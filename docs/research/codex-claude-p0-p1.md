# RouteAdapter 重构 — Codex × Claude 交叉审查决策表

> 基线:`abc30a2`(route-leg-adapter refactor 已合入 main)。精确核对确认其 `listener/` 与候选 `837fa82` 完全相同。逐-wei 等价验收已通过:图/环/quote/sim/EV 五阶段 SHA 双端相同。tx2 `0x7ce631` 的 Balancer V3 正向 sim 是 **fixed-path** 证据(`netProfit=150817806425095`,calldata 逐字节相同);scanner 自发枚举由更早的 `searcher:loop-fork-gate` 单独证明,两条证据不可混写。
> 本表记录**谁提出、对方是否同意、核实结论**。Codex = Sol;Claude = fable(非作者对抗审查,逐条核代码)。
> **总纲共识**:merge 合理且线上已跑新 searcher(systemd `mev-searcher` ExecStart=`searcher:live`=`main.ts`,active,已核);等价性只证"重构未改坏行为",不证"无预存 gap / 未来不漏配"。以下多数是**未来漂移硬化**,当前无 live 故障。

## 1. 生产侧"手工平行清单会漂"点(核心议题)

| # | 点 | 提出方 | 对方是否同意 | 核实结论 |
|---|---|---|---|---|
| 1 | **swap victim 未从 route 派生** — Balancer V3 有 route 却无 victim-model + 无 pool-impact decoder → 不能 backrun;测试方向反了(查 victim→route,不查 route→victim)静默 PASS | Codex | **Claude 同意**(逐条核实成立);但**重定性**:非回归,是**预存覆盖 gap**(baseline 也没 balancer-v3 victim),等价性正确未报 | 真预存 gap,framing=补 backrun 覆盖。保持 victim model 与 route execution 分层;新增反向 conformance:每个 swap route 必须有 victim model,或显式声明 `unsupported(reason)`,不能静默缺席 |
| 2 | balancer-v3 打分/mid drift(mid-readers 零 balancer) | Claude | **Claude 自己撤回** | 误报,撤回。但证据应拆开:tx2 fixed-path 证明 quote/plan/calldata/sim;旧 tx2 loop gate 证明 scanner 自发产 ring/plan;`balancerV3Adapter.warm=external-mid` + `main.ts::readBlockScanExternalSwapMid()` 证明走通用 mid 路径 |
| 3 | swap topic 在 active-pool-discovery + build-active-pool-universe 两处各写 7 个 | Codex+Claude | 双方一致 | 真漂移风险(当前一致);修=从 adapter 声明 topic、registry 汇总 |
| 4 | **P0-1 默认入口** `start`/`dev`→旧 `src/index.ts` | Codex | **Claude 部分同意但降级**:事实对,但 systemd 跑 `searcher:live`(新)已核 → 是 footgun,非"线上跑旧代码"。改一行即可 | 当前线上正常,不应描述成 live 故障;但默认命令仍是运维接口,应最先修。最终定为 P1 operational footgun,随后删除或显式改名旧单池 listener |
| 5 | **P0-2 path-template `SWAP_ADAPTERS` 手工枚举** → 未登记 edge 静默 no_candidate | Codex | **Claude 部分同意但降级**:当前清单已完整 | 消费方已证实:`planner.ts::plan()` 在 `buildTokenPaths()` 前用 template adapter 过滤 graph。当前无漏项,但下一个 adapter 漏登记会静默 `no_candidate`;属于 P0 单一注册源硬化,不是当前 live outage |
| 6 | **P0-3 protocol flag** `filterLiveProtocolRegistry()` 手写 6 协议 | Codex | **Claude 部分同意**:当前一致,未来漂移风险 | 当前无分歧;新 protocol 漏进排除名单会在总开关关闭时仍启用。把 `requiresProtocolEdgesFlag` 放入 descriptor 并派生过滤;P0 单一注册源硬化,非当前 live outage |
| 7 | **P0-4 V2 factory 身份 vs fee 分叉**(Pancake 在 v2-fee 有、capability 无) | Codex | **Claude 部分同意**:Pancake 经活动发现后可按 provisional-factory + 25bps 执行 | 不是当前执行故障,但 factory 索引覆盖不完整:未进入近期 Swap 窗口的 Pancake 池不会从该 factory 被发现。统一成 V2 lineage descriptor(factory provenance + execution family + measured fee rule);P1 coverage hardening |
| 8 | router discovery swap topic 只认 V2/V3/V4(漏 Curve/Balancer V3-only router) | Codex | Claude 同意 | P1 漂移 |
| 9 | 两套 active-pool scanner 各维护 topic/解析 | Codex | Claude 同意 | P1 收口(保留两入口、共享 scanner 核) |
| 10 | capability `supported_in_prod` vs `PRODUCTION_ROUTE_ADAPTERS` 双真值 | Codex | Claude 同意 | P1 改为派生(身份可独立,执行支持不能两份) |
| 11 | warm invalidation topic 与 adapter 分开维护 | Codex | Claude 同意 | P1 收口 |
| 12 | pool adapter 解析白名单(override 缺 curve-underlying/balancer-v3) | Codex | Claude 同意(Codex 自己 P0→P1:override 文件为空,潜在缺陷非当前故障) | P1 |
| 13 | Flash target 两表 / 三层注册 / swap-count debug 只认 V2/V3 | Codex | Claude 同意低优先 | Flash 双表是明确未纳入本轮的遗留;ActionAdapter/Descriptor/RouteAdapter 分层合理,只需按协议包统一导出;debug Swap 计数改读共享 event registry。均为 P2 |

