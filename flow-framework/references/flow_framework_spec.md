# Flow Framework — 多组学通用流程架构规范 v2.0

本文档是 Flow 家族流程的**强制架构规范**。所有 Flow 系列流程（RNAFlow、SCRNAFlow、BTCRFlow、ATACFlow、WGSFlow 等）必须遵循此规范。新流程开发以此为蓝本，已有流程按 §15 对齐清单逐步收敛。

> 本版由旧 `Flow_framework.md`（v1）、`Flow_architecture.md` 合并而成，规范条款以三家已实现流程（RNAFlow / SCRNAFlow / ATACFlow）的实际代码核对为准。§15 中标注"已验证"的条目来自逐仓库代码审查。

---

## 1. 框架总览

### 1.1 设计哲学

| 原则 | 说明 |
|------|------|
| 共享骨架，分化分析 | 入口、配置、MD5 校验、QC、交付、报告为通用层；mapping/count/variant 为组学专用层 |
| 配置优先级链 | 默认四件套 → 项目级 `analysisyaml` → 命令行 `--config` 最终覆盖 |
| 硬性数据门控 | 使用 Rust 工具 `seq_preprocessor`（标准化重命名）+ `json_md5_verifier`（MD5 校验）处理输入文件；**所有样本**校验通过后方可启动下游分析，任一样本不通过 → 流程中止，下游不启动 |
| 模块开关 + 依赖自动启用 | 每个模块可独立启停；启用下游时自动启用其依赖并警告 |
| 零拷贝标准化 | 原始 FASTQ 通过 symlink 标准化命名，不消耗额外磁盘 |
| 通用模板层 | `01.common.smk` + `02.file_convert_md5.smk` + `03.short_read_qc.smk` 为所有 Flow 共享模板：将不同平台、不同命名规则的下机 FASTQ 统一为标准命名，经质控获得 clean data；组学专用层从 04 开始分化 |
| 分层目标生成 | `AnalysisTargets()` 计算中间目标 → `DataDeliver()` 追加交付/报告目标 |
| 纯函数目标生成 | 目标生成函数无副作用：不改写 config、不 sleep、不做 IO |

### 1.2 Flow 家族成员

| 流程 | 组学场景 | 核心分析层 | 状态 |
|------|----------|------------|------|
| RNAFlow | Bulk RNA-seq | STAR → RSEM → DEG → variant → rMATS → fusion | 生产 |
| SCRNAFlow | 单细胞 RNA | Cell Ranger / dnbc4tools → count matrix | 生产 |
| BTCRFlow | Bulk BCR/TCR | cutadapt → MiXCR → VDJtools diversity | 生产 |
| ATACFlow | 染色质可及性 | Bowtie2 → MACS2/3 peak → consensus → diff → motif | 生产 |
| WGSFlow | 全基因组 | BWA → GATK → CNV → SV | 规划 |

### 1.3 通用目录结构（强制）

```text
<X>Flow/
├── README.md                        # 必须存在，首行为 Flow Framework 来源声明（见下）
├── snakefile                        # 入口（小写，必须存在）
├── config/
│   ├── config.yaml                  # 默认配置（software、raw_data、模块开关默认值）
│   ├── reference.yaml               # 参考基因组路径
│   ├── run_parameter.yaml           # 运行参数（线程、内存、工具参数）
│   ├── cluster_config.yaml          # HPC 资源 profile + clusters 映射
│   ├── samples.csv                  # 样本表模板
│   └── contrasts.csv                # 对比表模板（可选）
├── examples/
│   └── analysisyaml.example.yaml    # 项目级配置示例（脱敏，无真实机器路径/IP）
├── schema/
│   └── config.schema.yaml           # JSON Schema 验证（必须存在）
├── rules/
│   ├── 01.common.smk                # 导入 utils + logger 初始化（无业务 rule）
│   ├── 02.file_convert_md5.smk      # FASTQ 标准化 + MD5 校验（通用）
│   ├── 03.short_read_qc.smk         # FastQC + MultiQC（通用）
│   ├── 04.*.smk ~ N-2.*.smk         # 组学专用层，编号连续、全小写蛇形命名
│   ├── subrules/                    # 可选：可替换子规则（如 bowtie2/chromap）
│   ├── N-1.deliver.smk              # 交付（通用接口）
│   ├── N.Report.smk                 # 报告（通用接口）
│   └── utils/
│       ├── __init__.py              # 必须存在
│       ├── common.py                # AnalysisTargets + DataDeliver + 辅助函数
│       ├── datadeliver.py           # 模块目标文件收集器
│       ├── id_convert.py            # 样本表/对比表解析
│       ├── validate.py              # 配置验证、参考路径检查
│       ├── reference_update.py      # resolve_reference_paths
│       ├── resource_manager.py      # HPC 资源 profile 解析
│       └── tools.py                 # 组学专用命令行构建辅助
├── src/                             # Git submodule → JZ_Tools
├── scripts/                         # 组学专用 R/Python 脚本（被 rule 引用的才允许存在）
├── envs/                            # Conda 环境 YAML（统一 .yaml 后缀）
├── docs/
├── report/                          # Git submodule → bioreport
└── container_env/                   # Git submodule → Flowcontainer（可选）
```

命名与仓库卫生细则：

- **README.md 来源声明（强制）**：所有基于本规范创建的 Flow 流程，其 `README.md` 文件的**最前面**（第一行）必须添加以下声明：

  > 本分析流程是基于 Flow Framework — 多组学通用流程架构规范 v2.0 继续创建，关于该规范更加详细的细节见: https://github.com/xsx123123/FlowFrame

  该声明必须位于所有其他内容（含标题、frontmatter）之前；README 其余部分再按常规写流程简介、使用方法等。
- rule 文件必须为 `NN.snake_case.smk`（编号两位、连续、不跳号、不允许同序号两个文件）。例外：收尾报告允许 `N.Report.smk`。
- env 文件必须全小写 `.yaml`（禁止 `.yml`、大写开头）；一个工具一个环境，禁止重复环境并存。
- 仓库根目录禁止存在项目级 `config.yaml`（项目配置一律走 `examples/analysisyaml.example.yaml` + `--config analysisyaml=`）。
- 入库内容禁止出现真实机器绝对路径、内网 IP、个人 home 路径（`config/reference.yaml` 默认值应为空或占位，由 analysisyaml 覆盖）。
- `__pycache__/`、`*.pyc`、`logs/`、`benchmarks/`、`Compile_release/`、`target/` 必须在 `.gitignore`；但 `config/*.csv`、`data/*.fa` 等模板/固定小数据必须加例外，禁止 `*.csv` 一刀切。
- 日志与 benchmark 目录命名必须与 rule 编号一致：`logs/<NN>.<module>/`、`benchmarks/<NN>.<module>/`（统一复数 `benchmarks`）。

---

## 2. 入口 snakefile（强制规范）

### 2.1 标准初始化序列

所有 Flow 流程的 `snakefile` **必须**遵循以下 8 步初始化序列。以 SCRNAFlow 为参考实现：

```python
from snakemake.utils import validate, min_version
min_version("9.9.0")

# ─── Step 1: 导入框架工具 ───────────────────────────────────────────
from rules.utils.id_convert import load_samples, load_contrasts, parse_groups
from rules.utils.validate import (
    load_user_config, validate_genome_version, validate_species
)
from rules.utils.reference_update import resolve_reference_paths
from rules.utils.resource_manager import rule_resource

# ─── Step 2: 加载默认四件套 ─────────────────────────────────────────
configfile: "config/config.yaml"
configfile: "config/reference.yaml"
configfile: "config/run_parameter.yaml"
configfile: "config/cluster_config.yaml"

# ─── Step 3: 用户 analysisyaml 覆盖（最高优先级）────────────────────
load_user_config(config, cmd_arg_name="analysisyaml")

# ─── Step 4: 解析参考基因组路径 ─────────────────────────────────────
resolve_reference_paths(config, index_keys=[...])  # 组学专用 keys

# ─── Step 5: Schema 验证（必须执行）─────────────────────────────────
validate(config, "schema/config.schema.yaml")
validate_genome_version(config)
validate_species(config)

# ─── Step 6: 工作目录重定向 ─────────────────────────────────────────
workdir: config["workflow"]

# ─── Step 7: 加载样本表 ─────────────────────────────────────────────
SAMPLES = load_samples(config, required_columns=[...])
GROUPS = parse_groups(SAMPLES)
CONTRASTS = load_contrasts(config, SAMPLES)

# ─── Step 8: 包含规则 + 动态目标 ────────────────────────────────────
include: "rules/01.common.smk"
include: "rules/02.file_convert_md5.smk"
include: "rules/03.short_read_qc.smk"
# ... 组学专用规则 ...
include: "rules/N-1.deliver.smk"
include: "rules/N.Report.smk"

# 目标列表只在此处计算一次（见 §5.6）
ALL_TARGETS = DataDeliver(config, SAMPLES, GROUPS, CONTRASTS)

rule all:
    input: ALL_TARGETS
```

细则：

- `configfile:` 只允许四件套；容器元数据等本机信息走 analysisyaml 或"存在才加载"的可选文件，不得让缺失文件导致启动报错。
- 插件 logger 为**强制依赖**（见 §6.1）：生产环境必须安装 `snakemake_logger_plugin_rich_loguru` 并通过 `--logger rich-loguru` 启用；代码中保留 try/except fallback 仅为开发调试兜底，禁止顶层裸 import 导致未装插件即 ImportError。
- snakefile 不写版本号字符串；版本唯一来源是 `config/config.yaml` 的 `pipeline_version`，README 引用它。

### 2.2 Import 路径规范（强制）

| 位置 | Import 方式 | 示例 |
|------|-------------|------|
| `snakefile` | `from rules.utils.<module> import ...` | `from rules.utils.validate import load_user_config` |
| `rules/*.smk` | `from utils.<module> import ...` | `from utils.common import DataDeliver` |
| `rules/utils/*.py` 互相引用 | `from utils.<module> import ...` | `from utils.datadeliver import qc_clean` |

> **限制**：`rules/utils/*.py` 内部只允许 `utils.*` 一种根，禁止同一文件混用 `rules.utils.*` 与 `utils.*`（同一模块被加载两次，且经 `rules.utils` 路径导入时 `utils.*` 解析失败）。SCRNAFlow 曾因此出现 datadeliver 导入错误（已验证）。

### 2.3 运行方式（所有 Flow 统一）

```bash
snakemake -s /path/to/<X>Flow/snakefile \
  --cores 32 \
  --use-conda \
  --conda-frontend mamba \
  --rerun-triggers mtime \
  --logger rich-loguru \
  --config analysisyaml=/project/01.workflow/config.yaml
```

> **`--logger rich-loguru` 为强制参数**：所有 Flow 家族流程运行时必须启用 `snakemake_logger_plugin_rich_loguru` 插件（见 §6.1）。

### 2.4 各流程 index_keys 对照

| 流程 | `resolve_reference_paths` index_keys |
|------|--------------------------------------|
| RNAFlow | `["STAR_index", "deg_enrich_wrapper", "ploidy_setting"]` |
| SCRNAFlow | `["CellRanger_reference", "DNB_reference"]` |
| BTCRFlow | `["mixcr_species", "vdjtools_jar"]` |
| ATACFlow | `["Bowtie2_index", "genome_fasta", "chrsize", "tss_annotation"]` |
| WGSFlow | `["BWA_index", "genome_fasta", "dbsnp", "mills"]` |

