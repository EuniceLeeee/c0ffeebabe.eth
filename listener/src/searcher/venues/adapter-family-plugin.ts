import type { PlanFragment } from "./route-leg-adapter.js";
import { ethers } from "ethers";
import type { RouteVenueMid } from "./mid-readers.js";
import type { AllowedTaxonomy } from "./route-leg-adapter.js";
import {
  type FamilyId,
  type InstanceKey,
  type LineageId,
  type RouteKey,
} from "./adapter-family-identifiers.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
  RequestProgram,
  RequestRequirements,
  StaticEvidenceProgram,
} from "./adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./canonical-value.js";
import {
  assertBoundFamilyOwnedAction,
  type FamilyOwnedActionAdapter,
} from "./family-owned-action.js";

export type { FamilyOwnedActionAdapter } from "./family-owned-action.js";

export type DiscoverySourceKind =
  | "factory-log"
  | "landed-log"
  | "observed-call"
  | "address-surface"
  | "canonical-registry";

export type Hex4 = `0x${string}`;
export type Hex32 = `0x${string}`;

export interface AbiArgumentProjection {
  readonly index: number;
  readonly type: string;
  readonly name: string;
}

export interface CallPattern {
  readonly id: string;
  readonly selector: Hex4;
  readonly signature: string;
  readonly candidateAddress:
    | { readonly from: "call-target" }
    | { readonly from: "argument"; readonly index: number };
  readonly argumentProjection?: readonly AbiArgumentProjection[];
}

export interface LogPattern {
  readonly id: string;
  readonly topic: Hex32;
  readonly signature: string;
  /**
   * How a logical instance is recovered when logs are emitted by shared
   * infrastructure instead of the instance address itself. Infrastructure
   * singleton addresses are identity sources; they are not instance
   * allowlists.
   */
  readonly emitter?:
    | { readonly mode: "address" }
    | {
        readonly mode:
          | "singleton-indexed-address"
          | "singleton-indexed-bytes32";
        readonly address: string;
        readonly topicIndex: number;
        readonly fromBlock: number;
      };
}

export interface AddressSurfacePattern {
  readonly id: string;
  readonly kind: "code-hash" | "interface" | "proxy-implementation";
  readonly fingerprint: string;
}

export type UnifiedObservation =
  | {
      readonly kind: "call";
      readonly source: CanonicalSource;
      readonly target: string;
      readonly sender?: string;
      readonly data: string;
      readonly transactionHash?: string;
    }
  | {
      readonly kind: "log";
      readonly source: CanonicalSource;
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }
  | {
      readonly kind: "address-surface";
      readonly source: CanonicalSource;
      readonly address: string;
      readonly codeHash: string;
      readonly implementationWord: string;
      readonly interfaceFingerprints?: readonly string[];
      /**
       * Plugin-owned opaque payload (e.g. a cache-backed behavior-probe
       * sample). The framework never interprets it; the owning plugin's
       * decodeCandidate does. Without it the observation is still a valid
       * address surface for interface/proxy Families.
       */
      readonly opaque?: CanonicalValue;
    }
  | {
      /**
       * Projected factory-log incumbent surface: a pool admitted by a
       * factory bootstrap event. Carries the factory address, a canonical
       * pool-key projection, the last factory-log confirmation block, and
       * the raw bootstrap log (topic + topics + data) so catalog matching
       * and Family decodeCandidate can re-verify the admission.
       */
      readonly kind: "factory-log";
      readonly source: CanonicalSource;
      readonly factory: string;
      readonly poolKeyProjection: string;
      readonly lastFactoryLogBlock: number;
      readonly topic: Hex32;
      readonly topics: readonly string[];
      readonly data: string;
    };

/**
 * The only descriptor visible to central capture code. `opaqueBinding` is
 * interpreted synchronously by the owning plugin; the framework must never
 * branch on its fields or assign protocol meaning to it.
 */
export interface FamilyCaptureDescriptor {
  readonly familyId: FamilyId;
  readonly candidateIdentity: string;
  readonly source: CanonicalSource;
  readonly opaqueBinding: CanonicalValue;
}

export type CaptureObservationIntent =
  | {
      /**
       * A source-bound observation restored from the catalog-owned durable
       * inventory. The owning plugin validates that it matches one of its
       * declarations before the central executor is allowed to use it.
       */
      readonly kind: "provided-observation";
      readonly patternId: string;
      readonly observation: UnifiedObservation;
    }
  | {
      readonly kind: "address-surface";
      readonly patternId: string;
      readonly address: string;
      readonly interfaceFingerprints: readonly string[];
    }
  | {
      readonly kind: "declared-log";
      readonly patternId: string;
      readonly candidateIdentity: string;
    }
  | {
      readonly kind: "observed-call";
      readonly patternId: string;
      readonly transactionHash: string;
      readonly traceAddress: readonly number[];
    }
  | {
      readonly kind: "observed-log";
      readonly patternId: string;
      readonly transactionHash: string;
      readonly logIndex: number;
    };

export interface RouteCaptureVector {
  readonly kind: "route";
  readonly observations: readonly CaptureObservationIntent[];
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

export interface FundingCaptureVector {
  readonly kind: "funding";
  readonly assets: readonly string[];
  readonly amount: bigint;
  readonly minProfit: bigint;
}

export interface CreditCaptureVector {
  readonly kind: "credit";
  readonly observations: readonly CaptureObservationIntent[];
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly minAmountOut: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

export type FamilyCaptureVector =
  | RouteCaptureVector
  | FundingCaptureVector
  | CreditCaptureVector;

export interface CaptureMaterializationSemantics {
  materialize(descriptor: FamilyCaptureDescriptor): FamilyCaptureVector;
}

export interface CaptureNominationInput {
  readonly address: string;
  readonly opaque: CanonicalValue;
}

export interface CaptureNominationProvider {
  call(
    transaction: { readonly to: string; readonly data: string },
    blockTag?: number,
  ): Promise<string>;
  getCode(address: string, blockTag?: number): Promise<string>;
  getStorage(
    address: string,
    slot: string,
    blockTag?: number,
  ): Promise<string>;
  getLogs(filter: {
    readonly address?: string;
    readonly fromBlock?: number;
    readonly toBlock?: number;
    readonly topics?: readonly (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
  /**
   * Re-reads the real transaction receipt for a tx-bound nomination. The
   * plugin matches its declared log patterns against the receipt logs.
   */
  getTransactionReceipt(transactionHash: string): Promise<{
    readonly blockNumber?: number;
    readonly logs: readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[];
  } | null>;
  /**
   * Optional transaction trace for tx-bound nominations (e.g. recovering a
   * real calldata frame from a recent log's transaction). Unavailable
   * implementations reject; the plugin then keeps the candidate unresolved
   * instead of fabricating evidence.
   */
  traceTransaction?(transactionHash: string): Promise<unknown>;
}

export interface CaptureNominationSemantics {
  nominate(input: {
    readonly nominations: readonly CaptureNominationInput[];
    readonly source: CanonicalSource;
    readonly provider: CaptureNominationProvider;
  }): Promise<readonly UnifiedObservation[]>;
}

export interface FamilyCandidate {
  readonly candidateKind: string;
}

export type DiscoveryEvidenceChannel =
  | "nominate"
  | "tx-evidence";

export interface DiscoverySemantics<Candidate extends FamilyCandidate> {
  readonly sources: readonly DiscoverySourceKind[];
  readonly callPatterns?: readonly CallPattern[];
  readonly logPatterns?: readonly LogPattern[];
  readonly addressSurfaces?: readonly AddressSurfacePattern[];
  /**
   * Required evidence channel declaration. Every route/protocol/credit
   * Family must state how the strict side re-derives its own admission
   * evidence: "nominate" means the plugin owns a nomination capability that
   * re-materializes real observations from opaque pool nominations;
   * "tx-evidence" means the Family admits only from real observed
   * transactions (verified txHash nominations whose receipts/traces the
   * strict side re-reads). A Family with neither is rejected at definition
   * time, so a missing interface can never silently pass as "unresolved".
   * Legacy caches only nominate candidates; they never supply evidence.
   */
  readonly evidenceChannel: DiscoveryEvidenceChannel;
  readonly nominate?: CaptureNominationSemantics;
  decodeCandidate(input: {
    readonly observation: UnifiedObservation;
    readonly matchedPatternId: string;
  }): Candidate | null;
  candidateKey(candidate: Candidate): string;
}

export interface IdentityProvenance {
  readonly kind: string;
  readonly subject: string;
  readonly evidenceHash?: string;
}

export interface VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly subject: string;
  readonly provenance: readonly IdentityProvenance[];
}

export type IdentityVariantKind =
  | "factory-child"
  | "registry-member"
  | "standalone-contract"
  | "singleton-subinstance"
  | "custom";

export interface IdentityStepInput<
  Candidate extends FamilyCandidate,
  Evidence,
> {
  readonly candidate: Candidate;
  readonly evidence?: Evidence;
  readonly step: number;
}

export type IdentityRejectReason = string;

export type IdentityDecision<Identity extends VerifiedIdentity> =
  | { readonly status: "continue" }
  | { readonly status: "verified"; readonly identity: Identity }
  | { readonly status: "rejected"; readonly reason: IdentityRejectReason };

export interface IdentityVariant<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Evidence = unknown,
> {
  readonly id: string;
  readonly kind: IdentityVariantKind;
  /** Explicitly binds the variant to the manifest lineage set. */
  readonly lineageId: LineageId;
  applies(candidate: Candidate): boolean;
  requirements(input: IdentityStepInput<Candidate, Evidence>): RequestRequirements;
  buildRequests(
    input: IdentityStepInput<Candidate, Evidence>,
  ): readonly AdapterRequest[];
  decode(input: {
    readonly step: IdentityStepInput<Candidate, Evidence>;
    readonly results: readonly AdapterRequestResult[];
  }): Evidence;
  decide(
    input: IdentityStepInput<Candidate, Evidence>,
  ): IdentityDecision<Identity>;
}

export interface IdentitySemantics<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
> {
  readonly variants: readonly IdentityVariant<Candidate, Identity, unknown>[];
  identityKey(identity: Identity): string;
}

export type RuntimeRequirement =
  | {
      readonly kind: "source-state";
      readonly freshness: "pinned-block" | "current-head" | "tx-bound";
    }
  | {
      readonly kind: "execution-actor";
      readonly role: "executor" | "observed-sender" | "verified-actor";
    }
  | {
      readonly kind: "head-evidence";
      readonly scope: "family" | "instance";
      readonly evidenceKind: string;
    }
  | {
      readonly kind: "quote-completion";
      readonly mode: "return-data" | "return-or-revert-data" | "effect-delta";
    }
  | {
      readonly kind: "effect-observation";
      readonly effects: readonly (
        | "token-delta"
        | "native-delta"
        | "total-supply-delta"
        | "logs"
        | "trace"
      )[];
    }
  | {
      readonly kind: "extension-policy";
      readonly mode:
        | "proven-transparent"
        | "quote-and-final-sim"
        | "tx-bound"
        | "simulation-only";
      readonly extensionBinding: string;
    }
  | {
      readonly kind: "oracle-state";
      readonly oracleBinding: string;
      readonly maxSourceLagBlocks: number;
    }
  | {
      readonly kind: "opaque-payload";
      readonly slot: string;
      readonly evidenceKind: string;
    };

export interface RuntimeEvidence {
  readonly evidenceId: string;
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly kind: string;
  readonly scope: "source-block" | "head" | "transaction";
  readonly source: CanonicalSource;
  readonly txHash?: string;
  readonly evidenceHash: string;
  readonly sealedPayloadRef: string;
}

export interface FamilySharedBindingRef {
  readonly familyId: FamilyId;
  readonly bindingKind: string;
  readonly bindingKey: string;
  readonly fingerprint: string;
}

export interface SharedBindingRequestKey {
  readonly bindingKind: string;
  readonly bindingKey: string;
}

export interface SharedBindingSemantics<Descriptor> {
  references(descriptor: Descriptor): readonly SharedBindingRequestKey[];
  readonly program: RequestProgram<SharedBindingRequestKey, unknown>;
  canonicalProjection(input: unknown): CanonicalValue;
}

export interface CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly provenance: readonly IdentityProvenance[];
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface InstanceSemantics<
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Draft extends object = Descriptor,
  StaticEvidence = unknown,
> {
  instanceKey(identity: Identity): InstanceKey;
  compileDraft(identity: Identity): Draft;
  readonly staticEvidence?: StaticEvidenceProgram<Draft, StaticEvidence>;
  finalizeDescriptor(input: {
    readonly identity: Identity;
    readonly draft: Draft;
    readonly staticEvidence?: StaticEvidence;
    readonly sharedBindings: readonly FamilySharedBindingRef[];
  }): Descriptor;
  staticBindingProjection(descriptor: Descriptor): CanonicalValue;
}

export interface RouteBindingRef {
  readonly bindingKey: string;
  readonly fingerprint: string;
}

export interface FamilyRouteDescriptor {
  readonly routeKey: RouteKey;
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly taxonomy: AllowedTaxonomy;
  readonly bindingRef: RouteBindingRef;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface FamilyGraphProjection {
  /** Family-owned root ActionAdapter for this route. */
  readonly routeActionAdapterId: string;
  /** Actual call/settlement target, which may differ from identity subject. */
  readonly executionTarget: string;
  /** Stable venue identity without leaking protocol fields into TokenEdge. */
  readonly venueIdentity: CanonicalValue;
  /** Identifies a central score/ranking row; the Family never supplies score. */
  readonly centralScoreKey?: string;
}

export interface RouteProjectionSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  project(input: { readonly descriptor: Descriptor }): readonly Route[];
  projectGraph(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
  }): FamilyGraphProjection;
}

export interface CurrentPricingInput<PricingDescriptor, Route> {
  readonly descriptor: PricingDescriptor;
  readonly routes: readonly Route[];
  readonly source: CanonicalSource;
}

export interface BoundRequestProgram<Evidence> {
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
  decode(results: readonly AdapterRequestResult[]): Evidence;
}

export interface RequestRoundEvidence {
  readonly results: readonly AdapterRequestResult[];
}

export function bindRequestResultRound(
  requirements: RequestRequirements,
  requests: readonly AdapterRequest[],
): BoundRequestProgram<RequestRoundEvidence> {
  return Object.freeze({
    requirements: Object.freeze({ ...requirements }),
    requests: Object.freeze([...requests]),
    decode(results: readonly AdapterRequestResult[]): RequestRoundEvidence {
      return Object.freeze({ results: Object.freeze([...results]) });
    },
  });
}

export function collectRequestProgramResults(
  initialResults: readonly AdapterRequestResult[],
  dependentEvidence: readonly unknown[],
): readonly AdapterRequestResult[] {
  const output = [...initialResults];
  for (const evidence of dependentEvidence) {
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      !("results" in evidence) ||
      !Array.isArray((evidence as { readonly results?: unknown }).results)
    ) {
      throw new Error("dependent request round returned invalid evidence");
    }
    output.push(...(
      evidence as { readonly results: readonly AdapterRequestResult[] }
    ).results);
  }
  return Object.freeze(output);
}

export interface DependentRequestProgram<Input, Evidence> {
  requirements(input: Input): RequestRequirements;
  buildRequests(input: Input): readonly AdapterRequest[];
  buildDependentProgram?(input: {
    readonly programInput: Input;
    readonly completedRound: number;
    readonly initialResults: readonly AdapterRequestResult[];
    readonly priorEvidence: readonly unknown[];
  }): BoundRequestProgram<unknown> | null;
  decode(input: {
    readonly programInput: Input;
    readonly initialResults: readonly AdapterRequestResult[];
    readonly dependentEvidence: readonly unknown[];
  }): Evidence;
}

export interface MutationSemantics<PricingDescriptor, Route> {
  affectedStateKeys(input: {
    readonly descriptor: PricingDescriptor;
    readonly routes: readonly Route[];
    readonly observation: UnifiedObservation;
  }): readonly string[];
}

export interface LiveStateProjection<PricingDescriptor, Snapshot> {
  project(input: {
    readonly descriptor: PricingDescriptor;
    readonly snapshot: Snapshot;
  }): CanonicalValue;
}

export interface PricingSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor extends object,
  Snapshot extends object,
  Draft extends object = PricingDescriptor,
  StaticEvidence = unknown,
> {
  stateKey(route: Route): string;
  staticBindingProjection(input: {
    readonly descriptor: Descriptor;
    readonly routes: readonly Route[];
  }): CanonicalValue;
  snapshotCompatibilityProjection(input: {
    readonly descriptor: Descriptor;
    readonly routes: readonly Route[];
  }): CanonicalValue;
  compileDraft(input: {
    readonly descriptor: Descriptor;
    readonly stateKey: string;
    readonly routes: readonly Route[];
  }): Draft;
  readonly staticEvidence?: StaticEvidenceProgram<Draft, StaticEvidence>;
  finalizePricingDescriptor(input: {
    readonly draft: Draft;
    readonly staticEvidence?: StaticEvidence;
    readonly sharedBindings: readonly FamilySharedBindingRef[];
  }): PricingDescriptor;
  readonly current: {
    requirements(
      input: CurrentPricingInput<PricingDescriptor, Route>,
    ): RequestRequirements;
    buildRequests(
      input: CurrentPricingInput<PricingDescriptor, Route>,
    ): readonly AdapterRequest[];
    buildDependentProgram?(input: {
      readonly current: CurrentPricingInput<PricingDescriptor, Route>;
      readonly completedRound: number;
      readonly initialResults: readonly AdapterRequestResult[];
      readonly priorEvidence: readonly unknown[];
    }): BoundRequestProgram<unknown> | null;
    decodeSnapshot(input: {
      readonly descriptor: PricingDescriptor;
      readonly initialResults: readonly AdapterRequestResult[];
      readonly dependentEvidence: readonly unknown[];
    }): Snapshot;
    deriveMids(input: {
      readonly descriptor: PricingDescriptor;
      readonly snapshot: Snapshot;
      readonly routes: readonly Route[];
    }): ReadonlyMap<RouteKey, RouteVenueMid>;
    classifyUnavailable?(input: {
      readonly descriptor: PricingDescriptor;
      readonly snapshot: Snapshot;
      readonly routes: readonly Route[];
    }): ReadonlyMap<RouteKey, string>;
  };
  dependencies(input: {
    readonly descriptor: PricingDescriptor;
    readonly routes: readonly Route[];
  }): readonly string[];
  readonly mutation?: MutationSemantics<PricingDescriptor, Route>;
  readonly liveStateProjection?: LiveStateProjection<PricingDescriptor, Snapshot>;
}

export interface ExactQuoteInput<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  readonly descriptor: Descriptor;
  readonly route: Route;
  readonly amountIn: bigint;
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

export interface ExactQuoteResult<Evidence> {
  readonly amountOut: bigint;
  readonly evidence: Evidence;
}

export type LocalExactAttempt<Evidence> =
  | {
      readonly status: "quoted";
      readonly result: ExactQuoteResult<Evidence>;
    }
  | {
      readonly status: "not-applicable";
      readonly reason: string;
    };

export type ExactMethod<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
> =
  | {
      readonly id: string;
      readonly kind: "local";
      quote(
        input: ExactQuoteInput<Descriptor, Route>,
      ): LocalExactAttempt<Evidence>;
    }
  | {
      readonly id: string;
      readonly kind: "request-program";
      readonly program: DependentRequestProgram<
        ExactQuoteInput<Descriptor, Route>,
        ExactQuoteResult<Evidence>
      >;
    };

export type ExactRequestProgram<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
> = DependentRequestProgram<
  ExactQuoteInput<Descriptor, Route>,
  ExactQuoteResult<Evidence>
>;

export function localZeroExactMethod<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
>(
  id: string,
  quote: (
    input: ExactQuoteInput<Descriptor, Route>,
  ) => ExactQuoteResult<Evidence>,
): ExactMethod<Descriptor, Route, Evidence> {
  return Object.freeze({
    id,
    kind: "local" as const,
    quote(input: ExactQuoteInput<Descriptor, Route>): LocalExactAttempt<Evidence> {
      if (input.amountIn !== 0n) {
        return Object.freeze({
          status: "not-applicable" as const,
          reason: "positive input requires the next exact method",
        });
      }
      return Object.freeze({
        status: "quoted" as const,
        result: quote(input),
      });
    },
  });
}

export interface ExactQuoteSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
> {
  methods(
    input: ExactQuoteInput<Descriptor, Route>,
  ): readonly ExactMethod<Descriptor, Route, Evidence>[];
  cacheCompatibilityProjection(
    input: ExactQuoteInput<Descriptor, Route>,
  ): CanonicalValue;
}

export interface ExecutionEffectInput<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  readonly descriptor: Descriptor;
  readonly route: Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
}

export type ExpectedEffect =
  | {
      readonly kind: "token-delta";
      readonly token: string;
      readonly account: "executor" | "route-target";
      readonly direction: "increase" | "decrease";
    }
  | {
      readonly kind: "native-delta";
      readonly account: "executor" | "route-target";
      readonly direction: "increase" | "decrease";
    }
  | {
      readonly kind: "total-supply-delta";
      readonly token: string;
      readonly direction: "increase" | "decrease";
    };

export interface ExecutionRuntimeHop {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface ExecutionPrewarmCall {
  readonly from: string;
  /** Empty means the central runtime binds the current hop target. */
  readonly to: string;
  readonly calldata: string;
  readonly gasLimit: number;
}

/**
 * Plugin-owned execution facts consumed before a concrete exact result exists.
 * The central runtime treats this as opaque projection data: it neither knows
 * the protocol nor compares adapter/family ids. Infrastructure singleton
 * addresses are permitted here, but instance admission remains an identity
 * capability and can never be granted by this projection.
 */
export interface ExecutionRuntimeProjection {
  readonly allowanceSpender: string | null;
  readonly prewarmQuoteCalls: readonly ExecutionPrewarmCall[];
}

export const NO_EXECUTION_RUNTIME_PROJECTION: ExecutionRuntimeProjection =
  Object.freeze({
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  });

export function hopTargetExecutionRuntimeProjection(input: {
  readonly hop: ExecutionRuntimeHop;
}): ExecutionRuntimeProjection {
  return Object.freeze({
    allowanceSpender: input.hop.target,
    prewarmQuoteCalls: Object.freeze([]),
  });
}

export interface ExecutionSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  ExactEvidence,
> {
  runtimeProjection(input: {
    readonly hop: ExecutionRuntimeHop;
  }): ExecutionRuntimeProjection;
  buildFragment(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly amountIn: bigint;
    readonly quotedAmountOut: bigint;
    readonly minAmountOut: bigint;
    readonly exactEvidence: ExactEvidence;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
  }): PlanFragment;
  expectedEffects(
    input: ExecutionEffectInput<Descriptor, Route>,
  ): readonly ExpectedEffect[];
}

export interface RuntimeEvidenceProgramInput<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  readonly descriptor: Descriptor;
  readonly route?: Route;
  readonly source: CanonicalSource;
}

