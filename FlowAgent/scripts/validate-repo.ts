/** 临时校验脚本：直接调用 FlowAgent 的 validate_manifests 工具校验指定仓库 */
import { createValidateTool } from '../src/tools/validate.ts';
import type { FlowAgentConfig } from '../src/config.ts';

const root = process.argv[2];
const lint = process.argv.includes('--lint');
if (!root) {
  console.error('usage: tsx run-validate.ts <workflow_root> [--lint]');
  process.exit(2);
}

const cfg = {
  baseURL: '', apiKey: '', model: '', modelExpert: '',
  workflowRoot: root, host: '127.0.0.1', port: 0, authToken: '',
  allowedOrigins: [], allowSubmit: false, cores: 1, useConda: false,
  condaFrontend: 'mamba', extraArgs: [],
} satisfies FlowAgentConfig;

const { validate_manifests } = createValidateTool(cfg, 'expert');
const result = await validate_manifests.execute!(
  { task_id: `onboard-validate-${Date.now()}`, lint },
  { toolCallId: 'manual', messages: [], abortSignal: undefined as never },
);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
