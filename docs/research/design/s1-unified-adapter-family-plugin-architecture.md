# S1 统一 Adapter Family 插件架构（Strict-only 终态合同）

> 状态：strict-only runtime 的 canonical 最终合同。
>
> 本文只描述唯一允许存在的最终运行时，不是迁移路线、shadow 对比计划、fixture 计划或历史
> checkpoint 汇编。
>
> 本次重写的事实锚点是
> 5f104cedd4b4778316c177ce4fa08a6761af85b1。该 SHA 只记录重写时实际审阅的代码状态，
> 不是部署、live、F5、100/100 或 S1 完成声明；后续实现和验收必须绑定各自新的 exact SHA。
>
> 后续实现和验收分别绑定各自的 exact SHA：硬切换（旧 Graph/runtime 物理删除，
> b54730b8/-17k lines、0b58021f、49890a0f、6764e6f1）、50 块窗口（cc207326）、2 天窗口与流式
> 观察哈希（9fb5864b）、univ4 retain channel 与 archive Initialize 反查（0aa7582d..b55a1631）、
> duplicate-instance 与流式 checkpoint（efc6df7f/2aab991a/3ae1e427）、funding token universe
> 固化表（692c7bd7..5fc974ab）。当前 edge/candidate observation 窗口为 14400 blocks（2 天）；
> 不再存在 7 天 dormancy scan。新实例只由最近 2 天的链上 discovery 发现；所有既有 verified
> memo 通过其 fingerprint-bound `candidateSnapshot` 永久带回候选分区，且只有明确的
> `terminal-rejected` 原子撤销该 memo。memo snapshot 只是提名与复用材料，不是第二准入权威，
> 也不能扩张 2 天 source coverage。
> touched-driven 当前定价（只刷新本块触及 venue，快照容忍未触及 edge 并以 degraded 发布）：
> 7a0d5c5a、b56091a5、b6a2711f、f7be24cb、2672cbe2、56e32e96；funding 面收敛到固化 universe
> （45a01264）；exact session 只重发触及实例（e79768ad）且按 coarse 块 touched 作用域
> （b8d4e664）。
>
> 最终验收绑定 exact SHA **496545fbdfbc67d8139a1dac305bed3f17432291**（§16.8）。

## 0. 第一要义：事实验收，直接硬切

S1 的第一要义是：

> **要事实验收；不要人工写测试脚本来定义成功；不要走迁移路线。先一次性物理删除旧 authority，
> 直接写成唯一 strict-only 管线。完整 commit 推送后部署 exact SHA dry-run，再沿真实 live 对象
> lineage 找到第一个断点并修 production。capture/parity/shadow harness、人工 fixture 和自报 pass
> 字符串永远不能代替生产事实。**

这条原则有四个直接后果：

1. **事实高于辅助脚本。** 真相来自已部署生产进程实际签发的 canonical source、candidate、Family
   decision、publication、readyGeneration、Graph edge、exact handle、execution program 和 final
   simulation。工具可以收集、重算或核验这些 immutable object，但不能制造它们，也不能填补缺失阶段。
2. **先删，再闭合真实编译缺口。** 旧 Graph/runtime authority 在一个连续工作批次内整体删除。编译
   错误只用于定位：consumer 应直接消费 strict readyGeneration/current-source authority，还是已经
   失去意义并应删除。绝不能为了让旧测试可编译而恢复 builder。
3. **只有一个可部署状态。** 只要旧 topology source、fallback、consumer switch 或 legacy-shaped
   authority facade 仍然 load-bearing，就不存在可部署 SHA。删除、strict 接线、完整 build、canonical
   更新和 source closure 必须组成一个 hard-cutover commit。
4. **Live 按数据链定位，不按 harness 绕圈。** exact-SHA dry-run 部署后，寻找最早缺失或矛盾的 lineage
   transition，修那个 production transition。脚本若与 immutable production object 冲突，先诊断并修
   脚本；不得让正确 production authority 迁就错误 fixture。

这条原则不降低安全标准。exact-SHA、systemd binding、dry-run、wallet/EV gate、签名授权和广播授权仍是
硬边界。脚本缺陷绝不构成绕过安全门的权限。

## 1. Definition of the final runtime

The only startup and runtime chain is:

~~~text
fixed-cutoff startup discovery
→ durable Family+Instance attestation
→ atomic readyGeneration(Graph + catalog + coverage + cutoff)
→ producer creation
→ backrun and blockscan consume the same frozen GraphView
→ current-source strict state and exact
→ strict request and execution program
→ mandatory final simulation
~~~

There is no second Graph, runtime registry, mutable pool topology, live-discovery publisher, secondary edge
merge, default edge, legacy quoter, legacy exact path, legacy execution path, or strict/legacy switch.

### 1.1 Runtime invariants

1. A producer cannot be created without a valid readyGeneration.
2. A producer generation cannot run discovery, backfill, protocol-trace discovery, topology publication, or
   Graph generation changes.
3. Backrun and blockscan consume the same Graph root and catalog root.
4. A raw universe row, PoolEntry, candidate journal entry, cache row, or observed transaction cannot create
   an edge. Only a current Family publication admitted by readyGeneration can create an edge.
5. Current state, exact, execution, and final simulation bind the same generation, route binding, and
   canonical source lineage.
6. Unknown or unowned execution nodes fail closed. There is no skip sentinel.
7. Candidate and source omissions are explicit. A missing row is never interpreted as a negative proof.
8. The central runtime contains no Family name, protocol address, protocol ABI, protocol selector/topic
   meaning, storage layout, or protocol math.

### 1.2 Durable incomplete state versus ready authority

Discovery coverage and attestation completeness are separate facts.

- sourceCoverage.appliedThrough == cutoff proves the declared source range was consumed.
- It does not prove that every nominated instance verified.
- A durable `inProgressRun` contains the fixed candidate partition and every outcome completed so far.
  `verified`, `terminal-rejected`, and `retryable` are all accounted outcomes; a candidate with no outcome is
  the only pending/unaccounted state.
- Completion is `remainingUnaccounted = candidateCount - accountedCandidateCount = 0`. It is not
  `retryableCount = 0`.
- Only verified publications enter a candidate Graph/catalog snapshot. Retryable and pending candidates never
  enter Graph.
- Once the partition is fully accounted, promotion atomically publishes the verified-only generation, moves
  retryables to the independent durable probe queue, and clears `inProgressRun`. A queued retryable therefore
  does not pin startup forever to an already-completed historical cutoff.
- Final S1 acceptance requires no silent missing candidate and `remainingUnaccounted=0`; queued retryables are
  disclosed separately and never represented as verified coverage. Funding and Credit may have no live
  instance only with explicit capability and absence evidence.

Single-pool probe and checkpoint inspection expose Family failures without discarding already verified work
or falsely claiming that a verified subset is the complete universe. Live begins only after the partition is
complete.

## 2. Authority boundaries

### 2.1 Central kernel responsibilities

The central kernel owns only protocol-independent mechanics and safety:

- fixed canonical number/hash and generation fencing;
- startup scheduling, batching, dedupe, deadlines, abort, backpressure, and resource budgets;
- generic RPC, eth_call, log query, storage read, and strict simulation transport;
- durable single-writer checkpointing and compare-and-swap;
- source coverage accounting and exact candidate partition accounting;
- issued-object validation, canonical encoding, content hashing, and authority fingerprints;
- stable route taxonomy: Swap, Protocol, Funding, Credit;
- generic path enumeration, budget clipping, and opaque solver-choice scheduling;
- standing-position, conservation, repayment, final-simulation, and EV gates;
- generated catalog integrity and exact action ownership;
- exact-SHA/runtime/PID/process-start/log-inode lineage.

The central kernel may understand an EVM primitive. It must not understand why one protocol uses that
primitive.

### 2.2 Family plugin responsibilities

Each Family plugin owns all protocol meaning:

- discovery topics, selectors, address surfaces, candidate decoding, and instance nomination key;
- reverse-verified identity and chain-proven rejection rules;
- descriptor materialization and route projection;
- protocol ABI, storage layout, token ordering, pool key, fee model, and math;
- current-state request program, decoding, pricing, and sizing;
- victim observation, transition, mutation, or replay;
- protocol-specific solver choices;
- exact quote semantics;
- execution action ownership and encoding;
- Family-specific caller mode and effect-observation scope;
- any infrastructure singleton used as a proof source, never as an instance allowlist.