> 注：旧文档写的 ATACFlow `BWA_index` 更正为 `Bowtie2_index`（实际实现）。

**为什么各流程 index_keys 不同**：不同分析流程使用不同的比对/定量软件（如 RNAFlow 用 STAR+RSEM、ATACFlow 用 Bowtie2、WGSFlow 用 BWA），每种软件需要特定格式的 index 或参考文件；同时同一软件在不同基因组版本（hg38/mm10/TAIR10 等）下的 index 路径也不同。`index_keys` 的作用是声明当前流程需要从 `reference.yaml` 中解析哪些键为绝对路径，从而：

- 隔离流程差异：每个流程只解析自己消费的参考键，不因其他流程的参考缺失而报错
- 保存流程特异性配置：不同流程的参考基因组目录结构、index 格式、辅助文件（如 chrsize、TSS bed）各不相同
- 支持多基因组共存：同一 `reference.yaml` 可包含多个基因组版本，`resolve_reference_paths` 只解析当前 `Genome_Version` 对应的条目

---

## 3. 配置系统（通用）

### 3.1 配置优先级（从低到高）

```text
config/config.yaml          (仓库默认)
  ← config/reference.yaml   (参考基因组)
  ← config/run_parameter.yaml (运行参数)
  ← config/cluster_config.yaml (资源 profile)
  ← analysisyaml            (项目级，用户覆盖)
  ← --config key=value      (命令行，最终覆盖)
```

### 3.1.1 参考基因组集中管理与快速部署（强制）

所有参考基因组文件和 index 统一存放在特定目录下（如 `/data/reference/<X>Flow_reference/`），通过 `config/reference.yaml` 进行路径配置。这一设计实现：

- **快速部署**：新环境只需准备参考目录 + 修改 `reference.yaml` 中的路径前缀，即可运行全部流程，无需改动任何 rule 代码
- **快速迁移**：参考目录整体迁移（rsync/NFS 挂载）后，仅更新 `reference.yaml` 或 analysisyaml 中的 `reference_path` 即可完成环境切换
- **多版本共存**：同一参考目录下按基因组版本（hg38/mm10/TAIR10）分子目录，`resolve_reference_paths` 按当前 `Genome_Version` 只解析对应条目
- **流程隔离**：各流程通过 `index_keys`（§2.4）声明自己消费的参考键，互不干扰

`reference.yaml` 标准结构示例：

```yaml
reference_path: /data/reference/RNAFlow_reference

hg38:
  STAR_index: /data/reference/RNAFlow_reference/hg38/STAR_index
  rsem_index: /data/reference/RNAFlow_reference/hg38/RSEM_index
  genome_fasta: /data/reference/RNAFlow_reference/hg38/genome.fa
  gene_gtf: /data/reference/RNAFlow_reference/hg38/genes.gtf
  # ... 其他流程专用键

mm10:
  STAR_index: /data/reference/RNAFlow_reference/mm10/STAR_index
  # ...
```

> 部署清单：① 准备参考目录（下载/构建 index）→ ② 编写 `reference.yaml` → ③ analysisyaml 中设置 `reference_path` → ④ dry-run 验证路径可达。

### 3.2 项目级 analysisyaml 最小结构

```yaml
# ─── 项目元数据 ─────────────────────────────────────────
project_name: my_project
Genome_Version: hg38
species: Homo_sapiens
client: demo

# ─── 路径（必须绝对路径）────────────────────────────────
raw_data_path:
  - /data/project/00.raw_data
sample_csv: /data/project/01.workflow/samples.csv
paired_csv: /data/project/01.workflow/contrasts.csv
workflow: /data/project/01.workflow
data_deliver: /data/project/02.data_deliver
reference_path: /data/reference/<X>Flow_reference

# ─── 执行模式 ───────────────────────────────────────────
execution_mode: local       # local | cluster
queue_id: ""                # cluster 模式下的队列名

# ─── 模块开关（按需覆盖，不写则用仓库默认）─────────────
only_qc: false
qc_clean: true
deliver: true
report: true
```

> `sample_csv` / `workflow` / `data_deliver` / `reference_path` 必须为绝对路径：样本表解析发生在 `workdir:` 重定向前，相对路径会按 snakemake 启动目录解析，从仓库外调用即失败（SCRNAFlow 已验证此坑）。

### 3.3 通用 config/config.yaml 结构

```yaml
# ─── 软件路径 ───────────────────────────────────────────
software:
  seq_preprocessor: ../src/src/md5/Compile_release/seq_preprocessor_x86_64/release/seq_preprocessor
  json_md5_verifier: ../src/src/md5/Compile_release/json_md5_verifier_x86_64/release/json_md5_verifier
  fastqc: fastqc
  multiqc: multiqc
  # 组学专用工具在此追加

# ─── 原始数据配置 ───────────────────────────────────────
raw_data:
  md5: md5.txt                # 原始数据目录中的 MD5 文件名
  library_type: short-read    # 传给 seq_preprocessor --library-type
  sample_sheet_rename: false

# ─── 标准化输出 ─────────────────────────────────────────
convert_md5: link_dir         # 标准化链接输出子目录名
r1_suffix: _R1.fq.gz          # 标准化后缀（定义了就必须被消费，见下）
r2_suffix: _R2.fq.gz

# ─── 流程控制 ───────────────────────────────────────────
pipeline_version: "<X>Flow v1.0.0"    # 唯一版本来源
log_level: INFO
print_target: false           # dry-run 时打印目标列表

# ─── 通用模块开关（默认值必须显式写出）──────────────────
only_qc: false
qc_clean: true
deliver: true
report: true

# ─── 组学专用模块开关（各流程自定义，同样必须显式写出）──
# mapping: true
# count: true
# deg: true
```

配置键细则：

- **开关默认值显式化**：`AnalysisTargets` 的机制是 `config.get(module) is not False`（缺键即开），但每个可关闭模块的开关**必须**在 `config/config.yaml` 中有显式默认值，使用户能看到全部可关项；首次运行时把生效开关表打进日志。
- **禁止死键/重复键**：顶层不允许再有 `md5` 这类与 `raw_data.md5` 重复的键（三家仓库都曾存在，已验证）；新增键前先在 schema 登记。
- **定义即消费**：`r1_suffix`/`r2_suffix` 定义了就必须被消费——所有拼 FASTQ 路径的 helper 从 config 读后缀，禁止散落硬编码 `_R1.fq.gz`（RNAFlow 曾定义而未消费，已验证）。
- **键名读取一致性**：模块开关的读取键必须与文档/schema 完全一致。RNAFlow 曾出现文档写 `deg`、代码读 `DEG` 导致开关静默失效（已验证）。新增开关时 grep 验证读取点。

### 3.4 cluster_config.yaml 标准结构

```yaml
resource_profiles:
  low_resource:
    threads: 2
    mem_mb: 18000
    runtime: 240
    queue_type: short
  medium_resource:
    threads: 10
    mem_mb: 86000
    runtime: 720
    queue_type: medium
  high_resource:
    threads: 18
    mem_mb: 100000
    runtime: 1440
    queue_type: long
  very_high_resource:
    threads: 32
    mem_mb: 200000
    runtime: 2880
    queue_type: long

clusters:                    # cluster 模式 queue_type → 实际队列名映射（必须存在）
  short: short_queue
  medium: medium_queue
  long: long_queue
```

> **规范**：`very_high_resource` 的 mem_mb 与 threads 必须 >= `high_resource`（RNAFlow 曾出现 32 线程 profile 内存反而更小的倒置，已验证）。`clusters:` 段缺失时 cluster 模式必须 fail-fast，禁止静默降级为 warning 后提交不带队列的作业（已验证）。

### 3.5 Schema 验证（强制）

每个流程**必须**在 `schema/config.schema.yaml` 中定义 JSON Schema，且在 snakefile Step 5 中显式调用 `validate(config, "schema/config.schema.yaml")`。

Schema 规范：

- 使用 JSON Schema draft 2020-12
- `additionalProperties: true`（允许扩展，但已定义字段必须类型正确）
- 必须有顶层 `required`，至少包含：`project_name`, `Genome_Version`, `species`, `raw_data_path`, `sample_csv`, `workflow`, `data_deliver`
- 必须验证：`Genome_Version`(enum), `raw_data_path`(array), `execution_mode`(enum)
- 组学专用字段按需追加
- **Schema 必须与本流程真实配置结构对齐**：禁止从别的流程复制不改。ATACFlow 的 schema 曾整段保留 RNAFlow 的 STAR/RSEM 结构、标题仍为 "RNAFlow"（已验证）；RNAFlow 的 `genomeConfig` 要求 `ploidy` 但实际键是 `ploidy_setting`（已验证）。
- `Genome_Version` 的 enum 应与 `reference.yaml` 可用版本单一来源（生成或 CI 检查一致），禁止双处手工维护漂移。

---

## 4. 02 步：FASTQ 标准化与 MD5 校验（通用核心）

### 4.1 数据流

```text
raw_data_path (任意命名的原始 FASTQ)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  seq_preprocessor (Rust)                                     │
│                                                              │
│  1. 递归扫描 raw_data_path 目录                              │
│  2. 识别多种 FASTQ 命名模式：                                │
│     - Illumina: {sample}_S1_L001_R1_001.fastq.gz            │
│     - Generic:  {sample}_R1.fq.gz / {sample}_1.fq.gz        │
│     - SRA PE:   SRRxxxxxx_1.fq.gz / _2.fq.gz               │
│     - .raw 后缀: {sample}.R1.raw.fq.gz                      │
│     - Long-read SE: {sample}.fq.gz                          │
│  3. 创建标准化软链接（零拷贝）：                             │
│     00.raw_data/link_dir/{sample}/{sample}_R1.fq.gz         │
│     00.raw_data/link_dir/{sample}/{sample}_R2.fq.gz         │
│  4. 解析原始目录中的 md5.txt，写入 per-sample md5.txt        │
│  5. 生成审计报告：                                           │
│     00.raw_data/link_dir/raw_data_md5.json                   │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  json_md5_verifier (Rust)                                    │
│                                                              │
│  1. 读取 raw_data_md5.json                                   │
│  2. 多线程并行计算实际 MD5（Rayon）                          │
│  3. 逐文件比对 expected vs actual MD5                        │
│  4. SRA 数据（无厂商 MD5）：计算并记录，标记 PASS            │
│  5. 输出校验报告：01.qc/md5_check.tsv                        │
│  6. 任何文件校验失败 → 非零退出码 → 流程中止                │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
  01.qc/md5_check.tsv  ← 硬性门控（Hard Gate）
        │
        ├──> 03.short_read_qc (FastQC/MultiQC)
        ├──> [组学专用] prepare_scrna_fastq_links (SCRNAFlow)
        └──> 组学专用下游规则
```

### 4.2 设计原则

