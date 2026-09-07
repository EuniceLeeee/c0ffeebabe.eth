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
> duplicate-instance 与流式 checkpoint（efc6df7f/2aab991a/3ae1e427）。曾使用的 funding token
> universe 固化表（692c7bd7..5fc974ab）已经退役，只保留为对应 SHA 的历史证据。当前
> edge/candidate observation 窗口为 14400 blocks（2 天）；
> 不再存在 7 天 dormancy scan。新实例只由最近 2 天的链上 discovery 发现；所有既有 verified
> memo 通过其 fingerprint-bound `candidateSnapshot` 永久带回候选分区，且只有明确的
> `terminal-rejected` 原子撤销该 memo。memo snapshot 只是提名与复用材料，不是第二准入权威，
> 也不能扩张 2 天 source coverage。
> touched-driven 当前定价采用稀疏读取、稠密发布：只刷新本块触及的 state，完整 ready Graph
> 仍是快照与枚举输入；未触及 edge 只能按 §11.1 的 canonical activity proof 携带上一代安全价格，
> 不能被自动改写为 unresolved。旧 funding 固化表路径（45a01264）已由 §8 的 catalog
> observation → Funding Ready 取代；coarse pricing session 明确排除 Funding，source-N 与 exact
> session 通过显式 request API 传入各自的 Funding 集合。exact session 继承 coarse candidate 的
> 完整 edge closure（requiredEdgeIds），不再按 touched pool 截断，并对缺失 edge fail closed。
>
> exact SHA **496545fbdfbc67d8139a1dac305bed3f17432291** 是旧 Funding 表架构的历史验收锚
> （§16.8），不是当前 Funding Ready/blockscan replay slice 的终态验收；当前终态必须绑定本次
> exact-SHA rebuild、target-blind replay 与 dry-run 部署证据。

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
   candidate fingerprint, memo-scoped definition hash, proof policy, proof-source bound) first. A memo whose
   proof source is the exact same canonical number+hash as the fixed cutoff is reused with zero authority
   RPC even when bookkeeping has started a new run; only a newer cutoff performs chain authority
   revalidation (code/storage/blockHash RPC). Valid memo → reuse; otherwise attest. A previously fail-closed
   pool is re-adopted by a new Family only through a fresh chain proof (its old terminal outcome is keyed to
   the old Family and does not carry).

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

The first exact-SHA resume at `2c351197` then proved the storage path at production scale: it replayed the
existing base plus journal without rescanning, accounted all 23,990 candidates and left the 538,737,677-byte
base untouched while the journal grew by incremental records. Ready promotion nevertheless failed closed
because two retained candidate keys resolved to one `familyInstanceKey`; the completed partition contained
22,555 verified outcomes but only 22,554 unique verified instances. The one duplicate happened to be in
`curve-underlying`, but the defect was central and protocol-independent: the reusable-memo fast path wrote a
verified outcome without entering the same instance-uniqueness gate used by fresh attestations.

All verified paths now share one serialized `familyInstanceKey` claim. The first candidate remains verified;
a later alias becomes terminal `duplicate-instance`, and that terminal outcome removes only its duplicate
memo in the same durable write. The existing resume repair remains as crash/old-checkpoint defense, but a new
run no longer needs to fail once before repairing retained aliases. A regression starts with two valid
retained memos, distinct candidate keys, one instance key and no run outcomes; it proves zero lifecycle calls,
one verified outcome, one terminal duplicate, one active instance, `remainingUnaccounted=0`, and successful
Ready promotion. No Family ID, protocol, address, selector or topic branch was added. Exact-SHA checkpoint
recovery at `3f8db9da40c08d4cbcaf2617326960057270246c` then passed without deleting, replacing or rescanning the
checkpoint. The process appended only the duplicate repair delta, promoted generation 10 and compacted the
journal into a 524,906,882-byte base. Final state is: 23,990 accounted = 22,554 verified + 1,378 terminal +
58 retryable, `remainingUnaccounted=0`, `inProgressRun=null`, 22,554/22,554 memo snapshots present and
22,554/22,554 active instance keys unique. The independent retry queue contains 73 entries: the current run's
58 plus 15 candidates retained from earlier rolling runs. Node checkout, capture checkout and runtime commit
all equal the exact SHA under `SEARCHER_DRY_RUN=1`; the strict Ready Graph loaded 44,967 edges and blockscan
resumed on successive canonical heads.

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

Current-source refresh is atomic and block-cadence aware. It uses the sparse-read/dense-publication contract
defined in §11.1: the canonical activity/touched set controls refresh work only, while the complete ready
Graph remains the snapshot and enumeration input. A failed dirty refresh is an explicit unresolved result;
it is not silently replaced by a prior price. Funding refresh and final source/generation fences remain
fail-closed. Strict-session coalescing is in-flight-only: a settled session is never retained as a historical
cache entry. Creation telemetry reports pricing, Funding, route projection, total wall time, selected/failed
counts, and heap usage, but never relaxes a production gate.

The concurrency cap is a resource policy, not a Family contract. A Family plugin still issues its request
program; the kernel only schedules independent issued programs. Adding or changing an unrelated capability
closure therefore does not require revalidating Families that do not depend on it.

Funding discovery uses the same fixed-window rebuild as Swap and Protocol discovery, but projects into a
separate Funding Ready table rather than the routing Graph:

- the central scanner reads the union of plugin-declared observation patterns once over the canonical
  14,400-block window; a preflight may shrink this same production scan (for example to 100 blocks) but can
  never widen it, and a shortened run is not terminal acceptance evidence;
- each Funding plugin owns its FlashLoan event signature, trusted singleton emitter and token-field decoder;
  central code sees only a generic `familyId + asset` candidate and contains no lender/topic branch;
- the durable key retains the provider-Family/token pair across rolling windows, while the
  `dependency-proof` validity policy forces a fresh current-cutoff liquidity attestation on every rebuild;
- only a readable, positive current balance enters Funding Ready. Zero/unreadable liquidity remains
  retryable and cannot become a borrow offer or Graph authority;
- current-source refresh preserves `familyId -> assets[]`; it never queries every Funding Family for every
  other Family's observed token.

There is no external funding-token JSON, provider-deployment backscan, or graph-token balance sweep. Route
memos alone enter Graph construction; Funding memos participate in the same Ready CAS but are consumed only
by the Funding runtime projection.

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

### 11.1 Current-source pricing continuity

The current-source coarse publisher uses sparse reads and dense publication. A block's touched state-key set
is only the refresh set; it never defines the edge set or the candidate input. With no prior safe base, the
publisher takes the bootstrap branch and refreshes the complete ready pricing surface. Once a base exists,
each untouched edge may carry only when its canonical edge contract, Family id, Family stateKey, prior
resolved pricing provenance, and source-bound canonical activity proof all match. A touched refresh failure
remains explicitly unresolved and is never substituted with a prior price. Behavior-proven unavailable
remains a separate terminal category.

Every published coarse snapshot records the disjoint pricing partition
`refreshed + carried + unavailable + unresolved = expected`; degraded publication does not relax the final
fail-closed gate. Exact scope is derived from the complete canonical edge closure of the coarse candidates'
`seedEdges` through `requiredEdgeIds`. The exact session must contain every required edge and fails closed
when any required edge is absent; it does not use an independent touched-pool scope.

The ready generation also owns one static pricing index: route projection, Family ownership, state-key
identity, and the ready-edge contract are established once and reused across source generations. A steady
same-topology publication starts from the prior safe snapshot and applies only the current delta: refreshed
edges replace their mids, untouched compatible edges retain their prior mids, and a newly unavailable or truly
unresolved edge removes its old mid while publishing its new terminal classification. The resulting maps are
still dense over the complete ready pricing edge set and are equivalent to a full rebuild; sharing an
unchanged map is an allocation optimization, never a coverage or fail-closed shortcut. Bootstrap and topology
changes use full assembly, and all carry decisions still require the source-bound canonical activity proof and
the Family/state-key/edge-contract checks above.

