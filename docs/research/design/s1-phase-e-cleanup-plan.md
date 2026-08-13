# S1 Phase E cleanup plan（先建后删，逐对保持绿）

> D-011：用户决定跳过默认 authority 切换的额外验证，直接执行 Phase E，
> 可回退。live 节点 `/opt/MEV` 在显式部署前仍运行旧 runtime，不受本分支
> 删除影响。每条删除对（pair）都必须：strict 替换先落地（合同绿）→
> call-site 切到 strict（默认 OFF 的 env gate 内）→ 验证 → 删除 legacy
> （合同绿）。任一 pair 无法保持绿则回退该 pair 并如实记录。

## 已完成

- Slice 1（`74ee43b5`）：移除 legacy activation manifest + 合同/基线、
  erc4626 legacy recall + 探针；全部绿。

## 删除对（按依赖排序）

> **结构性前置（2026-08-12 确认）：** 所有删除对都依赖 live 循环真正提交
> strict catalog publication。当前 production 里
> `discoveryContinuityComposition.catalogRoot.capture()` 恒为 null：没有
> 任何生产者执行 discovery→lifecycle→closure→stage→commit 管线，strict
> views 从未存在，execution 投影因此永远回退 legacy。Phase E 删除的硬
> 前置是**先建这条 strict 生产管线**（这是 canonical 一直说的"solver 真实
> 接线"本体），不是默认 authority 开关本身：
> 1. 每个 admission 的 pool 经 strict Family lifecycle 签发 PreparedFamilyInstance；
> 2. checkpoint inventory（writer 已落地）→ closure verifier → receipt；
> 3. 逐族 stage（complete-snapshot / observed-complete）→ catalogRoot
>    prepare + compareAndPublish；
> 4. solver/revm 消费 committed views（execution 投影已就绪）。
> 在此之前任何 legacy 删除都会留下无数据路径；"直接删除+回退"只会在
> 回退循环里打转，不构成推进。
>
> **管线进展（2026-08-12）：** `strict-catalog-live-publisher` 已落地：
> 给定 lifecycle-issued publication，恢复 checkpoint inventory →
> closure verifyAndIssue → 逐族 stage（complete-snapshot /
> observed-complete）→ prepare + compareAndPublish，返回 revision 或
> unresolved；wsteth 合同测试通过（rev1 + committed views）。剩余：
> 生产循环里为每个 admission 的 pool 跑 strict Family lifecycle（管线
> 步骤 1）并把 publisher 接到 live 发布路径（步骤 4 消费端已就绪）。
>
> **管线进展 2（2026-08-12）：** `runStrictFamilyLifecycle` 已落地
> （catalog.matches → executeAdapterFamilyLifecycleBatch → publication，
> 无 match/无 publication fail-closed 且错误带 stage/reason）；wsteth
> fixture runtime 导出复用，合同测试通过。管线步骤 1 的调用面就绪；
> 剩余为生产循环把 discovery observations 喂给 runner 并把 publication
> 接到 publisher。
>
> **硬边界（2026-08-12 证据确认）：** `main.ts` 只有 legacy
> `AdapterRuntimeCoordinator`，**production 不存在 strict
> `CentralAdapterRuntime`**（无任何 lifecycle 执行实例、无 strict
> scheduler/budget/fence 生产接线），`catalogRoot` 在生产里从未被
> 提交过 publication。因此管线最后一段（production strict runtime +
> live-loop 接线）是整套 S1 production runtime 迁移，不是可继续以
> 合同 wrapper 凑出的 slice；继续产出小 wrapper 而不建 production
> runtime 属于"polishing the microscope"（decision-log X-004），
> 不再这样推进。下一步必须是生产 runtime 建设（multi-slice 程序），
> 或明确接受 shadow-only 边界。
>
> **生产 runtime 第一块已落地（2026-08-12）：**
> `createStrictCentralAdapterRuntime`：provider-backed strict runtime
> （eth-call / get-code / get-storage 按 canonical source block 执行，
> simulation fail-closed resource-limited，scheduler/policy/fence 按
> central 契约）；合同测试用 mock provider 驱动 wsteth lifecycle 到
> publication 成功。剩余：simulation transport（revm）接入、main.ts
> 构造并接线 live-loop（runner→publisher）。
>
> **生产 runtime 第二块（2026-08-12）：** simulation transport 合同面
> 已落地（`StrictSimulationTransport`）：注入 simulator 后
> state-override/effect-delta simulation 返回 data + effects，缺省
> 仍 fail-closed resource-limited；合同测试覆盖两分支。剩余：revm
> backend 实现该 transport、main.ts 构造 runtime 并接线 live-loop。
>
> **生产 runtime 第三块 + main 接线骨架（2026-08-12）：**
> `createRevmStrictSimulationTransport`（quote-backed：CallerRef 解析、
> preCalls 顺序执行；observe/funded-override 不支持时 fail-closed）
> 已落地并测试；main.ts 在 composition 存在时构造 strict runtime
> （provider + revm transport + fence），`onPublicationApplied` 挂
> `publishStrictCatalogFromLiveDiscovery`（当前 observation feed 未
> 接，显式 fail-closed no-op，不伪造 publication）。剩余：把
> mempool/discovery 观测转成 UnifiedObservation 喂给 runner 并接到
> publisher（live observation feed 接线）。
>
> **管线完成（2026-08-12）：** `deriveLiveDiscoveryAddressSurfaceObservations`
> （evidence cache → address-surface UnifiedObservation，interface
> fingerprint 从 family 声明的 surface 投影、identity 阶段链上再验证）
> 已落地；main.ts 的 `publishStrictCatalogFromLiveDiscovery` 现在真正
> 执行 observations → runStrictFamilyLifecycle → publishStrictCatalog
> FromLifecycle，`onPublicationApplied` 先 sync checkpoint 再 publish
> （顺序保证 enumerator 看到新 inventory）。端到端合同测试：fixture
> live publication → observations → lifecycle（provider-backed runtime）
> → publisher → committed rev1 with pricing 通过。四步管线在合同/切片
> 层面全部闭环；production 实跑（节点 composition env 开启后 live-loop
> 自动执行）是下一步机器验收。
>
> **节点部署验收（2026-08-12，机器证据）：** challenger
> `a1c282d9` + composition env 开启，600s dry-run：
> composition empty→trusted、writer ready、checkpoint 提交至 rev4、
> searcher 无回退（priced 87.82%、edges 37178）；**数据源缺口**：
> live protocol cache 持久化只有 verified_candidates（404），
> address_entries 为 0 → 观测 feed 无 address-surface 数据，publisher
> 如实 no-op。下一步：把 protocol discovery 的 address entries 持久化
> 进 cache（或从 live 进程内存 feed），再跑一次验收即可看到
> catalogRoot 生产提交。
>
> **验收推进（2026-08-12，`871c0e74`）：** self-burn dependency
> fingerprint 修复（32-byte hex）后，protocol cache 的
> address_entries 从 0 增至 **11,354**（fingerprint bug 确认是
> 根因；持久化早已存在，无需改序列化）；searcher priced 从 87.7%
> 升至 **90.15%**。但 600s 窗口内这 11,354 条 entry 的 candidate 全为
> null——live matcher 尚未把 shortlist 地址验证为 protocol candidate，
> strict feed 继续 fail-closed no-op。剩余杠杆：更长的预热窗口让
> current-N matcher 完成验证（observed-interaction / 20-min prewarm），
> 或排查 self-burn shortlist 验证为何在窗口内全部 null。
>
> **null 根因定位 + strict feed 修复（2026-08-12，本提交）：**
> 排查完成（按用户选 2）：抽样 12 个 address_entries 地址在链上
> EIP-1967 slot（`0x3608…`）全部为 0（节点 RPC 复验），
> self-burn `candidateFromAddress` 的 proxy 门
> （`implementationWord !== ZeroHash`）按合同拒绝全部——是语义负例，
> 不是读取 bug；更长的预热窗口不会改变结果。真正生产候选在
> verified_candidates（458 条：erc4626×450、erc4626-silo×2、
> astra×2、ethertoken×2、fluid-dex×1、eigenpie×1），但 strict feed
> 只消费 address_entries → 观测仍为空。
> 修复三块：
> 1) `deriveLiveDiscoveryAddressSurfaceObservations` /
>    `deriveLiveDiscoveryCheckpointInventory` 同时消费
>    verified_candidates（保留提名按当前 source 重新进入 strict
>    lifecycle；adapterId 与 strict familyId 相同或经 ownerOfAction
>    双解析）；inventory 的 address-surface 补
>    `interfaceFingerprints`（snapshot closure 校验要求）。
> 2) `FamilyCapabilityCatalog` proxy-implementation 匹配修正：按
>    wildcard 索引、`implementationWord` 非零即匹配（原来用 label
>    指纹当 key 按 implementationWord 查询，结构上永不匹配）。
> 3) `publishStrictCatalogFromLifecycle` 第二次发布起补
>    `sourceTransitionProof`（composition 暴露
>    `issueSourceTransition`；main.ts 在非 canonical-adjacent 时
>    fail-closed 跳过发布，不伪造祖先证明）。
> 合同测试：family-capability-catalog（proxy 匹配正/反例）、
> strict-live-observation-feed（verified candidate → inventory
> sync → lifecycle → rev2 publish）；shadow suite / build /
> regression sweep 全绿。剩余：节点验收重跑（challenger 600s）
> 验证生产路径第一次 catalogRoot 提交。
>
> **第一个生产 catalogRoot（2026-08-12，`78934fdf` 节点机器证据）：**
> challenger 600s dry-run 首次出现 `strict catalog live publisher
> published`（evidence:
> `docs/research/design/evidence/s1-node-acceptance-pipeline-78934fdf.json`）：
> composition trusted、writer ready、checkpoint 提交至 revision 11；
> fluid-dex 实例完成 strict identity（declared-revert quote 语义）
> → instance → routes → pricing，经 complete-snapshot closure 提交；
> searcher 无回退（priced 87.79%、edges 37172）。本轮修复链：
> verified-candidate feed + interfaceFingerprints（`417c0d74`）、
> proxy 匹配与 source-transition proof（`417c0d74`）、declared
> revert/能力标注（`565b00e6`）、RPC 单次重试 + 小族优先
> （`f47048c3`）、全 catalog family staging（`78934fdf`）。
> 剩余唯一失败：erc4626 450 实例在 verified-actor/effect-delta
> 能力边界 fail-closed（authority-failure），不是回归；需要 revm
> transport 的 effect-delta + observe + funded override +
> verified-actor 才能进入发布集（结构性能力缺口，另行立项）。
>
> **catalogRoot 内容确认（2026-08-12，`f3c1d066` 节点机器证据）：**
> 日志 `strict catalog root committed: revision=1 instances=1
> pricing=2`（evidence:
> `docs/research/design/evidence/s1-node-acceptance-pipeline-f3c1d066.json`）：
> 生产路径第一次非空 catalogRoot 提交完成——fluid-dex 单实例、
> 2 条 pricing 条目；checkpoint revision 13（source
> 25738323）；searcher priced 90.10%（无回退）；下一 pass 在
> 同一 source 被 canonical-adjacent 门正确跳过。
>
> **catalogRoot 重复发布修复（2026-08-12）：** 上一版
> canonical-adjacent 门只允许相邻块，但节点 observed cursor 按
> discovery chunk 跳进，导致 revision 2+ 的发布会被永久跳过。
> 改为有界祖先链验证
> （`resolveCanonicalSourceTransition`：从当前 source 沿 parent
> hash 回走至 previous source，maxDepth=256，非祖先 fail-closed）；
> main.ts 在发布前用同一函数校验后才允许
> `issueSourceTransition`。合同测试
> `strict-live-source-transition`（相邻/跨块/非祖先/倒退/深度上限
> 五例）已并入 shadow suite；build/suite 全绿。剩余：节点验收确认
> 第二个 source 能提交 revision 2。
>
> **catalogRoot generation 单调修复（2026-08-12）：** 节点复跑发现
> 祖先门通过后第二 pass 仍 unresolved：
> `staged publication generation is not newer`——main.ts 的 live
> source 硬编码 generation=0，而 catalogRoot 要求新 source 的
> generation 严格大于上一 revision。修复：inventory sync 与 live
> publisher 的 source generation 均由上一 catalogRoot
> `(generation ?? -1) + 1` 派生（首次仍为 0），与祖先验证共用同一
> source。build/suite 全绿；剩余：节点验收确认 revision 2 提交。
>
> **catalogRoot 重复发布验收通过（2026-08-12，`22c965dd` 节点机器
> 证据）：** 600s dry-run 日志连续出现
> `strict catalog root committed: revision=1 instances=1 pricing=2`
> 与 `revision=2 instances=1 pricing=2`——跨块 source 的第二次
> 发布不再被跳过（祖先链验证 + generation 单调共同生效）；
> checkpoint revision 17（source 25738565, generation 1）；
> searcher priced 90.09% 无回退。证据：
> `docs/research/design/evidence/s1-node-acceptance-pipeline-22c965dd.json`。
>
> **strict caller-authority 合同补全（2026-08-12）：**
> `createStrictCentralAdapterRuntime` 新增 `verifiedActors` 输入；
> `PRODUCTION_STRICT_VERIFIED_ACTORS` 集中声明 7 个 evidence id →
> probe actor（erc4626 / erc4626-silo / self-burn probe+pricing /
> ethertoken / fluid-credit / dodo-v2），main.ts 构造 runtime 时注入。
> 之前 erc4626 在 authority 阶段就 fail（恒定空 authority 是漏绑，
> 不是能力结论）；现在会正确通过 caller-authority，随后在 revm
> transport 的 effect-delta/observe/funded-override/verified-actor
> 能力边界以 resource-limited fail-closed——错误分类被消除。
> 合同测试：runtime 无 map 时 authority-failure、有 map 时
> verified-actor 请求执行成功；build/suite 全绿。
>
> **correctness kernel 修订（2026-08-12，按 P0 审计）：**
> live publisher 不再从 publication 存在性伪推 complete-snapshot：
> 所有 live stage 一律 `observed-complete`（不授予 omission/
> tombstone authority），移除共享 closure receipt 与伪造
> `ffff…/eeee…` terminal evidence（P0-1/P0-3/P0-4）；
> `eventCovered()` 删除全局 DEX/protocol cursor OR fallback，只认
> 精确 `Family × source × cutoff` receipt（P0-2）。合同回归：
> 多 Family（wsteth + fluid-dex）同代 observed-complete 发布成功
> （revision 2、2 instances）——旧共享 receipt 路径在第二个
> complete-snapshot stage 必失败；精确/缺失 coverage 水位正反例。
> build/suite 全绿。complete-snapshot closure 仍保留在 composition
> 供未来精确 bootstrap 路径使用，live 循环不触碰。
>
> **correctness kernel 节点验收（2026-08-12，`20354d76` 机器证据）：**
> 600s dry-run 仍连续提交 `revision=1` 与 `revision=2`
> （instances=1/pricing=2），但发布已全部走 observed-complete；
> checkpoint revision 21 的 43 行水位全部 append-only、
> contiguous-history 为 0——全局 cursor 不再铸造完整性，精确
> Family×source receipt 缺失时保持诚实；erc4626 稳定停在
> `resource-limited`（verified-actor authority 已绑定，剩余为
> revm effect-delta transport 能力缺口）。证据：
> `docs/research/design/evidence/s1-node-acceptance-pipeline-20354d76.json`。
> 剩余 P0：跨重启提交协议/最终 fence（P0-5）、验收门 sealed
> parity 诚实化（P0-6）；P1：完整 event ingress、真实预算/
> timing/provenance、continuous 调度、22-Family 崩溃恢复合同。
>
> **P0-5 核心落地（2026-08-12）：**
> 1) `createCoalescingPublicationChain`：live 回调严格串行 +
> 在途 coalesce（每次链运行重取最新 capture），消除 checkpoint
> 写与 catalog CAS 交错；合同测试覆盖顺序/合并/错误隔离。
> 2) main.ts 将原两个独立 closure（各 capture 一次）合并为单一
> `runStrictLivePublicationChain`：一次 capture 构建 source，
> publish 成功后才在同一个 source/envelope 写 durable checkpoint
> ——appliedThrough 不再领先可恢复 authority。
> 3) 最终 CAS 不再用 no-op fence：composition 暴露真实
> `verifyCanonicalSource`（生产为 block-hash 校验）与
> `assertGenerationCurrent`（catalog-relative 单调）；checkpoint
> store 内部保留 hash-successor 语义（同一 generation 的
> checkpoint 写入合法）。合同测试：final CAS 必调用 canonical
> verifier、stale generation 被拒。build/suite（25 项）全绿。
> 剩余 P0-5：catalogRoot 本身仍为内存态（private state 含 runtime
> handle，不可序列化），重启后由下一次发布重建——因 live 路径
> 只授予 observed-complete，不构成 omission authority，此限制在
> 文档中显式记录。
>
> **P0-5 节点验收（2026-08-12，`43a678d9` 机器证据）：** 600s
> dry-run 日志顺序为 `strict catalog root committed: revision=1`
> → `discovery checkpoint inventory committed`（revision=2 同序）：
> durable checkpoint 只在 catalogRoot CAS 成功后推进；
> checkpoint revision 23、source generation 1、43 行水位全部
> append-only；erc4626 稳定 `resource-limited`；searcher priced
> 87.83% 无回退。证据：
> `docs/research/design/evidence/s1-node-acceptance-pipeline-43a678d9.json`。
>
> **P0-6 验收门诚实化（2026-08-12）：**
> 1) sealed-production acceptance 现在要求非空 held-out negatives
>    （空数组不再 vacuous pass），否则 ineligible 并给出明确 reason；
> 2) production capture 校验拒绝 `fixture:*` evidenceRefs 与全同字节
>    占位 hash（`issueArchitectureMigrationSideCapture` fail-closed）；
> 3) parity CLI 对 sealed-production 强制
>    `productionProvenance{commit,sourceBlock,sourceBlockHash,evidencePath}`，
>    禁止 CLI 自封 production；
> 4) 22-family 证据重新分类为 `unit-contract`（19/22 为 fixture
>    case），receipt 的 `acceptance={eligible:false,verdict:ineligible}`；
>    verify 脚本断言 aggregate pass 且 acceptance 不得 eligible。
> 合同测试：fixture-ref/placeholder-hash 拒绝、空 held-out 拒绝、
> 非空 held-out 通过、文件入口 sealed 无 held-out 拒绝。剩余：
> 真实 on-chain production corpus + 非空 held-out 的
> sealed-production 验收需真实案例采集（另行立项）。
>
> **P1-a 真实 runtime 遥测/预算/provenance（2026-08-12）：**
> `createStrictCentralAdapterRuntime` 不再返回固定值：
> `timing()` 度量真实 queue/transport wall time；`budgets` 强制正
> deadline 与可配置 batch 上限（默认 512）；static-evidence reuse
> seal 改为绑定 reusePolicy/source/requests/resultsFingerprint 的
> sha256；simulation provenance fingerprint 绑定 request
> （id/kind/to/data/preCalls/override/observe/source）。合同测试
> 覆盖 telemetry、reuse seal 变化、预算拒绝、仿真 provenance
> 非固定值；build/suite（25 项）全绿。
> 剩余 P1：完整 factory-log/landed-log/observed-call ingress、
> continuous 调度 lane/producer reserve/deadline/去重/backlog、
> revm effect-delta 能力、崩溃恢复契约扩展、legacy fallback 收口。
>
> **P1-f 运行模式决策 + P1-d 回归断言（2026-08-12）：**
> canonical 架构文档新增 continuous-first 最终决策（每代冻结
> source、串行化链、checkpoint 后置、observed-complete live、
> complete-snapshot 仅精确 bootstrap 且 receipt 每族独立、block-hash
> + 有界祖先 + generation 单调 fence、reorg/stale fail-closed）；
> strict-catalog-live-publisher 合同新增断言：live 发布的全部
> sourceAnchors 必须为 append-only-nomination（不得授予
> complete-snapshot）。build/suite 全绿。
>
> **P1-d 错误 omission 合同（2026-08-12）：** 新增回归测试：live
> 路径某 revision 不再发布某 Family 实例时，catalogRoot 必须
> fail-closed——未接线 issuer-bound StateInstance mutation proof
> 前，carry 被拒且已提交实例集保持不变（无 silent omission、
> 无 tombstone）。这确认了 canonical 文档的
> observed-complete 不变式：删除权与跨代 carry 都依赖显式
> mutation/terminal proof，缺失时整体拒绝而非悄悄丢实例。
> 剩余 P1：为 live 路径接线 StateInstance mutation/terminal
> proof issuer，使合法收缩（显式 terminal settlement）可提交。
>
> **P1 处置决策 + md 收口（2026-08-12，D-012）：** 按用户规则逐项
> 评估，剩余 P1 全部不影响当前生产（legacy 仍是生产 authority，
> live strict 仅 observed-complete 旁路、无删除权）：
> mutation/terminal proof（收缩发布 fail-closed 只增不减）、
> 活动族 ingress（legacy 仍全覆盖）、continuous 调度（后台链
> 错误隔离）、revm effect-delta（legacy 负责这些族）、legacy 收口
> （cutover 动作）。因此本轮直接完成 md 收口；P1 实现推迟到
> cutover 规划，作为 production authority 前置条件逐项立项。