- **命名标准化**：无论输入是何种命名 convention，统一为 `{sample}/{sample}_R1.fq.gz`。
  - **10x Genomics 单细胞特殊要求**：Cell Ranger 对输入 FASTQ 文件名有严格约定，必须为 `{SampleName}_S{N}_L{LLL}_R{1,2}_001.fastq.gz` 格式（如 `PBMC_S1_L001_R1_001.fastq.gz`）。SCRNAFlow 的 `prepare_scrna_fastq_links` 步骤会在通用标准化（`{sample}_R1.fq.gz`）之后，额外创建符合 Cell Ranger 命名规范的 symlink 目录结构，确保 `cellranger count --fastqs` 能正确识别。DNB 平台（dnbc4tools）则有 cDNA/oligo 双目录结构要求，同样由该步骤处理。
- **零拷贝**：使用 Unix symlink，不消耗额外磁盘空间。
- **硬性门控**：`01.qc/md5_check.tsv` 是下游规则的**显式 input 依赖**，MD5 不通过则流程中止。
- **审计追踪**：`raw_data_md5.json` 保留原始路径（绝对）→ 标准化路径（相对）的完整映射。
- **SRA 兼容**：公共数据库下载的数据无厂商 MD5，工具自动计算并记录，建立基线。
- **唯一实现**：仅使用 Rust 二进制工具，不保留 Python fallback（`check_md5.py` 已废弃）。

### 4.3 门控接线规范（强制）

以下条款均源自已发生的真实 bug：

1. **入口规则显式挂门**：`01.qc/md5_check.tsv` 必须是**每个直接消费原始/标准化 FASTQ 的规则**的显式 `input`——03 QC、04 contamination、05 clean，以及不经 clean 的分析入口（如 SCRNAFlow 的 count）。仅靠产物链传导不满足规范：SCRNAFlow 的 count 曾只靠 fastqc 产物传递门控，一旦中间环节被摘掉门控即静默失效（已验证）。
2. **FASTQ 必须进 input**：任何规则消费的 FASTQ/链接文件必须声明在 `input`，禁止只放 `params`——params 不建 DAG 边，会产生"链接尚未生成即运行"的竞态。SCRNAFlow 04 fastq_screen 曾犯此错（已验证）。
3. **声明依赖与扫描范围一致**：`seq_preprocessor` 的 input 声明必须与实际 `-i` 扫描的目录列表一致（RNAFlow 曾声明样本表目录、实际扫 config 原列表，审计不完整，已验证）。
4. **日志不双写**：规则的 `log:` 与工具自身 `--log-file` 禁止指向同一文件（SCRNAFlow 02 步曾双重写入、内容交错，已验证）；日志路径遵循 §1.3 的编号约定。
5. **线程与 profile 一致**：`check_md5` 等规则的线程数不得超过资源 profile 的 threads（ATACFlow 曾 `threads: 1` 申请 high_resource 18 线程、verifier 又跑 40 线程，已验证）。
6. **`--library-type` 必须传递**：调用 seq_preprocessor 必须传 `--library-type {config[raw_data][library_type]}`（RNAFlow/ATACFlow 曾未传，已验证）。
7. **`raw_data_md5.json` 是审计层**：下游业务不得把它当数据源；确需用作链接发现回退时（如 SCRNAFlow prepare_links）必须在 rule 注释中说明。

### 4.4 raw_data_md5.json 格式

```json
[{
  "sample_name": "SampleA",
  "library_type": "PE",
  "new_r1_path_relative": "SampleA/SampleA_R1.fq.gz",
  "original_r1_path_absolute": "/data/raw/SampleA/SampleA_R1.clean.fq.gz",
  "md5_r1": "d41d8cd98f00b204e9800998ecf8427e",
  "new_r2_path_relative": "SampleA/SampleA_R2.fq.gz",
  "original_r2_path_absolute": "/data/raw/SampleA/SampleA_R2.clean.fq.gz",
  "md5_r2": "098f6bcd4621d373cade4e832627b4f6"
}]
```

### 4.5 md5_check.tsv 格式

```text
CheckTime	SampleName	FilePath	ExpectedMD5	ActualMD5	Status	Message
2024-01-01T00:00:00	SampleA	SampleA/SampleA_R1.fq.gz	d41d8c...	d41d8c...	PASS	
```

### 4.6 工具来源与编译

`seq_preprocessor` 和 `json_md5_verifier` 均为 Rust 编写的高性能命令行工具，源码托管在 JZ_Tools 仓库。

**Git 子模块集成**（所有 Flow 统一）：

```bash
cd /path/to/<X>Flow
git submodule add git@github.com:xsx123123/JZ_Tools.git src
git submodule update --init --recursive
```

`.gitmodules` 标准内容：

```ini
[submodule "src"]
    path = src
    url = git@github.com:xsx123123/JZ_Tools.git
[submodule "report"]
    path = report
    url = git@github.com:xsx123123/bioreport.git
[submodule "container_env"]
    path = container_env
    url = git@github.com:xsx123123/Flowcontainer.git
```

**编译方法**：

```bash
# 需要 Rust 工具链
cd src/src/md5/seq_preprocessor && cargo build --release
cd ../json_md5_verifier && cargo build --release

# 复制到标准发布路径
mkdir -p src/src/md5/Compile_release/{seq_preprocessor_x86_64/release,json_md5_verifier_x86_64/release}
cp src/src/md5/seq_preprocessor/target/release/seq_preprocessor \
   src/src/md5/Compile_release/seq_preprocessor_x86_64/release/
cp src/src/md5/json_md5_verifier/target/release/json_md5_verifier \
   src/src/md5/Compile_release/json_md5_verifier_x86_64/release/
```

**二进制管理规范**：
- `Compile_release/` 目录加入 `.gitignore`，不提交到版本控制
- 生产环境通过部署脚本或 CI 编译
- `target/` 目录（Cargo 构建缓存）绝不提交
- 未来迁移到 GitHub Releases 分发预编译二进制

---

## 5. 目标生成系统（核心架构）

### 5.1 分层架构（强制）

所有 Flow 流程的 `rules/utils/common.py` **必须**实现以下分层结构：

```python
# ─── 模块依赖图（每个流程自定义）────────────────────────
MODULE_DEPENDENCIES = {
    # 示例：ATACFlow
    "peak_calling": ["mapping"],
    "motif_analysis": ["peak_calling"],
    "consensus_peaks": ["peak_calling"],
    "diff_peaks": ["consensus_peaks"],
    "atac_qc": ["mapping"],
}

# ─── 模块目标收集器注册表 ───────────────────────────────
MODULE_COLLECTORS = {
    "qc_clean": datadeliver.qc_clean,
    "mapping": datadeliver.mapping,
    "peak_calling": datadeliver.peak_calling,
    # ...
}


def AnalysisTargets(config, samples, groups=None, contrasts=None):
    """
    计算所有启用的分析模块的中间目标文件列表。

    职责：
    1. 解析模块开关（config.get(module) is not False；默认值显式化见 §3.3）
    2. only_qc=True 时强制关闭所有下游模块
    3. 自动启用缺失的依赖模块（带警告日志）
    4. 按 MODULE_COLLECTORS 顺序收集目标文件
    5. 固定追加 MD5 校验层目标

    返回：list[str]
    """
    targets = []

    # 固定目标（所有流程）
    targets.append("00.raw_data/link_dir/raw_data_md5.json")
    targets.append("01.qc/md5_check.tsv")

    enabled = _resolve_enabled_modules(config)

    for module in enabled:
        collector = MODULE_COLLECTORS[module]
        targets = collector(samples, targets, config, groups=groups, contrasts=contrasts)

    return targets


def DataDeliver(config, samples, groups=None, contrasts=None):
    """
    最终目标生成器，作为 rule all 的 input。

    职责：
    1. 调用 AnalysisTargets() 获取分析目标
    2. 追加交付目标（deliver=True 时）
    3. 追加报告目标（report=True 时）
    4. 可选打印目标列表（print_target=True 时）

    返回：list[str]
    """
    targets = AnalysisTargets(config, samples, groups, contrasts)

    if config.get("deliver") is not False:
        targets.extend(datadeliver.delivery_outputs(config))

    if config.get("report") is not False:
        targets.extend(datadeliver.report_outputs(config))

    if config.get("print_target"):
        logger.info(f"Targets ({len(targets)}):\n" + "\n".join(map(str, targets)))

    return targets
```

### 5.2 模块依赖自动启用（强制）

```python
def _resolve_enabled_modules(config):
    """解析模块开关，自动启用缺失依赖。"""
    enabled = set()

    for module in MODULE_DEPENDENCIES:
        if config.get(module) is not False:
            enabled.add(module)

    # only_qc 模式：只保留 qc_clean 和 MD5 层
    if config.get("only_qc"):
        return {"qc_clean"} & enabled

    # 自动启用依赖（递归传递）
    changed = True
    while changed:
        changed = False
        for module in list(enabled):
            for dep in MODULE_DEPENDENCIES.get(module, []):
                if dep not in enabled:
                    logger.warning(
                        f"Module '{module}' requires '{dep}', auto-enabling it."
                    )
                    enabled.add(dep)
                    changed = True

    return enabled
```

### 5.3 datadeliver.py 标准接口

每个模块收集器函数签名统一：

```python
def <module_name>(samples, data_deliver, config, **kwargs) -> list:
    """
    收集该模块的所有输出文件路径。

    Args:
        samples: 样本字典 {sample_id: {sample_name, group, ...}}
        data_deliver: 当前已累积的目标列表（可追加）
        config: Snakemake config 字典
        **kwargs: 组学专用参数（contrasts, groups 等）

    Returns:
        追加后的目标列表
    """
```

收集器细则：

- 可选子步骤（如 fastq_screen）的目标追加必须读自己的开关，禁止无条件追加。RNAFlow/ATACFlow 均出现过 `fastq_screen: false` 时目标仍被拉回 DAG（已验证）。
- 收集器返回的路径必须与 rule 的 `output` 逐字一致；改 rule output 必须同 PR 改收集器。ATACFlow 曾出现收集器返回 `04.consensus/single/...` 而实际目录是 `single_macs2/single_macs3`（已验证）。
- 空壳收集器（原样返回列表）视同 bug：ATACFlow 的 `motif_analysis()` 曾为空壳导致 motif 开关无效（已验证）。

### 5.4 交付与报告目标（通用）

```python
def delivery_outputs(config) -> list:
    """交付模块固定输出。"""
    deliver_dir = config["data_deliver"]
    return [
        f"{deliver_dir}/delivery_manifest.json",
        f"{deliver_dir}/delivery_manifest.md5",
        f"{deliver_dir}/delivery_details.log",
    ]

def report_outputs(config) -> list:
    """报告模块固定输出（最小实现）。"""
    return ["project_summary.json"]
```

### 5.5 各流程 MODULE_DEPENDENCIES 定义

| 流程 | MODULE_DEPENDENCIES |
|------|---------------------|
| RNAFlow | `{"mapping": ["qc_clean", "trimming"], "count": ["mapping"], "deg": ["count"], "call_variant": ["mapping"], "detect_novel_transcripts": ["mapping"], "rmats": ["mapping"], "gene_fusion": ["mapping"]}` |
| SCRNAFlow | `{"count": ["qc_clean"]}` |
| BTCRFlow | `{"mixcr": ["qc_clean", "trimming"], "vdj_analysis": ["mixcr"]}` |
| ATACFlow | `{"mapping": ["qc_clean", "trimming"], "peak_calling": ["mapping"], "motif_analysis": ["peak_calling"], "consensus_peaks": ["peak_calling"], "diff_peaks": ["consensus_peaks"], "atac_qc": ["mapping"]}` |
| WGSFlow | `{"mapping": ["qc_clean", "trimming"], "variant": ["mapping"], "cnv": ["mapping"], "sv": ["mapping"]}` |

