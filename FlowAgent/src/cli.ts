import readline from 'node:readline/promises';
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';
import { loadConfig, type AgentMode } from './config';
import { runFlowAgent } from './agent';
import { appendLedger } from './ledger';

function preview(value: unknown, max = 600): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + ' …(截断)' : s;
}

interface ConfirmInput {
  task_id: string;
  targets: string[];
  workdir?: string;
  summary: string;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.error('缺少 API Key:复制 .env.example 为 .env 并填入 FLOWAGENT_API_KEY(或设置环境变量 ARK_API_KEY)。');
    process.exit(1);
  }

  // 会话模式:员工(默认)/专家;斜杠命令或 --expert 切换,下一条消息生效
  let mode: AgentMode = 'standard';
  const expertModel = () => cfg.modelExpert || cfg.model;
  const activeModel = () => (mode === 'expert' ? expertModel() : cfg.model);

  const argv = process.argv.slice(2);
  if (argv[0] === '--expert') {
    mode = 'expert';
    argv.shift();
  }

  console.log(`FlowAgent CLI  mode=${mode}  model=${activeModel()}`);
  console.log(`workflow root  ${cfg.workflowRoot}`);
  console.log(`submit 开关    ${cfg.allowSubmit ? 'ON' : 'OFF(仅 dry-run 可达,submit 一律拒绝)'}\n`);

  const messages: ModelMessage[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 行缓冲:rl.question 只消化「question 挂起期间」到达的行,管道输入会把后续行冲进 'line' 事件丢掉;
  // 统一走 nextLine(先写提示符再从队列取),交互与管道行为一致。EOF 视为 exit。
  const lineQueue: string[] = [];
  const lineWaiters: ((line: string) => void)[] = [];
  rl.on('line', (l) => {
    const w = lineWaiters.shift();
    if (w) w(l); else lineQueue.push(l);
  });
  rl.on('close', () => {
    const w = lineWaiters.shift();
    if (w) w('exit'); else lineQueue.push('exit');
  });
  function nextLine(promptText: string): Promise<string> {
    process.stdout.write(promptText);
    if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
    return new Promise((res) => lineWaiters.push(res));
  }

  /** 人工确认:在终端把规模交给用户本人,应答写入台账(模型无权代填,规范 §4.6) */
  async function humanConfirm(call: ToolCallPart): Promise<boolean> {
    const input = call.input as ConfirmInput;
    console.log(`\n\x1b[33m[人工确认]\x1b[0m 模型请求正式提交,请核对计算规模:`);
    console.log(`  task_id:  ${input.task_id}`);
    console.log(`  targets:  ${(input.targets ?? []).join(' ')}`);
    if (input.workdir) console.log(`  workdir:  ${input.workdir}`);
    if (input.summary) console.log(`  规模摘要: ${input.summary}`);
    const ans = (await nextLine('\x1b[33m确认提交? [y/N]\x1b[0m ')).trim().toLowerCase();
    const approved = ans === 'y' || ans === 'yes';
    appendLedger(cfg.workflowRoot, {
      ts: new Date().toISOString(),
      task_id: input.task_id,
      op: 'human_decision',
      target: (input.targets ?? []).join(' '),
      object: input.workdir ?? '.',
      result: approved ? 'approved' : 'rejected',
      detail: `CLI 终端人工确认 by=cli-user`,
      mode,
    });
    return approved;
  }

  async function ask(input: string): Promise<void> {
    messages.push({ role: 'user', content: input });
    // 外层循环:confirm_submit 是 client-side 工具(无 execute),流会在等待人工答复处结束;
    // 应答以 tool-result 追加后重新进入循环,模型据此继续(或放弃)submit_cluster。
    for (;;) {
      const result = runFlowAgent(cfg, messages, mode);
      const pendingConfirms: ToolCallPart[] = [];
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            process.stdout.write(part.text);
            break;
          case 'tool-call':
            if (part.toolName === 'confirm_submit') pendingConfirms.push(part as ToolCallPart);
            console.log(`\n\x1b[36m[调用工具]\x1b[0m ${part.toolName} ${preview(part.input, 200)}`);
            break;
          case 'tool-result':
            console.log(`\x1b[90m[工具返回]\x1b[0m ${part.toolName}: ${preview(part.output)}`);
            break;
          case 'error':
            console.error('\n[错误]', part.error);
            break;
        }
      }
      messages.push(...(await result.response).messages);
      if (pendingConfirms.length === 0) break;
      // 逐个应答未确认的 confirm_submit(同一步多次调用也全部补上 tool-result,否则协议不完整)
      const contents: ToolResultPart[] = [];
      for (const call of pendingConfirms) {
        const approved = await humanConfirm(call);
        console.log(approved ? '\x1b[32m[已确认]\x1b[0m 用户批准提交' : '\x1b[31m[已拒绝]\x1b[0m 用户否决提交');
        contents.push({
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: 'text', value: JSON.stringify({ approved, by: 'cli-user' }) },
        });
      }
      messages.push({ role: 'tool', content: contents });
    }
    process.stdout.write('\n');
  }

  const oneShot = argv.join(' ').trim();
  if (oneShot) {
    await ask(oneShot);
    rl.close();
    return;
  }

  console.log('进入交互模式,输入需求后回车;/expert /standard 切换模式,/mode 查看当前模式,exit 退出。\n');
  for (;;) {
    const line = (await nextLine(`\x1b[32m需求[${mode}]>\x1b[0m `)).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit' || line === '/exit') break;
    if (line === '/expert' || line === '/standard') {
      const next: AgentMode = line === '/expert' ? 'expert' : 'standard';
      if (next !== mode) {
        mode = next;
        console.log(
          mode === 'expert'
            ? '\x1b[35m开启专家模式:切换到更强模型,Agent 获得主动体检、rule 提案起草、扩展修复策略等授权;所有主动动作仍记录台账,提交仍需您确认。\x1b[0m'
            : '\x1b[35m已回到员工模式:Agent 恢复按需执行,不再主动建议。\x1b[0m',
        );
      } else {
        console.log(`已是${mode === 'expert' ? '专家' : '员工'}模式。`);
      }
      continue;
    }
    if (line === '/mode') {
      console.log(`当前模式: ${mode}  model=${activeModel()}(专家模型 ${cfg.modelExpert ? expertModel() : '未配置,回退员工模型'})`);
      continue;
    }
    try {
      await ask(line);
    } catch (e) {
      console.error('[会话错误]', e);
    }
    console.log();
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
