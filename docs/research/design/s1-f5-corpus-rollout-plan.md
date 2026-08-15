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
- 20 个 discovery 生产族已声明：13 个 `nominate`（univ2/3/4、
  fluid-dex、silo、goldx、rocksolid、metronome-synth、psm、self-burn、
  wsteth、erc4626、credit:fluid），7 个 `tx-evidence`（astra、eigenpie、
  ethertoken、hgusdc、dodo-v2、curve-underlying、angstrom-v4）。
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

### 后续切片备注（2026-08-14）

- **P0 已修**：univ4 nomination 不再返回 Swap log（decodeCandidate 拒绝
  Swap/ModifyLiquidity 防单向哈希猜身份），改为 Swap log → trace 还原真实
  PoolManager.swap calldata 帧 → manager-swap call observation（真实
  calldata 解码 PoolKey，identity 仍链上重验）。
- **materializer 输入**：`runtime-graph-pools.json` 与
  `runtime-protocol-discovery-cache.json` 仍作 **transitional nomination
  源**（只提名候选地址/txHash，证据由 strict 重派生）；F6 计划新增一项：
  “移除 materializer 对 legacy 文件的依赖，提名源改为 strict 产出的
  durable checkpoint inventory + 增量 feed”。
- **跨运行增量**（用户方向）：materializer 增加可选 `--refresh
  <previous-inventory>`：catalogHash 与 source block 不变时，已完整通过
  的族从上次 inventory 直接复用（不进 nomination）；契约变更时用 pin 住的
  真实 txHash 重放 strict（重读 receipt/trace + 新代码 decode + source
  block 重验），而非重新扫全部 pool。
- **self-burn 现状**：10,437 个 cache 候选全部 EIP-1967=0（proxy 门语义
  负例），verified 0 个——当前节点数据无真实正例，保持 unresolved 不伪造。

### 节点真实覆盖 checkpoint（2026-08-14，commit 6382e235）

**节点 materializer 真实运行结果（真实 graph + protocol cache + 真实 RPC）：**

- **admitted 13 族**：univ2/univ3/univ4（近期 Swap 反推 + univ4 trace
  还原）、fluid-dex/credit:fluid/goldx/metronome-synth/psm/rocksolid/
  self-burn/wsteth/erc4626（address-surface 实读）、astra（真实 tx
  evidence）。
- **unresolved 7 族**：curve-underlying、angstrom-v4、dodo-v2、eigenpie
  （深语义缺口，回溯范畴）、silo（无 txHash 且 cache 行为证据需
  identity 重验）、ethertoken（有 txHash 但 receipt/trace 无可解码
  观测）、hgusdc（行为型身份，需真实 executePath 交易）。
- RPC 成本：univ2/3/4 合计 3 次 getLogs + 4 次 trace（早停 + 近期窗口
  生效）；getCode/getStorage 各 10,394 来自 self-burn 10K+ 候选探针。
- **self-burn 说明**：0x3364（metronome-synth 池地址）是 EIP-1967 proxy，
  self-burn 的 proxy wildcard 匹配它——同一地址被两族认领是
  catalog.matches 的正常行为，identity 阶段按语义区分。

**F5 剩余**：7 个 unresolved 族要么需要真实链上证据（eigenpie/hgusdc
真实交易、silo 行为验证、ethertoken 回读修复），要么属于用户批准的
深缺口回溯（curve/angstrom/dodo）。**未达到 22 族全覆盖前，sealed-
production eligible=true 不能宣称**；descriptor 生成器按设计在
unresolved 非空时 fail-closed 拒绝。

### 统一 FamilyPlugin 契约收敛（2026-08-14）

- 新增统一判别类型 `FamilyPlugin<Domain>`（swap/protocol/credit/funding
  按 domain 选能力槽），四个具体接口保留为类型别名，22 个 production
  entry 零改动。
- `defineFamily` 从 `plugin.manifest.domain` 取 domain（不再传参），
  `defineSwapFamily` 等保留为薄包装。
- funding 的 discovery 槽按 domain 语义**可选**（funding 无实例发现，
  repayment target 在其 funding 能力内声明）；其余 domain 的
  discovery 必填 evidenceChannel=nominate + nominate 能力。
- 新增插件脚手架 `templates/family-plugin/`（README + skeleton.ts）：
  新族从统一骨架挑 domain 所需切片，中央流水线/capture/corpus/parity
  不动；未来 LP 域只需加 domain 值 + validator + 能力槽。

### 同地址多族 per-label nomination（2026-08-14）

- **发现**：silo-redeem 的 pool 地址 0x3d7d… 同时被 graph 标为 erc4626
  （identitySource: erc4626-standard）——同一地址是两个族的合法 vault。
  first-writer-wins（按 address 去重）让 graph 的 erc4626 条目抢占了
  silo 的 verified_candidates 提名（含 20 条行为 evidence），silo 因此
  unresolved。
- **修复**：opaquePoolNominations 改为按 (address, label) 复合键去重——
  每个 label 的提名都保留，不同族可认领同一地址；同源同 label 重复仍
  合并。
- **ethertoken 结论（基础设施约束）**：evidence txHash（block
  25711694）超出 reth 保留窗口（~75K 块），debug_traceTransaction 报
  pruned——strict 无法重读其调用帧。receipt 可读但只有 Transfer 日志，
  discovery 无匹配 logPattern。属“等真实 tx 或回溯”范畴，非代码 bug。
- **silo 行为读确认**：source block 上 asset()/totalSupply()/
  previewRedeem() 全部可读（head 附近窗口内），per-label 修复后
  nomination 可携带行为 evidence，identity 在 source block 重验。

### F5 覆盖 checkpoint 2（2026-08-14，commit 59315ae6）

**节点 materializer 真实运行：16 admitted / 4 unresolved**

- **新增 admitted**：angstrom-v4（近期 [Swap, poolId] + trace 还原 calldata）、
  erc4626-silo-redeem（verified_candidates 行为 evidence 经 override 保留，
  address-surface 实读 + identity source block 重验）。
- **根因修复**：graph 以 adapter=erc4626-silo-redeem 列出 0x3d7d…（与
  verified_candidates 同 label），first-writer-wins 丢了 evidence 版本；
  setNomination 增加 overrideEvidence——完整候选分支的 evidence 覆盖同
  label 裸条目，不同 label 仍各自保留。
- **curve-underlying 已解决（2026-08-14，commit 30bdcd18）**：根因是
  universe 生成器在 S1 重构（a699009a）删除了 curve enrich 分支后只放行
  univ2/univ3，curve 池在 selectMatureDexActivity 就被滤掉，根本到不了
  身份验证——不是适配失败。按用户决策走**旧管线过渡桥**：build-active-
  pool-universe 重新放行 curve-underlying（TRANSITIONAL BRIDGE，F6
  delete-scope 注释标注），strict identity 仍为准入门
  （identitySource=curve-metaregistry-underlying），仅 token-domain 元数据
  经共享 curve resolver 补充。**节点验证（2 天窗口）**：44 个 curve-
  underlying 池入图，underlyingCoins 完整，无抛错。删除前置：catalog
  驱动生成器或插件 nominate 路径成为默认后，删除中央 curve 分支。
