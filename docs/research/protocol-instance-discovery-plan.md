# Protocol Instance Discovery — 分相实施计划

> 目标:protocol adapter 注册后,实例**自动**发现、probe、建边、热更新进图 —— 消灭 per-instance
> 手写名单(erc4626 vault 类),保留经证明的身份根 pin(registry/factory/singleton)。
> 基线:`origin/main b7f087a`(刀1 已落地,见下)。

## 0. 已完成(不在本计划内)

**b7f087a "derive static protocol venues from adapters"** 已实现刀1:

- `ProtocolConversionAdapter.declaredVenues: readonly DeclaredProtocolVenue[]` + `undeclaredVenueReason`
  (二选一强制,registry 构造期断言:外族 pool adapter、scored 静态 venue、非法地址全部 throw)。
- 单例协议(goldx/psm/wsteth/rocksolid/metronome)已迁入各自 adapter;`graphOrder` 保序。
- erc4626 显式声明 `undeclaredVenueReason: "ERC4626 instances require external discovery and
  per-vault probe admission"`;其 20+ 条 vault 实例留在 `EXTERNAL_AND_LEGACY_POOL_REGISTRY`
  (命名即债务标记),是本计划 Slice C 的清除对象。
- conformance(route-adapters)13/13 实跑 PASS。

**声明档接口自证(declared-venue attestation,`106d1b5` + boot 日志 follow-up)**:各 protocol
adapter 的 `buildEdges` 在建边前用 venue 自身接口 eth_call 核对声明绑定 —— wsteth `stETH()`、
psm `gem()/dai()`、erc4626 标准分支 `asset()==fixedTokenIn`(silo 分支跳过:fixed 字段不喂边,
行为验证归 fork 收据)、hgusdc 经 `HGUSDC.asset()==声明 tokenOut`(router 本体无可查 view,
其地址绑定靠 trusted-singleton-seed 身份门 + final sim);goldx/rocksolid 无 token-address view,
attest 报价依赖的 `unit()`/`convertToShares()` 活性,pair 保持 code-owned。失败 = 该 pool 建边
失败进 `buildTokenGraphWithResults.failed`,boot(backrun+blockscan)与 refresh 三条路径均逐
pool 打日志(cap 5 + 溢出计数);且因 swap 事件发现永远端不出协议单例,refresh timer 显式重试
`liveRegistry` 中不在 `knownPoolKeys` 的 venue 直至准入 —— boot 瞬时 RPC 失败最多损失一个
refresh 周期,不再是进程生命周期(对抗审查发现,同轮修复;`runtime-pool-refresh` 6/6 回归)。
conformance 扩为 15/15(正反例 + silo 跳过 + attest 目标合约校验)。fork 级 flip 因环境网络
策略未跑,按 gates.md 记 `implemented`;定案证据 = `npm run searcher:audit-erc4626`(逐 vault
验 `asset()==fixedTokenIn`)+ 一次 fork/node boot 六 venue 全准入。

**硬编码三态定论(D-005,勿重开)**:
1. **venue 地址 pin = 身份根,保留**。单例无 factory/registry 可反查,pin 是 attest 的锚点
   (宪法 §2 infrastructure-singleton 豁免);Ubiquity 型"pin 权威 + `hasRole` 派生"仅当链上
   存在权威合约时可用,GOLDx/RockSolid 类无权威 → pin 不可再削。
2. **token pair 声明 = 被 attest 的预期值**。字面还在代码里,但从"无条件断言"降级为"合约
   接口核对不过即拒"。**核对(fail-closed)而非派生(open-ended)**:派生模式下合约升级返回
   意外地址会静默建边指向陌生 token;且 pair 常量织入 quote/plan 层(`quotePreparedPSM` 精度、
   `quoteGoldxMint` 守卫、`psm.buildPlanFragment` 方向判定),仅建边点派生 = 假去除。单例真
   派生 = Slice C `enumerateRoutes` 形态,等 erc4626 家族管道走通后再评估,不单独立项。