### 11.2 Producer transport contract

Each coarse generation owns one source-hash-pinned `producer-bulk` call backend. Pricing `eth_call` work is
coalesced into physical JSON-RPC batches of at most 128 items, with at most four batches in flight. The
backend uses the shared Reth transport scheduler's producer-bulk lane when configured, keeps the EIP-1898
source hash on every item, and rejects a failed producer batch as a batch; it never expands that failure into
one single-call request per item. The backend is closed and drained before the generation's call statistics
are published. Exact refinement uses a separate exact-scoped backend and retains its own bounded fallback
policy. Producer batch count, item count, batch latency, scheduler queue wait, batch failures, and fallback
count are diagnostic telemetry only and cannot relax a deadline, coverage, or final fail-closed gate.

Exact refinement has a separate logical candidate limit,
`SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY` (default 128). This limit fills the existing source-hash-pinned
JSON-RPC batches; it does not create one HTTP request per candidate or raise the physical transport cap.
The same path is used for local reth and for a remote EIP-1898-capable RPC, with no provider-specific branch.
The accepted exact transport defaults are 64 items per physical batch and at most 16 exact batches in
flight. These limits are independent of the producer-bulk limit above and do not change block/pass/planner
scheduling.
The legacy `SEARCHER_BLOCKSCAN_MID_CONCURRENCY` name is accepted only as a compatibility input when the
explicit exact setting is absent. Runtime telemetry records the configured limit, the active limit and the
peak concurrent probe count alongside physical batch statistics, so logical fan-out and RPC pressure are
measured independently.
The per-candidate bound is independently configured by
`SEARCHER_BLOCKSCAN_EXACT_PROBE_TIMEOUT_MS` (default 4,000ms) and is always clipped by the pass-wide exact
deadline. A full pending batch is dispatched immediately; only the final partial batch waits for the
zero-delay coalescing flush. These scheduling rules change neither exact decoding nor fail-closed outcomes.

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
- every probe target owns and releases its resident simulation client in `finally`; a target-level transport
  exception leaves that key queued, does not terminate sibling workers, and makes the batch report failure only
  after all other selected targets have had a chance to commit their outcomes;
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

### 16.8 Historical final acceptance evidence (496545fb; superseded Funding path)

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

**Funding (§8):** the 496545fb historical run used a now-retired external funding-token table. That artifact
remains historical evidence for that SHA only and is not acceptance evidence for the current architecture.
Current acceptance requires the catalog FlashLoan observation -> Family/token candidate -> positive
current-cutoff attestation -> Funding Ready lineage from the same rebuild; pass prepare and blind prewarm
consume that Ready projection, never an external JSON or the routing graph's token set.

### 16.9 Coarse-pricing continuity acceptance (2026-09-02 RPC producer)

The current coarse-pricing contract is sparse read plus dense publication. The touched/activity set selects
only the instances refreshed at the new source; every compatible clean edge inherits its last validated mid
and provenance from the previous safe base. Each expected edge is exactly one of refreshed, carried,
behavior-proven unavailable, or genuinely unresolved, and the producer enforces
`expected = refreshed + carried + unavailable + unresolved` before publication. The first generation with no
previous base is the sole full bootstrap. Exact execution takes the complete canonical edge closure of the
coarse candidates through `requiredEdgeIds`; a missing required edge fails closed.

A local mainnet-RPC/revm producer run on 2026-09-02 (broadcast disabled: block-scan submit, backrun, mempool,
and MEV-Share all off) produced Ready generation 2 at cutoff 25889041 from a 14400-block scan: 17090
candidates partitioned into 15674 verified, 1300 terminal-rejected, and 116 residual retryable outcomes. The
route projection contained 15602 route instances and 31067 canonical edges; terminal and retryable outcomes
remained outside the Graph and did not block Ready publication.

The no-baseline bootstrap at source 25889095 selected all 15602 route instances, projected all 31067 edges,
and published 28839 priced edges. It took 99.689s and was not repeated. Catch-up and steady generations
25889096 through 25889110 selected only 6-49 touched instances per generation and skipped 15553-15596 clean
instances; observed strict coarse-session time was 171-606ms after bootstrap (generation wall time was
887-2808ms in the recorded catch-up slice), while every recorded generation continued to report
`priced=28839`, `expected=31067`, and zero producer issues.

For current heads 25889104 through 25889110, adjacent N-1 coarse snapshots naturally enumerated 465-470
candidates per block. Their current-N exact sessions selected the candidates' full closure of 926-936
instances and projected 1906-1926 required routes, with zero missing-edge rejection at session creation.
The measured blocks then hit the independent exact-refinement deadline before planner/final-sim, so this
window accepts coarse continuity and coarse-to-exact scope coupling only; it is not a six-stage
`production_gap_fixed` or broadcast acceptance claim.

A later RPC/revm live-submit window on the final 64-item exact transport tree (all four broadcast entrances
still disabled) recorded 25 consecutive steady N-1 blocks, 25889819 through 25889843. Exact refinement was
3.853s p50 / 5.335s p95 and the whole pass was 12.684s p50 / 13.378s p95; 4/25 passes were below 10s. The
coarse-state KPI accepted 26/27 non-warm periodic passes, with the remaining startup pass excluded because
enumeration did not run; no pass that ran enumeration had low or missing coarse coverage. A controlled
128-item comparison over 27 consecutive steady blocks reduced physical request count but regressed exact to
4.914s p50 / 5.685s p95 and whole-pass latency to 12.826s p50 / 15.347s p95, with zero batch failure or
single-call fallback. Commit `3837dac5` therefore restores the accepted 64-item default. The final tree for
the three reverted exact-batch files is byte-identical to the 64-item live tree. This is transport and coarse
continuity acceptance; the measured pass latency does not satisfy a sustained sub-10-second claim.

The same live startup reused the existing durable universe checkpoint. `resumed=false` means the prior
fixed-cutoff run had already promoted and no unfinished run remained; it is not a cache miss. The same line's
`retained=15982` records cross-run retained candidates. The next promotion produced Ready generation 8 at
cutoff 25889940 with all 17538 candidates accounted: 16133 verified, 1288 terminal-rejected and 117
retryable. A post-run read of the durable checkpoint reported revision 8134, 16133 verified memos,
`inProgressRun: none`, and the same 16133 active Ready instances. A future startup may freeze a new rolling
cutoff while reusing these memos; only an interrupted fixed run reports `resumed=true`.

### 16.10 Unified activity discovery and refresh (2026-09-07)

Commits `f97df59f`, `5377daf6`, and `5283154d` retain the coarse contract in §16.9 and establish:

- A rolling window (default 14,400 blocks) and explicit `--from-block`/`--to-block` are mutually exclusive
  range selectors for the same rebuild pipeline. Both obey the same maximum span and frozen cutoff;
  an unfinished run cannot be silently moved to another range.
- The catalog derives one activity plan from Family `logPatterns` and `callPatterns`. `eth_getLogs` and
  `trace_block` (with `debug_traceBlockByNumber` fallback) feed the same nomination, deduplication,
  identity, memo and Graph path. Both surfaces share one `catalog-activity-union` receipt. A log-only
  receipt cannot certify required call coverage; malformed/incomplete debug traces cannot seal a receipt
  or replace the prior Ready generation.
- Live refresh uses the union of log identities and nested call targets; singleton pool IDs remain
  log-derived. Trace transport/envelope/frame failures reject the read, not prove clean state. There is
  no new family-wide fallback, scheduler change, coverage threshold, or final-gate relaxation.
