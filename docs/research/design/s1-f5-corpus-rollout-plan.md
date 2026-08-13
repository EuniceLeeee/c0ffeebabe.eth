# S1 F5-b real corpus rollout plan（守护窗口自动续跑契约）

> 目标：把 22 族的 sealed-production corpus 从 fixture 升级为真实链上采集。
> 本文件是自动化续跑的唯一事实来源：每轮守护恢复后先读本文件，从未完成项
> 继续，直到 `DONE`。用户无需每轮回复。P0-6 fail-closed 门不动。

> **终态合同覆盖（2026-08-13）：** 本文早期逐族 capture 函数、
> `GenericCaptureDriver` 注册表、capture-name alias、descriptor 字段映射和
> 3:1 train/held-out 记录仅是历史 checkpoint，不再授权终态实现。终态以
> canonical §0.1 为准：中央只有一个 catalog-issued generic capture 入口；
> observation/exact/execution/final-sim/capture materialization 均由 plugin
> closure 声明；框架测试只使用 synthetic/dynamic catalog；AST + transitive
> import-closure gate 必须通过。

## 模板契约（univ2，第一族）

1. 新建 `captureUniv2OnchainCase(input: {source, provider, pool, tokenA?,
   tokenB?, reserves?, caseId?})`，在 `source.number` block tag 上：
   - `pair.factory()` / `pair.token0()` / `pair.token1()` /
     `pair.getReserves()` 实读；
   - 描述符与链上值不一致（含 RPC 失败/空结果）一律 fail-closed 抛错；
   - 身份用链上 factory/token 派生，禁止硬编码 factory。
2. 证据 ref 改为 `onchain:1:<source.hash>:univ2:<pool>`（可对链上数据复核）。
3. 本地合同测试：mock provider 正例 + RPC 失败拒绝 + token/factory 不一致
   拒绝 + evidenceRefs 前缀断言。
4. 节点 dry-run 复验（SSM 只读 + impl-capture worktree，dry-run）。
5. 验收：build + shadow suite + 12 组 sweep 全绿，checkpoint 同轮 commit+push。

## 通用采集路径（2026-08-13 用户选定，替代逐族工具链扩展）

新增 `generic-family-capture.ts`：`captureFamilyGenerically` 输入
`{catalog, familyId, source, observation, runtime}` → 通用 strict
lifecycle → publication 派生 stages（instances/edges/prices/
enumeratedRoutes/failures 全通用；exact/execution/finalSim 在 per-plugin
driver 接入前诚实 `framework-blocked`，不伪造）。该段描述的是历史过渡
实现；终态不得保留中央 per-family driver registry。合同测试曾以具体族
fixture runtime 验证过渡行为；终态框架测试须改为 synthetic catalog；
build/shadow suite（38）/12 组 sweep 全绿。剩余：由 discovery 声明
派生 observation 的通用函数、CLI 通用模式、exact/execution per-plugin
driver 注册表（新族 = 插件自带模块，不再改工具链逻辑）。

**通用路径推进 2（2026-08-13）：** `deriveFamilyObservationFromNodeData`
按插件 discovery 声明派生 observation（callPatterns→call、logPatterns→
log、addressSurfaces→codeHash+EIP-1967 实读）；`GenericCaptureDriver`
注册表 + `registerGenericCaptureDriver`/`resolveGenericCaptureDriver`（历史
迁移桥，现列入删除目标），
`captureFamilyGenerically` 在 driver 注册时真实执行 exact/execution/
finalSim，否则诚实 framework-blocked。合同测试：无 driver blocked +
有 driver exercised。build/shadow suite（38）/12 组 sweep 全绿。
剩余：CLI `--generic` 模式（descriptor 只带 family+address，走
derive+capture 通用路径 + strict runtime/revm）与 univ2 真实 driver。