export interface OptionalFamilySemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  readonly pendingEvidence?: RequestProgram<
    RuntimeEvidenceProgramInput<Descriptor, Route>,
    RuntimeEvidence
  >;
  readonly preparedQuote?: RequestProgram<
    ExactQuoteInput<Descriptor, Route>,
    ExactQuoteResult<unknown>
  >;
}

export type FamilyDomain = "swap" | "protocol" | "funding" | "credit";

/**
 * Deliberate extension boundary: the frozen inventory has no active liquidity
 * Family. There is therefore no defineLiquidityFamily constructor until a
 * separate share/accounting/position policy is specified and hashed.
 */
export const RESERVED_FAMILY_DOMAINS = Object.freeze(["liquidity"] as const);
export type ReservedFamilyDomain = (typeof RESERVED_FAMILY_DOMAINS)[number];

export interface FamilyManifest<Domain extends FamilyDomain> {
  readonly familyId: FamilyId;
  readonly domain: Domain;
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  readonly supportedLineages: readonly LineageId[];
  /**
   * Plugin-owned legacy universe pool-adapter labels (e.g. "univ2",
   * "erc4626"). These are provenance labels consumed by the file-backed
   * pool universe and universe deploy trust; they are never an admission
   * gate — identity/lineage remains the authority. The central pipeline
   * only reads this declaration through the generated catalog projection;
   * it never hardcodes a family-specific label table.
   */
  readonly poolAdapterIds?: readonly string[];
}

export interface LandedEventSpec {
  readonly patternIds: readonly string[];
  classify(input: {
    readonly observation: UnifiedObservation;
  }): "swap" | "mutation" | null;
}

export interface SwapObservedEffect {
  readonly kind: "swap" | "mutation";
  readonly canonicalPayload: CanonicalValue;
}

export interface SwapObservationSpec {
  readonly patternIds: readonly string[];
  decode(input: {
    readonly observation: UnifiedObservation;
  }): readonly SwapObservedEffect[];
}

export interface PoolMaterializationSpec {
  readonly patternIds: readonly string[];
  candidateBinding(input: {
    readonly observation: UnifiedObservation;
  }): CanonicalValue | null;
}

export interface LocalVictimApplySpec {
  apply(input: {
    readonly preState: CanonicalValue;
    readonly observation: UnifiedObservation;
  }): CanonicalValue | null;
}

export interface VictimOverlaySpec {
  build(input: {
    readonly observation: UnifiedObservation;
  }): CanonicalValue | null;
}

/**
 * Central observation code normalizes a swap victim before a Family replay is
 * attempted. Protocol-specific post-state facts remain opaque canonical data
 * until the owning Family validates them against its descriptor.
 */
export interface NormalizedSwapVictimImpact {
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut?: bigint;
  readonly exactPostState?: CanonicalValue;
}

export interface VictimReplayLocalResult {
  readonly postImpact: CanonicalValue;
  readonly amountOut: bigint;
}

export interface VictimReplayOverlayTokenDeal {
  readonly token: string;
  readonly to: string;
  readonly amount: string;
  readonly balanceSlot?: number;
}

export interface VictimReplayOverlayCall {
  readonly from: string;
  readonly to: string;
  readonly calldata: string;
  readonly gasLimit?: number;
  readonly allowanceSlot?: number;
}

/** Pure state-override/call intent. The Family never executes these calls. */
export interface VictimReplayOverlayIntent {
  readonly whale: string;
  readonly tokenDeals: readonly VictimReplayOverlayTokenDeal[];
  readonly preCalls: readonly VictimReplayOverlayCall[];
}

/**
 * Full victim replay is one coherent capability: the Family binds a
 * normalized impact to one of its prepared routes, derives an optional local
 * and exact post-state, and constructs a pure overlay intent. Wall-clock time,
 * I/O and execution remain central concerns.
 */
export interface VictimReplaySpec<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  bind(input: {
    readonly descriptor: Descriptor;
    readonly routes: readonly Route[];
    readonly impact: NormalizedSwapVictimImpact;
  }): Route | null;
  applyLocal(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly preState: CanonicalValue;
    readonly impact: NormalizedSwapVictimImpact;
    readonly source: CanonicalSource;
  }): VictimReplayLocalResult | null;
  exactPostState?(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly impact: NormalizedSwapVictimImpact;
    readonly source: CanonicalSource;
  }): CanonicalValue | null;
  buildOverlay(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly impact: NormalizedSwapVictimImpact;
    readonly source: CanonicalSource;
    /** Central deterministic transaction validity, expressed in Unix seconds. */
    readonly validUntil: bigint;
  }): VictimReplayOverlayIntent | null;
}

export interface OracleVictimSpec {
  readonly callPatterns: readonly CallPattern[];
  decode(input: {
    readonly observation: UnifiedObservation;
  }): CanonicalValue | null;
}

export interface SwapDomainSemantics<
  Descriptor extends CompiledInstanceDescriptor = CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor = FamilyRouteDescriptor,
> {
  readonly landedEvents: LandedEventSpec;
  readonly observation: SwapObservationSpec;
  readonly victimSupport:
    | "none"
    | "detect-only"
    | "local-apply"
    | "overlay"
    | "replay";
  readonly poolMaterialization?: PoolMaterializationSpec;
  readonly localApply?: LocalVictimApplySpec;
  readonly overlay?: VictimOverlaySpec;
  readonly replay?: VictimReplaySpec<Descriptor, Route>;
}

export type ProtocolCandidateKind =
  | "observed-call"
  | "address-surface"
  | "factory-child"
  | "registry-member"
  | "standalone-contract";

export interface ProtocolDomainSemantics {
  readonly candidateKinds: readonly ProtocolCandidateKind[];
  readonly activeBehaviorProof: "required";
  readonly oracleVictim?: OracleVictimSpec;
}

/**
 * Funding is not a graph route. It publishes source-bound liquidity offers
 * and contributes the borrow/repayment envelope around a centrally assembled
 * plan. Keeping this shape separate prevents a flash provider from inventing
 * token routes, mids or an exact quote merely to enter the catalog.
 */
export interface FundingSourceDescriptor {
  readonly fundingId: string;
  readonly instanceKey: string;
  readonly provider: string;
  readonly stateKey: string;
  readonly asset: string;
  readonly requiredReadKeys: readonly string[];
}

export interface FundingOfferDescriptor {
  readonly fundingId: string;
  readonly asset: string;
  readonly maxBorrow: bigint;
  readonly fee: bigint;
  readonly actionAdapterId: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
}

export interface FundingLiquidityProgramInput<
  Source extends FundingSourceDescriptor,
> {
  readonly assets: readonly string[];
  readonly sources: readonly Source[];
  readonly source: CanonicalSource;
}

export interface FundingLiquiditySemantics<
  Source extends FundingSourceDescriptor,
  Evidence,
> {
  sources(assets: readonly string[]): readonly Source[];
  readonly program: RequestProgram<
    FundingLiquidityProgramInput<Source>,
    Evidence
  >;
  deriveOffers(input: {
    readonly evidence: Evidence;
    readonly sources: readonly Source[];
  }): readonly FundingOfferDescriptor[];
}

export interface FundingBorrowBuildInput {
  readonly offer: FundingOfferDescriptor;
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly children: readonly PlanFragment[];
}

export interface FundingRepaymentSemantics {
  readonly target: string;
  readonly liquidityHolder: string;
  readonly mode: "approve-pull" | "transfer";
  readonly paramShape: "none" | "tokens-and-amounts";
  buildBorrowFragment(input: FundingBorrowBuildInput): PlanFragment;
  buildRepaymentFragment(input: {
    readonly offer: FundingOfferDescriptor;
    readonly amount: bigint;
  }): PlanFragment;
}

export interface FundingDomainSemantics<
  Source extends FundingSourceDescriptor = FundingSourceDescriptor,
  Evidence = unknown,
> {
  readonly liquidity: FundingLiquiditySemantics<Source, Evidence>;
  readonly repayment: FundingRepaymentSemantics;
}

export interface CreditRiskProgramInput<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  readonly descriptor: Descriptor;
  readonly route: Route;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

