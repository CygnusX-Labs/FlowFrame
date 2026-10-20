import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeExecutionSpecDigestSync, ruleLibraryVersionSync } from './spec-digest';

export interface RunBundleInfo {
  /** 相对仓库根的 bundle 目录(runs/<task_id>/<run_id>) */
  rel: string;
  /** 本次运行唯一 ID(目录名),同 task_id 多次提交不再互相覆盖 */
  run_id: string;
}

/**
 * run bundle 固化(审核手册阶段 2 第 1 项 + 架构评审 §4.3):
 * submit 时把「这次跑通的组合」的完整上下文快照到 runs/<task_id>/<run_id>/——
 * rule 库版本 + 组合目录副本 + config/样本表副本 + 执行对象摘要。
 *
 * 与旧实现的三点差异(评审 §4.3):
 * - run_id:每次提交独立目录,同 task_id 不再复用/覆盖历史 bundle;
 * - 失败抛错:快照固化失败由 submit 阻断,不再静默提交;
 * - 记录执行对象摘要,与台账中 dry_run/人工确认的摘要可对账。
 *
 * rule 库版本两种路径(FLOW_WORKFLOW_ROOT 是否 git 管理不定,两者都要):
 *   git 管理      → git rev-parse HEAD(精确到 commit);
 *   非 git 管理   → 全库 manifest 的联合 sha256(内容指纹,粗于 commit 但可检测漂移)。
 */
export function createRunBundle(root: string, taskId: string, workdir: string, targets: string[]): RunBundleInfo {
  const safeId = taskId.replace(/[^\w-]/g, '_');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const bundleDir = path.join(root, 'runs', safeId, runId);
  const version = ruleLibraryVersionSync(root);
  const digest = computeExecutionSpecDigestSync(root, workdir, targets, taskId);

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'rule_library_version.txt'), `${version}\n`);

  // 组合目录副本(workdir 为组合目录时)
  if (workdir && workdir !== '.') {
    const src = path.join(root, workdir);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(bundleDir, 'composed'), { recursive: true });
  }

  // config 与样本表副本(样本表是复现的隐性依赖)
  for (const rel of ['config/config.yaml', 'config/samples.csv', 'config/units.tsv']) {
    const src = path.join(root, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(bundleDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  // AnalysisPlan 副本(存在时):科学方案是本次运行的审阅对象,随 bundle 冻结
  const planRel = path.join('agent', 'plans', `${taskId}.analysis.yaml`);
  if (fs.existsSync(path.join(root, planRel))) {
    const dest = path.join(bundleDir, planRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, planRel), dest);
  }

  fs.writeFileSync(
    path.join(bundleDir, 'bundle_manifest.json'),
    JSON.stringify(
      {
        run_id: runId,
        task_id: taskId,
        workdir,
        targets,
        rule_library: version,
        spec_digest: digest,
        created: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  return { rel: path.relative(root, bundleDir), run_id: runId };
}