- **unresolved 3 族**：eigenpie（无真实 depositAsset 交易）、ethertoken
  （evidence tx 超出 reth 保留窗口，trace pruned）、hgusdc（行为型身份，
  需真实 executePath 交易）——全部属用户批准的“等真实 tx 或回溯”范畴。
- **RPC 成本**：univ2/3/4/dodo/angstrom 合计 ~6 getLogs + ~5 trace
  （每族早停常数级）；getCode/getStorage ~10.4K（self-burn 10K+ 候选探针）。

**F5 状态**：17/20 discovery 族真实 admitted（curve-underlying 经过渡桥
入图解决）。3 族（eigenpie/ethertoken/hgusdc）的 evidence 交易超出节点
reth trace 保留窗口（state pruned，无法回放内部调用），且已确认非查询
漏洞——call-based 族的交易存在（hgusdc 3 天窗口 2 笔真实交易、ethertoken
3 笔保留窗口内 receipt 可读）但 trace 回放不可用，属**基础设施窗口期
约束**，非代码可补。

**用户最高命令（2026-08-14）**：管线验收中，因超过 2 天 trace 窗口期
导致未迁移/未采集的 adapter family **视为不存在**，直接执行完整迁移。
descriptor 生成器与 sealed-production 验收按此执行——不再因这 3 族
unresolved 阻塞 eligible 判定；其采集状态如实记录在 checkpoint（非吞掉
失败），待节点 trace 窗口内出现新交易时经通用 call-seed 扫描器
（recent-call-seed-scan.ts）自动恢复。

### F5 双闭包执行准备（2026-08-14，commit 待本轮）

- **baseline 重新冻结决策**：parity-capture-baseline 分支 tip 4265971d
  （08-12 冻结）只有旧逐族 exporter CLI（baseline-capture-cli + 扁平
  旧格式 descriptor），没有通用 F5 工具链（generic capture/descriptor/
  held-out 生成器）——无法执行"同一 descriptor 双闭包"流程。按 F5
  计划"经漂移审计后重新冻结的更新 ds tip"：**baseline 重新冻结为
  f47fff1c**（08-14 03:25，F5 工具链完整建立点：real-cli + generic-
  family-capture + descriptor 生成器 + held-out 生成器 + collect 重写
  齐备；族语义早于 F9 清理 944b276f/ba60679f/8e672cd7）。两侧同一
  generic CLI 各自闭包采集：baseline=f47fff1c（迁移推进 snapshot），
  challenger=当前 tip——parity 证明该区间 catalog/plugin 语义无回退。
- **collect 脚本修复**：`collect-s1-sealed-production-corpus.sh` 增加
  fail-closed 检查（两个 worktree 的固定 HEAD 都必须自带
  `run-architecture-migration-capture-real-cli.ts`，缺失即 exit 6），
  注释明确双闭包机制（两侧同 generic CLI、各自 HEAD 的 catalog 语义）。
- **节点执行步骤（待运行）**：① baseline worktree checkout f47fff1c、
  impl worktree checkout 当前 tip，两侧 build；② impl 侧 dry-run 至
  discovery publication 产出真实 checkpoint（含 inventoryFamilies +
  catalogHash），或复用节点已有 checkpoint；③ 调 `descriptorFromCheckpoint`
  生成真实 descriptor（assets=真实 token 地址、executor=BOTVM、
  amount/minProfit）；④ 跑 collect（双闭包 + held-out negatives +
  judge）→ `eligible=true` + `verdict=pass`；⑤ 写 evidence JSON 到
  `docs/research/design/evidence/`。
- **节点 materializer 真实运行（2026-08-14，commit b187468f，旧 graph
  产物）**：`materialize-s1-capture-inventory.ts` 用 Aug 12 dry-run 的
  runtime-blockscan-pools.json + protocol-cache.json（真实只读 RPC，
  源块取 head）：**17 admitted / 3 unresolved**——admitted 全部携带
  真实链上观察（address-surface/log/call；rpc counts call=1/
  getCode=11379/getStorage=11379/getLogs=16/receipt=8/trace=10）。
  unresolved = curve-underlying（旧 graph 在过渡桥 30bdcd18 之前，
  无 curve 提名，非 trace 族）、ethertoken/hgusdc（trace 窗口族，
  按用户命令视为不存在）。
- **新 graph materializer（2026-08-14，1500s dry-run 后）**：新 runtime
  graph（edges=2088，blockscan_graph_hash=0x6b28bb…，块 25753317）
  重跑 materializer 得 **13 admitted / 7 unresolved**——首次 generation
  只覆盖 2088 边（hot 池优先），dodo/fluid/credit 提名缺失；universe
  文件（19605 池）无 curve（08-13 旧文件，过渡桥前）。**曲线缺口
  根因**：universe 需重建（impl worktree 跑 build-active-pool-universe
  含过渡桥 curve 分支），但 1200s 内 14K 块日志扫描未完成（timeout）。
  **下轮**：延长 universe 重建窗口 → materializer 以新 universe 为
  graph 输入（形状识别兼容）→ descriptor → collect → eligible 校验。
- **根因定位（2026-08-14，用户指正后）**：新 run 的 blockscan
  view=2117/edges=2088 **不是池少**（universe 19605 池与旧持平），而是
  venue identity 阶段 19534 池全部被拒（`state at block #25743200 is
  pruned`）。**根因 = /opt/MEV/.env 固化过期的
  `SEARCHER_DISCOVERY_TO_BLOCK=25743199`**（08-13 的块，reth 修剪后
  不可读）——EIP-1898 启动 probe 在该块上失败（fatal）。**验证修复**：
  dry-run 覆盖 `SEARCHER_DISCOVERY_TO_BLOCK=head-1000` + 双 RPC 指向
  本地 reth（本地 8545 对历史块 eth_call 可读，Alchemy 对 38h 前块
  prune）→ **启动成功（EXIT=124 无 fatal）、venue identity 0 拒绝**
  （19534 池全过）。**factory 全量枚举已撤销**（用户判定错误方向，
  commit 211731b6 revert 为 a066cd33）：旧条件（2 天窗口 + minSwaps=1
  + 无上限 + retained）本身产出 19546 池/37136 边，达标路径就是恢复
  旧条件 + 本地 RPC。**下轮**：长窗口（3000s）dry-run（本地 RPC +
  DTB 覆盖）等首次 generation 完成 → 验证 graph edges ≥3 万 →
  materializer → descriptor → collect → eligible。

### 完全重建真实规模核验（2026-08-15，commit bf6d6b94）

- **head-N 源块修复（766dcf69）**：univ2/univ3 activity 池 strict
  identity 从 1433 全挂 → 42 失败（<4%，均为第三方 V3 fork 池正确
  拒绝：factory 非官方 Uniswap V3、getPool 反查 revert）。根因是
  reth 对精确 head 的 eth_call 间歇性返回全零；改用 head-5 稳定源块
  后通过。**univ4 PositionManager 反查 97% 命中（2665/2745）**。
