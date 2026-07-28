# TX Gap 分析 — 固定回答格式

> 输入：一笔竞争者已落地的 tx hash。目标：以审计时的 canonical `main` 完整 SHA 为基线，回答生产能否复现、首个失败阶段、具体文件/函数，以及是否只需补 adapter。
>
> 本文同时规定**取证方法和最终交付格式**，但不是源码路径表。工具名、文件名、环境变量和部署路径会随
> 架构变化；分析时必须在审计 SHA 上重新定位。下文示例里的名字只证明当时那笔交易，不是未来分析的硬依赖。

## 0. 固定方法

### 0.1 人工事实链先行

1. 钉死三锚：审计代码 SHA；生产实际输入/config/universe 的内容哈希；lane-correct 状态锚。scanner 使用父块态；
   backrun 使用父块 `boundary`，再按真实顺序构造 `trigger-only` 与 `full-prefix`。任何一锚不明都先写
   `证据不足`，不能用当前状态代替历史状态。
2. 读取完整 block、transaction、receipt、logs、call trace/state diff 和 token/native balance delta，人工重建
   `(target, selector, tokenIn, tokenOut, amount, identity evidence)` 的有序事实链。mint/burn、wrap/unwrap、
   protocol conversion 必须同时核对调用与资产变化，不能只看 event 名。**venue 取"顶层直接调用锚"，
   proxy 的 impl（delegatecall）和 venue 内部子调用（如 Curve 池内部调 cToken/借贷组件）都是实现、不是
   route venue（判定见 §4）。**
3. **固定做 sender/同块关联审计：**记录 parent-state 与目标块末态的 `from` code hash；若两者不同，必须用
   winner 前 `full-prefix`/state diff 确定执行前 code，取不到就标 `unknown`，不能拿块末态冒充 tx 前态。读取带
   完整交易体的目标块，枚举同一 sender 的全部交易并按 `transactionIndex` 排序，nonce 只作连续性核对。
   对每笔标记 `setup/funding`、`trigger`、`winner`、`profit disposal/refund` 或 `unrelated`。若 trace 出现独立
   executor、profit recipient、sponsor 或直接 coinbase payment，再对这些地址做同块相邻交易的 bounded 交叉检查。
4. earlier same-block tx 可能改变 winner 前态，later tx 可能只是利润处置。正常 backrun 对一笔已声明的真实
   swap/oracle trigger 的依赖记为 `declared_trigger_dependency`；只有还依赖 sender setup/funding、第二个未声明
   trigger，或 `trigger-only` 与 `full-prefix` 的 route/final-sim/EV bucket 不一致时，才记
   `multi_tx_dependency` 并列出具体交易。multi-tx 本身不自动等于 out-of-scope，先按真实资金守恒和生产范围分类。
5. 将核心本金闭环与 flash principal、builder payment、gas、利润换币、库存处置分开。毛利润用 fork 前后原始
   token/ETH delta 独立复算；builder payment 同时检查 priority fee 和 trace 中的直接 coinbase transfer。
6. 在声明根因前主动排除替代解释：错误 parent/prefix、同块前序状态、历史 state 不可读、universe/config 不同、
   hop/template 限制、coarse rank/exact refinement、candidate/top-N cap、deadline/TTL、warm/cache、profit-token
   valuation 或 flash liquidity。第一个被生产证据证明失败、拒绝或无法继续的阶段才是 gap；机器证据是从步骤 1
   开始的有序前缀，并在该条 `fail | reject | not_reached` 记录后立即终止。人工六行展示若补齐余下行，只能把它们
   标成展示用 `not_reached`，不得再发出额外 machine evidence。
7. 如果分析器无法区分核心闭环与利润处置而输出 `MANUAL REQUIRED`，这是 fail-closed；用上述 token continuity、
   同块关系和可信 replay 消歧，不能把 touched venue 集合强行拼成路线。

### 0.2 工具只作第二证据源