- Compatible verified memos remain reusable. Source-plan drift invalidates obsolete discovery coverage,
  not every unchanged memo. Once all candidates have verified/terminal/retryable outcomes, Ready may
  publish the verified partition; classified residual retryables remain outside Graph in the independent
  queue. The optional completed-Ready startup shortcut is dry-run-only and rejects an unfinished run.

The completed development rebuild `rolling-2d-unified-20260907T032835Z` covered
25908396..25922795 and accounted for all 31376 candidates: 28113 verified, 1859 terminal-rejected, and
1404 residual retryable. Ready generation 12 retained 28113 active instances; its pricing projection was
28004 instances / 55765 directed edges. The existing checkpoint was reused for subsequent observations;
no second two-day rebuild was needed. These inputs were produced by the development tree, including its
preexisting Family identity/probe changes, which are not included in the three commits above.

Development producer `82e241ff-7505-40ad-960b-9ab115315a38` (broadcast disabled) published a 49520-mid
baseline at 25924073. Reconstructing source 25924090 through two deltas retained 49520 mids across 14 of
20 pricing Families; that block updated 128 edges, enumerated 512 routes, entered Planner for 100 and
started Solver for 29. Final sim and EV were not reached before head supersession. This is development
coarse-to-exact/lifecycle evidence, not an exact-final-SHA or six-stage production-profitability verdict.

The isolated impl integration passes the listener build and the blockscan contract (8/8), strict production
runtime session (including refreshed A/carried B closed-loop enumeration and both-leg exact), strict Family
declarations, Ready runtime, checkpoint, rehydrator, rebuild production/runner/startup CLI, runtime defaults,
mid-history (4/4), and historical-production-replay contract tests. Independent reviews reproduced and then
verified rejection of malformed live and historical debug traces. The integration leaves the original
worktree's unrelated identity, simulator and queued-tail edits intact and uncommitted.

Final code `5283154d` was then run locally against mainnet RPC with the same completed Ready generation,
`SEARCHER_DRY_RUN=1`, blockscan submit off, and backrun/mempool/MEV-Share off. Its first baseline at
25924166 refreshed all 28004 pricing instances without failures and published 49518 mids. At source
25924181 only 31 instances were refreshed, 27973 were skipped as clean, and the history delta updated 60
edges. Offline reconstruction at 25924186 applied nine deltas to the same baseline and still contained
49518 mids across 14 pricing Families; that source naturally enumerated 512 routes, entered Planner for
100 and started Solver for 29. Exact sessions used the candidates' closure (1020 instances / 2104 routes
at 25924178), rather than the 39 refreshed instances. The mid table and route lifecycle were reconstructed
with the indexed `analysis:block-activity`; the complete retained timing log was also processed with
`analysis:blockscan-pass-latency`.

For source 25924186 the six-stage timing was state 8.732s, enumeration 1.565s, exact refinement 2.989s,
planner/solver 1.402s, final sim not reached, and EV not reached (14.688s total; new-head supersession).
Other recorded passes include exact-refinement deadlines and remain in the evidence. The earlier clean-tree
attempt at `5377daf6` failed local fork readiness and is retained as a failed attempt; it is not merged into
the successful restart's measurements. Both processes were stopped after their bounded observations.
These facts accept coarse continuity, required-edge scope and unified activity publication only, not a
sub-10-second timing claim, complete six-stage profitability, or the broader S1 completion statement below.

The final local artifacts are under `logs/unified-refresh-final-5283154d/` in the impl integration worktree.
The stopped log SHA-256 is `78c90c772b05f39922018ac538f762114278121dcdec906d5456748c1cfaef3d`;
mid-history SHA-256 is `9eb159001c2d9228a01d53e883eba552ae668d078fa425f69f4cbf1c4959276f`;
route-history SHA-256 is `a1549f12c696113f7de54ed25abafb33841c857d618c0dd1049c777c9639cce0`.
The diagnostic manifest `/tmp/unified-refresh-final-tools.json` records the executed tools and has
SHA-256 `795e0479b069aca0a68a06824d4658665f51ee94d7e21f15a56fdddf9b40ac5e`. Raw logs and secrets are not
committed. The external local revm binary used for this observation has SHA-256
`5fc6a63cc00875cbcdc8ee07cce1e0f9a26c945e72279be1b91f98f302af8c7e`.

### 16.11 Source-N background final-simulation fork contract (2026-09-07)

Runtime commit `ba30eff62a6cfa68d07ff631bc2e9bd1f5c5d28d` replaces the Source-N five-worker
execution barrier with pass-owned background preparation of the reserved final-simulation workers only.
With the observed configuration this means one fork, not four quote workers plus one final-sim worker.
Preparation starts alongside the source-N pricing/Funding session. Enumeration, Exact and quote-only
Planner/Solver do not await it; mandatory final simulation awaits its own worker immediately before use.
Startup price bootstrap starts no speculative execution forks; the N-1 path retains its existing lazy fork.

`blockscan-runtime-loop.ts` retains the existing `prepareBlockScanExecutionWorkerFork` source/hash and
optional infrastructure-install checks. Its pass-owned `startBlockScanBackgroundFork` captures failures at
launch, propagates cancellation, and drains/reaps interrupted, pending or failed work before the next pass
can reuse workers. Healthy completed workers remain reusable through `anvil_reset`. After the asynchronous
final wait, source/hash/generation, shutdown, cancellation and the final-sim deadline are checked again
before invoking the simulator. No candidate ranking, admission cap, block scheduling, deadline, Family
contract, final-sim decision or EV policy changed.

The optional coordinator `prepareExecution` API remains available to other callers. When absent,
`StrictCurrentRuntimeCoordinator.prepare` reports `executionMs=0`; it must not label pricing/Funding wait
as execution preparation. Terminal pass events additionally record background worker count, actual fork
durations/status, final-sim wait and cleanup time. Cleanup remains inside end-to-end timing. Zero final-sim
wait on a pass that never entered final simulation is not proof of a completed simulation.

The complete listener build and these existing contract suites passed: historical-live-production replay
contract, strict production runtime session, final-simulation work runtime, state-fork cancellation,
exact-refine deadline, blockscan contract, frozen topology and runtime defaults. Added regressions cover
nonblocking foreground progress, one preparation shared by final-sim intents, captured early rejection,
wrong-hash rejection before installation, cancellation/deadline/early-exit/retirement cleanup, and healthy
fork reuse. The independent non-author review ran TypeScript checking plus four of those suites and found
no issues in patch SHA-256 `f20ccc39363d1553da7c64e979880537e8acd675b4e8c9bc9c1120dadf2a1873`.
These tests include mocks and source-wiring assertions; they do not by themselves establish live latency
or a six-stage production result.

The local real-head RPC observation reused Ready generation 12, range `25908396..25922795`, cutoff hash
`0xc926d91e245b774742d6e8d5faf443373afa9080874e016e4cb29e2f46814a90`, without rebuilding or reattesting
instances. Startup retained 28,113 admitted instances, a pricing catalog of 28,004 instances/55,765 edges,
and the same Graph hash `8cd0c2df47c866d4e1dcb2c03fd3f0ba81695b0eaa92a28ab89de7adc4914c96`.
The checkpoint SHA-256 before and after restart was
`ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da`.
The existing dry-run Ready shortcut was used only to disable submission and reuse admitted instances;
price/Exact/Solver inputs still came from actual current mainnet heads. Backrun, mempool and MEV-Share
remained disabled. The original detached worktree's 70 pre-existing dirty/untracked entries were untouched.