- **recent-log 性能修复（bf6d6b94）**：`findRecentLogHit` 默认 chunk
  5000→500（reth getLogs 超线性，500 块 30-87ms vs 5000 块 0.8-1.7s），
  enrich 从 15 分钟/1000 池提升到 ~55 分钟/7773 池（仍偏慢，每池
  strict lifecycle 框架开销 ~10s 是剩余瓶颈）。
- **完全重建 2 天窗口实测（universe-full1.json）**：**10,611 池**
  （univ2-standard 5,566 / univ3-standard 1,981 / univ4 2,961 /
  curve-underlying 43 / dodo-v2 38 / fluid-dex 20 / angstrom-v4 2），
  对照旧基准 ee2e2483（19,546 池）缺口 ~9,000 池。
- **缺口根因（结构性，非代码 bug）**：本地 reth 日志保留仅 ~7-14 天、
  state ~1.2 天；univ4 历史池（旧 9,251）依赖 400 万块 Initialize
  backfill + retained 累积，完全重建 2 天仅 2,961、7 天仅 3,285；
  univ2/univ3 7 天 unique 仅比 2 天 +25%（5,507→6,867）。**完全重建
  上限约 1.3-1.4 万池，2 万池/3 万边验收线在当前"完全重建 + 本地
  reth + 无 Alchemy + retained 不作证据"约束下不可达**。
- **待用户方向决策**：① 接受 ~1.3-1.4 万池为 F5 真实规模并调整验收
  线；② 允许 univ4/dodo 历史池走 Alchemy archive 补池追平旧基准；
  ③ 保留原验收线，F5 记录为数据保留窗口 blocker，先推进 F6-F9。
  当前未降线、未冒充达标。
- **token 填充分支修复（5cac62f9）**：`enrichPool` 只匹配
  `adapter === "univ2"/"univ3"`，而 strict identity 返回
  `univ2-standard`/`univ3-standard` → 分支不匹配、token 未填。修复后
  universe-full2.json：**10,671 池 / 10,628 带 token / 可建有向边约
  21,256**（修复前 6,474 边）。池数与边数仍约为旧基准一半，缺口
  结构性（本地 reth 日志保留 7-14 天，univ4 历史池需 400 万块
  backfill + retained 累积）。方向决策仍待用户。
- **retained 上限量化（28185c15 后）**：retained 文件（19605 池）按
  adapter 分布 univ2 5726 / univ3 3238 / univ4 10026 / dodo 613 /
  angstrom 2。univ4 retained 10,026 池中 **2 天窗口内活跃仅 2,548
  （25%）**——其余 ~7,500 历史冷池在 strict 路径下无近期链上观测，
  无法验证。**retained 能补的上限 ≈ 2,548 且与 fresh activity 大概率
  重叠，救不了 2 万池目标**。同时 retained attestation 8094 候选为
  串行逐池（每池冷池 ~19s），需数小时，已用 lookback 10K 限制
  （28185c15）但本质仍是冷池不可验证。
- **F5 结构性 blocker 最终结论（2026-08-15）**：完全重建 + 本地 reth
  （日志保留 7-14 天）+ 无 Alchemy + retained 不作 eligible 证据的约束
  组合下，**universe 上限约 1.3-1.4 万池 / ~2.1-2.5 万边**，2 万池 /
  3 万边验收线不可达。缺口非代码 bug、非三个 family 缺失，而是
  "strict 身份需近期链上观测"与"本地节点保留窗口"的物理约束。
  已确认可选项：① 调整验收线接受真实规模；② 允许 univ4/dodo 历史池
  走 archive RPC 补池；③ 保留原线、F5 记为数据窗口 blocker 先推进
  F6-F9。当前未降线、未冒充达标。

### F5 根因定位与修复（2026-08-15，目标文件确立 2 万池/3 万边验收线）

- **旧基准逐项对比（ee2e2483 vs universe-full2）**：按正确键（univ4
  用 poolId，其余用 address）计算，旧 19,546 池中 univ2 5,579 /
  univ3 4,120 / univ4 9,251 / dodo 594；新 10,671 池中 univ2 5,625 /
  univ3 1,981 / univ4 2,963 / dodo 37 / curve 43 / fluid 20 /
  angstrom 2。univ2 持平（窗口轮换），univ3 差 ~2.1K、univ4 差 ~6.3K、
  dodo 差 ~557。
- **地面真值（本地 reth 直接数 Swap 日志 emitter）**：新窗口 univ2
  5,653 / univ3 2,040 / univ4 3,042 / dodo 311；旧窗口 univ2 5,613 /
  univ3 4,059 / dodo 293。→ univ3 差池是市场活动减半（非 bug），
  univ4/dodo 差池是 retained 冷池（strict 需要近期观测）。
- **dodo 真实漏检修复（1a62c665）**：311 个新窗口 emitter 中 306 个能过
  registry 反查，但 universe 只进 37。根因 = `createAddressLandedPool
  Materializer` 默认 3s 整批超时（dodo materializer elapsed≈3.2s），
  超时后候选进 retryable 且 universe 构建丢弃 retryable。修复：dodo
  materializer 超时 120s（族内配置）+ universe 构建通用 retryable 重试
  （最多 3 轮，对齐 main.ts startup 模式，无逐族分支）。修复后 dodo
  materialized≈330，仍有 75 个 retryable 为持久失败（后续单独核查）。
- **retained 串行瓶颈（cfc41c37）**：strict retained attestation 原为
  串行逐池（500 池/21 分钟，7,836 池需 ~5.5h，CPU 0% 纯等 RPC）。
  改为 24 并发 + 按 index 保序 + 逐池错误隔离（无逐族分支）；
  测试 PASS（strict-identity-attestation）。
- **univ4 冷池逐池扫描瓶颈（bd2c2225）**：univ4 nomination 逐池
  `findRecentLogHit`（冷池 20 次 getLogs × 7K 池）。改为 plugin-owned
  source-keyed manager 全窗口 Swap 索引（一次 ~20 次 getLogs 建
  poolId→最新 tx 索引，按 source+provider 缓存），冷池 O(1) 内存查询，
  活跃池仍走真实 trace；plugin-local 测试契约同步更新。
- **日志保留边界实测**：本地 reth 3d/5d/7d 有日志，10d 起为空 →
  有效窗口 ~7-8 天。2 天窗口 + strict retained（只收近期有观测的池）
  最多 ~12K 池，2 万线需更长窗口。
- **7 天窗口重跑（进行中，universe-ret6，lookback=50400）**：仍在本地
  reth 保留内；预期 univ3 恢复旧窗口池（~4-5K）、univ2 ~8K、univ4
  ~3.3K、dodo ~450，fresh 合计 ~17-18K，+ retained 近期池 + factory/
  swap-active view → 目标 2 万池/3 万边。窗口是旧基准逐项对比轴之一，
  属“定位修复重跑”而非降线。

