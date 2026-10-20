import { spawnSync } from 'node:child_process';
import type { FlowAgentConfig } from './config';
import { spawnDetached } from './shell';

export interface SubmitRequest {
  cwd: string;
  logFile: string;
  /** bash 脚本:snakemake 命令 + 结束后把退出码追加进日志(check_run 依赖) */
  script: string;
  cores: number;
  taskId: string;
}

/**
 * 执行器接口(架构评审 §7.6「executor 接口;先实现 local,再适配 Slurm 等」)。
 * submit_cluster 只面向本接口;local 与 slurm 的区别收敛在 spawn 一处,
 * 台账/run_state/检查逻辑(check_run 解析同一 logFile 的退出码行)不变。
 */
export interface FlowExecutor {
  readonly kind: 'local' | 'slurm';
  /** 后台提交,立即返回本地进程 pid(sbatch 时为 sbatch 自身 pid,作业 ID 从日志解析) */
  spawn(req: SubmitRequest): number;
}

class LocalExecutor implements FlowExecutor {
  readonly kind = 'local' as const;
  spawn(req: SubmitRequest): number {
    return spawnDetached('bash', ['-c', req.script], { cwd: req.cwd, logFile: req.logFile });
  }
}

class SlurmExecutor implements FlowExecutor {
  readonly kind = 'slurm' as const;
  constructor(private partition: string) {
    // 集群适配器在提交前自检:sbatch 不在 PATH 说明当前环境不是登录节点,明确报错而非静默退回 local
    const probe = spawnSync('sbatch', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      throw new Error('FLOWAGENT_EXECUTOR=slurm 但 sbatch 不可用(PATH 中找不到)——请在 Slurm 登录节点部署,或改回 local');
    }
  }
  spawn(req: SubmitRequest): number {
    const args = [
      '--parsable', // 只输出作业 ID(写入 logFile,check_run 据此 squeue 探活)
      `--job-name=flowagent-${req.taskId.replace(/[^\w-]/g, '_')}`,
      `--cpus-per-task=${req.cores}`,
      `--output=${req.logFile}`,
      `--error=${req.logFile}`,
      ...(this.partition ? [`--partition=${this.partition}`] : []),
      `--wrap=${req.script}`,
    ];
    return spawnDetached('sbatch', args, { cwd: req.cwd, logFile: req.logFile });
  }
}

/** 按配置构造执行器;slurm 环境自检失败时抛错(submit_cluster 捕获后拒绝提交) */
export function createExecutor(cfg: FlowAgentConfig): FlowExecutor {
  return cfg.executor === 'slurm' ? new SlurmExecutor(cfg.slurmPartition) : new LocalExecutor();
}

/** 作业是否仍在队列/运行(squeue 不可用时返回 null,表示无法判断) */
export function slurmJobAlive(jobId: string): boolean | null {
  const r = spawnSync('squeue', ['-j', jobId, '-h'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout).trim().length > 0;
}
