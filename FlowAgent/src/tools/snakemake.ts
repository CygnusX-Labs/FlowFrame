import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { safeJoin, safeJoinResolved, type AgentMode, type FlowAgentConfig } from '../config';
import {
  appendLedger,
  approvedDigests,
  countSignatureFailures,
  hasSuccessfulDryRun,
  hasUnconsumedApproval,
  lastCountedFailure,
  readLedger,
  successfulDryRunDigests,
} from '../ledger';
import { classifyError } from '../error-classify';
import { createRunBundle } from '../run-bundle';
import { computeExecutionSpecDigestSync } from '../spec-digest';
import { createExecutor, slurmJobAlive, type FlowExecutor } from '../executor';
import { runShell, tail } from '../shell';
import { loadManifests } from './registry';

const taskFields = {
  task_id: z.string().describe('任务 ID(如 20260907_qc_only),贯穿 dry_run/summary/submit,硬约束校验依赖它'),
  targets: z.array(z.string()).min(1).describe('snakemake target 文件路径列表'),
  workdir: z
    .string()
    .optional()
    .describe('相对仓库根的工作目录(组合流程填 composed/<日期>_<需求>/),默认仓库根。参与硬约束:dry-run/人工确认必须针对同一 workdir'),
};

/**
 * task_id / targets 入口校验(安全审查 H1/H2):
 * - task_id 限字母/数字/下划线/中文/点/横线且首字符非 . -,防止拼进提交日志路径时穿越仓库根;
 * - targets 不得以 - 开头——snakemake 会把它解析为选项(如 --snakefile 指向任意文件,
 *   其顶层 Python 在 dry-run 阶段就会被执行,完全绕过 composed/ 三层防线);
 *   也不得含空白(台账按空格拼接/拆分 targets,空白会破坏硬约束的精确匹配)。
 */
export const TASK_ID_RE = /^[\w一-鿿][\w一-鿿.-]*$/;

function validateTaskArgs(task_id: string, targets: string[]): string | null {
  if (!TASK_ID_RE.test(task_id)) {
    return `task_id 非法: "${task_id}"(只允许字母/数字/下划线/中文/点/横线,首字符不得是 . 或 -,不允许路径形式)`;
  }
  for (const t of targets) {
    if (!t || /\s/.test(t)) {
      return `target 非法: "${t}"(不得为空或含空白字符——台账按空格区分 targets,空白会破坏硬约束匹配)`;
    }
    if (t.startsWith('-')) {
      return `target 非法: "${t}"(不得以 - 开头:snakemake 会将其解析为选项,如 --snakefile 可注入任意 Snakefile 绕过组合防线)`;
    }
  }
  return null;
}

/** submit 的 set_resources 白名单(审核手册阶段 1 第 2 项:OOM 自动加内存重试的前提) */
const RESOURCE_KEYS = new Set(['mem_mb', 'disk_mb', 'threads', 'runtime']);

function validateSetResources(
  setResources: Record<string, Record<string, string | number>> | undefined,
): string | null {
  if (!setResources) return null;
  for (const [rule, res] of Object.entries(setResources)) {
    if (!/^[A-Za-z_][\w*]*$/.test(rule)) return `resource 规则名非法: ${rule}(只允许字母/数字/下划线/*)`;
    for (const [k, v] of Object.entries(res ?? {})) {
      if (!RESOURCE_KEYS.has(k)) return `resource key "${k}" 不在白名单(只允许 ${[...RESOURCE_KEYS].join('/')})`;
      if (k === 'runtime') {
        if (typeof v !== 'string' || !/^\d+[smhd]$/.test(v)) return `runtime 值非法: ${v}(格式如 "2h"/"30m")`;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1_048_576) return `${k} 值非法: ${v}(需 1~1048576 的整数)`;
        if (k === 'threads' && n > 1024) return `threads 值非法: ${v}(上限 1024)`;
      }
    }
  }
  return null;
}