The user's interim timing check froze log lines through 69,796 in
`logs/background-final-fork-ba30eff6/live.log`, run `8cae2b9a-45af-4079-b6af-ce6ee694dcd6`.
Startup source `25924609` took 136.253 seconds and is separate from the 21 consecutive non-bootstrap
passes `25924620..25924640`; the first post-bootstrap transition and every interrupted pass remain included.
Of these 21 passes, 17 entered Planner/Solver, versus 18/74 in the earlier fixed baseline window
`25924221..25924294` at `4c2d4bd1`. Source blocks differ: this is an early observational comparison,
not paired A/B evidence or completion of the longer 100-pass observation.

| Stage | Entered passes | Median seconds | Nearest-rank p95 seconds |
|---|---:|---:|---:|
| State preparation (activity + pricing/Funding) | 21 | 2.730 | 7.194 |
| Enumeration | 21 | 1.607 | 1.659 |
| Exact refinement | 21 | 2.802 | 4.001 |
| Planner/Solver | 17 | 6.139 | 10.097 |
| Final simulation | 0 | not reached | not reached |
| EV | 0 | not reached | not reached |

Stage timings include cancellation; the 17 Solver passes all ended at a new-head fence, while four passes
ended at Exact refinement. None completed all six stages. Pass lifetime to termination was median
12.617 seconds/p95 15.705 seconds, not successful end-to-end completion time. Actual Solver starts among
entered passes had median 58/max 92, with 100 planned candidates per entered pass. Background fork
preparation had median 3.849 seconds/p95 4.646 seconds; pass cleanup had median 4 ms/p95 9 ms.
All 21 passes prepared only worker 4; source-state preparation no longer waited for its completion.
The earlier fixed window's state-preparation median was 8.349 seconds.

After independent raw-log analysis, the current capability query
`single-block,production-events,state-coverage,latency` selected and executed
`analysis:blockscan-pass-latency` and `analysis:block-activity` through `tool-run` (both exit 0).
Manifest `/tmp/background-final-fork-current-tools.json` has SHA-256
`12f0721c434bc6f2d5c06687f1d197da883d7482a389801fd776f57c7d9773fc`.
The latency tool's all-record aggregate includes the bootstrap and unentered-stage zeros; the table above
uses the explicit non-bootstrap/entered-stage denominators instead. The activity join at target `25924641`
confirmed source `25924640` with 49,506 reconstructed mids, 512 enumerated routes, 100 Planner entries,
60 Solver entries and no final-sim event. Analysis was offline and made no extra RPC calls. The exact
runtime remained running with broadcasting disabled after this interim check; no six-stage or 10-second
acceptance claim is made.

### 16.12 Scanner local-compute reuse (2026-09-07)

The scanner retains at most one static topology index: pair membership, normalized edge identities,
stable edge order and numeric token IDs. Reuse requires the exact same ordered edge objects after the
existing per-pass coverage/eligibility filtering. Every retained edge, optional route binding and optional
V4 key must be frozen. Changed membership/order/object identity rebuilds the index; mutable inputs use
an uncached index. The index contains no mid, depth, eligibility decision, funding amount or return bound.

Each scan rebuilds priced edges and reverse-return bounds from its current resolved mids. Reverse bounds
use Float64 arrays with negative infinity for unreachable tokens, bounded to 8 MiB per scan; additional
anchors use sparse numeric maps without search pruning. Both retain the same stable edge order,
arithmetic and absorbing anchor. Outgoing lists inherit that order without a second sort. Open-path
validation checks the appended token against parent links, retaining the existing single non-funded
repeated-token/protocol-segment rule; full paths are materialized for completed rings. Candidate caps,
six-hop search, ranking, sizing, deadlines, scheduling, Exact, Solver and final-simulation/EV gates are
unchanged. No Exact result is written into mid.

`searcher:blockscan-scanner-index` compared 95 inputs against the pre-change scanner from
`d7a12e7c97c1c712558647fdcb8fba0b7d993443`, including current-price changes/removals, edge/route
eligibility, touched searches, reordered/mutable inputs and repeated-token/protocol controls. A
20,128-edge/128-touched-anchor control counted typed-array allocations, including row copies, and
verified the 8 MiB per-scan dense bound with unchanged output. Ordered
outputs, sizing seeds and counts matched. A 55,384-edge synthetic graph additionally matched all outputs
over 12 alternating before/after timing pairs. The recorded output hash is
`4501460d7210688e5b06ba8e39ef20d21b01030d3a764cbbcb635c2b126edbe0`.
Local artifacts remain under `logs/scanner-index-*`; these synthetic CPU results do not establish
live full-pipeline latency or a six-stage production pass. Existing scanner, production boundary,
strict production session, blockscan contract, Exact deadline, pricing-source, historical-live replay
contract, frozen-topology and bundle-router safety suites, plus the listener build, passed.

Runtime commit `c57ba6bfd55ae3331f04f852ee4dab46b2f89381` was independently reviewed. The review
identified excessive dense allocation for many touched anchors; the final implementation uses the
bounded dense/sparse contract above. The reviewer independently verified 140,000 dense/sparse bound
comparisons, a profitable sparse-fallback route and 6,763,008 dense bytes per scan in the resource control.
The final test asserts the memory limit separately for each candidate scan and rejects the reviewed
11,271,680-byte regression. Final three-file code/test patch SHA-256:
`740afdd9bf56b51deedf2bb9f687a39bef8340d066cb16f7fd6b43fae57f755e`.

The previous real-head process had already exited on an unhandled HTTP ClientRequest cancellation error;
its logs were preserved and this scanner patch does not claim to fix that transport issue. The first
restart failed before Ready loading because Anvil's system-proxy tunnel could not connect. A read-only
mainnet chain-ID request succeeded directly. A second restart excluded only loopback and the configured
RPC host from proxies for that process (no global proxy change) and reached Ready generation 12, cutoff
`25922795`, with the same 28,113 admitted instances and unchanged concurrency/deadline banner. Its local
evidence directory is `logs/scanner-index-ready12-c57ba6bf-attempt2/`; submission remains off. No Universe
rebuild or instance reattestation ran. Checkpoint SHA-256 remained
`ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da` before restart.

The first 50 non-bootstrap source heights were frozen as `25924888..25924937`, not the first
50 successful passes. All 50 have terminal timing and route-lifecycle records, with no missing or duplicate
source height. Startup at `25924875` took 150.941 seconds and is separate. The measured log ends at
line 144,018; later blocks and graceful shutdown are retained but not substituted into this window.

| Stage | Entered / 50 | p50 seconds | p90 seconds | p95 seconds | Max seconds |
|---|---:|---:|---:|---:|---:|
| Activity + pricing/Funding state | 50 | 2.045 | 3.059 | 3.985 | 6.762 |
| Enumeration | 50 | 1.581 | 1.783 | 1.898 | 2.113 |
| Exact refinement | 50 | 1.823 | 2.829 | 3.138 | 4.006 |
| Planner/Solver | 49 | 6.688 | 7.915 | 7.924 | 8.142 |
| Final simulation | 0 | not reached | not reached | not reached | not reached |
| EV | 0 | not reached | not reached | not reached | not reached |

49 passes ended at `source_head_superseded`, one at `exact_refinement_deadline`. Terminal lifetime was
p50 12.427 / p90 13.215 / p95 13.251 / max 13.955 seconds. Nine terminated under ten seconds;
none completed to EV, so the full-pipeline success rate is **0/50**, not 9/50. Planner admitted 100
per entered pass; actual Solver starts across the fixed window were p50 62 / max 100. The live enumeration
remained budget-censored near 1.5 seconds despite the synthetic speedup, so no live enumeration-latency
improvement is claimed from this window.

