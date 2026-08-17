# S1 Phase F cutover plan（strict → production default authority）

> 用户 2026-08-13 授权（“做”）D-012 的 cutover 前置清单。本文件是把
> “strict 成为 production default authority”拆成可逐 slice 验证、可回退的
> 程序；每条 slice 保持：合同测试 + 完整 build + `s1-regression-sweep.sh`
> 全绿 + checkpoint 同轮 commit/push。代码落地 ≠ authority cutover：
> 最终 live 切换还必须满足 `s1-cutover-readiness` 与
> `default-authority-cutover-gate` 两道门（`status: "ready"`），并经
> `deploy-node.sh` 守护路径 + 显式 live 授权执行，bounded-live envelope
> 全程不变。

> **终态覆盖（2026-08-13）：** canonical §0.1 的“中央路径零单族逻辑”
> 是 F5→F8 的共同前置。旧 generic CLI switch、capture-name alias、中央
> driver/projection map、逐族 corpus/negative harness 或点名生产 Family 的
> 框架测试即使现有测试为绿，也不具备 cutover 权。必须先由 plugin-owned
> capability + generated catalog 取代，并通过 AST + transitive
> import-closure gate。

## F9 cutover 消费点迁移清单（2026-08-14 盘点）

`PRODUCTION_ADAPTER_FAMILIES`（legacy AdapterFamilyRegistry）当前被
**~40 个调用点、20+ 文件**消费。移除 `LEGACY_PRODUCTION_ADAPTER_FAMILIES`
需要逐消费点切到 strict catalog 等价物。按依赖分组：

| 组 | 调用 | 文件 | strict 替代 | 状态 |
|---|---|---|---|---|
| 执行管线 | `routes().buildEdges(backend)`（§18.3 条件 3 旧 I/O 入口）、`routes().findForEdge` 的 `prepared.quote`、`findFundingByAction`/`defaultFunding`、`credits()` | planner/token-graph、solver/quoter、plan-builder、amount-propagation、flash-liquidity、pool-state-updater、planner、path-template | strict lifecycle 管线（adapter-family-runtime）+ `catalog.ownerOfAction` + strict quote（F8 已切 solver 报价，plan 构建未切） | 未开始 |
| 族元数据查询 | `routes().list()` 的 `poolAdapters`、`swaps()`、`oracleVictims()`、`discoverableRoutes()`、`requiresProtocolEdgesFlag` | pool-adapter-policy、path-template、route-family-manifest、main.ts（mempool intake）、live-discovery-coordinator | FamilyManifest 扩展（poolAdapterIds/edgeAdapterIds/oracleVictims/requiresProtocolEdgesFlag 声明进 plugin）+ 从 catalog 投影查询面 | 未开始 |
| pending evidence | `routes().forFamily(id).pendingTransactionEvidence`（routeActivation/scope key） | main.ts（currentHeadEvidence*，5 处） | strict `optional.pendingEvidence`（RequestProgram 形态，需投影层适配） | 未开始 |
| victim models | `victimModels().forEdge(id)?.runtime?.buildOverlay` | live-backends/victim-overlay | strict `VictimOverlaySpec`/`LocalVictimApplySpec`（插件已声明） | 未开始 |
| blind/audit | `list()`、`routes()`（blind T1 投影） | blind-production-compatibility、main.ts（blind session） | strict catalog listAll 投影族清单 | 未开始 |
| registry 判定 | `isRegisteredVenueId`/`isRegisteredIdentitySource` | pool-adapter-policy | catalog/identity registry 判定 | 未开始 |

依赖顺序：FamilyManifest 扩展（族元数据声明）→ catalog 查询面投影 →
执行管线消费切 strict → blind/victim/pending 适配 → 删除 LEGACY 列表 →
closure 清零 + verdict=pass。每步保持 build/shadow/sweep 绿。
（static-protocol-registry-attestation 为未跟踪历史原型，不在清单内）

**调研发现（2026-08-14，供下轮直接执行）**：
- 每个消费点绑定 legacy 族声明字段（poolAdapters/edgeAdapterIds/
  requiresProtocolEdgesFlag/oracleVictims/pendingTransactionEvidence/
  victimModels），strict plugin manifest 目前只有 familyId/domain/
  ownedActionAdapterIds/requiredInfraActionAdapterIds/allowedTaxonomy/
  supportedLineages——缺失字段需逐项设计 strict 等价，非字段搬运。
- `edgeAdapterIds` ↔ strict `routeProjection.projectGraph` 的
  `routeActionAdapterId`（univ2 两处均为 `univ2-swap`），且与
  `ownedActionAdapterIds` 一致——edge 面可经 `catalog.ownerOfAction`
  或 routes capability 静态收敛。
- `poolAdapter`（"univ2" 等池类型标签）是 legacy universe 世界的标签，
  strict 世界用 lineage/pattern（`univ2:factory-child`）——pool-adapter-
  policy 的 `PRODUCTION_POOL_ADAPTERS` 准入派生集需映射到 strict
  lineage 集（派生集本身允许，不得硬编码）。
- `oracleVictim`/`victimModels` 含运行时函数（matcher/priceProbe/
  buildOverlay），只能作为 plugin capability 声明（strict 已有
  `VictimOverlaySpec`/`LocalVictimApplySpec` 先例），不能进 manifest。
- solver/planner 执行管线（token-graph `buildEdges` → planner →
  amount-propagation/plan-builder/flash-liquidity）仍是活跃 legacy 路径
  （`routes().buildEdges` 即 §18.3 条件 3 旧 I/O 入口），是最大切片。

## 门（代码已在库中）

- `searcher:s1-cutover-readiness`：batch parity、非空 held-out negatives、
  systemic-live verdict、startup manifest、strict consumer source-bound
  五项全过才 `ready`。
- `searcher:default-authority-cutover-gate`：strict consumer 为唯一
  production 路径（无 dual authority）、legacy authority 关闭，且三项证据
  门全过才 `ready`。

## Slice 分解（按依赖排序）

### F0 立项

- 本文档。状态：**已完成**。

### F1 StateInstance mutation/terminal proof

- **F1-a terminal settlement（已完成）：** live publisher 接受显式
  terminalRemovals 声明 → issuer-bound terminal removal proof → 合法收缩
  提交（checkpoint 见 Phase E plan）。
