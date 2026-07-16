# RouteAdapter 重构 — Codex × Claude 交叉审查决策表

> 基线:`abc30a2`(route-leg-adapter refactor 已合入 main,逐-wei 等价验收通过:图/环/quote/sim/EV 五阶段 SHA 双端相同,含 tx2 `0x7ce631` Balancer V3 正向 sim `netProfit=150817806425095` calldata 逐字节相同)。
> 本表记录**谁提出、对方是否同意、核实结论**。Codex = Sol;Claude = fable(非作者对抗审查,逐条核代码)。
> **总纲共识**:merge 合理且线上已跑新 searcher(systemd `mev-searcher` ExecStart=`searcher:live`=`main.ts`,active,已核);等价性只证"重构未改坏行为",不证"无预存 gap / 未来不漏配"。以下多数是**未来漂移硬化**,当前无 live 故障。

## 1. 生产侧"手工平行清单会漂"点(核心议题)

| # | 点 | 提出方 | 对方是否同意 | 核实结论 |
|---|---|---|---|---|
| 1 | **swap victim 未从 route 派生** — Balancer V3 有 route 却无 victim-model + 无 pool-impact decoder → 不能 backrun;测试方向反了(查 victim→route,不查 route→victim)静默 PASS | Codex | **Claude 同意**(逐条核实成立);但**重定性**:非回归,是**预存覆盖 gap**(baseline 也没 balancer-v3 victim),等价性正确未报 | 真 gap,§20 该修;framing=补覆盖 |
| 2 | balancer-v3 打分/mid drift(mid-readers 零 balancer) | Claude | **Claude 自己撤回**(tx2 逐 wei 过反证:balancer-v3 走通用打分路径,字面 grep 0 ≠ 被丢) | 误报,撤回 |
| 3 | swap topic 在 active-pool-discovery + build-active-pool-universe 两处各写 7 个 | Codex+Claude | 双方一致 | 真漂移风险(当前一致);修=从 adapter 声明 topic、registry 汇总 |
| 4 | **P0-1 默认入口** `start`/`dev`→旧 `src/index.ts` | Codex | **Claude 部分同意但降级**:事实对,但 systemd 跑 `searcher:live`(新)已核 → 是 footgun,非"线上跑旧代码"。改一行即可 | 降 P0→低;线上正常 |
| 5 | **P0-2 path-template `SWAP_ADAPTERS` 手工枚举** → 未登记 edge 静默 no_candidate | Codex | **Claude 部分同意但降级**:当前清单**已含 balancer-v3-unlock + 派生 protocol legs,一个不缺**;"planner 按它过滤"消费方未证实 | 降 P0→漂移风险;当前完整 |
| 6 | **P0-3 protocol flag** `filterLiveProtocolRegistry()` 手写 6 协议 | Codex | **Claude 部分同意**:当前一致,未来漂移风险 | 降 P0→P1 |
| 7 | **P0-4 V2 factory 身份 vs fee 分叉**(Pancake 在 v2-fee 有、capability 无) | Codex | **Claude 部分同意**:Pancake 走 provisional-factory + v2-fee 25bps 能跑(fee 对,只标 provisional);非当前故障 | 降 P0→按设计工作 |
| 8 | router discovery swap topic 只认 V2/V3/V4(漏 Curve/Balancer V3-only router) | Codex | Claude 同意 | P1 漂移 |
| 9 | 两套 active-pool scanner 各维护 topic/解析 | Codex | Claude 同意 | P1 收口(保留两入口、共享 scanner 核) |
| 10 | capability `supported_in_prod` vs `PRODUCTION_ROUTE_ADAPTERS` 双真值 | Codex | Claude 同意 | P1 改为派生(身份可独立,执行支持不能两份) |
| 11 | warm invalidation topic 与 adapter 分开维护 | Codex | Claude 同意 | P1 收口 |
| 12 | pool adapter 解析白名单(override 缺 curve-underlying/balancer-v3) | Codex | Claude 同意(Codex 自己 P0→P1:override 文件为空,潜在缺陷非当前故障) | P1 |
| 13 | Flash target 两表 / 三层注册 / swap-count debug 只认 V2/V3 | Codex | Claude 同意低优先 | P2 |

**统一修法(1/3/8/9/10/11 同源)**:这些"venue 是什么"的事实应从 **route registry 派生**,不手工维护平行清单。§20 victim 修复应扩成"mid/discovery/victim/decode/topic 全从 route adapter 派生",一次堵住多个漏配点。

## 2. codex-plan.md 设计层发现(§15–20)

