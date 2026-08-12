# S1 剩余 gate 设计说明（blocker 可执行化）

> 本文把 canonical 文档中仍未关闭、且卡在沙箱内的两项实现 gate 写成可
> 执行设计。其余未关闭项（production solver 接线、paired-live 实跑、
> 默认 authority 切换、Phase E cleanup）以 `evaluateS1CutoverReadiness`
> receipt 为单一入口，必须由节点/授权环境完成，本设计不替代授权。

## 1. complete-snapshot 一次性消费：factory-log incumbent 扩展

### 现状 blocker

- 状态更新：address-surface Family 的 complete-snapshot 正向路径已关闭
  （wsteth fixture lifecycle → closure receipt → prepare/publish 成功，
  见 canonical 文档对应 checkpoint）；本节仅针对 factory-log 族。
- `AdapterFamilySnapshotInventoryClosureVerifier.expectedFamilies` 对每个
  discovery Family 要求 `supportsAddressSurfaceBootstrap`（sources 必须是
  event/address-surface 且含 address-surface + addressSurfaces）；
- 实测 22 族中仅 9 族满足；univ2/3/4、dodo、curve、angstrom、astra、
  eigenpie、silo、ethertoken、hgusdc 等 factory-log/event 族不满足；
- 因此 full-catalog 的 closure receipt 无法签发，strict shadow catalog
  的 `prepare` 只能拒绝 `complete-snapshot` stage。

### 落地状态（2026-08-12）

- 本节设计已按 1–3 验收关闭：`factory-log` incumbent surface、
  `catalog.matches` 反向 topic 匹配、closure 的 candidateKey ===
  inventoryKey 门、hash v3（incumbentKind + factory-log 投影）、
  expectedFamilies 放宽（address-surface **或** factory-log+logPatterns）、
  strict shadow catalog 真实 receipt prepare/publish 正向路径均已有
  合同测试并通过；
- 验收 4 已合同级关闭：snapshot inventory closure 采用 subset 语义后，
  真实生产 catalog 中 univ2-standard（以及全部 13 个 bootstrap-eligible
  族）可签发 closure receipt，其余 7 个 observed-call/landed-log-only
  族（astra、eigenpie、erc4626-silo、ethertoken、hgusdc、
  curve-underlying、dodo-v2）保持 append-only，mixed-mode 同批
  prepare/commit 已过合同；这些族仍需要超出本节的新 incumbent 语义，
  不能通过放宽 factory-log 规则解决。

### 目标模型

新增 inventory incumbent kind：`factory-log-incumbent`。

- `inventoryKey`：canonical 化 pool 地址（与 address-surface incumbent
  同字段，便于 admission keys 统一）；
- `currentSurface`：保留 `AddressSurfaceObservation` 结构，但允许
  `kind: "factory-log"` 的扩展 observation（含
  `factory`、`poolKeyProjection`、`lastFactoryLogBlock`），
  `catalog.matches` 增加对 factory-log observation 的反向匹配：
  `discovery.logPatterns` 中 topic 命中 + `decodeCandidate` 返回该
  Family candidate 且 candidateKey === inventoryKey；
- fingerprint：`adapterFamilySnapshotInventoryHash` 增加
  `incumbentKind` 与 factory-log 投影（排序/去重规则沿用 address
  surface 版本），跨 kind 同 key 仍拒绝重复；
- `expectedFamilies` 放宽为：
  `sources ⊆ {factory-log, landed-log, observed-call, address-surface}`
  且（含 address-surface + addressSurfaces **或** 含 factory-log +
  logPatterns）；
- 事件连续性校验：factory-log incumbent 的 Family 必须在其
  `factory-log` watermark 上满足 `contiguous-history` 到 source 块。

### 验收

1. 合成 catalog（univ2 风格：factory-log+logPatterns、无
   address-surface）能通过 `expectedFamilies` 与
   `validateAndFreezeFamilies`；
2. 该合成 catalog 的 `verifyAndIssue` 对 factory-log incumbent 签发
   closure receipt，`consumeForCatalog` 只消费一次；
3. strict shadow catalog：对含该 Family 的 `complete-snapshot` stage，
   用真实 receipt prepare 成功；forge/缺失 receipt、重复消费、缺失
   Family 行全部 fail closed；
4. 真实 full-catalog 至少 univ2-standard 能先以 factory-log incumbent
   关闭（其余 Family 仍 append-only），随后逐族放宽。

## 2. production point-in-time enumerator 真实数据源

### 现状 blocker

`main.ts` 的 continuity composition 构造时
`enumerateSnapshotInventory` 直接 throw；point-in-time enumerator 只有
纯函数合同（`enumeratePointInTimeInventory`），没有 production source。

### 目标合同

```ts
interface DiscoveryInventoryEnumerator {
  enumerate(source: CanonicalSource):
    Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
}
```

- 输入：discovery checkpoint store 的当前 incumbent inventory
  （address-surface + factory-log 两种 incumbent，按 §1 统一投影）；
- 输出：`enumeratePointInTimeInventory` 可直接消费的
  `AdapterFamilySnapshotInventoryEnumerationInput`；
- fail-closed：任一 Family 的 inventory 无法从 checkpoint 还原时，
  整个 enumerator 返回 explicit unresolved，不允许部分快照冒充
  complete；
- 接线：`SEARCHER_DISCOVERY_CONTINUITY_COMPOSITION_PATH` 已开启时，
  composition 用该 enumerator 替换 throw 占位；枚举仍失败时 closure
  candidate 不可签发，系统保持 append-only。

### 验收

1. 节点 dry-run：开启 env gate 后，用真实 checkpoint store 数据调用
   enumerator，返回非空 inventory 且不 throw；
2. 与 closure verifier 的 `enumerateSnapshotInventory` 串联后，
   candidate.verifyAndIssue 全流程无错误；
3. checkpoint 缺行时 fail closed，日志给出缺哪个 Family/incumbent。

### 落地状态（2026-08-12）

- discovery checkpoint 已升级 v2，持久化逐 Family incumbent inventory
  （两种 surface 统一经 `enumeratePointInTimeInventory` canonical 化）；
  `DiscoveryInventoryEnumerator` /
  `CheckpointDiscoveryInventoryEnumerator` 已实现并在 main.ts env gate
  下接线，替代 throw 占位；
- 验收 2、3 已合同级关闭：wsteth 与 univ2 两个 composition 端到端路径
  都把 incumbent 先写入 checkpoint，再经 enumerator → closure verifier
  → strict catalog `complete-snapshot` 全链路通过；无 trusted receipt /
  append-only 重启 / source 不一致 / 缺失或多余 Family 行 / 篡改
  inventoryHash 全部 fail closed；
- 验收 1 部分关闭：fixture-backed 节点 dry-run 已执行并通过（SSM
  `5f6aba8c-512f-4d5a-8e0a-cac84021e163`，真实 store/catalog/enumerator
  实现 + 合成 incumbent inventory，证据记录
  `docs/research/design/evidence/s1-node-enumerator-dry-run-….json`）；
  live discovery 写入真实 incumbent inventory 的 dry-run 仍待接线，
  不在此虚报。

## 3. 依赖关系

- §2 依赖 §1 的 factory-log incumbent 投影（同一 inventory 模型）；
- 两者都完成并有节点机器证据后，`evaluateS1CutoverReadiness` 的
  `strictConsumerSourceBound` + `batchParityPass` 等前置才有机会全 true；
- 默认 authority 切换仍必须由人工授权执行，不因本设计自动发生。
