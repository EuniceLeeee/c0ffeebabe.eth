# TX Gap 分析 — 固定回答格式

> 输入：一笔竞争者已落地的 tx hash。目标：以当前 `origin/main` 为基线，回答生产能否复现、首个失败阶段、具体文件/函数，以及是否只需补 adapter。

## 0. 固定方法

1. 先从 receipt、trace、token continuity 和现有 pinned replay 人工重建事实。
2. 再运行当前生成的 `tool-index`，按所需 capability 选择正式工具，并通过 `tool-run` 留 execution receipt；禁止凭记忆硬编码工具名。
3. 单笔交易通常不调用 `census-gap`，因为它解决窗口枚举，不解决单笔深挖。
4. `graph-in` 只说明生产快照成员关系；“生产能复现”必须继续看到成功 TokenEdge、scanner 自发枚举、quote、plan 和 final sim。
5. 如果 postmortem 因无法区分核心闭环与利润处置而输出 `MANUAL REQUIRED`，这是 fail-closed；用 token continuity 和可信 replay 消歧，不能把全部 touched venues 强行拼成路线。
6. universe 成员关系的**判定标准 = tx 前 lookback 窗口现算**：用 canonical builder 钉窗重建
   （`POOL_UNIVERSE_FROM_BLOCK=<tx_block-lookback> POOL_UNIVERSE_TO_BLOCK=<tx_block-1> POOL_UNIVERSE_OUT=<scratch> npm run searcher:pool-universe`，
   lookback 取生产参数 `POOL_UNIVERSE_LOOKBACK_DAYS × 7200`，当前 2 天 = 14400 块），或等价地按 landed-event-registry
   的 topic 集对该池数 `[tx-lookback, tx-1]` 内的 swap 事件是否 ≥ minSwaps。这是链上可复算、任何人可复验的标准。
   tx 时刻实际加载的 hash-pin（`/opt/MEV-runtime/universe/active-pools-<sha>.json`，按部署/进程启动时间选；“当前生效”
   以进程 env `SEARCHER_POOL_UNIVERSE_PATH` 为真源）只是**实际行为证据**，用来解释生产当时真实的漏斗输出，不是 gap
   分类的判定标准。两者分歧 = **刷新滞后**（pin 老化的 ops 问题），单列一行，不得计入 pool/admission gap。用 cron 刚
   重建的今日文件回答历史成员关系 = 锚错时点，结论作废（type case：`0x14026eed…` 首查用了窗口起点晚于 tx 90 分钟的
   重建文件，结论与 pre-tx 现算相反）。现算/pin 对照必须声明 builder 代码版本——同一窗口不同代码结论相反（type
   case：58f2045 引入 factory-call-provisional 前后，未知 factory V2 pair 准入相反）。两个已知边界：
   （a）**minSwaps 判定只适用于 DEX swap 池**。protocol venue 不发标准 swap 事件，活动扫描原理上看不见它，走
   token-graph 静态 protocol entry 声明式进图（curated backbone，不闪烁）；对 protocol 腿判"当时在不在图"只看
   当时代码里有无该 entry + adapter，不查活动窗口。（b）钉窗重建把身份 eth_call pin 到窗口末块；tx 早于节点状态
   保留期（reth --full 约 1 万块）时这些调用失败，未知 factory 池被 fail-closed 掉——这是证据局限不是准入结论
   （type case：`0x3a8414b0` 窗口内 19 笔 swap，本地钉窗重建因裁剪拒之，节点新鲜状态构建收之）。老 tx 用
   landed-event topic 事件计数 + tx 时刻 pin 交叉，或换 archive RPC。
7. **禁止 look-ahead 输入**：复现判定与 §8 验收的冻结 universe，窗口必须止于 tx 块之前（`toBlock ≤ tx_block - 1`，或直接用 tx 时刻生效的 pin）。窗口含 tx 块的 universe 已被该 tx 自身的 swap 污染——死池正是被竞争者这笔交易注入 universe 的；它只能证明“事后 2 天内看得见”，不能证明“当时能自发抓到”。type case：`0x14026eed…` 的 uCR/WETH pair 在含 tx 窗口的 pin 里存在，在所有 pre-tx 窗口（含 tx 时刻现建）都不存在；用含 tx 的 pin 判定会得出“只缺 adapter”的假结论。

## 1. 结论

