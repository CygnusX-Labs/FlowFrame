# FlowAgent 总体规划对照审查与图标提示词

审查日期：2026-10-16。依据： [Flow-AI_Rule_Orchestration.md](../planning/Flow-AI_Rule_Orchestration.md)、[Flow-Workflow-Onboarding-Guide.md](../planning/Flow-Workflow-Onboarding-Guide.md)，以及当前工作区源码（包含尚未提交的实现）。旧的 2026-10-15 架构评审仅作历史参考；本文未改动现有业务代码或用户已有改动。

## 结论

**核心方向没有偏离，工程实现已有明显进步，但交付状态仍是受控试点后端，尚未达到总体规划定义的版本治理与科研验证闭环。**

LLM 检索、提出方案、诊断；工具校验、授权、记账；Snakemake 执行；专家审核——这个分工保留得很好。当前优先建设了交互与运行工具，发布资产、依赖锁和结果验证落后于应用层，属于实施顺序的倾斜，不必推倒重做。

不能以“demo 能跑”“有 bundle”“有科学方案 YAML”分别替代“生产仓库可接入”“历史可复现”“科学方案已审核”。两份规划本身也存在详略差异：入库手册描述的是过渡实现，不能替代总体规范的最终验收标准。

## 一、对照结果

| 规划要求 | 当前证据 | 判断 |
|---|---|---|
| 复用已有 rule，新增能力走候选提案 | `src/tools/registry.ts`、`expert.ts`、`composed-guard.ts` | 符合方向；但“存在于库”不等于有已审核 release |
| catalog 优先、按需检索 rule 详情 | `query_catalog/query_rules/get_rule` | 已实现，适合继续保留 |
| AnalysisPlan + 专家科学审核 | `src/tools/plans.ts` | 已有最小方案；缺参考版本、验证策略、结构化样本设计、独立科学审核与字段复审策略；submit 未硬性要求方案存在 |
| PipelinePlan → 确定性编译 | `src/tools/compiler.ts` | 已实现最小模块选择模板；缺版本解析、持久化 plan.yaml、完整 binding、with 覆盖文法和 existing_entry 正式契约 |
| 选中子图闭合与目标可达 | `validate.ts:checkSelectedSubgraphClosure` | 已检查端口名称和 target pattern；未证明边之间路径匹配、属性兼容、样本范围/参考一致或多生产者选择正确 |
| 规则配置 Schema 与 bootstrap | `validate.ts`、`writes.ts` | 有必需字段、类型范围、样本表和环境存在性检查；不是生产入口全部上下文的验收 |
| 先验证再运行、人工确认、一次性消费 | `snakemake.ts`、`ledger.ts`、CLI/HTTP | 三道闸已实现并增加摘要绑定；validate/summary/科学审核顺序主要依赖 SOP，非完整强制状态机 |
| rule/pipeline 独立版本和不可变发布 | registry 按 rule.name 检索，库版本用 Git HEAD 或 manifest hash | 仍缺稳定 rule_id@version 解析、传递依赖闭包、release 审核/撤销及完整锁 |
| 历史复跑与隔离回退 | `run-bundle.ts` | 独立 run_id 与配置副本已具备；未保存完整依赖，实际仍从原目录执行，不能保证历史复跑 |
| 环境、参考数据、输入身份锁定 | bundle 与 digest 的固定文件清单 | 未达到环境精确锁、参考对象版本/SHA-256、输入身份核对要求 |
| 四级验证及结果质量 | dry_run、check_run | 有加载/工作流验证及退出码和 target 存在性；缺格式、样本集合、参考身份、QC 阈值和科学结果验证策略 |
| pre/post-run 证据与 ledger | `run-bundle.ts`、`check_run`、`ledger.ts` | 有轻量快照与完成事件；post manifest 无完整动态 job/file 展开、产物 hash、指标与验证结论 |
| autonomous/supervised/manual | 配置与确认机制 | 当前以逐次人工确认运行；standard/expert 是模型/能力档位，不能代替三种执行授权模式 |
| 本地与 HPC、任务恢复 | `executor.ts`、`check_run`、`GET /api/runs` | 新增 local/Slurm 适配与持久状态；尚未核验真实集群；依赖主动 check_run，非独立持续监控服务 |
| 入库五道门禁与真实仓库验收 | demo、selftest、semantic eval | 有工具级证据；没有本次验证过的真实组学仓库全链、科学结果核对与专家发布记录 |