/** snakemake --rulegraph 的 dot 输出 → 文本缩进树(confirm 阶段给人看的 rule 链) */
function dotToTree(dot: string): string | undefined {
  const labels = new Map<string, string>();
  const edges: [string, string][] = []; // a -> b:b 依赖 a
  for (const line of dot.split('\n')) {
    let m = /^\s*(\d+)\s*\[label\s*=\s*"([^"]*)"/.exec(line);
    if (m) {
      labels.set(m[1], m[2]);
      continue;
    }
    m = /^\s*(\d+)\s*->\s*(\d+)/.exec(line);
    if (m) edges.push([m[1], m[2]]);
  }
  if (labels.size === 0) return undefined;
  const hasOutgoing = new Set(edges.map(([a]) => a));
  const roots = [...labels.keys()].filter((id) => !hasOutgoing.has(id)); // 无出边 = 最终 target
  const deps = new Map<string, string[]>();
  for (const [a, b] of edges) deps.set(b, [...(deps.get(b) ?? []), a]);
  const seen = new Set<string>();
  const lines: string[] = [];
  const walk = (id: string, depth: number): void => {
    const name = labels.get(id) ?? id;
    const mark = seen.has(id) ? ' (见上)' : '';
    lines.push(`${'  '.repeat(depth)}${name}${mark}`);
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of (deps.get(id) ?? []).sort()) walk(dep, depth + 1);
  };
  roots.sort().forEach((r) => walk(r, 0));
  return lines.join('\n');
}

