import {
  blockScanEdgeKey,
  blockScanStateKey,
  createMutationQueryDescriptor,
  deterministicHash,
  exactSetHash,
  mutationQueryDescriptorFingerprint,
  stateSchemaFingerprint,
  verifiedGraphCompletenessIssueDetails,
  type BlockSource,
  type BlockScanPricingLane,
  type CanonicalMutationRange,
  type CompiledBlockScanStateFamily,
  type CompiledIncrementalStateFamily,
  type FamilyMutationClassification,
  type MutationQueryDescriptor,
  type PublishedStateKey,
  type RegisteredBlockScanStateFamily,
  type StateFreshnessProof,
  type StateKeyCoverage,
  type StateRead,
  type StateReadFailureKind,
  type StateReadProvenance,
  type StateReadResult,
  type VerifiedGraphView,
} from "./venues/blockscan-state-capability.js";
import {
  observedLandedPoolIdentity,
  type LandedEventEmitter,
} from "./venues/landed-event-registry.js";
import {
  BLOCKSCAN_STATE_CACHE_SCHEMA_VERSION,
  appendBlockScanStateCache,
  compactBlockScanStateCache,
  loadBlockScanStateCache,
  type CachedBlockScanStateKey,
  type CachedBlockScanStateRead,
} from "./blockscan-state-cache.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";

export interface BlockScanStateReadBackend {
  /**
   * Pricing-only read. Successful results must carry exact source provenance
   * (EIP-1898 live, or a backend-attested immutable fork); this coordinator,
   * not each family batch, owns the canonical publication CAS.
   */
  readBatch(
    lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]>;

  verifyCanonicalSource(source: BlockSource, signal: AbortSignal): Promise<void>;

  /**
   * EIP-1898 is self-authenticating through requireCanonical. An immutable
   * fork proof is backend-specific, so the coordinator accepts it only when
   * the trusted backend explicitly verifies the fork lease.
   */
  verifyImmutableForkProvenance?(
    provenance: Extract<
      StateReadProvenance,
      { readonly kind: "immutable-fork" }
    >,
    source: BlockSource,
  ): boolean;

  readCanonicalMutationRange?(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      /** Generation owner; family-local aborts must not cancel shared proof work. */
      readonly sharedSignal?: AbortSignal;
    },
  ): Promise<CanonicalMutationRange>;

  /**
   * Optional whole-block activity proof used only to evaluate a conservative
   * protocol carry-forward rule. It is hash-pinned and contains every direct
   * transaction destination plus every receipt-log emitter. Families must
   * explicitly attest that those signals cover their pricing dependencies.
   */
  readCanonicalAddressTouches?(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CanonicalAddressTouchRange>;
}

export interface CanonicalAddressTouchRange {
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  readonly touchedAddresses: readonly string[];
  readonly transactionCount: number;
  readonly complete: true;
  readonly rangeFingerprint: string;
}

export type ProtocolAddressTouchShadowStatus =
  | "complete"
  | "unavailable";

export interface ProtocolAddressTouchShadowTelemetry {
  readonly status: ProtocolAddressTouchShadowStatus;
  readonly fromBlock?: number;
  readonly throughBlock: number;
  readonly wallMs: number;
  readonly touchedAddresses?: number;
  readonly transactionCount?: number;
  readonly protocolStateKeys: number;
  readonly predictedDirtyStateKeys?: number;
  readonly predictedCarryStateKeys?: number;
  readonly comparableCarryStateKeys?: number;
  readonly mismatchStateKeys?: number;
  readonly mismatchFamilyIds?: readonly string[];
  readonly families?: readonly {
    readonly familyId: string;
    readonly stateKeys: number;
    readonly predictedDirtyStateKeys: number;
    readonly predictedCarryStateKeys: number;
    readonly comparableCarryStateKeys: number;
    readonly mismatchStateKeys: number;
  }[];
  readonly unavailableReason?: string;
}

export interface BlockScanStateCoverage {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly unresolvedStateKeys: readonly string[];
  readonly expectedReadKeys: readonly string[];
  readonly resolvedReadKeys: readonly string[];
  readonly unresolvedReadKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
  readonly unavailableEdgeKeys: readonly string[];
  readonly unresolvedEdgeKeys: readonly string[];
  readonly expectedStateKeyHash: string;
  readonly resolvedStateKeyHash: string;
  readonly unresolvedStateKeyHash: string;
  readonly expectedReadKeyHash: string;
  readonly resolvedReadKeyHash: string;
  readonly unresolvedReadKeyHash: string;
  readonly expectedEdgeKeyHash: string;
  readonly resolvedEdgeKeyHash: string;
  readonly unavailableEdgeKeyHash: string;
  readonly unresolvedEdgeKeyHash: string;
}

export type BlockScanLaggingTopologyRefreshMode =
  | "startup-bootstrap"
  | "proof-scoped";

export type BlockScanStateIssueKind =
  | "graph-incomplete"
  | "edge-owner-missing"
  | "edge-owner-ambiguous"
  | "duplicate-family"
  | "schema"
  | "descriptor"
  | "backend"
  | "decode"
  | "derive"
  | "deadline"
  | "aborted"
  | "resource-limited"
  | "stale-generation";

export interface BlockScanStateIssue {
  readonly kind: BlockScanStateIssueKind;
  readonly lane?: BlockScanPricingLane;
  readonly familyId?: string;
  readonly sourceId?: string;
  readonly stateKey?: string;
  readonly edgeKey?: string;
  readonly message: string;
}

export interface BlockScanLaneTelemetry {
  readonly lane: BlockScanPricingLane;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly wallMs: number;
  readonly uniqueStateKeys: number;
  readonly reads: number;
  readonly batches: number;
}

export type BlockScanFamilyTelemetryStatus =
  | "complete"
  | "degraded"
  | "incomplete";

/**
 * Per-family execution evidence for one source generation. Lane telemetry
 * remains the aggregate scheduling view; these rows identify the family that
 * consumed the work or failed to reach a terminal publication.
 */
export interface BlockScanFamilyTelemetry {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly wallMs: number;
  readonly uniqueStateKeys: number;
  readonly reads: number;
  readonly batches: number;
  readonly status: BlockScanFamilyTelemetryStatus;
  readonly issueCount: number;
  /** Optional so persisted evidence from before stateKey-local refresh remains readable. */
  readonly carryStateKeys?: number;
  readonly directStateKeys?: number;
  readonly missingPreviousStateKeys?: number;
  /**
   * State keys that cannot enter the bounded mutation proof because they are
   * newly admitted, their safe base is missing, or it is outside the proof
   * window, and that still lack a current-generation replacement. Bounded
   * family-local direct recovery clears this count without expanding the whole
   * generation.
   */
  readonly recoveryRequiredStateKeys?: number;
  /**
   * Set only when a family that could otherwise refresh incrementally had to
   * fall back to direct current-N reads for every stateKey.
   */
  readonly fullFallbackReason?: string;
  /** Sanitized phase + failure class; raw RPC errors never enter telemetry. */
  readonly fullFallbackDetail?: string;
  readonly incrementalDescriptorMs?: number;
  readonly incrementalRangeMs?: number;
  readonly incrementalClassifierMs?: number;
}

export interface BlockScanStateSnapshot {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly graph: VerifiedGraphView;
  readonly mids: ReadonlyMap<string, RouteVenueMid>;
  readonly coverageByReadKey: ReadonlyMap<string, StateKeyCoverage>;
  readonly coverageByEdgeKey: ReadonlyMap<string, StateKeyCoverage>;
  readonly freshnessByReadKey: ReadonlyMap<string, StateFreshnessProof>;
  readonly stateByStateKey: ReadonlyMap<string, PublishedStateKey>;
  readonly resolvedFamilyIds: readonly string[];
  readonly incompleteFamilyIds: readonly string[];
  readonly coverage: BlockScanStateCoverage;
  readonly laneTelemetry: readonly BlockScanLaneTelemetry[];
  /** Optional for compatibility with persisted snapshots created before this field. */
  readonly familyTelemetry?: readonly BlockScanFamilyTelemetry[];
}

interface PrepareResultBase {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly coverage: BlockScanStateCoverage;
  readonly issues: readonly BlockScanStateIssue[];
  readonly laneTelemetry: readonly BlockScanLaneTelemetry[];
  /** Coordinator results always populate this; optional preserves old consumers. */
  readonly familyTelemetry?: readonly BlockScanFamilyTelemetry[];
}

export interface CompleteBlockScanStateResult extends PrepareResultBase {
  readonly status: "complete";
  readonly snapshot: BlockScanStateSnapshot;
}

export interface DegradedBlockScanStateResult extends PrepareResultBase {
  readonly status: "degraded";
  readonly snapshot: BlockScanStateSnapshot;
}

export interface IncompleteBlockScanStateResult extends PrepareResultBase {
  readonly status: "incomplete";
  /** Partial mids are deliberately not published. */
  readonly snapshot?: never;
}

export type BlockScanStatePrepareResult =
  | CompleteBlockScanStateResult
  | DegradedBlockScanStateResult
  | IncompleteBlockScanStateResult;

export interface PrepareBlockScanStateInput {
  readonly graph: VerifiedGraphView;
  readonly families: readonly RegisteredBlockScanStateFamily[];
  /**
   * Universal-registry-derived pricing projection. Credit/liquidity claims may
   * coexist in the immutable graph without being forced into a price lane.
   */
  readonly requiresPricing?: (edge: TokenEdge) => boolean;
  /**
   * Absolute generation deadline. Each family is additionally bounded by the
   * coordinator's shorter local timeout.
   */
  readonly deadlineAtMs: number;
  /**
   * Optional earlier family-settlement boundary. Hot production passes use it
   * to turn a slow family into an explicit degraded result while the
   * generation controller still has time to perform its canonical CAS and
   * publish healthy siblings. Startup/replay may omit it and use the full
   * generation deadline.
   */
  readonly familySettleDeadlineAtMs?: number;
  /**
   * A lagging topology proof is not permission to reread an established
   * family wholesale. Ordinary/N-1 passes may refresh only keys covered by a
   * canonical mutation proof (plus keys absent from the previous canonical
   * graph). The one-time startup warm may bootstrap the initial recovery base.
   */
  readonly laggingTopologyRefreshMode?: BlockScanLaggingTopologyRefreshMode;
  /**
   * Warm generations persist each resolved state key's raw reads for the
   * resumable-warm cache; hot generations only read from it. Default "hot".
   */
  readonly cacheMode?: "warm" | "hot";
  readonly signal?: AbortSignal;
}

export interface BlockScanStateCoordinatorOptions {
  /**
   * Hard wall-clock budget for one family across schema compilation,
   * incremental proof reads and current-N reads. Families run concurrently;
   * timing one out never aborts a sibling or the generation controller.
   */
  readonly familyTimeoutMs?: number;
  /**
   * Shadow compares the proposed carry rule with direct current-block reads.
   * Enabled applies only family-explicit dependency-touch opt-ins and falls
   * back to direct reads whenever the canonical activity proof is unavailable.
   */
  readonly protocolAddressTouchMode?: "off" | "shadow" | "enabled";
  /** Backward-compatible test/config alias for shadow mode. */
  readonly protocolAddressTouchShadow?: boolean;
  readonly onProtocolAddressTouchShadowTelemetry?: (
    telemetry: ProtocolAddressTouchShadowTelemetry,
  ) => void;
  /**
   * Max blocks between a recovery base's source and the new graph source for
   * incremental carry and cached-warm reuse. Default 32; production sets
   * SEARCHER_BLOCKSCAN_INCREMENTAL_RANGE_BLOCKS=128 so a deploy-lagging warm
   * can resume from a ~25-minute-old cache source instead of re-reading every
   * key.
   */
  readonly incrementalRangeBlocks?: number;
  /**
   * Optional JSONL cache of raw source-pinned reads. Each resolved state key
   * is appended as it completes during warm generations, and a restart
   * re-decodes cached keys instead of re-reading them from RPC (resumable
   * warm). Protocol-agnostic: only raw results are stored; the family's
   * registered decode path rebuilds the published state.
   */
  readonly cachePath?: string;
  readonly now?: () => number;
}

interface StateGroup {
  readonly family: RegisteredBlockScanStateFamily;
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly rawStateKey: string;
  readonly stateKey: string;
  readonly edges: readonly TokenEdge[];
  readonly edgeKeys: readonly string[];
}

interface OwnershipPlan {
  readonly groups: readonly StateGroup[];
  readonly expectedStateKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly ownerIssues: readonly BlockScanStateIssue[];
}

/**
 * Graph-topology-scoped index, rebuilt only when the edge topology/metadata/
 * ownership hashes change (never on a plain block advance). Per-block work
 * then resolves dirty state keys through stateKeysByPoolIdentity instead of
 * rescanning all 35k edges and rebuilding the identity index every
 * generation.
 */
interface StateTopologyIndex {
  readonly key: string;
  readonly ownership: OwnershipPlan;
  /** familyId\u001fpoolIdentity -> composite state keys. */
  readonly stateKeysByPoolIdentity: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly groupByStateKey: ReadonlyMap<string, StateGroup>;
}

interface LaneResult {
  readonly lane: BlockScanPricingLane;
  readonly stagedStaticSchemas: readonly (readonly [
    string,
    CompiledBlockScanStateFamily,
  ])[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedReadKeys: readonly string[];
  readonly resolvedReadKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
  readonly unavailableEdges: readonly BehaviorProvenUnavailableEdge[];
  readonly mids: readonly [string, RouteVenueMid][];
  readonly freshness: readonly [string, StateFreshnessProof][];
  readonly states: readonly [string, PublishedStateKey][];
  readonly issues: readonly BlockScanStateIssue[];
  readonly telemetry: BlockScanLaneTelemetry;
  readonly familyTelemetry: readonly FamilyExecutionTelemetry[];
}

interface FamilyExecutionTelemetry {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly wallMs: number;
  readonly uniqueStateKeys: number;
  readonly reads: number;
  readonly batches: number;
  readonly carryStateKeys?: number;
  readonly directStateKeys?: number;
  readonly missingPreviousStateKeys?: number;
  readonly recoveryRequiredStateKeys?: number;
  readonly fullFallbackReason?: string;
  readonly fullFallbackDetail?: string;
  readonly incrementalDescriptorMs?: number;
  readonly incrementalRangeMs?: number;
  readonly incrementalClassifierMs?: number;
}

interface BehaviorProvenUnavailableEdge {
  readonly edgeKey: string;
  readonly familyId: string;
  readonly stateKey: string;
  readonly reason: string;
}

interface ProtocolAddressTouchShadowAttempt {
  readonly startedAtMs: number;
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  readonly groups: readonly StateGroup[];
  readonly previousByStateKey: ReadonlyMap<string, PublishedStateKey>;
  readonly proof: Promise<CanonicalAddressTouchRange>;
}

interface FamilyLaneStaging {
  readonly staticSchemas: Map<string, CompiledBlockScanStateFamily>;
  readonly expectedReadKeys: Set<string>;
  reads: number;
  batches: number;
  carryStateKeys?: number;
  directStateKeys?: number;
  missingPreviousStateKeys?: number;
  recoveryRequiredStateKeys?: number;
  fullFallbackReason?: string;
  fullFallbackDetail?: string;
  incrementalDescriptorMs?: number;
  incrementalRangeMs?: number;
  incrementalClassifierMs?: number;
}

/**
 * Compile + mutation-proof phase output for one family, prepared for every
 * family of both lanes BEFORE any direct state reads start. This removes the
 * foreground-proof / background-read preemption inside a generation (a
 * family's bulk reads used to be aborted and retried whenever a sibling
 * family's canonical mutation proof grabbed the foreground lease).
 */
interface PreparedFamilyPhase {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly compiledFamilies: ReadonlyMap<string, CompiledBlockScanStateFamily>;
  readonly incrementalPreparation: IncrementalPreparation;
  readonly recoveryCandidateStateKeys: ReadonlySet<string>;
  readonly hotRecoveryStateKeys: ReadonlySet<string>;
  readonly staging: FamilyLaneStaging;
  readonly issues: readonly BlockScanStateIssue[];
  readonly addressTouchPlan?: FamilyIncrementalPlan;
}

interface FamilyIncrementalPlan {
  readonly familyId: string;
  readonly rangeByStateKey: ReadonlyMap<string, CanonicalMutationRange>;
  readonly classificationByStateKey: ReadonlyMap<
    string,
    FamilyMutationClassification
  >;
  readonly previousByStateKey: ReadonlyMap<string, PublishedStateKey>;
  readonly schemaCompatibleStateKeys: ReadonlySet<string>;
}

interface RecoveryStateBase {
  readonly state: PublishedStateKey;
  readonly schemaFingerprint: string;
  readonly requiredReadKeyHash: string;
  /**
   * Last direct-derived mids and behavior-proven unavailable edges, reused
   * verbatim for carry-forward keys so an unchanged state key never
   * re-derives 35k-edge quotes.
   */
  readonly midsByEdgeKey: ReadonlyMap<string, RouteVenueMid>;
  readonly unavailableByEdgeKey: ReadonlyMap<string, string>;
}

interface IncrementalPreparation {
  readonly plans: Map<string, FamilyIncrementalPlan>;
  readonly missingPreviousStateKeysByFamily: ReadonlyMap<string, number>;
  readonly fullFallbackReasonByFamily: Map<string, string>;
  readonly fullFallbackDetailByFamily: Map<string, string>;
  readonly phaseTimingByFamily: ReadonlyMap<
    string,
    Readonly<{
      readonly descriptorMs: number;
      readonly rangeMs: number;
      readonly classifierMs: number;
    }>
  >;
}

interface ActiveGeneration {
  readonly generation: number;
  readonly token: symbol;
  readonly controller: AbortController;
}

// Production raises this through SEARCHER_BLOCKSCAN_INCREMENTAL_RANGE_BLOCKS
// so a deploy-lagging warm resume can reuse a ~25-minute-old cache source
// (carries re-prove the range; exact joins correct stale coarse mids at N).
const DEFAULT_INCREMENTAL_RANGE_BLOCKS = 32;
// Keep recovery inside the ordinary hot budget; rotate so repeated failures
// cannot permanently starve later state keys in the same family.
const MAX_HOT_RECOVERY_STATE_KEYS_PER_FAMILY = 16;
const DEFAULT_FAMILY_TIMEOUT_MS = 5_000;
const ENABLED_PROTOCOL_ADDRESS_TOUCH_BUDGET_MS = 4_000;

class DeadlineAbort extends Error {
  constructor() {
    super("block-scan state deadline reached");
    this.name = "DeadlineAbort";
  }
}

class SupersededAbort extends Error {
  constructor(
    readonly generation: number,
    readonly supersededBy: number,
  ) {
    super(`generation ${generation} superseded by ${supersededBy}`);
    this.name = "SupersededAbort";
  }
}

class FamilyDeadlineAbort extends Error {
  constructor(
    readonly familyId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `block-scan state family ${familyId} did not settle within ${timeoutMs}ms`,
    );
    this.name = "FamilyDeadlineAbort";
  }
}

