# Protocol Instance Discovery — 分相实施计划

> 目标:protocol adapter 注册后,实例**自动**发现、probe、建边、热更新进图 —— 消灭 per-instance
> 手写名单(erc4626 vault 类),保留经证明的身份根 pin(registry/factory/singleton)。
> 基线:`origin/main b7f087a`(刀1 已落地,见下)。

## 当前实现状态（`codex/protocol-instance-discovery`，基线 `origin/main ba18f0d`）

裁决：**implemented_not_validated**，不是 `fixed`。代码已经把 B/C1/C2/D/E 的共享骨架接入生产
启动、周期 refresh 与 landed-receipt 两个调用点；首个且唯一已注册动态 family 是 ERC4626。但当前
完整 DEX universe 对 legacy ERC4626 的召回仍不完整，legacy 静态条目因此保留；系统性 scanner/
universe 变更还缺当前 gate 要求的预声明 cohort + paired Hermes A/B，亦未取得同一失败样本的
`scanner self-enumeration → path_found → final_sim_success` 证据，禁止写 fixed。

实际代码形状：

- `observed-protocol-discovery.ts::scanProtocolDiscoveryRange()` 是唯一 scanner，统一拥有 DEX 地址遍历、
  topic union、receipt/trace 去重、并发、错误与歧义裁决；family 文件没有 block loop/getLogs。
- `erc4626-discovery.ts::erc4626Discovery` 只声明 address matcher、Withdraw/redeem/withdraw observed
  matcher 与 route probe。DEX 地址源可召回没有近期 Withdraw 的 vault；observed 源必须同时通过
  selector、Withdraw、asset Transfer 和 causal calltrace。
- `protocol-instance-discovery.ts::runProtocolDiscovery()` 统一执行 identity + probe；
  `prepareProtocolDiscoveryProjection()` 原子 replace/remove discovery-owned pools、edges、strategy views、
  token index、pool map、flash token 与 blockscan graph。临时 reth/网络错误不会把 retained route 当作
  已完成否决而删除。
- `protocol-discovery-cache.ts` 持久化 machine-generated 正/负证据；每轮比较 runtime code hash、
  EIP-1967 implementation word 与 matcher version，负缓存另有 7,200-block TTL；reload 后仍重新走
  identity/probe，不能 load 即 admit。
- DEX 主动候选来自完整 `blockscanUniverse` 的 token metadata，加当前 swap graph 增量；固定 protocol
  token/edge 不参与候选或 loop-closability，避免 legacy/static 自证。
- 生产 endpoint 不新增付费 RPC：`deploy-node.sh` 强制 `SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545`，
  discovery 复用同一 provider。reth 已裁剪的旧事件状态记为证据不足并跳过，不自动回退外部 archive；
  当前状态的主动 DEX 枚举仍可工作。

当前边界：ERC4626 observed v1 只接退出侧（Withdraw + redeem/withdraw）；deposit/mint 不作为第三个
候选源，vault 的冷启动召回由同一个 DEX-universe 地址源完成。其他协议不会自动“猜 adapter”；以后
新增 family 仍需人工实现 capability/identity/probe，注册后才自动共享这两条候选源。Ubiquity 尚无
adapter，tx `0x14026eed…f4fd53` 另有 uCR/WETH cold DEX pool admission 缺口，因此本分支不关闭该 tx。

系统性验收 cohort（合并前仍待 paired Hermes A/B）：

- positive/observed：真实 Withdraw tx `0x0b46f1ff…db30a8`，目标不在 seed，要求 scanner 自发枚举并
  新增 deposit/redeem 两边；
- positive/DEX：生产完整 universe 中的标准 ERC4626 share token，先移除全部 ERC4626 seed，再比较
  graph 前后与第二轮 cache hit；legacy 全集只作答案卷，不作候选；
- negative：普通 ERC20 地址、伪 Withdraw（无对应 asset payout/causal trace）、纯 LP mint/burn、
  同 target 多 adapter 完整匹配、reth pruned historical state、identity/probe transport timeout；
- equivalence/resource：flag-off/shadow graph 不变；未触及 swap edge 集；记录启动地址数、code reads、
  expensive matcher probes、cache hits、scan wall time；A/B 同块比较两条现有 lane 的 pass latency、
  budget censoring、candidate composition 与 final-sim false-positive 数。

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

## 2. 接口:通用 scanner + 声明式 observation(一个扫描器,多租户)

