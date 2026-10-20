/**
 * 自测脚本:不调用 LLM,直接逐个执行工具,验证后端各环节可用。
 * 把 demo 仓库复制到临时目录,避免污染 demo(台账/缺口日志/组合目录都写在副本里)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, PACKAGE_ROOT } from '../src/config';
import { createTools } from '../src/tools';
import { appendLedger } from '../src/ledger';
import { computeExecutionSpecDigestSync } from '../src/spec-digest';

type ToolMap = ReturnType<typeof createTools>;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    const ok = await fn();
    if (ok) {
      passed++;
      console.log(`PASS  ${name}`);
    } else {
      failed++;
      console.log(`FAIL  ${name}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  异常: ${e}`);
  }
}

// 工具 execute 的第二个参数(AI SDK ToolCallOptions),自测中用桩代替
const stubCtx = { toolCallId: 'selftest', messages: [] } as any;

async function exec(tool: any, input: unknown): Promise<any> {
  return tool.execute(input, stubCtx);
}

async function main() {
  // demo → 临时副本
  const srcDemo = path.join(PACKAGE_ROOT, 'demo');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowagent-selftest-'));
  // 排除运行产物(conda 环境缓存可达数百 MB、日志、已生成输出、历史组合)
  const skip = /(\.snakemake|\/logs|\/01\.qc|\/00\.raw_data\/link_dir|run_ledger\.jsonl|\/composed\/20)/;
  fs.cpSync(srcDemo, tmp, { recursive: true, filter: (src) => !skip.test(src) });
  console.log(`selftest root: ${tmp}\n`);

  // 自测必须确定性:显式关闭提交开关(否则开发者 .env 若设 FLOWAGENT_ALLOW_SUBMIT=true,
  // 闸 3 不再拦截,两个"止步于服务端开关"用例会真的后台拉起 snakemake 并失败)
  const cfg = { ...loadConfig(), workflowRoot: tmp, allowSubmit: false };
  const tools: ToolMap = createTools(cfg);
  const task = 'selftest';
  const target = '01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html';

  await check('query_catalog(关键词:质控)', async () => {
    const r = await exec(tools.query_catalog, { keyword: '质控' });
    return r.ok && r.count >= 2;
  });

  await check('query_ports(全部摘要)', async () => {
    const r = await exec(tools.query_ports, {});
    return r.ok && r.count >= 5;
  });

  await check('query_ports(单个详情)', async () => {
    const r = await exec(tools.query_ports, { port: 'qc.fastqc.zip' });
    return r.ok && r.producers.length === 2;
  });

  await check('query_rules(produces_port=qc.fastqc.zip)', async () => {
    const r = await exec(tools.query_rules, { produces_port: 'qc.fastqc.zip' });
    return r.ok && r.count === 2;
  });

  await check('get_rule(short_read_multiqc_r1,含 schema 形式 config_requires)', async () => {
    const r = await exec(tools.get_rule, { rule_name: 'short_read_multiqc_r1' });
    const keys = (r.rule.config_requires ?? []).map((c: unknown) => (typeof c === 'string' ? c : (c as any).key));
    return r.ok && keys.includes('parameter.threads.multiqc');
  });

  await check('query_catalog(同义词:synonyms 防漏召回)', async () => {
    const r = await exec(tools.query_catalog, { keyword: 'read1' });
    return r.ok && r.count === 1 && r.deliverables[0].id === 'raw_multiqc_r1';
  });

  await check('validate_manifests(内置检查)', async () => {
    const r = await exec(tools.validate_manifests, { task_id: task });
    if (!r.ok) console.log('  issues:', r.issues);
    return r.ok === true;
  });

  await check('bootstrap 契约:样本表缺失→validate_manifests 以 issue 检出(评审 §7.4)', async () => {
    const samplesFile = path.join(tmp, 'config', 'samples.csv');
    const backup = fs.readFileSync(samplesFile);
    fs.rmSync(samplesFile);
    try {
      const r = await exec(tools.validate_manifests, { task_id: task });
      return r.ok === false && r.issues.join('\n').includes('samples.csv');
    } finally {
      fs.writeFileSync(samplesFile, backup); // 还原:后续 dry_run 依赖样本表
    }
  });

  await check('bootstrap 契约:conda 环境缺失→validate_manifests 以 issue 检出', async () => {
    const envFile = path.join(tmp, 'envs', 'fastqc.yaml');
    const backup = fs.readFileSync(envFile);
    fs.rmSync(envFile);
    try {
      const r = await exec(tools.validate_manifests, { task_id: task });
      return r.ok === false && r.issues.join('\n').includes('conda 环境不存在');
    } finally {
      fs.writeFileSync(envFile, backup);
    }
  });

  await check('confirm_submit 为客户端工具(无 execute,由人应答)', async () => {
    return typeof (tools.confirm_submit as any).execute !== 'function';
  });

  await check('submit_cluster 无 dry-run 记录→拒绝(闸1)', async () => {
    const r = await exec(tools.submit_cluster, {
      task_id: 'never-dry-run',
      targets: [target],
      reason: '闸1 对抗用例:无 dry-run 记录',
    });
    return r.ok === false && r.refused === true && r.reason.includes('dry_run');
  });

  await check('dry_run(catalog target)', async () => {
    const r = await exec(tools.dry_run, { task_id: task, targets: [target] });
    if (!r.ok) console.log('  output:', r.output_tail);
    return r.ok === true;
  });

  await check('detailed_summary(含 rule 链文本树 + 资源档位汇总)', async () => {
    const r = await exec(tools.detailed_summary, { task_id: task, targets: [target] });
    return (
      r.ok === true &&
      typeof r.dag_tree === 'string' &&
      r.dag_tree.includes('short_read_multiqc_r1') &&
      r.dag_tree.includes('seq_preprocessor') &&
      r.tier_summary &&
      r.tier_summary.low_resource === 4
    );
  });

  await check('submit_cluster dry-run 已过但无人工确认→拒绝(闸2)', async () => {
    const r = await exec(tools.submit_cluster, { task_id: task, targets: [target] });
    return r.ok === false && r.refused === true && r.reason.includes('人工确认');
  });

  await check('人工确认落账后→仅剩服务端开关拒绝(闸3)', async () => {
    // 模拟 CLI humanConfirm 应答 confirm_submit 后写入的台账记录(含执行对象摘要绑定)
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: task,
      op: 'human_decision',
      target: target,
      object: '.',
      result: 'approved',
      detail: 'CLI 终端人工确认 by=cli-user(自测模拟)',
      spec_digest: computeExecutionSpecDigestSync(tmp, '.', [target], task),
    });
    const r = await exec(tools.submit_cluster, {
      task_id: task,
      targets: [target],
      reason: '闸3 对抗用例:确认已落账,验证服务端开关拦截',
    });
    return r.ok === false && r.refused === true && r.reason.includes('FLOWAGENT_ALLOW_SUBMIT');
  });

  // ---- 安全审查对抗用例(H1/H2/M3/M4)----

  await check('dry_run:target 以 - 开头(--snakefile 注入绕过三层防线)→拒绝', async () => {
    const r = await exec(tools.dry_run, {
      task_id: 'adv_flag_inject',
      targets: ['--snakefile', '/tmp/evil.smk'],
    });
    return r.ok === false && r.error.includes('不得以 - 开头');
  });

  await check('submit_cluster:task_id 路径穿越(写库外日志)→拒绝', async () => {
    const r = await exec(tools.submit_cluster, {
      task_id: '../../evil',
      targets: [target],
      reason: '穿越用例',
    });
    return r.ok === false && r.reason.includes('task_id 非法');
  });

  await check('submit_cluster:target 含空白(破坏台账精确匹配)→拒绝', async () => {
    const r = await exec(tools.submit_cluster, {
      task_id: task,
      targets: ['01.qc/a b.html'],
      reason: '空白 target 用例',
    });
    return r.ok === false && r.reason.includes('空白');
  });

  await check('闸2 消耗:一次确认只放行一次提交,续跑须再确认', async () => {
    const t = 'selftest_consume';
    // 闸 1:本任务先 dry_run 成功
    const d = await exec(tools.dry_run, { task_id: t, targets: [target] });
    if (!d.ok) {
      console.log('  dry_run:', d.output_tail);
      return false;
    }
    // 闸 2:写入一次确认(绑定执行对象摘要),再模拟一次已启动的提交(消耗掉)
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t,
      op: 'human_decision',
      target: target,
      object: '.',
      result: 'approved',
      detail: 'CLI 终端人工确认 by=cli-user(自测模拟)',
      spec_digest: computeExecutionSpecDigestSync(tmp, '.', [target], t),
    });
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t,
      op: 'submit',
      target: target,
      object: '.',
      result: 'started',
      detail: '自测模拟:已启动一次提交,消耗上述确认',
    });
    const r = await exec(tools.submit_cluster, { task_id: t, targets: [target], reason: '消费语义用例' });
    return r.ok === false && r.refused === true && r.reason.includes('已被消费');
  });

  await check('审批绑定执行对象摘要:dry-run+确认后改动 config→submit 被拒(评审 §4.2)', async () => {
    const t = 'selftest_digest_bind';
    const d = await exec(tools.dry_run, { task_id: t, targets: [target] });
    if (!d.ok) {
      console.log('  dry_run:', d.output_tail);
      return false;
    }
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t,
      op: 'human_decision',
      target: target,
      object: '.',
      result: 'approved',
      detail: 'CLI 终端人工确认 by=cli-user(自测模拟)',
      spec_digest: computeExecutionSpecDigestSync(tmp, '.', [target], t),
    });
    // 模拟「确认后改动有效配置」:旧 dry-run 与旧确认不应再放行
    const cfgFile = path.join(tmp, 'config', 'config.yaml');
    const original = fs.readFileSync(cfgFile, 'utf8');
    fs.appendFileSync(cfgFile, '# drift:模拟确认后的配置变动\n');
    try {
      const r = await exec(tools.submit_cluster, { task_id: t, targets: [target], reason: '摘要绑定对抗用例' });
      return r.ok === false && r.refused === true && r.reason.includes('摘要');
    } finally {
      fs.writeFileSync(cfgFile, original); // 还原,避免影响后续用例的摘要
    }
  });

  const composedSnakefile = [
    'configfile: "../../config/config.yaml"',
    'configfile: "../../envs/general_software.yaml"   # 软件路径(Rust 二进制)',
    '',
    'workdir: "../.."   # 目标/路径均相对仓库根',
    '',
    'module qc:',
    '    snakefile: "../../rules/03.short_read_qc.smk"',
    '    config: config',
    '',
    'module md5:',
    '    snakefile: "../../rules/02.file_convert_md5.smk"',
    '    config: config',
    '',
    'use rule * from md5 as md5_*',
    'use rule short_read_qc_r1 from qc as qc_short_read_qc_r1',
    'use rule short_read_multiqc_r1 from qc as qc_short_read_multiqc_r1',
    '',
    'rule all:',
    `    input: "${target}"`,
    '',
  ].join('\n');

  await check('write_composed + 组合 dry-run(三层防线放行合法组合)', async () => {
    const w = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_qc_only',
      snakefile: composedSnakefile,
      reason: 'R1 MultiQC 需要 qc 模块两条 rule + md5 门控,端口链 reads.raw→reads.r1→qc.fastqc.zip→multiqc',
    });
    if (!w.ok) {
      console.log('  write_composed:', w.error);
      return false;
    }
    const r = await exec(tools.dry_run, { task_id: task, targets: [target], workdir: w.dir });
    if (!r.ok) console.log('  composed dry-run:', r.output_tail);
    return r.ok === true;
  });

  await check('workdir 绑定:根目录 dry-run 记录不能放行组合目录 submit(闸1)', async () => {
    // 新组合目录从未 dry-run;task_id/targets 与根目录那条成功记录相同
    const w = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_qc_alt',
      snakefile: composedSnakefile,
      reason: '同上,验证 workdir 绑定用例',
    });
    if (!w.ok) {
      console.log('  write_composed:', w.error);
      return false;
    }
    const r = await exec(tools.submit_cluster, {
      task_id: task,
      targets: [target],
      workdir: w.dir,
      reason: 'workdir 绑定用例:新组合目录无本目录 dry-run 记录',
    });
    return r.ok === false && r.refused === true && r.reason.includes('workdir');
  });

  await check('write_composed 同名目录→拒绝覆盖', async () => {
    const r = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_qc_only',
      snakefile: 'rule all:\n    input: "x"\n',
      reason: '重复目录名用例',
    });
    return r.ok === false;
  });

  await check('write_composed 含 use rule 仍粘贴 rule 本体→拒绝', async () => {
    const pasted = [
      'use rule short_read_qc_r1 from qc as qc_short_read_qc_r1',
      '',
      'rule short_read_qc_r2:   # 复制粘贴的 rule 本体',
      '    input: "00.raw_data/link_dir/{sample}/{sample}_R2.fq.gz"',
      '    output: "01.qc/short_read_qc_r2/{sample}_R2_fastqc.html"',
      '    shell: "fastqc {input}"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'selftest_paste', snakefile: pasted, reason: '粘贴本体用例' });
    return r.ok === false && r.error.includes('rule 定义');
  });

  // ---- 阶段 0 对抗用例:三层防线(审核手册) ----

  await check('防线1:顶层 import Python→拒绝(带行号)', async () => {
    const payload = [
      'configfile: "../../config/config.yaml"',
      'import os',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_import', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('第 2 行') && r.error.includes('白名单');
  });

  await check('防线1:顶层 open(...).write(...) 载荷(实测过的 PoC)→拒绝', async () => {
    const payload = [
      'open("/tmp/PWNED", "w").write("top-level python")',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_open', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('第 1 行');
  });

  await check('防线2:module snakefile 指向库外路径(../ 逃逸)→拒绝', async () => {
    const payload = [
      'module x:',
      '    snakefile: "../../../../../etc/hosts"',
      '    config: config',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_escape', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('越出流程仓库根');
  });

  await check('防线2:configfile 指向库外绝对路径→拒绝', async () => {
    const payload = [
      'configfile: "/etc/passwd"',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_abs', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('越出流程仓库根');
  });

  await check('防线3:use rule with 块函数调用载荷(__import__)→拒绝', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    params: x=__import__("os").system("id")',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_with', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('第 6 行') && /标识符|调用/.test(r.error);
  });

  await check('防线3:rule all input 表达式载荷(__import__)→拒绝', async () => {
    const payload = [
      'rule all:',
      '    input: [__import__("os").popen("id").read()]',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_allexpr', snakefile: payload, reason: '对抗' });
    return r.ok === false && r.error.includes('第 2 行') && /标识符|不允许/.test(r.error);
  });

  await check('防线3:rule all input 放行 expand()(参数限字面量)', async () => {
    const payload = [
      'configfile: "../../config/config.yaml"',
      '',
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    threads: 4',
      '    resources: mem_mb=4096',
      '',
      'rule all:',
      '    input: expand("01.qc/short_read_qc_r1/{sample}_R1_fastqc.html", sample=["S1", "S2"])',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'selftest_expand_ok', snakefile: payload, reason: '合法 with 块与 expand 用例' });
    if (!r.ok) console.log('  error:', r.error);
    return r.ok === true;
  });

  // ---- 阶段 0 补充:with 块路径约束(G1)、注释截断(G3)、惯用语法误伤(G2) ----

  await check('防线2扩展:with 块 output 覆盖指向仓库外(/tmp)→拒绝(G1)', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    output: r1_html="/tmp/flowagent_escape.html"',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_g1_abs', snakefile: payload, reason: 'G1 对抗' });
    return r.ok === false && r.error.includes('越出流程仓库根');
  });

  await check('防线2扩展:with 块 input 相对路径逃逸(../)→拒绝(G1)', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    input: fq="../../../outside.fq"',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_g1_rel', snakefile: payload, reason: 'G1 对抗' });
    return r.ok === false && r.error.includes('越出流程仓库根');
  });

  await check('防线2扩展:rule all input 指向仓库外→拒绝', async () => {
    const payload = ['rule all:', '    input: "/tmp/x.html"', ''].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_alltarget', snakefile: payload, reason: 'target 逃逸对抗' });
    return r.ok === false && r.error.includes('越出流程仓库根');
  });

  await check('防线3:注释截断载荷(注释后续行藏 __import__)→拒绝(G3)', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    output: r1_html="01.qc/a.html"  # 看似无害的注释',
      '        r1_zip=__import__("os").system("id")',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_g3_comment', snakefile: payload, reason: 'G3 对抗' });
    return r.ok === false && /标识符|dunder/.test(r.error);
  });

  await check('防线3:换行命名列表(无逗号,Snakemake 惯用)→放行(G2)', async () => {
    const payload = [
      'configfile: "../../config/config.yaml"',
      '',
      'workdir: "../.."',
      '',
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    output:',
      '        r1_html="01.qc/a.html"',
      '        r1_zip="01.qc/b.zip"',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'selftest_newline_list', snakefile: payload, reason: 'G2 惯用写法放行用例' });
    if (!r.ok) console.log('  error:', r.error);
    return r.ok === true;
  });

  await check('防线3:顶层尾逗号(Python 允许)→放行(G2)', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    output: r1_html="01.qc/a.html",',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'selftest_trailing_comma', snakefile: payload, reason: 'G2 尾逗号放行用例' });
    if (!r.ok) console.log('  error:', r.error);
    return r.ok === true;
  });

  await check('防线3:同行拼接(无逗号无换行)仍→拒绝', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    output: r1_html="01.qc/a.html" r1_zip="01.qc/b.zip"',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'adv_sameline', snakefile: payload, reason: '同行拼接对抗' });
    return r.ok === false && r.error.includes('同行拼接');
  });

  await check('防线3:负数字面量 params→放行', async () => {
    const payload = [
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_qc_r1 from qc as qc_x with:',
      '    params: cutoff=-1',
      '',
      'rule all:',
      '    input: "01.qc/x.html"',
      '',
    ].join('\n');
    const r = await exec(tools.write_composed, { task_id: task, name: 'selftest_neg_num', snakefile: payload, reason: '负数字面量放行用例' });
    if (!r.ok) console.log('  error:', r.error);
    return r.ok === true;
  });

  // ---- 阶段 1:config schema 校验 ----

  await check('config 副本 schema:数值字段填字符串→拒绝(带字段路径)', async () => {
    const badCfg = ['parameter:', '  threads:', '    fastqc: "两"', ''].join('\n');
    const payload = composedSnakefile; // 合法组合
    const r = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_bad_cfg',
      snakefile: payload,
      config_yaml: badCfg,
      reason: 'schema 对抗用例',
    });
    return r.ok === false && r.error.includes("config['parameter.threads.fastqc']") && r.error.includes('integer');
  });

  await check('config 副本 schema:枚举外取值→拒绝', async () => {
    const badCfg = ['convert_md5: "copy"', ''].join('\n');
    const r = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_bad_enum',
      snakefile: composedSnakefile,
      config_yaml: badCfg,
      reason: 'schema 对抗用例',
    });
    return r.ok === false && r.error.includes('枚举');
  });

  await check('config 副本 schema:合法值放行', async () => {
    const okCfg = ['convert_md5: link_dir', 'parameter:', '  threads:', '    fastqc: 4', '    multiqc: 2', ''].join('\n');
    const r = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_ok_cfg',
      snakefile: composedSnakefile,
      config_yaml: okCfg,
      reason: '合法 config 副本用例',
    });
    return r.ok === true;
  });

  // ---- 阶段 1:reason 必填 ----

  await check('write_gap_log 缺 reason→拒绝', async () => {
    const r = await exec(tools.write_gap_log, { task_id: task, need: 'x', missing: 'deliverable:x' } as any);
    return r.ok === false && r.error.includes('reason');
  });

  await check('write_gap_log(缺口记录+计数,reason 落台账)', async () => {
    const r1 = await exec(tools.write_gap_log, {
      task_id: task,
      need: '差异表达分析',
      missing: 'deliverable:diff_expr',
      reason: 'catalog 与端口表均无差异表达相关 deliverable/生产者',
    });
    const r2 = await exec(tools.write_gap_log, {
      task_id: task,
      need: '差异表达分析',
      missing: 'deliverable:diff_expr',
      reason: '同上,重复出现累计',
    });
    return r1.ok && r2.ok && r2.count === 2;
  });

  await check('read_log(路径越界→拒绝)', async () => {
    const r = await exec(tools.read_log, { path: '../../etc/passwd', tail_lines: 5 });
    return r.ok === false;
  });

  // ---- 阶段 1:熔断签名归一化 + 分桶(审核手册问题 4 / 原评审 #6) ----

  await check('熔断:同一签名(retryable 桶)第 3 次 dry_run 被前置阻断(不再实际执行,评审 §4.4)', async () => {
    const breakerSnakefile = [
      'configfile: "../../config/config.yaml"',
      '',
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_multiqc_r1 from qc as qc_short_read_multiqc_r1',
      '',
      'rule all:',
      '    input: "01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html"',
      '',
    ].join('\n');
    const w = await exec(tools.write_composed, {
      task_id: 'selftest_breaker',
      name: 'selftest_breaker',
      snakefile: breakerSnakefile,
      reason: '只引 multiqc(缺 fastqc 生产者),制造稳定 MissingInput 用例',
    });
    if (!w.ok) {
      console.log('  write_composed:', w.error);
      return false;
    }
    const t = '01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html';
    const run = () => exec(tools.dry_run, { task_id: 'selftest_breaker', targets: [t], workdir: w.dir });
    const r1 = await run();
    const r2 = await run();
    const r3 = await run();
    if (r1.ok || r2.ok) {
      console.log('  预期前两次失败,实际通过了——用例构造失效');
      return false;
    }
    return (
      r1.bucket === 'retryable' &&
      r1.signature === r2.signature && // 路径/数字不同也应归一为同一签名
      r2.failure_count === 2 &&
      r3.refused === true &&
      (r3.breaker === 'armed' || r3.breaker === 'tripped') && // armed=执行前阻断,tripped=兜底
      r3.reason.includes('熔断')
    );
  });

  await check('classifyError:路径/样本不同的同类报错归一为同一签名,分桶正确', async () => {
    const { classifyError } = await import('../src/error-classify');
    const a = classifyError(
      'MissingInputException in rule qc_x in file /repo/a.smk, line 3:\nMissing input files for rule qc_x:\n01.qc/S1/x.zip',
    );
    const b = classifyError(
      'MissingInputException in rule qc_x in file /repo/b.smk, line 7:\nMissing input files for rule qc_x:\n01.qc/S2/y.zip',
    );
    const wild = classifyError('WildcardError in rule align: No values given for wildcard sample.');
    const oom = classifyError('[flowagent] snakemake exited, code=137');
    return (
      a.signature === b.signature &&
      a.bucket === 'retryable' &&
      wild.bucket === 'sample_table' &&
      oom.bucket === 'transient'
    );
  });

  // ---- 阶段 1:submit resources 写口 ----

  await check('submit_cluster:set_resources 白名单外 key→拒绝', async () => {
    const r = await exec(tools.submit_cluster, {
      task_id: task,
      targets: [target],
      reason: '资源写口对抗用例',
      set_resources: { qc_short_read_qc_r1: { gpu: 1 } },
    });
    return r.ok === false && r.refused === true && r.reason.includes('set_resources 参数非法');
  });

  await check('submit_cluster:set_resources 合法值通过校验(止步于服务端开关)', async () => {
    const r = await exec(tools.submit_cluster, {
      task_id: task,
      targets: [target],
      reason: 'dry-run 已通过、人工确认已落账(自测模拟)',
      set_resources: { qc_short_read_qc_r1: { mem_mb: 8192, runtime: '2h' } },
      retries: 2,
    });
    return r.ok === false && r.refused === true && r.reason.includes('FLOWAGENT_ALLOW_SUBMIT');
  });

  await check('submit_cluster:缺 reason→拒绝', async () => {
    const r = await exec(tools.submit_cluster, { task_id: task, targets: [target] } as any);
    return r.ok === false && r.reason.includes('reason');
  });

  // ---- 阶段 2:pattern 必填 + run bundle ----

  await check('validate_manifests:io 缺 pattern→issue(入库门禁)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'rules', 'manifests', '99.selftest_bad.manifest.yaml'),
      [
        'module:',
        '  id: "99.selftest_bad"',
        '  snakefile: "rules/nonexistent.smk"',
        'rules:',
        '  - name: bad_rule',
        '    inputs:',
        '      - name: x',
        '        port: "reads.r1.fastq"',
        '    outputs:',
        '      - name: y',
        '        port: "qc.fastqc.html"',
        '',
      ].join('\n'),
    );
    const r = await exec(tools.validate_manifests, { task_id: task });
    fs.rmSync(path.join(tmp, 'rules', 'manifests', '99.selftest_bad.manifest.yaml'));
    return r.ok === false && r.issues.some((i: string) => i.includes('缺少 pattern'));
  });

  await check('选中 rule 必需字段:缺失→write_composed 拒绝 + validate_manifests 检出(评审:校验有效合并配置)', async () => {
    // 造一个库内本来就没有的必需 key 的临时 rule(纯 schema,不占端口)
    const smkRel = 'rules/98.selftest_req.smk';
    const mfRel = 'rules/manifests/98.selftest_req.manifest.yaml';
    fs.writeFileSync(path.join(tmp, smkRel), 'rule req_rule:\n    output: touch("98.selftest_req.done")\n    shell: "true"\n');
    fs.writeFileSync(
      path.join(tmp, mfRel),
      [
        'module:',
        '  id: "98.selftest_req"',
        '  snakefile: "rules/98.selftest_req.smk"',
        'rules:',
        '  - name: req_rule',
        '    summary: "selftest 必需字段用例"',
        '    config_requires:',
        '      - key: "selftest_only.required_key"',
        '        type: "string"',
        '',
      ].join('\n'),
    );
    const reqSnakefile = [
      'configfile: "../../config/config.yaml"',
      '',
      'module req:',
      '    snakefile: "../../rules/98.selftest_req.smk"',
      '    config: config',
      '',
      'use rule req_rule from req as req_req_rule',
      '',
      'rule all:',
      '    input: "98.selftest_req.done"',
      '',
    ].join('\n');
    // ① 选中 rule 的必需 key 缺失:write_composed 拒绝(校验对象是 仓库config+副本 的合并结果)
    const bad = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_req_missing',
      snakefile: reqSnakefile,
      config_yaml: 'convert_md5: link_dir\n',
      reason: '选中 rule 必需字段缺失对抗用例',
    });
    const refused = bad.ok === false && bad.error.includes('selftest_only.required_key');
    // ② 补上必需 key:放行
    const good = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_req_ok',
      snakefile: reqSnakefile,
      config_yaml: ['selftest_only:', '  required_key: "x"', ''].join('\n'),
      reason: '选中 rule 必需字段补齐用例',
    });
    let detected = false;
    if (refused && good.ok) {
      // ③ 写入后副本被改坏(删掉必需 key):validate_manifests 以 error 检出
      const dir = good.dir as string;
      fs.writeFileSync(path.join(tmp, dir, 'config.yaml'), 'convert_md5: link_dir\n');
      const v = await exec(tools.validate_manifests, { task_id: task, workdir: dir });
      detected = v.ok === false && v.issues.join('\n').includes('selftest_only.required_key');
    }
    // 清理临时 rule,避免影响后续用例
    fs.rmSync(path.join(tmp, smkRel));
    fs.rmSync(path.join(tmp, mfRel));
    return refused && good.ok && detected;
  });

  await check('选中子图闭合:只选 multiqc(缺 fastqc 生产者)→validate_manifests 以 error 检出(评审 §7.3)', async () => {
    // 与熔断用例同一手法:只引 multiqc(缺 fastqc 生产者),制造不闭合子图
    const openSnakefile = [
      'configfile: "../../config/config.yaml"',
      '',
      'module qc:',
      '    snakefile: "../../rules/03.short_read_qc.smk"',
      '    config: config',
      '',
      'use rule short_read_multiqc_r1 from qc as qc_short_read_multiqc_r1',
      '',
      'rule all:',
      `    input: "${target}"`,
      '',
    ].join('\n');
    const w = await exec(tools.write_composed, {
      task_id: task,
      name: 'selftest_open_graph',
      snakefile: openSnakefile,
      reason: '选中子图不闭合对抗用例:只选聚合 rule,缺生产者',
    });
    if (!w.ok) {
      console.log('  write_composed:', w.error);
      return false;
    }
    const v = await exec(tools.validate_manifests, { task_id: task, workdir: w.dir });
    const bad = v.ok === false && v.issues.join('\n').includes('选中子图不闭合') && v.issues.join('\n').includes('qc.fastqc.zip');
    // 对照:完整组合(md5 全模块 + qc_r1 + multiqc_r1)闭合,不得误报
    const fullDir = fs
      .readdirSync(path.join(tmp, 'composed'))
      .find((d) => d.endsWith('_selftest_qc_only'));
    if (!fullDir) return false;
    const full = await exec(tools.validate_manifests, { task_id: task, workdir: `composed/${fullDir}` });
    return bad && full.ok === true;
  });

  await check('PipelinePlan 编译器:结构化计划→模板 Snakefile→dry_run 端到端通过(评审 §7.3)', async () => {
    const r = await exec(tools.compile_pipeline, {
      task_id: 'selftest_compiled',
      name: 'selftest_compiled',
      modules: [
        { alias: 'md5', snakefile: 'rules/02.file_convert_md5.smk' },
        { alias: 'qc', snakefile: 'rules/03.short_read_qc.smk' },
      ],
      uses: [
        { rule: 'seq_preprocessor', from: 'md5', as: 'md5_seq_preprocessor' },
        { rule: 'check_md5', from: 'md5', as: 'md5_check_md5' },
        { rule: 'short_read_qc_r1', from: 'qc', as: 'qc_short_read_qc_r1' },
        { rule: 'short_read_multiqc_r1', from: 'qc', as: 'qc_short_read_multiqc_r1' },
      ],
      targets: [target],
      reason: 'PipelinePlan 编译器用例:与手写组合等价的最小质控计划',
    });
    if (!r.ok) {
      console.log('  compile:', r.error);
      return false;
    }
    const d = await exec(tools.dry_run, { task_id: 'selftest_compiled', targets: [target], workdir: r.dir });
    return d.ok === true;
  });

  await check('PipelinePlan 编译器:use_all 整模块引入(md5_* + 显式 qc)→ 编译 + dry_run 通过', async () => {
    const r = await exec(tools.compile_pipeline, {
      task_id: 'selftest_compiled_all',
      name: 'selftest_compiled_all',
      modules: [
        { alias: 'md5', snakefile: 'rules/02.file_convert_md5.smk' },
        { alias: 'qc', snakefile: 'rules/03.short_read_qc.smk' },
      ],
      uses: [
        { rule: 'short_read_qc_r1', from: 'qc', as: 'qc_short_read_qc_r1' },
        { rule: 'short_read_multiqc_r1', from: 'qc', as: 'qc_short_read_multiqc_r1' },
      ],
      use_all: [{ from: 'md5', prefix: 'md5' }],
      targets: [target],
      reason: 'use_all 用例:与 demo 手写组合同构(整模块 md5 + 显式 qc)',
    });
    if (!r.ok) {
      console.log('  compile:', r.error);
      return false;
    }
    const d = await exec(tools.dry_run, { task_id: 'selftest_compiled_all', targets: [target], workdir: r.dir });
    return d.ok === true;
  });

  await check('PipelinePlan 编译器:不闭合计划/幽灵 module/坏标识符→拒绝', async () => {
    const open = await exec(tools.compile_pipeline, {
      task_id: task,
      name: 'selftest_compiled_open',
      modules: [{ alias: 'qc', snakefile: 'rules/03.short_read_qc.smk' }],
      uses: [{ rule: 'short_read_multiqc_r1', from: 'qc', as: 'qc_multiqc' }],
      targets: [target],
      reason: '不闭合计划用例',
    });
    const ghostMod = await exec(tools.compile_pipeline, {
      task_id: task,
      name: 'selftest_compiled_ghost',
      modules: [{ alias: 'x', snakefile: 'rules/nonexistent.smk' }],
      uses: [{ rule: 'seq_preprocessor', from: 'x', as: 'x_seq' }],
      targets: [target],
      reason: '幽灵 module 用例',
    });
    const badIdent = await exec(tools.compile_pipeline, {
      task_id: task,
      name: 'selftest_compiled_bad',
      modules: [{ alias: 'bad-ident', snakefile: 'rules/03.short_read_qc.smk' }],
      uses: [{ rule: 'short_read_qc_r1', from: 'bad-ident', as: 'x' }],
      targets: [target],
      reason: '坏标识符用例',
    });
    return (
      open.ok === false &&
      String(open.error).includes('不闭合') &&
      ghostMod.ok === false &&
      String(ghostMod.error).includes('不存在') &&
      badIdent.ok === false
    );
  });

  await check('AnalysisPlan:写方案→纳入摘要;重复写/幽灵 rule 被拒(评审:科学方案成明确审阅对象)', async () => {
    const t = 'selftest_plan';
    const digestBefore = computeExecutionSpecDigestSync(tmp, '.', [target], t);
    const good = await exec(tools.write_analysis_plan, {
      task_id: t,
      scientific_goal: '比较 case 与 ctrl 的测序质量',
      grouping: 'case(S1) vs ctrl(S2),取自 config/samples.csv 的 group 列',
      method_assumptions: 'fastqc+multiqc 通用质控,不检验生物学差异',
      deliverable: 'raw_multiqc_r1',
      rules: ['short_read_qc_r1', 'short_read_multiqc_r1'],
      reason: 'catalog 命中 deliverable 的质控方案',
    });
    const digestAfter = computeExecutionSpecDigestSync(tmp, '.', [target], t);
    const dup = await exec(tools.write_analysis_plan, {
      task_id: t,
      scientific_goal: '改写方案',
      grouping: 'g',
      method_assumptions: 'a',
      deliverable: 'raw_multiqc_r1',
      rules: ['short_read_qc_r1'],
      reason: '重复写方案用例',
    });
    const ghost = await exec(tools.write_analysis_plan, {
      task_id: 'selftest_plan_ghost',
      scientific_goal: 'x',
      grouping: 'g',
      method_assumptions: 'a',
      deliverable: 'd',
      rules: ['no_such_rule'],
      reason: '幽灵 rule 用例',
    });
    return (
      good.ok === true &&
      digestBefore !== digestAfter && // 方案文件纳入执行对象摘要
      dup.ok === false &&
      dup.refused === true &&
      ghost.ok === false &&
      ghost.error.includes('no_such_rule')
    );
  });

  await check('HTTP 审批接口:服务端自算摘要绑定,未 dry-run 拒批/内容漂移拒批/confirm_id 一次性(评审 §4.1)', async () => {
    const { createFlowAgentServer } = await import('../src/server');
    const srv = createFlowAgentServer({ ...cfg, port: 0, authToken: '' });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    const post = async (body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as { ok?: boolean; error?: string; spec_digest?: string } };
    };
    try {
      // ① 未 dry-run 过的任务 → 拒绝批准(不能批未检查的内容)
      const noDry = await post({ task_id: 'http_approve_never', targets: [target], decision: 'approved' });
      // ② 本任务已有 dry_run 成功记录(task=selftest,仓库根)→ 批准成功,摘要服务端自算
      const ok1 = await post({ task_id: task, targets: [target], workdir: '.', confirm_id: 'http-confirm-1', decision: 'approved' });
      // ③ 同一 confirm_id 再次批准 → 409 一次性消费
      const dup = await post({ task_id: task, targets: [target], workdir: '.', confirm_id: 'http-confirm-1', decision: 'approved' });
      // ④ 摘要不匹配(workdir 不一致)→ 400
      const drift = await post({ task_id: task, targets: [target], workdir: 'composed/nope', decision: 'approved' });
      // ⑤ 拒绝决议也落账(rejected,同样绑定摘要)
      const rej = await post({ task_id: task, targets: [target], workdir: '.', confirm_id: 'http-confirm-2', decision: 'rejected' });
      return (
        noDry.status === 400 &&
        ok1.status === 200 &&
        ok1.body.ok === true &&
        typeof ok1.body.spec_digest === 'string' &&
        dup.status === 409 &&
        drift.status === 400 &&
        rej.status === 200
      );
    } finally {
      srv.close();
    }
  });

  await check('HTTP 审批接口:内容漂移后拒批(dry-run 后改动 config,摘要不一致→409)', async () => {
    const { createFlowAgentServer } = await import('../src/server');
    const srv = createFlowAgentServer({ ...cfg, port: 0, authToken: '' });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    const cfgFile = path.join(tmp, 'config', 'config.yaml');
    const original = fs.readFileSync(cfgFile, 'utf8');
    fs.appendFileSync(cfgFile, '# drift:http approve 用例\n');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: task, targets: [target], decision: 'approved' }),
      });
      return r.status === 409; // 有 dry-run 记录但内容已漂移 → 摘要不一致拒批
    } finally {
      fs.writeFileSync(cfgFile, original);
      srv.close();
    }
  });

  await check('check_run:无提交记录→报错;模拟完成运行→succeeded+产物清单+状态文件+完成事件只落一次', async () => {
    const none = await exec(tools.check_run, { task_id: 'never-submitted' });
    // 伪造一次已完成提交:日志含退出码行;target 在副本中不存在(验证产物清单如实记录缺失)
    const t2 = 'selftest_checkrun';
    const missingTarget = '01.qc/short_read_r1_multiqc/multiqc_r1_raw-data_report.html';
    const logRel = 'logs/flowagent/submit-selftest_checkrun-fake.log';
    fs.mkdirSync(path.join(tmp, 'logs', 'flowagent'), { recursive: true });
    fs.writeFileSync(path.join(tmp, logRel), 'Building DAG of jobs...\n[flowagent] snakemake exited, code=0\n');
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t2,
      op: 'submit',
      target: missingTarget,
      object: '.',
      result: 'started',
      detail: `pid=${process.pid} log=${logRel} run_id=fake-run-1`,
      run_id: 'fake-run-1',
      reason: 'check_run 用例',
    });
    const r1 = await exec(tools.check_run, { task_id: t2 });
    const r2 = await exec(tools.check_run, { task_id: t2 }); // 第二次查询走缓存,不重复落账
    const ledgerText = fs.readFileSync(path.join(tmp, 'agent', 'run_ledger.jsonl'), 'utf8');
    const finishedCount = ledgerText
      .split('\n')
      .filter((l) => l.includes('"run_id":"fake-run-1"') && l.includes('"result":"finished"')).length;
    return (
      none.ok === false &&
      r1.ok === true &&
      r1.status === 'succeeded' &&
      r1.exit_code === 0 &&
      r1.outputs[0].present === false &&
      fs.existsSync(path.join(tmp, 'runs', t2, 'fake-run-1', 'run_state.json')) &&
      fs.existsSync(path.join(tmp, 'runs', t2, 'fake-run-1', 'post_run_manifest.json')) &&
      finishedCount === 1 &&
      r2.status === 'succeeded'
    );
  });

  await check('executor 接口:local 可后台提交;slurm 环境自检失败即抛错(评审 §7.6)', async () => {
    const { createExecutor } = await import('../src/executor');
    const local = createExecutor({ ...cfg, executor: 'local' });
    if (local.kind !== 'local') return false;
    // local 真实后台提交一个立即结束的脚本,验证接口可用
    const logRel = 'logs/flowagent/executor-selftest.log';
    fs.mkdirSync(path.dirname(path.join(tmp, logRel)), { recursive: true });
    const pid = local.spawn({
      cwd: tmp,
      logFile: path.join(tmp, logRel),
      script: 'echo ok >> logs/flowagent/executor-selftest.log',
      cores: 1,
      taskId: 'executor_selftest',
    });
    if (!(pid > 0)) return false;
    // 本机无 sbatch(自测前置条件),slurm 构造必须明确抛错而不是静默退回 local
    let threw = false;
    try {
      createExecutor({ ...cfg, executor: 'slurm' });
    } catch (e) {
      threw = String(e).includes('sbatch');
    }
    return threw;
  });

  await check('GET /api/runs:服务端任务状态视图(聚合 run_state,不依赖客户端历史)', async () => {
    const { createFlowAgentServer } = await import('../src/server');
    const srv = createFlowAgentServer({ ...cfg, port: 0, authToken: '' });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/runs`);
      const body = (await r.json()) as { ok?: boolean; runs?: { task_id: string; run_id: string; state: { status?: string } }[] };
      // 前序 check_run 用例固化的 run_state 必须出现在服务端视图里
      const hit = body.runs?.find((x) => x.run_id === 'fake-run-1');
      return r.status === 200 && body.ok === true && hit !== undefined && hit.state.status === 'succeeded';
    } finally {
      srv.close();
    }
  });

  await check('check_run:无退出码行且进程存活→running', async () => {
    const t3 = 'selftest_checkrun_running';
    const logRel = 'logs/flowagent/submit-selftest_checkrun_running.log';
    fs.writeFileSync(path.join(tmp, logRel), 'Building DAG of jobs...\n');
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t3,
      op: 'submit',
      target: '98.selftest_req.done',
      object: '.',
      result: 'started',
      detail: `pid=${process.pid} log=${logRel} run_id=fake-run-2`,
      run_id: 'fake-run-2',
      reason: 'check_run running 用例',
    });
    const r = await exec(tools.check_run, { task_id: t3 });
    return r.ok === true && r.status === 'running';
  });


  await check('run bundle:版本固化 + 副本落盘(非 git → manifest hash)+ run_id 唯一不覆盖', async () => {
    const { createRunBundle } = await import('../src/run-bundle');
    // 组合目录前缀是当天日期,不能硬编码——按后缀定位实际目录,否则过了当天必失败
    const composedDir = fs
      .readdirSync(path.join(tmp, 'composed'))
      .find((d) => d.endsWith('_selftest_qc_only'));
    if (!composedDir) return false;
    const b1 = createRunBundle(tmp, task, `composed/${composedDir}`, [target]);
    const b2 = createRunBundle(tmp, task, `composed/${composedDir}`, [target]);
    const versionFile = path.join(tmp, b1.rel, 'rule_library_version.txt');
    const okFiles =
      fs.existsSync(versionFile) &&
      fs.existsSync(path.join(tmp, b1.rel, 'bundle_manifest.json')) &&
      fs.existsSync(path.join(tmp, b1.rel, 'config', 'config.yaml')) &&
      fs.existsSync(path.join(tmp, b1.rel, 'composed', 'Snakefile'));
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    // 同 task_id 两次固化:run_id 不同、目录各自独立(架构评审 §4.3:不再互相覆盖)
    const distinct = b1.run_id !== b2.run_id && fs.existsSync(path.join(tmp, b2.rel));
    return (
      okFiles &&
      distinct &&
      /^(git:|manifests-sha256:)/.test(version) &&
      !version.startsWith('git:')
    );
  });

  await check('台账已记录 dry_run 成功、human_decision、reason 与报错签名', async () => {
    const ledger = fs.readFileSync(path.join(tmp, 'agent', 'run_ledger.jsonl'), 'utf8');
    return (
      ledger.includes('"op":"dry_run"') &&
      ledger.includes('"result":"success"') &&
      ledger.includes('"op":"human_decision"') &&
      ledger.includes('"result":"approved"') &&
      ledger.includes('"reason"') &&
      ledger.includes('"signature"')
    );
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
