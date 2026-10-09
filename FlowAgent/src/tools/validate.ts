import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import { safeJoin, type AgentMode, type FlowAgentConfig } from '../config';
import { appendLedger } from '../ledger';
import { runShell, tail } from '../shell';
import { loadManifests, readYaml } from './registry';

/** manifest 中的路径 pattern → 正则:{sample} / {md5dir} 等占位符一律按非贪婪段匹配 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

// ---------- config_requires JSON Schema(审核手册阶段 1 第 1 项,对应原评审 #13) ----------

/** manifest config_requires 条目的 schema 形式;旧式纯字符串 key 视为 type:any 兼容 */
export interface ConfigSchema {
  key: string;
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
  /** 来源(manifest 文件 + rule 名),报错可追溯 */
  sourceRef: string;
}

/** 汇集全库 config_requires 的 schema;返回仍在用旧式 key 列表的 manifest 引用(提示补 schema) */
export function extractConfigSchemas(root: string): { schemas: ConfigSchema[]; legacyRefs: string[] } {
  const schemas: ConfigSchema[] = [];
  const legacyRefs = new Set<string>();
  for (const m of loadManifests(root)) {
    for (const r of m.rules) {
      const ref = `${m.sourceRef}#rules[name=${r.name}]`;
      for (const c of (r.config_requires ?? []) as unknown[]) {
        if (typeof c === 'string') legacyRefs.add(ref);
        else if (c && typeof c === 'object' && typeof (c as any).key === 'string')
          schemas.push({ ...(c as Omit<ConfigSchema, 'sourceRef'>), sourceRef: ref });
      }
    }
  }
  return { schemas, legacyRefs: [...legacyRefs] };
}

/** 按点分路径取嵌套 config 值,如 parameter.threads.fastqc */
function resolveDotted(obj: unknown, key: string): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || !(part in (cur as object)))
      return { found: false };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
}

/**
 * 校验 config(组合目录的 config 副本)是否满足全库声明的 schema。
 * 只校验 schema 已声明且 config 中存在的 key;缺 key 报 warning(dry_run 的 KeyError 会兜底)。
 */
export function checkConfigAgainstSchemas(
  config: unknown,
  schemas: ConfigSchema[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const s of schemas) {
    const where = `config['${s.key}']`;
    const { found, value } = resolveDotted(config, s.key);
    if (!found) {
      warnings.push(`${where}: schema 已声明但 config 缺少该 key(${s.sourceRef})——dry_run 时将 KeyError`);
      continue;
    }
    if (s.type && s.type !== 'any') {
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      let okType: boolean;
      if (s.type === 'integer') okType = typeof value === 'number' && Number.isInteger(value);
      else if (s.type === 'number') okType = typeof value === 'number';
      else if (s.type === 'array') okType = Array.isArray(value);
      else if (s.type === 'object') okType = typeof value === 'object' && value !== null && !Array.isArray(value);
      else okType = actual === s.type;
      if (!okType) {
        errors.push(`${where}: 期望 ${s.type},实际 ${actual}(${JSON.stringify(value)?.slice(0, 60)})——${s.sourceRef}`);
        continue;
      }
    }
    if (s.enum && !s.enum.includes(value as string | number))
      errors.push(`${where}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(s.enum)} 内——${s.sourceRef}`);
    if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum)
      errors.push(`${where}: ${value} 低于最小值 ${s.minimum}——${s.sourceRef}`);
    if (typeof s.maximum === 'number' && typeof value === 'number' && value > s.maximum)
      errors.push(`${where}: ${value} 超过最大值 ${s.maximum}——${s.sourceRef}`);
    if (s.pattern && typeof value === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value))
          errors.push(`${where}: 值 "${value}" 不匹配 pattern /${s.pattern}/——${s.sourceRef}`);
      } catch {
        warnings.push(`${s.sourceRef} 声明的 pattern 无效: ${s.pattern}`);
      }
    }
  }
  return { errors, warnings };
}

/** config_requires 条目(字符串或 schema 对象)→ 顶层 key(供 smk 覆盖率比对) */
function requireKey(c: unknown): string {
  return typeof c === 'string' ? c : typeof (c as any)?.key === 'string' ? (c as any).key : '';
}

