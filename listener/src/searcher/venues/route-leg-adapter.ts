import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import type { ProtocolAction, SlotKind } from "../strategy-taxonomy.js";
import type { AttestedPoolEntry } from "./identity.js";
import type {
  IdentityResolverDescriptor,
  OnchainIdentityResolver,
} from "./identity.js";
import type { SwapObservationCapability } from "./swap-observation.js";
import type { BlockScanStateCapability } from "./blockscan-state-capability.js";
import type { RegisteredFundingFamily } from "./funding/funding-capability.js";
import type { RouteInstanceIdentityCapability } from "./route-instance-identity.js";
import type { SwapLandedEventDeclaration } from "./landed-event-registry.js";
import type { SwapVictimModelDeclaration } from "./victim-model-registry.js";
import type { LandedPoolMaterializationCapability } from "./landed-pool-discovery.js";
import type { OracleVictimDescriptor } from "../detector/victim-effect.js";

export type SwapExecutionFamilyId =
  | "univ2-standard"
  | "univ3-standard"
  | "univ4"
  | "curve-plain"
  | "curve-underlying"
  | "balancer-v3"
  | "fluid-dex"
  | `custom-swap:${string}`;

export type ProtocolExecutionFamilyId = `protocol:${string}`;
export type FlashLoanExecutionFamilyId = `flash-loan:${string}`;
export type CreditExecutionFamilyId = `credit:${string}`;
export type LiquidityExecutionFamilyId = `liquidity:${string}`;
export type ExecutionFamilyId =
  | SwapExecutionFamilyId
  | ProtocolExecutionFamilyId
  | FlashLoanExecutionFamilyId
  | CreditExecutionFamilyId
  | LiquidityExecutionFamilyId;

export type AdapterFamilyKind =
  | "swap"
  | "protocol-conversion"
  | "flash-loan"
  | "credit"
  | "liquidity";
export type RouteLegKind = Exclude<AdapterFamilyKind, "flash-loan">;

export type IdentityAuthorityClass =
  | "canonical-onchain"
  | "observed-event"
  | "provisional"
  | "trusted-seed";

export interface IdentityAuthority {
  readonly class: IdentityAuthorityClass;
  /** Higher wins; the kernel never maps protocol/source strings to a rank. */
  readonly strength: number;
}

export interface RouteEdgeBuildControl {
  /** Absolute deadline shared by every read in this family build. */
  readonly deadlineAtMs?: number;
  /** Family-scoped cancellation; adapters must not publish after abort. */
  readonly signal?: AbortSignal;
}

export interface AdapterFamilyBase<
  Kind extends AdapterFamilyKind = AdapterFamilyKind,
> {
  readonly id: ExecutionFamilyId;
  readonly kind: Kind;
  /** Encoders whose execution semantics are owned by exactly this family. */
  readonly ownedActionAdapterIds: readonly string[];
  /** Shared low-level BotVM building blocks required by this family. */
  readonly requiredInfraActionAdapterIds: readonly string[];
}

export interface AllowedTaxonomy {
  slotKind: SlotKind;
  protocolAction?: ProtocolAction;
}

export interface PlanBuildContext {
  edge: TokenEdge;
  amountIn: bigint;
  amountOut: bigint;
  rawOut?: bigint;
  executor: string;
  state: StateBackend;
}

export type PlanRequirement =
  | { kind: "approve"; token: string; spender: string; amount: bigint }
  | { kind: "transfer-to-pool"; token: string; pool: string; amount: bigint };

export interface PlanFragment {
  requirements: readonly PlanRequirement[];
  nodes: readonly ResolvedPlanNode[];
}

export interface ExactQuoteContext {
  state: StateBackend;
  target: string;
  edgeAdapterId: string;
  amountIn: bigint;
  tokenIn?: string;
  tokenOut?: string;
  poolToken0?: string;
  poolToken1?: string;
  edge?: TokenEdge;
  cache?: PoolStateCache;
  v4PoolKey?: TokenEdge["v4PoolKey"];
  v4QuoteStats?: V4QuotePathStats;
}

