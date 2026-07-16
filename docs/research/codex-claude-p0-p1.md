# RouteAdapter 重构 — Codex × Claude 交叉审查决策表

> 基线:`abc30a2`(route-leg-adapter refactor 已合入 main)。精确核对确认其 `listener/` 与候选 `837fa82` 完全相同。逐-wei 等价验收已通过:图/环/quote/sim/EV 五阶段 SHA 双端相同。tx2 `0x7ce631` 的 Balancer V3 正向 sim 是 **fixed-path** 证据(`netProfit=150817806425095`,calldata 逐字节相同);scanner 自发枚举由更早的 `searcher:loop-fork-gate` 单独证明,两条证据不可混写。
> 2026-07-16 fresh non-author 对抗审计使用当前 `main=fb9ebd3`。审计边界只包含生产 `listener/` 与部署入口,不包含分析侧。新结论已由 Codex 逐条独立撞代码,见 §4。
> 本表记录**谁提出、对方是否同意、核实结论**。Codex = Sol;Claude = fable(非作者对抗审查,逐条核代码)。
> **总纲共识**:merge 合理且线上已跑新 searcher(systemd `mev-searcher` ExecStart=`searcher:live`=`main.ts`,active,已核);等价性只证"重构未改坏行为",不证"无预存 gap / 未来不漏配"。§1 多数是未来漂移硬化;§4 同时列出当前可触发的生产 P0/P1 与显式标注的 future hardening,两者不可混写。

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
| 14 | H1 quote sync/async 分层(prewarm async / mid+quoteLocal sync / quoteExact async) | Claude | **Codex 同意原设计,但复核确认已实现**:`RouteLegAdapter.readMid` 是 sync hot path,`warm` 是声明式预热,`quoteExact` 是 async | **已实现,从未完成 P0/P1 移除**;`route-leg-adapter.ts:70-80,132-148`,`detector/blockscan-scanner.ts:315-335` |
| 15 | H2 warm 协调器阶段提前(避免 live 半脑态) | Claude | **Codex 同意原风险,但复核确认已实现**:fork 后先 plan,再 invalidate/clear,然后 warm;fatal/预算失败终止 pass,单 venue protocol-mid 失败则 fail-closed omission 并记数 | **已实现,从未完成 P0/P1 移除**;`blockscan-warm-coordinator.ts:70-138`,`main.ts:1167-1235,3743-3745` |
| 16 | H3 与在飞 feature work 串行化 | Claude | **Codex 同意作为协作约束,不同意当作当前代码 P0/P1** | 保留在流程/分支治理,不进生产修复队列 |
| 17 | H7 deriveEdgeTaxonomy 安全位对齐(S2 guard 绕过) | Claude | **Codex 同意原风险,但复核确认已实现**:registry 建边时重派生校验,提交前 standing guard 再重派生且 fail closed | **已实现,从未完成 P0/P1 移除**;`route-leg-registry.ts:70-91`,`standing-guard.ts:20-47` |
| 18 | H8 LiquidityAdapter 占位不实现(lp 无 runtime slot、JIT-LP out-of-Mission) | Claude | **Codex 同意 mission 边界;不需要为占位而增加空 runtime 类型** | 不是生产缺陷;JIT-LP 进 mission 时再设计 |
| 19 | 两层 SwapAdapter+ActionAdapter(一 swap 多 action) | Codex | **Claude 同意;Codex 复核当前实现一致** | **已成为当前架构,不是待修 finding** |
| 20 | 三 ID(VenueId/SwapCapabilityId/ActionAdapterId) | Codex | Claude 原判“1 个 adapterId 即可”;**Codex 复核确认最终实现保留了三类职责键**:`id`(执行 family)、`edgeAdapterIds`(路由分发)、`actionAdapterIds`(执行 action),原 one-key 方案未采用 | “当前实现使用”不等于证明理论上不可简化;暂保留现状,不恢复三个全局巨型 ID 系统;`route-leg-adapter.ts:132-148` |
| 21 | 四类 RouteLegAdapter(Swap/Protocol/Liquidity/Flash) | Codex | **Codex 修正早期方案**:当前只有 `swap \| protocol-conversion \| compat`;Liquidity out-of-Mission,Flash 有独立生命周期 | 当前实现比四类方案更小,保持;`route-leg-adapter.ts:25,151-160` |
| 22 | 六步责任组件分解 + V2 探测最小集 | Codex | Claude 同意;**Codex 复核已成为当前架构** | 不再作为待修 finding;新漂移由 §1/§4 的 conformance 条目承接 |
| 23 | Collector→Strategy→Executor Engine 边界 | Codex | Claude 先判虚胖后撤回;**Codex 保留边界、不扩展抽象** | 已是架构约束,不是当前 P0/P1 |
| 24 | victim detect 从 route 派生、raw-tx-replay 万能兜底、applyLocal 只是优化 | Claude(纠正 Codex detect-only 默认) | **Codex 维持部分采纳**:VictimModel 独立已落地;raw replay 不替代 detector/intake;但 route→victim/`unsupported(reason)` 反向完整性仍缺 | 已完成架构分层,未完成 conformance;Balancer V3 是现存反例,与 #1 合并修 |

