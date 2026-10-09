import fs from 'node:fs';
import path from 'node:path';

/**
 * 组合 Snakefile 三层防线(审核手册阶段 0,规范 §8.2):
 *   1. 语句级白名单——顶层只放行 configfile:/include:/workdir:/module X:/use rule ...:/rule all:,
 *      其余任何顶层语句(顶层 Python、import、函数定义、其他 rule、shell:/run:)一律拒绝;
 *   2. 路径约束——configfile/include/workdir/module.snakefile 经 realpath 解析后必须
 *      位于流程仓库根内且真实存在(防 ../ 逃逸、库外绝对路径与符号链接逃逸);
 *      use rule with 块的 input/output/log/benchmark 与 rule all 的 input 中的字符串字面量,
 *      按组合目录与仓库根两个基准解析都必须落在根内(不要求存在——output 尚未产出),
 *      防止 with 块把 rule 的读写重定向到仓库外;
 *   3. 表达式约束——use rule with 块与 rule all 的 input 只允许字面量
 *      (str/int/float/bool/None/list/dict/tuple、一元 +/- 数字 与 kwargs),rule all 的 input
 *      额外放行 expand();禁止任何名称引用、函数调用、属性访问(含 __import__/dunder)。
 *      顶层序列允许换行分隔(Snakemake 官方文档惯用写法)与尾逗号(Python 允许);
 *      行内注释跳到行尾——绝不允许借注释截断解析、让注释之后的内容逃避校验。
 *
 * Snakefile 是 DSL 而非合法 Python,不能直接 ast.parse:先按顶层语句切块,
 * 块内表达式片段用自研递归下降解析器校验节点类型白名单。
 */

export interface GuardResult {
  ok: boolean;
  /** 每条含行号(若可得)与原因 */
  errors: string[];
}

// ---------- 词法 ----------

interface Tok {
  type: 'str' | 'num' | 'ident' | 'punct' | 'nl';
  value: string;
}

const PUNCT = '()[]{},:=.-+';

function tokenize(src: string): { toks: Tok[]; error?: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // 换行保留为记号:顶层序列允许换行分隔(无逗号的命名列表是 Snakemake 惯用写法),
    // 解析器据此区分"换行分隔"(放行)与"同行拼接"(拒绝)
    if (c === '\n') {
      toks.push({ type: 'nl', value: '\n' });
      i++;
      continue;
    }
    if (c === '#') {
      // 行内注释跳到行尾。绝不能在此终止整个词法分析:section 值可跨行,
      // 终止会让注释之后(下一行起)的内容完全绕过表达式校验
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          closed = true;
          break;
        }
        if (src[j] === '\n') break;
        j++;
      }
      if (!closed) return { toks, error: '字符串未闭合' };
      toks.push({ type: 'str', value: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ type: 'num', value: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i))!;
      toks.push({ type: 'ident', value: m[0] });
      i += m[0].length;
      continue;
    }
    if (PUNCT.includes(c)) {
      toks.push({ type: 'punct', value: c });
      i++;
      continue;
    }
    return { toks, error: `不允许的字符 "${c}"(表达式只允许字面量)` };
  }
  return { toks };
}

/** 提取"单个字符串字面量"语句值(用于 configfile/include/workdir/module.snakefile) */
function extractSingleString(src: string): string | null {
  const { toks, error } = tokenize(src);
  if (error) return null;
  return toks.length === 1 && toks[0].type === 'str' ? toks[0].value : null;
}

/** 提取表达式文本中的全部字符串字面量(用于对路径类字段做容器级路径约束) */
function extractStringLiterals(src: string): string[] {
  const { toks, error } = tokenize(src);
  if (error) return [];
  return toks.filter((t) => t.type === 'str').map((t) => t.value);
}

const BOOL_LITERALS = new Set(['True', 'False', 'None', 'true', 'false', 'null']);

// ---------- 表达式解析器 ----------

class ExprParser {
  pos = 0;
  constructor(
    private toks: Tok[],
    private where: string,
    private errors: string[],
    private allowExpand: boolean,
  ) {}

