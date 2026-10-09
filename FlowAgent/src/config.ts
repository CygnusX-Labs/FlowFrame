import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 极简 .env 加载(不引入 dotenv 依赖;已存在的环境变量优先)
function loadDotEnv(): void {
  const envPath = path.join(PACKAGE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

export interface FlowAgentConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 专家模式模型 ID(mode 由请求携带,不进 env;缺省回退 model) */
  modelExpert: string;
  /** Flow 流程仓库根目录(rules/ agent/ config/ 所在) */
  workflowRoot: string;
  /** server 绑定地址:默认 127.0.0.1(仅本机),对局域网开放时显式设 0.0.0.0 */
  host: string;
  port: number;
  /**
   * Bearer 鉴权 token:设置后 /api/chat 与 /api/mode 要求 Authorization: Bearer <token>。
   * 不设置时不鉴权(仅靠默认绑定 127.0.0.1 限制暴露面)。
   */
  authToken: string;
  /**
   * CORS 允许来源:'*' 恢复全开;显式列表精确匹配;缺省为 localhost/127.0.0.1 任意端口。
   * 上一版本为 Access-Control-Allow-Origin: *(任意网页可 drive-by 调用本服务并伪造人工确认)。
   */
  allowedOrigins: string[] | '*';
  /** 即使为 true,submit_cluster 仍受 dry-run 台账硬约束限制 */
  allowSubmit: boolean;
  cores: number;
  /** dry_run/submit 是否带 --use-conda(rule 的 conda: envs/xxx.yaml 由 snakemake 自动建环境) */
  useConda: boolean;
  condaFrontend: string;
  /** submit 追加参数,如 "--logger rich-loguru"(真实 Flow 仓库的强制 logger 插件) */
  extraArgs: string[];
}

/** 会话模式:standard=员工(按需执行);expert=专家(主动体检/提案起草/扩展修复策略) */
export type AgentMode = 'standard' | 'expert';

export function loadConfig(): FlowAgentConfig {
  return {
    baseURL: process.env.FLOWAGENT_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: process.env.FLOWAGENT_API_KEY ?? process.env.ARK_API_KEY ?? '',
    model: process.env.FLOWAGENT_MODEL ?? 'doubao-seed-1-6-250615',
    modelExpert: process.env.FLOWAGENT_MODEL_EXPERT ?? '',
    workflowRoot: path.resolve(process.env.FLOW_WORKFLOW_ROOT ?? path.join(PACKAGE_ROOT, 'demo')),
    host: process.env.FLOWAGENT_HOST ?? '127.0.0.1',
    port: Number(process.env.FLOWAGENT_PORT ?? 3090),
    authToken: process.env.FLOWAGENT_AUTH_TOKEN ?? '',
    allowedOrigins:
      process.env.FLOWAGENT_ALLOWED_ORIGINS === '*'
        ? '*'
        : (process.env.FLOWAGENT_ALLOWED_ORIGINS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    allowSubmit: process.env.FLOWAGENT_ALLOW_SUBMIT === 'true',
    cores: Number(process.env.FLOWAGENT_CORES ?? 8),
    useConda: process.env.FLOWAGENT_USE_CONDA !== 'false',
    condaFrontend: process.env.FLOWAGENT_CONDA_FRONTEND ?? 'conda',
    extraArgs: (process.env.FLOWAGENT_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
  };
}

/** 将相对路径解析到仓库根内,拒绝逃逸(工具层只读/受限写的第一道闸) */
export function safeJoin(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界: ${rel} 解析到仓库根之外,已拒绝`);
  }
  return resolved;
}
