import http from 'node:http';
import { Readable } from 'node:stream';
import { convertToModelMessages, type UIMessage } from 'ai';
import { loadConfig, type AgentMode } from './config';
import { runFlowAgent } from './agent';
import { appendLedger, hasApproval, hasConfirmRecord } from './ledger';

const cfg = loadConfig();

const AGENT_MODES: AgentMode[] = ['standard', 'expert'];

/** 请求体上限(安全审查 M2:无上限时单个 POST 可打爆内存) */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function parseMode(raw: unknown): AgentMode | null {
  if (raw === undefined || raw === null) return 'standard';
  return AGENT_MODES.includes(raw as AgentMode) ? (raw as AgentMode) : null;
}

/** 缺省 CORS 允许来源:localhost / 127.0.0.1 任意端口(前后端本机分端口开发) */
const DEFAULT_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** CORS 收紧(安全审查 H3:原 Access-Control-Allow-Origin: * 允许任意网页 drive-by 调用并伪造人工确认) */
function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return; // 同源/curl:无需 CORS 头
  const allowed =
    cfg.allowedOrigins === '*'
      ? true
      : cfg.allowedOrigins.length > 0
        ? cfg.allowedOrigins.includes(origin)
        : DEFAULT_ORIGIN_RE.test(origin);
  if (!allowed) return; // 不回 CORS 头,浏览器会拦截跨域读取与预检后的实际请求
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Bearer 鉴权(安全审查 H3:未设 FLOWAGENT_AUTH_TOKEN 时不鉴权,暴露面由默认绑定 127.0.0.1 兜底) */
function authorized(req: http.IncomingMessage): boolean {
  if (!cfg.authToken) return true;
  return req.headers.authorization === `Bearer ${cfg.authToken}`;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 人工确认落账:前端对 client-side 工具 confirm_submit 的应答(output.approved === true)
 * 会随消息历史回传。服务端在此把它写成 human_decision 台账记录——submit_cluster 的
 * 第二道闸只认台账,模型自己宣称的"用户已同意"不算数(规范 §4.6)。
 * 去重按 confirm_id(confirm_submit 工具调用的 toolCallId):同一确认事件只落一次账,
 * 但用户在新一轮 confirm_submit 上的新应答仍会落账(闸 2 是一次性消费,续跑需再确认)。
 * 注意:该记录的可信度等于前端实现的可信度;对不可信前端,正式提交仍受
 * FLOWAGENT_ALLOW_SUBMIT 总开关与 FLOWAGENT_AUTH_TOKEN 鉴权约束。
 */
function recordApprovalsFromUiMessages(uiMessages: UIMessage[], mode: AgentMode): void {
  for (const msg of uiMessages) {
    for (const part of (msg.parts ?? []) as any[]) {
      if (part?.type !== 'tool-confirm_submit' || part.state !== 'output') continue;
      const input = (part.input ?? {}) as { task_id?: string; targets?: string[]; workdir?: string };
      const output = part.output as { approved?: boolean } | undefined;
      const confirmId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      if (!input.task_id || !Array.isArray(input.targets) || input.targets.length === 0) continue;
      const workdir = input.workdir ?? '.';
      if (output?.approved !== true) continue;
      if (confirmId && hasConfirmRecord(cfg.workflowRoot, confirmId)) continue; // 同一确认事件去重
      if (!confirmId && hasApproval(cfg.workflowRoot, input.task_id, input.targets, workdir)) continue; // 无 id 时退回按任务去重
      appendLedger(cfg.workflowRoot, {
        ts: new Date().toISOString(),
        task_id: input.task_id,
        op: 'human_decision',
        target: input.targets.join(' '),
        object: workdir,
        result: 'approved',
        detail: 'HTTP 前端人工确认 by=ui-user',
        mode,
        ...(confirmId ? { confirm_id: confirmId } : {}),
      });
    }
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://localhost:${cfg.port}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, {
      ok: true,
      model: cfg.model,
      expert_model: cfg.modelExpert || cfg.model,
      workflow_root: cfg.workflowRoot,
      submit_enabled: cfg.allowSubmit,
      api_key_configured: Boolean(cfg.apiKey),
    });
    return;
  }

  /** 模式发现:前端切换按钮据此渲染;mode 本身由 /api/chat 请求逐条携带,服务端不存会话状态 */
  if (req.method === 'GET' && url.pathname === '/api/mode') {
    if (!authorized(req)) {
      json(res, { ok: false, error: '未授权:需 Authorization: Bearer <FLOWAGENT_AUTH_TOKEN>' }, 401);
      return;
    }
    json(res, {
      ok: true,
      modes: AGENT_MODES,
      models: { standard: cfg.model, expert: cfg.modelExpert || cfg.model },
      expert_configured: Boolean(cfg.modelExpert),
      confirm_copy: {
        'standard->expert':
          '开启专家模式:切换到更强模型,Agent 获得主动体检、rule 提案起草、扩展修复策略等授权;所有主动动作仍记录台账,提交仍需您确认。',
        'expert->standard': '已回到员工模式:Agent 恢复按需执行,不再主动建议。',
      },
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!authorized(req)) {
      json(res, { ok: false, error: '未授权:需 Authorization: Bearer <FLOWAGENT_AUTH_TOKEN>' }, 401);
      return;
    }
    if (!cfg.apiKey) {
      json(res, { ok: false, error: 'FLOWAGENT_API_KEY 未配置' }, 500);
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { messages: UIMessage[]; mode?: string };
      const mode = parseMode(body.mode);
      if (!mode) {
        json(res, { ok: false, error: `非法 mode: ${String(body.mode)}(可选 ${AGENT_MODES.join(' / ')})` }, 400);
        return;
      }
      recordApprovalsFromUiMessages(body.messages ?? [], mode);
      const modelMessages = await convertToModelMessages(body.messages ?? []);
      const result = runFlowAgent(cfg, modelMessages, mode);
      const response = result.toUIMessageStreamResponse({
        onError: (e) => (e instanceof Error ? e.message : String(e)),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      } else {
        res.end();
      }
    } catch (e) {
      json(res, { ok: false, error: String(e) }, 500);
    }
    return;
  }

  json(res, { ok: false, error: 'not found', routes: ['GET /api/health', 'GET /api/mode', 'POST /api/chat'] }, 404);
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`FlowAgent server  http://${cfg.host}:${cfg.port}`);
  console.log(`  POST /api/chat   Vercel AI SDK useChat 直接对接(UI message stream;body 可带 mode: standard|expert)`);
  console.log(`  GET  /api/health 健康检查`);
  console.log(`  GET  /api/mode   模式发现(员工/专家模型与切换文案)`);
  console.log(`  workflow root    ${cfg.workflowRoot}`);
  console.log(
    `  鉴权             ${cfg.authToken ? '已开启(FLOWAGENT_AUTH_TOKEN,Bearer)' : '未开启(建议设置 FLOWAGENT_AUTH_TOKEN)'}`,
  );
  console.log(
    `  CORS             ${cfg.allowedOrigins === '*' ? '全开(*)' : cfg.allowedOrigins.length ? cfg.allowedOrigins.join(', ') : 'localhost/127.0.0.1 任意端口'}`,
  );
  if (cfg.host !== '127.0.0.1' && !cfg.authToken) {
    console.warn('  [警告] 绑定非回环地址且未设 FLOWAGENT_AUTH_TOKEN:局域网内任意客户端可调用本服务并伪造人工确认记录。');
  }
  if (!cfg.apiKey) console.warn('  [警告] FLOWAGENT_API_KEY 未配置,/api/chat 将返回 500');
});
