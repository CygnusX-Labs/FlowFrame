# Snakemake 自动组装系统：审核报告核对 + 修复实施手册

> 本文档基于编码 Agent 的审核报告（13 条评审逐项核实版）做交叉核对。
> 结论：报告的 13 条判定中 10 条认可；报告自身存在 6 处问题，其中 P0 修法建议
> 修不干净（留三个绕过面）。修复按四阶段推进，每阶段附 paste-ready 提示词。
> 验收权在用户手里，不接受编码 Agent 自报通过。

---

## 一、核对总表

| 条目 | 报告判定 | 核对结论 |
|---|---|---|
| #1 write_composed 无代码审查层 | 半真，顶层 Python 绕过实测复现（P0） | ✅ 认可，但**修法建议不完整**（见问题 1） |
| #2 修复权限过宽 | 已规避，比建议更严 | ✅ 认可，但"样本表改不了"是闭环断点（见问题 5） |
| #3 dry_run 通过 ≠ 能跑通 | 大部分规避，原评审前提有误 | ✅ 接受纠正（-n 会抛 MissingInputException）；但"资源检查不适用"洗白了本地护栏缺口（见问题 2） |
| #4 端口匹配靠 LLM | 已规避（结构化端口签名） | ⚠️ 与 #12 的"pattern 可选"矛盾（见问题 3） |
| #5 query_catalog 误匹配 | 部分成立（关键词子串匹配） | ✅ 认可，补充：子串匹配有漏召回方向（同义词表） |
| #6 熔断一刀切 | 确实存在 | ✅ 认可；前置：composed config 需开放 resources 写口 |
| #7 提交幂等性 | 基本规避（snakemake workdir 锁） | ⚠️ 未澄清 composed 目录与 workdir 的关系，锁有效性以此为前提 |
| #8 续跑无限循环 | 已规避（stepCountIs(30)） | ✅ 认可，但熔断的报错签名归一化未核（见问题 4） |
| #9 confirm 信息不够 | 部分成立 | ✅ 认可，列阶段 2 |
| #10 可复现性 | 部分成立（rule 库版本/样本表未固化） | ✅ 认可；修法前置：确认 rule 库是否 git 管理 |
| #11 无审计日志 | 基本规避，"指控过重" | ❌ **维持原判**：操作审计 ≠ 决策理由（见问题 6） |
| #12 入库 lint 门禁 | 部分成立 | ✅ 认可；pattern 必填与 #4 绑定修复 |
| #13 config_requires 仅存在性 | 确实存在 | ✅ 认可，列阶段 1 |

---

## 二、报告自身的 6 处问题（按严重度排序）

### 问题 1（P0）：报告的修法建议留三个绕过面

报告建议"语句级白名单，只放行 include/configfile/workdir/module/use rule/rule all"。
但白名单语句本身仍可携带恶意载荷：

1. **`module x: snakefile: "<路径>"` 指向库外任意文件**——报告自己在核实部分点名过
   这个攻击面，修法里却没有对应约束。必须：module/configfile/include 的路径经
   `os.path.realpath` 解析后，必须位于 rule 库根目录内（防 `../` 与符号链接逃逸）。
2. **`use rule ... with:` 块内的字段值是 Python 表达式，会被 Snakemake 求值**——
   `params: x=__import__("os").system("...")` 在语句白名单下照样执行。必须：with 块
   只放行白名单字段（input/output/params/threads/resources/log/benchmark），
   值限字面量（str/int/float/bool/list/dict/None），禁止调用、属性访问、dunder、
   下划线开头的名称。
3. **`rule all: input:` 同为表达式**——同上约束，最多放行 `expand()` 一个受信函数。

实现注记：Snakefile 的 `rule`/`use rule` 是 Snakemake DSL 而非合法 Python，
纯 `ast.parse` 不可用。可行路径：先按顶层语句切块（Snakemake parser 的同款思路），
语句头匹配白名单；块内的表达式片段（with 块赋值、rule all 的 input 列表）单独
用 `ast.parse(expr, mode="eval")` 校验节点类型白名单。工作量在表达式约束与路径
约束，"约 20 行"的估计偏低，按 100~150 行 + 对抗测试预算。