### 2.3 The extension test

A new Family that the central code has never seen must require changes only in:

1. its plugin directory;
2. generated catalog artifacts;
3. plugin-local semantic tests.

It must not require a source edit in production composition, startup, Graph, state, scanner, solver, victim
handling, compiler, or the acceptance reader. If it does, the central contract is not generic enough.

### 2.4 True generality versus disguised single-Family logic

These are valid central primitives even if one Family first required them:

- caller execution mode;
- an exact token/account observation pair;
- returned, reverted, transportFailure, and invalidProgram outcomes;
- a generic storage mutation operation;
- a canonical log query and byte extractor;
- an opaque solver choice;
- source, generation, deadline, and budget.

These belong to plugins:

- which caller mode Astra requires;
- which four balances Astra observes;
- where V2/V3/V4 state is stored;
- how Curve, V3, or V4 math works;
- which Fluid debt ratios to explore;
- how a Metronome price effect is measured;
- what Angstrom evidence activates a route;
- where a protocol encodes an instance id in a log.

## 3. Generated catalog and Family contract

Production composition reads one build-generated exact catalog. It does not handwrite a list of Family ids,
adapter ids, actors, topics, or expected counts.

~~~ts
interface GeneratedFamilyCatalog {
  readonly schema: "generated-family-catalog:v1";
  readonly entries: readonly GeneratedFamilyEntry[];
  readonly familySetRoot: Hash;
  readonly actionOwnerRoot: Hash;
  readonly verifiedActorRoot: Hash;
  readonly contentHash: Hash;

  require(familyId: FamilyId): FamilyPlugin;
  ownerOf(actionHandle: ActionHandle): ExecutionActionOwner | null;
}

interface FamilyPlugin<Candidate, Identity, Descriptor, RouteMemo> {
  readonly manifest: FamilyManifest;
  readonly discovery: DiscoveryCapability<Candidate>;
  readonly identity: IdentityCapability<Candidate, Identity>;
  readonly materialization: MaterializationCapability<Identity, Descriptor>;
  readonly projection: ProjectionCapability<Descriptor, RouteMemo>;
  readonly currentState?: CurrentStateCapability;
  readonly victim?: VictimCapability;
  readonly solverChoices?: SolverChoiceCapability;
  readonly exact: ExactCapability;
  readonly execution: ExecutionCapability;
}
~~~

The generated catalog derives completeness from its exact entry set and roots. Hardcoded values such as
"22 Families" or "242 capabilities" are not production authority. Counts may be reported as observations but
must never be handwritten admission gates.

Verified actors are declared by the owning plugins and aggregated into a generated actor catalog. The
central caller authority verifies and resolves those declarations without importing protocol-specific actor
modules.

### 3.1 Capability evolution without global revalidation

The Family contract is extensible, but it is not one monolithic template version. A large domain template is
an index of independent capability contracts. Every capability has a stable id, schema version, content hash,
and dependency list. Every Family binds only the exact capability closure it implements or consumes.

~~~ts
interface CapabilityContractRef {
  readonly capabilityId: string;
  readonly domain: "core" | "swap" | "protocol" | "funding" | "credit";
  readonly schemaVersion: number;
  readonly contentHash: Hash;
  readonly dependsOn: readonly string[];
}

interface FamilyCapabilityClosure {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly capabilityIds: readonly string[];
  readonly capabilityHashes: readonly Hash[];
  readonly actionOwnerHash: Hash;
  readonly closureRoot: Hash;
}
~~~

The generated catalog has two different kinds of roots:

- catalog/index roots describe which plugins and capabilities are available in this release;
- per-Family closure roots describe the semantic code and contracts that can affect that Family.

Adding an optional capability changes the catalog/index root. It does not change an existing Family closure
root until that Family opts into the capability. A global catalog root change therefore does not by itself
invalidate every Family semantic receipt.

Impact is computed from the transitive capability dependency graph:

~~~ts
interface CapabilityChangeImpact {
  readonly changedCapabilityIds: readonly string[];
  readonly affectedFamilyIds: readonly FamilyId[];
  readonly reusableFamilyReceiptIds: readonly string[];
  readonly affectedDomainRoots: readonly Hash[];
  readonly impactRoot: Hash;
}

function affectedFamilies(
  before: GeneratedFamilyCatalog,
  after: GeneratedFamilyCatalog,
): readonly FamilyId[] {
  const changed = changedCapabilityContentHashes(before, after);

  return after.entries
    .filter((entry) =>
      intersects(entry.capabilityClosure.transitiveCapabilityIds, changed)
    )
    .map((entry) => entry.familyId)
    .sort();
}
~~~

Required revalidation scope:

| Change | Required semantic revalidation |
|---|---|
| Add a new optional Credit-only capability | only the Credit Family or Families that opt in, plus generated catalog integrity |
| Change an existing Credit capability | only Families whose closure contains that capability |
| Change a mandatory Credit domain invariant | all Credit Families, not Swap or Protocol |
| Change one Family implementation or action owner | that Family and its affected production lineage |
| Add a new optional Swap/Protocol capability | only the opt-in Families in that domain |
| Change a shared request, transport, source-fence, standing-position, repayment, or final-sim primitive | every Family whose transitive closure contains that primitive |
| Change only presentation, logging, or a helper verifier | no Family semantic revalidation unless production object semantics changed |

For example, if later Credit work needs a capability absent today, add a new Credit capability contract and
let the relevant Credit plugin declare it. Swap and Protocol declarations, closure roots, and semantic
receipts remain unchanged and are reused. Unrelated Credit Families also remain reusable if they do not
declare or depend on the new capability.

Receipt reuse is content-addressed, not based only on commit equality:

~~~ts
function canReuseFamilyReceipt(
  receipt: FamilySemanticReceipt,
  current: FamilyCapabilityClosure,
  currentCoreSafetyRoot: Hash,
): boolean {
  return receipt.familyDefinitionHash === current.familyDefinitionHash &&
    receipt.capabilityClosureRoot === current.closureRoot &&
    receipt.actionOwnerHash === current.actionOwnerHash &&
    receipt.coreSafetyRoot === currentCoreSafetyRoot &&
    verifyReceiptEvidence(receipt);
}
~~~

A new deployment still needs an exact-SHA systemd anchor, global startup/catalog integrity, and direct live
health evidence. It does not need to rerun unchanged Swap/Protocol semantic suites merely because an
independent Credit capability was added. Prior receipts are composed into the new release only when the
content-addressed closure proves they are unaffected.

This flexibility never permits an optional field to be silently ignored. Unknown capability ids fail closed
unless a current generated owner exists. A genuinely new central EVM primitive is added as a versioned core
capability; its impact follows the same dependency closure instead of forcing an unexamined global rerun.

## 4. One issued Request Program

Request drafts are symbolic Family declarations. There is one central issuer that validates caller authority,
materializes all references, canonicalizes the complete physical object, fingerprints it, and deep-freezes
it. No later layer rebuilds or partially copies the object.

~~~ts
interface IssuedRequestSet {
  readonly schema: "adapter-request-set:v2";
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly requests: readonly PhysicalAdapterRequest[];
  readonly requestSetFingerprint: Hash;
  readonly authorityFingerprint: Hash;
}

function issueRequestSet(
  familyId: FamilyId,
  drafts: readonly AdapterRequestDraft[],
  source: CanonicalSource,
  authority: CallerAuthority,
): IssuedRequestSet {
  const requests = drafts.map((draft) =>
    materializeAndValidateRequest(draft, authority)
  );

  const canonical = canonicalEncode({
    schema: "adapter-request-set:v2",
    familyId,
    source,
    requests,
  });

  return registerIssuedRequestSet(deepFreeze({
    schema: "adapter-request-set:v2",
    familyId,
    source,
    requests,
    requestSetFingerprint: keccak256(canonical),
    authorityFingerprint: authority.fingerprint,
  }));
}
~~~

For strict simulations:

