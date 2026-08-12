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

| Pair | legacy 目标 | 需要的 strict 替换 | 状态 |
|---|---|---|---|
| A | `production-registry.routes()/funding()` 在 `revm-live-backend` 的执行消费 | strict family runtime handle / strict funding consumer 接入 live execution | step 1-5 完成：22 族 execution projection 全覆盖（spender 静态/hop.target/angstrom 常量/null；prewarm 保守留空）env gate 接线（默认 OFF）；**删除步骤阻塞**：strict 路径激活依赖 composition env + committed publication（即默认 authority 接线），用户选择跳过；在 composition 成为默认前删除 legacy 会让无 composition 的生产路径失去 execution 数据 |
| A | 同上 | 同上 | step 1-6 完成：execution 投影改为 composition 存在即默认启用（移除 env flag；无 committed views 时按 per-family/per-availability 回退 legacy），删除步骤的 authority 前置已最小化；仍保留 per-family 回退，删除 legacy 消费前需 composition 生产默认 |

> **Pair A 节点验证（2026-08-12，SSM 串行 strict-live run）：**
> challenger `45908c6c` + `SEARCHER_STRICT_LIVE_EXECUTION=1`（composition
> env 未开）：priced=32730/37328（87.68%）、edges=37062、events=865，
> 与无 gate challenger（87.61%/36922）相比无回退。注意该 run 无 committed
> strict views，strict 路径按设计回退 legacy——验证的是 gate 接线 no-op
> 安全性；univ2 pilot 真正激活需要 composition env + committed publication
> （节点下一步）。
| B | `PRODUCTION_IDENTITY_RESOLVERS` / `attestPoolIdentities` | strict 身份经 Family lifecycle identity 阶段 + source-bound consumer | 未开始 |
| C | `landedPoolDiscovery` / `landed-event-registry` / `auto-close-router-gap` 消费 | strict discovery checkpoint + enumerator + observed-complete 事件面 | 未开始 |
| D | `productionPoolUniverseSourceFingerprints`（universe deploy trust） | strict catalog/checkpoint 派生指纹（identity/lineage 部分先由 strict 覆盖） | 未开始 |
| E | blockscan loop 的 legacy pricing 消费（14 legacy pricing Family） | strict pricing views + `strict-solver-consumer` 全量解析 | 合同已备，接线未接 |
| F | family facade / 手工 revision / legacy schema/cache bridge / 旧 flag | strict manifest + capability hash + CAS publication | 未开始 |

## 验收

- 每个 pair 提交后：`npm run build`、shadow suite、`s1-regression-sweep.sh`
  全绿；删除目标不再被 `listener/src`（除自身文档）引用；
- 全部 pairs 完成后：`searcher:live` 在无 legacy registry 引用下可编译
  启动（dry-run），canonical §18.3/§20.2.6 全门通过，Phase E 关闭。
