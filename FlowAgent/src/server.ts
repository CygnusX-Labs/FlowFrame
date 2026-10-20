import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { convertToModelMessages, type UIMessage } from 'ai';
import { loadConfig, type AgentMode, type FlowAgentConfig } from './config';
import { runFlowAgent } from './agent';
import { appendLedger, hasApproval, hasConfirmRecord, successfulDryRunDigests } from './ledger';
import { computeExecutionSpecDigestSync } from './spec-digest';

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
function setCors(req: http.IncomingMessage, res: http.ServerResponse, cfg: FlowAgentConfig): void {
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
function authorized(req: http.IncomingMessage, cfg: FlowAgentConfig): boolean {
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

const TASK_ID_RE = /^[\w一-鿿][\w一-鿿.-]*$/;

/**
 * 人工确认落账(历史消息回传路径,向后兼容):前端对 client-side 工具 confirm_submit 的应答
 * (output.approved === true)会随消息历史回传。服务端在此把它写成 human_decision 台账记录——
 * submit_cluster 的第二道闸只认台账,模型自己宣称的"用户已同意"不算数(规范 §4.6)。
 * 去重按 confirm_id(confirm_submit 工具调用的 toolCallId):同一确认事件只落一次账,
 * 但用户在新一轮 confirm_submit 上的新应答仍会落账(闸 2 是一次性消费,续跑需再确认)。
 * 注意:该记录的可信度等于前端实现的可信度;对不可信前端,应改用 POST /api/approve
 * 审批接口(服务端自算对象摘要,评审 §4.1),正式提交仍受 FLOWAGENT_ALLOW_SUBMIT 总开关约束。
 */
function recordApprovalsFromUiMessages(uiMessages: UIMessage[], mode: AgentMode, cfg: FlowAgentConfig): void {
  for (const msg of uiMessages) {
    for (const part of (msg.parts ?? []) as any[]) {
      // AI SDK v5 的 ToolUIPart 结果为 state='output-available'(旧版为 'output'),两种都认
      if (part?.type !== 'tool-confirm_submit' || (part.state !== 'output-available' && part.state !== 'output')) continue;
      const input = (part.input ?? {}) as { task_id?: string; targets?: string[]; workdir?: string };
      const output = part.output as { approved?: boolean } | undefined;
      const confirmId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      if (!input.task_id || !Array.isArray(input.targets) || input.targets.length === 0) continue;
      const workdir = input.workdir ?? '.';
      if (output?.approved !== true) continue;
      if (confirmId && hasConfirmRecord(cfg.workflowRoot, confirmId)) continue; // 同一确认事件去重
      if (!confirmId && hasApproval(cfg.workflowRoot, input.task_id, input.targets, workdir)) continue; // 无 id 时退回按任务去重
      // 确认即绑定当前执行对象摘要(架构评审 §4.2),与 CLI 路径一致:确认后改动内容,
      // 本次批准的 digest 不再匹配,submit 会要求重新确认。
      const specDigest = computeExecutionSpecDigestSync(cfg.workflowRoot, workdir, input.targets, input.task_id);
      appendLedger(cfg.workflowRoot, {
        ts: new Date().toISOString(),
        task_id: input.task_id,
        op: 'human_decision',
        target: input.targets.join(' '),
        object: workdir,
        result: 'approved',
        detail: 'HTTP 前端人工确认 by=ui-user',
        mode,
        spec_digest: specDigest,
        ...(confirmId ? { confirm_id: confirmId } : {}),
      });
    }
  }
}

/**
 * 构造 FlowAgent HTTP 服务(导出供自测做真实请求往返;直接运行本文件时才监听)。
 */
export function createFlowAgentServer(cfg: FlowAgentConfig): http.Server {
  return http.createServer(async (req, res) => {
    setCors(req, res, cfg);
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
        executor: cfg.executor,
        api_key_configured: Boolean(cfg.apiKey),
      });
      return;
    }

    /** 模式发现:前端切换按钮据此渲染;mode 本身由 /api/chat 请求逐条携带,服务端不存会话状态 */
    if (req.method === 'GET' && url.pathname === '/api/mode') {
      if (!authorized(req, cfg)) {
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

    /**
     * 审批接口(架构评审 §4.1 长期项的服务端实现):
     * 不信任客户端提交的历史消息,由调用方(前端确认按钮)在用户应答后显式调用本接口。
     * 服务端自行:① 校验 task_id/targets 形态;② 验证对象摘要——批准只能针对已 dry-run
     * 通过且内容未漂移的执行对象(摘要服务端自算,客户端传什么摘要都不算数);
     * ③ 一次性消费语义——同一 confirm_id 只落一次账,提交时由三道闸消费。
     * 身份即 Bearer 凭据持有方;平台化后可在此叠加用户身份与权限校验。
     */
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      if (!authorized(req, cfg)) {
        json(res, { ok: false, error: '未授权:需 Authorization: Bearer <FLOWAGENT_AUTH_TOKEN>' }, 401);
        return;
      }
      try {
        const body = JSON.parse(await readBody(req)) as {
          task_id?: string;
          targets?: string[];
          workdir?: string;
          confirm_id?: string;
          decision?: 'approved' | 'rejected';
        };
        const { task_id, targets, workdir, confirm_id, decision } = body;
        if (!task_id || !TASK_ID_RE.test(task_id)) {
          json(res, { ok: false, error: `task_id 非法: ${String(task_id)}` }, 400);
          return;
        }
        if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => typeof t !== 'string' || !t || /\s/.test(t) || t.startsWith('-'))) {
          json(res, { ok: false, error: 'targets 必须为非空字符串数组(不含空白、不得以 - 开头)' }, 400);
          return;
        }
        const wd = typeof workdir === 'string' && workdir ? workdir : '.';
        if (confirm_id && hasConfirmRecord(cfg.workflowRoot, confirm_id)) {
          json(res, { ok: false, error: `确认事件 ${confirm_id} 已落账(一次性消费,续跑请重新走 confirm_submit)` }, 409);
          return;
        }
        const approved = decision !== 'rejected';
        if (approved) {
          // 对象摘要验证:只批「已检查过且未漂移」的内容,不能批一个没 dry-run 过的对象
          const dryDigests = successfulDryRunDigests(cfg.workflowRoot, task_id, targets, wd);
          if (dryDigests.size === 0) {
            json(res, { ok: false, error: '无本任务(task_id+targets+workdir)的 dry_run 成功记录:不能批准未通过检查的内容' }, 400);
            return;
          }
          const digest = computeExecutionSpecDigestSync(cfg.workflowRoot, wd, targets, task_id);
          if (!dryDigests.has(digest)) {
            json(res, { ok: false, error: '当前内容与 dry_run 通过时的执行对象摘要不一致(组合/config/样本表/rule 库已变动),请重新 dry_run 后再批准' }, 409);
            return;
          }
        }
        const specDigest = computeExecutionSpecDigestSync(cfg.workflowRoot, wd, targets, task_id);
        appendLedger(cfg.workflowRoot, {
          ts: new Date().toISOString(),
          task_id,
          op: 'human_decision',
          target: targets.join(' '),
          object: wd,
          result: approved ? 'approved' : 'rejected',
          detail: 'HTTP 审批接口 by=api-user',
          spec_digest: specDigest,
          ...(confirm_id ? { confirm_id } : {}),
        });
        json(res, { ok: true, approved, task_id, spec_digest: specDigest });
      } catch (e) {
        json(res, { ok: false, error: String(e) }, 400);
      }
      return;
    }

    /**
     * 任务状态视图(架构评审 §4.5「无完整服务端任务恢复状态机」的最小闭环):
     * 从 runs/<task_id>/<run_id>/run_state.json 聚合服务端视角的任务状态,
     * 不依赖客户端传入历史;断线/重启后前端可据此恢复任务面板。
     */
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      if (!authorized(req, cfg)) {
        json(res, { ok: false, error: '未授权:需 Authorization: Bearer <FLOWAGENT_AUTH_TOKEN>' }, 401);
        return;
      }
      const runsRoot = path.join(cfg.workflowRoot, 'runs');
      const runs: { task_id: string; run_id: string; state: unknown }[] = [];
      if (fs.existsSync(runsRoot)) {
        for (const taskDir of fs.readdirSync(runsRoot)) {
          const abs = path.join(runsRoot, taskDir);
          if (!fs.statSync(abs).isDirectory()) continue;
          for (const runId of fs.readdirSync(abs)) {
            const stateFile = path.join(abs, runId, 'run_state.json');
            if (!fs.existsSync(stateFile)) continue;
            try {
              runs.push({ task_id: taskDir, run_id: runId, state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) });
            } catch {
              // 单个损坏的状态文件不拖垮整个视图
            }
          }
        }
      }
      runs.sort((a, b) => String((b.state as { started_at?: string })?.started_at ?? '').localeCompare(String((a.state as { started_at?: string })?.started_at ?? '')));
      json(res, { ok: true, runs });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (!authorized(req, cfg)) {
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
        recordApprovalsFromUiMessages(body.messages ?? [], mode, cfg);
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

    json(res, { ok: false, error: 'not found', routes: ['GET /api/health', 'GET /api/mode', 'GET /api/runs', 'POST /api/approve', 'POST /api/chat'] }, 404);
  });
}

// 直接运行(tsx src/server.ts)才监听;被 import(自测)时只导出工厂
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const cfg = loadConfig();
  const server = createFlowAgentServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`FlowAgent server  http://${cfg.host}:${cfg.port}`);
    console.log(`  POST /api/chat   Vercel AI SDK useChat 直接对接(UI message stream;body 可带 mode: standard|expert)`);
    console.log(`  POST /api/approve 人工审批接口(服务端自算对象摘要;批准须先 dry-run 通过)`);
    console.log(`  GET  /api/health 健康检查`);
    console.log(`  GET  /api/mode   模式发现(员工/专家模型与切换文案)`);
    console.log(`  GET  /api/runs   任务状态视图(聚合 runs/*/run_state.json)`);
    console.log(`  workflow root    ${cfg.workflowRoot}`);
    console.log(`  executor         ${cfg.executor}${cfg.executor === 'slurm' && cfg.slurmPartition ? ` (partition=${cfg.slurmPartition})` : ''}`);
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
}