~~~ts
function materializeSimulation(
  draft: SimulationRequestDraft,
  authority: CallerAuthority,
): PhysicalSimulationRequest {
  const request = {
    id: draft.id,
    kind: draft.kind,
    preCalls: (draft.preCalls ?? []).map((call) => ({
      from: resolveCallerRef(call.caller, authority),
      to: canonicalAddress(call.to),
      data: canonicalBytes(call.data),
    })),
    call: {
      from: resolveCallerRef(draft.call.caller, authority),
      executionMode: requireCallerMode(draft.call.executionMode),
      to: canonicalAddress(draft.call.to),
      data: canonicalBytes(draft.call.data),
    },
    overrideIntent: materializeOverride(draft.overrideIntent, authority),
    observeTokenBalances: (draft.observeTokenBalances ?? []).map((item) => ({
      token: canonicalAddress(item.token),
      account: typeof item.account === "string"
        ? canonicalAddress(item.account)
        : resolveCallerRef(item.account, authority),
    })),
    observeTotalSupplies: (draft.observeTotalSupplies ?? []).map(canonicalAddress),
    observeLogs: draft.observeLogs === true,
  };

  assertUniqueExactBalancePairs(request.observeTokenBalances);
  assertWithinSimulationBudget(request);
  return deepFreeze(request);
}
~~~

Rules:

- caller executionMode is explicit; a backend does not silently choose a default;
- each pre-call caller is independently authority-checked and need not equal the main caller;
- balance observation remains an exact token/account pair;
- transports do not split observations into token and account arrays and do not form a Cartesian product;
- the target contract is never guessed to be a token;
- total-supply subjects are explicit;
- the exact sealed physical object is the object transported, fingerprinted, and persisted.

### 4.1 Typed strict transport

The Rust transport must deserialize caller mode as an enum. An unknown value fails deserialization.

~~~rust
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CallerMode {
    TopLevel,
    ImpersonatedCallFrame,
}

#[derive(Deserialize)]
struct BalanceObservation {
    token: Address,
    account: Address,
}

fn configure_strict_frame(cfg: &mut CfgEnv, mode: CallerMode) {
    cfg.disable_eip3607 =
        matches!(mode, CallerMode::ImpersonatedCallFrame);
}
~~~

EIP-3607 may be disabled only for a strict impersonated inner-call frame. Final transaction simulation always
keeps EIP-3607 enabled.

Transport outcomes are facts, not protocol decisions:

~~~ts
type TransportOutcome =
  | { kind: "returned"; data: Bytes; effects: StrictEffects }
  | { kind: "reverted"; data: Bytes; effects: StrictEffects }
  | { kind: "transport-failure"; code: TransportFailureCode }
  | { kind: "invalid-program"; code: string };
~~~

The central transport never turns a revert, empty return, or decode exception into a permanent instance
rejection. The Family interprets deterministic outcomes.

## 5. Startup discovery and nomination

Startup freezes one canonical cutoff:

~~~ts
interface CanonicalCutoff {
  readonly number: number;
  readonly hash: Hash;
}
~~~

All declared discovery sources bind explicit fromBlock..cutoff ranges and source-plan fingerprints. Source
plans come from the generated Family catalog. A verified memo snapshot may nominate previously admitted work,
but it cannot prove coverage, advance a cursor, admit an instance, or create a Graph edge.

The production edge/candidate observation policy is one code-owned range:

~~~ts
const EDGE_COLLECTION_WINDOW_BLOCKS = 14400; // 2 days at 12s slots
const fromBlock = Math.max(0, cutoff.number - 14399);
~~~

- a new run queries exactly `[cutoff.number - 14399 .. cutoff.number]`;
- CLI flags, environment variables, legacy universe metadata, and warm-cache metadata cannot expand or
  narrow it;
- catalog event scans and every plugin auxiliary recent-log nomination bind that same number/hash cutoff and
  range;
- there is no 2-to-7-day dormancy scan or other wider nomination query;
- an unfinished run always resumes its original durable range and cutoff; it never changes window halfway;
- a completed pre-policy wider run is atomically retired before startup creates and returns the current
  14400-block ready generation.