**通用路径推进 3（2026-08-13）：** CLI `--generic` 模式已接线
（descriptor 只带 family+address，strict runtime + revm 经
`S1_REVM_SIM_BIN`；逐族容错，失败记录并继续）；generator 输出通用
`{family,address}`；corpus 脚本走 `--generic`。节点首次 generic 运行
暴露 univ4：通用 log 派生需要 emitter（V4 PoolManager 单例）与
Initialize log data（pool key 从 manager 链上读再编码）。
**经验约束（重要）：** 插件契约变更（即使加可选字段）会改 capability
manifest 哈希，使已提交节点证据失效（verifier 按设计 fail）——因此
“LogPattern 加 emitter 声明 + univ4 插件声明 + 节点证据重生成”必须
作为一个完整 slice 一起落地，不能半切。当前保持绿（emitter 未入插件，
generic 派生用 descriptor 可选 emitter 兜底）是推进 3 的历史停点；
推进 4 以下用原子 slice 取代该兜底。

**通用路径推进 4（2026-08-13）：** 已删除 descriptor emitter 兜底；
`LogPattern` 新增通用 emitter 声明（address / singleton-indexed-address /
singleton-indexed-bytes32，含 `topicIndex + fromBlock`），univ4 Family
plugin 自有 discovery 声明 PoolManager 单例。descriptor 仍严格只有
`{family,address}`，其中 V4 的 address 是真实 poolId；中央通用派生按
声明构造 indexed-topic 查询，从节点回读真实 Initialize log 的完整
topics/data，再交 strict lifecycle 解码 PoolKey。无日志、identity 非
32-byte、外部 emitter 或链上状态不一致均 fail closed；中央无
`if (univ4)`/协议地址分支。plugin 合同测试、generic capture、generated
capability manifest、完整 build 与 49 项 shadow suite 已通过。由于
capability artifact hash 变化，本 slice 必须与节点 enumerator/corpus
证据重生成一起提交，旧证据不能沿用。

**中央 batch liveness 补门（2026-08-13）：** 旧合同以单 Family capture
为主，只证明同步异常后的 `catch + continue`，没有证明 RPC 永久 pending
时 batch 仍能前进。generic 中央调度现以统一 work-item deadline 运行全部
plugin：每项独立 RPC provider/transport timeout，deadline 触发时主动
destroy provider，再记录该项失败并调度下一项；无 familyId/protocol
分支。合同覆盖“第一项永久 pending → cancel/失败；第二项仍完成并进入
batch 输出”，防止单 Family 测试误代替中央批量 liveness。

节点 enumerator 已在独立 `/opt/MEV-impl-capture`（production runtime
未改）对 `cc30bca1` 重跑：SSM
`4b4bbed5-2fee-4286-8568-038f9bf39684`，catalogHash
`4fc46b372088cc76bde079dc27031e24e9ca46b153e9dffdaffa5ef3cc87daa8`，
familyCount 20，writer committed/revision 2；本地 verifier PASS。旧 hash
的两份 enumerator 记录移入 `evidence/archive/` 仅作历史记录，不再被
当前 sweep 当成可复用证据。

节点真实 generic 首轮（SSM `cb289806-7ee4-459c-8710-8a71541e25d4`）
在 block `25745269` 由 immutable universe + protocol cache 生成 8 个真实
descriptor，无伪造地址；诚实暴露三类缺口：univ4 Initialize 回查从
PoolManager 部署块到 source 跨 `4,056,940` blocks，reth 单请求上限
100,000；astra/silo strict lifecycle 尚未发布；旧 corpus harness 仍错误
把 held-out 当 cases 切分并在 side JSON 内寻找 provenance。通用 log scanner
现倒序按 100,000-block page 查询，找到声明匹配日志即停；这是 cold/F5
回查，continuous 生产路径使用持久 cursor 后只增量扫描。合同覆盖第一页
为空、第二页命中，不含 univ4/familyId 分支。

## 滚动清单（按序，模板先 erc4626 再其余）