The offline source artifact is `logs/scanner-index-ready12-c57ba6bf-attempt2/first50-summary.json`.
Manual analysis was reconciled through current `latency,single-block,production-events,state-coverage`
selection and successful `analysis:blockscan-pass-latency` / `analysis:block-activity` executions.
The latency tool requires the process banner: slicing from the first timing record deliberately produced
no anchored records; rerunning lines `6..144018` bound runtime `c57ba6bf` and included bootstrap plus
50 passes. Its 51-record lifetime aggregate is distinct from the entered-stage table above, and its
`fast` property is not EV completion. `block-activity` at target `25924938` joined source `25924937`:
49,508 mids, 512 enumerated routes, 100 Planner entries, 100 Solver entries, zero final events.
Manifest `/tmp/scanner-index-first50-tools.json` after those executions has SHA-256
`8abc988272f555540beaa5e39a3965ada66829438ac7b9c90753c03a59a936e7`.
The task-owned Node/Anvil processes exited normally after SIGTERM; no confirmed HTTP 429 was found and
the checkpoint hash remained unchanged. These are unpaired observational results, not a Hermes A/B win.
This run retained the old `evGate=off` setting; it cannot establish a production EV-policy pass.

### 16.13 Bounded independent Solver grid probes (2026-09-07)

`solver.ts` evaluates independent grid amounts in batches of at most eight against the same pinned
strict session. The current five-point block-scan grid can therefore issue five amount probes concurrently
within each of the existing 16 quote workers; transport batch size/concurrency limits are unchanged.
Each amount's dependent leg propagation remains sequential. Results are committed in original grid order,
not reply order, preserving equal-profit tie breaking, failure attribution, best-observed amount, scored
candidate order and final-simulation fallbacks. Debt-BPS groups, GSS probes and finalist propagation/
plan construction remain sequential and unchanged. Wider and oracle grids retain every original point,
using further bounded batches. Abort/deadline controls remain attached to every nested quote; cancelled
work cannot launch another batch, dependent hop, plan build or deferred-candidate callback.

The pass-scoped pinned backend shares identical pending `eth_call` reads by its existing canonical
source-hash/to/data/from identity. Each waiter retains its own deadline and cancellation; one cancelled
waiter cannot reject a healthy peer. The last waiter removes the pending entry and aborts its logical
item. An in-flight HTTP envelope is aborted only when every sibling item is settled; no cancellation
falls back to new single calls. Failed/abandoned reads are not cached, and an older completion cannot
remove a replacement entry. Completed/durable cache hits check caller and scope controls first.
`eth_simulateV1` execution requests are not deduplicated by this change.

Independent review found that grid concurrency without pending-read sharing amplified a cold two-hop
control from two to ten RPC items despite identical results. The final regression uses the real solver
and backend queue/memo with only terminal transport mocked and requires both solvers to use two cold
items and zero warm items. A separate local HTTP suite verifies five duplicates share one physical item,
identity isolation, independent initiating/joining cancellation and deadlines, queued/in-flight last-waiter
abort and immediate retry, error non-caching, scope close/drain and cancelled/expired cache hits.

The local baseline is the unmodified solver from `b13f7200695b61fa856306c07208dfc09e13d3be`.
`searcher:solver-grid-quote-concurrency -- --baseline-solver <baseline-module>` passed 11 ordered-output
comparisons with forced out-of-order replies: ties, positive/negative/floor-admitted amounts, mixed and
first-/second-hop domain failures, multiple debt-BPS groups, capped/wide/oracle grids. Both implementations
also passed abort and absolute-deadline controls with non-cooperative late success/rejection. Amounts,
probe counts, exact-call counts, resolved plans, failure attribution and fallback ordering matched.
The existing 24-plan, 1/4/16-worker regression retained 72 deferred candidates and 576 exact calls.
The complete listener build, amount-search (21/21), strict production session, Exact deadline (4/4),
pass deadline (4/4), blockscan contract (8/8), bundle-router safety (6/6), search configuration (7/7),
and historical-live-production replay contract passed. These are deterministic local regressions,
not evidence that a live pass reached EV or met the ten-second goal.

The second independent non-author review cleared the cold-read amplification finding and executed the
solver/transport regressions, build/typecheck and strict runtime/cache/work-intent gates. Additional
independent controls verified scheduler-permit release, fallback cancellation and ignored abandoned late
completion. Reviewed code/package/test patch SHA-256:
`3b010de983a07d7b374e08159979da4eea420b087e222efa10c346f1d82690f2` (documentation excluded).
The user-directed iteration contract retains Ready12 and all search/transport limits, enables the existing
EV-policy gate for genuine EV decisions, and keeps signing/submission off. A fixed 50-source-block window
includes missing, cancelled, busy and timeout samples; a confirmed Alchemy 429/CU-throughput limit ends
RPC observation rather than triggering retry-through-throttling. EV-gate enablement is a separately
disclosed safety configuration difference, not a latency improvement attributable to this patch.

Runtime `beaf9f488fa9f76e41e98c5757433074db0c24a1` reused Ready12 with unchanged checkpoint
SHA-256 `ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da`. Its frozen
first 50 non-bootstrap source heights are `25925071..25925120`, with 50 terminal timing and
lifecycle records and no missing/duplicate heights. Startup source `25925064` took 104.048 seconds
and is reported separately. Evidence is in `logs/solver-grid-ready12-beaf9f48/`, run ID
`a4be68ce-2ce2-4948-9796-62f93ae4640b`; the measured log ends at line 148,154.

| Stage | Entered / 50 | p50 seconds | p90 seconds | p95 seconds | Max seconds |
|---|---:|---:|---:|---:|---:|
| Activity + pricing/Funding state | 50 | 2.434 | 4.214 | 4.567 | 9.279 |
| Enumeration | 50 | 1.670 | 1.849 | 1.927 | 2.054 |
| Exact refinement | 50 | 2.536 | 3.494 | 4.005 | 4.087 |
| Planner/Solver | 46 | 6.148 | 7.291 | 7.442 | 11.898 |
| Final simulation | 1 | 6.734 | 6.734 | 6.734 | 6.734 |
| EV | 0 | not reached | not reached | not reached | not reached |

Exact completed in 46 passes and failed in four. Four passes completed the Solver stage; the other
42 entered Solver stages failed. Decisions were 43 `source_head_superseded`, four
`exact_refinement_deadline` and three `blockscan_stale_state`. Terminal lifetime was p50 12.584 /
p90 13.882 / p95 14.276 / max 25.626 seconds; these mostly cancelled lifetimes are not successful
pipeline durations. Actual Solver starts were p50 61 / max 100; enumeration retained 512 and Planner
admitted 100 per entered pass. Full completion through EV under ten seconds remains **0/50**.

The one actual final simulation belongs to source `25925116`, hash
`0xb253493b986f24a6219065d3cf938612d4d3d4c3d1376fcd4d35a977ec6db616`, target `25925117`.
Route `0xb799f4c368c311410b876709d85f97abeb8087f8d60a26cc26f88d2114219cb4` returned
`simulation_result.ok=false` and `pipeline_dropped=final_verify:sim_revert`, then the pass became
stale. A final-sim `ran` marker therefore does not establish success or EV. Signing/submission stayed
off, the task-owned Node/Anvil stopped normally after the window, and no confirmed Alchemy 429 was
found. No rebuild or instance reattestation ran. Different blocks/network conditions and the separately
disclosed EV setting prevent a causal live speedup claim against the preceding window.