| # | 点 | 提出方 | 对方是否同意 | 结论 |
|---|---|---|---|---|
| 14 | H1 quote sync/async 分层(prewarm async / mid+quoteLocal sync / quoteExact async) | Claude | Codex 未明确回,Sol 六步也漏了 | 高危,必修 |
| 15 | H2 warm 协调器阶段提前(避免 live 半脑态) | Claude | — | 高危,必修 |
| 16 | H3 与在飞 feature work 串行化 | Claude | — | 高危(10 文件 cherry-pick 冲突已实证) |
| 17 | H7 deriveEdgeTaxonomy 安全位对齐(S2 guard 绕过) | Claude | 两位 reviewer(含 Sol)都漏 → 更须显式 | 高危,必修 |
| 18 | H8 LiquidityAdapter 占位不实现(lp 无 runtime slot、JIT-LP out-of-Mission) | Claude | — | 只留门 |
| 19 | 两层 SwapAdapter+ActionAdapter(一 swap 多 action) | Codex | **Claude 同意**(修正了 Claude 早先 encode-only 的错) | Codex 对 |
| 20 | 三 ID(VenueId/SwapCapabilityId/ActionAdapterId) | Codex | **Claude 不同意**:1 个分发键(adapterId)+ edgeKind 标记 + provenance 字段即可;三 ID 是 speculative | 简化 |
| 21 | 四类 RouteLegAdapter(Swap/Protocol/Liquidity/Flash) | Codex | Claude 同意(Liquidity 占位) | 采纳 |
| 22 | 六步责任组件分解 + V2 探测最小集 | Codex | Claude 同意 | 采纳 |
| 23 | Collector→Strategy→Executor Engine 边界 | Codex | Claude 先判虚胖后**撤回同意保留**(已知多策略=非投机;留接口、实现轻) | 保留边界 |
| 24 | victim detect 从 route 派生、raw-tx-replay 万能兜底、applyLocal 只是优化 | Claude(纠正 Codex detect-only 默认) | Codex 后续采纳 | swap-leg |

## 3. 验证 / 等价性

| # | 点 | 提出方 | 对方是否同意 | 结论 |
|---|---|---|---|---|
| 25 | 等价用逐-wei 不是 95%;两轴(正确性 100% 集合精确 / 延迟 95%) | Claude | Codex 采纳(最终报告五阶段 SHA) | 已执行 |
| 26 | R1 等价回放曾"未跑、误归因 trusted-A/B 限制" | Claude | Codex 后补跑 tx2 完成、报告改 accepted | 已解 |
| 27 | R2 standing-guard 重派生是捆绑行为变更、R3 curve-underlying victim 覆盖变更 | Claude | Codex 承认(报告列为有意改进/预声明 diff) | 预声明 |
| 28 | 基线 69e vs 837 疑污染 | Claude 提出→**自己核实撤回**(4392ffc→69e 仅动 deploy/analysis/docs,零 searcher 执行文件) | — | 基线干净 |
| 29 | 固定块离线 replay + 冻结 universe + harness 双端逐字节相同 | Codex(方法)+ Claude(核实 harness 未改) | 双方一致 | 方法可信 |

## 4. 分析侧 dedup(14 项)— Claude 大幅否决

| # | 点 | 提出方 | 对方是否同意 | 结论 |
|---|---|---|---|---|
| 30 | "分析侧 swap decoder/topic/routability 是冗余,删掉改 source 生产" | Codex | **Claude 强烈不同意**:那是**独立验证引擎**——删了 bundle-postmortem 就无法独立验生产(逐-wei/ground-truth 对质全靠它);dedup 恰会让"分析能验证生产"消失 | 拒绝主线 |
| 31 | RouteIndex(生产导出真实可路由 edge,修 in_graph 误导) | Codex | **Claude 部分同意**:分析**读它作数据对照**可以,但**不 source 自己的判别逻辑** | 只读不 source |
| 32 | 真冗余子集:死文件 victim-source/sender-flow、双 blockscan parser、纯地址常量 | Codex | **Claude 同意删** | 安全可做 |
| 33 | cli/index.ts 删除 | Codex | **Claude 不同意**:`"analysis":"tsx src/cli/index.ts"` 仍在用,非架空 | 先确认 umbrella 无人用 |
| 34 | arb-profit/flow-walk PnL 改读生产 | Codex | **Claude 不同意**:刚 3 轮 review+golden 修对,动它极可能再破;且是独立验证引擎 | 不动 |

## 判别标准(区分"真冗余"vs"独立性")
> **删掉它、改指向生产那份,我还能不能抓出生产的 bug?** 能 → 真冗余,删;不能(俩变成同一份代码) → 独立验证引擎,留。

## Mission 校验(贯穿所有条目)
以上多数是 infra/extensibility 硬化,**关 0 个 gap、产 0 个 +EV bundle**。merge 已过等价验收、线上跑新 searcher、无当前故障。除 #4(一行 footgun)外,均非紧急;**统一从 route registry 派生**是正解,应在 merge 稳定后按序做,不按 P0 抢修,更不为架构洁癖拆掉验证引擎(#30)。
