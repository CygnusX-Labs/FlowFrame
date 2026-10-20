<p align="center">
  <img src="../../FlowAgent/docs/flowagent_logo_1.png" alt="FlowAgent Logo · 深蓝底版" width="220">
  <img src="../../FlowAgent/docs/flowagent_logo_2.png" alt="FlowAgent Logo · 独立图形版" width="220">
</p>

# Flow × AI Agent：Rule 级编排、验证与版本治理技术规范

> 版本：v1.3（2026-09-08）
> 状态：讨论结论已纳入；FlowAgent 第 3 级骨架（`FlowAgent/`）已按 §8.3/§8.4 实现并通过 46 项回归自测，其验证结论（组合文件三层防线、报错签名归一化、台账 reason 字段等）已回写本规范；v1.3 新增：显式命名「受约束生成」中间态及到确定性编译的迁移路线（§8.7），三层防线补齐 with 块路径约束、注释截断修复与惯用语法放行（§8.2）；待真实仓库现状审计和端到端验收后冻结实现契约。
> 适用范围：采用统一规范构建的 Flow 系列 Snakemake 流程。
> 本文定义目标能力、接口和验收要求。除注明「已实现验证」的条款外，所述工具不代表已经实现；拟议路径、命令和 YAML 示例均需在实施阶段落地验证。

> 配套操作手册：[Flow 流程入库操作手册](Flow-Workflow-Onboarding-Guide.md)。本文代码与目录路径均相对于仓库根目录。

---

## 一、范围与目标

### 1.1 核心定位

**Agent 基于已有、经过严格测试和专家审核的已发布 rule，生成候选分析方案与 pipeline 实现；通过自动验证和专家审核后，发布 pipeline 并按授权策略运行。**

必须区分两种产出：

1. **复用已有 rule 的候选 pipeline**：审核对象是科学方案、组合关系、参数、依赖版本和验证证据；审核通过后发布 pipeline，不重复创建相同 rule。
2. **新增或修改的候选 rule**：仅在现有能力不足或存在缺陷时进入 Build 开发流程；连同 manifest、相关文件、环境和测试一并验证，经专家审核后作为新版本入库，再供 pipeline 引用。

已审核 rule 的可信范围受其输入条件、科学适用范围和版本约束限定。单条 rule 审核通过，不等于任意组合都科学正确。

Build 是辅助流程开发：Agent 承担检索、生成、测试、诊断和整理证据，专家负责科学方案与发布决策。Run 是分析执行与运行维护：在批准的方案、版本和权限范围内推进任务。

### 1.2 目标能力

- 自然语言需求转为可审核的分析方案和机器可验证的流程计划。
- 优先复用现有入口和已审核 rule；通过确定性生成器产出配置或组合文件。
- 分层验证契约、实际 DAG、最小真实运行和结果质量。
- 提供自主、监督、逐项确认三种运行模式，支持专家观察、暂停、批准和拒绝。
- 从首个试点开始实现 rule 级版本管理，完整锁定相关文件及传递依赖。
- 支持客户复跑历史 pipeline 版本、版本升级比较和隔离回退。
- 参考数据通过对象存储及版本化 YAML 描述，运行时校验身份与内容。
- 全程保留可查询的计划、审批、运行、修复和产物证据。

### 1.3 能力边界

本方案提高可追溯性、可重复执行性和流程自动化程度，不承诺所有科学判断正确或所有错误自动修复。专家审核分析设计，可执行校验器检查真实数据与产物，Agent 结合组学知识解释异常；三者互补。

`snakemake -n` 是必要的验证步骤，但不能证明工具实际运行成功、checkpoint 下游全部展开或结果科学正确。环境和数据完全锁定也不自动保证结果逐字节一致；非确定性工具需另外定义随机种子、运行条件及允许偏差。

### 1.4 总体架构

```text
需求 + 数据条件
       ↓
Build：检索已审核 rule → AnalysisPlan → 专家审核科学方案
       ↓
PipelinePlan → 版本解析与锁定 → 确定性编译
       ↓
静态/契约验证 → dry-run → 最小真实运行 → 结果校验
       ↓
候选实现审核 → 不可变 pipeline 发布
       ↓
Run：选择发布版本 → 项目预检 → 运行授权 → 提交
       ↓
监控 → 结果校验 → 授权内修复 / 专家核对 / 转 Build
       ↓
交付 + run.lock.yaml + ledger + 产物清单

历史复跑/回退：选择旧发布版本 → 隔离目录 → 新 run_id → 同样的预检与授权
```

---

## 二、术语与约定

| 术语 | 含义 |
|---|---|
| rule | Snakemake 执行单元；用稳定的 `rule_id` 标识逻辑能力 |
| module | 包含相关 rule 的源码模块；不能假设任意旧 `.smk` 都可独立导入 |
| manifest | rule 的接口、适用条件、文件依赖、环境和校验契约 |
| port | 输入输出的语义类型及兼容属性，不是简单的文件扩展名 |
| catalog / deliverable | 用户需求到可交付产物、入口和所需能力的映射 |
| AnalysisPlan | 面向专家的科学分析方案 |
| PipelinePlan | 面向编译器的结构化实现计划 |
| rule release | 某个 `rule_id@version` 对应的不可变依赖闭包和审核记录 |
| pipeline release | 组合逻辑、参数策略、编译产物及依赖锁的不可变发布单元 |
| release manifest | 发布身份、源码定位、依赖与证据摘要清单 |
| run lock | 单次运行使用的确切发布版本、数据、配置、环境和策略快照 |
| ledger | 运行服务追加写入的事件台账；不是 Agent 自行宣称审批的文本 |
| validation policy | 版本化的检查项、适用范围、阈值来源、严重性和处置规则 |
| approval | 绑定具体对象摘要、范围和审批人的授权记录 |
| Build / Run | 同一个 Agent 的两类能力角色，不要求两个独立 Agent |
| execution policy | 运行模式、动作白名单、资源预算、重试和审批规则 |
| skill | 指导方案设计和异常解释的知识资源，不替代实际校验或权限控制 |
| bootstrap | 为 module 提供 config、samples、logger、helper 等入口上下文的初始化契约 |
| attempt | 同一 run 的一次提交或重试尝试，拥有独立事件和集群 job 标识 |
| gap log | 记录能力、数据或验证缺口及其频次的追加日志 |

本规范使用「必须」「禁止」「应该」「可以」分别表示强制要求、禁止行为、推荐做法和可选能力。规范中的审批条款约束未来系统，不代表本次编辑文档需要额外审批。

---

## 三、职责与资产边界

### 3.1 三类版本化资产

| 资产 | 内容 | 发布与管理 |
|---|---|---|
| Rule 库与 pipeline | `.smk`、运行所需 helper/scripts、manifest、配置 Schema、环境 YAML/锁文件、rule 专用校验器、测试和组合适配器 | rule 独立版本 + pipeline 发布；Git 管理源码，制品存储保存不可变打包结果 |
| Agent 系统 | Plan Schema、编译器、通用校验框架、工具服务、审批与执行策略、CLI/UI、SDK 依赖、SOP 和组学 Skills | 与 Agent 一起管理和发布；每次构建与运行记录实际版本 |
| 参考数据与运行记录 | FASTA/GTF/索引、输入和输出数据、项目配置快照、审批与运行证据 | 数据存储/对象存储管理；版本化 YAML 和摘要关联到运行 |

**按实际依赖分类**：被 rule 执行时调用的 Python/R/shell 脚本属于 rule 的依赖；帮助 Agent 检索、编译、提交和解释结果的脚本属于 Agent 系统。通用校验引擎可随 Agent 发布，但每个 pipeline 必须锁定实际使用的引擎、策略及 rule 专用检查版本。

