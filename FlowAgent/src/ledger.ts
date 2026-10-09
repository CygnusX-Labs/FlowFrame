import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMode } from './config';

export type LedgerOp = 'dry_run' | 'summary' | 'validate' | 'submit' | 'error' | 'fix' | 'human_decision';

export interface LedgerEntry {
  /** 事件唯一 ID(规范 §4.6:事件需可标识、可关联) */
  id: string;
  ts: string;
  task_id: string;
  op: LedgerOp;
  target?: string;
  object?: string;
  result?: string;
  detail?: string;
  confirmed?: boolean;
  /** 会话模式(员工/专家),事后区分「员工干的还是专家干的」;缺省视为 standard */
  mode?: AgentMode;
  /** 归一化报错签名(异常类型|rule|消息骨架),熔断计数依据(审核手册问题 4) */
  signature?: string;
  /** 报错分桶:retryable / sample_table / transient / unknown */
  bucket?: string;
  /** LLM 决策理由(审核手册问题 6:操作审计 ≠ 决策理由),write_composed/submit_cluster/write_gap_log 必填 */
  reason?: string;
  /** run bundle 相对路径(submit 时固化) */
  bundle?: string;
  /** 确认事件标识(confirm_submit 工具调用的 toolCallId),HTTP 前端应答去重用 */
  confirm_id?: string;
}

export function ledgerPath(root: string): string {
  return path.join(root, 'agent', 'run_ledger.jsonl');
}

export function appendLedger(root: string, entry: Omit<LedgerEntry, 'id'>): void {
  const p = ledgerPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ id: randomUUID(), ...entry }) + '\n');
}

export function readLedger(root: string): LedgerEntry[] {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LedgerEntry => e !== null);
}

function normTargets(targets: string[]): string {
  return [...targets].sort().join(' ');
}

function targetsOf(e: LedgerEntry): string[] | null {
  return typeof e.target === 'string' ? e.target.split(' ') : null;
}

/** 台账条目是否属于本任务(task_id + targets + workdir 三者完全一致) */
function taskMatches(e: LedgerEntry, taskId: string, targets: string[], workdir: string): boolean {
  return (
    e.task_id === taskId &&
    (e.object ?? '.') === workdir &&
    targetsOf(e) !== null &&
    normTargets(targetsOf(e)!) === normTargets(targets)
  );
}

/** 硬约束依据:台账中是否存在本任务(task_id + targets + workdir 三者完全一致)的 dry_run 成功记录 */
export function hasSuccessfulDryRun(
  root: string,
  taskId: string,
  targets: string[],
  workdir = '.',
): boolean {
  return readLedger(root).some(
    (e) => e.op === 'dry_run' && e.result === 'success' && taskMatches(e, taskId, targets, workdir),
  );
}

/** 硬约束依据:台账中是否存在用户人工确认记录(由 CLI/server 应答 confirm_submit 时写入,模型无权写) */
export function hasApproval(root: string, taskId: string, targets: string[], workdir = '.'): boolean {
  return readLedger(root).some(
    (e) => e.op === 'human_decision' && e.result === 'approved' && taskMatches(e, taskId, targets, workdir),
  );
}

/**
 * 闸 2 消费语义:人工确认是否仍有剩余(确认次数 > 已启动的提交次数)。
 * 每次正式提交消耗一次确认——一次 y/N 只放行一次 submit,续跑/重试须再次 confirm_submit,
 * 防止「批准一次后模型可无限次提交」。
 */
export function hasUnconsumedApproval(
  root: string,
  taskId: string,
  targets: string[],
  workdir = '.',
): boolean {
  const ledger = readLedger(root);
  const approvals = ledger.filter(
    (e) => e.op === 'human_decision' && e.result === 'approved' && taskMatches(e, taskId, targets, workdir),
  ).length;
  const submits = ledger.filter(
    (e) => e.op === 'submit' && e.result === 'started' && taskMatches(e, taskId, targets, workdir),
  ).length;
  return approvals > submits;
}

/** HTTP 前端确认去重:同一 confirm_submit 工具调用(toolCallId)是否已落过账 */
export function hasConfirmRecord(root: string, confirmId: string): boolean {
  return readLedger(root).some((e) => e.confirm_id === confirmId);
}

/**
 * 熔断计数:本任务同一归一化签名此前的 dry_run 失败次数。
 * 签名由 classifyError 归一化(异常类型 + rule 名 + 去路径/数字/引号的消息骨架),
 * 保证"路径不同的同类 MissingInput"计入同一签名(审核手册问题 4)。
 */
export function countSignatureFailures(root: string, taskId: string, signature: string): number {
  return readLedger(root).filter(
    (e) => e.op === 'dry_run' && e.task_id === taskId && e.result === 'failed' && e.signature === signature,
  ).length;
}
