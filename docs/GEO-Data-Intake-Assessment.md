# 评估：从 GEO 编号直接开始分析的能力（基于 polariseq）

> 日期：2026-10-12
> 背景：已自研 [polariseq](https://github.com/xsx123123/polariseq)（v1.4.3，Rust，ENA/SRA/GEO/GSA 高速下载 + MD5 校验），评估将其接入 Flow 规范 / FlowAgent，实现"给一个 GEO 编号就能开始分析"。
> 关联文档：[Flow-AI_Rule_Orchestration.md](planning/Flow-AI_Rule_Orchestration.md)（下称「规范」）、[Flow-Workflow-Onboarding-Guide.md](planning/Flow-Workflow-Onboarding-Guide.md)（下称「入库手册」）。

---

## 一、结论

**可以加，与现行规范 fit 很好，改动以"拼装"为主，不需要造新体系。**

推荐开法（最小且治理上最干净的路线）：

```
GEO ID ──(解析 PRJNA)──> polariseq 下载 ──> FASTQ + ena_metadata.tsv
样本表（人提供，含 sample 名/分组/R1R2）──────────────┘
        ↓ 一致性校验（sample_table 桶）
现有流程入口（MD5 门控 → QC → 下游分析）
```

即 **GEO ID + 人供样本表** 即可启动分析；自动从 GEO 元数据抠分组的能力作为后续增强。

---

## 二、与现行规范的契合点

1. **数据获取本就在规范边界内**。`ports.yaml` 中外部输入端口标 `external: true`（入库手册 §4），"数据从库外进来"是已建模的概念。GEO 直接分析只是把"用户手工拷 FASTQ"替换为"Agent 经审批自动拉取"，Build/Run 主链路不变。

2. **polariseq 产物与 flow-framework 入口契约高度对齐**：
   - `ena_metadata_{ACCESSION}.tsv`（样本/Run 对应关系）→ 可转换对齐 `config/samples.csv`（首列 `sample`）；
   - 自动生成的 R1/R2 MD5 文件和 `md5.txt` → 正好喂给 flow-framework 的 **MD5 门控**（`02.file_convert_md5`，入库手册 §2 第 5 条要求建模为 `role: gate`）；
   - 规范 §8.1 提到 demo 已实测"vendor fastq → Rust 二进制标准化与 MD5 门控 → fastqc/multiqc 全链"——"Rust 二进制做数据入口"已有先例。

3. **审批与台账机制现成**。下载属写操作/外部副作用，规范 §8.3 已有"写操作 `reason` 必填落台账 + confirm_submit 本人确认 + 三道闸"框架，intake 挂进去即可，无需新造治理。

4. **可复现性有明确落点**：pre-run lock（§4.6）记录 GEO accession、解析出的 PRJNA、SRR 清单、ena_metadata 快照与 md5.txt，"从编号开始"也成为可审计、可复跑的输入身份。

5. **样本表治理天然吻合**：样本表在规范里属 `sample_table` 桶——错误直接升级人工、Agent 只读（§8.6）。人提供的表出问题不会烧熔断，恰是该机制的设计目的。

---

## 三、缺口分析

### 缺口 1：polariseq 不能直接吃 GSE 编号（必改）

README 明确：GEO 需用户自行从 GEO 页面找 BioProject ID 再传 `-A PRJNA...`。
**解法**：给 polariseq 加 GSE 直接解析（GSE → PRJNA → SRR），用 NCBI eutils 即可（README 已有 `esearch -db sra -query "GSEXXXXXX"` 先例）。工作量小。

### 缺口 2：GEO 分组元数据拿不到（已被"人供样本表"路线绕过）

AnalysisPlan（§4.4）强制要求样本分组、对照、配对、协变量；这些信息在 GSM 样本注释里，不在 SRA run metadata 里。
- **当前方案**：人提供样本表，分组直接进 AnalysisPlan，自动解析链路不需要。
- **后续增强**（有高频需求再做）：GEOquery 式解析 GSM 注释 → 自动生成带 group 列的样本表草稿，人工确认后使用。

### 缺口 3：规范中没有这个能力的"名分"（需补一小节）

建议规范新增**数据接入（data intake）**小节，明确：

- catalog 可加"从 GEO 编号开始分析"的 deliverable/入口；
- intake 是受审批的 **Agent 系统工具动作**（§3.1 第二类资产），不是 rule 库代码，不违反"Agent 对规则库只读"铁律；
- 下载体积/资源档位进 confirm_submit 确认摘要（§8.3 规模确认）；
- intake 生成的样本表按 `sample_table` 桶规则处理；
- run lock 增加 intake 身份字段（GEO accession、PRJNA、SRR 清单、ena_metadata 快照引用）。

---

## 四、落地路径

| 步骤 | 位置 | 内容 | 性质 |
|---|---|---|---|
| 1 | polariseq | 加 GSE→PRJNA→SRR 直接解析（`download -A GSE123456` 或新增 `geo-resolve` 子命令） | 必改 |
| 2 | FlowAgent | 新增 intake 工具（如 `fetch_geo_data`）：输入 GEO ID + 样本表 → 调 polariseq（用 `--filter-run`/`--filter-sample` 按表过滤，避免全量下载）→ 产物落 `runs/`、写台账、产 md5 门控文件 | 新增工具 |
| 3 | FlowAgent | 一致性校验器：样本表每个 sample 能在 ena_metadata 匹配到 run、R1/R2 配对完整、无通配符冲突；不匹配报 `sample_table` 桶升级人工 | 新增校验 |
| 4 | 规范 | 增补"数据接入"小节 + catalog 条目 + run lock 字段 | 文档改动 |

### 风险控制项

- **GEO→SRA 同步延迟 1–4 周**（README 已写明）：intake 必须先 esearch 预检；数据未就绪时给用户明确提示，**不得重试烧熔断**。
- **TB 级下载资源**：接执行策略的资源预算与租户磁盘配额（§8.5）；确认摘要必须含下载总量。
- **数据可变性**：S3/ENA 侧数据可能变化，ena_metadata 快照 + md5 进 run bundle，保证事后可核对。

---

## 五、范围建议

- **MVP**：`GEO ID + 人供样本表` → 下载 → MD5 门控 → **QC 质控交付物**（MultiQC 报告）。
- **二期**：接入下游定量/差异分析（样本表分组已满足 AnalysisPlan 要求，可直接走）。
- **远期**：GSM 注释自动解析生成分组草稿，覆盖"用户连样本表也不想写"的场景。

## 六、一句话总结

**GEO ID + 人供样本表是这条路线最小且治理上最干净的开法**：polariseq 当下载引擎、FlowAgent 当审批编排、规范补一个 intake 概念；最大的工作点不在下载，而在（已被绕过的）GEO 分组元数据解析。
