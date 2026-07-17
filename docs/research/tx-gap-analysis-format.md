# TX Gap 分析 — 固定回答格式

> 输入：一笔竞争者已落地的 tx hash。目标：以当前 `origin/main` 为基线，回答生产能否复现、首个失败阶段、具体文件/函数，以及是否只需补 adapter。

## 0. 固定方法

1. 先从 receipt、trace、token continuity 和现有 pinned replay 人工重建事实。
2. 再运行当前生成的 `tool-index`，按所需 capability 选择正式工具，并通过 `tool-run` 留 execution receipt；禁止凭记忆硬编码工具名。
3. 单笔交易通常不调用 `census-gap`，因为它解决窗口枚举，不解决单笔深挖。
4. `graph-in` 只说明生产快照成员关系；“生产能复现”必须继续看到成功 TokenEdge、scanner 自发枚举、quote、plan 和 final sim。
5. 如果 postmortem 因无法区分核心闭环与利润处置而输出 `MANUAL REQUIRED`，这是 fail-closed；用 token continuity 和可信 replay 消歧，不能把全部 touched venues 强行拼成路线。
6. 漏斗归因必须锚定 **tx 时刻生效的输入快照**，不是今天的重建产物。universe 成员关系以节点 hash-pin 文件为准（`/opt/MEV-runtime/universe/active-pools-<sha>.json`，按部署/进程启动时间选出 tx 时刻实际加载的那份；“当前生效”以运行进程 env `SEARCHER_POOL_UNIVERSE_PATH` 为真源）。“当时为何漏”用 tx 时刻 pin，“当前能否复现”用当前 pin 或冻结 universe——两问分开锚定、分开作答。用 cron 刚重建的 active-pools 回答历史成员关系 = 锚错时点，结论作废（type case：`0x14026eed…` 首查用了窗口起点晚于 tx 90 分钟的重建文件，得出与 tx 时刻 pin 相反的准入结论）。dust 池的成员身份随 2 天活动窗口闪烁，任何单一快照都不可外推到其他时点。“现建对照”实验必须同时声明建图所用 builder 代码版本——同一窗口，不同代码建出的 universe 不同（type case：58f2045 引入 factory-call-provisional 前后，未知 factory V2 pair 的准入相反）。
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

## 4. 实际核心闭环

| # | Token in → out | Venue / target | Adapter / edge | 当前生产阶段 | 结论 |
|---:|---|---|---|---|---|
| 1 | `<tokenIn → tokenOut>` | `<pool/target>` | `<adapterId>` | `<edge/quote/plan/sim>` | `<pass/fail>` |

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

每格证据必须注明输入锚（universe pin 标识 + 窗口/generatedAt，或状态块高）。tx 时刻与当前状态结论不一致时（活动窗口闪烁是常态），分两行分别写明各自的锚，不得合并成单一 pass/fail。

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
