# 竞对驱动 Unknown Adapter Family 自动发现、适配与严格验收架构

> 状态：规范性设计，尚不构成实现完成、production cutover 或部署证据。
>
> 实现对照基线：`codex/s1-unified-adapter-architecture-impl@af003a81a29a4b093be133fda39876401725e07d`。
>
> 本文同时包含 Family Plugin Adaptation 的执行规程。该规程是本文最后一章，不再维护独立的 `SKILL.md`，避免架构合同与执行步骤漂移。

本文补齐这一闭环：监听 watchlist 竞对的真实成功交易，在任何已知 family/topic/selector 过滤之前保存原始事实；从 durable evidence 形成单一 family 的 sealed adaptation job；让不受信任的 candidate 只实现一个 family owner；再由可信生产路径证明完整 production surface 的入图、exact、执行和系统回归，最后才允许 promotion。

---

## 1. 目标、边界与最终决定

### 1.1 目标

系统必须能够把以下任一入口转成可审计的 family adaptation 工作：

- watchlist 竞对交易命中从未声明的 selector、topic、call target 或 emitter；
- observation 能被 catalog 粗匹配，但所有候选 family 都给出确定性身份拒绝；
- 链上身份属于已有 family，但出现尚未声明的 action、route、direction 或 execution binding；
- 人工提供一笔包含未知协议的真实交易。

完成态不是“生成了一些 adapter 文件”，而是：

```text
real canonical tx evidence
  → durable raw intake
  → one-family sealed job
  → family-owned candidate
  → trusted S1 materialized Graph proof
  → trusted exact/finalSim proof
  → authenticated existing six-step judgment
  → full production-surface closure
  → family boundary + complete build/regression
  → promotion-ready receipt bound to the exact commit
```

### 1.2 非目标

本文不：

- 创建第二套 Adapter abstraction、Graph、exact runtime、simulator 或 six-step judge；
- 把 AI、磁盘 IO、RPC probing 或代码生成放进 `FamilyCapabilityCatalog.matches()`；
- 让未知 family adaptation 成为 producer 热路径的正确性依赖；
- 允许地址 allowlist 代替链上 identity；
- 允许 candidate 自己签发通过它的 G1/G2 receipt；
- 用 synthetic fixture、candidate journal 或预期 amount 冒充 production fact；
- 自动部署、签名或广播。

### 1.3 producer 时序

原始竞对事实可以在 producer 期间持续采集，但必须走独立、可背压、可恢复的 capture lane。重型聚类、链上证明、代码生成、fork finalSim 和 promotion 全部在 producer 外执行。

已知 family 的 Graph publication 是 startup-only 还是在满足原子性和预算后持续 publication，由统一 adapter 架构的运行时合同决定；本文不强制二选一。无论选择哪种时序，未知 family candidate 在 promotion 前都不能进入 production authority。

---

## 2. 端到端数据流

```text
watchlisted successful transaction
  │
  ├─ receipt + every log
  ├─ outer call
  └─ internal trace calls
        │
        ▼
Raw Competitor Intake                 ← before topic/selector/family filters
        │ durable append + fsync/commit acknowledgement
        ▼
Novelty Journal + Capture Coverage
        │ derived observations are rebuildable indexes
        ▼
Catalog classification + typed lifecycle terminal barrier
  ├─ verified known family            → normal strict lifecycle
  ├─ known family, missing surface    → extend-family cluster
  ├─ all deterministic rejections     → new-family cluster
  └─ retryable/unresolved             → retry or evidence queue; no new family
        │
        ▼
Independent label oracle + evidence materializer
        │
        ▼
Sealed FamilyAdaptationJob            ← exactly one family cluster
        │
        ▼
Untrusted family candidate
        │
        ├─ trusted G1 producer: real observation → lifecycle → Graph snapshot
        ├─ trusted G2 producer: finalSim actual effects ↔ central exact
        ├─ authenticated existing six-step judge
        └─ boundary/generated/build/regression closure
        │
        ▼
Promotion-ready receipt               ← exact commit, source and job bound
```

原始事实、派生索引、candidate code、trusted receipts 和最终 judgment 是五个不同 trust domain，不能互相替代。

---

## 3. Authority 与 trust boundary

### 3.1 权威来源

1. **Canonical chain evidence**：交易、receipt、trace、code、state 和 block number/hash。
2. **Durable intake producer**：证明哪些 watchlist 交易已经完整采集并持久化。
3. **Central family runtime**：签发 identity、instance、route handle、exact outcome 和 executable Graph。
4. **Trusted G1/G2 producers**：从 production path 产生不可由 candidate 手写的 receipts。
5. **Existing six-step judge**：只判断已经认证和绑定的 receipts，不执行 RPC、quote 或 simulation。
6. **Promotion gate**：绑定 job、candidate commit、source/generation、Graph/catalog roots、surface closure 和所有验证结果。

### 3.2 不受信任的输入

以下内容都只能作为 nomination 或 annotation：

- candidate adapter 的 `capture()`、`action`、`expectedEffects()`；
- AI 输出、协议名称、地址标签和 explorer 页面；
- legacy operational cache、candidate journal 和 solver 预计 amount；
- candidate 自己生成的 pass JSON；
- selector/topic 命中；
- 一次 timeout、RPC 错误或 resource limit。

它们不能单独决定 identity、coverage、actual amount、Graph admission 或 promotion。

### 3.3 可信 producer 的代码边界

G1/G2、job sealer、label oracle、receipt authenticator、boundary evaluator 和 judge 都属于 protected framework。family-local candidate 不得修改这些文件。可信 producer receipt 必须记录 producer ID、schema version、producer source digest 和运行时版本；promotion authenticator 必须验证这些值属于允许的 trusted baseline。