History: the 2-day window was parked at 50 blocks while univ4 pools could not enter the candidate partition
(swap logs carry only poolId; the retain channel's chain-truth sources were still landing). Once the retain
channel admitted univ4 pools (5.4), the window returned to 14400; the streaming observation hash makes the
wide window safe (no giant concatenated string, no "Invalid string length").

The window is an observation policy, not an admission shortcut. Every new rolling run forms its exact
candidate partition as:

~~~text
current 14400-block observations
+ startup candidates
+ every verified memo candidateSnapshot
+ current plugin-declared reverse bindings
→ generic dedupe
~~~

The memo snapshots retain previously verified candidates indefinitely even when they are silent in every
later two-day window. Each still passes `findReusableMemo`: a valid memo is reused, an invalid memo is
re-attested, and an explicit terminal outcome removes the memo in the same checkpoint CAS so it cannot be
retained into the following run. Thus permanent retention preserves topology without making an old file,
warm cache, or memo a coverage/admission/edge authority. Static reverse-verified identity and the plugin
retain channel (5.4) remain available independently.

**Discovery plan change = same-range re-adoption, never a new run.** The runner is layered:

1. **Run lifecycle**: an unfinished fixed run keeps its time world forever — same runId, same cutoff, same
   fromBlock. Only with no unfinished run does the runner freeze a new head and create a run.
2. **Discovery**: the source-plan fingerprint binds only each Family's discovery surface
   (`familyDiscoveryDefinitionHash` = capture/discovery capabilities; pricing/exact/execution changes do
   not move it). When the incumbent run's sealed receipts still match, the durable partition is restored
   with no scan. When they drift, discovery re-runs over the SAME fixed range with the current catalog and
   the SAME run is reconciled (`reconcileFixedRunPlan`: runId/cutoff/fromBlock/observedThrough immutable;
   only the partition hashes, candidatesByKey, sourceReceipts and outcomes are replaced). The reconciled
   partition includes every retained verified memo snapshot; outcomes outside that exact partition are
   discarded because old outcomes are never verification authority under a new discovery plan. Verified
   memos remain until an explicit terminal outcome revokes the corresponding candidate.
3. **Verification**: every candidate re-enters `findReusableMemo` — a pure local binding check (Family id,
   candidate fingerprint, memo-scoped definition hash, proof policy, proof-source bound) first, then the
   same-run fast path (local compares only) or chain authority revalidation (code/storage/blockHash RPC).
   Valid memo → reuse; otherwise attest. A previously fail-closed pool is re-adopted by a new Family only
   through a fresh chain proof (its old terminal outcome is keyed to the old Family and does not carry).

Memo validity binds `familyMemoDefinitionHash` (identity/instance/routes/pricing capabilities), so
changing exact quoting or execution never invalidates an identity memo; memos sealed before the hash split
remain valid under the conservative full-definition branch. This is why no global/family-local/none change
classification is needed: each memo decides its own validity cheaply.

**Checkpoint scale and crash recovery.** The first permanent-retention deployment at `301cb8e8` proved the
candidate model but exposed a storage defect: after upgrading 22,011 memos and sealing a 23,990-candidate
run, the checkpoint was 538,737,677 bytes. Its independently valid top-level fields were approximately
263.0 MB verified memos, 20.7 MB in-progress run, 0.1 MB retry queue and 255.0 MB prior ready generation.
The old `readFile(..., "utf8")` attempted to create one 514 MB V8 string and exited after 38 outcomes with
`RangeError: Invalid string length`; this was not RPC failure, OOM or a corrupt candidate.

The durable store therefore has two physical layers but still one logical authority:

- the base checkpoint is parsed one top-level JSON field at a time, so no whole-file string exists;
- attestation batches append newline-committed, fsynced delta records. Each record binds the prior logical
  checkpoint fingerprint, revision, run id, memo/outcome pair and its own fingerprint; the resulting state
  fingerprint forms a hash chain from the canonical base;
- a crash may leave only one unterminated suffix, which is uncommitted and discarded. Every complete record
  is fingerprint-checked and replayed; revision or chain divergence fails closed;
- any non-attestation CAS (including Ready promotion) atomically writes one canonical compacted base, then
  removes the already-included journal. A crash between rename and journal removal is safe because records
  below the compacted revision are recognized as historical;
- the journal is only a write-ahead representation of the same memo/outcome CAS. It is not a candidate
  journal, discovery source, admission authority or second Graph.

The regression forces field names, escapes and values across 5/7-byte read chunks, proves an attestation
batch does not rewrite the large base, proves a fresh store replays the hash chain, and proves an incomplete
tail is ignored before the next compaction. The universe/cutover targeted suite (18 commands), full listener
build, cleanup receipt and diff check pass; exact-SHA live resume evidence remains required before this
storage fix is called deployed.

### 5.1 Full evidence identity

Log dedupe preserves block number, block hash, transaction hash, log index, emitter address, topic identity,
and plugin-decoded pool/instance identity. Two observations that share a transaction or emitter are not
automatically the same evidence.

### 5.2 Plugin-owned instance nomination

The plugin provides an opaque instanceNominationKey. The central kernel groups candidates by
Family+instanceNominationKey and retains all distinct evidence rows.

~~~ts
interface NominationGroup<Candidate> {
  readonly familyId: FamilyId;
  readonly instanceNominationKey: string;
  readonly candidates: readonly Candidate[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly groupFingerprint: Hash;
}

function groupNominations<Candidate>(
  plugin: FamilyPlugin<Candidate, unknown, unknown, unknown>,
  candidates: readonly Candidate[],
): readonly NominationGroup<Candidate>[] {
  const groups = new Map<string, MutableNominationGroup<Candidate>>();

  for (const candidate of candidates) {
    const key = plugin.discovery.instanceNominationKey(candidate);
    const group = groups.get(key) ?? createMutableNominationGroup();
    group.candidates.push(candidate);
    group.evidenceRefs.push(...evidenceRefsFor(candidate));
    groups.set(key, group);
  }

  return [...groups].map(([instanceNominationKey, group]) =>
    deepFreeze({
      familyId: plugin.manifest.familyId,
      instanceNominationKey,
      candidates: dedupeByFullEvidenceIdentity(group.candidates),
      evidenceRefs: dedupeEvidenceRefs(group.evidenceRefs),
      groupFingerprint: hashNominationGroup(group),
    })
  );
}
~~~

There is no central address+poolId guess and no single representative candidate that discards alternate
actor/pair/amount/transaction evidence.

### 5.3 One lifecycle per Family+Instance

Within one fixed-cutoff run, a Family+Instance executes identity → materialization → projection at most once.
All startup pool sets are merged before lifecycle work. Universe and blockscan sources cannot separately
attest the same instance.

### 5.4 Retain channel: plugin-declared reverse binding

Some observations cannot form a complete candidate directly: a univ4 Swap log carries only the 32-byte
poolId (the manager never exposes per-pool contracts), and decodeCandidate deliberately refuses to guess a
PoolKey from a one-way hash. Such an observation is not dropped; it becomes an opaque nomination and the
plugin's declared retain channel re-materializes chain truth.

The plugin owns the declaration; the central pipeline owns the driver:

~~~ts
interface DiscoverySemantics<Candidate> {
  readonly reverseBinding?: ReverseBindingDeclaration;
}

type ReverseBindingDeclaration =
  | { readonly kind: "implementation";
      readonly reverseBinding: (input: {
        readonly nominations: readonly CaptureNominationInput[];
        readonly source: CanonicalSource;
        readonly provider: CaptureNominationProvider;
      }) => Promise<readonly ReverseBindingOutcome[]> }
  | { readonly kind: "explicitly-unsupported"; readonly reason: string };
~~~

The central rebuild driver derives opaque nominations only from plugin-declared semantics: a log pattern
whose emitter mode is `singleton-indexed-bytes32` declares that the singleton carries the child's opaque id
at `topics[emitter.topicIndex]`. The central pipeline never knows the protocol — no topic, selector, ABI or
infrastructure address appears in central paths. The catalog projection
(`hasReverseBinding`/`reverseBindingFor`) decides which families participate.

Execution order (fixed-cutoff run):

1. swap-window scan produces observations; `decodeCandidate` nulls are collected as opaque nominations
   instead of being discarded;
2. `executeCatalogReverseBindings` feeds each nomination to each Family's declared `reverseBinding`
   one at a time (the executor admits one verified observation per Family per call — a per-candidate
   contract, never a batch);
3. a "verified" outcome's observation re-enters through the same `catalog.matches` + `decodeCandidate`
   admission the scan channel uses;
4. reverse-bound candidates merge through the alias-collapsing dedupe
   (`rebuildFamilyInstanceDedupeKey`: Family + address + poolId), so retained and event spellings of one
   instance enter the run once.

univ4 sources (plugin-owned): primary is the PositionManager `poolKeys` reverse lookup at the source block;
fallback is the indexed Initialize-log reverse scan (`resolveV4InitsBackward`, topics
`[Initialize, poolId]`) on the archive node (MAINNET_RPC_URL) for router-side pools the position manager
never saw — the local node's `eth_getLogs` caps on indexed topics[1] filters and its history is pruned.

One verified outcome per family instance: two candidate keys can verify to the same instance (two curve
pools sharing one underlying). The runner keeps the first verified candidate per instance (sorted by key)
and downgrades the duplicates to terminal-rejected `duplicate-instance`, so the ready promotion's instance
set is unique; the startup runtime materializes exactly one instance per active key. The pass is idempotent
and repairs an incumbent run on resume (no re-verification).

## 6. Durable startup envelope

The durable store has one logical writer and one atomic envelope:

~~~ts
interface StartupCheckpointEnvelope {
  readonly schema: "strict-startup-envelope:v3";
  readonly revision: bigint;
  readonly verifiedMemos: Readonly<Record<FamilyCandidateKey, DurableVerifiedMemo>>;
  readonly inProgressRun: DurableAttestationRun | null;
  readonly retryableAttemptsByCandidateKey: Readonly<
    Record<FamilyCandidateKey, DurableRetryableQueueEntry>
  >;
  readonly readyGeneration: ReadyGeneration | null;
}

interface DurableVerifiedMemo {
  readonly familyCandidateKey: FamilyCandidateKey;
  readonly familyInstanceKey: FamilyInstanceKey;
  readonly candidateFingerprint: Hash;
  readonly familyDefinitionHash: Hash;
  readonly validity: DurableMemoValidity;
  readonly verifiedIdentity: unknown;
  readonly compiledDescriptor: unknown;
  readonly staticProjection: unknown;
  readonly evidenceFingerprint: Hash;
  readonly candidateSnapshot: CandidateSnapshot;
  readonly memoFingerprint: Hash;
}

interface DurableRetryableQueueEntry extends DurableRetryableOutcome {
  readonly runId: string;
  readonly cutoff: CanonicalCutoff;
}

interface DurableAttestationRun {
  readonly runId: string;
  readonly cutoff: CanonicalCutoff;
  readonly universeRange: { fromBlock: number; toBlock: number };
  readonly candidateSetHash: Hash;
  readonly candidatesByKey: Readonly<Record<FamilyCandidateKey, CandidateSnapshot>>;
  readonly outcomesByCandidateKey: Readonly<Record<FamilyCandidateKey, CandidateOutcome>>;
  readonly sourceReceipts: readonly DurableSourceReceipt[];
}

type CandidateOutcome =
  | DurableVerifiedOutcome
  | DurableTerminalOutcome
  | DurableRetryableOutcome;
~~~

The writer persists completed outcomes during the run, not only at the end:

- one writer and compare-and-swap revision;
- flush after a bounded item count or bounded time;
- SIGTERM/SIGINT flush;
- crash-safe temporary write and atomic replacement;
- partial or corrupt writes fail closed;
- resume by FamilyCandidateKey, never by array index or a number such as "8000".

Verified memos retain canonical identity, descriptor/static projection memo, proof fingerprints, Family
definition hash, implementation authority, source binding, evidence references, and the complete JSON-safe
plugin candidate snapshot needed for cross-window nomination. `memoFingerprint` binds the snapshot along
with the proof fields. Deployed pre-snapshot memos are accepted only after their old fingerprints verify;
the generated catalog/manifest reconstructs a candidate whose `FamilyCandidateKey` and candidate fingerprint
both match, then memo plus any incumbent verified outcome fingerprint upgrade in one CAS. Live route handles
are not serialized. There is no separate permanent candidate journal.

### 6.1 Typed Family decisions

~~~ts
type FamilyDecision<Identity> =
  | { kind: "verified"; identity: Identity }
  | {
      kind: "chain-proven-rejected";
      reasonCode: string;
      evidenceRequestIds: readonly string[];
    }
  | { kind: "retryable"; code: RetryableCode; detail?: string }
  | { kind: "invalid-program"; code: string; detail?: string };
~~~

RPC, timeout, deadline, abort, resource exhaustion, missing catalog capability, and deterministic plugin
program bugs are not chain-proven rejection. Error prose is never parsed into terminal authority.

### 6.2 Terminal proof binding

~~~ts
interface TerminalProofBinding {
  readonly familyDefinitionHash: Hash;
  readonly requestSetFingerprint: Hash;
  readonly trustedResultsFingerprint: Hash;
  readonly authorityFingerprint: Hash;
  readonly candidateFingerprint: Hash;
  readonly cutoff: CanonicalCutoff;
}

function sealTerminalOutcome(
  decision: ChainProvenRejectedDecision,
  issued: IssuedRequestSet,
  results: IssuedResultSet,
  current: CurrentAttestationBinding,
): DurableTerminalOutcome {
  assertEvidenceIdsBelongToResultSet(decision.evidenceRequestIds, results);

  return deepFreeze({
    status: "terminal-rejected",
    reasonCode: decision.reasonCode,
    binding: {
      familyDefinitionHash: current.familyDefinitionHash,
      requestSetFingerprint: issued.requestSetFingerprint,
      trustedResultsFingerprint: results.fingerprint,
      authorityFingerprint: issued.authorityFingerprint,
      candidateFingerprint: current.candidateFingerprint,
      cutoff: current.cutoff,
    },
    proofReceipt: results.sealedReceipt,
  });
}

function canReuseTerminal(
  saved: DurableTerminalOutcome,
  current: TerminalProofBinding,
): boolean {
  return bindingsExactlyEqual(saved.binding, current) &&
    verifyIssuedResultReceipt(saved.proofReceipt);
}
~~~

Empty fingerprints are forbidden. Any Family definition, request set, trusted result, authority, candidate,
or cutoff number/hash change forces re-attestation.

### 6.3 Source coverage

Each source receipt binds:

- Family and source id;
- explicit fromBlock..toBlock;
- observedThrough number/hash;
- appliedThrough number/hash;
- cutoff number/hash;
- query/source-plan fingerprint;
- dedupe policy fingerprint;
- result/candidate partition hash.

The cursor advances only after the durable receipt and associated outcomes are committed. Coverage cannot
fall back to a global DEX/protocol cursor. One verified instance cannot grant complete-snapshot or omission
authority to an entire Family source.

### 6.4 Promotion

Promotion performs one compare-and-swap over Graph, catalog, coverage, cutoff, candidate accounting, and
generation roots:

~~~ts
interface ReadyGeneration {
  readonly generationId: GenerationId;
  readonly cutoff: CanonicalCutoff;
  readonly catalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly coverageRoot: Hash;
  readonly candidateSetHash: Hash;
  readonly candidateAccounting: {
    readonly total: number;
    readonly verified: number;
    readonly terminalRejected: number;
    readonly retryable: number;
    readonly remainingUnaccounted: 0;
  };
  readonly completeness: "complete";
  readonly instances: readonly PersistedFamilyInstance[];
  readonly graph: PersistedGraph;
}

function promoteReady(
  envelope: StartupCheckpointEnvelope,
  run: DurableAttestationRun,
): StartupCheckpointEnvelope {
  assertCanonicalHash(run.cutoff);
  assertAllSourceReceiptsBound(run);
  assertExactCandidatePartition(run);
  assertRemainingUnaccountedZero(run);

  const verified = verifiedOutcomes(run);
  const ready = buildVerifiedOnlyReadyGeneration(run, verified);
  const retryableQueue = moveRetryablesToIndependentQueue(
    envelope.retryableAttemptsByCandidateKey,
    run,
  );

  return compareAndSwapEnvelope(envelope.revision, {
    ...envelope,
    inProgressRun: null,
    retryableAttemptsByCandidateKey: retryableQueue,
    readyGeneration: ready,
  });
}
~~~

Promotion never advances source facts that are not durably proven. A missing outcome keeps the fixed run
durable and blocks promotion; a retryable is an explicit accounted result that remains outside Graph and moves
to the independent probe queue. Successful promotion clears `inProgressRun` while retaining verified memos,
queued retries, and the ready generation; the next startup can therefore freeze a new rolling 14400-block
cutoff instead of restoring an already-completed historical run forever.
A pre-queue checkpoint that already contains a Ready bound exactly to its kept run is migrated locally before
source-plan reconciliation: the same promotion checks must pass, then retryables move to the queue and the run
clears. Any root, instance-set, receipt, or accounting mismatch skips this fast path and enters normal
fail-closed recovery.

## 7. Persisted Graph and runtime rehydration

Persisted Graph rows contain stable public routing facts and a plugin-owned route memo. They do not contain
protocol-shaped fields or executable closures.

~~~ts
interface PersistedGraphEdge {
  readonly canonicalEdgeId: CanonicalEdgeId;
  readonly familyId: FamilyId;
  readonly instanceKey: FamilyInstanceKey;
  readonly routeKey: RouteKey;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly taxonomy: "swap" | "protocol" | "funding" | "credit";
  readonly leavesStandingPosition: boolean;
  readonly routeBindingFingerprint: Hash;
  readonly routeMemo: RouteHandleMemo;
}

interface RuntimeGraphEdge
  extends Omit<PersistedGraphEdge, "routeMemo"> {
  readonly routeHandle: OpaqueRouteHandle;
}
~~~

The central rehydrator asks the current plugin to reissue a live route handle:

~~~ts
function rehydrateGraphEdge(
  edge: PersistedGraphEdge,
  catalog: GeneratedFamilyCatalog,
  source: CanonicalSource,
): RuntimeGraphEdge {
  const plugin = catalog.require(edge.familyId);
  const routeHandle = plugin.projection.rehydrateRoute({
    memo: edge.routeMemo,
    source,
  });

  assertRouteBinding(routeHandle, edge.routeBindingFingerprint);

  return deepFreeze({
    ...withoutRouteMemo(edge),
    routeHandle,
  });
}
~~~

Protocol fields such as curve indices, V2/V3 fees, V4 PoolKey, poolId fallback identity, token ordering, ABI,
or storage kind do not belong in the central Graph type.

## 8. Current state, pricing, and sizing

The central scanner does not read protocol reserves, liquidity, ticks, balances, rates, or storage layouts.
It consumes plugin-issued sealed state and a generic sizing envelope.

~~~ts
interface CurrentStateCapability {
  issueProgram(input: {
    routeHandle: OpaqueRouteHandle;
    source: CanonicalSource;
  }): IssuedRequestSet;

  decode(input: {
    routeHandle: OpaqueRouteHandle;
    requestSet: IssuedRequestSet;
    outcomes: readonly TransportOutcome[];
  }): SealedCurrentStateHandle;

  projectSizing(input: {
    routeHandle: OpaqueRouteHandle;
    state: SealedCurrentStateHandle;
  }): SizingEnvelope;
}

interface SizingEnvelope {
  readonly maxInput: bigint;
  readonly suggestedCenters: readonly bigint[];
  readonly depthScore: number;
  readonly confidence: "exact" | "bounded";
}
~~~

Protocol math may live in reusable libraries, but dependency direction matters: Family plugins may import
those libraries; central scanner/solver code may not import a V2/V3/V4/Curve-specific state reader or math
module. Central caching keys sealed state by route binding, source number/hash, Family definition hash,
request-set fingerprint, and authority. A cache never grants admission or Graph authority.

Current-source refresh is atomic and block-cadence aware, and it is **touched-driven**: the strict
session refreshes current pricing only for the venues this block's transactions actually touched (the block
log addresses, and the univ4 PositionManager poolId from topics[1]); untouched ready instances are skipped
explicitly ("skipped" outcomes, never a missing refresh). The published snapshot keeps the full ready graph
in its expected edge set but marks every untouched edge unresolved
(coverage reason `untouched-this-block`) and reports `degraded` while its family joins
`incompleteFamilyIds`; the scanner enumeration resolves over the priced (resolved) subset. This keeps the
whole-block pipeline inside one block cadence at the 16k-instance graph scale instead of re-reading every
venue per block:

- ready instances refresh under a bounded shared worker pool; independent instances must not form one
  serial RPC chain, and untouched instances are not read at all;
- the same source number/hash/generation shares one in-flight session promise across blockscan/backrun; the
  session cache key includes the touched-set fingerprint;
- exact-kind sessions (exact refinement probes and the exact execution context) re-issue route handles only
  for the touched instances (credit families always re-issued), scoped to the coarse block's touched venues
  in the N-1 lane — never the full 16k-instance reissue, which blew the refinement budget;
- results are stored by ready-instance index and flattened in deterministic ready order;
- one failed instance rejects the whole new session and cannot publish a partial pricing snapshot;
- Funding refresh and final source/generation fences remain fail-closed.

The concurrency cap is a resource policy, not a Family contract. A Family plugin still issues its request
program; the kernel only schedules independent issued programs. Adding or changing an unrelated capability
closure therefore does not require revalidating Families that do not depend on it.

Funding liquidity is read per token per block, so the funded token set must not scale with the routing
graph's token count (the 14400-window graph carries thousands of tokens; unbounded funding reads blew the
block budget and one unreadable result crashed the funding decode). The funded token set is the funding
providers' real support surface, enumerated from chain truth and solidified once into a table
(/opt/MEV-runtime/funding-token-universe.json):

