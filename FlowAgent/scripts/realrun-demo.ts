/**
 * demo 真实运行:走后端真实工具路径 dry_run → 人工确认落账 → submit_cluster(后台 snakemake --use-conda)。
 * 首次会构建 fastqc/multiqc conda 环境,耗时几分钟。
 * 用法:FLOWAGENT_ALLOW_SUBMIT=true npm run demo:run
 * (执行本命令即代表你本人批准提交,脚本会把 human_decision 记录写入台账)
 */
import { loadConfig } from '../src/config';
import { createTools } from '../src/tools';
import { appendLedger, hasSuccessfulDryRun, hasUnconsumedApproval } from '../src/ledger';
import { computeExecutionSpecDigestSync } from '../src/spec-digest';

const target = process.argv[2] ?? '01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html';
const taskId = 'demo_realrun';
const ctx = { toolCallId: 'realrun', messages: [] } as any;

async function main() {
  const cfg = loadConfig();
  const tools = createTools(cfg);
  console.log(`root: ${cfg.workflowRoot}\ntarget: ${target}\n`);

  if (!hasSuccessfulDryRun(cfg.workflowRoot, taskId, [target])) {
    console.log('[1/3] dry_run(含 --use-conda)...');
    const d: any = await tools.dry_run.execute!({ task_id: taskId, targets: [target] }, ctx);
    console.log(`dry_run ok = ${d.ok}`);
    if (!d.ok) {
      console.log(d.output_tail);
      process.exit(1);
    }
  } else {
    console.log('[1/3] 台账已有本任务 dry-run 成功记录,跳过');
  }

  if (!hasUnconsumedApproval(cfg.workflowRoot, taskId, [target])) {
    console.log('[2/3] 人工确认:执行本命令即视为你本人批准,写入 human_decision 台账(每次提交消耗一次)...');
    appendLedger(cfg.workflowRoot, {
      ts: new Date().toISOString(),
      task_id: taskId,
      op: 'human_decision',
      target,
      object: '.',
      result: 'approved',
      detail: 'demo:run 脚本执行即人工确认 by=cli-user',
      spec_digest: computeExecutionSpecDigestSync(cfg.workflowRoot, '.', [target]),
    });
  } else {
    console.log('[2/3] 台账已有本任务人工确认记录,跳过');
  }

  console.log('[3/3] submit_cluster...');
  const r: any = await tools.submit_cluster.execute!(
    { task_id: taskId, targets: [target], reason: 'demo:run 脚本:dry-run 已通过且人工确认已落账' },
    ctx,
  );
  console.log(JSON.stringify(r, null, 2));
  if (r.ok) {
    console.log(`\n跟踪进度: tail -f ${cfg.workflowRoot}/${r.log_file}`);
  }
}

main();
