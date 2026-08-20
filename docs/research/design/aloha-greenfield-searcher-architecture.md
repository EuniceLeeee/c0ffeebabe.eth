# Aloha 绿地 Searcher 最终架构

> 状态：可直接指导实现的 strict-only 终态合同。
>
> Aloha 基线：codex/aloha@0a712e515b003cd6f578727be26360a8632bfcff。
>
> 冻结实现参考：impl@d33c8b48d43f0191db4354ebe4192d805ac9323f。
>
> 补充成熟模块复用审计：impl@ccb41fbb175fefaf6c388d62521c68966cc7c4a6。旧实现只提供可定位的
> 算法/行为样本；Aloha 性能不继承旧分支 verdict，最终只由 Aloha 自己的事实窗口证明。
>
> 本文只定义从空仓库直接实现的最终系统；不定义迁移、shadow或legacy双轨。本轮不执行部署，文中只设计
> future exact-SHA systemd dry-run边界；绝不授予签名或广播授权。
>
> 本文是 Aloha 的唯一 normative architecture。外部 greenfield v1.2 bundle 与旧仓库只作为设计来源和
> `untrusted-reference`；其 qualification、clean-room 与边界治理要求经本文明确吸收后才生效。发生冲突时，
> 本文的 single authority、immutable producer session、protocol-neutral core、plugin-owned typed outcome 与
> independent-fact verdict 优先。禁止执行者在两份文档间选择更容易实现的条款；任何新冲突必须通过版本化
> ADR与新canonical commit解决，不能silent merge。

## 0. 判断标签、引用方法与强制用语

本文用以下标签区分事实与设计，标签是结论的一部分：

| 标签 | 含义 |
|---|---|
| [VEF] | verified existing fact：在冻结 SHA 的源码、测试或已归档记录中可复核的既有事实 |
| [MDR] | mature design retained：已经暴露并修过真实问题、且符合 Aloha 解耦边界的成熟设计 |
| [ASR] | asset selected for reuse：经reference lock选定的pure symbol、declaration或明确不变量；不表示旧runtime可复制 |
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

[MDR] 绿地不等于拒绝成熟路线。只要旧机制满足以下全部条件，就可以作为主要参考、逐symbol采用
已证明的isolated pure kernel，或按新contract重写其成熟choreography：

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
→ Family-owned current-source coarse projections
→ protocol-neutral rank/prune + Top-K/bounded-unranked admission
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
9. impl 与 Aloha 都由同一个、先冻结且已资格化的事实验收协议判断；impl只是不可信reference
   producer，独立链上、Reth、数学与EVM事实才是oracle；
10. 默认 dry-run，final simulation、standing-position、repayment、conservation 与 submission gate
    全部 fail closed；
11. stable Family core只定义所有Family共同生命周期；未来新增domain或Family种类只增加versioned
    extension与自己的package，不修改中央pipeline，也不使未声明依赖的Family或predicate重验。
12. coarse pricing、ranking、bounded exact refinement、EV/valuation、mempool intake、head scheduling与安全门
    都作为正式模块保留；解耦只改变其authority/contract边界，不得以“绿地重写”为由删除成熟搜索漏斗。

### 2.2 Non-goals

[REJ] 本架构不包括：

- legacy 到 strict 的迁移顺序；
- shadow、capture、paired-live 或 parity cutover；
- 为旧 fixture、类名、导出或目录形状保留兼容层；
- 运行时 mutable topology；
- target route、pinned route 或手写成功 fixture；
- keeper/reward、inventory、private path、sandwich、JIT-LP；
- 当前release的Liquidity/LP authoring template、LP capability/schema/interpreter、LP Family、LP fixture、
  LP catalog/BOM entry或LP strategy；本轮只冻结通用extension与局部失效机制，不创建placeholder/stub；
- 本轮生产代码、测试实现、部署、进程操作、签名或广播。

[PFD] Aloha 可以继续支持当前 mission 内的 blockscan 与 public-mempool backrun，但两条 lane 必须
消费同一个 immutable GraphView，并在 current-source exact 后才能进入执行。

## 3. Verified evidence baseline

### 3.1 可复现基线

| 标签 | 冻结对象 | 已验证状态 |
|---|---|---|
| [VEF] | Aloha@0a712e515b003cd6f578727be26360a8632bfcff | 分支 codex/aloha；审计开始时仅有 AGENTS.md，工作树干净 |
| [VEF] | impl@d33c8b48d43f0191db4354ebe4192d805ac9323f | 旧 worktree HEAD 与冻结 SHA 相同；未跟踪的 listener/src/searcher/transport-schedule-policy.ts 属于用户，未读取为稳定事实、未修改 |
| [VEF] | impl@ccb41fbb175fefaf6c388d62521c68966cc7c4a6 | 补充成熟能力遗漏审计只从该committed Git object读取；dirty impl工作树不进入结论 |

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
| [VEF] | impl scheduler 以 producer-critical、producer-bulk、exact、discovery 分 lane，并为 producer 预留 physical transport capacity | impl@ccb41fbb:listener/src/searcher/reth-transport-scheduler.ts:1-13,30-35,46-118,160-218 |
| [VEF] | impl background transport 支持 idempotent、abort-aware 的抢占与重试，critical 串行、foreground 可并发 | impl@ccb41fbb:listener/src/searcher/live-reth-read-priority.ts:28-145,181-234 |
| [MTM] | Aloha 的head/session/startup/exact P50/P95/P99与resource budgets没有从旧实现继承的pass结论 | 必须由Aloha同一exact SHA/PID/source窗口的raw facts实测；impl数字只能定位回归，不能签发Aloha verdict |
| [VEF] | impl已有current-source coarse mid→ring score→rank→cheap exact refinement的成熟漏斗，但旧core仍依赖TokenEdge/协议形状、JS number，并允许deadline-unprobed fallback | impl@ccb41fbb:listener/src/searcher/detector/blockscan-scanner-core.ts:100-166,172-246,661-805；blockscan-candidate-refinement.ts:92-145,146-195,620-756 |
| [VEF] | impl已有next-block base fee、source-pinned oracle freshness、gas/bid/EV算术；旧shell把Chainlink地址和默认profit-token表写在中央 | impl@ccb41fbb:listener/src/searcher/ev-evaluator.ts:6-17,79-117,119-163,165-273；profit-token-valuation.ts:1-69 |
| [VEF] | impl已有canonical优先的pending evidence隔离、per-owner bounded queue、单tx冻结head与single-flight observation | impl@ccb41fbb:listener/src/searcher/pending-evidence-admission-queue.ts:23-130,132-235；pending-evidence-session.ts:16-140 |
| [VEF] | impl latest-head scheduler在单active pass下只保留最新pending head，并显式记录coalesced/drop与same-head revision | impl@ccb41fbb:listener/src/searcher/latest-head-scheduler.ts:23-49,61-145,147-218 |
| [VEF] | impl已有有界amount search、current-source逐leg exact propagation和链上Funding capacity refresh；旧Funding cache仍硬编码Multicall/adapter holder语义 | impl@ccb41fbb:listener/src/searcher/solver/amount-bounds.ts:7-79；amount-propagation.ts:20-137；flash-liquidity.ts:3-16,27-129 |
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
| [MDR] | coarse economic funnel | Family-owned current-source coarse projection只负责排序；Top-K加bounded unranked lane，只有带保守proof的profit upper bound才能hard prune |
| [MDR] | source-bound EV/valuation | next-block fee、measured gas、current valuation与bid policy分别绑定source和provider；未知valuation/gas/freshness不得通过submission EV gate |
| [MDR] | latest-head coalescing与pending intake bulkhead | 单active+latest pending、drop accounting；canonical traffic优先，unknown evidence按owner有界隔离且不能挤掉canonical |
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
referenceLockId
adoptionMode = isolated-pure-kernel | invariant-only-rewrite | reference-witness | rejected
newContractHash
newPath
dependencyClosureHash
authorityOwned = false
oldRuntimeDependency = false
familyBranches = none for central assets
schemaRoundTrip = pass
failureSemantics = declared
acceptanceEvidenceRefs
qualificationCertificateRefs
reviewer
~~~

[PFD] 旧source tree、package/import layout、runtime type、checkpoint、compatibility facade与whole directory
永不复制。只有先定义新contract、无I/O/hidden state/旧runtime type的isolated pure symbol或单一纯声明模块，
才可在exact blob lock与独立事实证明后adopt；其他资产只允许提取不变量并从零实现新shell、authority、schema
和port。不能把改名、移动文件或大段复制包装成“重写”。

## 5. Legacy architecture/code reuse matrix

### 5.1 判断代码

| 代码 | 结论 |
|---|---|
| R0 | isolated pure-kernel/declaration adoption：新contract先行，exact symbol/blob可采用；禁止runtime/lifecycle/whole tree |
| R1 | 成熟设计复用：保留合同与算法，按新 port 实现 |
| R2 | 提取纯算法：只拿无 authority 的局部算法 |
| R3 | 按新接口重写：旧边界、状态或依赖不可进入 |
| R4 | 完全废弃 |

[PFD] 为避免表格重复长前缀，§5只允许以下可机械展开的locator缩写；它们仍是exact SHA:path引用：

- `impl@d33c8b48 <bare-searcher-file>` = `impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:listener/src/searcher/<file>`；
- `impl@d33c8b48 venues/...`、`planner/...`、`solver/...`、`execution/...`、`detector/...` = 同SHA的`listener/src/searcher/<written-path>`；
- `impl@d33c8b48 shared/...` = 同SHA的`listener/src/shared/<remaining-path>`；`impl@d33c8b48 analysis ...` = 同SHA的`analysis/src/<remaining-path>`；
- `impl@ccb41fbb <bare-searcher-file>` = `impl@ccb41fbb175fefaf6c388d62521c68966cc7c4a6:listener/src/searcher/<file>`；
- 以`src/`、`listener/`、`analysis/`、`scripts/`或`docs/`开头的path从repo root解析；冒号后的`:a-b`始终是冻结object的`nl -ba`行号。

[PFD] `source存在`或`test存在`只标记审计locator，不是运行证据；表中所有未执行效果均标[MTM]。若路径不
符合上述唯一展开规则，必须在单元格写完整SHA:path，禁止靠文件名猜测。

#### 5.1.1 Clean-room reference lock 与 reuse ledger

[PFD] 新repo在任何旧代码读取或case导入前，必须创建machine-readable `reference-lock.json` 与append-only
`reuse-ledger.yaml`。前者锁定source repository、exact commit、path、blob、license和允许的disposition；后者
逐symbol记录新contract、adoption mode、destination、dependency closure、所需证据与review。旧仓库只能由
`tools/reference-only/**`按lock读取，不能成为submodule、vendor tree、build input或runtime dependency。

[PFD] required CI必须复核lock中的blob仍精确匹配、ledger覆盖所有production reuse、source-repository
production import closure为零、reference-only工具不进入acceptance predicate或production transitive closure。
旧输出只可生成`trustLevel = untrusted-reference`的neutral claim/witness，不能生成expected verdict、qualified
observer/verifier certificate或production acceptance pass。

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
| [ASR] R1 | impl@d33c8b48 final-simulation-work-runtime.ts | final-sim admission、reserved resources、queue、fence、retire；不拥有协议语义 | :49-145,291-535,570-724；final-sim tests | packages/final-sim；保留调度不变量并按新port/queue/cancellation重写；execution program schema、source/gen、safety root 变化使 receipt 不可复用 |
| [BRW] R3 | impl@d33c8b48 revm-sim-client.ts；listener/revm-sim/src/main.rs | single FIFO daemon 与 REVM engine；daemon/queue/prepared cache 隐藏状态 | client:175-261证明共享FIFO存在HOL结构；afcc07e8改为per-attest隔离但实际效果[MTM]；Rust仅impersonated frame放宽EIP-3607 | runtime/revm-workers + packages/request-program；提取REVM engine/caller-mode规则，重写有界worker pool、single-flight、request id、deadline、kill/reap |
| [ASR] R1 | impl@ccb41fbb live-reth-read-priority.ts | 无 authority 的 idempotent background preemption primitive；内部 active attempts/waiters | :28-145,181-234；源码定义caller abort不重试、internal preemption重试 | packages/scheduler/src/preemptible-background.ts；保留抢占/abort不变量但按新WorkClass、queue和cancellation contract重写；旧文件不复制 |
| [ASR] R1 | impl@ccb41fbb reth-transport-scheduler.ts | physical-request permit、lane reserve、active/queued metrics；固定四 lane，无 queue cap/owner fairness | :1-13,30-35,46-118,160-218 | packages/scheduler；保留 reserve/abort/release算法，扩展通用WorkClass、bounded ingress、owner fairness；调度policy变化不使semantic memo失效 |
| [BRW] R2/R3 | impl@ccb41fbb blockscan-state-coordinator.ts | state physical-read dedupe、changed-set与settlement有成熟机制；同一巨型类仍拥有旧published pointer、N-1与topology cache/CAS | :330-406,736-846,898-1016,1435-1507；本轮只作源码审计[MTM] | packages/state-runtime只提取source-bound read grouping、single-flight、changed-set与family-local settlement；published topology、N-1 carry与Graph authority全部拒绝 |
| [BRW] R3 | impl@ccb41fbb {blockscan-runtime-loop,discovery-backfill-lane}.ts | head orchestration、yield/cancellation与telemetry混有N-1 state producer、旧publication和producer-time backfill | loop:280-320,410-430,637-748；backfill:185-239,291-423 | packages/producer/scheduler只重写latest-head sequencing、cancellation与work telemetry；禁止N-1 exact authority、producer-time discovery/backfill及任何topology publication |
| [ASR] R1 | impl@d33c8b48 canonical-header-journal.ts、producer-generation-freeze.ts | canonical header proof 与禁止 producer publication；journal size/process state | generation-freeze.ts:1-12；canonical journal tests | packages/canonical-source + packages/producer；保留 hash/fence原则，重写为 SourceView 与 GraphView lease |
| [ASR] R1 | impl@ccb41fbb latest-head-scheduler.ts | 单active/latest-pending coalescing、same-head revision、drop accounting；不拥有Graph/Family语义 | :23-49,61-145,147-218；旧test只作算法locator[MTM] | packages/producer/head-scheduler；保留状态机并将revision绑定immutable SourceSession/trigger context；不得用revision刷新topology |
| [BRW] R1/R3 | impl@ccb41fbb {mempool-intake,pending-evidence-admission-queue,pending-evidence-session}.ts | full-vs-filtered targets、canonical优先、unknown per-Family queue、one-tx frozen head；旧类型依赖PoolEntry/SwapAdapter/ExecutionFamilyId | intake:5-62；queue:23-130,132-235；session:16-140 | packages/producer/backrun-intake + scheduler；从ready GraphView与generated observation owners派生目标，central只按opaque ownerRef公平；unknown evidence不可挤掉canonical，provider subset不能冒充complete intake |
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
| [ASR] R2/R3 | impl@ccb41fbb detector/{blockscan-scanner-core,blockscan-candidate-refinement,blockscan-mid-batch}.ts | ring enumeration、coarse score/rank、ordered bounded reads、cheap exact refine；旧实现依赖TokenEdge/协议mid fields/JS number，且deadline-unprobed可回流fallback | scanner:100-166,172-246,661-805；refinement:92-145,146-195,620-756；mid-batch:1-46 | packages/coarse-economics + planner/refinement；保留漏斗choreography与deterministic bounded batch，重写schema/ports；普通score只排序，unprobed进入bounded unranked lane且仍必须exact，绝不作为execution fallback |
| [BRW] R1/R3 | impl@ccb41fbb {ev-evaluator,profit-token-valuation}.ts | next-block EIP-1559、gas/bid/valuation/freshness；旧中央写死Chainlink与token rule表 | ev:6-17,79-117,119-163,165-273；valuation:1-69 | packages/economics + safety；采用EIP-1559/整数舍入pure kernels，oracle/asset valuation由generated owner capability提供current-source facts；unknown valuation/gas/freshness fail-closed于EV/submission |
| [ASR] R2 | impl@d33c8b48 solver/{amount-bounds,amount-propagation,v2-constant-product-math,v2-fee,v3-math,v4-math,curve-math}.ts | 纯数值算法与协议数学；当前位于中央 | mathematical tests；中央 import协议 math违反边界 | 通用 amount bounds留 solver；V2/V3/V4/Curve math移动对应 Family kernel，不得由中央 import |
| [ASR] R2/R3 | impl@ccb41fbb solver/{amount-bounds,amount-propagation,flash-liquidity}.ts | bounded grid/GSS、逐leg strict exact、Funding capacity aggregation；旧flash cache硬编码Multicall和adapter holder，propagation仍依赖旧edge/session | bounds:7-79；propagation:20-137；flash:3-16,27-129 | packages/solver保留generic bounded optimizer和ordered exact propagation；Funding plugin签发source-bound CapacityFact，central只比较asset/amount/owner handle；Multicall只是generic transport batching |
| [BRW] R2/R3 | impl@ccb41fbb detector/victim-effect.ts、live-backends/victim-overlay.ts、detector/victim-source-quality.ts | trigger matching/affected-edge/overlay流程成熟，但中央旧union含swap/oracle、selector/ABI/adapter fields；历史sender streak可hard skip | victim-effect:9-91,105-165,167-240；overlay:18-97,99-125；quality:13-55 | families/<id>/trigger-effect capability + packages/producer/trigger-session；plugin输出opaque affected handles与EffectProgram，central只编排source-bound replay；source-quality仅telemetry/soft rank，不得hard admission |
| [BRW] R3 | impl@ccb41fbb detector/pool-impact.ts | mutation-only impact、receipt/log identity、source-generation binding、Family observer exact-trigger consumption、direct-call与receipt合并、ordered transition与post-state completeness；同时混有旧PoolEntry/TokenEdge形状 | :23-86,97-124,126-241,245-479,506-705,707-862；本轮只读审计[MTM] | families/<id>/trigger-effect + packages/producer/trigger-session；完整保留`receipt/log identity → source binding → Family observer → exact trigger → unresolved/mutation-only/impact分离 → ordered transition → overlay/replay`；禁止中央看到Swap topic就构造impact，禁止mutation-only伪造token direction；旧DTO和中央union重写 |
| [BRW] R3 | impl@ccb41fbb solver/pool-state-cache.ts、pinned-warm-pools.ts | V2/V3/V4/Curve warm state、epoch、tick/bitmap、batch warm与overlay invalidation是成熟性能能力；同时中央持有协议map、文件配置和静态fallback风险 | pool-state-cache.ts:1-14,294-412,414-559,561-729,731-1040+；pinned-warm-pools.ts:33-100,102-227；本轮只读审计[MTM] | packages/state-runtime + families/<id>/state; Family-owned `StateRead/StateSnapshot`与通用source-bound cache；保留warm/local math与invalidate算法，删除中央V2/V3/V4/Curve map；pinned hint只能引用ready Graph中的opaque edge，不得创建admission/edge/topology；warm失败显式unresolved，禁止pinned/legacy quoter fallback |
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
| [ASR] R0 | impl@d33c8b48:src/interfaces/{IERC20,IFluidVault,IMorpho,ISwap}.sol | 四个纯 ABI declaration，无 runtime authority | 冻结source；旧compile/tests只作locator，本轮未执行[MTM] | contracts/interfaces；新contract先行后按§5.5 exact declaration blob采用，接口 hash进入使用它的 Family kernel closure |
| [REJ] R4 | impl@d33c8b48 src/FlashArb.sol、Constants.sol 的具体路线 | wstUSR/Morpho/Fluid/PSM/V3/V4/Curve 硬编码执行合同 | FlashArb.sol:10-17,35-82,84-180 | 永不作为通用 Aloha execution authority；协议动作必须由 plugin action owner生成 |
| [ASR] R2 | impl@d33c8b48 shared/evidence/semantic-six-step.ts、impl@d33c8b48 analysis {six-step-validation-controller,six-step-validation-lifecycle,six-step-judgment}.ts | semantic evidence、validator、controller、merge/review lifecycle；旧 stage/route/branch authority混合 | semantic-six-step.ts:42-258；controller:313-680,1403-1651；lifecycle:327-570 | acceptance/schema-codec + acceptance/validator；提取 canonical/ordered/commitment算法，重写所有 stage和控制面 |
| [ASR] R2 | impl@d33c8b48 analysis trusted-six-step-runtime-attestation.ts | SHA/PID/starttime、content-addressed inputs、secret filtering；AWS/SSM耦合 | :72-199,276-399；AWS/SSM :17-19,201-274,402-613 | acceptance/collectors；提取纯验证，部署 collector为port；AWS/SSM/path不进入core schema |
| [BRW] R3 | impl@d33c8b48 {systemic-live-gate,serial-systemic-live-evidence}.ts | coverage/throughput/P95 evaluator与log parser | systemic gate:37-82；serial:26-144；只证明旧计算形状，不证明Aloha预算[MTM] | acceptance/validator + acceptance/collectors；保留计算概念，改成exact process/run/root joins、P99与raw receipt set |
| [REJ] R4 | impl@d33c8b48 architecture-migration-fixture-replay.ts、blind-*、paired-live、shadow/capture/parity与对应成功 fixtures | 迁移、target/capture、对比 authority | 不能证明production-issued对象 | 不进入 Aloha；只允许人为损坏 evidence 用于 validator negative calibration |
| [BRW] R3 | impl@d33c8b48 scripts/deploy-node.sh 与 systemd shell | exact SHA、dry-run/live marker、wallet cap、EV gate；同时含大量旧 env/feature flags并读取私钥 | deploy-node.sh:16-23,337-380,401-480,616-696 | deploy/runtime-shell；保留 exact SHA、systemd、default dry-run、human gate；删除 legacy flags；evidence collector不得读取私钥 |

