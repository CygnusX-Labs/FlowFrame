import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentMode, FlowAgentConfig } from '../config';
import { persistComposed } from './writes';
import { checkSelectedSubgraphClosure } from './validate';
import { loadManifests } from './registry';

/** PipelinePlan(架构评审 §7.3 最小实现):模块引用 + use 集合 + targets 的结构化计划。
 *  Snakefile 文本不再由模型自由书写,而是由固定模板确定性编译——模型只能表达
 *  「选什么」,「怎么写」收敛到工具层。 */
export interface PipelinePlan {
  modules: { alias: string; snakefile: string }[];
  uses: { rule: string; from: string; as: string }[];
  /** 整模块引入:use rule * from <from> as <prefix>_* */
  useAll?: { from: string; prefix: string }[];
  targets: string[];
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * 计划校验器 + 确定性编译:校验(module snakefile 必须存在且在仓库内、use 必须引用
 * 已声明的 module、targets 形态合法),再由固定模板生成 Snakefile 文本。
 */
export function compilePipelinePlan(
  root: string,
  composedDirAbs: string,
  plan: PipelinePlan,
): { ok: true; snakefile: string } | { ok: false; error: string } {
  const aliases = new Set<string>();
  for (const m of plan.modules) {
    if (!IDENT_RE.test(m.alias)) return { ok: false, error: `module 别名非法(只允许字母/数字/下划线,字母或下划线开头): ${m.alias}` };
    if (aliases.has(m.alias)) return { ok: false, error: `module 别名重复: ${m.alias}` };
    aliases.add(m.alias);
    const abs = path.resolve(root, m.snakefile);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, error: `module ${m.alias} 的 snakefile 越出仓库根: ${m.snakefile}` };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: `module ${m.alias} 的 snakefile 不存在: ${m.snakefile}` };
  }
  for (const u of plan.uses) {
    if (!IDENT_RE.test(u.rule)) return { ok: false, error: `rule 名非法: ${u.rule}` };
    if (!IDENT_RE.test(u.as)) return { ok: false, error: `use 别名非法: ${u.as}` };
    if (!aliases.has(u.from)) return { ok: false, error: `use rule ${u.rule} 引用了未声明的 module: ${u.from}` };
  }
  for (const ua of plan.useAll ?? []) {
    if (!IDENT_RE.test(ua.prefix)) return { ok: false, error: `use rule * 的前缀非法: ${ua.prefix}` };
    if (!aliases.has(ua.from)) return { ok: false, error: `use rule * 引用了未声明的 module: ${ua.from}` };
  }
  if (plan.uses.length === 0 && (plan.useAll ?? []).length === 0) {
    return { ok: false, error: '计划未选择任何 rule(use 与 use_all 至少给一项)' };
  }
  for (const t of plan.targets) {
    if (!t || /\s/.test(t)) return { ok: false, error: `target 非法(不得为空或含空白): ${t}` };
    if (t.startsWith('-')) return { ok: false, error: `target 不得以 - 开头(flag 注入): ${t}` };
  }
  const lines: string[] = [];
  if (fs.existsSync(path.join(root, 'rules', 'common.smk'))) {
    lines.push('include: "../../rules/common.smk"', '');
  }
  lines.push('configfile: "../../config/config.yaml"', '');
  // 仓库软件路径配置(第二 configfile,与 mergedEffectiveConfig 的合并契约一致)
  if (fs.existsSync(path.join(root, 'envs', 'general_software.yaml'))) {
    lines.push('configfile: "../../envs/general_software.yaml"', '');
  }
  lines.push('workdir: "../.."', '');
  for (const m of plan.modules) {
    const rel = path.relative(composedDirAbs, path.resolve(root, m.snakefile)).split(path.sep).join('/');
    lines.push(`module ${m.alias}:`, `    snakefile: "${rel}"`, '    config: config', '');
  }
  for (const ua of plan.useAll ?? []) {
    lines.push(`use rule * from ${ua.from} as ${ua.prefix}_*`);
  }
  for (const u of plan.uses) {
    lines.push(`use rule ${u.rule} from ${u.from} as ${u.as}`);
  }
  lines.push('', 'rule all:', `    input: ${plan.targets.map((t) => JSON.stringify(t)).join(', ')}`, '');
  return { ok: true, snakefile: lines.join('\n') };
}

