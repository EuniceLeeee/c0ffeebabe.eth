import {
  gitSha40Schema,
  hashSchema,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  CanonicalCutoffV1,
  SourceCoverageCertificateV1,
} from "../../discovery/src/index.ts";
import {
  CanonicalSource,
  type CanonicalHeadObservationCapabilityV1,
  type CanonicalSourceAuthorityV1,
  type ProducerSessionV1,
} from "../../canonical-source/src/index.ts";
import {
  GraphViewLeaseV1,
  type GraphLeaseBindingV1,
  type GraphRouteHandle,
  type IssuedRouteHandle,
  type RehydrationRefV1,
  type GraphServingAdmissionGuardPort,
  type GraphServingAdmissionV1,
  type RouteHandleIssuerPort,
  type PersistedGraphV1,
  type RuntimeGraphEdgeV1,
} from "../../graph/src/index.ts";
import {
  GenerationBuilderV1,
  type BuilderCanonicalPort,
  type BuilderCatalogV1,
  type BuilderCheckpointPort,
  type BuilderDiscoveryPort,
  type BoundReadyPromotionPort,
  type GenerationBuilderDependencies,
  type PersistedAttestationPort,
} from "../../generation-builder/src/index.ts";
import type {
  GenerationRefreshPolicyV1,
  ReadyGenerationV1,
  ServingValidationInputV1,
} from "../../ready-generation/src/index.ts";
import type {
  InstanceCatalogV1,
  InstancePublicationV1,
  StaticTransitionProjectionV1,
} from "../../catalog/src/index.ts";
import {
  assertGeneratedFamilyRuntimeComposition,
  type FamilyRehydrationSessionV1,
  type FamilyRuntimeCompositionV1,
} from "../../family-composition/src/index.ts";
import {
  assertIssuedStartupReadyPort,
  startupReadyPromotionPort,
} from "./internal/ready-owner.ts";
import { issueStartupRuntimeWithStage12Evidence } from "./internal/runtime-owner.ts";
import {
  issueStartupSixStepRouteParentCapabilityV1,
  type StartupSixStepRouteParentCapabilityV1,
} from "./internal/six-step-route-parent-owner.ts";

export {
  assertIssuedStartupRuntime,
  readStartupFullFamilyEvidenceBinding,
  readStartupStage12Evidence,
  type StartupFullFamilyEvidenceBindingV1,
  verifyStartupStage12Evidence,
} from "./internal/runtime-owner.ts";
import type {
  ReadyStage12EvidenceCapabilityV1,
  ReadyStage12EvidenceReaderPortV1,
} from "../../checkpoint/src/ready-stage12-evidence.ts";
import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../../checkpoint/src/ready-full-family-evidence.ts";

declare const startupReadyPortBrand: unique symbol;

/** The only recent-observation window admitted by the startup authority. */
export const STARTUP_OBSERVATION_WINDOW_BLOCKS = 50 as const;

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

