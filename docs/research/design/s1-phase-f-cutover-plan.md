# S1 Phase F cutover plan（strict → production default authority）

> 用户 2026-08-13 授权（“做”）D-012 的 cutover 前置清单。本文件是把
> “strict 成为 production default authority”拆成可逐 slice 验证、可回退的
> 程序；每条 slice 保持：合同测试 + 完整 build + `s1-regression-sweep.sh`
> 全绿 + checkpoint 同轮 commit/push。代码落地 ≠ authority cutover：
> 最终 live 切换还必须满足 `s1-cutover-readiness` 与
> `default-authority-cutover-gate` 两道门（`status: "ready"`），并经
> `deploy-node.sh` 守护路径 + 显式 live 授权执行，bounded-live envelope
> 全程不变。

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

- **F5-a 采集 harness（已完成）：**
  `scripts/collect-s1-sealed-production-corpus.sh`：校验 descriptor
  携带 sourceBlock/sourceBlockHash + 非空 cases，本地 reth 重验 block
  hash（fail-closed），3:1 切 train/held-out，经
  `architecture-migration-capture:real` 生成两侧 sealed capture，
  并强制校验 `productionProvenance.commit` 与当前 checkout 一致，
  写 `corpus-manifest.json`。
- **F5-b 真实 corpus 采集（待节点执行）：** 需要 22 族真实 on-chain
  descriptor（真实 pool/tx/state，不得 fixture:* 占位）在节点本地 reth
  上跑 F5-a，产出非空 held-out 并过 sealed-production acceptance
  （`verdict: eligible`）。未采集前 sealed acceptance 保持
  `unit-contract/ineligible`（P0-6 fail-closed，诚实不变）。

### F6 legacy 删除逐项确认

- Phase E Pairs：A 剩余 quote/approve legacy 分支；B identity resolvers；
  C landed-event 消费；D universe deploy trust；F facade/手工 revision/
  schema/cache bridge/旧 flag。每 pair 顺序：strict 替换合同绿 →
  call-site 切换 → 验证 → 删除 legacy（合同绿），任一失败回退该 pair。
  终态验收 = canonical §18.3 / §20.2.6 全门。
- 当前 strict 侧状态：B/C/D/F 均未开始；A 剩余分支等 F8 全量 strict
  quote。删除顺序 B→C→D→F→A，每对先建 strict 侧再删（当前无一对
  满足删除前置，不能诚实删除）。

### F7 节点 composition env + committed publication

- 在节点以 `SEARCHER_DISCOVERY_CONTINUITY_COMPOSITION_PATH` 开启
  composition（当前 live 未开），使 strict 四步管线在生产循环真实运行并
  提交 catalogRoot（已有 challenger 节点机器证据 `78934fdf`/
  `f3c1d066`/`22c965dd`/`43a678d9`/`e2e57f0c`，需在 live 路径复验）。

### F8 默认 authority 接线

- solver pricing / Funding / Credit / execution 消费切到 strict default
  （covered route 无 legacy 回退），关闭 legacy authority；必须先过
  `s1-cutover-readiness` 与 `default-authority-cutover-gate` 两道门。
  这是 **production authority cutover**，live 切换需显式授权 +
  guarded deploy；本文件不授权任何 live 广播。

## 回退

任一 slice 无法保持绿则回退该 slice（git revert + 上一已验收构建物），
并在 Phase E plan 如实记录。cutover 门保持 `not-ready` 期间，节点继续
legacy authority（bounded-live envelope 不变）。