1. 人工事实链完成后，运行当前生成的 `tool-index`，按 `receipt/trace/PnL/causality/venue identity/graph/replay`
   等能力查询选择正式工具，并通过 `tool-run` 留 execution receipt；不得凭记忆固定某个 CLI 名。
2. 窗口枚举类工具通常不能替代单笔深挖；图成员查询也只证明快照成员关系。生产可复现必须继续看到 runtime
   route/edge、scanner/detector 自发发现、planner、quote/sizing、plan/compile、final sim 和 EV 判定。
3. 人工与工具分歧时，以原始 receipt/trace/fork 继续取证；不得为了让工具输出通过而修改交易事实。
   本 `tx-gap` 流程启用 analysis-tool freeze：按稳定 `divergence_id` 写入 `docs/research/tool-divergences/`，状态固定为
   `open_frozen`，本轮不改分析器、hook 或 gate。archive/trace/state-diff 能力缺失必须标成证据限制，而不是协议或
   生产 admission 失败。

### 0.3 Universe 与禁止 look-ahead

1. universe 成员关系的判定标准是**按交易前窗口现算**。先在审计 SHA 上从生产启动/部署配置、实际进程环境与代码
   fallback 反查 lookback、min-swaps、identity policy、canonical builder，以及 universe、strategy view、per-token、
   path、candidate、refinement 等每一层独立 cap 的**生效值**；再用相同代码与参数重建 `[tx-lookback, tx-1]`。
   不得把本文曾出现过的天数、块数、命令、路径或今日配置当成常量，也不得用一个阶段的 top-N 代替另一个阶段的 cap。
2. 为 live 与 replay 各生成一份生效配置清单（字段、值、来源：process env / deploy injection / code fallback、来源 SHA）并
   比对内容哈希。做 production gap 判定或 Production Replay 时，必须按**实际消费阶段**逐字段复制 live 值；env 未设置时
   也要记录实际采用的 fallback，不能静默使用 replay 自己的默认值。匹配依据是语义而不是变量名：在 replay 入口截断
   整个 frozen universe 的 cap 必须对应 live base-universe admission cap，不能拿“在 base graph 之外额外补池”的 strategy-
   view cap 代替。若目标池存在于 live runtime view，却仅因 replay 更小的入口 cap 消失，结论是
   `replay_config_mismatch`，不是 production `pool/admission` gap。
3. 配置差异只允许两类：本轮预声明的实验变量；或当前 `gates.md`/trusted checker 明文授权、绑定其来源 SHA 的
   acceptance-only override。后者只可用于等价性验收，不得证明 live admission、candidate rank 或性能。除此之外，任何
   漏项或差异都记 `config_mismatch/证据不足`。
4. tx 时刻进程实际加载的 content-addressed pin 是“生产当时行为证据”；pre-tx 现算是可复算的分类证据。两者分歧
   写成**刷新/配置漂移**并保留两份 hash，不得静默选一份。今日刚生成的文件不能回答历史成员关系。
5. 活动阈值只适用于当前生产 discovery 明确定义为 activity-gated 的 venue。protocol/registry/behavior-discovered
   family 应沿审计 SHA 的真实 identity/admission 路径判断，不能套 DEX swap 事件阈值，也不能假定它永远是静态 entry。
6. 身份读取若需要旧 storage 而本地节点已裁剪，判定为证据能力不足；用 archive RPC、可验证的历史 pin 或 landed
   event + identity root 交叉验证，不能把 RPC 读不到写成 `identity fail`。
7. **禁止 look-ahead：**任何 universe/replay 输入都必须止于 tx 之前（`toBlock ≤ tx_block - 1`），或使用 tx 当时已经
   生效的 pin。包含目标 tx 的窗口会被该 tx 自身污染，只能证明“事后可见”，不能证明当时会自发发现。

### 0.4 架构无关的代码定位启发式

1. 在审计 SHA 上从实际 service/deploy command、package script 或 executable manifest 找生产入口，不预设它叫
   `main.ts`。用 `git ls-tree/git show` 确认分析的是该 SHA 的文件，而不是 dirty worktree。