/**
 * Shadow current-N state kernel. It owns scheduling/publication only and has
 * no protocol switch or production side effect.
 */
export class BlockScanStateCoordinator {
  private active: ActiveGeneration | null = null;
  private published: BlockScanStateSnapshot | null = null;
  private readonly staticSchemas = new Map<
    string,
    CompiledBlockScanStateFamily
  >();
  /**
   * Recovery-only dynamic bases. These values never enter PricingView directly:
   * they are usable only after a complete adapter-owned mutation proof advances
   * their exact source block/hash to the requested generation.
   */
  private readonly lastGoodByStateKey = new Map<string, RecoveryStateBase>();
  /**
   * State-key membership from the last generation that passed the canonical
   * source fence. This distinguishes a genuinely new graph key from an
   * established key whose state read failed and has no recovery base.
   */
  private previousCanonicalGraphStateKeys: ReadonlySet<string> | null = null;
  /**
   * Family-local cursor for bounded current-N recovery. It advances by one
   * whole quota after every oversized pass so continuously failing keys cannot
   * be starved by successful or coalesced graph generations.
   */
  private readonly hotRecoveryCursorByFamily = new Map<string, string>();
  private readonly familyTimeoutMs: number;
  private readonly incrementalRangeBlocks: number;
  private readonly protocolAddressTouchMode: "off" | "shadow" | "enabled";
  private readonly onProtocolAddressTouchShadowTelemetry:
    | ((telemetry: ProtocolAddressTouchShadowTelemetry) => void)
    | undefined;
  private readonly cachePath: string | undefined;
  private readonly cachedByStateKey = new Map<
    string,
    CachedBlockScanStateKey
  >();
  private topologyIndex: StateTopologyIndex | null = null;
  private cacheAppendChain: Promise<void> = Promise.resolve();
  /** Warm generations persist each resolved key; hot generations do not. */
  private cacheModeActive = false;
  private readonly now: () => number;

  constructor(
    private readonly backend: BlockScanStateReadBackend,
    options: BlockScanStateCoordinatorOptions = {},
  ) {
    const familyTimeoutMs =
      options.familyTimeoutMs ?? DEFAULT_FAMILY_TIMEOUT_MS;
    if (!Number.isFinite(familyTimeoutMs) || familyTimeoutMs <= 0) {
      throw new Error(
        `invalid block-scan family timeout ${String(familyTimeoutMs)}`,
      );
    }
    this.familyTimeoutMs = Math.max(1, Math.floor(familyTimeoutMs));
    this.incrementalRangeBlocks = Math.max(
      1,
      Math.floor(options.incrementalRangeBlocks ?? DEFAULT_INCREMENTAL_RANGE_BLOCKS),
    );
    this.protocolAddressTouchMode = options.protocolAddressTouchMode ??
      (options.protocolAddressTouchShadow ? "shadow" : "off");
    this.onProtocolAddressTouchShadowTelemetry =
      options.onProtocolAddressTouchShadowTelemetry;
    this.cachePath = options.cachePath;
    if (this.cachePath) {
      const loaded = loadBlockScanStateCache(this.cachePath);
      for (const [stateKey, entry] of loaded.entries) {
        this.cachedByStateKey.set(stateKey, entry);
      }
      if (loaded.lineCount > loaded.entries.size * 1.5 + 1024) {
        this.scheduleCacheCompact();
      }
    }
    this.now = options.now ?? Date.now;
  }

  latestSnapshot(): BlockScanStateSnapshot | null {
    return this.published;
  }

  private recoveryBaseForGroup(
    group: StateGroup,
  ): RecoveryStateBase | undefined {
    const base = this.lastGoodByStateKey.get(group.stateKey);
    if (
      !base ||
      base.state.familyId !== group.familyId ||
      base.state.stateKey !== group.rawStateKey ||
      base.requiredReadKeyHash !==
        exactSetHash(base.state.requiredReadKeys) ||
      base.state.requiredReadKeys.length === 0 ||
      new Set(base.state.requiredReadKeys).size !==
        base.state.requiredReadKeys.length ||
      base.state.requiredReadKeys.some((readKey) => {
        const proof = base.state.freshnessByReadKey.get(readKey);
        return !proof || !sameBlockSource(proof.source, base.state.source);
      })
    ) {
      return undefined;
    }
    return base;
  }

  private topologyFor(
    graph: VerifiedGraphView,
    families: readonly RegisteredBlockScanStateFamily[],
    requiresPricing: (edge: TokenEdge) => boolean,
  ): StateTopologyIndex {
    const key = [
      graph.orderedEdgeHash,
      graph.metadataHash,
      graph.ownershipHash,
      families.map((family) => family.familyId).sort().join(","),
      typeof requiresPricing === "function" ? "custom" : "default",
    ].join("\u001f");
    if (this.topologyIndex?.key === key) {
      return this.topologyIndex;
    }
    const ownership = buildOwnershipPlan(graph, families, requiresPricing);
    const stateKeysByPoolIdentity = new Map<string, Set<string>>();
    const groupByStateKey = new Map<string, StateGroup>();
    for (const group of ownership.groups) {
      groupByStateKey.set(group.stateKey, group);
      for (const edge of group.edges) {
        // The pool identity is poolId for v4-style families and the pool
        // address otherwise; edge.target is the shared manager/router and
        // must not be used directly.
        const poolIdentity = (edge.poolId ?? edge.target).toLowerCase();
        const identityKey = `${group.familyId}\u001f${poolIdentity}`;
        const stateKeys = stateKeysByPoolIdentity.get(identityKey) ??
          new Set<string>();
        stateKeys.add(group.stateKey);
        stateKeysByPoolIdentity.set(identityKey, stateKeys);
      }
    }
    const frozen = Object.freeze({
      key,
      ownership,
      stateKeysByPoolIdentity: new FrozenReadonlyMap(
        [...stateKeysByPoolIdentity].map(([identityKey, stateKeys]) => [
          identityKey,
          Object.freeze(new Set(stateKeys)),
        ] as const),
      ),
      groupByStateKey,
    });
    this.topologyIndex = frozen;
    return frozen;
  }

  /**
   * Resumable-warm lookup. A cached key is usable when its family matches,
   * its raw reads are internally consistent (validated at load) and its
   * source is recent enough to re-decode for this generation. Generation is
   * intentionally not compared: the cache resumes a warm across process
   * restarts, not an incremental carry.
   */
  private cacheEntryForGroup(
    group: StateGroup,
    graph: VerifiedGraphView,
  ): CachedBlockScanStateKey | undefined {
    const entry = this.cachedByStateKey.get(group.stateKey);
    if (!entry || entry.familyId !== group.familyId) return undefined;
    const distance = graph.sourceBlock - entry.source.number;
    if (distance < 0 || distance > this.incrementalRangeBlocks) {
      return undefined;
    }
    const readIds = new Set(entry.reads.map((read) => read.localId));
    if (
      entry.requiredReadKeys.length === 0 ||
      !entry.requiredReadKeys.every((id) => readIds.has(id))
    ) {
      return undefined;
    }
    return entry;
  }

  /**
   * Persist one resolved state key's raw reads for the next warm. Only fresh
   * direct/classified reads are cached (carried keys and re-hydrated keys
   * already have an entry or belong to an older source). Appends are
   * serialized so concurrent family lanes never interleave lines.
   */
  private scheduleCacheAppend(entry: CachedBlockScanStateKey): void {
    if (!this.cachePath) return;
    this.cachedByStateKey.set(entry.stateKey, entry);
    const path = this.cachePath;
    this.cacheAppendChain = this.cacheAppendChain
      .catch(() => {})
      .then(() => appendBlockScanStateCache(path, entry));
  }

  private scheduleCacheCompact(): void {
    if (!this.cachePath) return;
    const path = this.cachePath;
    const entries = this.cachedByStateKey;
    this.cacheAppendChain = this.cacheAppendChain
      .catch(() => {})
      .then(() => compactBlockScanStateCache(path, entries));
  }

  private buildCacheEntry(
    group: StateGroup,
    state: PublishedStateKey,
    resultsByGlobalId: ReadonlyMap<string, StateReadResult>,
    groupReads: readonly {
      readonly globalId: string;
      readonly localId: string;
    }[],
  ): CachedBlockScanStateKey | null {
    if (groupReads.length === 0) return null;
    const reads: CachedBlockScanStateRead[] = [];
    for (const item of groupReads) {
      const result = resultsByGlobalId.get(item.globalId);
      if (!result?.ok) return null;
      reads.push(Object.freeze({
        localId: item.localId,
        data: result.data,
        provenance: result.provenance,
      }));
    }
    if (reads.length === 0) return null;
    return Object.freeze({
      schemaVersion: BLOCKSCAN_STATE_CACHE_SCHEMA_VERSION,
      familyId: group.familyId,
      stateKey: group.stateKey,
      source: Object.freeze({ ...state.source }),
      // Planning order, not the sorted snapshot order: decodeState consumes
      // localResults in the round order (round-0 reads first, then dependent
      // rounds), so the cache must replay the same sequence on hydration.
      requiredReadKeys: Object.freeze(groupReads.map((item) => item.localId)),
      reads: Object.freeze(reads),
      savedAtMs: this.now(),
    });
  }

  /**
   * Trusted historical blind-run hook. Dynamic source-N state is discarded
   * between attempts while graph-fingerprint static schemas remain reusable.
   * Production never calls this method.
   */
  resetDynamicStateForReplay(): void {
    if (this.active) {
      throw new Error("cannot reset block-scan state during an active generation");
    }
    this.published = null;
    this.lastGoodByStateKey.clear();
    this.previousCanonicalGraphStateKeys = null;
    this.hotRecoveryCursorByFamily.clear();
  }

  async prepare(input: PrepareBlockScanStateInput): Promise<BlockScanStatePrepareResult> {
    const { graph } = input;
    this.cacheModeActive = input.cacheMode === "warm";
    const previousPublished = this.published;
    const familySettleDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      input.familySettleDeadlineAtMs ?? input.deadlineAtMs,
    );
    if (!Number.isFinite(familySettleDeadlineAtMs)) {
      throw new Error(
        `invalid block-scan family settle deadline ` +
          `${String(input.familySettleDeadlineAtMs)}`,
      );
    }
    // Topology-scoped: rebuilds ownership + the pool-identity reverse index
    // only when the graph's edge topology/metadata/ownership actually change.
    const ownership = this.topologyFor(
      graph,
      input.families,
      input.requiresPricing ?? (() => true),
    ).ownership;
    const earlierPublished = this.published?.generation ?? -1;
    if (graph.generation <= earlierPublished) {
      return incompleteResult({
        graph,
        ownership,
        issues: [{
          kind: "stale-generation",
          message: `generation ${graph.generation} is not newer than published ${earlierPublished}`,
        }],
      });
    }
    if (this.active) {
      if (graph.generation <= this.active.generation) {
        return incompleteResult({
          graph,
          ownership,
          issues: [{
            kind: "stale-generation",
            message: `generation ${graph.generation} is not newer than active ${this.active.generation}`,
          }],
        });
      }
      this.active.controller.abort(
        new SupersededAbort(this.active.generation, graph.generation),
      );
    }

    const controller = new AbortController();
    const token = Symbol(`blockscan-state-${graph.generation}`);
    const active = { generation: graph.generation, token, controller };
    this.active = active;
    const detachExternal = linkAbortSignal(input.signal, controller);
    const delay = input.deadlineAtMs - this.now();
    const deadlineTimer = setTimeout(
      () => controller.abort(new DeadlineAbort()),
      Math.max(0, delay),
    );