**核心原则(2026-07-20 收敛):协议种类不各自写 scanner。** 一个通用 protocol interaction scanner
拥有全部扫描机制(block/log 遍历、cursor、receipt/trace 读取与去重、并发、timeout);每个协议 adapter
只声明一份 `observation` capability(廉价 shortlist 提示 + 完整匹配 + 建边),不碰 getLogs/cursor。
错误的旧形状(per-adapter `discoverInstances` 各自 `getLogs`)已废弃——它会让每加一个协议就长一套
scanner、同一 tx 被多 adapter 重复拉 trace、扫描调度与协议语义纠缠。

```ts
// 通用 scanner 产出的标准化交互(scanner 不认识任何具体协议)
interface ObservedInteraction {
  txHash; blockNumber; target; selector; calldata;
  call: TraceCall; receipt: TransactionReceipt;
  transfers: TokenTransfer[]; mints: TokenTransfer[]; burns: TokenTransfer[];  // 从整笔 receipt 标准化
  trace: CallTrace;  // 成功 call tree
}

// adapter 只声明协议语义,零扫描机制
interface ProtocolObservationCapability {
  readonly eventTopics: readonly string[];   // scanner 聚合成 topic union,一次查询
  readonly selectors: readonly string[];     // 廉价 shortlist
  // 完整协议匹配:必须用 receipt Transfer + trace 因果退出双验(不是 selector+asset 就算)
  matchInteraction(i: ObservedInteraction, ctx): Promise<ProtocolInteractionMatch | null>;
  // graph-token 主动候选(无观测交互时,对一个地址试匹配);同样只声明语义,循环归 scanner
  matchAddressCandidate?(address: string, ctx): Promise<ProtocolInteractionMatch | null>;
  // 从完整匹配生成边;attestIdentity 的 code-hash/impl 绑定与 evidence 复验在此之后仍强制
  deriveEdges(m: ProtocolInteractionMatch, ctx): Promise<readonly TokenEdge[]>;
}
```

通用 scanner 管道(一次成型,所有协议共用):
```
通用 scanner:聚合所有 adapter 的 topic/selector → getLogs(topic union) → 按 txHash 去重
  → 每 tx 只读一次 receipt + 一次 trace → normalize 成 ObservedInteraction
    → 分发给所有 observation:matchInteraction
      → 0 个完整匹配 = unknown/skip;1 个 = attestIdentity → deriveEdges → 入图;
        >1 个 = ambiguous,隔离记录不入图(唯一性裁决,见 §4.7)
```

三条职责分层(勿混):**shortlist(selector/topic)= 廉价初筛**(命中只决定"交给哪个 adapter 深看",
绝不入图);**matchInteraction = 完整协议匹配**(target/receiver/amount/selector/Transfer 五项 + trace
因果退出);**attestIdentity = 身份根准入**(reverse-verify,code-hash/impl 绑定,升级即失效重 attest)。
`matchTrace` 现有混合实现(部分 target-aware、部分仅 selector)保留,仅作 shortlist,均无需改。

退化语义:无 `observation` 的 adapter = 只有 declaredVenues(单例协议永远停在这档即可)。

## 3. 分相(每片独立合并,通道按 HISTORICAL-GAP 路由)

### Slice B — 通用 protocol interaction scanner(管道,shadow 模式)【deterministic → replay+smoke 直进 main】
- 新建**一个**通用 scanner:聚合所有注册 adapter 的 `observation.eventTopics/selectors` → topic union
  `getLogs` → 按 txHash 去重 → 每 tx 只拉一次 receipt + 一次 trace → normalize `ObservedInteraction`
  → 分发 `matchInteraction` → `attestIdentity` → `deriveEdges` → 喂 `prepareRuntimePoolRefresh`
  (与 main.ts 现有 `scanActivePools()` 并列)。任一步失败 → 该交互不产出。scanner 拥有 cursor/并发/
  timeout;**adapter 侧零 getLogs、零 block loop**。
- **shadow 模式**:probe 结果只打结构化日志(`protocol_discovery` 事件:candidate、verdict、
  would-admit、ambiguous),**不改图**。零准入变更。