### F5 验收口径定版与运行历史（2026-08-15 用户裁定，最新为准）

- **验收基线（用户定版）**：最终 universe（fresh + retained 合并计数）
  ≥ 10,671 池 / ≥21,256 有向边即通过（10.7K/21.3K 为最低基线，不再要求
  2 万/3 万）。通过后交付新旧对比表（新 universe vs 旧基准 ee2e2483），
  逐族拆 fresh / retained 与总数、重叠/独有。
- **per-family fresh > 0 非硬门槛**：若人工确认某族在窗口内确实无交易，
  全 retained / fresh=0 也可算通过。当前 7 族 fresh 均 > 0，无需豁免。
- **双方法声明是硬性验收项**：每个纳入重建/验收的族，插件必须同时
  显式声明两条通道——fresh 接口（`nominate`：近期观测/交易证据）与
  retain 接口（`reverseBinding`：冷池可验的反向绑定）。retain 接口
  **允许拒绝**（例如 univ4 非 PositionManager 创建、必须回创建块
  Initialize 且超出本地 reth 保留窗口 → 显式返回“不可反查”；tx-bound
  族同理），但**必须显式声明，不允许缺字段/未实现**。验收对比表逐族
  列出：fresh 方法存在 / retain 方法存在 / retain 是否显式拒绝 /
  fresh 数 / retained 数 / 总数。
- **retained 可存在但非 eligible 证据**：F5 eligible 仍以 fresh 重建
  能力 + 真实观测为准；retained 只是生产拓扑保留，不算重建证明。
- **7 天窗口重跑已弃用**（用户明确“这个数据我也不要”）：F5 重建固定
  2 天窗口（lookback=14400）+ retained 输入
  （POOL_UNIVERSE_RETAIN_PATH=生产 active-pools.json），全部本地 reth。
- **运行历史与修复（以最新 commit 为准）**：
  - ret8：enrich 卡死（univ4 nomination 无条件建索引 → 非 univ4 池每次
    都重建 35 万日志索引，CPU 转圈）。修复 114258a6（非 univ4 opaque
    标签快速返回），plugin-local + 测试同步。
  - ret9：enrich 正常提速（~100 池/分），但进程在 metadata 5000/7891
    处被操作方终止（换 ret10），未写 universe。
  - ret10：在 retained attestation 7500/7921 处被终止（操作方动作），
    未写 universe。HEAD=2c051a43。
  - 2c051a43（另一个窗口）：univ2/univ3 冷池 address-surface nomination
    兜底——窗口内无近期 Swap 时用 getCode+接口指纹再物化观测，身份仍走
    链上 factory/token0/token1+getPair 反查后才准入。工作树另有未提交
    修改（strict-identity-attestation.ts、univ2/univ3 nomination 及
    测试），属该窗口进行中工作，本窗口不触碰。
- **模版双通道架构决定（2026-08-15 用户裁定，待 F6 Pair B 落地）**：
  Family 模版必须同时有 fresh 接口（现有 nominate：近期观测/交易证据）
  与 retain 接口（新增 reverseBinding：冷池可验的反向绑定
  factory-child / registry-member / PositionManager / manager-state）。
  每个族都必须声明 retain 接口；做不了的显式声明为空/不支持（如 univ4
  非 PositionManager 创建、必须回创建块 Initialize 的池——超出本地
  reth 保留窗口，显式返回不可反查；angstrom/eigenpie/ethertoken 等
  tx-bound 族同样显式声明）。中央按插件声明决定 retained 用哪条通道、
  窗口多大、保留哪些池；插件只声明语义，不决定策略。

### F5 materializer v6 覆盖达成 + P1 收尾项（2026-08-15，不阻塞 eligible）

- **v6 覆盖达成**：materializer（真实 RPC，graph-merged2 为输入）输出
  17 族 admitted（curve 用 log 观测；univ2/3/4、dodo 均带真实
  log/call 观测），unresolved 仅剩 eigenpie / ethertoken-native-redeem /
  metronome-hgusdc——按用户最高命令视为不存在，不阻塞 eligible。
  descriptor 生成 19 cases（17 admitted + balancer/morpho 两个 funding
  族）。collect 双闭包 → held-out negatives → parity judge →
  `eligible=true` + `verdict=pass` 待跑。
- **P1 收尾项（完成 F5 后处理，当前不阻塞）**：`f5-ret13.json`
  universe 文件中 curve-underlying 条目为 0，但 graph-merged2 /
  materializer v6 能从协议缓存/图提名拿到 curve（log 观测 admitted）。
  疑似 universe 构建的 curve 过渡桥（`maturePoolAdapters.add(
  "curve-underlying")` 路径）未产出 curve 条目；需在 F5 闭环后核对
  universe 生成链与过渡桥接线，修复并重出 universe（不降低 eligible
  证据有效性，但作为 P1 收尾必须记录并解决）。

### F5 验收模型决定：生产多跳闭环（2026-08-15 用户裁定，最新为准）

- **验收必须与生产实际一致**：生产套利是“借起点 token → 经多个池子的
  路径 → 还回起点”的多跳闭环（planner 的 `BorrowableCycleToken` /
  closed-loop 枚举、AGENTS.md 的 DEX↔DEX closed loops）。F5 capture
  不得再用“单腿 borrow→swap→repay”的简化模型来验收。
- **case = 真实闭环路径**：descriptor case 应是一条可执行的多跳闭环
  （起点 token 可借），路径由中央 solver/planner 按生产逻辑拼装；
  族验证 = 该族在真实路径中那一段的 identity/exact/execution 语义，
  不是孤立单腿。
- **funding 只需要起点 token 可借**（主流 WETH/USDC 通常满足），
  不再要求路径里每个池的双 token 都可借。
- **borrowable 过滤不构成验收约束**：单腿模型下的全局“双 token 可借”
  过滤是错误模型的补丁——它制造了 univ4/goldx 被整体滤没的假
  unresolved、15-25 分钟的冗余探测、以及“no executable Funding
  offer”这类模型不匹配的假失败。应从 capture 链路移除，或最多降级为
  “每族至少保留一个可执行代表 case”的提示，不得用可借过滤塑造 case
  集合或掩盖 funding 真实覆盖。
- **后续失败判读**：单腿模型下出现的 funding/borrowable 类失败先按
  “模型不匹配”归因，再查族语义；不要继续在单腿模型上修补丁。

### F5 startToken 验收决策 + P1 token 表（2026-08-15 用户裁定，最新为准）

- **当前过渡口径**：多跳验收的起点借款 token **先固定用 ETH（WETH）**，
  闭环路径从 WETH 出发、经过各族验证池、回 WETH 还款；不再做
  graphTokenFrequency / frequentTokens / borrowable 集探测这类绕圈实现。
  固定 ETH 只作为 F5 过渡，不构成终态语义。
- **正确终态（P1，新架构完成后）**：funding 族（morpho/balancer）提供
  “可借 token 列表查询函数”（borrowable assets 查询），中央维护一个
  **独立 token 表**（与 edge 表并列，作为第二个基础表）；startToken
  从该表动态选择，替换固定 ETH 和现在的逐池探测。