纵深防御（可选，不阻塞阶段 0）：dry_run 进程降权执行（独立低权限用户或 bwrap/容器），
即使白名单被绕过也把爆炸半径限制在 composed/ 目录内。

### 问题 2：#3 的"资源检查不适用"洗白了本地护栏缺口

当前 submit 是本地后台进程（集群为 README 明示未接项）。本地执行**更需要**资源
护栏：无 `--cores`/`--jobs` 上限时 Snakemake 默认占满本机核数，LLM 组一个上百
job 的流程会直接打满机器。submit_cluster 应固定携带 `--cores <上限>`（上限来自
部署配置，不让 LLM 决定），与集群未接项无关。

### 问题 3：#4 与 #12 的内部矛盾

#4 判"端口匹配是确定性的"，依据是 manifest 的结构化端口签名；#12 承认
`io.port` 必填但 `pattern` 可选。pattern 可选 ⇒ 未填 pattern 的 rule 无法做确定性
端口匹配，实际退化为全靠 dry_run 兜底。两条必须一起修：pattern 改必填，
validate_manifests 加硬性检查。

### 问题 4：熔断的报错签名归一化未核

铁律 6 是"同一报错 2 次熔断"。若报错签名直接取原始报错文本（含绝对路径、临时
文件名、时间戳），每次失败签名都不同，熔断永不触发，只剩 30 步全局兜底。
需确认签名提取做了归一化：仅保留异常类型 + rule 名 + 去除路径/数字/引号内容后的
消息骨架。

### 问题 5：样本表只读是闭环断点（#2 的遗留）

样本表错误是 dry_run 失败的高发原因，而 LLM 无任何样本表写工具——"失败→修复→
续跑"循环遇到样本表问题必死，白白烧掉熔断次数。最低成本修法：SOP 对策表增加
"样本表类错误（文件不存在/列缺失/样本名与通配符冲突）→ 直接升级人工、不计入
熔断计数"。中期可评估受限写入工具（schema 校验 + 限定目录 + 台账记录），
本轮不做。

### 问题 6：#11 维持原判——操作审计 ≠ 决策理由

台账记录的是 op 事件（做了什么、结果如何），原评审要求的是"LLM 每一步为什么
这么选"。报告承认选择理由只在对话记录里——对话记录不进 run bundle、不可检索、
随会话丢失，生物信息场景出静默错误后无法回溯"为什么走了这条链"。止血修法
极便宜：台账 schema 增加 `reason` 字段，write_composed / submit_cluster /
write_gap_log 调用时强制 LLM 填一句选择理由（一句话即可，落进 jsonl）。

### 小项两条

- **#7**：报告未澄清"组合目录每次新建、永不覆盖"与 workdir 的关系。Snakemake 锁
  在 workdir 级——若重复提交生成新 composed 目录但共享同一 workdir，锁有效；若
  workdir 随 composed 新建，重复提交将全量重跑（浪费但不出错）。需在手册验收时
  确认实际行为。另外台账 pid 在机器重启后可能因 pid 复用误判"已有活跃 submit"。
- **#5**：关键词子串匹配只防了"误拿"，没防"漏召回"——用户措辞与 catalog 条目名
  不一致时（如"差异分析" vs "differential_expression"），有现成 deliverable 也
  匹配不上，白走一遍组装流程。加固：catalog 条目加同义词/标签表。

---

## 三、分阶段实施

### 阶段 0（P0，立即施工）：write_composed 三层防线

目标：把 write_composed 的校验从"正则挡 rule 定义"升级为三层防线，并补对抗测试。