export interface CreditPositionSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
> {
  /** Credit routes always create a position until final simulation proves closure. */
  readonly lifecycle: "standing-position";
  readonly finalSafety: "position-and-repayment-required";
  positionKey(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
  }): string;
}

export interface CreditRiskSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
> {
  readonly debtBpsCandidates: readonly bigint[];
  readonly blocksPrefixInversion: true;
  readonly evidence?: RequestProgram<
    CreditRiskProgramInput<Descriptor, Route>,
    Evidence
  >;
  quoteOutputByDebtBps(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly collateralAmount: bigint;
    readonly debtBps: bigint;
    readonly evidence?: Evidence;
  }): bigint;
}

export interface CreditDomainSemantics<
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  Evidence,
> {
  readonly activeBehaviorProof: "required";
  readonly position: CreditPositionSemantics<Descriptor, Route>;
  readonly risk: CreditRiskSemantics<Descriptor, Route, Evidence>;
}

/**
 * Capability applicability table: the single source of truth deciding which
 * plugin slots each Family domain requires, allows, or forbids. Every
 * per-domain plugin shape below is a projection of MasterTemplate through
 * this table - the framework never hardcodes a per-family branch.
 */
export type FamilyCapabilityRequirement = "required" | "optional" | "never";

export const FAMILY_CAPABILITY_APPLICABILITY = Object.freeze({
  swap: Object.freeze({
    manifest: "required",
    capture: "optional",
    discovery: "required",
    identity: "required",
    instance: "required",
    routes: "required",
    pricing: "required",
    exact: "required",
    execution: "required",
    sharedBindings: "optional",
    optional: "optional",
    actionAdapters: "required",
    swap: "required",
    protocol: "never",
    credit: "never",
    funding: "never",
  }),
  protocol: Object.freeze({
    manifest: "required",
    capture: "optional",
    discovery: "required",
    identity: "required",
    instance: "required",
    routes: "required",
    pricing: "required",
    exact: "required",
    execution: "required",
    sharedBindings: "optional",
    optional: "optional",
    actionAdapters: "required",
    swap: "never",
    protocol: "required",
    credit: "never",
    funding: "never",
  }),
  credit: Object.freeze({
    manifest: "required",
    capture: "optional",
    discovery: "required",
    identity: "required",
    instance: "required",
    routes: "required",
    pricing: "optional",
    exact: "optional",
    execution: "required",
    sharedBindings: "never",
    optional: "never",
    actionAdapters: "required",
    swap: "never",
    protocol: "never",
    credit: "required",
    funding: "never",
  }),
  funding: Object.freeze({
    manifest: "required",
    capture: "optional",
    discovery: "never",
    identity: "never",
    instance: "never",
    routes: "never",
    pricing: "never",
    exact: "never",
    execution: "never",
    sharedBindings: "never",
    optional: "never",
    actionAdapters: "required",
    swap: "never",
    protocol: "never",
    credit: "never",
    funding: "required",
  }),
} as const satisfies Readonly<Record<FamilyDomain, Readonly<Record<FamilyCapabilityKey, FamilyCapabilityRequirement>>>>);

export type FamilyCapabilityKey =
  | "manifest" | "capture" | "discovery" | "identity" | "instance"
  | "routes" | "pricing" | "exact" | "execution"
  | "sharedBindings" | "optional" | "actionAdapters"
  | "swap" | "protocol" | "credit" | "funding";

export type FamilyCapabilityApplicability = Readonly<
  Record<FamilyDomain, Readonly<Record<FamilyCapabilityKey, FamilyCapabilityRequirement>>>
>;

/** Literal lookup of one domain/key requirement from the table. */
type FamilyCapabilityRequirementFor<
  Domain extends FamilyDomain,
  Key extends FamilyCapabilityKey,
> = Domain extends "swap"
  ? (typeof FAMILY_CAPABILITY_APPLICABILITY)["swap"][Key]
  : Domain extends "protocol"
  ? (typeof FAMILY_CAPABILITY_APPLICABILITY)["protocol"][Key]
  : Domain extends "credit"
  ? (typeof FAMILY_CAPABILITY_APPLICABILITY)["credit"][Key]
  : (typeof FAMILY_CAPABILITY_APPLICABILITY)["funding"][Key];

/** One capability slot projected through the applicability table. */
type FamilyCapabilitySlice<
  Domain extends FamilyDomain,
  Key extends FamilyCapabilityKey,
  Shape,
> = FamilyCapabilityRequirementFor<Domain, Key> extends "required"
  ? { readonly [P in Key]: Shape }
  : FamilyCapabilityRequirementFor<Domain, Key> extends "optional"
    ? { readonly [P in Key]?: Shape }
    // "never" projects to an empty shape: the key does not exist on the
    // plugin type, so "key" in plugin narrows correctly and excess-key
    // checks reject supplying it.
    : Record<never, never>;

/**
 * MasterTemplate: the single family plugin template. Every domain-specific
 * plugin shape below is a projection of this template through the capability
 * applicability table (required / optional / never), so a future domain
 * (e.g. LP) picks its slots without touching central dispatch.
 */
export type MasterTemplate<
  Domain extends FamilyDomain,
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor extends object,
  PricingSnapshot extends object,
  ExactEvidence,
  InstanceDraft extends object = Descriptor,
  PricingDraft extends object = PricingDescriptor,
  InstanceStaticEvidence = unknown,
  PricingStaticEvidence = unknown,
  Source extends FundingSourceDescriptor = FundingSourceDescriptor,
  LiquidityEvidence = unknown,
  RiskEvidence = unknown,
> =
  FamilyCapabilitySlice<Domain, "manifest", FamilyManifest<Domain>> &
  FamilyCapabilitySlice<Domain, "capture", CaptureMaterializationSemantics> &
  FamilyCapabilitySlice<Domain, "discovery", DiscoverySemantics<Candidate>> &
  FamilyCapabilitySlice<Domain, "identity", IdentitySemantics<Candidate, Identity>> &
  FamilyCapabilitySlice<Domain, "instance", InstanceSemantics<
    Identity,
    Descriptor,
    InstanceDraft,
    InstanceStaticEvidence
  >> &
  FamilyCapabilitySlice<Domain, "routes", RouteProjectionSemantics<Descriptor, Route>> &
  FamilyCapabilitySlice<Domain, "pricing", PricingSemantics<
    Descriptor,
    Route,
    PricingDescriptor,
    PricingSnapshot,
    PricingDraft,
    PricingStaticEvidence
  >> &
  FamilyCapabilitySlice<Domain, "exact", ExactQuoteSemantics<Descriptor, Route, ExactEvidence>> &
  FamilyCapabilitySlice<Domain, "execution", ExecutionSemantics<Descriptor, Route, ExactEvidence>> &
  FamilyCapabilitySlice<Domain, "sharedBindings", SharedBindingSemantics<Descriptor>> &
  FamilyCapabilitySlice<Domain, "optional", OptionalFamilySemantics<Descriptor, Route>> &
  FamilyCapabilitySlice<Domain, "actionAdapters", readonly FamilyOwnedActionAdapter[]> &
  FamilyCapabilitySlice<Domain, "swap", SwapDomainSemantics<Descriptor, Route>> &
  FamilyCapabilitySlice<Domain, "protocol", ProtocolDomainSemantics> &
  FamilyCapabilitySlice<Domain, "credit", CreditDomainSemantics<Descriptor, Route, RiskEvidence>> &
  FamilyCapabilitySlice<Domain, "funding", FundingDomainSemantics<Source, LiquidityEvidence>>;

/**
 * Swap projection: MasterTemplate<"swap"> with pricing/exact required by the
 * applicability table. Kept as a named type so production entries and the
 * thin defineSwapFamily wrapper stay unchanged.
 */
export type SwapFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor extends object,
  PricingSnapshot extends object,
  ExactEvidence,
  InstanceDraft extends object = Descriptor,
  PricingDraft extends object = PricingDescriptor,
  InstanceStaticEvidence = unknown,
  PricingStaticEvidence = unknown,
> = MasterTemplate<
  "swap",
  Candidate,
  Identity,
  Descriptor,
  Route,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
  InstanceDraft,
  PricingDraft,
  InstanceStaticEvidence,
  PricingStaticEvidence
>;

/** Protocol projection: MasterTemplate<"protocol">. */
export type ProtocolFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor extends object,
  PricingSnapshot extends object,
  ExactEvidence,
  InstanceDraft extends object = Descriptor,
  PricingDraft extends object = PricingDescriptor,
  InstanceStaticEvidence = unknown,
  PricingStaticEvidence = unknown,
> = MasterTemplate<
  "protocol",
  Candidate,
  Identity,
  Descriptor,
  Route,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
  InstanceDraft,
  PricingDraft,
  InstanceStaticEvidence,
  PricingStaticEvidence
>;

/** Credit projection: MasterTemplate<"credit"> (pricing/exact optional). */
export type CreditFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  RiskEvidence,
  InstanceDraft extends object = Descriptor,
  InstanceStaticEvidence = unknown,
> = MasterTemplate<
  "credit",
  Candidate,
  Identity,
  Descriptor,
  Route,
  object,
  object,
  RiskEvidence,
  InstanceDraft,
  object,
  InstanceStaticEvidence,
  object,
  FundingSourceDescriptor,
  unknown,
  RiskEvidence
>;

/** Funding projection: MasterTemplate<"funding"> (public slices never). */
export type FundingFamilyPlugin<
  Source extends FundingSourceDescriptor,
  LiquidityEvidence,
> = MasterTemplate<
  "funding",
  FamilyCandidate,
  VerifiedIdentity,
  CompiledInstanceDescriptor,
  FamilyRouteDescriptor,
  object,
  object,
  unknown,
  object,
  object,
  unknown,
  object,
  Source,
  LiquidityEvidence,
  unknown
>;

export type AdapterFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor extends object,
  PricingSnapshot extends object,
  ExactEvidence,
  InstanceDraft extends object = Descriptor,
  PricingDraft extends object = PricingDescriptor,
  InstanceStaticEvidence = unknown,
  PricingStaticEvidence = unknown,
> =
  | SwapFamilyPlugin<
      Candidate,
      Identity,
      Descriptor,
      Route,
      PricingDescriptor,
      PricingSnapshot,
      ExactEvidence,
      InstanceDraft,
      PricingDraft,
      InstanceStaticEvidence,
      PricingStaticEvidence
    >
  | ProtocolFamilyPlugin<
      Candidate,
      Identity,
      Descriptor,
      Route,
      PricingDescriptor,
      PricingSnapshot,
      ExactEvidence,
      InstanceDraft,
      PricingDraft,
      InstanceStaticEvidence,
      PricingStaticEvidence
    >;

export type AnyFamilyPlugin = AdapterFamilyPlugin<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * Unified plugin contract indexed by domain. Every Family - swap, protocol,
 * credit, funding, and any future domain (e.g. LP) - is defined through this
 * single discriminated type: the required/optional/prohibited capability
 * slots are decided by the domain, not by which constructor was used. The
 * concrete per-domain interfaces below remain as type aliases so existing
 * production entries keep working unchanged.
 */
export type FamilyPlugin<Domain extends FamilyDomain> =
  Domain extends "swap"
    ? AnySwapFamilyPlugin
    : Domain extends "protocol"
    ? AnyProtocolFamilyPlugin
    : Domain extends "credit"
    ? AnyCreditFamilyPlugin
    : AnyFundingFamilyPlugin;

export type AnySwapFamilyPlugin = SwapFamilyPlugin<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

export type AnyProtocolFamilyPlugin = ProtocolFamilyPlugin<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

export type AnyCreditFamilyPlugin = CreditFamilyPlugin<
  FamilyCandidate,
  VerifiedIdentity,
  CompiledInstanceDescriptor,
  FamilyRouteDescriptor,
  unknown,
  object,
  unknown
>;

export type AnyFundingFamilyPlugin = FundingFamilyPlugin<
  FundingSourceDescriptor,
  unknown
>;

export type AnyStrictFamilyPlugin =
  | AdapterFamilyPlugin<any, any, any, any, any, any, any, any, any, any, any>
  | FundingFamilyPlugin<FundingSourceDescriptor, unknown>
  | CreditFamilyPlugin<
      FamilyCandidate,
      VerifiedIdentity,
      CompiledInstanceDescriptor,
      FamilyRouteDescriptor,
      unknown,
      object,
      unknown
    >;

declare const definedFamilyPluginTypeBrand: unique symbol;

export type DefinedFamilyPlugin<Plugin> = Readonly<Plugin> & {
  readonly [definedFamilyPluginTypeBrand]: "defined-family-plugin";
};