  private peek(off = 0): Tok | undefined {
    return this.toks[this.pos + off];
  }
  private eat(v: string): boolean {
    const t = this.peek();
    if (t?.type === 'punct' && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }
  private fail(msg: string): boolean {
    this.errors.push(`${this.where}: ${msg}`);
    return false;
  }
  /** 跳过换行记号,返回跳过个数(调用方据此判断元素间是否存在换行分隔) */
  private skipNl(): number {
    let n = 0;
    while (this.peek()?.type === 'nl') {
      this.pos++;
      n++;
    }
    return n;
  }

  /** 解析一个值:字面量 / 容器 / (allowExpand 时) expand()。拒绝名称引用、调用、属性、运算符。 */
  parseValue(): boolean {
    this.skipNl();
    const t = this.peek();
    if (!t) return this.fail('表达式意外结束');
    if (t.type === 'str' || t.type === 'num') {
      this.pos++;
      return true;
    }
    if (t.type === 'ident') {
      if (BOOL_LITERALS.has(t.value)) {
        this.pos++;
        return true;
      }
      if (t.value.startsWith('_') || t.value.includes('__'))
        return this.fail(`标识符 "${t.value}" 不允许(下划线开头/dunder 一律拒绝)`);
      if (t.value === 'expand' && this.allowExpand && this.peek(1)?.type === 'punct' && this.peek(1)!.value === '(') {
        this.pos += 2;
        return this.parseSequence(')');
      }
      return this.fail(
        `标识符 "${t.value}" 不允许(只允许字面量${this.allowExpand ? '与 expand()' : ''};禁止名称引用、调用与属性访问)`,
      );
    }
    if (t.type === 'punct') {
      if (t.value === '-' || t.value === '+') {
        this.pos++;
        const n = this.peek();
        if (n?.type === 'num') {
          this.pos++;
          return true;
        }
        return this.fail(`一元 "${t.value}" 后只允许数字字面量`);
      }
      if (t.value === '[') {
        this.pos++;
        return this.parseSequence(']');
      }
      if (t.value === '{') {
        this.pos++;
        return this.parseDict();
      }
      if (t.value === '(') {
        this.pos++;
        return this.parseSequence(')');
      }
    }
    return this.fail(`不允许的记号 "${t.value}"(只允许字面量)`);
  }

  /**
   * 逗号序列(列表/元组/expand 参数/顶层):元素是值或 kwarg(参数名=值)。
   * close 为 null 表示顶层(无闭合符)。允许尾逗号(含顶层);
   * 顶层额外允许换行分隔(Snakemake 惯用的无逗号命名列表),同行拼接仍拒绝。
   */
  parseSequence(close: string | null): boolean {
    this.skipNl();
    if (close && this.eat(close)) return true;
    for (;;) {
      const t = this.peek();
      const nxt = this.peek(1);
      if (t?.type === 'ident' && nxt?.type === 'punct' && nxt.value === '=') {
        if (!/^[A-Za-z]\w*$/.test(t.value))
          return this.fail(`参数名 "${t.value}" 不允许`);
        this.pos += 2;
        if (!this.parseValue()) return false;
      } else if (!this.parseValue()) return false;
      if (this.eat(',')) {
        this.skipNl();
        if (close && this.eat(close)) return true;
        if (!close && this.pos >= this.toks.length) return true; // 顶层尾逗号
        continue;
      }
      const nls = this.skipNl();
      if (close) return this.eat(close) ? true : this.fail(`缺少 "," 或 "${close}"`);
      if (this.pos >= this.toks.length) return true;
      if (nls > 0) continue; // 换行分隔的下一个元素
      return this.fail('缺少 ","(顶层序列元素须以逗号或换行分隔,禁止同行拼接)');
    }
  }

  /** 字典:键限 str/num/bool 字面量(裸标识符键在 Python 里是名称求值,拒绝) */
  parseDict(): boolean {
    this.skipNl();
    if (this.eat('}')) return true;
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if (!t || !(t.type === 'str' || t.type === 'num' || (t.type === 'ident' && BOOL_LITERALS.has(t.value))))
        return this.fail('字典键只允许字符串/数字/布尔字面量');
      this.pos++;
      this.skipNl();
      if (!this.eat(':')) return this.fail('字典缺少 ":"');
      if (!this.parseValue()) return false;
      this.skipNl();
      if (this.eat(',')) {
        this.skipNl();
        if (this.eat('}')) return true;
        continue;
      }
      return this.eat('}') ? true : this.fail('字典缺少 "," 或 "}"');
    }
  }
}

/** 校验一段表达式文本(字段值 / rule all 的 input):字面量 + kwargs,allowExpand 时放行 expand() */
function checkExpression(src: string, where: string, errors: string[], allowExpand: boolean): boolean {
  const { toks, error } = tokenize(src);
  if (error) {
    errors.push(`${where}: ${error}`);
    return false;
  }
  if (toks.length === 0) return true; // 值在续行(字段头单独成行)
  const p = new ExprParser(toks, where, errors, allowExpand);
  return p.parseSequence(null);
}

// ---------- 顶层语句切块 ----------