2. 从 landed trace 的 target、selector/topic、adapter/edge id 与失败事件出发，用 `rg` 和 import/call graph 找到
   当前唯一 registry/capability owner，再沿真实调用链追踪：source → identity/admission → runtime graph/view →
   scanner/detector/refinement → planner → quote/sizing/warm → plan/compiler → state backend/final sim → EV/submission。
3. registry dispatch 后必须继续进入命中的具体 family module；旧 switch、旧路径或同名文件不自动算当前 owner。
   反过来，一个 shared owner 也不能被重复记成每个协议各自的 gap。
4. 用函数、注册项和 capability id 作为稳定定位，文件路径为本次审计结果、行号仅作辅助。重命名后只要真实调用链
   和能力相同，仍归同一阶段；找不到调用关系就写 `unresolved`，不能凭名字猜。
5. 只报告这笔交易实际经过或首先缺失的 owner。无需维护一张会随架构漂移的“所有阶段固定文件表”，也不为此新增
   scanner、hook 或复杂 gate；§3 的同块字段、§5 的逐阶段证据和 §6 的 symbol 定位就是轻量完整性检查。

## 1. 结论

- **交易：** `<full tx hash>`
- **审计基线：** `<canonical main ref> @ <full sha>`
- **当前生产结论：** `可复现 | 不可复现 | 已修复 | 不在生产目标 | 证据不足`
- **Gap 类型：** `scope | causality/multi-tx | pool | identity/admission | edge | path/enumeration | quote | plan | final-sim | EV | intake/causality | none`
- **是否只需补 adapter：** `已完成 | 是 | 否 | 部分 | 不适用`
- **一句话根因：** `<最先失败的生产阶段；已修复时写当前通过到哪一阶段>`

先回答当前结论。不得把历史缺口写成当前缺口，也不得用 `build 通过`、`in_graph=true` 或手工拼路线代替生产可复现证据。
独立 Adapter Replay runner 通过只记录 `adapter_replay_pass`；完成当前 trusted promotion 后才记录 `adapter_fixed`。
只有 Production Replay 不向生产 producer 提供 route/amount、并在输出冻结后才由 verifier 对照 expected route，
由生产入口自发发现并通过时，才能记录 `production_fixed`，并把当前
生产结论写为 `已修复/可复现`。

## 2. 调用工具

| 顺序 | 工具 | 用途 | 结果/证据 |
|---:|---|---|---|
| 1 | `<raw receipt / callTracer / pinned replay>` | `<人工事实>` | `<artifact>` |
| 2 | `<indexed tool id>` | `<capability query>` | `<manifest + execution receipt>` |

- **能力查询：** `<receipt, trace, pnl, causality, venue_identity, graph, replay 等实际查询集合>`
- **未调用的相邻工具：** `<按 capability 说明为何不需要窗口 census、live visibility 等相邻能力>`
- **正式工具清单来源：** `<tool-index manifest path + SHA-256>`

## 3. 交易事实

- **区块 / txIndex / builder：** `<values>`
- **Sender / code state：** `<from；parent code hash；block-end code hash；winner pre-state kind/hash 或 unknown>`
- **形态：** `<atomic_loop | backrun | inventory | keeper | rfq | unknown>`
- **毛利润 / builder payment / gas / 净利润：** `<values + denomination>`
- **因果状态：** `<boundary / trigger-only / full-prefix 已跑或未跑；未跑不得猜>`
- **跨交易依赖：** `<none | declared_trigger_dependency | multi_tx_dependency；依赖哪些 txIndex/hash 以及原因>`
- **闭环跳数 / 生产上限：** `<n / limit>`

同一 sender 在目标块的交易必须显式列出；即使只有 winner，也填一行。发现独立 executor、profit recipient、
sponsor 或 coinbase direct payment 时，将相关 bounded 相邻交易追加进表：