- 现有 `annotateStartTokens` 的 graph 高频 token + 逐池 funding 探测被
  判定为绕圈：它既不是真实可借列表查询，也没有维护独立 token 表。
  P1 落地时删除该实现，改为 funding 查询函数 + token 表。
- 该 P1 项不阻塞 F5 eligible（固定 ETH 足够跑通多跳闭环验收）。

### F5 验收路径决定：终止 capture harness，终态验收走 live 管线
（2026-08-16 用户裁定，最新为准）

- **删除旧管线、停止 capture harness**：F5 的 materializer → descriptor →
  collect（generic capture）被判定为“为跑验收而搭的并行管线”，其
  代表池选择、funding 模型、裁剪 runtime 装配产生一批人为 bug，不代表
  真实管线缺陷。不再用 capture harness 作为验收路径。
- **终态验收 = live 严格管线**：F6 删除 legacy 后，F7/F8 cutover 让
  production composition 只组装 strict closure，default authority 切到
  strict；届时 F5 的 eligible 证据直接来自 live 管线在真实 universe 上
  的运行（真实闭环、真实 finalSim/EV 门），不再由并行 harness 产出。
- **真实缺陷保留清单（live 也会撞，必须修）**：goldx pricing 依赖
  重复、univ4 执行节点空 token 字段、angstrom runtimeEvidence 注入、
  capture runtime 的 authority/scheduler/simulator 装配——这些是 strict
  实现缺陷，不因验收路径改变而消失。
- capture harness 相关代码（materialize-s1-capture-inventory /
  generic-family-capture / run-architecture-migration-capture-real-cli）
  在 cutover 完成后退役（同 F6 删除范围，可执行闭包清零）。

### F5 验收原则：事实验收，不写人为验收脚本（2026-08-16 用户裁定）

- **验收 = 事实**，不维护人为验收脚本/harness：
  1. family 在 edge 有真实 fresh 数据（S1：发现/身份/准入/图成功）；
  2. sim 结束后同 amountIn 下 `exact.amountOut ≈ sim.amountOut`
     （S3 与 S5 执行链路一致）；
  3. 六步 judge 对 live strict 管线产出的 receipts 出 verdict
     （exact/planning/sizing/calldata/finalSim/repayment/EV）。
- 人为验收脚本会自带 bug（代表池选择、funding 模型、裁剪 runtime
  装配），成为假失败来源；不得再以并行 harness 作为验收判据。
- 验收数据全部来自 live 生产路径（cutover 后 strict 管线）的真实运行，
  judge 只读结果，不解释管线内部。
### F6 删除执行状态（2026-08-16 起，用户裁定：capture harness 终止，直接删旧）

- **执行顺序**：B→C→D→F→A，每对 strict 侧验收证据已存在（B: f3188a31 +
  双通道 reverse-binding 22 族合同绿；C: 8efcf4a0；D: d70b1c77；F:
  b9ab331d；E 已收口 6589823e；A: 686a5689），按用户授权直接开删，
  不再等待 cutover 前置。
- **B 对进度（61fe74a9）**：startup-dex-identity-retry 的 legacy 实现
  （prepareStartupDexIdentityRetryStage + SourcePinnedIdentityBackend +
  测试）已删除——live-discovery-coordinator 的 strict 版
  （strictStartupDexIdentityRetryStage / attestPoolsStrictFromProvider）
  是唯一权威，文件保留 StartupDexIdentityRetryStage 等类型。
  **B 对剩余**：protocol-instance-discovery 的
  createCanonicalProtocolIdentityAttester 内部仍走 legacy
  attestPoolIdentities（影响面：protocol-discovery-runtime 生产 +
  erc4626/astra/eigenpie/fluid 等测试）；切换方案 = attester 内部改用
  attestPoolsStrictFromProvider（provider + blockNumber 从 backend
  派生），测试用 fake provider 适配。
- **C/D/F/A 删除清单（下一轮）**：
  - C: landedPoolDiscovery / landed-event-registry / auto-close-router-gap
    的 legacy 消费路径（strict discovery checkpoint + enumerator 已接）；
  - D: legacy identity-policies 指纹（strict-catalog-universe:v1 已接）；
  - F: legacy family facade（assembleSchema / compileStaticSchema）与
    手工 adapterSchemaRevision 的 blockscan 消费（strict
    definitionBoundaryHash 已接，Pair E 收口后删除前置已满足）；
  - A: revm-live-backend 的 quoteByAdapter legacy exact 分支 +
    overlayApproveSpender legacy 分支（strict execution projection
    686a5689 + strict quote 100% 覆盖后删除前置已满足）。
- **capture harness 删除范围（同 F6）**：materialize-s1-capture-inventory /
  generate-s1-capture-descriptor / run-architecture-migration-capture-real-cli
  / run-architecture-migration-capture-cli / generic-family-capture /
  generic-capture-loop / generic-capture-revm-final-simulation /
  architecture-migration-capture / architecture-migration-parity-runner /
  architecture-migration-parity / architecture-migration-baseline-normalizer /
  architecture-migration-evidence / run-architecture-migration-parity-cli /
  run-parity-evidence-cli / generate-architecture-migration-held-out-negatives
  + 相关测试（generic-family-capture / s1-capture-* /
  architecture-migration-* / *-onchain-capture）+ collect 脚本 +
  scripts/collect-s1-sealed-production-corpus.sh。**保留**：
  architecture-migration-fixture-replay.ts（strict 测试基础设施，
  需解耦其 harness import：architecture-migration-capture /
  architecture-migration-parity-runner）；adapter-family-shared-surface-
  conformance 的 AST 门文件清单需移除已删文件。
### F6 执行进度（2026-08-16 续）

- **B 对（61fe74a9 + 本轮）**：startup-dex-identity-retry legacy 实现已删
  （strictStartupDexIdentityRetryStage 唯一权威）。**B 对剩余**：
  protocol-instance-discovery 的 createCanonicalProtocolIdentityAttester
  内部仍走 legacy attestPoolIdentities——strict 切换方案已验证：
  attester 改用 attestPoolsStrictFromProvider（context.backend +
  context.blockNumber 派生），但 **erc4626/fluid/silo 的 identity 需要
  effect-delta simulator**（minimal runtime 无）→ 4 个测试
  （erc4626-instance-discovery / erc4626-silo-redeem-family /
  fluid-family-admission / protocol-discovery-live-smoke）红。**决策**：
  attester 切换与 **F8 中央 runtime 装配**（simulator 注入 + context
  identityRuntime 通道 + 测试 fake simulator）**一起落地**（生产 runtime
  带 revm transport 后这些族 identity 自然通过），已回退保持全绿。
- **C 对（本轮验证关闭）**：coordinator/main 的 landedPoolDiscovery 消费
  已是 strict/通用（coverage 跟踪 + retained 物化重试
  consumesMaterializationRetries），无 shadow-only 权威残留；landed
  registry 为通用 registry（插件声明派生）合法保留。
