# Flow 流程入库操作手册

> 适用场景：将一个**按 flow-framework 规范创建**的 Snakemake 流程仓库（`<X>Flow/`）接入 FlowAgent，使其 rule 可以被 AI Agent 检索、组链、验证并在人工确认后提交运行。
>
> 相关文档：
> - 上级规范：`Flow-AI_Rule_Orchestration.md`（§4 资产格式、§7 五道门禁、§8 铁律、§9 入库流程）
> - 流程创建规范：`flow-framework/references/flow_framework_spec.md` + `flow-framework/SKILL.md`
> - 校验实现：`FlowAgent/src/tools/validate.ts`、`FlowAgent/src/tools/registry.ts`
> - 参考范例：`FlowAgent/demo/`（迷你仓库，所有资产的最小完整示例）

---

## 0. 核心概念：两套资产的关系

flow-framework 规范解决的是"**流程怎么写**"（.smk、config 四件套、utils、deliver/Report）；FlowAgent 入库要解决的是"**流程怎么被 Agent 理解和安全调用**"。后者需要在仓库中**新增一组 Agent 资产**：

```
<X>Flow/                          # 你的流程仓库（flow-framework 规范）
├── snakefile                     # 已有：流程入口
├── config/                       # 已有：config.yaml / reference.yaml / run_parameter.yaml / cluster_config.yaml / samples.csv
├── envs/                         # 已有：conda env 定义
├── rules/
│   ├── 01.common.smk             # 已有：rule 本体
│   ├── ...
│   └── manifests/                # ★ 新增：每条 .smk 对应一份 manifest（Agent 的唯一资产加载入口）
│       ├── 02.file_convert_md5.manifest.yaml
│       ├── 03.short_read_qc.manifest.yaml
│       └── ...
├── agent/                        # ★ 新增：Agent 元数据目录
│   ├── ports.yaml                # 端口中央注册表（所有输入输出的"类型系统"）
│   ├── catalog.yaml              # 最终交付物目录（用户会开口要的结果）
│   ├── gap_log.yaml              # 缺口日志（可由 Agent 工具维护）
│   └── run_ledger.jsonl          # 运行台账（工具自动追加，无需手工建）
├── composed/                     # ★ 新增（空目录）：Agent 生成的组合 Snakefile 落盘处
└── runs/                         # ★ 新增（空目录）：run bundle 可复现性快照落盘处
```

**映射关系**（flow-framework 资产 → FlowAgent 资产）：

| flow-framework 侧 | FlowAgent 侧 | 说明 |
|---|---|---|
| `rules/NN.<module>.smk` 编号+模块名 | manifest 的 `module.id` | 一一对应，直接沿用 |
| rule 的命名 input/output 槽 | manifest 的 `inputs[]`/`outputs[]` + `ports.yaml` | 每个命名槽登记一个端口 |
| `MODULE_DEPENDENCIES`（utils/common.py） | ports.yaml 的 producers/consumers | 模块依赖图靠端口衔接关系表达 |
| deliver 的 `delivery_manifest.json` 产物 | `catalog.yaml` 的 deliverable 条目 | 只有最终交付物进 catalog |
| config 四件套 + analysisyaml | manifest 的 `config_requires`（schema 对象） | 每条 rule 声明自己消费的 config key |
| 模块开关（only_qc/qc_clean/deliver/report 等） | `config_requires` 中的 boolean key | 组合时按 schema 强校验 |
| `envs/<tool>.yaml` | manifest 的 `conda` 字段 | 与 .smk 中 `conda:` 声明保持一致 |

> ⚠️ 注意铁律（§8.3）：**FlowAgent 对规则库只读**。上述新增资产是"人工编写 + 工具校验"的活；运行期 Agent 只能写 `composed/`、`agent/gap_log.yaml`、`agent/run_ledger.jsonl`、`runs/`、`proposals/`。

---

## 1. 入库总流程（对应规范 §7.1 五道门禁 + §9）

