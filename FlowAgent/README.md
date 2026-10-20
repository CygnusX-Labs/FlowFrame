<p align="center">
  <img src="docs/flowagent_logo_1.png" alt="FlowAgent Logo · 深蓝底版" width="220">
  <img src="docs/flowagent_logo_2.png" alt="FlowAgent Logo · 独立图形版" width="220">
</p>

# FlowAgent —— Flow(Snakemake) × AI Agent 编排后端

按《Flow × AI Agent:Rule 级自动编排与自修复技术规范》([总体规划](../docs/planning/Flow-AI_Rule_Orchestration.md))§8.2 / §8.3 / §8.4 实现的 Agent 后端:

- **循环底座**:Vercel AI SDK `streamText` + tools(不手写 tool-calling 循环),模型走 OpenAI 兼容接口(默认火山方舟,可换);
- **大脑**:SOP 蒸馏 system prompt(行为铁律 §8.3 + 报错对策表分桶 §8.6);
- **手**:15 个工具,全部只读仓库,写操作仅限 `composed/`、`agent/gap_log.yaml`、`agent/plans/`(科学方案)、`agent/run_ledger.jsonl`、`runs/<task_id>/<run_id>/`(submit 时固化快照,每次提交独立 run_id 目录);
- **界面**:`CLI 优先`(规范 §8.4),同时内置 HTTP server,暴露 `POST /api/chat`(Vercel AI SDK UI message stream),前端 `useChat` 直接对接。

## 运行机制

```text
用户自然语言需求
   ↓
LLM(带 SOP 系统 prompt)──循环调用──→ 15 个工具
   ↓
┌──────────────── 决策流程 ────────────────┐
│ 1. query_catalog   有现成 deliverable?──→ 直接拿 targets      │
│ 2. query_ports / query_rules  端口能否串成链                  │
│    ├─ 能 → write_composed 生成组合 Snakefile(module+use rule)│
│    │        └─ 三层防线校验:语句白名单/路径约束/表达式约束    │
│    └─ 断链 → write_gap_log 记缺口(reason 必填),不瞎猜       │
│ 3. 检查样本表/config(manifest 的 config_requires schema 校验)│
│ 4. dry_run(snakemake -n)── 报错按对策表分桶修复              │
│    ├─ retryable:可修重试(归一化签名 2 次后熔断)             │
│    ├─ sample_table:升级人工,不计熔断                         │
│    └─ transient/OOM:续跑或 set_resources 加内存,不计熔断    │
│ 5. detailed_summary ── job/文件 + rule 链树 + 资源档位汇总    │
│ 6. confirm_submit ── 暂停,等用户本人在终端 y/N               │
│ 7. submit_cluster ── 后台提交(--rerun-incomplete + 固定      │
│    --cores 上限),自动固化 run bundle                         │
│ 8. 失败 → read_log 定位 → 修复 → 续跑                        │
└──────────────────────────────────────────────┘
```

**三层分工:**

- **大脑**:LLM 只做检索、组链、诊断、解释——SOP 蒸馏进 system prompt,模型不自由发挥;
- **手**:工具层,仓库全只读,只能写 `composed/`、`agent/gap_log.yaml`、`agent/run_ledger.jsonl`、`runs/<task_id>/<run_id>/`,路径越界一律拒绝;
- **账本**:每步操作追加写 `agent/run_ledger.jsonl`,这是所有硬约束的依据(含决策 reason 与报错签名)。

**submit 的三道闸**(全部查台账,不信模型嘴上说):

1. 本任务(task_id + targets + workdir 精确匹配)有 dry-run 成功记录,且其绑定的**执行对象摘要**(`spec_digest`:targets + rule 库版本 + 全局 config/样本表 + 组合目录内容的联合 hash)与当前内容一致——dry-run 之后改过组合/config/样本表/rule 库,旧记录即失效,须重新 dry_run;
2. 有用户通过 `confirm_submit` 本人确认的 `human_decision` 记录(同样绑定摘要,确认后改动内容须重新确认),且**未被消费**——每次正式提交消耗一次确认,一次 y/N 只放行一次 submit,续跑/重试须再次 confirm_submit;
3. 服务端 `FLOWAGENT_ALLOW_SUBMIT=true`。