- **D 对（68329009，已删）**：productionPoolUniverseSourceFingerprints
  legacy 版删除；strict 版去掉 identity-policies 指纹（strict catalog
  派生 surface 是唯一 identity/lineage 权威），保留 landed/mature/v2
  universe 生成参数指纹；poolUniverseSourceFingerprints 输入去
  identityPolicies；测试适配（conversion-freshness-universe-manifest /
  pool-universe）。pool-universe 15/15、strict-universe-source-fingerprints、
  conversion-freshness-production-evidence 全绿。
- **F 对（本轮验证关闭）**：blockscan revision 已全 strict 派生
  （strictDefinitionBoundaryHash ?? familyId，b9ab331d）；assembleSchema
  无定义（已删）；手工 adapterSchemaRevision 无 blockscan 消费（仅
  manifest 观测 + F9 receipt 检查）；compileStaticSchema 是族能力接口
  保留。blockscan-state-coordinator / -backend / -startup-warm 42/42 绿。
- **A 对（剩余）**：revm-live-backend 的 quoteByAdapter legacy exact 分支
  + overlayApproveSpender legacy 分支（strict execution projection
  686a5689 + strict quote 100% 覆盖后删除前置已满足，下一轮删除）。
- **harness 删除（剩余）**：按上轮清单（14 核心文件 + 20 测试 + collect
  脚本；fixture-replay 解耦保留）。
### F6 完成 + harness 退役 + F7/F8 状态（2026-08-16 续）

- **A 对（验证关闭）**：revm-live-backend 的 quoteByAdapter 已 strict-only
  （adapter.prepared.quote → quoteUnsupportedReason → fail-closed，无 legacy
  分支）；overlayApproveSpender 已 strict-only（strict execution projection
  唯一权威，无投影返回 null fail-closed）；prewarm legacy 回退已删
  （D-011）。A 对完成。
- **capture harness 已退役（0686ac4b）**：materializer / descriptor 生成器 /
  real-cli / capture-cli / generic-family-capture / generic-capture-loop /
  revm-final-simulation / architecture-migration-capture / parity-runner /
  parity / baseline-normalizer / evidence / parity-cli / evidence-cli /
  held-out 生成器（15 核心）+ 30 测试（s1-capture-* / architecture-migration-* /
  generic-family-capture / 21 个 onchain-capture）+ scripts
  （collect-s1-sealed-production-corpus.sh / capture-migration-parity.sh）已删；
  package.json 36 个 harness 脚本删；s1-regression-sweep 清理；
  **architecture-migration-fixture-replay.ts 保留**（strict 测试基础设施）并
  解耦（本地化 ARCHITECTURE_MIGRATION_STAGES / RawFamilyMigrationCaseCapture /
  exercisedStage / frameworkBlockedStage，~79 行改动）；AST 门
  （adapter-family-shared-surface-conformance）清单移除已删文件。
  完整 build 绿；strict-family-lifecycle-runner / strict-carry-continuity /
  strict-catalog-live-publisher / discovery-continuity-composition /
  shadow-catalog-publication / strict-execution-projection 全绿。
  **节点 dry-run（0686ac4b，head≈25770K）**：searcher 启动 + 运行 240s+
### F8 runtime 装配落地 + B 对 attester 切换（2026-08-16 续，545b551b）

- **通道完成（545b551b）**：attestPoolsStrictFromProvider 接受可选
  runtime（默认 minimal）；createCanonicalProtocolIdentityAttester 切换
  strict 权威（attestPoolsStrictFromProvider）并适配 discovery backend
  （getStorageAt→getStorage / 每调用 control 忽略——backend 已 pin 块）；
  ProtocolDiscoveryContext 增 identityRuntime?；protocol-discovery-runtime
  / live-discovery-coordinator / main.ts 逐层透传 identityRuntime
  （strictCentralRuntime，composition 存在时）。8 个测试的 attester 调用
  已切 strict（无参）；fixture-replay 新增 createFixtureStrictSimulationTransport
  （ERC4626 形状 deposit/redeem，可配 9/10 比例，动态 vault/asset/actor）。
- **测试适配进行中（工作树未提交）**：erc4626-instance-discovery 等 4 测试
  注入 identityRuntime（fake simulator）后 identity 仍 unresolved——调试
  发现：nominate 物化 address-surface 成功（getStorage 适配后），族
  identity base→active 链（fake simulation effects 匹配 9/10 fixture）
  理论上应 verified，但 attestation 的 accepted 为空。**下一步调试**：
  attestation 结果日志（accepted/rejected 计数 + lifecycle identity
  outcome 的 reasonCode——已加日志但未命中（可能 identityOutcome 找到后
  的 accepted 路径问题，或 lifecycle 抛错被 catch 吞）。
- **用户提议（tx 验证）**：attester 的族 active 证明需要真实交易事件
  evidence（withdraw/deposit）——用户可人工提供 tx hash，节点 receipt 读
  logs 派生族 evidence（F5 live 口径真实观测）。待 identity 链修通后作为
  evidence 注入通道实现。
- 生产正确性（不受测试影响）：生产 coordinator 传 strictCentralRuntime
  后，需要 simulator 的族（erc4626/fluid/silo/self-burn）的协议发现身份
  将可用；测试环境的 fake 适配是独立的（测试合同验证）。

  （19967 行日志、0 fatal、hint/impact 循环正常）——harness 删除无破坏 live 路径。
- **F7 状态**：durable discovery continuity composition 默认启用
  （8efcf4a0），catalogRoot 节点机器证据已有。
- **F8 状态**：solver quoteSource strict-only（16cf4436，两道门 PASS、
  shadow 55/55）；main.ts 中央 runtime 完整装配（2832-2841：
  createStrictCentralAdapterRuntime + verifiedActors +
  createRevmStrictSimulationTransport，composition 默认时）。
  **F8 B 对 attester 项已收口（545b551b + 93b037f6 + 25b0d082 + 44cdccf5）**：
  attester/attestPoolsStrictFromProvider runtime 注入 + context
  identityRuntime 通道落地，main.ts 传 production runtime（revm）；
  8 个族测试全部适配（erc4626 系/eigenpie/astra/fluid 全 PASS，fake
  simulator 等价生产 revm 路径）；live-smoke / dex-live-smoke 在节点以
  生产 revm 传输真实 RPC 全 PASS；两道门（s1-cutover-readiness /
  default-authority-cutover-gate）PASS；adapter-family-shadow-suite 37/37
  + systemic-live-gate + startup-manifest + strict-catalog-consumer-diagnostic
  全绿。F8 收口达成。
### F8 identity 测试适配进展（2026-08-16 续，ef513cff）

- **通道全部落地（545b551b + 93b037f6 + ef513cff）**：attestPoolsStrictFromProvider
  runtime 注入、attester strict 权威 + backend 适配（getStorageAt→getStorage、
  control 忽略）、context identityRuntime、coordinator/main 透传
  strictCentralRuntime（生产 revm）、accepted adapter 回退候选池标签、
  retryable rejection 分类（resource-limited/:rpc/:timeout → 
  RetryableProtocolDiscoveryError——错误链 instanceof + reason 模式）。
