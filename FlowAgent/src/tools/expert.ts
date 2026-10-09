import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import { safeJoin, type FlowAgentConfig } from '../config';
import { appendLedger, readLedger } from '../ledger';
import { readYaml } from './registry';

/**
 * 专家模式专属工具(仅 createTools(cfg, 'expert') 注册):
 * analyze_history   主动体检——台账与缺口日志的确定性复盘统计(只读)
 * write_rule_proposal 起草 rule 入库提案——写 proposals/,与 composed/ 同级约束:
 *                   safeJoin 白名单 + 只允许新建目录、拒绝覆盖,禁止触碰 rules/。
 */
export function createExpertTools(cfg: FlowAgentConfig) {
  const root = cfg.workflowRoot;

  const analyze_history = tool({
    description:
      '专家主动体检(只读):对 agent/run_ledger.jsonl 与 agent/gap_log.yaml 做确定性复盘统计——高频缺口排行、熔断事件清单(同一归一化签名失败 ≥2 次)、按操作类型分组的台账统计、近期确认/提交概况。返回紧凑结构化摘要,据此向用户报告值得行动的模式并给出建议。',
    inputSchema: z.object({
      top: z.number().int().min(1).max(50).optional().describe('各排行榜返回条数,默认 10'),
    }),
    execute: async ({ top }) => {
      const limit = top ?? 10;
      const entries = readLedger(root);

      const byOp: Record<string, number> = {};
      for (const e of entries) byOp[e.op] = (byOp[e.op] ?? 0) + 1;

      // 熔断事件清单:同一 task 内同一签名失败 ≥2 次(铁律 6 的熔断前置信号)
      const sigCount = new Map<string, { task_id: string; signature: string; bucket?: string; count: number; last_ts: string }>();
      for (const e of entries) {
        if (e.op !== 'dry_run' || e.result !== 'failed' || !e.signature) continue;
        const key = `${e.task_id}|${e.signature}`;
        const cur = sigCount.get(key) ?? { task_id: e.task_id, signature: e.signature, bucket: e.bucket, count: 0, last_ts: e.ts };
        cur.count += 1;
        cur.last_ts = e.ts;
        sigCount.set(key, cur);
      }
      const fuseEvents = [...sigCount.values()]
        .filter((s) => s.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      // 高频缺口排行(gap_log 的 count 已由 write_gap_log 累计)
      const gapFile = path.join(root, 'agent', 'gap_log.yaml');
      const gapEntries: any[] = fs.existsSync(gapFile)
        ? (((readYaml(gapFile) as any)?.entries ?? []) as any[])
        : [];
      const topGaps = gapEntries
        .map((g) => ({ missing: String(g.missing ?? ''), count: Number(g.count ?? 1), need: g.need, last_seen: g.last_seen }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      const recent = entries.slice(-20).map((e) => ({
        ts: e.ts, task_id: e.task_id, op: e.op, result: e.result, mode: e.mode ?? 'standard',
      }));

      return {
        ok: true,
        ledger_total: entries.length,
        by_op: byOp,
        fuse_events: fuseEvents,
        top_gaps: topGaps,
        recent,
        hint: 'fuse_events 是同签名连续失败信号;top_gaps 是下一个该策展 rule 的候选。低置信度判断请给用户选项,不要替用户定。',
      };
    },
  });

  const write_rule_proposal = tool({
    description:
      '起草 rule 入库提案(专家模式):在 proposals/<日期>_<name>/ 新建目录,写入 manifest 草稿 + .smk 草稿 + RATIONALE.md 设计理由,供用户人工审核。提案不是 rule 库——入库仍走人工审核门禁;本工具只允许新建目录,已存在即拒绝(永不覆盖),且无法写 rules/ 任何既有文件。reason 必填:说明为什么判定需要这个新 rule(缺口依据、端口设计理由),落台账审计。',
    inputSchema: z.object({
      task_id: z.string(),
      name: z.string().describe('提案目录名,如 rnaseq_salmon_quant;工具会自动加日期前缀'),
      manifest_yaml: z.string().describe('manifest 草稿(YAML,含 module.id/snakefile 与 rules[] 的 io.pattern/config_requires 等)'),
      smk: z.string().describe('rule 草稿(.smk 内容)'),
      rationale: z.string().describe('设计理由(Markdown):缺口依据、端口设计、参考来源、置信度'),
      reason: z.string().describe('一句话提案理由(落台账,审计用)'),
    }),
    execute: async ({ task_id, name, manifest_yaml, smk, rationale, reason }) => {
      if (!reason || !reason.trim()) {
        return { ok: false, error: 'reason 必填:说明为什么提案这个新 rule(台账审计依据)。' };
      }
      if (!/^[A-Za-z0-9_\-一-鿿]+$/.test(name)) {
        return { ok: false, error: `目录名含非法字符: ${name}` };
      }
      // manifest 草稿必须可解析且声明了 rules 列表——提案评审的第一道自检
      let manifestDoc: unknown;
      try {
        manifestDoc = YAML.parse(manifest_yaml);
      } catch (e) {
        return { ok: false, error: `manifest_yaml 解析失败: ${e}` };
      }
      const rules = (manifestDoc as any)?.rules;
      if (!Array.isArray(rules) || rules.length === 0) {
        return { ok: false, error: 'manifest_yaml 必须包含非空 rules 列表(提案评审要求 io 契约齐备)。' };
      }
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const dirName = name.startsWith(date) ? name : `${date}_${name}`;
      let dir: string;
      try {
        dir = safeJoin(root, path.join('proposals', dirName));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      if (fs.existsSync(dir)) {
        return { ok: false, error: `proposals/${dirName} 已存在。提案目录永不覆盖(可回溯),请换一个 name。` };
      }
      const smkName = `${name.replace(/^\d{8}_/, '')}.smk`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), manifest_yaml);
      fs.writeFileSync(path.join(dir, smkName), smk);
      fs.writeFileSync(path.join(dir, 'RATIONALE.md'), rationale);
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'fix',
        object: `proposals/${dirName}`,
        result: 'proposal_written',
        detail: ['manifest.yaml', smkName, 'RATIONALE.md'].join(', '),
        reason,
        mode: 'expert',
      });
      return {
        ok: true,
        dir: `proposals/${dirName}`,
        files: ['manifest.yaml', smkName, 'RATIONALE.md'],
        next: '提案已落盘待审。请向用户说明:提案不是 rule 库,入库需人工审核后移至 rules/ 并补 manifest 建档。',
      };
    },
  });

  return { analyze_history, write_rule_proposal };
}