- **F1-b mutation/carry proof（已完成）：** 跨代 carry 的 issuer-bound
  StateInstance mutation proof 全链路落地：proof/authority/issuer、
  prepare 线程、shadow root proof-scoped carry override、组合根暴露、
  live publisher `verifyCarriedInstance` 中央重验证回调。无 proof /
  foreign authority / binding mismatch 一律 fail-closed；有 proof 的
  carry 保持 value identity 并把 catalog 重绑到新 source。F1 关闭。

### F2 活动型族严格观测 ingress

- **F2-a 中央 carry 重验证接线（已完成）：**
  `reverifyCarriedInstanceContinuity` + `extractInstanceAddress`：
  从 committed instance 的 identity provenance 恢复地址 → 当前 source
  读 code hash + EIP-1967 implementation word（main.ts 经 provider
  `getCode`/`getStorage` 实读）→ 以 address-surface observation 在
  当前 source 重跑 strict Family lifecycle → 同一 instanceKey/
  lineageId 重新签发才返回 `central:state-continuity:<hash>` 证据。
  任何失败（无地址 provenance、surface 不可读、identity 变化）返回
  null → live publisher 保持 fail-closed。main.ts 已把该回调传入
  `publishStrictCatalogFromLifecycle`。合同测试四例 + shadow suite
  （28 项）/build/12 组 sweep 全绿。
- **F2-b 三类观测 ingress（未开始）：** 7 个活动型族（astra/eigenpie/
  erc4626-silo/ethertoken/hgusdc/curve-underlying/dodo-v2）的
  factory-log/landed-log/observed-call ingress → UnifiedObservation →
  `runStrictFamilyLifecycle`。当前 live feed 只消费 protocol cache 的
  verified_candidates + address_entries；剩余为把三类 log/call 观测源
  接入 feed（Phase E plan Pair C 对应面）。
- **F2-b 核心派生（已完成）：**
  `deriveLiveDiscoveryEventObservations`：原始 observed call/log 事件
  → source-bound UnifiedObservation（selector/topic0 经中央
  `catalog.matches` 按族分桶），同事件去重、超 source 事件跳过
  （stale buffer 不得铸超前 anchor 的观测）。合同测试（wsteth wrap
  call 分桶、重复折叠、越界跳过、未知 selector 空桶）；build/shadow
  suite（29）/12 组 sweep 全绿。剩余 F2-b 接线：生产 discovery
  循环保留 observed events（内存有界缓冲）+ strict feed 合并该分桶
  结果。
- **F2-b 生产接线（已完成）：** protocol cache runtime 增加
  `observedEvents` 有界内存环（4096，不持久化，clone 携带）；
  `projectObservedProtocolPublication` 接收 observed receipt logs 并
  append；live coordinator 把 `input.receipt.logs` 归一化为 log 事件
  传入；main.ts strict feed 用 `mergeFamilyObservations` 合并
  address-surface 与 event 派生结果后跑 lifecycle。observed-call
  ingress（trace calls）仍走既有 hint/内存路径，receipt 只承载
  log 面。build/shadow suite（29）/12 组 sweep 全绿。F2 关闭。

### F3 continuous 调度 lane

- **F3-a publication chain producer lane（已完成）：**
  `createCoalescingPublicationChain` 扩展为多 producer FIFO lane：
  per-producerKey 去重（在途重入 coalesce 为一次 rerun）、backlog
  上界（默认 64，溢出逐出最老 producer 并上报
  `PublicationChainBacklogEvictionError`）、per-run deadline
  （超时上报 `PublicationChainDeadlineError` 且链继续，不阻塞后续
  producer）、`backlogSize()`/`evictions()` 遥测。旧单 producer
  `enqueue(run)` 调用面不变。合同测试：FIFO、同 producer coalesce、
  deadline 后继续、backlog 逐出最老；build/shadow suite（28）/
  12 组 sweep 全绿。main.ts strict 链仍单 producer（默认 key），
  多 producer reserve 在 F2-b ingress 完成后接入。

### F4 22-Family 崩溃恢复契约扩展

- **F4-a restart 恢复（已完成）：**
  `restoreStrictCatalogFromCheckpoint`：catalogRoot 为内存态，重启后
  若只按新观测发布会静默重建更小的 catalog（omission）。恢复路径在
  checkpoint source 上对 durable inventory 的每个 incumbent 重跑
  strict Family lifecycle，任一族重签发实例数少于 incumbent 数、或
  已 committed root 上再次恢复，均 fail-closed 不发布部分 root；
  全部重验证成功才发布重建 root。main.ts 在 `loadForRestart()`
  `trusted` 时、strict runtime 构造后调用。合同测试：restore 重建
  实例集无省略、二次 restore 拒绝、族无法重验证整体拒绝且不发布；
  build/shadow suite（28）/12 组 sweep 全绿。
- 剩余 F4-b：恢复窗口的 22 族逐族失败隔离与 sealed parity 交叉验证
  （F5 corpus 落地后补）。

### F5 sealed-production corpus

- **F5-a 旧采集 harness（历史完成，终态重建中）：**
  `scripts/collect-s1-sealed-production-corpus.sh`：校验 descriptor
  携带 sourceBlock/sourceBlockHash + 非空 cases，本地 reth 重验 block
  hash（fail-closed），3:1 切 train/held-out，经
  `architecture-migration-capture:real` 生成两侧 sealed capture，
  并强制校验 `productionProvenance.commit` 与当前 checkout 一致，
  写 `corpus-manifest.json`。该实现错误地把 held-out negative 当 3:1 cases
  切分，并依赖旧 per-family capture 入口，不能作为终态 F5 证据。
- **F5-a2 终态通用 harness（未完成）：** catalog-issued generic capture；
  独立 baseline/challenger 执行闭包；动态 canonical-value negative；
  production provenance 位于 parity request；identical negative fail closed；
  中央无单族逻辑且 AST/import-closure gate 通过。
- **F5-b 真实 corpus 采集（进行中）：** 需要真实 on-chain
  descriptor（真实 pool/tx/state，不得 fixture:* 占位）在节点本地 reth
  上跑 F5-a，产出非空 held-out 并过 sealed-production acceptance
  （`verdict: eligible`）。17/20 族真实 admitted（curve-underlying 经过渡
  桥入图解决）。**用户最高命令（2026-08-14）**：因超过 reth trace 保留
  窗口（state pruned）导致未迁移/未采集的族（eigenpie/ethertoken/hgusdc）
  在管线验收中视为不存在，直接执行完整迁移；其采集状态如实记录（非吞
  掉失败），窗口内新交易出现时经通用 call-seed 扫描器自动恢复。