- **erc4626-instance-discovery 全 PASS**（strict runtime + fixture
  simulation transport：9/10 比例、动态 vault/asset/actor、transient
  retry 合同——identity 主线 + probe + claims + retry 全部验证）。
- **测试适配状态**：silo-redeem-family（族特有 SILO redeem 接口——
  simulateCalls 通道非 runtime.simulator——需族-specific fake simulator）、
  fluid-family-admission（identity factory-child-active-quote 双向 quote——
  fake backend 深度）、astra-multitoken-family（候选 0x000000 物化无 code）、
  eigenpie-deposit（部分断言）、live-smoke（真实 RPC——需 revm/节点侧）、
  dex-live-smoke（缺 SEARCHER_PROTOCOL_DISCOVERY_UNIVERSE_PATH env）——
  逐个下轮处理。
- **节点已部署 ef513cff（HEAD_OK + BUILD_OK）**。
- **用户澄清（2026-08-16）**：不需要人工 tx——4626 等族 identity 的
  active 证明用 revm 模拟（fork 真实状态跑 deposit/redeem），生产
  coordinator 已传 strictCentralRuntime；只有 revm 模拟失败/冷池才需
  tx 兜底。
- **下一步**：silo/fluid/astra/eigenpie 测试适配 → 两道门
  （s1-cutover-readiness / default-authority-cutover-gate）→ F8 收口 →
  live 验收 → F9。
- **silo 适配进展（ddb49547）**：fallback 物化透传候选 opaque（payoutToken/
  sampleShares/sampleAssets——族 decodeCandidate 需要，9460a68d）；silo
  测试适配（fake simulator：SILO redeem→AMOUNT_OUT + effects；discover 支持
  identityRuntime/candidatesByAdapter；valid/timeDrift/ambiguous 段构造候选
  + 注入 runtime——测试文件工作树）。**卡点**：族 identity 的
  observed-payout-active-proof 在 transport 阶段 scheduler-failure（detail
  空——executor.execute 的抛错未带 message；identity-debug 日志已加——
  下轮定位 executor 的抛错点（issueAdapterRequestResult/freezeObservedEffects
  或 Promise.all 的请求处理）。
- **下一步**：silo transport 定位 → silo 全绿 → fluid/astra/eigenpie →
  两道门 → F8 收口 → live 验收 → F9。
- **silo + address-candidate-unit 全 PASS（a8e63143）**：silo 的 transport
  scheduler-failure 定位 = fake effects 缺 observe 声明的 logs（补 logs: []
  后通过）；silo 全断言绿（valid/timeDrift/ambiguous/noSimulation/observed/
  mode fail-closed）；address-candidate-unit 绿（9/10 fake + runtime 注入）。
  节点已部署 a8e63143（HEAD_OK + BUILD_OK）。
- **剩余**：eigenpie-deposit（候选 0x000000 no_catalog_match——候选 opaque/
  observed evidence 路径）、fluid-family-admission（active-quote 双向）、
  astra-multitoken-family（候选物化）、live-smoke（真实 RPC——需 revm/
  节点侧）、dex-live-smoke（env）→ 两道门 → F8 收口 → live 验收 → F9。
- **eigenpie 适配分析（下轮直接做）**：eigenpie 的 nominate 是
  createTxEvidenceNomination（需候选 opaque 带 txHash——entryOpaque 透传后
  物化 receipt logs→AssetDeposit log observation→decode 过）；族 identity
  的 active 校验（tokenDeltas：tokenIn 减 amountIn/tokenOut 加 amountOut +
  totalSupply + assetDepositLogMatches（AssetDeposit 事件））→ 测试内联 fake
  simulator（depositAsset 解码 + DEPOSITOR/TOKEN_OUT/AMOUNT_OUT fixture +
  depositLog() 构造）；候选 pool 补 transactionHash + identityRuntime 注入
  （269-275 段）。fixture 常量：TARGET 0x..A1/TOKEN_IN 0x..B1/TOKEN_OUT
  0x..C1/DEPOSITOR 0x..D1/AMOUNT_IN 1000/AMOUNT_OUT 900。
- **eigenpie 全 PASS（2da91797 + a4aa821f）**：tx-evidence nomination（候选
  transactionHash + backend receipt 返回 observedLogs）→ AssetDeposit log
  物化；observed-sender caller authority（identityRuntime 传 executor=
  DEPOSITOR）；active-deposit fake simulator（data "0x"（depositAsset 无
  返回）、effects 去 blockNumber、logs 构造）；opaqueLabels 加
  "eigenpie-deposit-router"（plugin）。manifest 重新生成（a4aa821f）。
  节点已部署 a4aa821f（HEAD_OK + BUILD_OK）。
- **剩余**：astra-multitoken-family（候选 0x..A1/A2 nomination empty +
  no_catalog_match——astra 的 nominate/decode 待查）、fluid-family-admission
  （active-quote 双向）、live-smoke（真实 RPC）、dex-live-smoke（env）→
  两道门 → F8 收口 → live 验收 → F9。
- **astra-multitoken-family 全 PASS（822b093b）**：tx-evidence log nomination
  （backend receipt 返回 receiptLogs + 候选 transactionHash）→ Change log
  物化；change fixture simulator（quote(target, amountIn) 2/3 倍 + 4 项
  tokenDeltas + Change 日志 + change 结果编码）；observed-sender executor=
  CHANGER。节点已部署 822b093b（HEAD_OK + BUILD_OK）。
- **fluid 适配分析（下轮直接做）**：族 identity 三阶段（constants →
  reverse-binding（factory getDexAddress）→ active-quote（swapIn
  return-or-revert-data——FluidDexSwapResult revert data 编码（selector +
  amountOut——amountOut = amountIn*9/10 按方向））；fakeBackend 的 call 需
  swapIn selector 抛 revert（带 FluidDexSwapResult data）；identityRuntime
  仅 provider（无 simulator 需求——quote 是 eth-call）；候选 0xee3273 的
  no_catalog_match 待查（fluid nominate address-surface + opaqueLabels
  "fluid-dex"/"fluid"）。
- **fluid-family-admission 全 PASS（25b0d082）**：中央 attester 增加
  credit-domain 分支（`executeCreditFamilyInstanceLifecycle`，镜像 shadow
  reattestor 的 domain 分支）；`legacyLabelsForLineage` 改用族声明的
  `poolAdapterIds[0]`（fluid-dex 从错误 action label 'fluid-dex-swap'
  修正为 pool label 'fluid-dex'）；fluid-credit opaqueLabels 补
  'fluid-vault'；测试内联 fluidFixtureSimulator（vault operate
  effect-delta：tokenDeltas 满足观察声明）+ fakeBackend call 对 swapIn
  selector 抛 `FluidDexSwapResult` revert（ADDRESS_DEAD quote 通道）。
  fluid 6 族测试（含 erc4626 系/eigenpie/astra）+ build 全绿。
  节点已部署 25b0d082（HEAD_OK + BUILD_OK）。