以上源码路径均相对于 `FlowAgent/`。仓库包含规范与框架模板，不能据此认定外部 RNAFlow/SCRNAFlow 等生产仓库已经完成入库。

## 二、已确认的优先问题

### P0：执行摘要不能完整识别实际代码变动

`src/spec-digest.ts:ruleLibraryVersionSync` 在 Git 仓库只读 HEAD，不包含未提交的 rule/helper/env 变动；非 Git 仓库只 hash manifests。`computeExecutionSpecDigestSync` 对根入口只读取大写 `Snakefile`，而框架规定小写 `snakefile`。

本次在 `/tmp` 构造非 Git 最小仓库，分别修改 `rules/a.smk` 和小写 `snakefile`，两次摘要均保持不变。故当前不能声称“修改 rule 库必定使旧 dry-run/审批失效”。此外参考四件套、Agent/编译器版本、executor/extraArgs 等未完整纳入执行对象。

建议：解析发布依赖闭包，对实际源码、helper、环境、有效配置、入口和策略生成内容锁；批准后从冻结对象执行。资源重试可以排除在科学计划摘要之外，但必须受已批准的资源上限与策略约束，不能仅靠 key 白名单。

### P0：编译配置副本没有接入运行配置

`compiler.ts` 生成的 Snakefile 加载根 `config/config.yaml` 和可选 `envs/general_software.yaml`，没有加载工具接收并落盘的本地 `config.yaml`；`writes.ts` 却按“根配置 + 副本”校验。submit 也未自动传入该副本。

因此可能出现校验通过，但运行使用旧值/默认值。本次直接检查编译函数输出，确认无加载本地副本的指令。

建议：先确定唯一的配置加载与工作目录契约，再让编译、校验、摘要、dry-run 和 submit 共用同一有效配置；验收用例必须证明修改副本能改变真实规则读取的值。

### P1：生产 bootstrap 仍偏向 demo

`compiler.ts` 仅自动包含 `rules/common.smk`；框架实际使用 `rules/01.common.smk` 和入口八步初始化。`mergedEffectiveConfig` 只合并两份配置，未覆盖框架四件套、analysisyaml 和命令行最终覆盖。

“环境文件存在、samples.csv 有 sample 列”只能证明部分前置条件，不能证明 logger、SAMPLES、rule_resource、参考解析等可用。优先做规范提出的 existing_entry：生成项目配置与样本副本，通过真实原入口执行。跨模块组合需逐仓库验证适配器。

### P1：方案存在、结果成功和审批权限的含义需要收紧

- `write_analysis_plan` 可留存方案，但 submit 没有强制独立科学审核；其 grouping 等是字符串，不能机器核对真实分组。
- prompt 把方案写入放在 dry-run/summary 之后，写入方案又会改变摘要；应前置方案或明确要求重新 dry-run。
- `check_run` 根据退出码 0 标记 succeeded，同时另行记录 target 是否存在；尚无版本化产物/QC 检查，不能把 succeeded 展示为“科学验证通过”。
- JSONL 同步检查减少单进程异步竞争，不能等同跨 CLI/server/多副本进程的事务消费；HTTP 兼容历史消息落批准的路径仍需替换为服务端 pending approval + 身份绑定。

### P2：编译器迁移与文档契约未同步

- `write_composed` 仍可直写，未自动记录规范 §8.7 要求的 `compiler_gap`。
- 子图校验按裸 rule.name 汇总同名定义，未用 module + rule_id@version 唯一定位；同端口的多个生产者没有强制选择。
- 手册仍推荐旧 dynamic 字段、弱化端口属性为描述文本，缺 rule_id/version 与 release bundle 实操步骤；应标为“过渡入库”并补生产验收章节。
- 手册的 `gaps: []` 初始化与工具实际使用 `entries` 不一致。
- README 的工具数量、自测数量、末尾“尚需接 HPC”等表述已有漂移；旧评审的“无 compiler/plan”等判断已过时，应保留为历史快照并链接本次审查。

## 三、哪些改动值得保留