一句话:**模型提方案、工具做验证、台账管授权、人按最后那个按钮**——AI 负责编排,确定性与安全边界全部放在工具层。检查、审批、提交核对的是同一个执行对象摘要,杜绝「确认 A,执行 B」。

## 快速开始

```bash
cd FlowAgent
npm install
cp .env.example .env   # 填入 FLOWAGENT_API_KEY 等
```

### 命令行测试

```bash
# 自测(不调 LLM,验证工具层全部可用;65 项,含三层防线与安全对抗用例)
npm run selftest

# 一句话模式
npm run cli -- "对这批样本出原始数据 R1 的 MultiQC 质控报告"

# 交互模式(多轮)
npm run cli
```

不配置 `FLOW_WORKFLOW_ROOT` 时默认指向内置 `demo/` 迷你流程仓库(2 个模块、6 条 rule、2 个样本),`snakemake -n` 可真实跑通。指向真实流程仓库:

```bash
FLOW_WORKFLOW_ROOT=/path/to/RNAFlow npm run cli
```

### 接入 Vercel AI SDK UI 前端

```bash
npm run server   # 默认 http://127.0.0.1:3090(仅绑定回环地址)
```

前端(AI SDK v5):

```ts
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage, status } = useChat({
  transport: new DefaultChatTransport({ api: 'http://localhost:3090/api/chat' }),
});
```

AI SDK v4 前端:`useChat({ api: 'http://localhost:3090/api/chat' })`。
CORS 默认放行 localhost / 127.0.0.1 任意端口(前后端分端口开发);默认只绑定 `127.0.0.1`,对局域网开放需显式 `FLOWAGENT_HOST=0.0.0.0` 并配置 `FLOWAGENT_AUTH_TOKEN` 鉴权;生产可反代同域。

## 工具清单(规范 §8.4 的 7 个 + 5 个必要补充)

| 工具 | 作用 | 规范依据 |
|---|---|---|
| `query_catalog` | 需求 → 现成 deliverable/target(关键词 + synonyms 同义词匹配,防漏召回) | §8.3 |
| `query_ports` | 端口注册表查询(生产者/消费者) | §8.3 |
| `query_rules` / `get_rule` | rule 摘要检索 / 按需取详情(渐进式披露) | §8.4 |
| `validate_manifests` | manifest/端口/catalog 一致性 + **io.pattern 必填门禁** + **bootstrap 契约**(per-sample rule 要求 `config/samples.csv` 含 sample 列、manifest 声明的 conda env 必须存在、resources_tier 应显式;独立于 runner 恒执行)+ workdir 指向组合时的两项计划级校验:① 组合「有效合并配置」(仓库 config + 组合副本)按全库 schema 校验,**选中 rule(use rule 引用)的必需字段缺失按 error 拒绝**;② **选中子图端口闭合**——选中集合内无生产者且未登记 external 的 input 端口按 error 拒绝(dry-run 前拦截必然 MissingInput 的组合),未选中 rule 缺 key 仅 warning + 可选 `snakemake --lint`(warning 级);仓库自带 `agent/validate_manifests.py` 时优先调用 | §9.3 / §4.1 |
| `dry_run` | `snakemake -n` 封装;失败自动**归一化签名 + 分桶**(retryable 计熔断/sample_table 升级人工/transient 不计),同一签名第 3 次熔断拒绝 | §8.3 铁律 2/6 |
| `detailed_summary` | `snakemake --detailed-summary` + **rule 链文本树**(`--rulegraph`)+ **资源档位汇总**(manifest resources_tier),全部进 confirm 摘要 | §8.3 |
| `read_log` | 读 rule 日志(路径限制在仓库内,realpath 防符号链接逃逸) | §8.6 |
| `check_run` | **持久任务状态**:解析提交日志退出码,返回 running/succeeded/failed/lost + 各 target 产物落盘清单;结束时固化 `run_state.json` + `post_run_manifest.json` 并把完成事件落台账(同一 run_id 只落一次) | 评审 §7.5 |
| `confirm_submit` | **人工确认通道**(client-side 工具,无 execute):把计算规模(rule 链/资源汇总/job 数)交给用户本人在终端/前端应答,批准/拒绝写入台账;模型无权代填(规范 §4.6) | §4.6 |
| `submit_cluster` | **硬约束三道闸** + **reason 必填**;task_id/targets 入口校验(target 不得以 `-` 开头——防 `--snakefile` 等 flag 注入绕过组合防线;不含空白——保台账精确匹配);固定 `--rerun-incomplete` 与 `--cores <部署配置>`(本地资源护栏,LLM 不可改);OOM 重试走 `set_resources` 白名单(mem_mb/disk_mb/threads/runtime)与 `retries`(1~3);提交时自动固化 **run bundle** 并写初始 `run_state.json`(running);快照固化失败**阻断提交** | §8.3 三道闸 |
| `write_gap_log` | 缺口日志(自动累计次数,**reason 必填**:判定依据落台账) | §4.5 |
| `write_analysis_plan` | **AnalysisPlan 科学方案**(架构评审):目标/分组对照/方法假设/选用 rule 固化为 `agent/plans/<task_id>.analysis.yaml`,是人工审阅对象并纳入执行对象摘要;已存在拒写(方案变更须新 task_id 重走全流程),引用库外 rule 拒绝 | 评审 §4 |
| `write_composed` | `composed/<日期>_<需求>/` 新建组合文件(已存在拒绝覆盖;reason 必填);**三层防线**校验(见下),config 副本按「仓库 config + 副本」合并结果做全库 schema 校验,选中 rule 必需字段缺失拒绝写入。**退路**:仅当 compile_pipeline 表达不了(with 块覆盖、动态 target 表达式)时使用 | §8.2 |
| `compile_pipeline` | **PipelinePlan → 确定性编译**(架构评审 §7.3):只传结构化计划(模块 + use 集合 + targets),Snakefile 由固定模板生成;计划先过校验器(module 存在且在库内、use 引用已声明、targets 合法、**选中子图闭合 + target 显式路径绑定**),支持 use_all 整模块引入(`use rule * from m as p_*`),再过三层防线与 schema 校验;台账标注 `compiled` 可与模型手写区分 | 评审 §7.3 |
| `analyze_history`(**仅专家模式**) | 只读复盘台账与 gap_log:按 op 统计、同签名重复失败清单(熔断前兆)、高频缺口排行、最近事件 | 专家模式授权 1 |
| `write_rule_proposal`(**仅专家模式**) | 在 `proposals/<名称>/` 起草 rule 入库提案(manifest.yaml + .smk + RATIONALE.md,已存在拒绝覆盖,reason 必填);**不是** rule 库,入库仍走人工审核 | 专家模式授权 2 |

