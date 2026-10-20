/**
 * 语义错误评测(架构评审 §7.7「扩展语义错误评测并建立基线」):
 * 「错误但语法/流程上貌似合法」的组装必须被系统拦下;正向计划必须放行。
 * 全部确定性执行(不调 LLM),逐条用例独立 demo 副本,输出表格 + 退出码。
 *
 * 用法:npm run eval:semantic            跑一遍并与基线比对(无基线则只报告)
 *      npm run eval:semantic -- --save  把本次结果存为基线(eval/semantic-baseline.json)
 *
 * 基线文件记录 rule 库版本(git HEAD 或 manifest 联合 hash)与各用例判定,
 * rule 库/校验逻辑变更后重跑,可区分「库退化」与「校验逻辑改动」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, PACKAGE_ROOT } from '../src/config';
import { createTools } from '../src/tools';
import { ruleLibraryVersionSync } from '../src/spec-digest';

const stubCtx = { toolCallId: 'semantic-eval', messages: [] } as any;
const TARGET = '01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html';

interface SemanticCase {
  id: string;
  desc: string;
  /** 返回 true = 系统行为符合期望 */
  run: (tools: ReturnType<typeof createTools>, tmp: string) => Promise<boolean>;
}

const md5 = { alias: 'md5', snakefile: 'rules/02.file_convert_md5.smk' };
const qc = { alias: 'qc', snakefile: 'rules/03.short_read_qc.smk' };
const fullPlanUses = [
  { rule: 'seq_preprocessor', from: 'md5', as: 'md5_seq_preprocessor' },
  { rule: 'check_md5', from: 'md5', as: 'md5_check_md5' },
  { rule: 'short_read_qc_r1', from: 'qc', as: 'qc_short_read_qc_r1' },
  { rule: 'short_read_multiqc_r1', from: 'qc', as: 'qc_short_read_multiqc_r1' },
];

const cases: SemanticCase[] = [
  {
    id: 'reject_open_subgraph',
    desc: '不闭合子图(只选聚合 rule)→ 编译器拒绝',
    run: async (tools) => {
      const r: any = await tools.compile_pipeline.execute!(
        {
          task_id: 'sem_open',
          name: 'sem_open',
          modules: [qc],
          uses: [{ rule: 'short_read_multiqc_r1', from: 'qc', as: 'qc_multiqc' }],
          targets: [TARGET],
          reason: '语义用例:不闭合计划',
        },
        stubCtx,
      );
      return r.ok === false && String(r.error).includes('不闭合');
    },
  },
  {
    id: 'reject_open_subgraph_use_all',
    desc: 'use_all 整模块引入仍不闭合(md5 全家桶产不出 fastqc.zip)→ 编译器拒绝',
    run: async (tools) => {
      const r: any = await tools.compile_pipeline.execute!(
        {
          task_id: 'sem_open_all',
          name: 'sem_open_all',
          modules: [md5],
          uses: [],
          use_all: [{ from: 'md5', prefix: 'md5' }],
          targets: [TARGET],
          reason: '语义用例:use_all 不闭合',
        },
        stubCtx,
      );
      return r.ok === false && String(r.error).includes('不闭合');
    },
  },
  {
    id: 'reject_ghost_module',
    desc: '幽灵 module(smk 不存在)→ 编译器拒绝',
    run: async (tools) => {
      const r: any = await tools.compile_pipeline.execute!(
        {
          task_id: 'sem_ghost',
          name: 'sem_ghost',
          modules: [{ alias: 'x', snakefile: 'rules/nonexistent.smk' }],
          uses: [{ rule: 'seq_preprocessor', from: 'x', as: 'x_seq' }],
          targets: [TARGET],
          reason: '语义用例:幽灵 module',
        },
        stubCtx,
      );
      return r.ok === false && String(r.error).includes('不存在');
    },
  },
  {
    id: 'reject_ghost_rule_plan',
    desc: '方案引用库外 rule → write_analysis_plan 拒绝',
    run: async (tools) => {
      const r: any = await tools.write_analysis_plan.execute!(
        {
          task_id: 'sem_ghost_plan',
          scientific_goal: 'x',
          grouping: 'g',
          method_assumptions: 'a',
          deliverable: 'd',
          rules: ['no_such_rule'],
          reason: '语义用例:幽灵 rule',
        },
        stubCtx,
      );
      return r.ok === false && String(r.error).includes('no_such_rule');
    },
  },
  {
    id: 'reject_missing_required_config',
    desc: '选中 rule 必需字段缺失(临时 manifest)→ write_composed 拒绝',
    run: async (tools, tmp) => {
      fs.writeFileSync(path.join(tmp, 'rules/97.sem_req.smk'), 'rule sem_req:\n    output: touch("97.sem_req.done")\n    shell: "true"\n');
      fs.writeFileSync(
        path.join(tmp, 'rules/manifests/97.sem_req.manifest.yaml'),
        [
          'module:',
          '  id: "97.sem_req"',
          '  snakefile: "rules/97.sem_req.smk"',
          'rules:',
          '  - name: sem_req',
          '    summary: "语义用例"',
          '    config_requires:',
          '      - key: "sem_only.required_key"',
          '        type: "string"',
          '',
        ].join('\n'),
      );
      try {
        const r: any = await tools.write_composed.execute!(
          {
            task_id: 'sem_cfg',
            name: 'sem_cfg',
            snakefile: [
              'configfile: "../../config/config.yaml"',
              '',
              'module sem:',
              '    snakefile: "../../rules/97.sem_req.smk"',
              '    config: config',
              '',
              'use rule sem_req from sem as sem_sem_req',
              '',
              'rule all:',
              '    input: "97.sem_req.done"',
              '',
            ].join('\n'),
            config_yaml: 'convert_md5: link_dir\n',
            reason: '语义用例:必需字段缺失',
          },
          stubCtx,
        );
        return r.ok === false && String(r.error).includes('sem_only.required_key');
      } finally {
        fs.rmSync(path.join(tmp, 'rules/97.sem_req.smk'));
        fs.rmSync(path.join(tmp, 'rules/manifests/97.sem_req.manifest.yaml'));
      }
    },
  },
  {
    id: 'reject_missing_samples',
    desc: '样本表缺失(库有 per-sample rule)→ validate_manifests 报 issue',
    run: async (tools, tmp) => {
      const f = path.join(tmp, 'config', 'samples.csv');
      const backup = fs.readFileSync(f);
      fs.rmSync(f);
      try {
        const r: any = await tools.validate_manifests.execute!({ task_id: 'sem_samples' }, stubCtx);
        return r.ok === false && r.issues.join('\n').includes('samples.csv');
      } finally {
        fs.writeFileSync(f, backup);
      }
    },
  },
  {
    id: 'reject_missing_conda_env',
    desc: 'conda env 文件缺失 → validate_manifests 报 issue',
    run: async (tools, tmp) => {
      const f = path.join(tmp, 'envs', 'fastqc.yaml');
      const backup = fs.readFileSync(f);
      fs.rmSync(f);
      try {
        const r: any = await tools.validate_manifests.execute!({ task_id: 'sem_conda' }, stubCtx);
        return r.ok === false && r.issues.join('\n').includes('conda 环境不存在');
      } finally {
        fs.writeFileSync(f, backup);
      }
    },
  },
  {
    id: 'accept_compiled_plan',
    desc: '完整 PipelinePlan → 编译通过且 dry_run 成功(正向)',
    run: async (tools) => {
      const r: any = await tools.compile_pipeline.execute!(
        {
          task_id: 'sem_compiled',
          name: 'sem_compiled',
          modules: [md5, qc],
          uses: fullPlanUses,
          targets: [TARGET],
          reason: '语义用例:正向编译',
        },
        stubCtx,
      );
      if (!r.ok) return false;
      const d: any = await tools.dry_run.execute!({ task_id: 'sem_compiled', targets: [TARGET], workdir: r.dir }, stubCtx);
      return d.ok === true;
    },
  },
  {
    id: 'accept_catalog_dryrun',
    desc: 'catalog 主流程 dry_run 成功(正向)',
    run: async (tools) => {
      const r: any = await tools.dry_run.execute!({ task_id: 'sem_catalog', targets: [TARGET] }, stubCtx);
      return r.ok === true;
    },
  },
];