3. **goldx/rocksolid pair = 残余 code-owned**(合约不暴露 token view,链上无物可核),活性
   attest + final sim(自己在 fork 执行该 pair)兜底。
   attestation 是 **boot+retry 时点的漂移防护,不是持续保证**:boot 后的漂移(如 pin 背后的
   proxy 升级)本检查与"交易时点再读一次"同样都不覆盖,除非按节奏重 attest;持续兜底是
   final sim,逐笔交易时点读 view 只换来 drift-since-boot、代价是 CU。从交易 trace 提取
   in/out 属行为证据,只做检测/候选提名(观察侧 + Slice E 隔离区),不做准入 —— 行为可仿冒
   (蜜罐流),准入证据链固定为 pin 身份根 → 接口 attest → final sim 实测。

## 1. 模型:Instance 与 Route 两层(已核实的代码约束)

- `poolRegistryKey`(非 v4)= 纯地址 → **一个实例一条 PoolEntry**,同址第二条路线会被去重吞掉
  (pool-universe.ts)。因此**多 token 路线不进 PoolEntry 层**,由 adapter 的 route 枚举承担:
  一个 instance 进 registry 一次,`buildEdges` 一次返回该实例全部路线的 TokenEdge
  (TokenEdge 本身允许同 target 不同 tokenIn/Out 共存)。
- `PoolEntry.fixedTokenIn/Out` 单值,仅用于**声明式单路线**venue;多路线实例的 fixed 字段留空,
  路线全部由 `enumerateRoutes` 派生。
- `runtime-pool-refresh` 现为**纯追加**(`mergeEdges(current, additions)`),无 remove/replace
  —— 路线下线/实现升级的收回语义是 Slice D。

```
ProtocolInstance { target, adapter }                    // 身份:进 registry 的单位
ProtocolRoute { target, tokenIn, tokenOut, action,      // 行为:建边/报价/编码的单位
                selector, quoteTarget?, allowanceSpender? }
```

## 2. 接口(在 declaredVenues 基础上追加,全部可选、缺省退化)

```ts
interface ProtocolConversionAdapter {
  // 已有:declaredVenues / undeclaredVenueReason / buildEdges / quoteExact / buildPlanFragment
  readonly discovery?: {
    discoverInstances(ctx: DiscoveryContext): Promise<ProtocolCandidate[]>;

    // 强制,且必须位于 route 枚举/probe 之前:地址准入。
    // 返回 null = 身份根不认该地址 → quarantine,不得 enumerate/quote/入图。
    attestIdentity(
      candidate: ProtocolCandidate,
      blockTag: BlockTag,
    ): Promise<ProtocolInstance | null>;

    enumerateRoutes(instance: ProtocolInstance, blockTag: BlockTag): Promise<ProtocolRoute[]>;
    probeRoute(route: ProtocolRoute, ctx: ProbeContext): Promise<RouteProbeResult>;
    watchRouteChanges?(...): AsyncIterable<RouteChange>;   // Slice D
  };
}
```

管道固定为:`discover/call observation → attestIdentity → enumerateRoutes → probeRoute → PoolEntry`。

职责分层(勿混):**`matchTrace` = 候选分类**(selector → adapter family;动态发现时 target 本来
未知,不要求 matchTrace 先认识地址——现有实现本就混合:balancer-flash/metronome-hgusdc/morpho-flash/
univ4 是 target-aware,curve/dodo/balancer-v3 只看 selector,均无需为本计划改动);
**`attestIdentity` = 地址准入**(reverse-verify 身份根)。验证通过后持久化绑定
`(target, selector) → adapter`,proxy 记 implementation/code hash,升级即失效重 attest。

退化语义:无 `discovery` 的 adapter = 只有 declaredVenues(现状,单例协议永远停在这档即可)。

