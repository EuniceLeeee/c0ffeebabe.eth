# Aloha 绿地 Searcher 最终架构

> 状态：可直接指导实现的 strict-only 终态合同。
>
> Aloha 基线：codex/aloha@0a712e515b003cd6f578727be26360a8632bfcff。
>
> 冻结实现参考：impl@d33c8b48d43f0191db4354ebe4192d805ac9323f。
>
> 冻结性能参考：codex/ds-blockscan-state-timing-refactor@466cf84fe7791baa848974af32ff1b502bfd103c。
>
> 本文只定义从空仓库直接实现的最终系统；不定义迁移、shadow或legacy双轨。本轮不执行部署，文中只设计
> future exact-SHA systemd dry-run边界；绝不授予签名或广播授权。

## 0. 判断标签、引用方法与强制用语

本文用以下标签区分事实与设计，标签是结论的一部分：

| 标签 | 含义 |
|---|---|
| [VEF] | verified existing fact：在冻结 SHA 的源码、测试或已归档记录中可复核的既有事实 |
| [MDR] | mature design retained：已经暴露并修过真实问题、且符合 Aloha 解耦边界的成熟设计 |
| [ASR] | asset selected for reuse：选定复用的资产；可能是原样代码，也可能是明确范围的算法 |
| [BRW] | asset requiring boundary rewrite：机制可参考，但 authority、类型、依赖或接口必须重写 |
| [REJ] | asset explicitly rejected：禁止进入 Aloha 的代码、语义或 authority |
| [PFD] | proposed final design：Aloha 的强制终态设计 |
| [MTM] | evidence still requiring measurement：实现后必须测量，当前不得写成已满足 |

旧代码引用写成 SHA:path:line，例如
impl@d33c8b48:listener/src/searcher/universe-rebuild-checkpoint.ts:267-272。
它表示用 git show SHA:path 读取的冻结对象，不表示 Aloha 依赖旧工作树。行号均按冻结对象的
nl -ba 输出计算。

文中 MUST、MUST NOT、SHALL、SHALL NOT 为实现门； SHOULD 为默认设计，偏离时必须有书面、
可测量的理由； MAY 仅表示不拥有 authority 的实现选择。

## 1. Executive decision

[PFD] Aloha 是一次绿地、strict-only、单 authority 重写。它从空仓库直接实现最终 contract，
不连接旧 runtime，不先恢复旧测试，不保留 compatibility facade，也不以新旧数量 parity 定义成功。

[MDR] 绿地不等于拒绝成熟路线。只要旧机制满足以下全部条件，就可以作为主要参考、原样复用或
最小提取：

- authority 与状态所有权唯一；
- 中央只解释通用 contract，不识别 Family 名称、地址、ABI、selector、topic、数学或 storage slot；
- 通过稳定 port 接入，不反向 import 其他模块内部实现；
- capability 变化只使真实依赖它的 Family 失效；
- active generation 不可变；
- durable progress、restart 差集复用、fail-closed 成立；
- batching、dedupe、deadline、abort、backpressure 与性能预算成立；
- 架构无关的事实验收器可验证其结果。

[PFD] 因此，Aloha 的工程原则不是“为了重写而重写”，而是：

> 按最终解耦边界重新组装成熟资产；保留已经验证的算法、合同与运行流程，只重写不满足边界的
> authority、依赖和数据合同。

[PFD] 唯一生产链路是：

~~~text
canonical cutoff(number + hash)
→ fixed 50-block recent observation
→ canonical identity enumeration + nomination
→ FamilyCandidateKey / FamilyInstanceKey dedupe
→ durable Family+Instance attestation
→ atomic readyGeneration
→ immutable GraphView lease
→ producer
→ blockscan / backrun
→ generic planner / solver
→ current-source exact
→ strict execution program
→ mandatory final simulation
→ dry-run submission boundary
~~~

[PFD] 没有 readyGeneration 时 fail closed。任何候选不得绕过 exact、execution program 或 final
simulation。默认 submission boundary 只产生 unsigned dry-run receipt。本文件不授权签名或广播。

[PFD] 该链描述首次构建与每个next generation。Process restart若已有仍canonical、closure-compatible且未超
maxServingAgeBlocks的readyGeneration，可直接rehydrate同一immutable GraphView后启动producer；这不是第二
authority。独立builder随后恢复inProgress或构建next generation，仍只通过同一promotion/adoption合同切换。

## 2. Goals / non-goals

### 2.1 Goals

[PFD] Aloha 必须同时达到：

1. 一个 canonical source、一个 catalog authority、一个 readyGeneration authority、一个 Graph
   authority；
2. Family plugin 独占协议语义，中央 pipeline 永远协议无关；
3. 新增 Family 只增加 Family package 与生成 catalog，不改中央 composition、planner、solver、
   execution compiler 或 validator；
4. capability 可组合、版本化、局部失效；
5. freeze、normalize、persist、rehydrate、transport 使用同一 schema-derived codec；
6. active GraphView 在 producer session 内不可变，下一 generation 可并行构建并在安全边界原子切换；
7. 每个 fixed-cutoff run 的每个 Family+Instance 只 attest 一次，restart 只做差集；
8. 统一调度不以重复扫描、重复 materialization、重复 projection 或无界并发换取正确性；
9. impl 与 Aloha 都由同一个、先冻结的事实验收协议判断；
10. 默认 dry-run，final simulation、standing-position、repayment、conservation 与 submission gate
    全部 fail closed。

### 2.2 Non-goals

[REJ] 本架构不包括：

- legacy 到 strict 的迁移顺序；
- shadow、capture、paired-live 或 parity cutover；
- 为旧 fixture、类名、导出或目录形状保留兼容层；
- 运行时 mutable topology；
- target route、pinned route 或手写成功 fixture；
- keeper/reward、inventory、private path、sandwich、JIT-LP；
- 本轮生产代码、测试实现、部署、进程操作、签名或广播。

[PFD] Aloha 可以继续支持当前 mission 内的 blockscan 与 public-mempool backrun，但两条 lane 必须
消费同一个 immutable GraphView，并在 current-source exact 后才能进入执行。

## 3. Verified evidence baseline

### 3.1 可复现基线

| 标签 | 冻结对象 | 已验证状态 |
|---|---|---|
| [VEF] | Aloha@0a712e515b003cd6f578727be26360a8632bfcff | 分支 codex/aloha；审计开始时仅有 AGENTS.md，工作树干净 |
| [VEF] | impl@d33c8b48d43f0191db4354ebe4192d805ac9323f | 旧 worktree HEAD 与冻结 SHA 相同；未跟踪的 listener/src/searcher/transport-schedule-policy.ts 属于用户，未读取为稳定事实、未修改 |
| [VEF] | DS@466cf84fe7791baa848974af32ff1b502bfd103c | 仅从 Git 对象读取；旧 DS 工作树状态不进入结论 |

### 3.2 关键既有事实

| 标签 | 事实 | 冻结证据 |
|---|---|---|
| [VEF] | impl durable envelope 已把 verified memo、in-progress run、ready generation 分开；不把长期 raw tx inbox、数组进度或 candidate journal 作为正确性状态 | impl@d33c8b48:listener/src/searcher/universe-rebuild-checkpoint.ts:7-15,121-169 |
| [VEF] | checkpoint 写入具备单 writer、revision CAS、临时文件、fsync、atomic rename 与 fail-closed 损坏处理 | 同文件:267-272,440-509,574-600 |
| [VEF] | 当前冻结实现只有 verified 或 terminal-rejected、且 retryable 为零时才可 ready；promotion 后清空 in-progress | impl@d33c8b48:listener/src/searcher/universe-rebuild-runner.ts:469-481；universe-rebuild-checkpoint.ts:574-600,877-899 |
| [VEF] | startup recent observation 固定为 cutoff-49..cutoff 共 50 blocks | impl@d33c8b48:listener/src/searcher/strict-edge-collection-policy.ts:1-16；universe-rebuild-runner.ts:243-250 |
| [VEF] | impl 仍把 pinned、scored universe、full universe file 与 overrides 合并为 nomination input；其 receipt 只证明 input partition 被消费，不证明链上全集 | impl@d33c8b48:listener/src/searcher/main.ts:1259-1305；universe-rebuild-production.ts:971-976,1010-1014,1442-1500 |
| [VEF] | UniV4 cold identity 已与 recent Swap observation 分离；recent Swap 是 nomination evidence，PositionManager reverse binding 才能覆盖近期无 swap 的 identity | impl@d33c8b48:listener/src/searcher/venues/swaps/univ4-family/nomination.ts:185-192,214-252 |
| [VEF] | UniV4 recent-swap index 用 source-keyed settled 与 inFlight 双 map；并发同 key 单飞，失败不污染 settled cache | 同文件:43-105,108-182；test/univ4-nomination.ts:193-309 |
| [VEF] | current-source refresh 从约 1,700 次串行 RPC 改为 concurrency 16；原串行估算约 26s，超过约 12s block cadence | impl@d33c8b48:listener/src/searcher/strict-production-runtime-session.ts:192-223 |
| [VEF] | request draft 已表达 caller executionMode 与 exact token-account observations，但 handwritten freeze、materialized type 和 fingerprint 静默丢失这两个字段 | impl@d33c8b48:listener/src/searcher/venues/adapter-request-program.ts:81-121,123-153,755-823,1766-1818 |
| [VEF] | simulation provenance hash 也未绑定 executionMode 与 observeTokenBalances；caller-mode gap 被映射为 aborted 而非 invalidProgram | impl@d33c8b48:listener/src/searcher/strict-central-adapter-runtime.ts:330-364,412-427 |
| [VEF] | RevmSimClient 是单 daemon、stdin/stdout FIFO response queue；一个慢请求会 head-of-line block 后续请求 | impl@d33c8b48:listener/src/searcher/revm-sim-client.ts:175-261；commit afcc07e8 的冻结提交说明 |
| [VEF]/[MTM] | afcc07e8 的冻结结构为每个attest创建独立daemon，因此不再共享同一FIFO；按结构隔离sibling HOL，但实际时延效果本轮未测；进程数仍随并发key增长 | impl@d33c8b48:listener/src/searcher/universe-rebuild-production.ts:566-630 |
| [VEF] | final-sim runtime 已使用专属资源、有限 queue、source/generation/plan fence、deadline、abort 与 interrupted-resource retirement | impl@d33c8b48:listener/src/searcher/final-simulation-work-runtime.ts:49-145,291-461,463-535,570-724 |
| [VEF] | DS scheduler 以 producer-critical、producer-bulk、exact、discovery 分 lane，并为 producer 预留 transport capacity | DS@466cf84f:listener/src/searcher/reth-transport-scheduler.ts:1-13,30-35,46-118,160-218 |
| [VEF] | DS background transport 支持 idempotent、abort-aware 的抢占与重试，critical 串行、foreground 可并发 | DS@466cf84f:listener/src/searcher/live-reth-read-priority.ts:28-145,181-234 |
| [VEF] | DS 记录了 28-35s hot state、126-166s startup、8-17s header read、900+ probes 造成 15-20s heavy block 等真实慢路径 | DS@466cf84f:docs/research/design/blockscan-current-n-latency-recovery-20260727.md:54-65,635-676；blockscan-runtime-loop.ts:1222-1240,2818-2887 |
| [VEF] | 旧 DS 的 end-to-end P95 <10s 是验收目标，不是已达事实；归档结论是 implemented_not_fixed | DS 设计文档:540-565,625-629 |
| [VEF] | 旧 TokenEdge/PoolEntry 仍包含 V2/V3/V4/Curve、factory、poolId、fee、storage/taxonomy 等协议形状及 legacy registry 语义 | impl@d33c8b48:listener/src/searcher/planner/token-graph.ts:43-170,196-252 |
| [VEF] | 旧六步具备 canonical hash、ordered prefix、cross-step commitment，但 stage 仍是 discovery/route/quote/plan/final-sim/EV | impl@d33c8b48:listener/src/shared/evidence/semantic-six-step.ts:3-22,42-90,164-258 |

### 3.3 事实边界

[VEF] 上表只说明冻结代码与归档记录做过什么；不说明 Aloha 已实现、已测试、已部署或满足预算。

[PFD] 任何旧 live 数字只用于定义回归基线和预算理由。旧实现、旧脚本、旧 fixture、旧数量与旧
verdict 都不是 Aloha correctness oracle。

## 4. Existing mature architecture decisions retained

### 4.1 直接保留的设计

| 标签 | 成熟设计 | Aloha 保留方式 |
|---|---|---|
| [MDR] | fixed number+hash cutoff | canonical-source package 签发不可变 SourceView；所有 observation、request、memo、ready 与 evidence 绑定它 |
| [MDR] | single-writer durable CAS | checkpoint package 保留 revision CAS、fsync、atomic rename、损坏 fail closed |
| [MDR] | durable per-candidate outcome + restart 差集 | 用 opaque key 恢复，不使用数组 index 或 completed-only checkpoint |
| [MDR] | verified memo 与 route handle 分离 | 只持久化 canonical identity、descriptor、static projection memo 与 proof；live handle 由当前 plugin 重签发 |
| [MDR] | source-keyed settled + inFlight single-flight | 提升为中央通用 shared-work cache；Family 只定义完整 key 与 build 函数 |
| [MDR] | immutable ready topology | readyGeneration 同一 CAS 固定 catalog、Graph、coverage、cutoff 与 accounting |
| [MDR] | bounded worker pool + deterministic result order | 保留 per-index result assembly；按 RPC/REVM/lane/Family 再分配容量 |
| [MDR] | producer transport reserve 与抢占式 background | 保留按 physical request 获取 permit、abort 清 queue、producer critical reserve |
| [MDR] | final-sim reserved capacity | final-sim 不与 discovery、attestation、exact 共用 worker 或 daemon |
| [MDR] | caller mode 局部放宽 EIP-3607 | 只允许 impersonated internal frame；最终顶层交易 simulation 始终严格 |
| [MDR] | transport fact 与 Family decision 分离 | transport只返回returned、reverted或transportFailure；framework/plugin contract defect单独形成invalidProgram，绝不伪装成transport fact或链上否定 |
| [MDR] | semantic hash + causal chain + process anchor | 由新 Evidence Schema 重写字段，但保留内容寻址、ordered chain、exact SHA/PID/starttime |

### 4.2 保留成熟路线的判定门

[PFD] 任何旧资产在进入 Aloha 前必须得到 ReuseReceipt，至少包含：

~~~text
oldSha
oldPath
selectedSymbolOrRange
oldContentHash
newPath
dependencyClosureHash
authorityOwned = false
familyBranches = none for central assets
schemaRoundTrip = pass
failureSemantics = declared
acceptanceEvidenceRefs
reviewer
~~~

[PFD] 如果只是改名、改 import 或移动文件，而算法和语义不变，记录为原样代码复用；如果删除了
旧类型、旧 authority、Family 分支或 handwritten DTO，则记录为边界重写。不能把大段重写包装成
“原样复用”。

## 5. Legacy architecture/code reuse matrix

### 5.1 判断代码

| 代码 | 结论 |
|---|---|
| R0 | 原样代码复用：文件或明确 symbol 可复制；只允许 import 路径和 license header 的机械调整 |
| R1 | 成熟设计复用：保留合同与算法，按新 port 实现 |
| R2 | 提取纯算法：只拿无 authority 的局部算法 |
| R3 | 按新接口重写：旧边界、状态或依赖不可进入 |
| R4 | 完全废弃 |

[PFD] 为避免表格重复长前缀，§5只允许以下可机械展开的locator缩写；它们仍是exact SHA:path引用：

- `impl@d33c8b48 <bare-searcher-file>` = `impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:listener/src/searcher/<file>`；
- `impl@d33c8b48 venues/...`、`planner/...`、`solver/...`、`execution/...`、`detector/...` = 同SHA的`listener/src/searcher/<written-path>`；
- `impl@d33c8b48 shared/...` = 同SHA的`listener/src/shared/<remaining-path>`；`impl@d33c8b48 analysis ...` = 同SHA的`analysis/src/<remaining-path>`；
- `DS@466cf84f <bare-searcher-file>` = `DS@466cf84fe7791baa848974af32ff1b502bfd103c:listener/src/searcher/<file>`；
- 以`src/`、`listener/`、`analysis/`、`scripts/`或`docs/`开头的path从repo root解析；冒号后的`:a-b`始终是冻结object的`nl -ba`行号。

[PFD] `source存在`或`test存在`只标记审计locator，不是运行证据；表中所有未执行效果均标[MTM]。若路径不
符合上述唯一展开规则，必须在单元格写完整SHA:path，禁止靠文件名猜测。

### 5.2 中央、状态与运行时资产

| 标签 / 判断 | 旧 SHA 与路径 | 当前职责；authority / 特判 / 隐藏状态 | 证据与已知问题 | Aloha 目标；复用前合同；失效条件 |
|---|---|---|---|---|
| [ASR] R1 | impl@d33c8b48 universe-rebuild-checkpoint.ts | startup durable authority；无 Family 分支；revision、lock、pending buffer 隐藏状态 | :7-37,121-169,267-272,440-509,574-600,763-858；checkpoint/SIGTERM/stale-lock tests | packages/checkpoint；保留 CAS/flush 算法，schema 由新 codec 生成；core envelope、candidate binding、authority、Family definition 或 canonical identity 变化使对应 memo 失效 |
| [ASR] R1 | impl@d33c8b48 universe-rebuild-runner.ts | fixed-cutoff coordinator；调用 plugin lifecycle；cursor/worker state | :174-303,306-481,491-544,666-768；差集、并发、probe 测试 | packages/attestation；按 CandidateKey 恢复、worker finally flush、probe 算法保留；重写 ports、typed outcomes、per-lane schedule |
| [BRW] R3 | impl@d33c8b48 universe-rebuild-production.ts、startup-universe-rebuild.ts、main.ts startup composition | nomination/source composition，当前混合 file/pinned/override 与链上 source；拥有错误的 completeness 表述风险 | production.ts:971-976,1010-1014,1362-1546；main.ts:1259-1305 | generated/runtime-composition + packages/discovery；file/pinned/override 只能 nomination/provenance；completeness 只来自 canonical enumerator/registry authority |
| [ASR] R1 | impl@d33c8b48 strict-ready-runtime.ts、strict-ready-graph-view.ts | ready rehydrate 与 frozen Graph shell；仍依赖 TokenEdge、旧 catalog | strict-ready-graph-view.ts:20-170；检查相同 edge object 与 roots | packages/ready-generation + packages/graph；保留 immutable lease/root checks，重写 protocol-neutral edge 与 plugin handle reissue |
| [REJ] R4 | impl@d33c8b48 planner/token-graph.ts 的 PoolEntry、merge/query bridge、strict-catalog-registry-projection.ts、route-leg-registry.ts | legacy-shaped Graph/registry authority；大量 protocol fields、fallback shape、中央 adapter lookup | token-graph.ts:43-170,196-252,297-313 | 不设目标 package；永不恢复。新 Graph 只含通用 routing fact 和 opaque handles |
| [BRW] R3 | impl@d33c8b48 strict-production-runtime-session.ts | current-source session；ready instance refresh；固定 16 pool，共享 slow/fast slots | :192-223；串行 26s 根因；固定 16 未做 transport/Family isolation | packages/state-runtime；保留 deterministic per-index assembly，改为 RPC fast、REVM heavy、Family quota、explicit unresolved coverage |
| [BRW] R3 | impl@d33c8b48 strict-central-adapter-runtime.ts | provider/simulator transport 与 caller authority；手写 provenance；错误分类 | :330-364 漏字段；:412-427 caller gap 分类不正确 | packages/request-program + packages/capability-interpreters；只执行完整FrozenProgram envelope；codec mismatch/caller mode gap为invalidProgram，RPC/deadline为retryable |
| [ASR] R1 | impl@d33c8b48 final-simulation-work-runtime.ts | final-sim admission、reserved resources、queue、fence、retire；不拥有协议语义 | :49-145,291-535,570-724；final-sim tests | packages/final-sim；调度内核近原样重用，类型 port 重写；execution program schema、source/gen、safety root 变化使 receipt 不可复用 |
| [BRW] R3 | impl@d33c8b48 revm-sim-client.ts；listener/revm-sim/src/main.rs | single FIFO daemon 与 REVM engine；daemon/queue/prepared cache 隐藏状态 | client:175-261证明共享FIFO存在HOL结构；afcc07e8改为per-attest隔离但实际效果[MTM]；Rust仅impersonated frame放宽EIP-3607 | runtime/revm-workers + packages/request-program；提取REVM engine/caller-mode规则，重写有界worker pool、single-flight、request id、deadline、kill/reap |
| [ASR] R0 | DS@466cf84f live-reth-read-priority.ts | 无 authority 的 idempotent background preemption primitive；内部 active attempts/waiters | :28-145,181-234；13 个 race/abort tests | packages/scheduler/src/preemptible-background.ts；允许原样代码复用，由外层 bounded scheduler 提供 queue cap 与 Family quota；只有该 primitive 语义变化才重跑其消费者合同 |
| [ASR] R1 | DS@466cf84f reth-transport-scheduler.ts | physical-request permit、lane reserve、active/queued metrics；固定四 lane，无 queue cap/Family fairness | :1-13,30-35,46-118,160-218；scheduler tests:26-98 | packages/scheduler；保留 reserve/abort/release 算法，扩展通用 WorkClass、bounded ingress、per-Family fairness；调度 policy 变化不使 semantic memo 失效 |
| [ASR] R2 | DS@466cf84f blockscan-state-coordinator.ts | topology/state compilation、static read dedupe、per-family deadlines、CAS；混有旧 topology publication authority | :345-378,805-818,1677-1774,1849-2104,2672-2854,3351-3572 | packages/state-runtime；只提取 physical read dedupe、changed-set compile、family-local settlement、canonical CAS；旧 live topology publication不移植 |
| [BRW] R3 | DS@466cf84fe7791baa848974af32ff1b502bfd103c:listener/src/searcher/{blockscan-runtime-loop,discovery-backfill-lane}.ts | producer orchestration与性能调度；混有 N-1 fallback、旧 Graph/state/solver/final submission | loop:800-903,1165-1240,1260-1347,2787-2910,3672-3685；backfill:200-262,446-490 | apps/searcher-runtime + packages/producer；提取 head sequencing、critical header、exact budget、yield telemetry；拒绝 N-1 authority与旧 topology mutation |
| [ASR] R1 | impl@d33c8b48 canonical-header-journal.ts、producer-generation-freeze.ts | canonical header proof 与禁止 producer publication；journal size/process state | generation-freeze.ts:1-12；canonical journal tests | packages/canonical-source + packages/producer；保留 hash/fence原则，重写为 SourceView 与 GraphView lease |
| [BRW] R3 | impl@d33c8b48 shared/state/anvil-pool.ts、state-backend.ts、live-state-backend.ts | fork/state access 与 worker lifecycle；旧 pool、source fallback、transport ownership | state/backend/reorg/abort tests | packages/state-runtime/fork-port；提取 fork lease、reset cancellation、source pin；不得授予 topology、identity 或 exact authority |