### 5.6 目标生成硬约束（强制）

以下条款均源自已发生的真实 bug，必须遵守：

1. **纯函数**：`AnalysisTargets()` / `DataDeliver()` 无副作用——不改写 config（用局部 `enabled` 副本）、不 `sleep`、不做文件 IO。RNAFlow/ATACFlow 的 DataDeliver 曾直接改写全局 config 并含 `time.sleep(1)` 阻塞 DAG 构建（已验证）。
2. **唯一调用点**：目标列表只在 snakefile 计算一次（`ALL_TARGETS`），deliver / report 规则复用该结果。禁止在 .smk 里以不同参数二次调用——RNAFlow 的 13.deliver/14.Report 曾用 `DataDeliver(config)` 不传 samples 二次调用，导致单独跑 delivery 目标时 DAG 不完整（已验证）。
3. **deliver/report 必须进 rule all**：`deliver: true` / `report: true` 时其产物必须出现在 `rule all` 目标中。ATACFlow 曾把 deliver/report 目标放在无人调用的 `ReportData()` 里，默认运行不产出交付与报告，属功能级断路（已验证）。
4. **开关静默失效视为 P0 bug**：任何"文档/默认值宣称可关、实际关不掉"的开关（如 RNAFlow `deg`/`DEG` 键名不匹配），发现即按 P0 处理。

---

## 6. 通用层规则

### 6.1 01.common.smk（强制）

```python
# 职责：导入公共函数 + 初始化 logger，不定义任何业务 rule

from utils.common import DataDeliver, AnalysisTargets
from utils.datadeliver import (
    qc_clean, delivery_outputs, report_outputs,
    # 组学专用收集器在此追加
)

# Logger 初始化（snakemake_logger_plugin_rich_loguru 为强制依赖）
# 插件源码：https://github.com/xsx123123/JZ_Tools/tree/main/src/logger_plugin
# 启用方式：snakemake --logger rich-loguru
# 功能：统一日志美化 + 运行进度推送到监控平台（Loki/Grafana 或 OmicHub）
try:
    from snakemake_logger_plugin_rich_loguru import setup_logger
    logger = setup_logger(config)
except ImportError:
    # 开发/调试环境 fallback（生产环境必须安装插件）
    try:
        from loguru import logger
        logger.warning("snakemake_logger_plugin_rich_loguru not installed, using loguru fallback")
    except ImportError:
        import logging
        logger = logging.getLogger(__name__)
```