    const graphIssueDetails = verifiedGraphCompletenessIssueDetails(graph);
    const graphIssues = graphIssueDetails.map(
      (issue): BlockScanStateIssue => ({
        kind: "graph-incomplete",
        ...(issue.familyId === undefined ? {} : { familyId: issue.familyId }),
        ...(issue.sourceId === undefined ? {} : { sourceId: issue.sourceId }),
        message: issue.message,
      }),
    );
    const positiveProtocolFamilyIds = new Set(
      ownership.groups
        .filter((group) => group.lane === "protocol")
        .map((group) => group.familyId),
    );
    /*
     * Discovery completeness is labeling only: a lagging Swap source means the
     * graph may be missing newly landed venues, so the publication is honest
     * degraded recall. It never gates pricing — every family prices the pools
     * it owns through the unconditional incremental/direct path below, so a
     * backrun-style update pipe (read only the pools the previous block
     * traded, carry the rest from the last good state) works regardless of
     * how far the discovery watermark trails the head. A same-height hash
     * mismatch belongs to another canonical state and always stays blocked.
     */
    const graphIncompleteFamilyIds = new Set(
      graphIssueDetails.flatMap((issue) =>
        issue.familyId === undefined ||
          positiveProtocolFamilyIds.has(issue.familyId)
          ? []
          : [issue.familyId]
      ),
    );
    const stateBlockedFamilyIds = new Set(
      graph.perSourceCoverage.flatMap((coverage) =>
        coverage.completeThroughBlock === graph.sourceBlock &&
          coverage.completeThroughHash !== graph.sourceBlockHash
          ? [coverage.familyId]
          : []
      ),
    );
    const previousCanonicalGraphStateKeys =
      this.previousCanonicalGraphStateKeys;
    try {
      if (delay <= 0) controller.abort(new DeadlineAbort());
      const laneGroups = {
        swap: ownership.groups.filter(
          (group) =>
            group.lane === "swap" &&
            !stateBlockedFamilyIds.has(group.familyId),
        ),
        protocol: ownership.groups.filter(
          (group) =>
            group.lane === "protocol" &&
            !stateBlockedFamilyIds.has(group.familyId),
        ),
      } as const;
      const protocolAddressTouchShadow =
        this.beginProtocolAddressTouchShadow(
          previousPublished,
          laneGroups.protocol,
          graph,
          this.protocolAddressTouchMode === "enabled"
            ? Math.min(
                familySettleDeadlineAtMs,
                this.now() + ENABLED_PROTOCOL_ADDRESS_TOUCH_BUDGET_MS,
              )
            : input.deadlineAtMs,
          controller.signal,
        );
      const protocolAddressTouchPlans =
        this.protocolAddressTouchMode === "enabled"
          ? await this.resolveProtocolAddressTouchPlans(
              protocolAddressTouchShadow,
              controller.signal,
            )
          : new Map<string, FamilyIncrementalPlan>();
      /*
       * Phase 1: compile every family's static schema and settle every
       * canonical mutation-range proof for BOTH lanes before any direct state
       * read begins. Foreground proofs therefore never preempt background
       * bulk reads mid-generation (the old interleaving aborted and retried
       * sibling reads whenever another family grabbed the foreground lease).
       */
      const allGroups = [...laneGroups.swap, ...laneGroups.protocol];
      const preparedPhases = await Promise.all(
        uniqueFamilies(allGroups).map(async (family) => {
          const familyGroups = allGroups.filter(
            (group) => group.familyId === family.familyId,
          );
          const lane = familyGroups[0]!.lane;
          const addressTouchPlan = protocolAddressTouchPlans.get(
            family.familyId,
          );
          return this.prepareFamilyPhase({
            lane,
            groups: familyGroups,
            graph,
            deadlineAtMs: familySettleDeadlineAtMs,
            signal: controller.signal,
            generationSignal: controller.signal,
            previousCanonicalGraphStateKeys,
            ...(addressTouchPlan === undefined
              ? {}
              : { addressTouchPlan }),
          });
        }),
      );
      const preparedPhaseByFamily = new Map(
        preparedPhases.map((phase) => [phase.familyId, phase] as const),
      );
      // Phase 2: direct reads + decode for both lanes.
      const [swap, protocol] = await Promise.all([
        this.runLane(
          "swap",
          laneGroups.swap,
          graph,
          familySettleDeadlineAtMs,
          controller.signal,
          preparedPhaseByFamily,
        ),
        this.runLane(
          "protocol",
          laneGroups.protocol,
          graph,
          familySettleDeadlineAtMs,
          controller.signal,
          preparedPhaseByFamily,
        ),
      ]);
      const lanes = [swap, protocol] as const;
      let issues = [
        ...ownership.ownerIssues,
        ...graphIssues,
        ...swap.issues,
        ...protocol.issues,
      ];
      let resolvedStateKeys = lanes.flatMap((lane) => lane.resolvedStateKeys);
      let resolvedReadKeys = lanes.flatMap((lane) => lane.resolvedReadKeys);
      let resolvedEdgeKeys = lanes.flatMap((lane) => lane.resolvedEdgeKeys);
      let unavailableEdges = lanes.flatMap((lane) => lane.unavailableEdges);
      const expectedReadKeys = lanes.flatMap((lane) => lane.expectedReadKeys);
      try {
        await awaitWithAbort(
          this.backend.verifyCanonicalSource(
            Object.freeze({
              number: graph.sourceBlock,
              hash: graph.sourceBlockHash,
              generation: graph.generation,
            }),
            controller.signal,
          ),
          controller.signal,
        );
      } catch (error) {
        issues = [...issues, {
          kind: issueKindFromError(error, "stale-generation"),
          message: `publish-time canonical CAS failed: ${formatError(error)}`,
        }];
        resolvedStateKeys = [];
        resolvedReadKeys = [];
        resolvedEdgeKeys = [];
        unavailableEdges = [];
      }
      const stillActive = this.active?.token === token && !controller.signal.aborted;
      if (!stillActive) {
        const abortIssue = issueFromAbort(controller.signal.reason, graph.generation);
        issues = [...issues, abortIssue];
        resolvedStateKeys = [];
        resolvedReadKeys = [];
        resolvedEdgeKeys = [];
        unavailableEdges = [];
      }
      const terminalFamilyIds = completePricingFamilyIds(
        ownership.groups,
        graphIncompleteFamilyIds,
        {
          expectedReadKeys,
          resolvedStateKeys,
          resolvedReadKeys,
          resolvedEdgeKeys,
          unavailableEdgeKeys: unavailableEdges.map((entry) => entry.edgeKey),
        },
      );
      const coverage = createCoverage(
        ownership.expectedStateKeys,
        resolvedStateKeys,
        expectedReadKeys,
        resolvedReadKeys,
        ownership.expectedEdgeKeys,
        resolvedEdgeKeys,
        unavailableEdges.map((entry) => entry.edgeKey),
      );
      const laneTelemetry = freezeLaneTelemetry(lanes.map((lane) => lane.telemetry));
      const familyTelemetry = createFamilyTelemetry({
        groups: ownership.groups,
        registeredFamilies: input.families,
        execution: lanes.flatMap((lane) => lane.familyTelemetry),
        coverage,
        terminalFamilyIds,
        graphIncompleteFamilyIds,
        issues,
      });
      const fatalIssues = issues.filter((issue) => issue.familyId === undefined);
      if (!stillActive || fatalIssues.length > 0) {
        return Object.freeze({
          status: "incomplete",
          generation: graph.generation,
          sourceBlock: graph.sourceBlock,
          sourceBlockHash: graph.sourceBlockHash,
          coverage,
          issues: freezeIssues(issues),
          laneTelemetry,
          familyTelemetry,
        });
      }

      const resolvedStateKeySet = new Set(coverage.resolvedStateKeys);
      const resolvedReadKeySet = new Set(coverage.resolvedReadKeys);
      const resolvedEdgeKeySet = new Set(coverage.resolvedEdgeKeys);
      const unavailableReasonByEdgeKey = new Map(
        unavailableEdges.map((entry) => [entry.edgeKey, entry.reason] as const),
      );
      const mids = new FrozenReadonlyMap(
        lanes
          .flatMap((lane) => lane.mids)
          .filter(([edgeKey]) => resolvedEdgeKeySet.has(edgeKey))
          .map(([key, mid]) => [key, freezeMid(mid)] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const freshnessByReadKey = new FrozenReadonlyMap(
        lanes
          .flatMap((lane) => lane.freshness)
          .filter(([readKey]) => resolvedReadKeySet.has(readKey))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const coverageByReadKey = new FrozenReadonlyMap(
        coverage.expectedReadKeys.map((readKey) => [
          readKey,
          resolvedReadKeySet.has(readKey)
            ? Object.freeze({ status: "resolved" as const })
            : Object.freeze({
                status: "unresolved" as const,
                reason: "required current-block read did not resolve for its stateKey",
              }),
        ] as const),
      );
      const coverageByEdgeKey = new FrozenReadonlyMap(
        coverage.expectedEdgeKeys.map((edgeKey) => {
          const unavailableReason = unavailableReasonByEdgeKey.get(edgeKey);
          return [
            edgeKey,
            resolvedEdgeKeySet.has(edgeKey)
              ? Object.freeze({ status: "resolved" as const })
              : unavailableReason
              ? Object.freeze({
                  status: "rejected" as const,
                  reason: unavailableReason,
                })
              : Object.freeze({
                  status: "unresolved" as const,
                  reason:
                    "required current-block edge did not resolve for its stateKey",
                }),
          ] as const;
        }),
      );
      const stateByStateKey = new FrozenReadonlyMap(
        lanes
          .flatMap((lane) => lane.states)
          .filter(([stateKey]) => resolvedStateKeySet.has(stateKey))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const familyIds = uniqueSorted([
        ...ownership.groups.map((group) => group.familyId),
        ...graphIncompleteFamilyIds,
      ]);
      const resolvedFamilyIds = Object.freeze(
        familyIds.filter((familyId) =>
          terminalFamilyIds.has(familyId) &&
          ownership.groups
            .filter((group) => group.familyId === familyId)
            .every((group) => resolvedStateKeySet.has(group.stateKey))
        ),
      );
      const resolvedFamilySet = new Set(resolvedFamilyIds);
      const incompleteFamilyIds = Object.freeze(
        familyIds.filter((familyId) => !resolvedFamilySet.has(familyId)),
      );
      const snapshot: BlockScanStateSnapshot = Object.freeze({
        generation: graph.generation,
        sourceBlock: graph.sourceBlock,
        sourceBlockHash: graph.sourceBlockHash,
        graph,
        mids,
        coverageByReadKey,
        coverageByEdgeKey,
        freshnessByReadKey,
        stateByStateKey,
        resolvedFamilyIds,
        incompleteFamilyIds,
        coverage,
        laneTelemetry,
        familyTelemetry,
      });
      if (this.active?.token !== token || controller.signal.aborted) {
        return incompleteResult({
          graph,
          ownership,
          issues: [issueFromAbort(controller.signal.reason, graph.generation)],
          laneTelemetry,
          familyTelemetry,
        });
      }
      /*
       * Static schemas may contain chain-derived metadata (decimals and ABI
       * probes). Commit them only after the same canonical CAS and generation
       * fence as the snapshot. A failed or superseded generation must not
       * donate orphan-fork schema state to its successor.
       */
      for (const [familyId, schema] of lanes.flatMap(
        (lane) => lane.stagedStaticSchemas,
      )) {
        this.staticSchemas.set(familyId, schema);
      }
      this.previousCanonicalGraphStateKeys = new Set(
        ownership.groups.map((group) => group.stateKey),
      );
      const groupByStateKey = new Map(
        ownership.groups.map((group) => [group.stateKey, group] as const),
      );
      for (const [stateKey, state] of stateByStateKey) {
        const group = groupByStateKey.get(stateKey);
        if (!group) {
          throw new Error(
            `published state ${stateKey} has no ownership group`,
          );
        }
        const existingBase = this.lastGoodByStateKey.get(stateKey);
        this.lastGoodByStateKey.set(stateKey, Object.freeze({
          state,
          schemaFingerprint: stateSchemaFingerprint(group.edges),
          requiredReadKeyHash: exactSetHash(state.requiredReadKeys),
          midsByEdgeKey: existingBase?.midsByEdgeKey ?? new Map(),
          unavailableByEdgeKey:
            existingBase?.unavailableByEdgeKey ?? new Map(),
        }));
      }
      this.published = snapshot;
      if (this.protocolAddressTouchMode === "shadow") {
        this.finishProtocolAddressTouchShadow(
          protocolAddressTouchShadow,
          snapshot,
        );
      }
      const degraded =
        incompleteFamilyIds.length > 0 ||
        coverage.unresolvedStateKeys.length > 0 ||
        coverage.unresolvedReadKeys.length > 0 ||
        coverage.unresolvedEdgeKeys.length > 0 ||
        issues.length > 0;
      return Object.freeze({
        status: degraded ? "degraded" as const : "complete" as const,
        generation: graph.generation,
        sourceBlock: graph.sourceBlock,
        sourceBlockHash: graph.sourceBlockHash,
        coverage,
        issues: freezeIssues(issues),
        laneTelemetry,
        familyTelemetry,
        snapshot,
      });
    } finally {
      clearTimeout(deadlineTimer);
      detachExternal();
      this.cacheModeActive = false;
      if (this.active?.token === token) this.active = null;
    }
  }

  private beginProtocolAddressTouchShadow(
    previous: BlockScanStateSnapshot | null,
    groups: readonly StateGroup[],
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): ProtocolAddressTouchShadowAttempt | null {
    if (
      this.protocolAddressTouchMode === "off" ||
      (this.protocolAddressTouchMode === "shadow" &&
        !this.onProtocolAddressTouchShadowTelemetry) ||
      !this.backend.readCanonicalAddressTouches ||
      !previous ||
      previous.sourceBlock >= graph.sourceBlock ||
      graph.sourceBlock - previous.sourceBlock > 8 ||
      graph.generation <= previous.generation ||
      groups.length === 0
    ) {
      return null;
    }
    const fromExclusive = Object.freeze({
      number: previous.sourceBlock,
      hash: previous.sourceBlockHash,
      generation: previous.generation,
    });
    const through = Object.freeze({
      number: graph.sourceBlock,
      hash: graph.sourceBlockHash,
      generation: graph.generation,
    });
    const previousByStateKey = new Map<string, PublishedStateKey>();
    for (const group of groups) {
      const recovery = this.recoveryBaseForGroup(group);
      if (
        recovery &&
        recovery.schemaFingerprint === stateSchemaFingerprint(group.edges) &&
        sameBlockSource(recovery.state.source, fromExclusive)
      ) {
        previousByStateKey.set(group.stateKey, recovery.state);
      }
    }
    const proof = this.backend.readCanonicalAddressTouches(
      fromExclusive,
      through,
      { deadlineAtMs, signal },
    );
    // The full state lanes can take seconds; attach a rejection observer now
    // and let the terminal shadow comparison classify it later.
    proof.catch(() => undefined);
    return Object.freeze({
      startedAtMs: this.now(),
      fromExclusive,
      through,
      groups: Object.freeze([...groups]),
      previousByStateKey,
      proof,
    });
  }

  private finishProtocolAddressTouchShadow(
    attempt: ProtocolAddressTouchShadowAttempt | null,
    current: BlockScanStateSnapshot,
  ): void {
    if (!attempt || !this.onProtocolAddressTouchShadowTelemetry) return;
    const callback = this.onProtocolAddressTouchShadowTelemetry;
    void attempt.proof.then((proof) => {
      const touched = new Set(proof.touchedAddresses);
      let predictedDirtyStateKeys = 0;
      let predictedCarryStateKeys = 0;
      let comparableCarryStateKeys = 0;
      let mismatchStateKeys = 0;
      const mismatchFamilyIds = new Set<string>();
      const familyRows = new Map<string, {
        familyId: string;
        stateKeys: number;
        predictedDirtyStateKeys: number;
        predictedCarryStateKeys: number;
        comparableCarryStateKeys: number;
        mismatchStateKeys: number;
      }>();
      for (const group of attempt.groups) {
        const familyRow = familyRows.get(group.familyId) ?? {
          familyId: group.familyId,
          stateKeys: 0,
          predictedDirtyStateKeys: 0,
          predictedCarryStateKeys: 0,
          comparableCarryStateKeys: 0,
          mismatchStateKeys: 0,
        };
        familyRows.set(group.familyId, familyRow);
        familyRow.stateKeys++;
        const previous = attempt.previousByStateKey.get(group.stateKey);
        const dependencies = group.family.dependencies(group.edges);
        const dependencySetValid = dependencies.every(isCanonicalAddress);
        const dirty =
          !previous ||
          !dependencySetValid ||
          dependencies.some((address) => touched.has(address.toLowerCase()));
        if (dirty) {
          predictedDirtyStateKeys++;
          familyRow.predictedDirtyStateKeys++;
          continue;
        }
        predictedCarryStateKeys++;
        familyRow.predictedCarryStateKeys++;
        const next = current.stateByStateKey.get(group.stateKey);
        if (!next) continue;
        comparableCarryStateKeys++;
        familyRow.comparableCarryStateKeys++;
        try {
          if (
            semanticStateHash(previous, group.edges) !==
              semanticStateHash(next, group.edges)
          ) {
            mismatchStateKeys++;
            familyRow.mismatchStateKeys++;
            mismatchFamilyIds.add(group.familyId);
          }
        } catch {
          mismatchStateKeys++;
          familyRow.mismatchStateKeys++;
          mismatchFamilyIds.add(group.familyId);
        }
      }
      safelyEmitProtocolAddressTouchShadow(callback, Object.freeze({
        status: "complete" as const,
        fromBlock: proof.fromExclusive.number,
        throughBlock: proof.through.number,
        wallMs: Math.max(0, this.now() - attempt.startedAtMs),
        touchedAddresses: proof.touchedAddresses.length,
        transactionCount: proof.transactionCount,
        protocolStateKeys: attempt.groups.length,
        predictedDirtyStateKeys,
        predictedCarryStateKeys,
        comparableCarryStateKeys,
        mismatchStateKeys,
        mismatchFamilyIds: Object.freeze([...mismatchFamilyIds].sort()),
        families: Object.freeze(
          [...familyRows.values()]
            .sort((left, right) => left.familyId.localeCompare(right.familyId))
            .map((row) => Object.freeze({ ...row })),
        ),
      }));
    }).catch((error) => {
      safelyEmitProtocolAddressTouchShadow(callback, Object.freeze({
        status: "unavailable" as const,
        fromBlock: attempt.fromExclusive.number,
        throughBlock: attempt.through.number,
        wallMs: Math.max(0, this.now() - attempt.startedAtMs),
        protocolStateKeys: attempt.groups.length,
        unavailableReason: protocolAddressTouchUnavailableReason(error),
      }));
    });
  }

  private async resolveProtocolAddressTouchPlans(
    attempt: ProtocolAddressTouchShadowAttempt | null,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, FamilyIncrementalPlan>> {
    if (!attempt) return new Map();
    try {
      const proof = await awaitWithAbort(attempt.proof, signal);
      const touched = new Set(proof.touchedAddresses);
      const plans = new Map<string, FamilyIncrementalPlan>();
      let predictedDirtyStateKeys = 0;
      let predictedCarryStateKeys = 0;
      const groupsByFamily = new Map<string, StateGroup[]>();
      for (const group of attempt.groups) {
        if (group.family.addressTouchCarryPolicy !== "dependency-touch") {
          continue;
        }
        const familyGroups = groupsByFamily.get(group.familyId) ?? [];
        familyGroups.push(group);
        groupsByFamily.set(group.familyId, familyGroups);
      }
      for (const [familyId, groups] of groupsByFamily) {
        const rangeByStateKey = new Map<string, CanonicalMutationRange>();
        const previousByStateKey = new Map<string, PublishedStateKey>();
        const schemaCompatibleStateKeys = new Set<string>();
        const changedReadKeysByStateKey = new Map<
          string,
          ReadonlySet<string>
        >();
        const dependencyFingerprint = deterministicHash(
          groups.map((group) => ({
            stateKey: group.stateKey,
            dependencies: [...group.family.dependencies(group.edges)]
              .map((address) => address.toLowerCase())
              .sort(),
          })),
        );
        const range: CanonicalMutationRange = Object.freeze({
          fromExclusive: proof.fromExclusive,
          through: proof.through,
          events: Object.freeze([]),
          complete: true as const,
          queryDescriptorFingerprint: dependencyFingerprint,
          canonicalPathFingerprint: proof.rangeFingerprint,
          rangeFingerprint: deterministicHash({
            proof: proof.rangeFingerprint,
            familyId,
            dependencyFingerprint,
          }),
        });
        for (const group of groups) {
          const previous = attempt.previousByStateKey.get(group.stateKey);
          const dependencies = group.family.dependencies(group.edges);
          if (
            !previous ||
            dependencies.length === 0 ||
            dependencies.some((address) => !isCanonicalAddress(address))
          ) {
            predictedDirtyStateKeys++;
            continue;
          }
          rangeByStateKey.set(group.stateKey, range);
          previousByStateKey.set(group.stateKey, previous);
          schemaCompatibleStateKeys.add(group.stateKey);
          if (
            dependencies.some((address) => touched.has(address.toLowerCase()))
          ) {
            predictedDirtyStateKeys++;
            changedReadKeysByStateKey.set(
              group.rawStateKey,
              new Set(previous.requiredReadKeys),
            );
          } else {
            predictedCarryStateKeys++;
          }
        }
        if (schemaCompatibleStateKeys.size === 0) continue;
        const classification: FamilyMutationClassification = Object.freeze({
          mutationRangeFingerprint: range.rangeFingerprint,
          classifierFingerprint: deterministicHash({
            kind: "canonical-address-touch",
            familyId,
            dependencyFingerprint,
          }),
          changedReadKeysByStateKey,
        });
        plans.set(familyId, Object.freeze({
          familyId,
          rangeByStateKey,
          classificationByStateKey: new Map(
            [...schemaCompatibleStateKeys].map((stateKey) => [
              stateKey,
              classification,
            ] as const),
          ),
          previousByStateKey,
          schemaCompatibleStateKeys,
        }));
      }
      if (this.onProtocolAddressTouchShadowTelemetry) {
        safelyEmitProtocolAddressTouchShadow(
          this.onProtocolAddressTouchShadowTelemetry,
          Object.freeze({
            status: "complete" as const,
            fromBlock: proof.fromExclusive.number,
            throughBlock: proof.through.number,
            wallMs: Math.max(0, this.now() - attempt.startedAtMs),
            touchedAddresses: proof.touchedAddresses.length,
            transactionCount: proof.transactionCount,
            protocolStateKeys: attempt.groups.length,
            predictedDirtyStateKeys,
            predictedCarryStateKeys,
          }),
        );
      }
      return plans;
    } catch (error) {
      if (this.onProtocolAddressTouchShadowTelemetry) {
        safelyEmitProtocolAddressTouchShadow(
          this.onProtocolAddressTouchShadowTelemetry,
          Object.freeze({
            status: "unavailable" as const,
            fromBlock: attempt.fromExclusive.number,
            throughBlock: attempt.through.number,
            wallMs: Math.max(0, this.now() - attempt.startedAtMs),
            protocolStateKeys: attempt.groups.length,
            unavailableReason: protocolAddressTouchUnavailableReason(error),
          }),
        );
      }
      return new Map();
    }
  }

  /**
   * A complete-topology family may treat incremental refresh as an
   * optimization and fall back to direct current-N reads. For a family whose
   * topology proof is lagging, the caller consumes the absence of a plan as
   * unresolved established state instead; this method never decides admission.
   */
  private async prepareIncrementalPlans(
    groups: readonly StateGroup[],
    compiledFamilies: ReadonlyMap<string, CompiledBlockScanStateFamily>,
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
    generationSignal: AbortSignal,
  ): Promise<IncrementalPreparation> {
    const plans = new Map<string, FamilyIncrementalPlan>();
    const missingPreviousStateKeysByFamily = new Map<string, number>();
    const fullFallbackReasonByFamily = new Map<string, string>();
    const fullFallbackDetailByFamily = new Map<string, string>();
    const phaseTimingByFamily = new Map<
      string,
      {
        descriptorMs: number;
        rangeMs: number;
        classifierMs: number;
      }
    >();
    const readRange = this.backend.readCanonicalMutationRange;
    const families = uniqueFamilies(groups);
    for (const family of families) {
      const familyGroups = groups.filter(
        (group) => group.familyId === family.familyId,
      );
      missingPreviousStateKeysByFamily.set(
        family.familyId,
        familyGroups.filter((group) =>
          !this.recoveryBaseForGroup(group)
        ).length,
      );
    }
    if (!readRange) {
      for (const family of families) {
        if (compiledFamilies.get(family.familyId)?.incremental) {
          fullFallbackReasonByFamily.set(
            family.familyId,
            "mutation-range-reader-unavailable",
          );
        }
      }
      return {
        plans,
        missingPreviousStateKeysByFamily,
        fullFallbackReasonByFamily,
        fullFallbackDetailByFamily,
        phaseTimingByFamily,
      };
    }
    const through: BlockSource = Object.freeze({
      number: graph.sourceBlock,
      hash: graph.sourceBlockHash,
      generation: graph.generation,
    });
    await Promise.all(families.map(async (family) => {
      if (signal.aborted) {
        fullFallbackReasonByFamily.set(
          family.familyId,
          "mutation-range-pre-aborted",
        );
        fullFallbackDetailByFamily.set(
          family.familyId,
          "preflight:aborted",
        );
        return;
      }
      const familyGroups = groups.filter(
        (group) => group.familyId === family.familyId,
      );
      const recoveryByStateKey = new Map(
        familyGroups.flatMap((group) => {
          const base = this.recoveryBaseForGroup(group);
          return base ? [[group.stateKey, base] as const] : [];
        }),
      );
      const familyGroupByStateKey = new Map(
        familyGroups.map((group) => [group.stateKey, group] as const),
      );
      const eligibleByStateKey = new Map(
        [...recoveryByStateKey].filter(([stateKey, base]) => {
          const group = familyGroupByStateKey.get(stateKey);
          const distance = through.number - base.state.source.number;
          return (
            group !== undefined &&
            base.schemaFingerprint === stateSchemaFingerprint(group.edges) &&
            distance > 0 &&
            distance <= this.incrementalRangeBlocks &&
            through.generation > base.state.source.generation
          );
        }),
      );
      if (eligibleByStateKey.size === 0) {
        fullFallbackReasonByFamily.set(
          family.familyId,
          recoveryByStateKey.size === 0
            ? "previous-snapshot-unavailable"
            : "mutation-range-ineligible",
        );
        return;
      }
      /*
       * Every adapter family gets the event-driven update pipe, not just the
       * ones that hand-wrote an incremental capability. The mutation topics
       * are scanned from the adapter's landed-event declaration at
       * registration; the derived classifier re-reads exactly the pools that
       * emitted one of those topics in the range (whole-pool refresh through
       * the pool -> edges -> stateKeys reverse index) and carries everything
       * else from its last good state. Coarse mids may be a block stale for
       * off-event changes by design; candidate exact join at current N and
       * the periodic full rewarm bound the staleness.
       */
      let incremental = compiledFamilies.get(family.familyId)?.incremental;
      if (!incremental) {
        incremental = createDerivedSwapMutationIncremental({
          familyId: family.familyId,
          mutationEvents: family.mutationEvents,
          family,
          familyGroups,
          eligibleByStateKey,
          topologyIndex: this.topologyIndex!,
        }) ?? undefined;
      }
      if (!incremental) return;
      const previousByStateKey = new Map<string, PublishedStateKey>();
      const schemaCompatibleStateKeys = new Set<string>();
      for (const [stateKey, base] of eligibleByStateKey) {
        previousByStateKey.set(stateKey, base.state);
        schemaCompatibleStateKeys.add(stateKey);
      }
      let phase:
        | "mutation-descriptor-failed"
        | "mutation-range-failed"
        | "mutation-classifier-failed" = "mutation-descriptor-failed";
      const timing = {
        descriptorMs: 0,
        rangeMs: 0,
        classifierMs: 0,
      };
      phaseTimingByFamily.set(family.familyId, timing);
      try {
        const edges = Object.freeze(
          familyGroups.flatMap((group) => group.edges),
        );
        const descriptorStartedAtMs = this.now();
        let descriptor: MutationQueryDescriptor;
        try {
          descriptor = incremental.mutationQueryDescriptor(edges);
        } finally {
          timing.descriptorMs = Math.max(
            0,
            this.now() - descriptorStartedAtMs,
          );
        }
        if (isThenable(descriptor)) {
          throw new Error("mutationQueryDescriptor must return synchronously");
        }
        if (
          descriptor.fingerprint !==
          mutationQueryDescriptorFingerprint(descriptor)
        ) {
          throw new Error("mutation query descriptor fingerprint mismatch");
        }
        const stateKeysBySource = new Map<
          string,
          {
            readonly source: BlockSource;
            readonly stateKeys: string[];
          }
        >();
        for (const [stateKey, base] of eligibleByStateKey) {
          const source = base.state.source;
          const sourceKey = [
            source.number,
            source.hash.toLowerCase(),
            source.generation,
          ].join("\u001f");
          const current = stateKeysBySource.get(sourceKey);
          if (current) current.stateKeys.push(stateKey);
          else {
            stateKeysBySource.set(sourceKey, {
              source,
              stateKeys: [stateKey],
            });
          }
        }
        const settledRanges = await Promise.all(
          [...stateKeysBySource.values()].map(async (sourceGroup) => {
            let localPhase:
              | "mutation-range-failed"
              | "mutation-classifier-failed" =
                "mutation-range-failed";
            const rangeStartedAtMs = this.now();
            try {
              const range = await awaitWithAbort(
                readRange.call(
                  this.backend,
                  descriptor,
                  sourceGroup.source,
                  through,
                  {
                    deadlineAtMs,
                    // The generation owns the shared transport. A family
                    // timeout may classify that family as incomplete only
                    // after the physical canonical request settles, so an
                    // orphaned proof cannot contend with the next generation.
                    signal: generationSignal,
                    sharedSignal: generationSignal,
                  },
                ),
                generationSignal,
              );
              if (signal.aborted) {
                throw signal.reason ??
                  new Error(`family ${family.familyId} proof deadline reached`);
              }
              const rangeMs = Math.max(
                0,
                this.now() - rangeStartedAtMs,
              );
              validateCanonicalMutationRange(
                range,
                descriptor,
                sourceGroup.source,
                through,
              );
              localPhase = "mutation-classifier-failed";
              const classifierStartedAtMs = this.now();
              let classification: FamilyMutationClassification;
              try {
                classification = incremental.classifyMutations({
                  edges,
                  range,
                });
              } finally {
                timing.classifierMs += Math.max(
                  0,
                  this.now() - classifierStartedAtMs,
                );
              }
              if (isThenable(classification)) {
                throw new Error(
                  "classifyMutations must return synchronously",
                );
              }
              validateMutationClassification(
                classification,
                range,
                familyGroups,
              );
              return Object.freeze({
                status: "fulfilled" as const,
                sourceGroup,
                range,
                classification,
                rangeMs,
              });
            } catch (error) {
              return Object.freeze({
                status: "rejected" as const,
                sourceGroup,
                phase: localPhase,
                error,
                rangeMs: Math.max(0, this.now() - rangeStartedAtMs),
              });
            }
          }),
        );
        timing.rangeMs = settledRanges.reduce(
          (maximum, result) => Math.max(maximum, result.rangeMs),
          0,
        );
        const rangeByStateKey = new Map<string, CanonicalMutationRange>();
        const classificationByStateKey = new Map<
          string,
          FamilyMutationClassification
        >();
        for (const result of settledRanges) {
          if (result.status !== "fulfilled") continue;
          for (const stateKey of result.sourceGroup.stateKeys) {
            rangeByStateKey.set(stateKey, result.range);
            classificationByStateKey.set(
              stateKey,
              result.classification,
            );
          }
        }
        if (rangeByStateKey.size === 0) {
          const firstFailure = settledRanges.find(
            (result) => result.status === "rejected",
          );
          phase = firstFailure?.phase ?? "mutation-range-failed";
          const error = firstFailure?.error ??
            new Error("no recovery range settled");
          fullFallbackReasonByFamily.set(family.familyId, phase);
          fullFallbackDetailByFamily.set(
            family.familyId,
            sanitizedIncrementalFailureDetail(phase, error, signal),
          );
          return;
        }
        plans.set(family.familyId, Object.freeze({
          familyId: family.familyId,
          rangeByStateKey,
          classificationByStateKey,
          previousByStateKey,
          schemaCompatibleStateKeys,
        }));
      } catch (error) {
        // The caller decides whether absence of a proof permits direct reads
        // (complete topology/bootstrap) or must remain unresolved.
        fullFallbackReasonByFamily.set(family.familyId, phase);
        fullFallbackDetailByFamily.set(
          family.familyId,
          sanitizedIncrementalFailureDetail(phase, error, signal),
        );
      }
    }));
    return {
      plans,
      missingPreviousStateKeysByFamily,
      fullFallbackReasonByFamily,
      fullFallbackDetailByFamily,
      phaseTimingByFamily,
    };
  }

  /**
   * Phase 1 of a generation: compile every family's static schema and
   * resolve every canonical mutation-range proof (per family, bounded by the
   * family timeout), returning the prepared context the read phase consumes.
   * All families' proofs settle before any direct state read begins, so
   * foreground proofs never preempt background bulk reads mid-generation.
   */
  private async prepareFamilyPhase(input: {
    readonly lane: BlockScanPricingLane;
    readonly groups: readonly StateGroup[];
    readonly graph: VerifiedGraphView;
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal;
    readonly generationSignal: AbortSignal;
    readonly previousCanonicalGraphStateKeys: ReadonlySet<string> | null;
    readonly addressTouchPlan?: FamilyIncrementalPlan;
  }): Promise<PreparedFamilyPhase> {
    const { lane, groups, graph } = input;
    const familyId = groups[0]?.familyId;
    if (!familyId) {
      throw new Error("empty family phase has no familyId");
    }
    const startedAtMs = this.now();
    const localBudgetMs = Math.min(
      this.familyTimeoutMs,
      Math.max(0, input.deadlineAtMs - startedAtMs),
    );
    const familyDeadlineAtMs = Math.min(
      input.deadlineAtMs,
      startedAtMs + localBudgetMs,
    );
    const familyController = new AbortController();
    const detachParent = linkAbortSignal(input.signal, familyController);
    const deadlineTimer = setTimeout(
      () =>
        familyController.abort(
          new FamilyDeadlineAbort(familyId, localBudgetMs),
        ),
      Math.max(0, familyDeadlineAtMs - this.now()),
    );
    if (familyDeadlineAtMs <= startedAtMs) {
      familyController.abort(
        input.signal.aborted
          ? input.signal.reason
          : new FamilyDeadlineAbort(familyId, localBudgetMs),
      );
    }
    try {
      let recoveryCandidateStateKeys = new Set<string>();
      const issues: BlockScanStateIssue[] = [];
      const compiledFamilies = new Map<
        string,
        CompiledBlockScanStateFamily
      >();
      let schemaPhysicalReads = 0;
      let schemaBatches = 0;
      const staging: FamilyLaneStaging = {
        staticSchemas: new Map(),
        expectedReadKeys: new Set(),
        reads: 0,
        batches: 0,
        carryStateKeys: 0,
        directStateKeys: groups.length,
        missingPreviousStateKeys: groups.filter(
          (group) => !this.recoveryBaseForGroup(group),
        ).length,
      };
      const families = uniqueFamilies(groups);
      try {
        await Promise.all(families.map(async (family) => {
          const familyEdges = groups
            .filter((group) => group.familyId === family.familyId)
            .flatMap((group) => group.edges);
          const edgeFingerprint = stateSchemaFingerprint(familyEdges);
          const cached = this.staticSchemas.get(family.familyId);
          if (cached?.edgeFingerprint === edgeFingerprint) {
            compiledFamilies.set(family.familyId, cached);
            return;
          }
          try {
            const compiled = await awaitWithAbort(
              (cached?.recompile ?? family.compile)({
                edges: Object.freeze(familyEdges),
                deadlineAtMs: familyDeadlineAtMs,
                signal: familyController.signal,
                sourceBlock: graph.sourceBlock,
                sourceBlockHash: graph.sourceBlockHash,
                readStatic: async (reads) => {
                  const seen = new Set<string>();
                  for (const read of reads) {
                    validateRead(read, graph);
                    if (!read.id || seen.has(read.id)) {
                      throw new Error(
                        `duplicate or empty static read id ${read.id}`,
                      );
                    }
                    seen.add(read.id);
                  }
                  schemaPhysicalReads += reads.length;
                  schemaBatches++;
                  staging.reads += reads.length;
                  staging.batches++;
                  const results = await awaitWithAbort(
                    this.backend.readBatch(
                      lane,
                      reads,
                      {
                        sourceBlock: graph.sourceBlock,
                        sourceBlockHash: graph.sourceBlockHash,
                        sourceGeneration: graph.generation,
                        deadlineAtMs: familyDeadlineAtMs,
                        signal: familyController.signal,
                      },
                    ),
                    familyController.signal,
                  );
                  const byId = new Map<string, StateReadResult>();
                  for (const result of results) {
                    if (!seen.has(result.id) || byId.has(result.id)) {
                      throw new Error(
                        "static backend result IDs did not exactly match reads",
                      );
                    }
                    if (
                      !stateReadResultMatchesSource(
                        this.backend,
                        result,
                        graph,
                      )
                    ) {
                      throw new Error(
                        "static read result lacks current source provenance",
                      );
                    }
                    if (!result.ok) {
                      throw new Error(
                        `static read ${result.id} failed: ${result.error}`,
                      );
                    }
                    byId.set(result.id, result);
                  }
                  if (byId.size !== seen.size) {
                    throw new Error("static backend omitted one or more reads");
                  }
                  return Object.freeze([...byId.values()]);
                },
              }),
              familyController.signal,
            );
            if (compiled.edgeFingerprint !== edgeFingerprint) {
              throw new Error("compiled family schema fingerprint mismatch");
            }
            compiledFamilies.set(family.familyId, compiled);
            staging.staticSchemas.set(family.familyId, compiled);
          } catch (error) {
            issues.push({
              kind: issueKindFromError(error),
              lane,
              familyId: family.familyId,
              message: formatError(error),
            });
          }
        }));
      } catch (error) {
        issues.push({
          kind: issueKindFromError(error),
          lane,
          message: formatError(error),
        });
      }
      if (compiledFamilies.get(familyId)?.incremental) {
        recoveryCandidateStateKeys = new Set(
          groups.flatMap((group) => {
            const base = this.recoveryBaseForGroup(group);
            const previouslyEstablished =
              input.previousCanonicalGraphStateKeys?.has(group.stateKey) ??
              false;
            const newlyAdmitted =
              input.previousCanonicalGraphStateKeys !== null &&
              !previouslyEstablished;
            return (
                base &&
                  graph.sourceBlock - base.state.source.number >
                    this.incrementalRangeBlocks
              ) || (previouslyEstablished && !base) || newlyAdmitted
              ? [group.stateKey]
              : [];
          }),
        );
        staging.recoveryRequiredStateKeys =
          recoveryCandidateStateKeys.size > 0
            ? recoveryCandidateStateKeys.size
            : undefined;
      }
      const hotRecoveryStateKeys = this.selectHotRecoveryStateKeys(
        familyId,
        recoveryCandidateStateKeys,
      );
      const incrementalPreparation = await this.prepareIncrementalPlans(
        groups,
        compiledFamilies,
        graph,
        familyDeadlineAtMs,
        familyController.signal,
        input.generationSignal,
      );
      const incrementalPlans = incrementalPreparation.plans;
      if (input.addressTouchPlan && !incrementalPlans.has(familyId)) {
        incrementalPlans.set(familyId, input.addressTouchPlan);
      }
      let fullFallbackReason =
        incrementalPreparation.fullFallbackReasonByFamily.get(familyId);
      let fullFallbackDetail =
        incrementalPreparation.fullFallbackDetailByFamily.get(familyId);
      const incrementalTiming =
        incrementalPreparation.phaseTimingByFamily.get(familyId);
      const missingPreviousStateKeys = groups.filter(
        (group) => !this.recoveryBaseForGroup(group),
      ).length;
      staging.missingPreviousStateKeys = missingPreviousStateKeys;
      staging.fullFallbackReason = fullFallbackReason;
      staging.fullFallbackDetail = fullFallbackDetail;
      staging.incrementalDescriptorMs = incrementalTiming?.descriptorMs;
      staging.incrementalRangeMs = incrementalTiming?.rangeMs;
      staging.incrementalClassifierMs = incrementalTiming?.classifierMs;
      return Object.freeze({
        familyId,
        lane,
        compiledFamilies,
        incrementalPreparation,
        recoveryCandidateStateKeys,
        hotRecoveryStateKeys,
        staging,
        issues: Object.freeze(issues),
        ...(input.addressTouchPlan === undefined
          ? {}
          : { addressTouchPlan: input.addressTouchPlan }),
      });
    } finally {
      clearTimeout(deadlineTimer);
      detachParent();
    }
  }

  private async runLane(
    lane: BlockScanPricingLane,
    groups: readonly StateGroup[],
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
    preparedPhaseByFamily: ReadonlyMap<string, PreparedFamilyPhase>,
  ): Promise<LaneResult> {
    const startedAtMs = this.now();
    if (groups.length === 0) {
      return emptyLane(lane, startedAtMs, this.now());
    }
    const familyRuns = uniqueFamilies(groups).map(async (family) => {
      const familyGroups = groups.filter(
        (group) => group.familyId === family.familyId,
      );
      const familyStartedAtMs = this.now();
      const familyController = new AbortController();
      const detachParent = linkAbortSignal(signal, familyController);
      const localBudgetMs = Math.min(
        this.familyTimeoutMs,
        Math.max(0, deadlineAtMs - familyStartedAtMs),
      );
      const familyDeadlineAtMs = Math.min(
        deadlineAtMs,
        familyStartedAtMs + localBudgetMs,
      );
      const familyDeadline = new FamilyDeadlineAbort(
        family.familyId,
        localBudgetMs,
      );
      const deadlineTimer = setTimeout(
        () => familyController.abort(familyDeadline),
        Math.max(0, familyDeadlineAtMs - this.now()),
      );
      if (familyDeadlineAtMs <= familyStartedAtMs) {
        familyController.abort(
          signal.aborted
            ? signal.reason
            : familyDeadline,
        );
      }

      /*
       * A family owns this staging map until its complete lane result wins the
       * local deadline race. A late compile/read may finish in user/backend
       * code, but it has no reference to sibling staging or publication.
       */
      const prepared = preparedPhaseByFamily.get(family.familyId);
      if (!prepared) {
        return failedFamilyLane(
          lane,
          family.familyId,
          familyGroups.length,
          familyStartedAtMs,
          this.now(),
          {
            staticSchemas: new Map(),
            expectedReadKeys: new Set(),
            reads: 0,
            batches: 0,
            carryStateKeys: 0,
            directStateKeys: familyGroups.length,
            missingPreviousStateKeys: familyGroups.length,
          },
          new Error(
            `family ${family.familyId} missing prepared incremental phase`,
          ),
        );
      }
      const staging = prepared.staging;
      const familyRun = this.runFamilyLane(
        lane,
        familyGroups,
        graph,
        familyDeadlineAtMs,
        familyController.signal,
        signal,
        prepared,
      );
      try {
        /*
         * Do not race the family result against its local deadline here.
         * runFamilyLane owns abort-aware settlement of every compile/read and
         * can still return stateKeys whose carry proof or direct read completed
         * before a sibling stateKey timed out. Racing at this boundary erased
         * that safe partial result and turned one late pool into a whole-family
         * pricing loss. A generation-level abort remains fail-closed below.
         */
        const result = await awaitWithAbort(familyRun, signal);
        if (signal.aborted) {
          throw signal.reason ??
            new Error(`block-scan state family ${family.familyId} aborted`);
        }
        return result;
      } catch (error) {
        return failedFamilyLane(
          lane,
          family.familyId,
          familyGroups.length,
          familyStartedAtMs,
          this.now(),
          staging,
          error,
        );
      } finally {
        clearTimeout(deadlineTimer);
        detachParent();
        familyRun.catch(() => undefined);
      }
    });
    const familyResults = await Promise.all(familyRuns);
    const finishedAtMs = this.now();
    return mergeFamilyLaneResults(
      lane,
      groups.length,
      startedAtMs,
      finishedAtMs,
      familyResults,
    );
  }

  private async runFamilyLane(
    lane: BlockScanPricingLane,
    groups: readonly StateGroup[],
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
    generationSignal: AbortSignal,
    prepared: PreparedFamilyPhase,
  ): Promise<LaneResult> {
    const startedAtMs = this.now();
    if (groups.length === 0) {
      return emptyLane(lane, startedAtMs, this.now());
    }
    const familyId = groups[0]?.familyId;
    if (!familyId) {
      throw new Error("non-empty family lane has no familyId");
    }
    const issues: BlockScanStateIssue[] = [...prepared.issues];
    const compiledFamilies = prepared.compiledFamilies;
    const incrementalPreparation = prepared.incrementalPreparation;
    const incrementalPlans = new Map(incrementalPreparation.plans);
    if (prepared.addressTouchPlan && !incrementalPlans.has(familyId)) {
      incrementalPlans.set(familyId, prepared.addressTouchPlan);
    }
    let fullFallbackReason =
      incrementalPreparation.fullFallbackReasonByFamily.get(familyId);
    let fullFallbackDetail =
      incrementalPreparation.fullFallbackDetailByFamily.get(familyId);
    const incrementalTiming =
      incrementalPreparation.phaseTimingByFamily.get(familyId);
    const missingPreviousStateKeys = groups.filter(
      (group) => !this.recoveryBaseForGroup(group),
    ).length;
    const recoveryCandidateStateKeys = prepared.recoveryCandidateStateKeys;
    const hotRecoveryStateKeys = prepared.hotRecoveryStateKeys;
    const staging = prepared.staging;
    let carryStateKeys = 0;
    let directStateKeys = groups.length;
    staging.carryStateKeys = carryStateKeys;
    staging.directStateKeys = directStateKeys;
    staging.missingPreviousStateKeys = missingPreviousStateKeys;
    staging.fullFallbackReason = fullFallbackReason;
    staging.fullFallbackDetail = fullFallbackDetail;
    staging.incrementalDescriptorMs = incrementalTiming?.descriptorMs;
    staging.incrementalRangeMs = incrementalTiming?.rangeMs;
    staging.incrementalClassifierMs = incrementalTiming?.classifierMs;

    interface PlannedRead {
      readonly group: StateGroup;
      readonly localId: string;
      readonly globalId: string;
      readonly read: StateRead;
    }
    const plannedByStateKey = new Map<string, PlannedRead[]>();
    const resultsByGlobalId = new Map<string, StateReadResult>();
    const localResultsByStateKey = new Map<string, StateReadResult[]>();
    const seenLocalIdsByStateKey = new Map<string, Set<string>>();
    const closedStateKeys = new Set<string>();
    const carryForwardStateKeys = new Set<string>();
    const carryReadKeysByStateKey = new Map<string, readonly string[]>();
    const classifiedDirectStateKeys = new Set<string>();
    const cacheSourcedStateKeys = new Set<string>();
    const badStateKeys = new Set<string>(
      groups
        .filter((group) => !compiledFamilies.has(group.familyId))
        .map((group) => group.stateKey),
    );

    /*
     * Partition before building descriptors. Incremental families promise
     * stable local read IDs for a schema-compatible state key; the previous
     * requiredReadKeys therefore are the exact read set being proven through
     * the canonical mutation range. If the classifier names an unknown key,
     * discard its plan. Complete topology/bootstrap may then read current N;
     * proof-scoped lagging topology leaves established keys unresolved.
     */
    for (const [plannedFamilyId, plan] of incrementalPlans) {
      const familyGroups = groups.filter(
        (group) => group.familyId === plannedFamilyId,
      );
      const provisionalCarry = new Map<string, readonly string[]>();
      const provisionalDirect = new Set<string>();
      let classificationReadSetMismatch = false;
      for (const group of familyGroups) {
        if (
          badStateKeys.has(group.stateKey) ||
          !plan.schemaCompatibleStateKeys.has(group.stateKey)
        ) {
          continue;
        }
        const previousState = plan.previousByStateKey.get(group.stateKey);
        const previousReadKeys = previousState?.requiredReadKeys ?? [];
        const uniquePreviousReadKeys = new Set(previousReadKeys);
        if (
          !previousState ||
          previousReadKeys.length === 0 ||
          uniquePreviousReadKeys.size !== previousReadKeys.length ||
          previousReadKeys.some((readKey) => {
            const proof = previousState.freshnessByReadKey.get(readKey);
            return !proof ||
              !sameBlockSource(proof.source, previousState.source);
          })
        ) {
          continue;
        }
        const classification = plan.classificationByStateKey.get(
          group.stateKey,
        );
        if (!classification || !plan.rangeByStateKey.has(group.stateKey)) {
          continue;
        }
        const changed = classification.changedReadKeysByStateKey.get(
          group.rawStateKey,
        );
        if (!changed) {
          provisionalCarry.set(
            group.stateKey,
            Object.freeze([...previousReadKeys].sort()),
          );
          continue;
        }
        if (
          changed.size === 0 ||
          [...changed].some((readKey) => !uniquePreviousReadKeys.has(readKey))
        ) {
          classificationReadSetMismatch = true;
          break;
        }
        provisionalDirect.add(group.stateKey);
      }
      if (classificationReadSetMismatch) {
        incrementalPlans.delete(plannedFamilyId);
        fullFallbackReason = "mutation-classifier-read-set-mismatch";
        fullFallbackDetail = "classifier:read-set-mismatch";
        incrementalPreparation.fullFallbackReasonByFamily.set(
          plannedFamilyId,
          fullFallbackReason,
        );
        incrementalPreparation.fullFallbackDetailByFamily.set(
          plannedFamilyId,
          fullFallbackDetail,
        );
        continue;
      }
      for (const [stateKey, readKeys] of provisionalCarry) {
        carryForwardStateKeys.add(stateKey);
        carryReadKeysByStateKey.set(stateKey, readKeys);
        closedStateKeys.add(stateKey);
        for (const readKey of readKeys) {
          staging.expectedReadKeys.add(globalReadId(stateKey, readKey));
        }
      }
      for (const stateKey of provisionalDirect) {
        classifiedDirectStateKeys.add(stateKey);
      }
    }
    carryStateKeys = carryForwardStateKeys.size;
    directStateKeys = groups.filter(
      (group) =>
        !carryForwardStateKeys.has(group.stateKey) &&
        !badStateKeys.has(group.stateKey),
    ).length;
    staging.carryStateKeys = carryStateKeys;
    staging.directStateKeys = directStateKeys;
    staging.fullFallbackReason = fullFallbackReason;
    staging.fullFallbackDetail = fullFallbackDetail;

    // Schema/static reads already counted by the prepared phase.
    let physicalReads = staging.reads;
    let batches = staging.batches;
    // One initial batch plus at most four dependent batches. The fifth slot is
    // required by the strict adaptive quote ladder:
    // prerequisites -> preferred quote -> remaining quotes -> proof -> exact-out.
    // Reaching the bound is not evidence of closure: after the fifth batch, synchronously
    // ask once more and reject the state key if another read would be needed.
    const MAX_READ_ROUNDS = 5;
    let completedReadRounds = 0;
    for (let round = 0; round < MAX_READ_ROUNDS; round++) {
      const roundPlanned: PlannedRead[] = [];
      for (const group of groups) {
        if (
          badStateKeys.has(group.stateKey) ||
          closedStateKeys.has(group.stateKey)
        ) {
          continue;
        }
        if (
          round === 0 &&
          this.cacheModeActive &&
          !this.recoveryBaseForGroup(group)
        ) {
          const cacheEntry = this.cacheEntryForGroup(group, graph);
          if (cacheEntry) {
            cacheSourcedStateKeys.add(group.stateKey);
            for (const localId of cacheEntry.requiredReadKeys) {
              staging.expectedReadKeys.add(
                globalReadId(group.stateKey, localId),
              );
            }
            closedStateKeys.add(group.stateKey);
            continue;
          }
        }
        try {
          const compiled = compiledFamilies.get(group.familyId);
          if (!compiled) throw new Error("family static schema is unavailable");
          const common = {
            sourceBlock: graph.sourceBlock,
            sourceBlockHash: graph.sourceBlockHash,
            edges: group.edges,
          };
          const reads = round === 0
            ? compiled.buildCurrentBlockReads(common)
            : compiled.buildDependentBlockReads?.({
                ...common,
                completedRound: round - 1,
                priorResults: Object.freeze([
                  ...(localResultsByStateKey.get(group.stateKey) ?? []),
                ]),
              }) ?? [];
          if (isThenable(reads)) {
            throw new Error(
              round === 0
                ? "buildCurrentBlockReads must return synchronously"
                : "buildDependentBlockReads must return synchronously",
            );
          }
          if (round === 0 && reads.length === 0) {
            throw new Error("current-N state key emitted no reads");
          }
          if (round > 0 && reads.length === 0) {
            closedStateKeys.add(group.stateKey);
            continue;
          }
          const seen = seenLocalIdsByStateKey.get(group.stateKey) ?? new Set<string>();
          seenLocalIdsByStateKey.set(group.stateKey, seen);
          for (const read of reads) {
            validateRead(read, graph);
            if (!read.id || seen.has(read.id)) {
              throw new Error(`duplicate or empty local read id ${read.id}`);
            }
            seen.add(read.id);
            const globalId = globalReadId(group.stateKey, read.id);
            const item = {
              group,
              localId: read.id,
              globalId,
              read: Object.freeze({ ...read, id: globalId }),
            };
            const statePlanned =
              plannedByStateKey.get(group.stateKey) ?? [];
            statePlanned.push(item);
            plannedByStateKey.set(group.stateKey, statePlanned);
            staging.expectedReadKeys.add(globalId);
            roundPlanned.push(item);
          }
        } catch (error) {
          badStateKeys.add(group.stateKey);
          issues.push({
            kind: issueKindFromError(error, "descriptor"),
            lane,
            familyId: group.familyId,
            stateKey: group.stateKey,
            message: formatError(error),
          });
        }
      }
      const runnable = roundPlanned.filter(
        (item) =>
          !badStateKeys.has(item.group.stateKey) &&
          !carryForwardStateKeys.has(item.group.stateKey),
      );
      if (runnable.length === 0) break;
      if (signal.aborted) {
        for (const item of runnable) badStateKeys.add(item.group.stateKey);
        issues.push(Object.freeze({
          ...issueFromAbort(signal.reason, graph.generation, lane),
          familyId,
        }));
        break;
      }

      const runnableByFamily = new Map<string, typeof runnable>();
      for (const item of runnable) {
        // O(R) append: each read must be pushed once, not copied into a fresh
        // array every time (the old spread made one family's 13k reads copy
        // ~93M array slots per round).
        const bucket = runnableByFamily.get(item.group.familyId);
        if (bucket === undefined) {
          runnableByFamily.set(item.group.familyId, [item]);
        } else {
          bucket.push(item);
        }
      }
      const familyBatches = [...runnableByFamily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([familyId, items]) => {
          const descriptorGroups = deduplicatePlannedReads(items);
          return {
            familyId,
            items,
            descriptorGroups,
            physical: descriptorGroups.map((entry) => entry.representative.read),
          };
        });
      const roundPhysicalReads = familyBatches.reduce(
        (sum, familyBatch) => sum + familyBatch.physical.length,
        0,
      );
      physicalReads += roundPhysicalReads;
      batches += familyBatches.length;
      staging.reads += roundPhysicalReads;
      staging.batches += familyBatches.length;
      const settled = await Promise.all(familyBatches.map(async (familyBatch) => {
        const rawResults = await awaitWithAbort(
          this.backend.readBatch(
            lane,
            Object.freeze(familyBatch.physical),
            {
              sourceBlock: graph.sourceBlock,
              sourceBlockHash: graph.sourceBlockHash,
              sourceGeneration: graph.generation,
              deadlineAtMs,
              signal,
            },
          ),
          signal,
        );
        const expectedIds = new Set(
          familyBatch.physical.map((read) => read.id),
        );
        const rawById = new Map<string, StateReadResult>();
        for (const result of rawResults) {
          if (!expectedIds.has(result.id) || rawById.has(result.id)) {
            throw new Error(
              "backend result IDs did not exactly match scheduled reads",
            );
          }
          rawById.set(result.id, result);
        }
        if (rawById.size !== expectedIds.size) {
          throw new Error("backend omitted one or more scheduled reads");
        }
        return { ...familyBatch, rawById };
      }).map((promise) => promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      )));
      for (let index = 0; index < settled.length; index++) {
        const familyBatch = familyBatches[index];
        const result = settled[index];
        if (result.status === "rejected") {
          for (const item of familyBatch.items) {
            badStateKeys.add(item.group.stateKey);
          }
          issues.push({
            kind: issueKindFromError(result.reason, "backend"),
            lane,
            familyId: familyBatch.familyId,
            message: formatError(result.reason),
          });
          continue;
        }
        for (const descriptor of result.value.descriptorGroups) {
          const raw = result.value.rawById.get(
            descriptor.representative.globalId,
          );
          if (!raw) continue;
          for (const item of descriptor.items) {
            const local = Object.freeze({
              ...raw,
              id: item.localId,
            }) as StateReadResult;
            resultsByGlobalId.set(
              item.globalId,
              Object.freeze({ ...raw, id: item.globalId }),
            );
            const prior = localResultsByStateKey.get(item.group.stateKey) ?? [];
            prior.push(local);
            localResultsByStateKey.set(item.group.stateKey, prior);
            if (!local.ok) {
              badStateKeys.add(item.group.stateKey);
              issues.push({
                kind: mapReadFailureKind(local.kind),
                lane,
                familyId: item.group.familyId,
                stateKey: item.group.stateKey,
                message: local.error,
              });
            }
          }
        }
      }
      completedReadRounds = round + 1;
    }

    if (completedReadRounds === MAX_READ_ROUNDS) {
      for (const group of groups) {
        if (
          badStateKeys.has(group.stateKey) ||
          closedStateKeys.has(group.stateKey)
        ) {
          continue;
        }
        if (signal.aborted) {
          badStateKeys.add(group.stateKey);
          continue;
        }
        try {
          const compiled = compiledFamilies.get(group.familyId);
          if (!compiled) throw new Error("family static schema is unavailable");
          const reads = compiled.buildDependentBlockReads?.({
            sourceBlock: graph.sourceBlock,
            sourceBlockHash: graph.sourceBlockHash,
            edges: group.edges,
            completedRound: MAX_READ_ROUNDS - 1,
            priorResults: Object.freeze([
              ...(localResultsByStateKey.get(group.stateKey) ?? []),
            ]),
          }) ?? [];
          if (isThenable(reads)) {
            throw new Error("buildDependentBlockReads must return synchronously");
          }
          if (reads.length === 0) {
            closedStateKeys.add(group.stateKey);
            continue;
          }
          badStateKeys.add(group.stateKey);
          issues.push({
            kind: "resource-limited",
            lane,
            familyId: group.familyId,
            stateKey: group.stateKey,
            message:
              `dependent state reads did not close within ${MAX_READ_ROUNDS} read rounds`,
          });
        } catch (error) {
          badStateKeys.add(group.stateKey);
          issues.push({
            kind: issueKindFromError(error, "descriptor"),
            lane,
            familyId: group.familyId,
            stateKey: group.stateKey,
            message: formatError(error),
          });
        }
      }
    }

    const resolvedStateKeys: string[] = [];
    const resolvedReadKeys: string[] = [];
    const resolvedEdgeKeys: string[] = [];
    const unavailableEdges: BehaviorProvenUnavailableEdge[] = [];
    const mids: [string, RouteVenueMid][] = [];
    const freshness: [string, StateFreshnessProof][] = [];
    const states: [string, PublishedStateKey][] = [];
    for (const group of groups) {
      if (badStateKeys.has(group.stateKey)) continue;
      const cacheEntry = cacheSourcedStateKeys.has(group.stateKey)
        ? this.cacheEntryForGroup(group, graph)
        : undefined;
      const groupReads = cacheEntry
        ? []
        : (plannedByStateKey.get(group.stateKey) ?? []);
      const carryForward = carryForwardStateKeys.has(group.stateKey);
      const requiredLocalIds = cacheEntry
        ? cacheEntry.requiredReadKeys
        : carryForward
        ? carryReadKeysByStateKey.get(group.stateKey) ?? []
        : groupReads.map((item) => item.localId);
      const incrementalPlan = incrementalPlans.get(group.familyId);
      const localResults: StateReadResult[] = [];
      let resultFailure: StateReadResult | null = null;
      const cachedReadByLocalId = cacheEntry
        ? new Map(
            cacheEntry.reads.map((read) => [read.localId, read] as const),
          )
        : null;
      if (cacheEntry) {
        for (const localId of requiredLocalIds) {
          const cached = cachedReadByLocalId!.get(localId);
          if (!cached) {
            resultFailure = {
              id: localId,
              ok: false,
              sourceBlock: cacheEntry.source.number,
              sourceBlockHash: cacheEntry.source.hash,
              kind: "rpc",
              error: "missing cached read",
            };
            break;
          }
          localResults.push(Object.freeze({
            id: localId,
            ok: true,
            sourceBlock: cacheEntry.source.number,
            sourceBlockHash: cacheEntry.source.hash,
            provenance: cached.provenance,
            data: cached.data,
          }));
        }
      } else for (const item of carryForward ? [] : groupReads) {
        const result = resultsByGlobalId.get(item.globalId);
        if (!result) {
          resultFailure = {
            id: item.localId,
            ok: false,
            sourceBlock: graph.sourceBlock,
            sourceBlockHash: graph.sourceBlockHash,
            kind: "rpc",
            error: "missing backend result",
          };
          break;
        }
        const local = Object.freeze({ ...result, id: item.localId });
        if (
          !stateReadResultMatchesSource(
            this.backend,
            result,
            graph,
          )
        ) {
          resultFailure = {
            id: item.localId,
            ok: false,
            sourceBlock: result.sourceBlock,
            sourceBlockHash: result.sourceBlockHash,
            kind: "rpc",
            error: "backend result is not pinned to the requested source block/hash",
          };
          break;
        }
        if (!result.ok) {
          resultFailure = local;
          break;
        }
        localResults.push(local);
      }
      if (resultFailure) {
        issues.push({
          kind: resultFailure.ok ? "backend" : mapReadFailureKind(resultFailure.kind),
          lane,
          familyId: group.familyId,
          stateKey: group.stateKey,
          message: resultFailure.ok ? "unknown backend failure" : resultFailure.error,
        });
        continue;
      }

      let snapshot;
      try {
        if (carryForward) {
          snapshot = incrementalPlan?.previousByStateKey.get(
            group.stateKey,
          )?.snapshot;
          if (snapshot === undefined) {
            throw new Error("incremental state is missing the previous snapshot");
          }
        } else {
          const compiled = compiledFamilies.get(group.familyId);
          if (!compiled) throw new Error("family static schema is unavailable");
          snapshot = compiled.decodeState(Object.freeze(localResults));
          if (isThenable(snapshot)) {
            throw new Error("decodeState must return synchronously");
          }
        }
      } catch (error) {
        issues.push({
          kind: "decode",
          lane,
          familyId: group.familyId,
          stateKey: group.stateKey,
          message: formatError(error),
        });
        continue;
      }
      try {
        const previousBase = this.recoveryBaseForGroup(group);
        const deriveFromSnapshot = (): {
          readonly unavailable: ReadonlyMap<string, string>;
          readonly derived: ReadonlyMap<string, RouteVenueMid>;
        } => {
          const unavailable = snapshot.behaviorProvenUnavailableEdges?.(
            group.edges,
          ) ?? new Map<string, string>();
          if (isThenable(unavailable)) {
            throw new Error(
              "behaviorProvenUnavailableEdges must return synchronously",
            );
          }
          const derived = snapshot.deriveMids(group.edges);
          if (isThenable(derived)) {
            throw new Error("deriveMids must return synchronously");
          }
          return { unavailable, derived };
        };
        let unavailable: ReadonlyMap<string, string>;
        let derived: ReadonlyMap<string, RouteVenueMid>;
        if (
          carryForward &&
          previousBase &&
          previousBase.midsByEdgeKey.size > 0
        ) {
          // Unchanged state key: reuse the last direct-derived mids verbatim.
          // A schema-identical carried key cannot change its quotes without a
          // mutation event (the mutation range is the authoritative proof).
          unavailable = previousBase.unavailableByEdgeKey;
          derived = previousBase.midsByEdgeKey;
        } else {
          const computed = deriveFromSnapshot();
          unavailable = computed.unavailable;
          derived = computed.derived;
        }
        const expectedEdges = new Set(group.edgeKeys);
        for (const [edgeKey, reason] of unavailable) {
          if (!expectedEdges.has(edgeKey)) {
            throw new Error(
              `behavior-proven unavailable classification returned unknown edge ${edgeKey}`,
            );
          }
          if (typeof reason !== "string" || reason.trim().length === 0) {
            throw new Error(
              `behavior-proven unavailable edge ${edgeKey} has no reason`,
            );
          }
        }
        const expectedPricedEdges = new Set(
          group.edgeKeys.filter((edgeKey) => !unavailable.has(edgeKey)),
        );
        const derivedEdges = new Set(derived.keys());
        if (
          expectedPricedEdges.size !== derivedEdges.size ||
          [...expectedPricedEdges].some((key) => !derivedEdges.has(key))
        ) {
          if (!carryForward) {
            throw new Error(
              "deriveMids did not return the exact behavior-available edge-key set",
            );
          }
          // Topology drifted on a carried key (rare): recompute from the
          // carried snapshot instead of failing the key.
          const computed = deriveFromSnapshot();
          unavailable = computed.unavailable;
          derived = computed.derived;
          const recomputedPricedEdges = new Set(
            group.edgeKeys.filter((edgeKey) => !unavailable.has(edgeKey)),
          );
          const recomputedEdges = new Set(derived.keys());
          if (
            recomputedPricedEdges.size !== recomputedEdges.size ||
            [...recomputedPricedEdges].some(
              (key) => !recomputedEdges.has(key),
            )
          ) {
            throw new Error(
              "deriveMids did not return the exact behavior-available edge-key set",
            );
          }
        }
        resolvedStateKeys.push(group.stateKey);
        const localFreshness = new Map<string, StateFreshnessProof>();
        for (const localId of requiredLocalIds) {
          const globalId = globalReadId(group.stateKey, localId);
          let proof: StateFreshnessProof;
          if (carryForward) {
            if (!incrementalPlan) {
              throw new Error("carry-forward state lacks an incremental plan");
            }
            const range = incrementalPlan.rangeByStateKey.get(
              group.stateKey,
            );
            if (!range) {
              throw new Error(
                "carry-forward state lacks a canonical mutation range",
              );
            }
            proof = Object.freeze({
              kind: "carry-forward" as const,
              source: Object.freeze({
                number: graph.sourceBlock,
                hash: graph.sourceBlockHash,
                generation: graph.generation,
              }),
              previousSource: range.fromExclusive,
              mutationRangeFingerprint: range.rangeFingerprint,
              completeThroughBlock: range.through.number,
              completeThroughHash: range.through.hash,
            });
          } else if (cacheEntry) {
            const cached = cachedReadByLocalId?.get(localId);
            if (!cached) {
              throw new Error(`resolved state key lacks cached read ${localId}`);
            }
            proof = Object.freeze({
              kind: "direct-read" as const,
              source: Object.freeze({ ...cacheEntry.source }),
              provenance: cached.provenance,
            });
          } else {
            const result = resultsByGlobalId.get(globalId);
            if (!result?.ok) {
              throw new Error(`resolved state key lacks successful read ${globalId}`);
            }
            proof = Object.freeze({
              kind: "direct-read" as const,
              source: Object.freeze({
                number: graph.sourceBlock,
                hash: graph.sourceBlockHash,
                generation: graph.generation,
              }),
              provenance: result.provenance,
            });
          }
          resolvedReadKeys.push(globalId);
          freshness.push([globalId, proof]);
          localFreshness.set(localId, proof);
        }
        for (const [edgeKey, reason] of unavailable) {
          unavailableEdges.push(Object.freeze({
            edgeKey,
            familyId: group.familyId,
            stateKey: group.stateKey,
            reason: reason.trim(),
          }));
        }
        for (const edgeKey of group.edgeKeys) {
          if (unavailable.has(edgeKey)) continue;
          const mid = derived.get(edgeKey);
          if (!mid) throw new Error(`deriveMids omitted ${edgeKey}`);
          resolvedEdgeKeys.push(edgeKey);
          mids.push([edgeKey, mid]);
        }
        const publishedState: PublishedStateKey = Object.freeze({
          familyId: group.familyId,
          stateKey: group.rawStateKey,
          source: cacheEntry
            ? Object.freeze({ ...cacheEntry.source })
            : Object.freeze({
                number: graph.sourceBlock,
                hash: graph.sourceBlockHash,
                generation: graph.generation,
              }),
          snapshot,
          requiredReadKeys: Object.freeze([...requiredLocalIds].sort()),
          freshnessByReadKey: new FrozenReadonlyMap(
            [...localFreshness.entries()].sort(([a], [b]) =>
              a.localeCompare(b)
            ),
          ),
          refreshMode: cacheEntry
            ? "unproven-direct"
            : carryForward
            ? "carry-forward"
            : classifiedDirectStateKeys.has(group.stateKey)
            ? "classified-direct"
            : "unproven-direct",
          backrunInvalidations: Object.freeze(
            cacheEntry ||
              carryForward ||
              !classifiedDirectStateKeys.has(group.stateKey)
              ? []
              : [
                  ...(
                    incrementalPlan?.classificationByStateKey.get(
                      group.stateKey,
                    )?.backrunInvalidationsByStateKey?.get(
                        group.rawStateKey,
                      ) ?? []
                  ),
                ].map((invalidation) => Object.freeze({ ...invalidation })),
          ),
        });
        states.push([group.stateKey, publishedState]);
        /*
         * Per-key recovery bases are committed as each key resolves, so an
         * aborted/superseded generation still leaves every resolved key
         * resumable by the next generation instead of re-reading the whole
         * family. Warm generations additionally append the raw reads so a
         * process restart can re-decode them without RPC.
         */
        this.lastGoodByStateKey.set(group.stateKey, Object.freeze({
          state: publishedState,
          schemaFingerprint: stateSchemaFingerprint(group.edges),
          requiredReadKeyHash: exactSetHash(publishedState.requiredReadKeys),
          midsByEdgeKey: Object.freeze(new Map(derived)),
          unavailableByEdgeKey: Object.freeze(new Map(unavailable)),
        }));
        if (
          this.cacheModeActive &&
          !carryForward &&
          cacheEntry === undefined
        ) {
          const cacheEntryToWrite = this.buildCacheEntry(
            group,
            publishedState,
            resultsByGlobalId,
            groupReads,
          );
          if (cacheEntryToWrite) {
            this.scheduleCacheAppend(cacheEntryToWrite);
          }
        }
      } catch (error) {
        issues.push({
          kind: "derive",
          lane,
          familyId: group.familyId,
          stateKey: group.stateKey,
          message: formatError(error),
        });
      }
    }

    const finishedAtMs = this.now();
    const resolvedStateKeySet = new Set(resolvedStateKeys);
    const recoveryRequiredStateKeys = [...recoveryCandidateStateKeys].filter(
      (stateKey) => !resolvedStateKeySet.has(stateKey),
    ).length;
    staging.recoveryRequiredStateKeys = recoveryRequiredStateKeys > 0
      ? recoveryRequiredStateKeys
      : undefined;
    const familyExecution = Object.freeze({
      familyId,
      lane,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      uniqueStateKeys: groups.length,
      reads: physicalReads,
      batches,
      carryStateKeys,
      directStateKeys,
      missingPreviousStateKeys,
      ...(recoveryRequiredStateKeys === 0
        ? {}
        : { recoveryRequiredStateKeys }),
      ...(fullFallbackReason === undefined
        ? {}
        : { fullFallbackReason }),
      ...(fullFallbackDetail === undefined
        ? {}
        : { fullFallbackDetail }),
      ...(incrementalTiming === undefined
        ? {}
        : {
            incrementalDescriptorMs: incrementalTiming.descriptorMs,
            incrementalRangeMs: incrementalTiming.rangeMs,
            incrementalClassifierMs: incrementalTiming.classifierMs,
          }),
    });
    return Object.freeze({
      lane,
      stagedStaticSchemas: Object.freeze(
        [...staging.staticSchemas.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([familyId, schema]) =>
            Object.freeze([familyId, schema] as const)
          ),
      ),
      resolvedStateKeys: Object.freeze(resolvedStateKeys.sort()),
      expectedReadKeys: Object.freeze([...staging.expectedReadKeys].sort()),
      resolvedReadKeys: Object.freeze(resolvedReadKeys.sort()),
      resolvedEdgeKeys: Object.freeze(resolvedEdgeKeys.sort()),
      unavailableEdges: Object.freeze(
        unavailableEdges.sort((a, b) => a.edgeKey.localeCompare(b.edgeKey)),
      ),
      mids: Object.freeze(mids.sort(([a], [b]) => a.localeCompare(b))),
      freshness: Object.freeze(freshness.sort(([a], [b]) => a.localeCompare(b))),
      states: Object.freeze(states.sort(([a], [b]) => a.localeCompare(b))),
      issues: freezeIssues(issues),
      telemetry: Object.freeze({
        lane,
        startedAtMs,
        finishedAtMs,
        wallMs: Math.max(0, finishedAtMs - startedAtMs),
        uniqueStateKeys: groups.length,
        reads: physicalReads,
        batches,
      }),
      familyTelemetry: Object.freeze([familyExecution]),
    });
  }

  private selectHotRecoveryStateKeys(
    familyId: string,
    candidates: ReadonlySet<string>,
  ): ReadonlySet<string> {
    const sorted = [...candidates].sort();
    if (sorted.length === 0) {
      this.hotRecoveryCursorByFamily.delete(familyId);
      return new Set();
    }
    if (sorted.length <= MAX_HOT_RECOVERY_STATE_KEYS_PER_FAMILY) {
      this.hotRecoveryCursorByFamily.delete(familyId);
      return new Set(sorted);
    }
    const priorCursor = this.hotRecoveryCursorByFamily.get(familyId);
    const start = priorCursor === undefined
      ? 0
      : Math.max(
          0,
          sorted.findIndex((stateKey) => stateKey.localeCompare(priorCursor) > 0),
        );
    const selected = new Set(
      Array.from(
        { length: MAX_HOT_RECOVERY_STATE_KEYS_PER_FAMILY },
        (_, index) => sorted[(start + index) % sorted.length],
      ),
    );
    const lastSelected = [...selected].at(-1);
    if (lastSelected !== undefined) {
      this.hotRecoveryCursorByFamily.set(familyId, lastSelected);
    }
    return selected;
  }
}

function deduplicatePlannedReads<
  T extends { readonly globalId: string; readonly read: StateRead },
>(
  reads: readonly T[],
): readonly {
  readonly representative: T;
  readonly items: readonly T[];
}[] {
  const groups = new Map<string, T[]>();
  for (const item of reads) {
    const key = [
      item.read.sourceBlock,
      item.read.sourceBlockHash.toLowerCase(),
      item.read.to.toLowerCase(),
      item.read.data.toLowerCase(),
      item.read.from?.toLowerCase() ?? "",
      item.read.transport,
      deterministicHash(item.read.simulation ?? null),
      item.read.acceptRevertData ? "accept-revert-data" : "strict-success",
    ].join("\u001f");
    const current = groups.get(key);
    if (current) current.push(item);
    else groups.set(key, [item]);
  }
  return Object.freeze(
    [...groups.values()]
      .map((items) => Object.freeze({
        representative: items[0],
        items: Object.freeze(items),
      }))
      .sort((a, b) =>
        a.representative.globalId.localeCompare(b.representative.globalId)
      ),
  );
}

function validateCanonicalMutationRange(
  range: CanonicalMutationRange,
  descriptor: MutationQueryDescriptor,
  fromExclusive: BlockSource,
  through: BlockSource,
): void {
  if (
    range.complete !== true ||
    !sameBlockSource(range.fromExclusive, fromExclusive) ||
    !sameBlockSource(range.through, through) ||
    range.queryDescriptorFingerprint !== descriptor.fingerprint ||
    !range.canonicalPathFingerprint
  ) {
    throw new Error("canonical mutation range proof does not match refresh source");
  }
  for (const event of range.events) {
    if (
      event.removed === true ||
      event.blockNumber <= fromExclusive.number ||
      event.blockNumber > through.number ||
      !event.blockHash ||
      !Number.isSafeInteger(event.transactionIndex) ||
      !Number.isSafeInteger(event.logIndex)
    ) {
      throw new Error("canonical mutation range contains an invalid event");
    }
  }
  const expectedRangeFingerprint = deterministicHash({
    fromExclusive: range.fromExclusive,
    through: range.through,
    queryDescriptorFingerprint: range.queryDescriptorFingerprint,
    canonicalPathFingerprint: range.canonicalPathFingerprint,
    events: range.events,
  });
  if (range.rangeFingerprint !== expectedRangeFingerprint) {
    throw new Error("canonical mutation range fingerprint mismatch");
  }
}

function validateMutationClassification(
  classification: FamilyMutationClassification,
  range: CanonicalMutationRange,
  groups: readonly StateGroup[],
): void {
  if (
    classification.mutationRangeFingerprint !== range.rangeFingerprint ||
    !classification.classifierFingerprint
  ) {
    throw new Error("family mutation classification is not bound to the proven range");
  }
  const knownStateKeys = new Set(groups.map((group) => group.rawStateKey));
  for (const [stateKey, readKeys] of classification.changedReadKeysByStateKey) {
    if (!knownStateKeys.has(stateKey) || !(readKeys instanceof Set)) {
      throw new Error(`family mutation classification contains unknown state ${stateKey}`);
    }
    for (const readKey of readKeys) {
      if (!readKey) {
        throw new Error(`family mutation classification has an empty read key for ${stateKey}`);
      }
    }
  }
  for (
    const [stateKey, invalidations] of
    classification.backrunInvalidationsByStateKey ?? []
  ) {
    if (
      !knownStateKeys.has(stateKey) ||
      !classification.changedReadKeysByStateKey.has(stateKey) ||
      !Array.isArray(invalidations)
    ) {
      throw new Error(
        `family mutation classification contains invalid backrun state ${stateKey}`,
      );
    }
    for (const invalidation of invalidations) {
      if (
        invalidation.kind !== "v3-ticks" ||
        typeof invalidation.pool !== "string" ||
        invalidation.pool.length === 0
      ) {
        throw new Error(
          `family mutation classification has an invalid backrun invalidation for ${stateKey}`,
        );
      }
    }
  }
}

/**
 * Derive an event-driven incremental capability for adapter families that
 * declared mutation topics in their landed-event registration but did not
 * hand-write one. The classifier re-reads exactly the pools that emitted a
 * declared topic in the range and carries everything else from its last good
 * state, using the previous required read keys so the changed set always
 * matches the carry/direct partition contract.
 */
function createDerivedSwapMutationIncremental(input: {
  readonly familyId: string;
  readonly mutationEvents: readonly {
    readonly topic: string | null;
    readonly emitter: LandedEventEmitter;
  }[];
  readonly family: RegisteredBlockScanStateFamily;
  readonly familyGroups: readonly StateGroup[];
  readonly eligibleByStateKey: ReadonlyMap<string, RecoveryStateBase>;
  readonly topologyIndex: StateTopologyIndex;
}): CompiledIncrementalStateFamily | null {
  /*
   * Anonymous-data emitters (topic === null, e.g. Ekubo's Core) are not
   * auto-derived by design: their identity lives at a fixed data offset and
   * the family stays on current-N direct reads. Only declarations whose
   * emitter mode can be resolved generically (address, singleton-indexed
   * address, singleton-indexed bytes32) enter the automatic update pipe.
   */
  const resolvable = input.mutationEvents.filter(
    (event) => event.topic !== null,
  );
  if (resolvable.length === 0) return null;
  const topics = resolvable.map((event) => event.topic as string);
  /*
   * eligibleByStateKey is keyed by the coordinator composite stateKey
   * (familyId\u001frawKey); map composite -> raw so each base can be looked
   * up by the raw key the classifier emits. A reversed map silently emptied
   * baseByRawKey and made the derived classifier carry every pool.
   */
  const rawKeyByComposite = new Map(
    input.familyGroups.map((group) => [
      group.stateKey,
      group.rawStateKey.toLowerCase(),
    ] as const),
  );
  const baseByRawKey = new Map<string, RecoveryStateBase>();
  for (const [composite, base] of input.eligibleByStateKey) {
    const raw = rawKeyByComposite.get(composite);
    if (raw !== undefined) baseByRawKey.set(raw, base);
  }
  const eventByTopic = new Map<string, typeof resolvable[number]>();
  for (const event of resolvable) {
    eventByTopic.set(event.topic as string, event);
  }
  const classifierFingerprint = deterministicHash({
    familyId: input.familyId,
    topics,
    emitters: resolvable.map((event) => event.emitter),
  });
  return Object.freeze({
    mutationQueryDescriptor: () =>
      createMutationQueryDescriptor({ topics }),
    classifyMutations(classifyInput: {
      readonly edges: readonly TokenEdge[];
      readonly range: CanonicalMutationRange;
    }): FamilyMutationClassification {
      /*
       * Resolve range events against the graph-topology-scoped pool-identity
       * reverse index (rebuilt only when the topology hash changes, never
       * per generation). The index supports directional/composite state keys
       * without per-protocol branches.
       */
      const changed = new Map<string, ReadonlySet<string>>();
      for (const event of classifyInput.range.events) {
        const topic = event.topics[0]?.toLowerCase();
        if (topic === undefined) continue;
        const declaration = eventByTopic.get(topic);
        if (!declaration) continue;
        const identity = observedLandedPoolIdentity(
          declaration,
          event,
        );
        if (identity === null) continue;
        const identityKey =
          `${input.familyId}\u001f${identity.toLowerCase()}`;
        const compositeKeys =
          input.topologyIndex.stateKeysByPoolIdentity.get(identityKey);
        if (!compositeKeys) continue;
        for (const composite of compositeKeys) {
          const rawKey = rawKeyByComposite.get(composite);
          if (rawKey === undefined) continue;
          const base = baseByRawKey.get(rawKey);
          if (!base) continue;
          changed.set(
            rawKey,
            new Set([...base.state.requiredReadKeys]),
          );
        }
      }
      return Object.freeze({
        mutationRangeFingerprint: classifyInput.range.rangeFingerprint,
        classifierFingerprint,
        changedReadKeysByStateKey: changed,
      });
    },
  });
}

function sameBlockSource(a: BlockSource, b: BlockSource): boolean {
  return (
    a.number === b.number &&
    a.hash.toLowerCase() === b.hash.toLowerCase() &&
    a.generation === b.generation
  );
}

function buildOwnershipPlan(
  graph: VerifiedGraphView,
  familiesInput: readonly RegisteredBlockScanStateFamily[],
  requiresPricing: (edge: TokenEdge) => boolean,
): OwnershipPlan {
  const families = [...familiesInput].sort((a, b) => a.familyId.localeCompare(b.familyId));
  const familyIds = new Set<string>();
  const ownerIssues: BlockScanStateIssue[] = [];
  for (const family of families) {
    if (familyIds.has(family.familyId)) {
      ownerIssues.push({
        kind: "duplicate-family",
        familyId: family.familyId,
        message: `duplicate pricing family ${family.familyId}`,
      });
    }
    familyIds.add(family.familyId);
  }

  const grouped = new Map<string, {
    family: RegisteredBlockScanStateFamily;
    rawStateKey: string;
    edges: TokenEdge[];
    edgeKeys: string[];
  }>();
  const expectedEdgeKeys: string[] = [];
  const seenEdgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!requiresPricing(edge)) continue;
    const edgeKey = blockScanEdgeKey(edge);
    expectedEdgeKeys.push(edgeKey);
    if (seenEdgeKeys.has(edgeKey)) {
      ownerIssues.push({
        kind: "descriptor",
        edgeKey,
        message: `duplicate edge identity ${edgeKey}`,
      });
      continue;
    }
    seenEdgeKeys.add(edgeKey);
    const owners = families.filter((family) => family.ownsEdge(edge));
    if (owners.length !== 1) {
      ownerIssues.push({
        kind: owners.length === 0 ? "edge-owner-missing" : "edge-owner-ambiguous",
        edgeKey,
        message: owners.length === 0
          ? `no state family owns ${edgeKey}`
          : `multiple state families own ${edgeKey}: ${owners.map((owner) => owner.familyId).join(",")}`,
      });
      continue;
    }
    const family = owners[0];
    let rawStateKey: string;
    try {
      rawStateKey = family.stateKey(edge);
      if (typeof rawStateKey !== "string") {
        throw new Error("stateKey must return synchronously");
      }
    } catch (error) {
      ownerIssues.push({
        kind: "descriptor",
        familyId: family.familyId,
        edgeKey,
        message: `stateKey failed: ${formatError(error)}`,
      });
      continue;
    }
    let identity: string;
    try {
      identity = blockScanStateKey(family.familyId, rawStateKey);
    } catch (error) {
      ownerIssues.push({
        kind: "descriptor",
        familyId: family.familyId,
        edgeKey,
        message: formatError(error),
      });
      continue;
    }
    const current = grouped.get(identity);
    if (current) {
      current.edges.push(edge);
      current.edgeKeys.push(edgeKey);
    } else {
      grouped.set(identity, {
        family,
        rawStateKey,
        edges: [edge],
        edgeKeys: [edgeKey],
      });
    }
  }
  const groups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stateKey, group]): StateGroup => Object.freeze({
      family: group.family,
      familyId: group.family.familyId,
      lane: group.family.lane,
      rawStateKey: group.rawStateKey,
      stateKey,
      edges: Object.freeze(group.edges),
      edgeKeys: Object.freeze(group.edgeKeys),
    }));
  return Object.freeze({
    groups: Object.freeze(groups),
    expectedStateKeys: Object.freeze(groups.map((group) => group.stateKey).sort()),
    expectedEdgeKeys: Object.freeze([...new Set(expectedEdgeKeys)].sort()),
    ownerIssues: freezeIssues(ownerIssues),
  });
}