| Pair | legacy 目标 | 需要的 strict 替换 | 状态 |
|---|---|---|---|
| A | `production-registry.routes()/funding()` 在 `revm-live-backend` 的执行消费 | strict family runtime handle / strict funding consumer 接入 live execution | step 1-5 完成：22 族 execution projection 全覆盖（spender 静态/hop.target/angstrom 常量/null；prewarm 保守留空）env gate 接线（默认 OFF）；**删除步骤阻塞**：strict 路径激活依赖 composition env + committed publication（即默认 authority 接线），用户选择跳过；在 composition 成为默认前删除 legacy 会让无 composition 的生产路径失去 execution 数据 |
| A | 同上 | 同上 | step 1-6 完成：execution 投影改为 composition 存在即默认启用（移除 env flag；无 committed views 时按 per-family/per-availability 回退 legacy），删除步骤的 authority 前置已最小化；仍保留 per-family 回退，删除 legacy 消费前需 composition 生产默认。**2026-08-12 部分删除**：funding/route prewarm 与 encodeQuotePrewarm 的 legacy 消费已移除（无 committed views 时返回空，接受 D-011 风险）；`quoteByAdapter`/`overlayApproveSpender` legacy 分支保留至 Pair E 接线后删除 |

> **Pair A 节点验证（2026-08-12，SSM 串行 strict-live run）：**
> challenger `45908c6c` + `SEARCHER_STRICT_LIVE_EXECUTION=1`（composition
> env 未开）：priced=32730/37328（87.68%）、edges=37062、events=865，
> 与无 gate challenger（87.61%/36922）相比无回退。注意该 run 无 committed
> strict views，strict 路径按设计回退 legacy——验证的是 gate 接线 no-op
> 安全性；univ2 pilot 真正激活需要 composition env + committed publication
> （节点下一步）。
>
> **Pair A 部分删除（2026-08-12，按 D-011）：** 代码核验发现
> `quoteByAdapter` 只有 legacy 分支（strict 侧无 quote 实现），
> `resolveStrictSolverConsumer` 仍为 diagnostic-only（Pair E 未接线），
> 直接全删会让所有配置下 searcher 无法报价。按用户授权删除安全子集：
> `resolveFundingPrewarmAddresses` 移除 legacyAddresses 参数（无
> committed views 返回空）；revm-live-backend 移除 funding/route
> legacy prewarm 与 encodeQuotePrewarm legacy 回退。合同测试更新
> （无 strict views 时 funding prewarm 为空）；build/shadow suite
> 全绿。quote/approve legacy 保留，待 Pair E 接线后补删。
>
> **Pair E 接线（2026-08-12）：** 新增 `createStrictQuoteSource`：
> solver 的 quoteSource call-site 在 composition 存在时包一层 strict
> quote source——按 committed views 的 edges+pricing routes 建索引
> （adapterId/target/tokens → instanceKey → pricingPublicationKey +
> routeKey），命中 route 用 `createStrictCatalogConsumer.resolvePricingMid`
> 的 mid 按 1e9 scale 折算 amountOut；unavailable/missing/未知 route
> 按 per-availability/per-family 设计回退 legacy quote，保证 strict
> publication 集尚未齐全时 searcher 覆盖不塌。revision 变更自动
> 重建索引。合同测试五例全过；solver 全量 strict 解析（去 legacy
> 回退）属默认 authority 收口的一部分。
>
> **Pair E 节点验收（2026-08-12，`c88aef4d` 机器证据）：** 600s
> dry-run：priced 34089/37896（89.95%，无回退）、edges 37154、
> publisherPublished + checkpointCommitted、仅 erc4626
> resource-limited（capability 缺口）。strict quote source 接线在
> 生产循环里实际生效（fluid-dex committed views 报价 + 其余族
> per-family legacy 回退），覆盖不塌。证据：
> `docs/research/design/evidence/s1-node-acceptance-pipeline-c88aef4d.json`。
> 下一步：Pair A 剩余 quote/approve legacy 删除（待 strict
> publication 集齐全或默认 authority 收口时执行）。
>
> **revm effect-delta 能力（2026-08-12）：** 补齐 erc4626 能力缺口：
> revm-sim daemon 新增 `strictSimulate` op（canonical block fork →
> token 余额注资 → preCalls → 主调用 → 返回 return-data +
> token/totalSupply 增量 + logs，signed decimal delta）；TS client
> 新增 `strictSimulate`；`createRevmStrictSimulationTransport` 重写为
> effect-delta 执行（verified-actor 解析、funded tokenBalances、
> observe token/call-target 与 totalSupply/logs），native 注资仍
> fail-closed；strict runtime effects 契约补
> `totalSupplyDeltas`/`logs`；main.ts 注入
> `PRODUCTION_STRICT_VERIFIED_ACTORS`。合同测试重写五例；
> build/shadow suite（26 项）/sweep 全绿。剩余：节点编译新 revm
> 二进制（独立路径，不覆盖 live 进程二进制）→ 节点验收验证
> erc4626 identity 完成 effect-delta 阶段并进入 catalogRoot。
>
> **revm effect-delta 缺口补上（2026-08-13，`e2e57f0c` 机器证据）：**
> 修复链：strictSimulate 原生 gas 注资（LackOfFunds）、
> BigInt-safe simulation provenance（此前 JSON.stringify 崩溃导致
> 所有仿真统一 resource-limited）、ERC20 balance slot 候选扩充 +
> prestateTracer 精确 slot 发现（覆盖 exotic 份额映射）、slot key
> 双 0x 前缀解析修复、runtime 仿真失败原因日志。节点 600s
> dry-run：`strict catalog root committed: revision=1
> instances=14 pricing=15`（fluid-dex 1 + erc4626 13），
> lifecycleFailures 为空；searcher priced 87.6% 无回退。单 vault
> 复现确认 erc4626 完整 identity（base → active deposit/redeem
> effect-delta，含 funded override + observe deltas/logs）发布成功。
> 证据：
> `docs/research/design/evidence/s1-node-acceptance-pipeline-e2e57f0c.json`。
> 部署说明：新 revm-sim 二进制构建于节点 impl worktree
> （`/opt/MEV-impl-capture/listener/revm-sim/target/release/revm-sim`），
> challenger 通过 `S1_REVM_SIM_BIN_PATH` 覆盖使用，live 进程二进制
> 未被替换；后续部署到 live 需显式授权。

