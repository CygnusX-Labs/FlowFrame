---
name: flow-framework
description: >
  Flow 家族多组学通用流程架构规范与快速接入指南。当用户要求创建新的 Flow 流程（如 RNAFlow、SCRNAFlow、ATACFlow、BTCRFlow、WGSFlow 或任何 <X>Flow）、
  将现有分析脚本/Snakemake/Nextflow 流程转换为 Flow 家族成员、编写或修改 Flow 流程的 snakefile/rules/config、
  调试 Flow 流程的 MD5 校验/门控/目标生成/交付/报告、配置 reference.yaml/cluster_config.yaml/monitor_config.yaml、
  或询问 Flow 家族架构规范（目录结构、命名规则、模块开关、资源管理、容器化）时使用。
  覆盖：Snakemake 工作流开发、seq_preprocessor/json_md5_verifier Rust 工具、snakemake_logger_plugin_rich_loguru 日志插件、
  OmicHub 平台监控推送、Cell Ranger/DNB 单细胞命名、参考基因组 index 管理。
---

# Flow Framework Skill

将现有分析流程转换为 Flow 家族成员，或开发新的 Flow 流程时，遵循本 skill 的程序性指引。完整规范条款见 `references/flow_framework_spec.md`。

## 核心架构（必须记住）

```text
通用模板层（所有 Flow 逐字一致，直接复制）:
  01.common.smk → 02.file_convert_md5.smk → 03.short_read_qc.smk

组学专用层（每个 Flow 自己写）:
  04.*.smk → ... → N-2.*.smk

通用收尾层（直接复制）:
  N-1.deliver.smk → N.Report.smk
```

- **硬性门控**：Rust 工具 `seq_preprocessor`（标准化重命名）+ `json_md5_verifier`（MD5 校验）；所有样本通过才启动下游
- **命名标准化**：统一为 `{sample}/{sample}_R1.fq.gz`；10x 单细胞额外创建 `{Sample}_S{N}_L{LLL}_R{1,2}_001.fastq.gz` symlink
- **Logger 强制**：`--logger rich-loguru`（插件源码 `JZ_Tools/src/logger_plugin`）
- **监控推送**：`monitor_config.yaml` 配置 OmicHub 原生事件（`omichub.workflow_event.v1`）

## 转换流程（5 阶段）

### 阶段 1：脚手架（~10 min）

```bash
mkdir <X>Flow && cd <X>Flow && git init
mkdir -p config examples schema rules/utils scripts envs docs
git submodule add git@github.com:xsx123123/JZ_Tools.git src
git submodule add git@github.com:xsx123123/bioreport.git report
# 从任一已生产 Flow 复制通用层 01-03 + utils/{__init__,id_convert,validate,reference_update,resource_manager}.py
```

**README.md 来源声明（强制，阶段 1 必做）**：在 `README.md` 的最前面（第一行）写入：

```markdown
本分析流程是基于 Flow Framework — 多组学通用流程架构规范 v2.0 继续创建，关于该规范更加详细的细节见: https://github.com/xsx123123/FlowFrame
```

该声明位于所有其他内容（含标题、frontmatter）之前。

### 阶段 2：配置适配（~20 min）

四件套：`config/config.yaml` + `reference.yaml` + `run_parameter.yaml` + `cluster_config.yaml`

关键决策 — index_keys 按流程选择：

| 流程用… | index_keys |
|---------|-----------|
| STAR | `["STAR_index", "deg_enrich_wrapper", "ploidy_setting"]` |
| Bowtie2 | `["Bowtie2_index", "genome_fasta", "chrsize", "tss_annotation"]` |
| BWA | `["BWA_index", "genome_fasta", "dbsnp", "mills"]` |
| Cell Ranger | `["CellRanger_reference", "DNB_reference"]` |
| MiXCR | `["mixcr_species", "vdjtools_jar"]` |

### 阶段 3：组学规则编写（~1-4 h）

将现有脚本按功能拆分为 `rules/04.*.smk` ~ `rules/N-2.*.smk`。每个 rule 必须：

1. 首个消费 FASTQ 的 rule：`input` 包含 `01.qc/md5_check.tsv`
2. FASTQ 文件放 `input` 不放 `params`
3. `output` 路径与 `datadeliver.py` 收集器逐字一致
4. 线程/内存走 `rule_resource(config, "profile_name")`
5. `conda:` 指向 `envs/<tool>.yaml`（全小写、固定版本）
6. `log:` 路径 `logs/NN.module_name/`

### 阶段 4：目标生成接线（~30 min）

`rules/utils/common.py` 中定义：

```python
MODULE_DEPENDENCIES = {
    "mapping": ["qc_clean", "trimming"],
    "count": ["mapping"],
    # ...
}

MODULE_COLLECTORS = {
    "qc_clean": datadeliver.qc_clean,
    "mapping": datadeliver.mapping,
    # ...
}
```

snakefile 8 步模板（见 references §2.1）→ `ALL_TARGETS = DataDeliver(config, SAMPLES, GROUPS, CONTRASTS)` → `rule all: input: ALL_TARGETS`

