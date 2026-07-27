# Codex Reth State-Change Feed Plan

> Status: deferred architecture note. This document freezes the direction for a
> later latency project; it does not authorize implementation, deployment, or a
> change to the current V2/V3/V4 runtime.
>
> Baseline: `origin/main @ c38c19cef56867215616c4a1c8ac5d3b4559cb64`
> (2026-07-27).

## 1. Decision

Keep the current V2/V3/V4 canonical mutation-log optimization. When this work
becomes a priority, converge toward a central, reth-adjacent state-change feed:

```text
reth canonical block execution
        ↓
canonical account/storage state diff
        ↓
CanonicalStateChangeFeed
        ↓
family-owned dependency and state-key classification
        ↓
BlockScanStateCoordinator
        ↓
local state mirror / current-block reads
        ↓
local quote and final simulation
```

The target is **write-set/state-diff driven state**, not “the pool was called in
this block”. A call set is not a completeness proof:

- an internal or external call may be read-only;
- a pool price may change through an oracle, rate provider, token or protocol
  singleton without calling the pool address;
- V4/Balancer-style singletons need storage-key or event-level pool identity,
  not only an emitter address;
- tracing all calls is more expensive than consuming execution output and still
  does not directly provide the new state values.

Logs remain useful for cheap attribution and opportunity triggering. They do not
need to remain the only state-change proof once a complete canonical state-diff
feed exists.

## 2. What `fuzzland/sui-mev` actually does