export interface V4QuotePathStats {
  local: number;
  fallback: number;
  localFailures: number;
  hookSkipped: number;
}

export interface ProtocolDiscoveryLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
}

export interface ProtocolDiscoveryReceipt {
  readonly status: number | null;
  readonly logs: readonly ProtocolDiscoveryLog[];
}

export type ProtocolDiscoveryTopicFilter = string | readonly string[] | null;

export type RouteCandidateSourceKind =
  | "dex-token-domain"
  | "observed-interaction"
  | "canonical-registry";

export interface ProtocolDiscoverySimulatedCallResult {
  /** 1 = success, 0 = revert. */
  readonly status: number;
  readonly returnData: string;
  readonly logs: readonly ProtocolDiscoveryLog[];
}

export interface ProtocolDiscoveryReadControl {
  /** Absolute wall-clock deadline shared by every retry for this operation. */
  readonly deadlineAtMs?: number;
  /** Aborts the actual RPC transport; callers must not abort the parent signal. */
  readonly signal?: AbortSignal;
  /**
   * Optional shared read budget. Each actual transport attempt enters this
   * wrapper independently so retries cannot bypass the background semaphore.
   */
  readonly run?: <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

/** All state reads are pinned to one current block on the configured node. */
export interface ProtocolDiscoveryReadBackend {
  call(
    req: { to: string; data: string; from?: string },
    control?: ProtocolDiscoveryReadControl,
  ): Promise<string>;
  getCode(
    address: string,
    control?: ProtocolDiscoveryReadControl,
  ): Promise<string>;
  getStorageAt(
    address: string,
    position: bigint,
    control?: ProtocolDiscoveryReadControl,
  ): Promise<string>;
  getLogs(req: {
    readonly address?: string;
    readonly topics: readonly ProtocolDiscoveryTopicFilter[];
    readonly fromBlock: number;
    readonly toBlock: number;
  }, control?: ProtocolDiscoveryReadControl): Promise<readonly ProtocolDiscoveryLog[]>;
  getTransactionReceipt(
    txHash: string,
    control?: ProtocolDiscoveryReadControl,
  ): Promise<ProtocolDiscoveryReceipt | null>;
  traceTransaction(
    txHash: string,
    control?: ProtocolDiscoveryReadControl,
  ): Promise<unknown>;
  /**
   * Optional block-pinned execution simulation with state overrides
   * (eth_simulateV1 on a node or local fork). Enables nonzero execution
   * evidence for dormant instances; absence degrades adapters to their
   * view-only probes.
   */
  simulateCalls?(req: {
    readonly calls: readonly { readonly from: string; readonly to: string; readonly data: string }[];
    readonly stateOverrides?: Readonly<Record<string, {
      readonly stateDiff?: Readonly<Record<string, string>>;
    }>>;
  }, control?: ProtocolDiscoveryReadControl): Promise<readonly ProtocolDiscoverySimulatedCallResult[]>;
  /**
   * Optional eth_createAccessList: reveals the exact storage slots a call
   * reads. Used to locate a share-balance mapping slot regardless of layout
   * (solidity low-slot, vyper, ERC-7201 namespaced, diamond); absence falls
   * back to the linear slot scan.
   */
  createAccessList?(req: {
    readonly from: string;
    readonly to: string;
    readonly data: string;
  }, control?: ProtocolDiscoveryReadControl): Promise<
    readonly { readonly address: string; readonly storageKeys: readonly string[] }[]
  >;
}

export interface ProtocolDiscoveryContext {
  readonly backend: ProtocolDiscoveryReadBackend;
  readonly blockNumber: number;
  readonly fromBlock: number;
  readonly toBlock: number;
  /** Decimal chain id for semantic route keys; absent only in chain-agnostic fixtures. */
  readonly chainId?: string;
  /** Complete graph domain used only for post-match loop-closability checks. */
  readonly graphTokens: readonly string[];
  /** Production BotVM caller used by caller-sensitive active behavior probes. */
  readonly probeExecutor?: string;
  /** Previously admitted instances are re-probed so upgrades and route removal replace atomically. */
  readonly retainedInstances: readonly AttestedProtocolInstance[];
}

export interface ProtocolCandidate {
  readonly pool: PoolEntry;
  readonly source: string;
  /** Present for candidates derived from a concrete calltrace interaction. */
  readonly selector?: string;
  /** Adapter-owned evidence. The coordinator treats it as opaque and never turns it into identity. */
  readonly evidence?: readonly unknown[];
}

export interface ProtocolAddressCandidateSurface {
  readonly target: string;
  readonly codeHash: string;
  readonly implementationWord: string;
}

/**
 * Cross-block matcher reuse is an opt-in family contract, never a TTL.
 *
 * The family reads every mutable value that can change candidateFromAddress
 * output at the current source block and commits those values into one
 * fingerprint. The registry validates the explicit immutability invariant;
 * the scanner reuses an entry only when the matcher contract and this
 * current-block dependency fingerprint are both unchanged.
 */
export interface ProtocolAddressMatcherCachePolicy {
  readonly kind: "current-block-dependency-fingerprint";
  readonly invariant:
    "matcher-output-immutable-while-code-implementation-and-dependencies-match";
  /** Bump whenever the dependency read or encoding contract changes. */
  readonly version: string;
  currentDependencyFingerprint(
    candidate: ProtocolAddressCandidateSurface,
    ctx: ProtocolDiscoveryContext,
  ): Promise<string>;
}

export interface AttestedProtocolInstance {
  readonly pool: AttestedPoolEntry<PoolEntry>;
  readonly sources: readonly string[];
  /** Candidate classification remains address+selector; instance admission aggregates by address. */
  readonly selectors: readonly string[];
  readonly evidence: readonly unknown[];
  /**
   * Family adapter that verified this instance. A retained instance re-enters
   * ONLY its owner's candidate set, so one family's prior admission can never
   * seed a sibling family that shares the same pool adapter kind.
   */
  readonly ownerAdapterId?: string;
}

/**
 * The shared scanner owns block/log/receipt/trace enumeration. A family adapter
 * only declares its cheap event shortlist and parses addresses/interactions into
 * candidates. Identity and route probing remain shared admission gates.
 */
export interface ProtocolDiscoveryCapability {
  /** Declarative source ownership; the shared scanner remains the only scheduler. */
  readonly candidateSources: readonly RouteCandidateSourceKind[];
  /**
   * Registry-owned provenance hints for clean-start recall. These are addresses
   * only: they nominate contracts for candidateFromAddress, but carry no token,
   * route, identity, or admission credential.
   */
  readonly candidateAddressHints?: readonly string[];
  /** Topic-0 values that make a transaction worth receipt+trace inspection. */
  readonly eventTopics: readonly string[];
  /** Manually adapted on-chain calls that may establish this family's interaction. */
  readonly callSelectors: readonly string[];
  /** Bump when address matching semantics change so persisted negatives retry. */
  readonly addressMatcherVersion?: string;
  /**
   * Optional conformance-checked cross-block cache contract. Omission means
   * candidateFromAddress executes again at every source block.
   */
  readonly addressMatcherCachePolicy?: ProtocolAddressMatcherCachePolicy;
  /**
   * Bump when receipt/trace classification semantics change. The shared
   * cursor fingerprint uses this to schedule one bounded historical backfill.
   */
  readonly observedMatcherVersion?: string;
  /** Optional C2 matcher; the shared scanner owns DEX-token iteration and caching. */
  candidateFromAddress?(
    candidate: ProtocolAddressCandidateSurface,
    ctx: ProtocolDiscoveryContext,
  ): Promise<ProtocolCandidate | null>;
  probeCandidate(
    instance: AttestedProtocolInstance,
    ctx: ProtocolDiscoveryContext,
  ): Promise<readonly TokenEdge[]>;
  /** Optional Slice-E source. Selector match is only a candidate; identity/probe still follow. */
  candidateFromObservedCall?(
    call: {
      readonly target: string;
      readonly selector: string;
      /** Full successful call input. Required by multi-pair behavior families. */
      readonly input: string;
      /** Caller from callTracer when available; missing callers fail closed in families that need one. */
      readonly from?: string;
      readonly txHash: string;
      readonly receipt: ProtocolDiscoveryReceipt;
      /** Full transaction trace fetched once by the shared scanner. */
      readonly trace: unknown;
    },
    ctx: ProtocolDiscoveryContext,
  ): Promise<ProtocolCandidate | null>;
}

export interface PreparedRouteRequest {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolToken0?: string;
  poolToken1?: string;
  v4PoolKey?: TokenEdge["v4PoolKey"];
}

export interface PreparedRouteCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
}

