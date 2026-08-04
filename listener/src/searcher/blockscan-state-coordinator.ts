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
  type ChainLog,
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
import type { CanonicalBlockActivity } from "./blockscan-state-read-backend.js";
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

  /**
   * Unified canonical block activity (receipts + logs + touched addresses)
   * for one forward range. Feeds the single global dirty/carry partition for
   * both lanes; carries share this proof instead of per-family topic ranges.
   */
  readCanonicalBlockActivity?(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      /**
       * Max forward distance for one activity read. The unified refresh plan
       * passes the incremental-range window so a producer lagging more than
       * 8 blocks can still carry through a proven multi-block gap instead of
       * degrading to a full-graph direct read.
       */
      readonly maxRangeBlocks?: number;
    },
  ): Promise<CanonicalBlockActivity>;
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
  readonly edgeKeySet: ReadonlySet<string>;
  /**
   * Topology-scoped schema fingerprint, computed once in buildOwnershipPlan
   * instead of re-hashing every group's edges on every generation (16k+
   * sha256 calls per block were a top CPU/GC hotspot).
   */
  readonly schemaFingerprint: string;
}

interface OwnershipPlan {
  readonly groups: readonly StateGroup[];
  readonly expectedStateKeys: readonly string[];
  readonly expectedStateKeySet: ReadonlySet<string>;
  readonly expectedStateKeyHash: string;
  readonly expectedEdgeKeys: readonly string[];
  readonly expectedEdgeKeySet: ReadonlySet<string>;
  readonly expectedEdgeKeyHash: string;
  readonly ownerIssues: readonly BlockScanStateIssue[];
}

/**
 * Graph-topology-scoped index, rebuilt only when the edge topology/metadata/
 * ownership hashes change (never on a plain block advance). One canonical
 * block-activity read (receipts + logs) resolves dirty state keys for BOTH
 * lanes through the same activity-identity reverse index.
 */
interface StateTopologyIndex {
  readonly key: string;
  readonly ownership: OwnershipPlan;
  /**
   * activity identity ("address:<lower>" | "pool-id:<lower>") -> composite
   * state keys. Swap pool addresses and protocol contract addresses both land
   * in address:*; V4-style poolIds land in pool-id:*.
   */
  readonly stateKeysByActivityIdentity: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  /**
   * shared-manager emitter address -> composite state keys owned by poolId
   * edges under that manager. When a manager log's poolId cannot be resolved
   * generically, these keys fall back to current-N direct reads.
   */
  readonly singletonStateKeysByEmitter: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  /** topic -> landed-event declarations, for resolving singleton poolIds. */
  readonly eventResolvers: ReadonlyMap<
    string,
    readonly {
      readonly topic: string;
      readonly emitter: LandedEventEmitter;
    }[]
  >;
  readonly groupByStateKey: ReadonlyMap<string, StateGroup>;
}

/**
 * One global dirty/carry partition per generation, derived from a single
 * canonical block-activity read. Both lanes consume the same plan: a state
 * key is direct when it lacks a source-matching base, its schema drifted, or
 * the block activity touched one of its identities; otherwise it carries with
 * the shared canonical activity proof.
 */