---

## 4. Raw Competitor Intake：先保存，再分类

### 4.1 必须位于所有已知 surface 过滤之前

当前基线存在按已知 event topic 决定是否 trace，以及用 `catalog.matches()` 把 observation 直接分桶的路径。该路径适合已知 family 的高效 publication，但不能承担 unknown intake：真正陌生的 topic/selector 会在进入 novelty 判断前消失。

对于每一笔 watchlist 竞对的成功交易，raw intake 必须无条件采集：

- transaction hash、from、to、value、input 和 transaction index；
- canonical block number/hash 和 source generation；
- receipt status、gas 和全部 receipt logs，保留 log index；
- outer call；
- internal trace 的每个 call/create/delegatecall/staticcall，保留稳定 trace path；
- evidence producer/version；
- raw transaction、receipt 和 trace 的内容 digest。

“无条件”指不先按 known family/topic/selector 丢弃。它不意味着 producer 同步等待所有 RPC：receipt 可先 durable commit，trace 进入同一 tx 的 pending evidence 状态；在 trace commit 前，该 tx 的 capture coverage 必须是 incomplete。

### 4.2 原始 envelope

```ts
interface RawCompetitorTxEnvelope {
  readonly schemaVersion: 1;
  readonly chainId: string;
  readonly competitor: string;
  readonly txHash: string;
  readonly transactionIndex: number;
  readonly source: {
    readonly number: number;
    readonly hash: string;
    readonly generation: number;
  };
  readonly outerCall: RawCallEvidence;
  readonly logs: readonly RawLogEvidence[];
  readonly internalCalls: readonly RawTraceCallEvidence[];
  readonly blobs: readonly EvidenceBlobRef[];
  readonly producer: {
    readonly id: string;
    readonly version: string;
    readonly canonicalSerialization: string;
  };
  readonly envelopeSha256: string;
}
```

每条 log/call 保持自己的 locus，不得只扁平化成地址、selector 和 topic 数组：

```ts
interface RawLogEvidence {
  readonly txHash: string;
  readonly logIndex: number;
  readonly address: string;
  readonly topics: readonly string[];
  readonly dataSha256: string;
}

interface RawTraceCallEvidence {
  readonly txHash: string;
  readonly tracePath: readonly number[];
  readonly callType: string;
  readonly from: string;
  readonly to: string | null;
  readonly selector: string | null;
  readonly inputSha256: string;
  readonly outputSha256: string | null;
  readonly status: "success" | "revert";
}
```

### 4.3 coverage 语义

raw capture coverage 是显式范围合同，不是“看见过一些交易”：

```ts
interface CompetitorCaptureCoverage {
  readonly competitor: string;
  readonly observedThrough: { number: number; hash: string };
  readonly committedThrough: { number: number; hash: string };
  readonly traceCompleteThrough: { number: number; hash: string };
  readonly incompleteTxHashes: readonly string[];
}
```

cursor 只能在相应 journal commit acknowledgement 后推进。存在缺 receipt、缺 trace、queue overflow、磁盘失败或 canonical hash 未确认时，不得声称该范围 complete。

Factory enumeration 和区间交易识别都可以声明 complete，但 complete 的范围不同：

- factory/registry source 只能对明确 factory/registry、明确扫描范围和 cutoff 声明完整；
- event/transaction source 只能对明确 block interval、竞对集合和采集种类声明完整；
- 某一 interval 内没有观察到实例，不等于该 family 的全历史实例集合为空；
- 单笔 identity 成功不授予 omission/removal authority。

---

## 5. Durable Novelty Journal

### 5.1 journal 先存事实，派生分类可重建

建议新增通用 journal boundary，而不是给 `FamilyCapabilityCatalog.matches()` 增加副作用。raw envelope 是 durable truth；catalog match、聚类和 protocol label 是可从 raw evidence 重建的 derived index。

```ts
type NoveltyReason =
  | "no-catalog-match"
  | "no-verified-family"
  | "known-family-new-surface";

interface NoveltyRecord {
  readonly schemaVersion: 1;
  readonly journalSequence: bigint;
  readonly txEnvelopeSha256: string;
  readonly observationId: string;
  readonly reason: NoveltyReason;
  readonly attemptedFamilies: readonly FamilyAttemptOutcome[];
  readonly recordSha256: string;
}
```

### 5.2 durability contract

`offer(): void` 不足以表达持久化。写入接口必须返回 commit acknowledgement：

```ts
interface NoveltyJournal {
  append(record: UncommittedNoveltyRecord): Promise<JournalCommitAck>;
}

interface JournalCommitAck {
  readonly sequence: bigint;
  readonly recordSha256: string;
  readonly durableEpoch: string;
  readonly committedAtMs: number;
}
```

实现可以使用 SQLite WAL、append-only WAL 或等价机制，但必须满足：

- canonical serialization 后计算 record digest；
- record 与 sequence 原子提交；
- acknowledgement 只在 fsync/transaction commit 成功后返回；
- content key 保证 crash retry 的逻辑幂等；
- partial tail、checksum 错误和 sequence gap 启动 fail-closed；
- restart 能从最后一个 durable sequence 恢复；
- source/capture cursor 不得早于 journal commit；
- queue full、disk full、writer unavailable 产生 health fault 和 incomplete coverage，禁止 silent drop；
- reorg 不重写历史记录，而是追加绑定旧 block hash 的 invalidation/tombstone，再在新 canonical source 上重采集。

candidate journal 只是 adaptation evidence 的来源，不是 production Graph、identity 或 execution 的正确性路径。

---

## 6. Catalog 分类与 typed terminal barrier

### 6.1 两层 novelty 判断