interface Block {
  line: number;
  header: string;
  body: { line: number; text: string }[];
}

function splitBlocks(text: string, errors: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  text.split('\n').forEach((raw, idx) => {
    const line = idx + 1;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return; // 空行与注释不属于任何块
    if (/^\s/.test(raw)) {
      if (!cur) {
        errors.push(`第 ${line} 行: 缩进行没有所属的顶层语句`);
        return;
      }
      cur.body.push({ line, text: raw });
      return;
    }
    if (cur) blocks.push(cur);
    cur = { line, header: raw, body: [] };
  });
  if (cur) blocks.push(cur);
  return blocks;
}

/** 块体按 "字段名: 值" 切 section;无字段头的续行并入当前 section */
interface Section {
  line: number;
  key: string;
  value: string;
}

function splitSections(block: Block, errors: string[]): Section[] | null {
  const sections: Section[] = [];
  for (const { line, text } of block.body) {
    const m = /^(\s*)([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(text);
    if (m) {
      sections.push({ line, key: m[2], value: m[3] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].value += '\n' + text;
    } else {
      errors.push(`第 ${line} 行: 块内无法识别的语句(只允许 "字段名: 值")`);
      return null;
    }
  }
  return sections;
}

// ---------- 第 2 层:路径约束 ----------

function checkPathWithin(
  root: string,
  composedDir: string,
  rel: string,
  kind: string,
  line: number,
  errors: string[],
  stagedFiles: Set<string>,
): void {
  const abs = path.resolve(composedDir, rel);
  const isStaged = stagedFiles.has(path.relative(composedDir, abs));
  if (!isStaged && !fs.existsSync(abs)) {
    errors.push(`第 ${line} 行: ${kind} 路径不存在: ${rel}`);
    return;
  }
  let real: string;
  try {
    // staged 文件尚未落盘,以组合目录的 realpath 代替(组合目录必在仓库内)
    real = fs.realpathSync(isStaged ? composedDir : abs);
  } catch {
    errors.push(`第 ${line} 行: ${kind} 路径无法解析: ${rel}`);
    return;
  }
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    errors.push(`第 ${line} 行: ${kind} 路径越出流程仓库根(${rel} → ${real}),已拒绝`);
  }
}

/**
 * 路径字面量的容器级约束(用于 with 块 input/output/log/benchmark 与 rule all input)。
 * 与 checkPathWithin 的差异:不要求存在(output 尚未产出);且相对路径按组合目录与
 * 仓库根两个基准解析都必须落在根内——snakemake 实际按 workdir 解析,两种基准都过关
 * 才放行,避免 base 解释差异留出逃逸缝。已存在的路径追加 realpath 校验防 symlink 逃逸。
 */
function checkPathLiteralContained(
  root: string,
  composedDir: string,
  rel: string,
  kind: string,
  line: number,
  errors: string[],
): void {
  const realRoot = fs.realpathSync(root);
  for (const base of [composedDir, root]) {
    const abs = path.resolve(base, rel);
    let real = abs;
    try {
      if (fs.existsSync(abs)) real = fs.realpathSync(abs);
    } catch {
      // 无法 realpath 时按解析后的绝对路径判断
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      errors.push(`第 ${line} 行: ${kind} 的路径值越出流程仓库根(${rel}),已拒绝`);
      return;
    }
  }
}

// ---------- 第 1 层:语句头白名单 ----------

/** use rule 头: use rule NAME|*,... from MODULE [as NAME] [with]:?(纯导入无 with 块时行尾无冒号) */
const USE_RULE_HEADER =
  /^use\s+rule\s+[A-Za-z_*][\w*,\s]*?\s+from\s+[A-Za-z_]\w*(?:\s+as\s+[A-Za-z_*][\w*]*)?(?:\s+with)?:?\s*$/;
/** use rule with 块字段白名单(审核手册问题 1 之 2) */
const WITH_BLOCK_FIELDS = new Set(['input', 'output', 'params', 'threads', 'resources', 'log', 'benchmark']);
/** with 块中值是路径的字段:字符串字面量必须落在仓库根内(防读写重定向逃逸) */
const WITH_PATH_FIELDS = new Set(['input', 'output', 'log', 'benchmark']);
/** module 块字段白名单 */
const MODULE_FIELDS = new Set(['snakefile', 'config', 'meta']);

/**
 * 三层防线主入口。在 write_composed 现有正则防线(禁 rule 本体)之后追加,不替换。
 * @param root 流程仓库根(workflowRoot)
 * @param composedDir 组合目录绝对路径(相对路径以它为基准)
 * @param text Snakefile 全文
 * @param stagedFiles 即将与 Snakefile 一同写入组合目录的文件名(如 config.yaml),存在性检查放行
 */
export function validateComposedSnakefile(
  root: string,
  composedDir: string,
  text: string,
  stagedFiles: string[] = [],
): GuardResult {
  const errors: string[] = [];
  const staged = new Set(stagedFiles);
  const blocks = splitBlocks(text, errors);

  for (const block of blocks) {
    const { header, line } = block;
    const where = `第 ${line} 行`;
    let m: RegExpExecArray | null;

    // configfile / include / workdir:值限单个字符串字面量 + 路径约束
    if ((m = /^(configfile|include|workdir):\s*(.+)$/.exec(header))) {
      const kind = m[1];
      const rel = extractSingleString(m[2]);
      if (rel === null) {
        errors.push(`${where}: ${kind} 的值只允许一个字符串字面量`);
      } else {
        checkPathWithin(root, composedDir, rel, kind, line, errors, staged);
      }
      continue;
    }

    if (/^module\s+[A-Za-z_]\w*:\s*$/.test(header)) {
      const sections = splitSections(block, errors);
      if (!sections) continue;
      if (sections.length === 0) {
        errors.push(`${where}: module 块为空(至少需要 snakefile:)`);
        continue;
      }
      for (const s of sections) {
        if (!MODULE_FIELDS.has(s.key)) {
          errors.push(
            `第 ${s.line} 行: module 块内字段 "${s.key}" 不在白名单(只允许 ${[...MODULE_FIELDS].join('/')})`,
          );
        } else if (s.key === 'snakefile') {
          const rel = extractSingleString(s.value);
          if (rel === null) errors.push(`第 ${s.line} 行: module.snakefile 的值只允许一个字符串字面量`);
          else checkPathWithin(root, composedDir, rel, 'module.snakefile', s.line, errors, staged);
        } else if (s.key === 'config') {
          if (s.value.trim() !== 'config') {
            const errs: string[] = [];
            checkExpression(s.value, `第 ${s.line} 行`, errs, false);
            if (errs.length) errors.push(`第 ${s.line} 行: module.config 只允许裸名 config 或字面量 dict`);
          }
        } else {
          const errs: string[] = [];
          checkExpression(s.value, `第 ${s.line} 行`, errs, false);
          errors.push(...errs);
        }
      }
      continue;
    }

    if (USE_RULE_HEADER.test(header)) {
      const sections = splitSections(block, errors);
      if (!sections) continue;
      for (const s of sections) {
        if (!WITH_BLOCK_FIELDS.has(s.key)) {
          errors.push(
            `第 ${s.line} 行: use rule with 块内字段 "${s.key}" 不在白名单(只允许 ${[...WITH_BLOCK_FIELDS].join('/')})`,
          );
          continue;
        }
        // 第 3 层:with 块值限字面量(不放行 expand/任何标识符)
        const errs: string[] = [];
        checkExpression(s.value, `第 ${s.line} 行`, errs, false);
        errors.push(...errs);
        // 第 2 层(路径类字段):input/output/log/benchmark 的字符串字面量必须落在仓库根内
        if (errs.length === 0 && WITH_PATH_FIELDS.has(s.key)) {
          for (const lit of extractStringLiterals(s.value)) {
            checkPathLiteralContained(root, composedDir, lit, `with 块 ${s.key}`, s.line, errors);
          }
        }
      }
      continue;
    }

    if (/^rule\s+all:\s*$/.test(header)) {
      const sections = splitSections(block, errors);
      if (!sections) continue;
      if (!sections.some((s) => s.key === 'input')) {
        errors.push(`${where}: rule all 需要 input: 声明最终 target`);
        continue;
      }
      for (const s of sections) {
        if (s.key !== 'input') {
          errors.push(`第 ${s.line} 行: rule all 块内只允许 input(不允许 "${s.key}")`);
          continue;
        }
        // 第 3 层:rule all 的 input 限字面量 + expand()(参数仍限字面量)
        const errs: string[] = [];
        checkExpression(s.value, `第 ${s.line} 行`, errs, true);
        errors.push(...errs);
        // 第 2 层:target 路径同样不得越出仓库根
        if (errs.length === 0) {
          for (const lit of extractStringLiterals(s.value)) {
            checkPathLiteralContained(root, composedDir, lit, 'rule all input', s.line, errors);
          }
        }
      }
      continue;
    }

    errors.push(
      `${where}: 顶层语句不在白名单(只允许 configfile:/include:/workdir:/module X:/use rule ...:/rule all:)——"${header.slice(0, 60)}"`,
    );
  }

  return { ok: errors.length === 0, errors };
}