Manual analysis was reconciled with current `latency,single-block,production-events,state-coverage`
selection and successful `analysis:blockscan-pass-latency` / `analysis:block-activity` executions.
The latency report binds process-banner lines `6..148154` and contains startup plus 50 passes;
its 15 `fast` terminated lifetimes are not full EV completions. The single-block report at target
`25925117` joins 44,746 mids, 512 enumerated routes and the failed simulation above. Manifest
`/tmp/solver-grid-first50-tools.json` SHA-256 after execution:
`f35e3ac64efb70baf6614b030c19d58c21908b760c4e1dcfb3e71bcdefb8a9ee`.

An independent raw-event/source review reproduced both fixed-window timing/outcome distributions.
It also qualified the coverage denominator: all second-window snapshots were degraded, with
44,634–44,761 resolved prices out of 55,765 catalog edges; identical Ready12 does not establish
identical effective priced coverage. Raw enumeration was budget-censored in both 50-block windows.
The outer `ran`/`full_coverage` fields do not certify exhaustive enumeration or completed ranking.
These qualifiers prevent speed/coverage claims; they do not authorize reducing scope or loosening gates.
The review found zero recorded final-sim fork wait in all 100 passes; the remaining critical path is
quote search followed by the all-worker join and final simulation, not an upfront fork barrier.
Blockscan-only evidence says nothing about disabled mempool/backrun intake or market exhaustion.

### 16.14 Independent initial GSS pair (2026-09-07)

`goldenSectionMaximize` accepts an optional `evaluateInitialPair(c, d)` callback that returns scores
in original c/d order. The default evaluator remains serial for stateful callers. Solver alone opts
in with two independent pinned-session amount quotes and records their observations in c/d order after
both settle. Later GSS points remain dependent and serial, as do debt-BPS groups and finalist propagation.
Grid fan-out remains capped at eight; search brackets, evaluation counts, tolerances, ties, failure
attribution, ranking, candidate limits and final-sim/EV gates are unchanged. This removes one initial
dependency wave, not a search point. Existing nested deadlines/cancellation and same-key pending-read
sharing also cover this pair.

Against both the old serial solver (`b13f7200`) and the grid-parallel/GSS-serial solver (`beaf9f48`),
the existing concurrency regression passed 15 ordered-output cases and 12 grid/GSS cancellation cases.
Two-hop GSS dependency waves changed from eight to six with the same four search points. Negative
cold/warm transport counts stayed 2/0; the positive control with cold GSS keys stayed 4/0. The amount
search suite passed 22/22, including 13 default-serial/opt-in comparisons covering duplicate integer
probes, bounds, budgets, tolerance and stopping. Complete build/live typecheck, strict runtime/session,
exact cache, work-intent, state/fork cancellation, final-sim runtime, deadline, scanner-production,
pricing-source, search-config, blockscan/bundle safety and historical-live replay contract suites passed.

Independent non-author review approved the unchanged four-file code/test patch, SHA-256
`4bd9712f0558bc0b2035c801d53162e67f6922e8ca81341cc02708b61976f1ba` against
`6675a8ed3298449d024eeb2ae21d46c82e4fc728` (documentation excluded). The reviewer reran both baseline
modes, amount search, typechecks and relevant runtime/transport gates, plus 14,400 helper comparisons,
162 solver comparisons and four partial-pair cancellation controls. This is offline equivalence/resource
evidence, not a live latency win or a production six-stage result.

Runtime `c1f475d6a478665ee308d42acd687490610e872e` then reused Ready12 without rebuild or
reattestation. The checkpoint SHA-256 stayed
`ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da` before/after the run.
Startup source `25925217` took 144.657 seconds and is separate from the fixed first50
`25925229..25925278`. All 50 heights have one timing/lifecycle record, no missing/duplicate heights;
log boundary is line 148,793. Artifacts: `logs/solver-gss-ready12-c1f475d6/`, run ID
`cc4c33fd-e9c4-4845-bcde-0a20b29e9412`.

| Stage | Entered / 50 | p50 seconds | p90 seconds | p95 seconds | Max seconds |
|---|---:|---:|---:|---:|---:|
| Activity + pricing/Funding state | 50 | 2.516 | 3.634 | 5.813 | 8.554 |
| Enumeration | 49 | 1.566 | 1.676 | 1.784 | 2.096 |
| Exact refinement | 49 | 2.519 | 3.780 | 4.001 | 4.007 |
| Planner/Solver | 46 | 5.671 | 7.336 | 7.439 | 10.416 |
| Final simulation | 1 | 6.398 | 6.398 | 6.398 | 6.398 |
| EV | 0 | not reached | not reached | not reached | not reached |

One state stage failed; Exact completed 46 and failed three; Solver completed two and failed 44.
Actual Solver starts were p50 55 / p95 and max 100, with the same 512 enumeration / 100 Planner
limits. Completed Solver sources were `25925230` (9.061s Solver, 17.206s terminal) and `25925245`
(7.336s Solver, 20.923s terminal). Only the latter entered final sim, which reverted; no EV occurred.
Timing decisions were 45 `source_head_superseded`, one `blockscan_stale_state`, one `sim_revert`
and three `exact_refinement_deadline`. Terminal lifetime was p50 12.673 / p90 13.992 / p95 17.028 /
max 20.923 seconds. The 16 sub-ten-second lifetimes are failures, not complete passes: full EV
completion remains **0/50**. Local GSS equivalence does not imply a live systemic speedup; the windows
have different blocks, pricing completeness and interruption points.

The task-owned Node/Anvil stopped normally at the fixed boundary, with no confirmed Alchemy 429.
EV stayed on; signing/submission stayed off; no feature or configuration scope was reduced. Offline
manual analysis was reconciled through current `latency,single-block,production-events,state-coverage`
selection and successful `analysis:blockscan-pass-latency` / `analysis:block-activity` executions.
The latency tool binds process-banner lines `6..148793` (startup plus 50); its `fast` flag is not EV
success. Target `25925246` joins source `25925245`, 49,487 mids, 512 routes, 100 Planner and Solver
entries and one failed simulation. Manifest `/tmp/solver-gss-first50-tools.json` final SHA-256:
`0a64bf6be2887ea23ad111b32b574326c887d81ac89f19ee891917cf7d00358a`.

### 16.15 Reuse searched exact authority for finalist construction (2026-09-07)

Each scored Solver amount retains its existing `PropagatedAmounts`: spendable amounts, raw outputs and
session-issued sealed exact handles. Finalist construction consumes that same solve/session's result
instead of issuing the identical leg quotes again. There is no cross-solve or cross-block cache and
no reduction of grid/GSS points, candidate ranks, debt-BPS groups, funding alternatives or mandatory
final simulations. `StrictProductionRuntimeSession.buildExecution` checks its runtime generation fence
before consuming a retained handle, preserving the current-source check previously supplied by the
repeated `issueExact`; existing same-session/route/executor/evidence authority checks remain enforced.

The removed operations are duplicate exact issuance, not search coverage. RPC caches already absorb
some duplicate calls, so lower logical exact-call counts alone do not establish an equal reduction in
physical RPC traffic or live wall time.

The frozen pre-change solver is `c1f475d6`; older `b13f7200` and `beaf9f48` comparisons also pass.
The existing regression now verifies 17 ordered-output cases, 16 cancellation cases, three actual
solver final-simulation/funding-fallback cases, and isolation when the same solver/session is used for
another solve. Three two-hop finalists retain all nine searched amounts while exact issuance decreases
24→18. The 24-plan concurrency control retains 72 candidates at 1/4/16 workers and decreases duplicate
issuance from 576 to 432. Search-issued handle identity, safety-haircut amounts, all funding alternatives,
plan outputs and fallback order are checked; no finalist reissuance or late build/publication is allowed.
The real strict-session regression verifies identical execution output without another pricing read,
rejection after generation retirement, and unchanged forged/foreign-handle rejection.