第一层是 surface 粗匹配：

```text
catalog.matches(observation).length == 0
  → no-catalog-match
```

第二层必须等同一 tx/cluster 的所有候选 family lifecycle 得到结构化终态：

```ts
type FamilyAttemptOutcome =
  | {
      readonly status: "verified";
      readonly familyId: string;
      readonly identityDigest: string;
    }
  | {
      readonly status: "deterministic-rejection";
      readonly familyId: string;
      readonly stage: string;
      readonly reasonCode: string;
      readonly evidenceDigest: string;
    }
  | {
      readonly status: "retryable";
      readonly familyId: string;
      readonly stage: string;
      readonly reasonCode: string;
      readonly retryAfterMs?: number;
    }
  | {
      readonly status: "unresolved";
      readonly familyId: string;
      readonly stage: string;
      readonly reasonCode: string;
    };
```

只有在 barrier 满足以下全部条件时才产生 `no-verified-family`：

```text
verified count == 0
retryable count == 0
unresolved count == 0
deterministic-rejection count == attempted family count
```

禁止 caller 捕获错误字符串后继续，也禁止通过解析 error message 推导终态。`runStrictFamilyLifecycle`/batch caller 应返回 typed transaction-level result；producer publication 可以按自己的 policy fail-closed，但 novelty 分类必须消费结构化 outcomes。

### 6.2 已知 family 新 surface

identity 已验证但 action/route/direction/binding 未覆盖时，记录 `known-family-new-surface`，进入 `extend-family`，不得创建重复 family。

timeout、RPC 抖动、budget exhaustion 和 provider limitation 都是 retryable/unresolved，不是未知 family 的证据。

---

## 7. 聚类与 sealed `FamilyAdaptationJob`

### 7.1 一份 job 只能对应一个 family owner

一笔交易可能触达多个协议。聚类器先依据独立链上关系、call tree、emitter/target、code/proxy/factory/registry 证明和 value-flow 邻接形成 family clusters，再为每个 cluster 单独封装 job。

禁止把多个协议的地址、selector、topic 平铺到同一数组后交给 candidate 猜测。跨协议的 call/log 仍可作为 context reference，但必须标注为 cluster-external，不能变成该 family 的 positive。

### 7.2 sealed contract

```ts
interface FamilyAdaptationJob {
  readonly schemaVersion: 2;
  readonly jobId: string;
  readonly chainId: string;
  readonly competitor: string;
  readonly clusterId: string;
  readonly mode: "new-family" | "extend-family" | "unresolved";
  readonly possibleExistingFamilyIds: readonly string[];

  readonly canonicalRange: {
    readonly from: { number: number; hash: string };
    readonly through: { number: number; hash: string };
    readonly sourceGeneration: number;
  };

  readonly transactions: readonly AdaptationTransactionEvidence[];
  readonly positives: readonly LabelledFamilyExample[];
  readonly negatives: readonly LabelledFamilyExample[];
  readonly unresolved: readonly LabelledFamilyExample[];

  readonly suggestedDomain:
    | "swap"
    | "protocol"
    | "credit"
    | "unknown";

  readonly producer: {
    readonly id: string;
    readonly version: string;
    readonly sourceSha256: string;
    readonly canonicalSerialization: string;
  };
  readonly evidenceManifestSha256: string;
  readonly canonicalPayloadSha256: string;
  readonly jobDigest: string;
}

interface AdaptationTransactionEvidence {
  readonly txHash: string;
  readonly block: { number: number; hash: string };
  readonly transactionIndex: number;
  readonly txEnvelopeSha256: string;
  readonly receipt: EvidenceBlobRef;
  readonly trace: EvidenceBlobRef;
  readonly codeEvidence: readonly EvidenceBlobRef[];
  readonly observations: readonly AdaptationObservationEvidence[];
}

interface AdaptationObservationEvidence {
  readonly observationId: string;
  readonly clusterId: string;
  readonly txHash: string;
  readonly source: {
    readonly number: number;
    readonly hash: string;
    readonly generation: number;
  };
  readonly locus:
    | { readonly kind: "outer-call" }
    | { readonly kind: "internal-call"; readonly tracePath: readonly number[] }
    | { readonly kind: "log"; readonly logIndex: number };
  readonly address: string;
  readonly selector: string | null;
  readonly topic0: string | null;
  readonly dataSha256: string;
  readonly rawEvidenceSha256: string;
}

interface EvidenceBlobRef {
  readonly kind: "transaction" | "receipt" | "trace" | "runtime-code" |
    "implementation-code" | "state-proof" | "identity-proof";
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentAddress: string;
}
```

### 7.3 sealing invariants

job sealer 是 protected framework producer，并强制：

- `transactions` 非空，且至少一笔真实 canonical 成功交易；
- 每个 observation 都能反向定位 tx + logIndex/tracePath；
- receipt、trace、code/state evidence 都有内容 digest；
- positives、negatives、unresolved 独立分组，不能由 candidate 重标；
- 所有 cluster-owned observation 共享单一 family cluster invariant；
- evidence manifest 覆盖每个 blob，manifest digest 覆盖稳定排序后的 refs；
- canonical payload 使用版本化 canonical serialization；
- `jobDigest = sha256(schema + canonical payload + evidence manifest)`；
- 任一 blob、label、canonical hash、producer version 或 serialization 变化都会改变 job digest；
- reorg、hash mismatch 或 evidence 缺失使 job invalid，不得降级继续。

一笔真实交易足以启动 adaptation；更长监听窗口用于扩充 action/direction/instance coverage，而不是开始工作的前置条件。

---

## 8. Family classification 与 family-owned 实现合同

### 8.1 new family、extend family、unresolved

候选实现前必须先分类：