- 复用 builder 的 `blocked_on_adapter` 停车场:report 哪些停车候选在 discovery 下会出队(仅日志)。
- **唯一性裁决进 scanner(§4.7)**:一个交互被 ≥2 个 adapter 完整匹配 → ambiguous,隔离记录,不入图。
- 验收:graph SHA 与 main 逐位一致(shadow 不改图);conformance 扩两条——(a)有 observation 的
  adapter 其 matchInteraction 必须 fail-closed(receipt/trace 缺任一 → null);(b)ambiguous 交互
  产出零边;tsc;shadow 日志在 fork 环境可见样本。

> **Slice C 拆两片(2026-07-20 scope 收窄)**:v1 通用 scanner **只做 observed**(不含 DEX 主动
> 枚举),所以 legacy 删除**不在 v1**。C1 = observed-only 落地;C2 = 加 DEX 主动枚举,C2 才拥有
> legacy 删除。**在 C2 落地前,legacy 硬编码必须保留**——observed-only 对休眠 vault(实测 wYLDS 30d
> 无 Withdraw、pfOHM 11d)结构性召回不到,谁在 C1 删 legacy,这些 vault 立刻回退零边。

### Slice C1 — erc4626 作为通用 scanner 的第一个租户,observed-only【Hermes A/B】
- **首期只接 erc4626 一个 observation**(其余协议后续逐个接入,架构一次成型、租户逐个上)。
  erc4626 文件只保留 `eventTopics=[Withdraw,Deposit]` / `selectors=[redeem,withdraw,deposit,mint]`
  + `matchInteraction` + `deriveEdges`;**getLogs/block loop 全部上移到 Slice B 的通用 scanner**。
- **候选来源仅一条:observed 交互**(scanner 扫 topic union → receipt → trace → match)。
  **v1 不读 DEX universe、不用 graph-token 逐地址 probe**(`matchAddressCandidate` 与 DEX 遍历留到
  C2)。因此 v1 是纯 catch-up:抓不到首次,休眠 vault 无 Withdraw 即不产出——这是 v1 的已知边界,
  不是 bug。
- `attestIdentity`:**`asset()` 可读单独不构成身份**(假合约也能实现 asset());erc4626 的身份 =
  标准接口自洽检查(asset/totalAssets/convertTo* 互相一致)+ preview 与 receipt/trace 行为验证
  整体通过 —— 行为即身份,任一环节不符 → null(quarantine)。
- `probeRoute`:`previewDeposit/previewRedeem` 一致性 + **receipt/trace 级 redeem 验证**(继承
  `nonStandardRedeem` 纪律:"错边比没边更糟" —— srUSDe 类 preview 与实付不符的 vault 整体排除);
  loop-closable(asset 与 share 至少一端能在图内闭环)。
- **probe 否决必须有承载体(P0-2)**:`PoolEntry` 携带逐 route 的 `verifiedRoutes[]`,`buildEdges()`
  只为已验证 route 发边;断言 **identity/probe 任一步失败 → zero edge**。
- **flag 门在 refresh 前重执行(P0-3)**:coordinator 喂 refresh 前强制 `requiresProtocolEdgesFlag`;
  测试 **flag off + 有效 discovery = graph hash 不变**。
- **C1 验收(不含 legacy 删除)**:注册 erc4626 observation;喂一笔真实 Withdraw tx → 通用 scanner
  一次拉 receipt+trace → match → attest → probe → 入图;只 Withdraw topic 无匹配 trace = 零边;
  ambiguous(如有)隔离零边;live 窗口漏斗无回归。**C1 不删 legacy、不做召回验收**(那是 C2)。

### Slice C2 — DEX 主动枚举 + legacy 删除【Hermes A/B】
- 加第二个候选源:scanner 遍历 DEX universe token 调 erc4626 `matchAddressCandidate`(`asset()` 反查),
  对休眠 vault 不等 Withdraw 主动召回。**legacy 名单仍不是候选源**——只作期望召回答案卷,存在
  discovery 路径之外比对(P0-1:名单进候选源 = 循环论证假阳性)。
- 依赖 Slice D 的证据 cache 落盘(否则重启后主动召回也回退,见 D)。
- **A/B 验收(legacy 删除的前置)**:
  1. 召回比对:discovery 产出 ⊇ legacy 全集(答案卷比对,legacy 不在候选源);**少一条即 fail**——
     休眠 vault 靠主动枚举 + 证据 cache 必须能召回。
  2. **无 seed replay(强制)**:完全移除目标 legacy/`POOL_REGISTRY` seed 后重放,必须走通
     `scanner 自发枚举 → identity/probe 通过 → edge 入图 → path_found → final_sim_success`;
     现 `blockscan-hunt.ts:225-231` 直接 merge `POOL_REGISTRY`——**trusted harness 需先加 no-seed
     模式**。不满足只记 `implemented_not_validated`,不得记 fixed(gates.md bucket-transition)。
  3. 新增 vault 边计数与 probe 拒绝计数入 journal;live 窗口漏斗无回归。