## 3. 分相(每片独立合并,通道按 HISTORICAL-GAP 路由)

### Slice B — discovery coordinator(管道,shadow 模式)【deterministic → replay+smoke 直进 main】

> **[IMPLEMENTED 2026-07-17]**(`claude/protocol-adapter-graph-fix-z8io2d`):
> `venues/protocol-discovery.ts` `runProtocolDiscoveryShadow` — shadow by construction(无
> graph/refresh 访问,只回 report + `protocol_discovery` 结构化日志);coordinator 侧强制
> quarantine(attest null/throw 不得 enumerate/probe)、probe revert fail-closed、P0-3 flag 重
> 执行、would_admit 需 `receiptVerified`(preview 级恒 false ⇒ 恒不 admissible)。erc4626 挂
> 了 shadow 级 discovery 钩子(候选=universe token 集;attest=asset/totalAssets/convertTo*
> 自洽;probe=preview 一致性)。main.ts 启动后 detached 一次性运行(`SEARCHER_PROTOCOL_
> DISCOVERY_SHADOW=0` 关),parked 停车候选(discovery-queue.json)喂 attest 报 would-dequeue。
> conformance 15/15(隔离/fail-closed/flag 门/去重/parked)。接口偏差:attest/enumerate/probe
> 收 `ProbeContext{backend}` 而非裸 blockTag(attest 需要 backend 才能调链,计划签名系伪码)。
> 未完:fork 环境 shadow 日志样本、graph SHA 逐位比对(需网络);receipt 级 probe、refresh
> 喂入、召回比对与无 seed replay 全部属 Slice C【Hermes A/B】,此片零准入变更。
- 新 coordinator:遍历注册 adapter → `discoverInstances` → **`attestIdentity`** → `enumerateRoutes`
  → `probeRoute` → 产 `PoolEntry` → 喂 `prepareRuntimePoolRefresh`(与 main.ts 现有
  `scanActivePools()` 喂法并列)。attest 失败 → quarantine,不进后续任何一步。
- **shadow 模式**:本片内 probe 结果只打结构化日志(`protocol_discovery` 事件:candidate、
  probe verdict、would-admit),**不改图**。零准入变更。
- 复用 builder 的 `blocked_on_adapter` 停车场:coordinator 报告哪些停车候选在 discovery 下会出队
  (仅日志)。
- 验收:graph SHA 与 main 逐位一致(shadow 不改图);conformance 扩一条(有 discovery 的 adapter
  其 probe 必须 fail-closed:任一 probe 调用 revert → 该 route 不产出);tsc;shadow 日志在
  fork 环境可见样本。

### Slice C — erc4626 接口派生 discovery(第一个真准入变更)【Hermes A/B】
- `discoverInstances`:**候选源 = DEX universe 的 token 集,仅此一个**。legacy 名单**不是候选源**
  ——它只作为期望召回的答案卷,保存在 discovery 路径之外做比对(P0-1 修正:名单若进候选源,
  "全部重新发现"即循环论证的假阳性)。
- `attestIdentity`:**`asset()` 可读单独不构成身份**(假合约也能实现 asset());erc4626 的身份 =
  标准接口自洽检查(asset/totalAssets/convertTo* 互相一致)+ 下述 preview 与 fork 收据行为验证
  整体通过 —— 行为即身份,任一环节不符 → null(quarantine)。
- `probeRoute`:`previewDeposit/previewRedeem` 一致性 + **fork 收据级 redeem 验证**(继承
  `nonStandardRedeem` 纪律原文:"错边比没边更糟" —— srUSDe 类 preview 与实付不符的 vault
  整体排除,除非其 declaredVenues 带专用 metadata);loop-closable(asset 与 share 至少一端
  能在图内闭环)。
