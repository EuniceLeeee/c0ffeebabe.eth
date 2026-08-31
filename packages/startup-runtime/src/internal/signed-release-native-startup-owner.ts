import type { Hash } from "../../../canonical-codec/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import type {
  CanonicalHeadObservationCapabilityV1,
  ProducerSessionV1,
} from "../../../canonical-source/src/index.ts";
import { GraphViewLeaseV1 } from "../../../graph/src/index.ts";
import {
  GenerationBuilderV1,
  type BoundReadyPromotionPort,
  type GenerationBuilderDependencies,
} from "../../../generation-builder/src/index.ts";
import type { ReadyGenerationV1 } from "../../../ready-generation/src/index.ts";
import type {
  ReadyStage12EvidenceCapabilityV1,
  ReadyStage12EvidenceReaderPortV1,
} from "../../../checkpoint/src/ready-stage12-evidence.ts";
import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../../../checkpoint/src/ready-full-family-evidence.ts";
import type {
  StartupProducerLeaseV1,
  StartupRuntimeCompositionInputV1,
} from "../index.ts";
import {
  type NativeStartupOwnerPortV1,
  type NativeStartupGenerationBuilderV1,
  type NativeStartupGenerationHandleV1,
  type NativeStartupLoadedGenerationV1,
  type NativeStartupPromotionBoundaryV1,
  type NativeStartupPromotionRequestV1,
} from "./native-startup-contract.ts";
import {
  runNativeStartupStateMachineForExactAdapter,
  type NativeStartupRuntimeV1,
} from "./native-startup.ts";
import {
  assertIssuedStartupReadyPort,
  startupReadyPromotionPort,
} from "./ready-owner.ts";
import { issueStartupSixStepRouteParentCapabilityV1 } from "./six-step-route-parent-owner.ts";
import { createGeneratedRouteHandleIssuer } from "./generated-route-handle-adapter.ts";
import {
  assertStartupObservationWindow,
  assertStartupPolicy,
  fixedWindowCanonical,
} from "./startup-policy.ts";

type ReadyClosureV1 = Awaited<ReturnType<StartupRuntimeCompositionInputV1["checkpoint"]["loadReadyClosure"]>>;

interface ProductionLoadedGenerationV1 {
  readonly ready: ReadyGenerationV1;
  readonly catalog: ReturnType<StartupRuntimeCompositionInputV1["catalog"]["loadExact"]>;
  readonly closure: ReadyClosureV1;
}

function builderDependencies(
  input: StartupRuntimeCompositionInputV1,
  promotion: BoundReadyPromotionPort,
): GenerationBuilderDependencies {
  return {
    policy: input.policy,
    catalog: input.catalog,
    checkpoint: input.checkpoint,
    canonical: fixedWindowCanonical(input.canonical),
    discovery: input.discovery,
    attestation: input.attestation,
    bindPromotion: () => promotion,
  };
}

function producerLeaseFacade(
  lease: GraphViewLeaseV1,
  stage12Capability: ReadyStage12EvidenceCapabilityV1,
  stage12Reader: ReadyStage12EvidenceReaderPortV1,
): StartupProducerLeaseV1 {
  const facade: {
    readonly binding: StartupProducerLeaseV1["binding"];
    readonly edges: StartupProducerLeaseV1["edges"];
    sixStepRouteParents: StartupProducerLeaseV1["sixStepRouteParents"] | null;
    readonly assertActive: () => Promise<void>;
    readonly resolveRouteHandle: StartupProducerLeaseV1["resolveRouteHandle"];
    readonly release: () => void;
  } = {
    binding: lease.binding,
    edges: lease.edges,
    sixStepRouteParents: null,
    assertActive: () => lease.assertActive(),
    resolveRouteHandle: (edgeId, handle) => lease.resolveRouteHandle(edgeId, handle),
    release: () => lease.release(),
  };
  facade.sixStepRouteParents = issueStartupSixStepRouteParentCapabilityV1({
    lease: facade as StartupProducerLeaseV1,
    binding: lease.binding,
    readOwned: orderedEdgeIds => stage12Reader.routeParents(stage12Capability, orderedEdgeIds),
  });
  return Object.freeze(facade) as StartupProducerLeaseV1;
}