interface BlockActivityRefreshPlan {
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  readonly rangeFingerprint: string;
  readonly directStateKeys: ReadonlySet<string>;
  readonly carryStateKeys: ReadonlySet<string>;
  /** Proofs are shared by keys with the same last-good source. */
  readonly carryProofByPreviousSource: ReadonlyMap<
    string,
    StateFreshnessProof
  >;
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
  readonly staging: FamilyLaneStaging;
  readonly issues: readonly BlockScanStateIssue[];
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
  readonly committedBases: Map<
    string,
    {
      readonly previous: RecoveryStateBase | undefined;
      readonly current: RecoveryStateBase;
    }
  >;
  published: boolean;
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
// Deterministic per-key decode/derive failures (not transport errors) are
// deferred for a bounded window so a few permanently broken pools cannot
// re-run their full quote ladder on every generation.
const DEFERRED_STATE_KEY_FAIL_THRESHOLD = 3;
const DEFERRED_STATE_KEY_SKIP_BLOCKS = 256;
const DEFERRED_STATE_KEY_MAX = 64;
const ZERO_BLOCK_HASH = `0x${"00".repeat(32)}`;
// ERC-6909 claim transfers change a user's settlement claims, not a V4
// pool's slot0/liquidity pricing state. Treating them as an unknown manager
// mutation otherwise refreshes every pool behind the singleton.
const ERC6909_TRANSFER_TOPIC =
  "0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859";
// UniV4 PoolManager events that never mutate an existing pool's pricing
// state: Donate only sends protocol fees, Initialize creates a brand-new pool
// (discovery owns it). A decoded-but-untracked poolId is likewise a new pool;
// refreshing the whole singleton family on these is the observed 5.5k-key
// full-direct cascade.
const UNIV4_DONATE_TOPIC =
  "0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb";
const UNIV4_INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

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
  /**
   * stateKey -> sourceBlock until which (exclusive) the key is skipped. A key
   * reaches this only after DEFERRED_STATE_KEY_FAIL_THRESHOLD consecutive
   * decode/derive failures; a successful resolve clears it immediately.
   */
  private readonly deferredFailedStateKeys = new Map<string, number>();
  /** Consecutive deterministic per-key failures since the last success. */
  private readonly failedStateKeyAttempts = new Map<string, number>();
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
    const stateKeysByActivityIdentity = new Map<string, Set<string>>();
    const singletonStateKeysByEmitter = new Map<string, Set<string>>();
    const eventResolvers = new Map<
      string,
      {
        readonly topic: string;
        readonly emitter: LandedEventEmitter;
      }[]
    >();
    const groupByStateKey = new Map<string, StateGroup>();
    for (const group of ownership.groups) {
      groupByStateKey.set(group.stateKey, group);
      for (const edge of group.edges) {
        // Activity identity: poolId for v4-style families, the pool/contract
        // address otherwise. edge.target is the shared manager/router for
        // v4-style families and must not be used as the primary identity.
        const identity = edge.poolId !== undefined
          ? `pool-id:${edge.poolId.toLowerCase()}`
          : `address:${edge.target.toLowerCase()}`;
        const stateKeys = stateKeysByActivityIdentity.get(identity) ??
          new Set<string>();
        stateKeys.add(group.stateKey);
        stateKeysByActivityIdentity.set(identity, stateKeys);
        if (edge.poolId !== undefined) {
          const emitter = edge.target.toLowerCase();
          const fallback = singletonStateKeysByEmitter.get(emitter) ??
            new Set<string>();
          fallback.add(group.stateKey);
          singletonStateKeysByEmitter.set(emitter, fallback);
        }
      }
    }
    for (const family of families) {
      for (const event of family.mutationEvents) {
        if (event.topic === null) continue;
        const topic = event.topic.toLowerCase();
        const list = eventResolvers.get(topic) ?? [];
        list.push({ topic, emitter: event.emitter });
        eventResolvers.set(topic, list);
      }
    }
    const frozen = Object.freeze({
      key,
      ownership,
      stateKeysByActivityIdentity: new FrozenReadonlyMap(
        [...stateKeysByActivityIdentity].map(([identity, stateKeys]) => [
          identity,
          Object.freeze(new Set(stateKeys)),
        ] as const),
      ),
      singletonStateKeysByEmitter: new FrozenReadonlyMap(
        [...singletonStateKeysByEmitter].map(([emitter, stateKeys]) => [
          emitter,
          Object.freeze(new Set(stateKeys)),
        ] as const),
      ),
      eventResolvers: new FrozenReadonlyMap(
        [...eventResolvers].map(([topic, declarations]) => [
          topic,
          Object.freeze(declarations),
        ] as const),
      ),
      groupByStateKey,
    });
    this.topologyIndex = frozen;
    return frozen;
  }

  /**
   * Unified block-activity refresh plan: one canonical receipts+logs read
   * resolves every touched activity identity (swap pool addresses and
   * protocol contract addresses via address:*, V4-style poolIds via
   * pool-id:*) and partitions every state key into direct/carry for both
   * lanes. Returns null when no stateKey has an eligible last-good base or the
   * activity proof fails; the generation then direct-reads everything (cold
   * start / lagging base).
   */
  private async prepareBlockActivityRefreshPlan(
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<BlockActivityRefreshPlan | null> {
    const readActivity = this.backend.readCanonicalBlockActivity;
    const topology = this.topologyIndex;
    if (!readActivity || !topology) return null;
    const through: BlockSource = Object.freeze({
      number: graph.sourceBlock,
      hash: graph.sourceBlockHash,
      generation: graph.generation,
    });
    /*
     * A degraded publication may omit an entire family while healthy siblings
     * advance. The omitted keys still have valid, older last-good bases. Use
     * the oldest eligible per-key base as one canonical activity superset;
     * anchoring only at this.published.sourceBlock turns every older key into
     * an unnecessary current-N direct read and creates the observed fallback
     * cascade after one missed generation.
     */
    const eligibleBaseByStateKey = new Map<string, RecoveryStateBase>();
    let fromExclusive: BlockSource | undefined;
    for (const group of topology.ownership.groups) {
      const base = this.lastGoodByStateKey.get(group.stateKey);
      if (!base || base.schemaFingerprint !== group.schemaFingerprint) {
        continue;
      }
      const distance = through.number - base.state.source.number;
      if (
        distance <= 0 ||
        distance > this.incrementalRangeBlocks ||
        through.generation <= base.state.source.generation
      ) {
        continue;
      }
      eligibleBaseByStateKey.set(group.stateKey, base);
      if (
        fromExclusive === undefined ||
        compareBlockSource(base.state.source, fromExclusive) < 0
      ) {
        fromExclusive = base.state.source;
      }
    }
    if (fromExclusive === undefined) return null;
    let activity: CanonicalBlockActivity;
    try {
      activity = await awaitWithAbort(
        readActivity.call(this.backend, fromExclusive, through, {
          deadlineAtMs,
          signal,
          maxRangeBlocks: this.incrementalRangeBlocks,
        }),
        signal,
      );
    } catch {
      // Transient reth hiccups (header/coalesce errors) are common; retry once
      // before degrading the whole generation to a full-graph direct read,
      // which is slow enough to let the catch-up gap grow.
      try {
        activity = await awaitWithAbort(
          readActivity.call(this.backend, fromExclusive, through, {
            deadlineAtMs,
            signal,
            maxRangeBlocks: this.incrementalRangeBlocks,
          }),
          signal,
        );
      } catch {
        return null;
      }
    }
    if (
      !sameBlockSource(activity.fromExclusive, fromExclusive) ||
      !sameBlockSource(activity.through, through)
    ) {
      return null;
    }
    const canonicalHashByBlock = new Map<number, string>([
      [fromExclusive.number, fromExclusive.hash.toLowerCase()],
      [through.number, through.hash.toLowerCase()],
      ...(activity.canonicalBlocks ?? []).map((block) =>
        [block.number, block.hash.toLowerCase()] as const
      ),
    ]);
    const observed = new Set<string>();
    const fallbackDirty = new Set<string>();
    for (const address of activity.touchedAddresses) {
      observed.add(`address:${address.toLowerCase()}`);
    }
    for (const log of activity.events) {
      let singletonResolved = false;
      const topic = log.topics[0]?.toLowerCase();
      if (
        topic === ERC6909_TRANSFER_TOPIC ||
        topic === UNIV4_DONATE_TOPIC ||
        topic === UNIV4_INITIALIZE_TOPIC
      ) {
        continue;
      }
      const declarations = topic === undefined
        ? undefined
        : topology.eventResolvers.get(topic);
      if (declarations) {
        for (const declaration of declarations) {
          const raw = observedLandedPoolIdentity(declaration, log);
          if (raw === null) continue;
          if (
            declaration.emitter.mode === "singleton-indexed-bytes32" ||
            declaration.emitter.mode === "singleton-anonymous-data-bytes32"
          ) {
            observed.add(`pool-id:${raw.toLowerCase()}`);
            singletonResolved = true;
          } else {
            observed.add(`address:${raw.toLowerCase()}`);
          }
        }
      }
      const emitter = log.address?.toLowerCase();
      if (
        emitter !== undefined &&
        !singletonResolved &&
        topology.singletonStateKeysByEmitter.has(emitter)
      ) {
        const identities = poolIdIdentitiesFromLog(log);
        if (identities.length > 0) {
          /*
           * identityDecoded=true: the log carries a 32-byte pool identity.
           * Refresh only pools that exist in the current graph; an untracked
           * poolId belongs to a new/unknown pool and must not fail closed to
           * a whole-family direct read.
           */
          singletonResolved = true;
          for (const identity of identities) {
            if (topology.stateKeysByActivityIdentity.has(identity)) {
              observed.add(identity);
            }
          }
        }
      }
      if (
        emitter !== undefined &&
        !singletonResolved &&
        topology.singletonStateKeysByEmitter.has(emitter)
      ) {
        for (const stateKey of
          topology.singletonStateKeysByEmitter.get(emitter)!) {
          fallbackDirty.add(stateKey);
        }
      }
    }
    const directStateKeys = new Set<string>(fallbackDirty);
    for (const identity of observed) {
      for (const stateKey of
        topology.stateKeysByActivityIdentity.get(identity) ?? []) {
        directStateKeys.add(stateKey);
      }
    }
    const carryStateKeys = new Set<string>();
    const carryProofByPreviousSource = new Map<
      string,
      StateFreshnessProof
    >();
    const carryDiagnostics = new Map<
      string,
      {
        dirty: number;
        missing: number;
        sourceMismatch: number;
        fingerprintMismatch: number;
        carry: number;
      }
    >();
    for (const group of topology.ownership.groups) {
      const diagnostic = carryDiagnostics.get(group.familyId) ??
        {
          dirty: 0,
          missing: 0,
          sourceMismatch: 0,
          fingerprintMismatch: 0,
          carry: 0,
        };
      if (directStateKeys.has(group.stateKey)) {
        diagnostic.dirty++;
      } else {
        const rawBase = this.lastGoodByStateKey.get(group.stateKey);
        const base = eligibleBaseByStateKey.get(group.stateKey);
        const canonicalHash = base === undefined
          ? undefined
          : canonicalHashByBlock.get(base.state.source.number);
        if (
          !base ||
          canonicalHash === undefined ||
          canonicalHash !== base.state.source.hash.toLowerCase()
        ) {
          if (!rawBase) {
            diagnostic.missing++;
          } else if (rawBase.schemaFingerprint !== group.schemaFingerprint) {
            diagnostic.fingerprintMismatch++;
          } else {
            diagnostic.sourceMismatch++;
          }
          directStateKeys.add(group.stateKey);
        } else {
          diagnostic.carry++;
          carryStateKeys.add(group.stateKey);
          const sourceKey = blockSourceKey(base.state.source);
          if (!carryProofByPreviousSource.has(sourceKey)) {
            carryProofByPreviousSource.set(sourceKey, Object.freeze({
              kind: "carry-forward" as const,
              source: Object.freeze({ ...through }),
              previousSource: Object.freeze({ ...base.state.source }),
              mutationRangeFingerprint: activity.rangeFingerprint,
              completeThroughBlock: activity.through.number,
              completeThroughHash: activity.through.hash,
            }));
          }
        }
      }
      carryDiagnostics.set(group.familyId, diagnostic);
    }
    console.log(
      `[searcher/blockscan-activity-carry] ${JSON.stringify({
        sourceBlock: graph.sourceBlock,
        direct: directStateKeys.size,
        carry: carryStateKeys.size,
        byFamily: Object.fromEntries(
          [...carryDiagnostics.entries()].sort(([a], [b]) =>
            a.localeCompare(b)
          ),
        ),
      })}`,
    );
    return Object.freeze({
      fromExclusive: Object.freeze({ ...fromExclusive }),
      through,
      rangeFingerprint: activity.rangeFingerprint,
      directStateKeys: Object.freeze(directStateKeys),
      carryStateKeys: Object.freeze(carryStateKeys),
      carryProofByPreviousSource: new FrozenReadonlyMap(
        [...carryProofByPreviousSource],
      ),
    });
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
    this.deferredFailedStateKeys.clear();
    this.failedStateKeyAttempts.clear();
    this.previousCanonicalGraphStateKeys = null;
    this.hotRecoveryCursorByFamily.clear();
  }

  async prepare(input: PrepareBlockScanStateInput): Promise<BlockScanStatePrepareResult> {
    const { graph } = input;
    const prepareStartedAtMs = this.now();
    const prepareHeapAtStart = process.memoryUsage().heapUsed;
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
    const active: ActiveGeneration = {
      generation: graph.generation,
      token,
      controller,
      committedBases: new Map(),
      published: false,
    };
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
          coverage.completeThroughHash.toLowerCase() !== ZERO_BLOCK_HASH &&
          coverage.completeThroughHash.toLowerCase() !==
            graph.sourceBlockHash.toLowerCase()
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
      /*
       * Phase 1: compile every family's static schema (cached per topology).
       * The unified block-activity refresh plan is a single canonical
       * receipts+logs read that partitions every state key into
       * direct/carry for both lanes; no per-family mutation-range proof is
       * left to preempt background reads.
       */
      const allGroups = [...laneGroups.swap, ...laneGroups.protocol];
      const preparedStartedAtMs = this.now();
      const preparedPhases = await Promise.all(
        uniqueFamilies(allGroups).map(async (family) => {
          const familyGroups = allGroups.filter(
            (group) => group.familyId === family.familyId,
          );
          const lane = familyGroups[0]!.lane;
          return this.prepareFamilyPhase({
            lane,
            groups: familyGroups,
            graph,
            deadlineAtMs: familySettleDeadlineAtMs,
            signal: controller.signal,
          });
        }),
      );
      const preparedPhasesMs = Math.max(0, this.now() - preparedStartedAtMs);
      const preparedPhaseByFamily = new Map(
        preparedPhases.map((phase) => [phase.familyId, phase] as const),
      );
      const activityStartedAtMs = this.now();
      const refreshPlan = await this.prepareBlockActivityRefreshPlan(
        graph,
        familySettleDeadlineAtMs,
        controller.signal,
      );
      const activityPlanMs = Math.max(0, this.now() - activityStartedAtMs);
      // Phase 2: direct reads + decode for both lanes, driven by the shared
      // refresh plan (dirty direct / untouched carry with one canonical proof).
      const lanesStartedAtMs = this.now();
      const [swap, protocol] = await Promise.all([
        this.runLane(
          "swap",
          laneGroups.swap,
          graph,
          familySettleDeadlineAtMs,
          controller.signal,
          preparedPhaseByFamily,
          refreshPlan,
        ),
        this.runLane(
          "protocol",
          laneGroups.protocol,
          graph,
          familySettleDeadlineAtMs,
          controller.signal,
          preparedPhaseByFamily,
          refreshPlan,
        ),
      ]);
      const lanesFinishedAtMs = this.now();
      const lanesMs = Math.max(0, lanesFinishedAtMs - lanesStartedAtMs);
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
        {
          expectedStateKeySet: ownership.expectedStateKeySet,
          expectedStateKeyHash: ownership.expectedStateKeyHash,
          expectedEdgeKeySet: ownership.expectedEdgeKeySet,
          expectedEdgeKeyHash: ownership.expectedEdgeKeyHash,
        },
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
      const laneMids = lanes.flatMap((lane) => lane.mids);
      const laneFreshness = lanes.flatMap((lane) => lane.freshness);
      const laneStates = lanes.flatMap((lane) => lane.states);
      /*
       * Delta publication: when the expected key sets are unchanged (same
       * topology), copy the previous frozen maps (O(n) pointer moves, order
       * preserved -> no re-sort) and update only this generation's entries.
       * The old assembly flatMap+filter+map+sort rebuilt and re-allocated
       * ~80k entries per generation, the measured CPU/GC hotspot.
       */
      const previousSnapshot = this.published;
      const previousCoverage = previousSnapshot?.coverage;
      const keySetsUnchanged =
        previousSnapshot !== undefined &&
        previousCoverage !== undefined &&
        previousCoverage.expectedStateKeyHash ===
          coverage.expectedStateKeyHash &&
        previousCoverage.expectedReadKeyHash ===
          coverage.expectedReadKeyHash &&
        previousCoverage.expectedEdgeKeyHash ===
          coverage.expectedEdgeKeyHash;
      const previousResolvedStateKeys = new Set(
        previousSnapshot?.coverage.resolvedStateKeys ?? [],
      );
      const previousResolvedReadKeys = new Set(
        previousSnapshot?.coverage.resolvedReadKeys ?? [],
      );
      const previousResolvedEdgeKeys = new Set(
        previousSnapshot?.coverage.resolvedEdgeKeys ?? [],
      );
      const removedStateKeys = keySetsUnchanged
        ? [...previousResolvedStateKeys].filter(
            (key) => !resolvedStateKeySet.has(key),
          )
        : [];
      const removedReadKeys = keySetsUnchanged
        ? [...previousResolvedReadKeys].filter(
            (key) => !resolvedReadKeySet.has(key),
          )
        : [];
      const removedEdgeKeys = keySetsUnchanged
        ? [...previousResolvedEdgeKeys].filter(
            (key) => !resolvedEdgeKeySet.has(key),
          )
        : [];
      const mids = keySetsUnchanged
        ? deltaFrozenMap(previousSnapshot!.mids, laneMids, removedEdgeKeys)
        : new FrozenReadonlyMap(
            laneMids
              .filter(([edgeKey]) => resolvedEdgeKeySet.has(edgeKey))
              .map(([key, mid]) => [key, freezeMid(mid)] as const)
              .sort(([a], [b]) => a.localeCompare(b)),
          );
      const freshnessByReadKey = keySetsUnchanged
        ? deltaFrozenMap(
            previousSnapshot!.freshnessByReadKey,
            laneFreshness,
            removedReadKeys,
          )
        : new FrozenReadonlyMap(
            laneFreshness
              .filter(([readKey]) => resolvedReadKeySet.has(readKey))
              .sort(([a], [b]) => a.localeCompare(b)),
          );
      /*
       * Delta publication: the coverage maps are a pure function of the
       * expected/resolved/unavailable key sets. When every hash is unchanged
       * from the previous published snapshot, share the frozen maps instead
       * of rebuilding ~70k frozen entries per generation.
       */
      const coverageMapsUnchanged =
        previousSnapshot !== undefined &&
        previousCoverage !== undefined &&
        previousCoverage.expectedReadKeyHash ===
          coverage.expectedReadKeyHash &&
        previousCoverage.resolvedReadKeyHash ===
          coverage.resolvedReadKeyHash &&
        previousCoverage.expectedEdgeKeyHash ===
          coverage.expectedEdgeKeyHash &&
        previousCoverage.resolvedEdgeKeyHash ===
          coverage.resolvedEdgeKeyHash &&
        previousCoverage.unavailableEdgeKeyHash ===
          coverage.unavailableEdgeKeyHash;
      const coverageByReadKey = coverageMapsUnchanged
        ? previousSnapshot!.coverageByReadKey
        : new FrozenReadonlyMap(
            coverage.expectedReadKeys.map((readKey) => [
              readKey,
              resolvedReadKeySet.has(readKey)
                ? Object.freeze({ status: "resolved" as const })
                : Object.freeze({
                    status: "unresolved" as const,
                    reason:
                      "required current-block read did not resolve for its stateKey",
                  }),
            ] as const),
          );
      const coverageByEdgeKey = coverageMapsUnchanged
        ? previousSnapshot!.coverageByEdgeKey
        : new FrozenReadonlyMap(
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
      const stateByStateKey = keySetsUnchanged
        ? deltaFrozenMap(
            previousSnapshot!.stateByStateKey,
            laneStates,
            removedStateKeys,
          )
        : new FrozenReadonlyMap(
            laneStates
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
      // runFamilyLane already committed each resolved key together with its
      // validated mids. Do not walk/hash the full published map again here;
      // that duplicated all-key work and also made rollback ambiguous if a
      // generation failed between base mutation and snapshot publication.
      this.published = snapshot;
      active.published = true;
      const assemblyFinishedAtMs = this.now();
      const degraded =
        incompleteFamilyIds.length > 0 ||
        coverage.unresolvedStateKeys.length > 0 ||
        coverage.unresolvedReadKeys.length > 0 ||
        coverage.unresolvedEdgeKeys.length > 0 ||
        issues.length > 0;
      console.log(
        `[searcher/blockscan-state-stages] ${JSON.stringify({
          sourceBlock: graph.sourceBlock,
          generation: graph.generation,
          status: degraded ? "degraded" : "complete",
          prepareMs: Math.max(0, assemblyFinishedAtMs - prepareStartedAtMs),
          preparedPhasesMs,
          activityPlanMs,
          lanesMs,
          assemblyMs: Math.max(
            0,
            assemblyFinishedAtMs - lanesFinishedAtMs,
          ),
          heapDeltaMB: Math.round(
            (process.memoryUsage().heapUsed - prepareHeapAtStart) / 1048576,
          ),
        })}`,
      );
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
      if (!active.published) {
        for (const [stateKey, committed] of active.committedBases) {
          if (this.lastGoodByStateKey.get(stateKey) !== committed.current) {
            continue;
          }
          if (committed.previous === undefined) {
            this.lastGoodByStateKey.delete(stateKey);
          } else {
            this.lastGoodByStateKey.set(stateKey, committed.previous);
          }
        }
      }
      active.committedBases.clear();
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
   * @deprecated Replaced by the unified block-activity refresh plan
   * (prepareBlockActivityRefreshPlan); kept only until the dead per-family
   * planner is fully removed.
   */
  private async prepareIncrementalPlans(
    groups: readonly StateGroup[],
    compiledFamilies: ReadonlyMap<string, CompiledBlockScanStateFamily>,
    graph: VerifiedGraphView,
    deadlineAtMs: number,
    signal: AbortSignal,
    generationSignal: AbortSignal,
  ): Promise<IncrementalPreparation> {
    throw new Error("unified activity plan replaced per-family planning");
  }

  private async prepareFamilyPhase(input: {
    readonly lane: BlockScanPricingLane;
    readonly groups: readonly StateGroup[];
    readonly graph: VerifiedGraphView;
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal;
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
      const issues: BlockScanStateIssue[] = [];
      const compiledFamilies = new Map<
        string,
        CompiledBlockScanStateFamily
      >();
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
      return Object.freeze({
        familyId,
        lane,
        compiledFamilies,
        staging,
        issues: Object.freeze(issues),
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
    refreshPlan: BlockActivityRefreshPlan | null,
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
        refreshPlan,
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
    refreshPlan: BlockActivityRefreshPlan | null,
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
    const missingPreviousStateKeys = groups.filter(
      (group) => !this.recoveryBaseForGroup(group),
    ).length;
    const staging = prepared.staging;
    let carryStateKeys = 0;
    let directStateKeys = groups.length;
    staging.carryStateKeys = carryStateKeys;
    staging.directStateKeys = directStateKeys;
    staging.missingPreviousStateKeys = missingPreviousStateKeys;

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
    const cacheSourcedStateKeys = new Set<string>();
    const badStateKeys = new Set<string>(
      groups
        .filter((group) => !compiledFamilies.has(group.familyId))
        .map((group) => group.stateKey),
    );
    for (const group of groups) {
      const deferredUntil = this.deferredFailedStateKeys.get(group.stateKey);
      if (deferredUntil !== undefined && graph.sourceBlock < deferredUntil) {
        badStateKeys.add(group.stateKey);
      }
    }

    /*
     * Partition from the unified block-activity refresh plan: a key carries
     * when the single canonical activity proof covers it (base source matches
     * the range and no touched identity marks it dirty); everything else
     * direct-reads current N. Swap and protocol share the same plan.
     */
    for (const group of groups) {
      if (badStateKeys.has(group.stateKey)) continue;
      if (refreshPlan?.carryStateKeys.has(group.stateKey)) {
        const base = this.recoveryBaseForGroup(group);
        if (!base) continue;
        const readKeys = base.state.requiredReadKeys;
        carryForwardStateKeys.add(group.stateKey);
        carryReadKeysByStateKey.set(group.stateKey, readKeys);
        closedStateKeys.add(group.stateKey);
        for (const readKey of readKeys) {
          staging.expectedReadKeys.add(
            globalReadId(group.stateKey, readKey),
          );
        }
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
          snapshot = this.recoveryBaseForGroup(group)?.state.snapshot;
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
        this.recordHardStateKeyFailure(group, graph);
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
        const reusedValidatedBase =
          carryForward &&
          previousBase !== undefined &&
          derived === previousBase.midsByEdgeKey &&
          unavailable === previousBase.unavailableByEdgeKey;
        if (!reusedValidatedBase) {
          const expectedEdges = group.edgeKeySet;
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
              group.edgeKeys.filter(
                (edgeKey) => !unavailable.has(edgeKey),
              ),
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
        }
        resolvedStateKeys.push(group.stateKey);
        const localFreshness = new Map<string, StateFreshnessProof>();
        for (const localId of requiredLocalIds) {
          const globalId = globalReadId(group.stateKey, localId);
          let proof: StateFreshnessProof;
          if (carryForward) {
            if (!refreshPlan) {
              throw new Error(
                "carry-forward state lacks a canonical activity plan",
              );
            }
            if (!previousBase) {
              throw new Error(
                "carry-forward state lacks its last-good recovery base",
              );
            }
            const carryProof = refreshPlan.carryProofByPreviousSource.get(
              blockSourceKey(previousBase.state.source),
            );
            if (!carryProof) {
              throw new Error(
                "carry-forward state lacks its stateKey-local activity proof",
              );
            }
            proof = carryProof;
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
          requiredReadKeys: carryForward && previousBase
            ? previousBase.state.requiredReadKeys
            : Object.freeze([...requiredLocalIds].sort()),
          freshnessByReadKey: new FrozenReadonlyMap(
            [...localFreshness.entries()].sort(([a], [b]) =>
              a.localeCompare(b)
            ),
          ),
          refreshMode: cacheEntry
            ? "unproven-direct"
            : carryForward
            ? "carry-forward"
            : "unproven-direct",
          backrunInvalidations: Object.freeze(
            [],
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
        const committedBase: RecoveryStateBase = Object.freeze({
          state: publishedState,
          schemaFingerprint: group.schemaFingerprint,
          requiredReadKeyHash: exactSetHash(publishedState.requiredReadKeys),
          midsByEdgeKey: derived === previousBase?.midsByEdgeKey
            ? derived
            : Object.freeze(
                new Map(
                  [...derived].map(([edgeKey, mid]) => [
                    edgeKey,
                    freezeMid(mid),
                  ] as const),
                ),
              ),
          unavailableByEdgeKey:
            unavailable === previousBase?.unavailableByEdgeKey
              ? unavailable
              : Object.freeze(new Map(unavailable)),
        });
        const activeGeneration = this.active;
        if (
          activeGeneration?.generation !== graph.generation ||
          activeGeneration.controller.signal.aborted
        ) {
          continue;
        }
        if (!activeGeneration.committedBases.has(group.stateKey)) {
          activeGeneration.committedBases.set(group.stateKey, {
            previous: this.lastGoodByStateKey.get(group.stateKey),
            current: committedBase,
          });
        }
        this.lastGoodByStateKey.set(group.stateKey, committedBase);
        this.clearStateKeyFailure(group);
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
        this.recordHardStateKeyFailure(group, graph);
      }
    }

    const finishedAtMs = this.now();
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

  private recordHardStateKeyFailure(
    group: StateGroup,
    graph: VerifiedGraphView,
  ): void {
    const next = (this.failedStateKeyAttempts.get(group.stateKey) ?? 0) + 1;
    this.failedStateKeyAttempts.set(group.stateKey, next);
    if (next < DEFERRED_STATE_KEY_FAIL_THRESHOLD) return;
    if (this.deferredFailedStateKeys.size >= DEFERRED_STATE_KEY_MAX) return;
    const skipUntilBlock = graph.sourceBlock + DEFERRED_STATE_KEY_SKIP_BLOCKS;
    this.deferredFailedStateKeys.set(group.stateKey, skipUntilBlock);
    console.log(
      `[searcher/blockscan-deferred-key] ${JSON.stringify({
        familyId: group.familyId,
        stateKey: group.stateKey,
        failures: next,
        skipUntilBlock,
      })}`,
    );
  }

  private clearStateKeyFailure(group: StateGroup): void {
    const wasDeferred = this.deferredFailedStateKeys.delete(group.stateKey);
    this.failedStateKeyAttempts.delete(group.stateKey);
    if (wasDeferred) {
      console.log(
        `[searcher/blockscan-deferred-key] ${JSON.stringify({
          familyId: group.familyId,
          stateKey: group.stateKey,
          recovered: true,
        })}`,
      );
    }
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

function compareBlockSource(a: BlockSource, b: BlockSource): number {
  return a.number - b.number ||
    a.hash.toLowerCase().localeCompare(b.hash.toLowerCase()) ||
    a.generation - b.generation;
}

function blockSourceKey(source: BlockSource): string {
  return [
    source.number,
    source.hash.toLowerCase(),
    source.generation,
  ].join("\u001f");
}

function poolIdIdentitiesFromLog(log: ChainLog): readonly string[] {
  const words = new Set<string>();
  for (const topic of log.topics.slice(1)) {
    if (/^0x[0-9a-fA-F]{64}$/.test(topic)) {
      words.add(topic.toLowerCase());
    }
  }
  if (/^0x(?:[0-9a-fA-F]{64})*$/.test(log.data)) {
    const data = log.data.slice(2);
    for (let offset = 0; offset < data.length; offset += 64) {
      words.add(`0x${data.slice(offset, offset + 64)}`.toLowerCase());
    }
  }
  return Object.freeze(
    [...words]
      .map((word) => `pool-id:${word}`)
  );
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
      edgeKeySet: new Set(group.edgeKeys),
      schemaFingerprint: stateSchemaFingerprint(group.edges),
    }));
  return Object.freeze({
    groups: Object.freeze(groups),
    expectedStateKeys: Object.freeze(groups.map((group) => group.stateKey).sort()),
    expectedStateKeySet: new Set(groups.map((group) => group.stateKey)),
    expectedStateKeyHash: exactSetHash(groups.map((group) => group.stateKey).sort()),
    expectedEdgeKeys: Object.freeze([...new Set(expectedEdgeKeys)].sort()),
    expectedEdgeKeySet: new Set(expectedEdgeKeys),
    expectedEdgeKeyHash: exactSetHash([...new Set(expectedEdgeKeys)].sort()),
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
  precomputed?: {
    readonly expectedStateKeySet?: ReadonlySet<string>;
    readonly expectedStateKeyHash?: string;
    readonly expectedEdgeKeySet?: ReadonlySet<string>;
    readonly expectedEdgeKeyHash?: string;
  },
): BlockScanStateCoverage {
  const expectedStateKeys = precomputed?.expectedStateKeyHash !== undefined
    ? expectedStateKeysInput
    : uniqueSorted(expectedStateKeysInput);
  const expectedReadKeys = uniqueSorted(expectedReadKeysInput);
  const expectedEdgeKeys = precomputed?.expectedEdgeKeyHash !== undefined
    ? expectedEdgeKeysInput
    : uniqueSorted(expectedEdgeKeysInput);
  const expectedStateSet =
    precomputed?.expectedStateKeySet ?? new Set(expectedStateKeys);
  const expectedReadSet = new Set(expectedReadKeys);
  const expectedEdgeSet =
    precomputed?.expectedEdgeKeySet ?? new Set(expectedEdgeKeys);
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
    expectedStateKeyHash:
      precomputed?.expectedStateKeyHash ?? exactSetHash(expectedStateKeys),
    resolvedStateKeyHash: exactSetHash(resolvedStateKeys),
    unresolvedStateKeyHash: exactSetHash(unresolvedStateKeys),
    expectedReadKeyHash: exactSetHash(expectedReadKeys),
    resolvedReadKeyHash: exactSetHash(resolvedReadKeys),
    unresolvedReadKeyHash: exactSetHash(unresolvedReadKeys),
    expectedEdgeKeyHash:
      precomputed?.expectedEdgeKeyHash ?? exactSetHash(expectedEdgeKeys),
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
  // Delta publication: carried keys share the already-frozen mid object from
  // the recovery base, so the per-generation snapshot assembly stops copying
  // every mid (+ edge array) on an unchanged 35k-edge graph.
  if (Object.isFrozen(mid)) return mid;
  return Object.freeze({
    ...mid,
    edges: Object.freeze([...mid.edges]) as unknown as TokenEdge[],
  });
}

/**
 * Delta map assembly: copy the previous frozen map (preserving its sorted
 * insertion order), apply this generation's entry updates and drop keys that
 * became unresolved. The old flatMap+filter+map+sort rebuilt and
 * re-allocated the full map every generation.
 */
function deltaFrozenMap<K, V>(
  previous: ReadonlyMap<K, V>,
  updates: readonly (readonly [K, V])[],
  removed: readonly K[],
): FrozenReadonlyMap<K, V> {
  const merged = new Map<K, V>();
  for (const [key, value] of previous.entries()) merged.set(key, value);
  for (const [key, value] of updates) merged.set(key, value);
  for (const key of removed) merged.delete(key);
  return new FrozenReadonlyMap([...merged.entries()]);
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