- **probe 否决必须有承载体(P0-2 修正)**:`probeRoute → PoolEntry` 的管道有结构洞——refresh 收到
  PoolEntry 后由通用 builder 重新调 `buildEdges()`,而现 erc4626 `buildEdges` 只凭
  `fixedTokenIn/nonStandardRedeem` 发边,probe 拒绝的 redeem 会被重新长出来。**唯一承载方式**:
  `PoolEntry` 携带逐 route 的 `verifiedRoutes[]` metadata,`buildEdges()` 只允许为已验证 route 发边;
  并加断言:**identity/probe 任一步失败 → zero edge**(discovery 来源的 PoolEntry 无 verifiedRoutes
  = 不发任何边)。
- **flag 门在 refresh 前重执行(P0-3 修正)**:`SEARCHER_ENABLE_PROTOCOL_EDGES` 现只在启动时过滤
  静态 registry(`filterLiveProtocolRegistry`),`prepareRuntimePoolRefresh` 对 freshPools **零复查**
  (已核:refresh 文件中 flag 出现次数=0)——coordinator 必须在喂 refresh 前强制执行
  `requiresProtocolEdgesFlag` 门,并加测试:**flag off + 有效 discovery 结果 = graph hash 不变**。
- **A/B 验收(P0-1 修正后)**:
  1. 召回比对:discovery 产出 ⊇ legacy 20+ 条(答案卷比对,legacy 不在候选源);少一条即假阴,fail。
  2. **无 seed replay(强制)**:完全移除目标 legacy/`POOL_REGISTRY` seed 后重放,必须走通
     `scanner 自发枚举 → identity/probe 通过 → edge 入图 → path_found → final_sim_success`;
     注意现 `blockscan-hunt.ts` 第 225-231 行直接 merge `POOL_REGISTRY`——**trusted harness 需先加
     no-seed 模式**,否则结构性无法证明无 seed 枚举。不满足此 replay 的只能记
     `implemented_not_validated`,不得记 fixed(gates.md 的 bucket-transition 要求)。
  3. 新增 vault 边计数与 probe 拒绝计数入 journal;live 窗口漏斗无回归。
- 通过后:删除 `EXTERNAL_AND_LEGACY_POOL_REGISTRY` 的 erc4626 段(计划的核心交付物)。

### Slice D — route 生命周期(增删/重 probe)【replay 门 + 谨慎 A/B】
- `runtime-pool-refresh` 增加 remove/replace 语义(原子替换 graph/index/filter,不再只 append);
- `watchRouteChanges`(AssetAdded/Removed、实现升级)→ 重 probe → 增删边;
- 安全边界:删除路径只允许 discovery-owned 边;declaredVenues 边永不被自动删除。

### Slice E — observed-protocol-route catch-up(被动泳道,最低可信度,最后做)【Hermes A/B】
硬边界(逐条验收):
- selector 命中只产生 **quarantine candidate**(`matchTrace` = 候选分类,见 §2 分层)。
- **`attestIdentity` 未通过,不得 enumerate、不得 quote、不得入图。**
- 本 Slice **不覆盖任何 route 的首次出现**(observed-flow 定义即"先看到才学到",信息论边界)。
- **不得据此关闭 tx14、cold-pool、首次收割类 gap**。**本计划整体也不关闭 tx14(P0-4 修正)**:
  protocol instance discovery 与 **DEX cold-pool admission 是两个独立缺口**——tx14 的残余堵点是
  uCR/WETH 死 DEX 池(arb-relevance/cold-pool 修复,另行立项),Slice C 只服务 protocol 实例
  (erc4626 类)的首次机会,Ubiquity adapter 又不立项;任何 slice 上线都不得据此在台账关闭
  tx14 或 V4 cold-pool。
- 本 Slice **不替代 Slice C,也不能满足 Slice C 的验收**。

只按 selector 放行 = 把身份门降级成 selector 门 = 蜜罐可仿冒(造假 target 发对的 burn+mint,
quote-probe 会通过、执行时罚没)—— 这是 attestIdentity 强制的原因(宪法 §2)。