源码与运行资料可以位于不同仓库或同一仓库的不同目录。物理布局不改变上述独立发布与锁定责任。项目敏感配置、运行日志和大型数据不要求提交到公共源码 Git。

### 3.2 Agent 与确定性代码的分工

- Agent：理解需求、查询库、提出计划、解释失败、生成候选修订、整理评审材料。
- 版本解析器：解析已发布版本、传递依赖和兼容条件，生成精确锁，不由模型猜 commit 或摘要。
- 编译器：从合法计划生成固定结构的文件；不让模型自由生成每一个生产文件。
- 校验器：解析真实文件、计算指标、判断批准的约束、产生结构化证据。
- 执行服务：核对版本与授权、提交任务、跟踪集群状态、限制修改范围、记录台账。
- 专家：批准科学方案、候选 rule/pipeline 发布，以及授权之外的科学调整或异常处置。

### 3.3 Build 与 Run 的写入范围

Build 可以修改隔离开发目录中的候选代码和依赖，创建分支及评审包。已发布制品只读；修复必须创建新版本。

Run 只读发布制品和参考源；可写单次任务的配置快照、输出、日志、缓存及 Snakemake 状态目录。不得直接编辑已发布 rule、环境锁或参考描述。发现需要代码或科学调整时转交 Build，不能以「自修复」绕过发布审核。

---

## 四、结构化契约与数据模型

### 4.1 Rule Manifest

现有 `.smk` 模块可继续配一份 `rules/manifests/<module>.manifest.yaml`，内部每条 rule 从首个试点起具备独立身份和版本。以下为单条 rule 的字段示意，不是当前模板的已验证完整依赖清单：

```yaml
schema_version: "1"
module:
  id: rna.short_read_qc
  snakefile: rules/03.short_read_qc.smk
  requires_helpers: [rule_resource, logger]
  requires_context: [config, samples]
  bootstrap_ref: flow.bootstrap@1.0.0

rules:
  - rule_id: rna.qc.short_read_qc_r1
    version: 1.0.0
    name: short_read_qc_r1
    summary: 对单个样本的原始 R1 reads 运行 FastQC
    wildcards: [sample]
    per_sample: true
    io_resolution: static
    inputs:
      - name: link_r1_dir
        port: reads.fastq
        attributes: {mate: R1, processing: raw, compression: gz}
        scope: sample
        path_binding: raw_r1
        source: upstream
      - name: md5_check
        port: qc.md5_check.tsv
        path_binding: md5_gate
        role: gate
        source: upstream
    outputs:
      - name: r1_zip
        port: qc.fastqc.zip
        attributes: {mate: R1, processing: raw}
        scope: sample
        pattern: "01.qc/short_read_qc_r1/{sample}_R1_fastqc.zip"
        kind: intermediate
      - name: r1_html
        port: qc.fastqc.html
        attributes: {mate: R1, processing: raw}
        scope: sample
        pattern: "01.qc/short_read_qc_r1/{sample}_R1_fastqc.html"
        kind: report
    config_requires: [convert_md5, parameter.threads.fastqc]
    config_schema_ref: rna.qc.config@1.0.0
    dependencies:
      helpers: [flow.resource_manager@1.0.0]
      environments: [env.fastqc@1.0.0]
      validators: [validation.fastqc@1.0.0]
    tests_ref: tests/fixtures/short_read_qc
```

必需语义约定：

- `rule_id` 不依赖目录编号，重命名文件不改变逻辑身份；`version` 对应精确发布记录。
- `inputs[].port`、`outputs[].port` 必须在注册表定义；生产/消费连接检查属性、样本范围、基数、参考身份和数据状态。
- `source` 区分 `upstream` 与 `external`。原始数据、参考文件等可来自外部，不强求库内生产者。
- `pattern` **必填**：每个 input/output 必须给出可静态检查的路径 pattern，这是端口确定性匹配的最低要求（已实现验证：pattern 缺失会让端口选择退化为全靠 dry-run 兜底，入库校验直接拒绝）；`path_binding` 引用版本化适配器时，适配器同样必须暴露可静态检查的 pattern。必须明确定义通配符与 config 插值，禁止把 `{md5dir}` 这类占位符同时当成两种含义。
- `config_requires` 包含必填项；可选项、默认值、类型、枚举与条件必填由 Schema 定义。helper 和 bootstrap 的配置依赖参与合并。**Schema 内联形式（已实现验证）**：条目从纯 key 字符串升级为对象，旧式 key 列表兼容（视为 `type: any`）并给出升级提示：

```yaml
config_requires:
  - key: "parameter.threads.fastqc"
    type: "integer"        # string/integer/number/boolean/array/object/any
    minimum: 1
    maximum: 64
    default: 2
    description: "FastQC 线程数"
```

组合目录的 config 副本在写盘前与校验时按全库 Schema 做类型/枚举/范围/pattern 校验，报错必须带字段路径与期望约束——存在性检查拦不住「合法 key + 语义错误值」（如物种写错、链特异性写反），只有 Schema 加领域校验能拦住一部分。
- `io_resolution` 为 `static`、`input_function` 或 `checkpoint`。旧 `dynamic` 字段需迁移映射；普通 input 函数不等于必须等待作业执行。
- manifest 声明运行所需环境、脚本、helper、bootstrap、校验策略和测试；实际发布清单展开全部传递文件依赖。
- `kind: report` 表示输出用途，不表示该输出自动成为用户 deliverable。
- `resources_tier` 应声明资源档位（如 `low_resource`/`high_resource`）：人工确认阶段据此汇总预计资源规模（已实现验证：`--rulegraph` 的 rule 链 × manifest 档位即可生成确认摘要）。

### 4.2 端口注册表与路径绑定

端口匹配只是选择候选 rule 的条件，Snakemake 仍通过真实 input/output 路径构建作业 DAG。必须同时满足语义兼容与路径绑定。

例如 `reads.fastq` 的 `processing: raw` 与 `processing: trimmed` 不可默认为可互换；`align.bam` 应根据用途约束坐标体系、排序状态、索引和参考版本。聚合步骤必须明确使用哪一个样本集合，不能悄悄扫描目录纳入其他运行的数据。

`ports.yaml` 人工维护类型定义和兼容约束，生产者/消费者索引从发布 manifest 派生，并带 `rule_id@version`。索引中的「有生产者」不等于任何候选版本都兼容。

### 4.3 产物目录与派生索引

`catalog.yaml` 保存 deliverable 的 ID、名称、用途、keywords、**synonyms 同义词表**、入口或已发布 pipeline、target 模板、样本范围、前置条件和验证策略引用。同义词表防「漏召回」方向（用户措辞与条目名不一致时，如「质检」vs「质控」），已实现验证为关键词同时匹配 name/description/keywords/synonyms。

两条匹配纪律（已实现验证）：宁可多组装不可拿错——catalog 匹配是确定性关键词/同义词匹配，不允许用模型语义相似度直接判定「就是这个」；catalog 未命中但需求疑似已有 deliverable 时，Agent 必须先向用户明示「未命中的原因」（查了什么关键词、为什么不算匹配）再走组装。

Git 中的版本化 manifest、端口定义与 catalog 是相应发布的事实源；SQLite/FTS 等只作为可重建索引。发布状态与撤销记录由服务维护。查询工具默认返回紧凑摘要及版本/来源指针，详情按需读取；不把全库上下文成本承诺为固定 token 数。

派生索引必须记录来源发布摘要。Run 按 lock 查确切版本，禁止索引刷新后自动替换成 latest。第一版可使用本地查询库或 CLI，再通过 MCP 暴露同一实现。

### 4.4 AnalysisPlan：专家审核对象

分析方案必须记录：