async function main(): Promise<void> {
  const save = process.argv.includes('--save');
  const cfg = loadConfig();
  let passed = 0;
  const results: Record<string, 'pass' | 'fail'> = {};

  console.log(`semantic eval: ${cases.length} 例(demo 副本,确定性,无 LLM)\n`);
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowagent-sem-eval-'));
    const skip = /(\.snakemake|\/logs|\/01\.qc|\/00\.raw_data\/link_dir|run_ledger\.jsonl|\/composed\/20)/;
    fs.cpSync(path.join(PACKAGE_ROOT, 'demo'), tmp, { recursive: true, filter: (src) => !skip.test(src) });
    const tools = createTools({ ...cfg, workflowRoot: tmp, allowSubmit: false, useConda: false });
    let ok = false;
    try {
      ok = await c.run(tools, tmp);
    } catch (e) {
      console.log(`  异常: ${e}`);
    }
    results[c.id] = ok ? 'pass' : 'fail';
    if (ok) passed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const library = ruleLibraryVersionSync(loadConfig().workflowRoot);
  const baselinePath = path.join(PACKAGE_ROOT, 'eval', 'semantic-baseline.json');
  if (save) {
    fs.writeFileSync(baselinePath, JSON.stringify({ library, results, saved_at: new Date().toISOString() }, null, 2) + '\n');
    console.log(`\n基线已保存: eval/semantic-baseline.json(rule 库: ${library})`);
  } else if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { library: string; results: Record<string, string> };
    const regressions = cases.filter((c) => baseline.results[c.id] === 'pass' && results[c.id] !== 'pass');
    const fixed = cases.filter((c) => baseline.results[c.id] && baseline.results[c.id] !== 'pass' && results[c.id] === 'pass');
    console.log(`\n基线比对(rule 库: ${baseline.library}):`);
    if (regressions.length) console.log(`  退化: ${regressions.map((c) => c.id).join(', ')}`);
    if (fixed.length) console.log(`  修复: ${fixed.map((c) => c.id).join(', ')}`);
    if (!regressions.length && !fixed.length) console.log('  无变化');
    if (baseline.library !== library) console.log(`  [注意] rule 库版本已变化(${baseline.library} → ${library}),判定差异可能来自库变更`);
  } else {
    console.log('\n(无基线;npm run eval:semantic -- --save 保存基线后可比对退化)');
  }
  console.log(`\n结果: ${passed}/${cases.length} 通过`);
  process.exit(passed === cases.length ? 0 : 1);
}

main();