沿用性(核实 origin/main):`poolRegistryKey`(非 v4)= 裸地址,多 token 路线需新增
`protocolRouteId`(`selector:tokenIn:tokenOut`)进键,否则同址第二路线被去重吞掉。receipt→trace
shortlist 基础设施散在 detector/pool-impact,可复用,不新建 daemon。工程量 = 一个 scanner + 一个
route key + 两个调用点(启动回扫最近 N 块 + 现有 refresh timer 扫新块)。

### 关于 Ubiquity 身份根(attestIdentity 样本形状,链上实测)
- `Manager.hasRole(UBQ_BURNER_ROLE, observedTarget) == true` 且 `hasRole(UBQ_MINTER_ROLE, …) == true`
  (另有正向 `converter.manager() == Manager`)—— 作为 **block-pinned reverse identity 前置**成立,
  了结了早前"singleton 证据不足"的疑问:合宪准入依据 = pin Manager + `hasRole` 派生,**不是** pin
  样本地址 `0x4321`。
- **边界:`hasRole` 只证明授权身份,不单独证明报价与执行语义** —— 通过后仍需 code/selector/route
  probe(quote 一致性 + fork 行为验证)才可产 PoolEntry。
- **立项状态不变**:ubiquity-credit 仍不过 EV 入场门($0.02/次,残余协议),**不立项**;此段仅作
  attestIdentity 的具体实现样本留档。

## 4. 全局边界(每片都适用)

1. **不 pin 实例,只 pin 身份根**(宪法 §2):任何 discovery 源头必须是 registry/factory/标准接口
   /已证单例;凭单笔 tx 出现过就加地址 = 样本补丁,禁止。
2. **probe 否决 = 整体排除**(nonStandardRedeem 先例):可疑实例宁可不进图。
3. **final sim 永远是 fail-closed 门**;taxonomy/`leavesStandingPosition` 只经 `deriveEdgeTaxonomy`。
4. **多 token 铸造经内部 swap 的路线(USDC→zap→USDT vault)≠ 标准 erc4626 路线**:selector/quote/
   allowance 都不同,默认被 probeRoute 排除;要支持需独立 route metadata,另立 slice。
5. **新 adapter 立项仍过 EV/频次入场门**(§7 决策树 + 出现 ≥N 次或累计毛利 ≥$X);本计划管"写好的
   adapter 自动进图",不授权 adapter 扩产。
6. **身份根 attest 是任何 discovery/observed 泳道的准入前置**:进图单位是 `(chainId, target,
   selector, tokenIn, tokenOut)`,但 `target` 必须先过 `attestIdentity` 反查 on-chain 身份根
   (registry/factory/role/标准接口),命中 selector ≠ 通过身份;只按 selector 放行 = 蜜罐可仿冒。
7. **被动 catch-up 不得冒充首次收割修复**:observed-flow 结构性抓不到首次;任何 slice 的报告不许把
   "第二次学到了"写成 cold-pool/standing-state gap 已关闭。
8. Codex 产 diff,逐 hunk 审(gate-full-codex-diff);每片一个 rule-12 gate。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| discovery 产出爆图(vault 长尾/蜜罐) | probe 强制 + loop-closable 过滤 + 每 family 上限;YIELDX 先例 |
| Slice C 假阴(legacy 条目没被重新发现) | A/B 验收硬条件:legacy 集 ⊆ discovered 集,差集=fail |
| append-only refresh 期间路线腐烂 | Slice D 前 discovery 边仅随重启重建;上线 D 后才开 watch |
| probe 的 eth_call 撞状态裁剪(老块) | probe 只在 latest 态跑;历史归因走 tx-gap-format §0.6(b) |
| 管道 bug 与准入变更混淆 | Slice B shadow(图不变)先落,C 才动准入;读数分离 |
