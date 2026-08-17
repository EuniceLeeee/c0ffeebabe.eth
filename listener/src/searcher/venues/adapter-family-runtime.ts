import {
  executeAdapterWork,
  type AdapterWorkOutcome,
  type AdapterWorkControl,
  type CentralAdapterRuntime,
} from "../adapter-work-intent.js";
import {
  assertIssuedAdapterFamilyLifecycleContentCache,
  type AdapterStaticEvidenceStage,
} from "../adapter-family-lifecycle-content-cache.js";
import {
  assertIssuedAdapterFamilyExactQuoteCache,
  type AdapterExactQuoteCacheAddress,
} from "../adapter-family-exact-quote-cache.js";
import {
  assertDefinedFamilyPlugin,
  type CompiledInstanceDescriptor,
  type BoundRequestProgram,
  type DiscoverySemantics,
  type ExactMethod,
  type ExactQuoteInput,
  type ExactRequestProgram,
  type ExactQuoteResult,
  type ExpectedEffect,
  type FamilyCandidate,
  type FamilyManifest,
  type FamilyRouteDescriptor,
  type FamilySharedBindingRef,
  type SharedBindingRequestKey,
  type IdentityVariant,
  type IdentitySemantics,
  type InstanceSemantics,
  type NormalizedSwapVictimImpact,
  type RuntimeEvidence,
  type SwapDomainSemantics,
  type UnifiedObservation,
  type VerifiedIdentity,
  type VictimReplayLocalResult,
  type VictimReplayOverlayIntent,
} from "./adapter-family-plugin.js";
import type {
  FamilyId,
  InstanceKey,
  LineageId,
  RouteKey,
} from "./adapter-family-identifiers.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
  ExecutedProgram,
  RequestProgram,
  RequestRequirements,
  StaticEvidenceProgram,
} from "./adapter-request-program.js";
import { requestSetFingerprint } from "./adapter-request-program.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import type {
  FamilyCapabilityCatalog,
  LoadedFamilyBox,
  LoadedFamilyPlugin,
} from "./family-capability-catalog.js";
import { assertIssuedLoadedFamilyBox } from "./family-capability-catalog.js";
import type { RouteVenueMid } from "./mid-readers.js";
import type { PlanFragment } from "./route-leg-adapter.js";
import type { ResolvedPlanNode } from "../../types.js";

export type AdapterInstanceStage =
  | "discovery"
  | "identity"
  | "instance-compile"
  | "route-projection"
  | "pricing-compile"
  | "pricing-current"
  | "exact"
  | "victim-replay"
  | "execution";

export type AdapterInstanceStatus =
  | "candidate"
  | "verified"
  | "rejected"
  | "unsupported-variant"
  | "unresolved"
  | "failed";

export interface AdapterInstanceOutcome {
  readonly familyId: FamilyId;
  readonly lineageId?: LineageId;
  readonly candidateKey: string;
  readonly instanceKey?: InstanceKey;
  readonly stateKey?: string;
  readonly routeKey?: RouteKey;
  readonly stage: AdapterInstanceStage;
  readonly status: AdapterInstanceStatus;
  readonly reasonCode: string;
  readonly source: CanonicalSource;
  readonly evidenceRefs: readonly string[];
}

export interface PreparedPricingStateInstance {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly stateKey: string;
  readonly stateInstanceKey: string;
  readonly routes: readonly FamilyRouteDescriptor[];
  readonly pricingDescriptor: object;
  readonly snapshot: object;
  readonly mids: ReadonlyMap<RouteKey, RouteVenueMid>;
  readonly unavailable: ReadonlyMap<RouteKey, string>;
  readonly dependencies: readonly string[];
  /** Framework-owned ownership/binding integrity, independent of Family projection. */
  readonly groupBindingFingerprint: string;
  readonly staticBindingFingerprint: string;
  readonly snapshotCompatibilityFingerprint: string;
  readonly staticEvidenceFingerprint: string;
  readonly currentEvidenceFingerprint: string;
  readonly evidenceRefs: readonly string[];
}

export interface PreparedFamilyInstance {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly descriptor: CompiledInstanceDescriptor;
  /** Only routes backed by a successfully decoded StateInstance are present. */
  readonly routes: readonly FamilyRouteDescriptor[];
  /**
   * Process-local route capabilities issued by the central runtime. Callers
   * must pass these handles, never a structurally similar route descriptor,
   * across the exact/execution boundary.
   */
  readonly routeHandles: readonly FamilyRouteRuntimeHandle[];
  readonly pricingInstances: readonly PreparedPricingStateInstance[];
  readonly staticBindingFingerprint: string;
  readonly staticEvidenceFingerprint: string;
  readonly evidenceRefs: readonly string[];
}

export interface AdapterFamilyPublication {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly instances: readonly PreparedFamilyInstance[];
  readonly outcomes: readonly AdapterInstanceOutcome[];
  readonly publicationFingerprint: string;
}

export interface AdapterFamilyPublicationSink {
  /** The generation fence is checked immediately before this synchronous CAS. */
  publish(publication: AdapterFamilyPublication): void;
}

export interface FamilyLifecycleMatch {
  readonly observation: UnifiedObservation;
  readonly matchedPatternId: string;
}

export interface AdapterFamilyLifecycleLimits {
  readonly maxIdentityStepsPerVariant: number;
  readonly maxDependentReadRounds: number;
}

export interface AdapterFamilyLifecycleResult {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly outcomes: readonly AdapterInstanceOutcome[];
  readonly publication: AdapterFamilyPublication | null;
}

/** Shadow Credit lifecycle result; no production publication is implied. */
export interface CreditFamilyInstanceLifecycleResult {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly instance: PreparedFamilyInstance | null;
  readonly outcomes: readonly AdapterInstanceOutcome[];
}

declare const familyRouteRuntimeHandleTypeBrand: unique symbol;

/**
 * Opaque, process-local authority for one route in one catalog-issued Family
 * box and one prepared publication. Runtime authenticity is held in a private
 * WeakMap; the type brand is only an additional compile-time guard.
 */
export interface FamilyRouteRuntimeHandle {
  readonly [familyRouteRuntimeHandleTypeBrand]: "family-route-runtime-handle";
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
}

declare const sealedFamilyExactQuoteHandleTypeBrand: unique symbol;

/**
 * Public exact result metadata. Protocol-owned exact evidence is deliberately
 * absent: it remains sealed in the private handle record and can only flow to
 * the matching Family execution closure.
 */
export interface SealedFamilyExactQuoteHandle {
  readonly [sealedFamilyExactQuoteHandleTypeBrand]:
    "sealed-family-exact-quote-handle";
  readonly status: "resolved";
  readonly familyId: FamilyId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly methodId: string;
  readonly methodIndex: number;
  readonly methodOrderFingerprint: string;
  readonly cacheCompatibilityFingerprint: string;
  readonly evidenceRefs: readonly string[];
  readonly outcome: AdapterInstanceOutcome;
}

export type ResolvedFamilyExactQuote = SealedFamilyExactQuoteHandle;

export interface TerminalFamilyExactQuote {
  readonly status: "unresolved" | "failed";
  readonly outcome: AdapterInstanceOutcome;
}

export type FamilyExactQuoteOutcome =
  | ResolvedFamilyExactQuote
  | TerminalFamilyExactQuote;

export interface ResolvedFamilyVictimReplay {
  readonly status: "resolved";
  readonly familyId: FamilyId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly route: FamilyRouteRuntimeHandle;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly impact: NormalizedSwapVictimImpact;
  readonly localApply: VictimReplayLocalResult | null;
  readonly exactPostState: CanonicalValue | null;
  readonly overlay: VictimReplayOverlayIntent | null;
  readonly validUntil: bigint;
  readonly evidenceRefs: readonly string[];
  readonly outcome: AdapterInstanceOutcome;
}

export interface TerminalFamilyVictimReplay {
  readonly status: "rejected" | "unresolved" | "failed";
  readonly outcome: AdapterInstanceOutcome;
}

export type FamilyVictimReplayOutcome =
  | ResolvedFamilyVictimReplay
  | TerminalFamilyVictimReplay;

export interface FamilyVictimReplayInvocation {
  readonly family: LoadedFamilyPlugin;
  readonly route: FamilyRouteRuntimeHandle;
  readonly impact: NormalizedSwapVictimImpact;
  readonly preState: CanonicalValue | null;
  readonly validUntil: bigint;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: Pick<CentralAdapterRuntime, "generationFence">;
}

export interface ResolvedFamilyExecution {
  readonly status: "resolved";
  readonly fragment: PlanFragment;
  readonly expectedEffects: readonly ExpectedEffect[];
  readonly outcome: AdapterInstanceOutcome;
}

export interface TerminalFamilyExecution {
  readonly status: "rejected" | "failed";
  readonly outcome: AdapterInstanceOutcome;
}

export type FamilyExecutionOutcome =
  | ResolvedFamilyExecution
  | TerminalFamilyExecution;

interface FamilyRouteRuntimeHandleRecord {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly route: FamilyRouteDescriptor;
  readonly source: CanonicalSource;
  readonly generation: number;
}

interface PreparedFamilyInstanceIssue {
  readonly family: LoadedFamilyBox;
  readonly source: CanonicalSource;
  readonly generation: number;
}

interface PreparedPricingStateInstanceIssue extends PreparedFamilyInstanceIssue {
  readonly instance: PreparedFamilyInstance;
  readonly integrityFingerprint: string;
}

interface SealedFamilyExactQuoteHandleRecord {
  readonly family: LoadedFamilyPlugin;
  readonly routeHandle: FamilyRouteRuntimeHandle;
  readonly routeRecord: FamilyRouteRuntimeHandleRecord;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly evidence: unknown;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
  readonly runtimeEvidenceFingerprint: string;
  readonly source: CanonicalSource;
  readonly generation: number;
}

const issuedFamilyRouteRuntimeHandles = new WeakMap<
  object,
  FamilyRouteRuntimeHandleRecord
>();
const issuedPreparedFamilyInstances = new WeakMap<
  object,
  PreparedFamilyInstanceIssue
>();
const issuedPreparedPricingStateInstances = new WeakMap<
  object,
  PreparedPricingStateInstanceIssue
>();
const issuedSealedFamilyExactQuoteHandles = new WeakMap<
  object,
  SealedFamilyExactQuoteHandleRecord
>();

const DEFAULT_LIMITS: AdapterFamilyLifecycleLimits = Object.freeze({
  maxIdentityStepsPerVariant: 4,
  maxDependentReadRounds: 4,
});

interface CandidateContext {
  readonly candidate: FamilyCandidate;
  readonly candidateKey: string;
}

type RuntimeInstanceLifecyclePlugin = {
  readonly manifest: FamilyManifest<"swap" | "protocol" | "credit">;
  readonly discovery: DiscoverySemantics<FamilyCandidate>;
  readonly identity: IdentitySemantics<FamilyCandidate, VerifiedIdentity>;
  readonly instance: InstanceSemantics<
    VerifiedIdentity,
    CompiledInstanceDescriptor,
    object,
    unknown
  >;
};

interface DecodedCandidateMatch extends CandidateContext {
  readonly match: FamilyLifecycleMatch;
  readonly candidateFingerprint: string;
}

interface VerifiedIdentityResult {
  readonly status: "verified";
  readonly identity: VerifiedIdentity;
  readonly evidenceRefs: readonly string[];
}

interface TerminalIdentityResult {
  readonly status: Exclude<AdapterInstanceStatus, "candidate" | "verified">;
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
}

type IdentityResult = VerifiedIdentityResult | TerminalIdentityResult;

interface PreparedCandidate {
  readonly instance: PreparedFamilyInstance | null;
  readonly outcomes: readonly AdapterInstanceOutcome[];
}

interface PricingPreparation {
  readonly state: PreparedPricingStateInstance | null;
  readonly outcomes: readonly AdapterInstanceOutcome[];
}

interface IdentityProgramEvidence {
  readonly evidence: unknown;
  readonly successfulResultCount: number;
}

interface ResultSetEvidence {
  readonly results: readonly AdapterRequestResult[];
}

interface SharedBindingProgramEvidence {
  readonly canonicalProjection: CanonicalValue;
}

interface ResolvedSharedBinding {
  readonly status: "resolved";
  readonly ref: FamilySharedBindingRef;
  readonly evidenceRefs: readonly string[];
}

interface UnresolvedSharedBinding {
  readonly status: "unresolved";
  readonly work: Extract<AdapterWorkOutcome<unknown>, { status: "unresolved" }>;
}

type SharedBindingResolution =
  | ResolvedSharedBinding
  | UnresolvedSharedBinding;

interface FamilySharedBindingBatchResolver {
  resolve(request: SharedBindingRequestKey): Promise<SharedBindingResolution>;
}

interface ResolvedStaticEvidenceWork<Evidence> {
  readonly status: "resolved";
  readonly executed: ExecutedProgram<Evidence>;
  readonly cacheKey?: string;
}

type StaticEvidenceWorkOutcome<Evidence> =
  | ResolvedStaticEvidenceWork<Evidence>
  | Extract<AdapterWorkOutcome<Evidence>, { readonly status: "unresolved" }>;

const issuedFamilySharedBindingRefs = new WeakSet<object>();

function snapshotCanonicalSource(source: CanonicalSource): CanonicalSource {
  return Object.freeze({
    number: source.number,
    hash: source.hash,
    generation: source.generation,
  });
}

function snapshotFamilyLifecycleMatch(
  match: FamilyLifecycleMatch,
): FamilyLifecycleMatch {
  const observation = match.observation;
  const source = snapshotCanonicalSource(observation.source);
  switch (observation.kind) {
    case "call":
      return Object.freeze({
        matchedPatternId: match.matchedPatternId,
        observation: Object.freeze({
          kind: observation.kind,
          source,
          target: observation.target,
          ...(observation.sender === undefined
            ? {}
            : { sender: observation.sender }),
          data: observation.data,
          ...(observation.transactionHash === undefined
            ? {}
            : { transactionHash: observation.transactionHash }),
        }),
      });
    case "log":
      return Object.freeze({
        matchedPatternId: match.matchedPatternId,
        observation: Object.freeze({
          kind: observation.kind,
          source,
          address: observation.address,
          topics: Object.freeze([...observation.topics]),
          data: observation.data,
          ...(observation.transactionHash === undefined
            ? {}
            : { transactionHash: observation.transactionHash }),
        }),
      });
    case "address-surface":
      return Object.freeze({
        matchedPatternId: match.matchedPatternId,
        observation: Object.freeze({
          kind: observation.kind,
          source,
          address: observation.address,
          codeHash: observation.codeHash,
          implementationWord: observation.implementationWord,
          ...(observation.interfaceFingerprints === undefined
            ? {}
            : {
                interfaceFingerprints: Object.freeze([
                  ...observation.interfaceFingerprints,
                ]),
            }),
          // Plugin-owned opaque payload must survive the lifecycle
          // snapshot (e.g. a cold-pool PoolKey recovered from the
          // PositionManager reverse lookup); decodeCandidate reads it.
          ...(observation.opaque === undefined
            ? {}
            : { opaque: observation.opaque }),
        }),
      });
    case "factory-log":
      return Object.freeze({
        matchedPatternId: match.matchedPatternId,
        observation: Object.freeze({
          kind: observation.kind,
          source,
          factory: observation.factory,
          poolKeyProjection: observation.poolKeyProjection,
          lastFactoryLogBlock: observation.lastFactoryLogBlock,
          topic: observation.topic,
          topics: Object.freeze([...observation.topics]),
          data: observation.data,
        }),
      });
  }
}

function snapshotRuntimeEvidence(
  evidence: readonly RuntimeEvidence[],
): readonly RuntimeEvidence[] {
  return Object.freeze(evidence.map((item) => Object.freeze({
    evidenceId: item.evidenceId,
    familyId: item.familyId,
    ...(item.instanceKey === undefined
      ? {}
      : { instanceKey: item.instanceKey }),
    kind: item.kind,
    scope: item.scope,
    source: snapshotCanonicalSource(item.source),
    ...(item.txHash === undefined ? {} : { txHash: item.txHash }),
    evidenceHash: item.evidenceHash,
    sealedPayloadRef: item.sealedPayloadRef,
  })));
}

async function executeStaticEvidenceWork<Input, Evidence>(input: {
  readonly stage: AdapterStaticEvidenceStage;
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly subjectKey: string;
  readonly capabilityHash: string;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly program: StaticEvidenceProgram<Input, Evidence>;
  readonly programInput: Input;
  readonly runtime: CentralAdapterRuntime;
}): Promise<StaticEvidenceWorkOutcome<Evidence>> {
  const cache = input.runtime.staticEvidenceCache;
  if (cache !== undefined) {
    try {
      input.runtime.generationFence.assertCurrent(
        input.generation,
        input.source,
      );
      const hit = await cache.lookup({
        familyId: input.familyId,
        stage: input.stage,
        subjectKey: input.subjectKey,
        capabilityHash: input.capabilityHash,
        source: input.source,
        program: input.program,
        programInput: input.programInput,
      });
      input.runtime.generationFence.assertCurrent(
        input.generation,
        input.source,
      );
      if (hit !== undefined) {
        return Object.freeze({
          status: "resolved" as const,
          executed: hit.executed,
          cacheKey: hit.cacheKey,
        });
      }
    } catch {
      // Cache declaration/reuse is non-authoritative. The normal work path
      // below preserves the existing typed unresolved diagnostics.
    }
  }

  const work = await executeAdapterWork({
    intent: {
      stage: input.stage,
      familyId: input.familyId,
      ...(input.instanceKey === undefined
        ? {}
        : { instanceKey: input.instanceKey }),
      source: input.source,
      generation: input.generation,
      program: input.program,
      programInput: input.programInput,
    },
    runtime: input.runtime,
  });
  if (work.status === "unresolved") return work;
  if (cache !== undefined) {
    try {
      input.runtime.generationFence.assertCurrent(
        input.generation,
        input.source,
      );
      cache.store({
        familyId: input.familyId,
        stage: input.stage,
        subjectKey: input.subjectKey,
        capabilityHash: input.capabilityHash,
        source: input.source,
        program: input.program,
        programInput: input.programInput,
        executed: work.executed,
      });
      input.runtime.generationFence.assertCurrent(
        input.generation,
        input.source,
      );
    } catch {
      // A content-cache failure never changes authoritative lifecycle output.
    }
  }
  return work;
}

/**
 * Terminal S1/coarse lifecycle for strict Family definitions. It receives only
 * catalog-issued code capabilities and a central work runtime; no transport or
 * legacy Family surface crosses this boundary.
 */
export async function executeAdapterFamilyLifecycleBatch(input: {
  readonly family: LoadedFamilyPlugin;
  readonly matches: readonly FamilyLifecycleMatch[];
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly publisher: AdapterFamilyPublicationSink;
  readonly limits?: Partial<AdapterFamilyLifecycleLimits>;
}): Promise<AdapterFamilyLifecycleResult> {
  rejectCallerSharedBindingInjection(input);
  const captured = Object.freeze({
    family: input.family,
    matches: Object.freeze(input.matches.map(snapshotFamilyLifecycleMatch)),
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
    runtime: input.runtime,
    publisher: input.publisher,
    ...(input.limits === undefined
      ? {}
      : { limits: Object.freeze({ ...input.limits }) }),
  });
  assertIssuedLoadedFamilyBox(captured.family);
  assertDefinedFamilyPlugin(captured.family.plugin);
  assertSource(captured.source, captured.generation);
  if (captured.runtime.staticEvidenceCache !== undefined) {
    assertIssuedAdapterFamilyLifecycleContentCache(
      captured.runtime.staticEvidenceCache,
    );
  }
  assertFamilyCapabilities(captured.family);
  const limits = resolveLimits(captured.limits);
  for (const match of captured.matches) {
    assertMatchSource(captured.family, match, captured.source);
  }
  const coalesced = coalesceCandidateMatches(
    captured.family,
    captured.matches,
    captured.source,
  );
  const sharedBindingResolver = createFamilySharedBindingBatchResolver({
    family: captured.family,
    source: captured.source,
    generation: captured.generation,
    runtime: captured.runtime,
  });

  const prepared = await Promise.all(
    coalesced.candidates.map((decoded) => prepareCandidate({
      family: captured.family,
      decoded,
      source: captured.source,
      generation: captured.generation,
      runtime: captured.runtime,
      sharedBindingResolver,
      limits,
    })),
  );
  const settled = [...coalesced.terminal, ...prepared];
  const reconciled = reconcilePreparedInstances(
    captured.family.plugin.manifest.familyId,
    captured.source,
    settled,
  );
  const outcomes = reconciled.outcomes;
  const instances = reconciled.instances;
  if (instances.length === 0) {
    return sealLifecycleResult(captured, outcomes, null);
  }

  let publication: AdapterFamilyPublication;
  try {
    publication = sealPublication({
      familyId: captured.family.plugin.manifest.familyId,
      source: captured.source,
      generation: captured.generation,
      instances,
      outcomes,
    });
  } catch (error) {
    const failedOutcomes = publicationFailureOutcomes(
      captured.family.plugin.manifest.familyId,
      captured.source,
      instances,
      "publication-build",
      error,
    );
    return sealLifecycleResult(captured, [...outcomes, ...failedOutcomes], null);
  }
  try {
    captured.runtime.generationFence.assertCurrent(
      captured.generation,
      captured.source,
    );
  } catch (error) {
    const staleOutcomes = publicationFailureOutcomes(
      captured.family.plugin.manifest.familyId,
      captured.source,
      instances,
      "publication-fence",
      error,
    );
    return sealLifecycleResult(captured, [...outcomes, ...staleOutcomes], null);
  }
  try {
    captured.publisher.publish(publication);
  } catch (error) {
    const failedOutcomes = publicationFailureOutcomes(
      captured.family.plugin.manifest.familyId,
      captured.source,
      instances,
      "publication-cas",
      error,
    );
    return sealLifecycleResult(captured, [...outcomes, ...failedOutcomes], null);
  }
  return sealLifecycleResult(captured, outcomes, publication);
}