## 3. 验证 / 等价性

| # | 点 | 提出方 | 对方是否同意 | 结论 |
|---|---|---|---|---|
| 25 | 等价用逐-wei 不是 95%;两轴(正确性 100% 集合精确 / 延迟 95%) | Claude | Codex 采纳(最终报告五阶段 SHA) | 已执行 |
| 26 | R1 等价回放曾"未跑、误归因 trusted-A/B 限制" | Claude | Codex 后补完成五阶段 exact-SHA 对比,报告改 accepted | 已解。注意 tx2 正向 sim 是 fixed-path;scanner 自发枚举证据来自独立的旧 tx2 loop gate,不能说单个 fixed-path 用例证明了枚举 |
| 27 | R2 standing-guard 重派生是捆绑行为变更、R3 curve-underlying victim 覆盖变更 | Claude | **Codex 部分纠正**:standing-guard 是已预声明的 fail-closed 安全改进;curve-underlying 并未扩大 replay 能力,当前仍是 detect-only(`localApplyVariant=null`,`overlayReplayVariant=null`) | 保留 standing-guard 行为变更记录;撤回“curve-underlying victim 覆盖已扩大”的表述;`victim-model-registry.ts:103-111` |
| 28 | 基线 69e vs 837 疑污染 | Claude 提出→**自己核实撤回**(4392ffc→69e 仅动 deploy/analysis/docs,零 searcher 执行文件) | — | 基线干净 |
| 29 | 固定块离线 replay + 冻结 universe + harness 双端逐字节相同 | Codex(方法)+ Claude(核实 harness 未改) | 双方一致 | 方法可信 |

**报告一致性补充**:`codex-route-leg-adapter-refactor-validation.md` 顶部已是 `accepted_deterministic_equivalence`,但底部仍保留验收前的 `implemented_not_validated` 对抗裁决。历史不应删除,应把旧段标为"验收前、已被后续 exact-SHA 证据取代",并新增 final reconciliation,避免同一报告出现两个现行结论。

## 4. 2026-07-16 fresh non-author 生产对抗审计

方法:子代理不携带先验结论,只读审计当前 `main=fb9ebd3`;随后 Codex 对每条按真实调用链独立复核。未读 live 环境,因此“配置相关”条目不冒充已确认的现网配置。