- Morpho Blue: every registered market's loan token (CreateMarket events + market(id)); Morpho flash loans
  borrow the market loan token;
- Balancer V2 Vault: current balanceOf(vault) > 0 over the candidate tokens (the graph tokens in the
  searcher; pool-universe token0/token1 in the CLI) — the Vault flash-loans any ERC20 it holds and its
  flashLoan only checks vault balance, so the support surface is queried via the balanceOf interface, never
  pool-registration history (which the local node prunes).

First boot enumerates once and solidifies the table; the searcher only reads it afterwards. The per-family
balance decode skips unreadable sources (no offer for that source) instead of failing the family.

## 9. Victim observation and post-impact state

There is one VictimCapability. The central runtime does not expose parallel receiptObservation, localApply,
overlay, and replay authority shapes and does not decode protocol post-state.

~~~ts
interface VictimCapability {
  classifyReceipt(input: {
    receipt: CanonicalReceipt;
    source: CanonicalSource;
  }): IssuedVictimTransition | null;

  bindRoutes(input: {
    transition: IssuedVictimTransition;
    graph: GraphView;
  }): readonly OpaqueRouteHandle[];

  issueMutationProgram(input: VictimProgramInput): StateMutationProgram | null;
  issueReplayProgram(input: VictimProgramInput): IssuedReplayProgram | null;
}