- **live-smoke / dex-live-smoke 全 PASS（44cdccf5 测试接线 + 节点 revm 重建）**：
  两个 live smoke 测试在 SEARCHER_REVM_SIM_BIN+BOTVM_ADDRESS 存在时装配生产
  revm strict central runtime（createStrictCentralAdapterRuntime +
  createRevmStrictSimulationTransport，镜像 main.ts 2832-2841）；
  节点侧旧 revm-sim 二进制协议过时（strictSimulate 缺 to/data 字段），
  已按 deploy-node.sh 内容寻址方式重建并发布
  `/opt/MEV-runtime/revm/revm-sim-45131e4b…`（.env 同步）。
  live-smoke：unseeded ERC4626（0x8F135b…）admitted + 2 protocol edges；
  dex-live-smoke（universe 3000 池）：admissions=1、added=1、
  firstProbes=4200、secondCacheHits=1400、wallMs=14577。
  节点已部署 44cdccf5（HEAD_OK + BUILD_OK）。
- **两道门全 PASS（当前轮）**：`searcher:s1-cutover-readiness` PASS、
  `searcher:default-authority-cutover-gate` PASS；systemic-live-gate、
  production-family-startup-manifest、strict-catalog-consumer-diagnostic、
  adapter-family-shadow-suite 37/37 全绿。
- **F8 收口（03ac4f51 docs 确认）**：B 对 attester 项关闭——attester/
  attestPoolsStrictFromProvider runtime 注入 + context identityRuntime
  通道 + main.ts production revm runtime；8 个族测试全 PASS（含 fluid）；
  live-smoke / dex-live-smoke 节点真实 RPC 全 PASS；F8 中央 runtime
  装配（authority/scheduler/simulator）到位。
- **F5 live 运行集成修复（651b0235 + cb761c0a，live 暴露）**：ret13
  universe 行携带 `identitySource=strict-lifecycle`（strict attester
  自身输出）与 plugin 声明的 pool-adapter label 作 venueId（如
  `univ4-unlock`），生产 pool-universe loader 的 registry-ids /
  isProductionVenueId 校验拒绝——strict 管线输出无法回载。修复：
  `strict-lifecycle` 注册为已知 identity source；isProductionVenueId
  接受 catalog 声明的 pool-adapter labels（与 isProductionPoolAdapter
  同一插件自有投影）。节点已部署 cb761c0a（HEAD_OK + BUILD_OK）。
- **F5 live 验收运行中（edf2a3b9，3h 窗口，backend=revm）**：生产
  searcher（searcher:live，dry-run）以 f5-ret13 universe 为输入在节点
  运行；实测启动 12,015 池 strict attestation ~60min（universe +
  blockscan 两轮全量验证，冷池 address-surface fallback 每池 ~4-19s），
  90min 单窗口不足以到达 periodic pass（EVENTS=0）；3h 窗口预期
  ~2h periodic pass 产出 events/routes；验收事实 = family fresh 数据
  （S1）+ exact.amountOut ≈ sim.amountOut（S3/S5）+ 六步 judge verdict。
  若 3h 仍不足则考虑 SEARCHER_DISCOVERY_BACKFILL_ENABLED=0 冻结
  discovery 追赶（checkpoint 既有做法）以保留窗口给 periodic pass。
- **剩余**：F5 live 验收收尾（judge verdict）→ F9
  （MigrationCleanupReceipt.verdict=pass + AST/import-closure 证明）。










### F5 验收模型方向修正：生产多跳闭环（2026-08-15 用户裁定，最新为准）

- **验收以生产实际模型为准，单腿 borrowable 过滤不构成验收约束**。生产套利是
  多跳闭环：借一个可借起点 token（morpho/balancer 闪贷）→ 经 token graph 若干池
  swap → 回到起点 token 还款。中间池子的 token **不需要可借**——只有起点 token
  需要。planner.ts 的 BorrowableCycleToken/rotatedPlans 与
  solver/flash-liquidity.ts 已证明生产即多跳闭环。
- **单腿 + borrowable 过滤是人为简化，只会制造假失败**：① 要求池子“双 token
  都可借”比生产严得多；② 池子输入 token 可以是前一跳换来的，不需要直接可借；
  ③ 用可借性塑造 case 集合会掩盖 funding 真实覆盖（哪些 token 真借不到看不
  到）；④ 吃掉族覆盖（曾导致 univ4/goldx 被整体滤为 unresolved）；⑤ 额外
  15-25 分钟探测。**已删除**：materializer 不再按可借性过滤提名池，per-family
  early stop 取第一个物化的池，capture 对起点 token 如实报告 funding 结果。
- **funding 闭环是中央机制，验一次就够**（借→swap→还一个 case 跑通即证明
  borrow/repay fragment 与 finalSim 守恒在中央层正确）；**各族 case 验的是各族
  插件语义**（identity/exact/execution/pricing 在真实链上是否准入与正确），
  F5 要求每族一个真实正例即为此目的。两者不耦合为同一门槛。
- **case 模型演进**：当前 capture 为单腿 case（借 tokenIn → 一个池 swap → 还
  tokenIn）；**下一轮改为生产多跳闭环 case**（借起点 token → 中央 solver 按生产
  逻辑拼路径 → 还起点 token），每族验证它在路径中那一段的 exact/execution
  语义。期间“每族挑主流可执行代表池”只是过渡妥协，不是验收口径。
### F5 多跳闭环落地（2026-08-15 晚，代码已提交 3eb13b4d）

- **多跳执行已完成**：descriptor case 携带不透明 `path`（startToken +
  edges[{pool, tokenIn, tokenOut, adapterId}]），中央 capture 逐段执行：
  每段按该池族物化观测（plugin 声明 nominate/reverseBinding 通道）→
  lifecycle → exact（金额沿路径链式传递，首段 = startToken 归一化 1
  unit）→ execution fragment；所有 fragment 组合成闭环树（BotVM
  post-order 保证段 0..N-1 顺序执行）→ funding（仅 startToken）→
  finalSim 在 funding root 下执行整环（借起点 → 逐池 swap → 还起点）。
  任何一段无法物化/准入/报价/构建即 fail-closed。无 path 时保留单腿为
  诚实 fallback。路径/段是不透明参数，中央不解释协议语义。
- **v18 重跑原因**：v17 生成于 ae4d328c 之前 4 分钟（22:47 vs 22:51），
  不含 annotateStartTokens，全部 entry 无 startToken → descriptor v13
  全部 NO-PATH → challenger 15 全是单腿结构性失败。节点探针确认 funding
  探测正常（morpho/balancer 对 WETH/USDC 均有 offers，maxBorrow 巨大）。
- **下一步**：materializer v18（后台运行中）→ descriptor v14（带 path）→
  challenger 17（多跳执行）→ 逐 case 判读（环方向与族 route 不匹配等
  如实修，不猜不降级）。
