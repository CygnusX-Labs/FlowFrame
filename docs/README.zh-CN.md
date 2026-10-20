<p align="center">
  <img src="蓝色基因数据分析图标.png" alt="Flow Framework 图标" width="160">
  <img src="../FlowAgent/docs/flowagent_logo_1.png" alt="FlowAgent Logo" width="160">
</p>

# FlowFrame

[English](../README.md) | 中文

FlowFrame 将多组学分析流程的开发规范与 AI 编排能力放在一起：**Flow Framework 负责让流程结构统一、依赖明确；FlowAgent 负责理解需求、复用已有 rule、生成候选方案并辅助验证与运行。** 计算任务由 Snakemake 执行，科学方案与正式运行由专家和授权策略把关。

本仓库包含框架规范、开发指引、模板资源和 Agent 后端。具体组学流程在各自的 `<X>Flow` 仓库中开发和维护。

## 项目组成

| 组件 | 职责 | 入口 |
|---|---|---|
| Flow Framework | 定义目录、配置、rule、数据门控、资源管理、交付与报告规范，帮助开发和接入 Flow 家族流程 | [框架指南](../flow-framework/README.md) · [完整规范](../flow-framework/references/flow_framework_spec.md) |
| FlowAgent | 将自然语言需求映射到已有分析能力，提供方案留存、组合编译、校验、人工确认、执行与审计工具 | [Agent 使用文档](../FlowAgent/README.md) |
| 总体规划与入库手册 | 定义 rule/pipeline 治理、验证与版本目标，以及流程接入步骤 | [总体规划](planning/Flow-AI_Rule_Orchestration.md) · [入库手册](planning/Flow-Workflow-Onboarding-Guide.md) |

## 已开发的流程

以下流程基于 Flow Framework 开发，分别在各自的仓库中维护：

| 流程 | 仓库 |
|---|---|
| RNAFlow | [xsx123123/RNAFlow](https://github.com/xsx123123/RNAFlow) |
| AnnoFlow | [xsx123123/kegg_annotation](https://github.com/xsx123123/kegg_annotation) |
| ATACFlow | [xsx123123/ATACFlow](https://github.com/xsx123123/ATACFlow) |
| WGSFlow | [xsx123123/WGSFlow](https://github.com/xsx123123/WGSFlow) |
| TREEFlow | [xsx123123/TREEFlow](https://github.com/xsx123123/TREEFlow) |

## 如何协作

```text
流程开发者 → Flow Framework 规范与模板 → <X>Flow 流程仓库
                                           ↓ 入库校验与专家审核
科研需求 → FlowAgent → 检索能力 → 分析方案与流程计划
                                           ↓ 校验与人工确认
                                     Snakemake 执行
                                           ↓
                                    分析产物、日志与运行记录
```

Flow Framework 统一入口初始化、配置覆盖、模块依赖和目标生成，要求原始数据经过标准化与 MD5 门控，再进入组学分析和交付环节。

FlowAgent 通过 catalog、ports 和 manifests 理解流程能力。LLM 负责选择与解释，工具层负责约束校验、提交门禁和台账；新增或修改 rule 通过候选提案和人工审核进入能力库。

## 开始使用

**开发或改造流程**：从 [Flow Framework 指南](../flow-framework/README.md) 开始，按 [完整规范](../flow-framework/references/flow_framework_spec.md) 建立流程。供 AI 编程助手使用的开发指引见 [SKILL.md](../flow-framework/SKILL.md)。

**将流程接入 Agent**：按 [流程入库手册](planning/Flow-Workflow-Onboarding-Guide.md) 准备 manifests、端口与交付物目录，完成校验和真实小样验收，再设置 `FLOW_WORKFLOW_ROOT` 指向流程仓库。

**体验 Agent 后端**：

```bash
cd FlowAgent
npm install
cp .env.example .env
# 编辑 .env，配置模型接口、API Key 和模型 ID
npm run cli
```

未设置 `FLOW_WORKFLOW_ROOT` 时使用内置 demo。HTTP 服务、人工确认、模型配置与执行器的使用说明见 [FlowAgent README](../FlowAgent/README.md)。

## 当前进展

当前 Agent 已提供 CLI/HTTP 接口、标准与专家模式、能力检索、最小科学方案、结构化组合编译、配置与子图检查、dry-run、人工确认、运行快照及状态查询，并包含 local/Slurm 执行器接口。

整体仍处于受控试点阶段。完整的不可变 rule/pipeline 发布、依赖与参考锁、独立科学审核和结果质量验证仍需完善；demo 与工具测试不能替代真实流程的端到端验收。当前实现与目标的具体差距见 [规划对照审查](info/FlowAgent_Planning_Alignment_2026-10-16.md)。

## 仓库导航

```text
FlowFrame/
├── flow-framework/       # 流程开发指引、完整规范和模板
├── FlowAgent/            # AI 编排后端、demo 与评测脚本
├── docs/
│   ├── planning/         # 总体规划与流程入库手册
│   └── info/             # 架构评审与实现对照
└── LICENSE               # MIT License
```

## 许可证

本项目采用 [MIT License](../LICENSE)。引用的第三方工具与依赖遵循各自的许可证。