interface StateMutationProgram {
  readonly source: CanonicalSource;
  readonly generation: GenerationId;
  readonly routeBindingFingerprint: Hash;
  readonly victimEvidenceHash: Hash;
  readonly operations: readonly (
    | {
        kind: "storage-write";
        address: Address;
        slot: Bytes32;
        value: Bytes32;
      }
    | {
        kind: "token-balance-write";
        token: Address;
        account: Address;
        value: bigint;
      }
  )[];
  readonly touchedSubjectsRoot: Hash;
  readonly contentHash: Hash;
}
~~~

The plugin owns slot numbers, packing, token balance slots, and protocol post-state interpretation. The
central runtime verifies source/generation, issuer, touched-subject bounds, operation budgets, and content
hash before applying the program.

If the Family cannot issue a reliable mutation program, the runtime uses the Family-issued replay program
and mandatory final simulation. The central runtime never guesses a storage slot.

Oracle effects use the same request/effect contract. The central runtime does not decode a Family-specific
signature, function name, or output index.

Pending-evidence eligibility is plugin-issued and opaque:

~~~ts
interface IssuedEligibility {
  readonly generation: GenerationId;
  readonly scopeKey: string;
  readonly evidenceKeys: readonly string[];
  readonly contentHash: Hash;
}
~~~

The central runtime compares opaque scope/evidence keys. It does not contain special values such as
"family-wide" for one Family.

## 10. Solver choices, exact, and execution

Protocol-specific search dimensions are opaque solver choices:

~~~ts
interface SealedSolverChoice {
  readonly choiceId: string;
  readonly routeScopeHash: Hash;
  readonly diversityClass: string;
  readonly payloadHandle: OpaqueChoiceHandle;
}

interface SolverChoiceCapability {
  choices(input: SolverChoiceInput): readonly SealedSolverChoice[];

  quote(input: {
    routeHandle: OpaqueRouteHandle;
    choice: SealedSolverChoice;
    amountIn: bigint;
    state: SealedCurrentStateHandle;
  }): ExactQuoteHandle;
}
~~~

The central solver may schedule and diversify by diversityClass. It does not know that a choice represents a
Fluid debt ratio, a tick strategy, or any other protocol field.

Funding borrow/repayment mechanisms are Family-issued execution handles. The central runtime retains the
universal repayment proof and does not branch on protocol-specific modes such as approve-pull, transfer, or
tokens-and-amounts.

Credit and Protocol routes remain subject to taxonomy integrity, blocksPrefixInversion policy,
leavesStandingPosition guard, conservation, full repayment, and mandatory final simulation. Those are
central safety policies. The plugin supplies the signed taxonomy and route behavior; the central runtime
enforces the generic policy.

### 10.1 Fail-closed compilation

~~~ts
function compileNode(
  node: ResolvedExecutionNode,
  executor: Address,
  actions: GeneratedActionCatalog,
): Uint8Array {
  const owner = actions.ownerOf(node.actionHandle);
  if (owner === null) {
    throw new Error("unowned strict execution action");
  }

  const innerScript = concatBytes(
    ...node.children.map((child) =>
      compileNode(child, executor, actions)
    ),
  );

  return owner.encode({ node, executor, innerScript });
}
~~~

There is no skip adapter, empty-byte fallback, legacy encoder, or recovery through an old registry.

## 11. Frozen producer topology

Producer creation receives one immutable runtime view:

~~~ts
interface StrictReadyRuntime {
  readonly generationId: GenerationId;
  readonly cutoff: CanonicalCutoff;
  readonly catalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly graph: GraphView;
  openCurrentSource(source: CanonicalSource): StrictCurrentSourceSession;
}
~~~

During the producer lifetime:

- Graph root and catalog root do not change;
- no discovery/backfill/protocol-trace topology work runs;
- no runtime pool refresh exists;
- no edge is added, merged, replaced, or removed;
- current state changes only inside source-bound sessions;
- topology changes require a process restart and a newly promoted readyGeneration.

Generic in-flight dedupe, batching, caching, and backpressure may continue. They do not own admission,
coverage, cursor, Graph creation, or publication.

## 12. Physical deletion closure

The strict-only source closure must not contain any of the following authorities, even under a new name:

- buildTokenGraph or buildTokenGraphWithResults;
- POOL_REGISTRY or another handwritten production pool registry;
- raw universe/poolSets to edge bridge;
- runtime pool refresh or dynamic edge building;
- live-discovery publication;
- live-discovery checkpoint inventory as Graph authority;
- strict-catalog live publisher;
- producer-time discovery, backfill, protocol-trace discovery, or topology publication;
- strict edge secondary merge;
- legacy/default planner edge;
- legacy quoter or exact fallback;
- legacy execution fallback;
- strict/legacy Graph feature flag or consumer switch;
- legacy-shaped catalog/registry facade;
- a path that creates or mutates topology without readyGeneration.

Files and symbols that exist only for those paths are deleted, including obsolete tests, fixtures,
diagnostics, package scripts, and standalone consumers. Compatibility exports are not retained for old tests.