| # | 优先级 | 当前性 | 新卡点 | 交叉裁决 |
|---|---|---|---|---|
| 30 | **P0** | 当前安全违规 | **dry-run 仍用真实私钥签名** | fresh reviewer 提出,Codex 同意。`buildConfig()` 无论 dry/live 都构造 Wallet;dry router 收到 Wallet 后仍调 `buildSignedBackrunTx()`。不广播不改变“已在未授权 dry 包络中使用私钥签名”的事实,违反 `CLAUDE.md` Rule 1 |
| 31 | **P1** | 当前,需开启 protocol edges + blockscan | **Metronome hGUSDC route 可 build/quote/plan,却永久无 blockscan mid** | fresh reviewer 提出,Codex 同意。adapter 的 `readMid=null,warm=null`;production mid collector 只处理 `warm.kind=protocol-mid`;scanner 遇到该腿返回 null 并静默丢环。现有 Metronome fork gate 是 backrun 固定 trigger 路径,不能证明 blockscan 消费者完整 |
| 32 | **P1** | 当前生产覆盖 | **5 分钟 pool refresh 不发现 V4;对已发现的其他 pool 又只更新 backrun graph,且可永久毒化失败 pool** | fresh reviewer 与 Codex 独立命中主问题。最终反驳纠正 Codex 的 V4 子结论:`scanActivePools()` 当前根本没有 V4 topic/parser,因此不是“发现后被 address 去重吞掉”;未来接入 V4 refresh 时才必须同时改用 `poolRegistryKey()` |
| 33 | **P1** | 当前 backrun 生产覆盖;blockscan 为相邻 policy 问题 | **backrun 可选全 graph 的 borrowable profit token,但 EV 只估 WETH+四稳定币** | fresh reviewer 与 Codex 独立命中主问题。planner/sim 可得正利润,最终 EV 却因不可估值算成 0 并 `below_ev_gate`。blockscan 四币 map 是独立的风险/额度策略,未有证据表明“四币”本身是 correctness bug;可共享 valuation capability,但不强制共享起始币集合 |
| 34 | **P1** | 当前配置 footgun,未声称现网已触发 | **live 必开 EV gate,但 bribe 代码默认 10000bps 可形成死配置** | fresh reviewer 提出,Codex 同意但收窄 framing。若未显式配 `BRIBE_BPS<10000` 且无 `BRIBE_ALL_ABOVE_GAS`,则 `bid=expectedProfit`,`netEV=-gas`,所有正 gas 候选被拒。历史报告曾记录现网 5000bps/marker,所以这是必须 fail-fast 的默认配置问题,不是本轮已证实 live outage |
| 35 | **future/P1 hardening** | 当前已知 adapter 对齐;下一 adapter 可静默漏配 | **Identity admission 仍是 Route Registry 之外的手写 union + dispatcher** | Codex 独立发现。新 RouteAdapter 即使已会建边/报价/构建 plan,若忘了加入 `IdentityCheckedAdapter`/`requiresOnchainIdentity()`,file-discovered pool 会在进 graph 前被当作 `untrusted_seed`。并入 §1 的单一注册源 epic,不冒充当前 P0/live outage |

### 精确失败链、最小修复与验收

**#30 dry-run 签名**

- 链:`main.ts:432-445` 构造真 Wallet → `main.ts:656-662` 传入 `DryRunBundleRouter` → `execution/bundle-router.ts:46-66` 调 `buildSignedBackrunTx()` → `submitter.ts:283-350` 调 `wallet.signTransaction()`。`live-envelope.ts:20-25` 对 dry-run 直接跳过授权 envelope。
- 修:`DryRunBundleRouter` 不接 signer,不调签名 helper;只记 unsigned tx 参数,若需稳定 ID 则 hash unsigned serialization。
- 验:用“一旦调 `signTransaction` 就失败”的 signer/counter 按 `main.ts` dry 构造路径提交,断言签名调用为 0,同时 dry 诊断输出仍存在。现有 `test/bundle-router-safety.ts:61-81` 只测 no-wallet 路径,正好绕开了生产构造方式。

**#31 Metronome hGUSDC blockscan mid**

- 链:`venues/protocols/metronome.ts:91-146` 的 route 能力完整,但 `readMid/warm` 均 null → `main.ts:3697-3746` 不生成 external mid → `detector/blockscan-scanner.ts:315-350,402-431` 评分时返回 null → 环静默消失。
- 修:给 `metronomeHgusdcAdapter` 声明 `readMid: readProtocolExternalMid` 与 `warm:{kind:"protocol-mid",...}`,复用已有 `quoteExact`;不增加 main 特判。
- 验:hGUSDC edge + USDC→msUSD 回程 DEX 腿,断言 warm 先产 mid、scanner 再自发产 ring;再加 conformance:所有 blockscan-admitted 且非 standing protocol route 必须有 mid/warm 能力或显式 `unsupported(reason)`。

**#32 runtime pool refresh**

- 链:`active-pool-discovery.ts:131-147` 无 V4 discovery → runtime refresh 不可能获得新 V4 poolId。对其他 fresh pool,`main.ts:880-929` 启动时建立的 `tokenIndex/allPoolMap/flashTokens` 与 mempool filter 仍是快照,而 `main.ts:953-975` 只 `graph.push`。`buildTokenGraph()` 吞 per-pool 错误后,refresh 仍把失败 pool 加入 known,进程内不再重试。
- 修:先让 per-pool build 返回成功/失败且只 commit 成功 pool;用一个 refresh transaction 按**各消费者自己的 admission/view policy**重建相关投影。backrun 必须同步 graph/tokenIndex/pool map/flash tokens/mempool subscription;blockscan 必须重跑自己的 strategy view policy,不得把 backrun fresh pool 无条件塞进 blockscan。若要动态支持 V4,再补 V4 event/parser 并使用 `poolRegistryKey()`。
- 验:非 V4 新 pool 进入后,backrun 的 graph/pool-map/mempool/flash 投影同步更新;第一次 token query 失败、第二次成功会重试。blockscan 只在新 pool 通过它自身 view policy 后更新。V4 动态支持另验同一 PoolManager 下两个 poolId 均保留。

