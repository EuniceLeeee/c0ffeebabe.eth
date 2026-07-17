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
    enumerateRoutes(instance: ProtocolInstance, blockTag: BlockTag): Promise<ProtocolRoute[]>;
    probeRoute(route: ProtocolRoute, ctx: ProbeContext): Promise<RouteProbeResult>;
    watchRouteChanges?(...): AsyncIterable<RouteChange>;   // Slice D
  };
}
```

退化语义:无 `discovery` 的 adapter = 只有 declaredVenues(现状,单例协议永远停在这档即可)。

## 3. 分相(每片独立合并,通道按 HISTORICAL-GAP 路由)

### Slice B — discovery coordinator(管道,shadow 模式)【deterministic → replay+smoke 直进 main】
- 新 coordinator:遍历注册 adapter → `discoverInstances` → `enumerateRoutes` → `probeRoute`
  → 产 `PoolEntry` → 喂 `prepareRuntimePoolRefresh`(与 main.ts 现有 `scanActivePools()` 喂法并列)。
- **shadow 模式**:本片内 probe 结果只打结构化日志(`protocol_discovery` 事件:candidate、
  probe verdict、would-admit),**不改图**。零准入变更。
- 复用 builder 的 `blocked_on_adapter` 停车场:coordinator 报告哪些停车候选在 discovery 下会出队
  (仅日志)。
- 验收:graph SHA 与 main 逐位一致(shadow 不改图);conformance 扩一条(有 discovery 的 adapter
  其 probe 必须 fail-closed:任一 probe 调用 revert → 该 route 不产出);tsc;shadow 日志在
  fork 环境可见样本。

### Slice C — erc4626 接口派生 discovery(第一个真准入变更)【Hermes A/B】
- `discoverInstances`:候选源 = DEX universe 的 token 集 + 现有 legacy 名单(自检回归用);
  `asset()` 可读且 share/asset 任一在图内 → 候选。
- `probeRoute`:`previewDeposit/previewRedeem` 一致性 + **fork 收据级 redeem 验证**(继承
  `nonStandardRedeem` 纪律原文:"错边比没边更糟" —— srUSDe 类 preview 与实付不符的 vault
  整体排除,除非其 declaredVenues 带专用 metadata);loop-closable(asset 与 share 至少一端
  能在图内闭环)。
- **A/B 验收**:challenger 图 ⊇ champion 图的 erc4626 边(legacy 20+ 条必须全部被 discovery
  重新发现,一条都不能少 —— 少一条即 discovery 有假阴,fail);新增 vault 边计数与 probe 拒绝
  计数入 journal;live 窗口漏斗无回归。
- 通过后:删除 `EXTERNAL_AND_LEGACY_POOL_REGISTRY` 的 erc4626 段(计划的核心交付物)。

### Slice D — route 生命周期(增删/重 probe)【replay 门 + 谨慎 A/B】
- `runtime-pool-refresh` 增加 remove/replace 语义(原子替换 graph/index/filter,不再只 append);
- `watchRouteChanges`(AssetAdded/Removed、实现升级)→ 重 probe → 增删边;
- 安全边界:删除路径只允许 discovery-owned 边;declaredVenues 边永不被自动删除。

### Slice E — observed-selector quarantine 泳道(最低可信度,最后做)【Hermes A/B】
- 已知 selector 命中未知 target → quarantine → **身份根 attest** → getter/quote probe → 热进图。
- 沿用性(核实 origin/main):`ActionAdapter.matchTrace(target, selector)` 接口已带 address 参数、
  dispatch 已传 `target`,**但现有实现全是 `_target`(仅按 selector 匹配)** —— 本片必须让 address
  那一层真正生效。`poolRegistryKey`(非 v4)= 裸地址,多 token 路线需新增 `protocolRouteId`
  (`selector:tokenIn:tokenOut`)进键,否则同址第二路线被去重吞掉。receipt→trace shortlist 基础设施
  散在 detector/pool-impact,可复用,不新建 daemon。工程量 = 一个 scanner + 一个 route key + 两个
  调用点(启动回扫最近 N 块 + 现有 refresh timer 扫新块)。
- **身份根 attest 是准入前置,不是可选优化(宪法 §2 硬要求)**:命中 selector 只产生 candidate;必须
  再过 adapter 声明的 `attestIdentity(target)` —— reverse-verify on-chain 身份 —— 通过才 probe/进图,
  否则 quarantine 不进图。**只按 selector 放行 = 把身份门降级成 selector 门 = 蜜罐可仿冒**(造一个
  假 target 发对的 burn+mint,quote-probe 会通过、执行时罚没)。attest 形状:Ubiquity =
  `Manager.hasRole(BURNER_ROLE, target)`(**已链上实测 = true**,见下);erc4626 = `asset()` 可读且
  share/asset 自洽;proxy 记 implementation/code hash,升级即失效重 attest。
- **定位诚实(硬约束)**:observed-flow 定义即"先在链上看到才学到" → **首次收割永远抓不到**
  (信息论边界)。本片命名 = `observed-protocol-route catch-up`,报告必须写明"不覆盖首次收割";
  **cold-pool / standing-state 首次收割类 gap(tx14 死池、tx2b48 V4 cold-pool)不因本 scanner 上线
  而在 gap 台账关闭** —— 关闭它们要靠主动枚举(Slice C 的 `asset()` 反查 / 身份根枚举),那才是北极星
  要的东西,运维债消除只是附带。被动兜底与主动枚举**汇入同一个带身份根的 verified-route 出口**,不可
  只留被动这一条泳道。

### 关于 Ubiquity 身份根:证据已从"不足"变为"充分"(链上实测,本轮补)
- 早前结论"CreditNftManager singleton 证据不足、不能白名单化"**已被链上数据了结**:
  `converter(0x4321).manager()` = `0x4DA97a8b…`(正向),且身份根 `Manager.hasRole(UBQ_MINTER_ROLE,
  0x4321)` = **true**、`hasRole(UBQ_BURNER_ROLE, 0x4321)` = **true**(反向认证)。这满足宪法的
  reverse-verified on-chain identity —— 合宪准入依据 = pin Manager + `hasRole` 派生,**不是** pin 样本
  地址 `0x4321`。这条同时证明了上面 attest 钩子对 Ubiquity 的具体实现可行。
- **但立项状态不变**:ubiquity-credit 仍不过 EV 入场门($0.02/次,残余协议),**不立项**;上述身份根
  只是把它从"证据不足"移到"证据充分但不值",并作为 Slice E `attestIdentity` 的样本形状留档。

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