- 自动续跑契约：`docs/research/design/s1-f5-corpus-rollout-plan.md`
  （模板 univ2 → erc4626 → 其余，逐族机器判据；守护窗口每轮从该文件
  继续，不需用户逐轮确认）。

### F6 legacy 删除逐项确认

- Phase E Pairs：A 剩余 quote/approve legacy 分支；B identity resolvers；
  C landed-event 消费；D universe deploy trust；F facade/手工 revision/
  schema/cache bridge/旧 flag。每 pair 顺序：strict 替换合同绿 →
  call-site 切换 → 验证 → 删除 legacy（合同绿），任一失败回退该 pair。
  终态验收 = canonical §18.3 / §20.2.6 全门。
- **strict 侧状态（2026-08-15 同步）**：B（attestPoolIdentitiesStrict
  唯一权威）、C（discovery continuity composition）、D（universe 指纹
  strict）、E（strict pricing fail-closed）、F（blockscan schema strict）、
  A（revm strict-only overlay）的 strict 侧均已落地并保持 sweep 绿；
  legacy 删除尚未开始。删除顺序 B→C→D→F→A，每对必须先验证 strict 侧
  再删 legacy（当前无一对满足删除前置，不能诚实删除）。
- **Pair B 新增待落地：Family 模版双通道（fresh + reverseBinding）**
  （2026-08-15 用户裁定）：模版必须同时提供 fresh 接口（现有
  `nominate`：近期观测/交易证据）与 retain 接口（新增 `reverseBinding`
  槽位：冷池可验的反向绑定 factory-child / registry-member /
  PositionManager / manager-state）。每个族都必须声明 retain 接口，
  做不了的显式声明为空/不支持（univ4 非 PositionManager 创建需回创建块
  Initialize、超出本地 reth 保留窗口 → 显式不可反查；angstrom/eigenpie/
  ethertoken 等 tx-bound 族同理）。中央 retained 策略统一为：能反查先
  反查；插件显式不支持时才要求近期证据或拒绝。窗口与 retain 策略在
  中央，插件只声明语义。当前 2c051a43 已实现 univ2/univ3 冷池
  address-surface nomination 兜底（无近期 Swap 时 getCode+指纹物化，
  身份仍链上反查），是这条通道的首个落地切片；其余族与中央策略切换
  待本 slice 完成。
  **strict 验收判据（Pair B slice 完成条件）**：每个纳入重建/验收的族
  必须同时显式声明 fresh + retain 两条通道；retain 允许拒绝但必须显式
  写出（返回“不可反查/不支持”，不允许缺字段）；catalog 投影逐族可查
  `hasFresh` / `hasReverseBinding` / `reverseBindingExplicitlyUnsupported`，
  框架合同测试用 synthetic 族覆盖“两通道都有 / retain 显式拒绝 /
  缺 retain 字段即校验失败”三种形状；生产 22 族全部满足后才允许宣称
  Pair B strict 侧完成。
  **窗口/分片参数中央化（Pair B 子项）**：`findRecentLogHit` 的
  `lookback`（默认 10_000）与 `chunk`（默认 500）当前被 univ2/univ3/
  dodo/angstrom 插件隐式依赖默认值，univ4 插件在自建索引时还写死了
  `lookback: 10_000 / chunk: 500`（已加运行日志
  `[univ4-nomination] recent-swap index ...` 以便观测）。这些窗口/分片
  属于中央策略：由框架在调用 nomination 时显式注入（或由中央配置读取），
  插件只声明需要什么证据（topic/address/poolId），不再隐式吃默认值或
  写死参数。落地后各插件行为不变，但参数来源单一化。
- **F6 查询面扩展（2026-08-15，catalog 投影驱动）**：
  - `poolAdapterIds`（88b9cb94）：22 族插件 manifest 声明真实池 adapter
    标签；`pool-adapter-policy` 从 legacy 切到 strict 投影。
  - `requiresProtocolEdgesFlag`（978e531c）：protocol 族（除 psm）全
    true、swap 族全 false；catalog 投影 `requiresProtocolEdgesFlagFor`。
  - `candidateSources`（9651d381）：`DiscoverySemantics` 新增插件自有的
    动态候选源声明（dex-token-domain / observed-interaction /
    canonical-registry），7 个动态发现族（astra/eigenpie/erc4626/
    erc4626-silo/ethertoken/self-burn/fluid-dex）各自在 discovery
    closure 内声明；validator 同步注册字段与枚举校验。
  - `discoverableFamilySources()`（93f59b29）：catalog 投影
    `{familyId, sourceIds}`（仅含声明 candidateSources 的族）；
    `ProtocolDiscoveryCoverageCoordinator` 改收投影输入；
    main.ts `enabledProtocolDiscoveryFamilies` 切换为 catalog 成员判定，
    legacy 适配器只保留 matcher 细节（eventTopics/callSelectors）供
    证据指纹使用；`observedDiscoveryFamilyIds` 从投影派生。
    credit:fluid 不在投影内——credit 走独立 lifecycle，不参与 pool
    nomination/discovery coordinator（架构既有决定）。
  - 后续消费点（未完成）：route-family-manifest /
    blind-production-compatibility / main.ts `findForEdge`/`findForPool` /
    pendingEvidence / oracleVictims 仍读 legacy，按依赖链靠后切换。
- **F5 验收路径变更（2026-08-16 用户裁定）**：capture harness
  （materialize-s1-capture-inventory / generic-family-capture /
  run-architecture-migration-capture-real-cli / generic-capture-loop 等）
  终止并列入 F6 删除范围，不再作为验收判据。F5 终态验收 = live strict
  管线事实验收：edge fresh 数据（S1）+ 同 amountIn 下 exact↔sim 一致
  （S3/S5）+ 六步 judge 对 live receipts 出 verdict。执行顺序
  F6 → F7/F8（中央 runtime 装配 authority/scheduler/simulator）→ F5
  live 验收 → F9。六步 judge 判据补充：receipt 带
  `(amountIn, exact.amountOut, sim.amountOut)` 三元组做容差对照。

### F7 节点 composition env + committed publication

- 在节点以 `SEARCHER_DISCOVERY_CONTINUITY_COMPOSITION_PATH` 开启
  composition（当前 live 未开），使 strict 四步管线在生产循环真实运行并
  提交 catalogRoot（已有 challenger 节点机器证据 `78934fdf`/
  `f3c1d066`/`22c965dd`/`43a678d9`/`e2e57f0c`，需在 live 路径复验）。
