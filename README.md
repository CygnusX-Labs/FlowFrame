<p align="center">
  <img src="docs/蓝色基因数据分析图标.png" alt="Flow Framework icon" width="160">
  <img src="FlowAgent/docs/flowagent_logo_1.png" alt="FlowAgent logo" width="160">
</p>

# FlowFrame

English | [中文](docs/README.zh-CN.md)

FlowFrame brings together development standards for multi-omics analysis workflows and AI orchestration: **Flow Framework keeps workflow structure consistent and dependencies explicit, while FlowAgent understands requirements, reuses existing rules, generates candidate plans, and assists with validation and execution.** Computational tasks run on Snakemake, and scientific decisions and formal runs are gated by domain experts and authorization policies.

This repository contains the framework specification, development guides, template resources, and the Agent backend. Individual omics workflows are developed and maintained in their own `<X>Flow` repositories.

## Components

| Component | Responsibility | Entry points |
|---|---|---|
| Flow Framework | Defines standards for directory layout, configuration, rules, data gating, resource management, delivery, and reporting to help develop and onboard Flow-family workflows | [Framework guide](flow-framework/README.md) · [Full specification](flow-framework/references/flow_framework_spec.md) |
| FlowAgent | Maps natural-language requirements to existing analysis capabilities, with tooling for plan retention, composition compilation, validation, human confirmation, execution, and audit | [Agent documentation](FlowAgent/README.md) |
| Planning and onboarding | Defines rule/pipeline governance, validation, and version goals, plus the steps for onboarding a workflow | [Master plan](docs/planning/Flow-AI_Rule_Orchestration.md) · [Onboarding guide](docs/planning/Flow-Workflow-Onboarding-Guide.md) |

## How it works

```text
Workflow developers → Flow Framework standards & templates → <X>Flow repositories
                                           ↓ onboarding checks & expert review
Research requirements → FlowAgent → capability retrieval → analysis plan & workflow plan
                                           ↓ validation & human confirmation
                                     Snakemake execution
                                           ↓
                                    outputs, logs & run records
```

Flow Framework provides a unified entry point for initialization, configuration overrides, module dependencies, and target generation. Raw data must pass standardization and MD5 gating before entering omics analysis and delivery.

FlowAgent understands workflow capabilities through catalogs, ports, and manifests. The LLM selects and explains; the tool layer enforces constraints, submission gates, and ledgers. New or modified rules enter the capability library through candidate proposals and human review.

## Getting started

**Developing or refactoring a workflow**: Start with the [Flow Framework guide](flow-framework/README.md) and follow the [full specification](flow-framework/references/flow_framework_spec.md) to set up your workflow. Development guidance for AI coding assistants is available in [SKILL.md](flow-framework/SKILL.md).

**Onboarding a workflow to the Agent**: Follow the [workflow onboarding guide](docs/planning/Flow-Workflow-Onboarding-Guide.md) to prepare manifests, ports, and deliverable directories, complete validation and real small-sample acceptance, then set `FLOW_WORKFLOW_ROOT` to point at the workflow repository.

**Trying the Agent backend**:

```bash
cd FlowAgent
npm install
cp .env.example .env
# edit .env to configure the model endpoint, API key, and model ID
npm run cli
```

When `FLOW_WORKFLOW_ROOT` is not set, the built-in demo is used. See the [FlowAgent README](FlowAgent/README.md) for the HTTP service, human confirmation, model configuration, and executors.

## Status

The Agent currently provides CLI/HTTP interfaces, standard and expert modes, capability retrieval, minimal scientific plans, structured composition compilation, configuration and subgraph checks, dry-run, human confirmation, run snapshots, and status queries, along with local/Slurm executor interfaces.

Overall, the project remains in a controlled pilot stage. Fully immutable rule/pipeline releases, dependency and reference locking, independent scientific review, and result-quality validation still need work; demos and tooling tests cannot replace end-to-end acceptance of real workflows. See the [planning alignment review](docs/info/FlowAgent_Planning_Alignment_2026-10-16.md) for the specific gaps between the current implementation and the target.

## Repository layout

```text
FlowFrame/
├── flow-framework/       # workflow development guides, full specification, and templates
├── FlowAgent/            # AI orchestration backend, demos, and evaluation scripts
├── docs/
│   ├── planning/         # master plan and workflow onboarding guide
│   └── info/             # architecture reviews and implementation alignment
└── LICENSE               # MIT License
```

## License

This project is licensed under the [MIT License](LICENSE). Referenced third-party tools and dependencies follow their respective licenses.