| # | 族 | capture 函数 | 状态 |
|---|---|---|---|
| 1 | univ2 | captureUniv2OnchainCase | completed |
| 2 | erc4626 | captureErc4626OnchainCase | completed |
| 3 | erc4626-silo | captureErc4626SiloOnchainCase | completed |
| 4 | astra | captureAstraOnchainCase | completed |
| 5 | eigenpie | captureEigenpieOnchainCase | completed |
| 6 | ethertoken | captureEtherTokenOnchainCase | completed |
| 7 | metronome-hgusdc | captureMetronomeHgUsdcOnchainCase | completed |
| 8 | curve-underlying | captureCurveUnderlyingOnchainCase | completed |
| 9 | dodo-v2 | captureDodoV2OnchainCase | completed |
| 10 | fluid-dex | captureFluidDexOnchainCase | completed |
| 11 | fluid-credit | captureFluidCreditOnchainCase | completed |
| 12 | psm | capturePsmOnchainCase | completed |
| 13 | wsteth | captureWstethOnchainCase | completed |
| 14 | goldx | captureGoldxOnchainCase | completed |
| 15 | rocksolid | captureRocksolidOnchainCase | completed |
| 16 | metronome-synth | captureMetronomeSynthOnchainCase | completed |
| 17 | self-burn | captureSelfBurnOnchainCase | completed |
| 18 | angstrom-v4 | captureAngstromV4OnchainCase | completed |
| 19 | univ3 | captureUniv3OnchainCase | completed |
| 20 | univ4 | captureUniv4OnchainCase | completed |
| 21 | funding | captureFundingOnchainCase | completed |
| 22 | curve | n/a — 与 curve-underlying（row 8）同一族，captureCurveUnderlyingOnchainCase 已 completed | completed |

## 每族完成判据（全部满足才把状态改为 completed 并 commit+push）

- 真实链上身份派生 + 描述符一致性 fail-closed；
- `onchain:` 证据 ref，无 `fixture:`；
- 本地合同测试（mock provider 正/负例）；
- 节点 dry-run 复验有机器证据（JSON 落在
  `docs/research/design/evidence/`）；
- build + shadow suite + 12 组 sweep 全绿。

## 终态

- 22 族全 completed 后（当前 21 族 + curve 同族已 completed）：
  **held-out 契约修正（2026-08-13 代码核对）**：
  `ArchitectureMigrationHeldOutNegativeInput` 是“故意不匹配的
  baseline/challenger 对”，必须判 `semantic-mismatch`——不是真实 cases
  的切分。因此采集分两步：
  1. 真实 baseline/challenger：节点上从 catalog-owned inventory 与真实
     strict publication 生成同输入 descriptor；两侧必须由两个独立、固定
     commit 的可执行闭包各自采集，均携带可复核 `onchain:` 证据。禁止复制
     side 后改 commit/captureId 冒充独立闭包。
  2. held-out negatives：动态遍历实际 capture 的 Family cases，由中央
     通用 canonical-value mutator 确定性篡改一个已 exercised 的语义项；
     不得按族交换字段或维护逐族 negative 清单。每对必须由同一 judge 输出
     `semantic-mismatch`；identical/不可变 negative 必须 fail closed。
  3. sealed-production acceptance 判定：
     `evidenceClass=sealed-production` + 非空 heldOutNegatives +
     aggregate pass + 负例全 mismatch → `eligible`；F5 关闭后再进 F6。
- 节点执行步骤（待运行）：impl-capture 已到 `26888125` 且 build OK；
  下一步生成真实 descriptor → 跑 baseline + 负例 → parity judge →
  写 evidence JSON 到 `docs/research/design/evidence/`。

### F5 最终关闭判据

- descriptor generator 只从 catalog ownership/inventory 生成通用
  `{familyId, candidateIdentity, opaqueBinding?}`，无协议名或字段映射；
- capture CLI 只有 catalog-issued generic 路径，fixture/onchain per-family
  switch、capture-name alias 和中央 driver map 已删除；
- 所有 active production Family 都有真实 identity/state/exact/execution/
  final-sim 证据；无 `fixture:` 冒充；
- 独立 baseline/challenger 主对 aggregate pass；实际捕获的每族至少一个
  非空 held-out negative 且全部 `semantic-mismatch`；
- `evidenceClass=sealed-production` 且 acceptance `eligible=true`；
- 中央零单族 AST/import-closure gate、完整 build、shadow suite、sweep 与
  节点复核均通过。此前表格的 `completed` 只表示旧逐族合同，不足以关闭
  F5。