- 上述全过后:删除 `EXTERNAL_AND_LEGACY_POOL_REGISTRY` 的 erc4626 段(计划的核心交付物)。
  **C2 之前不得删。**

### Slice D — route 生命周期 + 证据 cache 持久化(增删/重 probe/跨重启)【replay 门 + 谨慎 A/B】
- `runtime-pool-refresh` 增加 remove/replace 语义(原子替换 graph/index/filter,不再只 append);
- `watchRouteChanges`(AssetAdded/Removed、实现升级)→ 重 probe → 增删边;
- 安全边界:删除路径只允许 discovery-owned 边;declaredVenues 边永不被自动删除。
- **证据 cache 落盘(删 legacy 安全的必要条件,2026-07-20 审出)**:现 `protocolDiscoveryOwnership`
  纯内存(main.ts 启动 `EMPTY_OWNERSHIP`,无落盘),**逐轮不覆盖(retained 实例带 evidence 复验,
  休眠 vault 只要实现没变一直留着),但进程重启清零** → 休眠 vault(实测 wYLDS 30d 无 Withdraw、
  pfOHM 11d)每次重启回退零边,直到 bootstrap 窗口内再现一笔 Withdraw。修法 = 把 admissions+evidence
  落一个**机器生成的 discovery cache**(每条 `{address, asset, evidence.txHash, codeHash, implWord}`),
  启动 reload。
- **reload 必须走 attest,绝不 load 即 admit(合宪红线)**:加载的条目是**候选**,每轮/启动都过
  `attestIdentity`——用**当前块** `getCode`/`getStorageAt`(自建全节点零 CU)算 code-hash,和 cache 里
  的比;一致 = 证据仍有效 → admit(不需要新 Withdraw、不碰 archive、不依赖窗口),升级/asset 变 →
  自动失效 drop。一旦有人让 loaded 条目跳过 attest,它立刻退化回不合宪的手写白名单。
- 这个 cache 才是删 legacy 的**正解**:它与手写名单的本质区别 = 每条带可链上复验的 evidence 且每轮
  自复验(machine-generated + reverse-verifiable),而非无条件信任的地址白名单。**删 legacy = 用此
  cache 替换,不是删了留空**;删除门改为"每个 legacy vault 至少产出过一次 verified 边并入 cache"的
  持久化召回,而非单次窗口扫描。

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
7. **唯一性裁决(通用 scanner 强制)**:一个 `ObservedInteraction` 被 `matchInteraction` 完整命中
   `0` 个 = unknown/skip;`1` 个 = 交给该 adapter;`>1` 个 = **ambiguous,隔离记录,不入图**。禁止对
   selector-shortlist 命中的多 adapter 各自 probe 后取并集(会产生重复/冲突 admission)。
8. **蜜罐只造假阳性,无资金风险(定性依据,非豁免)**:我们是单笔 flashloan 原子闭环 + 交易完成即
   转出,蜜罐最坏是白烧 final-sim/TTL(假阳性),不构成资金损失。**但这不豁免身份根 attest**——假阳性
   仍烧算力/挤占预算,§4.6 的 attest + §2 的 receipt/trace 双验仍是把假阳性挡在开工前的正门;final sim
   是最后而非唯一的门。
9. Codex 产 diff,逐 hunk 审(gate-full-codex-diff);每片一个 rule-12 gate。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| discovery 产出爆图(vault 长尾/蜜罐) | probe 强制 + loop-closable 过滤 + 每 family 上限;YIELDX 先例 |
| Slice C 假阴(legacy 条目没被重新发现) | A/B 验收硬条件:legacy 集 ⊆ discovered 集,差集=fail |
| append-only refresh 期间路线腐烂 | Slice D 前 discovery 边仅随重启重建;上线 D 后才开 watch |
| probe 的 eth_call 撞状态裁剪(老块) | probe 只在 latest 态跑;历史归因走 tx-gap-format §0.6(b) |
| 管道 bug 与准入变更混淆 | Slice B shadow(图不变)先落,C 才动准入;读数分离 |