export interface DefinedFamilyPluginContractSummary {
  readonly contractKind: "defined-family-plugin";
  readonly familyId: FamilyId;
  readonly domain: FamilyDomain;
  readonly supportedLineages: readonly LineageId[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly suppliedActionAdapterIds: readonly string[];
  readonly taxonomy: readonly string[];
  readonly definitionBoundaryHash: string;
}

export type AnyDefinedFamilyPlugin = DefinedFamilyPlugin<AnyFamilyPlugin>;
export type AnyDefinedStrictFamilyPlugin = DefinedFamilyPlugin<
  AnyStrictFamilyPlugin
>;

type FamilyPluginForDomain<Domain extends FamilyDomain> = Extract<
  AnyStrictFamilyPlugin,
  { readonly manifest: { readonly domain: Domain } }
>;

const definedFamilyPlugins = new WeakMap<
  object,
  DefinedFamilyPluginContractSummary
>();

function pluginForDomain<Domain extends FamilyDomain>(
  plugin: AnyStrictFamilyPlugin,
  domain: Domain,
): FamilyPluginForDomain<Domain> {
  if (plugin.manifest.domain !== domain) {
    throw new Error(
      `family manifest domain ${plugin.manifest.domain} does not match ${domain}`,
    );
  }
  return plugin as FamilyPluginForDomain<Domain>;
}

/**
 * Domain capability key sets derived from the single applicability table -
 * the runtime validator consumes the same table that projects the types, so
 * a domain's required/optional/never slots can never drift apart.
 */
function requiredCapabilityKeys(domain: FamilyDomain): readonly string[] {
  return Object.freeze(
    (Object.entries(FAMILY_CAPABILITY_APPLICABILITY[domain]) as
      readonly (readonly [FamilyCapabilityKey, FamilyCapabilityRequirement])[])
      .filter(([, requirement]) => requirement === "required")
      .map(([key]) => key),
  );
}

function optionalCapabilityKeys(domain: FamilyDomain): readonly string[] {
  return Object.freeze(
    (Object.entries(FAMILY_CAPABILITY_APPLICABILITY[domain]) as
      readonly (readonly [FamilyCapabilityKey, FamilyCapabilityRequirement])[])
      .filter(([, requirement]) => requirement === "optional")
      .map(([key]) => key),
  );
}

export function defineSwapFamily<
  C extends FamilyCandidate,
  I extends VerifiedIdentity,
  D extends CompiledInstanceDescriptor,
  R extends FamilyRouteDescriptor,
  PD extends object,
  PS extends object,
  E,
  ID extends object = D,
  PDR extends object = PD,
  ISE = unknown,
  PSE = unknown,
>(
  plugin: SwapFamilyPlugin<C, I, D, R, PD, PS, E, ID, PDR, ISE, PSE>,
): DefinedFamilyPlugin<
  SwapFamilyPlugin<C, I, D, R, PD, PS, E, ID, PDR, ISE, PSE>
> {
  return defineFamily(plugin);
}

export function defineProtocolFamily<
  C extends FamilyCandidate,
  I extends VerifiedIdentity,
  D extends CompiledInstanceDescriptor,
  R extends FamilyRouteDescriptor,
  PD extends object,
  PS extends object,
  E,
  ID extends object = D,
  PDR extends object = PD,
  ISE = unknown,
  PSE = unknown,
>(
  plugin: ProtocolFamilyPlugin<C, I, D, R, PD, PS, E, ID, PDR, ISE, PSE>,
): DefinedFamilyPlugin<
  ProtocolFamilyPlugin<C, I, D, R, PD, PS, E, ID, PDR, ISE, PSE>
> {
  return defineFamily(plugin);
}

export function defineFundingFamily<
  S extends FundingSourceDescriptor,
  E,
>(
  plugin: FundingFamilyPlugin<S, E>,
): DefinedFamilyPlugin<FundingFamilyPlugin<S, E>> {
  return defineFamily(plugin);
}

export function defineCreditFamily<
  C extends FamilyCandidate,
  I extends VerifiedIdentity,
  D extends CompiledInstanceDescriptor,
  R extends FamilyRouteDescriptor,
  E,
  ID extends object = D,
  ISE = unknown,
>(
  plugin: CreditFamilyPlugin<C, I, D, R, E, ID, ISE>,
): DefinedFamilyPlugin<CreditFamilyPlugin<C, I, D, R, E, ID, ISE>> {
  return defineFamily(plugin);
}

export function assertDefinedFamilyPlugin(
  value: unknown,
): asserts value is AnyDefinedStrictFamilyPlugin {
  if (value === null || typeof value !== "object") {
    throw new Error("family plugin must be an object");
  }
  const stored = definedFamilyPlugins.get(value);
  if (!stored) {
    throw new Error(
      "family plugin must come from defineSwapFamily or defineProtocolFamily " +
        "or defineFundingFamily or defineCreditFamily",
    );
  }
  if (!Object.isFrozen(value)) {
    throw new Error("defined family plugin boundary is not frozen");
  }
  const current = validateFamilyPlugin(
    value as AnyStrictFamilyPlugin,
    stored.domain,
  );
  if (current.definitionBoundaryHash !== stored.definitionBoundaryHash) {
    throw new Error("defined family plugin contract summary changed after definition");
  }
}

export function definedFamilyPluginContractSummary(
  plugin: AnyDefinedStrictFamilyPlugin,
): DefinedFamilyPluginContractSummary {
  assertDefinedFamilyPlugin(plugin);
  return definedFamilyPlugins.get(plugin)!;
}

function defineFamily<Plugin extends AnyStrictFamilyPlugin>(
  plugin: Plugin,
): DefinedFamilyPlugin<Plugin> {
  if (definedFamilyPlugins.has(plugin)) {
    throw new Error("family plugin has already been defined");
  }
  const summary = validateFamilyPlugin(plugin, plugin.manifest.domain);
  installSynchronousGuards(plugin, plugin.manifest.domain);
  deepFreezeDefinition(plugin, "plugin", new Set<object>());
  deepFreezeDefinition(summary, "contract summary", new Set<object>());
  definedFamilyPlugins.set(plugin, summary);
  return plugin as DefinedFamilyPlugin<Plugin>;
}

type SynchronousResultGuard = (
  result: unknown,
  args: readonly unknown[],
) => void;

function installSynchronousGuards(
  plugin: AnyStrictFamilyPlugin,
  domain: FamilyDomain,
): void {
  if (plugin.capture !== undefined) {
    guardSynchronousMethod(
      plugin.capture,
      "materialize",
      "capture.materialize",
      (result, args) => validateCaptureMaterializationResult(
        plugin,
        result,
        args,
      ),
    );
  }
  if (domain === "funding") {
    const fundingPlugin = pluginForDomain(plugin, "funding");
    const funding = fundingPlugin.funding;
    guardSynchronousMethod(
      funding.liquidity,
      "sources",
      "funding.liquidity.sources",
    );
    guardRequestProgram(
      funding.liquidity.program,
      "funding.liquidity.program",
    );
    guardSynchronousMethod(
      funding.liquidity,
      "deriveOffers",
      "funding.liquidity.deriveOffers",
    );
    guardSynchronousMethod(
      funding.repayment,
      "buildBorrowFragment",
      "funding.repayment.buildBorrowFragment",
    );
    guardSynchronousMethod(
      funding.repayment,
      "buildRepaymentFragment",
      "funding.repayment.buildRepaymentFragment",
    );
    for (const action of fundingPlugin.actionAdapters) {
      assertBoundFamilyOwnedAction(action);
    }
    return;
  }

  const routedPlugin = domain === "credit"
    ? pluginForDomain(plugin, "credit")
    : domain === "swap"
    ? pluginForDomain(plugin, "swap")
    : pluginForDomain(plugin, "protocol");

  guardSynchronousMethod(
    routedPlugin.discovery,
    "decodeCandidate",
    "discovery.decodeCandidate",
  );
  guardSynchronousMethod(
    routedPlugin.discovery,
    "candidateKey",
    "discovery.candidateKey",
  );
  guardSynchronousMethod(
    routedPlugin.identity,
    "identityKey",
    "identity.identityKey",
  );
  for (const variant of routedPlugin.identity.variants) {
    const label = `identity variant ${variant.id}`;
    guardSynchronousMethod(variant, "applies", `${label}.applies`);
    guardSynchronousMethod(
      variant,
      "requirements",
      `${label}.requirements`,
      domain === "protocol" || domain === "credit"
        ? requireActiveProofRequirements
        : undefined,
    );
    guardSynchronousMethod(
      variant,
      "buildRequests",
      `${label}.buildRequests`,
      domain === "protocol" || domain === "credit"
        ? requireActiveProofRequests
        : undefined,
    );
    guardSynchronousMethod(
      variant,
      "decode",
      `${label}.decode`,
      domain === "protocol" || domain === "credit"
        ? requireActiveProofEvidence
        : undefined,
    );
    guardSynchronousMethod(
      variant,
      "decide",
      `${label}.decide`,
      domain === "protocol" || domain === "credit"
        ? requireActiveProofDecision
        : undefined,
    );
  }

  guardSynchronousMethod(
    routedPlugin.instance,
    "instanceKey",
    "instance.instanceKey",
  );
  guardSynchronousMethod(
    routedPlugin.instance,
    "compileDraft",
    "instance.compileDraft",
  );
  guardSynchronousMethod(
    routedPlugin.instance,
    "finalizeDescriptor",
    "instance.finalizeDescriptor",
  );
  guardSynchronousMethod(
    routedPlugin.instance,
    "staticBindingProjection",
    "instance.staticBindingProjection",
  );
  if (routedPlugin.instance.staticEvidence !== undefined) {
    guardRequestProgram(
      routedPlugin.instance.staticEvidence,
      "instance.staticEvidence",
    );
  }

  guardSynchronousMethod(routedPlugin.routes, "project", "routes.project");
  guardSynchronousMethod(
    routedPlugin.routes,
    "projectGraph",
    "routes.projectGraph",
  );

  if (domain === "credit") {
    const creditPlugin = pluginForDomain(plugin, "credit");
    guardSynchronousMethod(
      creditPlugin.execution,
      "buildFragment",
      "execution.buildFragment",
    );
    guardSynchronousMethod(
      creditPlugin.execution,
      "expectedEffects",
      "execution.expectedEffects",
    );
    guardSynchronousMethod(
      creditPlugin.credit.position,
      "positionKey",
      "credit.position.positionKey",
    );
    guardSynchronousMethod(
      creditPlugin.credit.risk,
      "quoteOutputByDebtBps",
      "credit.risk.quoteOutputByDebtBps",
    );
    if (creditPlugin.credit.risk.evidence !== undefined) {
      guardRequestProgram(
        creditPlugin.credit.risk.evidence,
        "credit.risk.evidence",
      );
    }
    for (const action of creditPlugin.actionAdapters) {
      assertBoundFamilyOwnedAction(action);
    }
    return;
  }

  const pricedPlugin = domain === "swap"
    ? pluginForDomain(plugin, "swap")
    : pluginForDomain(plugin, "protocol");

  guardSynchronousMethod(pricedPlugin.pricing, "stateKey", "pricing.stateKey");
  guardSynchronousMethod(
    pricedPlugin.pricing,
    "staticBindingProjection",
    "pricing.staticBindingProjection",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing,
    "snapshotCompatibilityProjection",
    "pricing.snapshotCompatibilityProjection",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing,
    "compileDraft",
    "pricing.compileDraft",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing,
    "finalizePricingDescriptor",
    "pricing.finalizePricingDescriptor",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing,
    "dependencies",
    "pricing.dependencies",
  );
  if (pricedPlugin.pricing.staticEvidence !== undefined) {
    guardRequestProgram(
      pricedPlugin.pricing.staticEvidence,
      "pricing.staticEvidence",
    );
  }
  guardSynchronousMethod(
    pricedPlugin.pricing.current,
    "requirements",
    "pricing.current.requirements",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing.current,
    "buildRequests",
    "pricing.current.buildRequests",
  );
  if (pricedPlugin.pricing.current.buildDependentProgram !== undefined) {
    guardSynchronousMethod(
      pricedPlugin.pricing.current,
      "buildDependentProgram",
      "pricing.current.buildDependentProgram",
    );
  }
  guardSynchronousMethod(
    pricedPlugin.pricing.current,
    "decodeSnapshot",
    "pricing.current.decodeSnapshot",
  );
  guardSynchronousMethod(
    pricedPlugin.pricing.current,
    "deriveMids",
    "pricing.current.deriveMids",
  );
  if (pricedPlugin.pricing.current.classifyUnavailable !== undefined) {
    guardSynchronousMethod(
      pricedPlugin.pricing.current,
      "classifyUnavailable",
      "pricing.current.classifyUnavailable",
    );
  }
  if (pricedPlugin.pricing.mutation !== undefined) {
    guardSynchronousMethod(
      pricedPlugin.pricing.mutation,
      "affectedStateKeys",
      "pricing.mutation.affectedStateKeys",
    );
  }
  if (pricedPlugin.pricing.liveStateProjection !== undefined) {
    guardSynchronousMethod(
      pricedPlugin.pricing.liveStateProjection,
      "project",
      "pricing.liveStateProjection.project",
    );
  }

  guardSynchronousMethod(pricedPlugin.exact, "methods", "exact.methods");
  guardSynchronousMethod(
    pricedPlugin.exact,
    "cacheCompatibilityProjection",
    "exact.cacheCompatibilityProjection",
  );
  guardSynchronousMethod(
    pricedPlugin.execution,
    "buildFragment",
    "execution.buildFragment",
  );
  guardSynchronousMethod(
    pricedPlugin.execution,
    "expectedEffects",
    "execution.expectedEffects",
  );

  if (pricedPlugin.sharedBindings !== undefined) {
    guardSynchronousMethod(
      pricedPlugin.sharedBindings,
      "references",
      "sharedBindings.references",
    );
    guardSynchronousMethod(
      pricedPlugin.sharedBindings,
      "canonicalProjection",
      "sharedBindings.canonicalProjection",
    );
    guardRequestProgram(
      pricedPlugin.sharedBindings.program,
      "sharedBindings.program",
    );
  }
  if (pricedPlugin.optional?.pendingEvidence !== undefined) {
    guardRequestProgram(
      pricedPlugin.optional.pendingEvidence,
      "optional.pendingEvidence",
    );
  }
  if (pricedPlugin.optional?.preparedQuote !== undefined) {
    guardRequestProgram(
      pricedPlugin.optional.preparedQuote,
      "optional.preparedQuote",
    );
  }

  // Official Family-owned actions are synchronously guarded and frozen by
  // bindFamilyOwnedAction. Replacing their callbacks here would both destroy
  // that immutable ownership receipt and hide the real action implementation
  // behind an author-written mutable wrapper.
  for (const action of pricedPlugin.actionAdapters) {
    assertBoundFamilyOwnedAction(action);
  }

  if (domain === "swap") {
    const swap = pluginForDomain(plugin, "swap").swap;
    guardSynchronousMethod(swap.landedEvents, "classify", "swap.landedEvents.classify");
    guardSynchronousMethod(swap.observation, "decode", "swap.observation.decode");
    if (swap.poolMaterialization !== undefined) {
      guardSynchronousMethod(
        swap.poolMaterialization,
        "candidateBinding",
        "swap.poolMaterialization.candidateBinding",
      );
    }
    if (swap.localApply !== undefined) {
      guardSynchronousMethod(swap.localApply, "apply", "swap.localApply.apply");
    }
    if (swap.overlay !== undefined) {
      guardSynchronousMethod(swap.overlay, "build", "swap.overlay.build");
    }
    if (swap.replay !== undefined) {
      guardSynchronousMethod(swap.replay, "bind", "swap.replay.bind");
      guardSynchronousMethod(
        swap.replay,
        "applyLocal",
        "swap.replay.applyLocal",
      );
      if (swap.replay.exactPostState !== undefined) {
        guardSynchronousMethod(
          swap.replay,
          "exactPostState",
          "swap.replay.exactPostState",
        );
      }
      guardSynchronousMethod(
        swap.replay,
        "buildOverlay",
        "swap.replay.buildOverlay",
      );
    }
  } else {
    const protocol = pluginForDomain(plugin, "protocol").protocol;
    if (protocol.oracleVictim !== undefined) {
      guardSynchronousMethod(
        protocol.oracleVictim,
        "decode",
        "protocol.oracleVictim.decode",
      );
    }
  }
}

function guardRequestProgram(program: object, label: string): void {
  guardSynchronousMethod(program, "requirements", `${label}.requirements`);
  guardSynchronousMethod(program, "buildRequests", `${label}.buildRequests`);
  guardSynchronousMethod(program, "decode", `${label}.decode`);
  const reusePolicy = (program as { readonly reusePolicy?: unknown }).reusePolicy;
  if (
    reusePolicy !== null &&
    typeof reusePolicy === "object" &&
    "dependencyKeys" in reusePolicy
  ) {
    guardSynchronousMethod(
      reusePolicy,
      "dependencyKeys",
      `${label}.reusePolicy.dependencyKeys`,
    );
  }
}

function guardSynchronousMethod(
  owner: object,
  key: PropertyKey,
  label: string,
  resultGuard?: SynchronousResultGuard,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data function`);
  }
  const original = descriptor.value;
  assertSynchronousFunction(original, label);
  deepFreezeDefinition(original, `${label} callback`, new Set<object>());
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    const result = Reflect.apply(original, this, args);
    assertNonThenable(result, label);
    resultGuard?.(result, args);
    return result;
  };
  try {
    Object.defineProperty(owner, key, { ...descriptor, value: guarded });
  } catch {
    throw new Error(`${label} must be mutable until its Family is defined`);
  }
}

function assertNonThenable(value: unknown, label: string): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return;
  }
  let then: unknown;
  try {
    then = (value as { readonly then?: unknown }).then;
  } catch {
    throw new Error(`${label} returned an unreadable thenable`);
  }
  if (typeof then === "function") {
    throw new Error(`${label} returned a thenable; it must be synchronous`);
  }
}

function requireActiveProofRequirements(result: unknown): void {
  if (
    result === null ||
    typeof result !== "object" ||
    !Array.isArray((result as { readonly transports?: unknown }).transports) ||
    (result as { readonly transports: readonly unknown[] }).transports.length === 0
  ) {
    throw new Error(
      "identity active behavior proof requires a transport",
    );
  }
}

function requireActiveProofRequests(result: unknown): void {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(
      "identity active behavior proof requires at least one request",
    );
  }
}

function requireActiveProofEvidence(
  result: unknown,
  args: readonly unknown[],
): void {
  const input = args[0];
  const results = input !== null && typeof input === "object"
    ? (input as { readonly results?: unknown }).results
    : undefined;
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    results.some((item) =>
      item === null ||
      typeof item !== "object" ||
      (item as { readonly ok?: unknown }).ok !== true
    ) ||
    result === undefined
  ) {
    throw new Error(
      "identity active behavior proof requires successful results and explicit evidence",
    );
  }
}

function requireActiveProofDecision(
  result: unknown,
  args: readonly unknown[],
): void {
  if (
    result === null ||
    typeof result !== "object" ||
    (result as { readonly status?: unknown }).status !== "verified"
  ) {
    return;
  }
  const input = args[0];
  const step = input !== null && typeof input === "object"
    ? (input as { readonly step?: unknown }).step
    : undefined;
  const evidence = input !== null && typeof input === "object"
    ? (input as { readonly evidence?: unknown }).evidence
    : undefined;
  if (typeof step !== "number" || step <= 0 || evidence === undefined) {
    throw new Error(
      "identity cannot verify before active behavior proof evidence",
    );
  }
}

function validateFamilyPlugin(
  plugin: AnyStrictFamilyPlugin,
  expectedDomain: FamilyDomain,
): DefinedFamilyPluginContractSummary {
  assertPlainRecord(plugin, "family plugin");
  assertExactTopLevelKeys(plugin, expectedDomain);
  const manifest = plugin.manifest;
  validateManifest(manifest, expectedDomain);
  if (plugin.capture !== undefined) validateCapture(plugin.capture);
  if (expectedDomain === "funding") {
    const fundingPlugin = pluginForDomain(plugin, "funding");
    validateFundingDomain(
      fundingPlugin.funding,
      manifest,
    );
  } else {
    const routedPlugin = expectedDomain === "credit"
      ? pluginForDomain(plugin, "credit")
      : expectedDomain === "swap"
      ? pluginForDomain(plugin, "swap")
      : pluginForDomain(plugin, "protocol");
    validateDiscovery(routedPlugin.discovery);
    validateIdentity(routedPlugin.identity, manifest);
    validateInstance(routedPlugin.instance);
    validateRoutes(routedPlugin.routes);
    validateExecution(routedPlugin.execution);
    if (expectedDomain === "credit") {
      validateCreditDomain(pluginForDomain(plugin, "credit").credit);
    } else {
      const pricedPlugin = expectedDomain === "swap"
        ? pluginForDomain(plugin, "swap")
        : pluginForDomain(plugin, "protocol");
      validatePricing(pricedPlugin.pricing);
      validateExact(pricedPlugin.exact);
      if (pricedPlugin.sharedBindings !== undefined) {
        validateSharedBindings(pricedPlugin.sharedBindings);
      }
      if (pricedPlugin.optional !== undefined) {
        validateOptional(pricedPlugin.optional);
      }
    }
  }
  validateActions(plugin.actionAdapters, manifest);
  if (expectedDomain === "swap") {
    const swapPlugin = pluginForDomain(plugin, "swap");
    validateSwapDomain(
      swapPlugin.swap,
      swapPlugin.discovery,
    );
  } else if (expectedDomain === "protocol") {
    const protocolPlugin = pluginForDomain(plugin, "protocol");
    validateProtocolDomain(
      protocolPlugin.protocol,
      protocolPlugin.discovery,
    );
  }

  const supportedLineages = Object.freeze(
    [...manifest.supportedLineages].sort(),
  );
  const ownedActionAdapterIds = Object.freeze(
    [...manifest.ownedActionAdapterIds].sort(),
  );
  const requiredInfraActionAdapterIds = Object.freeze(
    [...manifest.requiredInfraActionAdapterIds].sort(),
  );
  const suppliedActionAdapterIds = Object.freeze(
    plugin.actionAdapters.map((action) => action.id).sort(),
  );
  const taxonomy = Object.freeze(
    manifest.allowedTaxonomy.map(taxonomyKey).sort(),
  );
  const routedPlugin = expectedDomain === "funding"
    ? null
    : expectedDomain === "credit"
    ? pluginForDomain(plugin, "credit")
    : expectedDomain === "swap"
    ? pluginForDomain(plugin, "swap")
    : pluginForDomain(plugin, "protocol");
  const domainPolicy: CanonicalValue = expectedDomain === "funding"
    ? fundingDomainBoundary(pluginForDomain(plugin, "funding").funding)
    : expectedDomain === "credit"
    ? creditDomainBoundary(pluginForDomain(plugin, "credit").credit)
    : null;
  const optionalCapabilities: readonly CanonicalValue[] =
    expectedDomain === "swap"
      ? pricedOptionalCapabilityNames(pluginForDomain(plugin, "swap"))
      : expectedDomain === "protocol"
      ? pricedOptionalCapabilityNames(pluginForDomain(plugin, "protocol"))
      : [];
  const boundary: CanonicalValue = {
    contractKind: "defined-family-plugin",
    familyId: manifest.familyId,
    domain: manifest.domain,
    supportedLineages,
    ownedActionAdapterIds,
    requiredInfraActionAdapterIds,
    suppliedActions: plugin.actionAdapters
      .map((action) => ({
        id: action.id,
        lineage: action.descriptor.lineage,
        edgeKind: action.descriptor.edgeKind,
        action: action.descriptor.action,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    taxonomy,
    capture: plugin.capture === undefined ? null : "plugin-materialized-v1",
    discoveryPatternIds: routedPlugin === null
      ? []
      : [...discoveryPatternIds(routedPlugin.discovery)].sort(),
    identityVariants: routedPlugin === null
      ? []
      : routedPlugin.identity.variants
        .map((variant) => ({
          id: variant.id,
          kind: variant.kind,
          lineageId: variant.lineageId,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    domainPolicy,
    optionalCapabilities,
  };
  return {
    contractKind: "defined-family-plugin",
    familyId: manifest.familyId,
    domain: manifest.domain,
    supportedLineages,
    ownedActionAdapterIds,
    requiredInfraActionAdapterIds,
    suppliedActionAdapterIds,
    taxonomy,
    definitionBoundaryHash: hashCanonical(boundary),
  };
}

function validateCapture(capture: CaptureMaterializationSemantics): void {
  assertPlainRecord(capture, "capture materialization");
  assertExactKeys(capture, ["materialize"], "capture materialization");
  assertSynchronousFunction(capture.materialize, "capture.materialize");
}

function validateCaptureMaterializationResult(
  plugin: AnyStrictFamilyPlugin,
  result: unknown,
  args: readonly unknown[],
): void {
  if (args.length !== 1) {
    throw new Error("capture.materialize requires exactly one descriptor");
  }
  const descriptor = args[0];
  assertPlainRecord(descriptor, "capture descriptor");
  assertExactKeys(
    descriptor as object,
    ["candidateIdentity", "familyId", "opaqueBinding", "source"],
    "capture descriptor",
  );
  const captureDescriptor = descriptor as unknown as FamilyCaptureDescriptor;
  if (captureDescriptor.familyId !== plugin.manifest.familyId) {
    throw new Error("capture descriptor Family does not match its plugin");
  }
  nonemptyString(
    captureDescriptor.candidateIdentity,
    "capture descriptor candidateIdentity",
  );
  validateCanonicalSource(captureDescriptor.source, "capture descriptor source");
  // This rejects functions, symbols, cycles and non-plain records before a
  // plugin can use opaque input as an escape hatch from the canonical model.
  hashCanonical(captureDescriptor.opaqueBinding);

  assertPlainRecord(result, "capture vector");
  const vector = result as FamilyCaptureVector;
  if (plugin.manifest.domain === "funding") {
    validateFundingCaptureVector(vector);
  } else if (plugin.manifest.domain === "credit") {
    validateCreditCaptureVector(plugin, captureDescriptor, vector);
  } else {
    validateRouteCaptureVector(plugin, captureDescriptor, vector);
  }
  deepFreezeDefinition(vector, "capture vector", new Set<object>());
}

function validateRouteCaptureVector(
  plugin: AnyStrictFamilyPlugin,
  descriptor: FamilyCaptureDescriptor,
  vector: FamilyCaptureVector,
): void {
  if (vector.kind !== "route") {
    throw new Error(`${plugin.manifest.domain} capture must return a route vector`);
  }
  assertExactKeys(
    vector,
    [
      "amountIn",
      "executor",
      "kind",
      "minAmountOut",
      "observations",
      "runtimeEvidence",
    ],
    "route capture vector",
  );
  validatePositiveBigint(vector.amountIn, "route capture amountIn");
  validateNonnegativeBigint(
    vector.minAmountOut,
    "route capture minAmountOut",
  );
  validateAddress(vector.executor, "route capture executor");
  validateCaptureObservations(plugin, descriptor, vector.observations);
  validateCaptureRuntimeEvidence(
    plugin.manifest.familyId,
    descriptor.source,
    vector.runtimeEvidence,
  );
}

function validateFundingCaptureVector(vector: FamilyCaptureVector): void {
  if (vector.kind !== "funding") {
    throw new Error("funding capture must return a funding vector");
  }
  assertExactKeys(
    vector,
    ["amount", "assets", "kind", "minProfit"],
    "funding capture vector",
  );
  if (!Array.isArray(vector.assets) || vector.assets.length === 0) {
    throw new Error("funding capture assets must be non-empty");
  }
  for (const asset of vector.assets) {
    validateAddress(asset, "funding capture asset");
  }
  if (new Set(vector.assets.map((asset) => asset.toLowerCase())).size !==
      vector.assets.length) {
    throw new Error("funding capture assets must be unique");
  }
  validatePositiveBigint(vector.amount, "funding capture amount");
  validateNonnegativeBigint(vector.minProfit, "funding capture minProfit");
}

function validateCreditCaptureVector(
  plugin: AnyStrictFamilyPlugin,
  descriptor: FamilyCaptureDescriptor,
  vector: FamilyCaptureVector,
): void {
  if (vector.kind !== "credit") {
    throw new Error("credit capture must return a credit vector");
  }
  assertExactKeys(
    vector,
    [
      "collateralAmount",
      "debtBps",
      "executor",
      "kind",
      "minAmountOut",
      "observations",
      "runtimeEvidence",
    ],
    "credit capture vector",
  );
  validatePositiveBigint(
    vector.collateralAmount,
    "credit capture collateralAmount",
  );
  validatePositiveBigint(vector.debtBps, "credit capture debtBps");
  if (vector.debtBps > 10_000n) {
    throw new Error("credit capture debtBps must not exceed 10000");
  }
  validateNonnegativeBigint(
    vector.minAmountOut,
    "credit capture minAmountOut",
  );
  validateAddress(vector.executor, "credit capture executor");
  validateCaptureObservations(plugin, descriptor, vector.observations);
  validateCaptureRuntimeEvidence(
    plugin.manifest.familyId,
    descriptor.source,
    vector.runtimeEvidence,
  );
}

function validateCaptureObservations(
  plugin: AnyStrictFamilyPlugin,
  descriptor: FamilyCaptureDescriptor,
  observations: readonly CaptureObservationIntent[],
): void {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error("capture observations must be non-empty");
  }
  if (!("discovery" in plugin)) {
    throw new Error("capture observations require discovery semantics");
  }
  const callPatternIds = new Set(
    (plugin.discovery.callPatterns ?? []).map((pattern) => pattern.id),
  );
  const logPatternIds = new Set(
    (plugin.discovery.logPatterns ?? []).map((pattern) => pattern.id),
  );
  const addressPatternIds = new Set(
    (plugin.discovery.addressSurfaces ?? []).map((pattern) => pattern.id),
  );
  for (const [index, observation] of observations.entries()) {
    const label = `capture observation ${index}`;
    assertPlainRecord(observation, label);
    switch (observation.kind) {
      case "provided-observation":
        assertExactKeys(
          observation,
          ["kind", "observation", "patternId"],
          label,
        );
        validateProvidedCaptureObservation(
          plugin,
          descriptor,
          observation.patternId,
          observation.observation,
          label,
        );
        break;
      case "address-surface":
        assertExactKeys(
          observation,
          ["address", "interfaceFingerprints", "kind", "patternId"],
          label,
        );
        assertCapturePattern(addressPatternIds, observation.patternId, label);
        validateAddress(observation.address, `${label} address`);
        if (!Array.isArray(observation.interfaceFingerprints)) {
          throw new Error(`${label} interfaceFingerprints must be an array`);
        }
        for (const fingerprint of observation.interfaceFingerprints) {
          nonemptyString(fingerprint, `${label} interface fingerprint`);
        }
        break;
      case "declared-log":
        assertExactKeys(
          observation,
          ["candidateIdentity", "kind", "patternId"],
          label,
        );
        assertCapturePattern(logPatternIds, observation.patternId, label);
        if (observation.candidateIdentity.toLowerCase() !==
            descriptor.candidateIdentity.toLowerCase()) {
          throw new Error(`${label} candidateIdentity is not descriptor-bound`);
        }
        break;
      case "observed-call":
        assertExactKeys(
          observation,
          ["kind", "patternId", "traceAddress", "transactionHash"],
          label,
        );
        assertCapturePattern(callPatternIds, observation.patternId, label);
        assertHex(observation.transactionHash, 32, `${label} transactionHash`);
        if (!Array.isArray(observation.traceAddress) ||
            observation.traceAddress.some((index: number) =>
              !Number.isSafeInteger(index) || index < 0
            )) {
          throw new Error(`${label} traceAddress must be nonnegative integers`);
        }
        break;
      case "observed-log":
        assertExactKeys(
          observation,
          ["kind", "logIndex", "patternId", "transactionHash"],
          label,
        );
        assertCapturePattern(logPatternIds, observation.patternId, label);
        assertHex(observation.transactionHash, 32, `${label} transactionHash`);
        if (!Number.isSafeInteger(observation.logIndex) ||
            observation.logIndex < 0) {
          throw new Error(`${label} logIndex must be a nonnegative integer`);
        }
        break;
      default:
        throw new Error(`${label} has unknown kind`);
    }
  }
}

function validateProvidedCaptureObservation(
  plugin: AnyStrictFamilyPlugin,
  descriptor: FamilyCaptureDescriptor,
  patternId: string,
  observation: UnifiedObservation,
  label: string,
): void {
  validateUnifiedCaptureObservation(observation, descriptor.source, label);
  if (!("discovery" in plugin)) {
    throw new Error(`${label} requires discovery semantics`);
  }
  const declared = observation.kind === "call"
    ? plugin.discovery.callPatterns?.some((pattern) =>
        pattern.id === patternId &&
        observation.data.slice(0, 10).toLowerCase() ===
          pattern.selector.toLowerCase()
      ) === true
    : observation.kind === "log"
      ? plugin.discovery.logPatterns?.some((pattern) =>
          pattern.id === patternId &&
          observation.topics[0]?.toLowerCase() === pattern.topic.toLowerCase()
        ) === true
      : observation.kind === "factory-log"
        ? plugin.discovery.logPatterns?.some((pattern) =>
            pattern.id === patternId &&
            observation.topic.toLowerCase() === pattern.topic.toLowerCase()
          ) === true
        : plugin.discovery.addressSurfaces?.some((pattern) => {
            if (pattern.id !== patternId) return false;
            if (pattern.kind === "code-hash") {
              return pattern.fingerprint.toLowerCase() ===
                observation.codeHash.toLowerCase();
            }
            if (pattern.kind === "proxy-implementation") {
              return !/^0x0{64}$/i.test(observation.implementationWord);
            }
            return observation.interfaceFingerprints?.includes(
              pattern.fingerprint,
            ) === true;
          }) === true;
  if (!declared) {
    throw new Error(`${label} does not match its plugin declaration`);
  }
}

function validateUnifiedCaptureObservation(
  observation: UnifiedObservation,
  source: CanonicalSource,
  label: string,
): void {
  assertPlainRecord(observation, `${label} observation`);
  validateCanonicalSource(observation.source, `${label} observation source`);
  if (
    observation.source.number !== source.number ||
    observation.source.generation !== source.generation ||
    observation.source.hash.toLowerCase() !== source.hash.toLowerCase()
  ) {
    throw new Error(`${label} observation is not descriptor-source-bound`);
  }
  switch (observation.kind) {
    case "call":
      validateAddress(observation.target, `${label} call target`);
      assertHexData(observation.data, `${label} call data`);
      break;
    case "log":
      validateAddress(observation.address, `${label} log address`);
      if (!Array.isArray(observation.topics) || observation.topics.length === 0) {
        throw new Error(`${label} log topics must be non-empty`);
      }
      for (const topic of observation.topics) {
        assertHex(topic, 32, `${label} log topic`);
      }
      assertHexData(observation.data, `${label} log data`);
      break;
    case "address-surface":
      validateAddress(observation.address, `${label} surface address`);
      assertHex(observation.codeHash, 32, `${label} code hash`);
      assertHex(observation.implementationWord, 32,
        `${label} implementation word`);
      break;
    case "factory-log":
      validateAddress(observation.factory, `${label} factory`);
      assertHex(observation.topic, 32, `${label} factory topic`);
      if (!Array.isArray(observation.topics) || observation.topics.length === 0) {
        throw new Error(`${label} factory topics must be non-empty`);
      }
      assertHexData(observation.data, `${label} factory data`);
      break;
  }
}

function assertCapturePattern(
  declared: ReadonlySet<string>,
  patternId: string,
  label: string,
): void {
  nonemptyString(patternId, `${label} patternId`);
  if (!declared.has(patternId)) {
    throw new Error(`${label} patternId is not declared by its plugin`);
  }
}

function validateCaptureRuntimeEvidence(
  family: FamilyId,
  source: CanonicalSource,
  evidence: readonly RuntimeEvidence[],
): void {
  if (!Array.isArray(evidence)) {
    throw new Error("capture runtimeEvidence must be an array");
  }
  for (const [index, item] of evidence.entries()) {
    const label = `capture runtimeEvidence ${index}`;
    assertPlainRecord(item, label);
    assertExactKeys(
      item,
      [
        "evidenceHash",
        "evidenceId",
        "familyId",
        "instanceKey",
        "kind",
        "scope",
        "sealedPayloadRef",
        "source",
        "txHash",
      ],
      label,
      true,
      [
        "evidenceHash",
        "evidenceId",
        "familyId",
        "kind",
        "scope",
        "sealedPayloadRef",
        "source",
      ],
    );
    if (item.familyId !== family) {
      throw new Error(`${label} Family is not plugin-bound`);
    }
    validateCanonicalSource(item.source, `${label} source`);
    if (hashCanonical({
      number: item.source.number,
      hash: item.source.hash,
      generation: item.source.generation,
    }) !== hashCanonical({
      number: source.number,
      hash: source.hash,
      generation: source.generation,
    })) {
      throw new Error(`${label} source is not descriptor-bound`);
    }
    nonemptyString(item.evidenceId, `${label} evidenceId`);
    nonemptyString(item.kind, `${label} kind`);
    if (!(["source-block", "head", "transaction"] as const)
      .includes(item.scope)) {
      throw new Error(`${label} scope is invalid`);
    }
    assertHex(item.evidenceHash, 32, `${label} evidenceHash`);
    if (!item.sealedPayloadRef.startsWith("onchain:")) {
      throw new Error(`${label} sealedPayloadRef must be onchain evidence`);
    }
    if (item.txHash !== undefined) {
      assertHex(item.txHash, 32, `${label} txHash`);
    }
  }
}

function validateCanonicalSource(source: unknown, label: string): void {
  assertPlainRecord(source, label);
  assertExactKeys(source as object, ["generation", "hash", "number"], label);
  const value = source as CanonicalSource;
  if (!Number.isSafeInteger(value.number) || value.number < 0) {
    throw new Error(`${label}.number must be a nonnegative safe integer`);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new Error(`${label}.generation must be a nonnegative safe integer`);
  }
  assertHex(value.hash, 32, `${label}.hash`);
}

function validateAddress(value: unknown, label: string): void {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label} must be an EVM address`);
  }
}