**Codex 二次复核后的收口边界**:

1. **Route registry** 是执行能力真值:edge adapter、taxonomy、quote/build、warm class、protocol feature metadata、`supported_in_prod` 从这里派生。
2. **Landed-event registry** 是链上事件真值:active-pool 两入口、router discovery、warm invalidation 和 debug 计数共享它,不再各写 topic。
3. **Victim model 保持独立**:route adapter 不自动等于可安全 replay 的 victim。Registry 间增加反向完整性检查,要求每个 swap route 明确映射 victim model 或 `unsupported(reason)`;不能把 replay 数学强塞进 RouteAdapter。
4. **V2 lineage descriptor** 统一 factory provenance、执行 family 与 fee rule;factory 仍是身份/发现来源,final sim 仍是最终 fail-closed 门。

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
| 24 | victim detect 从 route 派生、raw-tx-replay 万能兜底、applyLocal 只是优化 | Claude(纠正 Codex detect-only 默认) | Codex 二次复核后**部分采纳** | 不把 victim replay 实现塞入 RouteAdapter;保持独立 VictimModelRegistry,但由 conformance 强制 route→victim/unsupported 完整声明。raw-tx replay 可作真实性路径,不能替代生产 detector/intake 验收 |

## 3. 验证 / 等价性

| # | 点 | 提出方 | 对方是否同意 | 结论 |
|---|---|---|---|---|
| 25 | 等价用逐-wei 不是 95%;两轴(正确性 100% 集合精确 / 延迟 95%) | Claude | Codex 采纳(最终报告五阶段 SHA) | 已执行 |
| 26 | R1 等价回放曾"未跑、误归因 trusted-A/B 限制" | Claude | Codex 后补完成五阶段 exact-SHA 对比,报告改 accepted | 已解。注意 tx2 正向 sim 是 fixed-path;scanner 自发枚举证据来自独立的旧 tx2 loop gate,不能说单个 fixed-path 用例证明了枚举 |
| 27 | R2 standing-guard 重派生是捆绑行为变更、R3 curve-underlying victim 覆盖变更 | Claude | Codex 承认(报告列为有意改进/预声明 diff) | 预声明 |
| 28 | 基线 69e vs 837 疑污染 | Claude 提出→**自己核实撤回**(4392ffc→69e 仅动 deploy/analysis/docs,零 searcher 执行文件) | — | 基线干净 |
| 29 | 固定块离线 replay + 冻结 universe + harness 双端逐字节相同 | Codex(方法)+ Claude(核实 harness 未改) | 双方一致 | 方法可信 |

**报告一致性补充**:`codex-route-leg-adapter-refactor-validation.md` 顶部已是 `accepted_deterministic_equivalence`,但底部仍保留验收前的 `implemented_not_validated` 对抗裁决。历史不应删除,应把旧段标为"验收前、已被后续 exact-SHA 证据取代",并新增 final reconciliation,避免同一报告出现两个现行结论。

## Mission 校验(贯穿所有条目)
以上多数是 infra/extensibility 硬化,**当前不直接关闭新的 +EV gap**。merge 已过等价验收,没有证据表明本轮重构制造了线上故障;但单一注册源缺口会让下一个 adapter 出现静默漏配。执行顺序按生产风险和改动收益收敛为:

1. 修默认 live 入口(改动最小,先消除运维 footgun)。
2. Path Template adapter 集从 Route Registry/taxonomy 派生。
3. Protocol feature flag 从 descriptor 派生。
4. 合并 V2 factory identity/provenance 与 fee rule。
5. 建共享 landed-event descriptors,供两套 discovery 入口、router、warm invalidation、debug 消费。
6. 最后收口 pool 文件解析白名单、Flash 双表与低风险元数据。

保留多入口,统一事实源。