| txIndex / nonce（按 txIndex 排序） | Tx hash | From → To | 角色 | 对 winner 状态/资金的影响 |
|---|---|---|---|---|
| `<index / nonce>` | `<hash>` | `<from → to>` | `<setup/trigger/winner/disposal/refund/unrelated>` | `<fact or none>` |

只凭“同一 sender”不能宣告因果关系；必须由交易顺序、trace、state 或 balance delta 证明，nonce 只作连续性核对。反过来，未检查完整
block 就不能填写 `跨交易依赖=none`。

## 4. 实际核心闭环（逐腿双锚）

| # | Token in → out | Venue / target | Adapter / edge | 交易前状态（pre-tx 锚） | 当前状态（审计基线） | 结论 |
|---:|---|---|---|---|---|---|
| 1 | `<tokenIn → tokenOut>` | `<pool/target>` | `<adapterId>` | `<当时 universe/edge/adapter 状态>` | `<已覆盖/可闭合/仍然缺失>` | `<pass/fail>` |

每腿必须分开填两个时点（§0.3 的双锚与禁止 look-ahead）：**交易前状态**用 pre-tx lookback 现算或
tx 时刻 pin，**当前状态**用 §1 审计基线 SHA。当前状态词表：
`已支持/已覆盖`（adapter+准入都在）、`可闭合`（能力路径已定但未建/未准入，写明缺哪半）、
`仍然缺失`（结构性缺口，写明层）。两列结论不一致时（修复落地或活动窗口闪烁）不得合并成单一判定。

**Venue = 顶层调用锚，不是 trace 深处的实现合约（call-hierarchy 边界，硬规则）。** 每腿 `Venue / target`
必须是 bot/router 用 swap/exchange/deposit selector **直接调用**、且身份可**反向验证**（factory/registry/
`coins`/池 view）的地址。以下都**不是** route venue，禁止填进 Venue 列——把它们当 venue 会误报缺口、诱发
“为一个内部实现新建 family”的错：

- **proxy 的 implementation**（`delegatecall` 目标）：proxy 地址才是 venue，impl 是同一逻辑合约的实现层；
- **venue 内部子调用**：如 Curve underlying 池执行 `exchange_underlying(i,j,dx)` 时内部调 cToken、cToken 再调
  借贷组件（dForce/Compound 内部），这些都是**该 Curve 池的实现**——route venue 是 bot 直接调的那个 Curve
  池地址，不是 trace 深处的 cToken/借贷合约。
- **判定测试**：沿 token continuity（Transfer 日志）找到搬运本环 token 的地址 ∩ bot/router 用 swap-selector
  **直接**调用的地址 = venue；只在 callTracer 里作为**子调用/delegatecall**出现的更深地址是实现，不是 venue。
  身份也在 venue 地址上验（`coins()`/factory/registry），不在实现地址上验。

表格之后必须给出一行汇总读数（§7 裁决在路线层的直接投影）：

- **新增缺失 adapter 后能否闭合：** `能 | 不能（剩余堵点：<层 + 具体 venue/池>）`
  —— 假设所有"可闭合"腿的 adapter 都补齐，逐腿检查是否仍有"仍然缺失"腿：有任何一条即填
  `不能` 并列出该腿的层与地址；全部消除才填 `能`。这一行防止"补 adapter"被误当成整环修复。

只列维持本金闭合所必需的有序路线。flash principal、builder payment、利润换币、库存处置和无关 touch 单列，不能混成路线腿。

- **路线外动作：** `<例如：核心环赚取 USDT 后再换 WETH，属于利润退出腿>`
- **路线真值来源：** `<receipt/call trace token continuity + 同块交易关系 + trusted self-enumerating replay>`

## 5. 生产漏斗定位（统一领域六步）

这六步是架构无关的领域证据合同，不是固定文件或函数调用表。每项先选择一个验收轨道：