function decimal(value: string, context: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${context} is not a canonical decimal`);
  return BigInt(value);
}

/**
 * Enforces the production startup contract at the builder boundary.  The
 * lower-level discovery package deliberately accepts a shorter range at
 * chain genesis; production startup does not, because its edge evidence
 * contract is exactly cutoff-49..cutoff.
 */
export function assertStartupObservationWindow(
  cutoff: { readonly number: string },
  range: { readonly from: string; readonly to: string },
): void {
  const cutoffNumber = decimal(cutoff.number, "startup.cutoff.number");
  const from = decimal(range.from, "startup.observationRange.from");
  const to = decimal(range.to, "startup.observationRange.to");
  if (
    to !== cutoffNumber
    || cutoffNumber < BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS - 1)
    || from !== cutoffNumber - BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS - 1)
    || to - from + 1n !== BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS)
  ) {
    throw new Error("startup-observation-window-not-50");
  }
}

function fixedWindowCanonical(canonical: CanonicalSource): BuilderCanonicalPort {
  return Object.freeze({
    async freezeView(signal: AbortSignal) {
      const cutoff = await canonical.freezeView(signal);
      assertStartupObservationWindow(cutoff, canonical.recentObservationRange(cutoff));
      return cutoff;
    },
    async assertStillCanonical(cutoff: CanonicalCutoffV1) {
      assertStartupObservationWindow(cutoff, canonical.recentObservationRange(cutoff));
      return canonical.assertStillCanonical(cutoff);
    },
    async ageInBlocks(cutoff: CanonicalCutoffV1) {
      return canonical.ageInBlocks(cutoff);
    },
    recentObservationRange(cutoff: CanonicalCutoffV1) {
      const range = canonical.recentObservationRange(cutoff);
      assertStartupObservationWindow(cutoff, range);
      return range;
    },
  });
}

function assertPolicy(policy: GenerationRefreshPolicyV1): void {
  if (policy.observationWindowBlocks !== "50" || policy.maxInProgressRuns !== "1") {
    throw new Error("unsupported-startup-generation-policy");
  }
  decimal(policy.targetRefreshAgeBlocks, "startup.policy.targetRefreshAgeBlocks");
  decimal(policy.maxServingAgeBlocks, "startup.policy.maxServingAgeBlocks");
  decimal(policy.minPromotionMarginBlocks, "startup.policy.minPromotionMarginBlocks");
}

function builderDependencies(
  input: StartupRuntimeCompositionInputV1,
  promotion: BoundReadyPromotionPort,
): GenerationBuilderDependencies {
  const canonical = fixedWindowCanonical(input.canonical);
  return {
    policy: input.policy,
    catalog: input.catalog,
    checkpoint: input.checkpoint,
    canonical,
    discovery: input.discovery,
    attestation: input.attestation,
    // GenerationBuilder receives an owner-issued promotion capability through
    // this private package edge.  The public StartupReadyPort deliberately
    // exposes no bind/callback method, so an application cannot mint another
    // promotion caller or obtain the ready authority surface.
    bindPromotion: () => promotion,
  };
}

type StartupReadyClosureV1 = Awaited<ReturnType<StartupCheckpointPortV1["loadReadyClosure"]>>;

interface StartupActiveGenerationV1 {
  readonly ready: ReadyGenerationV1;
  readonly catalog: BuilderCatalogV1;
  readonly closure: StartupReadyClosureV1;
}

function servingGeneration(generation: StartupActiveGenerationV1): StartupServingGenerationV1 {
  const ready = generation.ready;
  return Object.freeze({
    ready,
    generationId: ready.generationId,
    graphRoot: ready.graphRoot,
    readyRecordHash: ready.readyRecordHash,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    definitionCatalogRoot: ready.definitionCatalogRoot,
    releaseProvenanceHash: ready.releaseProvenanceHash,
  });
}

function producerLeaseFacade(
  lease: GraphViewLeaseV1,
  stage12Capability: ReadyStage12EvidenceCapabilityV1,
  stage12Reader: ReadyStage12EvidenceReaderPortV1,
): StartupProducerLeaseV1 {
  const facade: {
    readonly binding: GraphLeaseBindingV1;
    readonly edges: readonly RuntimeGraphEdgeV1[];
    sixStepRouteParents: StartupSixStepRouteParentCapabilityV1 | null;
    readonly assertActive: () => Promise<void>;
    readonly resolveRouteHandle: (edgeId: Hash, handle: GraphRouteHandle) => Promise<IssuedRouteHandle>;
    readonly release: () => void;
  } = {
    binding: lease.binding,
    edges: lease.edges,
    sixStepRouteParents: null,
    assertActive: () => lease.assertActive(),
    resolveRouteHandle: (edgeId: Hash, handle: GraphRouteHandle) => lease.resolveRouteHandle(edgeId, handle),
    release: () => lease.release(),
  };
  facade.sixStepRouteParents = issueStartupSixStepRouteParentCapabilityV1({
    lease: facade,
    binding: lease.binding,
    readOwned: (orderedEdgeIds: readonly Hash[]) => stage12Reader.routeParents(stage12Capability, orderedEdgeIds),
  });
  return Object.freeze(facade) as StartupProducerLeaseV1;
}

/**
 * Build the Graph port from the same generated Family composition that owns
 * runtime rehydration.  The central startup package only sees generic route
 * fields; it never selects a Family or imports a Family definition.
 */
export function createGeneratedRouteHandleIssuer(value: unknown): RouteHandleIssuerPort {
  assertGeneratedFamilyRuntimeComposition(value);
  const composition = value;
  const sessions = new Map<Hash, FamilyRehydrationSessionV1>();
  return Object.freeze({
    issueRouteHandle(
      publication: InstancePublicationV1,
      projection: StaticTransitionProjectionV1,
      ref: RehydrationRefV1,
    ) {
      let session = sessions.get(publication.familyDefinitionHash);
      if (session === undefined) {
        session = composition.openRehydrationSession(publication.familyDefinitionHash);
        sessions.set(publication.familyDefinitionHash, session);
      }
      return composition.rehydrateRouteHandle(
        session,
        {
          familyId: publication.familyId,
          familyDefinitionHash: publication.familyDefinitionHash,
          instanceKey: publication.instanceKey,
          identityMemo: publication.identityMemo,
          identityMemoHash: publication.identityMemoHash,
          instancePublicationHash: publication.instancePublicationHash,
          staticProjectionMemoHash: publication.staticProjectionMemoHash,
          requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
        },
        {
          staticProjectionHash: projection.staticProjectionHash,
          projectionHash: projection.projectionHash,
        },
        {
          familyDefinitionHash: ref.familyDefinitionHash,
          instanceKey: ref.instanceKey,
          instancePublicationHash: ref.instancePublicationHash,
          staticProjectionMemoHash: ref.staticProjectionMemoHash,
          requestedArtifactDependencyRoot: ref.requestedArtifactDependencyRoot,
        },
      );
    },
  });
}

/**
 * The sole production startup join:
 *
 * fixed cutoff → 50-block discovery → durable attestation/checkpoint →
 * readyGeneration → validated closure → immutable GraphView lease.
 *
 * Nothing returned by this function owns discovery or topology mutation.  A
 * caller can only open a current-head producer session against a fresh lease
 * revalidated from the same ready closure; if any earlier stage has no ready
 * result, the function throws and returns no producer capability.
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
  assertPolicy(input.policy);
  // The ready object is owner-issued by the release bootstrap.  This check is
  // intentionally kept in an internal module so a structural test object
  // cannot become a serving authority merely by matching the public shape.
  assertIssuedStartupReadyPort(input.ready);

  const routeHandleIssuer = createGeneratedRouteHandleIssuer(input.familyRuntime);
  let closed = false;
  let promotionClosed = false;
  let sessionOpening = false;
  let activeSession: ProducerSessionV1<StartupProducerLeaseV1> | null = null;
  let activeLease: GraphViewLeaseV1 | null = null;
  let activeGeneration: StartupActiveGenerationV1 | null = null;
  const servedGenerations = new Map<string, StartupServingGenerationV1>();
  const sessionGenerations = new WeakMap<object, StartupServingGenerationV1>();
  const stage12Capabilities = new Map<string, ReadyStage12EvidenceCapabilityV1>();
  let refreshTask: Promise<void> | null = null;
  let refreshController: AbortController | null = null;
  let refreshFailure: unknown = null;
  const admissionWaiters = new Set<() => void>();
  const quiescenceWaiters = new Set<() => void>();

  const wakeAdmission = (): void => {
    for (const resolve of admissionWaiters) resolve();
    admissionWaiters.clear();
  };
  const wakeQuiescence = (): void => {
    if (sessionOpening || activeSession !== null) return;
    for (const resolve of quiescenceWaiters) resolve();
    quiescenceWaiters.clear();
  };
  const waitForAdmission = async (): Promise<void> => {
    while (promotionClosed && !closed) {
      await new Promise<void>(resolve => admissionWaiters.add(resolve));
    }
    if (closed) throw new Error("startup-runtime-closed");
  };
  const waitForQuiescence = async (): Promise<void> => {
    while (sessionOpening || activeSession !== null) {
      await new Promise<void>(resolve => quiescenceWaiters.add(resolve));
    }
  };
  const loadGeneration = async (ready: ReadyGenerationV1): Promise<StartupActiveGenerationV1> => {
    assertStartupObservationWindow(ready.cutoff, ready.recentObservationRange);
    const catalog = input.catalog.loadExact();
    if (catalog.definitionCatalogRoot !== ready.definitionCatalogRoot) {
      throw new Error("startup-definition-catalog-changed");
    }
    const admission = await input.ready.validateServing({
      ready,
      expectedDefinitionCatalogRoot: catalog.definitionCatalogRoot,
      policy: input.policy,
    });
    await input.ready.consumeServingAdmission(admission);
    const closure = await input.checkpoint.loadReadyClosure(ready);
    if (closure.graph.graphRoot !== ready.graphRoot
      || closure.instanceCatalog.instanceCatalogRoot !== ready.instanceCatalogRoot
      || closure.sourceCoverage.sourceCoverageRoot !== ready.sourceCoverageRoot) {
      throw new Error("startup-ready-closure-mismatch");
    }
    const generation = Object.freeze({ ready, catalog, closure });
    const serving = servingGeneration(generation);
    const existing = servedGenerations.get(serving.generationId);
    if (existing !== undefined
      && (existing.readyRecordHash !== serving.readyRecordHash
        || existing.graphRoot !== serving.graphRoot
        || existing.sourceCoverageRoot !== serving.sourceCoverageRoot
        || existing.releaseProvenanceHash !== serving.releaseProvenanceHash)) {
      throw new Error("startup-generation-identity-rebound");
    }
    servedGenerations.set(serving.generationId, serving);
    stage12Capabilities.set(serving.generationId, closure.stage12EvidenceCapability);
    return generation;
  };

  const promotionPort = startupReadyPromotionPort(input.ready);
  const promoteAtSafeBoundary = async (
    promotionInput: Parameters<BoundReadyPromotionPort["promote"]>[0],
  ): Promise<ReadyGenerationV1> => {
    if (closed) throw new Error("startup-runtime-closed");
    if (promotionClosed) throw new Error("startup-promotion-already-open");
    promotionClosed = true;
    await waitForQuiescence();
    if (closed) {
      promotionClosed = false;
      wakeAdmission();
      throw new Error("startup-runtime-closed");
    }
    const previousReadyRecordHash = activeGeneration?.ready.readyRecordHash ?? null;
    let mayReopenAdmission = false;
    try {
      try {
        const promoted = await promotionPort.promote(promotionInput);
        activeGeneration = await loadGeneration(promoted);
        mayReopenAdmission = true;
        return promoted;
      } catch (error) {
        // Promotion may have committed before its caller observed success.
        // Re-read the durable active authority while admission remains closed;
        // if it changed, install that exact closure before propagating the
        // original error to GenerationBuilder's recovery state machine.
        const current = await promotionPort.findLatestReusable(input.catalog.loadExact(), input.policy);
        if (current !== null
          && current.readyRecordHash !== previousReadyRecordHash) {
          activeGeneration = await loadGeneration(current);
          mayReopenAdmission = true;
        } else if (activeGeneration !== null) {
          // No durable pointer change was observed, so the prior immutable
          // generation remains the exact serving authority.
          mayReopenAdmission = true;
        }
        throw error;
      }
    } finally {
      // A committed Ready whose closure could not be installed is a hard
      // fail-closed state. Keep admission shut; reopening the old pointer
      // would splice it against the new durable authority.
      if (mayReopenAdmission) {
        promotionClosed = false;
        wakeAdmission();
      }
    }
  };

  const safePromotionPort: BoundReadyPromotionPort = Object.freeze({
    findLatestReusable: (
      catalog: Parameters<BoundReadyPromotionPort["findLatestReusable"]>[0],
      policy: Parameters<BoundReadyPromotionPort["findLatestReusable"]>[1],
    ) => promotionPort.findLatestReusable(catalog, policy),
    promote: promoteAtSafeBoundary,
  });
  const builder = new GenerationBuilderV1(builderDependencies(input, safePromotionPort));
  const initialReady = await builder.loadOrBuildInitialReady(signal);
  if (activeGeneration === null) activeGeneration = await loadGeneration(initialReady);

  const startRefreshIfDue = (headNumber: string, generation: StartupActiveGenerationV1): void => {
    if (closed || refreshTask !== null || generation !== activeGeneration) return;
    const age = decimal(headNumber, "startup.producerHead.number")
      - decimal(generation.ready.cutoff.number, "startup.activeReady.cutoff.number");
    if (age < decimal(input.policy.targetRefreshAgeBlocks, "startup.policy.targetRefreshAgeBlocks")) return;
    const controller = new AbortController();
    refreshController = controller;
    refreshFailure = null;
    const task = builder.buildNextReady(controller.signal).then(() => undefined);
    // Observe rejection immediately so a slow Producer callback cannot leave
    // a background promise unhandled. A later head retries while the old Ready
    // remains within its independently enforced serving age.
    refreshTask = task.catch(error => { refreshFailure = error; }).finally(() => {
      if (refreshController === controller) refreshController = null;
      if (refreshTask !== null) refreshTask = null;
    });
  };

  const runtime = Object.freeze({
    get ready() { return activeGeneration!.ready; },
    familyRuntimeComposition: input.familyRuntime,
    get generationId() { return activeGeneration!.ready.generationId; },
    get graphRoot() { return activeGeneration!.ready.graphRoot; },
    releaseBindingId,
    candidateReleaseCommit,
    canonicalSourceAuthority: input.canonical.authority,
    readActiveGeneration(): StartupServingGenerationV1 {
      if (closed || activeGeneration === null) throw new Error("startup-runtime-closed");
      return servedGenerations.get(activeGeneration.ready.generationId)!;
    },
    readServingGeneration(generationId: string): StartupServingGenerationV1 {
      if (typeof generationId !== "string" || generationId.length === 0) {
        throw new TypeError("startup serving generation id is required");
      }
      const serving = servedGenerations.get(generationId);
      if (serving === undefined) throw new Error("startup-serving-generation-unknown");
      return serving;
    },
    readProducerSessionGeneration(session: ProducerSessionV1): StartupServingGenerationV1 {
      if (session === null || typeof session !== "object") throw new TypeError("startup producer session is required");
      const serving = sessionGenerations.get(session);
      if (serving === undefined) throw new Error("startup-producer-session-unknown");
      return serving;
    },
    async waitForGenerationIdle(): Promise<void> {
      const task = refreshTask;
      if (task !== null) await task;
      if (refreshFailure !== null) throw refreshFailure;
    },
    async withProducerSession<Result>(
      headObservation: CanonicalHeadObservationCapabilityV1,
      run: (session: ProducerSessionV1<StartupProducerLeaseV1>) => Promise<Result>,
      sessionSignal?: AbortSignal,
    ): Promise<Result> {
      if (typeof run !== "function") throw new TypeError("startup producer callback is required");
      await waitForAdmission();
      if (sessionOpening || activeSession !== null) throw new Error("startup-producer-session-already-open");
      sessionOpening = true;
      const generation = activeGeneration;
      if (generation === null) {
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-active-generation-unavailable");
      }
      const sessionAdmission = await input.ready.validateServing({
        ready: generation.ready,
        expectedDefinitionCatalogRoot: generation.catalog.definitionCatalogRoot,
        policy: input.policy,
      });
      let lease: GraphViewLeaseV1;
      try {
        lease = await GraphViewLeaseV1.open(
          sessionAdmission,
          generation.closure.graph,
          generation.closure.instanceCatalog,
          routeHandleIssuer,
          input.processEpoch,
          input.canonical,
          input.ready,
        );
      } catch (error) {
        sessionOpening = false;
        wakeQuiescence();
        throw error;
      }
      if (closed) {
        lease.release();
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-runtime-closed");
      }
      activeLease = lease;
      let session: ProducerSessionV1<StartupProducerLeaseV1>;
      try {
        session = await input.canonical.openHeadSession(
          headObservation,
          producerLeaseFacade(lease, generation.closure.stage12EvidenceCapability, input.checkpoint.readyStage12EvidenceReader),
          sessionSignal,
        );
      } catch (error) {
        lease.release();
        activeLease = null;
        sessionOpening = false;
        wakeQuiescence();
        throw error;
      }
      if (closed) {
        await session.close();
        lease.release();
        activeLease = null;
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-runtime-closed");
      }
      activeSession = session;
      sessionGenerations.set(session, servedGenerations.get(generation.ready.generationId)!);
      sessionOpening = false;
      startRefreshIfDue(session.head.number, generation);
      try {
        return await run(session);
      } finally {
        activeSession = null;
        await session.close();
        lease.release();
        activeLease = null;
        wakeQuiescence();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      promotionClosed = true;
      wakeAdmission();
      refreshController?.abort(new Error("startup-runtime-closed"));
      if (activeSession !== null) {
        await activeSession.close();
        activeSession = null;
      }
      if (activeLease !== null) {
        activeLease.release();
        activeLease = null;
      }
      sessionOpening = false;
      wakeQuiescence();
      const draining = refreshTask;
      if (draining !== null) await draining;
    },
  });
  return issueStartupRuntimeWithStage12Evidence(runtime, {
    capability: (generationId?: string) => {
      const id = generationId ?? activeGeneration!.ready.generationId;
      const capability = stage12Capabilities.get(id);
      if (capability === undefined) throw new Error("startup-stage12-generation-unknown");
      return capability;
    },
    reader: input.checkpoint.readyStage12EvidenceReader,
    fullFamilyReader: input.checkpoint.readyFullFamilyEvidenceReader,
  });
}
