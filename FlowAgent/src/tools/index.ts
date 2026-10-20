import type { AgentMode, FlowAgentConfig } from '../config';
import { createRegistryTools } from './registry';
import { createValidateTool } from './validate';
import { createSnakemakeTools } from './snakemake';
import { createWriteTools } from './writes';
import { createPlanTools } from './plans';
import { createCompilerTools } from './compiler';
import { createExpertTools } from './expert';

/**
 * 工具集(规范 §8.2 / §8.3 / §8.4):
 * query_catalog / query_ports / query_rules / get_rule / validate_manifests
 * dry_run / detailed_summary / read_log / check_run / submit_cluster(硬约束)
 * write_gap_log / write_composed / compile_pipeline / write_analysis_plan
 * 全部只读仓库;写操作仅限 composed/、proposals/(专家提案)、agent/gap_log.yaml、
 * agent/plans/(科学方案)、agent/run_ledger.jsonl、runs/<task_id>/<run_id>/。
 *
 * 模式门控:analyze_history / write_rule_proposal 仅 expert 模式注册;
 * standard 模式工具集与 prompt 保持原样,零行为变化。
 */
export function createTools(cfg: FlowAgentConfig, mode: AgentMode = 'standard') {
  return {
    ...createRegistryTools(cfg),
    ...createValidateTool(cfg, mode),
    ...createSnakemakeTools(cfg, mode),
    ...createWriteTools(cfg, mode),
    ...createPlanTools(cfg, mode),
    ...createCompilerTools(cfg, mode),
    ...(mode === 'expert' ? createExpertTools(cfg) : {}),
  };
}