**#33 profit asset policy**

- 链:`solver/flash-liquidity.ts:34-125` + `main.ts:909-929` 对所有 backrun graph token 动态查 flash → `planner/planner.ts:446-478` 可选任意 borrowable cycle token 作 profit token → `ev-evaluator.ts:1-7,32-39` 对非 WETH/四稳定币返回 0 → 最终冒充 `below_ev_gate`。`main.ts:263-270` 的 blockscan 四币 map 是另一条 strategy policy,不作为这条 current bug 的因果环节。
- 修:建显式 valuation capability;backrun planner 只选可估值 profit token,或用可执行 WETH 路径/可信价格源保守估值。blockscan 可复用 valuation capability,但独立保留它的起始币和风险 cap 策略。
- 验:WBTC/其他非五币 token 有 liquidity+估值时,backrun 能通过 EV;无估值时在 rotation 前输出 `unpriceable_profit_token`,不得冒充 `below_ev_gate`。blockscan 的 start-token 集合另做显式 policy 测试。

**#34 dead EV default**

- 链:live envelope/deploy 强制 `EV_GATE=1` → `main.ts:513-520` 默认 `bribeBps=10000,bribeAllAboveGas=false,minNet=0` → `ev-evaluator.ts:41-78` 得 `netEV=-gas` → backrun/blockscan 在 `main.ts:2684-2700,2966-2975` 拒绝。
- 修:默认 bribe 保留正 retained EV,并在启动时对 `evGate && !bribeAllAboveGas && bribeBps>=10000` fail-fast;不依赖查日志才发现死配置。
- 验:用生产默认 config 构造**gross profit 明确高于 gas + 合理 bribe**的输入,必须启动拒绝死配置或得到 `netEV>0`,不得启动成功后因数学恒等式静默全拒。

**#35 identity registry 漂移**

- 链:`route-leg-registry.ts:5-68` 已注册 pool/edge adapter → `venues/identity.ts:20-26,110-145` 另写 identity union/dispatch → `identity.ts:160-209` 对未入 identity 清单且不是 code-owned seed 的 pool 返 `untrusted_seed` → 根本进不了 graph。
- 修:保持 identity resolver 与 route execution 分层,但建 `IdentityResolverRegistry`;每个 route poolAdapter 必须显式声明 `onchain-resolver` 或 `trusted-singleton-seed`,不把 identity 细节塞回巨型 RouteAdapter。
- 验:跨 registry conformance 覆盖集合必须完全一致;添加 synthetic adapter 但不声明 identity policy 时,必须在启动/测试明确失败,而不是 runtime 静默丢 pool。

## Mission 校验(贯穿所有条目)
等价验收仍然成立:没有证据表明 RouteAdapter 重构改坏了旧行为。但 fresh audit 证明旧行为本身存在可触发卡点,因此不能再把整份表定性为“只有 infra/extensibility”。执行顺序按安全、当前 +EV 覆盖、再到未来漂移收敛为:

1. **P0:先消除 dry-run 私钥签名**(#30);dry 路径必须真正 unsigned。
2. **P1:修 runtime pool refresh**(#32);先修失败重试与 backrun 相关投影同步,blockscan 重跑自己的 view policy;V4 需先补 discovery,再用 `poolRegistryKey()`。
3. **P1:补 Balancer V3 victim coverage**(#1),并装上按能力维度声明的跨 registry conformance(C2)。Fluid DEX(C1)先用固定 receipt 证明 paired-Transfer/raw-tx 现有路径哪一层失败,再只修已证实的维度;不凭“无 dedicated decoder”直接开错 branch。
4. **P1:补 Metronome hGUSDC blockscan mid/warm 能力**(#31),用 scanner 自发枚举 gate 验收。
5. **P1:统一 profit-token valuation capability**(#33),但保留 blockscan 独立的起始币/风险 cap 策略。
6. **P1:对死 EV 默认 fail-fast**(#34),同时修默认 live 入口(#4)。
7. **单一注册源 epic**:依次收口 Path Template(#5)、protocol flag(#6)、identity policy(#35);Route/Victim 仍保持分层,只加反向 conformance(#1/#24/C2)。#35 是 future/P1 hardening,不单独冒充 P0。
8. 统一 V2 lineage(#7)和 landed-event descriptors(#3/#8/#9/#11),最后收口 pool 文件解析白名单、Flash 双表与低风险元数据。

保留多入口,统一事实源。

## 5. Claude 主动扫描发现(非审 Codex,fable 提出;Codex 已复核)

系统性对照:14 个注册 route adapter × 每个 per-venue 消费点(quoter / plan-builder / path-template / pool-impact / victim-model / mid-readers / warm),找 route 有、某消费点无的不对称。

| # | 点 | 提出方 | Codex 意见 | 核实结论 |
|---|---|---|---|---|
| C1 | **victim 漏配不止 Balancer V3——Fluid DEX 同样没有 dedicated swap-event VictimModel/decoder** | Claude | **部分同意,撤回“Fluid 自身 swap 不能 trigger”的过满结论**:Fluid 目前是 `token-graph/quoter/plan-builder/blockscan-mid` 的 legacy route,确实无 dedicated decoder/local apply/overlay;但 `pool-impact.ts:720-724` 无条件跑 paired-Transfer fallback,`431-453` 会按 graph edge 匹配任意 adapter 并返回 `matchedAdapterId`。public-mempool raw-tx 路径使用完整 receipt logs,所以 Fluid 仍可能被通用路径识别 | **已证实的是分维度 capability gap,不是端到端 outage**:dedicated event decode/local apply/overlay 缺;paired-Transfer fallback 已有;raw-tx replay 需固定 Fluid receipt 验证。未验前不定为当前 P1 修复 branch |
| C2 | **建议增加 registry-conformance 测试,要求每个消费点都对齐 registry 或显式 `unsupported(reason)`** | Claude | **同意跨 registry conformance,不同意原骨架**:1)`PRODUCTION_ROUTE_ADAPTERS.swaps` 已是 swap 分组,不再加 `isSwapVenue`;2)receipt-level decoder 需跨 log/edge 上下文,继续属于独立 VictimModel/decoder registry,不塞进 RouteAdapter;3)path admissibility 应从 taxonomy 派生,不是用测试维护第二张白名单;4)Fluid 不在 Route Registry,原 loop 会直接漏它 | **部分采纳,应早于逐点扩展,但不能单独先合一个红 CI**。先把 Fluid 迁入 Route Registry(或将 legacy 明确登记为待迁移),再跨 Route/Victim/Mid/Identity registry 按维度校验。Fluid 应声明 `paired-transfer=supported`,同时对 dedicated/local/overlay 各自 `unsupported(reason)`;不得笼统声明“victim 全 unsupported”。修真 gap 仍需 replay flip,conformance 只防未来静默漂移 |

**C2 原 conformance 骨架(保留作为 Claude 提案,不按原样实现):**
```ts
for (const swapAdapter of PRODUCTION_ROUTE_ADAPTERS.swaps) {
  assert(pathPolicy.isAdmitted(swapAdapter), `${swapAdapter.id}: route 未进 path policy`);
  assert(victimCapabilities.hasEveryDimension(swapAdapter), `${swapAdapter.id}: victim 能力声明不完整`);
  assert(
    midPolicy.canScore(swapAdapter) || blockscanUnsupported.has(swapAdapter),
    `${swapAdapter.id}: 未声明 blockscan mid 能力`,
  );
  assert(identityPolicy.hasEveryPoolAdapter(swapAdapter), `${swapAdapter.id}: 未声明 identity policy`);
}
```
关联设计点(§2 / codex-plan §20):Claude 对**receipt 级上下文**的判断成立——V2 需 Swap+Sync 配对、Balancer V3/V4 单例需按 poolId 跨 edge 匹配。但这正是不把 `decodeSwapImpact` 塞进单个 RouteAdapter 的理由:由独立 receipt-level decoder registry 实现,再用 conformance 保证每个 swap route 对 dedicated-event / paired-transfer / local-apply / overlay / raw-tx-replay 逐维声明 `supported` 或 `unsupported(reason)`。
