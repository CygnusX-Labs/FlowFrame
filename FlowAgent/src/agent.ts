import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AgentMode, FlowAgentConfig } from './config';
import { buildSystemPrompt } from './system-prompt';
import { createTools } from './tools';

/**
 * 一次 agent 会话:CLI 与 HTTP server 共用。
 * 循环底座用 Vercel AI SDK streamText(不手写 tool-calling 循环),
 * SOP 在 system prompt,工具层在 createTools。
 * mode 决定三件事:模型(专家可换更强模型)、prompt 变体(专家授权段)、工具门控(专家专属工具)。
 */
export function runFlowAgent(cfg: FlowAgentConfig, messages: ModelMessage[], mode: AgentMode = 'standard') {
  const provider = createOpenAICompatible({
    name: 'flowagent',
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
  });
  const model = mode === 'expert' ? cfg.modelExpert || cfg.model : cfg.model;
  return streamText({
    model: provider.chatModel(model),
    system: buildSystemPrompt(cfg, mode),
    messages,
    tools: createTools(cfg, mode),
    stopWhen: stepCountIs(30),
  });
}