| 轨道 | 能证明什么 | 六步要求 |
|---|---|---|
| `family_execution` | trace-proven route 上，一个 quote-bearing `RouteLeg` execution family 的 quote、plan/size、encode、final sim、守恒与 EV 正确；funding-only family 不作为本轨 subject | route 可固定，amount/quote/plan/calldata 不得固定；步骤 1–2 明记 `bypassed`，步骤 3–6 必须由生产代码通过；结论最多 `adapter_fixed` |
| `production_route_stage` | 生产漏斗能自发发现并推进这条历史路线 | 生产运行只能收到交易与状态锚；expected route 由 verifier 保留，等输出冻结后再比较；六步按实际到达状态记录 |
| `systemic_live` | intake、admission、universe、ranking、分布、延迟、并发、deadline 或资源行为 | 单笔六步仅作诊断；正式结论来自预声明正负 cohort、同输入公平性、资源/性能和 Hermes A/B |

统一的六步顺序如下。状态词表固定为 `pass | fail | reject | bypassed | not_reached`：

| # | 稳定领域阶段 | 结果 | 必填核心证据 |
|---:|---|---|---|
| 1 | `discovery_admission_graph`（发现/身份准入/图） | `<status>` | `<候选来源与状态锚；identity/admission proof；canonical edge identities；runtime graph membership；配置/universe hash>` |
| 2 | `route_enumeration`（路线枚举） | `<status>` | `<生产枚举自然产出的 canonical ordered route identities；是否包含目标路线；不得由 expected route 影响枚举/筛选>` |
| 3 | `exact_quote_refine`（精确报价/精炼） | `<status>` | `<state block/root；逐腿 exact amountIn/amountOut、fee、rounding；refine 前后语义结果>` |
| 4 | `plan_and_size`（计划与 sizing） | `<status>` | `<canonical plan identity；solver 自选 amount；resolved 逐腿金额与约束>` |
| 5 | `fork_final_sim`（fork 最终模拟） | `<status>` | `<编译 calldata/script hash；正确 parent/trigger/full-prefix 锚；success/revert；profit/gas；repayment/conservation/standing position>` |
| 6 | `production_ev`（生产 EV） | `<status>` | `<估值与 policy 输入；gas/bid/haircut；allow/reject、reason、net EV>` |

Gap 定位到有序证据前缀末尾的第一个 `fail | reject | not_reached`，并在该记录处终止；未执行的后续阶段不再生成
machine evidence。人工六行报告可把余下行显示为 `not_reached`，但不得参与哈希、等价性或伪装成实际执行结果。
baseline→fix 的 stage advance 与重构等价性是比较共同执行到的规范化领域证据，不是第七步。功能修复记录第一个失败
阶段如何前进；等价重构比较所有受影响 fixture 的规范化核心字段。全局
registry/state/planner/quoter 重构还必须有跨 family 正负 cohort；触及热路径、资源或分布就进入 `systemic_live`。

Adapter Replay 用 trace-proven route，但不提供 amount、quote、plan 或 calldata；步骤 1–2 必须诚实写 `bypassed`，
runner 通过只记 `adapter_replay_pass`，trusted promotion 后才记 `adapter_fixed`。它不证明 production discovery、
candidate rank 或 stage advance。只有 Production Replay 不向生产 producer 提供 route/amount，并由生产入口自然完成
适用阶段，才能记录 `production_fixed`。
若 diff 同时影响多个 family，必须由 base/challenger production registry 与 active ActionAdapter catalog 自动派生
所有 owner；去重后的 changed-owner 集合必须与 fixture subject 集合完全相等。共享实现文件不能只验一个 owner，
也不能靠手工协议清单声明“其余不受影响”。baseline 的可翻转失败还必须具备稳定
`{ownerFamilyId, stageId, code}`；timeout、abort、RPC/provider 和未分类错误只算基础设施失败。

`expected_route` 只能是 verifier 的 output oracle：先让生产枚举、筛选、排序、候选保留、top-K、solve-set 选择和 sizing
全部结束并冻结输出，再进行完整有序身份比较。不得把 expected route/pools/tokens、其 hash 或派生选择提示传入生产
producer；不得把目标追加到 solve set、强制 probe 或因目标存在而扩大局部预算。若自然输出未包含目标，步骤 2
`fail`；若包含但未自然进入后续选择，在第一个无法继续的步骤记录 `not_reached` 并终止证据前缀。