## write_composed 三层防线

Snakefile 本身是 Python——`snakemake` **解析即执行顶层代码**,而 dry_run 发生在 confirm_submit 人工卡点**之前**,所以"只允许 use rule 组合"必须在写盘前由工具层强制。防线在原有正则(禁 rule 本体)之后追加(`src/composed-guard.ts`):

1. **语句级白名单**:顶层只放行 `configfile:` / `include:` / `workdir:` / `module X:` / `use rule ... [with]:` / `rule all:` 与注释空行;任何顶层 Python(import/赋值/调用)拒绝并报行号;
2. **路径约束**:configfile/include/workdir/module.snakefile 经 realpath 解析后必须位于流程仓库根内且真实存在(`../` 逃逸、库外绝对路径、符号链接逃逸均拒绝);
3. **表达式约束**:`use rule with:` 块(字段白名单 input/output/params/threads/resources/log/benchmark)与 `rule all:` 的 input 只允许字面量(str/int/float/bool/None/list/dict 与 kwargs),禁止名称引用、函数调用、属性访问、下划线/dunder 标识符;rule all 的 input 额外放行 `expand()`(参数仍限字面量)。

## 熔断分桶与报错签名

铁律 6 由工具层强制:`dry_run` 失败时对输出做**归一化签名**(异常类型 | rule 名 | 去引号/路径/数字的消息骨架),路径不同的同类 `MissingInputException` 计入同一签名。分桶决定重试策略:

| 桶 | 行为 |
|---|---|
| retryable(MissingInput/Ambiguous/Cyclic/KeyError…) | 计熔断:同一签名失败 2 次后,同一调用(task_id+targets+workdir 一致)第 3 次 dry_run 在**执行前**即被前置阻断(armed),不再实际运行;模型须整理报告给用户,修复后以新 task_id 重新 dry-run(计划变更即解除) |
| sample_table(WildcardError/samples.csv/列缺失…) | 不计熔断,直接升级人工(样本表无写工具,自行修复必死循环) |
| transient(OOM/节点瞬断/超时/code≠0) | 不计熔断,自动续跑;OOM 用 `set_resources` 白名单加内存重试,瞬断加 `retries` |

