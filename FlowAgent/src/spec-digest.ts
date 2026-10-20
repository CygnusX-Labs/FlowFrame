import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * 执行对象摘要(架构评审 §4.2):把「会影响本次运行」的内容压成一个 digest,
 * dry_run / 人工确认 / submit_cluster 三方核对同一摘要,防止「确认 A,执行 B」。
 *
 * 覆盖:targets、rule 库版本(git HEAD 或全库 manifest 联合 hash)、全局
 * config/样本表(config.yaml / samples.csv / units.tsv)、组合工作目录的全部文件,
 * 以及 taskId 对应的 AnalysisPlan(agent/plans/<task_id>.analysis.yaml,存在时)。
 * 刻意不含 set_resources/retries:确认后 OOM 加内存重试属于同一冻结计划内的
 * 许可操作,若绑进摘要会让已批准的续跑路径失效。
 *
 * 全部为同步实现:submit 的闸校验与台账落账之间不允许存在 await,
 * 否则并发请求可穿过「校验通过 → 记录消费」的窗口(评审 §4.2)。
 */
export function ruleLibraryVersionSync(root: string): string {
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
      .toString()
      .trim();
    if (head) return `git:${head}`;
  } catch {
    // 非 git 管理 → 退回 manifest 联合指纹
  }
  const hash = createHash('sha256');
  const mdir = path.join(root, 'rules', 'manifests');
  if (fs.existsSync(mdir)) {
    for (const f of fs.readdirSync(mdir).filter((x) => x.endsWith('.manifest.yaml')).sort()) {
      hash.update(f);
      hash.update('\0');
      hash.update(fs.readFileSync(path.join(mdir, f)));
    }
  }
  return `manifests-sha256:${hash.digest('hex').slice(0, 16)}`;
}

/** 递归 hash 目录内全部文件(相对路径 + 内容),按路径排序保证稳定 */
function hashDir(h: ReturnType<typeof createHash>, root: string, dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      hashDir(h, root, p);
    } else if (e.isFile()) {
      h.update(path.relative(root, p));
      h.update('\0');
      h.update(fs.readFileSync(p));
      h.update('\0');
    }
  }
}

export function computeExecutionSpecDigestSync(
  root: string,
  workdir: string,
  targets: string[],
  taskId?: string,
): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ targets: [...targets].sort(), library: ruleLibraryVersionSync(root) }));
  h.update('\0');

  const addFile = (rel: string): void => {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      h.update(rel);
      h.update('\0');
      h.update(fs.readFileSync(p));
      h.update('\0');
    }
  };
  for (const rel of ['config/config.yaml', 'config/samples.csv', 'config/units.tsv']) addFile(rel);
  // AnalysisPlan(架构评审:审批绑定计划内容摘要):科学方案文件存在即纳入摘要——
  // 方案改动会使 dry_run/确认/提交的摘要一致失效,须以新 task_id 重新走检查与确认。
  if (taskId) addFile(path.join('agent', 'plans', `${taskId}.analysis.yaml`));

  const wd = workdir && workdir !== '.' ? path.join(root, workdir) : null;
  if (wd && fs.existsSync(wd)) {
    hashDir(h, root, wd);
  } else if (!wd) {
    // 工作目录为仓库根时只钉住入口 Snakefile,避免把运行产物/日志卷进摘要
    addFile('Snakefile');
  }
  return h.digest('hex').slice(0, 24);
}