/** rulegraph 节点 → manifest 的 resources_tier 汇总(组合名带命名空间前缀,按包含关系匹配) */
function tierRollup(root: string, dot: string): Record<string, number> | undefined {
  const names = [...dot.matchAll(/\[label\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  if (names.length === 0) return undefined;
  const tierOf = new Map<string, string>();
  for (const m of loadManifests(root))
    for (const r of m.rules) tierOf.set(r.name, (r as any).resources_tier ?? 'unknown');
  const counts: Record<string, number> = {};
  for (const n of names) {
    // 组合后的名字形如 qc_short_read_qc_r1(带命名空间前缀),取能匹配上的 manifest rule;
    // 命中的是 rule 名,还需回查 tierOf 拿到真正的资源档位(不能把 rule 名当档位)
    const rn = tierOf.has(n) ? n : [...tierOf.keys()].find((k) => n.includes(k));
    const tier = rn ? (tierOf.get(rn) ?? 'unknown') : 'unknown';
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

export function createSnakemakeTools(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  const root = cfg.workflowRoot;

  const condaArgs = cfg.useConda ? ['--use-conda', '--conda-frontend', cfg.condaFrontend] : [];

  // 人工确认工具:没有 execute,由终端(CLI)或前端(useChat)把确认交给用户本人,
  // 模型只能发起请求,不能代替用户应答(规范 §4.6:Agent 无权自行设置 approved)。
  const confirm_submit = tool({
    description:
      '请求用户本人在终端/前端确认正式提交。detailed_summary 之后、submit_cluster 之前必须调用。summary 必须包含:detailed_summary 返回的 job/文件规模、dag_tree(rule 链)、tier_summary(资源档位汇总)、预计输出。工具会暂停等待用户答复:批准返回 {approved:true},拒绝返回 {approved:false}。用户在对话中的口头同意不构成确认,必须走本工具;每次正式提交消耗一次确认记录,续跑/重试前须再次调用本工具。',
    inputSchema: z.object({
      ...taskFields,
      summary: z
        .string()
        .describe('给用户看的计算规模摘要:job 数、关键文件清单、rule 链(dag_tree)、资源档位汇总(tier_summary)、预计输出'),
    }),
    // 无 execute:client-side tool,结果来自人类
  });

  const dry_run = tool({
    description:
      '封装 snakemake -n:验证流程组合定义正确性,不真正执行。结果自动写入运行台账(失败时带归一化报错签名与分桶),是 submit_cluster 的前置硬约束(按 task_id + targets + workdir + 执行对象摘要匹配)。同一报错签名(retryable/unknown 桶)连续失败 2 次后,同一调用不再实际执行第 3 次(熔断前置阻断,铁律 6);样本表类错误直接升级人工,不计熔断。create_envs_only=true 时用 --conda-create-envs-only 预建全部 conda 环境(不跑任务),用于正式运行前排掉环境构建失败。',
    inputSchema: z.object({
      ...taskFields,
      create_envs_only: z.boolean().optional().describe('true 时预建 conda 环境(--conda-create-envs-only),不执行任务'),
    }),
    execute: async ({ task_id, targets, workdir, create_envs_only }) => {
      const invalid = validateTaskArgs(task_id, targets);
      if (invalid) return { ok: false, refused: true, error: invalid };
      let cwd: string;
      try {
        cwd = safeJoinResolved(root, workdir ?? '.');
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      // 熔断前置阻断(架构评审 §4.4):同一调用(task_id+targets+workdir)上次失败签名已计 2 次,
      // 再实际执行必然熔断——直接拒绝,不再跑第 3 次。解除:计划变更(新 task_id 重新 dry-run)或人工清台账。
      const armed = lastCountedFailure(root, task_id, targets, workdir ?? '.');
      if (armed && armed.count >= 2) {
        return {
          ok: false,
          refused: true,
          breaker: 'armed',
          signature: armed.signature,
          bucket: armed.bucket,
          failure_count: armed.count,
          reason: `熔断前置阻断(铁律 6):本调用与上次失败完全一致(task_id+targets+workdir),归一化报错签名「${armed.signature}」已失败 ${armed.count} 次,不再实际执行第 ${armed.count + 1} 次。把报错原文、已试方案、log 摘要整理报告给用户;修复后请用新 task_id 重新 dry_run(计划变更即解除),或人工清除台账中的失败记录后重试。`,
        };
      }
      const args = ['-n', '--cores', '1', ...condaArgs];
      if (create_envs_only && cfg.useConda) args.push('--conda-create-envs-only');
      args.push(...targets);
      const { code, stdout, stderr } = await runShell('snakemake', args, {
        cwd,
        timeoutMs: create_envs_only ? 1_800_000 : 180_000,
      });
      const ok = code === 0;
      const output = tail(stdout + '\n' + stderr, 100);

      // 执行对象摘要:随 dry_run 记录落账,submit 时核对「跑的内容 = 批的内容」(架构评审 §4.2);
      // task_id 使 AnalysisPlan(agent/plans/<task_id>.analysis.yaml)纳入摘要
      const digest = computeExecutionSpecDigestSync(root, workdir ?? '.', targets, task_id);

      // 报错分类 + 熔断计数(审核手册阶段 1 第 2 项)
      let cls: ReturnType<typeof classifyError> | null = null;
      let priorFailures = 0;
      if (!ok) {
        cls = classifyError(output);
        priorFailures = countSignatureFailures(root, task_id, cls.signature);
      }
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'dry_run',
        target: targets.join(' '),
        object: workdir ?? '.',
        result: ok ? 'success' : 'failed',
        detail: tail(output, 20),
        ...(cls ? { signature: cls.signature, bucket: cls.bucket } : {}),
        spec_digest: digest,
        mode,
      });

      if (!ok && cls) {
        const failures = priorFailures + 1;
        if ((cls.bucket === 'retryable' || cls.bucket === 'unknown') && failures >= 3) {
          return {
            ok: false,
            refused: true,
            breaker: 'tripped',
            signature: cls.signature,
            bucket: cls.bucket,
            reason: `熔断(铁律 6):归一化报错签名「${cls.signature}」已失败 ${failures} 次(同类报错即使路径不同也计同一签名)。停止重试,把报错原文、已试方案、log 摘要整理报告给用户。`,
            output_tail: output,
          };
        }
        const bucketHint: Record<string, string> = {
          sample_table: '样本表类错误(不计熔断):按对策表直接升级人工——向用户说明缺什么/哪里冲突,不要继续自行修复样本表。',
          transient:
            '疑似瞬态/资源类错误(不计熔断):自动续跑即可;若为 OOM,用 submit_cluster 的 set_resources 白名单内加内存后重试。',
        };
        return {
          ok: false,
          exit_code: code,
          signature: cls.signature,
          bucket: cls.bucket,
          failure_count: failures,
          output_tail: output,
          next:
            bucketHint[cls.bucket] ??
            `按报错对策表修复后重跑本步${failures === 2 ? ';注意:同一签名已失败 2 次,再失败将熔断' : ''}`,
        };
      }
      return {
        ok,
        exit_code: code,
        output_tail: output,
        next: ok
          ? 'dry-run 通过:调用 detailed_summary 生成计算规模,再调 confirm_submit 交用户本人确认,approved 后才可 submit_cluster'
          : '按报错对策表修复后重跑本步;同一报错连续失败 2 次则停止并报告用户',
      };
    },
  });

  const detailed_summary = tool({
    description:
      '封装 snakemake --detailed-summary:列出每个目标文件的状态/计划/输入输出;同时生成 rule 链文本树(dag_tree,来自 --rulegraph)与资源档位汇总(tier_summary,来自 manifest 的 resources_tier)。三者都放进 confirm_submit 的 summary 交给用户。dry_run 通过后、confirm_submit 之前调用。',
    inputSchema: z.object(taskFields),
    execute: async ({ task_id, targets, workdir }) => {
      const invalid = validateTaskArgs(task_id, targets);
      if (invalid) return { ok: false, refused: true, error: invalid };
      let cwd: string;
      try {
        cwd = safeJoinResolved(root, workdir ?? '.');
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      const { code, stdout, stderr } = await runShell('snakemake', ['--detailed-summary', ...targets], { cwd });
      const ok = code === 0;
      const output = tail(stdout + '\n' + stderr, 120);

      // rule 链文本树 + 资源档位汇总(confirm 信息增强,审核手册阶段 2 第 3 项)
      let dagTree: string | undefined;
      let tierSummary: Record<string, number> | undefined;
      try {
        const rg = await runShell('snakemake', ['--cores', '1', '--rulegraph=dot', ...targets], { cwd, timeoutMs: 60_000 });
        if (rg.code === 0 && rg.stdout.includes('digraph')) {
          dagTree = dotToTree(rg.stdout);
          tierSummary = tierRollup(root, rg.stdout);
        }
      } catch {
        // rulegraph 失败不阻塞 summary(增强项,非硬约束)
      }

      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'summary',
        target: targets.join(' '),
        object: workdir ?? '.',
        result: ok ? 'success' : 'failed',
        detail: tail(output, 20),
        mode,
      });
      return { ok, exit_code: code, summary: output, ...(dagTree ? { dag_tree: dagTree } : {}), ...(tierSummary ? { tier_summary: tierSummary } : {}) };
    },
  });

  const read_log = tool({
    description: '读取仓库内日志文件尾部(如 logs/03.short_read_qc/xxx.log),用于运行期报错定位。只读,路径不允许越出仓库根。',
    inputSchema: z.object({
      path: z.string().describe('相对仓库根的日志路径'),
      tail_lines: z.number().int().positive().max(500).default(100),
    }),
    execute: async ({ path: rel, tail_lines }) => {
      let abs: string;
      try {
        abs = safeJoinResolved(root, rel); // realpath 校验:防 logs/ 下软链指向仓库外
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      if (!fs.existsSync(abs)) return { ok: false, error: `日志不存在: ${rel}` };
      return { ok: true, path: rel, content: tail(fs.readFileSync(abs, 'utf8'), tail_lines) };
    },
  });

  /**
   * 运行状态查询(架构评审 §7.5「持久任务状态/完成事件/post-run manifest」):
   * 从台账找本次任务的提交(started)记录,解析提交日志末尾的退出码行,给出
   * running / succeeded / failed / lost 四种状态;已结束时把 run_state.json 与
   * post_run_manifest.json(实际产物存在性/大小/退出码/日志尾)固化到
   * runs/<task_id>/<run_id>/,并把完成事件落台账(同一 run_id 只落一次)。
   */
  const check_run = tool({
    description:
      '查询已提交运行的状态:返回 running/succeeded/failed/lost/unknown、退出码与各 target 产物是否落盘;已结束时自动固化 run_state.json 与 post_run_manifest.json 到 runs/<task_id>/<run_id>/ 并把完成事件写入台账。Slurm 作业从日志解析作业 ID 后用 squeue 探活。submit_cluster 之后用它跟踪进度与收尾,代替人工 read_log 对退出码;定位具体 rule 报错时再用 read_log。',
    inputSchema: z.object({
      task_id: z.string().describe('任务 ID(submit_cluster 用过的同一个)'),
      run_id: z.string().optional().describe('可选:指定某次提交(缺省查最近一次)'),
    }),
    execute: async ({ task_id, run_id }) => {
      if (!TASK_ID_RE.test(task_id)) return { ok: false, error: `task_id 非法: "${task_id}"` };
      const entries = readLedger(root).filter(
        (e) => e.op === 'submit' && e.result === 'started' && e.task_id === task_id && (!run_id || e.run_id === run_id),
      );
      const last = entries[entries.length - 1];
      if (!last) {
        return { ok: false, error: `台账中不存在 task_id=${task_id}${run_id ? ` run_id=${run_id}` : ''} 的提交(started)记录` };
      }
      const m = /pid=(-?\d+)\s+log=(\S+)(?:\s+run_id=(\S+))?/.exec(last.detail ?? '');
      const logRel = m?.[2];
      const rid = run_id ?? m?.[3] ?? null;
      if (!logRel) return { ok: false, error: '提交记录缺少日志路径,无法定位运行' };

      // 已有固化终态直接返回(重复查询不产生重复完成事件);running 状态不缓存,继续解析日志
      const runDir = rid ? path.join(root, 'runs', task_id.replace(/[^\w-]/g, '_'), rid) : null;
      const stateFile = runDir ? path.join(runDir, 'run_state.json') : null;
      if (stateFile && fs.existsSync(stateFile)) {
        const cached = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { status?: string; exit_code?: number };
        if (cached.status && cached.status !== 'running') {
          return { ok: true, task_id, run_id: rid, status: cached.status, exit_code: cached.exit_code, cached: true };
        }
      }

      let abs: string;
      try {
        abs = safeJoinResolved(root, logRel);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      let exitCode: number | null = null;
      let logText = '';
      if (fs.existsSync(abs)) {
        logText = fs.readFileSync(abs, 'utf8');
        const em = /\[flowagent\] snakemake exited, code=(\d+)/.exec(logText);
        if (em) exitCode = Number(em[1]);
      }
      const targets = (last.target ?? '').split(' ').filter(Boolean);
      const outputs = targets.map((rel) => {
        const p = safeJoin(root, rel);
        const present = fs.existsSync(p);
        return { target: rel, present, ...(present ? { size: fs.statSync(p).size } : {}) };
      });

      let status: string;
      if (exitCode !== null) {
        status = exitCode === 0 ? 'succeeded' : 'failed';
      } else {
        // Slurm 路径:--parsable 作业 ID 在日志首行(或 "Submitted batch job <id>"),用 squeue 探活;
        // 本地路径:提交进程 pid 探活
        const jobId =
          /Submitted batch job (\d+)/.exec(logText)?.[1] ?? (logText.trim() ? (/^(\d+)\s*$/m.exec(logText)?.[1] ?? null) : null);
        if (jobId) {
          const alive = slurmJobAlive(jobId);
          status = alive === true ? 'running' : alive === false ? 'lost' : 'unknown';
        } else {
          const pid = Number(m?.[1] ?? -1);
          let alive = false;
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch {
              alive = false;
            }
          }
          status = alive ? 'running' : 'lost'; // 无退出码行且进程已死:运行失联(kill -9/机器重启)
        }
      }
      if (status === 'running') {
        return { ok: true, task_id, run_id: rid, status, pid: Number(m?.[1]), note: '运行中:作业仍在队列/运行,稍后再次调用 check_run。' };
      }
      if (status === 'unknown') {
        return { ok: true, task_id, run_id: rid, status, note: '无法判定:squeue 不可用且日志无退出码行,请人工核对作业状态。' };
      }

      const finishedAt = new Date().toISOString();
      const present = outputs.filter((o) => o.present).length;
      if (runDir) {
        // 持久任务状态 + post-run manifest(评审 §7.5:实际产物/退出码/结果状态)
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, 'run_state.json'),
          JSON.stringify(
            {
              run_id: rid,
              task_id,
              status,
              pid: m ? Number(m[1]) : null,
              exit_code: exitCode,
              log: logRel,
              started_at: last.ts,
              finished_at: finishedAt,
              outputs_present: `${present}/${outputs.length}`,
            },
            null,
            2,
          ) + '\n',
        );
        fs.writeFileSync(
          path.join(runDir, 'post_run_manifest.json'),
          JSON.stringify(
            {
              run_id: rid,
              task_id,
              exit_code: exitCode,
              finished_at: finishedAt,
              targets: outputs,
              log_tail: fs.existsSync(abs) ? tail(fs.readFileSync(abs, 'utf8'), 20) : null,
            },
            null,
            2,
          ) + '\n',
        );
      }
      // 完成事件落台账(同一 run_id 只落一次);无 run_id 的旧记录不落,避免轮询刷账
      if (rid) {
        const alreadyLogged = readLedger(root).some((e) => e.op === 'submit' && e.result === 'finished' && e.run_id === rid);
        if (!alreadyLogged) {
          appendLedger(root, {
            ts: finishedAt,
            task_id,
            op: 'submit',
            target: last.target,
            object: last.object,
            result: 'finished',
            detail: `exit_code=${exitCode} outputs=${present}/${outputs.length}`,
            run_id: rid,
            spec_digest: last.spec_digest,
            mode,
          });
        }
      }
      return { ok: true, task_id, run_id: rid, status, exit_code: exitCode, outputs, log: logRel };
    },
  });

  /** shell 单引号转义:把参数安全地拼进 bash -c 脚本 */
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  const submit_cluster = tool({
    description:
      '正式提交运行(硬约束工具)。三道闸:① 台账中必须存在本任务(task_id+targets+workdir 一致且执行对象摘要匹配)的 dry_run 成功记录;② 台账中必须存在用户通过 confirm_submit 产生且未被消费的人工确认记录(每次提交消耗一次,续跑需再次确认;模型无权代填);③ 服务端需开启 FLOWAGENT_ALLOW_SUBMIT。提交走执行器(executor 配置:local=本地后台 / slurm=sbatch 集群;slurm 环境自检失败即拒绝,不退回 local),固定带 --rerun-incomplete 与 --cores <部署配置>(LLM 不可改,本地资源护栏),结束后 snakemake 退出码追加到提交日志末尾。OOM 后重试可用 set_resources(白名单 mem_mb/disk_mb/threads/runtime)与 retries(1~3)调资源;提交成功后自动固化 run bundle 与初始 run_state(runs/<task_id>/<run_id>/),运行跟踪用 check_run。',
    inputSchema: z.object({
      ...taskFields,
      reason: z.string().describe('本次提交的理由(如:dry-run 已通过、用户已确认规模),落台账审计'),
      set_resources: z
        .record(z.string(), z.record(z.string(), z.union([z.string(), z.number()])))
        .optional()
        .describe('可选:按 rule 调整资源(白名单 mem_mb/disk_mb/threads/runtime),如 {"qc_fastqc": {"mem_mb": 8192}};OOM 加内存重试用'),
      retries: z.number().int().min(1).max(3).optional().describe('可选:瞬态错误自动重试次数(1~3,默认不重试)'),
    }),
    execute: async ({ task_id, targets, workdir, reason, set_resources, retries }) => {
      const wd = workdir ?? '.';
      const invalid = validateTaskArgs(task_id, targets);
      if (invalid) return { ok: false, refused: true, reason: invalid };
      if (!reason || !reason.trim()) {
        return { ok: false, refused: true, reason: 'reason 必填:说明本次提交的依据(dry-run/人工确认状态),台账审计用。' };
      }
      const resErr = validateSetResources(set_resources);
      if (resErr) return { ok: false, refused: true, reason: `set_resources 参数非法: ${resErr}` };

      // 闸 1/2 升级为摘要绑定(架构评审 §4.2):不再只问「有没有记录」,
      // 而是核对 dry_run/人工确认所绑定的执行对象摘要与当前内容是否一致。
      const dryDigests = successfulDryRunDigests(root, task_id, targets, wd);
      if (dryDigests.size === 0) {
        const everDryRun = hasSuccessfulDryRun(root, task_id, targets, wd);
        return {
          ok: false,
          refused: true,
          reason: everDryRun
            ? `台账中本任务虽有 dry_run 成功记录,但其执行对象摘要与当前内容不一致(组合/config/样本表/rule 库在 dry-run 后有变动)。请先对当前内容重新调用 dry_run,再确认、提交。`
            : `台账(agent/run_ledger.jsonl)中不存在 task_id=${task_id}、相同 targets 且相同 workdir(${wd})的 dry_run 成功记录。铁律 2:dry-run 未通过禁止提交。请先对完全一致的 task_id/targets/workdir 调用 dry_run。`,
        };
      }
      const apprDigests = approvedDigests(root, task_id, targets, wd);
      if (apprDigests.size === 0) {
        return {
          ok: false,
          refused: true,
          reason: `台账中不存在 task_id=${task_id}、相同 targets、相同 workdir(${wd})且与当前内容摘要一致的用户人工确认记录。请先调用 confirm_submit 把计算规模交给用户本人确认;用户在对话中的口头同意不算数。`,
        };
      }
      if (!hasUnconsumedApproval(root, task_id, targets, wd)) {
        return {
          ok: false,
          refused: true,
          reason: `task_id=${task_id} 的人工确认已被消费:每次正式提交消耗一次确认记录,一次 y/N 只放行一次 submit。续跑/重试请再次调用 confirm_submit 交用户本人确认(修复后的规模可能已变)。`,
        };
      }
      let digest: string;
      try {
        digest = computeExecutionSpecDigestSync(root, wd, targets, task_id);
      } catch (e) {
        return { ok: false, refused: true, reason: `执行对象摘要计算失败,按安全策略阻断提交: ${e}` };
      }
      if (!dryDigests.has(digest)) {
        return {
          ok: false,
          refused: true,
          reason:
            '当前执行对象摘要与 dry_run 成功记录绑定的不一致(组合/config/样本表/rule 库在 dry-run 后有变动)。铁律:检查、审批、提交必须针对同一内容,请先重新 dry_run。',
        };
      }
      if (!apprDigests.has(digest)) {
        return {
          ok: false,
          refused: true,
          reason:
            '当前执行对象摘要与人工确认时绑定的不一致(确认后组合/config/样本表/rule 库有变动)。请重新调用 confirm_submit 把最新规模交给用户本人确认。',
        };
      }
      if (!cfg.allowSubmit) {
        return {
          ok: false,
          refused: true,
          reason: '服务端未开启正式提交(FLOWAGENT_ALLOW_SUBMIT!=true)。dry-run 与人工确认记录齐全,请用户决定是否在服务端开启后重试。',
        };
      }
      let cwd: string;
      try {
        cwd = safeJoinResolved(root, wd);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      // 执行器(架构评审 §7.6):local=本地后台;slurm=sbatch(环境自检失败即拒绝,不退回 local)
      let executor: FlowExecutor;
      try {
        executor = createExecutor(cfg);
      } catch (e) {
        return { ok: false, refused: true, reason: `执行器不可用,阻断提交: ${e}` };
      }

      // run bundle 固化(评审 §4.3):每次提交独立 run_id 目录;固化失败即阻断,不再静默提交。
      // 以下到台账落账全部为同步操作,堵住「校验通过 → 记录消费」之间的并发窗口(评审 §4.2)。
      let bundle: string;
      let runId: string;
      try {
        const b = createRunBundle(root, task_id, wd, targets);
        bundle = b.rel;
        runId = b.run_id;
      } catch (e) {
        return { ok: false, refused: true, reason: `运行快照固化失败,按可复现性策略阻断本次提交: ${e}` };
      }

      // task_id 已过 validateTaskArgs(不含 / 与 ..):拼接进日志路径不会越出仓库根(安全审查 H2)
      const logFile = path.join(root, 'logs', 'flowagent', `submit-${task_id}-${Date.now()}.log`);
      const smkArgs = [
        '--cores',
        String(cfg.cores), // 本地资源护栏:固定上限,来自部署配置,LLM 不可改(审核手册问题 2)
        '--rerun-incomplete',
        ...condaArgs,
        ...cfg.extraArgs,
      ];
      if (retries) smkArgs.push('--retries', String(retries));
      for (const [rule, res] of Object.entries(set_resources ?? {}))
        for (const [k, v] of Object.entries(res)) smkArgs.push('--set-resources', `${rule}:${k}=${v}`);
      smkArgs.push(...targets);
      // bash 包一层:结束后把 snakemake 退出码追加到同一份提交日志,供 read_log / 台账对账
      const script = `snakemake ${smkArgs.map(shq).join(' ')}; c=$?; echo "[flowagent] snakemake exited, code=$c" >> ${shq(logFile)}; exit $c`;
      const pid = executor.spawn({ cwd, logFile, script, cores: cfg.cores, taskId: task_id });
      appendLedger(root, {
        ts: new Date().toISOString(),
        task_id,
        op: 'submit',
        target: targets.join(' '),
        object: wd,
        result: 'started',
        detail: `pid=${pid} log=${path.relative(root, logFile)} run_id=${runId} executor=${executor.kind}`,
        reason,
        bundle,
        run_id: runId,
        spec_digest: digest,
        mode,
      });
      // 初始持久状态(running):断线/重启后 check_run 凭台账 + 日志恢复,任务不丢(评审 §7.5)
      try {
        const runDir = path.join(root, 'runs', task_id.replace(/[^\w-]/g, '_'), runId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, 'run_state.json'),
          JSON.stringify(
            { run_id: runId, task_id, status: 'running', executor: executor.kind, pid, log: path.relative(root, logFile), started_at: new Date().toISOString() },
            null,
            2,
          ) + '\n',
        );
      } catch {
        // 状态文件写失败不阻断已授权的提交,check_run 解析日志时会重建
      }
      return {
        ok: true,
        pid,
        run_id: runId,
        log_file: path.relative(root, logFile),
        bundle,
        note: '已后台提交(带 --rerun-incomplete)。用 read_log 跟踪进度;结束时日志末尾有退出码行。失败时读对应 rule 日志修复后重新 submit(仍为断点续跑);OOM 可用 set_resources 加内存,retries 应对瞬断。',
      };
    },
  });

  return { dry_run, detailed_summary, read_log, check_run, submit_cluster, confirm_submit };
}