- 研究目标、组学类型、实验方法、预期 deliverable；
- 样本范围、分组与对照、配对关系、批次及协变量；
- 方法、关键参数、参考数据版本、适用条件与选择依据；
- 校验策略、阈值来源、可接受差异和异常处置；
- 未知信息、方法假设、需要专家决定的问题；
  - 方案 ID、修订号、所用 Skill/资料版本及审批引用；确定性声明、随机种子和允许差异。

字段级复审触发矩阵由版本化策略文件管理：

| 变更字段 | 处理 |
|---|---|
| 分组、对照、配对、协变量 | 必须重新科学审核 |
| 方法、rule 组合、参考或注释版本 | 必须重新审核 |
| 关键参数、过滤阈值、统计模型 | 必须重新审核 |
| validation policy、阈值来源或允许差异 | 必须重新审核 |
| 样本路径、队列、重试次数和资源参数 | 按授权策略处理；不改变科学含义时可免重新审核 |
| 文案、日志和展示格式 | 修订并留痕，通常免重新审核 |

Agent 只能按该矩阵执行，不能自行判定是否需要复审。

缺少决定科学方案的信息时提出明确问题，不能为通过校验而编造分组、参考版本或阈值。专家审核绑定方案内容摘要；命中复审矩阵时必须重新审核。

### 4.5 PipelinePlan：编译器输入

Agent 提交结构化计划，不提交任意可执行代码。以下为字段示意；正式 lock 中必须全部解析为确定值：

```yaml
schema_version: "1"
pipeline_id: customer_raw_qc
revision: 1
analysis_plan_ref: analysis-001@1
mode: existing_entry
base_pipeline_ref: RNAFlow@2025.06.01
steps:
  - instance_id: qc_r1
    rule_ref: rna.qc.short_read_qc_r1@1.0.0
bindings:
  qc_r1.link_r1_dir: input.raw_r1
  qc_r1.md5_check: upstream.md5_pass
targets: [raw_multiqc_r1]
config_ref: config/project.yaml
sample_sheet_ref: config/samples.csv
reference_ref: references/project.yaml
validation_policy_ref: validation.raw_qc@1.0.0
execution_policy_ref: supervised@1
```

计划中的 steps 可以是能力选择，解析器必须补全所需上游规则闭包，遇到多个不等价生产者要求明确选择。校验器解析完整连接和实际 target，不能因为一个示意步骤合法就视整条链完整。样本级作业展开和调度 DAG 由 Snakemake 决定，不自造调度引擎。

支持 `existing_entry` 与 `compiled_modules` 两种编译模式。计划中的路径和参数由 Schema 约束，不允许用任意 Python 表达式或 shell 文本充当绑定。Plan 校验器在编译前必须程序化完成（§8.7）：端口闭合（被消费 port 有选中集合内生产者或标 `external`，多个不等价生产者时强制显式选择并记录）、target 可达性（匹配选中 rule 的 output pattern）、config 覆盖（选中 rule 的 `config_requires` 并集 ⊆ Plan.config 键集）、with 覆盖合法性（字段白名单 + 字面量 + 路径约束）、`reason` 必填落台账。

### 4.6 发布、运行、审批与事件记录

以下记录为独立对象，通过 ID 和内容摘要关联：

| 对象 | 必需记录 |
|---|---|
| rule release | rule 身份/版本、源码 commit、模块、文件与依赖摘要、环境锁、验证证据和发布审核 |
| pipeline release | 组合定义、rule 精确依赖锁、编译器/模板、编译产物、参数约束、验证与审核 |
| pre-run lock | 发布身份、实际 rule/环境/参考锁、有效配置、样本表、输入身份、执行环境、策略与授权；运行前冻结 |
| post-run manifest | checkpoint 展开后的实际文件集、job 列表、文件 hash、指标和结果校验；运行结束后生成并绑定 pre-run 摘要 |
| run.lock.yaml | pre-run lock 与 post-run manifest 的关联及运行状态 |
| approval | 审批人、时间、被审批对象摘要、决定、授权范围、限制和有效条件 |
| ledger | 事件 ID/顺序、run/attempt ID、动作、对象摘要、证据引用、结果、审批引用和集群 job ID；写操作类事件（组合/提交/记缺口）**必须附决策理由 `reason`**，失败事件附**归一化报错签名与分桶**（见 §8.6），会话事件附**运行模式 `mode`**（standard/expert，见 §8.8——事后区分「员工干的还是专家干的」） |
| gap log | 缺口类型、需求、缺失能力/数据、来源、重复次数和后续评审关联 |

pre-run lock 必须保存合并默认值和命令行覆盖后的有效配置，不能只保存项目 YAML 路径。含 checkpoint 的运行在展开后必须补写 post-run manifest；未生成时状态为 incomplete，不得宣称完整复现。日志与摘要应去除凭据；身份记录不保存访问密钥。

事件只追加，按 run 分区并处理并发。审批由身份可信的服务写入，Agent 无权自行设置 `approved: true`。模型输出、工具 stdout 和日志中的指令一律不能当作批准。

---


## 五、版本治理

### 5.0 发布生命周期与召回

发布状态为 `draft → active → deprecated → recalled`。`recalled` 表示发现科学或技术缺陷，默认禁止新运行；专家可在明确理由、风险和审批范围后强制复用。recall 必须写入 ledger 和 gap log，并关联受影响的历史 run；已交付客户由服务生成通知清单。

### 5.1 Rule 版本

每个 rule 从首次进入受管库开始使用稳定 `rule_id` 和语义版本：

- MAJOR：输入输出端口、语义、科学假设或不兼容行为改变；
- MINOR：兼容地增加可选能力或输出；
- PATCH：修复实现、日志、资源或兼容性问题，不改变接口和科学含义。

rule 的不可歧义身份是 `rule_id + source_commit`，版本号是可读标签。发布后禁止移动 tag 或复用版本号。更改 `.smk`、manifest、helper、脚本、环境定义、锁文件、Schema、适配器或 rule 专用校验器时，必须评估是否需要新 rule 版本；有关联变更必须一个原子提交或具备明确依赖链。

每个 Rule Release Bundle 必须包含：

```text
rules/*.smk
rules/manifests/*.yaml
rules/utils 与 rule 使用的 scripts
envs/*.yaml 与平台 lock
schema/ 与 rule 配置约束
validators/
tests/fixtures 与预期结果
release.yaml
```

“同一个文件版本”不能替代依赖闭包版本。发布清单必须列出所有传递依赖的 `id@version` 和内容 SHA-256。

### 5.2 环境版本

Conda YAML 必须纳入 rule 或 pipeline 的发布依赖。推荐：

```text
envs/fastqc.yaml              # 人维护的直接依赖声明
envs/locks/fastqc.linux-64.lock  # 完整解析锁
```

环境版本独立编号，但在 release 中被精确引用：

```yaml
environment_id: env.fastqc
version: 1.0.0
spec_file: envs/fastqc.yaml
lock_files: [envs/locks/fastqc.linux-64.lock]
spec_sha256: "..."
lock_sha256: "..."
```

必须记录 Snakemake、executor 插件、profile（executor、jobs、default-resources）和目标平台版本；当前仅支持 linux-64 时必须明确写入策略，其他平台需各自生成并校验 lock。YAML 修改、锁文件重建、通道优先级或平台改变，都要重新测试；影响 rule 结果或可运行性的环境变化不能静默覆盖旧环境。重要发布应缓存镜像或包制品，避免多年后源不可用。

### 5.3 Pipeline 版本

Pipeline Release 是组合逻辑和依赖的不可变快照：

```yaml
pipeline_id: RNAFlow-qc-mapping
version: 2026.06.01
revision: 1  # 候选计划修订；发布版本使用不可变日期版本，二者不混用
repository_commit: abc123
compiler:
  id: flow.pipeline_compiler
  version: 1.0.0
rules:
  - rule_ref: rna.raw.check_md5@1.1.0
  - rule_ref: rna.qc.short_read_qc_r1@1.0.0
environments:
  - env.fastqc@1.0.0
references:
  - reference.hg38.star@2026.05.15
validation_policies: [rna.qc.outputs@1.0.0]
```