function createCoverage(
  expectedStateKeysInput: readonly string[],
  resolvedStateKeysInput: readonly string[],
  expectedReadKeysInput: readonly string[],
  resolvedReadKeysInput: readonly string[],
  expectedEdgeKeysInput: readonly string[],
  resolvedEdgeKeysInput: readonly string[],
  unavailableEdgeKeysInput: readonly string[],
): BlockScanStateCoverage {
  const expectedStateKeys = uniqueSorted(expectedStateKeysInput);
  const expectedReadKeys = uniqueSorted(expectedReadKeysInput);
  const expectedEdgeKeys = uniqueSorted(expectedEdgeKeysInput);
  const expectedStateSet = new Set(expectedStateKeys);
  const expectedReadSet = new Set(expectedReadKeys);
  const expectedEdgeSet = new Set(expectedEdgeKeys);
  const resolvedStateKeys = uniqueSorted(
    resolvedStateKeysInput.filter((key) => expectedStateSet.has(key)),
  );
  const resolvedEdgeKeys = uniqueSorted(
    resolvedEdgeKeysInput.filter((key) => expectedEdgeSet.has(key)),
  );
  const resolvedStateSet = new Set(resolvedStateKeys);
  const resolvedReadKeys = uniqueSorted(
    resolvedReadKeysInput.filter((key) => expectedReadSet.has(key)),
  );
  const resolvedReadSet = new Set(resolvedReadKeys);
  const resolvedEdgeSet = new Set(resolvedEdgeKeys);
  const unavailableEdgeKeys = uniqueSorted(
    unavailableEdgeKeysInput.filter(
      (key) => expectedEdgeSet.has(key) && !resolvedEdgeSet.has(key),
    ),
  );
  const unavailableEdgeSet = new Set(unavailableEdgeKeys);
  const unresolvedStateKeys = Object.freeze(
    expectedStateKeys.filter((key) => !resolvedStateSet.has(key)),
  );
  const unresolvedEdgeKeys = Object.freeze(
    expectedEdgeKeys.filter(
      (key) => !resolvedEdgeSet.has(key) && !unavailableEdgeSet.has(key),
    ),
  );
  const unresolvedReadKeys = Object.freeze(
    expectedReadKeys.filter((key) => !resolvedReadSet.has(key)),
  );
  return Object.freeze({
    expectedStateKeys,
    resolvedStateKeys,
    unresolvedStateKeys,
    expectedReadKeys,
    resolvedReadKeys,
    unresolvedReadKeys,
    expectedEdgeKeys,
    resolvedEdgeKeys,
    unavailableEdgeKeys,
    unresolvedEdgeKeys,
    expectedStateKeyHash: exactSetHash(expectedStateKeys),
    resolvedStateKeyHash: exactSetHash(resolvedStateKeys),
    unresolvedStateKeyHash: exactSetHash(unresolvedStateKeys),
    expectedReadKeyHash: exactSetHash(expectedReadKeys),
    resolvedReadKeyHash: exactSetHash(resolvedReadKeys),
    unresolvedReadKeyHash: exactSetHash(unresolvedReadKeys),
    expectedEdgeKeyHash: exactSetHash(expectedEdgeKeys),
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unavailableEdgeKeyHash: exactSetHash(unavailableEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash(unresolvedEdgeKeys),
  });
}

/**
 * Family completeness is classification metadata, not a publication boundary.
 * Successful stateKeys publish independently; a failed sibling remains
 * unresolved without erasing healthy current-generation state. A family is
 * terminal only when every owned state, required read, and edge reached either
 * a priced or behavior-proven unavailable terminal state in this generation.
 */
function completePricingFamilyIds(
  groups: readonly StateGroup[],
  graphIncompleteFamilyIds: ReadonlySet<string>,
  raw: {
    readonly expectedReadKeys: readonly string[];
    readonly resolvedStateKeys: readonly string[];
    readonly resolvedReadKeys: readonly string[];
    readonly resolvedEdgeKeys: readonly string[];
    readonly unavailableEdgeKeys: readonly string[];
  },
): ReadonlySet<string> {
  const resolvedStateKeys = new Set(raw.resolvedStateKeys);
  const resolvedReadKeys = new Set(raw.resolvedReadKeys);
  const resolvedEdgeKeys = new Set(raw.resolvedEdgeKeys);
  const unavailableEdgeKeys = new Set(raw.unavailableEdgeKeys);
  const groupsByFamily = new Map<string, StateGroup[]>();
  for (const group of groups) {
    const familyGroups = groupsByFamily.get(group.familyId);
    if (familyGroups) familyGroups.push(group);
    else groupsByFamily.set(group.familyId, [group]);
  }

  const complete = new Set<string>();
  for (const [familyId, familyGroups] of groupsByFamily) {
    if (graphIncompleteFamilyIds.has(familyId)) continue;
    const familyReadKeys = raw.expectedReadKeys.filter((readKey) =>
      readKey.startsWith(`${familyId}\u001f`)
    );
    if (
      familyGroups.every((group) =>
        resolvedStateKeys.has(group.stateKey) &&
        group.edgeKeys.every((edgeKey) =>
          resolvedEdgeKeys.has(edgeKey) || unavailableEdgeKeys.has(edgeKey)
        )
      ) &&
      familyReadKeys.every((readKey) => resolvedReadKeys.has(readKey))
    ) {
      complete.add(familyId);
    }
  }
  return complete;
}

function createFamilyTelemetry(input: {
  readonly groups: readonly StateGroup[];
  readonly registeredFamilies: readonly RegisteredBlockScanStateFamily[];
  readonly execution: readonly FamilyExecutionTelemetry[];
  readonly coverage: BlockScanStateCoverage;
  readonly terminalFamilyIds: ReadonlySet<string>;
  readonly graphIncompleteFamilyIds: ReadonlySet<string>;
  readonly issues: readonly BlockScanStateIssue[];
}): readonly BlockScanFamilyTelemetry[] {
  const executionByFamilyId = new Map(
    input.execution.map((entry) => [entry.familyId, entry] as const),
  );
  const registeredByFamilyId = new Map(
    input.registeredFamilies.map((family) => [family.familyId, family] as const),
  );
  const groupsByFamilyId = new Map<string, StateGroup[]>();
  for (const group of input.groups) {
    const current = groupsByFamilyId.get(group.familyId);
    if (current) current.push(group);
    else groupsByFamilyId.set(group.familyId, [group]);
  }
  const resolvedStateKeys = new Set(input.coverage.resolvedStateKeys);
  const resolvedReadKeys = new Set(input.coverage.resolvedReadKeys);
  const resolvedEdgeKeys = new Set(input.coverage.resolvedEdgeKeys);
  const unavailableEdgeKeys = new Set(input.coverage.unavailableEdgeKeys);
  const familyIds = uniqueSorted([
    ...groupsByFamilyId.keys(),
    ...input.execution.map((entry) => entry.familyId),
    ...[...input.graphIncompleteFamilyIds].filter((familyId) =>
      registeredByFamilyId.has(familyId)
    ),
  ]);

  return freezeFamilyTelemetry(familyIds.flatMap((familyId) => {
    const execution = executionByFamilyId.get(familyId);
    const groups = groupsByFamilyId.get(familyId) ?? [];
    const lane = execution?.lane ??
      groups[0]?.lane ??
      registeredByFamilyId.get(familyId)?.lane;
    if (!lane) return [];
    const madeProgress =
      groups.some((group) => resolvedStateKeys.has(group.stateKey)) ||
      [...resolvedReadKeys].some((readKey) =>
        readKey.startsWith(`${familyId}\u001f`)
      ) ||
      groups.some((group) =>
        group.edgeKeys.some((edgeKey) =>
          resolvedEdgeKeys.has(edgeKey) || unavailableEdgeKeys.has(edgeKey)
        )
      );
    const issueCount = input.issues.filter(
      (issue) => issue.familyId === familyId,
    ).length;
    const status: BlockScanFamilyTelemetryStatus =
      input.terminalFamilyIds.has(familyId) && issueCount === 0
        ? "complete"
        : madeProgress
        ? "degraded"
        : "incomplete";
    return [Object.freeze({
      familyId,
      lane,
      wallMs: execution?.wallMs ?? 0,
      uniqueStateKeys: groups.length,
      reads: execution?.reads ?? 0,
      batches: execution?.batches ?? 0,
      status,
      issueCount,
      ...(execution?.carryStateKeys === undefined
        ? {}
        : { carryStateKeys: execution.carryStateKeys }),
      ...(execution?.directStateKeys === undefined
        ? {}
        : { directStateKeys: execution.directStateKeys }),
      ...(execution?.missingPreviousStateKeys === undefined
        ? {}
        : {
            missingPreviousStateKeys:
              execution.missingPreviousStateKeys,
          }),
      ...(execution?.recoveryRequiredStateKeys === undefined
        ? {}
        : {
            recoveryRequiredStateKeys:
              execution.recoveryRequiredStateKeys,
          }),
      ...(execution?.fullFallbackReason === undefined
        ? {}
        : { fullFallbackReason: execution.fullFallbackReason }),
      ...(execution?.fullFallbackDetail === undefined
        ? {}
        : { fullFallbackDetail: execution.fullFallbackDetail }),
      ...(execution?.incrementalDescriptorMs === undefined
        ? {}
        : { incrementalDescriptorMs: execution.incrementalDescriptorMs }),
      ...(execution?.incrementalRangeMs === undefined
        ? {}
        : { incrementalRangeMs: execution.incrementalRangeMs }),
      ...(execution?.incrementalClassifierMs === undefined
        ? {}
        : { incrementalClassifierMs: execution.incrementalClassifierMs }),
    })];
  }));
}

function incompleteResult(input: {
  readonly graph: VerifiedGraphView;
  readonly ownership: OwnershipPlan;
  readonly issues: readonly BlockScanStateIssue[];
  readonly laneTelemetry?: readonly BlockScanLaneTelemetry[];
  readonly familyTelemetry?: readonly BlockScanFamilyTelemetry[];
}): IncompleteBlockScanStateResult {
  return Object.freeze({
    status: "incomplete",
    generation: input.graph.generation,
    sourceBlock: input.graph.sourceBlock,
    sourceBlockHash: input.graph.sourceBlockHash,
    coverage: createCoverage(
      input.ownership.expectedStateKeys,
      [],
      [],
      [],
      input.ownership.expectedEdgeKeys,
      [],
      [],
    ),
    issues: freezeIssues(input.issues),
    laneTelemetry: freezeLaneTelemetry(input.laneTelemetry ?? []),
    familyTelemetry: freezeFamilyTelemetry(input.familyTelemetry ?? []),
  });
}

function emptyLane(
  lane: BlockScanPricingLane,
  startedAtMs: number,
  finishedAtMs: number,
): LaneResult {
  return Object.freeze({
    lane,
    stagedStaticSchemas: Object.freeze([]),
    resolvedStateKeys: Object.freeze([]),
    expectedReadKeys: Object.freeze([]),
    resolvedReadKeys: Object.freeze([]),
    resolvedEdgeKeys: Object.freeze([]),
    unavailableEdges: Object.freeze([]),
    mids: Object.freeze([]),
    freshness: Object.freeze([]),
    states: Object.freeze([]),
    issues: Object.freeze([]),
    telemetry: Object.freeze({
      lane,
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      uniqueStateKeys: 0,
      reads: 0,
      batches: 0,
    }),
    familyTelemetry: Object.freeze([]),
  });
}

function failedFamilyLane(
  lane: BlockScanPricingLane,
  familyId: string,
  uniqueStateKeys: number,
  startedAtMs: number,
  finishedAtMs: number,
  staging: FamilyLaneStaging,
  error: unknown,
): LaneResult {
  return Object.freeze({
    lane,
    stagedStaticSchemas: Object.freeze([]),
    resolvedStateKeys: Object.freeze([]),
    expectedReadKeys: uniqueSorted([...staging.expectedReadKeys]),
    resolvedReadKeys: Object.freeze([]),
    resolvedEdgeKeys: Object.freeze([]),
    unavailableEdges: Object.freeze([]),
    mids: Object.freeze([]),
    freshness: Object.freeze([]),
    states: Object.freeze([]),
    issues: freezeIssues([{
      kind: issueKindFromError(error, "backend"),
      lane,
      familyId,
      message: formatError(error),
    }]),
    telemetry: Object.freeze({
      lane,
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      uniqueStateKeys,
      reads: staging.reads,
      batches: staging.batches,
    }),
    familyTelemetry: Object.freeze([Object.freeze({
      familyId,
      lane,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      uniqueStateKeys,
      reads: staging.reads,
      batches: staging.batches,
      ...(staging.carryStateKeys === undefined
        ? {}
        : { carryStateKeys: staging.carryStateKeys }),
      ...(staging.directStateKeys === undefined
        ? {}
        : { directStateKeys: staging.directStateKeys }),
      ...(staging.missingPreviousStateKeys === undefined
        ? {}
        : { missingPreviousStateKeys: staging.missingPreviousStateKeys }),
      ...(staging.recoveryRequiredStateKeys === undefined
        ? {}
        : {
            recoveryRequiredStateKeys:
              staging.recoveryRequiredStateKeys,
          }),
      ...(staging.fullFallbackReason === undefined
        ? {}
        : { fullFallbackReason: staging.fullFallbackReason }),
      ...(staging.fullFallbackDetail === undefined
        ? {}
        : { fullFallbackDetail: staging.fullFallbackDetail }),
      ...(staging.incrementalDescriptorMs === undefined
        ? {}
        : { incrementalDescriptorMs: staging.incrementalDescriptorMs }),
      ...(staging.incrementalRangeMs === undefined
        ? {}
        : { incrementalRangeMs: staging.incrementalRangeMs }),
      ...(staging.incrementalClassifierMs === undefined
        ? {}
        : { incrementalClassifierMs: staging.incrementalClassifierMs }),
    })]),
  });
}

function mergeFamilyLaneResults(
  lane: BlockScanPricingLane,
  uniqueStateKeys: number,
  startedAtMs: number,
  finishedAtMs: number,
  results: readonly LaneResult[],
): LaneResult {
  return Object.freeze({
    lane,
    stagedStaticSchemas: Object.freeze(
      results
        .flatMap((result) => result.stagedStaticSchemas)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([familyId, schema]) =>
          Object.freeze([familyId, schema] as const)
        ),
    ),
    resolvedStateKeys: uniqueSorted(
      results.flatMap((result) => result.resolvedStateKeys),
    ),
    expectedReadKeys: uniqueSorted(
      results.flatMap((result) => result.expectedReadKeys),
    ),
    resolvedReadKeys: uniqueSorted(
      results.flatMap((result) => result.resolvedReadKeys),
    ),
    resolvedEdgeKeys: uniqueSorted(
      results.flatMap((result) => result.resolvedEdgeKeys),
    ),
    unavailableEdges: Object.freeze(
      results
        .flatMap((result) => result.unavailableEdges)
        .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey)),
    ),
    mids: Object.freeze(
      results
        .flatMap((result) => result.mids)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    freshness: Object.freeze(
      results
        .flatMap((result) => result.freshness)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    states: Object.freeze(
      results
        .flatMap((result) => result.states)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    issues: freezeIssues(results.flatMap((result) => result.issues)),
    telemetry: Object.freeze({
      lane,
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - startedAtMs),
      uniqueStateKeys,
      reads: results.reduce(
        (total, result) => total + result.telemetry.reads,
        0,
      ),
      batches: results.reduce(
        (total, result) => total + result.telemetry.batches,
        0,
      ),
    }),
    familyTelemetry: Object.freeze(
      results
        .flatMap((result) => result.familyTelemetry)
        .sort((a, b) => a.familyId.localeCompare(b.familyId)),
    ),
  });
}