This review pins the public repository's default `master` commit
[`462bb2b24caec403da62f9ce8104039fbd30a3fa`](https://github.com/fuzzland/sui-mev/tree/462bb2b24caec403da62f9ce8104039fbd30a3fa)
and its patched Sui dependency
[`suiflow/mevsui@7c6a455adbdfce4bf1625ecc5182f80b70ad5318`](https://github.com/suiflow/mevsui/tree/7c6a455adbdfce4bf1625ecc5182f80b70ad5318).

Its data path has four separate responsibilities:

```text
PoolCreated events + cursor
        → pool topology cache

fullnode transaction execution
        → actual written objects
        → Unix socket
        → local WritebackCache

transaction effects + recognized Swap events
        → opportunity trigger

candidate paths
        → local Move VM simulation
```

### 2.1 Topology is not live pricing state

`DexIndexer` loads a token/pool directory, backfills PoolCreated events, then
polls the per-protocol cursors. The directory contains pool identity and static
metadata; it does not maintain reserves, ticks or current prices.

Source:
[`crates/dex-indexer/src/lib.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/crates/dex-indexer/src/lib.rs#L32-L79).

### 2.2 The latency mechanism is the execution write-set

For each non-system transaction, the patched fullnode examines
`transaction_outputs.written`. If at least one written object ID appears in
`pool_related_ids`, or one written object has the single configured
`ObjectOwner`, it sends that transaction's complete written-object set to
connected simulators. This is not a general match for every owned object or
every address-owned object. Each simulator replaces the delivered objects in
its local `WritebackCache`; objects not delivered naturally retain their
previous cached versions.

Sources:

- [`authority.rs`](https://github.com/suiflow/mevsui/blob/7c6a455adbdfce4bf1625ecc5182f80b70ad5318/crates/sui-core/src/authority.rs#L1642-L1701)
- [`cache_update_handler.rs`](https://github.com/suiflow/mevsui/blob/7c6a455adbdfce4bf1625ecc5182f80b70ad5318/crates/sui-core/src/cache_update_handler.rs#L15-L111)
- [`db_simulator/mod.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/crates/simulator/src/db_simulator/mod.rs#L569-L607)

This is whole-object state-diff plus persistent carry-forward, not a
protocol-specific Swap-event reserve updater.

### 2.3 Events trigger search; they are not the state truth

The node separately sends transaction effects and events. The strategy recognizes
known Swap events, extracts a coin and optional pool ID, and inserts a potential
search into `ArbCache`. That is not a trigger-to-worker delivery guarantee:
five-second cache expiry, recent-coin deduplication and a bounded drain from the
cache can discard or delay work before a worker searches it. The current public
path can also refresh cached state for a watched non-Swap write without
launching an opportunity search.

Sources:

- [`collector.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/collector.rs#L39-L109)
- [`strategy/mod.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/strategy/mod.rs#L98-L169)
- [`arb_cache.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/strategy/arb_cache.rs#L67-L183)

### 2.4 Quotes are local executions

The bot reads current objects from the local cache, builds the real programmable
transaction and executes it in a local Move VM. Its default CLI configuration
provides eight workers and 32 simulators. This removes per-candidate remote
state RPC from the DB-simulator path.

Sources:

- [`start_bot.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/start_bot.rs#L83-L113)
- [`defi/mod.rs`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/defi/mod.rs#L46-L94)

The repository does not publish a controlled before/after latency benchmark, so
the mechanism is clear but a quantitative performance claim is not established
by the public source alone.

## 3. Comparison with current `main`

Current `main` already implements the safer EVM-specific first stage:

- `BlockScanStateCoordinator` is the only lifecycle coordinator;
- V2/V3/V4 may opt into `IncrementalStateCapability`;
- the backend proves a canonical block/log range;
- the family synchronously classifies affected state keys;
- changed keys receive current-source reads;
- unchanged keys carry the previous snapshot with a current-block freshness
  proof;
- missing, ambiguous, non-contiguous or failed evidence causes full direct
  current-source fallback for that family.

| Concern | Current EVM implementation | `sui-mev` |
|---|---|---|
| Topology | active-pool and family discovery | PoolCreated event directory |
| Change proof | canonical mutation-log range | actual written-object stream |
| Changed state | current-source direct read | pushed replacement object |
| Unchanged state | explicit carry-forward proof | object remains cached |
| Quote | family math/exact quote/final sim | local Move VM execution |
| Reorg/gap handling | source hash, continuity and fail-closed fallback | no equivalent end-to-end proof |
| Extensibility | registry and family capability | central protocol lists/matches |

The two approaches are compatible. A future state-diff feed should become
another backend proof/data source behind the existing coordinator, not a new
per-protocol warm coordinator and not another switch in `main.ts`.

## 4. Target boundary

### 4.1 Central feed

The eventual provider should expose an ordered canonical range, conceptually:

```ts
interface CanonicalStateChangeFeed {
  readRange(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: { deadlineAtMs: number; signal: AbortSignal },
  ): Promise<CanonicalStateDiffRange>;
}

interface CanonicalStateDiffRange {
  fromExclusive: BlockSource;
  through: BlockSource;
  blocks: readonly {
    number: number;
    hash: string;
    parentHash: string;
    diff:
      | {
          kind: "block-final";
          accountWrites: readonly AccountWrite[];
          storageWrites: readonly StorageWrite[];
          deletions: readonly StateDeletion[];
        }
      | {
          kind: "transitions";
          transitions: readonly {
            ordinal: number;
            origin:
              | {
                  kind: "transaction";
                  transactionIndex: number;
                  transactionHash: string;
                }
              | { kind: "pre-block-system" }
              | { kind: "post-block-system" }
              | { kind: "withdrawal"; withdrawalIndex: number };
            accountWrites: readonly AccountWrite[];
            storageWrites: readonly StorageWrite[];
            deletions: readonly StateDeletion[];
          }[];
        };
  }[];
  rangeFingerprint: string;
}
```

Block-final diffs are sufficient for the first dirty-set optimization. Per-
transaction transitions are required only when a separately proven trigger,
ordering or diagnostic contract needs them. Withdrawals and protocol-defined
pre/post-block system transitions remain part of canonical state even though
they have no transaction index.

The exact TypeScript/Rust boundary is intentionally undecided. The contract,
not this sketch, is the frozen part.

### 4.2 Family-owned semantics

Existing adapter families remain responsible only for protocol meaning:

```ts
interface StateDiffClassifier<Schema> {
  dependencies(input: {
    schema: Schema;
    edges: readonly TokenEdge[];
  }): DependencySurface;

  classifyStateDiff(input: {
    schema: Schema;
    edges: readonly TokenEdge[];
    range: CanonicalStateDiffRange;
  }): FamilyMutationClassification;
}
```

The default case may map one pool address to one state key. Special families
override only what is special:

- V2/V3: pool-address writes can identify the pool, while token/factory
  dependencies remain explicit;
- V4: PoolManager storage changes require storage-key-to-poolId attribution or
  retained event attribution; marking every V4 pool dirty on any Manager write
  is correct but loses the latency benefit;
- Curve/DODO/Balancer: declare pool, vault, rate-provider and oracle dependency
  surfaces;
- protocol conversion: declare vault/token/oracle/rate dependencies and treat
  an unresolved dependency as direct-read or unresolved, never as unchanged.

Registration must remain the only central integration point. Adding a family
must not add a family-name branch to `main.ts`, the coordinator, planner or
solver.

## 5. Reliability contract

Any EVM version must be stronger than the public Sui implementation in these
areas:

1. Every diff is bound to block number, block hash and parent hash. Ordered
   transitions additionally bind an ordinal and origin; only transaction
   origins require a transaction index and hash.
2. Applying state and publishing search work has an explicit barrier: the
   scanner cannot observe a block before its state diff is committed.
3. Node execution must not synchronously await an unbounded consumer write.
   Each consumer has a bounded queue and an applied watermark; overflow or a
   slow consumer becomes an explicit gap/fallback without blocking canonical
   block execution or other consumers.
4. Reorg rollback is supported to the last common ancestor.
5. Socket/process gaps are detectable by sequence and canonical watermark.
6. Account deletion, storage clearing and self-destruct semantics are
   represented.
7. Dependency surfaces are registry-derived and generation-bound; they are not
   a second manually maintained instance allowlist.
8. A family can use carry-forward only after proving its dependency surface is
   complete for the relevant pricing state.
9. A missing classifier, unknown write, schema change or proof failure falls
   back to current-source reads. It must never silently certify unchanged
   state.
10. Dynamic state is current-source state. TTL may cache topology/schema/read
   plans, not a stale pricing conclusion used for hard rejection.
11. Pending victim overlays and final simulation remain independent,
    fail-closed safety layers.

## 6. What not to copy

The following `sui-mev` choices are observations, not target architecture:

- a startup-static `pool_related_ids` file as the completeness boundary;
- a state socket without ACK, sequence, checkpoint watermark or gap recovery;
- synchronous, serial socket writes on the fullnode commit path;
- omission of deleted/wrapped state;
- omission of system-transaction writes from the update feed;
- Swap-event-only search triggering;
- trigger work silently dropped by short expiry, recent-coin deduplication or
  backlog limits;
- central `Protocol` enums and repeated protocol matches;
- search speed obtained by hard caps such as two hops and ten pools per token;
- graph reduction, fixture-specific routes, hardcoded pool instances or delayed
  dynamic pricing state to manufacture a latency pass.

Its checked-in `pool_related_ids.txt` contains roughly 768,000 lines. That is a
large preload/filter universe, not automatic dependency completeness.

## 7. Deferred implementation sequence

When this becomes a prioritized project, use the following order.

### Phase 0 — evidence and contract

- Freeze a representative swap/conversion cohort and current-main latency
  baseline.
- Measure current V2/V3/V4 mutation proof, direct-read count, pass latency and
  fallback rate.
- Define the exact reth integration boundary before changing runtime code.

### Phase 1 — shadow state-diff feed

- Emit canonical diffs from reth or a node-adjacent component.
- Consume them without changing scanner output.
- Start with the unfiltered block-final `ExecutionOutcome`/equivalent full diff
  as the completeness oracle. Existing logs and the existing read plan cannot
  prove that an undeclared oracle, proxy, code or system dependency was not
  missed.
- Compare, per block, the diff-derived dirty set with current log-derived and
  direct-read observations.
- Any missed changed key, ordering gap or reorg mismatch fails the experiment.
- If a later producer filters by registry dependencies, bind its dependency-set
  fingerprint and effective-from block/hash acknowledgement to the graph/schema
  generation.

### Phase 2 — dirty-set provider

- Use a proven diff only to classify changed versus unchanged keys.
- Keep current-source reads for changed keys and retain the existing direct-read
  fallback.
- V2/V3/V4 output, candidate set and final-sim result must remain equivalent.

### Phase 3 — local state mirror

- Apply account/storage writes to a source-block-bound local state mirror.
- Let family math and REVM consume that mirror.
- Remove changed-key RPC only after bit-exact quote/final-sim equivalence is
  proven.

### Phase 4 — expand family coverage

- Extend through Curve, DODO, Balancer and protocol conversion using
  registry-declared dependencies.
- A family without a complete classifier stays on current-source reads. It does
  not block or weaken other families.

## 8. Acceptance contract

This is a systemic latency/state-freshness change, not a single-transaction
stage-fix. Its future acceptance must predeclare a cohort and include:

- same immutable graph/universe and same source blocks for performance/output
  equivalence, plus a separate graph/schema-generation churn test for filtered
  dependency handshakes;
- exact route/candidate/final-sim output equivalence for unaffected behavior;
- changed-key recall of 100% against an unfiltered reth block-final
  `ExecutionOutcome`/equivalent independent full-diff oracle; current-source
  reads separately validate state decoding and quote equivalence;
- quiet-block carry-forward and mutation-block refresh controls;
- withdrawal and pre/post-block system-transition controls;
- V4 singleton and external oracle/rate-provider controls;
- injected feed gap, disconnect and reorg tests proving fail-closed fallback;
- a slow-reader/fanout test proving one consumer cannot block canonical node
  execution or another consumer;
- trigger-to-worker recall, expiry, deduplication and backlog controls;
- direct-read/RPC count and CPU/pass-latency before versus after;
- node execution overhead and block-head-to-state-ready latency;
- p50/p95 and budget-censoring, without reducing graph, candidate budget,
  supported hops or adapter-family coverage;
- a shadow period before the feed may become authoritative;
- normal final simulation and EV policy unchanged.

No performance threshold should be achieved by hardcoding a fixture, excluding
families, shrinking the graph or using stale dynamic state.

## 9. Open decisions for the future round

These choices are deliberately left for the implementation round:

1. reth in-process hook, reth plugin, or a node-adjacent ordered diff stream;
2. full state diff versus registry-filtered diff with a completeness proof;
3. storage-slot decoding at the producer versus family-side classification;
4. how much state the local REVM mirror owns;
5. whether state changes may trigger scanner work directly in addition to
   transaction/log triggers;
6. migration order after the V2/V3/V4 shadow pilot.

Until those questions are answered and the cohort is frozen, the current
canonical event-proof plus current-source fallback remains the production
design.