1. **结构化模板编译优先，三层 guard 继续自检**：已经沿总体规划 §8.7 走出关键一步，减少模型自由书写生产组合的范围。
2. **审批摘要绑定**：比手册仅以 task/target/workdir 绑定更强，修好依赖覆盖后应成为正式契约。
3. **每次提交独立 run_id，快照失败阻断提交**：避免历史覆盖和无证据启动，优于轻量 bundle 的早期实现。
4. **check_run 与持久状态**：退出码、完成事件、任务列表为后续证据服务提供基础。
5. **executor 接口及 Slurm 不可用即拒绝**：清楚地区分本地与集群能力；但 Slurm 当前是将 Snakemake 总进程包装成一个 sbatch 作业，未证明已实现按 rule 分配集群资源。
6. **无 LLM 语义回归集**：比只靠 prompt 或模型在环测试更容易定位工具层退化；需继续补真正的配置生效、属性不兼容、同名 rule、多生产者与摘要漂移反例。

这些多数是总体规划的落实，准确说是“比旧实现更好”，而非证明已经超越总体规划。

## 四、建议推进顺序与验收

1. 修复摘要闭包与配置实际加载；以“变更依赖必失效、批准内容等于执行内容、配置副本真实生效”作为硬验收。
2. 选一个真实 Flow 仓库先做 existing_entry 试点；跑四件套/analysisyaml/样本表/MD5 门控/真实小样，核对全部输出。
3. 做一个完整 rule release 和 pipeline release：稳定 ID、依赖文件 hash、环境与参考锁、科学审核、历史隔离复跑。
4. 补 AnalysisPlan 科学审核和执行授权状态机；把运行模式与 standard/expert 分开建模。
5. 补版本化结果校验及 validation.json、完整 post-run manifest；再扩大跨模块编译和平台集成。

无需先扩展多 Agent 或重建前端；当前最有价值的投入是把一次真实分析的计划、发布、批准、执行与结果证据闭环做实。

## 五、本次验证与边界

- `npm run typecheck`：通过。
- `XDG_CACHE_HOME=/tmp/flowagent-audit-cache node --import tsx scripts/run-semantic-eval.ts`：9/9 通过，含真实 demo dry-run；这不覆盖前述配置副本与摘要漏项。
- selftest 首轮遇默认 Snakemake cache 只读；迁移 XDG_CACHE_HOME 后重试，已执行的 57 项全部 PASS，随后在 HTTP 测试处因 `listen EPERM 127.0.0.1` 中断，未执行完全集。不能据此宣称整套通过，也不将端口限制误判为业务缺陷。
- 使用临时目录复现 rule 源码/小写入口修改摘要不变，并检查模板未引用本地配置副本。
- 未调用外部 LLM、未正式提交分析、未执行真实组学全链或真实 Slurm 作业，未验证前端人工确认往返。因此本报告不声称上述能力已经验收。

## 六、Flow-AI Agent 图标提示词

### 推荐方向：有秩序的分析流，具有人格感但不画成机器人

与项目现有蓝色基因图标保持色系连续性，以“可组合的分析节点 + 隐含 F + 温和的智能感”体现受控科研编排。DNA 可作为微弱联想，不必成为唯一主体。

**可直接复制：**

> 为科研分析产品「Flow-AI Agent」设计一个独立应用图标。核心概念是智能编排、可信分析、清晰的数据流。画面中央用一条流畅连续的蓝色带状路径连接三个精简的圆角节点，整体轮廓巧妙形成字母 F，表达将复杂分析组织成有序工作流。节点与曲线之间留出充足负空间，局部以非常克制的双螺旋节奏暗示生命科学。让主体呈现一点温和、专注的智能伙伴气质，通过整体轮廓和比例实现，不添加拟人五官。主色深海军蓝、科技蓝与少量青色高光；轮廓利落，轻微柔和体积与材质层次，精密、安静、可靠。正面居中，单一主体，方形画布，安全边距约 15%，轮廓在 32×32 像素下仍清晰。输出一版透明背景的纯图形标志，适合应用图标、聊天 Agent 头像和侧边栏。不出现文字，不出现品牌水印。

**负面提示词：**

> 复杂 DNA 插画，机器人头，电路板，大脑图案，密集网络，过多节点，锁与盾牌堆叠，细碎线条，彩虹配色，强烈霓虹，过度玻璃折射，夸张 3D，厚重阴影，照片，场景背景，文字，水印，模糊边缘。

**深色应用图标变体：** 保持同一主体、比例与节点结构；深海军蓝圆角方形底，主体使用冰蓝与青色，降低发光强度，适合桌面图标。透明标志版与带底应用版分别生成，避免把两种背景要求混在一张图中。