Production consumers are handled by one of three actions:

1. load-bearing consumer → wire directly to strict readyGeneration, GraphView, and current-source session;
2. valuable invariant test → make it consume production-issued strict objects;
3. old registry/dynamic topology/fallback-only consumer → delete it.

### 12.1 Central protocol semantics that must also disappear

The hard-cutover closure additionally removes:

- protocol fields from central Graph/PoolEntry DTOs;
- a strict catalog projected back into a legacy RouteLegAdapter/PoolEntry facade;
- central V2/V3/V4/Curve state readers, math dispatch, storage overlays, and sizing branches;
- central protocol observation decoders and concrete landed-event topic tables;
- central protocol identity resolvers and ABI tables;
- central oracle-victim decoding;
- Family-specific pending-evidence activation modes;
- Fluid-specific debt-bps fields in the generic solver;
- handwritten production Family/adapter/actor counts and tables;
- cleanup scanners that exempt an entire central directory because its path contains "venues".

Only exact generated plugin roots and generated artifacts are exempt from the central semantic-closure scan.

## 13. One-batch hard-cutover procedure

This procedure is one coherent implementation batch, not a sequence of deployable migrations.

### 13.1 Resolve the exact working base

- confirm branch, local HEAD, upstream tip, and remote relation;
- inspect every staged, unstaged, and untracked file;
- preserve user-owned and other-window changes;
- never touch or commit listener/diag-attest.ts;
- identify the exact old commit that may be consulted as read-only history.

### 13.2 Delete all old authority

Delete the complete closure described in section 12 before trying to restore a green build. Do not stop at
the first compiler error and do not create a compatibility wrapper.

### 13.3 Close compiler gaps against strict authority

For each compiler error:

- connect a production consumer to readyGeneration/GraphView/current-source strict authority;
- update a still-valid invariant test to use production-issued strict objects; or
- delete a consumer/tool that exists only for legacy authority.

Never restore an old builder, rebuild an edge from raw PoolEntry RPC calls, add a strict/legacy flag, rename
runtime topology refresh, handwrite a TokenEdge fixture as lifecycle evidence, or change production behavior
solely to satisfy an obsolete harness.

### 13.4 Verify the final source closure

Only after all old authority is deleted and all strict consumers are connected:

- run strict startup/readyGeneration contracts;
- run backrun/blockscan strict-only contracts;
- run exact/execution/final-simulation authority contracts;
- run producer freeze contracts;
- run retry/restart/checkpoint contracts;
- run the listener complete build;
- inspect source and transitive import closure for legacy authority = 0;
- inspect real central data shapes for protocol leakage;
- update this canonical document to match final code.

Build and tests are required regression guards. They are not production acceptance and do not justify a
deployable intermediate SHA.

### 13.5 One commit and push

Deletion, strict rewiring, contracts, build fixes, cleanup, and canonical update form one hard-cutover
commit. Push it and verify local HEAD equals upstream tip, committed scope contains no unrelated user
changes, and any remaining worktree changes are explicitly identified user/other-window files. No
intermediate hard-cutover SHA is deployed.

## 14. Deployment safety

Deployment begins only after the complete strict-only commit is pushed.

Required preflight:

- local and remote exact SHA;
- intended branch and clean committed scope;
- current systemd unit, PID, process start, runtime commit, and log inode;
- deployment/runtime locks;
- pool-universe cron state;
- local Reth health and ownership;
- dry-run environment;
- no unauthorized signing or broadcast.

Deployment uses scripts/deploy-node.sh, systemd, and SEARCHER_RUNTIME_COMMIT bound to the exact pushed SHA.
Nohup is forbidden. The pool-universe cron must not compete with startup rebuild; any pause and later
restoration state is recorded exactly. The default remains dry-run. This document grants no signing or
broadcast authority.

## 15. Live fact lineage

Each live candidate must carry one correlation lineage:

~~~text
runtimeCommit
processId
processStart
logInode
generationId
cutoffNumber + cutoffHash
catalogRoot
candidateSetHash
FamilyId + FamilyCandidateKey + FamilyInstanceKey
publicationHash
graphRoot + canonicalEdgeId + routeBindingFingerprint
currentSourceNumber + currentSourceHash
requestSetFingerprint
exactHandleId
executionProgramHash
finalSimulationReceiptHash
correlationId
~~~

Every stage emits immutable identifiers from its actual production object. Logging a copied label without the
bound object hash is not lineage.

### 15.1 Diagnose the first broken transition

| Observed facts | First place to inspect |
|---|---|
| source receipt absent | discovery query, explicit range, provider, source-plan fingerprint |
| candidate exists but no outcome | scheduler, durable writer, abort/resource accounting |
| retryable repeats | exact request fingerprint, transport outcome, caller mode, Family decode |
| verified outcome but no instance | materialization or memo rehydration |
| instance exists but no edge | Family projection or Graph promotion |
| edge exists but planner does not consume it | GraphView/current generation consumer |
| route exists but no state/sizing | current-state capability |
| state exists but no exact | exact request/decode/source fence |
| exact exists but no execution program | generated action owner or execution projection |
| program exists but final simulation fails | calldata, repayment, conservation, standing position, state/replay |
| all six stages pass but no inclusion | live competitiveness, latency, submission, or builder path |

This table is the primary debugging method. A capture/parity/shadow script cannot redirect diagnosis away
from the earliest missing production object.

### 15.2 Script disagreement

When a helper reports failure but immutable production lineage appears complete:

1. freeze exact runtime objects and helper inputs;
2. compare the helper predicate with the canonical contract;
3. determine whether the producer, verifier, or helper is wrong;
4. if the helper is wrong, fix it and its narrow regression;
5. do not change correct production authority or reintroduce legacy objects to make the helper pass.

Safety predicates, canonical source, runtime SHA, repayment, conservation, standing-position, and final
simulation failures are never dismissed as helper bugs without direct evidence.

## 16. Fact-based final acceptance

Tests and scripts support this judgment; they do not own it. Final acceptance directly inspects
production-issued objects from one exact runtime.

### 16.1 Runtime anchor

The evidence set binds:

- exact pushed SHA;
- systemd SEARCHER_RUNTIME_COMMIT;
- PID and process start;
- log inode and bounded log window;
- dry-run and safety configuration;
- generationId, cutoff, catalogRoot, graphRoot;
- no process restart inside the measured 100/100 window.

### 16.2 Full Family Universe/Instance matrix

For every generated production Family:

- declared source plans and source receipts are visible;
- candidates are counted by exact partition;
- every candidate is verified, chain-proven rejected, or retryable;
- final acceptance has `remainingUnaccounted=0`; queued retryables are reported separately and never counted
  as active instances;
- verified candidates bind publications and instances;
- no candidate or Family silently disappears.

Funding and Credit may have zero live instances when the catalog proves their capability and the measured
source window carries explicit absence evidence.

### 16.3 Full Family Edge/Graph matrix

For every verified instance:

- projected route count is explicit;
- every edge binds FamilyId, InstanceKey, publication, route memo, route binding, catalogRoot, and graphRoot;
- an empty projection is an explicit Family result, not a missing row;
- no raw pool row or secondary merge creates an edge;
- every runtime edge rehydrates through the current generated catalog.

### 16.4 Six load-bearing stages

At least one real live candidate must traverse all six stages under the same correlation lineage:

1. **Input and identity** — real source/candidate and reverse-verified Family decision.
2. **Instance and Graph** — publication, instance, route projection, atomic readyGeneration.
3. **Current state and exact** — current-source session, sealed state, sizing, and exact handle.
4. **Resolved execution** — solver-selected route/amount and current generated action ownership.
5. **Mandatory final simulation** — real encoded program passes repayment, conservation, standing-position,
   and effect checks.
6. **Production outcome** — dry-run EV/result is emitted from that same final-simulation receipt.

An adapter replay may diagnose a Family, but a pinned route is not a substitute for target-blind live
lineage.

### 16.5 Restart and durable reuse

After a controlled systemd restart:

- startup freezes a new current 14400-block run while retaining the prior atomic readyGeneration as durable
  evidence until the new generation promotes;