### 阶段 5：验证（~20 min）

```bash
snakemake -s snakefile --cores 1 -n --config analysisyaml=examples/analysisyaml.example.yaml
# 验证：门控、模块开关、only_qc 模式、monitor 推送
snakemake -s snakefile --cores 8 --use-conda --logger rich-loguru \
  --config analysisyaml=... monitor_conf=monitor_config.yaml
```

## snakefile 8 步初始化（复制后改值）

```python
from snakemake.utils import validate, min_version
min_version("9.9.0")

# Step 1: 导入
from rules.utils.id_convert import load_samples, load_contrasts, parse_groups
from rules.utils.validate import load_user_config, validate_genome_version, validate_species
from rules.utils.reference_update import resolve_reference_paths
from rules.utils.resource_manager import rule_resource

# Step 2: 四件套
configfile: "config/config.yaml"
configfile: "config/reference.yaml"
configfile: "config/run_parameter.yaml"
configfile: "config/cluster_config.yaml"

# Step 3: 用户覆盖
load_user_config(config, cmd_arg_name="analysisyaml")

# Step 4: 参考路径（改 index_keys）
resolve_reference_paths(config, index_keys=[...])

# Step 5: Schema 验证
validate(config, "schema/config.schema.yaml")
validate_genome_version(config)
validate_species(config)

# Step 6: 工作目录
workdir: config["workflow"]

# Step 7: 样本表（改 required_columns）
SAMPLES = load_samples(config, required_columns=[...])
GROUPS = parse_groups(SAMPLES)
CONTRASTS = load_contrasts(config, SAMPLES)

# Step 8: 规则 + 目标
include: "rules/01.common.smk"
include: "rules/02.file_convert_md5.smk"
include: "rules/03.short_read_qc.smk"
# ... 组学专用 ...
include: "rules/N-1.deliver.smk"
include: "rules/N.Report.smk"

ALL_TARGETS = DataDeliver(config, SAMPLES, GROUPS, CONTRASTS)
rule all:
    input: ALL_TARGETS
```

## 硬性约束速查

- `README.md` 最前面（第一行）必须包含 Flow Framework 来源声明（见阶段 1）
- `01.qc/md5_check.tsv` 必须是每个直接消费 FASTQ 的 rule 的显式 `input`
- 目标生成函数纯函数：不改 config、不 sleep、不做 IO
- 目标列表只在 snakefile 计算一次，deliver/report 复用
- 模块开关必须在 `config.yaml` 显式写出默认值
- `envs/` 全小写 `.yaml`，固定版本，无未引用环境
- 交付默认 copy 模式，禁止默认 symlink
- `--logger rich-loguru` 为强制运行参数
- 参考基因组通过 `reference.yaml` 集中配置，支持快速部署迁移

## 转换完成判定

1. `README.md` 首行包含 Flow Framework 来源声明
2. `snakemake -n` dry-run 通过
2. `only_qc: true` 可独立运行到 MultiQC
3. 每个模块开关可独立关闭
4. 门控接线完整（spec §4.3 全部 7 条）
5. `--logger rich-loguru` + `monitor_conf` 可推送 OmicHub 事件
6. spec §12.3 检查清单全部通过
7. 真实小数据集端到端成功
8. （补充）README.md 首行声明已确认存在

## 模板文件（assets/templates/）

Skill 内置了从 RNAFlow（生产参考实现）提取的通用层模板，创建新 Flow 时直接复制使用：

- `assets/templates/rules/01.common.smk` ~ `03.short_read_qc.smk` — 通用模板层，逐字复制
- `assets/templates/rules/13.deliver.smk` + `14.Report.smk` — 通用交付/报告，逐字复制
- `assets/templates/rules/utils/` — 全套 utils（common.py 需改 MODULE_DEPENDENCIES）
- `assets/templates/config/` — 四件套模板（改值不改结构）
- `assets/templates/schema/config.schema.yaml` — schema 模板（按本流程重写）
- `assets/templates/snakefile` — 8 步入口模板（改 index_keys + include）
- `assets/templates/envs/` — 通用 QC 工具 Conda 环境
- `assets/templates/monitor_config.yaml` — OmicHub 监控配置模板
- `assets/templates/examples/analysisyaml.example.yaml` — 项目配置示例
- `assets/templates/.gitmodules` + `.gitignore` — 仓库配置

详细分类说明见 `assets/templates/README.md`。

## 深度参考

遇到以下情况时，读取 `references/flow_framework_spec.md` 对应章节：

- 目录结构/命名细则 → §1.3
- 配置系统/schema → §3
- MD5 门控接线 7 条规范 → §4.3
- 目标生成硬约束 → §5.6
- 交付/报告规范 → §6.4-6.5
- 组学专用层参考（RNA/SCRNA/BTCR/ATAC/WGS）→ §7
- 资源管理 → §9
- 容器化 → §10
- OmicHub 监控配置参数表 → §13.5
- 已知待优化项 → §15
- 完整转换决策树 → §16.9