- 链上 identity 可归属已有 family，但 production surface 缺失：`extend-family`；
- 所有已有 family 都给出可复核的确定性 identity rejection：`new-family`；
- 仍有 retryable、证据不足或 identity 冲突：`unresolved`，禁止写 adapter 以赌结果。

### 8.2 复用现有 master contract

实现必须落入现有 `adapter-family-plugin.ts` capability：

```text
manifest
capture
discovery
identity
instance
routes / projectGraph
pricing
exact
execution
actionAdapters
swap | protocol | credit
```

不得创建第二个 family abstraction 或在中央 catalog/runtime 添加协议分支。

### 8.3 discovery 与 identity

discovery 负责粗召回，可以用 selector、topic、observed call、landed log、factory range 或 address surface。identity 才负责 admission。

identity 必须来自可重放的链上证明，例如：

- runtime/implementation code 和 proxy relation；
- factory reverse lookup、registry membership 或 immutable relation；
- 标准 view/state relation；
- active effect-delta simulation；
- 真实 tx receipt/trace 特征与当前链上重验的组合。

硬编码 infrastructure singleton、registry、vault、oracle 或 token constant 可以作为 identity source；硬编码实例地址集合不能作为 admission gate。selector/topic 命中也不能直接 admitted。

### 8.4 routes、exact 与 execution

family 的 `projectGraph()` 只声明 family facts，中央 `projectFamilyRouteGraph()` 签发 canonical edge。family code 不得直接构造 `TokenEdge` 并把它作为入图证明。

exact evidence 必须绑定：

```text
family + route handle + direction + amountIn + amountOut
+ source/generation + binding fingerprint + runtime evidence digest
```

execution 必须拒绝 route、direction、amount、binding 或 generation 不匹配的 exact evidence。candidate 单元测试只能证明局部 contract，不能替代 central exact 和 actual finalSim。

### 8.5 family-local 写边界

一次 adaptation 只影响一个 owner。典型 protocol family 允许的手写 runtime surface 是：

```text
listener/src/searcher/venues/protocols/<slug>-family/*
listener/src/searcher/venues/production-families/<slug>.production.ts
listener/src/searcher/test/<slug>-family-plugin.ts
listener/src/searcher/test/fixtures/adapter-families/<slug>-*.json
family-specific docs/evidence
```

candidate 禁止修改：

```text
adapter-family-plugin.ts
family-capability-catalog.ts
adapter-family-runtime.ts
adapter-family-graph-runtime.ts
strict-family-lifecycle-runner.ts
trusted G1/G2 producers
job sealer / label oracle / receipt authenticator
six-step evidence producer / judge
family boundary evaluator
```

需要中央能力时状态转为 `framework-blocked`，由独立 framework change 修复并验证后重新开始 family-local run。

---

## 9. Trusted G1：真实 S1 materialized Graph 证明

### 9.1 要证明的事实

G1 必须证明真实 tx observation 经完整 production composition 到达当前 executable Graph：

```text
sealed raw observation
→ catalog match
→ decode candidate
→ chain-derived identity
→ instance
→ routes
→ lifecycle-issued route handles
→ central graph projection/materialization
→ immutable Graph snapshot
```

不能接受 synthetic `projectGraph()`、fixture `TokenEdge`、旧 cache edge、candidate 自报 receipt 或只检查 routes 数量。

### 9.2 trusted producer

G1 producer 必须位于 protected framework，加载 exact candidate commit 的 family runtime，但自身代码和配置必须匹配 trusted producer allowlist。它从已经 materialized 的 Graph snapshot 读取结果，不在 gate 内重建第二份“看起来一样”的 Graph。

Graph snapshot、catalog root、canonical source 和 generation 必须来自同一 committed runtime envelope。若它们当前不能原子读取，G1 为 unresolved；禁止先读 checkpoint、后读内存 catalog 再拼 receipt。

### 9.3 receipt

```ts
interface FreshFamilyGraphReceipt {
  readonly schemaVersion: 2;
  readonly producer: TrustedProducerIdentity;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly jobDigest: string;
  readonly familyId: string;
  readonly familyDefinitionSha256: string;
  readonly source: {
    readonly number: number;
    readonly hash: string;
    readonly generation: number;
  };
  readonly catalogRootSha256: string;
  readonly materializedGraphRootSha256: string;
  readonly graphEnvelopeSha256: string;
  readonly observedTxHashes: readonly string[];
  readonly admittedSurfaces: readonly {
    readonly surfaceId: string;
    readonly instanceKey: string;
    readonly routeKey: string;
    readonly canonicalEdgeId: string;
    readonly actionAdapterId: string;
    readonly target: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
  }[];
  readonly receiptSha256: string;
  readonly verdict: "pass";
}
```

authenticator 必须重算 receipt digest，并验证 candidate commit、job、family definition、source hash、catalog root 和 Graph root 之间的绑定。

---

## 10. Trusted G2：central exact 与 actual finalSim 一致

### 10.1 actual amount 的独立来源

G2 的 actual `amountIn/amountOut` 必须来自同一次 fork finalSim 交易的可信观测：

- transaction receipt 和完整 call trace；
- 中央 executor 的 route call boundary；
- route boundary 前后的 token/native balance effect delta；
- 可独立归属的 transfer/log effects。

candidate-owned `capture()`、`action`、`expectedEffects()`、solver `hop_amounts` 和 plan 预计输出只能协助标注 route，不能提供 actual amount。否则 exact 和 witness 会共享同一 candidate bug，交叉证明失效。

对于无法从独立 trace/receipt/effect delta 唯一归属的 hop，G2 返回 unresolved；不能复制 quoted amount 代替实际值。native token、fee-on-transfer、rebasing 等特殊规则必须来自 protected shared witness semantics，而不是由被审 family 临时声明。