> **强制要求**：`snakemake_logger_plugin_rich_loguru` 是 Flow 家族运行时的**必装插件**，负责：
> 1. 统一所有 Flow 流程的 Snakemake 运行日志格式（rich 美化输出）
> 2. 将运行进度实时推送到监控平台（支持 Loki/Grafana 兼容模式与 OmicHub 原生模式，见 §13.5）
>
> 插件源码位于 [JZ_Tools/src/logger_plugin](https://github.com/xsx123123/JZ_Tools/tree/main/src/logger_plugin)，通过 `pip install` 或 `snakemake --logger rich-loguru` 自动加载。代码中的 fallback 仅为开发调试兜底，生产部署必须确保插件可用。
>
> 注意：01.common.smk 与 utils/common.py 之间禁止复制粘贴重复的 import/fallback 块（RNAFlow 曾两处几乎全同，已验证）。公共逻辑只放 utils。

### 6.2 02.file_convert_md5.smk（通用，所有流程相同）

```python
rule seq_preprocessor:
    output:
        json_report="00.raw_data/link_dir/raw_data_md5.json",
    params:
        raw_data_path=lambda wildcards: get_all_input_dirs(SAMPLES, config),
        md5_file=config.get("raw_data", {}).get("md5", "md5.txt"),
        library_type=config.get("raw_data", {}).get("library_type", "short-read"),
    threads: 1
    log: "logs/02.file_convert_md5/seq_preprocessor.log"
    shell:
        "{config[software][seq_preprocessor]} ... --library-type {params.library_type}"

rule check_md5:
    input:
        json_report="00.raw_data/link_dir/raw_data_md5.json",
    output:
        check_report="01.qc/md5_check.tsv",
    threads: workflow.cores
    log: "logs/02.file_convert_md5/check_md5.log"
    shell:
        "{config[software][json_md5_verifier]} ..."
```

### 6.3 03.short_read_qc.smk（通用）

- 对 `00.raw_data/link_dir/{sample}/{sample}_R1/R2.fq.gz` 运行 FastQC
- MultiQC 汇总所有样本；MultiQC 合并报告必须按子目录精确收集，禁止递归扫整个 `01.qc`（会把已生成的 multiqc 产物二次吃进合并报告，SCRNAFlow 已验证）
- **必须**将 `01.qc/md5_check.tsv` 作为 input gate
- 可选 FastQ Screen 污染检测（由 `parameter.fastq_screen.run` 控制，收集器同步尊重该开关）
- R1/R2 两对镜像 rule 可用 wildcards 合并为一条

### 6.4 交付规则 N-1.deliver.smk（通用接口）

**输入**：snakefile 层算好的 `ALL_TARGETS`（复用，禁止二次调用 DataDeliver，见 §5.6-2）

**输出**：
- `{data_deliver}/delivery_manifest.json` — 交付文件清单（含来源路径、大小、MD5、动作）
- `{data_deliver}/delivery_manifest.md5` — manifest 自身的 MD5
- `{data_deliver}/delivery_details.log` — 逐文件 MD5 列表

**交付工具统一接口**：

```bash
# 所有流程使用同一个 Rust 交付工具，通过 config YAML 区分行为
flow-deliver \
  --config <X>Flow_delivery_config.yaml \
  --source-dir {workflow_dir} \
  --target-dir {data_deliver} \
  --mode copy
```

> **当前状态**：RNAFlow/ATACFlow 使用 `rnaflow-cli deliver`；SCRNAFlow 使用 Python 脚本。
> **目标状态**：统一为 `flow-deliver`（重命名后的 Rust 工具），各流程仅传不同 config YAML。

**交付模式规范（强制）**：

- `--mode` 默认 **copy**（或硬链接）。**禁止默认 symlink**：SCRNAFlow 曾以 symlink 交付指向 workflow 内部文件，workflow 目录移动/清理后交付区全部悬空（已验证）。symlink 仅允许显式 `--mode symlink` 且文档注明风险。
- 目录型产物必须计入 manifest，禁止静默跳过（SCRNAFlow 曾 `continue` 跳过目录，掩盖漏交付，已验证）。
- 目标列表传参必须用 `{input:q}` 或 manifest 文件，禁止未加引号的 `{input}` 展开（路径含空格即炸、样本多时超 argv 长度，SCRNAFlow 已验证）。

**delivery_manifest.json 格式**：

```json
{
  "pipeline": "ATACFlow",
  "version": "v1.0.0",
  "project_name": "my_project",
  "created_at": "2024-01-01T00:00:00",
  "files": [
    {
      "source": "06.mapping/bowtie2/SampleA.sort.bam",
      "delivered_path": "mapping/SampleA.sort.bam",
      "size_bytes": 123456789,
      "md5": "abc123...",
      "action": "copy"
    }
  ]
}
```

### 6.5 报告规则 N.Report.smk（通用接口）

**最小实现**（所有流程必须）：

```python
rule generate_project_summary:
    output: "project_summary.json"
    # 包含：项目元数据、样本列表、模块启用状态、软件版本、运行时间
```

**完整实现**（生产流程）：

- 使用容器运行 bioreport 子模块（引擎配置驱动：`container.engine: docker/apptainer/singularity`）
- 输入：`generate_docker_json` rule 生成报告配置 JSON
- 输出：HTML 交互式报告

**报告规范（强制）**：

- 报告 rule 必须依赖本流程真实分析产物（经 ALL_TARGETS），禁止只依赖 manifest 与 02 步并行完成（SCRNAFlow 曾如此，`project_summary.json` 无法反映真实完成状态，已验证）。
- `project_summary.json` / 报告配置中的产物路径必须来自 datadeliver 收集器，禁止写死其他流程的产物路径（ATACFlow 报告模板曾写死 RNAFlow 的 `merge_rsem_tpm.tsv`、QualiMap 路径并使用 `bioreportrna` 镜像，已验证）。
- 集群 executor 下必须有非 docker 路径（apptainer）或明确降级为 `project_summary.json`；禁止假定计算节点存在 docker daemon 且有权限（RNAFlow 14.Report 曾在 conda env 里直接 `docker run`，已验证）。
- `only_qc: true` 与 `report: true` 组合必须可用：报告退化为 QC 摘要，不引用未运行模块的产物（RNAFlow 曾因此组合失败，已验证）。
- 挂载点路径（如 `docker_prefix`）禁止硬编码 `/data`，必须由配置驱动并与 bind 配置一致（RNAFlow/ATACFlow 均曾硬编码，已验证）。

---

## 7. 组学专用层

### 7.1 RNAFlow（Bulk RNA-seq）

**规则链**：

```text
02.file_convert_md5 → 03.QC → 04.Contamination → 05.fastp clean
→ 06.STAR mapping → 07.RSEM count → 08.GATK variant
→ 09.StringTie → 10.DEG/Enrichment → 11.rMATS → 12.Fusion
→ 13.deliver → 14.Report
```

**核心工具**：STAR、RSEM、fastp、DESeq2、GATK、rMATS、Arriba

**样本表**：

| 必填列 | 可选列 |
|--------|--------|
| `sample, sample_name, group` | `bam`(自动生成), `condition, batch` |

**模块开关**：`trimming, mapping, count, deg, call_variant, detect_novel_transcripts, rmats, gene_fusion`

**特殊逻辑**：
- `bam` 列若为空，自动生成路径 `02.mapping/STAR/sort_index/{sample}.sort.bam`；自动推导的 bam 路径必须与 mapping rule 真实 output 逐字一致（ATACFlow 曾推导 `Bowtie2/...` 而实际输出 `Aligner/...`，已验证）
- `only_qc: true` 时只运行到 QC + trimming + mapping + count
- DEG 需要 contrasts.csv 定义对比组
- 参考基因组非版本子键（GO obo、blacklists 等）必须同样被 `resolve_reference_paths` 解析为绝对路径——RNAFlow 的 GO obo 曾因只解析版本条目、在 workdir 重定向后指向不存在路径，导致富集分析必挂（已验证）
- `check_reference_paths` 只校验当前 `Genome_Version` 对应条目，且覆盖该流程实际消费的全部键（bed12/rsem_index/go_annotation/ref_all 等）；禁止遍历全部基因组版本导致未使用版本缺文件即退出（RNAFlow 已验证）

### 7.2 SCRNAFlow（单细胞 RNA）

**规则链**：

```text
02.file_convert_md5 → prepare_scrna_fastq_links
→ 03.QC → 04.Contamination → 05.merge_qc_report
→ 06.count (Cell Ranger / dnbc4tools) → 07.deliver → 08.Report
```

**核心工具**：Cell Ranger、dnbc4tools

**样本表**：

| 必填列 | 可选列 |
|--------|--------|
| `sample, sample_name, group, platform` | `fastq_id, chemistry, lanes, expect_cells` |

`platform` 取值：`10x` / `cellranger` / `dnb` / `dnbc4` / `dnbc4tools`

**模块开关**：`count`

**特殊逻辑**：
- 不做 read clean，原始 FASTQ 直接交给 count backend；因此 count 规则必须显式 input `md5_check.tsv`（§4.3-1）
- `prepare_scrna_fastq_links` 创建平台专用链接：
  - Cell Ranger: bcl2fastq 命名 (`{sample}_S1_L001_R1_001.fastq.gz`)
  - DNB: cDNA/oligo 双目录结构
- 输出统一矩阵：`03.count/matrix/{sample}/filtered_feature_bc_matrix/`
- 生成 `scrna_fastq_manifest.json`（平台专用 manifest，独立于 `raw_data_md5.json`；是 AnalysisTargets 的第三个固定目标——本流程内）
- 容器支持：Cell Ranger / dnbc4tools 通过 `container_tool_command()` 调用
- DNB oligo reads 的 QC 覆盖（fastq_screen / multiqc 合并报告）应补齐，或在 README 明确为设计取舍（当前 oligo 只被 manifest 版 FastQC 覆盖，已验证）
- 容器内路径计算：`params` 中的 `os.path.abspath` 在 snakemake 主进程启动目录解析而非 `config["workflow"]`，路径拼接必须以 `os.path.abspath(config["workflow"])` 为基（SCRNAFlow 06.count 的 `--fastqs` 曾因此指向不存在路径，已验证）

### 7.3 BTCRFlow（Bulk BCR/TCR）

**规则链**：

```text
02.file_convert_md5 → 03.QC → 04.trimming (cutadapt -U 30)
→ 05.MiXCR analyze → 06.VDJtools diversity → 07.deliver → 08.Report
```

**核心工具**：MiXCR v4、VDJtools 1.2.1、cutadapt

**样本表**：

| 必填列 | 可选列 |
|--------|--------|
| `sample, sample_name, group, platform, path` | `index` |

`platform` 取值：`bcr` / `tcr`

**模块开关**：`trimming, mixcr, vdj_analysis`

**特殊逻辑**：
- BCR: preset `takara-human-rna-bcr-umi-smarter`
- TCR: preset `generic-amplicon`
- Clontech SMARTer 协议：`-U 30` 硬切 5' 端
- VDJtools: downsample + diversity 统计

### 7.4 ATACFlow（染色质可及性）

**规则链**：

```text
02.file_convert_md5 → 03.QC → 04.Contamination → 05.fastp clean
→ 06.Bowtie2 mapping → dedup → filter → Tn5 shift → BigWig → TSS
→ 07.MACS2/MACS3 peak calling → HOMER annotation → consensus peaks → count matrix
→ 08.MergeMACS3 (pooled analysis)
→ 09.ATAC QC (ataqv + MultiQC)
→ 10.DEG/Enrichment → 11.TOBIAS motifs
→ 12.deliver → 13.Report
```

**核心工具**：Bowtie2、MACS2/MACS3、HOMER、DESeq2、TOBIAS、ataqv、deepTools

**样本表**：

| 必填列 | 可选列 |
|--------|--------|
| `sample, sample_name, group` | `condition, batch` |

**模块开关**：`mapping, peak_calling, motif_analysis, consensus_peaks, diff_peaks, atac_qc`

**特殊逻辑**：
- Peak caller 选择：通过 `config["peak_caller"]` 配置（`macs2` / `macs3` / `both`），默认 `macs3`；选择器必须真实接线（当前 MACS2+MACS3 无条件双跑、Genrich 为死代码、IDR 已禁用但配置注释仍宣称支持——均为已验证的对齐项）
- Tn5 shift: +4/-5 correction via deepTools alignmentSieve
- Blacklist filtering: 按 `Genome_Version` 从 reference.yaml 的 `blacklists` 键获取；未配置的基因组自动跳过并 warning。路线图项：常见物种 ENCODE blacklist 自动集成
- Pooled analysis: 仅当所有 group 有 >= 2 个重复时启用（`merge_group` 检测）
- Subrules 机制：`rules/subrules/mapping/` 下可替换 aligner（bowtie2/chromap）；未接线的分支（chromap 当前为注释死代码）要么恢复为 config-driven 条件 include，要么删除
- `check_reference_paths` 必须覆盖 ATAC 实际消费的键：`chromap_index / tss_bed / go_annotation / autosomes / blacklists / gene_gtf`（当前只校验 RNA 遗留的 `rsem_index_dir` 等，已验证）

### 7.5 WGSFlow（全基因组，规划中）

**规则链**：

```text
02.file_convert_md5 → 03.QC → 04.trimming → 05.BWA mapping
→ 06.dedup/BQSR → 07.GATK variant → 08.CNV/SV → 09.deliver → 10.Report
```

---

## 8. 样本表约定（通用）

### 8.1 通用必填列

```csv
sample,sample_name,group
```

- `sample`: 样本唯一标识符（用于文件命名，不含特殊字符）
- `sample_name`: 显示名称（可用于报告）
- `group`: 分组标识（用于 DEG/对比分析）

### 8.2 组学扩展列

| 流程 | 额外必填列 | 可选列 |
|------|------------|--------|
| RNAFlow | — | `bam, condition, batch` |
| SCRNAFlow | `platform` | `fastq_id, chemistry, lanes, expect_cells` |
| BTCRFlow | `platform, path` | `index` |
| ATACFlow | — | `condition, batch` |
| WGSFlow | — | `condition, batch` |

### 8.3 路径列多 lane 支持

路径列支持多个 lane 用逗号、分号或竖线分隔：

```csv
sample,path
SampleA,/data/lane1/SampleA,/data/lane2/SampleA
```

### 8.4 load_samples() 标准行为

```python
def load_samples(config, required_columns, index_col="sample"):
    """
    1. 读取 config["sample_csv"]
    2. 验证 required_columns 全部存在
    3. 检查 sample 列唯一性
    4. 构建 samples dict: {sample_id: {col: value, ...}}
    5. 组学专用后处理（如 RNAFlow 自动生成 bam 路径）
    6. 对样本定位失败的样本 fail-fast 并列出缺失样本名
    """
```

### 8.5 对比表命名（强制）

对比名统一为 `Treat_vs_Control`（业界惯例，效应方向 = Treat 相对 Control）。RNAFlow 的 `id_convert.py` 曾生成 `Control_vs_Treat`（已验证），属于必须修正或显著标注方向含义的对齐项。

---

## 9. 资源管理（通用）

### 9.1 resource_manager.py 标准接口

```python
def rule_resource(config, profile_name, skip_queue_on_local=True):
    """
    从 cluster_config.yaml 的 resource_profiles 中获取命名 profile。

    Args:
        config: Snakemake config
        profile_name: "low_resource" | "medium_resource" | "high_resource" | "very_high_resource"
        skip_queue_on_local: local 模式下移除 queue_type 字段

    Returns:
        dict: {"threads": N, "mem_mb": N, "runtime": N, ...}
    """
```

规范：

- local 模式只移除队列类键（`queue_type`），**必须保留 threads**（ATACFlow 曾把 threads 一并 pop，已验证）。
- cluster 模式 `queue_type → queue` 映射依赖 `cluster_config.yaml` 的 `clusters:` 段；该段缺失时 fail-fast（§3.4）。
- 资源 profile 的 threads/mem 必须与 rule 实际使用一致（申请 ≥ 使用）：SCRNAFlow 的 cellranger 曾申请 32 线程/128G 而只用 16/64（已验证）；rule 内禁止硬编码 `threads: 20` 这类字面量（ATACFlow 06.mapping 已验证）。

### 9.2 规则中使用

```python
rule STAR_mapping:
    resources: **rule_resource(config, "very_high_resource")
    threads: rule_resource(config, "very_high_resource")["threads"]
```

### 9.3 库代码错误处理（强制）

- 库代码（rules/utils/*.py）禁止 `sys.exit`；统一抛自定义异常（`ConfigError` / `ReferenceError` / `SampleSheetError`），由 snakefile 顶层捕获后友好退出（RNAFlow 曾大量 sys.exit，已验证）。
- 参考块直接索引（`config["STAR_index"][gv]`）前必须由 `check_reference_paths` 兜底，禁止裸 KeyError 穿透到 rule 执行期（SCRNAFlow 已验证）。

---

## 10. 容器化策略（通用）

### 10.1 分层原则

| 层级 | 工具 | 管理方式 |
|------|------|----------|
| 通用层 | seq_preprocessor, json_md5_verifier | 仓库内编译二进制 |
| QC 层 | FastQC, MultiQC, fastq_screen, fastp, cutadapt | Conda env |
| 分析层（可 conda） | STAR, RSEM, MiXCR, Bowtie2, GATK, MACS2/3 | Conda env |
| 分析层（不可 conda） | Cell Ranger, dnbc4tools | 容器 / bind mount |
| 报告层 | bioreport | Docker/Apptainer 容器 |
| 参考基因组 | 所有 index | Bind mount，不打入镜像 |

### 10.2 容器配置标准结构

```yaml
container:
  enabled: false
  engine: docker              # docker | apptainer | singularity
  images:
    cellranger: cellranger:10.1.0
    dnbc4tools: dnbc4tools:3.1
    report: bioreport:vX.Y.Z   # 固定 tag，禁止 latest
  bind:
    - /data:/data
    - /tmp:/tmp
  extra_args: ""
```

### 10.3 container_tool_command() 标准接口

```python
def container_tool_command(config, image_key, inner_cmd, extra_binds=None):
    """
    构建容器化命令。container.enabled=False 时直接返回 inner_cmd。

    支持 docker / apptainer / singularity 三种引擎。
    自动追加 config["container"]["bind"] + extra_binds。
    """
```

### 10.4 注意事项

- 参考基因组体积大、更新频繁，永远通过 bind mount 提供
- Cell Ranger 有许可限制，不放入公共镜像仓库
- 容器内路径必须和配置路径一致（通过 bind mount 保证）
- `logs/`、输出目录必须在容器内可写
- 禁止全局 `container:` 指令（RNAFlow 曾用 `container: "docker://continuumio/miniconda3:latest"`，tag 不固定破坏可复现性，已验证）；容器按 rule/工具配置驱动
- 集群模式下临时目录用 rule 局部 `TMPDIR`，禁止 `mktemp /tmp/固定前缀`（ATACFlow 07.MACS2/3 曾有并发碰撞风险，已验证）
- 容器镜像若依赖手工放置的 tarball，`containers/` 必须附获取脚本与校验和，保证可重建审计（SCRNAFlow 已验证缺失）

---

## 11. Conda 环境管理（通用）

### 11.1 命名规范

- 所有环境文件统一使用 `.yaml` 后缀（禁止 `.yml`）
- 命名格式：`{tool_name}.yaml`（如 `star.yaml`, `macs3.yaml`），全小写
- 通用 Python 环境：`py3.12.yaml`

### 11.2 环境文件标准结构

```yaml
name: star_env
channels:
  - bioconda
  - conda-forge
dependencies:
  - star=2.7.11b
  - samtools=1.20
```

### 11.3 版本固定

- 所有工具**必须**固定版本号（`tool=x.y.z`），禁止 `latest` 或不带版本的依赖
- 只 pin 主工具版本，禁止 build-string 级 pin（`=h5eee18b_0`）与混用镜像 channel（SCRNAFlow fastqc.yaml 已验证）
- rule 声明的 conda env 必须真实存在于 `envs/`；`envs/` 中无引用的环境必须删除（ATACFlow 曾残留 16 个 RNAFlow 拷贝的未引用环境，已验证）

---

## 12. 验证与调试（通用）

### 12.1 标准验证命令

```bash
# Dry-run（验证 DAG 完整性）
snakemake -s snakefile -n --cores 1 \
  --config analysisyaml=/path/to/config.yaml

# 打印目标列表（调试 DataDeliver）
snakemake -s snakefile -n --cores 1 \
  --config analysisyaml=/path/to/config.yaml print_target=true

# 只运行到 MD5 校验
snakemake -s snakefile --cores 4 \
  --config analysisyaml=/path/to/config.yaml \
  01.qc/md5_check.tsv

# 完整运行
snakemake -s snakefile --cores 32 --use-conda --conda-frontend mamba \
  --config analysisyaml=/path/to/config.yaml

# DAG 可视化
snakemake -s snakefile --dag --config analysisyaml=/path/to/config.yaml | dot -Tsvg > dag.svg
```

### 12.2 测试要求（强制）

- 每个流程仓库必须有一条最小 dry-run CI：`snakemake -n --config analysisyaml=examples/analysisyaml.example.yaml`（配微型测试数据或 stub），验证 DAG 可构建、`rule all` 目标集非空且含 deliver/report。
- 每个 datadeliver 收集器函数应有单元测试：给定开关组合断言目标列表；收集器返回路径与 rule output 的一致性由 CI dry-run 校验。
- 通用层（01–03、utils、deliver、report）任何改动，必须对全部 Flow 流程跑 dry-run 回归。

### 12.3 新流程开发检查清单

- [ ] `README.md` 存在且最前面（第一行）为 Flow Framework 来源声明（§1.3）
- [ ] `snakefile` 存在且遵循 8 步初始化序列
- [ ] `schema/config.schema.yaml` 存在、含 `required`、与本流程真实配置结构对齐，且在 snakefile 中调用
- [ ] `rules/utils/__init__.py` 存在
- [ ] `rules/utils/common.py` 实现 `AnalysisTargets()` + `DataDeliver()` 分层，且满足 §5.6 硬约束
- [ ] `MODULE_DEPENDENCIES` 定义完整
- [ ] `01.qc/md5_check.tsv` 作为所有 FASTQ 消费入口 rule 的显式 input gate；FASTQ 一律进 input 不进 params
- [ ] `config/config.yaml` 写齐全部模块开关默认值 + `pipeline_version`
- [ ] `envs/` 全部 `.yaml` 后缀、无未引用环境
- [ ] `.gitmodules` 包含 src、report（、container_env）
- [ ] `Compile_release/`、`target/`、`__pycache__/` 在 `.gitignore` 中；`config/*.csv` 模板有例外
- [ ] `examples/analysisyaml.example.yaml` 脱敏且 dry-run 通过
- [ ] 交付规则生成 manifest + md5 + log，默认 copy 模式
- [ ] 报告规则至少生成 `project_summary.json`，且 deliver/report 目标在 `rule all` 中

---

## 13. 维护原则

### 13.1 通用层维护

- `raw_data_md5.json` 是 MD5 校验层产物，下游业务不得直接依赖它作为数据源
- 改 rule `output` 时**必须**同步改 `rules/utils/datadeliver.py` 对应收集器
- 改样本表字段时**必须**同步检查 `id_convert.py`、相关 scripts、`tools.py`
- `seq_preprocessor` / `json_md5_verifier` 升级时，所有 Flow 流程同步更新 submodule
- 文档以当前实现为准；通用规范不应覆盖各流程的实际边界
- 通用层改动必须三家同步评审，禁止单家私改后漂移；中期目标是把 `rules/utils` 收敛为共享包（如 `flow-utils`），各流程 pin 版本引用，落地前以"逐字一致 + dry-run 回归"过渡

### 13.2 组学层维护

- 新增组学流程时，复用 01-03 通用规则，只编写组学专用 rule 文件
- 组学专用 manifest（如 `scrna_fastq_manifest.json`）不要和 `raw_data_md5.json` 耦合
- 参考基因组 `index_keys` 按流程独立维护，不要交叉引入
- 组学专用函数放 `tools.py`，通用函数放 `common.py`

### 13.3 工具链维护

- JZ_Tools submodule 统一追踪 `main` 分支
- 编译产物不提交到版本控制（`.gitignore`）
- Rust 工具升级后需重新编译并验证所有 Flow 流程的 02 步 dry-run
- 交付工具重命名为 `flow-deliver`，消除 RNAFlow 品牌耦合

### 13.4 代码质量规范

- 不保留死代码（永远返回 False/空的函数、注释掉的大段分支、废弃的 Python fallback、无引用的遗留脚本）
- 不保留未使用的配置项；README/注释宣称的能力必须与代码一致（IDR、Genrich、chromap 等未接线功能不得出现在文档宣称中）
- 注释使用英文，变量/函数命名使用英文 snake_case
- 每个 `datadeliver.py` 收集器函数必须有对应的 rule output 验证
- `resource_manager.py` 的 `skip_queue_on_local` 默认为 True，无需每次传参
- 版本号单一来源 `pipeline_version`；README 不另写版本号（ATACFlow 曾三处版本号不一致，已验证）

### 13.5 工作流监控推送（snakemake_logger_plugin_rich_loguru v0.2.0+）

从 **v0.2.0** 开始，`snakemake_logger_plugin_rich_loguru` 插件新增对 **OmicHub** 平台的原生工作流监控推送能力，同时保留原有 Loki/Grafana 兼容能力。所有 Flow 家族流程在生产环境运行时，必须配置监控推送以实现 OmicHub 平台与 Flow 家族的融合。

**OmicHub 模式相比 Loki 兼容模式的优势**：

- 原生事件结构（`omichub.workflow_event.v1`），便于平台直接解析任务状态
- 支持 `task_id` / `flow_id` / `user_id` 等业务字段，实现精准的任务归属与权限校验
- 支持 Bearer Token 鉴权、HMAC-SHA256 签名、AES-256-GCM payload 加密

#### 配置参数

| 参数名 | 环境变量 | 描述 |
| :--- | :--- | :--- |
| `omichub_monitor_url` | `SNAKEMAKE_OMICHUB_MONITOR_URL` | OmicHub 原生事件接收端点 |
| `omichub_monitor_token` | `SNAKEMAKE_OMICHUB_MONITOR_TOKEN` | Bearer Token 鉴权凭据 |
| `omichub_task_id` | `SNAKEMAKE_OMICHUB_TASK_ID` | 任务 ID（建议等于 `project_name`） |
| `omichub_flow_id` | `SNAKEMAKE_OMICHUB_FLOW_ID` | 流程 ID，如 `rna_seq`、`atac_seq` |
| `omichub_user_id` | `SNAKEMAKE_OMICHUB_USER_ID` | 任务归属用户 ID |
| `omichub_monitor_sign_requests` | `SNAKEMAKE_OMICHUB_MONITOR_SIGN_REQUESTS` | 是否启用 HMAC 签名（默认 `false`） |
| `omichub_monitor_signing_key` | `SNAKEMAKE_OMICHUB_MONITOR_SIGNING_KEY` | HMAC 签名密钥 |
| `omichub_monitor_encrypt_payload` | `SNAKEMAKE_OMICHUB_MONITOR_ENCRYPT_PAYLOAD` | 是否启用 AES-256-GCM 加密（默认 `false`） |
| `omichub_monitor_encryption_key` | `SNAKEMAKE_OMICHUB_MONITOR_ENCRYPTION_KEY` | Base64 编码的 32 字节 AES 密钥 |
| `omichub_monitor_tls_verify` | `SNAKEMAKE_OMICHUB_MONITOR_TLS_VERIFY` | 是否校验 HTTPS 证书（默认 `true`） |
| `omichub_monitor_timeout` | `SNAKEMAKE_OMICHUB_MONITOR_TIMEOUT` | 单次请求超时秒数（默认 `5`） |
| `omichub_monitor_queue_size` | `SNAKEMAKE_OMICHUB_MONITOR_QUEUE_SIZE` | 事件队列大小（默认 `10000`） |
| `omichub_monitor_retry_count` | `SNAKEMAKE_OMICHUB_MONITOR_RETRY_COUNT` | 网络错误/5xx 重试次数（默认 `3`） |
| `omichub_monitor_retry_backoff` | `SNAKEMAKE_OMICHUB_MONITOR_RETRY_BACKOFF` | 重试退避基数秒（默认 `0.5`） |

#### 配置文件示例（monitor_config.yaml）

在工作流根目录下创建 `monitor_config.yaml`：

```yaml
# Loki 兼容端点（第一期兼容方案，可选）
loki_url: "http://web:8000/api/v1/workflow-monitor"
project_name: "<task_id>"

# OmicHub 原生事件端点（推荐）
omichub_monitor_url: "https://omichub.example.edu/api/v1/workflow-monitor/events"
omichub_monitor_token: "${OMICHUB_WORKFLOW_MONITOR_TOKEN}"
omichub_task_id: "<task_id>"
omichub_flow_id: "rna_seq"
omichub_user_id: "<user_id>"

# 生产环境安全加固
omichub_monitor_sign_requests: true
omichub_monitor_signing_key: "${OMICHUB_WORKFLOW_MONITOR_SIGNING_KEY}"
omichub_monitor_encrypt_payload: false
omichub_monitor_encryption_key: "${OMICHUB_WORKFLOW_MONITOR_ENCRYPTION_KEY}"
```

#### 运行方式

```bash
snakemake \
  -s Snakefile \
  --cores 8 \
  --logger rich-loguru \
  --config monitor_conf=monitor_config.yaml
```

> **project.yaml 集成**：OmicHub 平台下发任务时，通过 `project.yaml`（即 analysisyaml）注入 `monitor_conf` 路径与相关环境变量，实现平台与 Flow 家族的无缝融合。`omichub_task_id` 建议等于 `project_name`，`omichub_flow_id` 对应流程标识（`rna_seq`、`atac_seq`、`scrna_seq`、`btcr_seq`、`wgs`）。

---

## 14. 各流程 02 步后续对比

| 流程 | 02 步输出 | 后续业务 manifest | 核心分析入口 |
|------|-----------|-------------------|--------------|
| RNAFlow | `link_dir/{sample}/{sample}_R1/R2.fq.gz` | 无（直接用 link_dir） | STAR mapping |
| SCRNAFlow | `link_dir/` + `scrna_fastq_manifest.json` | `scrna_fastq_manifest.json` | Cell Ranger / dnbc4tools |
| BTCRFlow | `link_dir/{sample}/{sample}_R1/R2.fq.gz` | 无（直接用 link_dir） | MiXCR analyze |
| ATACFlow | `link_dir/{sample}/{sample}_R1/R2.fq.gz` | 无（直接用 link_dir） | Bowtie2 mapping |
| WGSFlow | `link_dir/{sample}/{sample}_R1/R2.fq.gz` | 无（直接用 link_dir） | BWA mapping |

所有流程共享同一套 `seq_preprocessor` + `json_md5_verifier` 二进制和 `raw_data_md5.json` 格式，仅下游业务 manifest 和分析入口不同。

---

## 15. 已知待优化项（对齐清单）

以下条目来自对三家仓库的逐文件代码审查。**已验证** = 审查中确认代码现状如此；**待复核** = 建议修复前用 dry-run / grep 再确认。

### 15.1 P0 — 功能级 bug（先于一切架构对齐修复）

| 流程 | 问题 | 状态 |
|------|------|------|
| RNAFlow | `deg` 开关失效：代码读 `DEG` 键（common.py），文档/schema 写 `deg`，用户无法关闭 DEG | 已验证 |
| RNAFlow | GO obo 相对路径不被 resolve（reference_update 只处理版本条目），workdir 重定向后富集分析必挂（10.DEG_Enrichments.smk） | 已验证 |
| RNAFlow | `fastq_screen: false` 无效：datadeliver 无条件追加 fastq_screen 目标 | 已验证 |
| RNAFlow | 缺 `deliver` 独立开关；`report: false` 连带关闭交付 | 已验证 |
| ATACFlow | **deliver/report 断路**：`rule all` 只含 AnalysisTargets，deliver/report 目标在无默认调用的 `ReportData()` 中，默认运行不产出交付与报告 | 已验证 |
| ATACFlow | `motif_analysis()` 收集器为空壳，motif 开关无效 | 已验证 |
| ATACFlow | `id_convert.py` 自动推导 bam 路径 `02.mapping/Bowtie2/...` 与实际输出 `02.mapping/Aligner/...` 不一致 | 已验证 |
| ATACFlow | `get_diff_analysis_input` 返回 `04.consensus/single/...` 与实际目录 `single_macs2/single_macs3` 不符 | 已验证 |
| ATACFlow | fastq_screen 开关泄漏：datadeliver 与 05 merge_qc_report 无条件引用 fastq_screen 产物 | 已验证 |
| SCRNAFlow | `06.count.smk` `params.fastq_dir = os.path.abspath(...)` 在启动目录而非 `config["workflow"]` 解析，非 workflow 目录启动则 `--fastqs` 指向不存在路径 | 已验证 |
| SCRNAFlow | `04.Contamination_check.smk` fastq_screen 的 FASTQ 只放 `params` 不进 `input`，存在 DAG 竞态 | 已验证 |
| SCRNAFlow | count / report 规则不显式依赖 `md5_check.tsv` 与分析产物，门控与报告时序靠巧合 | 已验证 |

### 15.2 P1 — 架构对齐（对应正文强制条款）

| 流程 | 问题 | 对应条款 |
|------|------|----------|
| 三家 | schema 重写：加顶层 `required`；ATACFlow 替换 STAR/RSEM 遗留结构；RNAFlow 修 `ploidy`/`ploidy_setting` 不匹配 | §3.5 |
| 三家 | `resolve_reference_paths` / `check_reference_paths` 对齐：只校验当前基因组、补全实际消费键、非版本子键（GO/blacklists）也解析 | §2.4 / §7.1 |
| 三家 | DataDeliver 纯函数化（去 config 改写、`time.sleep`）；`rule all` 唯一调用点；MODULE_DEPENDENCIES 自动启用落地 | §5 |
| 三家 | 删除仓库根游离项目级 `config.yaml`（含真实路径与内网 loki IP）→ 移入 `examples/analysisyaml.example.yaml` | §1.3 |
| RNAFlow | 删除全局 `container:` 指令；报告 docker 调用改为引擎配置驱动 + 集群降级路径 | §10.4 / §6.5 |
| RNAFlow | 13.deliver/14.Report 复用 snakefile 层目标列表（当前二次调用 `DataDeliver(config)` 不传 samples） | §5.6-2 |
| ATACFlow | peak caller 配置化（`peak_caller: macs2/macs3/both`）；删除 Genrich 死代码与 IDR 虚假宣称 | §7.4 |
| ATACFlow | chromap 分支恢复为 config-driven 条件 include 或删除 | §7.4 |
| ATACFlow | 清理 RNA 残留：16 个未引用 envs、schema、报告模板（merge_rsem_tpm/QualiMap/bioreportrna）、`judge_*` 死代码、`rnaflow-cli` 更名 | §11.3 / §6.5 / §13.3 |
| SCRNAFlow | 交付改 copy 模式（当前 symlink 悬空风险）；`--targets {input}` 加引号；目录产物计入 manifest | §6.4 |
| SCRNAFlow | 统一 `rules/utils/*.py` 内部 import 根为 `utils.*`（当前 datadeliver 经 rules.utils 导入即失败） | §2.2 |
| 三家 | 交付工具统一为 `flow-deliver`（重命名 rnaflow-cli，SCRNAFlow Python 脚本替换） | §6.4 |
| 三家 | `cluster_config.yaml` 补 `clusters:` 映射段；queue 缺失 fail-fast | §3.4 |
| RNAFlow | submodule 落后 origin/main 9 commit；report 子模块 16 文件未提交；logger 插件文档 0.1.4 vs 实际 0.1.6 | §13.3 |

### 15.3 P2 — 清理与一致性

| 流程 | 问题 |
|------|------|
| RNAFlow | 对比名 `Control_vs_Treat` → `Treat_vs_Control`（§8.5）；`envs/star.yml`→`.yaml`；very_high_resource mem 倒置；rule 文件大小写统一；`r1_suffix/r2_suffix` 死配置接通；顶层 `md5` 死键删除；`benchmarks/benchmark` 单复数统一；README 结构清单与实际不符（04/07/11/15 编号、scripts/ 等） |
| ATACFlow | 两个同序号 `07.MACS2.smk`/`07.MACS3.smk` 重编号；版本号三处不一致归一到 `pipeline_version`；`reference_update.py` 的 `star_index_config` 变量更名；`judge_star_index` 的 `" Genome"` 前导空格；`.gitignore` 对 `config/*.csv`、`data/*.fa` 加例外；`rules/utils/__pycache__/*.pyc` 被 git 跟踪需 `git rm --cached`；06.mapping 硬编码 threads 改走 profile；`config/blacklists_chrM_Pt.yaml` 无引用需删除或接线 |
| SCRNAFlow | 删除遗留脚本 `prepare_scrna_fastqs.py`、`check_fastq_manifest.py`；删除死代码（`judge_*`、空 `ReportData()`、`_active_platforms`）；平台常量三处重复收敛；02 步 `--log-file` 与 `log:` 双写修复；05 merge_qc 递归扫描改精确收集；cellranger 资源申请与实际使用对齐；envs 清理（cellranger/dnbc4tools/py3.12 无引用；fastqc.yaml build-string pin；multiqc.yaml 臃肿）；containers/ 附 tarball 获取脚本与校验和；`docs/Architecture.md` 整体重写 |
| 通用 | JZ_Tools 移除 `check_md5.py` 废弃 fallback；清理 submodule `target/` 构建缓存；`Compile_release/` 入所有流程 `.gitignore`；预编译二进制迁移 GitHub Releases（P3） |

### 15.4 修复顺序建议

1. **§15.1 P0 全部**（功能 bug，改动小、影响直接）
2. **§15.2 P1 中的三家共通项**（schema、reference resolve、DataDeliver 纯函数化、根目录 config.yaml 清理）——做完这一轮，三家通用层即满足本文档强制条款
3. **§15.2 各流程专项**（ATACFlow 的 RNA 残留清理量最大，单独排期）
4. **§15.3 P2** 随日常开发顺带清理
5. 每完成一项，在对应仓库 dry-run 验证（§12.2），并回本表勾销


---

## 16. 快速接入指南：将现有分析脚本转换为 Flow 家族流程

本节是**操作指南**（how-to），与前述规范条款（what）互补。目标：将一个已有的分析脚本/简单 Snakemake 流程，在最短时间内转换为符合本规范的 Flow 家族成员，并通过 dry-run 验证。

### 16.1 转换总览（5 阶段）

```text
阶段 1: 脚手架搭建（~10 min）
  └─ 创建目录结构 + 复制通用层文件
阶段 2: 配置适配（~20 min）
  └─ 编写 config 四件套 + schema + analysisyaml 示例
阶段 3: 组学专用规则编写（~1-4 h，视复杂度）
  └─ 将现有脚本逻辑拆分为 04+.smk 规则
阶段 4: 目标生成系统接线（~30 min）
  └─ 实现 MODULE_DEPENDENCIES + datadeliver 收集器 + AnalysisTargets
阶段 5: 验证与收尾（~20 min）
  └─ dry-run + §12.3 检查清单 + monitor_config.yaml
```

### 16.2 文件三分类表

| 类别 | 文件 | 操作 |
|------|------|------|
| **直接复制**（通用层，所有 Flow 逐字一致） | `rules/01.common.smk` | 从任一已生产 Flow 复制 |
| | `rules/02.file_convert_md5.smk` | 同上 |
| | `rules/03.short_read_qc.smk` | 同上 |
| | `rules/utils/__init__.py` | 空文件 |
| | `rules/utils/id_convert.py` | 复制（通用样本表解析） |
| | `rules/utils/validate.py` | 复制（通用配置验证） |
| | `rules/utils/reference_update.py` | 复制（通用参考路径解析） |
| | `rules/utils/resource_manager.py` | 复制（通用资源 profile） |
| | `rules/N-1.deliver.smk` | 复制（通用交付接口） |
| | `rules/N.Report.smk` | 复制最小实现（`project_summary.json`） |
| **适配改写**（改配置值/键名，结构不变） | `config/config.yaml` | 改 `pipeline_version`、模块开关、软件路径 |
| | `config/reference.yaml` | 改为本流程的 index 键（§2.4） |
| | `config/run_parameter.yaml` | 改线程/内存/工具参数 |
| | `config/cluster_config.yaml` | 通常可直接复制 |
| | `schema/config.schema.yaml` | 按本流程配置结构重写 |
| | `rules/utils/common.py` | 改 `MODULE_DEPENDENCIES` + `MODULE_COLLECTORS` |
| | `rules/utils/datadeliver.py` | 改收集器函数（按本流程模块） |
| | `rules/utils/tools.py` | 改为本流程专用命令行构建 |
| | `snakefile` | 复制 8 步模板，改 `index_keys`、`required_columns`、include 列表 |
| | `examples/analysisyaml.example.yaml` | 按本流程配置写脱敏示例 |
| | `monitor_config.yaml` | 改 `omichub_flow_id` 为本流程标识 |
| **从零编写**（组学专用） | `rules/04.*.smk` ~ `rules/N-2.*.smk` | 将现有脚本逻辑转为 Snakemake rule |
| | `envs/<tool>.yaml` | 每个新工具一个 Conda 环境 |
| | `scripts/` | 组学专用 R/Python 脚本 |
| | `config/samples.csv` | 按 §8 定义本流程样本表列 |

### 16.3 阶段 1：脚手架搭建

```bash
# 1. 创建仓库
mkdir <X>Flow && cd <X>Flow && git init

# 2. 创建目录骨架
mkdir -p config examples schema rules/utils scripts envs docs

# 3. 添加 Git submodules
git submodule add git@github.com:xsx123123/JZ_Tools.git src
git submodule add git@github.com:xsx123123/bioreport.git report
# 可选：git submodule add git@github.com:xsx123123/Flowcontainer.git container_env

# 4. 从参考流程（推荐 RNAFlow）复制通用层
cp -r /path/to/RNAFlow/rules/01.common.smk rules/
cp -r /path/to/RNAFlow/rules/02.file_convert_md5.smk rules/
cp -r /path/to/RNAFlow/rules/03.short_read_qc.smk rules/
cp /path/to/RNAFlow/rules/utils/__init__.py rules/utils/
cp /path/to/RNAFlow/rules/utils/id_convert.py rules/utils/
cp /path/to/RNAFlow/rules/utils/validate.py rules/utils/
cp /path/to/RNAFlow/rules/utils/reference_update.py rules/utils/
cp /path/to/RNAFlow/rules/utils/resource_manager.py rules/utils/

# 5. 创建 .gitignore
cat > .gitignore << 'GI'
__pycache__/
*.py[cod]
*.egg-info/
src/src/md5/Compile_release/
src/**/target/
.snakemake/
GI

# 6. 编译 Rust 工具（或从 CI 获取）
cd src/src/md5/seq_preprocessor && cargo build --release && cd -
cd src/src/md5/json_md5_verifier && cargo build --release && cd -
mkdir -p src/src/md5/Compile_release/{seq_preprocessor_x86_64/release,json_md5_verifier_x86_64/release}
cp src/src/md5/seq_preprocessor/target/release/seq_preprocessor \
   src/src/md5/Compile_release/seq_preprocessor_x86_64/release/
cp src/src/md5/json_md5_verifier/target/release/json_md5_verifier \
   src/src/md5/Compile_release/json_md5_verifier_x86_64/release/

# 7. 创建 README.md（最前面必须为来源声明，强制）
cat > README.md << 'RD'
本分析流程是基于 Flow Framework — 多组学通用流程架构规范 v2.0 继续创建，关于该规范更加详细的细节见: https://github.com/xsx123123/FlowFrame

# <X>Flow
RD
```

### 16.4 阶段 2：配置适配

**决策点**：你的流程需要哪些参考基因组/index？

| 你的流程使用… | index_keys 需要包含… | reference.yaml 需要配置… |
|--------------|---------------------|------------------------|
| STAR 比对 | `STAR_index` | STAR index 目录路径 |
| Bowtie2 比对 | `Bowtie2_index`, `genome_fasta` | bt2 index 前缀 + fasta |
| BWA 比对 | `BWA_index`, `genome_fasta`, `dbsnp` | bwa index + fasta + 已知变异 |
| Cell Ranger | `CellRanger_reference` | Cell Ranger ref 目录 |
| 无参考（de novo） | `[]`（空） | 无需 reference.yaml 版本条目 |
| 需要基因注释 | `gene_gtf` / `gene_bed` | GTF/BED 文件路径 |
| 需要功能富集 | `go_annotation` / `deg_enrich_wrapper` | GO obo + 注释文件 |

**最小 config/config.yaml 模板**（复制后改值）：

```yaml
software:
  seq_preprocessor: ../src/src/md5/Compile_release/seq_preprocessor_x86_64/release/seq_preprocessor
  json_md5_verifier: ../src/src/md5/Compile_release/json_md5_verifier_x86_64/release/json_md5_verifier
  fastqc: fastqc
  multiqc: multiqc
  # ← 在此追加你的组学工具

raw_data:
  md5: md5.txt
  library_type: short-read    # 改为你的数据类型
  sample_sheet_rename: false

convert_md5: link_dir
r1_suffix: _R1.fq.gz
r2_suffix: _R2.fq.gz

pipeline_version: "<X>Flow v1.0.0"
log_level: INFO
print_target: false

# ─── 模块开关（全部显式写出）──────────────────────────
only_qc: false
qc_clean: true
deliver: true
report: true
# ← 在此追加组学专用开关，如：
# mapping: true
# peak_calling: true
```

### 16.5 阶段 3：组学专用规则编写

**转换策略**：将现有脚本按功能拆分为独立 rule 文件。

```text
现有脚本                    →  Flow rule 文件
─────────────────────────────────────────────────
01_trim.sh                 →  rules/04.trimming.smk
02_align.sh                →  rules/05.mapping.smk
03_quantify.sh             →  rules/06.count.smk
04_deg.R                   →  rules/07.deg.smk + scripts/deg_analysis.R
05_enrichment.py           →  rules/08.enrichment.smk + scripts/enrichment.py
```

**每个 rule 文件的标准结构**：

```python
# rules/05.mapping.smk
from utils.tools import build_mapping_cmd  # 组学专用命令构建

rule align_reads:
    input:
        gate="01.qc/md5_check.tsv",  # ← 必须挂门控！
        r1="00.raw_data/link_dir/{sample}/{sample}_R1.fq.gz",
        r2="00.raw_data/link_dir/{sample}/{sample}_R2.fq.gz",
    output:
        bam="02.mapping/<aligner>/{sample}.sort.bam",
        bai="02.mapping/<aligner>/{sample}.sort.bam.bai",
    threads: rule_resource(config, "very_high_resource")["threads"]
    resources: **rule_resource(config, "very_high_resource")
    log: "logs/05.mapping/{sample}.log"
    conda: "../envs/<aligner>.yaml"
    shell:
        "{build_mapping_cmd(wildcards, config, input, output, threads)}"
        " > {log} 2>&1"
```

**关键检查点**（写每个 rule 时对照）：

- [ ] `input` 包含 `01.qc/md5_check.tsv`（如果是直接消费 FASTQ 的首个规则）
- [ ] FASTQ 文件在 `input` 而非 `params`
- [ ] `output` 路径与 `datadeliver.py` 收集器逐字一致
- [ ] 线程/内存走 `rule_resource()`，不硬编码
- [ ] `conda:` 指向 `envs/` 中真实存在的 `.yaml`
- [ ] `log:` 路径遵循 `logs/NN.module_name/` 编号约定

### 16.6 阶段 4：目标生成系统接线

**Step 1**：定义 `MODULE_DEPENDENCIES`（`rules/utils/common.py`）

```python
# 示例：你的流程有 trimming → mapping → count → deg 四步
MODULE_DEPENDENCIES = {
    "mapping": ["qc_clean", "trimming"],
    "count": ["mapping"],
    "deg": ["count"],
}
```

**Step 2**：实现收集器（`rules/utils/datadeliver.py`）

```python
def trimming(samples, data_deliver, config, **kwargs):
    for sample in samples:
        data_deliver.append(f"01.qc/fastp/{sample}.clean_R1.fq.gz")
        data_deliver.append(f"01.qc/fastp/{sample}.clean_R2.fq.gz")
    return data_deliver

def mapping(samples, data_deliver, config, **kwargs):
    for sample in samples:
        data_deliver.append(f"02.mapping/star/{sample}.sort.bam")
    return data_deliver

# ... 每个模块一个收集器
```

**Step 3**：注册到 `MODULE_COLLECTORS`

```python
MODULE_COLLECTORS = {
    "qc_clean": datadeliver.qc_clean,
    "trimming": datadeliver.trimming,
    "mapping": datadeliver.mapping,
    "count": datadeliver.count,
    "deg": datadeliver.deg,
}
```

**Step 4**：snakefile 中 include 顺序与编号一致

```python
include: "rules/01.common.smk"
include: "rules/02.file_convert_md5.smk"
include: "rules/03.short_read_qc.smk"
include: "rules/04.trimming.smk"
include: "rules/05.mapping.smk"
include: "rules/06.count.smk"
include: "rules/07.deg.smk"
include: "rules/08.deliver.smk"
include: "rules/09.Report.smk"
```

### 16.7 阶段 5：验证与收尾

```bash
# 1. Dry-run 验证 DAG 完整性
snakemake -s snakefile --cores 1 --config analysisyaml=examples/analysisyaml.example.yaml -n

# 2. 验证门控：注释掉 md5_check.tsv 的生成规则，确认下游全部报错
# 3. 验证开关：设 only_qc: true，确认只生成 QC 目标
# 4. 验证模块开关：逐个设 false，确认对应目标消失
# 5. 配置 monitor_config.yaml（§13.5）
# 6. 运行 §12.3 检查清单
# 7. 真实小数据集端到端测试
snakemake -s snakefile --cores 8 --use-conda --logger rich-loguru \
  --config analysisyaml=/test/project/config.yaml monitor_conf=monitor_config.yaml
```

### 16.8 最小可运行 Flow（Minimum Viable Flow）

如果只需要最快跑通框架验证（不含真实分析），最小文件集为：

```text
<X>Flow/
├── snakefile                    # 8 步模板（index_keys=[]）
├── config/
│   ├── config.yaml              # 最小配置（only_qc: true）
│   ├── reference.yaml           # 空或占位
│   ├── run_parameter.yaml       # 默认值
│   └── cluster_config.yaml      # 复制
├── schema/config.schema.yaml    # 最小 schema
├── rules/
│   ├── 01.common.smk            # 复制
│   ├── 02.file_convert_md5.smk  # 复制
│   ├── 03.short_read_qc.smk     # 复制
│   ├── 04.deliver.smk           # 最小交付
│   ├── 05.Report.smk            # 最小报告（project_summary.json）
│   └── utils/                   # 复制通用 + 最小 common.py/datadeliver.py
├── examples/analysisyaml.example.yaml
├── monitor_config.yaml
└── .gitmodules
```

此最小集可通过 `only_qc: true` 模式 dry-run，验证通用层（01-03）+ 交付 + 报告链路完整。之后逐步添加组学专用 rule 即可。

### 16.9 常见转换决策树

```text
你的现有流程是什么形态？
│
├─ Shell 脚本集合
│   └─ 每个脚本 → 一个 .smk rule（§16.5 拆分策略）
│
├─ 已有 Snakemake 流程（非 Flow 规范）
│   ├─ 保留分析 rule 逻辑，改写 input/output 路径对齐 Flow 目录约定
│   ├─ 替换入口为 8 步 snakefile 模板
│   ├─ 替换配置系统为四件套 + analysisyaml
│   └─ 添加 01-03 通用层 + 门控接线
│
├─ Nextflow / WDL / CWL 流程
│   └─ 提取每个 process/task 的命令行 → 转为 Snakemake rule
│       注意：channel 逻辑 → wildcards + input 函数
│
└─ 纯 R/Python 分析脚本（无流程管理）
    └─ 按分析步骤拆分 → 每步一个 rule + 对应 script
```

### 16.10 转换完成判定标准

一个流程被视为"已接入 Flow 家族"，当且仅当：

1. `snakemake -n`（dry-run）通过，DAG 无环、无缺失 input
2. `only_qc: true` 模式可独立运行到 MultiQC 报告
3. 每个模块开关可独立关闭，关闭后对应目标从 DAG 消失
4. `01.qc/md5_check.tsv` 门控接线完整（§4.3 全部 7 条）
5. `--logger rich-loguru` + `monitor_conf=monitor_config.yaml` 可推送事件到 OmicHub
6. §12.3 检查清单全部勾选
7. 至少一个真实小数据集端到端运行成功
8. `README.md` 最前面包含 Flow Framework 来源声明（§1.3）