// ---------- 内置一致性检查 ----------

/** 内置一致性检查(规范 §9.3 阶段 2 的轻量实现;仓库自带 agent/validate_manifests.py 时优先调用它) */
function builtinValidate(root: string): { issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const manifests = loadManifests(root);
  if (manifests.length === 0) {
    issues.push('rules/manifests/ 下没有任何 *.manifest.yaml');
    return { issues, warnings };
  }

  // 1. rule 名与 snakefile 存在性 + 端口签名完整性(pattern 必填:端口确定性匹配的地基)
  const usedPorts = new Set<string>();
  const outputPatterns: { pattern: string; ref: string }[] = [];
  for (const m of manifests) {
    const smkRel = m.snakefile;
    const smkAbs = smkRel ? path.join(root, smkRel) : '';
    const smkText = smkRel && fs.existsSync(smkAbs) ? fs.readFileSync(smkAbs, 'utf8') : null;
    if (!smkText) issues.push(`${m.sourceRef}: module.snakefile 不存在: ${smkRel || '(未声明)'}`);

    for (const r of m.rules) {
      const ref = `${m.sourceRef}#rules[name=${r.name}]`;
      if (smkText && !new RegExp(`rule\\s+${r.name}\\s*[:]`).test(smkText)) {
        issues.push(`${ref}: snakefile ${smkRel} 中找不到 rule ${r.name}`);
      }
      for (const io of [...(r.inputs ?? []), ...(r.outputs ?? [])]) {
        if (!io.port) issues.push(`${ref}: input/output ${io.name} 缺少 port 声明`);
        else usedPorts.add(io.port);
        // pattern 必填(审核手册问题 3:pattern 可选会让确定性端口匹配退化为全靠 dry_run 兜底)
        if (typeof (io as any).pattern !== 'string' || !(io as any).pattern.trim()) {
          issues.push(`${ref}: input/output ${io.name}(${io.port}) 缺少 pattern——端口确定性匹配依赖它(规范 §4.1)`);
        }
      }
      for (const o of r.outputs ?? []) {
        if (typeof (o as any).pattern === 'string') {
          outputPatterns.push({ pattern: (o as any).pattern, ref });
        }
      }
    }

    // 2. config_requires 覆盖检查(模块级:模块内全部 rule 声明取并集后与 snakefile 全文比对,避免按 rule 重复告警)
    if (smkText) {
      const declared = new Set(m.rules.flatMap((r) => (r.config_requires ?? []).map(requireKey).map((k) => k.split('.')[0])));
      for (const match of smkText.matchAll(/config\[['"]([A-Za-z0-9_]+)['"]\]/g)) {
        if (!declared.has(match[1])) {
          warnings.push(
            `${m.sourceRef}: snakefile 读取 config['${match[1]}'],但模块内所有 rule 的 config_requires 均未声明;若由其他模块声明可忽略`,
          );
        }
      }
    }
  }

  // 2.5 旧式 config_requires 提示(不强制,建议升级为 schema)
  const { legacyRefs } = extractConfigSchemas(root);
  if (legacyRefs.length) {
    warnings.push(`${legacyRefs.length} 个 rule 的 config_requires 仍是旧式 key 列表,建议升级为 {key,type,...} schema 形式: ${legacyRefs.slice(0, 5).join('; ')}${legacyRefs.length > 5 ? ' …' : ''}`);
  }

  // 3. 端口登记 + 5. 生产者闭合
  const portsFile = path.join(root, 'agent', 'ports.yaml');
  const registered = fs.existsSync(portsFile)
    ? (((readYaml(portsFile) as any)?.ports ?? {}) as Record<string, any>)
    : {};
  for (const p of usedPorts) {
    if (!registered[p]) issues.push(`端口未登记进 agent/ports.yaml: ${p}`);
  }
  const producerPorts = new Set<string>();
  for (const m of manifests)
    for (const r of m.rules) for (const o of r.outputs ?? []) if (o.port) producerPorts.add(o.port);
  for (const m of manifests)
    for (const r of m.rules)
      for (const i of r.inputs ?? []) {
        if (!i.port || producerPorts.has(i.port)) continue;
        const entry = registered[i.port];
        if (entry && entry.external === true) continue;
        warnings.push(`端口 ${i.port}(被 ${r.name} 消费)没有库内生产者;若为外部输入请在 ports.yaml 标 external: true`);
      }

  // 4. catalog target 可被某 rule output pattern 匹配
  const catalogFile = path.join(root, 'agent', 'catalog.yaml');
  if (fs.existsSync(catalogFile)) {
    const deliverables = ((readYaml(catalogFile) as any)?.deliverables ?? []) as any[];
    for (const d of deliverables) {
      for (const t of d.targets ?? []) {
        if (!outputPatterns.some(({ pattern }) => patternToRegex(pattern).test(t))) {
          issues.push(`catalog deliverable ${d.id} 的 target 无任何 rule output pattern 可匹配: ${t}`);
        }
      }
    }
  } else {
    issues.push('agent/catalog.yaml 不存在');
  }

  return { issues, warnings };
}

/** snakemake --lint(入库门禁;失败仅 warning,不阻断——审核手册阶段 2 第 2 项) */
async function runLint(root: string): Promise<string[]> {
  const { code, stdout, stderr } = await runShell('snakemake', ['--lint', 'text'], { cwd: root, timeoutMs: 120_000 });
  if (code === 0) return [];
  const out = tail(stdout + '\n' + stderr, 40);
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `lint: ${l}`);
}

export function createValidateTool(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  const root = cfg.workflowRoot;

  const validate_manifests = tool({
    description:
      '一致性校验(规范 §9.3/§4.1):manifest 与 .smk 漂移、端口登记、端口 pattern 完整性、catalog target 可匹配、config_requires 覆盖;workdir 指向组合目录时,对其 config.yaml 副本按全库 schema 做 JSON Schema 校验(类型/枚举/范围/pattern)。lint=true 时追加 snakemake --lint(仅 warning,入库门禁用)。仓库自带 agent/validate_manifests.py 时优先调用它。每次改动 manifest/组合文件后必须先跑。',
    inputSchema: z.object({
      task_id: z.string().describe('任务 ID,写入台账'),
      workdir: z.string().optional().describe('组合目录(如 composed/20260908_xxx):对其 config.yaml 副本做 schema 校验'),
      lint: z.boolean().optional().describe('true 时追加 snakemake --lint(入库/大改后使用,较慢)'),
    }),
    execute: async ({ task_id, workdir, lint }) => {
      // 组合 config 副本的 schema 校验(两种路径都执行)
      let configErrors: string[] = [];
      let configWarnings: string[] = [];
      if (workdir) {
        let cfgFile: string;
        try {
          cfgFile = safeJoin(root, path.join(workdir, 'config.yaml'));
        } catch (e) {
          return { ok: false, error: String(e) };
        }
        if (fs.existsSync(cfgFile)) {
          const { schemas } = extractConfigSchemas(root);
          const check = checkConfigAgainstSchemas(readYaml(cfgFile), schemas);
          configErrors = check.errors;
          configWarnings = check.warnings;
        } else {
          configWarnings.push(`${workdir}/config.yaml 不存在(组合未携带 config 副本,跳过 schema 校验)`);
        }
      }

      const pyScript = path.join(root, 'agent', 'validate_manifests.py');
      let issues: string[] = [];
      let warnings: string[] = [];
      let runner = 'builtin';
      let lintOut = '';
      if (fs.existsSync(pyScript)) {
        runner = 'python';
        const { code, stdout, stderr } = await runShell('python3', [pyScript], { cwd: root });
        lintOut = tail(stdout + '\n' + stderr, 80);
        if (code !== 0) issues.push(`agent/validate_manifests.py 退出码 ${code}(输出见 output)`);
      } else {
        const r = builtinValidate(root);
        issues = r.issues;
        warnings = r.warnings;
      }
      if (lint) warnings.push(...(await runLint(root)));

      issues.push(...configErrors);
      warnings.push(...configWarnings);
      const ok = issues.length === 0;
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'validate',
        object: workdir ?? '.',
        result: ok ? 'success' : 'failed',
        detail: [...issues, ...warnings].slice(0, 20).join('\n'),
        mode,
      });
      return { ok, runner, issues, warnings, ...(lintOut ? { output: lintOut } : {}) };
    },
  });

  return { validate_manifests };
}