export interface PreparedRouteCallResult {
  output: string;
  latencyMs: number;
  cacheStats?: { warmHits: number; coldMisses: number };
}

export interface PreparedRouteQuoteResult {
  amountOut: bigint;
  latencyMs: number;
  cacheStats?: { warmHits: number; coldMisses: number };
}

export interface PreparedRouteContext {
  request: PreparedRouteRequest;
  edge?: TokenEdge;
  callPrepared(
    to: string,
    data: string,
    options?: { from?: string; gasLimit?: number },
  ): Promise<PreparedRouteCallResult>;
  readChain(req: { to: string; data: string }): Promise<string>;
}

export interface PreparedRouteCapability {
  readonly quote: ((ctx: PreparedRouteContext) => Promise<PreparedRouteQuoteResult>) | null;
  readonly quoteUnsupportedReason: string | null;
  readonly encodeQuotePrewarm:
    ((ctx: PreparedRouteContext) => Promise<readonly PreparedRouteCall[]>) | null;
  readonly allowanceSpender: ((request: PreparedRouteRequest) => string | null) | null;
  readonly prewarmAddresses: ((request: PreparedRouteRequest) => readonly string[]) | null;
}

export interface RouteLegAdapter<
  Kind extends RouteLegKind = RouteLegKind,