- **2026-08-14 达成（Pair C，commit 8efcf4a0）**：durable discovery
  continuity composition 默认启用（checkpoint 路径默认
  `searcher/state/discovery-continuity-checkpoint.json`，env 可覆盖）；
  startup loadForRestart → enumerator → writer CAS 随每次 live publication
  触发；`onPublicationApplied` → strict live publication chain（observation
  shadow ingress + lifecycle + catalogRoot）。节点 dry-run：`discovery
  continuity composition empty` 正常启动。catalogRoot 节点机器证据
  （78934fdf 等）为 production 路径首次提交记录。

### F8 默认 authority 接线

- solver pricing / Funding / Credit / execution 消费切到 strict default
  （covered route 无 legacy 回退），关闭 legacy authority；必须先过
  `s1-cutover-readiness` 与 `default-authority-cutover-gate` 两道门。
  这是 **production authority cutover**，live 切换需显式授权 +
  guarded deploy；本文件不授权任何 live 广播。
- **2026-08-16 完成（commit c949d56f）**：default-authority cutover 落地。
  `PRODUCTION_ADAPTER_FAMILIES` 改为 strict-catalog 投影
  （`strict-catalog-registry-projection.ts`）：22 族 legacy-shaped 表面全部
  由 plugin manifest 元数据桥接或 `StrictOnlySurfaceError` fail-closed；
  blockscan pricing 与 funding 读取经中央 views provider 直接消费 committed
  strict views（composition 未提交时 fail-closed 无 mids/offers）；路由图
  buildEdges 改从 strict views 取边（token-graph queryPoolEdges）；动态
  admission 清单与 route-family-manifest 从 catalog 投影；LEGACY 权威列表
  与 legacy identity-policy 机器删除（空 resolver registry 仅留形状）。
  四道命名路径（路由图/blockscan pricing/discovery/identity resolvers）
  同 slice 迁移。`MigrationCleanupReceipt` 增加 F9 遗留 legacy runtime
  call-site 探针（quoter/plan-builder/revm/victim/credit/pending-evidence），
  verdict 保持 fail 直至 F9 删除。两道门 PASS、shadow suite 37/37、build
  绿；本地单测按 F8 表面更新（legacy 机器测试改用 legacy adapter 本地
  fixture，如 venue-identity/victim-effect/route-adapters/dodo-v2）。
  遗留 legacy-machinery 测试（swap-observation/protocol-blockscan-state 的
  fixture 断言、amtsearch 的 legacy solver plan 构建）随 F9 删除或改写。
- **2026-08-17 节点 runtime 收敛（commit ed028aee→6342b759，节点 8 次部署）**：F8
  默认 authority 下 strict 管线在 production 循环真实提交。四个运行时缺口逐个
  关闭：(a) 协议 trace 门依赖空 legacy discoverableRoutes——strict catalog log
  pattern topics 模块级注入（ed028aee）；(b) DEX backfill lane 的 heavyweight
  strict incumbent attestation 卡住且 DEX-preempt 永远饿死独立 protocol lane——
  protocol backfill 与 DEX 并行调度（739bc30d）+ observed cursor 锚定 startup
  source（c85a3c9d）；(c) strict projected adapters 缺 discovery capability，
  协议扫描零 adapter——DiscoverySemantics→legacy scan 词汇桥（candidateSources/
  eventTopics/callSelectors/address-surface+observed-call matcher、fail-closed
  identity resolver、cache policy 持久化 matched candidates；8503de55+9b4de6a5），
  silo-redeem/ethertoken/self-burn 补 observed log pattern；(d) address-surface
  observation 误用 adapterId|address 缓存键（bd6c7d3e）+ blockscan observed lane
  事件源入 observedEvents（6342b759）。节点证据：strict catalog root committed:
  revision=N instances=16 pricing=16（多族实例持续提交）、protocol discovery
  address_probe 2400+/pass、observed-call 169 事件、lifecycle 仅剩 fluid-dex
  identity rpc 与 silo no-outcome 两族缺口。node env：
  SEARCHER_DISCOVERY_BACKFILL_ENABLED=1（F5 冻结 0 会饿死 strict 观察面）、
  universe 1500 pools。本地两道门 PASS、shadow suite 全绿、build 绿。
- **2026-08-17 F6 收尾（commit 57c91f09）**：`scripts/s1-regression-sweep.sh`
  仍引用 5 个已删 harness 脚本（generic-family-capture / s1-capture-
  inventory-materializer / architecture-migration-held-out-generator /
  s1-capture-descriptor-generator / architecture-migration-parity-runner），
  `set -euo pipefail` 下 sweep 在首个缺失脚本处退出、receipt 永远写不出——
  F6 机器证据门实际失效。已清除 5 行过期引用并重跑：
  `[s1-regression] PASS commit=57c91f09 tests=7`，receipt 归档
  docs/research/design/evidence/s1-regression-receipt-57c91f09.json。
  F6 至此文档口径收尾（A/B/C/D/F + harness 全 closed/deleted；sweep
  全绿 receipt 为机器证据）。
- **2026-08-17 observed lane 全 catalog 注入生效（commit 57c91f09）**：DEX 族
  实例面接通——observed lane 扫描全部 strict catalog log-pattern topics，DEX
  Swap 日志直进 strict observedEvents（不触发 trace），lifecycle 开始消化。
  节点证据：`strict catalog root committed: instances=44 pricing=44 mids=44
  edges=44`（此前 2）、`blockscan-nminus1-state expected=44 priced=44`（全量
  定价）、observed-interaction watermark 推进。blockscan pass `outcome: ran`
  （state/enumeration 阶段 ran）。当前 44 条边均为 erc4626（22 vault × 2
  方向）；DEX 族 lifecycle 批量处理中（观察量大，coalescing 链串行消化）。
- **2026-08-17 状态机收敛（commit e7b7174a→52122d5e）**：blockscan state machine
  从 expected=0 推进到 `expected=15`（protocol:erc4626 keys=15）。三个缺口：(e)
  observed-interaction 族 watermark 是 contiguous source，watermark=0 永远无法
  推进——startup 锚定 seedObserved（e7b7174a）；(f) strict 实例的 pool 不在 DEX
  universe pool set——committed strict edges 在每次 strict publication 合并进
  runtime graph（98091024，dedup by canonicalEdgeId + 检测地址表）；(g) 图视图
  缓存按 discovery topologyKey 键控，strict 合并不改变该 key——缓存永远冻结
  空边集——topologyKey 后缀 strict root revision（52122d5e）。剩余：`priced=0`
  （expected=15）——strict pricing state 的 mids 推导（生命周期 pricing 证据），
  下轮跟进。