```
阶段0 审计 → ① 建 agent 资产骨架 → ② 登记端口 → ③ 编写 manifest
→ ④ 更新 catalog → ⑤ validate_manifests 清零 error → ⑥ dry-run
→ ⑦ 真实小样端到端 → ⑧ 专家审核 → ⑨ 接入 FlowAgent + 回归评测
```

预估工作量：一个 5~8 模块的流程，首次入库约 **0.5~1 天**（manifest 编写占大头）。

---

## 2. 阶段 0：审计（动手前必做）

盘点现有仓库，产出一张审计表：

1. **模块清单**：`rules/` 下每个 `NN.<module>.smk` 包含哪些 rule，各自干什么（一句话）；
2. **I/O 衔接**：每条 rule 的命名 input/output 槽、路径模板、哪些产物被下游谁消费——这直接决定端口设计；
3. **config key 清单**：.smk 和 utils 里所有 `config["..."]` 引用（`grep -rn "config\[" rules/`），标注类型、取值范围、默认值；
4. **环境依赖**：每个 rule 用的 `envs/*.yaml` 或 `general_software` 路径；
5. **门控确认**：flow-framework 的门控接线（`01.qc/md5_check.tsv` 作为 gate 输入）是否完整——入库时它要建模为 `role: gate` 的输入端口；
6. **交付物清单**：用户会"直接开口要"的最终结果有哪些（定量矩阵？差异分析表？MultiQC 报告？交付目录？）——这是 catalog 的唯一来源，**中间产物不进 catalog**。

---

## 3. 步骤①：建 agent 资产骨架

```bash
cd <X>Flow
mkdir -p rules/manifests agent composed runs
touch agent/gap_log.yaml   # 内容先写: gaps: []
```

`agent/run_ledger.jsonl` 不用手工建，工具首次落账时自动追加。

---

## 4. 步骤②：登记端口 `agent/ports.yaml`

端口是流程的"类型系统"：**同一名称的端口 = 语义可互换的产物**。命名建议沿用 flow-framework 的路径语义，属性（raw/trimmed 等）不同的产物必须用不同端口名。

```yaml
ports:
  raw_fastq_r1:
    description: "原始 R1 FASTQ（已经过 02 模块标准化重命名 + MD5 门控）"
    external: true            # 库内无生产者（来自用户原始数据）必须标 external: true
  raw_fastq_r2:
    description: "原始 R2 FASTQ"
    external: true
  md5_check:
    description: "MD5 校验通过标记（门控产物，01.qc/md5_check.tsv）"
    producers: ["02.file_convert_md5.md5_check"]
  qc_report_r1:
    description: "R1 FastQC 报告（raw 阶段）"
    producers: ["03.short_read_qc.fastqc_raw_r1"]
    consumers: ["03.short_read_qc.multiqc_raw_r1"]
  # ... 每个模块衔接处的产物都要登记
```

校验规则（`validate.ts:179-191`）：

- manifest 中引用的**每个 port 必须在此登记**（error）；
- 被消费但**无库内生产者**且未标 `external: true` → warning（外部输入忘了标会刷屏）；
- `producers` / `consumers` 是派生索引，格式 `"<module>.<rule>"`，可后补，但建议一次写全——它是 Agent 组链推理的重要线索。

> 端口属性（如 `processing: raw` vs `trimmed`）语义不可互换，靠**人工维护 description** 保证（§4.2）；机器校验目前只到 pattern 层。

---

## 5. 步骤③：编写 manifest（核心工作）

**每条 `rules/NN.<module>.smk` 对应一份 `rules/manifests/NN.<module>.manifest.yaml`**，命名必须一致。manifest 是 Agent 资产的**唯一强制加载入口**（`registry.ts:43-60` 只扫这个目录）。

### 5.1 完整模板