> extends AdapterFamilyBase<Kind> {
  readonly poolAdapters: readonly PoolEntry["adapter"][];
  /**
   * Optional projection into the mature low-latency PoolStateCache used by
   * backrun/JIT lanes. The updater dispatches by this family declaration,
   * never by a concrete action adapter id.
   */
  readonly livePoolState?: {
    readonly kind: "constant-product-v2" | "concentrated-v3" | "singleton-v4";
  };
  /**
   * Optional protocol-specific raw-transaction/oracle trigger declaration.
   * Detection remains one generic pipeline; trigger/edge semantics stay with
   * the family that owns the affected route.
   */
  readonly oracleVictim?: OracleVictimDescriptor;
  /**
   * Optional family override. Address/logicalInstanceId + edge adapter is the
   * mature default; singleton managers declare their own opaque keys here.
   */
  readonly routeIdentity?: RouteInstanceIdentityCapability;
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  /**
   * Ordinary file/factory admission policy owned by this family. Discovery
   * may replace it with discoveryIdentityResolver only after source+probe.
   */
  readonly identityPolicies: readonly IdentityResolverDescriptor[];
  /** Admission metadata for the global SEARCHER_ENABLE_PROTOCOL_EDGES switch. */
  readonly requiresProtocolEdgesFlag: boolean;
  /** Optional prepared-state/Revm lane capability; null means fail closed in that lane. */
  readonly prepared: PreparedRouteCapability | null;
  /**
   * Optional instance-admission capability shared by every route family.
   * Candidate scheduling, identity, active probing, claim arbitration and
   * projection remain one coordinator pipeline; the execution family only
   * supplies its matchers and proof.
   */
  readonly discovery?: ProtocolDiscoveryCapability;
  /**
   * Dynamic identity ships with the same family registration as discovery.
   * Address hints nominate candidates only and can never replace this resolver.
   */
  readonly discoveryIdentityResolver?: OnchainIdentityResolver;
  /** Typed, protocol-agnostic evidence rank used only for route arbitration. */
  readonly discoveryIdentityAuthority?: IdentityAuthority;

  buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
    control?: RouteEdgeBuildControl,
  ): Promise<TokenEdge[]>;
  quoteExact(ctx: ExactQuoteContext): Promise<bigint>;
  buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment>;
}