## config_requires JSON Schema

manifest 的 config_requires 支持对象形式(`src/tools/validate.ts`):

```yaml
config_requires:
  - key: "parameter.threads.fastqc"
    type: "integer"        # string/integer/number/boolean/array/object/any
    minimum: 1
    maximum: 64
    default: 2
    description: "FastQC 线程数"
```

`write_composed` 携带 config 副本时、`validate_manifests(workdir=...)` 时,对**有效合并配置**(仓库 `config/config.yaml` + `envs/general_software.yaml` + 组合副本,深合并)按全库 schema 校验(类型/枚举/范围/pattern,报错带字段路径);**选中 rule**(组合 Snakefile 中 `use rule X from m` / `use rule * from m` 引用,含通配展开)的必需字段缺失为 error,未选中 rule 缺 key 仅 warning;旧式纯 key 列表兼容(type:any)+ warning 提示补 schema。

## 运行台账 run ledger

`agent/run_ledger.jsonl`(在目标流程仓库内),每次 dry_run / summary / validate / submit / gap / 人工确认全量记录,事件带唯一 `id`;失败 dry_run 附 `signature`/`bucket`,`write_composed`/`submit_cluster`/`write_gap_log` 附必填 `reason`(LLM 决策理由——事后排查"是 rule 库的锅还是组装的锅"的唯一线索),submit 附 `bundle` 路径与 `run_id`,dry_run/human_decision/submit 均附 `spec_digest`(执行对象摘要):

```json
{"id":"<uuid>","ts":"2026-09-08T...","task_id":"20260908_qc_only","op":"dry_run","target":"01.qc/...","object":".","result":"failed","signature":"MissingInputException|qc_x|...","bucket":"retryable"}
{"id":"<uuid>","ts":"2026-09-08T...","task_id":"20260908_qc_only","op":"human_decision","target":"01.qc/...","object":".","result":"approved","detail":"CLI 终端人工确认 by=cli-user"}
{"id":"<uuid>","ts":"2026-09-08T...","task_id":"20260908_qc_only","op":"submit","target":"01.qc/...","object":".","result":"started","detail":"pid=... log=...","reason":"dry-run 已通过且用户确认规模","bundle":"runs/20260908_qc_only/20261015T...-abcdef12","run_id":"20261015T...-abcdef12"}
```

`submit_cluster` 的三道闸直接查询该台账(dry-run 与人工确认均按 task_id + targets + workdir 精确匹配,组合目录与仓库根互不通用),并核对当前内容算出的 `spec_digest` 与记录绑定的一致。断网/重启后可根据台账恢复任务上下文(规范 §8.3 台账硬约束)。

## run bundle(可复现性快照)

submit 通过三道闸后自动固化 `runs/<task_id>/<run_id>/`(run_id 为时间戳+随机后缀,同任务多次提交各自独立、互不覆盖;固化失败即阻断本次提交):`rule_library_version.txt`(rule 库 git commit;非 git 仓库用全库 manifest 联合 sha256)+ 组合目录副本 + `config/config.yaml` 与样本表副本 + `bundle_manifest.json`(含 run_id / targets / spec_digest)。三个月后 rule 库更新,仍可复原"这次跑通的组合"的确切上下文。

## LLM 在环回归评测(阶段 3)

`eval/cases.yaml`(10 条起步:catalog 命中 / 组装 / 缺口三类)+ `scripts/run-eval.ts`(mock confirm 自动批准、mock submit 不真跑,其余工具真实执行),输出四档命中率(完全匹配 / 链对但缺 rule / 链错 / 误判断链):

```bash
npm run eval   # 需 FLOWAGENT_API_KEY
npm run eval -- --mode both        # 员工 + 专家双基线
npm run eval -- --save-baseline --mode both   # 保存逐用例判定基线(eval/eval-baseline.json)
```