The complete build/live typecheck, amount search (22/22), strict runtime/session/cache/work-intent,
transport, state/fork cancellation, final-sim runtime, Exact/pass deadlines, blockscan/bundle safety,
scanner-production, pricing-source, search configuration and historical-live replay contract suites
passed. These remain local equivalence/resource/safety checks, not full-pipeline live acceptance.

Independent non-author review approved six-file code/test patch SHA-256
`38c3a7077e6c6bf1629b31e83b4573ac7f398a69e05cc8c77c257ca83ae6cc36` against
`4d73a4ec8124700648c0e4f130fab7417178d492` (documentation excluded), after independently executing
all three baseline modes, amount/concurrency/strict-session tests, typechecks and strict consumer,
execution-projection, family and credit-runtime controls. Its separate GC control found all 648 issued
test handles collectible after solve completion. Retention is proportional to admitted search points
times hops during a solve; it is not claimed to be free, constant-memory or a persistent result cache.

Runtime `e982ce0becdbe19e69bb4965f66156c1f8275f91` reused Ready12 with unchanged checkpoint
SHA-256 `ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da`. Startup
source `25925361` took 166.435 seconds. The fixed non-bootstrap window is `25925374..25925423`,
50 timing/lifecycle records with no missing/duplicate heights, log end line 156,676. Evidence directory
is `logs/solver-reuse-ready12-e982ce0b/`, run ID `fee41377-7943-4ad3-9f2f-96b3431cbfbc`.

| Stage | Entered / 50 | p50 seconds | p90 seconds | p95 seconds | Max seconds |
|---|---:|---:|---:|---:|---:|
| Activity + pricing/Funding state | 50 | 2.319 | 4.488 | 5.172 | 14.270 |
| Enumeration | 49 | 1.655 | 1.909 | 1.938 | 2.082 |
| Exact refinement | 49 | 2.696 | 3.744 | 4.001 | 4.090 |
| Planner/Solver | 45 | 6.299 | 7.182 | 7.805 | 8.816 |
| Final simulation | 0 | not reached | not reached | not reached | not reached |
| EV | 0 | not reached | not reached | not reached | not reached |

One state stage failed, Exact completed 45 and failed four, Solver completed two and failed 43.
Actual Solver starts were p50 60 / p90, p95 and max 100. The two completed Solver stages at
`25925398` and `25925421` took 8.236/8.816 seconds, but their passes were already stale at
17.062/17.063 seconds. Decisions were 44 `source_head_superseded`, four
`exact_refinement_deadline` and two `blockscan_stale_state`. Terminal lifetime was p50 12.525 /
p90 14.249 / p95 14.433 / max 17.063 seconds. Sixteen short terminated lifetimes are not successful
passes; full EV completion remains **0/50**. The same search/candidate/transport configuration and
EV-on/submission-off posture were retained; no rebuild/reattestation or confirmed Alchemy429 occurred.
The task-owned processes stopped normally after the boundary. This unpaired window does not establish
a live latency win for the proven duplicate-work removal.

Manual analysis was reconciled through current `latency,single-block,production-events,state-coverage`
selection and successful `analysis:blockscan-pass-latency` / `analysis:block-activity` executions.
Process-banner lines `6..156676` bind startup plus 50; `fast` still means terminal lifetime, not EV.
Target `25925424` joins source `25925423`, 49,485 mids, 512 routes, 100 Planner / 60 Solver entries
and no final event. Manifest `/tmp/solver-reuse-first50-tools.json` final SHA-256:
`7a0b7123079d934414e3e5b2ae571a8785578ab90b9ba590890d8adaac54e9ac`.

### 16.16 Cancelled 32-worker quote configuration experiment (2026-09-07)

The proposed process-local `SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY=32` experiment was cancelled
before live execution after the user prioritized structural optimization over numeric tuning. No
configuration, default or global environment was changed; quote concurrency remains 16. The two
uncommitted experiment-only test changes were preserved under ignored logs and removed from the worktree.
There is no quote32 live window or performance verdict. Subsequent work investigates repeated computation,
same-state reads and unnecessary waits while preserving the Ready12 universe, complete search/admission
contract, final-sim/EV gates and fixed first50 denominator. Confirmed Alchemy429 remains a hard stop.

### 16.17 Same-pass Source-N Funding read reuse (2026-09-07)

The Source-N producer transport now lives through its own pass. Preparation still uses the existing
per-work settlement deadline and drains all queued/active requests before enumeration, but does not
close the transport's successful `eth_call` memo at that boundary. The exact session receives a
cache-only view after equality of source number, block hash and generation is checked.
It freshly issues Funding receipts/offers and exact route authority; it does not reuse an old session,
opaque handle or cross-block dynamic state. Exact quotes retain their separate exact transport.

This removes an observed duplicate dependency: the Source-N pricing session prepared 91 Funding
assets, then the exact session reread its candidate subset of four. In source blocks 25925422/25925423
of §16.15, the latter Funding preparation took 455/633ms. Those samples identify existing repeated
work, not a predicted or measured candidate speedup. Successful identical requests can hit the existing
memo; missing, reverted and cancelled results are not promoted to successful cached reads. Cache misses
retain the prior direct provider, retry and scheduling path, rather than entering producer batching.

The producer lane and batching limits remain unchanged. Preparation failure aborts and drains the
backend immediately; every pass exit closes/drains both backends before terminal timing is recorded.
Parent cancellation, caller deadlines and final-sim/EV checks remain active. The backend's outer
lifetime covers the pass, while each preparation request retains the prior phase deadline. Startup
keeps its existing independently bounded runtime deadline; N-1 has no reuse path into current-N.
One final aggregate producer-transport record exposes memo hits and zero-in-flight cleanup; no
per-route heavy telemetry or additional diagnostic RPC is introduced.

This is a structural duplicate-read removal, not a concurrency/configuration experiment. Ready12,
candidate/search scope, ordering and block scheduling stay fixed. Its live result must be recorded
separately over the next first50 source-block window; it is not yet a full-pipeline timing verdict.

Offline verification: the existing backend suite passed all 33 named checks, including non-closing
partial-batch/active-transport drain, successful cache-only lookup, pending/missing/failed isolation,
phase deadlines, new-head cancellation and final cleanup. The existing strict-session suite exercised
real central issuance against a local HTTP stub: pricing read four Funding balances plus one reserve;
the exact subset made zero Funding RPC items and issued fresh equivalent offers/roots; its exact quote
made one call on the separate exact backend. Empty/reverted cache entries kept two direct provider
reads each. These are local equivalence/resource assertions, not on-chain performance evidence.

`npm run build`, `npm run build:live`, `tsc --noEmit`, strict production session/central runtime,
Funding runtime, adapter work intent/exact cache, amount search, solver quote concurrency/config,
state-call/fork/pass deadlines, final-simulation runtime, exact refinement deadline, scanner production
boundary, pricing-source mode, blockscan contract, strict solver/execution consumers, Family runtime,
bundle-router safety and historical-live-production-replay contract checks passed. No numerical
configuration, instance validation, checkpoint or broadcast setting changed.

Independent non-author review approved the seven-file listener patch against
`45789d4f1455cdd4d756783e7b2a1403b2330d3a`, excluding this document. Binary/full-index patch SHA-256:
`ce8736e8409ea571f987e5d294d6e58d6a39d3199c06a86e8d1b2b07bacbcaec`.
The reviewer reran backend, strict-session/central, pass-deadline, live build and TypeScript gates,
plus held-permit miss/retry/mixed-request and lifecycle controls. The initial whole-backend injection
was rejected because it changed cache-miss scheduling; the final cache-only interface resolves that
finding. Approval is offline scope/equivalence approval only.