### 10.2 同一 state anchor

可信 producer 必须把每个 hop 绑定到其真实 pre-hop state。第一 hop 可以使用 canonical fork anchor；后续 hop 若受到前缀状态变更影响，必须在同一 fork 上 replay prefix 或使用可信 snapshot/overlay 后调用中央 exact。

如果当前 runtime 无法重建同一 pre-hop state，该 surface 的 G2 是 unresolved。换到更方便的 base state 不算通过。

### 10.3 central exact

反查必须走现有中央入口 `executeFamilyExactQuote()`，并使用同一：

```text
family route handle
direction
actual amountIn
source number/hash/generation
binding fingerprint
pre-hop runtime state/evidence
```

默认要求 integer exact equality。只有 protected shared semantic contract 已经定义、且 receipt 明确绑定的 protocol rounding rule 才能使用 tolerance；candidate 不得在 adaptation 时新增或放宽中央 tolerance。

### 10.4 receipt

```ts
interface ExactFinalSimConsistencyReceipt {
  readonly schemaVersion: 2;
  readonly producer: TrustedProducerIdentity;
  readonly candidateCommit: string;
  readonly jobDigest: string;
  readonly familyId: string;
  readonly source: {
    readonly number: number;
    readonly hash: string;
    readonly generation: number;
  };
  readonly finalSim: {
    readonly txHash: string;
    readonly receiptSha256: string;
    readonly traceSha256: string;
    readonly stateAnchorSha256: string;
    readonly routeCallPathSha256: string;
    readonly prePostEffectDeltaSha256: string;
  };
  readonly legs: readonly {
    readonly surfaceId: string;
    readonly canonicalEdgeId: string;
    readonly routeKey: string;
    readonly direction: string;
    readonly bindingFingerprint: string;
    readonly amountIn: string;
    readonly actualAmountOut: string;
    readonly exactAmountOut: string;
    readonly exactOutcomeSha256: string;
    readonly equalityRuleId: string;
  }[];
  readonly receiptSha256: string;
  readonly verdict: "pass";
}
```

G2 authenticator 验证 finalSim tx、receipt/trace hashes、route call path、effect delta、central exact outcome、source/generation 和 candidate commit 全部属于同一次证据链。

---

## 11. 接入 existing six-step judge

`evaluateSixStepJudgment()` 明确是纯 judgment，信任输入已经 preauthenticated；当前 CLI 读取任意 JSON 并不能自行建立这个信任。因此 production promotion 前必须增加认证 wrapper，而不是让 candidate 直接把 JSON 交给 judge。

认证流程：

```text
raw receipt package
→ verify trusted producer identity/source digest
→ recompute every content digest
→ verify job/candidate/source/family/surface bindings
→ verify G1 + G2 + native family_execution receipts
→ emit AuthenticatedAdapterMergeEnvelope
→ evaluateSixStepJudgment()
```

```ts
interface AuthenticatedAdapterMergeEnvelope {
  readonly schema_version: 2;
  readonly gate: "six-step-judgment";
  readonly trust_boundary: "authenticated-receipt-envelope";
  readonly claim: "adapter_merge";
  readonly job_digest: string;
  readonly candidate_commit: string;
  readonly promotion_receipt: unknown;
  readonly promotion_receipt_sha256: string;
  readonly family_boundary: unknown;
  readonly fresh_family_graph_receipt: FreshFamilyGraphReceipt;
  readonly exact_final_sim_receipt: ExactFinalSimConsistencyReceipt;
  readonly production_surface_closure: ProductionSurfaceClosureReceipt;
  readonly authentication_manifest_sha256: string;
}
```

judge 继续保持：

```text
no RPC
no simulation
no quote
no edge generation
no Git mutation
no code repair
```

它只验证已认证 receipts 对同一 job、family、source、surface 和 commit 的逻辑绑定。不要创建 `validate-new-family.sh` 或第二个 promotion judge。

---

## 12. 完整 production surface closure

### 12.1 不能用“一条 edge + 一笔 tx”代表 family 完成

promotion 必须从 candidate manifest、catalog-issued route handles、action adapters、exact methods 和 execution bindings 派生 production-reachable surface：

```ts
interface FamilyProductionSurface {
  readonly surfaceId: string;
  readonly identityVariantId: string;
  readonly routeKey: string;
  readonly actionId: string;
  readonly direction: string;
  readonly exactMethod: string;
  readonly executionBinding: string;
  readonly reachability: "production-enabled" | "explicitly-disabled";
  readonly disableReasonCode?: string;
}
```

这不是盲目做笛卡尔积；由 manifest 和 route/action binding 明确声明合法组合，再由 central catalog/runtime 重算。candidate 不能通过漏声明 surface 来回避验证：production entry、action catalog、route handles 和 static capability artifact 的联合闭包必须一致。

### 12.2 closure 规则

每个 `production-enabled` surface 必须具备：

- 至少一个 chain-derived identity positive；
- 对应 G1 central-issued edge；
- 对应 central exact 和 execution binding；
- 对应 actual finalSim G2 leg；
- 对应 native `family_execution` six-step result；
- direction、action、binding 和 source/generation 一致。

未验证的 surface 只能：

- 从 production manifest 中明确禁用，并给出稳定 reason code；或
- 阻止 promotion。

不能把未覆盖 surface 默认为已验证，也不能用某个 identity variant 的成功推导全部 variants 完整。

### 12.3 closure receipt