发布后 pipeline lock、组合 Snakefile、有效默认配置、测试证据和 review 记录不可变。客户“换样本/路径”生成新的 run，不改变 pipeline 版本；改变 rule 组合、科学参数、参考数据、环境或验证策略时创建新的 pipeline revision/release。

### 5.4 Agent 与 Skills 版本

Agent 系统另行发布，例如：

```yaml
agent_release: flow-agent@1.3.0
compiler: flow-compiler@1.1.0
validator_engine: flow-validator@1.0.0
skills:
  - bulk-rna@2.0.0
  - qc-interpretation@1.1.0
```

组学 Skill 提供方案模板、方法适用条件、异常解释和校验策略引用；它不能直接放宽执行权限，也不能替代校验器。每次 Build/Run 的 lock 必须记录实际使用的 Agent、compiler、validator、Skills 与策略版本。

### 5.5 参考数据与对象存储

参考 FASTA、GTF、索引和其它大型固定文件放在对象存储是推荐方案。使用内容不可变 URI、对象存储版本 ID 或内容摘要，不能只写会被覆盖的 `s3://bucket/hg38/latest`。

```yaml
reference_id: reference.hg38.star
version: 2026.05.15
objects:
  - uri: s3://flow-reference/hg38/star/2026.05.15/index.tar.zst
    object_version_id: "..."
    sha256: "..."
  - uri: s3://flow-reference/hg38/annotation/2026.05.15.gtf.gz
    sha256: "..."
metadata: {genome: hg38, annotation: GENCODE_v47, index_tool: STAR_2.7}
```

下载到运行目录后再次校验 hash；URI、对象版本、解压目录和构建工具版本写入 run lock。对象不可用或摘要不符时停止，不能自动改用 latest。

### 5.6 升级、历史运行与回退

历史 release 必须可读取且禁止原地修改。Agent 根据客户记录查找原 pipeline release，创建隔离 checkout/workspace，解析对应 rule、环境锁和参考对象，生成新的 run lock 和输出目录，然后照常执行预检、dry-run 和授权。

```text
客户任务 → pipeline@2025.06.01 → commit/lock/reference@固定版本
                    ↓
          新 run_id + 新输出目录 + 新 ledger
```

回退是“选择旧发布版本创建新运行”，不是把当前开发分支执行 `git reset`，也不是覆盖已有结果。若要把旧版本输出用于比较，必须记录输入相同与否、结果校验策略及差异报告。

---

## 六、校验与结果质量

### 6.1 四级验证门

1. **契约验证**：manifest schema、端口属性、配置必填项、依赖闭包和静态漂移检查。
2. **工作流验证**：Snakemake 加载、目标解析、实际 DAG、`--dry-run`、资源与路径预检、**环境预构建**（`--conda-create-envs-only`，把网络/源/版本问题提前暴露在正式运行前，已实现验证）。注意 `snakemake -n` 会构建 DAG 并对无生产者的缺失输入抛 `MissingInputException`，但它不验证环境可用与集群资源充足。
3. **执行验证**：最小 fixture 或项目运行中的工具退出码、日志、输出存在性、格式、样本集合和参考身份。
4. **科学结果验证**：按批准的 validation policy 检查指标、阈值、允许差异、质量报告和关键统计结果。

前三级通常可自动执行。第四级由版本化策略和校验器执行；发现需要科学判断的 WARN/NEEDS_REVIEW 时提交专家，而不是由模型自行宣布通过。

### 6.2 Validation Policy

```yaml
policy_id: rna.qc.outputs
version: 1.0.0
applies_to:
  - rule: rna.qc.short_read_qc_r1
    version_range: ">=1.0.0,<2.0.0"  # semver range，由版本解析器校验
checks:
  - id: sample_ids_match
    validator: matrix_sample_ids
    severity: error
  - id: alignment_rate
    validator: star_metrics
    thresholds_ref: analysis_plan
    severity: review
  - id: count_matrix_contract
    validator: count_matrix_structure
    severity: error
```

每个检查必须定义输入、代码版本、预期条件、严重性和处置：

- **PASS**：条件满足；
- **WARN**：保存警告并可按策略继续；
- **FAIL**：阻断下游或交付；
- **NEEDS_REVIEW**：暂停等待专家；
- **NOT_APPLICABLE**：记录为何不适用。

常见检查包括：

- 样本表、目标文件和矩阵的样本 ID 集合一致；
- 矩阵行列、数据类型、缺失值、ID 唯一性符合契约；
- FASTQ/BAM/索引可读且配对完整；
- 比对、测序深度、重复率等指标在该项目批准的范围或参考分布内；
- 参考基因组、注释和索引身份与计划一致；
- 输出数量、目录和文件格式完整；
- 最小测试或历史参考结果在策略规定的差异范围内。

阈值必须来自实验类型、批准的分析方案、验证数据或专家维护的策略，不得由 Agent 临时猜测。规则允许“缺失阈值时需要审核”，不允许为了通过而自动放宽阈值。参考结果比较可以定义结构、统计指标和容许差异，不强制所有文件逐字节相同。

### 6.3 校验器的实现位置

校验器不是另一个必须独立部署的 Agent。建议由一个通用 validator engine 加载各组学校验插件：

```text
agent/
  validators/
    common.py
    bulk_rna.py
    scrna.py
    atac.py
  policies/
    bulk_rna/*.yaml
    scrna/*.yaml
  skills/
    bulk-rna/SKILL.md
    scrna/SKILL.md
```

插件负责读取真实文件、计算指标并输出结构化结果；Skill 负责告诉 Agent 如何选择策略和解释证据；专家批准方案及策略。大型组织可以另设结果审查 Agent 生成第二意见，但其输入限定为只读的校验结果、指标、日志和已批准方案，不得绕过上述校验器或人工闸门，也不默认读取原始数据。

校验器可以作为 Snakemake rule 运行，也可以作为提交前/交付前服务。对于会影响下游的检查，优先设为显式校验 rule，产出带版本的 `validation.json` 和 `validation_passed` 标记。


## 七、Rule 库增长与治理

### 7.1 候选 rule 入库门禁

新增或修改 rule 的候选包必须包含 rule diff、manifest、相关 helper/script、环境 YAML 和锁文件、校验器、最小测试数据、预期输出、dry-run、最小真实运行和来源说明。入库必须通过：

1. Schema 与依赖校验（含 `io.pattern` 必填、config_requires Schema 完整性）；
2. 静态加载和 dry-run；建议追加 `snakemake --lint`（warning 级，不阻断，输出进报告）；
3. 最小真实运行和输出校验；
4. 专家审核 checklist；
5. 新版本 release 和不可变制品保存。

专家批准的是候选 rule 的适用范围和证据，不只是代码能否运行。被驳回的草案和修正意见可作为 Agent 的提示范例，但不得被当作已发布能力。

候选包的上游来源之一是专家模式 Agent 起草的**入库提案**（§8.8 的 `write_rule_proposal`，落在 `proposals/<日期>_<名称>/`，manifest 草稿 + .smk 草稿 + RATIONALE.md）。提案只是草稿与理由的固化，不产生任何可执行能力；从提案到候选包仍须补齐本节全部材料并走完五道门禁。

### 7.2 候选 pipeline 发布门禁

复用已发布 rule 生成的候选 pipeline 必须包含 AnalysisPlan、PipelinePlan、依赖 lock、编译产物、dry-run、最小真实运行、结果校验和人工审核记录。审核通过后发布不可变 pipeline；变更 rule 组合、关键参数、参考、环境或策略时创建新的 pipeline revision。

### 7.3 缺口与持续测试

