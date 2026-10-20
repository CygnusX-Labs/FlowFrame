<p align="center">
  <img src="../docs/蓝色基因数据分析图标.png" alt="Flow Framework 图标" width="200">
</p>

# Flow Framework

Flow 家族的多组学通用流程架构规范与开发指引，用于创建新的 `<X>Flow` 流程，或将已有分析脚本和工作流接入统一的 Snakemake 架构。

完整规范统一维护在 [flow_framework_spec.md](references/flow_framework_spec.md)。原仓库根 README 中的详细架构条款由该文件承载；根 [README](../README.md) 介绍 FlowFrame 与 FlowAgent 的整体关系。

## 核心约定

- 共享流程骨架：通用初始化、FASTQ 标准化、MD5 校验、质控、交付与报告。
- 配置驱动：默认四件套、项目级 `analysisyaml` 与命令行覆盖。
- 数据门控：全部样本校验通过后才启动下游分析。
- 模块化分析：组学专用 rule 独立组织，通过依赖开关和纯函数目标生成连接。
- 统一运行：资源 profile、Conda 环境、日志与监控接口保持一致。

## 文档与资源

| 资源 | 用途 |
|---|---|
| [完整架构规范](references/flow_framework_spec.md) | 目录命名、入口八步初始化、配置、门控、目标生成、环境、监控及开发验收 |
| [开发指引](SKILL.md) | 面向 AI 编程助手的工作流程与快速检查 |
| [模板说明](assets/templates/README.md) | 模板与脚手架资源的使用方法 |
| [FlowAgent 入库手册](../docs/planning/Flow-Workflow-Onboarding-Guide.md) | 为已有流程补齐 Agent 可检索与校验的资产 |
| [编排与治理规划](../docs/planning/Flow-AI_Rule_Orchestration.md) | rule/pipeline 发布、版本锁、审批和结果验证的目标契约 |

## 开发步骤

1. 按完整规范 §1–§3 建立目录、入口与配置。
2. 接入通用层和数据门控，编写组学专用 rule。
3. 接线模块依赖、分析目标、交付与报告。
4. 按 §12.3 检查清单和 §16 接入指南执行 dry-run、门控验证及真实小样测试。
5. 需要由 FlowAgent 调用时，继续完成流程入库与专家审核。

本目录的规范定义“流程如何开发”；Agent 元数据、发布和运行授权另见入库手册与总体规划。

采用仓库根目录的 [MIT License](../LICENSE)。