```ts
interface ProductionSurfaceClosureReceipt {
  readonly schemaVersion: 1;
  readonly candidateCommit: string;
  readonly familyId: string;
  readonly familyManifestSha256: string;
  readonly generatedCapabilitySha256: string;
  readonly declaredSurfaces: readonly FamilyProductionSurface[];
  readonly verifiedSurfaceIds: readonly string[];
  readonly disabledSurfaceIds: readonly string[];
  readonly missingSurfaceIds: readonly string[];
  readonly closureSha256: string;
  readonly verdict: "pass";
}
```

`missingSurfaceIds` 非空时不能产生 pass receipt。

---

## 13. Positive / negative / unresolved oracle

### 13.1 三态标签

held-out oracle 必须由 candidate 之外的 evidence producer生成：

- **positive**：有独立链上证明属于同一 family；同 implementation/factory/registry family 的其他实例通常是 held-out positive。
- **negative**：有独立证据证明 identity 不同，即使 selector/topic 相同也不属于该 family。
- **unresolved**：证据不足、RPC retryable、proxy relation 不明或存在冲突，不能冒充 negative。

“附近未知地址”不是天然 negative。“same implementation family 的其他实例”更不能列成 negative。

```ts
interface LabelledFamilyExample {
  readonly exampleId: string;
  readonly label: "positive" | "negative" | "unresolved";
  readonly txHash?: string;
  readonly address: string;
  readonly source: { number: number; hash: string; generation: number };
  readonly independentProofRefs: readonly EvidenceBlobRef[];
  readonly labelProducer: TrustedProducerIdentity;
  readonly labelSha256: string;
}
```

### 13.2 单调性

“negative 只增不删”只适用于已经认证且 canonical evidence 仍有效的标签。reorg、proof corruption 或 label producer bug 必须通过显式 invalidation/tombstone 撤销，不能静默改写。

candidate retry 不得删除 positive/negative、把 unresolved 改成 negative，或降低 identity fail-closed 程度。若 oracle 本身有 framework bug，进入独立 framework lane。

---

## 14. Generated activation 与 `family_local` boundary

新 `.production.ts` 要进入 loader，必须机械更新：

```text
listener/src/searcher/generated/production-family-entries.generated.ts
listener/src/searcher/generated/family-capability-shadow.generated.json
```

当前 boundary 将这些非 family-owned runtime paths 归为 framework，导致“只能改 family files”和“必须激活 generated loader”互相死锁。正式方案是在启用自动 adaptation 前，一次性扩展 generic boundary：允许这两个文件作为 **mechanical generated closure**，不计为第二 family owner。

允许条件必须全部满足：

1. 生成器固定为 `build-family-capability-manifest.ts`，candidate 不得修改生成器或参数语义。
2. 输入只来自 candidate commit 的 production entry set、family source closure 和固定配置。
3. 在 clean worktree 上重跑固定 `--write` 后，再跑 `--check`，产物 byte-for-byte 一致。
4. static import semantic diff 只允许加入/更新 impacted family entry；不能删除、替换或重排其他 family 的语义。
5. capability artifact 对 unaffected families 的 normalized records 与 baseline 完全相同。
6. boundary receipt 绑定 generator source digest、input closure digest、两个 generated artifact digest 和 candidate commit。
7. 手工编辑 generated file、修改 generator、出现第二 owner 或不可重算时，classification 必须是 `framework`。

因此 family candidate commit 可以包含：一个 family owner、它的 production entry、family-local tests/evidence，以及上述两份可信生成器可重算的机械产物。生成产物是 activation closure，不是第二 family owner。

---

## 15. Durable adaptation state machine

### 15.1 状态

```ts
type AdaptationState =
  | "raw-captured"
  | "evidence-complete"
  | "clustered"
  | "job-sealed"
  | "classified"
  | "candidate-committed"
  | "family-local-verified"
  | "activation-generated"
  | "s1-graph-proven"
  | "exact-final-sim-proven"
  | "six-step-proven"
  | "regression-proven"
  | "promotion-ready"
  | "deterministically-rejected"
  | "evidence-insufficient"
  | "retryable"
  | "framework-blocked"
  | "invalidated";
```

状态存储使用 append-only transition log + compare-and-swap：每次 transition 绑定 previous state digest、job digest、candidate commit、receipt digests 和 actor/producer identity。不得靠目录是否存在或最后一条控制台日志推断状态。

### 15.2 invalidation

- family source、production entry 或 generated artifact 变化：旧 G1、G2、six-step、closure 和 regression receipts 全部失效，回到 `candidate-committed`。
- job/evidence/label 变化：candidate 及全部下游证据失效，回到 `job-sealed` 或 `invalidated`。
- source reorg/hash mismatch：job 和所有 source-bound receipt 失效。
- trusted producer version变化：由其生成的 receipts 失效。
- crash 发生在 transition commit 前：重启后仍停留前一 durable state；不得推测下一状态已成功。

### 15.3 terminal barrier

每个状态必须有机器可读的 outcome 和 reason code。错误字符串只用于诊断，不承担控制流。一个 family 失败后不得吞错并发布其余 subset 再声称该 adaptation transaction complete；允许 partial diagnostic，但 promotion barrier 必须看到完整 declared closure。

---

## 16. Framework 落地顺序与合同测试

以下顺序先关闭 trust boundary，再启用自动 family 生成。每一阶段都必须以合同测试和 listener 完整 build 收口。

### 16.1 Raw intake 与 journal

实现 raw competitor ingress、WAL/transaction commit、capture coverage 和 reorg tombstone。

必须测试：

- 完全未知 topic/selector 仍被采集；
- receipt、outer call、internal calls 保留 locus；
- crash/partial tail 恢复；
- fsync/commit 前 cursor 不推进；
- queue/disk failure 使 coverage incomplete；
- canonical hash mismatch fail-closed；
- reorg 追加 tombstone 并重采集。