function validatePositiveBigint(value: unknown, label: string): void {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new Error(`${label} must be a positive bigint`);
  }
}

function validateNonnegativeBigint(value: unknown, label: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a nonnegative bigint`);
  }
}

function fundingDomainBoundary(
  funding: FamilyPluginForDomain<"funding">["funding"],
): CanonicalValue {
  return {
    target: funding.repayment.target,
    liquidityHolder: funding.repayment.liquidityHolder,
    repayment: funding.repayment.mode,
    paramShape: funding.repayment.paramShape,
  };
}

function creditDomainBoundary(
  credit: FamilyPluginForDomain<"credit">["credit"],
): CanonicalValue {
  return {
    activeBehaviorProof: credit.activeBehaviorProof,
    lifecycle: credit.position.lifecycle,
    finalSafety: credit.position.finalSafety,
    debtBpsCandidates: credit.risk.debtBpsCandidates,
    blocksPrefixInversion: credit.risk.blocksPrefixInversion,
  };
}

function pricedOptionalCapabilityNames(
  plugin:
    | FamilyPluginForDomain<"swap">
    | FamilyPluginForDomain<"protocol">,
): readonly CanonicalValue[] {
  return [
    plugin.sharedBindings === undefined ? null : "sharedBindings",
    plugin.optional?.pendingEvidence === undefined ? null : "pendingEvidence",
    plugin.optional?.preparedQuote === undefined ? null : "preparedQuote",
  ];
}

function assertExactTopLevelKeys(
  plugin: object,
  domain: FamilyDomain,
): void {
  const required = requiredCapabilityKeys(domain);
  const optional = optionalCapabilityKeys(domain);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(plugin, key)) {
      throw new Error(`family plugin is missing required top-level capability ${key}`);
    }
  }
  for (const key of Reflect.ownKeys(plugin)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(
        `family plugin has unknown top-level capability ${String(key)}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(plugin, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(
        `family plugin capability ${key} must be an enumerable data field`,
      );
    }
  }
}

