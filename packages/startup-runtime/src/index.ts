import {
  gitSha40Schema,
  hashSchema,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type { SourceCoverageCertificateV1 } from "../../discovery/src/index.ts";
import {
  CanonicalSource,
  type CanonicalHeadObservationCapabilityV1,
  type CanonicalSourceAuthorityV1,
  type ProducerSessionV1,
} from "../../canonical-source/src/index.ts";
import type {
  GraphLeaseBindingV1,
  GraphRouteHandle,
  GraphServingAdmissionGuardPort,
  GraphServingAdmissionV1,
  IssuedRouteHandle,
  PersistedGraphV1,
  RuntimeGraphEdgeV1,
} from "../../graph/src/index.ts";
import type {
  BuilderCatalogV1,
  BuilderCheckpointPort,
  BuilderDiscoveryPort,
  PersistedAttestationPort,
} from "../../generation-builder/src/index.ts";
import type {
  GenerationRefreshPolicyV1,
  ReadyGenerationV1,
  ServingValidationInputV1,
} from "../../ready-generation/src/index.ts";
import type { InstanceCatalogV1 } from "../../catalog/src/index.ts";
import type { FamilyRuntimeCompositionV1 } from "../../family-composition/src/index.ts";
import type { GeneratedFamilySearchRuntimePortV1 } from "../../family-composition/src/internal/generated-runtime-composition.ts";
import type {
  ReadyStage12EvidenceCapabilityV1,
  ReadyStage12EvidenceReaderPortV1,
} from "../../checkpoint/src/ready-stage12-evidence.ts";
import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../../checkpoint/src/ready-full-family-evidence.ts";
import { issueStartupRuntimeWithStage12Evidence } from "./internal/runtime-owner.ts";
import type { StartupSixStepRouteParentCapabilityV1 } from "./internal/six-step-route-parent-owner.ts";
import { createGeneratedRouteHandleIssuer } from "./internal/generated-route-handle-adapter.ts";
import {
  startSignedReleaseNativeStartupRuntime,
  type SignedReleaseNativeStartupRuntimeV1,
} from "./internal/signed-release-native-startup-owner.ts";
import type { NativeStartupServingGenerationV1 } from "./internal/native-startup.ts";
import {
  assertStartupObservationWindow,
  STARTUP_OBSERVATION_WINDOW_BLOCKS,
} from "./internal/startup-policy.ts";

export {
  assertIssuedStartupRuntime,
  readStartupFullFamilyEvidenceBinding,
  readStartupStage12Evidence,
  readStartupStage12EvidenceBinding,
  type StartupFullFamilyEvidenceBindingV1,
  verifyStartupStage12Evidence,
} from "./internal/runtime-owner.ts";

declare const startupReadyPortBrand: unique symbol;

export { STARTUP_OBSERVATION_WINDOW_BLOCKS, assertStartupObservationWindow };
export { createGeneratedRouteHandleIssuer };

export interface StartupCheckpointPortV1 extends BuilderCheckpointPort {
  readonly readyStage12EvidenceReader: ReadyStage12EvidenceReaderPortV1;
  readonly readyFullFamilyEvidenceReader: ReadyFullFamilyEvidenceReaderPortV1;
  loadReadyClosure(ready: ReadyGenerationV1): Promise<{
    readonly sourceCoverage: SourceCoverageCertificateV1;
    readonly instanceCatalog: InstanceCatalogV1;
    readonly graph: PersistedGraphV1;
    readonly stage12EvidenceCapability: ReadyStage12EvidenceCapabilityV1;
  }>;
}

/**
 * A release-owned ready service exposes only the two narrow ports needed by
 * startup.  In particular, the caller token is created by this package and
 * bound by the ready owner; raw promotion authority is never accepted.
 */
export interface StartupReadyPortV1 extends GraphServingAdmissionGuardPort {
  readonly [startupReadyPortBrand]: true;
  validateServing(input: ServingValidationInputV1): Promise<GraphServingAdmissionV1>;
}

/** Plain producer-facing view of a graph lease. CanonicalSource intentionally
 * consumes a plain capability object; the concrete GraphViewLease instance
 * never crosses that boundary or becomes a second lease authority. */
export interface StartupProducerLeaseV1 {
  readonly binding: GraphLeaseBindingV1;
  readonly edges: readonly RuntimeGraphEdgeV1[];
  readonly sixStepRouteParents: StartupSixStepRouteParentCapabilityV1;
  assertActive(): Promise<void>;
  resolveRouteHandle(edgeId: Hash, handle: GraphRouteHandle): Promise<IssuedRouteHandle>;
  release(): void;
}

export type { StartupSixStepRouteParentCapabilityV1 } from "./internal/six-step-route-parent-owner.ts";

export interface StartupRuntimeCompositionInputV1 {
  readonly policy: GenerationRefreshPolicyV1;
  readonly catalog: { loadExact(): BuilderCatalogV1 };
  readonly checkpoint: StartupCheckpointPortV1;
  readonly canonical: CanonicalSource;
  readonly discovery: BuilderDiscoveryPort;
  /**
   * This is the production attestation owner port.  Startup does not invent
   * candidate outcomes or inspect Family data; the owner must provide the
   * durable-difference operation.
   */
  readonly attestation: PersistedAttestationPort;
  readonly ready: StartupReadyPortV1;
  /** Branded generated composition issued by the release bootstrap. */
  readonly familyRuntime: FamilyRuntimeCompositionV1;
  /** Opaque search surface issued from the same generated Family authority. */
  readonly familySearchRuntime: GeneratedFamilySearchRuntimePortV1;
  readonly processEpoch: string;
  /** Exact release identity supplied by the release authority composition. */
  readonly releaseBindingId: Hash;
  readonly candidateReleaseCommit: `${string}`;
}

export interface StartupServingGenerationV1 {
  readonly ready: ReadyGenerationV1;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly releaseProvenanceHash: Hash;
}

export interface StartupRuntimeV1 {
  /** Exact ready record selected by this startup run. */
  readonly ready: ReadyGenerationV1;
  /** The exact generated composition used to issue every route handle. */
  readonly familyRuntimeComposition: FamilyRuntimeCompositionV1;
  /** The exact generated search port resolving those route handles. */
  readonly familySearchRuntime: GeneratedFamilySearchRuntimePortV1;
  /** The generation identity is duplicated as a stable, log-safe join key. */
  readonly generationId: string;
  readonly graphRoot: Hash;
  /** Exact release identity copied from the owner-issued startup input. */
  readonly releaseBindingId: Hash;
  readonly candidateReleaseCommit: `${string}`;
  /** Exact canonical source authority used by startup and producer intake. */
  readonly canonicalSourceAuthority: CanonicalSourceAuthorityV1;
  /** One atomic owner snapshot. Consumers must not compose separately read
   * dynamic getters across a promotion boundary. */
  readonly readActiveGeneration: () => StartupServingGenerationV1;
  /** Resolve a generation previously served by this process. This keeps a
   * completed old head joined to its own Ready after a later promotion. */
  readonly readServingGeneration: (generationId: string) => StartupServingGenerationV1;
  /** Resolve only a canonical-source session actually opened by this startup
   * owner. This is the atomic serving bind used after provisional admission. */
  readonly readProducerSessionGeneration: (session: ProducerSessionV1) => StartupServingGenerationV1;
  /**
   * The only producer entry. Each callback receives a disposable session and
   * lease opened against the same frozen ready closure; callers cannot open a
   * second concurrent session or pre-build a transport against another
   * generation.
   */
  readonly withProducerSession: <Result>(
    headObservation: CanonicalHeadObservationCapabilityV1,
    run: (session: ProducerSessionV1<StartupProducerLeaseV1>) => Promise<Result>,
    signal?: AbortSignal,
  ) => Promise<Result>;
  /** Await the current background generation build and surface its exact
   * failure. This is an observation/drain seam, not a second build trigger. */
  readonly waitForGenerationIdle: () => Promise<void>;
  /** Closes the active session/lease; subsequent producer admission is fail-closed. */
  readonly close: () => Promise<void>;
}

function productionServingGeneration(
  signed: SignedReleaseNativeStartupRuntimeV1,
  generation: NativeStartupServingGenerationV1,
  projections: WeakMap<object, StartupServingGenerationV1>,
): StartupServingGenerationV1 {
  const existing = projections.get(generation.handle);
  if (existing !== undefined) return existing;
  const ready = signed.readyFor(generation.handle);
  const serving = Object.freeze({
    ready,
    generationId: generation.generationId,
    graphRoot: generation.graphRoot,
    readyRecordHash: generation.recordRoot,
    sourceCoverageRoot: generation.sourceCoverageRoot,
    definitionCatalogRoot: generation.definitionCatalogRoot,
    releaseProvenanceHash: ready.releaseProvenanceHash,
  });
  projections.set(generation.handle, serving);
  return serving;
}

/**
 * The sole production startup join. The public shape remains release-specific;
 * the native session/promotion/refresh/close state machine is shared behind
 * owner-issued narrow adapters.
 */
export async function startStartupRuntime(
  input: StartupRuntimeCompositionInputV1,
  signal: AbortSignal = new AbortController().signal,
): Promise<StartupRuntimeV1> {
  if (input === null || typeof input !== "object") throw new TypeError("startup composition input is required");
  if (typeof input.processEpoch !== "string" || input.processEpoch.length === 0) {
    throw new TypeError("startup process epoch is required");
  }
  const releaseBindingId = hashSchema.decode(input.releaseBindingId, "startup.releaseBindingId");
  const candidateReleaseCommit = gitSha40Schema.decode(input.candidateReleaseCommit, "startup.candidateReleaseCommit");
  const signed = await startSignedReleaseNativeStartupRuntime({
    composition: input,
    runtimeBindingId: releaseBindingId,
    implementationCommit: candidateReleaseCommit,
  }, signal);
  const native = signed.native;
  const servingProjections = new WeakMap<object, StartupServingGenerationV1>();
  const projectServing = (generation: NativeStartupServingGenerationV1) => productionServingGeneration(
    signed,
    generation,
    servingProjections,
  );
  const runtime = Object.freeze({
    get ready() { return signed.readyFor(native.activeGeneration.handle); },
    familyRuntimeComposition: input.familyRuntime,
    familySearchRuntime: input.familySearchRuntime,
    get generationId() { return native.generationId; },
    get graphRoot() { return native.graphRoot; },
    releaseBindingId,
    candidateReleaseCommit,
    canonicalSourceAuthority: input.canonical.authority,
    readActiveGeneration: () => projectServing(native.readActiveGeneration()),
    readServingGeneration: (generationId: string) => projectServing(native.readServingGeneration(generationId)),
    readProducerSessionGeneration: (session: ProducerSessionV1) => projectServing(
      native.readProducerSessionGeneration(session),
    ),
    waitForGenerationIdle: () => native.waitForGenerationIdle(),
    withProducerSession: <Result>(
      headObservation: CanonicalHeadObservationCapabilityV1,
      run: (session: ProducerSessionV1<StartupProducerLeaseV1>) => Promise<Result>,
      sessionSignal?: AbortSignal,
    ) => native.withProducerSession(headObservation, run, sessionSignal),
    close: () => native.close(),
  });
  return issueStartupRuntimeWithStage12Evidence(runtime, {
    capability: (generationId?: string) => {
      let generation: NativeStartupServingGenerationV1;
      if (generationId === undefined) {
        generation = native.activeGeneration;
      } else {
        try {
          generation = native.readServingGeneration(generationId);
        } catch {
          throw new Error("startup-stage12-generation-unknown");
        }
      }
      return signed.stage12CapabilityFor(generation.handle);
    },
    reader: signed.stage12Reader,
    fullFamilyReader: signed.fullFamilyReader,
  });
}
