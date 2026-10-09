/**
 * 评测脚本(审核手册阶段 3):逐条跑完整 agent 循环,比对 write_composed 产出的
 * rule 链 / catalog 命中 / 缺口记录与期望,输出四档命中率报告。
 *
 *   mock:confirm_submit 自动批准(评测不卡人)、submit_cluster 替换为桩(不真跑 snakemake);
 *   其余工具(dry_run/validate/write_composed/write_gap_log)全部真实执行。
 *
 * 用法:npm run eval(需 FLOWAGENT_API_KEY;逐条完整循环,耗时与模型速度相关)
 *      npm run eval -- --mode expert|both(专家模式/双基线,区分模型换档与 prompt 退化)
 * 接入节奏:rule 库新增 rule、改 system prompt、改端口签名结构、切换专家模型时各跑一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamText, stepCountIs, type ModelMessage, type ToolCallPart, type ToolResultPart } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import YAML from 'yaml';
import { tool } from 'ai';
import { z } from 'zod';
import { loadConfig, PACKAGE_ROOT, type AgentMode, type FlowAgentConfig } from '../src/config';
import { buildSystemPrompt } from '../src/system-prompt';
import { createTools } from '../src/tools';

interface CaseDef {
  id: string;
  need: string;
  expect: {
    kind: 'catalog' | 'composed' | 'gap';
    deliverable?: string;
    rules_contain?: string[];
    missing_regex?: string;
  };
}

type Verdict = 'exact_match' | 'chain_partial' | 'chain_wrong' | 'mis_gap';

function verdictLabel(v: Verdict): string {
  return { exact_match: '完全匹配', chain_partial: '链对但缺 rule', chain_wrong: '链错', mis_gap: '误判断链' }[v];
}

/** 评测用工具集:mock 掉 confirm_submit(自动批准)与 submit_cluster(不真跑) */
function evalTools(cfg: FlowAgentConfig, mode: AgentMode) {
  const real = createTools(cfg, mode) as Record<string, any>;
  real.submit_cluster = tool({
    description: 'submit_cluster(评测桩:不真正提交)',
    inputSchema: z.object({ task_id: z.string(), targets: z.array(z.string()).min(1), workdir: z.string().optional() }),
    execute: async () => ({ ok: true, note: 'eval: submit 已 mock,未真正提交' }),
  });
  return real;
}