function uniqueFamilies(
  groups: readonly StateGroup[],
): readonly RegisteredBlockScanStateFamily[] {
  const byId = new Map<string, RegisteredBlockScanStateFamily>();
  for (const group of groups) byId.set(group.familyId, group.family);
  return Object.freeze([...byId.values()].sort((a, b) => a.familyId.localeCompare(b.familyId)));
}

function validateRead(read: StateRead, graph: VerifiedGraphView): void {
  if (read.sourceBlock !== graph.sourceBlock) {
    throw new Error(
      `read ${read.id} requested block ${read.sourceBlock}, expected ${graph.sourceBlock}`,
    );
  }
  if (read.sourceBlockHash.toLowerCase() !== graph.sourceBlockHash) {
    throw new Error(`read ${read.id} requested a different source block hash`);
  }
  if (!read.to || !read.data || !read.transport) {
    throw new Error(`read ${read.id} is missing a required descriptor field`);
  }
}

function stateReadResultMatchesSource(
  backend: BlockScanStateReadBackend,
  result: StateReadResult,
  graph: VerifiedGraphView,
): boolean {
  const source: BlockSource = Object.freeze({
    number: graph.sourceBlock,
    hash: graph.sourceBlockHash,
    generation: graph.generation,
  });
  if (
    result.sourceBlock !== source.number ||
    result.sourceBlockHash.toLowerCase() !== source.hash.toLowerCase()
  ) return false;
  if (!result.ok) return true;
  const provenance = result.provenance;
  if (
    provenance.source.number !== source.number ||
    provenance.source.hash.toLowerCase() !==
      source.hash.toLowerCase() ||
    provenance.source.generation !== source.generation
  ) return false;
  if (provenance.kind === "eip1898") {
    return provenance.requireCanonical === true;
  }
  return (
    typeof provenance.forkId === "string" &&
    provenance.forkId.length > 0 &&
    backend.verifyImmutableForkProvenance?.(
      provenance,
      source,
    ) === true
  );
}

