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

  const cfg = { ...loadConfig(), workflowRoot: tmp };
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
    // 模拟 CLI humanConfirm 应答 confirm_submit 后写入的台账记录
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: task,
      op: 'human_decision',
      target: target,
      object: '.',
      result: 'approved',
      detail: 'CLI 终端人工确认 by=cli-user(自测模拟)',
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
    // 闸 2:写入一次确认,再模拟一次已启动的提交(消耗掉)
    appendLedger(tmp, {
      ts: new Date().toISOString(),
      task_id: t,
      op: 'human_decision',
      target: target,
      object: '.',
      result: 'approved',
      detail: 'CLI 终端人工确认 by=cli-user(自测模拟)',
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

  await check('熔断:同一签名(retryable 桶)第 3 次 dry_run 被拒', async () => {
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
      r3.breaker === 'tripped' &&
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

  await check('run bundle:版本固化 + 副本落盘(非 git → manifest hash)', async () => {
    const { createRunBundle } = await import('../src/run-bundle');
    // 组合目录前缀是当天日期,不能硬编码——按后缀定位实际目录,否则过了当天必失败
    const composedDir = fs
      .readdirSync(path.join(tmp, 'composed'))
      .find((d) => d.endsWith('_selftest_qc_only'));
    if (!composedDir) return false;
    const rel = await createRunBundle(tmp, task, `composed/${composedDir}`);
    if (!rel) return false;
    const versionFile = path.join(tmp, rel, 'rule_library_version.txt');
    const okFiles =
      fs.existsSync(versionFile) &&
      fs.existsSync(path.join(tmp, rel, 'bundle_manifest.json')) &&
      fs.existsSync(path.join(tmp, rel, 'config', 'config.yaml')) &&
      fs.existsSync(path.join(tmp, rel, 'composed', 'Snakefile'));
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    return okFiles && /^(git:|manifests-sha256:)/.test(version) && !version.startsWith('git:');
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