### 16.2 Typed lifecycle 与 sealed job

把 lifecycle caller 从 throw/catch 字符串改为 typed outcomes 和 tx-level barrier；实现 clusterer、label oracle、evidence manifest 和 job sealer。

必须测试：

- all deterministic rejection 才能产生 `no-verified-family`；
- 任一 retryable/unresolved 阻止错误建新 family；
- 多协议交易拆成多个单 owner jobs；
- observation 保留 tx/logIndex/tracePath 关联；
- canonical serialization 稳定；
- 任一 evidence byte、label 或 block hash 变化使 job digest 变化；
- tampered/missing blob 无法 seal。

### 16.3 Trusted evidence producers

实现 G1 materialized Graph producer、G2 independent finalSim witness 和 receipt authenticator。

必须测试：

- candidate 手写或篡改 G1/G2 JSON 被拒；
- G1 绑定 Graph/catalog roots、source/generation 和 candidate commit；
- Graph/checkpoint 非原子或 hash mismatch 返回 unresolved/fail；
- 修改 candidate `expectedEffects()` 不改变 actual amount extractor；
- solver quoted amount 与 actual trace delta 不同时 G2 失败；
- pre-hop state 无法重建时不允许换 anchor；
- candidate commit 变化使旧 receipt 失效。

### 16.4 Surface closure 与 generated boundary

实现 central surface derivation、closure receipt 和 mechanical-generated boundary exception。

必须测试：

- 少一个 direction/action/binding 即阻止 promotion；
- explicitly disabled surface 不进入 production reachability；
- candidate 漏写 manifest 但 loader/action catalog 可达时仍被发现；
- generated artifacts 手改、生成器变化或 unaffected family drift 被拒；
- clean regeneration + `--check` 通过且只影响一个 owner。

### 16.5 Orchestrator 与完整验收

最后实现 durable adaptation state machine、认证 wrapper 和 existing judge integration。

必须测试：

- crash 后从 durable state 恢复且不跳步；
- source/job/candidate/producer 变化正确 invalidation；
- arbitrary JSON 不能直接取得 production judgment；
- G1、G2、family_execution、boundary、closure 均绑定同一 job/commit/source；
- full listener build、capability manifest check、family-local tests、ownership/import closure 和 S1 regression 全部通过。

---

## 17. Definition of Done

### 17.1 Framework 完成

只有同时满足下列条件，unknown-family auto-adaptation framework 才算实现完成：

- watchlist 成功交易在已知 filter 前完整进入 durable raw intake；
- raw capture coverage 可证明、可恢复、可 reorg invalidation，cursor 不提前；
- novelty 使用 typed terminal outcomes，不解析错误字符串；
- sealed job 保持 evidence 关联、独立三态标签、单 family cluster 和全内容 digest；
- candidate 不能修改 trusted producer/judge/boundary；
- G1 由可信 producer 绑定 executable Graph snapshot、catalog root、source/generation 和 commit；
- G2 actual amount 独立来自同一 finalSim trace/receipt/effect delta；
- receipt authenticator 建立 existing judge 所需的 preauthenticated boundary；
- promotion 覆盖完整 production-reachable surface；
- generated activation 与 family-local boundary 不再死锁；
- durable state machine 可在 crash、reorg、source/candidate 变化后正确恢复/失效；
- 所有合同测试与 listener 完整 build 通过。

### 17.2 单个 family 完成

一个新 family 或 extension 只有同时具备以下证据才是 `promotion-ready`：

```text
sealed real-tx job
+ chain-derived identity positives and certified negatives/unresolved
+ exactly one family owner
+ reproducible generated activation artifacts
+ full surface closure
+ trusted G1 Graph receipt
+ trusted G2 exact/finalSim receipt
+ native family_execution six-step receipt
+ authenticated existing judge adapter_merge_ready=true
+ build / manifest / held-out / ownership / S1 regression pass
+ every receipt bound to the exact candidate commit
```

`implemented`、unit/shadow pass、synthetic edge、fixture parity 或单次 finalSim 都不是 production cutover。merge 后仍需按统一架构的部署与最新精确 commit 验收流程取得独立运行证据；本文不授权部署、签名或广播。

---

## 18. Family Plugin Adaptation 执行规程（内嵌）

本章把原先独立 skill 的执行内容并入架构文档。它是 candidate code producer 的操作规程，不是 promotion authority；不得另外维护一份可能漂移的 `family-plugin-adaptation-SKILL.md`。

### 18.1 适用时机

使用本规程处理一个已经 sealed 的 `FamilyAdaptationJob`：

- 新增一个未知 family；
- 扩展已知 family 的新 action、route、direction 或 binding；
- 把真实未知 venue 变成可路由、可 exact、可执行的 production candidate。

只分析不落地、只修已有 family 的实例 bug、或尚无 sealed job 时，不进入本规程。

### 18.2 不可协商的边界

- 只接受真实 canonical tx evidence；synthetic observation 只能做补充单测。
- 一次只修改一个 family owner和它的可重算 generated activation closure。
- 不改 central catalog、Graph、runtime、trusted producers、authenticator、judge 或 boundary。
- 不使用实例地址 allowlist 作为 identity admission。
- 不删除已认证 held-out labels，不把 unresolved 伪装成 negative。
- 不放宽 identity、exact/sim tolerance、six-step 或 regression gate。
- transient infrastructure failure 只重试，不改 family semantics。
- framework 能力不足时标记 `framework-blocked`，停止 family-local promotion。
- build/unit pass、synthetic edge 或 candidate 自报 receipt 都不代表完成。

### 18.3 必需输入

开始前验证 job 至少包含：

