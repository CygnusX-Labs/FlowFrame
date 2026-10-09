import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runShell(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 后台启动长时间任务(正式运行),输出重定向到日志文件,立即返回 pid */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; logFile: string },
): number {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const out = fs.openSync(opts.logFile, 'a');
  const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out); // 子进程已继承 fd,父进程及时关闭,防每次 submit 泄漏一个 fd
  return child.pid ?? -1;
}

export function tail(text: string, lines: number): string {
  const arr = text.trim().split('\n');
  return arr.slice(-lines).join('\n');
}