基线机制(评审 §7.7):`--save-baseline` 把每条用例的判定(catalog 命中/组装/缺口三档评级)按模式存入 `eval/eval-baseline.json`;常规运行自动逐用例比对,报告「退化」(如 catalog 命中退化为误判断链)与「改善」,用于区分 rule 库退化、prompt 改坏与模型换档。

## 语义错误评测(确定性基线,评审 §7.7)

`scripts/run-semantic-eval.ts`(9 例,不调 LLM):「错误但语法/流程上貌似合法」的组装必须被拦下(不闭合子图、幽灵 module、幽灵 rule、选中 rule 必需字段缺失、样本表/conda env 缺失),正向计划(完整 PipelinePlan 编译、catalog 主流程)必须放行。基线存于 `eval/semantic-baseline.json`(含 rule 库版本),rule 库或校验逻辑变更后比对退化:

```bash
npm run eval:semantic            # 跑一遍并与基线比对
npm run eval:semantic -- --save  # 保存新基线
```

conda 预建已实测(评审 §4.5):snakemake 9.19.0 下 `dry_run(create_envs_only=true)` 的 `--conda-create-envs-only` 会真实创建 `.snakemake/conda/` 环境(`bin/`、`conda-meta`、`.env_setup_done` 齐全);实测 3 个环境中 2 个一次成功,1 个因镜像站 SSL 瞬断未完成——属网络瞬态,重跑即可,与 flag 语义无关。

rule 库新增 rule、改 system prompt、改端口签名结构时各跑一遍,对比基线区分"rule 库退化"与"组装退化"。

## 员工 / 专家模式

同一个 Agent 有两档运行模式,本质是「三件事按 mode 取值」:**模型 + system prompt 变体 + 工具门控**;安全铁律(基础六条、submit 三道闸、confirm_submit 本人应答、写路径边界)在两种模式下**无一放宽**。

| | 员工模式(standard,默认) | 专家模式(expert) |
|---|---|---|
| 模型 | `FLOWAGENT_MODEL` | `FLOWAGENT_MODEL_EXPERT`(未设置则回退员工模型) |
| system prompt | 基础 SOP | 基础 SOP + 专家授权段(主动体检/提案起草/策略分化/预判性动作/流程优化建议,及对应的置信度分级、可驳回性等义务) |
| 工具 | 12 个基础工具 | 额外注册 `analyze_history`、`write_rule_proposal` |
| 台账 | 每条记录带 `mode` 字段,事后可区分「员工干的还是专家干的」 | 同左(三道闸不按 mode 过滤——批准与 dry-run 记录跨模式通用) |

**proposals/ 与 rule 库的边界**:`write_rule_proposal` 只写 `proposals/<名称>/`(只允许新建、拒绝覆盖,`../` 越界与 `rules/*.smk` 一律拒绝),提案文件不是 rule 库,入库仍走人工审核。

**切换方式**:

- HTTP:`POST /api/chat` 请求体带 `mode: "standard" | "expert"`(逐条请求生效,非法值返回 400);`GET /api/mode` 返回可用模式、双模型 ID、expert 是否已配置,以及给前端按钮用的两段切换文案;`GET /api/runs` 返回服务端任务状态视图(聚合 `runs/*/run_state.json`,不依赖客户端历史,断线/重启后可恢复任务面板);`POST /api/approve` 是**审批接口**(评审 §4.1):前端确认按钮在用户应答后显式调用,服务端自算执行对象摘要——只批「已 dry-run 通过且内容未漂移」的对象(否则 400/409),同一 confirm_id 只落一次账(409),身份即 Bearer 凭据持有方。历史消息回传落账路径保留作向后兼容,不可信前端应改用本接口。
- CLI:`/expert`、`/standard` 切换(下一条消息生效),`/mode` 查看当前模式;启动可用 `npm run cli -- --expert "需求..."`。

**评测双基线**:专家模式换了模型,同一 SOP 在两档模式下行为基线不同——评测须各跑一遍,否则无法区分「退化是模型换档还是 prompt 改坏」:

```bash
npm run eval -- --mode both   # 员工 + 专家双基线;--mode expert 单跑专家;默认 standard
```

## 人工确认(human-in-the-loop)

`confirm_submit` 是没有 `execute` 的 client-side 工具:模型只能发起请求,应答必须来自人。