```text
任务：加固 write_composed 的生成物校验，只查改 writes.ts 与其测试，不动其他模块。

背景：已实测确认 Snakefile 顶层 Python 代码在 snakemake -n 解析阶段即执行，
dry_run 发生在 confirm_submit 人工卡点之前，现有正则只拦截 rule X: 定义，
挡不住顶层 import/subprocess、module 指向库外路径、use rule with 块表达式、
rule all input 表达式四类载荷。

要求把校验升级为三层（在现有正则防线之后追加，不是替换）：

1. 语句级白名单：解析生成的 Snakefile，顶层只允许以下语句——
   configfile: / include: / workdir: / module X: / use rule ... from ... as ... [with:] /
   rule all: 以及注释与空行。出现任何其他顶层语句（import、赋值、函数定义、
   其他 rule 定义、shell/run 块）一律拒绝并列出违规行号。
   注意 Snakefile 是 DSL 不是合法 Python，先按顶层语句切块再逐块判定。

2. 路径约束：configfile/include/module 的 snakefile 路径经 realpath 解析后
   必须位于 rule 库根目录内，拒绝 ../ 逃逸与库外绝对路径。

3. 表达式约束：use rule 的 with 块只放行 input/output/params/threads/resources/
   log/benchmark 字段，值经 ast.parse(mode="eval") 校验，只允许字面量节点
   （str/int/float/bool/list/dict/tuple/None），禁止 Call/Attribute/Name(非字面量)/
   任何下划线开头名称；rule all 的 input 同标准，仅额外放行 expand() 调用
   （其参数仍限字面量）。

4. 对抗 selftest 必须新增并全部通过：
   a. 顶层 import os / open(...).write(...) 载荷 → 拒绝
   b. module x: snakefile 指向库外路径（含 ../ 逃逸）→ 拒绝
   c. use rule ... with: params: x=__import__("os").system("id") → 拒绝
   d. rule all: input: [__import__("os").popen("id").read()] → 拒绝
   e. 现有 demo 的三个合法组合 Snakefile 全部仍放行（防误伤回归）

交付：改动 diff + selftest 全部输出。改完说明每层防线各自挡住哪类载荷。
```

人工验收 checklist：

| 操作 | 期望现象 | 不通过处理 |
|---|---|---|
| 让 LLM 组一个现有 demo 流程并 dry_run | 正常通过三层校验并 dry_run 成功 | 查是否误伤合法语法，贴报错给编码 Agent |
| 手工在 composed Snakefile 顶层加一行 `import os` 后重新触发校验 | write_composed/校验器拒绝并指出行号 | 阶段 0 不通过，回退 |
| 把 demo 的 module 路径改成库外路径 | 拒绝 | 同上 |
| 在 use rule with 块写入函数调用表达式 | 拒绝 | 同上 |

### 阶段 1（与阶段 0 同一轮）：config schema + 熔断分桶 + 本地资源护栏 + 决策理由

```text
任务：四项中小改动，均限定在既有模块内，禁止引入新工具。

1. config_requires 升级为 JSON Schema（#13）：
   manifest 的 config_requires 从 key 列表升级为每项支持
   {type, enum, minimum/maximum, pattern, default, description} 子集；
   check_config 按 schema 校验 composed config 副本，报错带字段路径与期望约束；
   现有只写了 key 列表的 manifest 视为 type:any 保持兼容，validate_manifests
   新增"建议补 schema"的 warning（不强制）。

2. 熔断分桶 + 报错签名归一化（#6）：
   - 报错签名 = 异常类型 + rule 名 + 去除路径/数字/引号内容后的消息骨架，
     熔断按归一化签名计数（同一签名 2 次熔断不变）；
   - SOP 对策表按错误类型分桶：MissingInput/通配符冲突/歧义 rule → 可修复重试；
     样本表类错误 → 直接升级人工、不计熔断；OOM/节点瞬断 → 自动续跑不计熔断；
   - composed config 副本开放 resources 写口：允许 LLM 在白名单内调整
     内存/核数/重试次数（Snakemake 的 --set-resources 或 config 覆盖机制，
     二选一，写清选型理由），作为 OOM 自动加内存重试的前提。

3. 本地 submit 资源护栏（评审报告 #3 洗白项）：
   submit_cluster 固定携带 --cores <N>（N 来自部署配置，LLM 不可改），
   README 同步注明集群提交仍为未接项。

4. 台账 reason 字段（#11 维持原判项）：
   run_ledger.jsonl 的 write_composed/submit_cluster/write_gap_log 事件
   增加必填 reason 字段（LLM 调用时填一句选择理由），旧事件兼容缺省。

交付：四项各自的 diff + 对应测试 + README/SOP 文档同步更新。
```

