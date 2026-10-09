import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, type AgentMode, type FlowAgentConfig } from './config';

const PROMPTS_DIR = path.join(PACKAGE_ROOT, 'prompts');

function loadPrompt(file: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').trim();
}

/**
 * SOP 蒸馏 system prompt(规范 §8.3/§8.6 + 审核手册阶段 0/1 修订)。
 * 正文维护在 prompts/system-base.md 与 prompts/system-expert.md,
 * 此处仅做装配与 {{workflowRoot}} / {{cores}} 变量插值。
 */
export function buildSystemPrompt(cfg: FlowAgentConfig, mode: AgentMode = 'standard'): string {
  const base = loadPrompt('system-base.md')
    .replaceAll('{{workflowRoot}}', cfg.workflowRoot)
    .replaceAll('{{cores}}', String(cfg.cores));
  if (mode !== 'expert') return base;
  return `${base}\n\n${loadPrompt('system-expert.md')}`;
}