### 5.5 Isolated declaration adoption 白名单

[PFD] R0是封闭的isolated declaration清单，不是实施者可自行扩展的资产类别。Git blob ID绑定冻结内容；
采用前必须已有独立新contract，ReuseReceipt另记SHA-256、license与new dependency closure：

| 冻结SHA:path | Git blob ID | R0范围 | Aloha目标 |
|---|---|---|---|
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IERC20.sol | 6235ad08ac04be0b3030678fb614bb3d9273a034 | entire interface | contracts/interfaces/IERC20.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IFluidVault.sol | 4abea40103ce2e59e1894a367c84f04a1ed71a83 | entire interface | contracts/interfaces/IFluidVault.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/IMorpho.sol | 828245a0ca0bf08035c64c506edde0cf9447bc6e | entire interface | contracts/interfaces/IMorpho.sol |
| impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:src/interfaces/ISwap.sol | 5eab400561a96533cf3d204e3dddc3577c0d84c3 | entire interface | contracts/interfaces/ISwap.sol |

[PFD] 以上四项之外没有R0。Pure math、ABI、codec helper即使看起来无状态，也统一是R2逐symbol提取；
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
| venues/blockscan-state-capability.ts | BlockSource/ChainLog/MutationQueryDescriptor、Family state projection、mutation classification/carry proof、coverage/source facts、source-bound StateRead与retryable failure；同时承载旧schema assembly | impl@ccb41fbb source:18-75,77-183,185-223,241-286,321-380[VEF] | R2提取Family state语义与mutation/carry不变量；R3重写schema/ports | packages/state-runtime + families/<id>/state；coordinator只做batch/deadline/retry/publication，source provenance由core绑定；不得由state coordinator拥有Graph/topology或第二mutable cache |
| blockscan-state-cache.ts | source-pinned resumable raw cache | source:9-24 | R3 schema重写 | state-runtime→packages/durable-store；key含chainId/block hash/request+codec hash |
| blockscan-multicall.ts、blockscan-pass-deadline.ts | generic batching/deadline但输入旧Pool/Graph shapes | deadline test存在[MTM] | R2提取generic算法 | scheduler/state-runtime only；不得创建edge或coverage |
| venues/route-immutable-binding.ts、venues/route-instance-identity.ts | immutable binding/hash与Family-owned instance/edge/plan identity算法成熟，但旧payload含旧DTO、adapter/PoolEntry fallback与protocol fields | impl@ccb41fbb route-immutable-binding.ts:3-138；route-instance-identity.ts:12-252[VEF] | R2提取domain-separated hash/ownership/duplicate检查；R3重写payload与issued handle | packages/planner + packages/graph；identity由`FamilyInstanceKey + direction + ExecutionVariantKey + opaque route binding`组成；中央只验证hash/lease/generation，不能从PoolEntry/TokenEdge推导协议语义 |
| blockscan-route-identity.ts | deterministic route identity思想；旧preimage含adapterId/PoolEntry fields并用JSON stringify | impl@ccb41fbb source:1-61[VEF] | R3 schema重写，R2提取domain-separated ordered identity不变量 | packages/planner；RouteId只哈希ordered canonical edge refs、directions、generation/Graph binding和strategy objective，不含协议字段 |
| mempool-intake-refresh-signal.ts | process-local observer set；旧语义可在任意notify重连filtered subscription | impl@ccb41fbb source:1-13[VEF] | R2提取subscription primitive，R3重写adoption trigger | producer/backrun-intake只在ready generation安全adopt或provider reconnect时重建filter；notify不得改变Graph/admission authority |
| blockscan-backrun-state-bridge.ts | current-N snapshot→旧PoolStateCache的第二mutable state publication；V2/V3 taxonomy | source:1-90及tests存在[MTM] | R4 bridge authority；R2仅提取source monotonicity/check算法 | blockscan/backrun直接消费同一SourceSession+state-runtime facts，不复制到第二cache |
| blockscan-enumeration-solver-{telemetry,worker}.ts | bounded worker/file writer含queue hidden state；payload仍是旧route/pricing mode | source开头及tests存在[MTM] | R3 telemetry schema；R2提取bounded writer/rotation算法 | packages/telemetry只写architecture-neutral receipts，永不影响planner/acceptance verdict |
| blockscan-view-overrides.ts | 文件中的raw PoolEntry注入production view，含legacy adapter taxonomy | source:1-55[VEF] | R4完全废弃 | 不允许operator file创建edge/instance；测试输入只在contract test process内 |
| detector/blockscan-scanner-core.ts | generic ring/path scan依赖旧TokenGraph | source存在；冻结tests/旧live未在本轮验证[MTM] | R2提取scan/ring算法 | producer→protocol-neutral GraphView/planner port |
| detector/blockscan-scanner-production.ts | production facade把AdapterRuntimeSnapshot/TokenEdge/pricing/funding合并并带degraded mode | source:1-90[VEF] | R3重写boundary；core scan算法沿上一行R2 | packages/producer→packages/planner，只收immutable GraphView/SourceSession；无degraded/default edge |
| venues/swaps/view-quote-blockscan-state.ts、adaptive-view-quote-blockscan-state.ts | grouped prerequisite/dependent reads、Family-owned decode、source-pinned amount ladder与bounded rounds；旧实现仍把alternate quote写成中央fallback语义 | view-quote:22-109,125-337；adaptive:24-122,124-329[VEF] | R2提取分轮read/依赖与bounded ladder算法；R3重写schema/ports | families/<id>/quote + packages/state-runtime；healthy path只跑首选amount，失败才走capability-local bounded alternate program；zero/revert/unresolved显式返回，绝不能成为中央legacy quoter |
| blockscan-pass-timeline.ts | state→enumeration→exact_refine→planner_solver→final_sim→EV阶段顺序、cumulative head budget、atomic timing merge | impl@ccb41fbb source:1-155[VEF] | R2提取architecture-neutral timeline/receipt算法，R3重写字段 | packages/telemetry + acceptance/collectors；只观察阶段顺序、预算与timing，不拥有routing/correctness authority，不得以timeline脚本补production事实 |
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

[PFD] Family ABI与pure math不属于R0；四个Solidity interface declaration是全部白名单，
精确SHA/path/blob见§5.5。

### 5.7 冻结 Family kernel inventory

[VEF] impl冻结generated inventory在
`impl@d33c8b48d43f0191db4354ebe4192d805ac9323f:listener/src/searcher/generated/production-family-entries.generated.ts:1-47`
精确列出22个entry。该清单是本次复用审计分母，不是Aloha中央admission allowlist；Aloha release分母最终只
来自独立release-intent BOM与generated exact equality。

[PFD] 下表的Swap/Protocol/Funding/Credit只是人类复用审计与owner分组标签，不是FamilyManifest字段、runtime
domain enum、中央dispatch、validator分支或未来封闭集合。当前release不含LP；不得据此生成LP placeholder、
absence slot或验收分支。

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
│   ├── predicates/                   # versioned pass/fail/invalid Fact Contracts
│   ├── capability-index/             # capability IDs/versions/dependencies
│   ├── authority-proof/              # architecture-neutral proof programs
│   ├── governance/                    # architecture-boundaries/reference-lock/reuse-ledger schemas
│   └── release-intent/               # independently reviewed Family/Strategy BOM exact set
├── generated/
│   ├── family-catalog/               # immutable definitions/data/root
│   ├── strategy-catalog/             # generated current strategy refs; no LP strategy
│   └── runtime-composition/           # only generated imports of Family public entries
├── packages/
│   ├── canonical-codec/              # schema-derived canonical bytes/hash
│   ├── canonical-source/             # header/state-root/canonical view
│   ├── durable-store/                # one SQLite WAL content/CAS implementation
│   ├── observation/                  # raw block/log/tx ingestion
│   ├── family-sdk/
│   │   ├── authoring/                # build-time generic big template; never runtime-imported
│   │   ├── conformance/              # compiles/validates definitions
│   │   └── runtime-refs/             # narrow stage refs + opaque handle issuers
│   ├── strategy-sdk/                 # planning composition contract; protocol-neutral
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
│   ├── coarse-economics/             # current-source projections, rank/prune proof
│   ├── economics/                    # valuation, gas, EV and bid policy
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
│       └── capabilities/              # nomination/identity/state/coarse/trigger/exact/action
├── strategies/
│   └── <strategy-id>/                # current production strategies only; no LP strategy
├── runtime/
│   └── revm-workers/                 # isolated single-flight worker protocol
├── contracts/
│   ├── executor/
│   └── interfaces/
├── acceptance/
│   ├── schema-codec/                 # generated independently from specs
│   ├── validator/                    # no production imports
│   ├── predicate-specs/
│   ├── reference-models/             # math/small-model/independent engine oracles
│   ├── observer-qualification/
│   ├── authority-proof-interpreters/ # generic replay of declared proof programs
│   ├── collectors/
│   ├── negative-corpus/
│   └── cli/
├── tools/
│   └── reference-only/
│       └── impl/                     # exact-SHA claim importer; untrusted-reference
└── deploy/
    ├── systemd/
    └── runtime-shell/
~~~