端口断链、缺 rule、缺 deliverable、校验失败和专家否决必须写入 gap log。高频缺口用于安排 rule 策展。CI 定期复测已发布 rule 和 pipeline；环境或工具升级导致失效的版本标记为待修复，Agent 组链时禁用，历史运行仍保留原 lock。

---

## 八、实现形态与工具接口

### 8.1 实现分级与两种工作模式

实现分三级推进（第 3 级已有参考实现并通过回归验证，即 `FlowAgent/`）：

1. **第 1 级：MCP/CLI 工具**——把查询与校验封装为工具，通用 Agent 宿主调用；
2. **第 2 级：Agent SDK 集成**——在既有 Agent 框架内挂载工具与 SOP；
3. **第 3 级：自建 Agent 应用**——独立后端（CLI + HTTP/UI），SOP 蒸馏进 system prompt，循环底座用成熟 tool-calling SDK（如 Vercel AI SDK `streamText`），不手写 tool-calling 循环；换模型只换环境变量。

同一个 Flow Agent 同时提供 Build 和 Run。Build 允许在隔离分支生成候选文件；Run 使用不可变 release。两种模式共用 catalog、manifest、validator、ledger 和审批服务。

第一版优先实现标准入口模式：Agent 生成 analysisyaml、样本表副本和 target，调用现有入口完成验证。只有现有入口无法表达需求时，才使用固定模板编译组合 Snakefile。生产仓库的模块依赖 samples、config、logger、rule_resource 和 workflow 等入口上下文，必须先完成上下文审计和 bootstrap 契约，再开放任意 module + use rule 组合；**小型/受控仓库可在 §8.2 三层防线保护下先行试点 module + use rule 组合**（demo 仓库已实测跑通：vendor fastq → Rust 二进制标准化与 MD5 门控 → fastqc/multiqc 全链）。

### 8.2 组合文件约定与三层防线

组合文件由编译器生成，位置为 composed/<pipeline-id>/<revision>/，不覆盖已有目录（过渡实现可用 `composed/<日期>_<需求简述>/` 命名，同样永不覆盖）：

```text
composed/<pipeline-id>/<revision>/
  plan.yaml
  Snakefile
  config/analysis.yaml
  config/samples.csv
  release.lock.yaml
  validation/dry-run.txt
  review/approval.json
```

禁止把 rule 本体复制到组合文件；只允许使用已发布模块和编译器支持的固定模板。组合文件中的每个 rule 引用必须能追溯到 rule_id@version。

**组合文件骨架的实测约定**（已实现验证，违反即运行期失败）：

```python
include: "../../rules/common.smk"        # 仓库存在 common.smk 时必须第一行(隐性 helper 唯一来源)
configfile: "../../config/config.yaml"   # 或本目录内生成的 config 副本
workdir: "../.."                          # target 与路径均相对仓库根

module qc:
    snakefile: "../../rules/03.short_read_qc.smk"
    config: config   # 必须显式传:不传时 module 拿不到组合文件 configfile 加载的 config(实测 KeyError)

use rule short_read_qc_r1 from qc as qc_short_read_qc_r1   # 命名空间前缀避免 AmbiguousRuleException

rule all:
    input: "<本组合的最终 target>"
```

**三层防线（P0，已实现验证）**。Snakefile 本身是 Python——`snakemake` 解析即执行顶层代码，而 dry-run 发生在人工确认**之前**。「只允许 use rule 组合」必须在写盘前由工具层强制，仅靠正则挡 rule 定义不够（顶层 `import`/`open(...).write(...)` 载荷曾实测绕过并在 dry-run 阶段执行）。组合文件必须依次通过：

1. **语句级白名单**：顶层只放行 `configfile:` / `include:` / `workdir:` / `module X:` / `use rule ... [with]:` / `rule all:` 与注释空行；任何其他顶层语句（import、赋值、函数定义、其他 rule 定义、`shell:`/`run:`）拒绝并报行号。Snakefile 是 DSL 不是合法 Python，需按顶层语句切块后逐块判定；
2. **路径约束**：configfile/include/workdir/module.snakefile 的路径经 realpath 解析后必须位于流程仓库根内且真实存在（防 `../` 逃逸、库外绝对路径与符号链接逃逸）；with 块 `input/output/log/benchmark` 与 `rule all` input 的字符串字面量同样必须落在仓库根内——按组合目录与仓库根两个基准解析都过关才放行，不要求存在（output 尚未产出），已存在的追加 realpath 防 symlink（已实现验证：with 块 `output: r1_html="/tmp/..."` 曾实测放行——写盘层 ok=true，修复后拒绝）；
3. **表达式约束**：`use rule ... with:` 块（字段白名单 input/output/params/threads/resources/log/benchmark）与 `rule all:` 的 input 只允许字面量（str/int/float/bool/None/list/dict/tuple、一元 +/- 数字与 kwargs），禁止名称引用、函数调用、属性访问、下划线开头与 dunder 标识符（`__import__` 载荷在此被拦截）；`rule all` 的 input 额外放行 `expand()`，参数仍限字面量。三条已实测的解析器纪律：行内注释只跳到行尾——绝不允许借注释截断解析（注释后续行藏 `__import__` 载荷曾实测绕过防线并在写盘层放行，修复后拒绝）；顶层序列允许换行分隔（Snakemake 官方文档惯用的无逗号命名列表——误拒会浪费重试轮次并诱导 LLM 换写法绕行）与尾逗号（Python 允许）；同行拼接（无逗号无换行）仍然拒绝。

可选纵深防御（不阻塞第一阶段）：dry-run 进程降权执行（独立低权限用户或 bwrap/容器），即使防线被绕过也把爆炸半径限制在组合目录内。

### 8.3 行为铁律与工具层硬约束

以下约束全部由工具层强制、写入运行台账，不相信模型嘴上说（已实现验证）。SOP 中的「禁区六条」：

1. 修改优先级：样本表 > config > 组合 Snakefile > 新增 rule > 已有 rule；已有 rule（.smk 库文件）的任何改动必须先征得用户明确同意，Agent 只能提出建议；
2. dry-run 未通过、或用户未通过确认工具本人确认前，禁止提交（工具层硬性拒绝）；用户在对话里口头说「可以」不构成批准——必须经 client-side 确认工具由终端/UI 把确认交给用户本人应答，批准落账后才生效；
3. manifest 中动态 I/O（`io_resolution: input_function/checkpoint`）的 rule，禁止凭读代码断言其 I/O，只许 dry-run 实测；
4. 正式运行失败后的续跑一律 `--rerun-incomplete`，禁止全量重跑；
5. 每次改动 manifest 或组合文件后，先跑一致性校验，通过后再继续；
6. 同一报错按归一化签名计数（§8.6），连续失败 2 次后熔断，整理报告给用户。

**提交的三道闸**（全部查台账，按 task_id + targets + workdir 精确匹配）：

1. 台账中存在本任务的 dry-run 成功记录；
2. 台账中存在用户本人确认的 `human_decision` 记录（模型无权代填；HTTP 前端的确认可信度等于前端实现的可信度，须受服务端总开关约束）;
3. 服务端提交总开关开启。

**其余工具层硬约束**：

- 仓库只读；写操作仅限组合目录、缺口日志、运行台账、run bundle 快照目录与专家模式提案目录 `proposals/`（§8.8，只允许新建）；一切相对路径经越界防护解析，逃逸即拒绝；
- 组合目录与发布制品永不覆盖（可回溯）；
- 写操作类工具（组合/提交/记缺口）的 `reason` 必填，落台账审计；
- 提交固定携带 `--cores <上限>`（来自部署配置，Agent 不可改——本地执行无此护栏会占满整机核数；集群提交时由 execution policy 的资源预算承担同一职责）；
- Agent 循环有全局步数上限（如单次会话 30 步），叠加铁律 6 的同签名熔断，杜绝隐式无限循环；
- 人工确认摘要必须包含 job/文件规模、rule 链（`--rulegraph` 文本树）、资源档位汇总（manifest `resources_tier`）与预计输出，否则确认流于形式；
- 提交成功后固化 run bundle（rule 库版本 + 组合副本 + config/样本表副本）：rule 库 git 管理时用 commit，非 git 管理时用全库 manifest 联合 hash；这是 pre-run lock（§4.6）在过渡阶段的轻量实现。