人工验收 checklist：

| 操作 | 期望现象 | 不通过处理 |
|---|---|---|
| composed config 里把某数值字段填成字符串 | check_config 拒绝并指出字段路径与期望类型 | 查 schema 校验逻辑 |
| 连续制造同一报错 3 次（路径不同的同类 MissingInput） | 第 2 次触发熔断（签名归一化生效） | 若第 3 次仍未熔断，签名归一化未生效 |
| 制造一次样本表缺失错误 | SOP 直接要求人工介入，熔断计数不变 | 查对策表分桶 |
| 查看 run_ledger.jsonl | 新事件带 reason 字段且内容可读 | 查台账写入路径 |
| submit 时观察本机负载 | snakemake 进程带固定 --cores 参数 | 查 submit_cluster 参数拼装 |

### 阶段 2（加固，可独立排期）

```text
任务：四项加固，相互独立，可并行或拆分排期。

1. run bundle 固化（#10）：submit 成功后将 rule 库版本（git rev-parse HEAD；
   若 rule 库非 git 管理，改用全库 manifest 的联合 hash）+ 样本表副本 +
   composed 目录整体固化进 run bundle（runs/<task_id>/bundle/），台账记录
   bundle 路径。先确认 rule 库是否 git 管理再选型，两种路径都写出来。

2. pattern 必填 + 入库 lint（#12 + #4 矛盾项）：manifest 的 io.port.pattern
   改为必填，validate_manifests 拒绝缺 pattern 的新 manifest（存量给迁移清单）；
   入库检查追加 snakemake --lint（失败仅 warning 级，不阻断，输出进报告）。

3. confirm 信息增强（#9）：confirm_submit 前展示——DAG 文本树（snakemake
   --dag 转文本缩进树即可，不必画图）、资源预估（manifest 的 resources_tier
   汇总成总核时/峰值内存/预计磁盘）、本组合用到的 rule 及版本。

4. catalog 同义词表（#5 漏召回方向）：catalog 条目支持 synonyms/tags 字段，
   子串匹配同时对同义词表生效；匹配结果为空且用户需求疑似已有 deliverable 时
   （LLM 判断），SOP 要求明示"未命中现成 deliverable 的原因"再走组装。
```

### 阶段 3（体系）：LLM 在环评测集

```text
任务：建立"自然语言需求 → 期望 rule 链"回归评测集，区分 rule 库退化与组装退化。

1. 从现有 demo 与真实使用记录合成 20~50 对样本：{需求文本, 期望 deliverable
   或期望 rule 链, 期望命中的 manifest 版本}，落 eval/cases.yaml；
2. 评测脚本：逐条跑完整 agent 循环（mock confirm_submit 自动 y、
   mock submit_cluster 不真跑），比对 write_composed 产出的 rule 链与期望；
3. 输出命中率报告：完全匹配 / 链对但参数错 / 链错 / 误判断链 四档；
4. 接入节奏：rule 库新增 rule、改 system prompt、改端口签名结构时各跑一遍。
   本轮只交付评测集与脚本，不要求一次跑到高命中率——基线本身即是产出。
```

---

## 四、遗留确认项（下次施工前需回答的事实问题）

1. composed 目录每次新建时，workdir 是否共享？（决定 #7 snakemake 锁是否真能
   挡住重复提交，以及重复提交是 no-op 还是全量重跑）
2. rule 库是否在 git 管理下？（决定阶段 2 第 1 项的版本固化路径）
3. 熔断报错签名的现有提取方式（原始文本 or 已归一化）？（决定阶段 1 第 2 项
   是修补还是新建）
4. selftest 19 项中是否覆盖"无 human_decision 台账事件直接调 submit_cluster
   必须被拒"的对抗用例？（confirm_submit 卡点的防伪验证）

---

*文档版本：v1（首轮核对）。后续轮次的修复反馈与新评审追加到本文档新章节，不另起文档。*