**Live 节点落地（2026-08-13，`10cfa554` 机器证据）：** 用户授权
“那你先落地就好了”。经 trusted `scripts/deploy-node.sh`（从
origin/main 取脚本）以
`SEARCHER_DEPLOY_REF=origin/codex/s1-unified-adapter-architecture-impl`
部署到 `/opt/MEV`，HEAD=`10cfa554fd79c63ce33afc962f9dc344d397d305`
（旧 runtime `269ade3c` → S1 分支 tip）。
- 模式保持 bounded-live：`.deploy-live` 标记未动，DRY_RUN=0、
  EV_GATE=1、钱包 `0xb8578…DDA3c` 余额 0.00270409 ETH ≤ 0.2 ETH
  上限、BotVM owner 链上核验通过；backrun/mempool=1、mevshare=0、
  blockscan submit=1、n-1 fallback=1 姿态与标记一致（重启后逐项校验）。
- 新 revm-sim content-addressed 产物（sha256 `3179a8ae…5a327`）在节点
  构建并绑定 `SEARCHER_REVM_SIM_BIN`；listener build 与 analysis
  preflight（18/18）通过；V2 lineage（2 条）与 pool universe（fresh
  84 blocks，跳过重建）重新 pin。
- 顺带修复节点既有事故：此前 searcher 因 `.env` 钉住
  `SEARCHER_DISCOVERY_TO_BLOCK=25726000` 而 reth 已剪枝该块 state，
  在 EIP-1898 启动探针崩溃循环；deploy 重钉至当前头 `25743199` 后
  unit active、NRestarts=0、无 fatal。