每个阶段可带 namespaced `extensions`，记录 wall time、rank、计数器、debug 文本、源码位置或实现特有中间值。
extensions 保留用于诊断，但不参加语义等价。若本轮声明就是 latency/rank/resource，则这些字段属于
`systemic_live` 的预声明 metric/cohort，而不是六步等价字段。

证据绑定 capability ID、canonical edge/route identity、状态锚和领域数值，不绑定文件路径、函数名、类名或模块数量。
能力搬家、拆分、合并或改为 registry dispatch 后仍使用同一六步语义。未知 extension 字段保留且不参与旧版语义比较；
缺少核心字段 fail closed；新增或修改必填核心字段必须升级 schema，并由独立 trusted verifier 更新。

对 backrun，未收到 victim、transition/decode、identity/admission/graph 都定位到第 1 步；其中
`input_not_received` 的“已修复”声明必须由 live orderflow 证据完成，历史 fork 只能记录，不能证明。必要 edge
都在但未形成 route 是第 2 步；状态/overlay/exact quote 是第 3 步；planner、borrowability、sizing 以及 resolved
plan 产生前的 solver 内部 sim 是第 4 步；solver 返回后独立 mandatory final sim 是第 5 步。六步全过但仍错过
区块属于 latency/submission/inclusion，进入 `systemic_live`，不是第 7 步。

步骤 1 必须把 candidate source、identity/admission 和 runtime graph membership 分开记录；`in_graph=true` 不能替代
自发发现。步骤 5 必须同时留下编译产物和执行结果，不能只报 fork 成功。准入证据按 §0.3 使用审计 SHA 反查实际
窗口、阈值、独立 cap、identity policy 与 builder，并证明 Production Replay 配置按消费语义映射到 live。pin 与现算
分歧写成刷新/配置漂移；tx 时刻与当前状态不一致也必须分列，不能合并成一个 pass/fail。

人工裁决只拥有轨道与 scope 分类权：可以保留某个 machine failure 并说明它不属于当前声明，但不能把 `fail` 改成
`pass`、代替必填阶段，或用 prose 证明 identity/probe、quote、plan/size、encoding、final sim、守恒、EV、状态/config
锚或安全边界。只有另一可信机器 producer 已覆盖当前声明全部必需性质时，范围外失败才不阻断该声明。

## 6. 精确代码定位

| Gap / 能力 | 文件 | 函数或注册项 | 失败机制 | 最小改动 |
|---|---|---|---|---|
| `<gap>` | `<absolute repo path>` | `<symbol>` | `<mechanism>` | `<change>` |

定位必须按 §0.4 在审计 SHA 重新完成：先写 production entry/registry owner，再写 dispatch 命中的 family/shared
implementation；如果失败发生在输入、budget 或全局 policy，不能为了套 adapter 格式而只列 adapter 文件。使用
`git ls-tree/git show` 证明路径属于审计 SHA，并用 import/call site 证明 symbol 确实在生产链上。以函数、注册项或
capability id 为主，行号为辅。若当前已修复，列“能力现在落在哪”，不要把旧路径或历史 line number 写成待修问题。

## 7. 是否只需补 adapter

逐项核对：

- [ ] 已有 adapter family 可直接复用
- [ ] 新实例身份/discovery 能从 family metadata、canonical identity root 或统一 behavior policy 派生，不靠实例 allowlist
- [ ] runtime route/edge、quote、mid、plan、warm/prepared、impact observation 与 final-sim 均被覆盖
- [ ] landed event / scanner observation 能从共享 metadata 或当前 family capability 派生
- [ ] 如需 backrun，victim model / impact decoder / intake 已覆盖
- [ ] 新 target 能进入当前 intake/graph/view 的派生通路，不需要另加一份地址表
- [ ] profit-token valuation、flash liquidity 与风险策略没有另一个缺口
- [ ] coarse rank、exact refinement、search budget / candidate cap 没有在 adapter 之后剪掉路线