- **交易：** `<full tx hash>`
- **审计基线：** `origin/main @ <full sha>`
- **当前生产结论：** `可复现 | 不可复现 | 已修复 | 证据不足`
- **Gap 类型：** `pool | identity/admission | edge | path/enumeration | quote | plan | final-sim | EV | intake/causality | none`
- **是否只需补 adapter：** `已完成 | 是 | 否 | 部分`
- **一句话根因：** `<最先失败的生产阶段；已修复时写当前通过到哪一阶段>`

先回答当前结论。不得把历史缺口写成当前缺口，也不得用 `build 通过`、`in_graph=true` 或手工拼路线代替生产可复现证据。

## 2. 调用工具

| 顺序 | 工具 | 用途 | 结果/证据 |
|---:|---|---|---|
| 1 | `<raw receipt / callTracer / pinned replay>` | `<人工事实>` | `<artifact>` |
| 2 | `<indexed tool id>` | `<capability query>` | `<manifest + execution receipt>` |

- **未调用的相邻工具：** `<例如：单笔 tx 不调用 census-gap>`
- **正式工具清单来源：** `<tool-index manifest path + SHA-256>`

## 3. 交易事实

- **区块 / txIndex / builder：** `<values>`
- **形态：** `<atomic_loop | backrun | inventory | keeper | rfq | unknown>`
- **毛利润 / builder payment / gas / 净利润：** `<values + denomination>`
- **因果状态：** `<boundary / trigger-only / full-prefix 已跑或未跑；未跑不得猜>`
- **闭环跳数 / 生产上限：** `<n / limit>`

## 4. 实际核心闭环（逐腿双锚）

| # | Token in → out | Venue / target | Adapter / edge | 交易前状态（pre-tx 锚） | 当前状态（审计基线） | 结论 |
|---:|---|---|---|---|---|---|
| 1 | `<tokenIn → tokenOut>` | `<pool/target>` | `<adapterId>` | `<当时 universe/edge/adapter 状态>` | `<已覆盖/可闭合/仍然缺失>` | `<pass/fail>` |

每腿必须分开填两个时点（§0.6 双锚纪律的逐腿粒度）：**交易前状态**用 pre-tx lookback 现算或
tx 时刻 pin（§0.7 禁止 look-ahead），**当前状态**用 §1 审计基线 SHA。当前状态词表：
`已支持/已覆盖`（adapter+准入都在）、`可闭合`（能力路径已定但未建/未准入，写明缺哪半）、
`仍然缺失`（结构性缺口，写明层）。两列结论不一致时（修复落地或活动窗口闪烁）不得合并成单一判定。

表格之后必须给出一行汇总读数（§7 裁决在路线层的直接投影）：

- **新增缺失 adapter 后能否闭合：** `能 | 不能（剩余堵点：<层 + 具体 venue/池>）`
  —— 假设所有"可闭合"腿的 adapter 都补齐，逐腿检查是否仍有"仍然缺失"腿：有任何一条即填
  `不能` 并列出该腿的层与地址；全部消除才填 `能`。这一行防止"补 adapter"被误当成整环修复。

只列维持本金闭合所必需的有序路线。flash principal、builder payment、利润换币、库存处置和无关 touch 单列，不能混成路线腿。

- **路线外动作：** `<例如：核心环赚取 USDT 后再换 WETH，属于利润退出腿>`
- **路线真值来源：** `<receipt/call trace token continuity + trusted self-enumerating replay>`

## 5. 生产漏斗定位

| 阶段 | 结果 | 证据 |
|---|---|---|
| 身份 / discovery / admission | `<pass/fail/not-run>` | `<fact>` |
| TokenEdge 构建 / runtime graph | `<pass/fail/not-run>` | `<fact>` |
| Scanner 自发枚举 | `<pass/fail/not-run>` | `<fact>` |
| Quote | `<pass/fail/not-run>` | `<fact>` |
| Plan build | `<pass/fail/not-run>` | `<fact>` |
| Final sim | `<pass/fail/not-run>` | `<fact>` |
| EV / submit | `<pass/fail/not-run>` | `<fact>` |

Gap 定位到第一个失败阶段。`fixed` 必须由同一历史输入的阶段翻转证明；手工注入 path/amount 只证明可执行性，不证明生产能找到。

