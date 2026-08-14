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

### 终态通用 capture 完整计划 checkpoint（2026-08-14）

- production generated catalog 的 22 个插件均发布 plugin-local
  `capture.materialize`；中央 observation/capture/CLI 只执行 catalog-issued
  能力，已删除中央 exact/execution driver registry 与 per-Family capture
  switch。框架合同只使用 synthetic Family 验证 log 分页与 batch liveness。
- route/credit capture 不再用 `tokenDeals` 伪造执行本金。中央动态枚举
  catalog 的 Funding domain，按通用 planning priority 选择真实 offer；
  Funding plugin 重新签发完整根计划并把 route requirements、route root、
  `assert-balance`、repayment 放进同一 callback closure。revm bridge 执行
  完整 BotVM bytes，观测 executor/owner/全部计划 target 的 token delta、
  total-supply delta 与 logs；revert 作为真实 final-sim 结果记录，不冒充
  success。
- parity 文件入口支持每个 held-out negative 的独立双侧 capture 文件，
  sealed-production 仍逐侧通过 trusted issuer 验证；旧 3:1 cases 拆分尚未
  授权，下一 slice 将由通用 canonical-value mutator 取代。
- 本 checkpoint 的 TypeScript、Rust、generic capture、parity runner 与
  完整 listener build 已通过。它将作为后续同 descriptor 独立双跑的固定
  executable closure；尚未产出节点真实 corpus，F5 仍未关闭。

### 终态 descriptor/corpus harness checkpoint（2026-08-14）

- 旧 `generate-s1-real-descriptor.py` 与
  `run-migration-parity-multi.py` 的 Family/协议 switch 已删除；旧 3:1
  `collect-s1-sealed-production-corpus.sh` 已替换为无协议语义的双闭包
  orchestrator：同一 descriptor 分别由两个 clean、不同 HEAD 的 worktree
  执行同一 generic CLI，再生成逐族 held-out negative 并运行 trusted
  sealed-production judge。两侧相同 commit/closure、工作树 dirty、链上
  source hash 不同或最终 `eligible!=true` 均 fail closed。
- 新 descriptor generator 只遍历 generated catalog 和 durable checkpoint
  inventory；route/credit 的 candidate + current observation 来自 catalog-owned
  incumbent，Funding target 来自 Funding plugin 自有 repayment capability，
  asset inventory 是独立通用地址输入。任一 generated Family 缺 capture 或
  incumbent 时整体拒绝，不以部分成功缩小验收 denominator。
- 新 held-out generator 只遍历 migration capture schema，稳定选择 exercised
  semantic item 并递归变更一个 canonical leaf；没有生产 Family 列表、协议
  字段映射或 per-Family mutation。synthetic 双 Family 合同证明每个输出只
  改目标 Family，其他 Family 字节语义保持不变。
- fixture-era parity/node/enumerator verifier 已从 active regression sweep
  删除；原 JSON 仍在 evidence 目录作为不可执行历史证据。active sweep 改验
  generic capture、descriptor、held-out、当前 parity/authority/cutover 合同。
  新节点 sealed-production evidence 产生后才重新作为 active F5 gate 接入。

### plugin-owned nomination slice（2026-08-14，原子契约变更）

**根因（节点诊断确认）：** 节点上 materializer 首轮输出 11 entries + 9
unresolved。诊断发现 graph 的裸 label（"goldx"/"wsteth"/"univ2"）无法经
`catalogFamilyForLabel` 解析成 familyId（"protocol:goldx"/"univ2-standard"），
因此这些 pool 条目从未进入提名，address-surface 探针也无从执行；这是中央
label 解释的覆盖 bug，不是链上证据缺失。

**方向（用户选定）：** 不做中央 per-family 反推脚本，改为 plugin-owned
nomination 能力，经 generated catalog 自动注册：

1. 契约：`DiscoverySemantics` 新增可选 `nominate?: CaptureNominationSemantics`
   （plugin-local 能力，输入 opaque pool nominations + source + 只读 provider，
   输出真实 `UnifiedObservation[]`）。provider 的 transport/timeout/retry/
   分页与逐项隔离归中央。
2. 中央 executor：`executeCatalogCaptureNominations` 只做三件事——收集 opaque
   pool nomination → 执行 catalog 发布的 nomination 能力 → 用
   `catalog.matches()` + plugin `decodeCandidate()` 准入，fail-closed；
   nomination 产物不能通过 matches+decodeCandidate 时抛错，不吞掉。
3. univ2/univ3/univ4 证明模式：graph pool 条目是 opaque nomination；plugin
   用自己的 ABI 读 token0/token1/factory（V2）、token0/token1/fee/tickSpacing
   （V3）、opaque poolId（V4），以精确 topics 查 factory/PoolManager 日志
   （Bloom 索引直接定位，无全量扫描），返回真实 log（含真实 txHash）；
   identity 阶段仍反向验证（getPair/getPool/poolKey）。