### 8.4 推荐工具

```text
query_catalog / query_ports / query_rules / get_rule
validate_manifests / validate_plan / compile_pipeline
dry_run / detailed_summary / read_log / write_gap_log
write_composed / submit_cluster / confirm_submit
validate_outputs / pause / resume / rerun_release

# 专家模式追加(§8.8,员工模式不注册):
analyze_history / write_rule_proposal
```

查询类工具返回紧凑摘要（端口/rule 摘要先行），详情按需读取（渐进式披露，不一次性拉全库）。工具输出必须结构化，同时保留可读摘要。Agent 的自然语言回答不能作为唯一审计证据。

### 8.5 多租户隔离

多客户并行运行必须按客户、项目、pipeline release 和 run_id 隔离工作目录、输出、ledger、制品配额和凭据。共享参考缓存只允许读取不可变对象，并以 hash 校验；不得共享可写的 Snakemake 状态目录。对象存储前缀、日志访问权限和生命周期策略必须绑定租户。

补充（已实现验证的幂等性事实）：组合流程的 workdir 通常重定向到仓库根，多个组合共享同一 workdir——Snakemake 的 workdir 锁使并发重复提交直接失败，`--rerun-incomplete` 使已完成输出的顺序重复提交成为 no-op。若 workdir 随组合目录新建，重复提交将全量重跑（浪费但不出错）；发布态应固定共享 workdir 并在台账记录活跃提交，避免 pid 复用误判。

### 8.6 失败分类、报错签名与重试策略

失败分类和重试上限由版本化 execution policy 定义，Agent 不得现场改变。**熔断必须按归一化报错签名计数**（已实现验证）：签名 = 异常类型 + rule 名 + 去除引号内容/路径/数字后的消息骨架。原始报错文本含绝对路径、样本名与时间戳，直接做签名则每次失败签名都不同，熔断永不触发，只剩全局步数兜底。

分桶决定重试策略（报错对策表按桶给出修复动作）：

| 桶 | 典型报错 | 策略 |
|---|---|---|
| retryable | MissingInput / AmbiguousRule / CyclicGraph / KeyError(config) | 按对策表修复重试，计入熔断（同签名 2 次后第 3 次拒绝） |
| sample_table | WildcardError / 样本表文件或列缺失 / 样本名与通配符冲突 | **直接升级人工，不计熔断**：样本表对 Agent 只读（无写工具），「失败→修复→续跑」循环遇到样本表问题必死，继续自行尝试只会白烧熔断次数 |
| transient | OOM / 节点瞬断 / 超时 / 非零退出码无明确异常 | 自动续跑（`--rerun-incomplete`），不计熔断；OOM 用受限资源写口（白名单 mem_mb/disk_mb/threads/runtime，经 `--set-resources` 传递、落台账）加内存重试，瞬断有限次自动重试 |
| unknown | 未识别类型 | 按可修复处理（计入熔断），保守 |

科学指标异常必须暂停专家核对（NEEDS_REVIEW）；同一签名熔断后生成证据包（报错原文、已试方案、log 摘要）交给用户，不允许换着花样无限重试。

### 8.7 生成信任模型：受约束生成 → 确定性编译

§3.2 的分工承诺（「编译器从合法计划生成固定结构的文件」）与 §8.2 的三层防线之间曾长期没有命名中间态。本节显式定义两种生成信任模型、当前定位与迁移路线。

**两种信任模型**：

| | 确定性编译（目标） | 受约束生成（当前实现） |
|---|---|---|
| 谁写组合文件 | 编译器（固定模板机械展开） | LLM（生成全文） |
| 正确性来源 | **构造**：Plan 合法性由 Schema + 端口闭合分析前置保证，编译只产生合法产物 | **枚举**：防线事后拒绝已知非法类别，漏一个类别就是洞 |
| LLM 角色 | 只产出结构化 Plan（选哪些 rule、字面量参数） | 直接决定每一个字节（语句顺序、命名、覆盖） |
| 错误模式 | 编译器 bug → **系统性**错误（同因复现，易回归测试） | LLM 幻觉 → **随机**错误（难复现，靠评测集统计） |
| 可审计性 | Plan 是结构化对象，可 diff、可版本化、可机器复核 | 只有台账一句 `reason` + 生成文件本身 |

关键事实：执行层面的科学逻辑（shell/脚本）100% 来自库内已审核 rule（`use rule` 是引用不是复制，防线保证 LLM 夹带不了自己的代码）；差距全部在**组装决策层**（选哪些 rule、参数覆盖、target、config 值）。

**受约束生成级的适用边界与能力边界**：适用于受控仓库（rule 库完成阶段 0~2 资产建设）、组合请求量低、有三道闸与人工确认兜底的过渡期。其明确的能力边界是：防线的谓词是「没有可执行代码 + 路径不越界」，不是「组装科学上正确」——rule 选择错误、链拓扑错误（漏门控 rule）、with 参数覆盖错误、config 语义错误（类型对、枚举内、但值填反）、target 指向中间产物这五类语义错误（E1–E5）不在任何自动化闸门的谓词内；dry-run 是当前唯一的自动化正确性闸门，而 §1.3 已承认它不证明科学正确。这五类错误当前只能依赖 confirm_submit 的人工确认摘要（dag_tree + 文件清单 + 资源档位）去发现，属于「规模确认」而非 §4.4 要求的「方案确认」。

**迁移路线**（不是一步切换）：

1. 新增 `compile_from_plan` 工具（§8.4 的 `validate_plan` / `compile_pipeline`）：Plan 进、组合目录出。编译前 Plan 校验器做纯程序化检查——端口闭合（每个被消费 port 有选中集合内生产者或标 `external`；多个不等价生产者时强制 Plan 显式选择并记录）、target 可达（匹配某选中 rule 的 output pattern）、config 覆盖（选中 rule 的 `config_requires` 并集 ⊆ Plan.config 键集）、with 覆盖合法性（字段白名单 + 字面量 + 路径约束，与 §8.2 同一文法）、`reason` 必填落台账；
2. SOP 改为：catalog 命中与可 Plan 表达的组合一律走编译；编译器表达不了的才允许 `write_composed` 直写。编译产物必须自动重跑三层防线作为自检——防线失败 = 编译器 bug，立即熔断报错、不落盘；
3. 每次直写落一条 `compiler_gap` 缺口事件（复用 gap_log 机制）——直写是「编译器文法缺什么」的信号，驱动模板长全；
4. 观测直写率趋零后关闭直写路径（或降级为需服务端开关的逃生门）。

**迁移触发条件**（满足其一即应启动编译器建设）：组合请求量超过运维阈值；发生任何一次防线绕过事件；`compiler_gap` 事件出现可收敛的模式。

**该路线自身的风险**：编译器 bug 是系统性错误——一个模板错误同时污染所有组合（缓解：编译产物必过三层防线自检 + golden 测试「样例 Plan → 期望字节」+ 同一 Plan 重复编译字节一致回归，即 §10.3 通过门槛；残余风险是防线与编译器共用文法假设时同源失守）；表达力天花板——checkpoint / input function 在 Plan 文法中的表达是最大未解问题，未解之前直写逃生门必须保留；Plan Schema 不过早冻结（schema_version + 演进策略，初期只冻结 modules/rules/targets/config 最小集）。

### 8.8 员工 / 专家模式（已实现验证）