export interface SwapAdapter extends RouteLegAdapter<"swap"> {
  readonly kind: "swap";
  /**
   * This family consumes the existing factory/active-pool/file-universe
   * discovery fast path. The shared coordinator derives completeness from
   * this declaration; main never recognizes concrete adapter IDs.
   */
  readonly matureDexUniverseDiscovery?: true;
  /** Family-owned receipt/discovery/warm invalidation event contract. */
  readonly landedEvents: SwapLandedEventDeclaration;
  /** Optional family-owned landed-pool metadata/materialization contract. */
  readonly poolDiscovery?: LandedPoolMaterializationCapability;
  readonly observation: SwapObservationCapability;
  /** Family-owned victim reproduction policy; detect-only remains fail closed. */
  readonly victimModel: SwapVictimModelDeclaration;
  readonly pricingState: BlockScanStateCapability;
}

export type DeclaredProtocolVenue = Readonly<
  Omit<PoolEntry, "score"> & {
    /** Static protocol venues are code-owned and never consume the scored pool budget. */
    readonly score?: never;
    /** Preserve pre-registry graph order during migration; new venues append when omitted. */
    readonly graphOrder?: number;
  }
>;

export interface ProtocolConversionAdapter extends RouteLegAdapter<"protocol-conversion"> {
  readonly kind: "protocol-conversion";
  readonly pricingState: BlockScanStateCapability;
  readonly declaredVenues: readonly DeclaredProtocolVenue[];
  /** Required only for families whose instances must come from discovery/probe admission. */
  readonly undeclaredVenueReason: string | null;
}

export type DiscoverableRouteLegAdapter = RouteLegAdapter & Required<
  Pick<
    RouteLegAdapter,
    "discovery" | "discoveryIdentityResolver" | "discoveryIdentityAuthority"
  >
>;

export interface CreditAdapterFamily extends RouteLegAdapter<"credit"> {
  readonly kind: "credit";
  /**
   * Credit actions may include non-edge lifecycle actions (for example an
   * in-transaction liquidation) that share the same accounting/position
   * policy as the route-producing action.
   */
  readonly creditActionAdapterIds: readonly string[];
  /** Solver/accounting policy owned by the credit execution family. */
  readonly creditPolicy: {
    /** Candidate debt ratios used by the generic sizing engine. */
    readonly debtBpsCandidates: readonly bigint[];
    /**
     * Family-owned sizing semantics for a candidate debt ratio. The generic
     * amount propagator must never recognize a concrete credit adapter ID.
     */
    quoteOutputByDebtBps(amountIn: bigint, debtBps: bigint): bigint;
    /** A credit leg before a victim-impact reversal cannot be inverted safely. */
    readonly blocksPrefixInversion: boolean;
  };
}

export interface LiquidityAdapterFamily extends RouteLegAdapter<"liquidity"> {
  readonly kind: "liquidity";
}

export interface FlashLoanAdapterFamily extends AdapterFamilyBase<"flash-loan"> {
  readonly kind: "flash-loan";
  readonly funding: RegisteredFundingFamily;
}

export type AdapterFamily =
  | SwapAdapter
  | ProtocolConversionAdapter
  | FlashLoanAdapterFamily
  | CreditAdapterFamily
  | LiquidityAdapterFamily;