function validateManifest(
  manifest: FamilyManifest<FamilyDomain>,
  expectedDomain: FamilyDomain,
): void {
  assertPlainRecord(manifest, "family manifest");
  assertExactKeys(manifest, [
    "allowedTaxonomy",
    "domain",
    "familyId",
    "ownedActionAdapterIds",
    "poolAdapterIds",
    "requiredInfraActionAdapterIds",
    "supportedLineages",
  ], "family manifest", true, [
    "allowedTaxonomy",
    "domain",
    "familyId",
    "ownedActionAdapterIds",
    "requiredInfraActionAdapterIds",
    "supportedLineages",
  ]);
  if (manifest.domain !== expectedDomain) {
    throw new Error(
      `family manifest domain ${String(manifest.domain)} does not match ${expectedDomain}`,
    );
  }
  nonemptyString(manifest.familyId, "familyId");
  const owned = stringSet(
    manifest.ownedActionAdapterIds,
    "ownedActionAdapterIds",
    true,
  );
  const infra = stringSet(
    manifest.requiredInfraActionAdapterIds,
    "requiredInfraActionAdapterIds",
    false,
  );
  for (const actionId of owned) {
    if (infra.has(actionId)) {
      throw new Error(
        `${manifest.familyId} action ${actionId} cannot be both owned and shared infra`,
      );
    }
  }
  const lineages = stringSet(
    manifest.supportedLineages,
    "supportedLineages",
    true,
  );
  if (lineages.size !== manifest.supportedLineages.length) {
    throw new Error(`${manifest.familyId} duplicates a supported lineage`);
  }
  if (manifest.poolAdapterIds !== undefined) {
    stringSet(manifest.poolAdapterIds, "poolAdapterIds", true);
  }
  if (!Array.isArray(manifest.allowedTaxonomy) ||
      manifest.allowedTaxonomy.length === 0) {
    throw new Error(`${manifest.familyId} must declare allowed taxonomy`);
  }
  const taxonomy = new Set<string>();
  for (const item of manifest.allowedTaxonomy) {
    assertPlainRecord(item, "allowed taxonomy");
    assertExactKeys(item, ["protocolAction", "slotKind"], "allowed taxonomy", true);
    const key = taxonomyKey(item);
    if (taxonomy.has(key)) {
      throw new Error(`${manifest.familyId} duplicates taxonomy ${key}`);
    }
    taxonomy.add(key);
    if (expectedDomain === "swap") {
      if (item.slotKind !== "swap" || item.protocolAction !== undefined) {
        throw new Error(`${manifest.familyId} swap taxonomy must be swap/none`);
      }
    } else if (expectedDomain === "protocol" &&
        (item.slotKind !== "protocol" || item.protocolAction === undefined)) {
      throw new Error(
        `${manifest.familyId} protocol taxonomy requires protocolAction`,
      );
    } else if (
      expectedDomain === "funding" &&
      (item.slotKind !== "flash" || item.protocolAction !== undefined)
    ) {
      throw new Error(`${manifest.familyId} funding taxonomy must be flash/none`);
    } else if (
      expectedDomain === "credit" &&
      (item.slotKind !== "lend" || item.protocolAction !== undefined)
    ) {
      throw new Error(`${manifest.familyId} credit taxonomy must be lend/none`);
    }
  }
}

function validateDiscovery(discovery: DiscoverySemantics<any>): void {
  assertPlainRecord(discovery, "discovery semantics");
  assertExactKeys(
    discovery,
    [
      "addressSurfaces",
      "callPatterns",
      "candidateKey",
      "decodeCandidate",
      "evidenceChannel",
      "logPatterns",
      "nominate",
      "sources",
    ],
    "discovery semantics",
    true,
    ["candidateKey", "decodeCandidate", "evidenceChannel", "sources"],
  );
  if (
    discovery.evidenceChannel !== "nominate" &&
    discovery.evidenceChannel !== "tx-evidence"
  ) {
    throw new Error(
      "discovery must declare evidenceChannel: \"nominate\" or \"tx-evidence\"",
    );
  }
  if (discovery.evidenceChannel === "nominate" &&
      discovery.nominate === undefined) {
    throw new Error(
      "discovery evidenceChannel=nominate requires a nominate capability",
    );
  }
  if (discovery.evidenceChannel === "tx-evidence" &&
      discovery.nominate !== undefined) {
    throw new Error(
      "discovery evidenceChannel=tx-evidence must not declare nominate; " +
        "pick one evidence channel",
    );
  }
  if (discovery.evidenceChannel === "tx-evidence" &&
      (discovery.callPatterns?.length ?? 0) === 0 &&
      (discovery.logPatterns?.length ?? 0) === 0) {
    throw new Error(
      "discovery evidenceChannel=tx-evidence requires call or log patterns " +
        "for receipt/trace decoding",
    );
  }
  if (discovery.nominate !== undefined) {
    assertPlainRecord(discovery.nominate, "discovery nomination semantics");
    assertExactKeys(
      discovery.nominate,
      ["nominate"],
      "discovery nomination semantics",
    );
    if (typeof discovery.nominate.nominate !== "function") {
      throw new Error("discovery nomination nominate must be a function");
    }
  }
  const sources = stringSet(discovery.sources, "discovery sources", true);
  const supported = new Set<DiscoverySourceKind>([
    "factory-log",
    "landed-log",
    "observed-call",
    "address-surface",
    "canonical-registry",
  ]);
  for (const source of sources) {
    if (!supported.has(source as DiscoverySourceKind)) {
      throw new Error(`unsupported discovery source ${source}`);
    }
  }
  assertSynchronousFunction(discovery.decodeCandidate, "discovery.decodeCandidate");
  assertSynchronousFunction(discovery.candidateKey, "discovery.candidateKey");
  const ids = discoveryPatternIds(discovery);
  if (ids.length === 0) {
    throw new Error("discovery must declare at least one pattern");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("discovery pattern ids must be unique");
  }
  for (const pattern of discovery.callPatterns ?? []) {
    validateCallPattern(pattern, "call pattern");
  }
  for (const pattern of discovery.logPatterns ?? []) {
    validateLogPattern(pattern, "log pattern");
  }
  for (const pattern of discovery.addressSurfaces ?? []) {
    validateAddressSurfacePattern(pattern);
  }
}

function validateCallPattern(pattern: CallPattern, label: string): void {
  assertPlainRecord(pattern, label);
  assertExactKeys(
    pattern,
    [
      "argumentProjection",
      "candidateAddress",
      "id",
      "selector",
      "signature",
    ],
    label,
    true,
    ["candidateAddress", "id", "selector", "signature"],
  );
  assertIdentifier(pattern.id, `${label} id`);
  assertHex(pattern.selector, 4, `${label} ${pattern.id} selector`);
  assertIdentifier(pattern.signature, `${label} ${pattern.id} signature`);
  assertPlainRecord(
    pattern.candidateAddress,
    `${label} ${pattern.id} candidateAddress`,
  );
  switch (pattern.candidateAddress.from) {
    case "call-target":
      assertExactKeys(
        pattern.candidateAddress,
        ["from"],
        `${label} ${pattern.id} candidateAddress`,
      );
      break;
    case "argument":
      assertExactKeys(
        pattern.candidateAddress,
        ["from", "index"],
        `${label} ${pattern.id} candidateAddress`,
      );
      if (
        !Number.isInteger(pattern.candidateAddress.index) ||
        pattern.candidateAddress.index < 0
      ) {
        throw new Error(
          `${label} ${pattern.id} candidateAddress index must be non-negative`,
        );
      }
      break;
    default:
      throw new Error(
        `${label} ${pattern.id} has unsupported candidateAddress source`,
      );
  }
  if (pattern.argumentProjection !== undefined) {
    if (!Array.isArray(pattern.argumentProjection)) {
      throw new Error(`${label} ${pattern.id} argumentProjection must be an array`);
    }
    for (const projection of pattern.argumentProjection) {
      assertPlainRecord(projection, `${label} ${pattern.id} argument projection`);
      assertExactKeys(
        projection,
        ["index", "name", "type"],
        `${label} ${pattern.id} argument projection`,
      );
      if (!Number.isInteger(projection.index) || projection.index < 0) {
        throw new Error(
          `${label} ${pattern.id} argument projection index must be non-negative`,
        );
      }
      assertIdentifier(
        projection.name,
        `${label} ${pattern.id} argument projection name`,
      );
      assertIdentifier(
        projection.type,
        `${label} ${pattern.id} argument projection type`,
      );
    }
  }
}

function validateLogPattern(pattern: LogPattern, label: string): void {
  assertPlainRecord(pattern, label);
  assertExactKeys(pattern, ["emitter", "id", "signature", "topic"], label,
    true, ["id", "signature", "topic"]);
  assertIdentifier(pattern.id, `${label} id`);
  assertHex(pattern.topic, 32, `${label} ${pattern.id} topic`);
  assertIdentifier(pattern.signature, `${label} ${pattern.id} signature`);
  if (pattern.emitter === undefined) return;
  assertPlainRecord(pattern.emitter, `${label} ${pattern.id} emitter`);
  if (pattern.emitter.mode === "address") {
    assertExactKeys(
      pattern.emitter,
      ["mode"],
      `${label} ${pattern.id} emitter`,
    );
    return;
  }
  assertExactKeys(
    pattern.emitter,
    ["address", "fromBlock", "mode", "topicIndex"],
    `${label} ${pattern.id} emitter`,
  );
  if (
    pattern.emitter.mode !== "singleton-indexed-address" &&
    pattern.emitter.mode !== "singleton-indexed-bytes32"
  ) {
    throw new Error(`${label} ${pattern.id} has unsupported emitter mode`);
  }
  try {
    ethers.getAddress(pattern.emitter.address);
  } catch {
    throw new Error(`${label} ${pattern.id} emitter address is invalid`);
  }
  if (!Number.isSafeInteger(pattern.emitter.topicIndex) ||
      pattern.emitter.topicIndex < 1) {
    throw new Error(`${label} ${pattern.id} emitter topicIndex is invalid`);
  }
  if (!Number.isSafeInteger(pattern.emitter.fromBlock) ||
      pattern.emitter.fromBlock < 0) {
    throw new Error(`${label} ${pattern.id} emitter fromBlock is invalid`);
  }
}