```yaml
# rules/manifests/03.short_read_qc.manifest.yaml
module:
  id: "03.short_read_qc"                # 不填则用文件名推导，建议显式写
  snakefile: "rules/03.short_read_qc.smk"   # 必填，相对仓库根；文件不存在直接报 error
  title: "短读长原始数据质控"
  stage: "01.qc"
  summary: "对原始 FASTQ 做 FastQC + MultiQC 汇总"

rules:
  - name: fastqc_raw_r1                 # 必填，必须与 .smk 中 `rule fastqc_raw_r1:` 精确一致
    summary: "对每个样本 R1 原始 reads 跑 FastQC"
    wildcards: ["sample"]               # 聚合 rule 写 []
    per_sample: true
    dynamic: false                      # 动态 I/O 的 rule 必须标 true（§8.3 铁律 3）
    inputs:
      - name: md5_check                 # 与 .smk 中命名槽一致
        port: md5_check                 # 必填，必须在 ports.yaml 已登记
        pattern: "01.qc/md5_check.tsv"  # 必填非空；{sample} 等占位符按非贪婪段匹配
        role: gate                      # 门控输入标此项
      - name: fq
        port: raw_fastq_r1
        pattern: "00.raw_data/link_dir/{sample}/{sample}_R1.fq.gz"
    outputs:
      - name: html
        port: qc_report_r1
        pattern: "01.qc/fastqc_raw/{sample}_R1_fastqc.html"
        kind: report                    # 报告类产物标 report，中间产物标 intermediate
      - name: zip
        port: qc_zip_r1
        pattern: "01.qc/fastqc_raw/{sample}_R1_fastqc.zip"
        kind: intermediate
    config_requires:                    # 推荐 schema 对象形式（旧式纯字符串会出升级 warning）
      - key: parameter.threads.fastqc
        type: integer
        minimum: 1
        default: 4
        description: "FastQC 线程数"
      - key: qc_clean
        type: boolean
        default: false
        description: "是否启用质控后清洗模块"
    conda: "envs/fastqc.yaml"           # 与 .smk 中 conda: 声明同步
    resources_tier: "low_resource"      # low_resource | high_resource；confirm 摘要的资源汇总依据
```

### 5.2 字段级强制规则（`validate.ts:117-210`）

| # | 规则 | 级别 |
|---|---|---|
| 1 | `rules/manifests/` 下至少有一份 manifest | error |
| 2 | `module.snakefile` 指向的文件必须存在 | error |
| 3 | 每条 `rules[].name` 必须能在 .smk 中找到 `rule <name>:` | error |
| 4 | 每个 input/output 必须有 `port` 且 `pattern` **必填非空** | error |
| 5 | 引用的每个 port 必须登记在 `agent/ports.yaml` | error |
| 6 | 外部输入端口未标 `external: true` | warning |
| 7 | .smk 里 `config['x']` 的顶层 key 未被模块内任何 rule 的 `config_requires` 声明 | warning |
| 8 | 旧式 `config_requires` 纯 key 列表 | warning（升级为 schema 对象） |

### 5.3 config_requires 的 schema 对象形式

支持的字段：`key`（点路径）、`type`（string/integer/number/boolean/array/object/any）、`enum`、`minimum`、`maximum`、`pattern`（正则）、`default`、`description`。

组合运行时，FlowAgent 会把 composed 目录的 config 副本按**全库 manifest 汇总出的 schema** 做类型/枚举/范围校验，报错带字段路径（`validate.ts:65-107, 238-253`）——schema 写得越严，Agent 组链时出错越早暴露。

> 与 flow-framework 侧的 `schema/config.schema.yaml` 分工：那个校验的是**项目级 analysisyaml**（snakefile Step 5 显式调用）；manifest 的 `config_requires` 校验的是 **Agent 组合时注入的 config**。两者都要写，前者照 flow-framework 规范，后者按本节。

### 5.4 flow-framework 特有结构的处理建议