- **2026-08-17 状态机定价接通（commit 9be60f6a→1bca0578）**：expected 稳定
  `26`（此前在 15/37/0 间翻转）：图视图缓存与 nminus1 producer 拓扑缓存均按
  discovery topologyKey 键控，strict 合并不改该 key——两处都改为按当前图的
  strict-edge 指纹键控（hashTokenGraph(canonicalEdgeId 边)，merge 落地即变
  键，9be60f6a 为 buildGraphView、1bca0578 为 producer）；revision 后缀与
  chain merge 延迟在 240s 采纳窗口内竞争（同码重启 expected 翻转）已消除。
  committed root 证据：`instances=26 pricing=26 mids=26 edges=26`（mids 就绪）。
  剩余最后一步：`priced=0`（expected=26）——状态机内 strict capability
  deriveMids 的解析/键空间验证（下轮本地复现 coordinator pricing 路径）。
- **2026-08-17 priced>0 达成（commit 41414b51）**：根因 = 协调器硬拒绝空
  current-N reads（`current-N state key emitted no reads`，causes 26 条
  descriptor 错误），而 strict views-backed capability 的 mids 来自 committed
  views 不执行逐块读取。修复：capability 声明 `readlessPricing`（数据驱动，
  无族分支），协调器对 readless 族豁免空 reads 错误并直接从 committed
  snapshot derive mids。节点证据：`blockscan-nminus1-state expected=2 priced=2`
  （priced>0 达成）、composition `instances=2 pricing=2 mids=2 edges=2` 持续
  提交、blockscan pass `outcome: ran`。本地完整管线复现（真实 composition
  + 生产 registry + 状态机 compile→deriveMids）derived=2 PASS。剩余：DEX 族
  （univ2/univ3/…）实例面——strict 图需要 DEX 边（observed lane 现只扫桥接
  族 topics）；F5 live 验收（ret13 真实 universe 闭环）。
- **2026-08-14 完成（commit 16cf4436）**：solver quoteSource 移除
  `strictQuoteSource ?? liveBackend` 的 legacy fallback——strict quote
  source 是唯一 solver 报价路径（composition 默认后 strict 总存在；
  缺失时 fail-closed 不报价）。两道门 `s1-cutover-readiness` /
  `default-authority-cutover-gate` PASS；shadow suite 55/55；节点 dry-run
  240s 正常（无 fatal、composition 就绪）。revm/anvil backend 保留为
  AmountQuoteSource 接口实现（仅非 strict rpc lane），生产默认 authority
  为 strict-only。

**Pair A strict execution projection checkpoint（2026-08-13，未完成
cutover）：** execution plugin 合同新增必选 `runtimeProjection`，20 个
route/credit plugin 各自在自身 execution closure 内声明 allowance spender
与 prewarm call；`strict-execution-projection.ts` 已删除原中央 20-Family
import/map，只经 catalog `ownerOfAction()` 取得 plugin capability。框架合同
改用 synthetic catalog，不点名生产 Family。完整 build、定向合同与 shadow
suite 通过；generated capability/catalog hash 因 execution closure 合法变化，
旧节点 enumerator evidence 按设计以 `catalogHash mismatch` fail closed，需在
本 checkpoint 固定 commit 上重新执行节点 dry-run 后才算恢复全 sweep。该项
只建立 Pair A 的一部分 strict 侧；`revm-live-backend` 的 legacy quote/
approve fallback 与默认 authority 尚未删除，禁止标记 F6-A/F8 completed。

### F9 最终 cleanup receipt（完成定义，不可省略）

- F7/F8 完成后执行 canonical §18.3 与 §20.2.6 的独立 cleanup slice；
  `MigrationCleanupReceipt.verdict` 必须为 `pass`，全部字段绑定真实机器
  证据。
- production source closure 不得残留可执行 legacy pipeline、dual
  authority、fallback、旧 runtime/schema/cache/revision/flag/I/O API 或
  中央单族逻辑。回滚只指向上一已验收 commit/build artifact，源码不保留
  双实现。
- 只有 F5 eligible、F6 B→C→D→F→A、F7/F8、§18.3/§20.2.6 和最终
  clean-process/node gates 全部通过后，才可宣称 S1/MD 交付完成。

- **2026-08-14 落地（commit 15f00bf0 + 944b276f）**：
  `listener/src/searcher/migration-cleanup-receipt.ts` 落地——
  `buildMigrationCleanupReceipt` 只扫描中央路径（searcher 顶层 +
  live-backends，排除 `venues/` 插件自有声明与 `build-family-capability-manifest.ts`
  dev/CI 工具），产出 `MigrationCleanupReceipt`：`schemaVersion:
  migration-cleanup-receipt-v1`、`legacyRuntimeBranches`（激活输入/族宽
  schema API/手工 adapterSchemaRevision/exactToCoarse 旁路/环境 I/O API
  五类中央 legacy 符号）、`verdict`、`sourceClosureHash`、
  `productionCatalogKind`、`traceWindowAbsentFamilyIds` 与全部机器证据字段。
  中央路径扫描当前 `verdict: pass`（legacySummary 空、legacyRuntimeBranches
  空）；manual `adapterSchemaRevision` 从 swaps 族声明移除，blockscan
  schema revision 改由 strict catalog 的 `strictDefinitionBoundaryHash`
  （capability 注册顶层参数）驱动。`searcher:migration-cleanup-receipt`
  注册，合同测试 PASS，shadow suite 55/55，`s1-regression-sweep.sh` 12/12
  全绿（commit 944b276f）。
- **诚实状态（F9 未完，勿标 completed）**：`productionCatalogKind` 当前为
  `frozen-legacy-route-authority-v1`——`LEGACY_PRODUCTION_ADAPTER_FAMILIES`
  仍作为 `AdapterFamilyRegistry` 的 production authority 输入；切换为
  `generated-static-imports` 需要 strict catalog 完全替代 registry 输入
  （深桥接，非单轮）。receipt 的机器证据字段（batchParityReceiptHashes/
  finalFamilyResultMatrixHash/activeCatalogHash/rollbackArtifactRef 等）
  需在固定 commit 上节点 dry-run 后绑定真实哈希，当前为合同占位。AST/
  import-closure 传递闭包正式证明待补（`scanLegacySymbols` 为结构扫描，
  非传递闭包）。完成这三项后才可宣称 §18.3/§20.2.6 终态。