function validateAddressSurfacePattern(pattern: AddressSurfacePattern): void {
  assertPlainRecord(pattern, "address surface");
  assertExactKeys(
    pattern,
    ["fingerprint", "id", "kind"],
    "address surface",
  );
  assertIdentifier(pattern.id, "address surface id");
  if (
    pattern.kind !== "code-hash" &&
    pattern.kind !== "interface" &&
    pattern.kind !== "proxy-implementation"
  ) {
    throw new Error(`address surface ${pattern.id} has unsupported kind`);
  }
  assertIdentifier(
    pattern.fingerprint,
    `address surface ${pattern.id} fingerprint`,
  );
}

function validateIdentity(
  identity: IdentitySemantics<any, any>,
  manifest: FamilyManifest<FamilyDomain>,
): void {
  assertPlainRecord(identity, "identity semantics");
  assertExactKeys(
    identity,
    ["identityKey", "variants"],
    "identity semantics",
  );
  assertSynchronousFunction(identity.identityKey, "identity.identityKey");
  if (!Array.isArray(identity.variants) || identity.variants.length === 0) {
    throw new Error(`${manifest.familyId} must declare an identity variant`);
  }
  const variantIds = new Set<string>();
  const variantLineages = new Set<string>();
  const allowedLineages = new Set<string>(manifest.supportedLineages);
  const kinds = new Set<IdentityVariantKind>([
    "factory-child",
    "registry-member",
    "standalone-contract",
    "singleton-subinstance",
    "custom",
  ]);
  for (const variant of identity.variants) {
    assertPlainRecord(variant, "identity variant");
    assertExactKeys(
      variant,
      [
        "applies",
        "buildRequests",
        "decide",
        "decode",
        "id",
        "kind",
        "lineageId",
        "requirements",
      ],
      "identity variant",
    );
    const id = nonemptyString(variant.id, "identity variant id");
    if (variantIds.has(id)) throw new Error(`duplicate identity variant ${id}`);
    variantIds.add(id);
    if (!kinds.has(variant.kind)) {
      throw new Error(`identity variant ${id} has unsupported kind ${variant.kind}`);
    }
    const lineage = nonemptyString(variant.lineageId, `identity variant ${id} lineageId`);
    if (!allowedLineages.has(lineage)) {
      throw new Error(
        `identity variant ${id} lineage ${lineage} is absent from the manifest`,
      );
    }
    variantLineages.add(lineage);
    assertSynchronousFunction(variant.applies, `identity variant ${id}.applies`);
    assertSynchronousFunction(
      variant.requirements,
      `identity variant ${id}.requirements`,
    );
    assertSynchronousFunction(
      variant.buildRequests,
      `identity variant ${id}.buildRequests`,
    );
    assertSynchronousFunction(variant.decode, `identity variant ${id}.decode`);
    assertSynchronousFunction(variant.decide, `identity variant ${id}.decide`);
  }
  for (const lineage of allowedLineages) {
    if (!variantLineages.has(lineage)) {
      throw new Error(
        `${manifest.familyId} supported lineage ${lineage} has no identity variant`,
      );
    }
  }
}

function validateInstance(instance: InstanceSemantics<any, any, any, any>): void {
  assertPlainRecord(instance, "instance semantics");
  assertExactKeys(
    instance,
    [
      "compileDraft",
      "finalizeDescriptor",
      "instanceKey",
      "staticBindingProjection",
      "staticEvidence",
    ],
    "instance semantics",
    true,
    [
      "compileDraft",
      "finalizeDescriptor",
      "instanceKey",
      "staticBindingProjection",
    ],
  );
  assertSynchronousFunction(instance.instanceKey, "instance.instanceKey");
  assertSynchronousFunction(instance.compileDraft, "instance.compileDraft");
  assertSynchronousFunction(
    instance.finalizeDescriptor,
    "instance.finalizeDescriptor",
  );
  assertSynchronousFunction(
    instance.staticBindingProjection,
    "instance.staticBindingProjection",
  );
  if (instance.staticEvidence !== undefined) {
    validateRequestProgram(instance.staticEvidence, "instance.staticEvidence", true);
  }
}

function validateRoutes(routes: RouteProjectionSemantics<any, any>): void {
  assertPlainRecord(routes, "route projection semantics");
  assertExactKeys(
    routes,
    ["project", "projectGraph"],
    "route projection semantics",
  );
  assertSynchronousFunction(routes.project, "routes.project");
  assertSynchronousFunction(routes.projectGraph, "routes.projectGraph");
}

function validatePricing(pricing: PricingSemantics<any, any, any, any, any, any>): void {
  assertPlainRecord(pricing, "pricing semantics");
  assertExactKeys(
    pricing,
    [
      "compileDraft",
      "current",
      "dependencies",
      "finalizePricingDescriptor",
      "liveStateProjection",
      "mutation",
      "snapshotCompatibilityProjection",
      "stateKey",
      "staticBindingProjection",
      "staticEvidence",
    ],
    "pricing semantics",
    true,
    [
      "compileDraft",
      "current",
      "dependencies",
      "finalizePricingDescriptor",
      "snapshotCompatibilityProjection",
      "stateKey",
      "staticBindingProjection",
    ],
  );
  assertSynchronousFunction(pricing.stateKey, "pricing.stateKey");
  assertSynchronousFunction(
    pricing.staticBindingProjection,
    "pricing.staticBindingProjection",
  );
  assertSynchronousFunction(
    pricing.snapshotCompatibilityProjection,
    "pricing.snapshotCompatibilityProjection",
  );
  assertSynchronousFunction(pricing.compileDraft, "pricing.compileDraft");
  assertSynchronousFunction(
    pricing.finalizePricingDescriptor,
    "pricing.finalizePricingDescriptor",
  );
  assertSynchronousFunction(pricing.dependencies, "pricing.dependencies");
  if (pricing.staticEvidence !== undefined) {
    validateRequestProgram(pricing.staticEvidence, "pricing.staticEvidence", true);
  }
  assertPlainRecord(pricing.current, "pricing.current");
  assertExactKeys(
    pricing.current,
    [
      "buildDependentProgram",
      "buildRequests",
      "classifyUnavailable",
      "decodeSnapshot",
      "deriveMids",
      "requirements",
    ],
    "pricing.current",
    true,
    ["buildRequests", "decodeSnapshot", "deriveMids", "requirements"],
  );
  assertSynchronousFunction(
    pricing.current.requirements,
    "pricing.current.requirements",
  );
  assertSynchronousFunction(
    pricing.current.buildRequests,
    "pricing.current.buildRequests",
  );
  if (pricing.current.buildDependentProgram !== undefined) {
    assertSynchronousFunction(
      pricing.current.buildDependentProgram,
      "pricing.current.buildDependentProgram",
    );
  }
  assertSynchronousFunction(
    pricing.current.decodeSnapshot,
    "pricing.current.decodeSnapshot",
  );
  assertSynchronousFunction(
    pricing.current.deriveMids,
    "pricing.current.deriveMids",
  );
  if (pricing.current.classifyUnavailable !== undefined) {
    assertSynchronousFunction(
      pricing.current.classifyUnavailable,
      "pricing.current.classifyUnavailable",
    );
  }
  if (pricing.mutation !== undefined) {
    assertPlainRecord(pricing.mutation, "pricing.mutation");
    assertExactKeys(
      pricing.mutation,
      ["affectedStateKeys"],
      "pricing.mutation",
    );
    assertSynchronousFunction(
      pricing.mutation.affectedStateKeys,
      "pricing.mutation.affectedStateKeys",
    );
  }
  if (pricing.liveStateProjection !== undefined) {
    assertPlainRecord(pricing.liveStateProjection, "pricing.liveStateProjection");
    assertExactKeys(
      pricing.liveStateProjection,
      ["project"],
      "pricing.liveStateProjection",
    );
    assertSynchronousFunction(
      pricing.liveStateProjection.project,
      "pricing.liveStateProjection.project",
    );
  }
}

function validateExact(exact: ExactQuoteSemantics<any, any, any>): void {
  assertPlainRecord(exact, "exact semantics");
  assertExactKeys(
    exact,
    [
      "cacheCompatibilityProjection",
      "methods",
    ],
    "exact semantics",
  );
  assertSynchronousFunction(exact.methods, "exact.methods");
  assertSynchronousFunction(
    exact.cacheCompatibilityProjection,
    "exact.cacheCompatibilityProjection",
  );
}

function validateExecution(execution: ExecutionSemantics<any, any, any>): void {
  assertPlainRecord(execution, "execution semantics");
  assertExactKeys(
    execution,
    ["buildFragment", "expectedEffects", "runtimeProjection"],
    "execution semantics",
  );
  assertSynchronousFunction(execution.buildFragment, "execution.buildFragment");
  assertSynchronousFunction(execution.expectedEffects, "execution.expectedEffects");
  assertSynchronousFunction(
    execution.runtimeProjection,
    "execution.runtimeProjection",
  );
}

function validateSharedBindings(shared: SharedBindingSemantics<any>): void {
  assertPlainRecord(shared, "shared binding semantics");
  assertExactKeys(
    shared,
    ["canonicalProjection", "program", "references"],
    "shared binding semantics",
  );
  assertSynchronousFunction(shared.references, "sharedBindings.references");
  assertSynchronousFunction(
    shared.canonicalProjection,
    "sharedBindings.canonicalProjection",
  );
  validateRequestProgram(shared.program, "sharedBindings.program", false);
}

function validateOptional(optional: OptionalFamilySemantics<any, any>): void {
  assertPlainRecord(optional, "optional family semantics");
  assertExactKeys(
    optional,
    ["pendingEvidence", "preparedQuote"],
    "optional family semantics",
    true,
  );
  if (optional.pendingEvidence !== undefined) {
    validateRequestProgram(optional.pendingEvidence, "optional.pendingEvidence", false);
  }
  if (optional.preparedQuote !== undefined) {
    validateRequestProgram(optional.preparedQuote, "optional.preparedQuote", false);
  }
}

function validateRequestProgram(
  program: RequestProgram<any, any>,
  label: string,
  allowStatic: boolean,
): void {
  assertPlainRecord(program, label);
  assertExactKeys(
    program,
    allowStatic
      ? ["buildRequests", "decode", "requirements", "reusePolicy"]
      : ["buildRequests", "decode", "requirements"],
    label,
    allowStatic,
    ["buildRequests", "decode", "requirements"],
  );
  assertSynchronousFunction(program.requirements, `${label}.requirements`);
  assertSynchronousFunction(program.buildRequests, `${label}.buildRequests`);
  assertSynchronousFunction(program.decode, `${label}.decode`);
  if ("reusePolicy" in program) {
    if (!allowStatic) throw new Error(`${label} cannot declare reusePolicy`);
    const staticProgram = program as StaticEvidenceProgram<any, any>;
    assertPlainRecord(staticProgram.reusePolicy, `${label}.reusePolicy`);
    assertExactKeys(
      staticProgram.reusePolicy,
      ["codeSubjects", "dependencyKeys", "kind"],
      `${label}.reusePolicy`,
      true,
      ["kind"],
    );
    switch (staticProgram.reusePolicy.kind) {
      case "source-local":
        assertExactKeys(
          staticProgram.reusePolicy,
          ["kind"],
          `${label}.reusePolicy`,
        );
        break;
      case "immutable-code":
        assertExactKeys(
          staticProgram.reusePolicy,
          ["codeSubjects", "kind"],
          `${label}.reusePolicy`,
        );
        stringSet(
          staticProgram.reusePolicy.codeSubjects,
          `${label}.reusePolicy.codeSubjects`,
          true,
        );
        break;
      case "dependency-proof":
        assertExactKeys(
          staticProgram.reusePolicy,
          ["dependencyKeys", "kind"],
          `${label}.reusePolicy`,
        );
        assertSynchronousFunction(
          staticProgram.reusePolicy.dependencyKeys,
          `${label}.reusePolicy.dependencyKeys`,
        );
        break;
      default:
        throw new Error(`${label} has unsupported reuse policy`);
    }
  }
}

function validateActions(
  actions: readonly FamilyOwnedActionAdapter[],
  manifest: FamilyManifest<FamilyDomain>,
): void {
  if (!Array.isArray(actions)) throw new Error("actionAdapters must be an array");
  const supplied = new Set<string>();
  const owned = new Set<string>(manifest.ownedActionAdapterIds);
  for (const action of actions) {
    assertBoundFamilyOwnedAction(action);
    assertPlainRecord(action, "family ActionAdapter");
    assertExactKeys(
      action,
      [
        "descriptor",
        "encode",
        "field2Offset",
        "id",
        "isWrapper",
        "matchTrace",
      ],
      "family ActionAdapter",
    );
    const id = nonemptyString(action.id, "ActionAdapter id");
    if (supplied.has(id)) throw new Error(`duplicate ActionAdapter ${id}`);
    supplied.add(id);
    if (!owned.has(id)) {
      throw new Error(`${manifest.familyId} supplies unowned ActionAdapter ${id}`);
    }
    if (typeof action.isWrapper !== "boolean") {
      throw new Error(`ActionAdapter ${id} isWrapper must be boolean`);
    }
    if (
      action.field2Offset !== null &&
      typeof action.field2Offset !== "number" &&
      typeof action.field2Offset !== "function"
    ) {
      throw new Error(`ActionAdapter ${id} field2Offset is invalid`);
    }
    if (typeof action.field2Offset === "function") {
      assertSynchronousFunction(
        action.field2Offset,
        `ActionAdapter ${id}.field2Offset`,
      );
    }
    assertSynchronousFunction(action.encode, `ActionAdapter ${id}.encode`);
    assertSynchronousFunction(action.matchTrace, `ActionAdapter ${id}.matchTrace`);
    assertPlainRecord(action.descriptor, `ActionAdapter ${id}.descriptor`);
    assertExactKeys(
      action.descriptor,
      [
        "adapterId",
        "lineage",
        "edgeKind",
        "action",
        "canSendValue",
        "leavesStandingPositionDefault",
      ],
      `ActionAdapter ${id}.descriptor`,
    );
    if (action.descriptor.adapterId !== id) {
      throw new Error(`ActionAdapter ${id} descriptor adapterId does not match`);
    }
    nonemptyString(action.descriptor.lineage, `ActionAdapter ${id} lineage`);
    nonemptyString(action.descriptor.action, `ActionAdapter ${id} action`);
    if (
      typeof action.descriptor.canSendValue !== "boolean" ||
      typeof action.descriptor.leavesStandingPositionDefault !== "boolean"
    ) {
      throw new Error(`ActionAdapter ${id} descriptor flags must be boolean`);
    }
    const expectedEdgeKind = edgeKindForDomain(manifest.domain);
    if (action.descriptor.edgeKind !== expectedEdgeKind) {
      throw new Error(
        `ActionAdapter ${id} descriptor edgeKind must be ${expectedEdgeKind}`,
      );
    }
    if (manifest.domain === "funding") {
      if (
        action.descriptor.action !== "flash" ||
        action.descriptor.leavesStandingPositionDefault
      ) {
        throw new Error(
          `ActionAdapter ${id} funding descriptor must be an atomic flash action`,
        );
      }
    }
    if (manifest.domain === "credit") {
      const creditActions = new Set(["borrow", "repay", "supply", "withdraw"]);
      if (
        !creditActions.has(action.descriptor.action) ||
        !action.descriptor.leavesStandingPositionDefault
      ) {
        throw new Error(
          `ActionAdapter ${id} credit descriptor must preserve standing-position risk`,
        );
      }
    }
  }
  if (supplied.size !== owned.size) {
    const missing = [...owned].filter((id) => !supplied.has(id));
    throw new Error(
      `${manifest.familyId} must supply exactly its owned ActionAdapters ` +
        `(missing=${missing.join(",")})`,
    );
  }
}

