import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import { safeJoin, type AgentMode, type FlowAgentConfig } from '../config';
import { appendLedger } from '../ledger';
import { validateComposedSnakefile } from '../composed-guard';
import { readYaml } from './registry';
import { checkConfigAgainstSchemas, extractConfigSchemas } from './validate';

export function createWriteTools(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  const root = cfg.workflowRoot;

  const write_gap_log = tool({
    description:
      '记录缺口事件到 agent/gap_log.yaml(端口断链/缺 rule/缺 deliverable)。同一缺口重复出现自动累计次数。高频缺口是专家下一个该策展的 rule。reason 必填:说明为什么判定这是缺口(哪个端口找不到生产者等),落台账审计。',
    inputSchema: z.object({
      task_id: z.string(),
      need: z.string().describe('用户需求描述'),
      missing: z.string().describe('缺的端口、rule 或 deliverable,如 port:align.bam / deliverable:diff_expr'),
      reason: z.string().describe('判定理由:查了哪些端口/rule、为什么断定缺口(审计依据)'),
    }),
    execute: async ({ task_id, need, missing, reason }) => {
      if (!reason || !reason.trim()) {
        return { ok: false, error: 'reason 必填:说明为什么判定这是缺口(台账审计依据)。' };
      }
      const file = path.join(root, 'agent', 'gap_log.yaml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const doc = fs.existsSync(file)
        ? ((readYaml(file) as any) ?? {})
        : {};
      const entries: any[] = doc.entries ?? [];
      const hit = entries.find((e) => e.missing === missing);
      if (hit) {
        hit.count = (hit.count ?? 1) + 1;
        hit.last_seen = new Date().toISOString();
        hit.need = need;
        hit.mode = mode;
      } else {
        entries.push({ time: new Date().toISOString(), last_seen: new Date().toISOString(), need, missing, count: 1, mode });
      }
      fs.writeFileSync(file, YAML.stringify({ entries }));
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'error',
        object: 'agent/gap_log.yaml',
        result: 'gap_recorded',
        detail: missing,
        reason,
        mode,
      });
      return { ok: true, missing, count: hit ? hit.count : 1, file: 'agent/gap_log.yaml' };
    },
  });

  const write_composed = tool({
    description:
      '在 composed/ 下新建组合 Snakefile 目录(每次组合一个新目录,已存在则拒绝,永不覆盖)。内容必须用 module + use rule 引用库中 rule,禁止复制粘贴 rule 本体;仓库存在 rules/common.smk 时 include 必须为第一行。生成物经三层防线校验:顶层语句白名单(禁止任何顶层 Python)、路径约束(configfile/include/module 必须位于仓库内;with 块 input/output/log/benchmark 与 rule all target 的路径值同样不得越出仓库根)、表达式约束(with 块与 rule all 的 input 只允许字面量,rule all 额外放行 expand();顶层序列允许换行分隔与尾逗号)。reason 必填:说明选 rule 与串链的依据。携带 config_yaml 时按全库 config_requires schema 校验(类型/枚举/范围/pattern)。',
    inputSchema: z.object({
      task_id: z.string(),
      name: z.string().describe('需求简述目录名,如 qc_only;工具会自动加日期前缀'),
      snakefile: z.string().describe('组合 Snakefile 完整内容'),
      config_yaml: z.string().optional().describe('可选:本组合专用 config 副本内容,写入同目录 config.yaml(按 schema 校验)'),
      reason: z.string().describe('组合理由:为什么选这些 rule、端口串链依据(落台账,审计用)'),
    }),
    execute: async ({ task_id, name, snakefile, config_yaml, reason }) => {
      if (!reason || !reason.trim()) {
        return { ok: false, error: 'reason 必填:说明为什么这样组合(选 rule 与串链依据),台账审计用。' };
      }
      if (!/^[A-Za-z0-9_\-一-鿿]+$/.test(name)) {
        return { ok: false, error: `目录名含非法字符: ${name}` };
      }
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const dirName = name.startsWith(date) ? name : `${date}_${name}`;
      let dir: string;
      try {
        dir = safeJoin(root, path.join('composed', dirName));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      if (fs.existsSync(dir)) {
        return { ok: false, error: `composed/${dirName} 已存在。组合目录永不覆盖(可回溯),请换一个 name。` };
      }
      // 防线 0(原有):组合文件只允许 rule all + module/use rule 引用,任何其它 rule 定义
      // 无论是否同时写了 use rule,都视为复制粘贴/新写 rule 本体,直接拒绝(规范 §8.2)。
      const definedRules = [...snakefile.matchAll(/^\s*rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
      const illegal = definedRules.filter((n) => n !== 'all');
      if (illegal.length) {
        return {
          ok: false,
          error: `组合 Snakefile 中检测到 rule 定义:${illegal.join(', ')}。组合文件只允许 rule all 与 module + use rule 引用库中 rule,禁止复制粘贴或新写 rule 本体(规范 §8.2)。新增 rule 请走 Build 入库门禁。`,
        };
      }
      // 防线 1~3(审核手册阶段 0):Snakefile 是 Python,snakemake 解析即执行顶层代码,
      // 而 dry_run 发生在人工确认之前——必须在此拦截顶层 Python/库外路径/表达式载荷。
      const guard = validateComposedSnakefile(root, dir, snakefile, config_yaml ? ['config.yaml'] : []);
      if (!guard.ok) {
        return {
          ok: false,
          error: `组合 Snakefile 未通过三层防线校验(只允许 module + use rule 组合,禁止任何可执行代码):\n${guard.errors.map((e) => `  - ${e}`).join('\n')}`,
        };
      }
      // config 副本 schema 校验(审核手册阶段 1 第 1 项)
      if (config_yaml) {
        let cfgObj: unknown;
        try {
          cfgObj = YAML.parse(config_yaml);
        } catch (e) {
          return { ok: false, error: `config_yaml 解析失败: ${e}` };
        }
        const { schemas } = extractConfigSchemas(root);
        const { errors } = checkConfigAgainstSchemas(cfgObj, schemas);
        if (errors.length) {
          return {
            ok: false,
            error: `config 副本未通过 schema 校验(manifest config_requires 声明的类型/范围/枚举):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
          };
        }
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Snakefile'), snakefile);
      const files = ['Snakefile'];
      if (config_yaml) {
        fs.writeFileSync(path.join(dir, 'config.yaml'), config_yaml);
        files.push('config.yaml');
      }
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'fix',
        object: `composed/${dirName}`,
        result: 'composed_written',
        detail: files.join(', '),
        reason,
        mode,
      });
      return {
        ok: true,
        dir: `composed/${dirName}`,
        files,
        next: `先调 validate_manifests(workdir="composed/${dirName}"),再 dry_run(targets, workdir="composed/${dirName}")`,
      };
    },
  });

  return { write_gap_log, write_composed };
}