function globalReadId(stateKey: string, localId: string): string {
  return `${stateKey}\u001f${localId}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezeMid(mid: RouteVenueMid): RouteVenueMid {
  return Object.freeze({
    ...mid,
    edges: Object.freeze([...mid.edges]) as unknown as TokenEdge[],
  });
}

function freezeIssues(
  issues: readonly BlockScanStateIssue[],
): readonly BlockScanStateIssue[] {
  return Object.freeze(
    [...issues]
      .sort((a, b) =>
        [
          a.kind,
          a.lane ?? "",
          a.familyId ?? "",
          a.stateKey ?? "",
          a.edgeKey ?? "",
          a.message,
        ].join("\u001f").localeCompare([
          b.kind,
          b.lane ?? "",
          b.familyId ?? "",
          b.stateKey ?? "",
          b.edgeKey ?? "",
          b.message,
        ].join("\u001f"))
      )
      .map((issue) => Object.freeze({ ...issue })),
  );
}

function freezeLaneTelemetry(
  lanes: readonly BlockScanLaneTelemetry[],
): readonly BlockScanLaneTelemetry[] {
  return Object.freeze(
    [...lanes]
      .sort((a, b) => a.lane.localeCompare(b.lane))
      .map((lane) => Object.freeze({ ...lane })),
  );
}

function freezeFamilyTelemetry(
  families: readonly BlockScanFamilyTelemetry[],
): readonly BlockScanFamilyTelemetry[] {
  return Object.freeze(
    [...families]
      .sort((a, b) => a.familyId.localeCompare(b.familyId))
      .map((family) => Object.freeze({ ...family })),
  );
}

function issueFromAbort(
  reason: unknown,
  generation: number,
  lane?: BlockScanPricingLane,
): BlockScanStateIssue {
  if (reason instanceof SupersededAbort) {
    return {
      kind: "stale-generation",
      lane,
      message: reason.message,
    };
  }
  if (reason instanceof DeadlineAbort) {
    return {
      kind: "deadline",
      lane,
      message: reason.message,
    };
  }
  return {
    kind: "aborted",
    lane,
    message: reason instanceof Error
      ? reason.message
      : `generation ${generation} aborted`,
  };
}

function issueKindFromError(
  error: unknown,
  fallback: BlockScanStateIssueKind = "schema",
): BlockScanStateIssueKind {
  if (
    error instanceof DeadlineAbort ||
    error instanceof FamilyDeadlineAbort
  ) return "deadline";
  if (error instanceof SupersededAbort) return "stale-generation";
  if (isAbortError(error)) return "aborted";
  return fallback;
}

function mapReadFailureKind(kind: StateReadFailureKind): BlockScanStateIssueKind {
  if (kind === "deadline") return "deadline";
  if (kind === "aborted") return "aborted";
  if (kind === "resource-limited") return "resource-limited";
  return "backend";
}

function sanitizedIncrementalFailureDetail(
  fallbackPhase:
    | "mutation-descriptor-failed"
    | "mutation-range-failed"
    | "mutation-classifier-failed",
  error: unknown,
  signal: AbortSignal,
): string {
  const transported = error && typeof error === "object"
    ? error as { readonly phase?: unknown; readonly kind?: unknown }
    : null;
  const phase = typeof transported?.phase === "string"
    ? transported.phase
    : fallbackPhase === "mutation-descriptor-failed"
    ? "descriptor"
    : fallbackPhase === "mutation-classifier-failed"
    ? "classifier"
    : "range";
  const transportedKind = transported?.kind;
  if (
    transportedKind === "deadline" ||
    transportedKind === "aborted" ||
    transportedKind === "rpc" ||
    transportedKind === "validation" ||
    transportedKind === "unknown"
  ) {
    return `${phase}:${transportedKind}`;
  }
  const message = formatError(signal.aborted ? signal.reason : error)
    .toLowerCase();
  const kind = message.includes("deadline") || message.includes("timed out")
    ? "deadline"
    : signal.aborted ||
        isAbortError(error) ||
        message.includes("cancelled") ||
        message.includes("superseded")
    ? "aborted"
    : fallbackPhase === "mutation-descriptor-failed" ||
        fallbackPhase === "mutation-classifier-failed"
    ? "validation"
    : "unknown";
  return `${phase}:${kind}`;
}

function semanticStateHash(
  state: PublishedStateKey,
  edges: readonly TokenEdge[],
): string {
  const mids = [...state.snapshot.deriveMids(edges)]
    .sort(([left], [right]) => left.localeCompare(right));
  const unavailable = state.snapshot.behaviorProvenUnavailableEdges
    ? [...state.snapshot.behaviorProvenUnavailableEdges(edges)]
      .sort(([left], [right]) => left.localeCompare(right))
    : [];
  return deterministicHash({ mids, unavailable });
}

function isCanonicalAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function protocolAddressTouchUnavailableReason(error: unknown): string {
  const message = formatError(error).toLowerCase();
  if (message.includes("deadline") || message.includes("timed out")) {
    return "deadline";
  }
  if (isAbortError(error) || message.includes("superseded")) {
    return "aborted";
  }
  if (message.includes("canonical") || message.includes("parent")) {
    return "canonical-proof-failed";
  }
  if (message.includes("activity") || message.includes("transaction")) {
    return "activity-incomplete";
  }
  return "rpc-or-validation-failed";
}

function safelyEmitProtocolAddressTouchShadow(
  callback: (telemetry: ProtocolAddressTouchShadowTelemetry) => void,
  telemetry: ProtocolAddressTouchShadowTelemetry,
): void {
  try {
    callback(telemetry);
  } catch {
    // Observability must never affect pricing publication.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("abort")
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw signal.reason ?? new Error("aborted");
  }
  let remove = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
    promise.catch(() => undefined);
  }
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

class FrozenReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
}