- **import-closure 传递闭包检查器（2026-08-14 落地，commit 待本轮）**：
  `productionImportClosure()` 从生产入口 `listener/src/searcher/main.ts`
  出发，跟随全部相对 import（静态/副作用/动态）到不动点（567 文件、
  0 unresolved），闭包内区分中央命中（verdict 输入）与 `venues/` 插件
  声明（参考项）；注释剥离后中央 legacy 符号只剩
  `LEGACY_PRODUCTION_ADAPTER_FAMILIES`（production-registry.ts，生产
  authority 未迁移的真实残留）；familyId 字面量分支检查（排除 typeof
  类型守卫）发现 `blind-production-compatibility.ts` 的 erc4626 特判与
  T1 逐族 driver 表（`T1_REGISTERED_ROUTE_FAMILY_IDS`/
  `T1_WARM_KIND_BY_FAMILY`，blind baseline 兼容投影，属 central corpus/
  parity harness 范畴，需迁移为 sealed baseline 数据或删除）。
  **verdict 收紧为 fail（诚实）**：`legacyRuntimeBranches` 空但 closure
  未净 → 之前中央路径扫描的 `pass` 只证明中央符号删除，不证明
  §18.3 终态；`MigrationCleanupReceipt.verdict` 现在要求中央 + 闭包都净。
  合同测试断言 closure 字段、确定性哈希、blind 命中与 `verdict: fail`；
  shadow suite + regression sweep 保持全绿。
- **blind T1 词汇迁移为 sealed artifact（2026-08-14，commit 待本轮）**：
  `blind-production-compatibility.ts` 的 T1 逐族表（registered/current
  family ids、warm-kind map、fluid legacy descriptor）与 erc4626 特判
  从中央可执行代码移出：新建 dev/CI 生成器 `build-blind-t1-baseline.ts`
  （不进 production import closure）产出 `generated/
  blind-t1-baseline.generated.json`（frozenAcceptanceVocabulary +
  generatorSourceHash），compatibility 模块只消费 sealed 数据；
  erc4626 特判通用化为 sealed `mergeGroups` 循环（descriptor 字段顺序
  保持，challenger-runtime/harness/artifact-freezer 测试 PASS 证明语义
  等价）。prebuild 增加 artifact stale check。**closure familyId 分支
  清零**：中央闭包不再有字面量逐族分支/驱动表（`centralFamilyLiteral
  BranchesPresent=false`），只剩 `LEGACY_PRODUCTION_ADAPTER_FAMILIES`
  一处中央残留（production authority 未迁移）。
- **既有失败记录（非本轮引入）**：`searcher:adapter-family-blind-t1-
  compatibility` 自 commit 02f0fbdb（移除 balancer-v3/curve-plain/
  ekubo-router-v1 生产族）起即 fail closed——T1 冻结词汇仍含已删除族，
  inventory 校验 throw（`freeze a new trusted acceptance generation`）；
  原版与迁移版失败相同（验证过），不在 shadow suite。属于 blind 验收
  体系需要新 T0 冻结的独立工作项，不阻塞 S1 F9 清理；后续轮次处理。
- **节点 dry-run 证据（2026-08-14，commit 78a52739 固定，SSM 手动）**：
  /opt/MEV-impl-capture checkout 78a52739（git rev-parse HEAD 确认），
  listener `npm run build` 通过（BUILD_EXIT=0）；注入 /opt/MEV/.env
  白名单 env（SEARCHER_DRY_RUN=1、submit/MEV-Share 关闭）后 240s
  dry-run：EXIT=124（timeout 正常终止）、零 fatal；startup manifest
  `730bd6e0...` families=22 capabilities=242；eager state backends
  ready（8555/8556）；DEX cursor 恢复于 25726089、universe 锚
  25743115 → `pool universe provenance/registry/canonical anchor changed`
  按 Pair D 合同从 max(universe.toBlock, persisted cursor) fail-closed
  恢复；discovery continuity composition empty + inventory writer ready
  （Pair C 正常启动）。注：节点 live searcher 进程未运行期间，
  `node-side-serial-dry-run.sh` 无法从 live pid environ 取 env（exit 2），
  需改用 .env 注入方式（本轮已用）。

## 回退

任一 slice 无法保持绿则回退该 slice（git revert + 上一已验收构建物），
并在 Phase E plan 如实记录。cutover 门保持 `not-ready` 期间，节点继续
legacy authority（bounded-live envelope 不变）。

## 中央家族/协议分类清理（2026-08-17，commit b82383ce→e8e7a7db）

用户裁定：中央管弦内不允许存在协议类别/adapter-family 分类；删除后流程
暂可不跑通，但 build 必须保持绿。逐批完成并 commit/push：

- pool-registry-key：univ4 特判移除，按 route binding / poolId 字段数据驱动。
- pinned-warm-pools：univ4 特判移除，fixedToken/warmDirections 通用解析，
  warm pool key 按字段存在性派生。
- strategy-taxonomy：fluid-vault 特判移除（slot 必须由池声明）。
- blind-production-compatibility：fluid-dex/credit:fluid/erc4626-silo 兼容
  别名与 fluid-credit/fluid-dex legacy descriptor 特判删除；冻结库存门
  需要冻结新 baseline 才能重新通过（接受）。
- auto-close-route-gap / route-gap-watcher：venue 分支改为 id 形态驱动
  （bytes32 pool-key vs address）。
- detector/blockscan-scanner：legacyReader 家族 switch 删除，改为按状态
  快照形状数据驱动的 readAnyWarmMid；删除孤儿 blockscan-curve-mids。
- active-pool-discovery：univ2/univ3 工厂 topic/解析分支删除，工厂事件
  语义由 venue catalog 声明（factoryEvent），中央只消费声明。
- build-active-pool-universe：univ2/univ3/curve-underlying 元数据 enrichment
  桥与 discovery-queue 家族探测删除，通用 lane 只携带 strict identity 字段；
  无 token 元数据时 queue 条目 fail-closed 阻塞（族物化器提供前不通过）。