export interface SignedReleaseNativeStartupRuntimeV1 {
  readonly native: NativeStartupRuntimeV1<
    CanonicalHeadObservationCapabilityV1,
    ProducerSessionV1<StartupProducerLeaseV1>
  >;
  readyFor(handle: NativeStartupGenerationHandleV1): ReadyGenerationV1;
  stage12CapabilityFor(handle: NativeStartupGenerationHandleV1): ReadyStage12EvidenceCapabilityV1;
  readonly stage12Reader: ReadyStage12EvidenceReaderPortV1;
  readonly fullFamilyReader: ReadyFullFamilyEvidenceReaderPortV1;
}

/** Exact production adapter. The concrete constructor is intentionally private to this module. */
class SignedReleaseNativeStartupOwner implements NativeStartupOwnerPortV1<
  CanonicalHeadObservationCapabilityV1,
  StartupProducerLeaseV1,
  ProducerSessionV1<StartupProducerLeaseV1>
> {
  readonly #input: StartupRuntimeCompositionInputV1;
  readonly #runtimeBindingId: Hash;
  readonly #implementationCommit: string;
  readonly #routeHandleIssuer: ReturnType<typeof createGeneratedRouteHandleIssuer>;
  readonly #promotion: BoundReadyPromotionPort;
  readonly #generationHandles = new WeakMap<object, ReadyGenerationV1>();
  readonly #promotionRequests = new WeakMap<object, Parameters<BoundReadyPromotionPort["promote"]>[0]>();
  readonly #loadedGenerations = new WeakMap<object, ProductionLoadedGenerationV1>();
  #authorityDescriptor: SignedReleaseRuntimeAuthorityDescriptorV1 | null = null;

  readonly targetRefreshAgeBlocks: string;
  readonly stage12Reader: ReadyStage12EvidenceReaderPortV1;
  readonly fullFamilyReader: ReadyFullFamilyEvidenceReaderPortV1;

  constructor(
    input: StartupRuntimeCompositionInputV1,
    runtimeBindingId: Hash,
    implementationCommit: string,
  ) {
    if (new.target !== SignedReleaseNativeStartupOwner) {
      throw new TypeError("signed release native startup owner cannot be subclassed");
    }
    assertStartupPolicy(input.policy);
    assertIssuedStartupReadyPort(input.ready);
    this.#input = input;
    this.#runtimeBindingId = runtimeBindingId;
    this.#implementationCommit = implementationCommit;
    this.#routeHandleIssuer = createGeneratedRouteHandleIssuer(input.familyRuntime);
    this.#promotion = startupReadyPromotionPort(input.ready);
    this.targetRefreshAgeBlocks = input.policy.targetRefreshAgeBlocks;
    this.stage12Reader = input.checkpoint.readyStage12EvidenceReader;
    this.fullFamilyReader = input.checkpoint.readyFullFamilyEvidenceReader;
    Object.freeze(this);
  }

  #wrapGeneration(ready: ReadyGenerationV1): NativeStartupGenerationHandleV1 {
    const handle = Object.freeze({});
    this.#generationHandles.set(handle, ready);
    return handle;
  }

  #ready(handle: NativeStartupGenerationHandleV1): ReadyGenerationV1 {
    const ready = handle !== null && typeof handle === "object"
      ? this.#generationHandles.get(handle)
      : undefined;
    if (ready === undefined) throw new TypeError("native startup generation is not owner-issued");
    return ready;
  }

  #wrapPromotionRequest(
    input: Parameters<BoundReadyPromotionPort["promote"]>[0],
  ): NativeStartupPromotionRequestV1 {
    const request = Object.freeze({});
    this.#promotionRequests.set(request, input);
    return request;
  }

  #promotionRequest(
    request: NativeStartupPromotionRequestV1,
  ): Parameters<BoundReadyPromotionPort["promote"]>[0] {
    const input = request !== null && typeof request === "object"
      ? this.#promotionRequests.get(request)
      : undefined;
    if (input === undefined) throw new TypeError("native startup promotion request is not owner-issued");
    return input;
  }

  readonly createGenerationBuilder = (
    boundary: NativeStartupPromotionBoundaryV1,
  ): NativeStartupGenerationBuilderV1 => {
    const safePromotion: BoundReadyPromotionPort = Object.freeze({
      findLatestReusable: (
        catalog: Parameters<BoundReadyPromotionPort["findLatestReusable"]>[0],
        policy: Parameters<BoundReadyPromotionPort["findLatestReusable"]>[1],
      ) => this.#promotion.findLatestReusable(catalog, policy),
      promote: async (input: Parameters<BoundReadyPromotionPort["promote"]>[0]) => this.#ready(
        await boundary.promote(this.#wrapPromotionRequest(input)),
      ),
    });
    const builder = new GenerationBuilderV1(builderDependencies(this.#input, safePromotion));
    return Object.freeze({
      loadOrBuildInitial: async (signal: AbortSignal) => this.#wrapGeneration(
        await builder.loadOrBuildInitialReady(signal),
      ),
      buildNext: async (signal: AbortSignal) => {
        await builder.buildNextReady(signal);
      },
    });
  };

  readonly promote = async (
    request: NativeStartupPromotionRequestV1,
  ): Promise<NativeStartupGenerationHandleV1> => this.#wrapGeneration(
    await this.#promotion.promote(this.#promotionRequest(request)),
  );

  readonly findLatestReusable = async (): Promise<NativeStartupGenerationHandleV1 | null> => {
    const ready = await this.#promotion.findLatestReusable(this.#input.catalog.loadExact(), this.#input.policy);
    return ready === null ? null : this.#wrapGeneration(ready);
  };

  readonly generationRecordRoot = (handle: NativeStartupGenerationHandleV1): Hash => (
    this.#ready(handle).readyRecordHash
  );

  readonly loadGeneration = async (
    handle: NativeStartupGenerationHandleV1,
  ): Promise<NativeStartupLoadedGenerationV1> => {
    const ready = this.#ready(handle);
    if (this.#authorityDescriptor === null) {
      this.#authorityDescriptor = createSignedReleaseRuntimeAuthorityDescriptorV1({
        authorityClass: "signed-release",
        runtimeBindingId: this.#runtimeBindingId,
        releaseProvenanceHash: ready.releaseProvenanceHash,
        implementationCommit: this.#implementationCommit,
      });
    } else if (ready.releaseProvenanceHash !== this.#authorityDescriptor.releaseProvenanceHash) {
      throw new Error("startup-runtime-lineage-changed");
    }
    assertStartupObservationWindow(ready.cutoff, ready.recentObservationRange);
    const catalog = this.#input.catalog.loadExact();
    if (catalog.definitionCatalogRoot !== ready.definitionCatalogRoot) {
      throw new Error("startup-definition-catalog-changed");
    }
    const admission = await this.#input.ready.validateServing({
      ready,
      expectedDefinitionCatalogRoot: catalog.definitionCatalogRoot,
      policy: this.#input.policy,
    });
    await this.#input.ready.consumeServingAdmission(admission);
    const closure = await this.#input.checkpoint.loadReadyClosure(ready);
    if (closure.graph.graphRoot !== ready.graphRoot
      || closure.instanceCatalog.instanceCatalogRoot !== ready.instanceCatalogRoot
      || closure.sourceCoverage.sourceCoverageRoot !== ready.sourceCoverageRoot) {
      throw new Error("startup-ready-closure-mismatch");
    }
    const loaded = Object.freeze({ ready, catalog, closure });
    const loadedHandle = Object.freeze({});
    this.#loadedGenerations.set(loadedHandle, loaded);
    return Object.freeze({
      handle: loadedHandle,
      identity: Object.freeze({
        generationId: ready.generationId,
        graphRoot: ready.graphRoot,
        recordRoot: ready.readyRecordHash,
        sourceCoverageRoot: ready.sourceCoverageRoot,
        definitionCatalogRoot: ready.definitionCatalogRoot,
        cutoff: Object.freeze({ number: ready.cutoff.number }),
        observationRange: Object.freeze({
          from: ready.recentObservationRange.from,
          to: ready.recentObservationRange.to,
        }),
        authority: projectRuntimeAuthorityDescriptorV1(this.#authorityDescriptor),
      }),
    });
  };

  #loaded(handle: NativeStartupGenerationHandleV1): ProductionLoadedGenerationV1 {
    const loaded = handle !== null && typeof handle === "object"
      ? this.#loadedGenerations.get(handle)
      : undefined;
    if (loaded === undefined) throw new TypeError("native startup loaded generation is not owner-issued");
    return loaded;
  }

  readonly openProducerLease = async (
    handle: NativeStartupGenerationHandleV1,
  ): Promise<StartupProducerLeaseV1> => {
    const generation = this.#loaded(handle);
    const admission = await this.#input.ready.validateServing({
      ready: generation.ready,
      expectedDefinitionCatalogRoot: generation.catalog.definitionCatalogRoot,
      policy: this.#input.policy,
    });
    const lease = await GraphViewLeaseV1.open(
      admission,
      generation.closure.graph,
      generation.closure.instanceCatalog,
      this.#routeHandleIssuer,
      this.#input.processEpoch,
      this.#input.canonical,
      this.#input.ready,
    );
    return producerLeaseFacade(
      lease,
      generation.closure.stage12EvidenceCapability,
      this.#input.checkpoint.readyStage12EvidenceReader,
    );
  };

  readonly releaseProducerLease = (lease: StartupProducerLeaseV1): void => {
    lease.release();
  };

  readonly openProducerSession = (
    observation: CanonicalHeadObservationCapabilityV1,
    lease: StartupProducerLeaseV1,
    signal?: AbortSignal,
  ): Promise<ProducerSessionV1<StartupProducerLeaseV1>> => (
    this.#input.canonical.openHeadSession(observation, lease, signal)
  );

  readonly closeProducerSession = (
    session: ProducerSessionV1<StartupProducerLeaseV1>,
  ): Promise<void> => session.close();

  readonly producerSessionHeadNumber = (
    session: ProducerSessionV1<StartupProducerLeaseV1>,
  ): string => session.head.number;

  readonly readyFor = (handle: NativeStartupGenerationHandleV1): ReadyGenerationV1 => (
    this.#loaded(handle).ready
  );

  readonly stage12CapabilityFor = (
    handle: NativeStartupGenerationHandleV1,
  ): ReadyStage12EvidenceCapabilityV1 => this.#loaded(handle).closure.stage12EvidenceCapability;
}

Object.freeze(SignedReleaseNativeStartupOwner.prototype);

/** The only signed-release call into the internal generic state machine. */
export async function startSignedReleaseNativeStartupRuntime(input: {
  readonly composition: StartupRuntimeCompositionInputV1;
  readonly runtimeBindingId: Hash;
  readonly implementationCommit: string;
}, signal: AbortSignal): Promise<SignedReleaseNativeStartupRuntimeV1> {
  const owner = new SignedReleaseNativeStartupOwner(
    input.composition,
    input.runtimeBindingId,
    input.implementationCommit,
  );
  const native = await runNativeStartupStateMachineForExactAdapter(owner, signal);
  return Object.freeze({
    native,
    readyFor: owner.readyFor,
    stage12CapabilityFor: owner.stage12CapabilityFor,
    stage12Reader: owner.stage12Reader,
    fullFamilyReader: owner.fullFamilyReader,
  });
}
