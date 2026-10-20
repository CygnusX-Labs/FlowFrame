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
  /**
   * 执行器(架构评审 §7.6 executor 接口):local=本地后台 Snakemake(默认);
   * slurm=sbatch 提交到集群(需 sbatch 在 PATH,日志/退出码行仍写同一 logFile,check_run 可查)。
   */
  executor: 'local' | 'slurm';
  /** Slurm 分区名(executor=slurm 时可选,空则走集群默认分区) */
  slurmPartition: string;
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
    executor: process.env.FLOWAGENT_EXECUTOR === 'slurm' ? 'slurm' : 'local',
    slurmPartition: process.env.FLOWAGENT_SLURM_PARTITION ?? '',
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

/**
 * safeJoin + realpath 二次校验:已存在路径按真实文件身份再判一次,防 symlink 逃逸
 * (safeJoin 只是词法判断,logs/ 下的软链可以指向仓库外)。不存在的路径(如 staged
 * 组合目录)退回 safeJoin 的词法结果,与 composed-guard 的 staged 处理保持一致。
 */
export function safeJoinResolved(root: string, rel: string): string {
  const abs = safeJoin(root, rel);
  if (!fs.existsSync(abs)) return abs;
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(abs);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`路径越界(符号链接): ${rel} 真实位置在仓库根之外,已拒绝`);
  }
  return abs;
}