- 删除 univ4 专用 backfill-v4-poolid 工具 + npm script + 直接测试。
- main.ts：univ2 专用 provisional 图日志泛化。

保持不动（文档化例外）：build-blind-t1-baseline 冻结 T0/T1 词汇（sealed
桥，不进生产 closure）；migration-cleanup-receipt 的
TRACE_WINDOW_ABSENT_FAMILY_IDS（用户裁定验收数据）；fixture-replay 测试
基建；pool-state-cache 的 v2/v3/v4/curve 状态形状 kind（数据模型）。

剩余待处理：requiresProtocolEdgesFlag / slotKind 类别开关的进一步收敛为
插件声明（当前为 manifest 字段的通用消费）；LEGACY_PRODUCTION_ADAPTER_
FAMILIES 权威拆除（F9 深桥）。

## DEX 观察面 live 验证（2026-08-17，commit 94d17ef6）

根因（94d17ef6 修复）：protocol backfill 的 rebase 同时要求 DEX routing
fingerprint 与预备时一致，而 DEX lane 每几秒发布 → protocol 作业永远
rebase 失败被丢弃 → 扫描写入（observedEvents/address）从不发布，ring 恒空、
observed cursor 卡在启动块。修复：(1) protocol-only rebase 不再被 DEX
routing fingerprint 门住；(2) rebase 时把 staged 扫描的 observedEvents /
address 写入合并进 current cache，而不是用 fresh clone 替换（旧逻辑每次
rebase 都丢掉扫描产出）。

节点验证证据（/opt/MEV + /opt/MEV-impl-capture = 94d17ef6，build 绿，
searcher PID 208616，dirty 文件保留）：

- `strict catalog observed topics=22`；`observed ring: n=1550`，topic 分布
  含 univ3（499）/univ4+angstrom（394）/univ2（255）/curve（254）/
  pancake-v3（57）/fluid（18）等。
- `strict observations: families=8`：univ2-standard=509、univ3-standard=566、
  univ4=407、dodo-v2=26、angstrom=395、fluid-dex=992、erc4626=998、
  silo=13（DEX 族不再静默）。
- `strict catalog root committed: revision=2 instances=134 pricing=135
  mids=255 edges=257`（从 12 增长）。
- `strict edges merged into runtime graph: edges=257 pools=134`。
- blockscan-nminus1-state：`expected=257 priced=255`（收敛后），state keys 含
  univ3=107、univ2=5、univ4=1、dodo=9、fluid=1、erc4626=5。
- 无新 fatal（当前进程 tail 800 行 0 fatal）。

收敛后（2026-08-17 继续运行 ~30 分钟）：blockscan-family 最近 20 个 pass
`outcome: ran ×16 / budget_exceeded ×4`（0 degraded）；`expected=257
priced=255` 稳定；当前进程 0 fatal。判据全部满足：ring 非空、DEX 族
lifecycle 运行、root instances 增长（12→134）、blockscan expected/priced
>44、DEX 族出现在 state keys、pass outcome ran。

仍记录（不阻塞本次验证、按规则继续跟踪）：状态机 `status=degraded`
issueCount=25 来自族源完整性缺口（landed-event 落后 ~3 块、dex-token-domain
complete through 0、observed-interaction 未追平；curve/self-burn/astra/
silo/angstrom 等族级缺口），需后续批次逐个补齐才能让状态机 status 转
degraded→ok；单族失败结构化记录、不降门槛。

## 当前 live 复核（2026-08-17，节点 HEAD `2eceb6f8`）

节点 `/opt/MEV`、本地分支与 `origin` 已按 exact-SHA 核对为
`2eceb6f8b512fdb40ec7eacf22f31288d244aea9`。最新机器记录为
`sourceBlock=25772716`, `generation=687`, `expected=257`, `priced=255`,
`status=degraded`, `issueCount=25`；因此当前覆盖仍为 **255/257**，只能作
诊断进度，不能写成 F5 `eligible=true`。

`custom-swap:angstrom-v4` 仍有重复的
`strict lifecycle ... no-outcome`。已确认这不是“没有 topic”：原始 V4/Angstrom
日志已进入 observed 面；当前已部署路径仍缺从 opaque `poolId` 观测到真实
tx-bound proof 的可发布结果。`2eceb6f8` 的一次性历史窗口能力是中央通用、
环境开关控制的补扫，不是 Angstrom 专用修复，且本次结果未改变 255/257。

工作树中的 nomination bridge 尚未提交/部署，不能计入节点证据。下一步必须按
“测试 → build → commit/push → 节点 exact-SHA 同步 → live 重跑”执行；在
Angstrom 与其余 `graph-incomplete` 来源闭合、`status` 收敛且六步 live receipts
完整前，F5/F9 均保持未关闭。
## F6 legacy call-site 删除地图（2026-08-17，部署/F5 后执行）

MigrationCleanupReceipt 的 import-closure 扫描（scanLegacySymbols）当前 6
个命中（legacy.size === 6；borrow-fragment probe 已干净）：

| probe | 文件 |
|---|---|
| legacy quoteExact call-site (`.quoteExact({`) | solver/quoter.ts |
| legacy buildPlanFragment call-site (`.buildPlanFragment({`) | solver/plan-builder.ts |
| legacy prepared quote call-site (`.prepared.quote(`) | live-backends/revm-live-backend.ts |
| legacy credit sizing call-site (`.creditPolicy.quoteOutputByDebtBps(`) | solver/amount-propagation.ts |
| legacy victim overlay call-site (`.victimModels()`) | live-backends/victim-overlay.ts, solver/victim-apply.ts |
| legacy pending evidence call-site (`pendingTransactionEvidence()`) | main.ts |

删除顺序（F6）：先证明 strict replacement live-load-bearing（F5 部署后），
再逐对删除并跑 receipt（verdict 从 fail 转 pass 前保持 legacy.size 递减且
closure.legacySymbolHitsPresent 最终 false）。

## 对抗审计 P0 修复（2026-08-17，commits 984c5440/016a728d/5f24f795/dfcaf055）

外部对抗审计（257-audit-current-startup.log）逐条验证属实，并按其设计修复：

- **P0-a（984c5440）**：startup poolSets 按每实例身份键（V4/Angstrom 用
  poolId、其余用 address）去重，universe 与 blockscanUniverse 同源文件只
  attest 一次（原来 12,015 池 attest 两遍，第二遍还排队在后面）。
  `attestPoolIdentitiesStrict` 新增 `outcomesByKey` 供并集结果分发。