async function runCase(cfg: FlowAgentConfig, c: CaseDef, mode: AgentMode): Promise<{ verdict: Verdict; detail: string }> {
  // 每条用例独立 demo 副本
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowagent-eval-'));
  const skip = /(\.snakemake|\/logs|\/01\.qc|\/00\.raw_data\/link_dir|run_ledger\.jsonl|\/composed\/20)/;
  fs.cpSync(path.join(PACKAGE_ROOT, 'demo'), tmp, { recursive: true, filter: (src) => !skip.test(src) });
  const caseCfg = { ...cfg, workflowRoot: tmp, allowSubmit: false };
  const tools = evalTools(caseCfg, mode);
  const task = `eval_${c.id}`;
  const caseModel = mode === 'expert' ? caseCfg.modelExpert || caseCfg.model : caseCfg.model;

  const provider = createOpenAICompatible({ name: 'flowagent', baseURL: caseCfg.baseURL, apiKey: caseCfg.apiKey });
  const messages: ModelMessage[] = [{ role: 'user', content: c.need }];
  // 与 CLI 相同的外层循环:confirm_submit 是 client-side 工具,流在等待应答处结束,补 tool-result 后续跑
  for (let round = 0; round < 6; round++) {
    const result = streamText({
      model: provider.chatModel(caseModel),
      system: buildSystemPrompt(caseCfg, mode),
      messages,
      tools,
      stopWhen: stepCountIs(30),
    });
    const pending: ToolCallPart[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call' && part.toolName === 'confirm_submit') pending.push(part as ToolCallPart);
    }
    messages.push(...(await result.response).messages);
    if (pending.length === 0) break;
    messages.push({
      role: 'tool',
      content: pending.map((call) => ({
        type: 'tool-result' as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'text' as const, value: JSON.stringify({ approved: true, by: 'eval-auto' }) },
      })) as ToolResultPart[],
    });
  }

  // 取证:组合目录 / 台账 / 缺口日志
  const composedDir = path.join(tmp, 'composed');
  const composed = fs.existsSync(composedDir)
    ? fs.readdirSync(composedDir).filter((d) => !d.startsWith('.'))
    : [];
  const useRules = composed.flatMap((d) =>
    [...fs.readFileSync(path.join(composedDir, d, 'Snakefile'), 'utf8').matchAll(/^use\s+rule\s+(.+)$/gm)].map((m) => m[1]),
  );
  const gapFile = path.join(tmp, 'agent', 'gap_log.yaml');
  const gapMissing = fs.existsSync(gapFile)
    ? (((YAML.parse(fs.readFileSync(gapFile, 'utf8')) as any)?.entries ?? []) as any[]).map((e) => String(e.missing ?? ''))
    : [];

  let verdict: Verdict;
  let detail: string;
  if (c.expect.kind === 'catalog') {
    const hit = useRules.length === 0 && gapMissing.length === 0;
    // catalog 命中不生成组合也不记缺口;deliverable 精确性由对话轨迹判断,这里只看行为
    verdict = hit ? 'exact_match' : 'mis_gap';
    detail = hit ? `未生成组合(期望 catalog 直接命中 ${c.expect.deliverable})` : `生成了组合/缺口(期望 catalog 命中 ${c.expect.deliverable})`;
  } else if (c.expect.kind === 'composed') {
    const wanted = c.expect.rules_contain ?? [];
    const matched = wanted.filter((w) => useRules.some((u) => u.includes(w)));
    verdict =
      matched.length === wanted.length ? 'exact_match' : matched.length > 0 ? 'chain_partial' : gapMissing.length > 0 ? 'mis_gap' : 'chain_wrong';
    detail = `use rule 链: ${useRules.join('; ') || '(空)'};期望含 ${wanted.join(', ')}`;
  } else {
    const rx = c.expect.missing_regex ? new RegExp(c.expect.missing_regex, 'i') : null;
    const hit = gapMissing.some((g) => !rx || rx.test(g));
    verdict = hit ? 'exact_match' : composed.length > 0 ? 'mis_gap' : 'chain_wrong';
    detail = `缺口记录: ${gapMissing.join('; ') || '(无)'};组合目录: ${composed.join(', ') || '(无)'}`;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { verdict, detail };
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.error('缺少 FLOWAGENT_API_KEY:评测需真实 LLM 在环。配置后重跑 npm run eval。');
    process.exit(1);
  }
  // --mode standard|expert|both(默认 standard;专家模式换模型,双基线用于区分「模型换档 vs prompt 改坏」)
  const modeArg = process.argv.find((a) => a.startsWith('--mode'))?.split('=')[1]
    ?? (process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : undefined)
    ?? 'standard';
  const modes: AgentMode[] =
    modeArg === 'both' ? ['standard', 'expert'] : modeArg === 'expert' ? ['expert'] : ['standard'];

  const doc = YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'eval', 'cases.yaml'), 'utf8')) as { cases: CaseDef[] };
  const cases = doc.cases;
  console.log(
    `评测集:${cases.length} 条  模式:${modes.join('+')}  模型:standard=${cfg.model} expert=${cfg.modelExpert || cfg.model}\n`,
  );

  const countsByMode = new Map<AgentMode, Record<Verdict, number>>();
  for (const mode of modes) {
    const counts: Record<Verdict, number> = { exact_match: 0, chain_partial: 0, chain_wrong: 0, mis_gap: 0 };
    countsByMode.set(mode, counts);
    for (const c of cases) {
      process.stdout.write(`[${c.id}][${mode}] `);
      try {
        const { verdict, detail } = await runCase(cfg, c, mode);
        counts[verdict]++;
        console.log(`${verdictLabel(verdict)}  ${detail}`);
      } catch (e) {
        counts.chain_wrong++;
        console.log(`执行异常: ${String(e).slice(0, 200)}`);
      }
    }
  }

  const total = cases.length;
  for (const mode of modes) {
    const counts = countsByMode.get(mode)!;
    console.log(`\n==== 命中率报告(${mode},模型 ${mode === 'expert' ? cfg.modelExpert || cfg.model : cfg.model}) ====
完全匹配      ${counts.exact_match}/${total} (${Math.round((counts.exact_match / total) * 100)}%)
链对但缺 rule ${counts.chain_partial}/${total}
链错          ${counts.chain_wrong}/${total}
误判断链      ${counts.mis_gap}/${total}`);
  }
  console.log('提示:本基线用于检测退化(rule 库/prompt 改动前后对比),不要求一次跑满;--mode both 双基线可区分模型换档与 prompt 退化。');
}

main();