- **CLI**:模型调用 `confirm_submit` 时流暂停,终端打印 task_id / targets / 规模摘要(rule 链 + 资源档位),用户 `y/N` 应答;结果写入 `human_decision` 台账后循环继续。
- **HTTP 前端(useChat)**:工具调用以 `tool-confirm_submit` 部件到达前端,渲染确认 UI 后用 `addToolResult` 回传输出;服务端收到 `output.approved === true` 的历史消息时落账(兼容 AI SDK v5 的 `state: 'output-available'`;按 confirm_id 即工具调用 ID 去重——同一确认事件只落一次,用户在新一轮 confirm_submit 上的新应答仍会落账),落账时绑定当前执行对象摘要(`spec_digest`)。示例:

```ts
const { messages, sendMessage } = useChat({ transport: ... });
// 渲染层检测到 confirm_submit 部件(state === 'input-available')时:
addToolResult({ tool: 'confirm_submit', toolCallId, output: { approved: true, by: 'ui-user' } });
```

> 注意:HTTP 路径下确认记录的可信度等于前端实现的可信度。服务端已做三重收敛:默认仅绑定 `127.0.0.1`、CORS 不放行任意网页(防浏览器 drive-by 伪造确认)、可选 `FLOWAGENT_AUTH_TOKEN` Bearer 鉴权;对不可信前端或跨机部署,务必开启鉴权,正式提交另受 `FLOWAGENT_ALLOW_SUBMIT` 总开关约束(规范 §4.6)。

## 目录结构

```text
FlowAgent/
├── src/
│   ├── config.ts          # env/.env 加载、路径越界防护(safeJoin)、AgentMode 类型、host/鉴权/CORS 配置
│   ├── system-prompt.ts   # SOP 蒸馏(铁律六条/决策流程/分桶对策表 + 专家授权段)
│   ├── agent.ts           # streamText 循环(CLI 与 server 共用,全局 30 步上限)
│   ├── ledger.ts          # run ledger JSONL 读写 + 三道闸/熔断/确认消费查询(含 signature/bucket/reason/bundle/confirm_id/spec_digest/run_id)
│   ├── spec-digest.ts     # 执行对象摘要(rule 库版本 + targets + config/样本表 + 组合内容)与库版本指纹
│   ├── error-classify.ts  # 报错签名归一化 + 分桶(retryable/sample_table/transient/unknown)
│   ├── tools/plans.ts     # write_analysis_plan:科学方案固化为可审阅对象(纳入执行对象摘要)
│   ├── tools/compiler.ts  # compile_pipeline:PipelinePlan 结构化计划 → 固定模板编译 Snakefile
│   ├── composed-guard.ts  # write_composed 三层防线(自研词法 + 递归下降表达式解析)
│   ├── run-bundle.ts      # submit 时的可复现性快照(runs/<task_id>/<run_id>/)
│   ├── executor.ts        # 执行器接口(评审 §7.6):local=本地后台 / slurm=sbatch(squeue 探活)
│   ├── shell.ts           # 子进程封装:runShell(前台)/spawnDetached(后台日志重定向)/tail
│   ├── cli.ts             # 命令行入口(单句/交互,confirm_submit 终端应答)
│   ├── server.ts          # HTTP 入口:POST /api/chat + POST /api/approve(审批接口)+ GET /api/runs(任务状态)+ GET /api/health + GET /api/mode
│   └── tools/
│       ├── index.ts       # createTools:按 mode 聚合与门控(expert 才注册专家工具)
│       ├── registry.ts    # query_catalog / query_ports / query_rules / get_rule + loadManifests/readYaml
│       ├── validate.ts    # validate_manifests + config_requires JSON Schema 校验(导出给 writes 复用)
│       ├── snakemake.ts   # dry_run / detailed_summary / read_log / check_run / submit_cluster / confirm_submit
│       ├── writes.ts      # write_gap_log / write_composed
│       └── expert.ts      # analyze_history / write_rule_proposal(仅专家模式)
├── scripts/selftest.ts    # 无 LLM 自测(65 项,含对抗用例)
├── scripts/run-eval.ts    # LLM 在环评测(eval/cases.yaml)
└── demo/                  # 内置迷你 Flow 仓库(smk + manifests + ports + catalog)
```

## 源码引用关系

按「谁 import 谁」实测分层(箭头指向被依赖方),单向向下、无环:

```text
入口层   cli.ts ──────┐          server.ts ──────┐
           │                          │
           ▼                          ▼
循环层   agent.ts ←─ system-prompt.ts / tools/index.ts
                        │
                        ▼
工具层   tools/index.ts
           ├─ registry.ts(查询工具 + 全库资产加载)
           ├─ validate.ts ←─ registry
           ├─ snakemake.ts ←─ ledger / error-classify / run-bundle / executor / shell / registry
           ├─ writes.ts ←─ ledger / composed-guard / registry / validate
           └─ expert.ts ←─ ledger / registry(仅 expert 注册)
                        │
                        ▼
支撑层   ledger.ts ←─ config(仅类型)      run-bundle.ts ←─ shell
         system-prompt.ts ←─ config
基础层   config.ts / shell.ts / error-classify.ts / composed-guard.ts(零本地依赖)
```

各文件的职责与被引用情况:

| 文件 | 导出(被 src 内复用的部分) | 引用它的文件 |
|---|---|---|
| `config.ts` | `loadConfig` / `FlowAgentConfig` / `AgentMode` / `safeJoin` | 除 `shell` / `error-classify` / `composed-guard` 外的全部 |
| `shell.ts` | `runShell` / `spawnDetached` / `tail` | `snakemake` / `validate` / `run-bundle` |
| `error-classify.ts` | `classifyError`(签名 + 分桶) | `snakemake` |
| `composed-guard.ts` | `validateComposedSnakefile`(三层防线) | `writes` |
| `ledger.ts` | `appendLedger` / `readLedger` / `hasSuccessfulDryRun` / `hasApproval` / `hasUnconsumedApproval` / `hasConfirmRecord` / `countSignatureFailures` | `cli` / `server` / `snakemake` / `validate` / `writes` / `expert` |
| `run-bundle.ts` | `createRunBundle`(bundle 快照) | `snakemake` |
| `system-prompt.ts` | `buildSystemPrompt`(expert 追加授权段) | `agent` |
| `agent.ts` | `runFlowAgent`(streamText,30 步上限) | `cli` / `server` |
| `tools/registry.ts` | 4 个查询工具 + `loadManifests` / `readYaml` | `index` / `validate` / `snakemake` / `writes` / `expert` |
| `tools/validate.ts` | `validate_manifests` + `extractConfigSchemas` / `checkConfigAgainstSchemas` | `index` / `writes` |
| `tools/snakemake.ts` | 6 个执行类工具(含无 execute 的 `confirm_submit`;check_run 提供持久任务状态与 post-run manifest) | `index` |
| `tools/writes.ts` | `write_gap_log` / `write_composed` | `index` |
| `tools/expert.ts` | `analyze_history` / `write_rule_proposal` | `index`(仅 expert) |
| `tools/index.ts` | `createTools`(按 mode 聚合门控) | `agent` |

三个共享枢纽决定了改动的波及面:

- **`ledger.ts`**:三道闸与熔断计数的唯一数据源,入口层(`cli`/`server` 落 human_decision)与工具层(`snakemake`/`validate`/`writes`/`expert` 追加记录)都写它。改台账结构须全量核对这 6 处调用。
- **`tools/registry.ts` 的 `loadManifests` / `readYaml`**:manifest/catalog/ports 等 YAML 资产的唯一加载入口,5 个工具文件共享;manifest 字段结构变更只改这里。
- **`tools/validate.ts` 的 config schema 校验**:`validate_manifests`(workdir 路径)与 `write_composed`(config_yaml 路径)两条路径都走 `extractConfigSchemas` + `checkConfigAgainstSchemas`,校验规则只维护一份。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FLOWAGENT_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | OpenAI 兼容接口地址 |
| `FLOWAGENT_API_KEY` | (回退 `ARK_API_KEY`) | 必填 |
| `FLOWAGENT_MODEL` | `doubao-seed-1-6-250615` | 模型/接入点 ID |
| `FLOWAGENT_MODEL_EXPERT` | 空(回退 `FLOWAGENT_MODEL`) | 专家模式模型 ID |
| `FLOW_WORKFLOW_ROOT` | `./demo` | 目标 Flow 流程仓库根 |
| `FLOWAGENT_HOST` | `127.0.0.1` | server 绑定地址(仅本机;对局域网开放设 `0.0.0.0` 并务必配置鉴权) |
| `FLOWAGENT_PORT` | `3090` | server 端口 |
| `FLOWAGENT_AUTH_TOKEN` | 空(不鉴权) | Bearer 鉴权 token:设置后 `/api/chat`、`/api/mode` 与 `/api/approve` 要求 `Authorization: Bearer <token>` |
| `FLOWAGENT_ALLOWED_ORIGINS` | localhost/127.0.0.1 任意端口 | CORS 允许来源:逗号分隔精确匹配;`*` 恢复全开(不建议) |
| `FLOWAGENT_ALLOW_SUBMIT` | `false` | 正式提交总开关(硬约束第三道闸) |
| `FLOWAGENT_CORES` | `8` | submit 固定 `--cores` 上限(资源护栏,LLM 不可改;slurm 时映射为 `--cpus-per-task`) |
| `FLOWAGENT_EXECUTOR` | `local` | 执行器:`local`=本地后台 Snakemake;`slurm`=sbatch 集群提交(构造时自检 sbatch,不可用即拒绝提交,**不会静默退回 local**;作业 ID 写入日志,check_run 用 squeue 探活) |
| `FLOWAGENT_SLURM_PARTITION` | (空) | slurm 分区名(空则走集群默认分区) |
| `FLOWAGENT_USE_CONDA` | `true` | dry_run/submit 带 `--use-conda`,rule 的 `conda: envs/*.yaml` 自动建环境 |
| `FLOWAGENT_CONDA_FRONTEND` | `conda` | 装了 mamba/micromamba 可改 `mamba` 提速 |
| `FLOWAGENT_EXTRA_ARGS` | 空 | submit 追加参数,如 `--logger rich-loguru`(真实 Flow 仓库强制) |

## 环境与软件如何工作(真实运行)

- **conda 环境**:rule 在 `.smk` 里声明 `conda: envs/*.yaml`(manifest 的 `conda` 字段同步登记),`dry_run` / `submit_cluster` 已带 `--use-conda`,snakemake 自动建环境;`dry_run(create_envs_only=true)` 可在正式跑之前预建全部环境(`--conda-create-envs-only`),把网络/源问题提前暴露;
- **Rust 二进制**(seq_preprocessor / json_md5_verifier):生产 Flow 仓库中路径走 `config.software.*`(规范 §3.3),Agent 通过 manifest `config_requires` 知道该查哪些 key;日志报 command not found 时向用户要路径,不改 rule;
- **demo 仓库已真实可跑**:vendor 原始 fastq(真实 gzip 数据 + md5.txt)→ **真实 Rust 二进制** `seq_preprocessor` / `json_md5_verifier`(路径走 `envs/general_software.yaml` 的 `general_software` 段,生产仓库对应 `config.software`)→ 真实 fastqc/multiqc(conda 环境)。一条命令实测:

```bash
FLOWAGENT_ALLOW_SUBMIT=true npm run demo:run
# 指定 target: npm run demo:run -- "01.qc/short_read_r2_multiqc/multiqc_r2_raw-data_report.html"
# 跟踪: tail -f demo/logs/flowagent/submit-demo_realrun-*.log
```

> demo 的 vendor 数据带有 `md5.txt`(厂商校验文件);若缺失,seq_preprocessor 的 JSON 报告不含 md5 字段,json_md5_verifier 会「无可校验记录」不产出门控文件——真实项目请确认厂商 md5 就位(SRA 数据除外,规范 §4.1)。

## 与规范的对应关系 / 后续路线

- 本目录即规范的「第 3 级:自建 Agent 应用」骨架(§8.1);资产(manifest/catalog/ports/SOP)仍在目标流程仓库,本后端零绑定、换模型只换 env;
- 真实仓库侧的阶段 0~3 资产(全库 manifest、AGENTS.md、validate_manifests.py)按规范第九章另行建设,建成后把 `FLOW_WORKFLOW_ROOT` 指过去即可,后端无需改动;
- `submit_cluster` 当前为本地后台 `snakemake --rerun-incomplete`(带固定 `--cores` 上限护栏);接 HPC 时将其替换为集群提交命令(台账硬约束逻辑不变);
- 纵深防御(可选后续):dry_run 进程降权执行(独立低权限用户或 bwrap/容器),即使三层防线被绕过也把爆炸半径限制在 composed/ 内。