- **P0-b（016a728d）**：startup attestation 收集每个池的 sealed lifecycle
  publication（原来 publisher 是 no-op，实例/投影全丢）；按 family 合并为
  单 publication（`mergeStartupFamilyPublications` + 导出
  `sealPublication`）后经 `publishStrictCatalogFromLifecycle` 在 startup
  source 提交到 composition（fresh start 才发布，restart 走 checkpoint
  restore），并把 committed strict edges 合并进 runtime graph/blockscan
  graph/pool map（coordinator 创建前）。
- **P0-c（016a728d）**：`publishedByFamily.has(familyId)` 整族跳过 carry
  改为逐实例 carry——本轮未重发布的每个 (familyId, lineageId, instanceKey)
  单独 reverify + issuer-bound mutation proof。
- **P0-d（5f24f795）**：observation 去重键从 block+txHash+topic0 改为完整
  日志身份 block+txHash+logIndex+address+全部 topics（`logIndex` 从
  eth_getLogs 贯穿 `ProtocolDiscoveryLog`/`StrictLiveObservedEvent`；
  共享 helper `strictObservedEventDedupeKey` 供 scanner buffer、严格
  观察派生、coordinator 合并三处使用）。
- **P0-e（dfcaf055）**：修复 lookback 双调用副作用（一次性消费在第一次
  调用就翻转，值永远到不了 scan）+ Math.max 无法向历史扩展；改为首个
  protocol-backfill 接收**绝对** `eventWindowFrom`，绑定 universe build
  window（manifest fromBlock..toBlock，main.ts 从
  `loadPoolUniverseCoverageMetadata` 传入），`SEARCHER_OBSERVED_EVENT_
  LOOKBACK_BLOCKS` 仅作可回退 fallback；scan 的 canonical source-hash
  断言绑定 cutoff。

测试：strict-identity-attestation（去重 + merge 单元）、strict-catalog-
live-publisher、strict-live-observation-feed、observed-protocol-discovery
全绿。tsc 仅剩另一窗口未提交 nomination 文件的既有 TS2339。

本地验证补充：用节点真实持久化 cache（2923 entries）+ 空/全 coverage 直接
跑 writer.write() 均 committed（revision=1）——checkpoint writer/CAS 路径
健康；历史 67 次 unresolved 全来自旧代码 run（无 reason 后缀），当前代码
首轮发布后即可看到真实行为。

节点运行时代码确认（审计同判）：PID 216494 07:57:51 启动早于 2eceb6f8
（08:40:11 UTC）——运行代码至多是 259eef30，已 kill；旧 run 的
"attestation 两轮串行" 与 no-op publisher 丢弃成果意味着等它没有任何
可信 ETA。rebuild（pid 227686，dfcaf055 之前代码 + retain 修复）产出
新 universe 后：trust 校验 → publish → deploy-node.sh 部署
（systemd + RUNTIME_COMMIT 绑定）。

## ret13 12015 池宇宙 + 历史窗口回扫（2026-08-17，commit 2a0f928d）

节点实际状态修正：上一节的“searcher inactive”不准确——节点在
`2eceb6f8`（launch2 后再次部署）以 DRY 模式运行在旧 ret13 快照
（`/opt/MEV-runtime/universe/f5-ret13.json`，12015 池，toBlock=25758963）
上，启动 strict attestation（8000/12015 @ ~63min，与重建抢 reth 时更慢），
进程 env 含 `SEARCHER_POOL_UNIVERSE_TOP_N=20000`、`SEARCHER_DRY_RUN=1`。

ret13 重建 retain 失败修复（2a0f928d）：重建（RETAIN=旧 ret13）在
`pools[11697].identitySource` 报 `unsupported identity source
angstrom-v4-hook-poolkey`。全量 12015 条中仅 2 条携带该旧 provenance
（均为活跃 angstrom hook-poolkey 池：USDC/WETH、WETH/USDT，lastSwap 在
窗口内）。根因：259eef30 为运行时加载加了
`allowUnregisteredIdentitySource`（main.ts:1640），但 builder 的 retain
解析（build-active-pool-universe.ts priorUniversePools）漏接该选项。
修复：retain 调用传 `allowUnregisteredIdentitySource: true`，沿用同一
契约——标签仅作输入 provenance，builder 经
`retainVerifiedSwapFamilyInstances`（strictAttestation）立即对全部 retained
行重 attestation 并覆写标签，输出快照保持干净；deploy-time trust 校验与
运行时保持严格解析。测试 pool-universe-parse 通过；节点 /opt/MEV 已
exact-SHA `2a0f928d`。

重建（节点 pid 227686，`POOL_UNIVERSE_TO_BLOCK=25773809`、
`LOOKBACK_DAYS=2`、RETAIN=旧 ret13、OUT=/tmp/ret13-new.json）：retain
解析通过（0 unsupported 报错），窗口 [25759404, 25773804]，union scan
15 组完成，retained family inventory 重 attestation 3637 候选进行中，
后续为 enrich/rank/输出。完成 → trust 校验（pool-universe-deploy-trust，
当前代码指纹）→ publish 到 active-pools.json → deploy（debounce 命中跳过
1500s 重建）。

部署计划（部署纪律 + debounce 细节）：先 stop searcher（触发 deploy
“no running process”分支，.env 中非管理键保留），在 .env 追加
`SEARCHER_OBSERVED_EVENT_LOOKBACK_BLOCKS=14400`（对齐新重建窗口起点），
再 `SEARCHER_DEPLOY_REF=origin/codex/s1-unified-adapter-architecture-impl`
deploy。部署后首轮 protocol-backfill 一次性回扫 [head-14400, head]，
观察 12015 池窗口内 Swap 日志 → 新实例/边跳升（目标：边数从 257 显著
增长、expected/priced 同步），验证 F8 证据驱动管线在大池面上的覆盖能力。

checkpoint 持久化（重启沿用）仍 unresolved：节点 67 次
`checkpoint inventory unresolved` 全部来自旧 run（无 reason 后缀）；
当前 run（2eceb6f8 含 6a191b17 reason 日志）首次发布后即可拿到真实
reason。节点无 `searcher/state/discovery-continuity-checkpoint.json`
残留文件；后端 mkdir recursive + 原子 CAS，首次 CAS(expected=null) 路径
代码上成立。待 reason 到手后修复（本地 dbg-checkpoint.ts 复现 harness
已就绪）。