function edgeKindForDomain(
  domain: FamilyDomain,
): "swap" | "protocol" | "flash" | "credit" {
  switch (domain) {
    case "swap":
      return "swap";
    case "protocol":
      return "protocol";
    case "funding":
      return "flash";
    case "credit":
      return "credit";
  }
}

function validateFundingDomain(
  funding: FundingDomainSemantics<FundingSourceDescriptor, unknown>,
  manifest: FamilyManifest<FamilyDomain>,
): void {
  assertPlainRecord(funding, "funding domain semantics");
  assertExactKeys(
    funding,
    ["liquidity", "repayment"],
    "funding domain semantics",
  );
  assertPlainRecord(funding.liquidity, "funding.liquidity");
  assertExactKeys(
    funding.liquidity,
    ["deriveOffers", "program", "sources"],
    "funding.liquidity",
  );
  assertSynchronousFunction(
    funding.liquidity.sources,
    "funding.liquidity.sources",
  );
  validateRequestProgram(
    funding.liquidity.program,
    "funding.liquidity.program",
    false,
  );
  assertSynchronousFunction(
    funding.liquidity.deriveOffers,
    "funding.liquidity.deriveOffers",
  );

  assertPlainRecord(funding.repayment, "funding.repayment");
  assertExactKeys(
    funding.repayment,
    [
      "buildBorrowFragment",
      "buildRepaymentFragment",
      "liquidityHolder",
      "mode",
      "paramShape",
      "target",
    ],
    "funding.repayment",
  );
  nonemptyString(funding.repayment.target, "funding repayment target");
  nonemptyString(
    funding.repayment.liquidityHolder,
    "funding repayment liquidityHolder",
  );
  if (
    funding.repayment.mode !== "approve-pull" &&
    funding.repayment.mode !== "transfer"
  ) {
    throw new Error(`${manifest.familyId} has unsupported funding repayment mode`);
  }
  if (
    funding.repayment.paramShape !== "none" &&
    funding.repayment.paramShape !== "tokens-and-amounts"
  ) {
    throw new Error(`${manifest.familyId} has unsupported funding paramShape`);
  }
  assertSynchronousFunction(
    funding.repayment.buildBorrowFragment,
    "funding.repayment.buildBorrowFragment",
  );
  assertSynchronousFunction(
    funding.repayment.buildRepaymentFragment,
    "funding.repayment.buildRepaymentFragment",
  );
}

function validateCreditDomain(
  credit: CreditDomainSemantics<
    CompiledInstanceDescriptor,
    FamilyRouteDescriptor,
    unknown
  >,
): void {
  assertPlainRecord(credit, "credit domain semantics");
  assertExactKeys(
    credit,
    ["activeBehaviorProof", "position", "risk"],
    "credit domain semantics",
  );
  if (credit.activeBehaviorProof !== "required") {
    throw new Error("credit activeBehaviorProof must be required");
  }
  assertPlainRecord(credit.position, "credit.position");
  assertExactKeys(
    credit.position,
    ["finalSafety", "lifecycle", "positionKey"],
    "credit.position",
  );
  if (credit.position.lifecycle !== "standing-position") {
    throw new Error("credit position lifecycle must be standing-position");
  }
  if (credit.position.finalSafety !== "position-and-repayment-required") {
    throw new Error(
      "credit position finalSafety must require position and repayment",
    );
  }
  assertSynchronousFunction(
    credit.position.positionKey,
    "credit.position.positionKey",
  );

  assertPlainRecord(credit.risk, "credit.risk");
  assertExactKeys(
    credit.risk,
    [
      "blocksPrefixInversion",
      "debtBpsCandidates",
      "evidence",
      "quoteOutputByDebtBps",
    ],
    "credit.risk",
    true,
    [
      "blocksPrefixInversion",
      "debtBpsCandidates",
      "quoteOutputByDebtBps",
    ],
  );
  if (credit.risk.blocksPrefixInversion !== true) {
    throw new Error("credit risk must block prefix inversion");
  }
  if (
    !Array.isArray(credit.risk.debtBpsCandidates) ||
    credit.risk.debtBpsCandidates.length === 0
  ) {
    throw new Error("credit risk must declare debtBpsCandidates");
  }
  let previous = 0n;
  for (const candidate of credit.risk.debtBpsCandidates) {
    if (typeof candidate !== "bigint" || candidate <= previous) {
      throw new Error(
        "credit debtBpsCandidates must be positive, unique and ascending",
      );
    }
    previous = candidate;
  }
  assertSynchronousFunction(
    credit.risk.quoteOutputByDebtBps,
    "credit.risk.quoteOutputByDebtBps",
  );
  if (credit.risk.evidence !== undefined) {
    validateRequestProgram(
      credit.risk.evidence,
      "credit.risk.evidence",
      false,
    );
  }
}

function validateSwapDomain(
  swap: SwapDomainSemantics,
  discovery: DiscoverySemantics<any>,
): void {
  assertPlainRecord(swap, "swap domain semantics");
  assertExactKeys(swap, [
    "landedEvents",
    "localApply",
    "observation",
    "overlay",
    "poolMaterialization",
    "replay",
    "victimSupport",
  ], "swap domain semantics", true, ["landedEvents", "observation", "victimSupport"]);
  const patternIds = new Set(discoveryPatternIds(discovery));
  assertExactKeys(
    swap.landedEvents,
    ["classify", "patternIds"],
    "swap.landedEvents",
  );
  validatePatternConsumer(swap.landedEvents, "swap.landedEvents", patternIds);
  assertSynchronousFunction(swap.landedEvents.classify, "swap.landedEvents.classify");
  assertExactKeys(
    swap.observation,
    ["decode", "patternIds"],
    "swap.observation",
  );
  validatePatternConsumer(swap.observation, "swap.observation", patternIds);
  assertSynchronousFunction(swap.observation.decode, "swap.observation.decode");
  if (swap.poolMaterialization !== undefined) {
    assertExactKeys(
      swap.poolMaterialization,
      ["candidateBinding", "patternIds"],
      "swap.poolMaterialization",
    );
    validatePatternConsumer(
      swap.poolMaterialization,
      "swap.poolMaterialization",
      patternIds,
    );
    assertSynchronousFunction(
      swap.poolMaterialization.candidateBinding,
      "swap.poolMaterialization.candidateBinding",
    );
  }
  if (swap.localApply !== undefined) {
    assertPlainRecord(swap.localApply, "swap.localApply");
    assertExactKeys(swap.localApply, ["apply"], "swap.localApply");
    assertSynchronousFunction(swap.localApply.apply, "swap.localApply.apply");
  }
  if (swap.overlay !== undefined) {
    assertPlainRecord(swap.overlay, "swap.overlay");
    assertExactKeys(swap.overlay, ["build"], "swap.overlay");
    assertSynchronousFunction(swap.overlay.build, "swap.overlay.build");
  }
  if (swap.replay !== undefined) {
    assertPlainRecord(swap.replay, "swap.replay");
    assertExactKeys(
      swap.replay,
      ["applyLocal", "bind", "buildOverlay", "exactPostState"],
      "swap.replay",
      true,
      ["applyLocal", "bind", "buildOverlay"],
    );
    assertSynchronousFunction(swap.replay.bind, "swap.replay.bind");
    assertSynchronousFunction(
      swap.replay.applyLocal,
      "swap.replay.applyLocal",
    );
    if (swap.replay.exactPostState !== undefined) {
      assertSynchronousFunction(
        swap.replay.exactPostState,
        "swap.replay.exactPostState",
      );
    }
    assertSynchronousFunction(
      swap.replay.buildOverlay,
      "swap.replay.buildOverlay",
    );
  }
  switch (swap.victimSupport) {
    case "none":
    case "detect-only":
      if (
        swap.localApply !== undefined ||
        swap.overlay !== undefined ||
        swap.replay !== undefined
      ) {
        throw new Error(`${swap.victimSupport} victim support cannot declare replay callbacks`);
      }
      break;
    case "local-apply":
      if (
        swap.localApply === undefined ||
        swap.overlay !== undefined ||
        swap.replay !== undefined
      ) {
        throw new Error("local-apply victim support requires only localApply");
      }
      break;
    case "overlay":
      if (
        swap.overlay === undefined ||
        swap.localApply !== undefined ||
        swap.replay !== undefined
      ) {
        throw new Error("overlay victim support requires only overlay");
      }
      break;
    case "replay":
      if (
        swap.replay === undefined ||
        swap.localApply !== undefined ||
        swap.overlay !== undefined
      ) {
        throw new Error("replay victim support requires only the combined replay contract");
      }
      break;
    default:
      throw new Error(`unsupported swap victimSupport ${String(swap.victimSupport)}`);
  }
}

function validateProtocolDomain(
  protocol: ProtocolDomainSemantics,
  discovery: DiscoverySemantics<any>,
): void {
  assertPlainRecord(protocol, "protocol domain semantics");
  assertExactKeys(
    protocol,
    ["activeBehaviorProof", "candidateKinds", "oracleVictim"],
    "protocol domain semantics",
    true,
    ["activeBehaviorProof", "candidateKinds"],
  );
  if (protocol.activeBehaviorProof !== "required") {
    throw new Error("protocol activeBehaviorProof must be required");
  }
  const candidates = stringSet(protocol.candidateKinds, "protocol candidateKinds", true);
  const known = new Set<ProtocolCandidateKind>([
    "observed-call",
    "address-surface",
    "factory-child",
    "registry-member",
    "standalone-contract",
  ]);
  for (const candidate of candidates) {
    if (!known.has(candidate as ProtocolCandidateKind)) {
      throw new Error(`unsupported protocol candidate kind ${candidate}`);
    }
  }
  if (candidates.has("observed-call") &&
      !discovery.sources.includes("observed-call")) {
    throw new Error("observed-call protocol candidates require an observed-call source");
  }
  if (candidates.has("address-surface") &&
      !discovery.sources.includes("address-surface")) {
    throw new Error("address-surface protocol candidates require an address-surface source");
  }
  if (protocol.oracleVictim !== undefined) {
    assertPlainRecord(protocol.oracleVictim, "protocol.oracleVictim");
    assertExactKeys(
      protocol.oracleVictim,
      ["callPatterns", "decode"],
      "protocol.oracleVictim",
    );
    if (!Array.isArray(protocol.oracleVictim.callPatterns) ||
        protocol.oracleVictim.callPatterns.length === 0) {
      throw new Error("protocol oracleVictim must declare call patterns");
    }
    for (const pattern of protocol.oracleVictim.callPatterns) {
      validateCallPattern(pattern, "protocol oracleVictim call pattern");
    }
    assertSynchronousFunction(
      protocol.oracleVictim.decode,
      "protocol.oracleVictim.decode",
    );
  }
}

function validatePatternConsumer(
  consumer: { readonly patternIds: readonly string[] },
  label: string,
  discoveryIds: ReadonlySet<string>,
): void {
  assertPlainRecord(consumer, label);
  const ids = stringSet(consumer.patternIds, `${label}.patternIds`, true);
  for (const id of ids) {
    if (!discoveryIds.has(id)) {
      throw new Error(`${label} references unknown discovery pattern ${id}`);
    }
  }
}

function discoveryPatternIds(
  discovery: DiscoverySemantics<any>,
): readonly string[] {
  return [
    ...(discovery.callPatterns ?? []).map((pattern) => pattern.id),
    ...(discovery.logPatterns ?? []).map((pattern) => pattern.id),
    ...(discovery.addressSurfaces ?? []).map((pattern) => pattern.id),
  ];
}

function taxonomyKey(item: AllowedTaxonomy): string {
  return `${item.slotKind}/${item.protocolAction ?? "none"}`;
}

function stringSet(
  value: readonly unknown[],
  label: string,
  nonempty: boolean,
): Set<string> {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    throw new Error(`${label} must be ${nonempty ? "a non-empty" : "an"} array`);
  }
  const result = new Set<string>();
  for (const item of value) {
    const normalized = nonemptyString(item, label);
    if (result.has(normalized)) throw new Error(`${label} contains duplicate ${normalized}`);
    result.add(normalized);
  }
  return result;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function assertIdentifier(value: unknown, label: string): void {
  nonemptyString(value, label);
}

function assertHex(value: unknown, bytes: number, label: string): void {
  if (typeof value !== "string" ||
      !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${label} must be ${bytes}-byte hex`);
  }
}

function assertHexData(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be even-length hex data`);
  }
}

function assertSynchronousFunction(value: unknown, label: string): void {
  if (typeof value !== "function") throw new Error(`${label} must be a function`);
  if (value.constructor?.name === "AsyncFunction") {
    throw new Error(`${label} must be synchronous`);
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string,
  optional = false,
  requiredKeys: readonly string[] = optional ? [] : allowedKeys,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${label} has unknown field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label}.${key} must be an enumerable data field`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing required field ${key}`);
    }
  }
}

function deepFreezeDefinition(
  value: unknown,
  path: string,
  stack: Set<object>,
): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  if (typeof value === "function") {
    deepFreezeFunction(value, path, stack);
    return;
  }
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) &&
      prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain records and arrays`);
  }
  stack.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${path} must not contain sparse arrays`);
      }
      deepFreezeDefinition(value[index], `${path}.${index}`, stack);
    }
    const expected = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !expected.has(key)) {
        throw new Error(`${path} array has unsupported field ${String(key)}`);
      }
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(`${path} must not contain symbol fields`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new Error(`${path}.${key} must be an enumerable data field`);
      }
      deepFreezeDefinition(descriptor.value, `${path}.${key}`, stack);
    }
  }
  stack.delete(value);
  Object.freeze(value);
}

function deepFreezeFunction(
  value: Function,
  path: string,
  stack: Set<object>,
): void {
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    // These are engine-owned poison-pill accessors on ordinary functions.
    if (key === "arguments" || key === "caller") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${path}.${String(key)} must be a data field`);
    }
    if (key === "prototype" && descriptor.value !== undefined) {
      deepFreezeFunctionPrototype(
        descriptor.value,
        `${path}.prototype`,
        stack,
        value,
      );
    } else {
      deepFreezeDefinition(
        descriptor.value,
        `${path}.${String(key)}`,
        stack,
      );
    }
  }
  stack.delete(value);
  Object.freeze(value);
}

function deepFreezeFunctionPrototype(
  value: unknown,
  path: string,
  stack: Set<object>,
  owner: Function,
): void {
  if (value === null || typeof value !== "object") return;
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain function prototype`);
  }
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${path}.${String(key)} must be a data field`);
    }
    if (key === "constructor" && descriptor.value === owner) continue;
    deepFreezeDefinition(
      descriptor.value,
      `${path}.${String(key)}`,
      stack,
    );
  }
  stack.delete(value);
  Object.freeze(value);
}