```text
chainId
competitor
jobDigest and evidenceManifestSha256
one-family clusterId and invariant
one or more canonical successful tx hashes
block number/hash and source generation
per-observation tx/logIndex/tracePath linkage
receipt/trace/code/state evidence content digests
independently labelled positives/negatives/unresolved
producer/version/canonical serialization
```

缺任一强制字段、digest 无法重算或 canonical hash 不匹配，返回 `evidence-insufficient`/`invalidated`，不开始写代码。

### 18.4 执行步骤

1. **重验 sealed evidence。** 重算 job/evidence manifest，复核 canonical block、tx、receipt、trace、code/state refs 和 label producer。

2. **分类。** 以链上 identity 判断 `extend-family`、`new-family` 或 `unresolved`；不能从 timeout 创建 family。

3. **选择 domain。** 使用现有 `adapter-family-plugin.ts` master contract；最近似 family 只作为结构参考，不复制它的地址表或特殊中央分支。

4. **先实现 discovery + identity。** discovery 可以高召回；identity 必须 chain-derived，拒绝 selector/topic collision 和无关合约。

5. **实现 instance + routes。** descriptor 来自 verified identity；`projectGraph()` 只声明 family facts，不直接创建 `TokenEdge`。

6. **声明完整 production surface。** 枚举每个 identity variant、route/action、direction、exact method 和 execution binding 的合法组合；未实现项明确 disabled，不能隐式遗漏。

7. **实现 pricing + exact。** exact evidence 绑定 route、direction、amount、source/generation、binding 和 runtime evidence。

8. **实现 execution/action/capture。** execution 必须拒绝不兼容 exact evidence。`capture/expectedEffects` 只属于 candidate semantics，不能成为 G2 actual amount authority。

9. **生成 activation closure。** 使用固定 manifest builder 生成两个 artifacts；clean regeneration 和 `--check` 必须 byte-for-byte 一致，unaffected family semantic closure 不变。

10. **提交 candidate commit。** receipts 必须绑定 commit，因此先形成可验证的 exact candidate SHA；后续源码变化会强制重新提交和重跑证据。

11. **由 trusted G1 producer 证明 S1 Graph。** 使用 sealed real observations 跑 strict lifecycle 和 central materialized Graph，覆盖所有 production-enabled surfaces。

12. **跑 native family execution。** 使用现有 production/fork path 和 `family_execution` six-step evidence；fixture 不得注入 admitted identity、quote、plan、amount 或 calldata。

13. **由 trusted G2 producer 做 exact ↔ finalSim。** 从同一次 finalSim 的 trace/receipt/effect delta 读取 actual amounts，在相同 pre-hop state 上调用 `executeFamilyExactQuote()`。

14. **认证并调用 existing judge。** receipt authenticator 先验证 producer、digests 和同一 job/commit/source/surface binding，再要求 `evaluateSixStepJudgment(...).adapter_merge_ready === true`。

15. **跑系统回归。** listener 完整 build、family capability manifest check、family-local positives/negatives/unresolved tests、S1 regression、ownership/import closure 全部通过。

16. **形成 promotion-ready receipt。** 只有 surface closure 无缺口、所有 receipts 绑定当前 commit 且状态机到达 `regression-proven` 时，才转换为 `promotion-ready`。

### 18.5 family-owned implementation shape

protocol family 通常拥有：

```text
listener/src/searcher/venues/protocols/<slug>-family/
  abi.ts
  action.ts
  binding.ts
  capture.ts
  discovery.ts
  exact.ts
  execution.ts
  identity.ts
  instance.ts
  manifest.ts
  pricing.ts
  protocol.ts
  routes.ts
  types.ts
listener/src/searcher/venues/production-families/<slug>.production.ts
listener/src/searcher/test/<slug>-family-plugin.ts
listener/src/searcher/test/fixtures/adapter-families/<slug>-*.json
```

swap/credit domain 使用对应 family 结构。generated activation 文件只能由固定生成器机械产生，不能手写。

### 18.6 失败分类与动作

```text
family-bug
  → 只修改 family-owned implementation；提交新 candidate；重跑全部下游 receipts。

evidence-insufficient
  → 从同一监听窗口补 receipt/trace/code/state 或新增真实 tx；重新 seal job。

retryable
  → 不改变 family semantics；按 reason code 重试。

framework-blocked
  → 停止 family-local run；单独修通用 framework 并验证，再从有效 job 重启。

deterministically-rejected
  → 保留证据和 reason code；不创建或推广该 family candidate。

invalidated
  → reorg、hash/digest mismatch 或 trusted producer 变化；废弃所有下游 receipts 并回到合法前置状态。
```

普通测试失败不是停点：读取精确失败，归类后继续在允许边界内修复。任何通过删除 labels、放宽 gate、绕过 identity、复制 expected amount 或修改 trusted producer 得到的“pass”都无效。

### 18.7 输出与 promotion gate

一次执行必须输出：

- exact candidate commit；
- family owner 和 family definition digest；
- generated activation digests；
- G1、G2、family_execution、surface closure、boundary 和 regression receipt digests；
- authentication manifest digest；
- durable final state 和 reason code；
- 尚未覆盖或明确 disabled 的 surfaces。

只有下列条件全部为真才能标记 `promotion-ready`：

```text
sealed job valid
family boundary == family_local with one owner
generated activation reproducible
production surface closure == pass
trusted fresh S1 Graph receipt == pass
trusted exact ↔ actual finalSim receipt == pass
existing family_execution six-step == pass
authenticated existing judge adapter_merge_ready == true
build + manifest + labels + S1 regression + ownership closure == pass
all receipts bind the exact candidate commit
```

任何 partial result 都保持它的真实状态，不得解释成 production-ready 或 cutover。