每格证据必须注明输入锚。准入行的判定锚 = **pre-tx lookback 窗口现算**（§0.6：窗口 `[tx-lookback, tx-1]` + minSwaps + builder 代码 SHA）；pin 只作实际行为证据（标识 + 窗口/generatedAt）。现算与 pin 结论不一致 = 刷新滞后，单列一行；tx 时刻与当前状态不一致（活动窗口闪烁是常态）也分两行写明各自的锚，均不得合并成单一 pass/fail。

## 6. 精确代码定位

| Gap / 能力 | 文件 | 函数或注册项 | 失败机制 | 最小改动 |
|---|---|---|---|---|
| `<gap>` | `<absolute repo path>` | `<symbol>` | `<mechanism>` | `<change>` |

以函数/注册项为主，行号为辅。若当前已修复，列“能力现在落在哪”，不要再把旧文件位置写成待修问题。

## 7. 是否只需补 adapter

逐项核对：

- [ ] 已有 adapter family 可直接复用
- [ ] 新协议身份/discovery 能从 adapter metadata 或统一 identity policy 派生
- [ ] edge、quote、plan、warm/prepared/final-sim 均被覆盖
- [ ] block-scan landed event 能从共享 event metadata 派生
- [ ] 如需 backrun，victim model / impact decoder / intake 已覆盖
- [ ] profit-token valuation、flash liquidity 与风险策略没有另一个缺口
- [ ] search budget / candidate cap 没有在 adapter 之后剪掉路线

**唯一裁决：** `已经完成 | adapter-only | adapter + registry metadata | adapter + victim model | 非 adapter 的 admission/planner/economics gap`

“补 adapter”只代表执行能力主路径。新 victim 类型、因果 intake、估值、flash 资金和搜索预算仍可能是独立能力，不能用 adapter 结论代替检查。

## 8. 验收

- **失败样本：** `<tx hash>`
- **冻结 universe 锚：** `<pin 标识或重建参数；窗口必须 toBlock ≤ tx_block - 1（§0.7 禁止 look-ahead）+ 建图代码 SHA>`
- **baseline：** `<first failing stage>`
- **fix commit：** `<sha or none>`
- **可信命令：** `<existing pinned harness>`
- **期望翻转：** `<no_candidate → path_found → final_sim_success, etc.>`
- **实际结果：** `<result>`
- **scanner 是否自发产出路线：** `是/否`
- **是否注入 path / amount：** `否` 才能证明枚举修复
- **是否需要 live：** `<确定性正确性通常不需要；仅分布/延迟/intake 可见性需要>`

## 9. 工具一致性

- **人工事实 vs 正式工具：** `一致 | 有意 fail-closed | 分歧`
- **解释：** `<例如：postmortem 识别 protocol touch，但因未重建有序核心路线而 MANUAL REQUIRED>`
- **工具缺陷：** `none | <LearningCase + file/function + codify commit>`
- **对抗审查：** `<reviewer + verdict；仅在人工/工具覆盖冲突时必填>`

## 示例：`0x149df3ec…fde60` 的当前结论

- 核心闭环是四腿：`USDT→PAXG→GOLDx→USDx→USDT`。
- Moxie `0x1bc610…` 把闭环赚到的约 `0.442405 USDT` 换成 WETH，是利润退出腿，不是核心闭环第五腿。
- GOLDx 能力位于 `venues/protocols/goldx.ts::goldxAdapter`；Curve underlying 能力位于 `venues/swaps/curve-underlying.ts::curveUnderlyingAdapter`；两者均在 `production-registry.ts::PRODUCTION_ROUTE_ADAPTERS` 注册。
- `blockscan-hunt-tx149.ts` 使用冻结 production universe，让未改造的 scanner 自发枚举四腿；不注入 path/amount，结果从 `not_admitted` 翻转为 `final_sim_success`，`net_profit_raw=442380`。
- 因此这笔在当前 main 已修复，不需要再补 adapter。历史修复也不只是 adapter：rank 89 路线还依赖通用 block-scan candidate cap 从 20 扩到 100。
- 当前 `bundle-postmortem` 已通过 `GOLDx target + mint(address,uint256)` 识别 `protocol`，但故意不从 touch-set 自动猜核心闭环，因此 `MANUAL REQUIRED` 是诚实降级，不是工具缺陷。

## 示例：`0x14026eed…f4fd53` 的逐腿双锚表（§4 的填法范本）

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