**Ready12 fixed50 observation.** Runtime `0c1e2d098f51dd57d6ef802fdb458be8b2375385`, run
`a7a6cf65-cc84-43d4-b06b-f84de58cdefb`, source window **25925573..25925622**, frozen end line
165497 of `logs/funding-reuse-ready12-0c1e2d09/live.log`. Bootstrap source 25925565 took 93.010s
and is separate. The window has 50 timing and 50 lifecycle records, no missing/duplicate blocks.
Ready12 checkpoint SHA remains `ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da`;
Graph/catalog hashes and configured work limits are unchanged. EV was on; signing/submission off.

| Stage | Entered / completed | p50 s | p90 s | p95 s | max s |
|---|---:|---:|---:|---:|---:|
| State/activity + pricing/Funding | 50 / 50 | 2.332 | 3.307 | 4.195 | 8.702 |
| Enumeration | 50 / 50 | 1.571 | 1.654 | 1.802 | 2.031 |
| Exact | 50 / 48 | 1.533 | 2.320 | 2.452 | 3.064 |
| Planner/Solver | 48 / 18 | 6.708 | 7.419 | 7.608 | 7.974 |
| Actual final sim | 0 / 0 | — | — | — | — |
| Production EV | 0 / 0 | — | — | — | — |

Stage distributions include every entered stage, including failure/cancellation; a completed outer
enumeration stage is not a claim of exhaustive uncensored search. Solver-start count p50/p90/p95/max
was 100. Terminal lifetime p50/p90/p95/max was 12.544/14.027/14.658/18.503s. Twelve shorter cancelled
lifetimes were below ten seconds; **complete EV passes and complete EV passes under ten seconds both
remain 0/50**. Decisions: 35 `source_head_superseded`, 13 `blockscan_stale_state`, two Exact deadlines.
The stale pre-sim guard verifies the uncached current head/hash; it is not a simulated revert.

All 50 exact sessions spent 2ms p50, 4ms p95 and 5ms max in Funding; each pass recorded eight added
successful memo hits, zero additional producer RPC items and zero pending/live/in-flight transports
after cleanup. The previous §16.15 window's 49 exact sessions spent 279/671/999ms in Funding at those
percentiles. Exact-session total p50/p95 changed from 1087/1859ms to 270/376ms. These are unpaired
observations, not a claim that memo reuse caused every elapsed-time difference. Likewise the observed
45→48 Solver-entered and 2→18 Solver-completed block counts are not a paired A/B win: the current
priced coverage was 39,806..39,982 of 55,765 edges, versus approximately 49.5k in §16.15. No configured
Graph/Family/candidate scope was reduced, but actual resolved coverage was not equivalent.

The first50 guard normally stopped Node29738 at 1788785871902; Node29738 and its Anvil29765 exited,
both live/guard sessions returned zero, and no confirmed Alchemy429 occurred. The immediately following
shutdown record is outside the frozen denominator. Logs/checkpoint were retained, not committed.
Canonical offline reconciliation ran `analysis:blockscan-pass-latency` and `analysis:block-activity`,
both exit0, selected using `latency,single-block,production-events,state-coverage`. The latency tool's
process-bound view includes bootstrap plus fifty (51 records); its twelve `fast` terminals are not EV
successes. Activity target25925623 joins source25925622: 39,982 mids, 512 enumerated routes, 100 Planner
and 85 Solver entries, no final events. Manifest `/tmp/funding-reuse-first50-tools.json` SHA-256:
`2a468987515bca8df308bab9f67b2bb955d260889b07f396b55e13cc7785f648`.

The subsequent definition-cache investigation was deferred without a runtime change. The actual
23-plugin catalog took 429ms wall / 482ms process CPU for 11,500 warmed assertions. Independent
adversarial inspection found accessor/prototype/post-wrap lineage cases that a simple frozen-object
shortcut would stop rejecting. This microbenchmark does not justify adding a new immutability
validation framework. Repeated execution-body construction was also deferred: the real strict
two-leg fixture measured approximately 0.20ms duplicate CPU per solve (three finalists, two Funding
alternatives), not the seconds suggested by summed asynchronous `planBuildMs`.

### 16.18 Independent Funding Family reads share the existing transport wave

Baseline is `806c2534a42cfb22fba3365da36bd4b1eee5f49a` (runtime §16.17). The only production change is
the Funding loop in `StrictProductionRuntimeRoot.createSession`: discover the same nonempty
Family/asset work in catalog order, dispatch independent source-pinned reads together, await all
settlements, then assemble offers/outcomes in the original order. A rejected Family work promise is
propagated in catalog order only after sibling work settles. The existing central per-source failure
isolation, generation/control checks and fresh Funding authority remain unchanged. Physical
transport cancellation/drain continues to belong to the pass backend; settling a Family promise
is not a substitute for transport drain.

Pricing still finishes before Funding. No block/head/solver scheduling, candidate/ranking/amount
scope, numerical configuration, retry policy, exact cache-miss path or final sim/EV gate changes.
This removes a dependency between independent Family reads; it does not add a provider-specific
API or bypass the existing batch/transport limits. Actual live effect remains to be measured.

The existing strict-session regression now holds both real Funding plugins at transport and releases
them in reverse order, checking unchanged offer order and roots, one-provider failure isolation,
stale generation, abort, and settlement. Against the unchanged baseline session implementation the
same overlap assertion fails (`Funding families still serialize`); the candidate passes. Its local
HTTP fixture retains all five physical items (one reserve, four Funding) but now sends two batches
(one pricing, one shared Funding), rather than three serialized Family-separated batches. This is
deterministic dependency/resource evidence, not a live ten-second verdict.

`build`, `build:live`, strict production/central sessions, Funding runtime, adapter work, pinned quote
backend, pass deadline, production scanner boundary, strict solver consumer, solver quote-concurrency,
amount search (22/22), final-simulation runtime, bundle-router safety (6/6), and historical-live
production-replay contract pass. The next live uses the unchanged Ready12 checkpoint SHA
`ba97aec00cb62ae01e18b22b995986f82ed3dbd6dfb6a1f2274966d32f99b9da`, first fifty consecutive
non-bootstrap source blocks, EV enabled and signing/broadcast disabled. Cancelled/missing/stale
passes remain failures in the fixed denominator; confirmed Alchemy429 stops task RPC.

Non-author review approved after independently running strict-session, central/Funding/backend
tests, TypeScript and diff checks, including a held-transport control confirming that explicit drain
is still required. Reviewed two-listener-file `git diff --binary` SHA-256:
`2699fb62fe03d30f86e4e3bafcc0a482bd33cc95be5f0653a3f1fdd5a983fbe2`
(`--full-index`: `c23c154517d4c31aeeef8881490516d9ede96f1eb23c1f1e36025d23e33823a3`).

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

**Historical completion record (2026-08-22):** items 1–13 above were satisfied at exact SHA
496545fbdfbc67d8139a1dac305bed3f17432291 per §16.8 evidence: strict-only authority in source and
runtime (hard-cutover commits b54730b8/0b58021f/49890a0f/6764e6f1), deployed dry-run by systemd with
runtime anchors, full Family matrices with no silent missing row, live lineage traversed (windows above
run real production passes; the mandatory final sim gate and fail-closed admission stayed active),
restart-proven durable reuse (generations 11→14, same cutoff, checkpoint resume), continuous 100/100
bound to that exact process (window 2), legacy authority zero (F6–F9 receipts +
MigrationCleanupReceipt.verdict=pass), plugin + generated catalog extension boundary (§2.3/§3.1
contract suites), and this canonical document describing the exact deployed runtime. Broadcast remains
human-gated (Rule 1). The Funding source used by that SHA is now retired; this historical record cannot
certify the current §8 Funding Ready implementation or the current blockscan/V4 replay objective.
