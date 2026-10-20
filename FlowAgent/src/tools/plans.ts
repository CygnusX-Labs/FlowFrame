import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import { safeJoin, type AgentMode, type FlowAgentConfig } from '../config';
import { appendLedger } from '../ledger';
import { loadManifests } from './registry';
import { TASK_ID_RE } from './snakemake';

/**
 * AnalysisPlan(架构评审 §4 表):科学目标、分组对照、方法假设形成明确的审阅对象。
 * 计划写入 agent/plans/<task_id>.analysis.yaml,且纳入执行对象摘要——
 * dry_run / 人工确认 / submit_cluster 核对同一摘要,方案改动即整体失效,
 * 须以新 task_id(新 revision)重新走检查与确认。
 */
export function createPlanTools(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  const root = cfg.workflowRoot;

  const write_analysis_plan = tool({
    description:
      '把科学方案固化为可审阅对象(AnalysisPlan):科学目标、样本分组与对照、方法假设、交付产物、选用的 rule 列表,写入 agent/plans/<task_id>.analysis.yaml。detailed_summary 通过之后、confirm_submit 之前必须调用,confirm 的 summary 引用本方案要点;方案文件是执行对象摘要的一部分,dry_run/确认/提交三方核对同一摘要。已存在则拒绝(方案变更须用新 task_id 重新走检查与确认);引用的 rule 必须存在于库中。',
    inputSchema: z.object({
      task_id: z.string().describe('任务 ID(与 dry_run/confirm_submit/submit_cluster 同一个)'),
      scientific_goal: z.string().describe('科学目标:本次分析要回答什么生物学问题'),
      grouping: z.string().describe('样本分组与对照:哪些组、谁是对照(须与 config/samples.csv 的分组一致)'),
      method_assumptions: z.string().describe('方法假设:为何选这些 rule/参数,适用边界与已知局限'),
      deliverable: z.string().describe('交付产物(catalog deliverable id 或 targets)'),
      rules: z.array(z.string()).min(1).describe('本方案选用的库 rule 名(use rule 引用的原名,非命名空间前缀名)'),
      reason: z.string().describe('判定依据:方案与 rule 选择的理由,落台账审计'),
    }),
    execute: async ({ task_id, scientific_goal, grouping, method_assumptions, deliverable, rules, reason }) => {
      if (!TASK_ID_RE.test(task_id)) {
        return { ok: false, error: `task_id 非法: "${task_id}"(只允许字母/数字/下划线/中文/点/横线)` };
      }
      const known = new Set(loadManifests(root).flatMap((m) => m.rules.map((r) => r.name)));
      const unknown = rules.filter((r) => !known.has(r));
      if (unknown.length) {
        return { ok: false, refused: true, error: `方案引用的 rule 在库中不存在: ${unknown.join(', ')}——先用 query_rules 核实再写方案` };
      }
      const dir = safeJoin(root, path.join('agent', 'plans'));
      const rel = path.join('agent', 'plans', `${task_id}.analysis.yaml`);
      const file = path.join(dir, `${task_id}.analysis.yaml`);
      if (fs.existsSync(file)) {
        return {
          ok: false,
          refused: true,
          error: `计划已存在: ${rel}。方案变更 = 科学参数变更,须用新 task_id 重新 dry_run 与确认(改变科学参数需新 revision 和重新审阅)`,
        };
      }
      const doc = {
        task_id,
        scientific_goal,
        grouping,
        method_assumptions,
        deliverable,
        rules,
        created_at: new Date().toISOString(),
        mode,
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, YAML.stringify(doc));
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'plan',
        object: rel,
        result: 'written',
        detail: scientific_goal.slice(0, 120),
        reason,
        mode,
      });
      return {
        ok: true,
        plan: rel,
        note: '计划已固化为人工审阅对象,并纳入执行对象摘要:之后调用 dry_run(本任务),确认与提交会核对同一摘要;改动方案须新 task_id 重新走全流程。',
      };
    },
  });

  return { write_analysis_plan };
}