export function createCompilerTools(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  const root = cfg.workflowRoot;

  const compile_pipeline = tool({
    description:
      'PipelinePlan → 确定性编译(架构评审 §7.3,优先于 write_composed 使用):只提供结构化计划(模块 + use 集合 + targets),组合 Snakefile 由固定模板生成,模型不书写流程文本。计划先经校验器(module 存在且在库内、use 引用已声明 module、targets 合法、选中子图端口闭合),再过三层防线与 config schema 校验后落盘。编译不出的计划(需要 with 块覆盖、动态 target 表达式等)才退回 write_composed,并在 reason 说明原因。',
    inputSchema: z.object({
      task_id: z.string(),
      name: z.string().describe('需求简述目录名,如 qc_only;工具自动加日期前缀'),
      modules: z
        .array(z.object({ alias: z.string().regex(IDENT_RE, 'module 别名非法'), snakefile: z.string() }))
        .min(1)
        .describe('引用的库模块:别名 + manifest 的 snakefile 路径(相对仓库根)'),
      uses: z
        .array(
          z.object({
            rule: z.string().regex(IDENT_RE, 'rule 名非法'),
            from: z.string().regex(IDENT_RE, 'module 别名非法'),
            as: z.string().regex(IDENT_RE, 'use 别名非法'),
          }),
        )
        .default([])
        .describe('use rule 集合:库 rule 原名 + 所属 module 别名 + 组合内命名空间别名(与 use_all 至少给一项)'),
      use_all: z
        .array(
          z.object({
            from: z.string().regex(IDENT_RE, 'module 别名非法'),
            prefix: z.string().regex(IDENT_RE, '前缀非法'),
          }),
        )
        .optional()
        .describe('整模块引入:如 [{from: "md5", prefix: "md5"}] → use rule * from md5 as md5_*'),
      targets: z.array(z.string().min(1)).min(1).describe('最终交付 target(相对仓库根)'),
      config_yaml: z.string().optional().describe('可选:本组合专用 config 副本内容(按 schema 校验)'),
      reason: z.string().describe('计划理由:为什么选这些模块/rule、串链依据(落台账)'),
    }),
    execute: async ({ task_id, name, modules, uses, use_all, targets, config_yaml, reason }) => {
      if (!reason || !reason.trim()) {
        return { ok: false, error: 'reason 必填:说明计划依据(选 rule 与串链依据),台账审计用。' };
      }
      // 落盘目录先解析出来,模板里的 module snakefile 路径相对它计算
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const dirName = /^[A-Za-z0-9_\-一-鿿]+$/.test(name) && name.startsWith(date) ? name : `${date}_${name}`;
      let composedAbs: string;
      try {
        composedAbs = path.resolve(root, 'composed', dirName);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      const plan: PipelinePlan = { modules, uses, useAll: use_all, targets };
      const compiled = compilePipelinePlan(root, composedAbs, plan);
      if (!compiled.ok) {
        return { ok: false, refused: true, error: `PipelinePlan 未通过校验器: ${compiled.error}` };
      }
      // 选中子图闭合(计划级校验,不等 validate_manifests 兜底):use_all 展开为模块全部 rule
      const selected = new Set(uses.map((u) => u.rule));
      if (use_all?.length) {
        const manifests = loadManifests(root);
        for (const ua of use_all) {
          const smk = modules.find((m) => m.alias === ua.from)?.snakefile;
          const mf = manifests.find((x) => x.snakefile === smk);
          if (mf) for (const r of mf.rules) selected.add(r.name);
        }
      }
      const closure = checkSelectedSubgraphClosure(root, selected, targets);
      if (closure.errors.length) {
        return {
          ok: false,
          refused: true,
          error: `PipelinePlan 选中子图不闭合:\n${closure.errors.map((e) => `  - ${e}`).join('\n')}`,
        };
      }
      const r = persistComposed(root, {
        task_id,
        name,
        snakefile: compiled.snakefile,
        config_yaml,
        reason,
        mode,
        provenance: 'compiled',
      });
      if (!r.ok || !r.dir || !r.files) {
        return { ok: false, error: r.error ?? '组合写入失败' };
      }
      return {
        ok: true,
        dir: r.dir,
        files: r.files,
        snakefile: compiled.snakefile,
        next: `先调 validate_manifests(workdir="${r.dir}"),再 dry_run(targets, workdir="${r.dir}")`,
      };
    },
  });

  return { compile_pipeline };
}