同一个 Agent 有两档运行模式，本质是「三件事按 mode 取值」：**模型 + system prompt 变体 + 工具门控**。基础铁律六条、submit 三道闸、confirm_submit 本人应答、写路径边界在两档模式下**无一放宽**——专家授权改变的是 Agent 可以主动做什么，不是可以越过什么。

| | 员工模式（standard，默认） | 专家模式（expert） |
|---|---|---|
| 模型 | `FLOWAGENT_MODEL` | `FLOWAGENT_MODEL_EXPERT`（未设置则回退员工模型） |
| system prompt | 基础 SOP | 基础 SOP + 专家授权段（见下） |
| 工具 | 基础工具集 | 额外注册 `analyze_history`（台账/gap_log 复盘：by_op 统计、同签名连续失败清单、高频缺口排行）与 `write_rule_proposal`（rule 入库提案起草） |
| 台账 | 每条记录带 `mode` 字段——事后能区分「员工干的还是专家干的」 | 同左；三道闸不按 mode 过滤（dry-run 与批准记录跨模式通用） |

**专家授权段**（追加在基础 SOP 之后）授予五项主动能力：①主动体检——基于台账与 gap_log 复盘，发现值得行动的模式时主动报告，不等用户问；②起草 rule 入库提案；③扩展修复策略——同一签名失败第二次即换策略（重排 use rule 顺序、调整 target 表达、改 config 来源），并在台账 reason 写明「上次为什么没成、这次为什么不同」；④预判性动作——长链路或首次构建时主动 `dry_run(create_envs_only=true)` 预建环境、主动 detailed_summary 前置暴露规模风险；⑤流程优化建议——发现 rule 库结构性问题（端口命名不一致、catalog 同义词缺失、manifest schema 缺失）时主动提出修订建议。

**授权的对价（专家义务）**：每项主动动作落台账、reason 写清「依据什么判断该做」；结论与建议标注置信度（高/中/低）与依据来源（manifest 条目 / 端口记录 / 台账记录 / 推测），低置信度给选项而不是替用户定；用户驳回的主动建议记录驳回原因并停止该方向；专家授权不延伸到 confirm_submit——规模确认与正式提交仍必须由用户本人应答。

**proposals/ 与 rule 库的边界**：`write_rule_proposal` 只写 `proposals/<日期>_<名称>/`（manifest.yaml + .smk + RATIONALE.md，经越界防护解析、只允许新建、拒绝覆盖，写路径与 composed/ 同级纳入白名单）。**提案文件不是 rule 库**——入库仍走 §7.1 人工审核门禁；本工具无法改 `rules/*.smk` 任何既有文件。

**切换方式**：HTTP 由 `POST /api/chat` 请求体逐条携带 `mode: "standard" | "expert"`（非法值 400；服务端无状态，切换下一条消息生效），`GET /api/mode` 向前端按钮提供可用模式、双模型 ID、expert 是否已配置与切换确认文案；CLI 用 `/expert`、`/standard` 斜杠命令切换、`/mode` 查看，`--expert` 启动参数直接进入。

**评测双基线**：专家模式换了模型，同一 SOP 在两档模式下行为基线不同——`run-eval` 须两档各跑一遍（`--mode both`），否则无法区分「退化是模型换档造成的还是 prompt 改坏了」。

---

## 九、阶段化实施与验收

### 9.1 阶段 0：流程现状审计

只查不改，产出模块/rule 清单、I/O 衔接、config key、helper 和动态 I/O 清单、入口上下文、样本配对现状、环境与参考依赖清单。抽查文件和行号必须能对应实际代码。

### 9.2 阶段 1：Manifest 与 Rule 版本试点

选 rules/03.short_read_qc.smk 建立 manifest、rule_id、环境声明、最小测试和一个 Rule Release Bundle。验证 manifest、代码、helper、配置和环境能共同完成加载、dry-run 与最小运行。

### 9.3 阶段 2：校验器、端口和 catalog

建立 validate_manifests.py、端口属性兼容检查、catalog、派生索引、validation policy 和结果校验插件。故意修改 manifest、环境或输出结构时，CI 必须识别漂移或回归。

### 9.4 阶段 3：PipelinePlan 与确定性编译器

实现 PipelinePlan Schema、版本解析器和固定模板编译器。优先支持标准入口；确认 bootstrap 和上下文契约后，再支持组合模块。Agent 不得直接生成任意生产代码。

### 9.5 阶段 4：Build/Run 端到端验收

- 方案审核：Agent 生成 AnalysisPlan，专家修改或批准；改变科学含义后必须生成新修订。
- 候选 pipeline：复用已发布 rule，生成 PipelinePlan 和编译产物，经过 dry-run、最小运行、结果校验和专家审核后发布。
- 候选 rule：新增/修改 rule 连同依赖和测试进入独立入库门禁。
- 运行授权：分别验证 autonomous、supervised、manual；未经授权的科学调整、版本变更和锁漂移必须被阻断。
- 故障处理：验证日志诊断、授权内 rerun-incomplete、专家核对和重试熔断。
- 历史回退：从旧 pipeline release 创建新 run，不覆盖现有输出，并能通过 run lock 还原代码、环境、参考和配置。

### 9.6 阶段 5：平台化 Agent

在上述资产稳定后，再决定采用 MCP、Agent SDK、CLI 或 Web UI。SDK 是实现选择，不应成为 manifest、release、lock 和验证契约的前置依赖。

**参考实现**：`FlowAgent/` 是 §8.1 第 3 级（自建 Agent 应用）的骨架，已按 §8.3/§8.4 实现 12 个基础工具（含 client-side 人工确认通道）+ 2 个专家模式工具（§8.8，员工模式不注册）并通过 46 项无 LLM 回归自测（含三层防线对抗用例、with 块路径逃逸、注释截断载荷、惯用语法放行、三道闸、熔断签名）与 LLM 在环验收；其实测结论已回写 §4.1/§4.3/§4.6/§8.2/§8.3/§8.6/§8.7/§8.8。接入真实仓库时把 `FLOW_WORKFLOW_ROOT` 指向完成阶段 0~3 资产的仓库即可，后端零绑定。配套 `eval/cases.yaml` + 评测脚本（自然语言需求 → 期望 rule 链，四档命中率）用于区分「rule 库退化」与「组装退化」：rule 库新增 rule、改 SOP prompt、改端口签名结构时各跑一遍；专家模式换模型后须按 §8.8 双基线各跑一遍。


---

## 十、Todo：从技术验证到 Agent 平台

本节是当前实施清单。四个阶段必须按顺序推进；每一阶段形成证据并通过门槛后，才能冻结下一阶段的接口。Todo 中的“完成”指代码、测试、文档和验收记录均已提交，而不是仅完成讨论。

### 10.1 Snakemake 组合 spike：验证 A1

**目标**：证明语义端口、路径绑定和现有 Flow 入口上下文能够落地为真实 Snakemake DAG。

**工作流**：

1. 固定 Snakemake 8/9 版本和一个可运行的 executor/profile；记录平台与插件版本。
2. 选择 `03.short_read_qc.smk` 与一个下游模块，建立最小 fixture、样本表和配置。
3. 分别测试标准入口模式、`module`/`use rule`、rule 命名空间、`ruleorder` 和必要的 `with:` 重写。
4. 验证 output/input pattern、wildcard、`expand`、directory、log、benchmark、conda 和 workdir 的解析结果。
5. 验证 `samples`、`config`、`logger`、`rule_resource`、`workflow` 等上下文的 bootstrap 方式。
6. 单独记录 checkpoint、input function 和动态输出的限制；含 checkpoint 的测试禁止使用 `--immediate-submit`。
7. 生成 rulegraph、DAG、dry-run 和最小真实运行证据，记录不能组合的旧模块。

