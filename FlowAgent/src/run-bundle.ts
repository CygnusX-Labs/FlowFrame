import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runShell } from './shell';

/**
 * run bundle 固化(审核手册阶段 2 第 1 项,对应原评审 #10 可复现性):
 * submit 时把「这次跑通的组合」的完整上下文快照到 runs/<task_id>/bundle/——
 * rule 库版本 + 组合目录副本 + config/样本表副本,三个月后 rule 库更新也能复原本次运行。
 *
 * rule 库版本两种路径(手册遗留确认项 2 的答案:FLOW_WORKFLOW_ROOT 是否 git 管理不定,两者都要):
 *   git 管理      → git rev-parse HEAD(精确到 commit);
 *   非 git 管理   → 全库 manifest 的联合 sha256(内容指纹,粗于 commit 但可检测漂移)。
 */
export async function createRunBundle(root: string, taskId: string, workdir: string): Promise<string | null> {
  try {
    const safeId = taskId.replace(/[^\w-]/g, '_');
    const bundleDir = path.join(root, 'runs', safeId, 'bundle');

    // 1. rule 库版本
    let version: string;
    const git = await runShell('git', ['-C', root, 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
    if (git.code === 0 && git.stdout.trim()) {
      version = `git:${git.stdout.trim()}`;
    } else {
      const hash = createHash('sha256');
      const mdir = path.join(root, 'rules', 'manifests');
      if (fs.existsSync(mdir)) {
        for (const f of fs.readdirSync(mdir).filter((x) => x.endsWith('.manifest.yaml')).sort()) {
          hash.update(f);
          hash.update('\0');
          hash.update(fs.readFileSync(path.join(mdir, f)));
        }
      }
      version = `manifests-sha256:${hash.digest('hex').slice(0, 16)}`;
    }

    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'rule_library_version.txt'), `${version}\n`);

    // 2. 组合目录副本(workdir 为组合目录时)
    if (workdir && workdir !== '.') {
      const src = path.join(root, workdir);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(bundleDir, 'composed'), { recursive: true });
    }

    // 3. config 与样本表副本(样本表是复现的隐性依赖)
    for (const rel of ['config/config.yaml', 'config/samples.csv', 'config/units.tsv']) {
      const src = path.join(root, rel);
      if (fs.existsSync(src)) {
        const dest = path.join(bundleDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    // 4. bundle 清单
    fs.writeFileSync(
      path.join(bundleDir, 'bundle_manifest.json'),
      JSON.stringify(
        { task_id: taskId, workdir, rule_library: version, created: new Date().toISOString() },
        null,
        2,
      ) + '\n',
    );
    return path.relative(root, bundleDir);
  } catch {
    return null; // bundle 失败不阻塞提交(可复现性加固,非硬约束)
  }
}