### 5.3 Family、capability、planner 与执行资产

| 标签 / 判断 | 旧 SHA 与路径 | 当前职责；authority / 特判 / 隐藏状态 | 证据与已知问题 | Aloha 目标；复用前合同；失效条件 |
|---|---|---|---|---|
| [BRW] R3 | impl@d33c8b48 venues/adapter-family-plugin.ts、adapter-family-runtime.ts | 超大 Family contract 与 runtime helpers；混合多个 domain、手写 validation | capability/family tests 多，但核心 contract 单体过大 | packages/family-sdk + packages/capability-contracts；拆成稳定 core envelope 与独立 capability module；core 变化才全局失效 |
| [ASR] R1 | impl@d33c8b48 venues/capability-content-hash.ts、canonical-value.ts | source closure 与 canonical hash；无链上 authority，但 TypeScript/旧 contract version 耦合 | capability-content-hash.ts:23-161,164-267；canonical-value.ts:10-113 | packages/artifact-fingerprint；保留 dependency-closure 算法，改用跨语言 schema codec；未声明 capability 不进入 Family closure |
| [BRW] R3 | impl@d33c8b48 venues/adapter-request-program.ts | request/effect schema、freeze、fingerprint、result validation；拥有 issued-object boundary | :29-45,56-207；:755-823,1766-1818 静默漏字段 | specs/capability-index + packages/canonical-codec + packages/request-program；必须全量schema-derived，禁止手写复制；schema/interpreter/authority/program变化使request fingerprint变化 |
| [ASR] R1 | impl@d33c8b48 venues/swaps/univ4-family/nomination.ts:43-182 | Family-local recent Swap index；settled/inFlight cache；provider/key maps | 并发四 nomination 单 scan、hash change不复用、失败可重试 tests:193-309 | packages/shared-work + families/univ4；通用 cache 抽中央，UniV4 key/build 留 plugin；key schema变化使 settled cache失效，不影响 identity memo |
| [ASR] R2 | impl@d33c8b48 venues/**-family 下 ABI、selector/topic常量、pure math、fee rule、pool-key、pricing helper | Family 语义；不应拥有中央 authority；部分文件 import 旧 DTO/constants | 旧tests/live记录仅作定位，未在本轮执行[MTM] | families/<family>/kernel；统一默认提取pure symbol并重绑新codec，绝不把该glob视为R0；pluginCodeHash或声明capability变化只失效本Family |
| [ASR] R1 | impl@d33c8b48 venues/**-family/{identity,reverse-binding,instance,pricing,exact,execution,action,victim}.ts | 协议语义与链上 proof；Family authority；常依赖旧 SDK shape | 已有 Family tests；V2/V3 factory、V4 reverse binding、Curve registry 等路线成熟 | families/<family>/capabilities；算法保留、全部重绑新 SDK；canonical identity/request/action hash变化只失效本 Family |
| [BRW] R3 | impl@d33c8b48 venues/**-family/{manifest,routes,codec,capture,discovery}.ts 与 *-family-plugin.ts | plugin assembly、old capture/route DTO 与 schema手写；Family authority | capture/parity形状与旧 catalog耦合 | families/<family>/manifest + capability-local schema-derived codec；manifest和schema重写，nomination/identity算法可调用旧提取 kernel |
| [REJ] R4 | impl@d33c8b48 production-family-composition.ts、production-families/loader.ts、family-capability-shadow.ts、strict-catalog-registry-projection.ts | 手写中央 composition、shadow catalog与legacy facade | 新 Family 仍需碰中央 loader/registry；名称含 strict 不改变边界 | 由 build-time manifest discovery 生成 catalog；中央只 import generated artifact |
| [BRW] R3 | impl@d33c8b48 planner/planner.ts、solver/{solver,plan-builder,quoter,pool-state-updater,victim-apply,post-impact-overrides}.ts | route enumeration、sizing、exact、victim与protocol state混合；import旧 TokenEdge/Family math | old route/solver tests和live路径可作算法参考 | packages/planner + packages/solver + packages/exact；中央只处理通用 edge、opaque choice/handle；Family math经 capability port调用 |
| [ASR] R2 | impl@d33c8b48 solver/{amount-bounds,amount-propagation,v2-constant-product-math,v2-fee,v3-math,v4-math,curve-math}.ts | 纯数值算法与协议数学；当前位于中央 | mathematical tests；中央 import协议 math违反边界 | 通用 amount bounds留 solver；V2/V3/V4/Curve math移动对应 Family kernel，不得由中央 import |
| [REJ] R4 | impl@d33c8b48 listener/src/compiler.ts | old registry lookup、skip/empty fallback | :12-15,30-57 明确 adapterId 分派并跳过 skip | 不移植；packages/execution-program 只按 generated ActionOwner handle 编译，unknown owner fail closed |
| [ASR] R1 | impl@d33c8b48 final-simulation runner、solver/final-verify-gate.ts | mandatory simulation与profit floor；中央 safety | final-sim worker tests；旧 EV字段需剥离 | packages/final-sim + packages/safety；保留 mandatory gate，输入改为 sealed ExecutionProgram 与 SafetyContract |
| [BRW] R3 | impl@d33c8b48 standing-guard.ts、execution/bundle-router.ts | standing-position double guard、dry-run router、production signer；marker path与legacy taxonomy耦合 | standing-guard.ts:20-47；bundle-router.ts:31-84,115-203 | packages/safety + packages/submission；保留双重 fail-closed原则与 unsigned dry-run ID，重写 marker/config、taxonomy与 signer port |
| [ASR] R1 | impl@d33c8b48 execution/submission-coordinator.ts | target-block slot arbitration；process-local slots | :23-77；无协议语义 | packages/submission；可保留 arbitration算法，但输入必须绑定 final-sim receipt、generation与deadline |

### 5.4 Solidity、验收与部署资产

| 标签 / 判断 | 旧 SHA 与路径 | 当前职责；authority / 特判 / 隐藏状态 | 证据与已知问题 | Aloha 目标；复用前合同；失效条件 |
|---|---|---|---|---|
| [ASR] R2 | impl@d33c8b48:src/BotVM.sol | 旧execution VM、callback state、owner entry与transient slots；整体拥有旧execution authority | :7-21仅覆盖旧15 opcode中的9个；:34-55 owner/self gate；:95-209 VM | 旧contract整体R4；只可逐symbol提取无协议opcode dispatch算法到contracts/executor，重新证明opcode completeness/callback/auth；新contract hash失效execution receipts |
| [ASR] R2 | impl@d33c8b48:src/BotVMEncoder.sol | 旧bytecode encoder；与旧opcode schema强耦合 | 冻结source与Solidity tests存在，本轮未执行[MTM] | 只有新executor选择完全相同的已审计opcode encoding时提取pure encode symbol；否则R4，不保compat encoder |
| [REJ] R4 | impl@d33c8b48:src/BotVMScriptBuilder.sol | route-specific script builder与旧execution形状 | 固定旧route/action assembly | 永不移植；新program只由generated ActionOwner按versioned execution schema生成 |
| [ASR] R0 | impl@d33c8b48:src/interfaces/{IERC20,IFluidVault,IMorpho,ISwap}.sol | 四个纯 ABI interface，无 runtime authority | 冻结source；旧compile/tests只作locator，本轮未执行[MTM] | contracts/interfaces；按§5.5精确blob白名单原样复用，接口 hash进入使用它的 Family kernel closure |
| [REJ] R4 | impl@d33c8b48 src/FlashArb.sol、Constants.sol 的具体路线 | wstUSR/Morpho/Fluid/PSM/V3/V4/Curve 硬编码执行合同 | FlashArb.sol:10-17,35-82,84-180 | 永不作为通用 Aloha execution authority；协议动作必须由 plugin action owner生成 |
| [ASR] R2 | impl@d33c8b48 shared/evidence/semantic-six-step.ts、impl@d33c8b48 analysis {six-step-validation-controller,six-step-validation-lifecycle,six-step-judgment}.ts | semantic evidence、validator、controller、merge/review lifecycle；旧 stage/route/branch authority混合 | semantic-six-step.ts:42-258；controller:313-680,1403-1651；lifecycle:327-570 | acceptance/schema-codec + acceptance/validator；提取 canonical/ordered/commitment算法，重写所有 stage和控制面 |
| [ASR] R2 | impl@d33c8b48 analysis trusted-six-step-runtime-attestation.ts | SHA/PID/starttime、content-addressed inputs、secret filtering；AWS/SSM耦合 | :72-199,276-399；AWS/SSM :17-19,201-274,402-613 | acceptance/collectors；提取纯验证，部署 collector为port；AWS/SSM/path不进入core schema |
| [BRW] R3 | impl@d33c8b48 {systemic-live-gate,serial-systemic-live-evidence}.ts；DS@466cf84fe7791baa848974af32ff1b502bfd103c:analysis/src/{blockscan-kpi,blockscan-window}.ts | coverage/throughput/P95 evaluator与log parser | systemic gate:37-82；serial:26-144；DS window:49-86,300-354 | acceptance/validator + acceptance/collectors；保留计算概念，改成 exact process/run/root joins、P99与raw receipt set |
| [REJ] R4 | impl@d33c8b48 architecture-migration-fixture-replay.ts、blind-*、paired-live、shadow/capture/parity与对应成功 fixtures | 迁移、target/capture、对比 authority | 不能证明production-issued对象 | 不进入 Aloha；只允许人为损坏 evidence 用于 validator negative calibration |
| [BRW] R3 | impl@d33c8b48 scripts/deploy-node.sh 与 systemd shell | exact SHA、dry-run/live marker、wallet cap、EV gate；同时含大量旧 env/feature flags并读取私钥 | deploy-node.sh:16-23,337-380,401-480,616-696 | deploy/runtime-shell；保留 exact SHA、systemd、default dry-run、human gate；删除 legacy flags；evidence collector不得读取私钥 |
| [REJ] R4 | DS@466cf84fe7791baa848974af32ff1b502bfd103c:listener/src/searcher/blockscan-runtime-loop.ts 的N-1 fallback及runtime topology authority | 旧系统的降级 availability与mutable topology机制 | DS@466cf84fe7791baa848974af32ff1b502bfd103c:docs/research/design/blockscan-current-n-latency-recovery-20260727.md:154-177,625-676 | 不进入 Aloha correctness path；Aloha只接受current-source exact，generation只能通过完整ready CAS和安全边界adopt |

### 5.5 原样代码复用白名单

[PFD] R0是封闭的exact-file清单，不是实施者可自行扩展的资产类别。Git blob ID绑定冻结内容；复制时
ReuseReceipt另记SHA-256、license与new dependency closure：

| 冻结SHA:path | Git blob ID | R0范围 | Aloha目标 |
|---|---|---|---|
| DS@466cf84fe7791baa848974af32ff1b502bfd103c:listener/src/searcher/live-reth-read-priority.ts | 5fcb3e00e4bc59de406bab820c38ccea6df27713 | entire file；只允许机械import/license调整 | packages/scheduler/src/preemptible-background.ts |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IERC20.sol | 6235ad08ac04be0b3030678fb614bb3d9273a034 | entire interface | contracts/interfaces/IERC20.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IFluidVault.sol | 4abea40103ce2e59e1894a367c84f04a1ed71a83 | entire interface | contracts/interfaces/IFluidVault.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IMorpho.sol | 828245a0ca0bf08035c64c506edde0cf9447bc6e | entire interface | contracts/interfaces/IMorpho.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/ISwap.sol | 5eab400561a96533cf3d204e3dddc3577c0d84c3 | entire interface | contracts/interfaces/ISwap.sol |

[PFD] 以上五项之外没有R0。Pure math、ABI、codec helper即使看起来无状态，也统一是R2逐symbol提取；
authority-bearing文件、catalog、request codec、checkpoint schema、Graph type、runtime composition、planner、
REVM client、final submission与validator均不得整体复制。新增R0必须先修订本canonical并重新审计，不得由
实施Agent在ReuseReceipt中自行升级R2/R3。§5.2–§5.7明确列出的glob/紧密模块按对应row执行；任何未被这些
row机械覆盖的旧文件或symbol默认R4不移植。若实施中发现遗漏的成熟资产，必须先修改canonical新增精确row，
不能临场在R2/R3之间选择。

### 5.6 关键紧密模块的最终判断与依赖方向

[VEF] 下表的“test”只表示冻结tree存在对应source test，不表示本轮运行通过；任何live有效性均为[MTM]。
本表每行已经给出最终R2/R3/R4；不存在表外默认R2/R3，不留“以后再决定”的口子。
[PFD] 本表每个未显式写SHA的path都固定解析为
`impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:listener/src/searcher/<written-path>`；`venues/`、
`detector/`、`execution/`均在该root下；唯一`./scripts/`行解析为同SHA repo-root `scripts/`。它不是浮动
工作树引用。

| 冻结文件/紧密模块 | 旧依赖、hidden state或特判 | 冻结证据 | 最终判断 | 新依赖方向、目标与精确失效 |
|---|---|---|---|---|
| venues/family-owned-action.ts | 旧Family SDK→WeakSet/issuer identity；进程内hidden ownership | source:15-25,96-159；test/family-owned-action.ts存在，未执行[MTM] | R2提取issuer/ownership算法 | families→family-sdk issuer；handle不序列化，issuer/definition root变化失效 |
| venues/family-capability-catalog.ts | 固定capability set、owner maps与closure hidden state | source:145-239；test/family-capability-catalog.ts存在[MTM] | R3重写catalog，R2提取unique-owner/root检查 | catalog-generator→specs；runtime只读generated roots |
| generated/production-family-entries.generated.ts | 22-entry inventory artifact；依赖旧composition | source:2-47 | R2保留generated exact-set机制，文件本身不复制 | release-intent→catalog-generator→generated/runtime-composition；BOM exact equality |
| adapter-family-catalog-publication.ts | publication CAS/deep-freeze/carry；输出旧edge/catalog shape | 对应source与test/adapter-family-catalog-publication.ts存在[MTM] | R3边界重写、R2提取CAS/root算法 | attestation→instance catalog→ready；projection dependency root变化精确失效 |
| adapter-family-lifecycle-content-cache.ts、adapter-family-exact-quote-cache.ts | object identity/旧DTO cache key、process maps | 对应tests存在[MTM] | R3重写 | artifact-fingerprint→packages/durable-store；exact source/request root完整绑定 |
| adapter-family-discovery-checkpoint.ts、continuity-composition.ts、inventory-enumerator.ts、inventory-writer.ts | discovery cursor/inventory authority混合旧poolSets | 对应四个tests存在[MTM] | R3重写；仅R2提取range accounting/atomic writer | canonical SourcePlan→coverage receipt；nomination cache无omission authority |
| universe-rebuild-{probe,status}-cli.ts | probe mutates old checkpoint directly；status reads old envelope；CLI parse/process state | source存在；probe/status behavior未在本轮执行[MTM] | R3重写CLI boundary；只提取argument/status formatting R2 | apps/operator-cli通过runtime-local admin port请求同一generation-builder/writer；status只读，probe只替换retryable |
| universe-rebuild-startup-cli.ts | standalone second startup/composition path，可动态import wiring | source存在[VEF] | R4完全废弃 | apps/searcher-runtime是唯一startup；operator CLI不得创建builder或promotion authority |
| adapter-family-graph-runtime.ts | oldpublication→TokenEdge/Graph runtime bridge | source存在；旧Graph authority闭包[VEF] | R4完全废弃 | instance publication→packages/graph的唯一projection path |
| adapter-family-snapshot-inventory-closure.ts | snapshot closure/accounting依赖旧inventory shapes | source存在，测试未在本轮执行[MTM] | R3重写，R2提取exact-set accounting | discovery SourcePlan receipts→coverage root；不从memo推omission |
| venues/adapter-family-identifiers.ts、adapter-family-registry.ts | 固定Family identifiers/registry composition | source存在；fixed registry是旧composition边界[VEF] | R4 registry；identifier只作manifest数据R3 | release-intent+manifests→generated definition catalog |
| reth-adapter-work-runtime.ts | old request DTO→scheduler/transport；settled/inFlight、fairness、consumer deadline hidden state；参与字段丢失 | source:421-704,923-1022,1420-1476；test存在[MTM] | R3 payload边界，R2提取single-flight/fairness | request-program→scheduler generic port；完整FrozenProgram WorkKey |
| revm-strict-simulation-transport.ts | old request shape→Rust client；token/account拆分边界 | source:70-123与test存在[MTM] | R3重写transport schema | FrozenProgram exact pairs→runtime/revm-workers；pair/schema/source变化失效 |
| blockscan-state-read-backend.ts | source-pinned batching、semaphore、physical lifecycle hidden queue | source:208-317,1880-2036,2059-2116；test存在[MTM] | R2提取算法，ports重写 | state-runtime→scheduler/RPC port；不得importGraph/Family math |
| blockscan-state-cache.ts | source-pinned resumable raw cache | source:9-24 | R3 schema重写 | state-runtime→packages/durable-store；key含chainId/block hash/request+codec hash |
| blockscan-multicall.ts、blockscan-pass-deadline.ts | generic batching/deadline但输入旧Pool/Graph shapes | deadline test存在[MTM] | R2提取generic算法 | scheduler/state-runtime only；不得创建edge或coverage |
| blockscan-backrun-state-bridge.ts | current-N snapshot→旧PoolStateCache的第二mutable state publication；V2/V3 taxonomy | source:1-90及tests存在[MTM] | R4 bridge authority；R2仅提取source monotonicity/check算法 | blockscan/backrun直接消费同一SourceSession+state-runtime facts，不复制到第二cache |
| blockscan-enumeration-solver-{telemetry,worker}.ts | bounded worker/file writer含queue hidden state；payload仍是旧route/pricing mode | source开头及tests存在[MTM] | R3 telemetry schema；R2提取bounded writer/rotation算法 | packages/telemetry只写architecture-neutral receipts，永不影响planner/acceptance verdict |
| blockscan-view-overrides.ts | 文件中的raw PoolEntry注入production view，含legacy adapter taxonomy | source:1-55[VEF] | R4完全废弃 | 不允许operator file创建edge/instance；测试输入只在contract test process内 |
| detector/blockscan-scanner-core.ts | generic ring/path scan依赖旧TokenGraph | source存在；冻结tests/旧live未在本轮验证[MTM] | R2提取scan/ring算法 | producer→protocol-neutral GraphView/planner port |
| detector/blockscan-scanner-production.ts | production facade把AdapterRuntimeSnapshot/TokenEdge/pricing/funding合并并带degraded mode | source:1-90[VEF] | R3重写boundary；core scan算法沿上一行R2 | packages/producer→packages/planner，只收immutable GraphView/SourceSession；无degraded/default edge |
| live-backends/revm-live-backend.ts | 巨型legacy backend混合TokenEdge、compiler、victim overlay、balance slots、strict catalog与fallback | source:1-90及旧tests存在[MTM] | R4 facade；REVM transport/kernel复用已由独立rows覆盖 | state-runtime/exact/final-sim各自port；禁止重建“all-in-one backend” |
| strict-current-runtime-coordinator.ts | large facade连接ready、Family refresh、state | source存在；证据仅源码[MTM] | R4 facade，局部session思想已在R1模块体现 | 不设对应facade；producer/state/exact分owner |
| strict-catalog-consumer-diagnostic.ts | diagnostic直接消费旧strict catalog shape | source存在[VEF] | R4删除；不保compat CLI | acceptance只读Evidence/roots，不importproduction catalog |
| strict-production-family-declarations.ts | 手写/固定production declaration set | source存在[VEF] | R4文件，R2保留declaration exact-set思想 | release-intent BOM→generated catalog/runtime composition |
| strict-universe-source-fingerprints.ts | source/fingerprint hash helper依赖旧universe schema | source存在，tests未在本轮执行[MTM] | R2提取domain-separated hash算法 | artifact-fingerprint；新SourcePlan schema与authority root完整绑定 |
| strict-execution-projection.ts | Family action→旧execution DTO | test/strict-execution-projection.ts存在[MTM] | R3重写 | Family ActionOwner→execution-program schema；owner/root变化失效 |
| strict-family-lifecycle-runner.ts | identity→materialize→project choreography，依赖旧plugin envelope | test存在[MTM] | R2提取阶段状态机，R3端口 | attestation→family-sdk；typed outcome与per-instance single-flight |
| strict-identity-attestation.ts | legacy pool row、labels、adapterForLineage/fallback | test存在[MTM] | R4整体废弃；仅key/dedupe思想已重写 | opaque CandidateRecord→Family identity port |
| strict-solver-consumer.ts | env-gated second consumer/switch | source:11-19；test存在[MTM] | R4完全废弃 | planner/solver为唯一consumer |
| pinned-reth-quote-backend.ts | pinned/legacy second exact authority | test/pinned-reth-quote-backend.ts存在[MTM] | R4完全废弃 | current-source exact唯一authority |
| execution/inclusion-tracker.ts | generic inclusion/slot state，依赖旧bundle receipt | test/inclusion-tracker.ts存在[MTM] | R2提取state machine | submission只消费sealed final-sim+authorization receipt |
| scripts/deploy-ab-challenger.sh | A/B、paired deployment/cutover authority | frozen script存在 | R4完全废弃 | Aloha只有exact-SHA systemd dry-run shell |

[PFD] Family ABI与pure math不属于R0；四个Solidity interface与一个DS scheduler primitive是全部白名单，
精确SHA/path/blob见§5.5。

### 5.7 冻结 Family kernel inventory

[VEF] impl冻结generated inventory在
`impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:listener/src/searcher/generated/production-family-entries.generated.ts:1-47`
精确列出22个entry。该清单是本次复用审计分母，不是Aloha中央admission allowlist；Aloha release分母最终只
来自独立release-intent BOM与generated exact equality。

| 审计组 | 冻结entry / kernel资产 | Aloha处理 |
|---|---|---|
| Swap | angstrom-v4、curve-underlying、dodo-v2、fluid-dex、univ2-standard、univ3-standard、univ4 | 每个Family的ABI/reverse identity/math/exact/action逐symbol R2；manifest/routes/codec shell R3；新目录只在families/<id> |
| Protocol | astra-multitoken、eigenpie、erc4626-silo-redeem、erc4626、ethertoken-native-redeem、goldx、metronome-hgusdc、metronome-synth、psm、rocksolid、self-burn-native、wsteth | 保留协议proof/kernel算法，全部重绑capability/obligation schema；不得把caller/effect/debt特判移入中央 |
| Funding | balancer-flash、morpho-flash | Funding/action/repayment能力由plugin owner声明；无实例也必须有完整source partition |
| Credit | fluid-credit | Credit capability可新增局部schema/interpreter；不得改变无关Swap/Protocol dependency root或验收 |

[PFD] 每个entry实施时必须产出自己的ReuseReceipt，写明旧production entry、实际选取kernel symbol、旧/新hash、
新capability closure与事实门。冻结generated entry文件本身R2仅保留“exact set由generator产生”的机制，不能
复制为Aloha composition或把22写进validator。

## 6. Never-port deletion ledger

[REJ] 以下结构在 Aloha source、generated artifacts、runtime、logs 与 acceptance 中必须为零：

| 禁止项 | 为什么禁止 | Aloha 中的唯一替代 |
|---|---|---|
| 旧 Graph builder / buildTokenGraph 类路径 | raw rows 可越权创建 edge | Family publication → readyGeneration CAS → GraphView |
| raw universe/poolSets → edge bridge | nomination/provenance 冒充 admission | canonical enumerator + identity attestation |
| runtime topology refresh、producer内原地改Graph | active generation 失去不可变性 | next generation 独立构建，安全边界 adopt |
| continuous live publication直接改变active generation | 跨步 lineage 与 planner source 漂移 | immutable lease + atomic pointer swap |
| strict edge secondary merge | 第二 Graph authority | readyGeneration 内唯一 Graph |
| legacy/default edge、legacy quoter/exact/execution fallback | 缺 owner 时继续执行 | unknown/unowned fail closed |
| strict/legacy switch、compatibility facade | 双轨 authority | strict-only ports |
| legacy-shaped catalog/registry/PoolEntry/TokenEdge | 协议字段泄漏中央 | protocol-neutral GraphEdge + opaque handle |
| 中央按 Family id/name/address/ABI/selector/topic 分派 | 中央知道协议语义 | generated capability/action owner |
| 中央保存协议 math、storage slot、pool key | 状态 ownership 错位 | Family kernel/plugin |
| universe 与 blockscan 对同实例重复 attest | 正确性换重复工作 | startup attestation唯一authority，producer只读ready |
| publishedByFamily 整族跳过 | 一个实例成功掩盖缺失 | per CandidateKey/InstanceKey accounting |
| 数组下标或“处理到8000”恢复 | candidate order变化会错配 | content-addressed opaque key |
| candidate journal / completed-only checkpoint | crash后丢结果或错授coverage | per-outcome durable run envelope |
| 手写 TokenEdge、success fixture | 制造production事实 | production-issued object + raw locator |
| capture/parity/shadow/paired-live为truth | 只证明对比，不证明链上事实 | independent fact validator |
| 为旧测试保留export或失败后接回旧authority | 旧形状重新load-bearing | 删除旧test shape，按新contract写regression |
| N-1 或任意旧状态授权 exact/execution | state freshness不成立 | current-source exact + final canonical fence |
| 单shared FIFO REVM daemon | head-of-line blocking | bounded isolated single-flight workers |
| per-attest无界daemon | 进程/内存无backpressure | fixed worker pool + queue cap |
| global EIP-3607 disable | 扩大simulation语义 | explicit per-call executionMode |
| decode异常/0x/revert由中央永久reject | plugin bug变链上否定 | typed transport facts + plugin decision |
| AWS/SSM、固定主机/path进入validator core | 环境实现变correctness contract | read-only collector port |

## 7. Final repository/package layout

[PFD] 最终仓库按 authority 边界组织，不按旧目录镜像：

~~~text
/
├── apps/
│   ├── searcher-runtime/             # 只做 composition；唯一 production process entry
│   └── operator-cli/                 # status + narrow probe client；无第二startup path
├── specs/
│   ├── core-envelope/                # 稳定核心 schema + reason codes
│   ├── evidence/                     # frozen Evidence Schema
│   ├── capability-index/             # capability IDs/versions/dependencies
│   ├── authority-proof/              # architecture-neutral proof programs
│   └── release-intent/               # independently reviewed Family BOM exact set
├── generated/
│   ├── family-catalog/               # immutable definitions/data/root
│   └── runtime-composition/           # only generated imports of Family public entries
├── packages/
│   ├── canonical-codec/              # schema-derived canonical bytes/hash
│   ├── canonical-source/             # header/state-root/canonical view
│   ├── durable-store/                # one SQLite WAL content/CAS implementation
│   ├── observation/                  # raw block/log/tx ingestion
│   ├── family-sdk/                   # plugin ports + opaque handle issuers
│   ├── capability-contracts/         # versioned capability envelopes
│   ├── capability-interpreters/      # generic EVM/RPC/effect interpreters
│   ├── artifact-fingerprint/         # code/schema/interpreter closure hashes
│   ├── catalog-generator/            # pure build tool; generated/ owns artifacts
│   ├── request-program/              # issue/freeze/rehydrate FrozenProgram
│   ├── scheduler/                    # lanes, permits, quotas, backpressure
│   ├── shared-work/                  # settled + inFlight coalescing
│   ├── discovery/                    # source plans, nomination accounting
│   ├── attestation/                  # fixed-cutoff lifecycle
│   ├── generation-builder/           # sole source→attest→promotion coordinator
│   ├── checkpoint/                   # single-writer durable CAS
│   ├── catalog/                      # verified FamilyInstance publications
│   ├── ready-generation/             # atomic promotion/adoption records
│   ├── graph/                        # persisted projection + GraphView lease
│   ├── producer/                     # head sessions, blockscan/backrun
│   ├── state-runtime/                # source-bound state acquisition
│   ├── planner/                      # protocol-neutral path enumeration
│   ├── solver/                       # amount scheduling + opaque choices
│   ├── exact/                        # current-source exact coordinator
│   ├── execution-program/            # ActionOwner compile + safety contract
│   ├── final-sim/                    # reserved simulation runtime
│   ├── submission/                   # unsigned dry-run / authorized port
│   ├── safety/                       # repayment/conservation/standing/EV gates
│   ├── evidence-emitter/             # native immutable EvidenceEvent writer
│   └── telemetry/                    # metrics only; never authority
├── families/
│   └── <family-id>/
│       ├── manifest/
│       ├── kernel/                    # ABI/math/reverse-binding
│       └── capabilities/              # nomination/identity/state/exact/action
├── runtime/
│   └── revm-workers/                 # isolated single-flight worker protocol
├── contracts/
│   ├── executor/
│   └── interfaces/
├── acceptance/
│   ├── schema-codec/                 # generated independently from specs
│   ├── validator/                    # no production imports
│   ├── adapters/impl-readonly/
│   ├── authority-proof-interpreters/ # generic replay of declared proof programs
│   ├── collectors/
│   ├── negative-corpus/
│   └── cli/
└── deploy/
    ├── systemd/
    └── runtime-shell/
~~~

[PFD] generated/runtime-composition 是唯一允许 import families/<id>/public-entry 的文件集合；它完全由
release-intent BOM + manifests 生成，禁止手写分支，并同时输出source hash、executable closure root与
definitionCatalogRoot。apps/searcher-runtime 只 import 该content-addressed generated module和中央ports，
不得直接import某个Family。packages/**永不importfamilies/**。

## 8. Authority and dependency rules

### 8.1 Authority ownership

| 模块 | 唯一拥有的 authority | 不得拥有 |
|---|---|---|
| canonical-source | CanonicalSourceView(number/hash/stateRoot) | Family identity、Graph、quote |
| durable-store | SQLite writer lease、immutable content bytes、transaction/fsync/GC primitives | outcome语义、ready/current root选择 |
| observation | immutable raw observation receipt | identity completeness、edge |
| Family plugin | protocol meaning、canonical identity、descriptor、route memo、state/exact/action interpretation | canonical header、CAS、scheduler permit |
| generated/family-catalog | release内Family/capability/action exact set及roots | 链上实例admission |
| release-intent | 人工审阅的release Family BOM exact set | plugin执行、链上实例admission |
| attestation | fixed-run candidate partition与typed outcome | plugin protocol verdict |
| generation-builder | one in-progress build lease、编排顺序、唯一PromotionCallerToken | candidate verdict、checkpoint revision、ready/Graph authority |
| checkpoint | durable revision与atomic envelope | outcome语义 |
| catalog | verified instance publication set | raw nomination |
| ready-generation | cutoff/catalog/coverage/Graph同一CAS的ready authority | current-source state |
| graph | persisted generic edges与immutable GraphView lease | protocol math、live topology mutation |
| producer | source-bound session与candidate lineage | Graph publication |
| state-runtime | current-source sealed state facts | identity/admission |
| planner/solver | generic path与amount schedule | Family dispatch、protocol math |
| exact | current-source exact orchestration | legacy quote fallback |
| execution-program | owned action assembly与program hash | unknown action guessing |
| final-sim | real simulation receipt | chain identity、quote creation |
| submission | dry-run receipt或显式授权的external port | 签名授权本身 |
| evidence | immutable事实记录 | 创建candidate/edge/quote/program/success |
| acceptance | fact query与validation verdict | production object creation |

### 8.2 允许依赖

[PFD] 依赖只能向下：

~~~mermaid
flowchart TD
  APP["apps/searcher-runtime"] --> PROD["producer / planner / exact / execution / final-sim"]
  APP --> GEN["ready-generation / graph / attestation"]
  APP --> COMPOSE["generated runtime composition"]
  COMPOSE --> CAT["generated/family-catalog"]
  COMPOSE --> FAM["families/* public entries"]
  CAT --> SDK["family-sdk + capability contracts"]
  FAM --> SDK
  FAM --> KERNEL["family-local kernel"]
  PROD --> SDK
  PROD --> CORE["canonical-source / codec / scheduler"]
  GEN --> SDK
  GEN --> CORE
  ACCEPT["acceptance"] --> SPEC["frozen specs only"]
  EMIT["evidence-emitter"] --> SPEC
~~~

### 8.3 禁止依赖

[PFD] 构建必须用 dependency rules 阻止：

- packages/** import families/**；
- 一个 Family import 另一个 Family 的内部实现；
- planner、solver、state-runtime、execution-program import protocol ABI/math；
- acceptance import apps/**、packages/** production implementation 或 families/**；
- evidence adapter import production builder/planner/solver；
- apps/operator-cli直接打开durable DB、构造candidate或取得PromotionCallerToken；它只能读status snapshot或经
  runtime-local admin port请求同run retryable probe；
- Family import checkpoint、Graph internal container、submission 或 deploy；
- telemetry 被任一 authority decision 读取；
- generated artifact 反向 import source generator。

[PFD] 唯一例外是generated/runtime-composition对Family public entry的生成import；dependency linter要求该
文件逐字可由frozen release-intent+manifest重建，禁止任何handwritten statement。若release-intent BOM、
generated definition catalog与runtime composition exact set不完全相等，build和runtime均fail closed。

### 8.4 Failure semantics

| 事实 | 中央结果 | 是否可持久化为链上否定 | 对 ready / producer 的影响 |
|---|---|---|---|
| RPC/network/deadline/abort/queue full/resource limit | retryable / unresolved | 否 | startup阻止promotion；per-head只使相关route unavailable |
| schema decode、unknown capability/version、caller-mode contract缺失、plugin throw | invalidProgram | 否 | startup阻止promotion并要求代码修复 |
| returned(data/effects) | 交给 owning plugin | 只有plugin可形成chainProvenRejected | 由typed Family decision决定 |
| reverted(data/effects) | 交给 owning plugin，中央不推断 | 同上 | 同上 |
| plugin verified | verified | 不适用 | 可生成instance publication |
| plugin chainProvenRejected +完整binding | terminal rejected | 是，紧凑proof | 计入完整partition，不进Graph |
| canonical hash mismatch / reorg | stale source | 否 | 整个run/session fail closed |
| final simulation revert | candidate simulation_reverted | 只否定该program/source，不否定instance | 不submission |
| final-sim infrastructure failure | unresolved | 否 | 不submission，受损worker退休 |
| evidence write失败 | evidence gap | 否 | dry-run可记录失败；任何external submission必须fail closed |

## 9. Family SDK and plugin boundary

### 9.1 Stable core envelope

[PFD] Family SDK 只固定少量长期稳定概念：

~~~ts
type FamilyId = OpaqueString<"FamilyId">;
type FamilyCandidateKey = Hash;
type FamilyInstanceKey = OpaqueString<"FamilyInstanceKey">;
type CapabilityId = OpaqueString<"CapabilityId">;

interface FamilyManifest {
  familyId: FamilyId;
  pluginCodeHash: Hash;
  authorityDeclaration: AuthorityDeclaration;
  capabilities: readonly DeclaredCapabilityRef[];
  actionOwners: readonly ActionOwnerDeclaration[];
}

interface FamilyPlugin {
  manifest: FamilyManifest;
  nomination: CapabilityHandle<"nomination">;
  identity: CapabilityHandle<"identity">;
  materialization: CapabilityHandle<"materialization">;
  projection: CapabilityHandle<"projection">;
  optional: ReadonlyMap<CapabilityId, CapabilityHandle>;
}
~~~

[PFD] Candidate、Identity、Descriptor、RouteMemo、State、Choice 与 Action payload 对中央都是
schema-tagged opaque canonical bytes。中央可以校验 schema/hash/size/source/issuer，但不能解析协议意义。

### 9.2 Plugin-owned keys

[PFD] nomination capability 必须提供：

~~~ts
interface NominationCapability {
  sourcePlans(cutoff: CanonicalCutoff): readonly SourcePlan[];
  nominate(input: NominationInput): Promise<readonly OpaqueCandidate[]>;
  instanceNominationKey(candidate: OpaqueCandidate): OpaqueCanonicalKey;
}
~~~

[PFD] 同一真实实例的所有 evidence 必须得到同一 instanceNominationKey。中央按
H(familyDefinitionHash, instanceNominationKey) 形成 FamilyCandidateKey，并保留全部不同 evidence。
若两个 nomination key 在 identity 后收敛为同一 FamilyInstanceKey，视为 plugin conformance defect：
第二条不得重新 materialize/project，run 进入 invalidProgram，不能静默挑一个代表。

### 9.3 Adding a Family

[PFD] 新增 Family 的唯一 production changes 是：

1. 新建 families/<family-id>/manifest、kernel、capabilities；
2. 在独立review的release-intent BOM加入Family public entry与manifest root；
3. 由 build tool 比对BOM和manifest，生成catalog entry、runtime composition、capability closure与action
   owner roots；
4. 运行该 Family 的 contract、fact与performance验收；
5. integration owner更新生成 artifact hash。

[PFD] 中央 composition、attestation engine、Graph、planner、solver、exact coordinator、compiler、
evidence schema与validator源码不变。若新增 Family 要修改这些包，接口设计未达标。

## 10. Capability/version/invalidation model

### 10.1 Capability contract

[PFD] 使用“稳定核心 envelope + 可组合、版本化 capability module”：

~~~ts
interface CapabilityModule<Program, Output> {
  readonly capabilityId: CapabilityId;
  readonly version: SemVer;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly dependencyIds: readonly CapabilityId[];
  readonly programCodec: SchemaCodec<Program>;
  readonly outputCodec: SchemaCodec<Output>;

  issue(input: CapabilityIssueInput): FrozenProgramEnvelope<Program>;
  interpret(
    program: FrozenProgramEnvelope<Program>,
    facts: readonly TransportFact[],
  ): ProgramInterpretation<Output>;
}
~~~

[PFD] capability ID 标识语义，version 标识兼容合同，schemaHash 绑定数据形状，
interpreterHash 绑定执行/解释语义。pluginCodeHash、authorityHash 与 canonicalIdentityHash 单独绑定。
展示层 MAY 从 manifest 读取 opaque namespace/tag，但中央不得把 swap/protocol/funding/credit 固定成 union，
也不得按 namespace 分派或失效；语义只来自显式 capability ID 与 dependency closure。

### 10.2 局部指纹

~~~text
declaredCapabilityRoot =
  H(sorted(capabilityId, version, schemaHash, interpreterHash, dependencyRoot))

familyDefinitionHash =
  H(familyId, pluginCodeHash, declaredCapabilityRoot,
    authorityDeclarationHash, actionOwnerRoot)

artifactFingerprint =
  H(artifactKind,
    artifactImplementationClosureHash,
    requestedTransitiveCapabilityDependencyRoot,
    requestedAuthorityDependencyRoot,
    canonicalIdentityHashOrSubjectHash)

requestFingerprint =
  H(coreEnvelopeSchemaHash, familyDefinitionHash, capabilityId, capabilityVersion,
    canonicalSource, canonicalFrozenProgramBytes)
~~~

[PFD] familyDefinitionHash是完整release lineage，不自动成为每个memo的失效开关。每个identity、descriptor、
projection、exact/action artifact有自己的exact implementation/dependency root；只有该artifact真实读取的
capability及传递依赖进入fingerprint。未声明或未被该artifact请求的capability新增/变化不得使其memo失效。
新runtime仍记录当前familyDefinitionHash，并由current plugin对可复用旧artifact签发reuse proof。

### 10.3 Memo invalidation graph

| 变化 | 失效范围 |
|---|---|
| 某Family代码变化 | 只失效implementation closure包含该symbol/module的artifacts；完整familyDefinition lineage更新 |
| 某declared capability schema/interpreter | 只失效requested dependency closure包含它的artifacts/Families |
| 新增未被既有 Family 声明的 Credit capability | 新/opt-in Credit Family；既有 Swap/Protocol 不失效 |
| authority declaration或proof-source identity | 使用该 authority 的 Family |
| canonical identity hash | 该 FamilyInstance |
| nomination evidence变化，但identity/static validity仍成立 | 更新observation receipt；不自动失效verified identity memo |
| stable core envelope语义变化 | 显式全局revalidation |
| scheduling、telemetry、日志展示变化 | semantic memo不失效 |
| final-sim safety contract变化 | execution/final-sim receipt失效；identity memo不失效 |
| definition catalog新增独立Family | global definitionCatalogRoot变化；既有Family semantic memo仍可内容寻址复用 |

[PFD] “commit 变化”本身不是 semantic invalidation。每次部署仍需 exact runtime SHA 与新 process
anchor，但未受影响的 content-addressed Family memo 可以组合进新 ready generation。

### 10.4 Capability impact algorithm

~~~ts
function affectedArtifacts(
  before: Catalog,
  after: Catalog,
): ReadonlySet<ArtifactRef> {
  const changed = changedSchemaOrInterpreterOrDependencyRoots(before, after);
  return setOf(
    after.artifacts
      .filter(artifact => intersects(artifact.requestedDependencyClosure, changed))
      .map(artifact => artifact.ref),
  );
}
~~~

[PFD] generated catalog 必须输出 impact receipt：changed capabilities、affected artifacts/Families、reusable
memo roots、new definitionCatalogRoot。不能因global definitionCatalogRoot改变而粗暴重跑全部Family。

## 11. Schema-driven freeze / codec / rehydration

### 11.1 单一字段 authority

[BRW] impl 中 request draft、materialized request、runtime transport 与 provenance fingerprint 是四份手写
字段列表；executionMode 与 observeTokenBalances 已因此在中间层丢失。Aloha 不修某一个 copier，而是
删除所有 handwritten copier。

[PFD] 每个 core envelope 与 capability payload 只有一份可执行 schema。构建系统从该 schema 生成：

- TypeScript/Rust/Solidity 边界类型（适用时）；
- exact-key validator；
- canonical encoder/decoder；
- semantic hash 与 schema hash；
- freeze/thaw helper；
- version negotiation table；
- redaction descriptor；
- round-trip 与跨语言 golden vectors。

业务代码不得重新声明一个“较小的 materialized 类型”。内存对象、持久化 bytes、transport bytes、
fingerprint input 与 evidence input 必须来自同一 canonical bytes。

~~~text
plugin issue
  └─ schema.validate + canonical.encode
       └─ FrozenProgram { schemaRef, canonicalBytes, semanticHash }
            ├─ persist exact bytes
            ├─ transport exact bytes
            ├─ fingerprint exact bytes
            └─ decode exact bytes for owning interpreter
~~~

### 11.2 Codec policy

[PFD] CanonicalCodec 必须满足：

1. UTF-8、domain-separated hash、duplicate-key rejection；
2. address、hash、bytes 使用唯一规范形式；u256、block number、时间量使用十进制字符串；
3. 禁止 NaN、Infinity、unsafe integer、隐式浮点转换；
4. core envelope exact-key：未知 core 字段 fail closed；
5. capability extension 只有 schemaRef 已在 generated catalog 声明时才可出现；
6. 未知 capability/version 返回 invalidProgram，不得降级或忽略；
7. decode 后 re-encode 必须 byte-for-byte 等于原 canonical bytes；
8. semantic fingerprint 必须覆盖所有能改变请求、解释、effect 或安全语义的字段；
9. telemetry、queue timing 等非语义字段不得进入 semantic fingerprint；
10. schema 升级不做兼容猜测；显式 upgrader 本身是版本化、hash-bound 的 capability。

[PFD] stable core envelope 只承载所有 Family 都需要的引用：schemaRef、issuer、source、authority、
capabilityRef、canonical payload bytes、hash 与 cancellation/deadline。Credit 以后增加新字段时，新增或
升级 Credit capability schema；Swap 与不依赖该 capability 的 Protocol payload 不变化、不失效。

### 11.3 Freeze 与 rehydrate

[PFD] FrozenProgram 是 value object，不含 provider、socket、function、WeakMap token、route handle 或
其他进程对象。RouteHandle 是当前进程的 issuer-bound capability，只能由 owning Family rehydrator 从
以下内容重新签发：

- canonical identity；
- verified descriptor；
- static projection；
- evidence memo；
- 当前 generated catalog 的 Family/capability closure；
- 当前 canonical authority binding。

[PFD] rehydrator先复核schema hash、Family ID、当前requested artifact dependency root、authority、identity与
current plugin签发的reuse proof，再生成不可序列化handle。完整familyDefinitionHash可因无关capability变化
而不同，但当前definition和原definition都进入lineage。反序列化旧handle、伪造plain object或跨Family使用handle
必须失败。Handle 重签发不等于重新 attest；只有依赖 closure 失效才需要重新 attest。

### 11.4 防丢字段合同

[PFD] 每个 schema 的 release gate 至少包括：

- issue → freeze → persist → load → rehydrate → transport 的 canonical bytes 全等；
- TypeScript → Rust → TypeScript round-trip；
- 每个字段单独 mutation 后 semantic hash 必变（声明为 non-semantic 的字段除外）；
- 删除字段、未知字段、未知 version、错误 issuer、错误 schema hash 均 fail closed；
- capability interpreter 不能读取未声明依赖；
- generated declaration audit 证明 runtime 使用的 schema exact set 等于 catalog exact set。

[PFD] 这些是 contract conformance，不是 production 成功证据。真实成功仍由第 19–23 节的事实协议验证。

## 12. Request / effect / error contract

### 12.1 中央只报告 transport fact

[PFD] request runtime 的公开结果只有事实，不含协议 verdict：

~~~ts
type TransportFact =
  | { kind: "returned"; requestId: Hash; data: Bytes; source: SourceAnchor }
  | { kind: "reverted"; requestId: Hash; data: Bytes; source: SourceAnchor }
  | { kind: "transportFailure"; requestId: Hash; failure: RetryableTransportFailure };

type ProgramInterpretation<O> =
  | { kind: "verified"; output: O }
  | { kind: "chainProvenRejected"; proof: ChainRejectionProof }
  | { kind: "retryable"; failure: RetryableFailure }
  | { kind: "invalidProgram"; defect: ProgramDefect };

type AttestationOutcome =
  | { kind: "verified"; memo: VerifiedMemoDraft }
  | { kind: "chainProvenRejected"; proof: ChainRejectionProof }
  | { kind: "retryable"; failure: RetryableFailure }
  | { kind: "invalidProgram"; defect: ProgramDefect };
~~~

[PFD] returned 0x、revert、空 effects、decode throw、同批另一个 request 的结果，都不能被中央组合成
terminal rejection。只有 owning plugin 对自己的完整 request/effect facts 解释后，才能返回
chainProvenRejected。Plugin throw、codec mismatch、缺 request result、非法 caller mode、ABI/program
形状错误属于 invalidProgram；RPC、deadline、abort、queue full、worker crash、resource limit 属于
retryable。

[PFD] invalidProgram 与 retryable 都阻止 startup ready；二者区别是 invalidProgram 需要修代码或合同，
不得无限自动重试，retryable 可以按有界 policy 重试。二者均不是链上否定，不能永久排除实例。

### 12.2 通用 effect simulation program

[PFD] Family 通过 versioned capability 声明完整 effect program，中央不识别 Family：

~~~ts
interface EffectSimulationProgramV1 {
  caller: {
    ref: AccountRef;
    executionMode: "top-level-transaction" | "impersonated-internal-call-frame";
  };
  preCalls: readonly FrozenCall[];
  callProgram: readonly FrozenCall[];
  observe: {
    tokenBalances: readonly { token: AddressRef; account: AccountRef }[];
    accounts: readonly AccountRef[];
    logs: boolean;
    storage: readonly StorageObservation[];
  };
  invariants: readonly DeclaredInvariant[];
}
~~~

[PFD] token/account observation 是精确 pair list。transport 必须原样传递 pairs；严禁分别传 tokens 与
accounts 后在 Rust 侧做 Cartesian product。排序、去重若发生，必须对 pair canonicalize，且 semantic
hash 覆盖排序后的完整 pair set。

[MDR] impersonated-internal-call-frame 表示“该地址作为内部 CALL 的 msg.sender”而不是“该地址能签署
顶层交易”。只有这一明确模式可在对应 strict effect simulation frame 关闭 EIP-3607；
top-level-transaction 与最终 simulation 始终保持 EIP-3607。禁止全局关闭。

### 12.3 Plugin verdict 与 proof binding

[PFD] ChainRejectionProof 必须同时绑定：

~~~text
familyDefinitionHash
requestFingerprint
authorityHash
cutoff.number + cutoff.hash
identitySubjectHash
ordered transport-fact root
plugin decision code
plugin decision bytes hash
~~~

[PFD] identitySubjectHash在已verified identity时是canonicalIdentityHash；若链上否定发生在identity前，则是
CandidateRecord中exact claimed subject bytes的commitment，不得伪造FamilyInstanceKey或声称已验证identity。

[PFD] 任一 binding 变化必须复验。chain-proven rejection 只能在同一 fixed-cutoff run 内作为 terminal
partition 结果复用；新 cutoff 即使 block number相近也必须重新让 plugin 判断，不能跨窗口永久排除。
Verified memo 是否跨 cutoff 复用则由其显式 validity dependencies 决定，不能套用 rejection policy。

### 12.4 Cancellation 与资源失败

[PFD] logical deadline 必须发出 cancellation，但 physical permit 只有在 socket/request/worker 真正结束
或被 kill/reap 后才释放。忽略迟到结果不等于资源已释放。每个 result 绑定 requestId、source、worker
epoch；stale epoch 的迟到结果必须丢弃并记录 telemetry，不能进入 interpretation。

[PFD] request runtime 输出 reason code catalog；reason code 是稳定机器字段，不包含协议名称。Family
可在自己的 extension schema 中提供协议解释，但中央调度只依据 retry class、work class、deadline 与
resource cost，不依据 Family 名称。

## 13. Complete runtime sequence

### 13.1 Identity coverage 与 50-block observation 分离

[PFD] 50-block window 固定为：

~~~text
recentObservationRange = [max(chainGenesis, cutoff.number - 49), cutoff.number]
~~~

[PFD] 它只回答“近期发生了哪些可观察行为，可形成哪些 edge/activity evidence”。它不回答“链上历史
存在过哪些实例”。完整身份 inventory 必须来自每个 Family 声明的 canonical SourcePlan：registry/
factory 在 cutoff 的 point-in-time enumeration，或具有完整 cursor 的历史 source。历史 event scan只能
补充声明为event-dependent的Family source，且必须有
显式 from..to 与 coverage proof；不能用全局 protocol cursor 或最近 50 blocks 冒充完整性。

[PFD] 仍有效的verified memo可以carry一个已知实例、避免重复identity/materialization，但绝不证明没有
其他实例，也不贡献omission/complete source coverage。只有先前durable CoverageCertificate本身来自complete
snapshot/history、且通过连续canonical extension更新到新cutoff时，才可复用coverage；memo本身不是certificate。

[PFD] file、pinned、score、competitor hit 与 runtime observation 都只能 nomination/provenance；它们不能
授予 omission authority。每个 SourcePlan 必须声明 completeness semantics：complete snapshot、contiguous
history、point lookup 或 nomination-only；只有前两类可贡献对应 partition coverage。

### 13.2 Candidate 与 instance 去重

[PFD] 所有 startup source 结果先合并，再按 plugin-owned opaque key 去重：

~~~text
FamilyCandidateKey =
  H("aloha/family-candidate/v1", familyDefinitionHash, instanceNominationKey)

RunCandidateKey =
  H("aloha/run-candidate/v1", runId, FamilyCandidateKey)

FamilyInstanceKey =
  plugin-issued canonical opaque identity key after reverse verification
~~~

[PFD] FamilyCandidateKey 是稳定候选身份，不包含 rolling cutoff；run/cutoff 由 RunCandidateKey 与 run
envelope 绑定。候选的所有不同 log/tx evidence 都保留完整日志身份：block number+hash、txHash、logIndex、
address、topic 与 opaque pool/instance hint；去重不能把多个证据压成一条不知来源的 observation。

[PFD] 同一 run 每个 FamilyCandidateKey 只调用一次 identity。多个 candidate 收敛为同一
FamilyInstanceKey 时，中央在identity phase后停止第二次materialization/projection，并把完整evidence挂到
同一instance group。但若它们的instanceNominationKey不同，说明plugin key没有表达“同实例”合同：run记录
nomination-key-collision invalidProgram并阻止ready，不能静默把错误key合法化。只有candidate evidence在
同一FamilyCandidateKey内的alias聚合是合法dedupe。通过run因此保证每个Instance lifecycle恰好一次。

### 13.3 唯一 startup 路径

[PFD] 启动顺序固定：

1. 先load并校验checkpoint root；
2. 若有inProgressRun，复核其原cutoff仍canonical、definition/dependency roots兼容，然后直接恢复其已持久
   candidate partition、source coverage和outcomes；不得先freeze新head或重扫50 blocks；
3. 若旧run cutoff已stale，先单独CAS seal stale诊断；只有无可恢复run时才获取新cutoff；
4. 新run执行全部declared SourcePlan，形成source coverage receipt；
5. 新run扫描恰好50 blocks recent observation；
6. 合并nomination，原子持久化exact CandidateRecord set/root后才开始attestation；
7. 用memo impact graph计算verified reuse、需要复验与未决集合；
8. identity phase每CandidateKey一次；按FamilyInstanceKey分组后instance phase每Instance materialize/project一次；
9. bounded workers只处理差集；single writer途中持久化；
10. retryable/invalidProgram/pending非零时保持durable incomplete；
11. exact partition、source coverage与canonical fence全部成立后构造catalog/Graph；
12. 一次CAS promotion为readyGeneration，从其签发immutable GraphView，再创建producer。

[PFD] Recent observation只有在Family声明recent-behavior capability时才进入其projection dependency root：
例如“近期有行为”可改变active edge/priority，但“近期无行为”不能删除canonical identity。未声明该capability
的Family只把50-block facts作为nomination/telemetry；声明者必须给出如何从完整50-blockreceipt生成projection
的schema与validity，变化只失效该capability closure。

[PFD] 未完成 candidate 的临时 queue 只属于当前 inProgressRun；它是持久化 run partition 的调度视图，
不是独立 candidate journal。未来 generation 的 mempool/log hint 可以放入有界、可丢弃的 nomination
hint buffer，但该 buffer 无 admission/coverage authority；下一 builder 仍必须执行 declared SourcePlan。

### 13.4 Producer 与 next generation

[PFD] producer session 持有 SourceSession 与 GraphView lease。session 生命周期内 generationId、cutoff、
definitionCatalogRoot、instanceCatalogRoot、graphRoot与edge object set不变。Producer不执行discovery、backfill identity、trace
discovery、attestation、Graph publication 或 topology mutation。

[PFD] 背景 MAY 在隔离的 builder namespace 准备下一 generation，但必须：

- 使用独立 runId、checkpoint namespace、SourceView 与 roots；
- 不写 active GraphView；
- 不占用 producer critical/final-sim 保留资源；
- 未 ready 时不得影响当前 producer；
- 只能在 head session 全部释放 lease、无 in-flight plan/exact/final-sim 的明确 adoption barrier 原子切换。

[PFD] 新 generation 失败只留下可恢复的 incomplete run；当前 active generation 不回滚、不被局部覆盖。

### 13.5 Generation refresh policy

[PFD] 不靠cron、producer callback或continuous publication保持近期性。独立GenerationBuilder按versioned
GenerationRefreshPolicy运行：observationWindowBlocks=50、targetRefreshAgeBlocks=20、
maxServingAgeBlocks=50、minPromotionMarginBlocks=2、maxInProgressRuns=1。触发条件是active cutoff年龄达到20 blocks、definition/
dependency root变化或operator显式重试已存在run；
它freeze新cutoff并构建完整next generation，成功后只在adoption barrier切换。

[PFD] packages/generation-builder是唯一允许取得GenerationBuildLease与PromotionCallerToken的coordinator；
它自身不拥有candidate verdict、checkpoint revision、catalog/Graph或ready authority，只按ports编排。apps/
searcher-runtime只能start/stop它，discovery、attestation、checkpoint和ready-generation包都不能反向调用或
另建第二条startup/promotion路径。

[PFD] Builder失败时保留inProgress并按failure policy/probe恢复；active generation在年龄≤50且仍canonical/
closure-valid时继续服务。年龄>50仍无新ready则阻止新producer sessions并发出fail-closed stale-generation
receipt，不能无限用旧50-block behavior window。Policy hash进入ready、runtime和performance evidence；调度
参数变化不使Family identity memo失效。

[PFD] Cold first boot可能需要超过promotion freshness margin才能建立12k-scale identity/memo集合；任何
完成时已超过margin的run只能成为durable memo seed，禁止把其早期cutoff直接promotion。Seed完成后必须立即freeze新cutoff，重新执行该cutoff的完整
SourcePlans与50-block observation，并用plugin reuse proofs只复验新增/失效/retryable差集；只有这个fresh
finalization run可promotion。这样cold成本被持久化复用，但ready在签发时仍满足serving-age合同。

## 14. Durable persistence / restart / probe

### 14.1 逻辑 envelope 与物理存储

[MDR] 逻辑 authority 仍是一个 envelope：verifiedMemos + one inProgressRun + readyGeneration。
[PFD] packages/durable-store的首个production实现固定使用同一个SQLite WAL数据库（WAL mode、
foreign_keys=ON、synchronous=FULL）保存immutable content tables、mutable indexes与一个CAS root row；
checkpoint、catalog和Graph只能通过该port读写，不得各建数据库或文件authority。不再把KV/SQLite留给实现
Agent二选一。其他backend未来必须证明相同transaction/fsync/CAS语义后另行版本化。只有checkpoint root row
revision拥有promotion pointer authority；durable-store只拥有物理durability/GC，且GC不得删除任何live root
可达content。不每25条重写数万实例JSON。

~~~ts
interface CheckpointRootV1 {
  revision: U64String;
  verifiedMemoRoot: Hash;
  inProgressRunId: RunId | null;
  latestMemoSeedReceiptHash: Hash | null;
  readyGenerationId: GenerationId | null;
  readyGenerationRecordHash: Hash | null;
  schemaHash: Hash;
}

interface InProgressRunV1 {
  runId: RunId;
  cutoff: CanonicalCutoff;
  recentObservationRange: BlockRange;
  candidateSetHash: Hash;
  candidatePartitionRoot: Hash;
  candidateRecordCount: U64String;
  sourceCoverageRoot: Hash;
  definitionCatalogRoot: Hash;
  outcomesRoot: Hash;
  accounting: {
    pending: U64String;
    verified: U64String;
    chainProvenRejected: U64String;
    retryable: U64String;
    invalidProgram: U64String;
  };
}

interface SealedMemoSeedReceiptV1 {
  runId: RunId;
  cutoff: CanonicalCutoff;
  definitionCatalogRoot: Hash;
  coreEnvelopeSchemaHash: Hash;
  candidatePartitionRoot: Hash;
  sourceCoverageRoot: Hash;
  exactOutcomePartitionRoot: Hash;
  carriedVerifiedMemoRoot: Hash;
  reason: "cutoff-too-old-for-serving";
  sealedRevision: U64String;
}
~~~

[PFD] CandidateRecord set在beginNewRun事务中以RunCandidateKey内容寻址持久化；record含compact canonical
candidate snapshot、完整evidence refs、Family definition与nomination key。candidateSetHash证明语义exact
set，candidatePartitionRoot使payload可恢复；只有hash没有records不能resume。它属于唯一inProgressRun
authority，不是独立长期candidate journal，run seal/retention后按policy回收。

[PFD] records immutable/content-addressed；更新 outcomes root、accounting 与 root revision 必须在同一事务。
DB/WAL 损坏、root 指向缺 record、hash mismatch 或 revision regression 全部 fail closed，不得退化为
append-only 或从空开始覆盖。

[PFD] completed run若在finalization时已超过serving-age，只能由single writer把verified memo合并进全局
memo root、写SealedMemoSeedReceipt，并在同一CAS清空inProgressRunId；rejection不跨cutoff carry，且绝不写
ready pointer。下一迭代必须freeze新cutoff并建立新CandidateRecord partition。Seed receipt只是durable reuse
provenance，不是coverage、catalog、Graph或ready authority。

### 14.2 途中持久化

[PFD] 一个 single writer 接收 worker completion，按确定性 key 排序后：

- 每 25 个 outcome 或最迟每 2–5 秒（先到者）事务 flush；
- verified 保存 compact identity/descriptor/static projection/evidence memo 与 validity dependencies；
- chainProvenRejected 保存本 run/cutoff 的 compact proof；
- retryable 保存 compact candidateSnapshot/evidenceRef、stage、failureCode、attemptCount、next policy；
- invalidProgram 保存相同定位信息与 schema/program defect；
- SIGTERM/SIGINT 停止领取新 work，等待有界 worker cancel/reap，强制 flush 后退出；
- writer/DB failure 取消 builder，绝不继续到 ready。

[PFD] raw log/tx 只在当前 candidate evidenceRef 或未完成 batch 需要时保留。Outcome sealed 后可按审计 retention
保留内容 hash 与外部 locator，不建立长期 raw tx inbox。人工停止后已 durable 的 outcome 不得丢失。

### 14.3 Memo reuse 与精确失效

[PFD] verified memo复用必须逐条验证：requested artifact dependency closure、authority、canonical identity、
descriptor validity、source validity与requested projection schema。完整Family definition变化本身不全量
失效；由current plugin reuse proof判断candidate→memo。rolling observation变化本身不使静态identity
memo 失效；若某 capability 声明依赖 recent behavior，则只失效该 capability/projection closure。

[PFD] chainProvenRejected 不跨 cutoff 复用。retryable 与 invalidProgram 不是 memo；restart 在同一 run 中按
RunCandidateKey 恢复。新的 run 重新计算 candidate set 与 invalidation closure，不按“上次到 8000”恢复。

### 14.4 Single-instance probe

[PFD] probe 是同一 attestation engine 的窄入口，不是旁路：

1. load runId 与 RunCandidateKey；
2. 复核原 cutoff hash/stateRoot 与 current canonical chain；
3. load exact candidateSnapshot/evidenceRef、Family definition 与 retryable failure；
4. 只执行该 key 的 attestOnce，使用相同 scheduler/codec/plugin；
5. single writer CAS 替换该 outcome；
6. 输出 before/after outcome、request/fact roots 与 raw locator；
7. 最后一个 retryable 解决后也不自动绕过 finalize assertions。

[PFD] authoritative同run probe只允许替换retryable outcome。invalidProgram表示schema/code/contract defect；
同runprobe只能生成只读diagnostic receipt，不能改outcome，修复后因closure变化开启新run。Probe不允许改
cutoff、替换candidate、跳过reverse identity或手写verified。若原hash已非canonical，整个run stale，必须
新建run；不能在旧envelope中偷换block hash。

### 14.5 Promotion 前的 exact partition

[PFD] promotion 前必须同时满足：

~~~text
pending == 0
retryable == 0
invalidProgram == 0
verified + chainProvenRejected == exact candidate count
every candidate key appears exactly once
every complete source partition has appliedThrough == cutoff
recent observation range == cutoff-49..cutoff (clamped only at genesis)
candidateSetHash / coverageRoot / definitionCatalogRoot recompute equal
canonical number+hash+stateRoot still match
generation compare-and-swap revision still match
~~~

[PFD] observedThrough、appliedThrough、正式 catalog、Graph 与 ready pointer 不得在该 assertion 前推进。

## 15. readyGeneration / Graph model

### 15.1 Atomic ready authority

~~~ts
interface ReadyGenerationV1 {
  generationId: GenerationId;
  parentGenerationId: GenerationId | null;
  generationRefreshPolicyHash: Hash;
  cutoff: CanonicalCutoff;
  recentObservationRange: BlockRange;
  definitionCatalogRoot: Hash;
  sourceCoverageRoot: Hash;
  candidatePartitionRoot: Hash;
  verifiedMemoSetRoot: Hash;
  instanceCatalogRoot: Hash;
  graphRoot: Hash;
  edgeCount: U64String;
  instanceCount: U64String;
  promotionRevision: U64String;
  promotedAtMonotonicNs: U64String;
}
~~~

[PFD] definition catalog、instance catalog、coverage、cutoff、Graph与accounting由一个transaction/CAS提升。
Graph file 先内容寻址写完并 fsync，root row 最后原子指向；崩溃只能看见旧 ready 或完整新 ready，不能
看见 cursor 领先 Graph。

### 15.2 Protocol-neutral Graph

[PFD] PersistedGraphEdge只包含通用路由事实：endpoint asset refs、direction、persistent RehydrationRef、
generic constraint refs、owning Family+Instance lineage、static projection hash。它不含v2FeeBps、v3Fee、
curveI/J、v4PoolKey、protocol name、ABI、storage slot 或中央可解释的 protocol kind。

~~~ts
interface RehydrationRef {
  familyDefinitionHash: Hash;
  instanceKey: FamilyInstanceKey;
  instancePublicationHash: Hash;
  staticProjectionMemoHash: Hash;
  requestedArtifactDependencyRoot: Hash;
}

interface RuntimeGraphEdge extends PersistedGraphEdge {
  issuedRouteHandle: IssuedRouteHandle; // process-local, never serialized
}
~~~

[PFD] Graph builder 不从 raw PoolEntry 读 RPC。它只投影已 verified、当前 closure 可 rehydrate 的
instance publications。每条 edge 绑定 publication hash；Graph root 是 canonical ordered edge set 的
Merkle/content root。Promotion只持久化RehydrationRef，不持久化handle；process打开GraphView时由owning
plugin重签IssuedRouteHandle。schema/dependency不匹配使generation invalidProgram，不能跳过后继续ready。

### 15.3 Coverage 不等于 current-state freshness

[PFD] ReadyCoverage 证明在 cutoff 完成的 identity/source partition；StateFreshness 证明某 producer head 上
exact 所用的 current-source facts。两者是不同类型、不同 root、不同生命周期。禁止把 producer 的后续
block/hash 写回 ready coverage，也禁止用 ready cutoff state 代替 current-source exact。

### 15.4 Lease 与 adoption

[PFD] GraphView 是 ready root 的只读 lease：

~~~text
GraphViewLease = H(generationId, generationRefreshPolicyHash, cutoff, definitionCatalogRoot,
                   instanceCatalogRoot, graphRoot, processEpoch)
~~~

任何 planner path、exact request、execution program 与 final-sim receipt 都绑定 lease/root。Adoption 在
head boundary 执行 compare-and-swap：active sessions=0、old lease drain、new ready canonical fence pass，
然后一次替换 active pointer。旧 lease 直到所有 holder 释放才回收；不得修改其对象。

[PFD] 所有首次serve、每次新head session admission与adoption都调用同一个validateServingLease：复算ready
完整root closure，验证cutoff仍canonical、definition catalog等于当前release、policy hash等于当前配置、
generation age不超过maxServingAgeBlocks，并验证GraphView正由该ready签发。任一不满足都关闭新session
admission并触发next-generation/recovery；不能因为active pointer已经存在就跳过。

[PFD] canonical-source提供短生命周期CanonicalFenceLease：它把本进程canonical journal更新与promotion/
adoption CAS串行化，token绑定journal epoch、number/hash/stateRoot。Graph构建不持有该锁；最终短CAS重新取得
并在事务内校验token。它不能“冻结链”，所以CAS之后的reorg仍由head listener使lease失效；首次serve和
每次session admission再次验证，确保stale ready即使作为历史content存在也永远不能load-bearing。

## 16. Producer / state / planner / exact / execution boundaries

### 16.1 Producer scheduler

[PFD] producer 只做 head sequencing、lane admission、GraphView lease 分发与 cancellation。blockscan 和
backrun 共享相同 generation，但各自有有界 ingress 与 correlationId。它们可以产生 observation hint，
却不能 admission instance 或改变 Graph。

[PFD] source session 绑定 canonical head number/hash/stateRoot；reorg 或 hash mismatch 取消该 head 全部
plan/exact/sim。旧 state 只能作为非 authority cache，命中后仍验证 source key。

### 16.2 State acquisition

[PFD] Family capability 声明 StateReadProgram；中央 state-runtime 合并相同 physical reads、batch、dedupe、
deadline 与 backpressure，再把 exact source-bound facts 交回 owning interpreter。中央不定义 V2/V3/V4/
Curve state struct，不读协议 storage slot，不做协议数学。

[PFD] shared read key 至少绑定 chainId、provider/backend epoch、source number+hash+stateRoot、request codec、
target、calldata/storage key 与 block tag。逻辑 consumers 可以各自 timeout；物理请求完成前 permit 不释放。

### 16.3 Planner 与 solver

[PFD] planner 只消费 immutable generic GraphView，输出有序 RouteHandle refs 与通用 constraints。solver 只
安排 amount/budget 与比较 owning capability 返回的 opaque evaluated choices。二者不得 import Family、
ABI、protocol math、address tables 或 protocol state；不得存在 default edge、legacy quote 或 handcrafted
route injection。

[PFD] “opaque choice”不等于opaque经济结果。Owning capability返回协议无关、schema-bound结果，中央只比较
整数资产流和通用约束：

~~~ts
interface ChoiceEvaluationV1 {
  choiceHandle: IssuedOpaqueChoiceHandle;
  source: CanonicalSourceView;
  inputs: readonly { asset: AssetRef; amount: U256String }[];
  outputs: readonly { asset: AssetRef; amount: U256String }[];
  gasUpperBound: U256String;
  valueAtRiskUpperBound: U256String;
  constraintResults: readonly {
    constraintRef: GenericConstraintRef;
    verdict: "satisfied" | "unsatisfied" | "unresolved";
    proofHash: Hash;
  }[];
  obligationRoot: Hash;
  validityRoot: Hash;
}

interface ObjectiveProfileV1 {
  numeraire: AssetRef;
  minNetGain: U256String;
  maxGas: U256String;
  maxValueAtRisk: U256String;
}
~~~

[PFD] AssetRef/amount/gas/objective/constraint verdict是稳定core经济合同，不含协议kind。unresolved constraint
不可被solver当false后绕过，整条choice不可用。协议math产生这些结果但仍由current-source exact与final-sim
复核；plugin不能定义自己的“盈利”绕过中央ObjectiveProfile。

[PFD] 如果某协议需要新的约束或选择语义，新增 versioned capability/interpreter；只有声明者进入 impact
closure。不能在 solver 写 if familyId 或扩充一个固定 protocol union。

### 16.4 Current-source exact

[PFD] exact coordinator 对 route 中每个 handle：复核 issuer/lease，取得 current SourceSession，执行 owning
StateReadProgram 与 ExactProgram，由 owning capability 解释。任何 missing owner、schema mismatch、stale
source 或 unresolved fact 使该 route fail closed。禁止 pinned-state、legacy quoter 或 N-1 fallback。

[PFD] exact 输出绑定 ordered instances root、state facts root、source anchor、amounts、constraints 与 owning
interpreter hashes。它是 execution program 的唯一价格/状态输入。

### 16.5 Execution program 与 safety

[PFD] 每个 action 由 generated catalog 中唯一 ActionOwner 编译为 schema-tagged opaque action bytes。中央
compiler 只负责有序组合、资金流引用、caller/preCall/effect contract、repayment/standing-position/
conservation obligations 与 hash；不知道 swap、vault、debt mint 或具体协议。

[PFD] standing-position guard 不是协议分类表。Family capability 声明通用 position/debt/credit obligations，
中央 safety engine 只验证“所有声明 obligation 已关闭或被明确允许”“资产守恒”“借款已偿还”。Unknown
obligation、缺声明或无法证明均 fail closed。这样新增 Credit 只新增 capability owner，不在中央新增
Fluid/Silo/Astra 名字分支，同时不会把 debt mint 当普通 swap 绕过安全门。

### 16.6 Final simulation 与 submission

[PFD] final simulation 使用独立保留 worker、当前 source、完整 execution program 与与真实顶层交易相同的
EIP-3607/nonce/value/gas语义。它必须重新验证 repayment、conservation、standing-position、generation 与
canonical fence。Effect-attestation 的 impersonated internal frame 不能降低最终 simulation。

[PFD] submission package 默认只有 UnsignedDryRunPort。任何 external signer/broadcaster 是部署时注入的
独立 port，必须同时满足用户授权、安全 envelope、exact runtime anchor、成功 final-sim 与 policy gate。
本文没有提供该授权。

## 17. Performance architecture and budgets

### 17.1 已验证的慢因，而非“统一接口天然慢”

| 标签 | 慢因/风险 | 冻结证据边界 | 终态修复 |
|---|---|---|---|
| [VEF] | UniV4同key cold index曾需要single-flight | impl@d33c8b48 nomination.ts:43-105已有settled+inFlight；这是已修成熟模式，不声称d33仍重复 | shared-work推广完整source/program key，失败删除inFlight |
| [MDR] | 多source对同instance重复lifecycle是历史暴露风险 | d33的once/per-key合同不应被描述为当前缺陷；Aloha保留不变量 | startup merged partition；每Family+Instance每run一次 |
| [MDR] | Family级carry会造成无关实例重验 | 作为禁止的粗粒度设计，不声称冻结SHA当前仍采用 | content-addressed per-instance/per-capability impact diff |
| [VEF] | 约1,700 current-source reads串行约26s | impl@d33c8b48 strict-production-runtime-session.ts:192-223 | physical-read coalescing、changed dependency set、lane reserve、bounded concurrency |
| [VEF] | 单REVM FIFO可能HOL；per-attest daemon会把进程数绑到并发 | impl@d33c8b48 revm-sim-client.ts:175-261、universe-rebuild-production.ts:566-630 | fixed isolated worker pool、single-flight、request id/deadline/kill-reap |
| [MTM] | heavy与light混队列可造成resource starvation | 目标环境实际failure mix尚待Aloha measurement，不写成d33当前事实 | fast/heavy/final-sim lane隔离、quota、retry budget/circuit breaker |
| [VEF] | background Reth read可与producer critical竞争 | DS@466cf84f reth-transport-scheduler.ts:1-13,46-118与live-reth-read-priority.ts:28-145 | producer保留physical permits，background可抢占且有界 |
| [PFD] | 2-day scan不再是recent edge contract | 这是新终态决定，不冒充旧实现事实 | recent edge窗口固定50 blocks；identity coverage走独立complete source |

[PFD] 性能修复不能通过降低 canonical fence、跳过 Family、使用 stale state、恢复 N-1 或绕过 final sim 获得。

### 17.2 Work key 与 single-flight

[PFD] 每项可共享工作必须定义 semantic WorkKey：

~~~text
H(provider/backend epoch,
  source.number, source.hash, source.stateRoot,
  capability/schema/interpreter fingerprint,
  target/source authority,
  complete request parameters,
  window/lookback/chunk)
~~~

settled cache 只保存成功且仍满足 validity 的结果；inFlight 保存当前 Promise。失败必须只删除“仍等于
该 Promise”的 inFlight entry，不污染 settled。consumer deadline 不取消仍有其他 consumer 的 shared
physical work；最后一个 consumer 退出才发 abort。

### 17.3 Lane 与 backpressure

[PFD] 至少分为：producer-critical、producer-bulk、startup-RPC-fast、startup-REVM-heavy、background-next-
generation、final-sim。每 lane 有 queue cap、concurrency、reserved permits、deadline、retry budget；每
Family/instance 有公平 quota。queue full 返回显式 retryable，不允许无限内存排队。

[PFD] RPC 与 REVM 使用不同 permit pools；final-sim 使用专属 pool。slow Family 只能耗尽自己的 heavy
quota，不能阻塞 light Family、header read 或 final sim。scheduler policy 不进入 semantic memo hash，
但其 exact version与指标进入 performance receipt。

[PFD] 第一版可直接实现的ResourceProfile起点为：

| 资源 | 初始上限 | 保留/公平约束 |
|---|---:|---|
| RPC/Reth physical requests | 8 | producer-critical保留至少4；exact+background合计最多4 |
| RPC logical batch | 500 items | provider限制更小时下调；每batch绑定source/hash/deadline |
| per-Family RPC active | 2 | 不得阻塞critical header；Family名仅作quota key，不作语义分派 |
| REVM heavy workers | 4 | 每worker single-flight；per-Family active默认1 |
| REVM waiting queue | 32 | 满则typed retryable，不扩进程 |
| final-sim workers / queue | 2 / 2 | 与identity/exact资源隔离；过期work不开始 |
| attestation logical workers | 24 | 仍受physical permits、per-Family quota与bounded queue限制 |

[MTM] 这些是初始profile而非已测最优值。impl校准与目标硬件测量可在production实现前调整并冻结
ResourceProfile hash；调整调度参数不使semantic memo失效，但必须重跑性能事实门。

### 17.4 绝对预算

[PFD] 第一版 ProductionPerformanceProfile 在 acceptance schema freeze 时固定，默认目标为：

| 指标 | 预算 / 硬不变量 |
|---|---|
| recent observation | 范围恰为50 blocks；同 source plan 的 physical scan count=1 |
| identity lifecycle | 同 run 同 FamilyCandidateKey identity count≤1；同 FamilyInstanceKey materialize/project count≤1 |
| shared work | 同 WorkKey 同时 physical build count=1；无 unbounded queue/process |
| unchanged restart | 未失效 verified memo reuse=100%；旧 verified instance attestation count=0 |
| producer header/source acquisition | P95≤1.5s，P99≤2.5s |
| eligible head terminal accounting | 连续100个 eligible canonical heads 必须100/100产生明确 terminal receipt，silent missing=0 |
| head completion | P95≤8s，P99≤11s，单head hard deadline<12s；超出即性能门失败而非丢样本 |
| planner→exact→program（有candidate） | P95≤2.5s，P99≤3.5s，不含final-sim |
| final simulation queue wait | P95≤0.5s，P99≤1s；无资源时明确fail closed |
| final simulation service / queue+service | service P95≤2s、P99≤3s；queue+service P99≤4s、hard≤5s |
| head critical-path composition | source 2.5s + planner/exact/program 3.5s + final queue 1s + final service 3s + overhead 1s = P99 budget 11s |
| restart ready reuse | 若ready仍canonical且closure不变，进程启动后≤30s签发GraphView，不全量attest |
| new generation recent scan | 50-block scan P95≤15s、hard≤30s；同source physical scan=1 |
| warm next-generation / fresh finalization | changed/retryable≤5%时P95≤120s、hard≤5min；从age=20触发，hard完成时仍须age<50，否则不得adopt |
| cold 12k-scale build | P95≤15min、hard≤30min；若完成时仍有promotion margin可ready，否则只产durable seed且原cutoff禁止promotion，不允许纯等超过hard gate |
| post-seed fresh-cutoff finalize | 新cutoff完整SourcePlans+50-blockscan+差集P95≤120s、hard≤5min；只有此run可ready |
| startup RPC-fast lane | queue P95≤250ms/P99≤1s；service P95≤2s/P99≤5s；持续completion≥20 candidates/s |
| startup REVM-heavy lane | queue P95≤1s/P99≤3s；attempt P95≤10s、hard≤30s；四worker持续completion≥0.25 candidates/s |
| queue telemetry | 每lane current/max/oldest age/accepted/rejected/cancelled完整，无负数或未归属permit |
| startup progress durability | completed outcome最迟5s可见；有runnable work却连续60s无completion时发stall并停止纯等待 |
| CPU / event loop | allocatable CPU P95≤80%、P99<95%；event-loop lag P95<25ms、P99<100ms |
| memory / workers | warm后一小时heap slope≤1% configured heap；无孤儿REVM worker、无单调queue增长 |

[MTM] 这些是 Aloha 的初始绝对验收预算，不是冻结旧代码已达事实。若目标硬件/Reth profile 的基线证明
某绝对值不合理，必须在 Aloha production实现开始前通过 versioned profile decision 调整；不得在失败
run后临时放宽，也不得用 impl 更慢来判 Aloha pass。

[PFD] 100/100 指“同一 exact SHA、PID/process-start、log inode、generation 下连续100个 eligible canonical
heads 全部被及时、显式结算”，不是99%、不是任选100个、不是100次脚本循环，也不要求每个 head 都有
盈利 candidate。至少一条真实 dry-run candidate 仍须完整通过六步。

[PFD] eligible set由独立canonical-header collector在process进入ready-serving状态时预先确定：该区间内每个
canonical replacement head都eligible；no-candidate、timeout、queue-full、stale、resource failure仍在分母。
Orphaned reorg head单列并由canonical replacement替代，不允许operator、runtime或validator事后挑样本。
Warmup/maintenance只能以process/ready anchor划定整个连续区间，不能从运行区间中删除失败head。

[PFD] Critical-path各P99预算按11s显式组成，并与head completion P99使用同一candidate-bearing head分母，
避免“每个组件单独过门但总和超过12s”。无candidate head仍进入100/100 terminal分母，但不伪装成
planner→final-sim latency样本。Cold/warm generation
按candidate分母、fast/heavy mix与complete receipt set同时报告；若真实candidate规模不同，仍同时使用绝对
hard gate和per-lane throughput，不能只用较小分母宣称更快。

### 17.5 事实指标与对比

[PFD] 每阶段记录 queue wait、service time、end-to-end time、source scan count、physical/logical request、
single-flight join、dedupe hit、memo reuse、retry reason、RPC/REVM concurrency、CPU、RSS、worker restart、
completed/missed heads、P50/P95/P99。分母与完整 receipt set 必须随指标一起 hash。

[PFD] 对比 DS/impl 时使用相同 canonical head window、provider、hardware profile、dry-run policy 与 raw
receipt set。旧实现只用于定位回归：Aloha 即使比旧实现快也不能替代绝对预算、六步 lineage 或安全门；
旧实现即使失败也不能自动让 Aloha 通过。

## 18. Existing six-step asset audit

### 18.1 可提取机制

| 标签 / 判断 | impl@d33c8b48 资产 | 可保留事实机制 | 必须删除/重写的旧语义 | Aloha 目标 |
|---|---|---|---|---|
| [ASR] R2 | listener/src/shared/evidence/semantic-six-step.ts | canonical JSON/hash、semantic output 与 metrics 分离、ordered prefix、terminal semantics、cross-step commitment、deep freeze | discovery_admission_graph、route_enumeration、quote/solve/final-sim/EV stage；family bypass；legacy readers | acceptance/schema-codec + validator；全新 six stage 与 exact-key schema |
| [ASR] R2 | analysis/src/six-step-validation-controller.ts | content-addressed inputs、exact set、payload/evidence hash复算、state anchor复核、fsync/rename seal | production imports、target route、trusted reference、旧 Graph builder、review/merge/rollback | independent validator/collectors；只读 raw facts，不运行production builder |
| [ASR] R2 | analysis/src/six-step-validation-lifecycle.ts | chain validation、process before/after stability、full-envelope digest | branch/reviewer/merge/cleanup lifecycle、checkpoint/final merge verdict | immutable run receipt lifecycle；不管理Git迁移 |
| [ASR] R2 | analysis/src/trusted-six-step-runtime-attestation.ts | exact SHA、PID/start ticks、content-addressed inputs、secret filtering、parent anchor | AWS/SSM、固定region/host/path进入core | environment collector port + process anchor schema |
| [BRW] R3 | analysis/src/six-step-judgment.ts | fail-closed pure evaluator shape | adapter_merge、production_gap、listener/family imports、非canonical receipt hash | architecture-neutral fact verdict |
| [ASR] R2 | listener/src/searcher/systemic-live-gate.ts | 所有事实门全过才pass、coverage/throughput/latency fail closed | 旧route/Families truth | absolute budget evaluator |
| [BRW] R3 | serial-systemic-live-evidence.ts、paired-live | percentile/coverage/throughput math | tolerant parser、同block覆盖、paired/parity correctness authority | exact process/run/generation join；serial只作diagnostic |

[VEF] 冻结source中已有mutation cases：semantic-six-step.ts:183-292,378-402（digest/order/terminal）；
six-step-validation-lifecycle.ts:553-713,738-899（splice/commitment/stage/runtime/envelope）；
six-step-validation-pending-evidence.ts:40-230（empty/subset/duplicate/exact set）；
trusted-six-step-runtime-attestation.ts:128-329（snapshot/input/secret/parent）；
listener/src/searcher/test/systemic-live-gate.ts:102-189（任一门fail closed）。[MTM] 本轮未运行这些tests，
因此只选择mutation机制，不宣称冻结test当前pass。

[REJ] 旧六步不能靠改名映射成新六步：旧 step 1 混合 discovery 与 Graph，旧 step 2 是 route
enumeration，旧 step 3/4 是 quote→solver，旧 step 5 才是 sim，旧 step 6 是 EV。Aloha 的 planner→exact
顺序、独立 execution program 与 atomic ready receipt 都没有一对一旧 stage。impl-first calibration 可以
诚实显示 missing fact，不能合成成功。

### 18.2 永不进入新 schema 的旧字段

[REJ] production_route_stage、family_execution、discovery_admission_graph、route_enumeration、
exact_quote_refine、plan_and_size、fork_final_sim、production_ev、bypassed、route_pinned、fixture_route_sha256、
target_route_sha256、trusted target/reference、selected_by_solve_policy、adapter_merge、production_gap、
checkpoint_pass、final_validated、rollback/baseline/branch reviewer/cleanup、pairedLiveVerdict 与 AWS/SSM command
identity 均不进入 Aloha Evidence Schema。

[PFD] deployment collector MAY 报 environment-specific locator，但 schema/validator 不按 provider、host、
AWS region、path 或 systemId 选择宽松规则。

## 19. New fact-only Evidence Schema

### 19.1 Schema

[PFD] EvidenceEventV1 顶层 core 字段 exact-key；扩展只能位于已声明 schema hash 的 extensions：

~~~ts
type SchemaRef = Readonly<{ id: string; version: SemVer; schemaHash: Hash }>;

type EvidenceScopeV1 =
  | {
      kind: "builder-run";
      builderRunId: string;
      producerSessionId: null;
      generationId: null;
      generationRefreshPolicyHash: Hash;
    }
  | {
      kind: "ready-generation";
      builderRunId: string;
      producerSessionId: null;
      generationId: string;
      generationRefreshPolicyHash: Hash;
    }
  | {
      kind: "producer-session";
      builderRunId: string; // origin run of the leased ready generation
      producerSessionId: string;
      generationId: string;
      generationRefreshPolicyHash: Hash;
    };
~~~

~~~ts
interface EvidenceEventV1 {
  schemaVersion: 1;
  kind: "aloha.fact-evidence-event";
  eventId: Hash;

  source: {
    systemId: string;
    emitterKind: "native" | "read-only-adapter";
    emitterCodeHash: Hash;
    rawArtifactHash: Hash;
    rawLocator: ReadOnlyArtifactLocator;
  };

  runtime: {
    commitSha: GitSha40;
    executableHash: Hash;
    pid: DecimalString;
    processStartTicks: DecimalString;
    bootIdHash: Hash;
    logDevice: DecimalString;
    logInode: DecimalString;
    logOffsetStart: DecimalString;
    logOffsetEnd: DecimalString;
  };

  scope: EvidenceScopeV1;
  correlationId: string;
  runSequence: DecimalString;
  cutoff: { number: DecimalString; hash: BlockHash; stateRoot: Hash };
  definitionCatalogRoot: Hash;
  instanceCatalogRoot: Hash | null;
  graphRoot: Hash | null;

  familyId: FamilyId;
  candidateKey: FamilyCandidateKey;
  familyDefinitionHash: Hash;
  capabilities: readonly {
    capabilityId: CapabilityId;
    version: SemVer;
    schemaHash: Hash;
    interpreterHash: Hash;
  }[];
  capabilitySetHash: Hash;
  instanceKey: FamilyInstanceKey | null;

  stage: {
    ordinal: 1 | 2 | 3 | 4 | 5 | 6;
    id:
      | "universe_instance"
      | "edge_ready_generation"
      | "planner_consumption"
      | "current_source_exact"
      | "execution_program"
      | "final_simulation";
    version: 1;
  };

  parentEventIds: readonly Hash[];
  parentOutputHashes: readonly Hash[];
  inputSchema: SchemaRef;
  inputs: CanonicalJsonObject;
  inputHash: Hash;
  factSchema: SchemaRef;
  facts: CanonicalJsonObject;
  outputHash: Hash;
  outcome:
    | "verified"
    | "success"
    | "chain_proven_rejected"
    | "retryable"
    | "invalid_program"
    | "policy_rejected"
    | "simulation_reverted"
    | "failed_closed";
  reasonCode: StableReasonCode | null;
  latency: {
    startedMonotonicNs: DecimalString;
    finishedMonotonicNs: DecimalString;
    durationUs: DecimalString;
  };
  extensions: readonly {
    schema: SchemaRef;
    value: CanonicalJson;
  }[];
}
~~~

[PFD] scope按stage exact匹配：stage 1只能是builder-run，generationId必须为null，因为attestation先于
generation产生，且rejected/retryable/invalidProgram可能永远不属于任何generation；stage 2只能是
ready-generation；stage 3–6只能是producer-session。definitionCatalogRoot在六层均必填；stage 1的
instanceCatalogRoot/graphRoot必须为null，stage 2–6必须非null并沿DAG相容。candidateKey始终必填；
pre-identity rejected/retryable/invalidProgram的instanceKey为null，verified stage 1及stage 2–6必须非null。
不得为失败候选伪造instanceKey或预先分配generationId。

[PFD] inputSchema/factSchema是specs/evidence中冻结的stage-specific exact schema；validator先验证schema
id/version/hash和exact fields，再计算hash。它不能把任意CanonicalJsonObject自述当事实。每个schema明确
membership proof、authority artifact、source anchor与failure所需字段。

[PFD] extensions按canonical(schema.id, version, schemaHash)严格升序，重复SchemaRef拒绝；每个value先由该
schema exact-decode/re-encode再进入eventId。禁止用object-key字符串化SchemaRef或last-write-wins覆盖extension。

[PFD] 多实例route形成provenance DAG而不是伪造一条单实例线。Stage 3 facts含
orderedInstanceBindingsRoot；每个叶子绑定该leg的instance publication、Family definition、capability
closure、原stage-1 attestation Event与stage-2 ready/edge membership Event。顶层family/instance只是展示
anchor；只验证anchor不足以接受整条route。

### 19.2 Hash 与真实性

~~~text
capabilitySetHash =
  H("aloha/capability-set/v1", canonical(sorted capabilities))

inputHash =
  H("aloha/stage-input/v1", stage.id, inputSchema, canonical(inputs))

outputHash =
  H("aloha/stage-output/v1", stage.id, factSchema,
    canonical(facts), outcome, reasonCode)

eventId =
  H("aloha/evidence-event/v1", canonical(all fields except eventId))
~~~

[PFD] outputHash 只绑定语义事实，支持跨步 commitment；eventId 绑定完整 envelope，包括 runtime、latency、
source 与 raw locator。修改 telemetry 后也必须改变 eventId，不能无痕覆盖。

[PFD] outcome与reasonCode属于语义结果，必须进入outputHash；否则把verified改成rejected仍可能维持child
commitment。Stage 1成功结果使用verified，stage 2–6过程成功使用success。

[PFD] Hash 只能证明内容完整性，不能单独证明事实真实性。真实性来自 exact runtime/process/log anchor、
只读 raw artifact locator、checkpoint/root 复算、独立 Reth/on-chain 复核与真实 final-sim receipt。成功 verdict
不得来自手写 fixture、手写 TokenEdge、validator 自建 Graph 或“日志打印了 success”。

### 19.3 Event 写入边界

[PFD] emitter 在每个 production boundary 收到已经存在的 authority object，仅 canonicalize/hash/append；
它不能构造 candidate、publication、Graph、plan、quote、program 或 simulation result。Evidence append 必须
有单调 sequence、fsync seal 与 log offsets。External submission 要求 evidence write成功；纯 dry-run若
写失败也必须输出 failed-closed process状态，不能宣称六步完成。

[PFD] Stage 1 Event在builder真正产生candidate outcome时写入，保留原builderRun/process anchor且没有
generationId。每次新ready generation都为实际进入该generation的publication/edge写新的stage-2 membership
Event：新stage 2引用原stage 1；若使用跨generation memo，还必须引用并复核plugin-issued reuse proof。
Stage-2 fact schema含`attestationMode = fresh | memo-reuse`；memo-reuse时proof bytes/hash/raw locator为必填事实，
但proof不是伪装成production stage的额外Event，stage 2仍以对应原stage 1为唯一attestation parent。
同一generation的process restart不得以新PID重发stage 1/2冒充新attestation/promotion；Stage 3通过
parentEventIds和Merkle membership proof直接引用该leased generation的原stage-2 Events。Validator复核
原artifact locator、原process、promotion revision及当前memo/GraphView reuse receipt。这样失败candidate、
跨generation memo reuse、restart和多leg route都形成真实provenance DAG，而不伪造未来generation身份。

[PFD] rawLocator 是只读、内容寻址定位（file/device/inode/offset、checkpoint key/root、receipt JSON pointer
等），不得包含 RPC secret、private key、完整环境变量或可签名材料。

[PFD] Evidence Schema还包含两个非六步、同样exact-key/hash-bound的聚合receipt：CoverageReceiptV1
编码release-intent exact set、source partitions、zero-candidate与全族分母；HeadTerminalReceiptV1编码每个
eligible canonical head的terminal/no-candidate/failure与deadline。它们不能伪造instanceKey，也不能替代
某条candidate的六步DAG。

## 20. impl-first validator calibration

### 20.1 独立拓扑

~~~text
impl runtime ──真实 artifact──> impl read-only adapter ──EvidenceEventV1──┐
                                                                          ├─> one frozen validator
Aloha runtime ────────────────> native evidence emitter ──EvidenceEventV1─┘

Reth / on-chain ──────────────> independent fact collector ───────────────┘
~~~

[PFD] acceptance package 不 import impl 或 Aloha production源码。impl adapter 是只读 translator，不能调用
builder、planner、solver、quoter、executor或 simulator补齐事实，不能改变 runtime，也无权定义成功。

### 20.2 校准顺序

[PFD] 在任何 Aloha production implementation 开始前：

1. 实现独立 schema/codec、state machine、validator 与 mutation corpus；
2. 固定一个 impl exact SHA、executable hash、PID/start/boot/log inode 与 raw artifact set；
3. adapter 读取 impl 的 six-step receipt、producer receipt、checkpoint/catalog/Graph、process/log stat 与
   Reth/on-chain anchors；
4. 每个 Event 字段必须有 raw artifact hash 与 locator；不存在的事实不生成；
5. 同一 validator 运行 impl evidence；缺 readyGeneration、instance attestation或 execution lineage 时诚实
   missing-stage，不为 impl 放宽；
6. 人工审查随机样本，独立复算 roots 与 Reth facts；
7. 运行完整负向 corpus；
8. 修复 validator/adapter 的真实读取 bug，并同时重跑 impl；
9. 冻结 schemaVersion、schemaHash、reasonCodeCatalogHash、validator exact commit、validator bundle hash、
   negativeCorpusRoot、implAdapter hash 与 calibrationReceiptRoot；
10. 只有冻结 receipt 成立，Aloha production agents 才从 architecture-baseline 开始实现。

[PFD] “impl-first”是校准读取与判定，不是要求 impl 达到 Aloha终态。旧实现缺事实就是校准成功暴露的
缺口。新旧数量无需 parity；两者只需接受同一事实合同。

### 20.3 Validator bug policy

[PFD] 当 validator 与 source/checkpoint/runtime/on-chain事实冲突：先定位 raw locator、schema decode、窗口、
join 与 lineage。确认 validator bug 后：升级 validator版本与hash、加入最小负向/回归 case、同时重跑 impl
与Aloha。禁止修改正确production authority迎合脚本，禁止只给 Aloha 特判，禁止沿用旧错误 verdict。

## 21. Six-step acceptance protocol

### 21.1 通用 DAG 规则

[PFD] 六步是六个语义层，不强制“恰好六个Event的假线性链”。每个verified route leg有原stage-1 Event
及其stage-2 membership Event；一个多leg stage-3 planner Event按route顺序引用全部stage-2 parents；
stage 4→5→6再形成当前candidate的线性tail。

[PFD] Stage 1保留原builder-run/runtime/process anchor且generationId=null；Stage 2保留实际promotion的
ready-generation scope。Stage 3–6必须拥有相同当前runtime commit/PID/start/boot/log inode、
producerSessionId、correlationId、generationId、definitionCatalogRoot、generationRefreshPolicyHash、
instanceCatalogRoot、graphRoot及GraphView lease，并且其scope.builderRunId等于leased ready的origin run。
所有DAG节点cutoff/Family-capability leaf bindings必须相容；parentEventIds/outputHashes、Merkle membership与
sequence必须可复算，但不得错误要求stage 1拥有尚不存在的generation。

[PFD] Restart不重发stage 1/2；stage 3引用持久的原stage-2 Events及ready/memo-reuse receipt。每个leg均须
验证，不能用anchor Family代表其他legs。Stage 1/2非verified结果terminal且不得进入stage3 ancestry；
stage 3–6任何非success outcome terminal。不存在bypass/not_reached成功占位。GraphView lease在stage3–6
不变；全局adopt新generation时旧session仍持有原lease直至DAG tail终止。

### 21.2 Step 1 — Universe / Instance

[PFD] 验证：

- nomination source kind、source plan、cutoff 与 completeness semantics；
- FamilyCandidateKey、FamilyInstanceKey、canonical identity 与 reverse-binding proof；
- familyDefinitionHash、declared capability set、authority与request fingerprint；
- outcome 为 verified、chainProvenRejected、retryable 或 invalidProgram；pre-identity outcome的
  instanceKey为null；
- exact candidate partition无 missing/duplicate；
- successful six-step sample 必须是 verified instance publication，不能从 rejected/fixture 开始。

Reth/on-chain collector 对抽样 identity proof 在同 cutoff复核；validator不按Family名称决定如何复核，
而用specs/authority-proof中独立冻结的AuthorityProofProgram与acceptance-side generic interpreter重放
eth_call/log/storage关系。Production plugin提供proof program与raw receipt，但不能提供validator verdict。

### 21.3 Step 2 — Edge / readyGeneration

[PFD] 验证同一verified publication hash进入instanceCatalogRoot，Family definition进入
definitionCatalogRoot，edge绑定该publication并进入graphRoot；coverage、cutoff、两个catalog roots、Graph
与accounting属于同一个promotion revision/CAS；promotion在producer session之前；GraphEdge无raw
pool/default/legacy来源。

[PFD] restart时step 2引用原promotion receipt并证明当前GraphView lease从该root打开；它不是再次promotion。

### 21.4 Step 3 — Planner consumption

[PFD] 验证生产 planner 实际持有该 immutable GraphView lease，route的orderedInstanceBindingsRoot来自同一
graphRoot/generation，未注入target route，未调用default/legacy Graph或fallback。Validator只验证object
lineage和roots，不重新运行planner生成一条“应该存在”的route。

### 21.5 Step 4 — Current-source exact

[PFD] 验证 exact 使用相同 ordered instances、current SourceSession number/hash/stateRoot、declared exact/
state capability/interpreter、完整input/output hashes与fallback=false。对抽样state fact用Reth独立复核。
ready cutoff与current source可以是不同block，但各自类型明确且lineage不可互换。

### 21.6 Step 5 — Execution program

[PFD] 验证 program由generated catalog中的action owners对step 4 exact output编译，绑定program hash、caller
mode、preCalls、call sequence、exact observation pairs、repayment/standing-position/conservation obligations
与interpreter hashes；unknown action或legacy execution fallback为失败。

### 21.7 Step 6 — Final simulation

[PFD] 验证同correlationId/program/source进入真实final-sim worker并得到process-anchored、content-addressed、
可独立重放/复算的receipt；final sim使用顶层
交易语义，generation/canonical fence、repayment、conservation、standing-position与submission safety gate
实际执行。成功或明确simulation revert都可形成真实terminal事实；只有success且其他门通过才可产生unsigned
dry-run success。Harness/capture/fork fixture不能替代真实目标环境dry-run receipt。

## 22. Negative validator calibration

[PFD] Mutation corpus 至少必须让以下篡改稳定失败：

| 类别 | 必失败 mutation |
|---|---|
| stage | 删除、重复、交换任一步；terminal后追加；ordinal/id不一致 |
| run/process | splice两个run/correlation；SHA、executable、PID、start ticks、boot ID不一致；篡改stage1/2原builder anchor或restart reuse receipt |
| log | device/inode改变；offset重叠、倒退、越界；rawArtifactHash不匹配 |
| canonical | 相同number不同hash/stateRoot；source越出declared range |
| generation | stage1伪造非null generation、stage/scope kind错配；generationId、generationRefreshPolicyHash、definitionCatalogRoot、instanceCatalogRoot、graphRoot、promotion revision不一致；ready前producer启动；session中lease变化 |
| Family | familyDefinitionHash、capabilitySetHash、candidateKey、nullable instance规则、ordered route-leg root不一致；删除/替换某leg stage1/2 membership |
| hash chain | 修改facts/outcome/reason不改hash；重算output/event但不改child input；parent Events/outputs DAG断裂 |
| exact | 伪造exact、缺current source或Reth binding、fallback=true |
| execution | 伪造program、缺action owner/interpreter/exact binding、观察pair被Cartesian展开 |
| simulation | 伪造final-sim、缺program/source/receipt；用effect sim替代final sim |
| schema | unknown core field、duplicate key、非规范number/address/hash、未知version被忽略 |
| performance | 空分母、丢失败样本、任选100 heads、跨PID拼接、serial证据冒充同窗 |

[PFD] negative corpus 可以人为损坏真实 evidence，也可以构造最小无成功语义的格式样本来测 parser；它不能
用手写成功 fixture证明production成功。每个 mutation记录base artifact root、mutator code hash、expected
reason与实际validator reason，corpus root进入冻结 receipt。

[PFD] Validator还必须证明自己不会：按Family名称分支、import production实现、自己构建Graph/quote/program、
从日志文案推导success、容忍坏JSON后跳过、把同block后写覆盖前写、让empty denominator pass。

## 23. Full-family / restart / performance acceptance

### 23.1 全族矩阵

[PFD] 全族exact set来自独立frozen release-intent BOM；validator先要求BOM、generated definition catalog与
runtime composition exact equality，不在源码手写22或242。每个release Family
都必须有以下之一，且有原始分母与locator：

1. strict attested/published 的实例集合；
2. exact source partition证明 candidate count=0；
3. 每个candidate均chain-proven rejected；
4. retryable/invalidProgram（此时整体不得ready/pass）。

[PFD] Funding/Credit允许在目标window无实例，但必须给出source coverage、zero-candidate partition与catalog
entry，不能silent missing。对有instances的Family，分别报告candidate、verified、rejected、retryable、
invalidProgram、instancePublication、projectedEdge、declaredExactCapability、ownedAction计数与roots；这些
字段均由architecture-neutral schema定义，不沿用旧expected/priced术语。Family名称仅用于展示；verdict由
BOM exact set与schema facts驱动。

### 23.2 Restart 与差集

[PFD] 在同 exact SHA或语义closure兼容的新SHA下进行systemd restart，验证：

- process anchor变化且runtime SHA/ready root绑定正确；
- ready仍canonical时GraphView直接复用；
- verified memo逐实例复用，unchanged old instance attest=0；
- 只处理新增candidate、失效dependency closure、retryable与上一run不跨cutoff复用的rejection；
- source/canonical hash变化会fail closed而非复用错误run；
- single-instance probe只改变目标RunCandidateKey outcome；
- SIGTERM中途完成的outcomes重启后仍存在；
- 无重复identity/materialize/project，无array-index resume。

### 23.3 Performance事实门

[PFD] 使用同一 exact SHA、PID/start、log inode、generation与连续 canonical window收集第17节指标。必须同时
给出raw Event/metric receipt set root、eligible denominator、excluded heads及客观原因、queue caps、provider/
hardware profile。任何missing或unknown不从分母删除。

[PFD] 最终门至少包括：

- 连续100/100 eligible heads显式terminal且满足固定deadline profile；
- P50/P95/P99与throughput满足绝对预算；
- source scan count、single-flight physical build、attest/materialize/project counts满足不重复不变量；
- memo reuse与restart差集满足预期；
- RPC/REVM/final-sim permit与queue可守恒，CPU/RSS/worker restart无失控；
- producer active generation冻结；
- 至少一条真实dry-run candidate在同lineage完成六步；
- legacy authority/import/runtime/log/consumer=0。

[PFD] Unit/build/fixture、部分Graph、单次进程启动、来源不明的edge数、旧新数量parity或某脚本打印pass均
不能替代上述事实。Build只证明implemented；真实lineage、restart与性能门共同成立才证明该架构落地。

## 24. Core pseudocode

[PFD] 本节是接口和 authority 伪代码，不是生产实现。所有 Hash 操作都有 domain separator；所有
persist/CAS 都指单 writer transaction；所有 Promise 都接受 cancellation/deadline。

### 24.1 FamilyPlugin 与 CapabilityModule

~~~ts
interface FamilyPluginV1 {
  readonly manifest: FrozenFamilyManifest;

  // Plugin owns candidate and instance semantics.
  sourcePlans(cutoff: CanonicalCutoff): readonly SourcePlan[];
  nominate(facts: readonly SourceFact[]): Promise<readonly OpaqueCandidate[]>;
  instanceNominationKey(candidate: OpaqueCandidate): OpaqueCanonicalKey;
  verifyIdentity(input: IdentityInput): Promise<FamilyDecision<OpaqueIdentity>>;
  instanceKey(identity: OpaqueIdentity): FamilyInstanceKey;
  materialize(identity: OpaqueIdentity): Promise<FamilyDecision<OpaqueDescriptor>>;
  project(descriptor: OpaqueDescriptor): Promise<FamilyDecision<OpaqueStaticProjection>>;

  // Handles are process-local and issuer-bound.
  rehydrate(memo: VerifiedMemo, source: CanonicalSourceView): IssuedRouteHandle;
  capability(id: CapabilityId): DeclaredCapabilityHandle;
}

interface CapabilityModuleV1<P, F, O> {
  readonly ref: CapabilityRef; // id/version/schema/interpreter/dependency hashes
  readonly programCodec: SchemaCodec<P>;
  readonly factCodec: SchemaCodec<F>;
  readonly outputCodec: SchemaCodec<O>;

  issue(input: OpaqueIssueInput, issuer: FamilyIssuer): FrozenProgramEnvelope<P>;
  execute(program: FrozenProgramEnvelope<P>, port: GenericExecutionPort): Promise<readonly F[]>;
  interpret(program: FrozenProgramEnvelope<P>, facts: readonly F[]): ProgramInterpretation<O>;
}
~~~

[PFD] 中央 lifecycle 只看 union tag 与 hashes，不解析 OpaqueIdentity/Descriptor/Projection/Output。Plugin
不能自行写 checkpoint、Graph、evidence success 或 submission；capability interpreter 不能取得未声明 port。

### 24.2 Schema codec、freeze 与 rehydrate

~~~ts
interface FrozenProgramEnvelope<S> {
  envelopeSchemaRef: SchemaRef;
  payloadSchemaRef: SchemaRef;
  capabilityRef: CapabilityRef;
  issuerRef: FamilyIssuerRef;
  source: CanonicalSourceView;
  authorityHash: Hash;
  canonicalPayloadBytes: Bytes;
  payloadHash: Hash;
  requestFingerprint: Hash;
}

function freezeProgram<S>(input: {
  payloadSchemaRef: SchemaRef;
  capabilityRef: CapabilityRef;
  issuer: FamilyIssuer;
  source: CanonicalSourceView;
  authorityHash: Hash;
  value: S;
}): FrozenProgramEnvelope<S> {
  const schema = generatedSchemaRegistry.requireExact(input.payloadSchemaRef);
  const payload = schema.encodeExact(input.value); // no handwritten projection
  assertBytesEqual(schema.encodeExact(schema.decodeExact(payload)), payload);
  const envelope = {
    envelopeSchemaRef: CORE_PROGRAM_ENVELOPE_SCHEMA,
    payloadSchemaRef: input.payloadSchemaRef,
    capabilityRef: input.capabilityRef,
    issuerRef: input.issuer.ref,
    source: input.source,
    authorityHash: input.authorityHash,
    canonicalPayloadBytes: payload,
    payloadHash: H("aloha/program-payload/v1", input.payloadSchemaRef, payload),
  };
  return frozenProgramCodec.freeze({
    ...envelope,
    requestFingerprint: H("aloha/frozen-program/v1", frozenProgramCodec.encodeCanonical(envelope)),
  });
}

function persistFrozen(tx: Transaction, program: FrozenProgramEnvelope<unknown>): FrozenProgramRef {
  const envelopeBytes = frozenProgramCodec.encodeCanonical(program);
  const recordHash = tx.putContentAddressed("aloha/frozen-program-record/v1", envelopeBytes);
  tx.bindRequestFingerprint(program.requestFingerprint, recordHash);
  return { requestFingerprint: program.requestFingerprint, recordHash };
}

function rehydrateRouteHandle(
  memo: VerifiedMemo,
  reuseProof: PluginIssuedReuseProof,
  plugin: FamilyPluginV1,
  currentCatalog: GeneratedCatalog,
  source: CanonicalSourceView,
): IssuedRouteHandle {
  assert(memo.familyId === plugin.manifest.familyId);
  assert(reuseProof.memoHash === memo.hash && reuseProof.currentIssuer === plugin.manifest.familyId);
  assert(reuseProof.requestedArtifactDependencyRoot ===
    currentCatalog.requiredArtifactDependencyRoot(memo.familyId, "route-rehydration"));
  assert(validateMemoDependenciesWithPluginProof(memo, reuseProof, currentCatalog, source) === "reusable");
  const canonicalMemo = verifiedMemoCodec.decodeExact(memo.canonicalBytes);
  return plugin.rehydrate(canonicalMemo, source); // issuer creates a new non-serializable handle
}
~~~

### 24.3 Transport facts 与 attestation outcome

~~~ts
async function runOwnedProgram<O>(
  issued: FrozenProgramEnvelope<unknown>,
  capability: DeclaredCapabilityHandle<O>,
  signal: AbortSignal,
): Promise<ProgramInterpretation<O>> {
  let facts: readonly TransportFact[];
  try {
    assertIssuerAndClosure(issued, capability);
    facts = await requestRuntime.executeFrozenEnvelope(
      frozenProgramCodec.encodeCanonical(issued),
      signal,
    ); // expected per-request failures are returned as TransportFact
  } catch (e) {
    if (isTransportOrResourceFailure(e)) return retryable(e);
    return invalidProgram(toFrameworkProgramDefect(e));
  }

  try {
    // Central does not inspect revert/0x/decode meaning.
    return capability.interpret(issued, facts);
  } catch (e) {
    // A plugin throw is always its code/codec contract defect, even if its shape
    // resembles an RPC/resource error. Only an explicit returned union is trusted.
    return invalidProgram(toPluginProgramDefect(e));
  }
}
~~~

[PFD] capability.interpret 自己 decode自己的 returned/reverted facts。ProgramInterpretation只是某个已声明
capability的解释结果；attestation engine只有在identity→materialization→projection全部完成后，才把它封装为
最终AttestationOutcome/VerifiedMemo。中央catch不能产生chainProvenRejected；只有显式plugin result能产生且
必须通过proof binding validator。Framework发现自身schema/issuer/program defect可以形成invalidProgram，
但不得把它塞进TransportFact，也不得永久排除实例。

### 24.4 Fixed-cutoff startup coordinator

~~~ts
async function startSearcherProcess(signal: AbortSignal): Promise<void> {
  const catalog = loadAndVerifyReleaseIntentEqualsGeneratedRuntimeComposition();
  const root = await checkpoint.loadAndValidateRoot();
  const reusableReady = await readyStore.findLatestReusable(
    root, catalog, canonicalSource, GENERATION_REFRESH_POLICY,
  ); // includes canonical/closure/maxServingAgeBlocks checks

  if (reusableReady) {
    const lease = await graphStore.rehydrateImmutableGraphView(reusableReady, catalog);
    return serveWithGenerationBuilder(lease, signal); // no identity re-attestation
  }

  const ready = await buildGeneration(signal); // first boot/no valid ready blocks producer
  const lease = await graphStore.rehydrateImmutableGraphView(ready, catalog);
  return serveWithGenerationBuilder(lease, signal);
}

async function serveWithGenerationBuilder(
  lease: GraphViewLease,
  signal: AbortSignal,
): Promise<void> {
  await validateServingLease(lease, generatedCatalog.loadExact(), GENERATION_REFRESH_POLICY);
  const serving = await producer.openServing(lease, signal); // returns only after intake is live
  runtimeSupervisor.spawnRequired(
    "generation-builder",
    () => generationBuilder.runRefreshLoop(GENERATION_REFRESH_POLICY, signal),
  );
  await serving.untilStopped();
}

interface CompletedBuilderRun {
  snapshot: SealedRunSnapshot;
  catalog: GeneratedCatalog;
  cutoff: CanonicalCutoff;
}

async function buildGeneration(signal: AbortSignal): Promise<ReadyGenerationV1> {
  for (;;) {
    const completed = await buildOrResumeOneRun(signal);
    const canonical = await canonicalSource.checkStillCanonical(completed.cutoff);
    if (!canonical.ok) {
      await checkpoint.sealCompletedRunStaleAndClearWithoutCarryCAS(
        completed.snapshot, canonical.reason,
      );
      continue;
    }
    const age = await canonicalSource.ageInBlocks(completed.cutoff);
    const latestPromotableAge = GENERATION_REFRESH_POLICY.maxServingAgeBlocks
      - GENERATION_REFRESH_POLICY.minPromotionMarginBlocks;
    if (age > latestPromotableAge) {
      await checkpoint.sealCompletedRunAsMemoSeedAndClearCAS({
        snapshot: completed.snapshot,
        carriedVerifiedMemoRoot: completed.snapshot.verifiedMemoRoot,
        reason: "cutoff-too-old-for-serving",
      }); // one CAS: persist receipt + carry verified memos + clear inProgress; no ready
      continue; // freeze a fresh cutoff; rejections/coverage are not carried
    }
    return promoteReadyGeneration(completed.snapshot, completed.catalog, completed.cutoff);
  }
}

async function buildOrResumeOneRun(signal: AbortSignal): Promise<CompletedBuilderRun> {
  const catalog = generatedCatalog.loadExact();
  let root = await checkpoint.loadAndValidateRoot();
  let run: InProgressRun | null = null;
  let candidates: readonly CandidateRecord[] = [];

  if (root.inProgressRunId) {
    const previous = await checkpoint.loadRun(root.inProgressRunId);
    const classification = await classifyRunForResume(previous, catalog, canonicalSource);
    if (classification.kind === "compatible") {
      run = previous;
      candidates = await checkpoint.loadExactCandidatePartition(run.candidatePartitionRoot);
      assert(hashExactCandidatePartition(candidates) === run.candidateSetHash);
    } else {
      // stale/incompatible runs remain immutable diagnostic records; the single CAS
      // clears the active pointer before a new cutoff is frozen.
      root = await checkpoint.sealRunAndClearInProgressCAS(
        previous.runId, root.revision, classification.reason,
      );
    }
  }

  if (run === null) {
    const cutoff = await canonicalSource.freezeView(signal);
    const sourceFacts = await discovery.executeAllDeclaredPlans(catalog, cutoff, signal);
    const coverage = discovery.assertCoverageSemantics(sourceFacts, cutoff);
    const recent = await observation.scanExactly(
      range(max(chainGenesis, cutoff.number - 49), cutoff.number), signal,
    );
    const nominated = await discovery.nominateAll(catalog, sourceFacts, recent, signal);
    candidates = dedupeCandidatesPreservingAllEvidence(nominated);
    run = await checkpoint.beginNewRunAndPersistPartition({
      cutoff, coverage, catalog, candidates,
      candidateSetHash: hashExactCandidatePartition(candidates),
    }); // CandidateRecords and run root are one transaction
  }

  const activeRun = requireNonNull(run);

  const impact = await memoStore.computeImpactWithPluginReuseProofs(catalog, activeRun.cutoff, candidates);
  const writer = await checkpoint.startOutcomeWriterActor(activeRun.runId, {
    flushEveryItems: 25,
    flushEveryMs: 3000,
  });

  try {
    // Phase A: identity/reuse once per stable CandidateKey.
    const identified = await boundedMapByLane(impact.toProcess, async candidate => {
      throwIfAborted(signal);
      const runKey = H("aloha/run-candidate/v1", activeRun.runId, candidate.familyCandidateKey);
      const sealed = await writer.loadSealedOrPartial(runKey);
      if (sealed?.isFinal) return sealed;
      const result = await resolveIdentityOrReuseProofOnce(candidate, activeRun.cutoff, catalog, signal);
      if (result.kind === "identityVerified") {
        await writer.enqueue({ kind: "candidate-partial-identity", runKey, result });
      } else {
        // reusable verified memo, chain rejection, retryable and invalidProgram are
        // final candidate outcomes here; they must leave pending accounting.
        await writer.enqueue({ kind: "candidate-final-outcome", runKey, result });
      }
      return result;
    }, signal);

    // Phase B: an accepted run has one nomination key and one lifecycle per InstanceKey.
    const groups = groupVerifiedIdentityResultsByFamilyInstanceKey(identified);
    await boundedMapByLane(groups, async group => {
      if (group.distinctFamilyCandidateKeys.length !== 1) {
        const proof = sealNominationKeyCollisionProof(group);
        for (const candidate of group.candidates) {
          await writer.enqueue(finalInvalidProgramForCandidate(candidate, proof));
        }
        return;
      }
      const instanceOutcome = await instanceLifecycleSingleFlight.getOrBuild(
        instanceWorkKey(activeRun, group.familyInstanceKey),
        () => materializeAndProjectOnce(group.identity, activeRun.cutoff, catalog, signal),
      );
      await writer.enqueue(sealCandidateOutcomeFromInstance(group.onlyCandidate, instanceOutcome));
    }, signal);
  } finally {
    stopNewAttestationTaskAdmission(activeRun.runId);
    await cancelAwaitAndPhysicallyReapWorkers(activeRun.runId); // completed workers may still enqueue
    await writer.closeAfterAllProducersAndFlush();
    // actor uses a non-cancellable durability context for the final flush
  }

  const snapshot = await checkpoint.loadRun(activeRun.runId);
  assertExactPartitionAndNoUnresolved(snapshot);
  await canonicalSource.assertStillCanonical(activeRun.cutoff);
  return { snapshot, catalog, cutoff: activeRun.cutoff };
}
~~~

[PFD] sourceFacts中的nomination-only hints可丢；coverage receipt不可由hints推导。已有valid ready与
inProgressRun是两个独立root refs：restart可立即消费旧ready，同时builder在隔离namespace恢复next run；
只有无valid ready时builder阻塞producer。若inProgress cutoff stale，先CAS seal stale后才freeze新cutoff。

### 24.5 Checkpoint writer

~~~ts
class DurableOutcomeWriterActor {
  private mailbox = new BoundedAsyncMailbox<WriterMessage>(WRITER_MAILBOX_CAP);
  private pending = new Map<RunCandidateKey, CompactOutcome>();
  private lastFlush = monotonicNow();
  private accepting = true;
  private loopTask = this.runLoop(); // only this task owns pending/revision/DB writes

  async enqueue(message: WriterMessage): Promise<void> {
    if (!this.accepting) throw new WriterClosed();
    await this.mailbox.put(deepFreeze(message)); // workers never mutate pending directly
  }

  private async runLoop(): Promise<void> {
    while (this.accepting || !this.mailbox.empty()) {
      // takeUntil must cancel/unregister its waiter on timeout; a raw Promise.race would
      // leave an orphan take() that could consume and lose the next completion.
      const message = await this.mailbox.takeUntil(this.lastFlush + FLUSH_MS);
      if (message.kind === "writer-message") this.applyToPendingExact(message.value);
      if (this.pending.size >= 25 || monotonicNow() - this.lastFlush >= FLUSH_MS) {
        await this.flushTransactionNonCancellable();
      }
    }
    await this.flushTransactionNonCancellable();
  }

  private async flushTransactionNonCancellable(): Promise<void> {
    const batch = sortByCanonicalKey(this.pending);
    if (batch.length === 0) {
      // Advance the timer epoch even when idle; otherwise an expired timer spins forever.
      this.lastFlush = monotonicNow();
      return;
    }
    await durableStore.transaction(async tx => {
      const root = tx.readRootForUpdate();
      assert(root.revision === this.expectedRevision);
      for (const [key, outcome] of batch) {
        const bytes = compactOutcomeCodec.encodeExact(outcome);
        const outcomeHash = H("aloha/run-outcome/v1", bytes);
        assert(tx.putContentAddressed("aloha/run-outcome/v1", bytes) === outcomeHash); // immutable value
        const previous = tx.getRunOutcomeRef(root.inProgressRunId, key);
        assertAllowedCandidateStateTransition(previous, outcome);
        tx.setRunOutcomeRef(root.inProgressRunId, key, outcomeHash); // mutable index in CAS
      }
      const nextRun = recomputeRunRootAndAccounting(tx, root.inProgressRunId);
      tx.compareAndSwapRoot(root.revision, rootWith(nextRun, root.revision + 1));
    });
    this.expectedRevision += 1;
    for (const [key] of batch) this.pending.delete(key);
    this.lastFlush = monotonicNow();
  }

  async closeAfterAllProducersAndFlush(): Promise<void> {
    this.accepting = false;
    this.mailbox.closeForNewWriters();
    await this.loopTask; // loop drains queued completions and performs final WAL sync
  }
}
~~~

[PFD] transaction commit/WAL sync成功后才从pending删除。CAS conflict重新load并要求已写值byte-identical；冲突
不能last-write-wins。独立timer保证即使没有新completion也在2–5秒内flush；多worker只能写bounded mailbox。
Signal handler不直接做异步I/O，只触发coordinator停止领取。Coordinator先cancel并await/reap所有worker，
期间completion仍可enqueue；确认没有outcome-worker producer后才关闭mailbox。Actor drain后用不可取消durability context完成
final flush。Partial stage与final outcome写不同content hashes，RunCandidateKey index只能按声明状态机前进；
accounting只统计final outcomes，不能把identityVerified当最终verified。

### 24.6 Single-instance probe

~~~ts
async function probeOne(runId: RunId, candidateKey: FamilyCandidateKey): Promise<ProbeReceipt> {
  const run = await checkpoint.requireIncompleteRun(runId);
  await canonicalSource.assertStillCanonical(run.cutoff);
  const runKey = H("aloha/run-candidate/v1", runId, candidateKey);
  const before = await checkpoint.requireOutcome(runKey, ["retryable"]);
  const candidate = candidateSnapshotCodec.decodeExact(before.candidateSnapshotBytes);
  const outcome = await attestationEngine.retryOneThroughNormalTwoPhaseLifecycle(
    candidate, run, callerSignal,
  );
  await checkpoint.singleWriterReplace(runKey, before.hash, compactOutcome(outcome));
  return sealProbeReceipt(run, runKey, before, outcome);
}

async function diagnoseInvalidProgram(runId: RunId, candidateKey: FamilyCandidateKey): Promise<DiagnosticReceipt> {
  const original = await checkpoint.requireOutcomeForRead(runId, candidateKey, ["invalidProgram"]);
  return runReadOnlyProgramDiagnostic(original); // never mutates run outcome
}
~~~

[PFD] probe不能传新candidate payload；用户只选择runId+key或failure category。invalidProgram只能只读
diagnose；修复必然改变schema/code/contract closure并开启新run，不能在旧run替换为verified。

### 24.7 Memo reuse / invalidation

~~~ts
async function evaluateVerifiedMemoReuse(
  memo: VerifiedMemo,
  candidate: CandidateRecord,
  catalog: GeneratedCatalog,
  cutoff: CanonicalCutoff,
): Promise<ReuseDecision> {
  const required = catalog.requiredArtifactDependencyRoot(candidate.familyId, "instance-publication");
  if (memo.familyId !== candidate.familyId) return requiresAttestation("family-mismatch");
  if (memo.requestedArtifactDependencyRoot !== required)
    return requiresAttestation("artifact-dependency-root-changed"); // exact, not subset
  if (memo.coreEnvelopeSchemaHash !== CORE_ENVELOPE_SCHEMA_HASH)
    return requiresAttestation("core-envelope-changed");

  const program = catalog.family(candidate.familyId).issueMemoReuseCheck({ memo, candidate, cutoff });
  const decision = await runOwnedProgram(program, catalog.memoReuseCapability(candidate.familyId), callerSignal);
  if (decision.kind !== "verified") return decision;
  assert(decision.output.memoHash === memo.hash);
  assert(decision.output.candidateToCanonicalIdentityBindingProof);
  assert(decision.output.validityDependencyRoot === memo.validityDependencyRoot);
  return reusableWithPluginProof(memo, decision.output);
}

function invalidatedArtifacts(change: CatalogChange): ReadonlySet<ArtifactRef> {
  const changedClosureNodes = transitiveChangedCapabilities(change);
  return change.after.artifacts
    .filter(a => intersects(a.requestedDependencyClosure, changedClosureNodes))
    .map(a => a.ref)
    .toSet();
}
~~~

[PFD] reuse不比较全局definitionCatalogRoot，也不让中央读取opaque candidate的canonicalIdentityHash；owning
plugin通过schema-bound reuse-check proof证明candidate→memo identity映射和validity。requested artifact
dependency root必须exact相等，不是subset。新的无关Credit capability不进入Swap root；Chain rejection不
调用此函数跨cutoff复用。

### 24.8 Shared inFlight cache

~~~ts
class SharedWorkCache<K, V> {
  private settled = new Map<Hash, { value: V; validity: ValidityProof }>();
  private inFlight = new Map<Hash, {
    promise: Promise<V>;
    controller: AbortController;
    consumers: Set<ConsumerId>;
  }>();

  getOrBuild(key: K, consumer: ConsumerLease, build: (s: AbortSignal) => Promise<V>): Promise<V> {
    const hash = canonicalWorkKeyHash(key);
    const hit = this.settled.get(hash);
    if (hit && validate(hit.validity, key)) return Promise.resolve(hit.value);

    const existing = this.inFlight.get(hash);
    if (existing) {
      existing.consumers.add(consumer.id);
      return this.attachConsumerDeadline(hash, existing, consumer);
    }

    const controller = new AbortController();
    const entry = {
      controller,
      consumers: new Set([consumer.id]),
      promise: undefined as unknown as Promise<V>,
    };
    const promise = build(controller.signal)
      .then(value => { this.settled.set(hash, sealWithValidity(value, key)); return value; })
      .finally(() => { if (this.inFlight.get(hash)?.promise === promise) this.inFlight.delete(hash); });
    entry.promise = promise;
    this.inFlight.set(hash, entry);
    return this.attachConsumerDeadline(hash, entry, consumer);
  }

  private async attachConsumerDeadline(
    hash: Hash,
    entry: { promise: Promise<V>; controller: AbortController; consumers: Set<ConsumerId> },
    consumer: ConsumerLease,
  ): Promise<V> {
    try {
      return await raceWithConsumerDeadlineAndAbort(entry.promise, consumer);
    } finally {
      entry.consumers.delete(consumer.id);
      if (entry.consumers.size === 0 && this.inFlight.get(hash)?.promise === entry.promise) {
        entry.controller.abort("last-consumer-left");
      }
    }
  }
}
~~~

[PFD] attachConsumerDeadline 只有在最后consumer离开时才abort physical work；worker/socket实际settle前scheduler
permit不释放。build failure不写settled，下一调用可重试。

### 24.9 Atomic ready promotion

~~~ts
async function promoteReadyGeneration(
  run: SealedRunSnapshot,
  catalog: GeneratedCatalog,
  cutoff: CanonicalCutoff,
): Promise<ReadyGenerationV1> {
  assertExactPartitionAndNoUnresolved(run);
  assertCoverageAppliedThroughCutoff(run.coverage, cutoff);
  await canonicalSource.assertStillCanonical(cutoff);
  await canonicalSource.assertPromotionAgeWithinMargin(cutoff, GENERATION_REFRESH_POLICY);

  const publications = validateAndLoadVerifiedPublications(run, catalog, cutoff);
  const graph = graphProjector.fromPublicationRehydrationRefsOnly(publications);
  const graphArtifact = await durableStore.putContentAndFsync(
    "aloha/persisted-graph/v1", graph.canonicalBytes,
  );
  const next = sealReadyGeneration(run, publications, graphArtifact);

  // Graph construction may be long. The final short transaction reacquires a
  // canonical-journal fence and revalidates every referenced root.
  await canonicalSource.withPromotionFence(cutoff, async fence => {
    await durableStore.transaction(async tx => {
      const root = tx.readRootForUpdate();
      assert(root.inProgressRunId === run.runId && root.revision === run.checkpointRevision);
      tx.requireCanonicalFence(fence);
      tx.requirePromotionAgeWithinMargin(fence, GENERATION_REFRESH_POLICY);
      assert(catalog.recomputeDefinitionCatalogRoot() === next.definitionCatalogRoot);
      assert(recomputePolicyHash(GENERATION_REFRESH_POLICY) === next.generationRefreshPolicyHash);
      tx.requireAndRehashContentRoot(run.candidatePartitionRoot, CANDIDATE_PARTITION_SCHEMA);
      tx.requireAndRehashContentRoot(run.sourceCoverageRoot, COVERAGE_SCHEMA);
      tx.requireAndRehashContentRoot(run.verifiedMemoRoot, VERIFIED_MEMO_SET_SCHEMA);
      tx.requireAndRehashContentRoot(next.instanceCatalogRoot, INSTANCE_CATALOG_SCHEMA);
      tx.requireAndRehashContentRoot(graphArtifact.hash, PERSISTED_GRAPH_SCHEMA);
      tx.requireReadyClosureExactlyMatches(next, run, catalog, graphArtifact);
      const readyBytes = readyGenerationCodec.encodeExact(next);
      const readyRecordHash = tx.putContentAddressed("aloha/ready-generation/v1", readyBytes);
      assert(readyRecordHash === H("aloha/ready-generation/v1", readyBytes));
      tx.compareAndSwapRoot(root.revision, {
        revision: root.revision + 1,
        verifiedMemoRoot: run.verifiedMemoRoot,
        inProgressRunId: null,
        latestMemoSeedReceiptHash: root.latestMemoSeedReceiptHash,
        readyGenerationId: next.generationId,
        readyGenerationRecordHash: readyRecordHash,
        schemaHash: CHECKPOINT_SCHEMA_HASH,
      });
    });
  });

  // A reorg can occur immediately after any local transaction. Never serve merely
  // because a ready row exists; revalidate closure/canonical/policy before returning.
  await validateReadyClosureAndCanonical(next, catalog, GENERATION_REFRESH_POLICY);
  return next;
}
~~~

### 24.10 Immutable producer session 与 next-generation adoption

~~~ts
async function withHeadSession(head: CanonicalHead, work: (s: ProducerSession) => Promise<void>) {
  await producer.adoptionGate.withSharedAdmission(async () => {
    const lease = await activeGeneration.acquireLease();
    try {
      await validateServingLease(lease, generatedCatalog.loadExact(), GENERATION_REFRESH_POLICY, head);
      const source = await canonicalSource.openHeadSession(head);
      const session = deepFreeze({ lease, source, correlationRoot: newCorrelationRoot() });
      try { await work(session); }
      finally { await source.close(); }
    } finally { await lease.release(); }
  });
}

async function adoptAtSafeBoundary(next: ReadyGenerationV1): Promise<void> {
  await producer.adoptionGate.withExclusiveAdmission(async () => {
    const expected = activeGeneration.currentId(); // capture after new session admission is blocked
    await producer.barrier.drainExistingSessionsOrAbortAtDeadline();
    assert(producer.barrier.activeCount() === 0);
    const nextLease = await graphStore.openImmutableLease(next);
    await validateServingLease(nextLease, generatedCatalog.loadExact(), GENERATION_REFRESH_POLICY);
    await canonicalSource.withPromotionFence(next.cutoff, async fence => {
      await validateServingLease(nextLease, generatedCatalog.loadExact(), GENERATION_REFRESH_POLICY);
      await activeGeneration.compareAndSwap({ expected, next: nextLease, canonicalFence: fence });
    });
  });
}
~~~

[PFD] builder可并行但不能调用activeGeneration mutation。Adoption barrier是唯一写active pointer的地方；
exclusive gate先阻止新session acquire，再drain、CAS并重开；session中禁止adopt其lease。

### 24.11 Planner → exact → execution → final-sim

~~~ts
async function evaluateCandidate(
  session: ProducerSession,
  trigger: TriggerFact,
): Promise<DryRunReceipt> {
  const planned = planner.enumerate(session.lease.graphView, trigger); // generic, no Family branch
  for (const route of planned) {
    const correlationId = correlationFor(session, trigger, route);
    const authorityParents = loadAndVerifyOriginalStage2ParentsForEveryRouteLeg(
      route, session.lease,
    ); // each stage2 has its original stage1 parent; no event is re-emitted
    emitStage3PlannerFact(session, correlationId, route, { parents: authorityParents });

    const exact = await exactCoordinator.evaluateCurrentSource({
      route, graphLease: session.lease, source: session.source, correlationId,
    });
    emitStage4ExactFact(session, correlationId, exact);
    if (!exact.ok) continue;

    const program = executionCompiler.compileOwnedActions({
      exact, actionOwners: generatedCatalog.actionOwners(), safety: REQUIRED_SAFETY_PROFILE,
    });
    emitStage5ProgramFact(session, correlationId, program);

    const rawSimulation = await finalSimulation.runReserved({
      program, source: session.source, graphLease: session.lease, topLevelRules: STRICT,
    });
    const sealedFinal = await safety.verifyCanonicalFencesAndSealFinalReceipt({
      rawSimulation, program, source: session.source, graphLease: session.lease,
      requiredObligations: REQUIRED_SAFETY_PROFILE,
    });
    emitStage6SimulationFact(session, correlationId, sealedFinal);
    if (sealedFinal.outcome === "success" && submission.isDryRun()) {
      return submission.recordUnsignedDryRun(program, sealedFinal);
    }
  }
  return submission.recordNoEligibleProgram(session, trigger);
}
~~~

[PFD] 每个 emit 只接收已产生的真实object并记录hash；emit失败不能被catch成候选失败后继续external submission。
Stage 3直接引用durable原stage-2 parents；不重发stage 1/2。Stage 6只记录已包含canonical/generation、
repayment、conservation与standing-position verdict的sealedFinal；不能先发success再运行safety。

### 24.12 Evidence emitter 与 six-step validator query

~~~ts
function emitEvidence(boundary: BoundaryObject, ctx: EvidenceContext): EventId {
  const eventWithoutId = evidenceSchema.encodeExact({
    ...ctx.stableRuntimeAndLineage,
    scope: ctx.scope,
    definitionCatalogRoot: ctx.definitionCatalogRoot,
    instanceCatalogRoot: ctx.instanceCatalogRoot, // null is allowed only for stage 1
    graphRoot: ctx.graphRoot,                     // null is allowed only for stage 1
    familyId: boundary.familyId,
    candidateKey: boundary.candidateKey,
    familyDefinitionHash: boundary.familyDefinitionHash,
    capabilities: boundary.capabilities,
    capabilitySetHash: boundary.capabilitySetHash,
    instanceKey: boundary.instanceKey,
    stage: boundary.stage,
    parentEventIds: ctx.parents.map(parent => parent.eventId),
    parentOutputHashes: ctx.parents.map(parent => parent.outputHash),
    inputSchema: boundary.inputSchema,
    inputs: boundary.canonicalInputs,
    inputHash: hashStageInput(boundary),
    factSchema: boundary.factSchema,
    facts: boundary.canonicalFacts,
    outputHash: hashStageOutput(boundary),
    outcome: boundary.outcome,
    reasonCode: boundary.reasonCode,
    latency: boundary.latency,
    extensions: sortAndRejectDuplicateSchemaRefs(boundary.extensions ?? []),
    source: locateRawBoundaryObject(boundary),
  });
  const event = addEventIdAndValidate(eventWithoutId);
  appendFsyncMonotonic(event);
  return event.eventId;
}

function validateSixStep(query: AcceptanceQuery, stores: ReadOnlyFactStores): Verdict {
  const tail = stores.events.exactCorrelation(query.processAnchor, query.correlationId);
  requireExactOrderedTail(tail, [3, 4, 5, 6]);
  requireSameProducerSessionGenerationRootsAndLease(tail);
  requireStage3ManyParentsThenLinearStage4To6(tail);

  const stage2Parents = requireExactOrderedRouteLegParents(tail[0], stores.events);
  const stage1Parents: EvidenceEventV1[] = [];
  for (const [legIndex, stage2] of stage2Parents.entries()) {
    requireStage(stage2, 2);
    requireOriginalBuilderRuntimeAndRawLocator(stage2);
    requireReadyMembershipForLeg(stage2, tail[0].facts.orderedInstanceBindingsRoot, legIndex);
    const stage1 = requireSingleParent(stage2, stores.events);
    stage1Parents.push(stage1);
    requireStage(stage1, 1);
    requireOriginalBuilderRuntimeAndRawLocator(stage1);
    requireCandidateInstanceAndDefinitionOrReuseBinding(stage1, stage2);
    requireMemoReuseProofWhenDeclared(stage1, stage2, stores.rawArtifacts);
    requireAuthorityProofReplay(stores.authorityProof, stores.reth, stage1);
  }

  requireReadyBeforePlanner(stores.checkpoint, stage2Parents, tail[0]);
  requireCurrentStateReplay(stores.reth, tail[1]);
  requireEveryLegExactAndActionOwner(tail[1], tail[2], stage2Parents);
  requireRealFinalSimAndSafetyReceipt(tail[2], tail[3]);
  return sealFailClosedDagVerdict([...stage1Parents, ...stage2Parents, ...tail]);
}
~~~

[PFD] query只含process anchor、correlationId与fact stores；不含target route、Family特判、builder callback或
“expected success”fixture。

## 25. Multi-Agent ownership and integration plan

### 25.1 并行规则

[PFD] 所有 Agent 从同一个 architecture-baseline commit 创建独立 branch/worktree。禁止共享工作树，禁止
两个Agent同时拥有同一package，禁止直接编辑另一个owner目录。跨package变化先改冻结spec并由integration
owner签发新baseline；不能靠临时相互import解决。

[PFD] 先冻结四类合同：Evidence Schema、core envelope/codec、Family/capability ports、authority/dependency
rules。冻结前只允许原型与审计；冻结后production工作包并行。工作包按完整模块边界拆分，不按单函数或
单测试微切片。

### 25.2 工作包

| Owner Agent | 可修改目录 | 禁止修改 | 输入 → 输出 / authority | 集成事实门 | 并行关系 |
|---|---|---|---|---|---|
| Core contract steward | specs/core-envelope、specs/capability-index、specs/authority-proof | apps、families、generated、validator | reviewed contracts → frozen spec roots；无runtime authority | exact schema/dependency hashes、跨语言vectors | 最先，与Acceptance contract共同freeze |
| Release-intent steward | specs/release-intent | generated、apps、Family源码 | 独立reviewed Family public-entry BOM → releaseIntentRoot | 两人review签名、manifest refs存在、无silent omission | Family proposals后串行；不得兼任runtime integration owner |
| Acceptance contract/schema | specs/evidence、acceptance/schema-codec、acceptance/validator、acceptance/authority-proof-interpreters、acceptance/negative-corpus、acceptance/cli | apps、packages、families、specs/release-intent | raw Evidence/Coverage/Head receipts → verdict；无production authority | impl calibration root、mutation corpus全拒绝、validator frozen hash | 最先；冻结后继续只读审计 |
| impl evidence adapter | acceptance/adapters/impl-readonly | impl工作树、production packages、validator | impl raw artifacts → canonical events；无成功创造权 | 每字段locator/hash，缺事实诚实fail | 与schema Agent协作，先于production |
| Canonical/durable checkpoint | packages/canonical-source、packages/canonical-codec、packages/durable-store、packages/checkpoint | Family/planner/execution | chain source + SQLite tx → SourceView/content/CAS root；拥有canonical、physical durability与checkpoint pointer | crash/reorg/CAS/partial-write/GC reachability事实 | contract冻结后可并行 |
| Family SDK/catalog generator | packages/family-sdk、packages/artifact-fingerprint、packages/catalog-generator | concrete families、planner、specs/release-intent、generated手写 | manifests+BOM → issuer/catalog/impact/composition roots | dependency closure、unknown schema fail、local invalidation、reproducible output | 与capability Agent并行，先于Family ports |
| Generated artifacts（machine-only） | generated/family-catalog、generated/runtime-composition仅由catalog-generator写 | 所有人手工编辑 | releaseIntentRoot+manifest roots → byte-reproducible artifacts | clean regenerate diff=0、BOM/catalog/runtime exact equality | integration owner只运行generator，不编辑产物 |
| Capability/interpreter | packages/capability-contracts、packages/capability-interpreters、packages/request-program | concreteFamily、scheduler internals | FrozenProgram → typed facts/interpretation ports | round-trip、field mutation、error ownership | 与SDK并行 |
| Discovery/attestation/generation builder | packages/observation、packages/discovery、packages/attestation、packages/generation-builder、apps/operator-cli | checkpoint internals、Family语义、ready internals、apps/searcher-runtime | SourcePlans+plugins+ports → exact partition/outcomes及唯一build orchestration；operator-cli仅status/read或向runtime admin port提交retryable probe，不直接开DB writer | 50-block、dedupe、once、typed outcome、无第二startup/promotion path | 依赖SDK/canonical contracts；与Graph owner按port并行 |
| Graph/readyGeneration | packages/catalog、packages/ready-generation、packages/graph | raw universe、Family internals、startup orchestration | verified publications + PromotionCallerToken → atomic immutable GraphView | full-root closure/CAS/canonical fence/crash/lease/adoption | 与state/scheduler并行 |
| State/scheduler/REVM | packages/scheduler、packages/shared-work、packages/state-runtime、runtime/revm-workers | Graph authority、Family math | generic work/program → source-bound facts | single-flight、quota、abort/HOL、permit守恒 | contract冻结后并行 |
| Producer/head-session | packages/producer | Graph write、discovery/attestation、Family语义、apps composition | active ready lease + canonical heads → immutable ProducerSession/correlation；拥有session admission/barrier，不拥有topology | serving-age/release/policy fence、100/100 terminal、active lease不变 | 依赖Graph/canonical/scheduler ports；与planner并行 |
| Planner/exact | packages/planner、packages/solver、packages/exact | families、protocol ABI/math | GraphView+opaque ports → route/current exact | no protocol import、current-source/fallback=0 | 依赖Graph/SDK port，不依赖Family实现细节 |
| Execution/final-sim | packages/execution-program、packages/final-sim、packages/safety、packages/submission、contracts/executor、contracts/interfaces | Family identities、signer secret | owned actions → program/real sim/unsigned receipt | action ownership、安全门、strict top-level sim | 与planner后半并行 |
| Evidence/telemetry | packages/evidence-emitter、packages/telemetry、acceptance/collectors | validator logic、production object creation | boundary objects → immutable events/metrics | raw locator、fsync、secret redaction | 所有owner提供boundary port |
| Family port groups | families/<assigned-set> | central packages、其他Family | frozen kernel + SDK → plugin/capabilities | identity/exact/action事实、无central import | 按Swap/Protocol/Funding/Credit分组并行 |
| Runtime integration owner | apps/searcher-runtime、deploy/systemd、deploy/runtime-shell | Family内部实现、validator、release-intent、generated手写 | generated catalog+composition+ports →唯一process | dependency closure、exact SHA、dry-run lineage | 最后集成；可运行generator但不可改生成物 |

[PFD] Family groups不是“一族一个中央补丁”。每组只修改自己目录；发现SDK缺能力时提交Capability Proposal：
新schema、通用语义、依赖closure与受影响Families。普通Family或capability扩展只能增加已声明的extension/
interpreter module，不得修改validator core或EvidenceEvent core schema；同一通用validator按schemaRef与
generated registry校验。只有确实改变所有模块共享含义的stable core envelope升级，才允许显式新major
schema并触发全局重验，不能把单个Credit/Family需求包装成core升级。无关Family保持原memo与验收，不进行
全量重跑。

### 25.3 Integration protocol

[PFD] 每个工作包交付一个coherent module commit，包含：

- frozen input/output spec hashes；
- authority与forbidden imports检查；
- ReuseReceipt（若提取旧资产）；
- deterministic contract evidence；
- raw事实验收入口；
- performance/resource receipt；
- exact commit与clean tree。

[PFD] integration owner只做port wiring与generated artifact更新，不在composition修Family bug。若集成需要
Family switch/address/ABI/selector或compat wrapper，拒绝集成并回到capability contract。Build绿不等于事实
验收；旧测试失败不授权恢复旧结构。

### 25.4 可并行与必须串行的边界

[PFD] Schema/validator calibration与core contract freeze必须串行在前；之后canonical/checkpoint、SDK/
capability、scheduler/state、Graph store可并行；Family port在SDK release后并行；planner/exact、execution/
final-sim在各自port稳定后并行；runtime composition、systemd dry-run与六步事实验收串行收口。

[PFD] 不允许为了多Agent吞吐创建共享“central TODO file”。跨owner问题进入content-addressed contract issue；
只有owner修改包，消费者更新到新spec hash。

## 26. Ordered greenfield implementation plan

[PFD] 这是空仓库内部的依赖顺序，不是旧runtime迁移、shadow或逐步cutover：

1. **冻结事实语言**：实现Evidence Schema、canonical codec、six-step state machine与negative corpus。
   Verify：schema hash、validator bundle hash、corpus root可复算。
2. **校准validator**：实现impl read-only adapter，读取真实impl dry-run/live artifacts与Reth事实。
   Verify：真实存在的事实可定位；缺事实诚实fail；mutation全部fail。
3. **签发architecture-baseline**：冻结core envelope、capability refs、error taxonomy、authority/dependency rules。
   Verify：所有owner只依赖spec hashes；新增Credit示例只影响declared closure。
4. **建立repo与依赖门**：创建最终package tree、forbidden-import linter、generated catalog pipeline。
   Verify：packages不能importfamilies，acceptance不能importproduction，空catalog可确定性生成。
5. **并行实现foundation**：canonical/durable-store/checkpoint、codec/SDK、scheduler/shared-work、REVM worker
   protocol、Graph store。
   Verify：reorg/CAS/crash、round-trip、single-flight/HOL、immutable lease事实合同。
6. **实现discovery/attestation/generation-builder**：declared SourcePlan、50-block observation、merged dedupe、
   typed outcomes、per-key durable writer、probe、memo impact与唯一source→promotion orchestration。
   Verify：SIGTERM中途恢复、exact partition、rejection不跨cutoff、invalidProgram阻止ready。
7. **实现atomic readyGeneration**：publication-only Graph、coverage/Graph/catalog一次CAS、lease/adoption。
   Verify：partial write不可见、ready前producer不可创建、activegeneration不可变。
8. **接入producer/state lanes**：blockscan/backrun共享lease，current-source reads与transport reserve。
   Verify：producer不拥有topology write；reorg取消；permit/queue守恒。
9. **接入planner/current-source exact**：protocol-neutralGraph、opaque handles、no fallback。
   Verify：source-bound exact lineage；central Family/protocol import=0。
10. **接入execution/final-sim/safety**：owned actions、obligations、reservedsim与unsigneddry-run。
    Verify：unknown action/obligationfail；最终top-level语义；standing/repayment/conservation执行。
11. **选择性移植Family kernels**：按ReuseReceipt复制ABI、reverse identity、math、exact/action算法，重写shell。
    Verify：每Family仅修改自己目录；oldclosurehash→newport evidence；central无分支。
12. **完成generatedcatalog与全族矩阵**：所有Familyexactset有source/outcome/publication/edge说明。
    Verify：Funding/Credit zero也有partition；silentmissing=0。
13. **接入nativeemitter**：在六个真实boundary写Event；validator保持frozen且无productionimport。
    Verify：rawlocator/root/Reth复核；不能通过手写成功fixture。
14. **做restart/差集/性能事实验收**：SIGTERM/systemd restart、memo reuse、singleprobe、100/100、P99。
    Verify：绝对预算、物理work不重复、Reth/CPU/queue不失控。
15. **exact-SHA systemd dry-run**：clean pushed SHA、executable/process/log anchor、默认无signer。
    Verify：runtime commit=deployed SHA；无nohup/旧process；不签名不广播。
16. **完成一条真实six-step lineage与全局零证明**：真实candidate到finalsim，同roots/correlation。
    Verify：legacy authority/import/runtime/log/consumer=0；所有事实门pass。

[PFD] 每一步不要求旧测试绿，不运行旧runtime作为Aloha fallback。实现中发现问题时按事实层定位：

| 事实停点 | 首查 owner |
|---|---|
| 无candidate/identity | SourcePlan、nomination、Family identity |
| publication有、ready无 | exact partition、coverage、promotion CAS |
| ready有、Graph缺edge | Family projection、Graph root builder |
| Graph有、planner不用 | GraphView lease、planner port |
| planner有、exact失败 | current source、state program、Family exact |
| exact有、program失败 | action owner、capability schema、obligation |
| program有、sim失败 | real EVM semantics、安全门、执行算法 |
| runtime事实与validator冲突 | raw locator后先审validator/collector，再判production |
| latency超标 | work counts、queue/permit、RPC/REVM lane与Reth contention |

[PFD] 这种定位不需要恢复旧authority。旧SHA只作为只读算法/行为参考。

## 27. Security boundary

[PFD] 以下是不可降级的系统边界：

1. 默认SEARCHER_DRY_RUN等价策略由类型和deploy profile同时强制；无signer port时production仍可完整运行。
2. 未经用户明确授权，禁止加载签名key、签名、广播、提高wallet cap或改变安全envelope。
3. final simulation必经且fail closed；effect/identity simulation不能替代它。
4. standing-position、repayment、conservation与EV/submission policy在最终program上执行；unknown obligation fail。
5. canonical number/hash/stateRoot、generation、GraphView lease在exact/program/finalsim前后复核。
6. systemd unit绑定exact pushed SHA、executable hash、PID/start/boot/log inode；禁止nohup或来源不明binary。
7. secrets不进入source、checkpoint、log、EvidenceEvent、raw locator或acceptance output；collector只读取allowlisted
   process metadata，不读取private key或完整env。
8. deploy shell默认不broadcast；即使未来获得授权，也必须script-enforced bounded envelope与human gate双成立。
9. RPC/provider响应视为不可信输入；codec exact-key、size/depth limit、deadline、canonical cross-check成立。
10. plugin与capability是受信代码但受最小port限制；不能取得checkpoint DB write、Graph active pointer、signer、
    submission或其他Family内部状态。
11. acceptance adapter与validator为只读；不能触发runtime action、RPC write、simulation success或deployment。
12. evidence真实性依赖多锚点，不把hash、日志文案或单一host当oracle。
13. operator admin port只绑定本机受限Unix socket与systemd identity；命令exact allowlist仅含status和同run
    retryable probe，不能替换candidate/cutoff、创建startup builder、promotion、signing或submission。

[PFD] 本文件只设计未来exact-SHA systemd dry-run边界；本轮不部署、不停进程、不签名、不广播。

## 28. Risks and explicitly resolved decisions

### 28.1 风险处置表

| 风险 | 已采用的终态决定 | 禁止的“快捷修复” | 事实证明 |
|---|---|---|---|
| Greenfield重复发明成熟算法 | 按文件ReuseReceipt选择性复用纯算法/成熟choreography | 全复制旧runtime或为了新颖全重写 | old/newcontent hash、dependency closure、contract evidence |
| 中央再次吸收Family特判 | opaque payload + generatedowner + capability proposal | if familyId、地址/ABI/selector/topic switch | forbidden import/literal审计 + 新Family不改central diff |
| Credit扩展导致Swap全重验 | declared transitive capability closure局部失效 | global definitionCatalogRoot变化即全量attest | impact receipt + unaffected memo reuse=100% |
| freeze层静默丢字段 | one schema生成codec/freeze/persist/transport/hash | handwritten DTO/copy | byte round-trip + per-field mutation + cross-language vectors |
| plugin bug变永久rejection | typed transportfacts，只有plugin显式proof可reject | decode throw+0x/revert中央推断 | proof binding + newcutoff revalidation |
| 50 blocks遗漏老实例 | observation与identityinventory分authority | recent swap冒充universe completeness | SourcePlan coverage + point-in-time enumeration |
| crash/人工停止从零开始 | per-key WAL/CAS中途flush | completed-only JSON/array index | fault injection + restart exact outcomes |
| checkpoint写入成性能瓶颈 | content-addressed records + small root transaction | 每25条重写巨型JSON | DB latency/WAL/fsync/P99 receipt |
| 统一调度变慢 | shared scan/single-flight、diff、lanes、quota、reserved capacity | 无界并发或跳过正确性 | physical work count + queues + 100/100 budgets |
| slowFamily拖死全局 | RPC/REVM/finalsim隔离、perFamilyquota/circuit | 每attest新daemon或singleFIFO | heavy/light progress与permit守恒 |
| activeGraph漂移 | immutablelease + safe adoption barrier | continuous publication/secondarymerge | root/lease events stage3–6不变 |
| validator塑造错误production | pre-freeze independentvalidator，rawfactonly | 为脚本绿改authority、targetfixture | impl+Aloha同validator、negative corpus、Reth复核 |
| impl校准被误当oracle | impl只做第一个被测系统，缺事实诚实fail | 数量parity或放宽schema | calibration receipt列missing bindings |
| finalsim被effectsim替代 | 独立top-level strictsim与reservedworkers | global disable EIP-3607 | stage6真实receipt + program/source binding |
| 多Agent互相覆盖 | 独立worktree、packageownership、frozen specs | sharedtree/central TODO/微补丁 | diff ownership与integration receipt |

### 28.2 已明确决定，不留实施期歧义

[PFD] 以下决定已关闭，不在实现期重新开放为兼容路线：

- Aloha 只有strict-only authority，无legacy/shadow/parity runtime；
- 最近edge/behavior observation恰好50 blocks；完整identity另有SourcePlan authority；
- active GraphView不可变，nextgeneration只能安全边界原子adopt；
- pending、retryable、invalidProgram任一非零都不能ready；
- chain-proven rejection不跨cutoff复用；verifiedmemo按显式dependency复用；
- CandidateKey稳定，RunCandidateKey绑定run/cutoff；不按数组index恢复；
- checkpoint逻辑单envelope、首个production物理实现固定SQLite WAL；
- protocol语义只在Family/capability，中央无固定Family/domain union；
- freeze/transport/hash来自同一schema；
- planner/solver只看genericGraph与opaqueports；
- current-source exact与final simulation无fallback；
- standing-position/repayment/conservation是通用obligation安全门，不是中央协议分类；
- acceptance先在impl真实证据上校准并冻结，之后同一schema/validator验Aloha；
- 成功验收只来自事实lineage；测试脚本是读者/校验器，不是truth creator；
- 性能是correctness交付的一部分，连续100/100与绝对预算不以旧实现失败而豁免；
- 默认dry-run；本文不授权签名或广播。

### 28.3 仍需测量但不改变架构的参数

[MTM] 目标硬件上的最优RPC/REVM concurrency、每lanequeue cap、WALbatch interval在第17节预算内通过事实
测量确定；Family成本模型与quota可调，但不能改变error ownership、memo语义或authority。若profile变更，
生成新PerformanceProfile hash并在同一100-head窗口重验；不要求无关Family重做identity attestation。

[PFD] 除§5.5/5.6明确R0白名单外，旧Family kernel一律按R2提取pure symbol；实现期ReuseReceipt只记录
实际选中symbol/content hash与新dependency closure，不再决定R0/R2分类。旧shell、TokenEdge和central
imports始终R3/R4，不能以“仍在审计”为由复制。

### 28.4 Definition of done

[PFD] Aloha只在以下事实同时成立时完成：

1. frozen schema/validator在impl校准且negative corpus全通过；
2. Aloha exact pushed SHA、clean tree、systemd/executable/PID/start/log anchor一致；
3. generated catalog exact set的全族Universe/Instance与Edge/Graph矩阵无silent missing；
4. readyGeneration为同一CAS，producer只持有immutableGraphView；
5. 至少一条真实dry-run candidate以同generation/cutoff/roots/correlation完成六步到finalsim；
6. restart复用、差集、singleprobe与SIGTERM恢复由durable facts证明；
7. 连续100/100与P50/P95/P99、throughput、resource/queue预算通过；
8. central Family/protocol semantics=0，legacy authority/import/runtime/log/consumer=0；
9. defaultdry-run、finalsim、standing/repayment/conservation与human signing/broadcast gate完整；
10. canonical文档、schema、generated catalog、runtime与acceptance receipt指向同一版本化合同。

[PFD] 任一项缺失都只能报告具体缺口，不能用build、unit、fixture、partialGraph、单次live、数量parity或
脚本自报pass替代。