**唯一裁决：** `已经完成 | adapter-only | adapter + registry metadata | adapter + victim model | 非 adapter 的 admission/planner/economics gap | 不适用（scope）`

“补 adapter”只代表执行能力主路径。新 victim 类型、因果 intake、估值、flash 资金和搜索预算仍可能是独立能力，不能用 adapter 结论代替检查。

## 8. 验收

- **失败样本：** `<tx hash>`
- **同块 sender 审计：** `<完整 block artifact/hash；同 sender txIndex 集；dependency verdict>`
- **状态锚：** `<parent block/state root；backrun 另列 trigger-only/full-prefix prefix>`
- **冻结 universe 锚：** `<实际生产 pin 与 SHA；pre-tx 重建参数/输出 SHA；窗口必须 toBlock ≤ tx_block - 1；builder 代码 SHA>`
- **生效配置锚：** `<live process/deploy/fallback manifest + SHA；replay manifest + SHA；按消费阶段映射；diff=none | 预声明实验差异 | trusted acceptance-only override + 授权 SHA>`
- **运行时视图锚：** `<live/replay 各 view 的 count+hash；目标池/edge membership；差异解释>`
- **验收轨道 / 层级：** `<family_execution / Adapter Replay runner | family_execution / trusted adapter promotion | production_route_stage / Production Replay | systemic_live / cohort+A/B>`
- **baseline：** `<first failing stage>`
- **fix commit：** `<sha or none>`
- **可信入口：** `<在审计 SHA 的 gate/runbook/manifest 中发现的 trusted producer+verifier 及 source hash；source identity 仅作防漂移元数据，不参加六步语义等价>`
- **期望翻转：** `<canonical 首败阶段 fail/not_reached → pass，或受影响 fixture 的六步核心字段等价>`
- **实际结果：** `<adapter_replay_pass | adapter_fixed | production_fixed | stage result | cohort/A-B result>`
- **生产是否自发产出路线：** `是 | 否 | 不适用（family_execution 的步骤 1–2 bypassed）`
- **是否提供 route / amount：** `<Adapter Replay 可 route-pinned、不得提供 amount/quote/plan/calldata；Production Replay 的 producer 两者都不得获得，expected route 仅由 verifier 在输出冻结后读取>`
- **逐 wei / calldata / EV：** `<quote amounts；calldata/script hash；final-sim profit/gas；EV decision>`
- **是否需要 live：** `<确定性 route correctness 通常不需要；systemic scanner/universe/分布/性能、延迟或 intake 可见性需要>`

route-stage 功能修复必须由同一历史输入从第一个失败阶段翻转；family 等价重构必须证明所有受影响 fixture 的 §5
核心字段一致；extensions 不参与语义等价。共享热路径或跨 family 重构另做 cohort 与 live performance。六步不作为
无关系统性改动的部署/决策开关；后者按预声明 cohort 和 A/B 验收。trusted producer/verifier 从审计基线或独立可信
tooling 读取，challenger 不得随实现一起弱化。若 sender/full-prefix 审计发现未声明的多交易依赖，先修正交易分类和
状态锚，再谈翻转。
Adapter Replay runner 只证明已知 route 的 execution family 能力并产出 `adapter_replay_pass`；trusted promotion 后才是
`adapter_fixed`。只有不提供 route/amount、由生产入口自发发现的 Production Replay 才能产出 `production_fixed`。

## 9. 工具一致性

- **人工事实 vs 正式工具：** `一致 | 有意 fail-closed | 分歧`
- **解释：** `<例如：postmortem 识别 protocol touch，但因未重建有序核心路线而 MANUAL REQUIRED>`
- **工具分歧：** `none | <divergence_id；status=open_frozen；记录路径；本轮新增 tx hash>`
- **对抗审查：** `<reviewer + verdict；仅在人工/工具覆盖冲突时必填>`