**交付物**：`spikes/snakemake-composition/`、测试 Snakefile、fixture、运行日志、限制清单和 A1 决策记录。

**通过门槛**：至少一个跨模块组合可重复通过加载、dry-run 和最小运行；失败路径能定位到明确的上下文、路径或 Snakemake 机制限制。未通过时，PipelinePlan 只能支持标准入口模式，不能冻结任意模块组合接口。

### 10.2 阶段 0 审计：建立现状基线

**目标**：只读审计现有流程，避免新契约建立在错误假设上。

**工作流**：

1. 枚举所有 Flow 入口、module、rule、helper、脚本和环境文件。
2. 提取 rule 名、输入输出、`config[...]`、全局变量、`expand`、input function、checkpoint、`unpack`、目录输出、日志和 benchmark。
3. 识别 executor、profile、jobs、default-resources、队列映射和支持平台；记录实际 Snakemake 与插件版本。
4. 盘点 Conda YAML、锁文件、channel、容器、参考基因组和索引依赖。
5. 形成 module 上下文矩阵：每个模块需要的 config、samples、logger、helper、workdir 和 bootstrap。
6. 盘点样本表、配对表、参考配置和运行目录的实际格式与变更步骤。

**交付物**：`audit/` 下的模块/rule 清单、I/O 表、config key 表、helper/context 表、动态 rule 清单、环境/profile 清单和风险登记。

**通过门槛**：抽查的文件行号、config key、动态 rule、executor/profile 与实际代码和运行配置一致；未建档或存在歧义的模块标为禁用自动组链。

### 10.3 冻结 PipelinePlan 与编译器接口

只有 spike 和审计通过后执行。先定义 PipelinePlan Schema、版本解析器、依赖闭包解析、端口属性兼容检查、确定性编译器和 lock 生成器。

**工作流**：

1. 将 AnalysisPlan 复审矩阵转成机器可执行策略。
2. 定义 `existing_entry` 和 `compiled_modules` 的能力边界。
3. 固定 Plan → config/样本表/target 或组合 Snakefile 的模板；禁止模型直接生成任意生产代码。
4. 编译后自动运行 manifest 校验、Snakemake 加载、dry-run、summary 和 lock 一致性检查。
5. 将 rule、环境、executor/profile、参考、validator、Skill 和编译器全部写入 release lock。
6. 用 spike 的真实样例完成回归测试，冻结 Schema 版本和向后兼容策略。

**通过门槛**：同一 Plan 在干净工作目录重复编译结果一致；生成文件可被 Snakemake 加载；lock 能还原全部直接和传递依赖；改变科学字段能触发重新审核。

### 10.4 Agent 平台开发

在接口冻结后实现 Build/Run Agent，不把 Agent 平台开发反过来决定流程契约。

**Build**：查询 catalog/ports/rules → 生成 AnalysisPlan → 专家审核 → 生成 PipelinePlan → 编译 → 四级验证 → 生成评审包 → 发布 pipeline 或候选 rule。

**Run**：选择不可变 release → 生成 pre-run lock → 预检与 dry-run → 按 autonomous/supervised/manual 授权 → 提交和监控 → 读取日志 → 执行授权内修复或转专家 → 生成 post-run manifest → 结果校验与交付。

**平台验收**：验证未经授权的提交、锁漂移、recalled release、科学参数修改和跨租户访问均被工具层阻断；验证失败任务重试、checkpoint post-run manifest、历史 release 复跑和 `rerun_release` 回退；记录 Agent 成功率、专家驳回率、验证拦截率和越权拦截率。

---

## 十一、风险与回退原则

| 风险 | 应对 |
|---|---|
| rule/manifest/环境漂移 | 同一原子变更或明确依赖锁；CI、hash 和不可变 release |
| Agent 生成错误 | 只生成 Plan，确定性编译；Schema、dry-run、最小运行和专家审核 |
| 组合文件夹带可执行代码 | 写盘前三层防线（§8.2）：语句白名单、路径约束（含 with 块路径字段与 rule all target）、表达式限字面量；可选降权执行 |
| 受约束生成的组装语义错误（E1–E5，§8.7） | 过渡期靠 confirm 摘要人工确认（规模+dag_tree+资源档位）；按 §8.7 迁移触发条件推进 Plan 校验器 + 确定性编译 |
| 科学方案错误 | AnalysisPlan 专家审核；结果异常进入 NEEDS_REVIEW |
| 自动修复越权 | execution policy、动作白名单、审批服务和工具层 submit guard |
| 熔断失效（签名漂移） | 归一化报错签名（异常类型+rule+消息骨架）+ 分桶（§8.6） |
| 样本表错误烧熔断 | sample_table 桶直接升级人工不计熔断（§8.6） |
| 参考数据被替换 | 对象存储不可变版本、hash 校验，禁止自动改用 latest |
| 环境源失效 | Conda lock、平台记录、镜像/包制品缓存 |
| 本地执行占满整机 | 提交固定 `--cores` 上限，来自部署配置，Agent 不可改（§8.3） |
| 版本回退覆盖结果 | 隔离 checkout、独立 run_id 和输出目录 |
| 动态 I/O 不可静态预测 | 标记高风险，实际 dry-run 和最小运行验证 |

任何阶段出问题，新增资产均应以增量方式叠加，不得改变既有生产 release；需要修改生产 rule 时只能发布新版本。

---

## 十二、结论与残余边界

本方案把开放式生成降维为：检索已审核 rule → 专家审核科学方案 → 结构化计划 → 确定性编译 → 自动验证 → 专家批准发布 → 按授权策略运行。它支持同一个 Agent 兼任 Build 和 Run，也支持 rule、环境、pipeline、参考数据和运行实例的完整版本锁定，因此可以服务新流程建设、客户历史版本复跑、升级比较和回退。

结果校验不需要额外的必选 Agent：校验器负责可重复计算，组学 Skill 负责方法知识和异常解释，专家负责科学判断。可选的第二意见 Agent 不能替代校验器或人工审核。

仍需明确的边界：dry-run 不证明科学正确；锁定版本不保证所有工具逐字节确定；Agent 不能替代专家对新研究设计的判断。凡是改变科学含义的调整，都必须回到 AnalysisPlan 和发布审核流程。

---

## 附录：命令与记录速查

```bash
snakemake -n <targets>
snakemake --conda-create-envs-only <targets>   # 预建全部 conda 环境，排掉网络/源问题
snakemake --detailed-summary <targets> > validation/detailed-summary.txt
snakemake --dag <targets> | dot -Tsvg > dag.svg
snakemake --rulegraph=dot <targets> | dot -Tsvg > rulegraph.svg   # 9.19+ 需显式 =dot
snakemake --lint
snakemake --list-target-rules
snakemake --rerun-incomplete
snakemake --cores <部署配置上限> --rerun-incomplete --set-resources RULE:mem_mb=8192 <targets>
python agent/validate_manifests.py
python agent/validate_plan.py plan.yaml
python agent/compile_pipeline.py plan.yaml

# FlowAgent 后端(第 3 级参考实现):
npm run selftest                 # 无 LLM 自测(工具层 + 三层防线对抗用例)
npm run eval -- --mode both      # LLM 在环评测:员工/专家双基线(§8.8)
curl localhost:3090/api/mode     # 模式发现:双模型 ID、expert 是否配置、切换文案
```

每次 Build/Run 至少保存：release.lock.yaml、pre-run lock、post-run manifest（含 checkpoint 时必需）、有效 config、样本表、reference lock、环境 lock、dry-run、summary、validation.json、approval 和 JSONL ledger。大文件放对象存储，记录 URI、版本 ID 和 SHA-256。

[^1]: Masera M, Leone A, Köster J, et al. Snakemaker: Seamlessly transforming ad-hoc analyses into sustainable Snakemake workflows with generative AI[J]. arXiv preprint:2505.02841, 2025.
