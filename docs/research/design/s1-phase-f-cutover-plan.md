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

- 7 个活动型族（astra/eigenpie/erc4626-silo/ethertoken/hgusdc/
  curve-underlying/dodo-v2）的 factory-log/landed-log/observed-call
  ingress → UnifiedObservation → `runStrictFamilyLifecycle`。当前 live
  feed 只消费 protocol cache 的 verified_candidates + address_entries；
  剩余为把三类 log/call 观测源接入 feed（Phase E plan Pair C 对应面）。

### F3 continuous 调度 lane

- strict publication 链的 producer reserve/deadline/去重/backlog：
  串行 + coalesce 已落地，剩余为 central scheduler 的 producer lane
  （reserve、per-producer deadline、dedupe、backlog 上界）接入 live 链，
  并把崩溃/超时恢复统一到 F4 合同。

### F4 22-Family 崩溃恢复契约扩展

- 从 durable checkpoint + 上一 catalogRoot 重启恢复的合同扩展：当前
  catalogRoot 是内存态（runtime handle 不可序列化），重启后由下一次发布
  重建（observed-complete 无 omission authority，安全但需成文契约）。
  扩展合同覆盖 22 族恢复语义：重启不得丢 authority、不得静默缺实例、
  恢复窗口内不伪造 publication。

### F5 sealed-production corpus

- 真实 on-chain production corpus + 非空 held-out negatives，使
  sealed-production acceptance 从 `unit-contract`（19/22 fixture）升级为
  可验证的生产验收。需真实案例采集（另行立项采集脚本/来源）。

### F6 legacy 删除逐项确认

- Phase E Pairs：A 剩余 quote/approve legacy 分支；B identity resolvers；
  C landed-event 消费；D universe deploy trust；F facade/手工 revision/
  schema/cache bridge/旧 flag。每 pair 顺序：strict 替换合同绿 →
  call-site 切换 → 验证 → 删除 legacy（合同绿），任一失败回退该 pair。
  终态验收 = canonical §18.3 / §20.2.6 全门。

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