[PFD] generated/runtime-composition 是唯一允许 import families/<id>/public-entry 与当前strategy public entry
的文件集合；它完全由
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
| Family authoring definition | build-time protocol meaning、canonical identity、descriptor、route memo、state/exact/action declarations | runtime authority、canonical header、CAS、scheduler permit |
| generated Family stage refs | 当前stage唯一issuer/capability/action owner refs | 完整authoring definition、其他stage能力、protocol dispatch |
| Strategy plugin | generic capability refs如何组成planning problem/constraints | Family协议语义、Graph写、solver kernel、submission |
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
| coarse-economics | source-bound coarse projection aggregation、generic rank与有proof的prune | edge creation、exact/execute authority、协议math |
| economics | current valuation/gas/EV/bid policy与sealed economic receipt | Family pricing math、signing/broadcast authorization |
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
  APP["apps/searcher-runtime"] --> PROD["producer / coarse-economics / planner / exact / economics / execution / final-sim"]
  APP --> GEN["ready-generation / graph / attestation"]
  APP --> COMPOSE["generated runtime composition"]
  COMPOSE --> CAT["generated family/strategy catalogs"]
  COMPOSE --> FAM["families + strategies public entries"]
  CAT --> SDK["family-sdk runtime refs + capability contracts"]
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
- production packages、stages、orchestrator或apps import `family-sdk/authoring`、完整Family definition或
  callable runtime god object；authoring façade只允许families/*/family-definition与catalog-generator导入；
- 一个 Family import 另一个 Family 的内部实现；
- planner、solver、state-runtime、execution-program import protocol ABI/math；
- acceptance import apps/**、packages/** production implementation 或 families/**；
- acceptance predicate/observer import `tools/reference-only/**`或根据impl/Aloha producer身份选择不同规则；
- acceptance/{validator,predicate-specs,reference-models} import acceptance/collectors、environment adapters、
  RPC/network/filesystem/process/child-process clients；GateCore只读冻结QualifiedFactSnapshot并运行pure codec/
  interpreter/reference model；
- tools/reference-only进入production、generated runtime或acceptance predicate transitive closure；
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

### 8.5 Machine-enforced boundary CI

[PFD] `architecture-boundaries`、`production-import-closure`、`reference-lock-integrity`、
`reuse-ledger-coverage`、`generated-reproducibility`与`acceptance-isolation`是required checks。它们读取
machine-readable manifests并在以下任一事实成立时阻止merge：禁止import/literal出现；authoring façade或
reference-only工具进入runtime/validator closure；旧repo package/blob未登记；handwritten generated diff；
新增Family/Strategy修改中央源码；reuse ledger与实际production blob closure不一致。脚本只机械收集和比较
这些事实，不能通过修改allowlist把违规结构声明为正确。

[PFD] required credit只能来自固定Git/build分母与pinned compiler/build graph：TypeScript/JavaScript读取exact
`tsconfig`、NodeNext resolution、workspace package exports/imports及build metafile；Rust读取locked cargo
metadata、compiler messages/dep-info、features/build-script/proc-macro与generated inputs；Solidity读取pinned
Forge build-info或solc standard-json、remappings及完整compiler input。若当前release尚无某语言，该adapter可
absent；该语言的第一个source进入denominator时必须先交付并qualification对应adapter，否则boundary verdict
为invalid，不能靠删除extension或optional root放行。

[PFD] 分母来自exact clean pushed Git tree、build manifests与generated output tree，不来自调用者可调的
`sourceExtensions`、任意exclude或repository-wide `other` root；manifest、compiler、resolver、generator与
denominator roots全部hash绑定。自写lexical scanner只可标记
`coverageClass="bootstrap-lexical" / requiredCredit=false / legacyZeroCredit=false`，不得命名为最终check、挂名
证明production closure或使baseline通过。所有mutation fixture按caseId+path+offset+diagnostic形成exact
multiset；“出现过某个错误”不能给同文件其他漏检攻击喂绿。

## 9. Family SDK and plugin boundary

### 9.1 Build-time Family 大模板与 stable core

[PFD] 完整大模板必须保留，但它是Family作者和catalog compiler使用的build-time authoring façade，不是
runtime god interface。大模板一次呈现manifest、共同lifecycle、versioned extensions、action owners与事实
声明，以强类型关系防止Family内部字段错配；production stages永远不能import或持有它。

~~~ts
type FamilyId = OpaqueString<"FamilyId">;
type FamilyCandidateKey = Hash;
type FamilyInstanceKey = OpaqueString<"FamilyInstanceKey">;
type CapabilityId = OpaqueString<"CapabilityId">;

type AuthoringCapabilitySlot<C> =
  | { readonly kind: "present"; readonly module: C }
  | { readonly kind: "absent"; readonly reason: DeclaredAbsenceReason };

interface FamilyAuthoringDefinitionV1<Extensions extends CapabilityAuthoringMap> {
  readonly manifest: FamilyManifestAuthoring;
  readonly core: {
    readonly nomination: NominationAuthoringModule;
    readonly identity: IdentityAuthoringModule;
    readonly materialization: MaterializationAuthoringModule;
    readonly projection: ProjectionAuthoringModule;
    readonly rehydration: RehydrationAuthoringModule;
  };
  readonly extensions: {
    readonly [K in keyof Extensions]: AuthoringCapabilitySlot<Extensions[K]>;
  };
  readonly actionOwners: readonly ActionOwnerAuthoringDeclaration[];
  readonly acceptanceDeclarations: readonly FamilyFactContractRef[];
}

declare function defineFamily<E extends CapabilityAuthoringMap>(
  definition: FamilyAuthoringDefinitionV1<E>,
): FamilyAuthoringDefinitionV1<E>; // build-time only
~~~

[PFD] `core`只固定每个load-bearing Family都必须经历的nomination→identity→materialization→projection与
rehydration lifecycle，以及Family/issuer/schema/source/authority/hash引用；它不固定任何domain payload、
资产数量、position种类、quote模型或execution action。`extensions`只覆盖当前release capability index中已
声明的slot；未来尚不存在的domain不在本baseline伪造`absent`条目。

[PFD] 本release只有通用`defineFamily()`，不提供`defineLiquidityFamily`、LP archetype或LP capability。
未来MAY增加authoring-only domain helper，但它只能把typed authoring fields编译为同一versioned extension
slots；不得进入runtime、增加stable core字段或产生中央domain union。若某需求确实改变所有Family共同语义，
必须单独core-major ADR、全局impact声明和重新qualification，不能把单个新domain需求伪装成core升级。

### 9.1.1 Generated runtime refs

[PFD] catalog compiler把大模板编译为不可调用的definition data与stage-local refs：

~~~ts
interface GeneratedFamilyEntryV1 {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly issuerRef: FamilyIssuerRef;
  readonly authorityRef: AuthorityDeclarationRef;
  readonly lifecycleRefs: {
    readonly nomination: CapabilityRef;
    readonly identity: CapabilityRef;
    readonly materialization: CapabilityRef;
    readonly projection: CapabilityRef;
    readonly rehydration: CapabilityRef;
  };
  readonly extensionRefs: readonly CapabilityRef[];
  readonly actionOwnerRefs: readonly ActionOwnerRef[];
  readonly factContractRefs: readonly FamilyFactContractRef[];
}

type StageFamilyRefs =
  | { readonly stage: "nomination"; readonly nomination: NominationRef }
  | { readonly stage: "identity"; readonly identity: IdentityRef }
  | { readonly stage: "materialization"; readonly materialization: MaterializationRef }
  | { readonly stage: "projection"; readonly projection: ProjectionRef }
  | { readonly stage: "rehydration"; readonly rehydration: RehydrationRef }
  | { readonly stage: "capability"; readonly capability: DeclaredCapabilityRef };
~~~

[PFD] runtime catalog按stage签发最窄ref；attestation、Graph、planner、exact与execution均不能取得完整
`GeneratedFamilyEntryV1`或其它stage callable。Candidate、Identity、Descriptor、RouteMemo、State、Choice与
Action payload对中央都是schema-tagged opaque canonical bytes；中央可以校验schema/hash/size/source/issuer，
但不能解析协议意义。

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

[PFD] 新增当前已有capability集合内的Family只改自己的package、release-intent与generated artifacts。未来新增
domain时，默认只增加自己的versioned extension schema/interpreter、可选authoring helper、Family package与
BOM entry；stable core、中央runtime、planner/solver与validator core仍不变。未声明新extension依赖的既有
Family/Strategy继续复用原semantic receipts。当前实施工作包不包含LP。

### 9.4 Family Plugin 与 Strategy Plugin 分离

[PFD] Family声明“某实例能做什么”；Strategy声明“如何把generic capability/Graph refs组成planning problem”。
Strategy不得importFamily实现或协议字段，planner/solver kernel也不得按strategy id分支：

~~~ts
interface StrategyAuthoringDefinitionV1 {
  readonly strategyId: StrategyId;
  readonly requiredCapabilityPredicates: readonly CapabilityPredicateRef[];
  readonly planningProblemIssuer: PlanningProblemIssuerRef;
  readonly constraintSchemaRefs: readonly SchemaRef[];
  readonly factContractRefs: readonly PredicateSpecRef[];
}
~~~

[PFD] strategy compiler同样只生成窄runtime ref与dependency closure。新增未来LP组合策略只能增加新的strategy
package、BOM与generated entry，不修改Family core、planner kernel、solver kernel或validator core；本release
不定义LP strategy。

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

interface ExtensionSlotDeclaration {
  readonly capabilityRef: CapabilityRef;
  readonly requiredByArtifactKinds: readonly ArtifactKind[];
  readonly dependencyIds: readonly CapabilityId[];
  readonly ownerRef: GeneratedOwnerRef;
}
~~~

[PFD] capability ID 标识语义，version 标识兼容合同，schemaHash 绑定数据形状，
interpreterHash 绑定执行/解释语义。pluginCodeHash、authorityHash 与 canonicalIdentityHash 单独绑定。
展示层 MAY 从 manifest 读取 opaque namespace/tag，但中央不得把 swap/protocol/funding/credit 固定成 union，
也不得按 namespace 分派或失效；语义只来自显式 capability ID 与 dependency closure。

[PFD] authoring helper只在build-time把强类型字段编译成`ExtensionSlotDeclaration`；runtime没有domain helper。
任何artifact只能读取自己声明的slot及传递依赖，未声明extension不能被interpreter读取，也不能进入其fingerprint。

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
| 新增未被既有 Family/Strategy 声明的future-domain capability | 新/opt-in声明者；既有未依赖Family/Strategy不失效 |
| authority declaration或proof-source identity | 使用该 authority 的 Family |
| canonical identity hash | 该 FamilyInstance |
| nomination evidence变化，但identity/static validity仍成立 | 更新observation receipt；不自动失效verified identity memo |
| stable core envelope语义变化 | 显式全局revalidation |
| scheduling、telemetry、日志展示变化 | semantic memo不失效 |
| final-sim safety contract变化 | execution/final-sim receipt失效；identity memo不失效 |
| definition catalog新增独立Family | global definitionCatalogRoot变化；既有Family semantic memo仍可内容寻址复用 |
| strategy catalog/implementation变化 | 新producer sessions、planning/exact downstream artifacts；ready Graph与Family memo不失效 |

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

[PFD] 未来若增加LP或其他domain authoring helper、新capability和新Family，允许global catalog root变化；既有
Swap/Protocol等未声明依赖者的requested closure roots、memo、predicate qualification与pinned semantic
outputs必须byte-stable并100%复用，旧generated entries也必须byte-identical。这里的LP仅是假设性impact case；
当前catalog不得签发任何LP CapabilityId或SchemaRef。

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
capabilityRef、canonical payload bytes、hash 与 cancellation/deadline。未来domain增加新字段时，新增或
升级自己的capability schema；任何不依赖该capability的payload不变化、不失效。本baseline不预建LP字段。

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

[PFD] PersistedGraphEdge只包含通用transition事实：ordered input/output asset ports、opaque transition ref、
persistent RehydrationRef、generic constraint refs、owning Family+Instance lineage、static projection hash。它
不假设二元swap、固定资产数量或position模型，也不含v2FeeBps、v3Fee、curveI/J、v4PoolKey、protocol name、
ABI、storage slot或中央可解释的protocol/domain kind。`Edge`只是当前Graph成员命名，不授予swap taxonomy。

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

[PFD] head scheduler采用单active+latest-pending状态机；中间head可coalesce但每次drop都产事实，same-head
revision只表示新的immutable trigger/evidence context，绝不刷新Graph或改变generation。shutdown停止admission、
取消pending并等待active按deadline结算，不能留下无terminal的eligible head。

[PFD] public-mempool intake的完整target set由当前GraphView实例与generated observation/trigger owners联合签发。
provider-side filtered subscription只是优化：只有另有完整local firehose时才允许subset；否则filtered truncation使
coverage invalid。canonical target traffic始终优先，unknown/evidence-promoted traffic按opaque ownerRef使用有界
queue、per-head admission cap与round-robin，不能挤掉canonical或兄弟owner。每笔pending tx只冻结一个canonical
head/source并对同owner observation single-flight。

[PFD] victim/trigger decode、affected instances、pre-state/post-state effects、overlay/preCalls与可观测账户全部属于
Family TriggerEffect capability。中央只接收schema-bound `TriggerFact + affected handle refs + EffectProgram`并在
同一SourceSession编排replay；不保留中央`swap|oracle` union、selector/ABI/adapter switch。历史sender/source
quality只能用于telemetry或soft rank，不能hard skip或形成chain-proven rejection。

[PFD] TriggerEffect capability必须保留完整的impact证据链：receipt/log identity先绑定canonical source generation，
再由Family observer消费exact trigger并声明affected instance；direct-call与receipt evidence必须按完整log身份去重
并合并，mutation-only只能表示状态变化、不能自行生成token方向。`unresolved`、`mutation-only`与可执行impact是三种
不同事实；ordered transition、pre/post-state completeness、overlay/preCalls与replay source必须可独立复算。中央不
能因看到topic、selector或某个空effect替Family作chain-proven否定，也不能用sender质量历史硬跳过。

### 16.2 State acquisition

[PFD] Family capability 声明 StateReadProgram；中央 state-runtime 合并相同 physical reads、batch、dedupe、
deadline 与 backpressure，再把 exact source-bound facts 交回 owning interpreter。中央不定义 V2/V3/V4/
Curve state struct，不读协议 storage slot，不做协议数学。

[PFD] shared read key 至少绑定 chainId、provider/backend epoch、source number+hash+stateRoot、request codec、
target、calldata/storage key 与 block tag。逻辑 consumers 可以各自 timeout；物理请求完成前 permit 不释放。

[PFD] hot/warm cache只保存canonical raw read bytes或owner-sealed derived fact，不保存mutable protocol object。
跨head复用必须由capability声明validity/dependency proof并在新source复核；否则只允许同source WorkKey命中。
changed-set optimization只决定“哪些read可复用”，不能把上一head的coarse/exact结果升级成current authority。
cache miss、stale或decode mismatch返回unavailable/retryable，禁止回落到default price或旧pool-state backend。

[PFD] warm/local state cache是性能实现，不是第二authority。Family在自己的StateRead/StateSnapshot capability中
拥有V2/V3/V4/Curve等协议状态解释、tick/bitmap或curve batch warm算法；中央只拥有source-bound cache envelope、
single-flight、epoch/invalidation与backpressure。cache key至少包含`chainId + provider/backend epoch + source
number/hash/stateRoot + instanceRef + stateSchema/interpreter fingerprint + request parameters`。命中旧source、
schema或overlay时必须显式失效并重新读；warm失败返回`unresolved/retryable`，不能退回pinned pool、旧quoter或静态
默认值。operator warm hint最多引用ready Graph中的opaque edge ref，永远不能创建instance、edge、coverage或
topology。

[PFD] prerequisite/dependent quote reads使用Family-owned versioned QuoteProgram：健康路径只读首选amount，失败时
由该Family声明的bounded alternate ladder按预算尝试；zero/revert/missing decode是unresolved或plugin outcome，
不是中央legacy quoter fallback。新增quote capability只使声明它的Family的state/quote closure失效。

### 16.3 Coarse economic projection、rank 与 prune

[PFD] 粗价格/粗经济漏斗是正式load-bearing性能模块，不能因为Graph解耦而删除。它位于immutable GraphView
与planner/exact之间：Family-owned capability根据当前SourceSession签发source-bound coarse projection；中央
只执行通用fixed-point组合、排序、预算与proof检查。50-block observation只负责近期edge/behavior evidence，
绝不提供价格；Graph/Edge只保存静态route fact，绝不把移动价格写入graphRoot。

~~~ts
interface CoarseEdgeProjectionV1 {
  readonly edgeRef: IssuedGraphEdgeRef;
  readonly direction: "forward" | "reverse";
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CanonicalSourceView;
  readonly ownerRef: GeneratedCapabilityOwnerRef;
  readonly capabilityDigest: Hash;
  readonly dependencyRoot: Hash;
  readonly stateFactsRoot: Hash;
  readonly sampleInput: { readonly asset: AssetRef; readonly amount: U256String };
  readonly estimatedOutput: { readonly asset: AssetRef; readonly amount: U256String } | null;
  readonly conservativeOutputUpperBound:
    | { readonly amount: U256String; readonly proofProgramRef: AuthorityProofProgramRef; readonly proofRoot: Hash }
    | null;
  readonly inputCapacityUpperBound: U256String | null;
  readonly status: "rankable" | "unavailable";
  readonly reasonCode: StableReasonCode | null;
}

interface CoarseRouteAssessmentV1 {
  readonly routeId: Hash;
  readonly projectionRoot: Hash;
  readonly rankScore: SignedDecimalString | null;
  readonly profitUpperBound:
    | { readonly numeraire: AssetRef; readonly amount: SignedDecimalString; readonly proofRoot: Hash }
    | null;
}
~~~

[PFD] 每个projection必须精确绑定`edgeRef + direction + generationId + graphRoot + current number/hash/stateRoot +
capabilityDigest + dependencyRoot`；任一不符即`unavailable`，禁止拿旧generation、旧head或另一方向的粗估。
粗投影只用整数/fixed-point/rational canonical bytes，禁止JS floating point成为hard-prune authority。

[PFD] admission固定为两条队列：`Top-K rankable`加`bounded unranked`。缺coarse capability、read失败、proof缺失
或projection unavailable的route按opaque ownerRef round-robin进入unranked预算，必须显式记`not-probed`事实，
不能silent drop。普通`rankScore`只改变顺序；只有所有依赖均有可复核保守上界、中央generic bound composer生成
`profitUpperBound`，且该上界仍低于ObjectiveProfile的最小净收益时，才允许hard prune。hard-prune receipt必须绑定
完整projection/proof/valuation/gas roots。任何被送入后续的route仍必须current-source exact；unprobed或粗估正值
都不能成为execution fallback。

[PFD] coarse extension是versioned optional capability：实现它的Family在自己的package提供program与interpreter，
不实现的Family仍可走unranked lane。新增或改变coarse capability只失效该owner的coarse cache/相关performance
qualification；不改变static Edge/Graph、identity memo，也不使无依赖的Swap/Protocol/Credit Family重验。

### 16.4 Planner 与 solver

[PFD] planner 只消费 immutable generic GraphView，输出有序 RouteHandle refs 与通用 constraints。每个route必须由
`FamilyInstanceKey + direction + ExecutionVariantKey + opaque immutable binding`签发；binding payload/hash由
schema生成并绑定issuer、GraphView lease、generation与strategy objective。中央只检查canonical hash、owner与
duplicate/ordering，不读取或重建协议字段；rehydration通过owner reissuer重新签发不可序列化handle，旧
PoolEntry/TokenEdge不能作为route identity来源。solver 只
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

[PFD] amount search保留victim/trigger anchored grid、严格次数上限、deterministic bounded optimization和逐leg
amount propagation；每个probe都走同一current-source exact coordinator。Funding capacity由Funding plugin的
StateRead/Capacity capability签发`asset + maxAmount + ownerHandle + source/proof root`，中央只比较容量并选择
owner handle。Morpho/Balancer地址、balanceOf holder、Multicall地址或flash action不得进入solver；Multicall只可
作为state-runtime通用batch transport。没有足够source-bound capacity时route不可执行，禁止静态allowlist猜测。

### 16.5 Current-source exact

[PFD] exact coordinator 对 route 中每个 handle：复核 issuer/lease，取得 current SourceSession，执行 owning
StateReadProgram 与 ExactProgram，由 owning capability 解释。任何 missing owner、schema mismatch、stale
source 或 unresolved fact 使该 route fail closed。禁止 pinned-state、legacy quoter 或 N-1 fallback。

[PFD] exact 输出绑定 ordered instances root、state facts root、source anchor、amounts、constraints 与 owning
interpreter hashes。它是 execution program 的唯一价格/状态输入。

### 16.6 Execution program、economics 与 safety

[PFD] 每个 action 由 generated catalog 中唯一 ActionOwner 编译为 schema-tagged opaque action bytes。中央
compiler 只负责有序组合、资金流引用、caller/preCall/effect contract、repayment/standing-position/
conservation obligations 与 hash；不知道 swap、vault、debt mint 或具体协议。

[PFD] standing-position guard不是协议分类表，obligation也不是position/debt/credit的中央closed union：

~~~ts
interface SafetyObligationRef {
  readonly schemaRef: SchemaRef;
  readonly ownerRef: GeneratedSafetyOwnerRef;
  readonly verifierHash: Hash;
  readonly subjectRoot: Hash;
  readonly proofRoot: Hash;
}
~~~

[PFD] Family capability签发versioned obligations，generated owner/verifier解释具体语义。中央safety engine只
验证声明exact set完整、owner/schema/hash有效、每个verifier receipt为satisfied或explicitly-permitted，并
执行通用资产守恒及当前release要求的repayment/standing-position policy。Unknown、漏声明、unresolved或proof
不相容均fail closed。这样当前debt mint不会被当普通swap绕过安全门；未来新position语义也只新增extension
owner，不改safety core。本baseline不定义LP obligation schema。

[PFD] economics在final-sim产生真实gas后签发source-bound EconomicReceipt：next-block EIP-1559 fee由目标parent
整数计算，profit-token valuation来自generated valuation/oracle owner的current-source fact，bid由versioned
policy计算。WETH、stablecoin、Chainlink地址或token decimals不得写进central evaluator；这些是asset/oracle
capability data。valuation unavailable、oracle stale、gas measurement unavailable或fee source mismatch都不能
通过EV/submission gate。coarse阶段可读取同一valuation view帮助排序，但不能替代final EconomicReceipt。

### 16.7 Final simulation 与 submission

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
| [VEF] | background Reth read可与producer critical竞争 | impl@ccb41fbb reth-transport-scheduler.ts:1-13,46-118与live-reth-read-priority.ts:28-145 | producer保留physical permits，background可抢占且有界 |
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
| producer header/source+coarse acquisition | combined P95≤1.5s，P99≤2.5s；coarse read与header共享去重但不占final-sim reserve |
| coarse projection/rank | 每个enumerated route必须为rankable或unavailable；同WorkKey physical projection≤1；P95≤1s、P99≤2s |
| coarse admission | Top-K与bounded-unranked分母/selected/not-probed exact守恒；无proof hard-prune=0，silent drop=0 |
| eligible head terminal accounting | 连续100个 eligible canonical heads 必须100/100产生healthy terminal receipt，silent/unhealthy=0 |
| head completion | P95≤8s，P99≤11s，单head hard deadline<12s；超出即性能门失败而非丢样本 |
| planner→exact→program（有candidate） | P95≤2.5s，P99≤3.5s，不含final-sim |
| final simulation queue wait | P95≤0.5s，P99≤1s；无资源时明确fail closed |
| final simulation service / queue+service | service P95≤2s、P99≤3s；queue+service P99≤4s、hard≤5s |
| economic seal | final gas、next-block fee、valuation、bid、EV全部同source/plan/sim root；unknown/stale通过submission=0 |
| head critical-path composition | source+coarse 2.5s + planner/exact/program 3.5s + final queue 1s + final service 3s + overhead 1s = P99 budget 11s |
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
heads 全部被及时、显式且健康地结算”，不是99%、不是任选100个、不是100次脚本循环，也不要求每个 head
都有盈利candidate。Healthy只允许`complete-no-candidate`（完整scan/coverage证明无candidate）或
`complete-candidates-terminal`（该head全部admitted candidates按冻结policy正常结算，包括正常policy reject或
final-sim reject）；timeout、queue-full、resource failure、stale、unknown、evidence invalid或未完成均是unhealthy，
仍占分母并使100/100失败。至少一条真实dry-run candidate仍须完整通过六步。

[PFD] eligible set由独立canonical-header collector在process进入ready-serving状态时预先确定：该区间内每个
canonical replacement head都eligible；no-candidate、timeout、queue-full、stale、resource failure仍在分母。
Orphaned reorg head单列并由canonical replacement替代，不允许operator、runtime或validator事后挑样本。
Warmup/maintenance只能以process/ready anchor划定整个连续区间，不能从运行区间中删除失败head。

[PFD] 在首个计数head前必须持久化
`windowStartAnchor + eligibilityRuleHash + performanceProfileHash + targetCount(100)`；commit后不能因看到结果
而后移起点或缩短窗口。pre-ready heads从未进入该窗口；reorg orphan只由同一ordinal的canonical replacement
结算。除此以外`excludedHeads`必须为空，missing/unknown直接fail或invalid，不能用“客观原因”删除。

[PFD] Critical-path各P99预算按11s显式组成；coarse包含在source+coarse combined budget内，不再重复相加，并与head completion P99使用同一candidate-bearing head分母，
避免“每个组件单独过门但总和超过12s”。无candidate head仍进入100/100 terminal分母，但不伪装成
planner→final-sim latency样本。Cold/warm generation
按candidate分母、fast/heavy mix与complete receipt set同时报告；若真实candidate规模不同，仍同时使用绝对
hard gate和per-lane throughput，不能只用较小分母宣称更快。

[PFD] `PerformancePredicateSpec`固定nearest-rank percentile：对升序整数微秒样本
`Pq = samples[ceil(q*n)-1]`，不插值；head start是canonical head被producer session接收的monotonic timestamp，
terminal是sealed healthy/unhealthy receipt的monotonic timestamp。全head timing sample count必须等于100；
candidate-path样本count必须等于content-addressed candidate-bearing head set，缺样本使verdict invalid，绝不skip。

### 17.5 事实指标与对比

[PFD] 每阶段记录 queue wait、service time、end-to-end time、source scan count、physical/logical request、
single-flight join、dedupe hit、memo reuse、retry reason、RPC/REVM concurrency、CPU、RSS、worker restart、
completed/missed heads、P50/P95/P99。分母与完整 receipt set 必须随指标一起 hash。

[PFD] 对比 impl/Aloha 时使用相同 canonical head window、provider、hardware profile、dry-run policy 与 raw
receipt set。旧实现只用于定位回归：Aloha 即使比旧实现快也不能替代绝对预算、六步 lineage 或安全门；
旧实现即使失败也不能自动让 Aloha 通过。

## 18. Existing six-step asset audit

[VEF] 本节另对当前 impl exact head
`1e87b7813bca0d0bcc2710c701f1f46c30f035fd` 做了只读复核。该 SHA 只锁定本节的验收资产判断，
不把当前 impl 扩张成 Aloha 的 source baseline，也不改变 §5 的 greenfield reuse 白名单；任何最终采用仍须进入
`reference-lock.json` 与逐 symbol `ReuseReceipt`。

### 18.1 可提取机制

| 标签 / 判断 | impl@1e87b781 资产 | 可保留事实机制 | 必须删除/重写的旧语义 | Aloha 目标 |
|---|---|---|---|---|
| [ASR] R2 | listener/src/shared/evidence/semantic-six-step.ts:68-192,288-402 | canonical JSON/hash、semantic output 与 metrics 分离、ordered prefix、terminal-after-stop、cross-step commitment、deep freeze | 固定旧六步、route target、Family bypass、legacy schema readers与按旧字段判 pass | acceptance/schema-codec + validator；schema-derived exact fields、Aloha DAG 与逐parent commitments |
| [ASR] R2 | analysis/src/six-step-validation-controller.ts:313-680,1403-1651 | content-addressed inputs、exact set、payload/evidence hash复算、state anchor复核、同目录 fsync+rename seal | import/call production builder、target route/trusted reference、worktree/branch/review/rollback orchestration | independent collectors只封存raw facts；validator不运行planner/Graph/exact/sim补事实 |
| [ASR] R2 | analysis/src/six-step-validation-lifecycle.ts:117-163,327-500 | ordered receipt validation、process/anchor稳定、完整envelope digest | branch/reviewer/merge/cleanup、checkpoint/final migration verdict与Git inspector | immutable run-receipt codec；Git release proof是独立predicate，不是事实生命周期 |
| [ASR] R2 | analysis/src/trusted-six-step-runtime-attestation.ts:72-199,276-400 | canonical payload、exact top-level keys、PID/start ticks、runtime/config cross-binding、content-addressed inputs、receipt/parent anchor | AWS/SSM command、固定instance/region/systemd unit、`/opt/MEV-runtime`、全量environ与固定tunnel | qualified environment collector port + portable process/artifact/log anchor；nested schema也exact |
| [ASR] R2 | analysis/src/cli/six-step-validation-gate.ts:11-36 | `read authenticated facts → pure evaluator → deterministic exit` 的薄CLI边界 | 把preauthenticated receipt误当raw/live真实性；旧judgment DTO | GateCore纯AND/三值判定；CLI不采证、不补事实、不拥有authority |
| [BRW] R3 | analysis/src/six-step-judgment.ts:35-214 | fail-closed纯 evaluator 形状与reason catalog | adapter_merge、production_gap、listener/Family imports、旧promotion receipt | architecture-neutral PredicateSpec evaluator；只接受qualified observations |
| [ASR] R2 | listener/src/searcher/systemic-live-gate.ts:37-82 | 所有独立事实门全过才pass并列出失败reason | paired baseline/challenger身份、直接信任report布尔值、旧relative/parity truth | 从raw receipt set独立复算的绝对预算AND gate |
| [BRW] R3 | listener/src/searcher/serial-systemic-live-evidence.ts:26-143 | per-head聚合、percentile/throughput纯计算概念；serial明确永不单独授权 | tolerant parser、后写覆盖、95% floor、伪candidate overlap、调用者window、relative baseline authority | 预冻结连续canonical denominator；exact process/run/generation join；serial只作diagnostic |
| [BRW] R3 | listener/src/searcher/migration-cleanup-receipt.ts:336-451 | 相对import closure遍历、unresolved记录、closure hash作为一个observer | regex冒充AST、仅从main.ts出发、遗漏entry/language/generated/runtime、hardcoded Family absence、receipt字段未进入verdict | AST/module/build/runtime多源closure predicates；不能由单scanner自证legacy=0 |

[VEF] 冻结source中已有mutation cases：semantic-six-step.ts:183-292,378-402（digest/order/terminal）；
six-step-validation-lifecycle.ts:553-713,738-899（splice/commitment/stage/runtime/envelope）；
six-step-validation-pending-evidence.ts:40-230（empty/subset/duplicate/exact set）；
trusted-six-step-runtime-attestation.ts:128-329（snapshot/input/secret/parent）；
listener/src/searcher/test/systemic-live-gate.ts:102-189（任一门fail closed）。[MTM] 本轮未运行这些tests，
因此只选择mutation机制，不宣称冻结test当前pass。

### 18.2 当前 impl 验收资产的对抗结论

[REJ] 以下不是“小瑕疵”，而是足以制造 production 假阳性的已证实边界，因此 Aloha 不得复制对应
report shape、阈值或test命名：

1. `listener/src/searcher/node-serial-systemic-live.ts:49-68` 无论 `gateVerdict` 是什么都固定输出顶层
   `status: "pass"`；读取顶层status的automation会把明确的not-pass误报为pass。
2. `serial-systemic-live-evidence.ts:31-85` 静默跳过坏JSON/缺block，以剩余Map作为分母；同block后写覆盖
   前写；缺outcome也被当completed；P95只看有`total_ms`的子集。坏证据因此可能通过“缩小分母”变好。
3. `serial-systemic-live-evidence.ts:93-133` 只有任意窗口95% floor，不是同SHA/PID/start/log inode/generation
   下预冻结的连续100/100；`candidateOverlapPass`甚至复用了heads-per-second，没有计算candidate集合交集。
4. `systemic-live-gate.ts:85-116` 只转抄`PairedLiveReport`布尔字段，不从raw facts复算；其手写一head fixture
   只能证明boolean aggregator，不证明live事实。
5. `migration-cleanup-receipt.ts:198-290` 的pass没有覆盖传入的全部commit/catalog/six-step/systemic字段，
   symbol表中多项硬切换probe也未全部进入verdict；source scan是regex且import closure仅从`main.ts`的相对
   literal imports出发。它只能是辅助sensor，不能证明源码、binary、runtime object与consumer authority均为零。
6. `listener/package.json:137,170,250` 名为serial/systemic/migration的命令实际运行unit fixture/test；绿色
   只证明helper处理了fixture，不能获得production acceptance credit。
7. `analysis/src/six-step-validation-controller.ts:815-900` 不是读取六个生产边界Event，而是从一个
   `raw.selected`对象一次性合成六个`pass`，并硬写target present、positive quote、simulation success与allow；
   这是最危险的“验收/采集编排器自己生成想验收的事实”（旧capture harness也属于此类风险），整段R4拒绝；
   多Agent开发workflow不是这里所说的验收编排器。
8. `semantic-six-step.ts:288-355` 的手写canonical JSON仍接受普通JavaScript number，且旧extensions允许任意
   key；Aloha只能保留内容寻址思想，实际codec必须由schema生成、拒绝unsafe number/duplicate/unknown core
   fields，扩展必须显式`SchemaRef`。

[PFD] 因此，impl可作为事实验收器的“机制语料”和untrusted reference producer，但不存在一份可直接复制后
即宣称合格的验收脚本。Aloha必须先冻结PredicateSpec与独立oracle，再按新边界重写。测试可人工构造
negative/invalid mutation来资格化validator，但手写success fixture、脚本顶层status、旧receipt verdict与旧分支
数量都不构成production pass。

### 18.3 Aloha 验收组件边界

~~~text
raw runtime / chain / Reth / process / filesystem
                    │
                    ▼
       qualified ObserverAdapter
  (environment-specific read-only collection)
                    │ raw locator + bytes hash + observer certificate
                    ▼
              EvidenceCore
   (canonical exact schema + lineage + immutable seal)
                    │ authenticated claims + qualified observations
                    ▼
               pure GateCore
 (frozen PredicateSpecs; pass / fail / invalid + reasons)
~~~

[PFD] `EvidenceCore`不得import systemd、AWS/SSM、impl、任意reference importer、Aloha production、planner或Family代码；
`ObserverAdapter`不得生成expected verdict，也不得调用production builder补缺失事实；`GateCore`不得读日志
文案或trust任意report布尔值。环境transport metadata只进入外层observation envelope；若locator本身load-bearing，
必须连同content hash、byte length、media/schema ref和observer qualification一起被hash绑定。

[PFD] process observer至少在采集前后复核PID、start ticks、boot ID、service/cgroup identity、executable hash与
deployment manifest；log observer绑定device/inode/offset range/raw bytes hash。配置只采显式allowlist字段，
不得先读取完整进程环境再靠敏感词denylist过滤。链上receipt/header/state必须保留可重读raw locator，validator
独立复算bytes hash与canonical relation。

[PFD] acceptance CLI只能序列化最终`AcceptanceCertificate.verdict`：`pass`唯一对应exit 0，`fail`与`invalid`
使用不同的非零exit code；若保留顶层`status`，它必须由同一verdict机械派生且字面相等。CLI不得同时输出
pass与任何内部non-pass，也不得用“命令成功执行”覆盖predicate结果。

[REJ] 旧六步不能靠改名映射成新六步：旧 step 1 混合 discovery 与 Graph，旧 step 2 是 route
enumeration，旧 step 3/4 是 quote→solver，旧 step 5 才是 sim，旧 step 6 是 EV。Aloha 的 planner→exact
顺序、独立 execution program 与 atomic ready receipt 都没有一对一旧 stage。reference-producer calibration 可以
诚实显示 missing fact，不能合成成功。

### 18.4 永不进入新 schema 的旧字段

[REJ] production_route_stage、family_execution、discovery_admission_graph、route_enumeration、
exact_quote_refine、plan_and_size、fork_final_sim、production_ev、bypassed、route_pinned、fixture_route_sha256、
target_route_sha256、trusted target/reference、selected_by_solve_policy、adapter_merge、production_gap、
checkpoint_pass、final_validated、rollback/baseline/branch reviewer/cleanup、pairedLiveVerdict 与 AWS/SSM command
identity 均不进入 Aloha Evidence Schema。

[PFD] deployment collector MAY 报 environment-specific locator，但 schema/validator 不按 provider、host、
AWS region、path 或 systemId 选择宽松规则。

## 19. New fact-only Evidence Schema

### 19.1 SemanticArtifact、ProductionReceipt 与 claim boundary

[PFD] 语义结果与“哪个实现、哪个进程、花了多久产生它”必须分离。相同canonical语义可拥有相同
SemanticArtifactId；runtime commit、PID、worker、raw locator与latency只进入ProductionReceipt：

~~~ts
type ReadOnlyArtifactLocatorV1 =
  | {
      readonly kind: "file-range";
      readonly systemId: string;
      readonly bootIdHash: Hash;
      readonly device: DecimalString;
      readonly inode: DecimalString;
      readonly startInclusive: DecimalString;
      readonly endExclusive: DecimalString;
    }
  | {
      readonly kind: "checkpoint-record";
      readonly storeIdentityHash: Hash;
      readonly namespaceHash: Hash;
      readonly keyHash: Hash;
      readonly revision: DecimalString;
      readonly recordHash: Hash;
    }
  | {
      readonly kind: "chain-object";
      readonly chainId: DecimalString;
      readonly blockNumber: DecimalString;
      readonly blockHash: BlockHash;
      readonly objectKind: "header" | "transaction" | "receipt" | "state-proof" | "logs";
      readonly objectKeyHash: Hash;
    }
  | {
      readonly kind: "content-object";
      readonly storeIdentityHash: Hash;
      readonly objectKey: Hash;
    }
  | {
      readonly kind: "json-pointer";
      readonly parentLocatorId: Hash;
      readonly pointer: string;
    };

interface ReadOnlyArtifactRefV1 {
  readonly artifactRefId: Hash;
  readonly locatorId: Hash;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly immutableMirrorLocatorId: Hash;
  readonly immutableMirrorLocator: Extract<
    ReadOnlyArtifactLocatorV1,
    { readonly kind: "content-object" }
  >;
  readonly contentSha256: Hash;
  readonly byteLength: DecimalString;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
  readonly resolverPolicyHash: Hash;
  readonly retentionLeaseReceiptId: Hash;
}

interface ResolverPolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.artifact-resolver-policy";
  readonly policyHash: Hash;
  readonly allowedLocatorKind: "content-object";
  readonly digestAlgorithm: "sha256";
  readonly maxByteLength: DecimalString;
  readonly requireExactLengthMediaAndSchema: true;
  readonly minimumRemainingStoreEpochs: DecimalString;
  readonly failureOutcome: "invalid";
}

interface RetentionLeaseReceiptV1 {
  readonly receiptId: Hash;
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly contentSha256: Hash;
  readonly validFromStoreEpoch: DecimalString;
  readonly validThroughStoreEpoch: DecimalString;
  readonly issuerId: string;
  readonly issuerQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
}

interface ArtifactResolutionResultV1 {
  readonly resultId: Hash;
  readonly artifactRefId: Hash;
  readonly resolverPolicyHash: Hash;
  readonly resolverImplementationDigest: Hash;
  readonly resolverQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly resolvedAtStoreEpoch: DecimalString;
  readonly bytes: Bytes | null;
  readonly observedContentSha256: Hash | null;
  readonly observedByteLength: DecimalString | null;
  readonly outcome: "resolved" | "missing" | "mismatch" | "lease-invalid";
}

interface ReadOnlyArtifactResolver {
  resolve(
    ref: ReadOnlyArtifactRefV1,
    policy: ResolverPolicyV1,
    lease: RetentionLeaseReceiptV1,
  ): Promise<ArtifactResolutionResultV1>;
}

interface SemanticArtifactV1 {
  readonly schema: SchemaRef;
  readonly artifactId: Hash;
  readonly inputArtifactIds: readonly Hash[];
  readonly dependencyClosureRoot: Hash;
  readonly canonicalPayloadHash: Hash;
}

interface ProductionReceiptV1 {
  readonly receiptId: Hash;
  readonly artifactId: Hash;
  readonly producer: {
    readonly systemId: string;
    readonly commitSha: GitSha40;
    readonly executableHash: Hash;
    readonly deploymentManifestHash: Hash;
    readonly serviceIdentityHash: Hash;
    readonly pid: DecimalString;
    readonly processStartTicks: DecimalString;
    readonly bootIdHash: Hash;
  };
  readonly logRangeArtifactRef: ReadOnlyArtifactRefV1;
  readonly sourceAnchorHash: Hash;
  readonly startedMonotonicNs: DecimalString;
  readonly finishedMonotonicNs: DecimalString;
  readonly durationUs: DecimalString;
  readonly rawBoundaryArtifactRef: ReadOnlyArtifactRefV1;
  readonly semanticConfigDigest: Hash;
  readonly resourceMetricsHash: Hash;
}
~~~

[PFD] `ProductionReceipt.logRangeArtifactRef.locator`必须是`file-range`，且其`systemId`与`bootIdHash`必须
分别等于producer anchor；log与raw-boundary artifact必须不同。跨system、跨boot、无device/inode/range的日志
不能伪装成该process的production evidence。其immutable mirror仍须由qualified resolver证明bytes/hash/length/
media/schema与retention lease真实可读；结构hash自洽本身不是live事实。

[PFD] EvidenceEvent引用input/output SemanticArtifact与ProductionReceipt，形成事实lineage；它不是跨stage业务
DTO，也不能让producer metadata改变语义artifact ID。不是每次hot-path amount search/quote都写durable
WorkLedger：只有startup partition/outcomes、ready、submission intent等跨restart authority按其合同持久化；
head内临时artifact可随bounded session回收，但被验收引用的artifact/receipt必须content-addressed可读取。该模型
不创建第二ArtifactStore、第二checkpoint或第二ready authority。

### 19.2 Evidence Schema

[PFD] EvidenceEventV1 顶层 core 字段 exact-key；扩展只能位于已声明 schema hash 的 extensions：

~~~ts
type SchemaRef = Readonly<{ id: string; version: SemVer; schemaHash: Hash }>;

interface SourceAnchor {
  readonly chainId: DecimalString;
  readonly number: DecimalString;
  readonly hash: BlockHash;
  readonly stateRoot: Hash;
}

interface ProcessAnchorV1 {
  readonly systemId: string;
  readonly commitSha: GitSha40;
  readonly executableHash: Hash;
  readonly deploymentManifestHash: Hash;
  readonly serviceIdentityHash: Hash;
  readonly pid: DecimalString;
  readonly processStartTicks: DecimalString;
  readonly bootIdHash: Hash;
}

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
    rawBoundaryArtifactRef: ReadOnlyArtifactRefV1;
  };

  runtime: {
    commitSha: GitSha40;
    executableHash: Hash;
    deploymentManifestHash: Hash;
    serviceIdentityHash: Hash;
    pid: DecimalString;
    processStartTicks: DecimalString;
    bootIdHash: Hash;
    logRangeArtifactRefId: Hash;
  };

  artifactLineage: {
    inputArtifactIds: readonly Hash[];
    outputArtifactId: Hash;
    productionReceiptId: Hash;
  };

  scope: EvidenceScopeV1;
  correlationId: string;
  runSequence: DecimalString;
  cutoff: { number: DecimalString; hash: BlockHash; stateRoot: Hash };
  definitionCatalogRoot: Hash;
  strategyCatalogRoot: Hash | null;
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
instanceCatalogRoot/graphRoot必须为null，stage 2–6必须非null并沿DAG相容。strategyCatalogRoot在stage1/2为
null、stage3–6为同一非null root；strategy变化不伪造新的attestation或ready。candidateKey始终必填；
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

### 19.3 Hash 与真实性

~~~text
capabilitySetHash =
  H("aloha/capability-set/v1", canonical(sorted capabilities))

locatorId =
  H("aloha/read-only-artifact-locator/v1", canonical(exact locator union payload))

artifactRefId =
  H("aloha/read-only-artifact-ref/v1", locatorId, immutableMirrorLocatorId,
    contentSha256, byteLength, mediaType, schema,
    resolverPolicyHash, retentionLeaseReceiptId)

processAnchorHash =
  H("aloha/process-anchor/v1", canonical(ProcessAnchorV1 exact fields))

resolverPolicyHash =
  H("aloha/artifact-resolver-policy/v1",
    canonical(all ResolverPolicy fields except policyHash))

resolutionResultId =
  H("aloha/artifact-resolution-result/v1",
    canonical(all ArtifactResolutionResult fields except resultId))

inputHash =
  H("aloha/stage-input/v1", stage.id, inputSchema, canonical(inputs))

outputHash =
  H("aloha/stage-output/v1", stage.id, factSchema,
    canonical(facts), outcome, reasonCode)

artifactId =
  H("aloha/semantic-artifact/v1", schema,
    canonical(schema-defined ordered inputArtifactIds),
    dependencyClosureRoot, canonicalPayloadHash)

receiptId =
  H("aloha/production-receipt/v1",
    canonical(all ProductionReceipt fields except receiptId))

eventId =
  H("aloha/evidence-event/v1", canonical(all fields except eventId))
~~~

[PFD] 文中其他`*ReceiptV1.receiptId`同样使用各自kind的domain separator并绑定除receiptId外全部exact字段；
任何被传入却未进入ID或verdict复算的字段都是schema错误，validator必须invalid。

[PFD] outputHash 只绑定语义事实，支持跨步 commitment；eventId 绑定完整 envelope，包括 runtime、latency、
source 与 raw locator。修改 telemetry 后也必须改变 eventId，不能无痕覆盖。

[PFD] outputHash绑定的exact payload就是该stage的`stage.id + factSchema + facts + outcome + reasonCode`，并必须
等于对应SemanticArtifact的canonicalPayloadHash；validator从artifact bytes独立重算artifactId，从receipt bytes
独立重算receiptId。Event的artifactLineage必须exact等于这些已读取对象，且
`receipt.artifactId == event.artifactLineage.outputArtifactId`；event中的runtime/source/latency必须与
ProductionReceipt精确相符。换producer但语义与依赖完全相同可以保持artifactId，receiptId/eventId必须变化。

[PFD] `ProcessAnchorV1`只含稳定process identity，不含每条Event不同的log range；validator从每个tail Event对应
ProductionReceipt的producer字段重建同一个ProcessAnchor并复算等于query.processAnchorHash。每条Event自己的
logRangeArtifactRef仍独立校验，不能用相同process anchor掩盖跨log splice。

[PFD] ObserverAdapter从exact union重算source与immutable-mirror locator IDs，通过qualified
`ReadOnlyArtifactResolver`从mirror按`objectKey=contentSha256`重读bytes，复核contentSha256/byteLength/media/
schema后才可封存QualifiedFactSnapshot。`file-range`必须满足`endExclusive-startInclusive == byteLength`，并与
同一boot/device/inode对象一致；JSON pointer先验证parent content再取值。Boundary raw artifact与process log
range使用两个独立ArtifactRef，禁止用一个含糊hash同时代表二者。

[PFD] 所有`*ArtifactRefId`与snapshot的`orderedRawArtifactRefIds`只引用`artifactRefId`；`locatorId`仅标识“去哪里
读取”，不绑定读取到的bytes，绝不能代替artifactRefId进入content/lineage root。

[PFD] Source locator用于provenance，可能因log rotation或远端retention失效；因此collector在发出ArtifactRef前
必须把exact bytes写入immutable content store并取得覆盖整个验收/复核期的retention lease。Resolver port只允许
按content-object locator读取，不允许builder/planner/simulator调用；mirror缺失、lease过期、resolver policy/
implementation未资格化或bytes不匹配均invalid。Chain/checkpoint locator的opaque hashed selector不能独立满足
可重读性，必须依赖该immutable mirror；GateCore仍不做I/O，只消费已封存snapshot。

[PFD] Lease subject必须exact等于ArtifactRef的mirror
`storeIdentityHash + objectKey + contentSha256`，issuer qualification在同registry current且未revoked；
`resolvedAtStoreEpoch`必须位于lease区间，且剩余epoch满足policy。Resolution result的implementation/
qualification、policy、registry与ArtifactRef逐项匹配，只有`resolved`且bytes/hash/length/media/schema全相等才可
生成QualifiedObservation；其他outcome一律invalid。RetentionLeaseReceipt作为`*ReceiptV1`按§19.3绑定全部字段，
resolver policy/result也按上式独立重算，不能靠store自报“仍可读”。

[PFD] outcome与reasonCode属于语义结果，必须进入outputHash；否则把verified改成rejected仍可能维持child
commitment。Stage 1成功结果使用verified，stage 2–6过程成功使用success。

[PFD] Hash 只能证明内容完整性，不能单独证明事实真实性。真实性来自 exact runtime/process/log anchor、
只读 raw artifact locator、checkpoint/root 复算、独立 Reth/on-chain 复核与真实 final-sim receipt。成功 verdict
不得来自手写 fixture、手写 TokenEdge、validator 自建 Graph 或“日志打印了 success”。

### 19.4 Event 写入边界

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

[PFD] `ReadOnlyArtifactRefV1`是只读、内容寻址定位与bytes commitment（file range、checkpoint record、chain
object、content object或validated JSON pointer），不得包含RPC secret、private key、完整环境变量或可签名材料。

[PFD] Evidence Schema还包含非六步、同样exact-key/hash-bound的聚合receipt。它们不能伪造instanceKey，也
不能替代某条candidate的六步DAG：

~~~ts
interface HeadWindowCommitmentV1 {
  readonly windowId: Hash;
  readonly readyServingAnchor: SourceAnchor;
  readonly producerAnchorHash: Hash;
  readonly generationId: string;
  readonly eligibilityRuleHash: Hash;
  readonly performanceProfileHash: Hash;
  readonly targetCount: "100";
  readonly commitProductionReceiptId: Hash;
  readonly commitArtifactRef: ReadOnlyArtifactRefV1;
  readonly committedMonotonicNs: DecimalString;
}

type HealthyHeadOutcome =
  | "complete-no-candidate"
  | "complete-candidates-terminal";
type UnhealthyHeadOutcome =
  | "timeout" | "queue-full" | "resource-failure" | "stale"
  | "unknown" | "evidence-invalid" | "incomplete";

interface HeadTerminalReceiptV1 {
  readonly receiptId: Hash;
  readonly windowId: Hash;
  readonly ordinal: DecimalString; // exact 0..99
  readonly canonicalHead: SourceAnchor;
  readonly supersededOrphanObservationRoot: Hash | null;
  readonly processGenerationLogAnchorHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidateSetRoot: Hash;
  readonly orderedCandidateTerminalReceiptRoot: Hash;
  readonly outcome: HealthyHeadOutcome | UnhealthyHeadOutcome;
  readonly healthy: boolean; // derived from outcome, never independently trusted
  readonly acceptedMonotonicNs: DecimalString;
  readonly terminalMonotonicNs: DecimalString;
  readonly rawReceiptSetRoot: Hash;
}

interface PerformanceAcceptanceReceiptV1 {
  readonly receiptId: Hash;
  readonly predicateSpecDigest: Hash;
  readonly qualificationCertificateIds: readonly Hash[];
  readonly windowCommitmentHash: Hash;
  readonly orderedHeadTerminalReceiptRoot: Hash;
  readonly headCount: "100";
  readonly healthyHeadCount: DecimalString;
  readonly candidateBearingHeadSetRoot: Hash;
  readonly fullHeadTimingSampleRoot: Hash;
  readonly candidatePathTimingSampleRoot: Hash;
  readonly metricRecomputationRoot: Hash;
  readonly rawReceiptSetRoot: Hash;
  readonly verdict: "pass" | "fail" | "invalid";
}
~~~

[PFD] `CoverageReceiptV1`编码release-intent exact set、source partitions、zero-candidate与全族分母。
Performance pass要求100个ordinal exact且唯一、canonical replacement规则成立、`healthyHeadCount=100`、全部样本
和roots可从raw locators独立复算；commit ArtifactRef/ProductionReceipt的log offset与monotonic time必须严格早于
ordinal 0的accepted anchor，`committedBeforeFirstHead`不得靠布尔自报。任何重复/缺失/unknown或receipt内部
布尔值与derived outcome不一致均invalid。

### 19.5 Claim、observation 与 PredicateSpec

[PFD] impl与Aloha runtime产生的Event、artifact和receipt首先都是`claim`；`strict`、`success`或branch名
不会让claim自动变成事实。Load-bearing observation由独立observer从raw locator、canonical chain、Reth、
process/filesystem、数学reference model或独立EVM重建：

~~~ts
interface ObserverRoleSpecV1 {
  readonly roleId: string;
  readonly observationSchema: SchemaRef;
  readonly anchorPolicyDigest: Hash;
  readonly observerQualificationSpecDigest: Hash;
  readonly requiredCriticalMutationIds: readonly string[];
  readonly minimumIndependentOracleCases: DecimalString;
}

interface PredicateSpecV1 {
  readonly predicateId: string;
  readonly version: SemVer;
  readonly claimSchemaRefs: readonly SchemaRef[];
  readonly observationSchemaRefs: readonly SchemaRef[];
  readonly requiredObserverRoles: readonly ObserverRoleSpecV1[];
  readonly observerRoleSetHash: Hash;
  readonly passRuleDigest: Hash;
  readonly failRuleDigest: Hash;
  readonly invalidRuleDigest: Hash;
  readonly anchorPolicyDigest: Hash;
  readonly tolerancePolicyDigest: Hash;
  readonly forbiddenProducerSelectors: readonly string[];
  readonly criticalMutationIds: readonly string[];
  readonly criticalMutationSetHash: Hash;
  readonly independentOracleKinds: readonly IndependentOracleKind[];
  readonly verifierQualificationSpecDigest: Hash;
  readonly specDigest: Hash;
}
~~~

[PFD] predicate只能读取声明的claim/observation schemas；同一canonical inputs/facts不得因producer为impl或
Aloha而改变verdict。DS不再是本重写的reference producer或校准对象。缺load-bearing observation、unknown schema、stale qualification或不完整分母返回
`invalid`；已观察到违反contract的事实才返回`fail`；事实完整且predicate成立才返回`pass`。展示层可显示
producer identity，predicate不得据此选阈值、放宽stage或改变expected result。

### 19.6 Verifier / Observer Qualification

~~~ts
interface QualificationRegistrySnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.qualification-registry";
  readonly registryId: Hash;
  readonly payloadHash: Hash;
  readonly epoch: DecimalString;
  readonly trustedIssuerSetRoot: Hash;
  readonly certificateSetRoot: Hash;
  readonly revokedCertificateIdsRoot: Hash;
  readonly previousRegistryRoot: Hash | null;
  readonly governanceApprovalHash: Hash;
}

interface ObserverQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.observer-qualification";
  readonly certificateId: Hash;
  readonly payloadHash: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly observerImplementationDigest: Hash;
  readonly observedSchemaIds: readonly SchemaRef[];
  readonly qualifiedLocatorKinds: readonly ReadOnlyArtifactLocatorV1["kind"][];
  readonly anchorValidationMethodDigest: Hash;
  readonly positiveCaseRoot: Hash;
  readonly negativeCaseRoot: Hash;
  readonly invalidCaseRoot: Hash;
  readonly declaredCriticalMutationIds: readonly string[];
  readonly rejectedOrInvalidMutationIds: readonly string[];
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: DecimalString;
  readonly issuerId: string;
  readonly issuedAtRegistryEpoch: DecimalString;
  readonly verdict: "qualified" | "not-qualified";
}

interface VerifierQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.verifier-qualification";
  readonly certificateId: Hash;
  readonly payloadHash: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly predicateSpecDigest: Hash;
  readonly predicateImplementationDigest: Hash;
  readonly observerQualificationIds: readonly Hash[];
  readonly requiredObserverRoles: readonly {
    readonly roleId: string;
    readonly observationSchema: SchemaRef;
    readonly anchorPolicyDigest: Hash;
    readonly observerQualificationSpecDigest: Hash;
    readonly requiredCriticalMutationIds: readonly string[];
    readonly minimumIndependentOracleCases: DecimalString;
    readonly observerQualificationId: Hash;
  }[];
  readonly caseSetRoot: Hash;
  readonly declaredCriticalMutationIds: readonly string[];
  readonly rejectedOrInvalidMutationIds: readonly string[];
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: DecimalString;
  readonly oldReferenceCaseCount: DecimalString;
  readonly counterexampleRoot: Hash;
  readonly issuerId: string;
  readonly issuedAtRegistryEpoch: DecimalString;
  readonly verdict: "qualified" | "not-qualified";
}

interface QualifiedObservationEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.qualified-observation";
  readonly observationId: Hash;
  readonly payloadHash: Hash;
  readonly observationSchema: SchemaRef;
  readonly observerImplementationDigest: Hash;
  readonly observerQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly anchorPolicyDigest: Hash;
  readonly observedClaimIds: readonly Hash[];
  readonly rawArtifactRefs: readonly ReadOnlyArtifactRefV1[];
  readonly acquisitionProductionReceiptId: Hash;
  readonly canonicalFacts: CanonicalJson;
  readonly canonicalFactsHash: Hash;
}

interface QualifiedFactSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.qualified-fact-snapshot";
  readonly snapshotId: Hash;
  readonly payloadHash: Hash;
  readonly claimSetRoot: Hash;
  readonly observationSetRoot: Hash;
  readonly rawArtifactSetRoot: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly orderedClaimIds: readonly Hash[];
  readonly orderedObservationIds: readonly Hash[];
  readonly orderedRawArtifactRefIds: readonly Hash[];
}

interface AcceptanceQueryV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.acceptance-query";
  readonly queryId: Hash;
  readonly payloadHash: Hash;
  readonly predicateSpecDigest: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly subjectArtifactRoot: Hash;
  readonly qualifiedFactSnapshotId: Hash;
  readonly processAnchorHash: Hash;
  readonly correlationId: string | null;
}

interface AcceptanceCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.acceptance-certificate";
  readonly certificateId: Hash;
  readonly payloadHash: Hash;
  readonly acceptanceQueryId: Hash;
  readonly subjectArtifactRoot: Hash;
  readonly claimSetRoot: Hash;
  readonly observationSetRoot: Hash;
  readonly rawArtifactSetRoot: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly predicateSpecDigest: Hash;
  readonly verifierQualificationId: Hash;
  readonly observerQualificationIds: readonly Hash[];
  readonly reasonSetRoot: Hash;
  readonly verdict: "pass" | "fail" | "invalid";
}
~~~

[PFD] 上述每种对象均使用自己的domain separator：
`payloadHash = H("<kind>/payload/v1", canonical(all fields except objectId/payloadHash))`，再以
`objectId = H("<kind>/id/v1", payloadHash)`生成其`registryId/certificateId/observationId/snapshotId/queryId`。
所有数组按schema声明的ordered或sorted语义exact编码；不得JSON stringify猜测、忽略未知字段或排除任意时间/commit
字段。AcceptanceCertificate绑定exact query、claim/observation/raw roots、qualification registry与完整reason set，
不能把旧pass certificate换一组facts重放。

[PFD] executable schema的`schemaHash`绑定完整declarative descriptor；任何cross-field refinement还必须把
versioned `refinementSpecDigest`写入descriptor。禁止用`Function.toString()`冒充可移植实现身份，也禁止只靠
同名`refinementId`。Verifier certificate的`predicateImplementationDigest`是完整load-bearing verifier closure
digest，必须覆盖canonical codec、schema refinement实现、registry/lineage validator与predicate program；其中
任一实现变化都会使旧certificate stale。这样规范变化改变schemaHash，规范不变但实现变化也必须重新
qualification。

[PFD] production acceptance只能引用current qualification：predicate spec/implementation或任一load-bearing
observer digest变化，旧证书立即stale并使verdict invalid。`declaredCriticalMutationIds`必须与
`rejectedOrInvalidMutationIds` exact相等，且independentOracleCaseCount>0；impl witness不计入该count，
也不能定义expected verdict。

[PFD] QualificationRegistrySnapshot由release-governance冻结的受信issuer set批准；validator绑定query指定的
exact registry root，复核certificate membership、issuer、epoch与revocation。`verdict:"qualified"`自报没有效力。
每条load-bearing observation逐条复核：certificate subject implementation digest、observed schema、locator kind、
anchor policy与envelope完全匹配，且certificate在该registry current且未revoked；不能用“系统里存在一张合格
observer证书”替未资格化adapter背书。

[PFD] Verifier certificate的`requiredObserverRoles`是exact set；每条被predicate消费的observation必须匹配一个
role，且其`observerQualificationId`必须属于该verifier certificate声明的exact IDs。缺role、额外load-bearing
observation或用未参与verifier qualification的可替换observer，均invalid；更换observer必须重新qualification并
签发新Verifier certificate。

[PFD] 每个role的`observerQualificationSpecDigest`必须与对应Observer certificate的
`qualificationSpecDigest`精确相等；它不是predicate spec digest。Role声明的observation schema、anchor policy、
required mutation exact set与minimum independent-oracle cases也必须逐项由current certificate满足。
`requiredObserverRoles`、`observerQualificationIds`、mutation IDs及registry certificate/revocation sets均按schema
规定严格排序；外部乱序直接invalid，GateCore不得normalize后放行。

[PFD] Observation facts先由`observationSchema` exact decode/re-encode，再复算`canonicalFactsHash`；snapshot的
ordered claim/observation/raw IDs与三个set roots必须exact相符。Acquisition ProductionReceipt必须属于同一
observer implementation/process并绑定这些raw refs；任一ID不存在、重复、splice或无法定位均invalid。

[PFD] observer也必须被证明能正确观察：canonical header至少交叉本地execution client与独立source；root/
Graph由独立reader重算；exact由独立整数数学、第二语言或pinned fork验证；final-sim由不同engine/fork比较
normalized effects；heuristic solver只验证feasible/best-found honesty，只有声明bounds内的小图exhaustive
oracle才可声称optimal。一个“不同名字但共享同一错误实现”的collector不算独立。

[PFD] 不要求先写完未来所有Family/domain测试。先资格化最小全局事实底座；之后每个vertical slice严格按
claim schema→observation schema→PredicateSpec→positive/negative/invalid/mutation cases→independent oracle→
qualify verifier/observer→production implementation→replay/live facts推进。手写损坏case可校准拒绝路径，
手写成功fixture永远不能提供production success。

## 20. impl-only reference-producer calibration

### 20.1 独立拓扑

~~~text
impl runtime ──raw artifacts──> tools/reference-only/impl ──untrusted claim──┐
Aloha runtime ────────────────> native evidence emitter  ──production claim─┼─> frozen predicates

chain / Reth / process / math / independent EVM ──qualified observations────┘
~~~

[PFD] acceptance package不import impl或Aloha production源码。唯一reference-only importer只把已存在的
raw artifacts规范化为`ReferenceWitnessReceipt { trustLevel: "untrusted-reference" }`；不能调用builder、
planner、solver、quoter、executor或simulator补齐事实，不能改变runtime，也无权定义成功或获得independent
oracle credit。acceptance core只读neutral claims与qualified observations，不读旧DTO。

[REJ] 旧`semanticStages(raw.selected)`、production-replay、blind/capture/paired-live与日志KPI parser不得进入
acceptance authority。尤其禁止从一个producer-selected对象合成`quote positive / execution success / decision
allow`六个pass；malformed/unknown行、缺timing或缺root不能被skip后缩小分母。它们最多提供带raw locator的
untrusted witness或diagnostic，production success只能来自六个真实load-bearing boundary facts。

[PFD] impl只用于校准它实际产生且能由raw locator复核的事实，例如startup、durable attestation、
Family+Instance、readyGeneration、Graph、restart与memo reuse。impl没有真实证据的exact、execution、
final-sim、完整性能或live downstream事实必须是`missing/invalid`；不能由代码形状、日志文案或旧脚本推成pass，
也不能反过来降低Aloha最终验收要求。Aloha的exact、execution、final-sim、性能和完整六步lineage只能由
Aloha自己的实际live事实证明。

### 20.2 校准顺序

[PFD] 在任何 Aloha production implementation 开始前：

1. 冻结core Claim/Observation schemas、PredicateSpecs、pass/fail/invalid语义与critical mutation IDs；
2. 实现最小qualification runner、independent reference models与observers，先签发current observer证书；
3. 固定唯一impl exact SHA、executable hash、PID/start/boot/log inode与raw artifact set；
4. reference-only importers逐字段附raw artifact hash/locator；不存在的事实不生成；
5. 只用impl实际覆盖校准对应predicates；
6. 用chain/Reth/process/math/independent EVM或bounded exhaustive model产生expected verdict；impl不得提供；
7. 对每个predicate运行positive、negative、invalid、metamorphic与声明的全部critical mutations，保存counterexample；
8. 人工抽查raw locators与独立复算结果；确认collector/validator bug后修复并重跑受影响case，而不改production；
9. 冻结schema/spec/validator/observer/corpus/reference-importer digests及qualification certificate roots；
10. 最小全局事实底座和首个vertical slice资格化后签发architecture baseline；后续slice必须在自己的production
    implementation开始前完成同样qualification，不要求预写未来所有Family/domain测试。

[PFD] impl某predicate为invalid不等于qualification framework失败；只要该predicate已有独立positive/
negative/invalid coverage和current certificates，baseline可成立。真正阻塞某个Aloha production slice的是该
slice无qualified predicate/observer，或Aloha自身缺load-bearing事实。新旧数量无需parity。

### 20.3 Validator bug policy

[PFD] 当 validator 与 source/checkpoint/runtime/on-chain事实冲突：先定位 raw locator、schema decode、窗口、
join 与 lineage。确认 validator/observer bug 后：升级implementation digest、使旧qualification stale、加入最小
负向/回归case并重跑受影响的impl/Aloha claims。禁止修改正确production authority迎合脚本，禁止为任一
producer特判，禁止沿用旧错误verdict。

## 21. Six-step acceptance protocol

[PFD] six-step是Aloha production DoD必需的端到端scenario，不是全部acceptance architecture。独立predicates
还必须分别验证source coverage、universe exact partition、Graph closure、solver feasibility、local transition、
compiler、independent simulation、restart/idempotency、resource bulkhead与qualification自身。

### 21.1 通用 DAG 规则

[PFD] 六步是六个语义层，不强制“恰好六个Event的假线性链”。每个verified route leg有原stage-1 Event
及其stage-2 membership Event；一个多leg stage-3 planner Event按route顺序引用全部stage-2 parents；
stage 4→5→6再形成当前candidate的线性tail。

[PFD] Stage 1保留原builder-run/runtime/process anchor且generationId=null；Stage 2保留实际promotion的
ready-generation scope。Stage 3–6必须拥有相同当前runtime commit/PID/start/boot/log inode、
producerSessionId、correlationId、generationId、definitionCatalogRoot、generationRefreshPolicyHash、
strategyCatalogRoot、instanceCatalogRoot、graphRoot及GraphView lease，并且其scope.builderRunId等于leased
ready的origin run。
所有DAG节点cutoff/Family-capability leaf bindings必须相容；parentEventIds/outputHashes、Merkle membership与
sequence必须可复算，但不得错误要求stage 1拥有尚不存在的generation。

[PFD] Restart不重发stage 1/2；stage 3引用持久的原stage-2 Events及ready/memo-reuse receipt。每个leg均须
验证，不能用anchor Family代表其他legs。Stage 1/2非verified结果terminal且不得进入stage3 ancestry；
stage 3–6任何非success outcome terminal。不存在bypass/not_reached成功占位。GraphView lease在stage3–6
不变，strategyCatalogRoot也不变；全局adopt新generation时旧session仍持有原lease直至DAG tail终止。

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

[PFD] 验证生产 planner 实际持有该 immutable GraphView lease与当前generated strategy ref，route的
orderedInstanceBindingsRoot来自同一graphRoot/generation，planning problem绑定同一strategyCatalogRoot，未
注入target route，未调用default/legacy Graph或fallback。Stage 3同时引用该route的current-source coarse
projection root与admission receipt，明确它来自ranked Top-K还是bounded-unranked lane；projection必须绑定同一
edge/direction/generation/graph/source。普通score不得形成hard prune；若审计hard-prune分支，validator用通用
proof program独立复核profit upper bound。Validator不重新运行planner生成一条“应该存在”的route。

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
dry-run success。success还必须引用同source/plan/sim的EconomicReceipt，证明真实gas、next-block fee、current
valuation、bid与net EV；unknown/stale不能通过。验收/采集编排器、capture输出或fork fixture不能替代真实目标
环境dry-run receipt。

## 22. Negative validator calibration

[PFD] Mutation corpus 至少必须让以下篡改稳定失败：

| 类别 | 必失败 mutation |
|---|---|
| stage | 删除、重复、交换任一步；terminal后追加；ordinal/id不一致 |
| run/process | splice两个run/correlation；SHA、executable、PID、start ticks、boot ID不一致；篡改stage1/2原builder anchor或restart reuse receipt |
| log | boot/device/inode改变；offset重叠、倒退、越界；logRangeArtifactRef bytes/hash/length不匹配 |
| canonical | 相同number不同hash/stateRoot；source越出declared range |
| generation | stage1伪造非null generation、stage/scope kind错配；generationId、generationRefreshPolicyHash、definitionCatalogRoot、strategyCatalogRoot、instanceCatalogRoot、graphRoot、promotion revision不一致；ready前producer启动；session中lease/strategy root变化 |
| Family | familyDefinitionHash、capabilitySetHash、candidateKey、nullable instance规则、ordered route-leg root不一致；删除/替换某leg stage1/2 membership |
| hash chain | 修改facts/outcome/reason不改hash；重算output/event但不改child input；parent Events/outputs DAG断裂 |
| exact | 伪造exact、缺current source或Reth binding、fallback=true |
| coarse | projection换edge/direction/head/generation；普通score伪装profit upper bound；删除unranked/not-probed accounting；50-block observation冒充current price |
| execution | 伪造program、缺action owner/interpreter/exact binding、观察pair被Cartesian展开 |
| simulation/economics | 伪造final-sim、缺program/source/receipt；用effect sim替代final sim；gas/fee/valuation/bid splice或stale仍allow |
| schema | unknown core field、duplicate key、非规范number/address/hash、未知version被忽略 |
| performance | 空分母、丢失败样本、任选100 heads、跨PID拼接、serial证据冒充同窗 |

[PFD] negative corpus 可以人为损坏真实 evidence，也可以构造最小无成功语义的格式样本来测 parser；它不能
用手写成功 fixture证明production成功。每个 mutation记录base artifact root、mutator code hash、expected
reason与实际validator reason，corpus root进入冻结 receipt。

[PFD] 表格类别不等于coverage。每个PredicateSpec必须列出exact `criticalMutationIds`，qualification certificate
复核declared集合与rejected-or-invalid集合完全相等。至少覆盖anchor hash/stateRoot、parent/event ID、amount±1、
ordered route/instance binding、artifact/root、execution bytes、effect delta、observer证书移除或stale、独立
observation移除；每个未按预期拒绝的case输出content-addressed counterexample并使certificate not-qualified。

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

[PFD] 所有release Family统一按自己声明的SourcePlan与exact partition判断：有实例、zero-candidate或
chain-proven rejected都必须有coverage和catalog entry，validator不得因Funding/Credit/任何domain名称放宽。
对有instances的Family，分别报告candidate、verified、rejected、retryable、invalidProgram、
instancePublication、projectedEdge、declaredCoarseCapability、coarseRankable/unavailable、unrankedAdmission、
declaredExactCapability、ownedAction计数与roots；这些字段均由
architecture-neutral schema定义，不沿用旧expected/priced术语。Family名称只用于展示；verdict由BOM exact
set与schema facts驱动。当前BOM没有LP entry，因此既不要求也不接受伪LP row。

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
给出raw Event/metric receipt set root、eligible denominator、exclusion audit、queue caps、provider/hardware
profile。Normalized denominator的`excludedHeads` MUST为空；pre-ready observations与被replacement取代的orphan
只进入独立non-denominator audit。任何missing或unknown不从分母删除。

[PFD] 首个计数head前只冻结window start、eligibility rule、profile与targetCount；真实未来99个hash不可能也不得
预知。之后canonical-header collector在outcome可见前按规则append-only接收下一个head并分配ordinal，最终ordered
number/hash set只能由该预冻规则与append log推导；reorg以显式orphan→replacement lineage在同ordinal结算，不做
last-write-wins覆盖。每个ordinal恰有一个最终terminal receipt；duplicate、坏JSON、未知outcome、缺timing、越界
log offset或采集中process/generation变化均使窗口`invalid`，不得skip。timing sample数必须等于denominator；
candidate overlap必须从两个content-addressed candidate sets计算，不能用heads/sec代替；窗口时长由monotonic
start/end anchors复算，不能信调用者传入。顶层verdict只能由PredicateSpec结果派生，不得与内部gate冲突。

[PFD] 最终门至少包括：

- 连续100/100 eligible heads为healthy terminal且满足固定deadline profile；
- P50/P95/P99与throughput满足绝对预算；
- source scan count、single-flight physical build、attest/materialize/project counts满足不重复不变量；
- memo reuse与restart差集满足预期；
- RPC/REVM/final-sim permit与queue可守恒，CPU/RSS/worker restart无失控；
- producer active generation冻结；
- 至少一条真实dry-run candidate在同lineage完成六步；
- legacy authority/import/runtime/log/consumer=0。

### 23.4 Architecture isolation predicates

[PFD] 除six-step外，required architecture predicates至少包括：

- `authoring-facade-runtime-closure-zero`：build-time大模板不进入production closure；
- `source-repository-production-closure-zero`：旧repo与reference-only工具不load-bearing；
- `legacy-authority-zero` aggregate gate：仅当下述两个独立predicate均持有current pass certificate才pass；其
  AST/module graph覆盖所有production entrypoints、generated/package alias、worker/child process、Rust/Solidity
  与deploy manifests，并与executable/runtime object lineage、logs及consumer receipts交叉；regex symbol scan/
  import closure hash只是一项observation，不能单独pass；
- `unaffected-capability-closure-stability`：新增未被依赖的capability/Family/Strategy后，既有closure roots、
  semantic receipts、pinned-input outputs与qualification保持有效；
- `new-domain-extension-isolation`：未来新增domain只能改变自己的extension specs、Family/Strategy packages、
  release-intent与generated artifacts；stable core和中央源码diff为零；
- `coarse-authority-isolation`：coarse projection不进入Graph root、不签发exact/action；无proof score mutation只改
  排序不改hard-prune集合，missing capability仍有bounded-unranked accounting；
- `family-resource-bulkhead`：一个Family超时、crash或资源尖峰时，只使自己的facts unresolved，关键lane预算不失守。

[PFD] 当前不创建LP template或adapter来跑`new-domain-extension-isolation`。该predicate先用schema-level arbitrary
extension和mutation证明通用机制；未来真正提出LP时，再用真实LP package作为该change set的事实输入，且既有
Swap/Protocol等未依赖closure必须byte-identical。

[PFD] legacy-zero拆成两个独立predicate：`source-repository-production-closure-zero`证明旧repo/reference-only
依赖为零；`legacy-shaped-authority-zero`证明新repo内没有换名后的compat facade、fallback、第二Graph/catalog/
checkpoint authority或runtime topology writer。两者共同消费以下exact receipt；任一unresolved/dynamic unknown
均为invalid，而不是从分母移除：

~~~ts
interface LegacyAuthorityClosureReceiptV1 {
  readonly receiptId: Hash;
  readonly predicateSpecDigests: readonly [
    sourceRepositoryProductionClosureZero: Hash,
    legacyShapedAuthorityZero: Hash,
  ];
  readonly qualificationCertificateIds: readonly [Hash, Hash];
  readonly releaseIntentRoot: Hash;
  readonly productionEntrypointDenominatorRoot: Hash;
  readonly tsJsAstModuleClosureRoot: Hash;
  readonly generatedAndPackageAliasClosureRoot: Hash;
  readonly workerChildDynamicEntrypointRoot: Hash;
  readonly rustBinaryClosureRoot: Hash;
  readonly solidityDeploymentAndAbiOwnershipRoot: Hash;
  readonly deployManifestAndSystemdExecRoot: Hash;
  readonly executableLoadedObjectRoot: Hash;
  readonly consumerObjectLineageRoot: Hash;
  readonly runtimeLogWindowRoot: Hash;
  readonly unresolvedEntrypointRefs: readonly ReadOnlyArtifactLocatorV1[];
  readonly oldRepositoryLoadBearingRefs: readonly ReadOnlyArtifactLocatorV1[];
  readonly forbiddenAuthorityRefs: readonly ReadOnlyArtifactLocatorV1[];
  readonly compatibilityFacadeOrFallbackRefs: readonly ReadOnlyArtifactLocatorV1[];
  readonly verdict: "pass" | "fail" | "invalid";
}
~~~

[PFD] 所有字段都参与receiptId与verdict复算；release-intent声明的每个app、CLI、worker、child、dynamic loader、
native binary、deployed contract与systemd ExecStart必须进入entrypoint denominator。Source scanner、build manifest、
deployed executable/loaded object、consumer lineage与同一process/log window相互交叉，任何一层自报零都不能独立pass。
两个digest与qualification certificate按上列固定顺序exact绑定，并分别签发AcceptanceCertificate；aggregate verdict
只是二者AND，不能用一张generic cleanup证书替代。

[PFD] Unit/build/fixture、部分Graph、单次进程启动、来源不明的edge数、旧新数量parity或某脚本打印pass均
不能替代上述事实。Build只证明implemented；真实lineage、restart与性能门共同成立才证明该架构落地。

## 24. Core pseudocode

[PFD] 本节是接口和 authority 伪代码，不是生产实现。所有 Hash 操作都有 domain separator；所有
persist/CAS 都指单 writer transaction；所有 Promise 都接受 cancellation/deadline。

### 24.1 Family authoring compiler、runtime refs 与 CapabilityModule

~~~ts
function compileFamilyDefinition(
  definition: FamilyAuthoringDefinitionV1<CapabilityAuthoringMap>,
  releaseIntent: FrozenReleaseIntent,
): GeneratedFamilyEntryV1 {
  assertExactStableCoreKeys(definition.core);
  assertEveryExtensionDeclaredInCurrentCapabilityIndex(definition.extensions);
  assertNoUndeclaredActionOwner(definition.actionOwners);
  assertFactContractsExist(definition.acceptanceDeclarations);
  return emitDataOnlyEntryAndStageLocalRefs(definition, releaseIntent);
}

interface RuntimeFamilyPortRegistryV1 {
  requireForStage(familyId: FamilyId, stage: StageId): StageFamilyRefs;
  requireCapability(ref: CapabilityRef): DeclaredCapabilityHandle;
  requireActionOwner(ref: ActionOwnerRef): DeclaredActionOwnerHandle;
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

[PFD] compiler是完整大模板的唯一消费者；runtime registry只按stage返回窄ref。中央lifecycle只看union tag与
hashes，不解析OpaqueIdentity/Descriptor/Projection/Output。Family module不能自行写checkpoint、Graph、
evidence success或submission；capability interpreter不能取得未声明port。

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
  rehydrator: DeclaredRehydrationHandle,
  currentCatalog: GeneratedCatalog,
  source: CanonicalSourceView,
): IssuedRouteHandle {
  assert(memo.familyId === rehydrator.familyId);
  assert(reuseProof.memoHash === memo.hash && reuseProof.currentIssuer === rehydrator.issuerRef);
  assert(reuseProof.requestedArtifactDependencyRoot ===
    currentCatalog.requiredArtifactDependencyRoot(memo.familyId, "route-rehydration"));
  assert(validateMemoDependenciesWithOwnerProof(memo, reuseProof, currentCatalog, source) === "reusable");
  const canonicalMemo = verifiedMemoCodec.decodeExact(memo.canonicalBytes);
  return rehydrator.rehydrate(canonicalMemo, source); // narrow issuer creates a non-serializable handle
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
      const strategies = generatedStrategyCatalog.loadExact();
      assertStrategyCatalogMatchesReleaseIntent(strategies);
      const source = await canonicalSource.openHeadSession(head);
      const session = deepFreeze({
        lease,
        source,
        strategyCatalogRoot: strategies.root,
        strategyRefs: strategies.stageLocalPlanningRefs(),
        correlationRoot: newCorrelationRoot(),
      });
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

### 24.11 Route enumeration → coarse funnel → exact → execution → final-sim/economics

~~~ts
function admitCoarse(
  routes: readonly RouteHandle[],
  assessments: ReadonlyMap<Hash, CoarseRouteAssessmentV1>,
  objective: ObjectiveProfileV1,
  budgets: { ranked: number; unranked: number },
): CoarseAdmissionV1 {
  const hardPruned: ProvenPrune[] = [];
  const rankable: RankedRoute[] = [];
  const unranked: RouteHandle[] = [];
  for (const route of routes) {
    const assessment = assessments.get(route.routeId);
    if (
      assessment?.profitUpperBound !== null &&
      assessment?.profitUpperBound !== undefined &&
      assetRefHash(assessment.profitUpperBound.numeraire) === assetRefHash(objective.numeraire) &&
      authorityProofs.verifyConservativeUpperBound(assessment) &&
      BigInt(assessment.profitUpperBound.amount) < BigInt(objective.minNetGain)
    ) {
      hardPruned.push(sealPrune(route, assessment));
    } else if (assessment?.rankScore !== null && assessment?.rankScore !== undefined) {
      rankable.push({ route, score: BigInt(assessment.rankScore) });
    } else {
      unranked.push(route);
    }
  }
  const rankedSelected = stableTopK(rankable, budgets.ranked);
  const unrankedSelected = deterministicOwnerRoundRobin(unranked, budgets.unranked);
  const terminalIds = new Set([
    ...rankedSelected.map(item => item.route.routeId),
    ...unrankedSelected.map(route => route.routeId),
    ...hardPruned.map(item => item.routeId),
  ]);
  return sealExactAccounting({
    ranked: rankedSelected,
    unranked: unrankedSelected,
    hardPruned,
    notProbed: routes.filter(route => !terminalIds.has(route.routeId)),
  });
}

async function evaluateCandidate(
  session: ProducerSession,
  trigger: TriggerFact,
): Promise<DryRunReceipt> {
  const planningProblems = session.strategyRefs.map(ref =>
    ref.issuePlanningProblem(session.lease.graphView, trigger),
  );
  const enumerated = planner.enumerate(planningProblems); // generic, no Family/strategy branch
  const projections = await coarseEconomics.projectCurrentSource({
    routes: enumerated,
    graphLease: session.lease,
    source: session.source,
    capabilityOwners: generatedCatalog.coarseOwners(),
  });
  const admission = coarseEconomics.admit({
    routes: enumerated,
    projections,
    objective: session.objective,
    rankedLimit: session.budgets.rankedExact,
    unrankedLimit: session.budgets.unrankedExact,
  });
  assertExactCoarseAccounting(enumerated, projections, admission);
  assert(admission.hardPruned.every(item => item.profitUpperBoundProof !== null));

  for (const route of admission.forExact) {
    const correlationId = correlationFor(session, trigger, route);
    const authorityParents = loadAndVerifyOriginalStage2ParentsForEveryRouteLeg(
      route, session.lease,
    ); // each stage2 has its original stage1 parent; no event is re-emitted
    emitStage3PlannerFact(session, correlationId, route, {
      parents: authorityParents,
      coarseProjectionRoot: admission.projectionRootFor(route),
      admissionClass: admission.classFor(route), // ranked | bounded-unranked
      accountingRoot: admission.accountingRoot,
    });

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
    const economic = await economics.sealCurrentSource({
      objective: session.objective,
      program,
      simulation: rawSimulation,
      source: session.source,
      valuationOwners: generatedCatalog.valuationOwners(),
      bidPolicy: session.bidPolicy,
    });
    const sealedFinal = await safety.verifyCanonicalFencesAndSealFinalReceipt({
      rawSimulation, program, source: session.source, graphLease: session.lease,
      economic,
      requiredObligations: REQUIRED_SAFETY_PROFILE,
    });
    emitStage6SimulationFact(session, correlationId, sealedFinal);
    if (
      sealedFinal.outcome === "success" &&
      economic.verdict === "positive-net-ev" &&
      submission.isDryRun()
    ) {
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
    artifactLineage: {
      inputArtifactIds: boundary.inputArtifactIds,
      outputArtifactId: boundary.semanticArtifactId,
      productionReceiptId: boundary.productionReceiptId,
    },
    scope: ctx.scope,
    definitionCatalogRoot: ctx.definitionCatalogRoot,
    strategyCatalogRoot: ctx.strategyCatalogRoot,       // null for stages 1/2
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

function validateSixStep(
  query: AcceptanceQueryV1,
  snapshot: FrozenQualifiedFactSnapshotView,
): Verdict {
  requireQueryAndSnapshotIdsRecompute(query, snapshot);
  requireSnapshotRootsAndExactObservationIdsRecompute(snapshot);
  const registry = snapshot.requireQualificationRegistry(query);
  const qualified = registry.currentVerifierFor(
    query.predicateSpecDigest,
    SIX_STEP_PREDICATE_IMPLEMENTATION_DIGEST,
  );
  if (!qualified) {
    return invalid("qualification-missing-or-stale");
  }
  for (const observation of snapshot.observations) {
    requireObservationIdAndPayloadRecompute(observation);
    requireObservationMatchesCurrentCertificateSubjectSchemaLocatorAndAnchor(
      observation,
      registry,
      qualified.requiredObserverRoles,
    );
  }
  requireObserverRolesExactCoverage(snapshot.observations, qualified.requiredObserverRoles);

  const tail = snapshot.claims.exactCorrelation(
    query.processAnchorHash,
    query.correlationId,
  );
  requireExactOrderedTail(tail, [3, 4, 5, 6]);
  requireSameProducerSessionGenerationStrategyRootsAndLease(tail);
  requireStage3ManyParentsThenLinearStage4To6(tail);

  const stage2Parents = requireExactOrderedRouteLegParents(tail[0], snapshot.claims);
  const stage1Parents: EvidenceEventV1[] = [];
  for (const [legIndex, stage2] of stage2Parents.entries()) {
    requireStage(stage2, 2);
    requireOriginalBuilderRuntimeAndRawLocator(stage2);
    requireReadyMembershipForLeg(stage2, tail[0].facts.orderedInstanceBindingsRoot, legIndex);
    const stage1 = requireSingleParent(stage2, snapshot.claims);
    stage1Parents.push(stage1);
    requireStage(stage1, 1);
    requireOriginalBuilderRuntimeAndRawLocator(stage1);
    requireCandidateInstanceAndDefinitionOrReuseBinding(stage1, stage2);
    requireMemoReuseProofWhenDeclared(stage1, stage2, snapshot.observations);
    requireAuthorityProofReplay(
      acceptancePureInterpreters.authorityProof,
      snapshot.requireQualifiedObservation("authority-proof", stage1.eventId),
      stage1,
    );
  }

  requireReadyBeforePlanner(
    snapshot.requireQualifiedObservation("ready-checkpoint", tail[0].eventId),
    stage2Parents,
    tail[0],
  );
  requireCurrentStateReplay(
    acceptancePureInterpreters.stateFact,
    snapshot.requireQualifiedObservation("current-state", tail[1].eventId),
    tail[1],
  );
  requireEveryLegExactAndActionOwner(tail[1], tail[2], stage2Parents);
  requireRealFinalSimAndSafetyReceipt(tail[2], tail[3]);
  return evaluateQualifiedPredicate(
    qualified,
    [...stage1Parents, ...stage2Parents, ...tail],
    snapshot.observations,
  );
}
~~~

[PFD] ObserverAdapter在GateCore调用前完成所有Reth/RPC、checkpoint、filesystem、process与log I/O并封存
`QualifiedFactSnapshotV1`；`FrozenQualifiedFactSnapshotView`只是对该content-addressed snapshot的纯exact decode，
不能延迟访问外部系统。query只含subject/process/correlation与snapshot ID；不含target route、Family特判、
builder callback或“expected success”fixture。

## 25. Multi-Agent ownership and integration plan

### 25.1 并行规则

[PFD] 所有 Agent 从同一个 architecture-baseline commit 创建独立 branch/worktree。禁止共享工作树，禁止
两个Agent同时拥有同一package，禁止直接编辑另一个owner目录。跨package变化先改冻结spec并由integration
owner签发新baseline；不能靠临时相互import解决。

[PFD] 先冻结五类合同：Claim/Observation/Evidence schemas与PredicateSpecs、qualification规则、core
envelope/codec、Family/Strategy/capability ports、authority/dependency rules。冻结前只允许原型与审计；
最小事实底座与首个slice资格化后production工作包并行。工作包按完整模块边界拆分，不按单函数或单测试微切片。

### 25.2 工作包

| Owner Agent | 可修改目录 | 禁止修改 | 输入 → 输出 / authority | 集成事实门 | 并行关系 |
|---|---|---|---|---|---|
| Core contract steward | specs/core-envelope、specs/capability-index、specs/authority-proof | apps、families、generated、validator | reviewed contracts → frozen spec roots；无runtime authority | exact schema/dependency hashes、跨语言vectors | 最先，与Acceptance contract共同freeze |
| Release-intent steward | specs/release-intent | generated、apps、Family/Strategy源码 | 独立reviewed Family/Strategy public-entry BOM → releaseIntentRoot | 两人review签名、manifest refs存在、无silent omission；当前LP=absent from BOM | proposals后串行；不得兼任runtime integration owner |
| Acceptance contract/schema | specs/{evidence,predicates}、acceptance/{schema-codec,validator,predicate-specs,reference-models,observer-qualification,authority-proof-interpreters,negative-corpus,cli} | apps、production packages、families、tools/reference-only、specs/release-intent | claims+qualified observations → pass/fail/invalid；无production authority | current verifier/observer certificates、critical mutations exact覆盖、independent oracle>0 | 最先；冻结后继续只读审计 |
| impl reference importer | tools/reference-only/impl | impl写入、production、validator | impl raw artifacts → untrusted witness claims；只生成其真实覆盖字段 | 每字段locator/hash；缺字段诚实invalid且不拖baseline | schema冻结后与independent observers并行 |
| Canonical/durable checkpoint | packages/canonical-source、packages/canonical-codec、packages/durable-store、packages/checkpoint | Family/planner/execution | chain source + SQLite tx → SourceView/content/CAS root；拥有canonical、physical durability与checkpoint pointer | crash/reorg/CAS/partial-write/GC reachability事实 | contract冻结后可并行 |
| Family SDK/catalog generator | packages/family-sdk、packages/artifact-fingerprint、packages/catalog-generator | concrete families、planner、specs/release-intent、generated手写 | build-time big definitions+BOM → narrow stage refs/catalog/impact/composition roots | authoring runtime closure=0、dependency closure、local invalidation、reproducible output | 与capability Agent并行，先于Family ports；不做LP template |
| Strategy SDK/catalog | packages/strategy-sdk、generated/strategy-catalog、strategies/<current> | Family internals、planner/solver kernel、LP strategy | generic capability predicates+BOM → planning problem issuer refs | no protocol import/central switch、strategy-local closure | Family runtime refs稳定后并行；只做当前策略 |
| Generated artifacts（machine-only） | generated/{family-catalog,strategy-catalog,runtime-composition}仅由generator写 | 所有人手工编辑 | releaseIntentRoot+manifest roots → byte-reproducible artifacts | clean regenerate diff=0、BOM/catalog/runtime exact equality | integration owner只运行generator，不编辑产物 |
| Capability/interpreter | packages/capability-contracts、packages/capability-interpreters、packages/request-program | concreteFamily、scheduler internals | FrozenProgram → typed facts/interpretation ports | round-trip、field mutation、error ownership | 与SDK并行 |
| Discovery/attestation/generation builder | packages/observation、packages/discovery、packages/attestation、packages/generation-builder、apps/operator-cli | checkpoint internals、Family语义、完整authoring definition、ready internals、apps/searcher-runtime | SourcePlans+stage-local refs+ports → exact partition/outcomes及唯一build orchestration；operator-cli仅status/read或向runtime admin port提交retryable probe，不直接开DB writer | 50-block、dedupe、once、typed outcome、无第二startup/promotion path | 依赖SDK/canonical contracts；与Graph owner按port并行 |
| Graph/readyGeneration | packages/catalog、packages/ready-generation、packages/graph | raw universe、Family internals、startup orchestration | verified publications + PromotionCallerToken → atomic immutable GraphView | full-root closure/CAS/canonical fence/crash/lease/adoption | 与state/scheduler并行 |
| State/scheduler/REVM | packages/scheduler、packages/shared-work、packages/state-runtime、runtime/revm-workers | Graph authority、Family math | generic work/program → source-bound facts | single-flight、quota、abort/HOL、permit守恒 | contract冻结后并行 |
| Producer/head-session | packages/producer | Graph write、discovery/attestation、Family语义、apps composition | active ready lease + canonical heads → immutable ProducerSession/correlation；拥有session admission/barrier，不拥有topology | serving-age/release/policy fence、100/100 terminal、active lease不变 | 依赖Graph/canonical/scheduler ports；与planner并行 |
| Planner/exact | packages/planner、packages/solver、packages/exact | families、protocol ABI/math | GraphView+opaque ports → route/current exact | no protocol import、current-source/fallback=0 | 依赖Graph/SDK port，不依赖Family实现细节 |
| Execution/final-sim | packages/execution-program、packages/final-sim、packages/safety、packages/submission、contracts/executor、contracts/interfaces | Family identities、signer secret | owned actions → program/real sim/unsigned receipt | action ownership、安全门、strict top-level sim | 与planner后半并行 |
| Evidence/telemetry | packages/evidence-emitter、packages/telemetry、acceptance/collectors | validator logic、production object creation | boundary objects → immutable events/metrics | raw locator、fsync、secret redaction | 所有owner提供boundary port |
| Family port groups | families/<assigned-set> | central packages、其他Family | locked pure kernels/invariants + big authoring template → generated narrow refs/capabilities | identity/exact/action事实、无central import | 按当前release-intent ownership cohort分组；cohort不进schema/runtime/validator；无LP cohort |
| Runtime integration owner | apps/searcher-runtime、deploy/systemd、deploy/runtime-shell | Family内部实现、validator、release-intent、generated手写 | generated catalog+composition+ports →唯一process | dependency closure、exact SHA、dry-run lineage | 最后集成；可运行generator但不可改生成物 |

[PFD] Family groups不是“一族一个中央补丁”。每组只修改自己目录；发现SDK缺能力时提交Capability Proposal：
新schema、通用语义、依赖closure与受影响Families。普通Family或capability扩展只能增加已声明的extension/
interpreter module，不得修改validator core或EvidenceEvent core schema；同一通用validator按schemaRef与
generated registry校验。只有确实改变所有模块共享含义的stable core envelope升级，才允许显式新major
schema并触发全局重验，不能把单个Family或future-domain需求包装成core升级。无关Family保持原memo与验收，不进行
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

[PFD] Claim/Observation/Predicate specs、qualification framework与core contract freeze必须串行在前；随后impl
reference importer、independent observers与boundary CI可并行，签发acceptance baseline后canonical/checkpoint、
SDK/capability、scheduler/state、Graph store再并行；Family port在SDK release后并行；planner/exact、execution/
final-sim在各自port稳定后并行；runtime composition、systemd dry-run与Aloha六步事实验收串行收口。

[PFD] 不允许为了多Agent吞吐创建共享“central TODO file”。跨owner问题进入content-addressed contract issue；
只有owner修改包，消费者更新到新spec hash。

## 26. Ordered greenfield implementation plan

[PFD] 这是空仓库内部的依赖顺序，不是旧runtime迁移、shadow或逐步cutover：

1. **冻结架构无关事实语言**：定义Claim/Observation/Evidence schemas、PredicateSpecs、pass/fail/invalid、
   SemanticArtifact/ProductionReceipt与critical mutation sets；实现最小qualification runner。
   Verify：schema/spec/implementation digests、observer/verifier certificate schemas与corpus root可复算。
2. **资格化并校准事实底座**：impl importer只校准其raw artifacts真实覆盖的startup、attestation、ready、
   Graph、restart与memo事实；expected只来自qualified chain/Reth/process/math/independent EVM。
   Verify：impl不存在的事实诚实invalid；全部declared mutations拒绝；current certificates成立。缺失后段
   不阻塞framework baseline，但Aloha最终仍须用自己的live事实完整通过。
3. **签发architecture-baseline**：冻结core envelope、generic Family大模板、generated narrow refs、Strategy/
   capability ports、error taxonomy与authority/dependency rules。
   Verify：所有owner只依赖spec hashes；arbitrary future-domain extension只影响declared closure；当前无LP schema。
4. **建立clean-room repo与依赖门**：创建最终package tree、reference-lock/reuse-ledger、boundary required CI、
   generated family/strategy catalog pipeline。
   Verify：production旧repo closure=0、authoring/runtime closure=0、acceptance不importproduction/reference tools、
   空catalog可确定性生成。
5. **并行实现foundation**：canonical/durable-store/checkpoint、codec/Family authoring compiler+runtime refs、
   capability/Strategy SDK、scheduler/shared-work、REVM worker protocol、Graph store。
   Verify：reorg/CAS/crash、round-trip、single-flight/HOL、immutable lease、extension local invalidation事实合同；
   不交付LP template/capability/Family/strategy。
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
11. **逐symbol采用或重写Family kernels**：按reference lock/ReuseReceipt只采用已证明的isolated pure symbol或
    declaration；reverse identity、lifecycle、schema、authority与shell全部按大模板/新ports实现。
    Verify：每Family仅修改自己目录；old symbol hash→new contract evidence；whole-file/runtime copy=0；central无分支。
12. **完成generatedcatalog与全族矩阵**：所有Familyexactset有source/outcome/publication/edge说明。
    Verify：所有Family统一按SourcePlan/exact partition；silentmissing=0；当前BOM与catalog均无LP entry。
13. **接入nativeemitter**：在真实boundaries写SemanticArtifact、ProductionReceipt与Event；validator保持frozen
    且无productionimport。
    Verify：rawlocator/root/qualified observations复核；不能通过手写成功fixture。
14. **做restart/差集/性能事实验收**：SIGTERM/systemd restart、memo reuse、singleprobe、100/100、P99。
    Verify：绝对预算、物理work不重复、Reth/CPU/queue不失控。
15. **exact-SHA systemd dry-run**：clean pushed SHA、executable/process/log anchor、默认无signer。
    Verify：runtime commit=deployed SHA；无nohup/旧process；不签名不广播。
16. **完成一条真实six-step lineage与全局零证明**：真实candidate到finalsim，同roots/correlation。
    Verify：legacy authority/import/runtime/log/consumer=0；所有production predicates/observers持current
    qualification且事实门pass。

[PFD] 步骤5以后仍按vertical slice执行fact contract→qualification→implementation→replay/live。冻结core
framework不等于提前写完未来所有测试；任何Agent不得先写production再补一个迎合其对象形状的predicate。

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
| Greenfield重复发明成熟算法 | reference-lock后逐symbol采用pure kernel或按不变量重写choreography | 全复制旧runtime、whole file adoption或为了新颖拒绝成熟不变量 | lock/ledger、old/newcontent hash、dependency closure、contract evidence |
| 中央再次吸收Family特判 | opaque payload + generatedowner + capability proposal | if familyId、地址/ABI/selector/topic switch | forbidden import/literal审计 + 新Family不改central diff |
| future-domain扩展导致既有Family全重验 | declared transitive capability closure局部失效 | global definitionCatalogRoot变化即全量attest | impact receipt + unaffected memo/qualification reuse=100% |
| Family大模板变runtime god object | build-time authoring façade→generated stage-local refs | stages持有完整Family definition/callable map | authoring-facade-runtime-closure-zero |
| 为未来LP预塞中央union或空模板 | 当前无LP资产，只保留generic extension slot | LP enum、placeholder capability/Family/fixture | current BOM LP=0 + arbitrary extension isolation |
| freeze层静默丢字段 | one schema生成codec/freeze/persist/transport/hash | handwritten DTO/copy | byte round-trip + per-field mutation + cross-language vectors |
| plugin bug变永久rejection | typed transportfacts，只有plugin显式proof可reject | decode throw+0x/revert中央推断 | proof binding + newcutoff revalidation |
| 50 blocks遗漏老实例 | observation与identityinventory分authority | recent swap冒充universe completeness | SourcePlan coverage + point-in-time enumeration |
| crash/人工停止从零开始 | per-key WAL/CAS中途flush | completed-only JSON/array index | fault injection + restart exact outcomes |
| checkpoint写入成性能瓶颈 | content-addressed records + small root transaction | 每25条重写巨型JSON | DB latency/WAL/fsync/P99 receipt |
| 统一调度变慢 | shared scan/single-flight、diff、lanes、quota、reserved capacity | 无界并发或跳过正确性 | physical work count + queues + 100/100 budgets |
| slowFamily拖死全局 | RPC/REVM/finalsim隔离、perFamilyquota/circuit | 每attest新daemon或singleFIFO | heavy/light progress与permit守恒 |
| activeGraph漂移 | immutablelease + safe adoption barrier | continuous publication/secondarymerge | root/lease events stage3–6不变 |
| 未资格化validator/observer塑造错误production | spec先行、current qualification、raw facts only | 为脚本绿改authority、target fixture | certificates、critical mutation exact coverage、independent oracle |
| impl reference被误当oracle | impl只产untrusted witness并只校准真实覆盖字段 | 数量parity、从代码形状补齐后段或producer特判 | reference receipts列missing/invalid且independentOracleCount不含旧系统 |
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
- 完整Family大模板只在build-time；runtime只接收generated stage-local refs；
- 当前release不定义LP template/capability/Family/fixture/catalog entry/strategy；未来domain只通过versioned
  extension与自己的Family/Strategy package接入，不使未依赖closure重验；
- freeze/transport/hash来自同一schema；
- planner/solver只看genericGraph与opaqueports；
- current-source exact与final simulation无fallback；
- standing-position/repayment/conservation是通用obligation安全门，不是中央协议分类；
- acceptance先资格化predicate/observers，再用impl真实覆盖事实校准；impl不是oracle，之后
  同一spec/implementation验Aloha；
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

1. frozen Claim/Observation/Evidence schemas与PredicateSpecs已签current verifier/observer qualification；impl
   reference cases只按其真实覆盖校准，critical mutation exact set全拒绝或invalid，independent oracle count为正；
   不要求impl缺失后段通过，但Aloha全量事实不得缺失；
2. Aloha exact pushed SHA、clean tree、systemd/executable/PID/start/log anchor一致；
3. generated catalog exact set的全族Universe/Instance与Edge/Graph矩阵无silent missing；
4. readyGeneration为同一CAS，producer只持有immutableGraphView；
5. 至少一条真实dry-run candidate以同generation/cutoff/roots/correlation完成六步到finalsim；
6. restart复用、差集、singleprobe与SIGTERM恢复由durable facts证明；
7. 连续100/100与P50/P95/P99、throughput、resource/queue预算通过；
8. central Family/protocol/domain semantics=0，authoring façade runtime closure=0，旧repo/reference-only
   production closure=0，legacy authority/import/runtime/log/consumer=0；
9. defaultdry-run、finalsim、standing/repayment/conservation与human signing/broadcast gate完整；
10. canonical文档、schema、generated catalog、runtime与acceptance receipt指向同一版本化合同；当前release
    BOM/catalog无LP资产，generic extension isolation predicate有效。

[PFD] 任一项缺失都只能报告具体缺口，不能用build、unit、fixture、partialGraph、单次live、数量parity或
脚本自报pass替代。