- 重启后核验：`pool registry: … = 20205 total`（universe 非零）、
  blockscan graph edges=35534。
- **如实边界：这是代码库落地，不是 strict default-authority
  cutover。** legacy 仍为生产 authority；strict consumers 环境门
  默认 OFF；strict quote source 仅在 committed views 覆盖的 route
  生效并按 per-availability 回退 legacy（live 暂无 committed
  publication，实际以 legacy 报价为主）。cutover 仍需 D-012 的
  P1 前置逐项立项。证据：
  `docs/research/design/evidence/s1-node-deploy-live-10cfa554.json`。
| B | `PRODUCTION_IDENTITY_RESOLVERS` / `attestPoolIdentities` | strict 身份经 Family lifecycle identity 阶段 + source-bound consumer | 未开始 |
| C | `landedPoolDiscovery` / `landed-event-registry` / `auto-close-router-gap` 消费 | strict discovery checkpoint + enumerator + observed-complete 事件面 | 未开始 |
| D | `productionPoolUniverseSourceFingerprints`（universe deploy trust） | strict catalog/checkpoint 派生指纹（identity/lineage 部分先由 strict 覆盖） | 未开始 |
| E | blockscan loop 的 legacy pricing 消费（14 legacy pricing Family） | strict pricing views + `strict-solver-consumer` 全量解析 | **2026-08-12 接线完成（部分）**：`createStrictQuoteSource` 已接入 solver quoteSource call-site——committed views 覆盖的 route 用 strict mid 报价（unavailable/missing 按 per-availability 回退 legacy），未覆盖 route 回退 legacy；revision 变更自动重建索引。合同测试 `strict-live-quote-source`（覆盖/未知/不可用/无 views/revision 重建五例）已并入 shadow suite。solver 全量 strict 解析（无 legacy 回退）待默认 authority 收口 |
| F | family facade / 手工 revision / legacy schema/cache bridge / 旧 flag | strict manifest + capability hash + CAS publication | 未开始 |

## 验收

- 每个 pair 提交后：`npm run build`、shadow suite、`s1-regression-sweep.sh`
  全绿；删除目标不再被 `listener/src`（除自身文档）引用；
- 全部 pairs 完成后：`searcher:live` 在无 legacy registry 引用下可编译
  启动（dry-run），canonical §18.3/§20.2.6 全门通过，Phase E 关闭。