- **门控**：`md5_check.tsv` 建模为独立端口，所有直接消费 FASTQ 的 rule 在 manifest inputs 里声明它并标 `role: gate`——与 flow-framework §4.3 门控接线一一对应，Agent 组链时会自动携带门控依赖；
- **聚合 rule**（MultiQC、deliver、Report）：`wildcards: []`、`per_sample: false`，聚合输入加 `expand_over: samples`；
- **deliver/Report 模块**：照写 manifest，但它们的产物是否进 catalog 取决于是否算"用户会直接要的结果"（通常 deliver 进、Report 进）；
- **utils/*.py 的 helper**：如果某模块强依赖 utils 函数，填 `module.requires_helpers: ["utils.datadeliver"]` 之类做声明（demo 均为 `[]`，属可选信息）。

---

## 6. 步骤④：更新 catalog `agent/catalog.yaml`

catalog 只放**最终交付物**，每条：

```yaml
deliverables:
  - id: qc_multiqc_raw
    name: "原始数据 MultiQC 质控报告"
    description: "全部样本原始 reads 的 FastQC 汇总报告"
    targets:
      - "01.qc/multiqc_raw/multiqc_report.html"   # 每个 target 必须能被某 rule 的 output pattern 匹配（error 级校验）
    keywords: ["质控报告", "QC", "multiqc"]
    synonyms: ["质控", "质量控制", "raw qc"]       # 同义词表防漏召回，中文场景务必写全口语说法
  - id: delivery_package
    name: "交付数据包"
    description: "按交付规范打包的全部结果文件"
    targets:
      - "{data_deliver}/delivery_manifest.json"
    keywords: ["交付", "deliver"]
    synonyms: ["数据交付", "结果打包"]
```

要点：

- `targets` 里的路径必须能被某条 rule 的 output `pattern` 匹配（`validate.ts:196-204`，error 级）——写 catalog 前先确认对应 manifest 已写好；
- `keywords` / `synonyms` 是 `query_catalog` 检索召回的唯一依据，**用户的口语说法要想全**（"定量矩阵" vs "表达矩阵" vs "count 表"）；
- 中间产物（bam、trimmed fq 等）不进 catalog——它们是端口，不是交付物。

---

## 7. 步骤⑤：跑校验，清零 error

每改一份 manifest / ports / catalog 后立即校验（§8.3 铁律 5）。两种方式：

**方式 A：通过 FlowAgent CLI 调工具**（推荐，走真实代码路径）

```bash
cd FlowAgent
FLOW_WORKFLOW_ROOT=/path/to/<X>Flow npm run cli
# 进入 REPL 后直接要求：
> 调用 validate_manifests 全量校验当前仓库
> 调用 validate_manifests 并开启 lint   # 追加 snakemake --lint（warning 级，不阻断）
```

**方式 B：仓库自带校验脚本**。如果仓库根放了 `agent/validate_manifests.py`，`validate_manifests` 工具会**优先调用它**替代内置检查（`validate.ts:255-269`）——可以把本手册的规则固化成脚本复用。

验收标准：**error 清零**；warning 逐条确认（config key 未声明、external 漏标、旧式 config_requires 三类最常见）。

---

## 8. 步骤⑥⑦：dry-run → 真实小样端到端

对应规范 §7.1 门禁 2-3，在 FlowAgent CLI 中：

```
> 用 demo 样本表组装一条 <某交付物> 的流程并 dry_run      # 门禁 2
> （如需先建环境）dry_run 时 create_envs_only=true        # 预建 conda env
> 提交运行                                                 # 门禁 3：confirm_submit 人工确认
```

注意三道闸（`snakemake.ts:313-340`）：submit 必须有 ① dry-run 成功台账记录 ② 未消费的人工确认（一次确认只放行一次提交）③ `FLOWAGENT_ALLOW_SUBMIT=true` 环境开关。

真实样本测试时：

- 把 `config/samples.csv` 换成真实样本表（首列必须 `sample`）；样本表错误会被归入 `sample_table` 桶，直接升级人工，Agent 不会瞎改；
- dry_run 失败时观察熔断分桶行为：同签名错误第 3 次自动熔断（retryable 桶），transient 类会自动续跑；
- submit 成功后检查 `runs/` 下的 run bundle（rule 库版本快照 + 组合副本 + config/样本表），确认可复现性。

---

## 9. 步骤⑧⑨：专家审核、接入与回归

1. **专家审核**（§7.1 门禁 4-5）：专家批准的是**适用范围与证据**，不只是"能跑"。审核材料：manifest 全集、dry-run 记录、run bundle、真实小样的输出核对结果；
2. **接入 FlowAgent**：后端零改动，把环境变量指过去即可：
   ```bash
   # FlowAgent/.env
   FLOW_WORKFLOW_ROOT=/path/to/<X>Flow
   ```
3. **回归评测**：rule 库变更后跑 `cd FlowAgent && npm run eval`（用例在 `eval/cases.yaml`，可按新仓库补充用例），对比基线区分"rule 库退化"与"组装退化"；
4. **缺口处理**：入库过程发现的端口断链、缺失 rule 写入 `agent/gap_log.yaml`（§7.3）；也可以用专家模式让 Agent 起草提案（`write_rule_proposal` → `proposals/<日期>_<名>/`，含 manifest.yaml + .smk + RATIONALE.md）——**提案不是 rule 库，仍需走人工门禁**。

---

## 10. 验收清单（入库完成的判定）

- [ ] 目录骨架齐全：`rules/manifests/`、`agent/{ports,catalog,gap_log}.yaml`、`composed/`、`runs/`
- [ ] 每条 .smk 有对应 manifest，`rule.name` 全部对得上
- [ ] 所有 input/output 有 `port` + 非空 `pattern`，端口全部登记
- [ ] 外部输入端口标 `external: true`
- [ ] 门控产物（md5_check）建模为 `role: gate` 输入
- [ ] `config_requires` 用 schema 对象形式，覆盖 .smk 里所有 config 引用
- [ ] catalog 只含最终交付物，targets 全部可匹配，同义词写全
- [ ] `validate_manifests` error 清零，warning 逐条有结论
- [ ] `validate_manifests(lint=true)` 的 `snakemake --lint` 输出已审阅
- [ ] dry-run 通过；真实小样端到端跑通且输出核对无误
- [ ] 三道闸行为验证：无确认不能 submit、一次确认不能 submit 两次
- [ ] run bundle 快照完整可复现
- [ ] 专家审核通过并记录
- [ ] `npm run eval` 回归无退化

---

## 附录 A：常见报错速查

| 报错/现象 | 原因 | 处理 |
|---|---|---|
| `manifest 的 snakefile 不存在` | `module.snakefile` 路径写错（须相对仓库根） | 改路径 |
| `rule <name> 在 .smk 中找不到` | name 与 `rule xxx:` 不一致（含大小写） | 对齐，注意 deliver/Report 的大写 R 例外 |
| `port <x> 未在 ports.yaml 登记` | 端口漏登记 | 补 ports.yaml |
| `pattern 为空` | input/output 漏写 pattern | 补路径模板 |
| `catalog target 无 rule 能产出` | target 路径与 output pattern 不匹配 | 检查占位符写法 |
| `.smk 引用了未声明的 config key`（warning） | `config_requires` 漏声明 | 补 schema 条目 |
| dry_run 同错误第 3 次被熔断 | retryable 桶保护 | 修复根因后用新签名重试 |
| submit 被拒：无未消费确认 | 三道闸拦截 | 走 confirm_submit 人工确认 |

## 附录 B：一页纸速查

```
新增资产：rules/manifests/*.manifest.yaml + agent/{ports,catalog,gap_log}.yaml + composed/ + runs/
manifest：每条 rule 声明 name/wildcards/inputs(port+pattern)/outputs/config_requires(schema)/conda/resources_tier
ports：语义命名，外部输入 external: true，门控 role: gate
catalog：只放交付物，targets 必须可匹配，keywords/synonyms 写全
校验：validate_manifests error 清零 → dry_run → 真实小样 → 专家审核 → FLOW_WORKFLOW_ROOT 接入 → npm run eval
铁律：Agent 对规则库只读；改 manifest 后必先校验；人按最后那个按钮
```