## 历史示例（只示范填法）

> 以下路径、参数、rank 和 pin 都绑定示例当时的代码/输入锚；新分析必须按 §0 重新发现，不得复制为当前真相。

### 示例：`0x149df3ec…fde60` 的当时结论

- 核心闭环是四腿：`USDT→PAXG→GOLDx→USDx→USDT`。
- Moxie `0x1bc610…` 把闭环赚到的约 `0.442405 USDT` 换成 WETH，是利润退出腿，不是核心闭环第五腿。
- GOLDx 能力位于 `venues/protocols/goldx.ts::goldxAdapter`；Curve underlying 能力位于 `venues/swaps/curve-underlying.ts::curveUnderlyingAdapter`；两者均在 `production-registry.ts::PRODUCTION_ROUTE_ADAPTERS` 注册。
- 该示例当时的 `blockscan-hunt-tx149.ts` 报告记录了冻结 production universe 与
  `not_admitted → final_sim_success`、`net_profit_raw=442380`。按当前合同复用这份证据前，还必须重新证明 expected
  route 没有进入枚举、筛选或 solve-set 选择；旧报告本身不能自动升级为新的 `production_fixed`。
- 该示例当时判定 main 已修复且不需要再补 adapter；按当前合同重新引用这个结论时必须重跑
  `production_route_stage`。历史改动也不只是 adapter：rank 89 路线还依赖通用 block-scan candidate cap 从 20
  扩到 100，因此不能拿 family replay 单独证明生产会选中它。
- 当前 `bundle-postmortem` 已通过 `GOLDx target + mint(address,uint256)` 识别 `protocol`，但故意不从 touch-set 自动猜核心闭环，因此 `MANUAL REQUIRED` 是诚实降级，不是工具缺陷。

### 示例：`0x14026eed…f4fd53` 的逐腿双锚表（§4 的填法范本）

pre-tx 锚 = 窗口 `[tx-14400, tx-1]` 现算 + tx 时刻 pin `4caf4b2f`；当前锚 = 复核当日 origin/main。

| 腿 | 交易前状态（pre-tx 锚） | 当前状态 | 结论 |
|---|---|---|---|
| Flash USDT（Balancer V2 Vault） | 已支持 | 不变 | pass |
| USDT→uAD，Curve `0x20955c…` | 2 天窗内有活动（2 笔），adapter 已有 | 已覆盖 | pass |
| uAD→uCR，Manager `0x432120…` | 无 protocol edge，无 adapter | **可闭合**（身份根 `hasRole` 已证 + declaredVenues 路径已定；adapter 未建，EV 门不立项） | fail |
| uCR→WETH，V2 `0xd9dc4a…` | pre-tx 所有窗口 0 swap，不在 universe | **仍然缺失**（死池活动门盲区，归 arb-relevance） | fail |
| WETH→USDT，V2 `0x3a8414…` | 19 笔活动但身份门拒未知 factory | 已覆盖（`58f2045` provisional 修复有证据） | pass |

- **新增缺失 adapter 后能否闭合：不能（剩余堵点：pool/admission，uCR/WETH `0xd9dc4a…` 死池
  不在任何 pre-tx universe 窗口）** —— 补齐 ubiquity-credit adapter 后腿 3 变 pass，但腿 4
  仍缺边，环闭不上；该堵点归 arb-relevance/cold-pool 修复，不归 adapter 工作。

示范要点：腿 3 两列不一致（当时无边 → 现在路径已定但未建）与腿 5 两列不一致（当时身份拒 →
现已修复）各自写明原因，不合并；腿 4 是唯一双锚都缺的结构性缺口，`Gap 类型` 因此填
`pool/admission`，不被腿 3 的 `可闭合` 稀释；汇总行"能否闭合 = 不能"正是 §7 裁决
`adapter + 非 adapter 的 admission gap` 的路线层读数。