4. address-surface 族（wsteth/psm/goldx/rocksolid/metronome-synth/
   self-burn/erc4626/fluid-credit 等）：共享 `createAddressSurfaceNomination`
   （plugin 声明自己认领的 opaque label + interface fingerprints，codeHash +
   EIP-1967 实读），中央不做 label→family 映射。
5. materializer 改为：已验证 tx 证据优先（verified_candidates 的 receipt/trace）
   → nomination 反推 → address-surface 探针；**删除全量日志回查**
   （`declaredLogObservations` 的 100k-block 分页扫描不再存在）。
6. 框架合同只使用 synthetic catalog（capture-nomination-framework）：graph
   nomination → observation → admit → fail-closed 通用循环；不点名生产
   Family。univ2/3/4 nomination 为 plugin-local 合同（mock provider 正/负例）。

**契约变更影响：** discovery 契约新增可选字段会改变 capability content
hash → generated catalog hash 变化 → 旧节点 enumerator/corpus 证据按设计
fail closed，本 slice 必须与节点证据重生成一起提交（原子 slice）。

**剩余：** 节点上以新 materializer 重跑受限诊断，拿真实 unresolved 清单；
随后补齐其余族的 nomination（如需）并产出真实 descriptor → baseline/
challenger 双闭包 → held-out negatives → sealed-production judge。

### evidence-channel 标配 slice（2026-08-14）

**验收判据（用户决定）：** nominate 成为 route/protocol/credit Family 的必有
能力声明，不允许“缓存里有历史条目所以碰巧通过”充当完成证据。

- `DiscoverySemantics` 新增必选 `evidenceChannel: "nominate" | "tx-evidence"`：
  - `nominate`：plugin 拥有 nomination 能力（`discovery.nominate`），从
    opaque pool nominations 重物化真实观测；
  - `tx-evidence`：族只从真实 observed 交易准入（verified txHash 提名，
    strict 重读 receipt/trace 后 decode）。
- 中央校验（`validateDiscovery`，三个 define* 构造器共用）：
  - 无 evidenceChannel → 定义拒绝；
  - `nominate` 无 nominate 能力 → 拒绝；
  - `tx-evidence` 却声明 nominate → 拒绝（通道二选一）；
  - `tx-evidence` 无 call/log patterns → 拒绝。
  新族漏写接口直接起不来，而不是默默 unresolved。
- 19 个生产族已声明：13 个 `nominate`（univ2/3/4、fluid-dex、silo、
  goldx、rocksolid、metronome-synth、psm、self-burn、wsteth、erc4626、
  credit:fluid），7 个 `tx-evidence`（astra、eigenpie、ethertoken、hgusdc、
  dodo-v2、curve-underlying、angstrom-v4）。
- materializer unresolved 诊断区分：missing nomination capability（既无
  nominate 也无 patterns）/ nomination found nothing / tx evidence found
  nothing，缺口一眼可见。
- **legacy 缓存只能当提名源**（候选地址/txHash 值得 strict 去验证），
  其字段不得直接当完成证据；完成证据由 strict 重派生（source block
  重读 codeHash/EIP-1967、重读 receipt/trace、精确 topic 反推）后写入
  checkpoint/published views/sealed corpus。
- 深缺口（dodo/curve/angstrom/eigenpie）与 hgusdc（行为型身份）留待
  架构完成后回溯；接线缺口（fluid-dex/self-burn/silo/credit:fluid）已
  在本 slice 内补完。

### 近期交易反推 slice（2026-08-14，节点基础设施约束适配）

**节点事实（实测）：** reth 是 pruned 节点——state 只保留最近 ~75K 块
（`state at block #X is pruned`），logs 单次查询上限 100K 块范围且更早
日志 pruned（`pruned history unavailable`）。因此：

- 历史 PairCreated/PoolCreated 创建日志反推在本节点不可用；
- 反推改为 **pool/factory 在近期保留窗口内的真实交易日志**：univ2/3
  查 pool 自身 emitter 的近期 Swap 日志（address=pool + topics[Swap]），
  univ4 查 PoolManager 近期 `[Swap, poolId]`（topics 精确定位）；
  返回真实 log（含真实 txHash），identity 阶段仍做链上反向绑定。
- nomination 不再读 token0/token1/factory（不需要，Swap emitter 即 pool），
  RPC 量从每 pool 4 次降到 1 次 getLogs（近窗口）。
- source block 必须落在 reth 保留窗口内（head 附近），state/logs 才可读。

**该方案与用户指示一致：** “不要反推第一个 factory，去推这个 factory
在近 1 万块的交易”——用近期真实交易证明实例存在，而不是历史创建事件。