export async function executeAdapterFamilyLifecycle(input: {
  readonly family: LoadedFamilyPlugin;
  readonly match: FamilyLifecycleMatch;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly publisher: AdapterFamilyPublicationSink;
  readonly limits?: Partial<AdapterFamilyLifecycleLimits>;
}): Promise<AdapterFamilyLifecycleResult> {
  rejectCallerSharedBindingInjection(input);
  return executeAdapterFamilyLifecycleBatch({
    family: input.family,
    matches: [input.match],
    source: input.source,
    generation: input.generation,
    runtime: input.runtime,
    publisher: input.publisher,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
}

/**
 * Central identity/instance lifecycle for Credit Families. It deliberately
 * stops before route/risk publication and issues one exact instance object;
 * callers cannot replace that object with a raw descriptor or structural clone.
 */
export async function executeCreditFamilyInstanceLifecycle(input: {
  readonly family: LoadedFamilyBox;
  readonly match: FamilyLifecycleMatch;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly maxIdentityStepsPerVariant?: number;
}): Promise<CreditFamilyInstanceLifecycleResult> {
  const family = input.family;
  const match = snapshotFamilyLifecycleMatch(input.match);
  const source = snapshotCanonicalSource(input.source);
  assertIssuedLoadedFamilyBox(family);
  assertDefinedFamilyPlugin(family.plugin);
  assertSource(source, input.generation);
  const plugin = runtimeInstanceLifecyclePlugin(family);
  if (plugin.manifest.domain !== "credit") {
    throw new Error("Credit instance lifecycle requires a Credit FamilyBox");
  }
  if (input.runtime.staticEvidenceCache !== undefined) {
    assertIssuedAdapterFamilyLifecycleContentCache(
      input.runtime.staticEvidenceCache,
    );
  }
  for (const capability of ["identity", "instance", "credit"] as const) {
    if (family.hashes[capability].familyId !== plugin.manifest.familyId) {
      throw new Error(`${capability} capability hash escaped its Credit Family`);
    }
  }
  assertMatchSource(family, match, source);

  let candidate: FamilyCandidate | null;
  let candidateKey = observationKey(match.observation);
  try {
    candidate = plugin.discovery.decodeCandidate({
      observation: match.observation,
      matchedPatternId: match.matchedPatternId,
    });
    if (candidate !== null) {
      candidateKey = canonicalKey(
        plugin.discovery.candidateKey(candidate),
        "Credit candidate key",
      );
    }
  } catch (error) {
    return creditLifecycleResult({
      familyId: plugin.manifest.familyId,
      source,
      generation: input.generation,
      instance: null,
      outcomes: [makeOutcome({
        familyId: plugin.manifest.familyId,
        candidateKey,
        stage: "discovery",
        status: "failed",
        reasonCode: `candidate-decode:${errorMessage(error)}`,
        source,
        evidenceRefs: [],
      })],
    });
  }
  if (candidate === null) {
    return creditLifecycleResult({
      familyId: plugin.manifest.familyId,
      source,
      generation: input.generation,
      instance: null,
      outcomes: [makeOutcome({
        familyId: plugin.manifest.familyId,
        candidateKey,
        stage: "discovery",
        status: "rejected",
        reasonCode: "candidate-not-recognized",
        source,
        evidenceRefs: [],
      })],
    });
  }
  const outcomes: AdapterInstanceOutcome[] = [makeOutcome({
    familyId: plugin.manifest.familyId,
    candidateKey,
    stage: "discovery",
    status: "candidate",
    reasonCode: "candidate-decoded",
    source,
    evidenceRefs: [],
  })];
  const identityResult = await resolveIdentity({
    family,
    candidate: { candidate, candidateKey },
    source,
    generation: input.generation,
    runtime: input.runtime,
    maxSteps: input.maxIdentityStepsPerVariant ??
      DEFAULT_LIMITS.maxIdentityStepsPerVariant,
  });
  if (identityResult.status !== "verified") {
    outcomes.push(makeOutcome({
      familyId: plugin.manifest.familyId,
      candidateKey,
      stage: "identity",
      status: identityResult.status,
      reasonCode: identityResult.reasonCode,
      source,
      evidenceRefs: identityResult.evidenceRefs,
    }));
    return creditLifecycleResult({
      familyId: plugin.manifest.familyId,
      source,
      generation: input.generation,
      instance: null,
      outcomes,
    });
  }

  const identity = identityResult.identity;
  let instanceKey: InstanceKey;
  let descriptor: CompiledInstanceDescriptor;
  let staticEvidenceFingerprint = hashCanonical([]);
  const evidenceRefs = [...identityResult.evidenceRefs];
  try {
    validateIdentity(identity, family, undefined);
    instanceKey = plugin.instance.instanceKey(identity);
    canonicalKey(instanceKey, "Credit instance key");
    const draft = requireObject(
      plugin.instance.compileDraft(identity),
      "Credit instance draft",
    );
    let staticEvidence: unknown;
    if (plugin.instance.staticEvidence !== undefined) {
      const work = await executeStaticEvidenceWork({
        stage: "instance-static",
        familyId: plugin.manifest.familyId,
        instanceKey,
        subjectKey: instanceKey,
        capabilityHash: family.hashes.instance.contentHash,
        source,
        generation: input.generation,
        program: plugin.instance.staticEvidence,
        programInput: draft,
        runtime: input.runtime,
      });
      if (work.status === "unresolved") {
        outcomes.push(workFailureOutcome({
          work,
          familyId: plugin.manifest.familyId,
          lineageId: identity.lineageId,
          candidateKey,
          instanceKey,
          stage: "instance-compile",
          source,
          evidenceRefs,
        }));
        return creditLifecycleResult({
          familyId: plugin.manifest.familyId,
          source,
          generation: input.generation,
          instance: null,
          outcomes,
        });
      }
      staticEvidence = work.executed.evidence;
      staticEvidenceFingerprint = work.executed.trustedResultsFingerprint;
      evidenceRefs.push(transportEvidenceRef(staticEvidenceFingerprint));
      if (work.cacheKey !== undefined) {
        evidenceRefs.push(`static-evidence-cache:${work.cacheKey}`);
      }
    }
    descriptor = requireObject(plugin.instance.finalizeDescriptor({
      identity,
      draft,
      staticEvidence,
      sharedBindings: Object.freeze([]),
    }), "Credit instance descriptor") as CompiledInstanceDescriptor;
    validateDescriptor(
      descriptor,
      identity,
      instanceKey,
      plugin.manifest.familyId,
    );
    deepFreezeOpaqueRuntimeValue(descriptor, "Credit instance descriptor");
    const staticBindingFingerprint = hashCanonical({
      capability: family.hashes.instance.contentHash,
      projection: plugin.instance.staticBindingProjection(descriptor),
      sharedBindings: [],
    });
    input.runtime.generationFence.assertCurrent(input.generation, source);
    const instance = Object.freeze({
      familyId: plugin.manifest.familyId,
      lineageId: identity.lineageId,
      candidateKey,
      instanceKey,
      descriptor,
      routes: Object.freeze([]),
      routeHandles: Object.freeze([]),
      pricingInstances: Object.freeze([]),
      staticBindingFingerprint,
      staticEvidenceFingerprint,
      evidenceRefs: Object.freeze(uniqueSorted(evidenceRefs)),
    }) satisfies PreparedFamilyInstance;
    registerIssuedPreparedFamilyInstance({
      family,
      instance,
      source,
      generation: input.generation,
    });
    outcomes.push(makeOutcome({
      familyId: plugin.manifest.familyId,
      lineageId: identity.lineageId,
      candidateKey,
      instanceKey,
      stage: "instance-compile",
      status: "verified",
      reasonCode: "credit-instance-capability-issued",
      source,
      evidenceRefs,
    }));
    return creditLifecycleResult({
      familyId: plugin.manifest.familyId,
      source,
      generation: input.generation,
      instance,
      outcomes,
    });
  } catch (error) {
    outcomes.push(makeOutcome({
      familyId: plugin.manifest.familyId,
      lineageId: identity.lineageId,
      candidateKey,
      stage: "instance-compile",
      status: "failed",
      reasonCode: `credit-instance:${errorMessage(error)}`,
      source,
      evidenceRefs,
    }));
    return creditLifecycleResult({
      familyId: plugin.manifest.familyId,
      source,
      generation: input.generation,
      instance: null,
      outcomes,
    });
  }
}

/** Exact-object authority check shared by route-specific runtimes. */
export function assertIssuedPreparedFamilyInstance(input: {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): void {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  if (
    input.instance === null ||
    typeof input.instance !== "object" ||
    !Object.isFrozen(input.instance)
  ) {
    throw new Error("Prepared Family instance must be lifecycle-issued");
  }
  const issue = issuedPreparedFamilyInstances.get(input.instance);
  if (issue === undefined) {
    throw new Error("Prepared Family instance must be lifecycle-issued");
  }
  if (issue.family !== input.family) {
    throw new Error("Prepared Family instance escaped its catalog FamilyBox");
  }
  if (
    input.instance.familyId !== input.family.plugin.manifest.familyId ||
    input.instance.familyId !== input.instance.descriptor.familyId ||
    input.instance.lineageId !== input.instance.descriptor.lineageId ||
    input.instance.instanceKey !== input.instance.descriptor.instanceKey
  ) {
    throw new Error("Prepared Family instance metadata changed after issue");
  }
  if (
    input.generation !== issue.generation ||
    input.source.number !== issue.source.number ||
    input.source.hash.toLowerCase() !== issue.source.hash.toLowerCase() ||
    input.source.generation !== issue.source.generation
  ) {
    throw new Error("Prepared Family instance source/generation mismatch");
  }
}

/** Issuer-private membership/source check for one prepared pricing shard. */
export function assertIssuedPreparedFamilyPricingStateInstance(input: {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly pricing: PreparedPricingStateInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): void {
  assertIssuedPreparedFamilyInstance({
    family: input.family,
    instance: input.instance,
    source: input.source,
    generation: input.generation,
  });
  const issue = issuedPreparedPricingStateInstances.get(input.pricing);
  if (
    issue === undefined ||
    issue.family !== input.family ||
    issue.instance !== input.instance ||
    issue.generation !== input.generation ||
    !sameCanonicalSource(issue.source, input.source) ||
    !Object.isFrozen(input.pricing) ||
    issue.integrityFingerprint !==
      preparedPricingStateIntegrityFingerprint(input.pricing)
  ) {
    throw new Error(
      "Prepared Family pricing state must be issuer-bound to its instance/source",
    );
  }
}

export interface FamilyExactQuoteInvocation {
  readonly family: LoadedFamilyPlugin;
  readonly route: FamilyRouteRuntimeHandle;
  readonly amountIn: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly control?: AdapterWorkControl;
  /** Central policy bound; Family code cannot raise this limit. */
  readonly maxDependentReadRounds?: number;
}

interface ResolvedFamilyExactQuoteInvocation
  extends Omit<FamilyExactQuoteInvocation, "route"> {
  readonly routeHandle: FamilyRouteRuntimeHandle;
  readonly routeRecord: FamilyRouteRuntimeHandleRecord;
  readonly instance: PreparedFamilyInstance;
  readonly route: FamilyRouteDescriptor;
}

/** S3 exact quote boundary. Request-bearing quotes always enter central work. */
export async function executeFamilyExactQuote(
  input: FamilyExactQuoteInvocation,
): Promise<FamilyExactQuoteOutcome> {
  const captured: FamilyExactQuoteInvocation = Object.freeze({
    family: input.family,
    route: input.route,
    amountIn: input.amountIn,
    executor: input.executor,
    runtimeEvidence: snapshotRuntimeEvidence(input.runtimeEvidence),
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
    runtime: input.runtime,
    ...(input.control === undefined ? {} : { control: input.control }),
    ...(input.maxDependentReadRounds === undefined
      ? {}
      : { maxDependentReadRounds: input.maxDependentReadRounds }),
  });
  let invocation: ResolvedFamilyExactQuoteInvocation | undefined;
  let programInput: RuntimeExactQuoteInput;
  let methods: readonly RuntimeExactMethod[];
  let methodOrderFingerprint: string;
  let compatibilityFingerprint: string;
  let maxDependentReadRounds: number;
  try {
    assertIssuedLoadedFamilyBox(captured.family);
    const routeRecord = resolveFamilyRouteRuntimeHandle(
      captured.family,
      captured.route,
    );
    invocation = Object.freeze({
      ...captured,
      routeHandle: captured.route,
      routeRecord,
      instance: routeRecord.instance,
      route: routeRecord.route,
    });
    assertExactInvocation(invocation);
    programInput = Object.freeze({
      descriptor: invocation.instance.descriptor,
      route: invocation.route,
      amountIn: invocation.amountIn,
      source: invocation.source,
      executor: invocation.executor.toLowerCase(),
      runtimeEvidence: invocation.runtimeEvidence,
    });
    methods = declareExactMethods(
      invocation.family.plugin.exact.methods(programInput),
    );
    methodOrderFingerprint = hashCanonical({
      namespace: "adapter-family-exact-method-order-v1",
      methods: methods.map((method, methodIndex) => ({
        methodIndex,
        methodId: method.id,
        kind: method.kind,
      })),
    });
    maxDependentReadRounds = exactDependentReadRoundLimit(
      invocation.maxDependentReadRounds,
    );
    compatibilityFingerprint = hashCanonical({
      capability: invocation.family.hashes.exact.contentHash,
      projection: invocation.family.plugin.exact.cacheCompatibilityProjection(
        programInput,
      ),
      executor: programInput.executor,
      runtimeEvidence: runtimeEvidenceProjection(programInput.runtimeEvidence),
    });
  } catch (error) {
    return terminalUnboundExact(
      captured,
      invocation,
      "failed",
      `exact-declaration:${errorMessage(error)}`,
      [],
    );
  }

  const evidenceRefs = [
    `exact-method-order:${methodOrderFingerprint}`,
  ];
  for (const [methodIndex, method] of methods.entries()) {
    const methodRef = exactMethodEvidenceRef(
      method,
      methodIndex,
      methodOrderFingerprint,
    );
    if (method.kind === "request-program") {
      evidenceRefs.push(methodRef);
      return executeExactRequestMethod({
        invocation,
        programInput,
        program: method.program,
        methodId: method.id,
        methodIndex,
        methodOrderFingerprint,
        compatibilityFingerprint,
        maxDependentReadRounds,
        evidenceRefs,
      });
    }

    try {
      invocation.runtime.generationFence.assertCurrent(
        invocation.generation,
        invocation.source,
      );
    } catch (error) {
      return terminalExact(invocation, "unresolved",
        `local-exact-generation:${errorMessage(error)}`, evidenceRefs);
    }
    let attempt;
    try {
      attempt = validateLocalExactAttempt(method.quote(programInput));
    } catch (error) {
      return terminalExact(invocation, "failed",
        `local-exact-quote:${method.id}:${errorMessage(error)}`,
        [...evidenceRefs, methodRef]);
    }
    try {
      invocation.runtime.generationFence.assertCurrent(
        invocation.generation,
        invocation.source,
      );
    } catch (error) {
      return terminalExact(invocation, "unresolved",
        `local-exact-generation:${errorMessage(error)}`, evidenceRefs);
    }
    if (attempt.status === "not-applicable") {
      evidenceRefs.push(
        `${methodRef}:not-applicable:${hashCanonical(attempt.reason)}`,
      );
      continue;
    }
    return resolvedExactQuote({
      invocation,
      quote: attempt.result,
      methodId: method.id,
      methodIndex,
      methodOrderFingerprint,
      compatibilityFingerprint,
      evidenceRefs: [
        ...evidenceRefs,
        methodRef,
        `local-exact:${compatibilityFingerprint}`,
      ],
      reasonCode: "local-exact-derived",
    });
  }
  return terminalExact(
    invocation,
    "failed",
    "exact-no-method-applies",
    evidenceRefs,
  );
}

type RuntimeExactQuoteInput = ExactQuoteInput<
  CompiledInstanceDescriptor,
  FamilyRouteDescriptor
>;

type RuntimeExactMethod = ExactMethod<
  CompiledInstanceDescriptor,
  FamilyRouteDescriptor,
  unknown
>;

interface DeclaredExactRound {
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
  readonly fingerprint: string;
  readonly decode?: (results: readonly AdapterRequestResult[]) => unknown;
}

async function executeExactRequestMethod(input: {
  readonly invocation: ResolvedFamilyExactQuoteInvocation;
  readonly programInput: RuntimeExactQuoteInput;
  readonly program: ExactRequestProgram<
    CompiledInstanceDescriptor,
    FamilyRouteDescriptor,
    unknown
  >;
  readonly methodId: string;
  readonly methodIndex: number;
  readonly methodOrderFingerprint: string;
  readonly compatibilityFingerprint: string;
  readonly maxDependentReadRounds: number;
  readonly evidenceRefs: readonly string[];
}): Promise<FamilyExactQuoteOutcome> {
  const invocation = input.invocation;
  const evidenceRefs = [...input.evidenceRefs];
  let initial: DeclaredExactRound;
  try {
    initial = declareInitialExactRound(input.program, input.programInput);
    assertNewExactRequestIds(initial.requests, new Set<string>());
  } catch (error) {
    return terminalExact(
      invocation,
      "failed",
      `exact-request-declaration:${input.methodId}:${errorMessage(error)}`,
      evidenceRefs,
    );
  }
  evidenceRefs.push(`exact-round:0:${initial.fingerprint}`);

  const cacheAddress: AdapterExactQuoteCacheAddress = Object.freeze({
    familyRuntimeIdentity: invocation.family,
    familyId: invocation.family.plugin.manifest.familyId,
    instanceKey: invocation.instance.instanceKey,
    routeKey: invocation.route.routeKey,
    instanceFingerprint: invocation.instance.staticBindingFingerprint,
    routeBindingFingerprint: invocation.route.bindingRef.fingerprint,
    capabilityHash: invocation.family.hashes.exact.contentHash,
    compatibilityFingerprint: input.compatibilityFingerprint,
    methodId: input.methodId,
    methodIndex: input.methodIndex,
    methodOrderFingerprint: input.methodOrderFingerprint,
    requestFingerprint: hashCanonical({
      namespace: "adapter-family-exact-request-method-v1",
      methodId: input.methodId,
      methodIndex: input.methodIndex,
      methodOrderFingerprint: input.methodOrderFingerprint,
      initialRoundFingerprint: initial.fingerprint,
      maxDependentReadRounds: input.maxDependentReadRounds,
    }),
    amountIn: invocation.amountIn,
    executor: input.programInput.executor,
    source: invocation.source,
  });

  const exactCache = invocation.runtime.exactQuoteCache;
  if (exactCache !== undefined) {
    try {
      assertIssuedAdapterFamilyExactQuoteCache(exactCache);
      invocation.runtime.generationFence.assertCurrent(
        invocation.generation,
        invocation.source,
      );
      const cached = exactCache.lookup(cacheAddress);
      invocation.runtime.generationFence.assertCurrent(
        invocation.generation,
        invocation.source,
      );
      if (cached !== undefined) {
        try {
          const quote = replayCachedExactRequestProgram({
            program: input.program,
            programInput: input.programInput,
            initial,
            trustedResults: cached.trustedResults,
            expectedRoundFingerprints: cached.roundFingerprints,
            source: invocation.source,
            maxDependentReadRounds: input.maxDependentReadRounds,
          });
          invocation.runtime.generationFence.assertCurrent(
            invocation.generation,
            invocation.source,
          );
          return resolvedExactQuote({
            invocation,
            quote,
            methodId: input.methodId,
            methodIndex: input.methodIndex,
            methodOrderFingerprint: input.methodOrderFingerprint,
            compatibilityFingerprint: input.compatibilityFingerprint,
            evidenceRefs: [
              ...evidenceRefs,
              ...cached.evidenceRefs,
              `exact-cache:${cached.cacheKey}`,
            ],
            reasonCode: "exact-cache-reused",
          });
        } catch {
          // Transport cache material is non-authoritative. Re-run this same
          // selected method; never advance to a later exact method.
          evidenceRefs.push(`exact-cache-redecode-failed:${cached.cacheKey}`);
        }
      }
    } catch (error) {
      return terminalExact(
        invocation,
        "unresolved",
        `exact-cache-generation:${errorMessage(error)}`,
        evidenceRefs,
      );
    }
  }

  const initialWork = await executeExactRoundWork({
    invocation,
    programInput: input.programInput,
    round: initial,
    decode: (results) => Object.freeze([...results]),
  });
  if (initialWork.status === "unresolved") {
    return terminalExactFromWork(invocation, initialWork, evidenceRefs);
  }
  const initialResults = Object.freeze([
    ...initialWork.executed.evidence,
  ]);
  const dependentEvidence: unknown[] = [];
  const trustedResults = [...initialWork.executed.trustedResults];
  const roundFingerprints = [initial.fingerprint];
  const seenRequestIds = new Set(initial.requests.map((request) => request.id));
  evidenceRefs.push(transportEvidenceRef(
    initialWork.executed.trustedResultsFingerprint,
  ));

  let completedRound = 0;
  for (;;) {
    let bound: BoundRequestProgram<unknown> | null;
    try {
      bound = input.program.buildDependentProgram?.({
        programInput: input.programInput,
        completedRound,
        initialResults,
        priorEvidence: Object.freeze([...dependentEvidence]),
      }) ?? null;
    } catch (error) {
      return terminalExact(
        invocation,
        "failed",
        `exact-dependent-declaration:${errorMessage(error)}`,
        evidenceRefs,
      );
    }
    if (bound === null) break;
    if (completedRound >= input.maxDependentReadRounds) {
      return terminalExact(
        invocation,
        "failed",
        "exact-dependent-round-budget-exhausted",
        evidenceRefs,
      );
    }

    let round: DeclaredExactRound;
    try {
      round = declareDependentExactRound(bound);
      assertNewExactRequestIds(round.requests, seenRequestIds);
    } catch (error) {
      return terminalExact(
        invocation,
        "failed",
        `exact-dependent-program:${errorMessage(error)}`,
        evidenceRefs,
      );
    }
    roundFingerprints.push(round.fingerprint);
    evidenceRefs.push(
      `exact-round:${completedRound + 1}:${round.fingerprint}`,
    );
    const work = await executeExactRoundWork({
      invocation,
      programInput: input.programInput,
      round,
      decode: round.decode!,
    });
    if (work.status === "unresolved") {
      return terminalExactFromWork(invocation, work, evidenceRefs);
    }
    dependentEvidence.push(work.executed.evidence);
    trustedResults.push(...work.executed.trustedResults);
    evidenceRefs.push(transportEvidenceRef(
      work.executed.trustedResultsFingerprint,
    ));
    completedRound++;
  }

  let quote: ExactQuoteResult<unknown>;
  try {
    quote = requireSynchronousExactValue(
      input.program.decode({
        programInput: input.programInput,
        initialResults,
        dependentEvidence: Object.freeze([...dependentEvidence]),
      }),
      "exact request program decode",
    );
    validateExactQuote(quote);
  } catch (error) {
    return terminalExact(
      invocation,
      "failed",
      `exact-decode:${errorMessage(error)}`,
      evidenceRefs,
    );
  }

  try {
    invocation.runtime.generationFence.assertCurrent(
      invocation.generation,
      invocation.source,
    );
  } catch (error) {
    return terminalExact(
      invocation,
      "unresolved",
      `exact-cache-generation:${errorMessage(error)}`,
      evidenceRefs,
    );
  }
  if (exactCache !== undefined) {
    try {
      exactCache.store(cacheAddress, {
        trustedResults: Object.freeze([...trustedResults]),
        roundFingerprints: Object.freeze([...roundFingerprints]),
        evidenceRefs,
      });
    } catch {
      // Completed-result caching is non-authoritative; the exact result remains
      // valid after the generation fence and can proceed without a cache write.
    }
  }
  try {
    invocation.runtime.generationFence.assertCurrent(
      invocation.generation,
      invocation.source,
    );
  } catch (error) {
    return terminalExact(
      invocation,
      "unresolved",
      `exact-cache-generation:${errorMessage(error)}`,
      evidenceRefs,
    );
  }
  return resolvedExactQuote({
    invocation,
    quote,
    methodId: input.methodId,
    methodIndex: input.methodIndex,
    methodOrderFingerprint: input.methodOrderFingerprint,
    compatibilityFingerprint: input.compatibilityFingerprint,
    evidenceRefs,
    reasonCode: "request-exact-derived",
  });
}

function executeExactRoundWork<Evidence>(input: {
  readonly invocation: ResolvedFamilyExactQuoteInvocation;
  readonly programInput: RuntimeExactQuoteInput;
  readonly round: DeclaredExactRound;
  readonly decode: (
    results: readonly AdapterRequestResult[],
  ) => Evidence;
}): Promise<AdapterWorkOutcome<Evidence>> {
  const program: RequestProgram<RuntimeExactQuoteInput, Evidence> = {
    requirements: () => input.round.requirements,
    buildRequests: () => input.round.requests,
    decode: ({ results }) => input.decode(results),
  };
  return executeAdapterWork({
    intent: {
      stage: "exact-refine",
      familyId: input.invocation.family.plugin.manifest.familyId,
      instanceKey: input.invocation.instance.instanceKey,
      routeKey: input.invocation.route.routeKey,
      source: input.invocation.source,
      generation: input.invocation.generation,
      program,
      programInput: input.programInput,
    },
    runtime: input.invocation.runtime,
    ...(input.invocation.control === undefined
      ? {}
      : { control: input.invocation.control }),
  });
}

function replayCachedExactRequestProgram(input: {
  readonly program: ExactRequestProgram<
    CompiledInstanceDescriptor,
    FamilyRouteDescriptor,
    unknown
  >;
  readonly programInput: RuntimeExactQuoteInput;
  readonly initial: DeclaredExactRound;
  readonly trustedResults: readonly AdapterRequestResult[];
  readonly expectedRoundFingerprints: readonly string[];
  readonly source: CanonicalSource;
  readonly maxDependentReadRounds: number;
}): ExactQuoteResult<unknown> {
  const byId = new Map<string, AdapterRequestResult>();
  for (const result of input.trustedResults) {
    if (byId.has(result.id)) {
      throw new Error(`cached exact results duplicate request id ${result.id}`);
    }
    byId.set(result.id, result);
  }
  if (input.expectedRoundFingerprints[0] !== input.initial.fingerprint) {
    throw new Error("cached exact initial round declaration changed");
  }

  const consumed = new Set<string>();
  const seenRequestIds = new Set<string>();
  const initialResults = rebindCachedExactRound({
    requests: input.initial.requests,
    byId,
    consumed,
    seenRequestIds,
    source: input.source,
  });
  const dependentEvidence: unknown[] = [];
  let completedRound = 0;
  for (;;) {
    const bound = input.program.buildDependentProgram?.({
      programInput: input.programInput,
      completedRound,
      initialResults,
      priorEvidence: Object.freeze([...dependentEvidence]),
    }) ?? null;
    if (bound === null) break;
    if (completedRound >= input.maxDependentReadRounds) {
      throw new Error("cached exact dependent round budget exhausted");
    }
    const round = declareDependentExactRound(bound);
    if (
      input.expectedRoundFingerprints[completedRound + 1] !==
        round.fingerprint
    ) {
      throw new Error(
        `cached exact dependent round ${completedRound} declaration changed`,
      );
    }
    const roundResults = rebindCachedExactRound({
      requests: round.requests,
      byId,
      consumed,
      seenRequestIds,
      source: input.source,
    });
    dependentEvidence.push(requireSynchronousExactValue(
      round.decode!(roundResults),
      `cached exact dependent round ${completedRound} decode`,
    ));
    completedRound++;
  }
  if (input.expectedRoundFingerprints.length !== completedRound + 1) {
    throw new Error("cached exact results contain undeclared request rounds");
  }
  if (consumed.size !== byId.size) {
    throw new Error("cached exact results contain requests absent from current rounds");
  }
  const quote = requireSynchronousExactValue(
    input.program.decode({
      programInput: input.programInput,
      initialResults,
      dependentEvidence: Object.freeze([...dependentEvidence]),
    }),
    "cached exact request program decode",
  );
  validateExactQuote(quote);
  return quote;
}

function rebindCachedExactRound(input: {
  readonly requests: readonly AdapterRequest[];
  readonly byId: ReadonlyMap<string, AdapterRequestResult>;
  readonly consumed: Set<string>;
  readonly seenRequestIds: Set<string>;
  readonly source: CanonicalSource;
}): readonly AdapterRequestResult[] {
  assertNewExactRequestIds(input.requests, input.seenRequestIds);
  return Object.freeze(input.requests.map((request) => {
    const result = input.byId.get(request.id);
    if (result === undefined) {
      throw new Error(`cached exact results omit current request id ${request.id}`);
    }
    input.consumed.add(request.id);
    return Object.freeze({
      ...result,
      source: Object.freeze({ ...input.source }),
    });
  }));
}

function declareExactMethods(value: unknown): readonly RuntimeExactMethod[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("exact methods must be a non-empty array");
  }
  const ids = new Set<string>();
  const methods = value.map((candidate, methodIndex) => {
    const method = requireObject(
      candidate,
      `exact method ${methodIndex}`,
    ) as Partial<RuntimeExactMethod>;
    const id = canonicalKey(method.id, `exact method ${methodIndex} id`);
    if (ids.has(id)) throw new Error(`exact methods duplicate id ${id}`);
    ids.add(id);
    if (method.kind === "local") {
      if (typeof method.quote !== "function") {
        throw new Error(`local exact method ${id} must declare quote`);
      }
      return method as RuntimeExactMethod;
    }
    if (method.kind === "request-program") {
      const program = requireObject(
        method.program,
        `request exact method ${id} program`,
      ) as Partial<ExactRequestProgram<
        CompiledInstanceDescriptor,
        FamilyRouteDescriptor,
        unknown
      >>;
      for (const name of ["requirements", "buildRequests", "decode"] as const) {
        if (typeof program[name] !== "function") {
          throw new Error(`request exact method ${id} must declare ${name}`);
        }
      }
      if (
        program.buildDependentProgram !== undefined &&
        typeof program.buildDependentProgram !== "function"
      ) {
        throw new Error(
          `request exact method ${id} buildDependentProgram must be a function`,
        );
      }
      return method as RuntimeExactMethod;
    }
    throw new Error(`exact method ${id} has unsupported kind`);
  });
  return Object.freeze(methods);
}

function validateLocalExactAttempt(value: unknown): ReturnType<Extract<
  RuntimeExactMethod,
  { readonly kind: "local" }
>["quote"]> {
  const attempt = requireObject(value, "local exact attempt") as {
    readonly status?: unknown;
    readonly reason?: unknown;
    readonly result?: unknown;
  };
  if (attempt.status === "not-applicable") {
    return Object.freeze({
      status: "not-applicable" as const,
      reason: canonicalKey(attempt.reason, "local exact not-applicable reason"),
    });
  }
  if (attempt.status === "quoted") {
    validateExactQuote(attempt.result as ExactQuoteResult<unknown>);
    return Object.freeze({
      status: "quoted" as const,
      result: attempt.result as ExactQuoteResult<unknown>,
    });
  }
  throw new Error("local exact attempt must be quoted or not-applicable");
}

function declareInitialExactRound(
  program: ExactRequestProgram<
    CompiledInstanceDescriptor,
    FamilyRouteDescriptor,
    unknown
  >,
  programInput: RuntimeExactQuoteInput,
): DeclaredExactRound {
  return declareExactRound({
    requirements: program.requirements(programInput),
    requests: program.buildRequests(programInput),
  });
}

function declareDependentExactRound(
  value: BoundRequestProgram<unknown>,
): DeclaredExactRound {
  const bound = requireObject(value, "dependent exact program") as Partial<
    BoundRequestProgram<unknown>
  >;
  if (typeof bound.decode !== "function") {
    throw new Error("dependent exact program decode must be a function");
  }
  return declareExactRound({
    requirements: bound.requirements,
    requests: bound.requests,
    decode: bound.decode.bind(bound),
  });
}

function declareExactRound(input: {
  readonly requirements: unknown;
  readonly requests: unknown;
  readonly decode?: (results: readonly AdapterRequestResult[]) => unknown;
}): DeclaredExactRound {
  const requirements = requireObject(
    input.requirements,
    "exact round requirements",
  ) as RequestRequirements;
  if (!Array.isArray(requirements.transports)) {
    throw new Error("exact round requirements transports must be an array");
  }
  if (!Array.isArray(input.requests)) {
    throw new Error("exact round requests must be an array");
  }
  const requests = Object.freeze([...input.requests]) as readonly AdapterRequest[];
  return Object.freeze({
    requirements,
    requests,
    fingerprint: hashCanonical({
      requirements: exactRequirementsProjection(requirements),
      requestSetFingerprint: requestSetFingerprint(requests),
    }),
    ...(input.decode === undefined ? {} : { decode: input.decode }),
  });
}

function exactRequirementsProjection(
  requirements: RequestRequirements,
): CanonicalValue {
  return {
    transports: Object.freeze([...requirements.transports]),
    caller: requirements.caller ?? null,
    completions: requirements.completions === undefined
      ? null
      : Object.freeze([...requirements.completions]),
    effects: requirements.effects === undefined
      ? null
      : Object.freeze([...requirements.effects]),
  };
}

function exactMethodEvidenceRef(
  method: RuntimeExactMethod,
  methodIndex: number,
  methodOrderFingerprint: string,
): string {
  return `exact-method:${methodIndex}:${method.id}:${method.kind}:` +
    methodOrderFingerprint;
}

function requireSynchronousExactValue<Value>(
  value: Value,
  label: string,
): Value {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  ) {
    throw new Error(`${label} must be synchronous`);
  }
  return value;
}

function terminalExactFromWork(
  invocation: ResolvedFamilyExactQuoteInvocation,
  work: Extract<AdapterWorkOutcome<unknown>, { readonly status: "unresolved" }>,
  evidenceRefs: readonly string[],
): TerminalFamilyExactQuote {
  const refs = uniqueSorted([
    ...evidenceRefs,
    ...(work.receipt.dedupeKey === null
      ? []
      : [`work:${work.receipt.dedupeKey}`]),
  ]);
  const failed = work.failure.code === "invalid-intent" ||
    work.failure.code === "invalid-program" ||
    work.failure.code === "authority-failure" ||
    work.failure.code === "policy-failure" ||
    work.failure.code === "admission-failure" ||
    work.failure.code === "decode-failure";
  return terminalExact(
    invocation,
    failed ? "failed" : "unresolved",
    `adapter-work:${work.failure.stage}:${work.failure.code}`,
    refs,
  );
}

function resolvedExactQuote(input: {
  readonly invocation: ResolvedFamilyExactQuoteInvocation;
  readonly quote: ExactQuoteResult<unknown>;
  readonly methodId: string;
  readonly methodIndex: number;
  readonly methodOrderFingerprint: string;
  readonly compatibilityFingerprint: string;
  readonly evidenceRefs: readonly string[];
  readonly reasonCode: string;
}): ResolvedFamilyExactQuote {
  const invocation = input.invocation;
  const evidenceRefs = uniqueSorted(input.evidenceRefs);
  const source = Object.freeze({ ...invocation.source });
  const runtimeEvidence = sealRuntimeEvidence(input.invocation.runtimeEvidence);
  const runtimeEvidenceFingerprint = hashCanonical(
    runtimeEvidenceProjection(runtimeEvidence),
  );
  const outcome = makeOutcome({
    familyId: invocation.family.plugin.manifest.familyId,
    lineageId: invocation.instance.lineageId,
    candidateKey: invocation.instance.candidateKey,
    instanceKey: invocation.instance.instanceKey,
    routeKey: invocation.route.routeKey,
    stage: "exact",
    status: "verified",
    reasonCode: input.reasonCode,
    source: invocation.source,
    evidenceRefs,
  });
  const handle = Object.freeze({
    status: "resolved" as const,
    familyId: invocation.family.plugin.manifest.familyId,
    candidateKey: invocation.instance.candidateKey,
    instanceKey: invocation.instance.instanceKey,
    routeKey: invocation.route.routeKey,
    source,
    generation: invocation.generation,
    amountIn: invocation.amountIn,
    amountOut: input.quote.amountOut,
    methodId: input.methodId,
    methodIndex: input.methodIndex,
    methodOrderFingerprint: input.methodOrderFingerprint,
    cacheCompatibilityFingerprint: input.compatibilityFingerprint,
    evidenceRefs: Object.freeze(evidenceRefs),
    outcome,
  }) as unknown as SealedFamilyExactQuoteHandle;
  issuedSealedFamilyExactQuoteHandles.set(handle, Object.freeze({
    family: invocation.family,
    routeHandle: invocation.routeHandle,
    routeRecord: invocation.routeRecord,
    amountIn: invocation.amountIn,
    amountOut: input.quote.amountOut,
    evidence: input.quote.evidence,
    executor: invocation.executor.toLowerCase(),
    runtimeEvidence,
    runtimeEvidenceFingerprint,
    source,
    generation: invocation.generation,
  }));
  return handle;
}

function exactDependentReadRoundLimit(value: number | undefined): number {
  const resolved = value ?? 4;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 16) {
    throw new Error("exact dependent read round limit must be an integer in [0,16]");
  }
  return resolved;
}

function assertNewExactRequestIds(
  requests: readonly AdapterRequest[],
  seen: Set<string>,
): void {
  for (const request of requests) {
    if (seen.has(request.id)) {
      throw new Error(`exact request rounds duplicate id ${request.id}`);
    }
    seen.add(request.id);
  }
}

/**
 * Pure victim replay boundary. Central code supplies an issuer-bound route,
 * normalized impact, pinned source and deterministic transaction validity;
 * the Family receives only issuer-private descriptor/route data and no clock,
 * transport, cache or scheduler handle.
 */
export function executeFamilyVictimReplay(
  input: FamilyVictimReplayInvocation,
): FamilyVictimReplayOutcome {
  const evidenceRefs: string[] = [];
  let impact: NormalizedSwapVictimImpact;
  let routeRecord: FamilyRouteRuntimeHandleRecord | undefined;
  try {
    assertIssuedLoadedFamilyBox(input.family);
    assertDefinedFamilyPlugin(input.family.plugin);
    assertSource(input.source, input.generation);
    routeRecord = resolveFamilyRouteRuntimeHandle(input.family, input.route);
    assertRouteHandleSource(
      routeRecord,
      input.source,
      input.generation,
      "victim replay",
    );
    if (input.family.plugin.manifest.domain !== "swap") {
      return terminalVictimReplay(
        input,
        routeRecord,
        "rejected",
        "victim-replay-non-swap",
      );
    }
    if (typeof input.validUntil !== "bigint" || input.validUntil <= 0n) {
      throw new Error("victim replay validUntil must be a positive bigint");
    }
    impact = sealVictimImpact(input.impact);
    evidenceRefs.push(`victim-impact:${hashCanonical(
      impact as unknown as CanonicalValue,
    )}`);
    input.runtime.generationFence.assertCurrent(input.generation, input.source);
  } catch (error) {
    return terminalVictimReplay(
      input,
      routeRecord,
      "failed",
      `victim-replay-input:${errorMessage(error)}`,
      evidenceRefs,
    );
  }

  // Narrowed to a swap Family by the domain check above; the runtime
  // treats the swap slot as present on this branch.
  const swap = (
    input.family.plugin as {
      readonly swap: SwapDomainSemantics<
        CompiledInstanceDescriptor,
        FamilyRouteDescriptor
      >;
    }
  ).swap;
  if (
    swap.victimSupport !== "replay" ||
    swap.replay === undefined
  ) {
    return terminalVictimReplay(
      input,
      routeRecord,
      "rejected",
      "victim-replay-not-declared",
      evidenceRefs,
    );
  }

  const instance = routeRecord.instance;
  let route: FamilyRouteDescriptor | null;
  try {
    route = swap.replay.bind({
      descriptor: instance.descriptor,
      routes: instance.routes,
      impact,
    });
    if (route === null) {
      return terminalVictimReplay(
        input,
        routeRecord,
        "rejected",
        "victim-impact-not-bound",
        evidenceRefs,
      );
    }
    assertPreparedRoute(input.family, instance, route);
    if (route !== routeRecord.route) {
      throw new Error("victim impact bound a route outside its issuer handle");
    }
  } catch (error) {
    return terminalVictimReplay(
      input,
      routeRecord,
      "failed",
      `victim-bind:${errorMessage(error)}`,
      evidenceRefs,
    );
  }

  let localApply: VictimReplayLocalResult | null = null;
  let exactPostState: CanonicalValue | null = null;
  let overlay: VictimReplayOverlayIntent | null = null;
  try {
    if (input.preState !== null) {
      const preState = sealCanonicalValue(input.preState);
      const applied = swap.replay.applyLocal({
        descriptor: instance.descriptor,
        route,
        preState,
        impact,
        source: input.source,
      });
      if (applied !== null) {
        localApply = sealVictimLocalApply(applied);
        evidenceRefs.push(`victim-local:${hashCanonical({
          amountOut: localApply.amountOut,
          postImpact: localApply.postImpact,
        })}`);
      }
    }
    if (swap.replay.exactPostState !== undefined) {
      const exact = swap.replay.exactPostState({
        descriptor: instance.descriptor,
        route,
        impact,
        source: input.source,
      });
      if (exact !== null) {
        exactPostState = sealCanonicalValue(exact);
        evidenceRefs.push(`victim-exact:${hashCanonical(exactPostState)}`);
      }
    }
    const builtOverlay = swap.replay.buildOverlay({
      descriptor: instance.descriptor,
      route,
      impact,
      source: input.source,
      validUntil: input.validUntil,
    });
    if (builtOverlay !== null) {
      overlay = sealVictimOverlay(builtOverlay);
      evidenceRefs.push(`victim-overlay:${hashCanonical(
        overlay as unknown as CanonicalValue,
      )}`);
    }
    if (localApply === null && exactPostState === null && overlay === null) {
      throw new Error("victim replay produced no usable result");
    }
  } catch (error) {
    return terminalVictimReplay(
      input,
      routeRecord,
      "failed",
      `victim-replay-derive:${errorMessage(error)}`,
      evidenceRefs,
    );
  }

  try {
    input.runtime.generationFence.assertCurrent(input.generation, input.source);
  } catch (error) {
    return terminalVictimReplay(
      input,
      routeRecord,
      "unresolved",
      `victim-replay-generation:${errorMessage(error)}`,
      evidenceRefs,
    );
  }
  const outcome = makeOutcome({
    familyId: input.family.plugin.manifest.familyId,
    lineageId: instance.lineageId,
    candidateKey: instance.candidateKey,
    instanceKey: instance.instanceKey,
    routeKey: route.routeKey,
    stage: "victim-replay",
    status: "verified",
    reasonCode: "victim-replay-derived",
    source: input.source,
    evidenceRefs,
  });
  return Object.freeze({
    status: "resolved" as const,
    familyId: input.family.plugin.manifest.familyId,
    candidateKey: instance.candidateKey,
    instanceKey: instance.instanceKey,
    route: input.route,
    source: Object.freeze({ ...input.source }),
    generation: input.generation,
    impact,
    localApply,
    exactPostState,
    overlay,
    validUntil: input.validUntil,
    evidenceRefs: Object.freeze(uniqueSorted(evidenceRefs)),
    outcome,
  });
}

export interface FamilyExecutionInvocation {
  readonly family: LoadedFamilyPlugin;
  readonly actionOwnership: Pick<FamilyCapabilityCatalog, "ownerOfAction">;
  readonly route: FamilyRouteRuntimeHandle;
  readonly exact: SealedFamilyExactQuoteHandle;
  /** Central planner-owned execution protection; Family code only encodes it. */
  readonly minAmountOut: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

interface ResolvedFamilyExecutionInvocation {
  readonly input: FamilyExecutionInvocation;
  readonly routeRecord: FamilyRouteRuntimeHandleRecord;
  readonly exactRecord: SealedFamilyExactQuoteHandleRecord;
}

/** S4 is deliberately synchronous: it has no scheduler or transport handle. */
export function buildFamilyExecutionFragment(
  input: FamilyExecutionInvocation,
): FamilyExecutionOutcome {
  let resolved: ResolvedFamilyExecutionInvocation | undefined;
  try {
    assertIssuedLoadedFamilyBox(input.family);
    const routeRecord = resolveFamilyRouteRuntimeHandle(
      input.family,
      input.route,
    );
    const exactRecord = resolveSealedFamilyExactQuoteHandle(
      input.family,
      input.exact,
    );
    resolved = Object.freeze({ input, routeRecord, exactRecord });
    assertExecutionInvocation(resolved);
    const fragment = input.family.plugin.execution.buildFragment({
      descriptor: routeRecord.instance.descriptor,
      route: routeRecord.route,
      amountIn: exactRecord.amountIn,
      quotedAmountOut: exactRecord.amountOut,
      minAmountOut: input.minAmountOut,
      exactEvidence: exactRecord.evidence,
      executor: exactRecord.executor,
      runtimeEvidence: exactRecord.runtimeEvidence,
    });
    assertFamilyOwnedPlanFragment({
      family: input.family,
      actionOwnership: input.actionOwnership,
      fragment,
    });
    const expectedEffects = input.family.plugin.execution.expectedEffects({
      descriptor: routeRecord.instance.descriptor,
      route: routeRecord.route,
      amountIn: exactRecord.amountIn,
      quotedAmountOut: exactRecord.amountOut,
    });
    if (!Array.isArray(expectedEffects)) {
      throw new Error("execution expectedEffects must return an array");
    }
    const sealedFragment = sealPlanFragment(fragment);
    const sealedEffects = Object.freeze(expectedEffects.map((effect) =>
      Object.freeze({ ...effect })
    ));
    const outcome = executionOutcome(resolved, "verified", "plan-fragment-built");
    return Object.freeze({
      status: "resolved" as const,
      fragment: sealedFragment,
      expectedEffects: sealedEffects,
      outcome,
    });
  } catch (error) {
    const status = error instanceof FamilyActionOwnershipError
      ? "rejected" as const
      : "failed" as const;
    return Object.freeze({
      status,
      outcome: terminalExecutionOutcome(
        input,
        resolved,
        status,
        `${status === "rejected" ? "action-ownership" : "execution-build"}:` +
          errorMessage(error),
      ),
    });
  }
}

/** Public gate shared by composition roots that assemble Family fragments. */
export function assertFamilyOwnedPlanFragment(input: {
  readonly family: LoadedFamilyBox;
  readonly actionOwnership: Pick<FamilyCapabilityCatalog, "ownerOfAction">;
  readonly fragment: PlanFragment;
}): void {
  assertIssuedLoadedFamilyBox(input.family);
  const fragment = requireObject(input.fragment, "PlanFragment") as PlanFragment;
  if (!Array.isArray(fragment.requirements) || !Array.isArray(fragment.nodes)) {
    throw new Error("PlanFragment must contain requirements and nodes arrays");
  }
  const owned = new Set(input.family.plugin.manifest.ownedActionAdapterIds);
  const infra = new Set(
    input.family.plugin.manifest.requiredInfraActionAdapterIds,
  );
  let ownedNodes = 0;
  const seen = new Set<object>();
  const visit = (node: ResolvedPlanNode): void => {
    validateResolvedPlanNode(node, seen);
    if (owned.has(node.adapterId)) {
      let owner: FamilyId;
      try {
        owner = input.actionOwnership.ownerOfAction(node.adapterId);
      } catch (error) {
        throw new FamilyActionOwnershipError(errorMessage(error));
      }
      if (owner !== input.family.plugin.manifest.familyId) {
        throw new FamilyActionOwnershipError(
          `ActionAdapter ${node.adapterId} is owned by ${owner}`,
        );
      }
      ownedNodes++;
    } else if (!infra.has(node.adapterId)) {
      throw new FamilyActionOwnershipError(
        `PlanFragment uses undeclared ActionAdapter ${node.adapterId}`,
      );
    }
    for (const child of node.children) visit(child);
    seen.delete(node);
  };
  for (const node of fragment.nodes) visit(node);
  if (ownedNodes === 0) {
    throw new FamilyActionOwnershipError(
      "PlanFragment has no Family-owned ActionAdapter",
    );
  }
}

function coalesceCandidateMatches(
  family: LoadedFamilyPlugin,
  matches: readonly FamilyLifecycleMatch[],
  source: CanonicalSource,
): {
  readonly candidates: readonly DecodedCandidateMatch[];
  readonly terminal: readonly PreparedCandidate[];
} {
  const candidates = new Map<string, DecodedCandidateMatch>();
  const conflicted = new Set<string>();
  const terminal: PreparedCandidate[] = [];
  const ordered = [...matches].sort((left, right) =>
    observationKey(left.observation).localeCompare(observationKey(right.observation)) ||
    left.matchedPatternId.localeCompare(right.matchedPatternId)
  );
  for (const match of ordered) {
    let candidate: FamilyCandidate | null;
    try {
      candidate = family.plugin.discovery.decodeCandidate({
        observation: match.observation,
        matchedPatternId: match.matchedPatternId,
      });
    } catch (error) {
      terminal.push(terminalCandidate({ family, source },
        observationKey(match.observation), {
          stage: "discovery",
          status: "failed",
          reasonCode: `candidate-decode:${errorMessage(error)}`,
        }));
      continue;
    }
    if (candidate === null) {
      terminal.push(terminalCandidate({ family, source },
        observationKey(match.observation), {
          stage: "discovery",
          status: "rejected",
          reasonCode: "candidate-decode-no-match",
        }));
      continue;
    }
    let candidateKey: string;
    let candidateFingerprint: string;
    try {
      candidateKey = canonicalKey(
        family.plugin.discovery.candidateKey(candidate),
        "candidate key",
      );
      candidateFingerprint = hashCanonical(
        candidate as unknown as CanonicalValue,
      );
    } catch (error) {
      terminal.push(terminalCandidate({ family, source },
        observationKey(match.observation), {
          stage: "discovery",
          status: "failed",
          reasonCode: `candidate-key:${errorMessage(error)}`,
        }));
      continue;
    }
    if (conflicted.has(candidateKey)) continue;
    const prior = candidates.get(candidateKey);
    if (prior === undefined) {
      candidates.set(candidateKey, Object.freeze({
        match,
        candidate,
        candidateKey,
        candidateFingerprint,
      }));
      continue;
    }
    if (prior.candidateFingerprint === candidateFingerprint) continue;
    candidates.delete(candidateKey);
    conflicted.add(candidateKey);
    terminal.push(terminalCandidate({ family, source }, candidateKey, {
      stage: "discovery",
      status: "failed",
      reasonCode: "candidate-key-conflicting-identity-input",
    }));
  }
  return Object.freeze({
    candidates: Object.freeze([...candidates.values()].sort((left, right) =>
      left.candidateKey.localeCompare(right.candidateKey)
    )),
    terminal: Object.freeze(terminal),
  });
}

function reconcilePreparedInstances(
  familyId: FamilyId,
  source: CanonicalSource,
  settled: readonly PreparedCandidate[],
): {
  readonly instances: readonly PreparedFamilyInstance[];
  readonly outcomes: readonly AdapterInstanceOutcome[];
} {
  const outcomes = settled.flatMap((item) => item.outcomes);
  const byInstance = new Map<InstanceKey, PreparedFamilyInstance[]>();
  for (const item of settled) {
    if (item.instance === null) continue;
    const siblings = byInstance.get(item.instance.instanceKey);
    if (siblings === undefined) byInstance.set(item.instance.instanceKey, [item.instance]);
    else siblings.push(item.instance);
  }
  const instances: PreparedFamilyInstance[] = [];
  for (const siblings of byInstance.values()) {
    const ordered = [...siblings].sort((left, right) =>
      left.candidateKey.localeCompare(right.candidateKey)
    );
    const fingerprints = new Set(ordered.map(preparedInstanceFingerprint));
    if (fingerprints.size === 1) {
      instances.push(ordered[0]);
      continue;
    }
    for (const instance of ordered) {
      outcomes.push(makeOutcome({
        familyId,
        lineageId: instance.lineageId,
        candidateKey: instance.candidateKey,
        instanceKey: instance.instanceKey,
        stage: "identity",
        status: "failed",
        reasonCode: "conflicting-instance-identity",
        source,
        evidenceRefs: instance.evidenceRefs,
      }));
    }
  }
  return Object.freeze({
    instances: Object.freeze(instances.sort((left, right) =>
      left.instanceKey.localeCompare(right.instanceKey)
    )),
    outcomes: Object.freeze(outcomes),
  });
}

function preparedInstanceFingerprint(instance: PreparedFamilyInstance): string {
  return hashCanonical({
    familyId: instance.familyId,
    lineageId: instance.lineageId,
    instanceKey: instance.instanceKey,
    staticBindingFingerprint: instance.staticBindingFingerprint,
    staticEvidenceFingerprint: instance.staticEvidenceFingerprint,
    routes: instance.routes.map((route) => route.routeKey).sort(),
    pricingInstances: instance.pricingInstances.map((state) => ({
      stateKey: state.stateKey,
      stateInstanceKey: state.stateInstanceKey,
      groupBindingFingerprint: state.groupBindingFingerprint,
      staticBindingFingerprint: state.staticBindingFingerprint,
      snapshotCompatibilityFingerprint: state.snapshotCompatibilityFingerprint,
      staticEvidenceFingerprint: state.staticEvidenceFingerprint,
      currentEvidenceFingerprint: state.currentEvidenceFingerprint,
    })).sort((left, right) => left.stateKey.localeCompare(right.stateKey)),
  });
}

function createFamilySharedBindingBatchResolver(input: {
  readonly family: LoadedFamilyPlugin;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
}): FamilySharedBindingBatchResolver {
  const cache = new Map<string, Promise<SharedBindingResolution>>();
  return Object.freeze({
    resolve(request: SharedBindingRequestKey): Promise<SharedBindingResolution> {
      if (input.family.plugin.sharedBindings === undefined) {
        throw new Error("Family without shared binding semantics requested a binding");
      }
      const normalized = normalizeSharedBindingRequest(request);
      const cacheKey = `family-shared-binding:${hashCanonical({
        familyId: input.family.plugin.manifest.familyId,
        bindingKind: normalized.bindingKind,
        bindingKey: normalized.bindingKey,
        capabilityHash: input.family.hashes.instance.contentHash,
        source: canonicalSourceProjection(input.source),
      })}`;
      const existing = cache.get(cacheKey);
      if (existing !== undefined) return existing;
      const pending = executeFamilySharedBinding({
        ...input,
        request: normalized,
      });
      cache.set(cacheKey, pending);
      return pending;
    },
  });
}

async function executeFamilySharedBinding(input: {
  readonly family: LoadedFamilyPlugin;
  readonly request: SharedBindingRequestKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
}): Promise<SharedBindingResolution> {
  const semantics = input.family.plugin.sharedBindings;
  if (semantics === undefined) {
    throw new Error("Family without shared binding semantics requested a binding");
  }
  const program: RequestProgram<
    SharedBindingRequestKey,
    SharedBindingProgramEvidence
  > = Object.freeze({
    requirements: (request: SharedBindingRequestKey): RequestRequirements =>
      semantics.program.requirements(request),
    buildRequests: (request: SharedBindingRequestKey): readonly AdapterRequest[] =>
      semantics.program.buildRequests(request),
    decode: (decodeInput: {
      readonly programInput: SharedBindingRequestKey;
      readonly results: readonly AdapterRequestResult[];
    }): SharedBindingProgramEvidence => {
      const { programInput, results } = decodeInput;
      const evidence = semantics.program.decode({ programInput, results });
      const canonicalProjection = semantics.canonicalProjection(evidence);
      // Validate synchrony and canonical encodability inside executeAdapterWork,
      // so malformed Adapter output remains an unresolved shard read.
      hashCanonical(canonicalProjection);
      return Object.freeze({ canonicalProjection });
    },
  });
  const work = await executeAdapterWork({
    intent: {
      stage: "instance-static",
      familyId: input.family.plugin.manifest.familyId,
      source: input.source,
      generation: input.generation,
      program,
      programInput: input.request,
    },
    runtime: input.runtime,
  });
  if (work.status === "unresolved") {
    return Object.freeze({ status: "unresolved" as const, work });
  }
  const ref = issueFamilySharedBindingRef({
    familyId: input.family.plugin.manifest.familyId,
    bindingKind: input.request.bindingKind,
    bindingKey: input.request.bindingKey,
    fingerprint: hashCanonical({
      familyId: input.family.plugin.manifest.familyId,
      bindingKind: input.request.bindingKind,
      bindingKey: input.request.bindingKey,
      capabilityHash: input.family.hashes.instance.contentHash,
      canonicalProjection: work.executed.evidence.canonicalProjection,
      trustedEvidence: work.executed.trustedResultsFingerprint,
    }),
  });
  return Object.freeze({
    status: "resolved" as const,
    ref,
    evidenceRefs: Object.freeze([
      `shared-binding:${ref.fingerprint}`,
      transportEvidenceRef(work.executed.trustedResultsFingerprint),
    ]),
  });
}

function issueFamilySharedBindingRef(input: FamilySharedBindingRef):
  FamilySharedBindingRef {
  const ref = Object.freeze({
    familyId: input.familyId,
    bindingKind: input.bindingKind,
    bindingKey: input.bindingKey,
    fingerprint: input.fingerprint,
  });
  issuedFamilySharedBindingRefs.add(ref);
  return ref;
}

async function prepareCandidate(input: {
  readonly family: LoadedFamilyPlugin;
  readonly decoded: DecodedCandidateMatch;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly sharedBindingResolver: FamilySharedBindingBatchResolver;
  readonly limits: AdapterFamilyLifecycleLimits;
}): Promise<PreparedCandidate> {
  const familyId = input.family.plugin.manifest.familyId;
  const { candidate, candidateKey } = input.decoded;
  const outcomes: AdapterInstanceOutcome[] = [makeOutcome({
    familyId,
    candidateKey,
    stage: "discovery",
    status: "candidate",
    reasonCode: "candidate-decoded",
    source: input.source,
    evidenceRefs: [],
  })];

  const identityResult = await resolveIdentity({
    family: input.family,
    candidate: { candidate, candidateKey },
    source: input.source,
    generation: input.generation,
    runtime: input.runtime,
    maxSteps: input.limits.maxIdentityStepsPerVariant,
  });
  if (identityResult.status !== "verified") {
    outcomes.push(makeOutcome({
      familyId,
      candidateKey,
      stage: "identity",
      status: identityResult.status,
      reasonCode: identityResult.reasonCode,
      source: input.source,
      evidenceRefs: identityResult.evidenceRefs,
    }));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  const identity = identityResult.identity;
  let instanceKey: InstanceKey;
  try {
    validateIdentity(identity, input.family, undefined);
    instanceKey = input.family.plugin.instance.instanceKey(identity);
    canonicalKey(instanceKey, "instance key");
  } catch (error) {
    outcomes.push(makeOutcome({
      familyId,
      candidateKey,
      stage: "identity",
      status: "failed",
      reasonCode: `identity-result:${errorMessage(error)}`,
      source: input.source,
      evidenceRefs: identityResult.evidenceRefs,
    }));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  outcomes.push(makeOutcome({
    familyId,
    lineageId: identity.lineageId,
    candidateKey,
    instanceKey,
    stage: "identity",
    status: "verified",
    reasonCode: "identity-proof-verified",
    source: input.source,
    evidenceRefs: identityResult.evidenceRefs,
  }));

  let draft: object;
  try {
    draft = requireObject(
      input.family.plugin.instance.compileDraft(identity),
      "instance draft",
    );
  } catch (error) {
    outcomes.push(instanceFailure(input, candidateKey, identity, instanceKey,
      "instance-compile", "failed", `draft:${errorMessage(error)}`,
      identityResult.evidenceRefs));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }

  let instanceStaticEvidence: unknown;
  let instanceStaticFingerprint = hashCanonical([]);
  const instanceEvidenceRefs = [...identityResult.evidenceRefs];
  if (input.family.plugin.instance.staticEvidence !== undefined) {
    const work = await executeStaticEvidenceWork({
      stage: "instance-static",
      familyId,
      instanceKey,
      subjectKey: instanceKey,
      capabilityHash: input.family.hashes.instance.contentHash,
      source: input.source,
      generation: input.generation,
      program: input.family.plugin.instance.staticEvidence,
      programInput: draft,
      runtime: input.runtime,
    });
    if (work.status === "unresolved") {
      outcomes.push(workFailureOutcome({
        work,
        familyId,
        lineageId: identity.lineageId,
        candidateKey,
        instanceKey,
        stage: "instance-compile",
        source: input.source,
        evidenceRefs: instanceEvidenceRefs,
      }));
      return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
    }
    instanceStaticEvidence = work.executed.evidence;
    instanceStaticFingerprint = work.executed.trustedResultsFingerprint;
    instanceEvidenceRefs.push(transportEvidenceRef(instanceStaticFingerprint));
    if (work.cacheKey !== undefined) {
      instanceEvidenceRefs.push(`static-evidence-cache:${work.cacheKey}`);
    }
  }

  let preliminaryDescriptor: CompiledInstanceDescriptor;
  let requestedBindings: readonly SharedBindingRequestKey[];
  try {
    preliminaryDescriptor = requireObject(
      input.family.plugin.instance.finalizeDescriptor({
        identity,
        draft,
        staticEvidence: instanceStaticEvidence,
        sharedBindings: Object.freeze([]),
      }),
      "preliminary instance descriptor",
    ) as CompiledInstanceDescriptor;
    validateDescriptor(preliminaryDescriptor, identity, instanceKey, familyId);
    requestedBindings = declareSharedBindingRequests(
      input.family,
      preliminaryDescriptor,
    );
  } catch (error) {
    outcomes.push(instanceFailure(input, candidateKey, identity, instanceKey,
      "instance-compile", "failed", `preliminary:${errorMessage(error)}`,
      instanceEvidenceRefs));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }

  const bindingResolutions = await Promise.all(
    requestedBindings.map((request) =>
      input.sharedBindingResolver.resolve(request)
    ),
  );
  const unresolvedBinding = bindingResolutions.find(
    (item): item is UnresolvedSharedBinding => item.status === "unresolved",
  );
  if (unresolvedBinding !== undefined) {
    outcomes.push(workFailureOutcome({
      work: unresolvedBinding.work,
      familyId,
      lineageId: identity.lineageId,
      candidateKey,
      instanceKey,
      stage: "instance-compile",
      source: input.source,
      evidenceRefs: instanceEvidenceRefs,
    }));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  const resolvedBindings = bindingResolutions as readonly ResolvedSharedBinding[];
  instanceEvidenceRefs.push(...resolvedBindings.flatMap((item) =>
    item.evidenceRefs
  ));

  let descriptor: CompiledInstanceDescriptor;
  let sharedBindings: readonly FamilySharedBindingRef[];
  let instanceBindingFingerprint: string;
  try {
    sharedBindings = sealSharedBindings(
      resolvedBindings.map((item) => item.ref),
      familyId,
    );
    descriptor = input.family.plugin.sharedBindings === undefined
      ? preliminaryDescriptor
      : requireObject(
          input.family.plugin.instance.finalizeDescriptor({
            identity,
            draft,
            staticEvidence: instanceStaticEvidence,
            sharedBindings,
          }),
          "final instance descriptor",
        ) as CompiledInstanceDescriptor;
    validateDescriptor(descriptor, identity, instanceKey, familyId);
    deepFreezeOpaqueRuntimeValue(descriptor, "compiled instance descriptor");
    const finalRequests = declareSharedBindingRequests(input.family, descriptor);
    assertSameSharedBindingRequests(requestedBindings, finalRequests);
    validateSharedBindingReferences(finalRequests, sharedBindings);
    instanceBindingFingerprint = hashCanonical({
      capability: input.family.hashes.instance.contentHash,
      projection: input.family.plugin.instance.staticBindingProjection(descriptor),
      sharedBindings: sharedBindingProjection(sharedBindings),
    });
  } catch (error) {
    outcomes.push(instanceFailure(input, candidateKey, identity, instanceKey,
      "instance-compile", "failed", `finalize:${errorMessage(error)}`,
      instanceEvidenceRefs));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  outcomes.push(makeOutcome({
    familyId,
    lineageId: identity.lineageId,
    candidateKey,
    instanceKey,
    stage: "instance-compile",
    status: "verified",
    reasonCode: "instance-descriptor-compiled",
    source: input.source,
    evidenceRefs: instanceEvidenceRefs,
  }));

  let routes: readonly FamilyRouteDescriptor[];
  try {
    routes = validateRoutes(
      input.family.plugin.routes.project({ descriptor }),
      descriptor,
      input.family,
    );
  } catch (error) {
    outcomes.push(instanceFailure(input, candidateKey, identity, instanceKey,
      "route-projection", "failed", `projection:${errorMessage(error)}`,
      instanceEvidenceRefs));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  if (routes.length === 0) {
    outcomes.push(instanceFailure(input, candidateKey, identity, instanceKey,
      "route-projection", "rejected", "no-verified-routes",
      instanceEvidenceRefs));
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  outcomes.push(makeOutcome({
    familyId,
    lineageId: identity.lineageId,
    candidateKey,
    instanceKey,
    stage: "route-projection",
    status: "verified",
    reasonCode: "verified-routes-projected",
    source: input.source,
    evidenceRefs: instanceEvidenceRefs,
  }));

  const groups = groupRoutes(input.family, routes, input, candidateKey,
    identity, instanceKey, outcomes, instanceEvidenceRefs);
  const pricing = await Promise.all([...groups.entries()].map(
    ([stateKey, stateRoutes]) => preparePricingState({
      family: input.family,
      candidateKey,
      identity,
      descriptor,
      instanceKey,
      stateKey,
      routes: stateRoutes,
      sharedBindings,
      source: input.source,
      generation: input.generation,
      runtime: input.runtime,
      maxDependentReadRounds: input.limits.maxDependentReadRounds,
      inheritedEvidenceRefs: instanceEvidenceRefs,
    }),
  ));
  outcomes.push(...pricing.flatMap((item) => item.outcomes));
  const states = pricing.flatMap((item) => item.state === null ? [] : [item.state]);
  if (states.length === 0) {
    return Object.freeze({ instance: null, outcomes: Object.freeze(outcomes) });
  }
  const publishedRoutes = states.flatMap((state) => state.routes);
  const allEvidenceRefs = uniqueSorted([
    ...instanceEvidenceRefs,
    ...states.flatMap((state) => state.evidenceRefs),
  ]);
  const prepared = {
    familyId,
    lineageId: identity.lineageId,
    candidateKey,
    instanceKey,
    descriptor,
    routes: Object.freeze(publishedRoutes),
    routeHandles: [] as FamilyRouteRuntimeHandle[],
    pricingInstances: Object.freeze(states),
    staticBindingFingerprint: instanceBindingFingerprint,
    staticEvidenceFingerprint: instanceStaticFingerprint,
    evidenceRefs: Object.freeze(allEvidenceRefs),
  } satisfies PreparedFamilyInstance;
  prepared.routeHandles = Object.freeze(publishedRoutes.map((route) =>
    issueFamilyRouteRuntimeHandle({
      family: input.family,
      instance: prepared,
      route,
      source: input.source,
      generation: input.generation,
    })
  )) as unknown as FamilyRouteRuntimeHandle[];
  Object.freeze(prepared);
  registerIssuedPreparedFamilyInstance({
    family: input.family,
    instance: prepared,
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
  });
  return Object.freeze({ instance: prepared, outcomes: Object.freeze(outcomes) });
}

async function resolveIdentity(input: {
  readonly family: LoadedFamilyBox;
  readonly candidate: CandidateContext;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly maxSteps: number;
}): Promise<IdentityResult> {
  const plugin = runtimeInstanceLifecyclePlugin(input.family);
  const applicable: IdentityVariant<FamilyCandidate, VerifiedIdentity, unknown>[] = [];
  const applicabilityFailures: string[] = [];
  for (const variant of plugin.identity.variants) {
    try {
      if (variant.applies(input.candidate.candidate)) applicable.push(variant);
    } catch (error) {
      applicabilityFailures.push(
        `variant-applies:${variant.id}:${errorMessage(error)}`,
      );
    }
  }
  if (applicable.length === 0 && applicabilityFailures.length === 0) {
    return terminalIdentity("unsupported-variant", "no-applicable-identity-variant", []);
  }

  const rejected: string[] = [];
  const unresolved: string[] = [];
  const failed = [...applicabilityFailures];
  const evidenceRefs: string[] = [];
  const verified: Array<{
    readonly variant: IdentityVariant<FamilyCandidate, VerifiedIdentity, unknown>;
    readonly identity: VerifiedIdentity;
    readonly identityKey: string;
  }> = [];
  for (const variant of applicable) {
    let evidence: unknown;
    let step = 0;
    let successfulEvidenceSteps = 0;
    for (;;) {
      const stepInput = Object.freeze({
        candidate: input.candidate.candidate,
        ...(evidence === undefined ? {} : { evidence }),
        step,
      });
      let decision;
      try {
        decision = variant.decide(stepInput);
      } catch (error) {
        failed.push(
          `variant-decision:${variant.id}:${errorMessage(error)}`,
        );
        break;
      }
      if (decision.status === "verified") {
        if (
          (plugin.manifest.domain === "protocol" ||
            plugin.manifest.domain === "credit") &&
          successfulEvidenceSteps === 0
        ) {
          failed.push(`protocol-proof-missing:${variant.id}`);
          break;
        }
        try {
          validateIdentity(decision.identity, input.family, variant);
          const identityKey = canonicalKey(
            plugin.identity.identityKey(decision.identity),
            "identity key",
          );
          verified.push({ variant, identity: decision.identity, identityKey });
        } catch (error) {
          failed.push(
            `variant-identity:${variant.id}:${errorMessage(error)}`,
          );
        }
        break;
      }
      if (decision.status === "rejected") {
        if (
          (plugin.manifest.domain === "protocol" ||
            plugin.manifest.domain === "credit") &&
          successfulEvidenceSteps === 0
        ) {
          failed.push(`protocol-negative-proof-missing:${variant.id}`);
          break;
        }
        rejected.push(`${variant.id}:${decision.reason}`);
        break;
      }
      if (step >= input.maxSteps) {
        unresolved.push(`${variant.id}:identity-step-budget-exhausted`);
        break;
      }

      const program: RequestProgram<typeof stepInput, IdentityProgramEvidence> = {
        requirements: (programInput) => variant.requirements(programInput),
        buildRequests: (programInput) => variant.buildRequests(programInput),
        decode: ({ programInput, results }) => ({
          evidence: variant.decode({ step: programInput, results }),
          successfulResultCount: results.filter((result) => result.ok).length,
        }),
      };
      const work = await executeAdapterWork({
        intent: {
          stage: "identity",
          familyId: plugin.manifest.familyId,
          source: input.source,
          generation: input.generation,
          program,
          programInput: stepInput,
        },
        runtime: input.runtime,
      });
      if (work.status === "unresolved") {
        unresolved.push(`${variant.id}:${work.failure.code}`);
        if (work.receipt.dedupeKey !== null) {
          evidenceRefs.push(`work:${work.receipt.dedupeKey}`);
        }
        break;
      }
      evidence = work.executed.evidence.evidence;
      if (work.executed.evidence.successfulResultCount > 0) {
        successfulEvidenceSteps++;
        evidenceRefs.push(transportEvidenceRef(
          work.executed.trustedResultsFingerprint,
        ));
      }
      step++;
    }
  }

  if (verified.length > 0) {
    const identityKeys = uniqueSorted(verified.map((item) => item.identityKey));
    if (identityKeys.length !== 1) {
      return terminalIdentity(
        "failed",
        `identity-conflict:${identityKeys.join("|")}`,
        evidenceRefs,
      );
    }
    const primary = verified[0]!.identity;
    const provenance = mergeIdentityProvenance(
      verified.flatMap((item) => item.identity.provenance),
    );
    const merged = Object.freeze({
      ...primary,
      provenance,
    }) as VerifiedIdentity;
    try {
      validateIdentity(merged, input.family, undefined);
      const mergedKey = canonicalKey(
        plugin.identity.identityKey(merged),
        "merged identity key",
      );
      if (mergedKey !== identityKeys[0]) {
        throw new Error("merged provenance changed the canonical identity key");
      }
    } catch (error) {
      return terminalIdentity(
        "failed",
        `identity-merge:${errorMessage(error)}`,
        evidenceRefs,
      );
    }
    return Object.freeze({
      status: "verified",
      identity: merged,
      evidenceRefs: Object.freeze(uniqueSorted(evidenceRefs)),
    });
  }
  if (unresolved.length > 0) {
    return terminalIdentity(
      "unresolved",
      `identity-work-unresolved:${unresolved.sort().join("|")}`,
      evidenceRefs,
    );
  }
  if (failed.length > 0) {
    return terminalIdentity(
      "failed",
      `identity-proof-failed:${failed.sort().join("|")}`,
      evidenceRefs,
    );
  }
  return terminalIdentity(
    "rejected",
    `identity-proof-rejected:${rejected.sort().join("|")}`,
    evidenceRefs,
  );
}

function mergeIdentityProvenance(
  items: readonly VerifiedIdentity["provenance"][number][],
): VerifiedIdentity["provenance"] {
  const byFingerprint = new Map<string, VerifiedIdentity["provenance"][number]>();
  for (const item of items) {
    const fingerprint = hashCanonical({
      kind: canonicalKey(item.kind, "identity provenance kind"),
      subject: canonicalKey(item.subject, "identity provenance subject"),
      evidenceHash: item.evidenceHash ?? null,
    });
    byFingerprint.set(fingerprint, Object.freeze({ ...item }));
  }
  return Object.freeze(
    [...byFingerprint]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item),
  );
}

function groupRoutes(
  family: LoadedFamilyPlugin,
  routes: readonly FamilyRouteDescriptor[],
  input: { readonly source: CanonicalSource },
  candidateKey: string,
  identity: VerifiedIdentity,
  instanceKey: InstanceKey,
  outcomes: AdapterInstanceOutcome[],
  evidenceRefs: readonly string[],
): ReadonlyMap<string, readonly FamilyRouteDescriptor[]> {
  const groups = new Map<string, FamilyRouteDescriptor[]>();
  for (const route of routes) {
    try {
      const stateKey = canonicalKey(
        family.plugin.pricing.stateKey(route),
        "pricing state key",
      );
      const existing = groups.get(stateKey);
      if (existing === undefined) groups.set(stateKey, [route]);
      else existing.push(route);
    } catch (error) {
      outcomes.push(makeOutcome({
        familyId: family.plugin.manifest.familyId,
        lineageId: identity.lineageId,
        candidateKey,
        instanceKey,
        routeKey: route.routeKey,
        stage: "pricing-compile",
        status: "failed",
        reasonCode: `state-key:${errorMessage(error)}`,
        source: input.source,
        evidenceRefs,
      }));
    }
  }
  return new Map([...groups].map(([key, value]) => [key, Object.freeze(value)]));
}

async function preparePricingState(input: {
  readonly family: LoadedFamilyPlugin;
  readonly candidateKey: string;
  readonly identity: VerifiedIdentity;
  readonly descriptor: CompiledInstanceDescriptor;
  readonly instanceKey: InstanceKey;
  readonly stateKey: string;
  readonly routes: readonly FamilyRouteDescriptor[];
  readonly sharedBindings: readonly FamilySharedBindingRef[];
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly maxDependentReadRounds: number;
  readonly inheritedEvidenceRefs: readonly string[];
}): Promise<PricingPreparation> {
  const familyId = input.family.plugin.manifest.familyId;
  const outcomes: AdapterInstanceOutcome[] = [];
  const evidenceRefs = [...input.inheritedEvidenceRefs];
  let draft: object;
  let groupBindingFingerprint: string;
  let staticBindingFingerprint: string;
  let compatibilityFingerprint: string;
  try {
    groupBindingFingerprint = validateAndFingerprintStateInstanceGroup({
      familyId,
      instanceKey: input.instanceKey,
      stateKey: input.stateKey,
      routes: input.routes,
    });
    staticBindingFingerprint = hashCanonical({
      capability: input.family.hashes.pricing.contentHash,
      stateKey: input.stateKey,
      projection: input.family.plugin.pricing.staticBindingProjection({
        descriptor: input.descriptor,
        routes: input.routes,
      }),
      sharedBindings: sharedBindingProjection(input.sharedBindings),
    });
    compatibilityFingerprint = hashCanonical({
      capability: input.family.hashes.pricing.contentHash,
      projection: input.family.plugin.pricing.snapshotCompatibilityProjection({
        descriptor: input.descriptor,
        routes: input.routes,
      }),
    });
    draft = requireObject(input.family.plugin.pricing.compileDraft({
      descriptor: input.descriptor,
      stateKey: input.stateKey,
      routes: input.routes,
    }), "pricing draft");
  } catch (error) {
    outcomes.push(pricingOutcome(input, "pricing-compile", "failed",
      `draft:${errorMessage(error)}`, evidenceRefs));
    return sealPricingPreparation(null, outcomes);
  }

  let staticEvidence: unknown;
  let staticEvidenceFingerprint = hashCanonical([]);
  if (input.family.plugin.pricing.staticEvidence !== undefined) {
    const work = await executeStaticEvidenceWork({
      stage: "pricing-static",
      familyId,
      instanceKey: input.instanceKey,
      subjectKey: `${input.instanceKey}:${input.stateKey}`,
      capabilityHash: input.family.hashes.pricing.contentHash,
      source: input.source,
      generation: input.generation,
      program: input.family.plugin.pricing.staticEvidence,
      programInput: draft,
      runtime: input.runtime,
    });
    if (work.status === "unresolved") {
      outcomes.push(workFailureOutcome({
        work,
        familyId,
        lineageId: input.identity.lineageId,
        candidateKey: input.candidateKey,
        instanceKey: input.instanceKey,
        stateKey: input.stateKey,
        stage: "pricing-compile",
        source: input.source,
        evidenceRefs,
      }));
      return sealPricingPreparation(null, outcomes);
    }
    staticEvidence = work.executed.evidence;
    staticEvidenceFingerprint = work.executed.trustedResultsFingerprint;
    evidenceRefs.push(transportEvidenceRef(staticEvidenceFingerprint));
    if (work.cacheKey !== undefined) {
      evidenceRefs.push(`static-evidence-cache:${work.cacheKey}`);
    }
  }

  let pricingDescriptor: object;
  let dependencies: readonly string[];
  try {
    pricingDescriptor = requireObject(
      input.family.plugin.pricing.finalizePricingDescriptor({
        draft,
        staticEvidence,
        sharedBindings: input.sharedBindings,
      }),
      "pricing descriptor",
    );
    deepFreezeOpaqueRuntimeValue(pricingDescriptor, "pricing descriptor");
    dependencies = validateDependencies(
      input.family.plugin.pricing.dependencies({
        descriptor: pricingDescriptor,
        routes: input.routes,
      }),
    );
  } catch (error) {
    outcomes.push(pricingOutcome(input, "pricing-compile", "failed",
      `finalize:${errorMessage(error)}`, evidenceRefs));
    return sealPricingPreparation(null, outcomes);
  }
  outcomes.push(pricingOutcome(input, "pricing-compile", "verified",
    "pricing-descriptor-compiled", evidenceRefs));

  const currentInput = Object.freeze({
    descriptor: pricingDescriptor,
    routes: input.routes,
    source: input.source,
  });
  const initialProgram: RequestProgram<typeof currentInput, ResultSetEvidence> = {
    requirements: (programInput) =>
      input.family.plugin.pricing.current.requirements(programInput),
    buildRequests: (programInput) =>
      input.family.plugin.pricing.current.buildRequests(programInput),
    decode: ({ results }) => ({ results }),
  };
  const initial = await executeCurrentWork(input, initialProgram, currentInput);
  if (initial.status === "unresolved") {
    outcomes.push(workFailureOutcome({
      work: initial,
      familyId,
      lineageId: input.identity.lineageId,
      candidateKey: input.candidateKey,
      instanceKey: input.instanceKey,
      stateKey: input.stateKey,
      stage: "pricing-current",
      source: input.source,
      evidenceRefs,
    }));
    return sealPricingPreparation(null, outcomes);
  }
  const initialResults = Object.freeze([
    ...initial.executed.evidence.results,
  ]);
  const dependentEvidence: unknown[] = [];
  const currentFingerprints = [initial.executed.trustedResultsFingerprint];
  evidenceRefs.push(transportEvidenceRef(initial.executed.trustedResultsFingerprint));

  const dependentBuilder = input.family.plugin.pricing.current
    .buildDependentProgram;
  let completedRound = 0;
  if (dependentBuilder !== undefined) {
    for (;;) {
      let declared: ReturnType<typeof dependentBuilder>;
      try {
        declared = dependentBuilder({
          current: currentInput,
          completedRound,
          initialResults,
          priorEvidence: Object.freeze([...dependentEvidence]),
        });
      } catch (error) {
        outcomes.push(pricingOutcome(input, "pricing-current", "failed",
          `dependent-build:${errorMessage(error)}`, evidenceRefs));
        return sealPricingPreparation(null, outcomes);
      }
      if (declared === null) break;
      if (completedRound >= input.maxDependentReadRounds) {
        outcomes.push(pricingOutcome(input, "pricing-current", "unresolved",
          "dependent-read-round-budget-exhausted", evidenceRefs));
        return sealPricingPreparation(null, outcomes);
      }
      let requirements: RequestRequirements;
      let requests: readonly AdapterRequest[];
      let decode: (results: readonly AdapterRequestResult[]) => unknown;
      try {
        const bound = requireObject(
          declared,
          "dependent request program",
        ) as unknown as {
          readonly requirements: RequestRequirements;
          readonly requests: readonly AdapterRequest[];
          decode(results: readonly AdapterRequestResult[]): unknown;
        };
        requirements = bound.requirements;
        if (!Array.isArray(bound.requests)) {
          throw new Error("dependent program requests must be an array");
        }
        requests = Object.freeze([...bound.requests]);
        if (typeof bound.decode !== "function") {
          throw new Error("dependent program decode must be a function");
        }
        decode = bound.decode.bind(bound);
      } catch (error) {
        outcomes.push(pricingOutcome(input, "pricing-current", "failed",
          `dependent-program:${errorMessage(error)}`, evidenceRefs));
        return sealPricingPreparation(null, outcomes);
      }
      const dependentProgram: RequestProgram<
        typeof currentInput,
        unknown
      > = {
        requirements: () => requirements,
        buildRequests: () => requests,
        decode: ({ results: roundResults }) => decode(roundResults),
      };
      const round = await executeCurrentWork(
        input,
        dependentProgram,
        currentInput,
      );
      if (round.status === "unresolved") {
        outcomes.push(workFailureOutcome({
          work: round,
          familyId,
          lineageId: input.identity.lineageId,
          candidateKey: input.candidateKey,
          instanceKey: input.instanceKey,
          stateKey: input.stateKey,
          stage: "pricing-current",
          source: input.source,
          evidenceRefs,
        }));
        return sealPricingPreparation(null, outcomes);
      }
      dependentEvidence.push(round.executed.evidence);
      currentFingerprints.push(round.executed.trustedResultsFingerprint);
      evidenceRefs.push(transportEvidenceRef(
        round.executed.trustedResultsFingerprint,
      ));
      completedRound++;
    }
  }

  let snapshot: object;
  let mids: ReadonlyMap<RouteKey, RouteVenueMid>;
  let unavailable: ReadonlyMap<RouteKey, string>;
  try {
    snapshot = requireObject(
      input.family.plugin.pricing.current.decodeSnapshot({
        descriptor: pricingDescriptor,
        initialResults,
        dependentEvidence: Object.freeze([...dependentEvidence]),
      }),
      "pricing snapshot",
    );
    deepFreezeOpaqueRuntimeValue(snapshot, "pricing snapshot");
    mids = validateRouteMap(
      input.family.plugin.pricing.current.deriveMids({
        descriptor: pricingDescriptor,
        snapshot,
        routes: input.routes,
      }),
      input.routes,
      "mid",
    ) as ReadonlyMap<RouteKey, RouteVenueMid>;
    unavailable = input.family.plugin.pricing.current.classifyUnavailable ===
        undefined
      ? new SealedReadonlyMap<RouteKey, string>(new Map())
      : validateRouteMap(
          input.family.plugin.pricing.current.classifyUnavailable({
            descriptor: pricingDescriptor,
            snapshot,
            routes: input.routes,
          }),
          input.routes,
          "unavailable",
        ) as ReadonlyMap<RouteKey, string>;
    validateRouteClassifications(input.routes, mids, unavailable);
  } catch (error) {
    outcomes.push(pricingOutcome(input, "pricing-current", "failed",
      `decode:${errorMessage(error)}`, evidenceRefs));
    return sealPricingPreparation(null, outcomes);
  }

  for (const [routeKey, reason] of unavailable) {
    outcomes.push(makeOutcome({
      familyId,
      lineageId: input.identity.lineageId,
      candidateKey: input.candidateKey,
      instanceKey: input.instanceKey,
      stateKey: input.stateKey,
      routeKey,
      stage: "pricing-current",
      status: "rejected",
      reasonCode: `behavior-proven-unavailable:${canonicalKey(reason, "reason")}`,
      source: input.source,
      evidenceRefs,
    }));
  }
  if (mids.size > 0) {
    outcomes.push(pricingOutcome(input, "pricing-current", "verified",
      "snapshot-and-mids-derived", evidenceRefs));
  }
  const currentEvidenceFingerprint = hashCanonical(
    [...currentFingerprints].sort(),
  );
  const state: PreparedPricingStateInstance = Object.freeze({
    familyId,
    lineageId: input.identity.lineageId,
    instanceKey: input.instanceKey,
    stateKey: input.stateKey,
    stateInstanceKey: `state-instance:${hashCanonical({
      familyId,
      instanceKey: input.instanceKey,
      stateKey: input.stateKey,
    })}`,
    routes: Object.freeze([...input.routes]),
    pricingDescriptor,
    snapshot,
    mids,
    unavailable,
    dependencies,
    groupBindingFingerprint,
    staticBindingFingerprint,
    snapshotCompatibilityFingerprint: compatibilityFingerprint,
    staticEvidenceFingerprint,
    currentEvidenceFingerprint,
    evidenceRefs: Object.freeze(uniqueSorted(evidenceRefs)),
  });
  return sealPricingPreparation(state, outcomes);
}

function executeCurrentWork<Input, Evidence>(
  input: {
    readonly family: LoadedFamilyPlugin;
    readonly instanceKey: InstanceKey;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly runtime: CentralAdapterRuntime;
  },
  program: RequestProgram<Input, Evidence>,
  programInput: Input,
): Promise<AdapterWorkOutcome<Evidence>> {
  return executeAdapterWork({
    intent: {
      stage: "pricing-current",
      familyId: input.family.plugin.manifest.familyId,
      instanceKey: input.instanceKey,
      source: input.source,
      generation: input.generation,
      program,
      programInput,
    },
    runtime: input.runtime,
  });
}

function validateIdentity(
  identity: VerifiedIdentity,
  family: LoadedFamilyBox,
  variant: IdentityVariant<FamilyCandidate, VerifiedIdentity, unknown> | undefined,
): void {
  requireObject(identity, "verified identity");
  if (identity.familyId !== family.plugin.manifest.familyId) {
    throw new Error("identity familyId escaped its Family");
  }
  if (!family.plugin.manifest.supportedLineages.includes(identity.lineageId)) {
    throw new Error("identity lineage is absent from the Family manifest");
  }
  if (variant !== undefined && identity.lineageId !== variant.lineageId) {
    throw new Error("identity lineage differs from its proof variant");
  }
  canonicalKey(identity.subject, "identity subject");
  if (!Array.isArray(identity.provenance)) {
    throw new Error("identity provenance must be an array");
  }
}

function assertExactInvocation(input: ResolvedFamilyExactQuoteInvocation): void {
  assertDefinedFamilyPlugin(input.family.plugin);
  assertSource(input.source, input.generation);
  if (typeof input.amountIn !== "bigint" || input.amountIn < 0n) {
    throw new Error("exact amountIn must be a non-negative bigint");
  }
  assertAddress(input.executor, "exact executor");
  assertPreparedRoute(input.family, input.instance, input.route);
  if (
    input.generation !== input.routeRecord.generation ||
    !sameCanonicalSource(input.source, input.routeRecord.source)
  ) {
    throw new Error(
      "exact source/generation differs from its route publication handle",
    );
  }
  validateRuntimeEvidence(
    input.runtimeEvidence,
    input.family.plugin.manifest.familyId,
    input.instance.instanceKey,
    input.source,
  );
}

function assertRouteHandleSource(
  record: FamilyRouteRuntimeHandleRecord,
  source: CanonicalSource,
  generation: number,
  label: string,
): void {
  if (
    generation !== record.generation ||
    !sameCanonicalSource(source, record.source)
  ) {
    throw new Error(
      `${label} source/generation differs from its route publication handle`,
    );
  }
}

function assertExecutionInvocation(
  resolved: ResolvedFamilyExecutionInvocation,
): void {
  const { input, routeRecord, exactRecord } = resolved;
  assertPreparedRoute(input.family, routeRecord.instance, routeRecord.route);
  assertAddress(input.executor, "execution executor");
  if (
    exactRecord.routeHandle !== input.route ||
    exactRecord.routeRecord !== routeRecord
  ) {
    throw new Error("sealed exact quote escaped its issued Family route handle");
  }
  if (
    typeof exactRecord.amountIn !== "bigint" || exactRecord.amountIn <= 0n ||
    typeof exactRecord.amountOut !== "bigint" || exactRecord.amountOut < 0n
  ) {
    throw new Error("execution exact amounts are invalid");
  }
  if (
    typeof input.minAmountOut !== "bigint" ||
    input.minAmountOut < 0n ||
    input.minAmountOut > exactRecord.amountOut
  ) {
    throw new Error(
      "execution minAmountOut must be non-negative and no greater than the quote",
    );
  }
  validateRuntimeEvidence(
    input.runtimeEvidence,
    input.family.plugin.manifest.familyId,
    routeRecord.instance.instanceKey,
    exactRecord.source,
  );
  if (input.executor.toLowerCase() !== exactRecord.executor) {
    throw new Error("execution executor differs from its sealed exact quote");
  }
  const runtimeEvidenceFingerprint = hashCanonical(
    runtimeEvidenceProjection(input.runtimeEvidence),
  );
  if (runtimeEvidenceFingerprint !== exactRecord.runtimeEvidenceFingerprint) {
    throw new Error(
      "execution runtime evidence differs from its sealed exact quote",
    );
  }
  if (
    exactRecord.generation !== routeRecord.generation ||
    !sameCanonicalSource(exactRecord.source, routeRecord.source)
  ) {
    throw new Error("sealed exact source escaped its route publication");
  }
}

function assertPreparedRoute(
  family: LoadedFamilyPlugin,
  instance: PreparedFamilyInstance,
  route: FamilyRouteDescriptor,
): void {
  if (
    instance.familyId !== family.plugin.manifest.familyId ||
    instance.descriptor.familyId !== family.plugin.manifest.familyId ||
    route.familyId !== family.plugin.manifest.familyId ||
    route.instanceKey !== instance.instanceKey ||
    route.lineageId !== instance.lineageId
  ) {
    throw new Error("route escaped its prepared Family instance");
  }
  const prepared = instance.routes.find((item) => item.routeKey === route.routeKey);
  if (prepared === undefined || prepared !== route) {
    throw new Error(
      "route must be the exact stored object from its prepared instance",
    );
  }
}

/**
 * Audit §9: central rehydration of process-local route handles from a
 * memo-rebuilt instance. Route handles are never serialized; after a
 * restart or a durable-memo rebuild, the central runtime re-issues fresh
 * handles bound to the exact stored route descriptors at the canonical
 * source. No identity RPC runs here - only local assembly + issuance.
 */
export function reissuePreparedInstanceRouteHandles(input: {
  readonly family: LoadedFamilyPlugin;
  readonly instance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): PreparedFamilyInstance {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  // Build one fresh object and issue every handle against that exact object.
  // Returning a spread clone after issuance would leave the WeakMap records
  // bound to a different instance and exact/execution would reject it.
  const prepared = {
    ...input.instance,
    routeHandles: [] as FamilyRouteRuntimeHandle[],
  } satisfies PreparedFamilyInstance;
  prepared.routeHandles = Object.freeze(prepared.routes.map((route) =>
    issueFamilyRouteRuntimeHandle({
      family: input.family,
      instance: prepared,
      route,
      source: input.source,
      generation: input.generation,
    })
  )) as unknown as FamilyRouteRuntimeHandle[];
  Object.freeze(prepared);
  registerIssuedPreparedFamilyInstance({
    family: input.family,
    instance: prepared,
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
  });
  return prepared;
}

/**
 * Re-issue only the process-local PreparedFamilyInstance authority.
 *
 * Credit instances have no route-Family handles: their route handles are
 * issued by `prepareCreditFamilyRoutes`. Durable memos therefore restore the
 * canonical descriptor first through this boundary, then the Credit runtime
 * issues its own source-bound route closure. This keeps serialized data from
 * masquerading as a live issuer handle after restart.
 */
export function reissuePreparedInstanceAuthority(input: {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): PreparedFamilyInstance {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  if (
    input.instance.familyId !== input.family.plugin.manifest.familyId ||
    input.instance.descriptor.familyId !== input.family.plugin.manifest.familyId ||
    input.instance.instanceKey !== input.instance.descriptor.instanceKey ||
    input.instance.lineageId !== input.instance.descriptor.lineageId
  ) {
    throw new Error("Prepared Family instance escaped its catalog FamilyBox");
  }
  const prepared = Object.freeze({
    ...input.instance,
    routeHandles: Object.freeze([]),
  }) as PreparedFamilyInstance;
  registerIssuedPreparedFamilyInstance({
    family: input.family,
    instance: prepared,
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
  });
  return prepared;
}

function issueFamilyRouteRuntimeHandle(input: {
  readonly family: LoadedFamilyPlugin;
  readonly instance: PreparedFamilyInstance;
  readonly route: FamilyRouteDescriptor;
  readonly source: CanonicalSource;
  readonly generation: number;
}): FamilyRouteRuntimeHandle {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  assertPreparedRoute(input.family, input.instance, input.route);
  const source = Object.freeze({ ...input.source });
  const handle = Object.freeze({
    familyId: input.family.plugin.manifest.familyId,
    lineageId: input.instance.lineageId,
    candidateKey: input.instance.candidateKey,
    instanceKey: input.instance.instanceKey,
    routeKey: input.route.routeKey,
    source,
    generation: input.generation,
  }) as unknown as FamilyRouteRuntimeHandle;
  issuedFamilyRouteRuntimeHandles.set(handle, Object.freeze({
    family: input.family,
    instance: input.instance,
    route: input.route,
    source,
    generation: input.generation,
  }));
  return handle;
}

/** Runtime authenticity check for central graph/publication consumers. */
export function assertIssuedFamilyRouteRuntimeHandle(
  family: LoadedFamilyBox,
  value: unknown,
): asserts value is FamilyRouteRuntimeHandle {
  if (
    value === null ||
    typeof value !== "object" ||
    !issuedFamilyRouteRuntimeHandles.has(value) ||
    !Object.isFrozen(value)
  ) {
    throw new Error(
      "Family route runtime handle must be issued by the central runtime",
    );
  }
  if (issuedFamilyRouteRuntimeHandles.get(value)!.family !== family) {
    throw new Error("Family route runtime handle escaped its catalog Family box");
  }
}

/** Publication-facing exact source check without exposing issuer records. */
export function assertIssuedFamilyRouteRuntimeHandleAtSource(input: {
  readonly family: LoadedFamilyPlugin;
  readonly handle: FamilyRouteRuntimeHandle;
  readonly source: CanonicalSource;
  readonly generation: number;
}): void {
  const record = resolveFamilyRouteRuntimeHandle(input.family, input.handle);
  assertSource(input.source, input.generation);
  if (
    record.generation !== input.generation ||
    !sameCanonicalSource(record.source, input.source)
  ) {
    throw new Error("Family route runtime handle source/generation mismatch");
  }
}

/**
 * Narrow bridge for the central graph projector: prove that caller-visible
 * opaque metadata is paired with the exact descriptor/route objects captured
 * by the issuer, without exposing either object from the private record.
 */
export function assertFamilyRouteRuntimeHandleBinding(
  family: LoadedFamilyBox,
  handle: FamilyRouteRuntimeHandle,
  descriptor: CompiledInstanceDescriptor,
  route: FamilyRouteDescriptor,
): void {
  assertIssuedFamilyRouteRuntimeHandle(family, handle);
  const record = issuedFamilyRouteRuntimeHandles.get(handle)!;
  if (
    record.instance.descriptor !== descriptor ||
    record.route !== route
  ) {
    throw new Error(
      "Family route runtime handle is not bound to the supplied descriptor/route",
    );
  }
}

function resolveFamilyRouteRuntimeHandle(
  family: LoadedFamilyPlugin,
  handle: FamilyRouteRuntimeHandle,
): FamilyRouteRuntimeHandleRecord {
  assertIssuedFamilyRouteRuntimeHandle(family, handle);
  const record = issuedFamilyRouteRuntimeHandles.get(handle)!;
  if (
    handle.familyId !== family.plugin.manifest.familyId ||
    handle.familyId !== record.instance.familyId ||
    handle.lineageId !== record.instance.lineageId ||
    handle.candidateKey !== record.instance.candidateKey ||
    handle.instanceKey !== record.instance.instanceKey ||
    handle.routeKey !== record.route.routeKey ||
    handle.generation !== record.generation ||
    !sameCanonicalSource(handle.source, record.source)
  ) {
    throw new Error("Family route runtime handle metadata changed after issue");
  }
  return record;
}

function resolveSealedFamilyExactQuoteHandle(
  family: LoadedFamilyPlugin,
  handle: SealedFamilyExactQuoteHandle,
): SealedFamilyExactQuoteHandleRecord {
  if (
    handle === null ||
    typeof handle !== "object" ||
    !Object.isFrozen(handle)
  ) {
    throw new Error(
      "sealed Family exact quote handle must be issued by the central runtime",
    );
  }
  const record = issuedSealedFamilyExactQuoteHandles.get(handle);
  if (record === undefined) {
    throw new Error(
      "sealed Family exact quote handle must be issued by the central runtime",
    );
  }
  if (record.family !== family) {
    throw new Error("sealed Family exact quote escaped its catalog Family box");
  }
  if (
    handle.familyId !== family.plugin.manifest.familyId ||
    handle.familyId !== record.routeHandle.familyId ||
    handle.candidateKey !== record.routeHandle.candidateKey ||
    handle.instanceKey !== record.routeHandle.instanceKey ||
    handle.routeKey !== record.routeHandle.routeKey ||
    handle.generation !== record.generation ||
    handle.amountIn !== record.amountIn ||
    handle.amountOut !== record.amountOut ||
    !sameCanonicalSource(handle.source, record.source)
  ) {
    throw new Error("sealed Family exact quote metadata changed after issue");
  }
  return record;
}

function validateRuntimeEvidence(
  evidence: readonly RuntimeEvidence[],
  familyId: FamilyId,
  instanceKey: InstanceKey,
  source: CanonicalSource,
): void {
  if (!Array.isArray(evidence)) throw new Error("runtime evidence must be an array");
  const seen = new Set<string>();
  for (const item of evidence) {
    requireObject(item, "runtime evidence");
    canonicalKey(item.evidenceId, "runtime evidence id");
    if (seen.has(item.evidenceId)) throw new Error("runtime evidence ids must be unique");
    seen.add(item.evidenceId);
    if (item.familyId !== familyId) throw new Error("runtime evidence escaped its Family");
    if (item.instanceKey !== undefined && item.instanceKey !== instanceKey) {
      throw new Error("runtime evidence escaped its instance");
    }
    if (
      item.source.number !== source.number ||
      item.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      item.source.generation !== source.generation
    ) {
      throw new Error("runtime evidence escaped its canonical source");
    }
    canonicalKey(item.kind, "runtime evidence kind");
    canonicalKey(item.evidenceHash, "runtime evidence hash");
    canonicalKey(item.sealedPayloadRef, "runtime evidence payload ref");
  }
}

function runtimeEvidenceProjection(
  evidence: readonly RuntimeEvidence[],
): CanonicalValue {
  return evidence.map((item) => ({
    evidenceId: item.evidenceId,
    familyId: item.familyId,
    instanceKey: item.instanceKey ?? null,
    kind: item.kind,
    scope: item.scope,
    source: canonicalSourceProjection(item.source),
    txHash: item.txHash ?? null,
    evidenceHash: item.evidenceHash,
    sealedPayloadRef: item.sealedPayloadRef,
  })).sort((left, right) =>
    String(left.evidenceId).localeCompare(String(right.evidenceId))
  );
}

function validateExactQuote(quote: ExactQuoteResult<unknown>): void {
  requireObject(quote, "exact quote");
  if (typeof quote.amountOut !== "bigint" || quote.amountOut < 0n) {
    throw new Error("exact amountOut must be a non-negative bigint");
  }
  if (quote.evidence === undefined) {
    throw new Error("exact quote must carry explicit evidence");
  }
  deepFreezeOpaqueRuntimeValue(quote.evidence, "exact quote evidence");
}

function terminalExact(
  input: ResolvedFamilyExactQuoteInvocation,
  status: TerminalFamilyExactQuote["status"],
  reasonCode: string,
  evidenceRefs: readonly string[],
): TerminalFamilyExactQuote {
  return Object.freeze({
    status,
    outcome: makeOutcome({
      familyId: input.family.plugin.manifest.familyId,
      lineageId: input.instance.lineageId,
      candidateKey: input.instance.candidateKey,
      instanceKey: input.instance.instanceKey,
      routeKey: input.route.routeKey,
      stage: "exact",
      status,
      reasonCode,
      source: input.source,
      evidenceRefs,
    }),
  });
}

function terminalUnboundExact(
  input: FamilyExactQuoteInvocation,
  resolved: ResolvedFamilyExactQuoteInvocation | undefined,
  status: TerminalFamilyExactQuote["status"],
  reasonCode: string,
  evidenceRefs: readonly string[],
): TerminalFamilyExactQuote {
  if (resolved !== undefined) {
    return terminalExact(resolved, status, reasonCode, evidenceRefs);
  }
  return Object.freeze({
    status,
    outcome: makeOutcome({
      familyId: input.family.plugin.manifest.familyId,
      candidateKey: "unbound-family-route-handle",
      stage: "exact",
      status,
      reasonCode,
      source: input.source,
      evidenceRefs,
    }),
  });
}

function terminalVictimReplay(
  input: Pick<
    FamilyVictimReplayInvocation,
    "family" | "route" | "source"
  >,
  routeRecord: FamilyRouteRuntimeHandleRecord | undefined,
  status: TerminalFamilyVictimReplay["status"],
  reasonCode: string,
  evidenceRefs: readonly string[] = [],
): TerminalFamilyVictimReplay {
  return Object.freeze({
    status,
    outcome: makeOutcome({
      familyId: input.family.plugin.manifest.familyId,
      ...(routeRecord === undefined
        ? {}
        : {
            lineageId: routeRecord.instance.lineageId,
            instanceKey: routeRecord.instance.instanceKey,
          }),
      candidateKey: routeRecord?.instance.candidateKey ??
        "unbound-family-route-handle",
      ...(routeRecord === undefined
        ? {}
        : { routeKey: routeRecord.route.routeKey }),
      stage: "victim-replay",
      status,
      reasonCode,
      source: input.source,
      evidenceRefs,
    }),
  });
}

function sealVictimImpact(
  value: NormalizedSwapVictimImpact,
): NormalizedSwapVictimImpact {
  requireObject(value, "normalized victim impact");
  canonicalKey(value.pool, "victim pool");
  assertAddress(value.tokenIn, "victim tokenIn");
  assertAddress(value.tokenOut, "victim tokenOut");
  if (value.tokenIn.toLowerCase() === value.tokenOut.toLowerCase()) {
    throw new Error("victim token direction must be distinct");
  }
  if (typeof value.amountIn !== "bigint" || value.amountIn <= 0n) {
    throw new Error("victim amountIn must be a positive bigint");
  }
  if (
    value.amountOut !== undefined &&
    (typeof value.amountOut !== "bigint" || value.amountOut < 0n)
  ) {
    throw new Error("victim amountOut must be a non-negative bigint");
  }
  const exactPostState = value.exactPostState === undefined
    ? undefined
    : sealCanonicalValue(value.exactPostState);
  return Object.freeze({
    pool: value.pool,
    tokenIn: value.tokenIn.toLowerCase(),
    tokenOut: value.tokenOut.toLowerCase(),
    amountIn: value.amountIn,
    ...(value.amountOut === undefined ? {} : { amountOut: value.amountOut }),
    ...(exactPostState === undefined ? {} : { exactPostState }),
  });
}

function sealVictimLocalApply(
  value: VictimReplayLocalResult,
): VictimReplayLocalResult {
  requireObject(value, "victim local apply result");
  if (typeof value.amountOut !== "bigint" || value.amountOut < 0n) {
    throw new Error("victim local amountOut must be a non-negative bigint");
  }
  return Object.freeze({
    postImpact: sealCanonicalValue(value.postImpact),
    amountOut: value.amountOut,
  });
}

function sealVictimOverlay(
  value: VictimReplayOverlayIntent,
): VictimReplayOverlayIntent {
  requireObject(value, "victim overlay intent");
  assertAddress(value.whale, "victim overlay whale");
  if (!Array.isArray(value.tokenDeals) || value.tokenDeals.length === 0) {
    throw new Error("victim overlay must declare a token deal");
  }
  if (!Array.isArray(value.preCalls) || value.preCalls.length === 0) {
    throw new Error("victim overlay must declare a pre-call");
  }
  const tokenDeals = value.tokenDeals.map((deal) => {
    requireObject(deal, "victim overlay token deal");
    assertAddress(deal.token, "victim overlay deal token");
    assertAddress(deal.to, "victim overlay deal recipient");
    if (!/^[0-9]+$/.test(deal.amount) || BigInt(deal.amount) <= 0n) {
      throw new Error("victim overlay deal amount must be a positive decimal");
    }
    assertOptionalNonNegativeInteger(
      deal.balanceSlot,
      "victim overlay balanceSlot",
    );
    return Object.freeze({
      token: deal.token.toLowerCase(),
      to: deal.to.toLowerCase(),
      amount: deal.amount,
      ...(deal.balanceSlot === undefined
        ? {}
        : { balanceSlot: deal.balanceSlot }),
    });
  });
  const preCalls = value.preCalls.map((call) => {
    requireObject(call, "victim overlay pre-call");
    assertAddress(call.from, "victim overlay call sender");
    assertAddress(call.to, "victim overlay call target");
    assertHexBytes(call.calldata, "victim overlay calldata");
    assertOptionalNonNegativeInteger(
      call.gasLimit,
      "victim overlay gasLimit",
    );
    assertOptionalNonNegativeInteger(
      call.allowanceSlot,
      "victim overlay allowanceSlot",
    );
    return Object.freeze({
      from: call.from.toLowerCase(),
      to: call.to.toLowerCase(),
      calldata: call.calldata.toLowerCase(),
      ...(call.gasLimit === undefined ? {} : { gasLimit: call.gasLimit }),
      ...(call.allowanceSlot === undefined
        ? {}
        : { allowanceSlot: call.allowanceSlot }),
    });
  });
  return Object.freeze({
    whale: value.whale.toLowerCase(),
    tokenDeals: Object.freeze(tokenDeals),
    preCalls: Object.freeze(preCalls),
  });
}

function sealCanonicalValue(
  value: CanonicalValue,
  seen: Set<object> = new Set<object>(),
): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical value numbers must be finite");
    }
    return value;
  }
  if (seen.has(value)) throw new Error("canonical value must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => sealCanonicalValue(item, seen)));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) {
      throw new Error("canonical value objects must be plain records");
    }
    const record = value as Readonly<Record<string, CanonicalValue>>;
    const sealed: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(record).sort()) {
      sealed[key] = sealCanonicalValue(record[key], seen);
    }
    return Object.freeze(sealed);
  } finally {
    seen.delete(value);
  }
}

function assertHexBytes(value: string, label: string): void {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be canonical hex bytes`);
  }
}

function assertOptionalNonNegativeInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function executionOutcome(
  resolved: ResolvedFamilyExecutionInvocation,
  status: "verified" | "rejected" | "failed",
  reasonCode: string,
): AdapterInstanceOutcome {
  const { input, routeRecord, exactRecord } = resolved;
  return makeOutcome({
    familyId: input.family.plugin.manifest.familyId,
    lineageId: routeRecord.instance.lineageId,
    candidateKey: routeRecord.instance.candidateKey,
    instanceKey: routeRecord.instance.instanceKey,
    routeKey: routeRecord.route.routeKey,
    stage: "execution",
    status,
    reasonCode,
    source: exactRecord.source,
    evidenceRefs: input.exact.evidenceRefs,
  });
}

function terminalExecutionOutcome(
  input: FamilyExecutionInvocation,
  resolved: ResolvedFamilyExecutionInvocation | undefined,
  status: "rejected" | "failed",
  reasonCode: string,
): AdapterInstanceOutcome {
  if (resolved !== undefined) {
    return executionOutcome(resolved, status, reasonCode);
  }
  return makeOutcome({
    familyId: input.family.plugin.manifest.familyId,
    candidateKey: "unbound-family-route-handle",
    stage: "execution",
    status,
    reasonCode,
    source: input.exact.source,
    evidenceRefs: [],
  });
}

class FamilyActionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyActionOwnershipError";
  }
}

function validateResolvedPlanNode(
  value: unknown,
  seen: Set<object>,
): asserts value is ResolvedPlanNode {
  const node = requireObject(value, "resolved plan node") as Partial<ResolvedPlanNode>;
  if (seen.has(node)) throw new Error("resolved plan nodes must not contain cycles");
  seen.add(node);
  canonicalKey(node.adapterId, "plan node adapterId");
  canonicalKey(node.target, "plan node target");
  canonicalKey(node.tokenIn, "plan node tokenIn");
  canonicalKey(node.tokenOut, "plan node tokenOut");
  if (typeof node.amount !== "bigint" || node.amount < 0n) {
    throw new Error("plan node amount must be a non-negative bigint");
  }
  requireObject(node.params, "plan node params");
  if (!Array.isArray(node.children)) {
    throw new Error("plan node children must be an array");
  }
}

function sealPlanFragment(fragment: PlanFragment): PlanFragment {
  const requirements = fragment.requirements.map((requirement) => {
    const item = requireObject(requirement, "plan requirement") as Record<
      string,
      unknown
    >;
    if (item.kind === "approve") {
      const token = canonicalKey(item.token, "approval token");
      const spender = canonicalKey(item.spender, "approval spender");
      if (typeof item.amount !== "bigint" || item.amount < 0n) {
        throw new Error("approval amount must be a non-negative bigint");
      }
      return Object.freeze({
        kind: "approve" as const,
        token,
        spender,
        amount: item.amount,
      });
    }
    if (item.kind === "transfer-to-pool") {
      const token = canonicalKey(item.token, "transfer token");
      const pool = canonicalKey(item.pool, "transfer pool");
      if (typeof item.amount !== "bigint" || item.amount < 0n) {
        throw new Error("transfer amount must be a non-negative bigint");
      }
      return Object.freeze({
        kind: "transfer-to-pool" as const,
        token,
        pool,
        amount: item.amount,
      });
    }
    throw new Error(`unsupported plan requirement ${String(item.kind)}`);
  });
  return Object.freeze({
    requirements: Object.freeze(requirements),
    nodes: Object.freeze(fragment.nodes.map(sealResolvedPlanNode)),
  }) as unknown as PlanFragment;
}

function sealResolvedPlanNode(node: ResolvedPlanNode): ResolvedPlanNode {
  const params: Record<string, ResolvedPlanNode["params"][string]> = {};
  for (const [key, value] of Object.entries(node.params)) {
    canonicalKey(key, "plan param key");
    params[key] = sealResolvedParam(value);
  }
  return Object.freeze({
    adapterId: node.adapterId,
    target: node.target,
    tokenIn: node.tokenIn,
    tokenOut: node.tokenOut,
    amount: node.amount,
    params: Object.freeze(params),
    children: Object.freeze(node.children.map(sealResolvedPlanNode)),
  }) as unknown as ResolvedPlanNode;
}

function sealResolvedParam(
  value: ResolvedPlanNode["params"][string],
): ResolvedPlanNode["params"][string] {
  if (
    typeof value === "bigint" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    // TypedArray elements cannot be Object.freeze'd in JavaScript. A detached
    // copy prevents post-build mutation through the Adapter-owned reference.
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    if (!value.every((item) =>
      typeof item === "bigint" || typeof item === "string"
    )) {
      throw new Error("resolved plan param arrays must be all-bigint or all-string");
    }
    return Object.freeze([...value]) as bigint[] | string[];
  }
  throw new Error("unsupported resolved plan param");
}

function assertAddress(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
}

function validateDescriptor(
  descriptor: CompiledInstanceDescriptor,
  identity: VerifiedIdentity,
  instanceKey: InstanceKey,
  familyId: FamilyId,
): void {
  if (descriptor.familyId !== familyId) {
    throw new Error("instance descriptor familyId escaped its Family");
  }
  if (descriptor.lineageId !== identity.lineageId) {
    throw new Error("instance descriptor lineage differs from its identity");
  }
  if (descriptor.instanceKey !== instanceKey) {
    throw new Error("instance descriptor key differs from instanceKey(identity)");
  }
  if (!Array.isArray(descriptor.provenance)) {
    throw new Error("instance descriptor provenance must be an array");
  }
  if (!Array.isArray(descriptor.runtimeRequirements)) {
    throw new Error("instance descriptor runtime requirements must be an array");
  }
}

function validateRoutes(
  value: unknown,
  descriptor: CompiledInstanceDescriptor,
  family: LoadedFamilyPlugin,
): readonly FamilyRouteDescriptor[] {
  if (!Array.isArray(value)) throw new Error("route projection must return an array");
  const seen = new Set<string>();
  const allowedTaxonomy = new Set(
    family.plugin.manifest.allowedTaxonomy.map(taxonomyKey),
  );
  const routes = value.map((item) => {
    const route = requireObject(item, "route descriptor") as unknown as FamilyRouteDescriptor;
    canonicalKey(route.routeKey, "route key");
    if (seen.has(route.routeKey)) throw new Error(`duplicate route ${route.routeKey}`);
    seen.add(route.routeKey);
    if (
      route.familyId !== descriptor.familyId ||
      route.lineageId !== descriptor.lineageId ||
      route.instanceKey !== descriptor.instanceKey
    ) {
      throw new Error(`route ${route.routeKey} escaped its instance descriptor`);
    }
    canonicalKey(route.tokenIn, "route tokenIn");
    canonicalKey(route.tokenOut, "route tokenOut");
    if (!allowedTaxonomy.has(taxonomyKey(route.taxonomy))) {
      throw new Error(`route ${route.routeKey} uses undeclared taxonomy`);
    }
    if (!Array.isArray(route.runtimeRequirements)) {
      throw new Error(`route ${route.routeKey} runtime requirements must be an array`);
    }
    requireObject(route.bindingRef, `route ${route.routeKey} bindingRef`);
    canonicalKey(route.bindingRef.bindingKey, "route binding key");
    if (!/^[0-9a-fA-F]{64}$/.test(route.bindingRef.fingerprint)) {
      throw new Error(`route ${route.routeKey} binding fingerprint must be SHA-256`);
    }
    deepFreezeOpaqueRuntimeValue(route, `route ${route.routeKey}`);
    return route;
  });
  return Object.freeze(routes);
}

function validateAndFingerprintStateInstanceGroup(input: {
  readonly familyId: FamilyId;
  readonly instanceKey: InstanceKey;
  readonly stateKey: string;
  readonly routes: readonly FamilyRouteDescriptor[];
}): string {
  const stateKey = canonicalKey(input.stateKey, "pricing state key");
  if (input.routes.length === 0) {
    throw new Error("pricing StateInstance group must contain a route");
  }
  const routeKeys = new Set<string>();
  const bindings = input.routes.map((route) => {
    if (
      route.familyId !== input.familyId ||
      route.instanceKey !== input.instanceKey
    ) {
      throw new Error(`route ${route.routeKey} escaped its StateInstance group`);
    }
    const routeKey = canonicalKey(route.routeKey, "StateInstance route key");
    if (routeKeys.has(routeKey)) {
      throw new Error(`StateInstance group duplicates route ${routeKey}`);
    }
    routeKeys.add(routeKey);
    const bindingKey = canonicalKey(
      route.bindingRef?.bindingKey,
      "StateInstance route binding key",
    );
    const bindingFingerprint = route.bindingRef?.fingerprint;
    if (!/^[0-9a-fA-F]{64}$/.test(bindingFingerprint ?? "")) {
      throw new Error(
        `StateInstance route ${routeKey} has no canonical binding fingerprint`,
      );
    }
    return Object.freeze({
      routeKey,
      bindingKey,
      bindingFingerprint: bindingFingerprint!.toLowerCase(),
    });
  }).sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  return hashCanonical({
    namespace: "adapter-state-instance-group-v1",
    familyId: input.familyId,
    instanceKey: input.instanceKey,
    stateKey,
    routes: bindings,
  });
}

function declareSharedBindingRequests(
  family: LoadedFamilyPlugin,
  descriptor: CompiledInstanceDescriptor,
): readonly SharedBindingRequestKey[] {
  if (family.plugin.sharedBindings === undefined) return Object.freeze([]);
  const declared = family.plugin.sharedBindings.references(descriptor);
  if (!Array.isArray(declared)) {
    throw new Error("shared binding references must be an array");
  }
  const normalized = declared.map(normalizeSharedBindingRequest).sort(
    compareSharedBindingRequest,
  );
  const seen = new Set<string>();
  for (const request of normalized) {
    const key = sharedBindingRequestIdentity(request);
    if (seen.has(key)) {
      throw new Error(
        `duplicate shared binding ${request.bindingKind}/${request.bindingKey}`,
      );
    }
    seen.add(key);
  }
  return Object.freeze(normalized);
}

function normalizeSharedBindingRequest(
  value: SharedBindingRequestKey,
): SharedBindingRequestKey {
  requireObject(value, "shared binding request");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 || keys[0] !== "bindingKey" ||
    keys[1] !== "bindingKind"
  ) {
    throw new Error("shared binding request must contain only kind and key");
  }
  return Object.freeze({
    bindingKind: canonicalKey(value.bindingKind, "shared binding kind"),
    bindingKey: canonicalKey(value.bindingKey, "shared binding key"),
  });
}

function compareSharedBindingRequest(
  left: SharedBindingRequestKey,
  right: SharedBindingRequestKey,
): number {
  return left.bindingKind.localeCompare(right.bindingKind) ||
    left.bindingKey.localeCompare(right.bindingKey);
}

function sharedBindingRequestIdentity(request: SharedBindingRequestKey): string {
  return hashCanonical({
    bindingKind: request.bindingKind,
    bindingKey: request.bindingKey,
  });
}

function assertSameSharedBindingRequests(
  preliminary: readonly SharedBindingRequestKey[],
  final: readonly SharedBindingRequestKey[],
): void {
  const expected = preliminary.map(sharedBindingRequestIdentity);
  const actual = final.map(sharedBindingRequestIdentity);
  if (
    expected.length !== actual.length ||
    expected.some((item, index) => item !== actual[index])
  ) {
    throw new Error(
      "final descriptor changed its preliminary shared binding references",
    );
  }
}

function validateSharedBindingReferences(
  requests: readonly SharedBindingRequestKey[],
  supplied: readonly FamilySharedBindingRef[],
): void {
  const expected = requests.map(sharedBindingRequestIdentity);
  const actual = supplied
    .map((item) => sharedBindingRequestIdentity(item));
  if (
    expected.length !== actual.length ||
    expected.some((item, index) => item !== actual[index])
  ) {
    throw new Error("instance shared binding references are incomplete or overbroad");
  }
}

function sealSharedBindings(
  value: readonly FamilySharedBindingRef[],
  familyId: FamilyId,
): readonly FamilySharedBindingRef[] {
  if (!Array.isArray(value)) throw new Error("shared bindings must be an array");
  const seen = new Set<string>();
  const bindings = value.map((item) => {
    requireObject(item, "shared binding");
    if (!issuedFamilySharedBindingRefs.has(item)) {
      throw new Error("shared binding ref was not issued by the central runtime");
    }
    if (item.familyId !== familyId) throw new Error("shared binding escaped its Family");
    canonicalKey(item.bindingKind, "shared binding kind");
    canonicalKey(item.bindingKey, "shared binding key");
    canonicalKey(item.fingerprint, "shared binding fingerprint");
    const key = sharedBindingRequestIdentity(item);
    if (seen.has(key)) throw new Error(`duplicate shared binding ${key}`);
    seen.add(key);
    return Object.freeze({ ...item });
  });
  return Object.freeze(bindings.sort((left, right) =>
    left.bindingKind.localeCompare(right.bindingKind) ||
    left.bindingKey.localeCompare(right.bindingKey)
  ));
}

function sharedBindingProjection(
  bindings: readonly FamilySharedBindingRef[],
): CanonicalValue {
  return bindings.map((item) => ({
    bindingKind: item.bindingKind,
    bindingKey: item.bindingKey,
    fingerprint: item.fingerprint,
  }));
}

function validateDependencies(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("pricing dependencies must be an array");
  const dependencies = value.map((item) => canonicalKey(item, "pricing dependency"));
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("pricing dependencies must be unique");
  }
  return Object.freeze([...dependencies].sort());
}

function validateRouteMap(
  value: unknown,
  routes: readonly FamilyRouteDescriptor[],
  label: "mid" | "unavailable",
): ReadonlyMap<RouteKey, unknown> {
  if (!(value instanceof Map)) throw new Error(`${label} projection must return a Map`);
  const allowed = new Set(routes.map((route) => route.routeKey));
  const result = new Map<RouteKey, unknown>();
  for (const [key, item] of value) {
    if (typeof key !== "string" || !allowed.has(key as RouteKey)) {
      throw new Error(`${label} projection returned a foreign route`);
    }
    if (label === "unavailable") canonicalKey(item, "unavailable reason");
    else deepFreezeOpaqueRuntimeValue(item, `mid projection ${key}`);
    result.set(key as RouteKey, item);
  }
  return new SealedReadonlyMap(result);
}

function validateRouteClassifications(
  routes: readonly FamilyRouteDescriptor[],
  mids: ReadonlyMap<RouteKey, RouteVenueMid>,
  unavailable: ReadonlyMap<RouteKey, string>,
): void {
  for (const route of routes) {
    const hasMid = mids.has(route.routeKey);
    const isUnavailable = unavailable.has(route.routeKey);
    if (hasMid === isUnavailable) {
      throw new Error(
        `route ${route.routeKey} must have exactly one mid/unavailable classification`,
      );
    }
  }
}

function workFailureOutcome(input: {
  readonly work: Extract<AdapterWorkOutcome<unknown>, { status: "unresolved" }>;
  readonly familyId: FamilyId;
  readonly lineageId?: LineageId;
  readonly candidateKey: string;
  readonly instanceKey?: InstanceKey;
  readonly stateKey?: string;
  readonly stage: AdapterInstanceStage;
  readonly source: CanonicalSource;
  readonly evidenceRefs: readonly string[];
}): AdapterInstanceOutcome {
  return makeOutcome({
    familyId: input.familyId,
    ...(input.lineageId === undefined ? {} : { lineageId: input.lineageId }),
    candidateKey: input.candidateKey,
    ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    ...(input.stateKey === undefined ? {} : { stateKey: input.stateKey }),
    stage: input.stage,
    status: "unresolved",
    reasonCode: `adapter-work:${input.work.failure.stage}:${input.work.failure.code}`,
    source: input.source,
    evidenceRefs: uniqueSorted([
      ...input.evidenceRefs,
      ...(input.work.receipt.dedupeKey === null
        ? []
        : [`work:${input.work.receipt.dedupeKey}`]),
    ]),
  });
}

function instanceFailure(
  input: { readonly family: LoadedFamilyPlugin; readonly source: CanonicalSource },
  candidateKey: string,
  identity: VerifiedIdentity,
  instanceKey: InstanceKey,
  stage: AdapterInstanceStage,
  status: AdapterInstanceStatus,
  reasonCode: string,
  evidenceRefs: readonly string[],
): AdapterInstanceOutcome {
  return makeOutcome({
    familyId: input.family.plugin.manifest.familyId,
    lineageId: identity.lineageId,
    candidateKey,
    instanceKey,
    stage,
    status,
    reasonCode,
    source: input.source,
    evidenceRefs,
  });
}

function pricingOutcome(
  input: {
    readonly family: LoadedFamilyPlugin;
    readonly candidateKey: string;
    readonly identity: VerifiedIdentity;
    readonly instanceKey: InstanceKey;
    readonly stateKey: string;
    readonly source: CanonicalSource;
  },
  stage: "pricing-compile" | "pricing-current",
  status: AdapterInstanceStatus,
  reasonCode: string,
  evidenceRefs: readonly string[],
): AdapterInstanceOutcome {
  return makeOutcome({
    familyId: input.family.plugin.manifest.familyId,
    lineageId: input.identity.lineageId,
    candidateKey: input.candidateKey,
    instanceKey: input.instanceKey,
    stateKey: input.stateKey,
    stage,
    status,
    reasonCode,
    source: input.source,
    evidenceRefs,
  });
}

function makeOutcome(
  input: AdapterInstanceOutcome,
): AdapterInstanceOutcome {
  return Object.freeze({
    ...input,
    source: Object.freeze({ ...input.source }),
    evidenceRefs: Object.freeze(uniqueSorted(input.evidenceRefs)),
  });
}

function terminalCandidate(
  input: { readonly family: LoadedFamilyPlugin; readonly source: CanonicalSource },
  candidateKey: string,
  terminal: {
    readonly stage: "discovery";
    readonly status: "rejected" | "failed";
    readonly reasonCode: string;
  },
): PreparedCandidate {
  return Object.freeze({
    instance: null,
    outcomes: Object.freeze([makeOutcome({
      familyId: input.family.plugin.manifest.familyId,
      candidateKey,
      ...terminal,
      source: input.source,
      evidenceRefs: [],
    })]),
  });
}

function terminalIdentity(
  status: TerminalIdentityResult["status"],
  reasonCode: string,
  evidenceRefs: readonly string[],
): TerminalIdentityResult {
  return Object.freeze({
    status,
    reasonCode,
    evidenceRefs: Object.freeze(uniqueSorted(evidenceRefs)),
  });
}

function sealPricingPreparation(
  state: PreparedPricingStateInstance | null,
  outcomes: readonly AdapterInstanceOutcome[],
): PricingPreparation {
  return Object.freeze({ state, outcomes: Object.freeze([...outcomes]) });
}

function publicationFailureOutcomes(
  familyId: FamilyId,
  source: CanonicalSource,
  instances: readonly PreparedFamilyInstance[],
  reason: "publication-build" | "publication-fence" | "publication-cas",
  error: unknown,
): readonly AdapterInstanceOutcome[] {
  return Object.freeze(instances.map((instance) => makeOutcome({
    familyId,
    lineageId: instance.lineageId,
    candidateKey: instance.candidateKey,
    instanceKey: instance.instanceKey,
    stage: "pricing-current",
    status: "unresolved",
    reasonCode: `${reason}:${errorMessage(error)}`,
    source,
    evidenceRefs: instance.evidenceRefs,
  })));
}

/**
 * Seal one family publication: sorts instances, computes the canonical
 * publication fingerprint. Exported for central aggregation paths (startup
 * universe attestation merges per-pool publications into one per-family
 * publication at the same source before committing through the composition).
 */
export function sealPublication(input: Omit<
  AdapterFamilyPublication,
  "publicationFingerprint"
>): AdapterFamilyPublication {
  assertPublicationUniqueness(input.instances);
  const instances = Object.freeze([...input.instances].sort((left, right) =>
    left.instanceKey.localeCompare(right.instanceKey)
  ));
  const outcomes = Object.freeze([...input.outcomes]);
  const publicationFingerprint = hashCanonical({
    familyId: input.familyId,
    source: canonicalSourceProjection(input.source),
    generation: input.generation,
    instances: instances.map((instance) => ({
      candidateKey: instance.candidateKey,
      lineageId: instance.lineageId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
      staticEvidenceFingerprint: instance.staticEvidenceFingerprint,
      pricingInstances: instance.pricingInstances.map((state) => ({
        stateKey: state.stateKey,
        stateInstanceKey: state.stateInstanceKey,
        routes: state.routes.map((route) => route.routeKey).sort(),
        groupBindingFingerprint: state.groupBindingFingerprint,
        staticBindingFingerprint: state.staticBindingFingerprint,
        snapshotCompatibilityFingerprint:
          state.snapshotCompatibilityFingerprint,
        staticEvidenceFingerprint: state.staticEvidenceFingerprint,
        currentEvidenceFingerprint: state.currentEvidenceFingerprint,
        unavailable: [...state.unavailable]
          .map(([routeKey, reason]) => ({ routeKey, reason }))
          .sort((left, right) => left.routeKey.localeCompare(right.routeKey)),
      })).sort((left, right) => left.stateKey.localeCompare(right.stateKey)),
    })),
  });
  return Object.freeze({
    ...input,
    source: Object.freeze({ ...input.source }),
    instances,
    outcomes,
    publicationFingerprint,
  });
}

function assertPublicationUniqueness(
  instances: readonly PreparedFamilyInstance[],
): void {
  const instanceKeys = new Set<InstanceKey>();
  const stateKeys = new Set<string>();
  for (const instance of instances) {
    if (instanceKeys.has(instance.instanceKey)) {
      throw new Error(`publication duplicates instance ${instance.instanceKey}`);
    }
    instanceKeys.add(instance.instanceKey);
    for (const state of instance.pricingInstances) {
      if (stateKeys.has(state.stateInstanceKey)) {
        throw new Error(
          `publication duplicates StateInstance ${state.stateInstanceKey}`,
        );
      }
      stateKeys.add(state.stateInstanceKey);
    }
  }
}

function sealLifecycleResult(
  input: { readonly family: LoadedFamilyPlugin; readonly source: CanonicalSource; readonly generation: number },
  outcomes: readonly AdapterInstanceOutcome[],
  publication: AdapterFamilyPublication | null,
): AdapterFamilyLifecycleResult {
  return Object.freeze({
    familyId: input.family.plugin.manifest.familyId,
    source: Object.freeze({ ...input.source }),
    generation: input.generation,
    outcomes: Object.freeze([...outcomes]),
    publication,
  });
}

function resolveLimits(
  input: Partial<AdapterFamilyLifecycleLimits> | undefined,
): AdapterFamilyLifecycleLimits {
  const limits = {
    maxIdentityStepsPerVariant:
      input?.maxIdentityStepsPerVariant ?? DEFAULT_LIMITS.maxIdentityStepsPerVariant,
    maxDependentReadRounds:
      input?.maxDependentReadRounds ?? DEFAULT_LIMITS.maxDependentReadRounds,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(limits);
}

function assertSource(source: CanonicalSource, generation: number): void {
  if (
    generation !== source.generation ||
    !Number.isSafeInteger(source.number) ||
    source.number < 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("Family lifecycle source/generation must be canonical");
  }
}

function rejectCallerSharedBindingInjection(input: object): void {
  if ("sharedBindings" in input) {
    throw new Error(
      "caller-provided shared bindings are forbidden; the central runtime executes them",
    );
  }
}

function assertMatchSource(
  family: LoadedFamilyBox,
  match: FamilyLifecycleMatch,
  source: CanonicalSource,
): void {
  const plugin = runtimeInstanceLifecyclePlugin(family);
  if (
    match.observation.source.number !== source.number ||
    match.observation.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
    match.observation.source.generation !== source.generation
  ) {
    throw new Error("Family lifecycle observation escaped its canonical source");
  }
  canonicalKey(match.matchedPatternId, "matched pattern id");
  const declared = [
    ...(plugin.discovery.callPatterns ?? []),
    ...(plugin.discovery.logPatterns ?? []),
    ...(plugin.discovery.addressSurfaces ?? []),
  ].some((pattern) => pattern.id === match.matchedPatternId);
  if (!declared) {
    throw new Error("Family lifecycle match references an undeclared pattern");
  }
}

function runtimeInstanceLifecyclePlugin(
  family: LoadedFamilyBox,
): RuntimeInstanceLifecyclePlugin {
  if (family.plugin.manifest.domain === "funding") {
    throw new Error("Funding Family has no identity/instance lifecycle");
  }
  return family.plugin as unknown as RuntimeInstanceLifecyclePlugin;
}

function creditLifecycleResult(
  input: CreditFamilyInstanceLifecycleResult,
): CreditFamilyInstanceLifecycleResult {
  return Object.freeze({
    familyId: input.familyId,
    source: snapshotCanonicalSource(input.source),
    generation: input.generation,
    instance: input.instance,
    outcomes: Object.freeze([...input.outcomes]),
  });
}

function assertFamilyCapabilities(family: LoadedFamilyPlugin): void {
  for (const capability of ["instance", "pricing"] as const) {
    if (family.hashes[capability].familyId !== family.plugin.manifest.familyId) {
      throw new Error(`${capability} capability hash escaped its Family`);
    }
  }
}

function taxonomyKey(value: {
  readonly slotKind: string;
  readonly protocolAction?: string;
}): string {
  return value.slotKind === "swap"
    ? "swap"
    : `protocol:${value.protocolAction ?? ""}`;
}

function observationKey(observation: UnifiedObservation): string {
  const projection: CanonicalValue = observation.kind === "call"
    ? {
        kind: observation.kind,
        target: observation.target,
        data: observation.data,
        source: canonicalSourceProjection(observation.source),
      }
    : observation.kind === "log"
    ? {
        kind: observation.kind,
        address: observation.address,
        topics: observation.topics,
        data: observation.data,
        source: canonicalSourceProjection(observation.source),
      }
    : observation.kind === "factory-log"
    ? {
        kind: observation.kind,
        factory: observation.factory,
        poolKeyProjection: observation.poolKeyProjection,
        lastFactoryLogBlock: observation.lastFactoryLogBlock,
        topic: observation.topic,
        topics: observation.topics,
        data: observation.data,
        source: canonicalSourceProjection(observation.source),
      }
    : {
        kind: observation.kind,
        address: observation.address,
        codeHash: observation.codeHash,
        implementationWord: observation.implementationWord,
        source: canonicalSourceProjection(observation.source),
      };
  return `observation:${hashCanonical(projection)}`;
}

function canonicalSourceProjection(source: CanonicalSource): CanonicalValue {
  return {
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  };
}

function sameCanonicalSource(
  left: CanonicalSource,
  right: CanonicalSource,
): boolean {
  return left.number === right.number &&
    left.generation === right.generation &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function registerIssuedPreparedFamilyInstance(input: {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): void {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  if (!Object.isFrozen(input.instance)) {
    throw new Error("Prepared Family instance must be frozen before issue");
  }
  const source = snapshotCanonicalSource(input.source);
  issuedPreparedFamilyInstances.set(input.instance, Object.freeze({
    family: input.family,
    source,
    generation: input.generation,
  }));
  for (const pricing of input.instance.pricingInstances) {
    if (!Object.isFrozen(pricing)) {
      throw new Error("Prepared Family pricing state must be frozen before issue");
    }
    issuedPreparedPricingStateInstances.set(pricing, Object.freeze({
      family: input.family,
      instance: input.instance,
      source,
      generation: input.generation,
      integrityFingerprint: preparedPricingStateIntegrityFingerprint(pricing),
    }));
  }
}

function preparedPricingStateIntegrityFingerprint(
  pricing: PreparedPricingStateInstance,
): string {
  return hashCanonical({
    format: "prepared-pricing-state-integrity-v1",
    familyId: pricing.familyId,
    lineageId: pricing.lineageId,
    instanceKey: pricing.instanceKey,
    stateKey: pricing.stateKey,
    stateInstanceKey: pricing.stateInstanceKey,
    routes: opaqueRuntimeIntegrityProjection(pricing.routes),
    pricingDescriptor: opaqueRuntimeIntegrityProjection(
      pricing.pricingDescriptor,
    ),
    snapshot: opaqueRuntimeIntegrityProjection(pricing.snapshot),
    mids: [...pricing.mids]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([routeKey, mid]) => ({
        routeKey,
        mid: opaqueRuntimeIntegrityProjection(mid),
      })),
    unavailable: [...pricing.unavailable]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([routeKey, reason]) => ({ routeKey, reason })),
    dependencies: pricing.dependencies,
    groupBindingFingerprint: pricing.groupBindingFingerprint,
    staticBindingFingerprint: pricing.staticBindingFingerprint,
    snapshotCompatibilityFingerprint:
      pricing.snapshotCompatibilityFingerprint,
    staticEvidenceFingerprint: pricing.staticEvidenceFingerprint,
    currentEvidenceFingerprint: pricing.currentEvidenceFingerprint,
    evidenceRefs: pricing.evidenceRefs,
  });
}

function opaqueRuntimeIntegrityProjection(
  value: unknown,
  active: Set<object> = new Set<object>(),
): CanonicalValue {
  if (value === undefined) return { runtimeType: "undefined" };
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(
      `pricing integrity value contains unsupported ${typeof value}`,
    );
  }
  if (active.has(value)) {
    throw new Error("pricing integrity value must not contain a cycle");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return {
        runtimeType: "array",
        entries: value.map((item) =>
          opaqueRuntimeIntegrityProjection(item, active)
        ),
      };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        "pricing integrity value must contain only plain records and arrays",
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("pricing integrity value must not contain symbol keys");
    }
    return {
      runtimeType: "record",
      entries: (keys as string[]).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !("value" in descriptor)
        ) {
          throw new Error("pricing integrity value must contain data fields");
        }
        return {
          key,
          value: opaqueRuntimeIntegrityProjection(descriptor.value, active),
        };
      }),
    };
  } finally {
    active.delete(value);
  }
}

class SealedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #entries: Map<Key, Value>;

  constructor(entries: ReadonlyMap<Key, Value>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: Key): Value | undefined {
    return this.#entries.get(key);
  }

  has(key: Key): boolean {
    return this.#entries.has(key);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<Key> {
    return this.#entries.keys();
  }

  values(): MapIterator<Value> {
    return this.#entries.values();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "SealedReadonlyMap";
  }
}

Object.freeze(SealedReadonlyMap.prototype);

/**
 * Retain a Family-owned value by identity while removing every mutable or
 * executable surface. This is intentionally narrower than structuredClone:
 * runtime descriptors/evidence are protocol data, not arbitrary JS objects.
 */
function deepFreezeOpaqueRuntimeValue(
  value: unknown,
  label: string,
  active: Set<object> = new Set<object>(),
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains unsupported ${typeof value}`);
  }
  if (active.has(value)) {
    throw new Error(`${label} must not contain a cycle`);
  }

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`${label} must contain only plain records and arrays`);
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} must not contain symbol keys`);
  }
  if (array) {
    const elementKeys = (keys as string[]).filter((key) => key !== "length");
    if (
      elementKeys.length !== value.length ||
      elementKeys.some((key) => {
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 ||
          index >= value.length || String(index) !== key;
      })
    ) {
      throw new Error(`${label} arrays must be dense and property-free`);
    }
  }

  active.add(value);
  try {
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor)
      ) {
        throw new Error(`${label} must not contain accessors`);
      }
      deepFreezeOpaqueRuntimeValue(
        descriptor.value,
        `${label}.${String(key)}`,
        active,
      );
    }
    Object.freeze(value);
  } finally {
    active.delete(value);
  }
}

function sealRuntimeEvidence(
  evidence: readonly RuntimeEvidence[],
): readonly RuntimeEvidence[] {
  return Object.freeze(evidence.map((item) => Object.freeze({
    ...item,
    source: Object.freeze({ ...item.source }),
  })));
}

function requireObject(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function canonicalKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function transportEvidenceRef(fingerprint: string): string {
  return `transport:${fingerprint}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