- chain discovery still reads only the new 14400-block range; the candidate partition additionally carries
  every fingerprint-bound verified memo snapshot, regardless of how long the instance has been inactive;
- verified memos are reused only when all fingerprints remain valid; an invalid memo is re-attested, while
  an explicit terminal outcome deletes it atomically so the next rolling run no longer retains it;
- only newly discovered and invalidated candidates execute fresh lifecycle work; an unchanged queued retryable is
  inherited as accounted and retried only by the independent single-candidate probe;
- an original-cutoff single-pool probe updates only its FamilyCandidateKey;
- source/candidate/Graph cursors never advance ahead of durable facts;
- topology remains frozen after producer creation.

### 16.6 Continuous health

The final exact SHA/PID/process-start/log-inode window records continuous 100/100 health. The denominator and
meaning come from actual production attempts, not a handwritten fixture set. Every failed attempt is
retained with its first failed lineage stage.

For the F5 latency stage, the same runtime anchor must additionally show over a continuous multi-block
window:

- strict current-source generation wall time remains below observed block cadence;
- the coarse producer catches up to the required adjacent N-1 source instead of remaining 100 blocks behind;
- `no_adjacent_precompleted_coarse` does not persist;
- state runs and real scanned/expected/priced counts are non-zero;
- scheduler queue time and strict session refresh wall time are reported separately. `scheduler_queue_ms=0`
  is not evidence of low latency when the producer itself takes longer than one block.

### 16.7 Legacy zero and receipts

Final evidence includes:

- source/import closure legacy authority = 0;
- runtime/log legacy authority = 0;
- consumer fallback and feature switches = 0;
- no central protocol-semantic imports or protocol-shaped DTO fields;
- final F6–F9 receipts;
- MigrationCleanupReceipt.verdict = pass;
- this canonical document matching the deployed exact SHA.

A cleanup receipt is supporting evidence. Its pass cannot override a real load-bearing legacy call site or a
missing live lineage object.

### 16.8 Final acceptance evidence (496545fb)

Final acceptance is bound to the exact deployed SHA **496545fbdfbc67d8139a1dac305bed3f17432291**
(systemd `mev-searcher` active, dry-run, `SEARCHER_DRY_RUN=1`), PID 1067437, process start
2026-08-22T12:21:24Z, log anchor /var/log/mev-live.log line 8288126 (log inode captured at measurement
time; no restart inside either window).

**Continuous 100/100 health (blockscan-pass-latency, threshold 10000ms, §16.6):**

- Window 1 (runtime commit b8d4e664992aa1cd1a20b490a0518a1465a19d85): 167 consecutive source blocks
  25810481→25810647, all passes ≤10s, total_ms P50=676ms P95=3315ms MAX=5646ms, overThreshold=0,
  continuity breaks=0;
- Window 2 (runtime commit 496545fb, after the controlled restart): 132 consecutive source blocks
  25810764→25810895, all passes ≤10s, total_ms P50=288ms P95=3005ms MAX=7147ms, overThreshold=0,
  continuity breaks=0.

Both windows are single-process/single-commit (eligibleForQualification=true): one process start at scope
start, one non-empty runtime_commit line, zero records before the commit anchor. Each failed attempt in
earlier deployments was retained with its first failed lineage stage (funding generation fence,
exact-session reissue budget, coarse-scope mismatch) and each was fixed in production code before the
window above.

**Restart and durable reuse (§16.5, historical evidence at 496545fb):** controlled systemd restarts
(generations 11→12→13→14) reused cutoff 25803561 under the then-current kept-run implementation while
retaining the prior atomic readyGeneration (16006 active instances) as durable evidence; each restart resumed
from the checkpoint without a reset and the post-restart process achieved its own qualified 100/100 window.
That kept-run behavior is superseded by the `remainingUnaccounted=0` completion rule above: completed runs now
clear and residual retryables live in the independent queue.

**Full Family matrices (§16.2/16.3):** universe rebuild status (checkpoint revision 1223, ready
generation 14): verifiedMemos=16006, outcomes verified=16006 / terminal-rejected=1639 / retryable=77
(historically retained in the run; under the current contract these move to the independent probe queue;
retryable candidates never enter the ready generation), activeInstances=16006, graph hash
324463193db1a7c6…; the 4 univ4 target pools (44cb18b3/3485addb/2287a962/3d8a4e3c) are in the Graph and
the univ3 fork pool 76a278bd was fail-closed rejected.

**Receipts (§16.7), run at the final SHA on the node:**

- migration cleanup receipt generator: PASS (MigrationCleanupReceipt.verdict=pass);
- s1 cutover readiness: PASS;
- strict production family declarations: PASS;
- default-authority cutover gate: PASS;
- systemic-live gate: PASS;
- full listener build + deploy-time suite (18/18) at every deployed SHA.

**Funding (§8):** the funded surface is the solidified universe table
(/opt/MEV-runtime/funding-token-universe.json, 261 tokens @ block 25804533, Morpho Blue market loan
tokens + Balancer V2 Vault balanceOf>0 candidates); the pass prepare and blind prewarm pass only that
surface (45a01264), never the graph token set.

## 17. Role of tests and tools

No new handwritten acceptance harness is required or allowed to manufacture the result.

Allowed:

- contract assertions over production issuers and real sealed object types;
- the listener complete build;
- source/import closure inspection;
- direct checkpoint, systemd, process, and structured runtime evidence collection;
- an independent verifier reading immutable production receipts;
- a narrow regression for a confirmed producer/verifier/helper defect.

Not allowed as production truth:

- hand-authored successful TokenEdge/Graph objects;
- manually populated expected Family counts;
- fixture-only candidate success;
- capture/parity/shadow output with no live object lineage;
- self-reported "sealed-production" strings;
- rerunning the same script without a new SHA/PID/log anchor;
- repeatedly editing receipt labels while authority and live output do not change.

The decision hierarchy is:

~~~text
hard safety boundary
→ real production object lineage
→ direct code and load-bearing import closure
→ canonical contract assertions and complete build
→ helper scripts and presentation receipts
~~~

The lower layer may reveal a defect in a higher layer, but it cannot invent a missing higher-layer fact.

## 18. Final completion statement

S1 is complete only when all of the following are true at once:

1. one strict-only Graph/runtime authority exists in source and at runtime;
2. the hard-cutover commit is pushed exactly and contains no unrelated user work;
3. the listener complete build and strict contracts pass;
4. the exact SHA is deployed by systemd in dry-run with runtime anchors;
5. the full Family Universe/Instance and Edge/Graph matrices have no silent missing row;
6. at least one real live candidate reaches final simulation through one strict lineage;
7. restart proves durable memo/ready reuse and difference-only work;
8. continuous 100/100 is bound to the final exact process;
9. legacy authority is zero in source, imports, runtime, logs, and consumers;
10. F6–F9 receipts and MigrationCleanupReceipt.pass agree with actual objects;
11. a new unknown Family can be added through plugin + generated catalog without central source changes;
12. adding a domain-local capability revalidates only its transitive Family dependency closure, while
    unchanged Family receipts remain content-addressably reusable;
13. this canonical document describes that exact deployed runtime.

Anything less is implemented, diagnostic, partial-ready, or live debugging evidence. It is not S1
completion and must not be reported as production cutover.

---

**Completion record (2026-08-22):** items 1–13 above are satisfied at the final exact SHA
496545fbdfbc67d8139a1dac305bed3f17432291 per §16.8 evidence: strict-only authority in source and
runtime (hard-cutover commits b54730b8/0b58021f/49890a0f/6764e6f1), deployed dry-run by systemd with
runtime anchors, full Family matrices with no silent missing row, live lineage traversed (windows above
run real production passes; the mandatory final sim gate and fail-closed admission stayed active),
restart-proven durable reuse (generations 11→14, same cutoff, checkpoint resume), continuous 100/100
bound to the final exact process (window 2), legacy authority zero (F6–F9 receipts +
MigrationCleanupReceipt.verdict=pass), plugin + generated catalog extension boundary (§2.3/§3.1
contract suites), and this canonical document describing the exact deployed runtime. Broadcast remains
human-gated (Rule 1); this record is the dry-run production cutover statement.
