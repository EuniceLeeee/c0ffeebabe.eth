import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  ActionOwnerRef,
  GeneratedFamilyEntryV1,
  StageCapabilityRefV1,
} from "../../family-sdk/runtime-refs/index.ts";
import type {
  FamilyIssuedRouteHandleV1,
  FamilyRouteHandleBindingV1,
  FamilyRoutePublicationV1,
  FamilyRouteProjectionV1,
  FamilyRouteRehydrationRefV1,
  FamilyRuntimeAuthorityBindingV1,
  FamilyRuntimeOwnerV1,
  FamilyRuntimePortV1,
  FamilyStageDefinitionV1,
  FamilyStageRuntimePortV1,
  RuntimeStageExecutorV1,
} from "../../family-sdk/runtime/index.ts";
import type {
  FamilySearchAdapterFactoryV1,
  FamilySearchAdapterV1,
  FamilySearchAmountEnvelopeV1,
  FamilySearchCurrentSourceV1,
  FamilySearchObjectiveV1,
  FamilySearchSourceReadPortV1,
} from "../../family-sdk/search-runtime/index.ts";
import {
  familySearchAmount,
  familySearchAmountHash,
  familySearchObjective,
  familySearchRouteBindingHash,
  familySearchSource,
} from "../../family-sdk/search-runtime/index.ts";
import {
  readIssuedCoarseRouteBindingV1,
  sealCoarseEdgeProjectionV1,
  type CoarseEdgeProjectionV1,
  type CoarseEdgeSweepBindingV1,
  type CoarseProjectionCapabilityV1,
  type CoarseProjectionServiceV1,
  type CoarseRouteBindingV1,
  type IssuedCoarseRouteBindingV1,
  type IssuedCoarseEdgeSweepBindingV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../../coarse-economics/src/index.ts";
import { readIssuedCoarseEdgeSweepBindingV1 } from "../../coarse-economics/src/internal/full-graph-sweep-owner.ts";
import { decodeSourcePlanRef, type SourcePlanRefV1 } from "../../discovery/src/index.ts";
import {
  createFamilyRuntimeAuthority,
  issueRuntimeStageDefinitionBinding,
} from "../../family-sdk/runtime/internal/authority-owner.ts";
import {
  registerGeneratedFamilyCoarseProjectionInstallerV1,
  registerGeneratedFamilyCoarseProjectionResultV1,
} from "./internal/coarse-runtime-owner.ts";

const STAGES = ["nomination", "identity", "materialization", "projection", "rehydration"] as const;
type FamilyStageNameV1 = (typeof STAGES)[number];
type CoarseProjectionOwnerDescriptorV1 = QualifiedCoarseProjectionReceiptV1["ownerDescriptor"];

// The generated composition is a release-owned capability.  A structural
// object with the same methods is not an equivalent authority and must not be
// accepted by production runtime consumers.
const generatedCompositionBrands = new WeakSet<object>();

export interface GeneratedFamilyRuntimeBindingV1 {
  readonly entry: GeneratedFamilyEntryV1;
  readonly owner: FamilyRuntimeOwnerV1;
}

export interface FamilyRuntimeCompositionInputV1 {
  readonly definitionCatalogRoot: Hash;
  readonly bindings: readonly GeneratedFamilyRuntimeBindingV1[];
}

export interface GeneratedFamilyRuntimePublicEntryV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
}

export interface GeneratedFamilyRuntimeStageV1 {
  readonly stage: Exclude<StageCapabilityRefV1["stage"], "capability">;
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly stageRef: StageCapabilityRefV1;
}

export interface GeneratedFamilyRuntimeSourcePlanV1 {
  readonly sourcePlanId: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly schemaHash: Hash;
  readonly planRef: SourcePlanRefV1;
  /** Stable plan leaf; an unrelated Family or plan does not change it. */
  readonly leafDigest: Hash;
  readonly nominationProgramProposal: GeneratedSourcePlanNominationProgramProposalV1;
}

export interface GeneratedNominationQualificationEntrypointV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
}

export interface GeneratedSourcePlanNominationProgramProposalV1 {
  readonly program: GeneratedNominationQualificationEntrypointV1 & {
    readonly schemaHash: Hash;
  };
  readonly mutationCorpus: GeneratedNominationQualificationEntrypointV1;
  readonly independentOracle: GeneratedNominationQualificationEntrypointV1;
  readonly nominationProgramRoot: Hash;
  readonly proposalLeafDigest: Hash;
}

export interface GeneratedFamilyRuntimeExtensionV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly capabilityRef: StageCapabilityRefV1;
}

export interface GeneratedFamilyRuntimeActionOwnerV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly ownerRef: ActionOwnerRef;
  readonly ownerId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly implementationHash: Hash;
  readonly actionKinds: readonly string[];
}

/** Generated descriptor for one Family-owned runtime adapter role. */
export interface GeneratedFamilyRuntimeAdapterV1 {
  /** Versioned open role key declared by the Family leaf. */
  readonly role: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly capabilityRefs: Readonly<Record<string, StageCapabilityRefV1>>;
  readonly actionOwnerRefs: Readonly<Record<string, ActionOwnerRef>>;
  /** Stable leaf identity; it intentionally excludes Family hash identity. */
  readonly leafDigest: Hash;
}

/** Static-import sidecar used to re-check descriptor identity at composition time. */
export interface GeneratedFamilyRuntimeAdapterImportV1 {
  readonly factory: FamilySearchAdapterFactoryV1;
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly leafDigest: Hash;
}

export interface GeneratedFamilyRuntimeFamilyV1 {
  readonly entry: GeneratedFamilyEntryV1;
  readonly publicEntry: GeneratedFamilyRuntimePublicEntryV1;
  readonly stages: readonly GeneratedFamilyRuntimeStageV1[];
  readonly sourcePlans: readonly GeneratedFamilyRuntimeSourcePlanV1[];
  readonly extensions: readonly GeneratedFamilyRuntimeExtensionV1[];
  readonly actionOwners: readonly GeneratedFamilyRuntimeActionOwnerV1[];
  readonly runtimeAdapters: readonly GeneratedFamilyRuntimeAdapterV1[];
  readonly runtimeAdapterRoot: Hash;
  readonly sourcePlanRoot: Hash;
  readonly stageDefinitionRoot: Hash;
}

export interface GeneratedFamilyCoarseProjectionDescriptorV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly capabilityRef: StageCapabilityRefV1;
  readonly extension: GeneratedFamilyRuntimeExtensionV1;
  readonly adapter: GeneratedFamilyRuntimeAdapterV1;
  readonly ownerDescriptor: CoarseProjectionOwnerDescriptorV1;
}

export interface GeneratedFamilyCoarseProjectionOwnerInstallationV1 {
  readonly familyDefinitionHash: Hash;
  readonly ownerDescriptor: CoarseProjectionOwnerDescriptorV1;
  readonly service: CoarseProjectionServiceV1;
  readonly releaseProvenanceHash: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly assertCurrent: () => void;
}

/** Stable per-owner derivation. It excludes descriptorRoot, catalog roots and
 * every unrelated Family leaf. */
export function generatedFamilyCoarseProjectionDescriptorV1(
  family: GeneratedFamilyRuntimeFamilyV1,
): GeneratedFamilyCoarseProjectionDescriptorV1 | null {
  const adapter = family.runtimeAdapters.find(value => value.role === "search/v1");
  const capabilityRef = adapter?.capabilityRefs.coarse;
  if (adapter === undefined || capabilityRef === undefined) return null;
  const extension = family.extensions.find(value => exactStageRef(value.capabilityRef, capabilityRef));
  if (extension === undefined) throw new TypeError("generated Family coarse adapter has no exact extension import");
  const implementationHash = hashDomain("aloha/generated-family-coarse-implementation/v1", {
    familyDefinitionHash: family.entry.familyDefinitionHash,
    extension: {
      modulePath: extension.modulePath,
      exportName: extension.exportName,
      closureRoot: extension.closureRoot,
      capabilityRef: extension.capabilityRef,
    },
    adapter: {
      role: adapter.role,
      modulePath: adapter.modulePath,
      exportName: adapter.exportName,
      closureRoot: adapter.closureRoot,
      leafDigest: adapter.leafDigest,
    },
  });
  const ownerDescriptor = deepFreeze({
    ownerRef: capabilityRef.ownerRef,
    capabilityId: capabilityRef.capabilityId,
    capabilityVersion: capabilityRef.version,
    schemaRef: capabilityRef.schemaHash,
    interpreterHash: capabilityRef.interpreterHash,
    implementationHash,
    boundVerifierHash: hashDomain("aloha/generated-family-coarse-rank-only-verifier/v1", {
      implementationHash,
      mode: "no-hard-prune-until-proof-qualified",
    }),
  });
  return deepFreeze({
    familyId: family.entry.familyId,
    familyDefinitionHash: family.entry.familyDefinitionHash,
    capabilityRef,
    extension,
    adapter,
    ownerDescriptor,
  });
}

export interface GeneratedFamilyRuntimeDescriptorV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  /** Exact root of the pre-commit proposed capability set consumed by catalog generation. */
  readonly proposedCapabilitySetRoot: Hash;
  readonly nominationProgramSetRoot: Hash;
  readonly families: readonly GeneratedFamilyRuntimeFamilyV1[];
  readonly descriptorRoot: Hash;
}

/**
 * This is the narrow deployment hand-off. The generated descriptor fixes the
 * exact Family entry and stage closures; deployment supplies only its bound
 * authority values and per-stage executors. The generated composition creates
 * the owner after binding the exact imported definitions. A prebuilt owner or
 * Family-supplied root is deliberately not accepted here.
 */
export interface GeneratedFamilyRuntimeAuthorityBindingV1 {
  readonly familyDefinitionHash: Hash;
  readonly definitionBindingRoot: Hash;
  readonly binding: FamilyRuntimeAuthorityBindingV1;
  readonly executors: readonly {
    readonly stage: FamilyStageNameV1;
    readonly executor: RuntimeStageExecutorV1;
  }[];
}

export interface GeneratedFamilyRuntimeCompositionInputV1 {
  readonly descriptor: GeneratedFamilyRuntimeDescriptorV1;
  readonly authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[];
  /** Exact named imports emitted by the catalog generator, one set per Family. */
  readonly definitions: readonly (readonly FamilyStageDefinitionV1[])[];
  /** Exact named extension imports emitted by the catalog generator. */
  readonly extensions: readonly (readonly object[])[];
  /** Exact named action-owner imports emitted by the catalog generator. */
  readonly actionOwners: readonly (readonly object[])[];
  /** Exact named adapter-factory imports emitted by the catalog generator. */
  readonly runtimeAdapters?: readonly (readonly (object | GeneratedFamilyRuntimeAdapterImportV1)[])[];
}

export interface FamilyRuntimeCompositionEntryV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly definitionCatalogLeafDigest: Hash;
  readonly capabilityCatalogRoot: Hash;
  readonly lifecycleRefs: GeneratedFamilyEntryV1["lifecycleRefs"];
  readonly extensionRefs: GeneratedFamilyEntryV1["extensionRefs"];
  readonly actionOwnerRefs: GeneratedFamilyEntryV1["actionOwnerRefs"];
  readonly owner: FamilyRuntimeOwnerV1;
}

/** Opaque generated owner identity. A copied object or caller callback is
 * never accepted as a coarse producer. */
export type FamilyCoarseProjectionProducerV1 = object;

export interface FamilyRuntimeCoarseProjectionSeamV1 {
  readonly producer: FamilyCoarseProjectionProducerV1;
  readonly service: CoarseProjectionServiceV1;
}

export interface FamilyRuntimeCurrentSourceV1 {
  readonly sessionId?: Hash;
  readonly source: Readonly<{
    readonly chainId: string;
    readonly number: string;
    readonly hash: string;
    readonly stateRoot: string;
  }>;
  readonly assertCurrent: () => Promise<void> | void;
}

export interface FamilyRuntimeCoarseProjectionRequestV1 {
  readonly binding: IssuedCoarseRouteBindingV1;
  readonly legIndex: number;
  readonly issuedHandle: FamilyIssuedRouteHandleV1;
  readonly currentSource: FamilyRuntimeCurrentSourceV1;
  readonly sourceRead: FamilySearchSourceReadPortV1;
  readonly objective: FamilySearchObjectiveV1;
  readonly amount: FamilySearchAmountEnvelopeV1;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

/** Acceptance-only directed-edge request. It deliberately has no route,
 * candidate, planner, or ranking fields. */
export interface FamilyRuntimeCoarseEdgeSweepRequestV1 {
  readonly binding: IssuedCoarseEdgeSweepBindingV1;
  readonly issuedHandle: FamilyIssuedRouteHandleV1;
  readonly currentSource: FamilyRuntimeCurrentSourceV1;
  readonly sourceRead: FamilySearchSourceReadPortV1;
  readonly objective: FamilySearchObjectiveV1;
  readonly amount: FamilySearchAmountEnvelopeV1;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Owner-issued record of the exact Family stage values that produced one
 * generic coarse capability.  Stage values are retained as canonical raw
 * values: downstream observers must exact-decode them and may not reconstruct
 * a Family artifact from the generic projection receipt.
 */
export interface FamilyRuntimeCoarseProjectionObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.family-runtime-coarse-projection-observation-v1";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly binding: CoarseRouteBindingV1;
  readonly legIndex: string;
  readonly routeHandleBindingHash: Hash;
  readonly amountHash: Hash;
  readonly projectionId: Hash;
  readonly stateOutcome: CanonicalJson;
  /** Null means the state stage was unavailable and coarse was not invoked. */
  readonly coarseOutcome: CanonicalJson | null;
  readonly observationRoot: Hash;
}

export interface FamilyRuntimeCoarseEdgeSweepObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.family-runtime-coarse-edge-sweep-observation-v1";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly binding: CoarseEdgeSweepBindingV1;
  readonly routeHandleBindingHash: Hash;
  readonly amountHash: Hash;
  readonly projectionId: Hash;
  readonly stateOutcome: CanonicalJson;
  readonly coarseOutcome: CanonicalJson | null;
  readonly observationRoot: Hash;
}

/** Shared route-owner identity used by search-runtime-core and this generated
 * owner. It binds one Family definition to the exact resolved route handle. */
export function familyCoarseRouteOwnerRefV1(familyDefinitionHash: Hash, routeBindingHash: Hash): Hash {
  return hashDomain("aloha/search-runtime-route-owner/v1", {
    familyDefinitionHash: assertHash(familyDefinitionHash, "familyDefinitionHash"),
    routeBindingHash: assertHash(routeBindingHash, "routeBindingHash"),
  });
}

/** Process-local handle used only by the rehydration owner. */
export type FamilyRehydrationSessionV1 = object;

export interface FamilyRuntimeCompositionV1 {
  readonly definitionCatalogRoot: Hash;
  readonly compositionRoot: Hash;
  readonly entries: readonly FamilyRuntimeCompositionEntryV1[];
  resolve(familyDefinitionHash: Hash, familyId?: string): FamilyRuntimeCompositionEntryV1 | null;
  require(familyDefinitionHash: Hash, familyId?: string): FamilyRuntimeCompositionEntryV1;
  openRehydrationSession(familyDefinitionHash: Hash): FamilyRehydrationSessionV1;
  rehydrateRouteHandle(
    session: FamilyRehydrationSessionV1,
    publication: FamilyRoutePublicationV1,
    projection: FamilyRouteProjectionV1,
    ref: FamilyRouteRehydrationRefV1,
  ): FamilyIssuedRouteHandleV1;
  resolveRouteHandle(handle: FamilyIssuedRouteHandleV1, familyDefinitionHash: Hash): FamilyRouteHandleBindingV1;
  resolveCapability(familyDefinitionHash: Hash, capabilityRef: StageCapabilityRefV1): object;
  resolveActionOwner(familyDefinitionHash: Hash, ownerRef: ActionOwnerRef): object;
  /** Resolve one generated adapter by exact Family hash and versioned role. */
  resolveAdapter(familyDefinitionHash: Hash, role: string): FamilySearchAdapterV1;
  requireAdapter(familyDefinitionHash: Hash, role: string): FamilySearchAdapterV1;
  /** Missing optional capability is explicit and routes to bounded-unranked. */
  resolveCoarseProjection(familyDefinitionHash: Hash): FamilyRuntimeCoarseProjectionSeamV1 | null;
  /** Sole request issuer. The producer, route handle and search binding are
   * all process-local capabilities owned by their respective boundaries. */
  issueCoarseProjection(
    producer: FamilyCoarseProjectionProducerV1,
    request: FamilyRuntimeCoarseProjectionRequestV1,
  ): Promise<CoarseProjectionCapabilityV1>;
  /** Acceptance-only complete-Graph edge probe. It never contributes to
   * planner admission, route ranking, or normal lane performance facts. */
  issueCoarseEdgeSweepProjection(
    producer: FamilyCoarseProjectionProducerV1,
    request: FamilyRuntimeCoarseEdgeSweepRequestV1,
  ): Promise<CoarseProjectionCapabilityV1>;
  /** Read only the raw stage observation paired with this exact opaque result. */
  readCoarseProjectionObservation(
    producer: FamilyCoarseProjectionProducerV1,
    capability: CoarseProjectionCapabilityV1,
  ): FamilyRuntimeCoarseProjectionObservationV1;
  readCoarseEdgeSweepObservation(
    producer: FamilyCoarseProjectionProducerV1,
    capability: CoarseProjectionCapabilityV1,
  ): FamilyRuntimeCoarseEdgeSweepObservationV1;
  revoke(): void;
}

export function assertGeneratedFamilyRuntimeComposition(value: unknown): asserts value is FamilyRuntimeCompositionV1 {
  if (value === null || typeof value !== "object" || !generatedCompositionBrands.has(value)) {
    throw new TypeError("Family runtime composition is not generated and release-authenticated");
  }
}

interface RehydrationSessionStateV1 {
  readonly familyDefinitionHash: Hash;
}

function exactStageRef(left: StageCapabilityRefV1, right: StageCapabilityRefV1): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function canonicalObservationValue(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stageRefs(entry: GeneratedFamilyEntryV1): readonly StageCapabilityRefV1[] {
  return STAGES.map(stage => entry.lifecycleRefs[stage]);
}

function validateBinding(input: GeneratedFamilyRuntimeBindingV1): FamilyRuntimeCompositionEntryV1 {
  if (input === null || typeof input !== "object") throw new TypeError("Family runtime binding is required");
  const entry = input.entry;
  if (entry === null || typeof entry !== "object") throw new TypeError("Family runtime entry is required");
  assertNonEmptyString(entry.familyId, "Family runtime entry.familyId");
  assertHash(entry.familyDefinitionHash, "Family runtime entry.familyDefinitionHash");
  assertHash(entry.definitionCatalogLeafDigest, "Family runtime entry.definitionCatalogLeafDigest");
  assertHash(entry.capabilityCatalogRoot, "Family runtime entry.capabilityCatalogRoot");
  if (input.owner === null || typeof input.owner !== "object") throw new TypeError("Family runtime owner is required");
  if (input.owner.port === null || typeof input.owner.port !== "object") throw new TypeError("Family runtime port is required");
  for (const stageRef of stageRefs(entry)) {
    const stage = input.owner.port.getStage(stageRef);
    if (stage === null || typeof stage !== "object" || !exactStageRef(stage.stageRef, stageRef)) {
      throw new TypeError(`Family runtime stage ref mismatch for ${entry.familyId}`);
    }
  }
  return Object.freeze({
    familyId: entry.familyId,
    familyDefinitionHash: entry.familyDefinitionHash,
    definitionCatalogLeafDigest: entry.definitionCatalogLeafDigest,
    capabilityCatalogRoot: entry.capabilityCatalogRoot,
    lifecycleRefs: Object.freeze({ ...entry.lifecycleRefs }),
    extensionRefs: Object.freeze([...entry.extensionRefs]),
    actionOwnerRefs: Object.freeze([...entry.actionOwnerRefs]),
    owner: input.owner,
  });
}

function entryKey(value: Pick<FamilyRuntimeCompositionEntryV1, "familyId" | "familyDefinitionHash">): string {
  return `${value.familyId}\u0000${value.familyDefinitionHash}`;
}

function compositionRoot(
  definitionCatalogRoot: Hash,
  entries: readonly FamilyRuntimeCompositionEntryV1[],
): Hash {
  return hashDomain("aloha/family-runtime-composition/v1", {
    definitionCatalogRoot,
    entries: entries.map(entry => ({
      familyId: entry.familyId,
      familyDefinitionHash: entry.familyDefinitionHash,
      definitionCatalogLeafDigest: entry.definitionCatalogLeafDigest,
      capabilityCatalogRoot: entry.capabilityCatalogRoot,
      lifecycleRefs: entry.lifecycleRefs,
      extensionRefs: entry.extensionRefs,
      actionOwnerRefs: entry.actionOwnerRefs,
    })),
  });
}

function generatedDescriptorRoot(
  descriptor: Omit<GeneratedFamilyRuntimeDescriptorV1, "descriptorRoot">,
): Hash {
  return hashDomain("aloha/generated-family-runtime-descriptor/v1", descriptor);
}

function stageDefinitionRoot(
  stages: readonly GeneratedFamilyRuntimeStageV1[],
): Hash {
  return hashDomain("aloha/family-runtime-definition-set/v1", [...stages].sort((left, right) => left.stage.localeCompare(right.stage)).map(stage => ({
    stage: stage.stage,
    modulePath: stage.modulePath,
    exportName: stage.exportName,
    closureRoot: stage.closureRoot,
    stageRef: stage.stageRef,
  })));
}

function adapterRefPayload(ref: StageCapabilityRefV1): Record<string, unknown> {
  // Family id/hash identify the containing release, not this reusable leaf.
  // Keeping them out of the leaf digest lets an unrelated adapter declaration
  // change the aggregate catalog without invalidating an existing adapter
  // leaf's own content identity.
  return {
    stage: ref.stage,
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    interpreterHash: ref.interpreterHash,
    ownerRef: ref.ownerRef,
  };
}

/** Stable digest shared by catalog generation and runtime descriptor checks. */
export function runtimeAdapterLeafDigest(adapter: Pick<GeneratedFamilyRuntimeAdapterV1, "role" | "modulePath" | "exportName" | "closureRoot" | "capabilityRefs" | "actionOwnerRefs">): Hash {
  return hashDomain("aloha/family-runtime-adapter-leaf/v1", {
    role: adapter.role,
    modulePath: adapter.modulePath,
    exportName: adapter.exportName,
    closureRoot: adapter.closureRoot,
    capabilityRefs: Object.entries(adapter.capabilityRefs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, ref]) => ({ role, ref: adapterRefPayload(ref) })),
    actionOwnerRefs: Object.entries(adapter.actionOwnerRefs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, ownerRef]) => ({ role, ownerRef })),
  });
}

function runtimeAdapterRoot(adapters: readonly GeneratedFamilyRuntimeAdapterV1[]): Hash {
  return hashDomain("aloha/family-runtime-adapter-set/v1", adapters.map(adapter => adapter.leafDigest).sort());
}

/** Content identity for one source plan, independent of aggregate catalog roots. */
export function sourcePlanLeafDigest(plan: Pick<GeneratedFamilyRuntimeSourcePlanV1, "sourcePlanId" | "modulePath" | "exportName" | "closureRoot" | "schemaHash" | "planRef">): Hash {
  return hashDomain("aloha/family-source-plan-leaf/v1", {
    sourcePlanId: plan.sourcePlanId,
    modulePath: plan.modulePath,
    exportName: plan.exportName,
    closureRoot: plan.closureRoot,
    schemaHash: plan.schemaHash,
    planRef: {
      ownerRef: plan.planRef.ownerRef,
      sourcePlanRef: plan.planRef.sourcePlanRef,
      completeness: plan.planRef.completeness,
      historyStartBlock: plan.planRef.historyStartBlock,
    },
  });
}

export function nominationProgramRoot(
  value: Pick<GeneratedSourcePlanNominationProgramProposalV1, "program">,
): Hash {
  return hashDomain("aloha/family-source-plan-nomination-program/v1", value.program);
}

export function nominationProgramProposalLeafDigest(
  sourcePlanLeafDigestValue: Hash,
  value: Omit<GeneratedSourcePlanNominationProgramProposalV1, "proposalLeafDigest">,
): Hash {
  return hashDomain("aloha/source-plan-nomination-program-proposal-leaf/v1", {
    sourcePlanLeafDigest: sourcePlanLeafDigestValue,
    program: value.program,
    mutationCorpus: value.mutationCorpus,
    independentOracle: value.independentOracle,
    nominationProgramRoot: value.nominationProgramRoot,
  });
}

export function nominationProgramSetRoot(leaves: readonly Hash[]): Hash {
  const ordered = [...leaves].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new TypeError("duplicate nomination qualification leaf");
  }
  return hashDomain("aloha/source-plan-nomination-program-set/v1", ordered);
}

function sourcePlanRoot(plans: readonly GeneratedFamilyRuntimeSourcePlanV1[]): Hash {
  return hashDomain("aloha/family-source-plan-set/v1", plans.map(plan => plan.leafDigest).sort());
}

function validateGeneratedDescriptor(
  descriptor: GeneratedFamilyRuntimeDescriptorV1,
): GeneratedFamilyRuntimeDescriptorV1 {
  if (descriptor === null || typeof descriptor !== "object") throw new TypeError("generated Family runtime descriptor is required");
  if (descriptor.schemaVersion !== 1) throw new TypeError("unsupported generated Family runtime descriptor");
  assertHash(descriptor.releaseIntentRoot, "generatedFamilyRuntime.releaseIntentRoot");
  assertHash(descriptor.definitionCatalogRoot, "generatedFamilyRuntime.definitionCatalogRoot");
  assertHash(descriptor.proposedCapabilitySetRoot, "generatedFamilyRuntime.proposedCapabilitySetRoot");
  assertHash(descriptor.nominationProgramSetRoot, "generatedFamilyRuntime.nominationProgramSetRoot");
  assertHash(descriptor.descriptorRoot, "generatedFamilyRuntime.descriptorRoot");
  if (!Array.isArray(descriptor.families) || descriptor.families.length === 0) {
    throw new TypeError("generated Family runtime descriptor has no release Families");
  }
  const families = descriptor.families.map((family, index) => {
    if (family === null || typeof family !== "object") throw new TypeError("generated Family runtime family " + index + " is invalid");
    const entry = family.entry;
    if (entry === null || typeof entry !== "object") throw new TypeError("generated Family runtime entry " + index + " is invalid");
    assertNonEmptyString(entry.familyId, "generatedFamilyRuntime.families[" + index + "].entry.familyId");
    assertHash(entry.familyDefinitionHash, "generatedFamilyRuntime.families[" + index + "].entry.familyDefinitionHash");
    assertHash(entry.definitionCatalogLeafDigest, "generatedFamilyRuntime.families[" + index + "].entry.definitionCatalogLeafDigest");
    assertHash(entry.capabilityCatalogRoot, "generatedFamilyRuntime.families[" + index + "].entry.capabilityCatalogRoot");
    if (family.publicEntry === null || typeof family.publicEntry !== "object") throw new TypeError("generated Family public entry " + index + " is invalid");
    assertNonEmptyString(family.publicEntry.modulePath, "generatedFamilyRuntime.families[" + index + "].publicEntry.modulePath");
    assertNonEmptyString(family.publicEntry.exportName, "generatedFamilyRuntime.families[" + index + "].publicEntry.exportName");
    assertHash(family.publicEntry.closureRoot, "generatedFamilyRuntime.families[" + index + "].publicEntry.closureRoot");
    assertHash(family.stageDefinitionRoot, "generatedFamilyRuntime.families[" + index + "].stageDefinitionRoot");
    assertHash(family.runtimeAdapterRoot, "generatedFamilyRuntime.families[" + index + "].runtimeAdapterRoot");
    assertHash(family.sourcePlanRoot, "generatedFamilyRuntime.families[" + index + "].sourcePlanRoot");
    if (!Array.isArray(family.stages) || family.stages.length !== 5) throw new TypeError("generated Family stage set " + index + " is incomplete");
    const stages: GeneratedFamilyRuntimeStageV1[] = family.stages.map((stage: GeneratedFamilyRuntimeStageV1, stageIndex: number) => {
      if (stage === null || typeof stage !== "object") throw new TypeError("generated Family stage " + index + ":" + stageIndex + " is invalid");
      if (!["nomination", "identity", "materialization", "projection", "rehydration"].includes(stage.stage)) {
        throw new TypeError("generated Family stage " + index + ":" + stageIndex + " is invalid");
      }
      if (
        stage.stageRef.familyId !== entry.familyId
        || stage.stageRef.familyDefinitionHash !== entry.familyDefinitionHash
        || stage.stageRef.stage !== stage.stage
        || !exactStageRef(stage.stageRef, entry.lifecycleRefs[stage.stage])
      ) {
        throw new TypeError("generated Family stage " + index + ":" + stageIndex + " binding mismatch");
      }
      assertNonEmptyString(stage.modulePath, "generatedFamilyRuntime.families[" + index + "].stages[" + stageIndex + "].modulePath");
      assertNonEmptyString(stage.exportName, "generatedFamilyRuntime.families[" + index + "].stages[" + stageIndex + "].exportName");
      assertHash(stage.closureRoot, "generatedFamilyRuntime.families[" + index + "].stages[" + stageIndex + "].closureRoot");
      return stage;
    }).sort((left: GeneratedFamilyRuntimeStageV1, right: GeneratedFamilyRuntimeStageV1) => left.stage.localeCompare(right.stage));
    if (new Set(stages.map(stage => stage.stage)).size !== 5) throw new TypeError("generated Family stage set " + index + " has duplicates");
    if (stageDefinitionRoot(stages) !== family.stageDefinitionRoot) throw new TypeError("generated Family stage definition root mismatch");
    if (!Array.isArray(family.sourcePlans) || family.sourcePlans.length === 0) {
      throw new TypeError("generated Family source plan set " + index + " is incomplete");
    }
    const rawSourcePlans = family.sourcePlans as readonly GeneratedFamilyRuntimeSourcePlanV1[];
    const sourcePlans: GeneratedFamilyRuntimeSourcePlanV1[] = rawSourcePlans.map((plan: GeneratedFamilyRuntimeSourcePlanV1, planIndex: number) => {
      if (plan === null || typeof plan !== "object") throw new TypeError("generated Family source plan " + index + ":" + planIndex + " is invalid");
      const planRef = decodeSourcePlanRef(plan.planRef, "generatedFamilyRuntime.sourcePlan.planRef");
      if (planRef.familyDefinitionHash !== entry.familyDefinitionHash) throw new TypeError("generated Family source plan definition mismatch");
      assertNonEmptyString(plan.sourcePlanId, "generatedFamilyRuntime.sourcePlan.sourcePlanId");
      assertNonEmptyString(plan.modulePath, "generatedFamilyRuntime.sourcePlan.modulePath");
      assertNonEmptyString(plan.exportName, "generatedFamilyRuntime.sourcePlan.exportName");
      assertHash(plan.closureRoot, "generatedFamilyRuntime.sourcePlan.closureRoot");
      assertHash(plan.schemaHash, "generatedFamilyRuntime.sourcePlan.schemaHash");
      assertHash(plan.leafDigest, "generatedFamilyRuntime.sourcePlan.leafDigest");
      if (sourcePlanLeafDigest({ ...plan, planRef }) !== plan.leafDigest) throw new TypeError("generated Family source plan leaf mismatch");
      const qualification = plan.nominationProgramProposal;
      if (qualification === null || typeof qualification !== "object") {
        throw new TypeError("generated Family source plan nomination qualification is missing");
      }
      for (const [name, entrypoint] of [
        ["program", qualification.program],
        ["mutationCorpus", qualification.mutationCorpus],
        ["independentOracle", qualification.independentOracle],
      ] as const) {
        if (entrypoint === null || typeof entrypoint !== "object") {
          throw new TypeError(`generated Family nomination ${name} is invalid`);
        }
        assertNonEmptyString(entrypoint.modulePath, `generatedFamilyRuntime.nomination.${name}.modulePath`);
        assertNonEmptyString(entrypoint.exportName, `generatedFamilyRuntime.nomination.${name}.exportName`);
        assertHash(entrypoint.closureRoot, `generatedFamilyRuntime.nomination.${name}.closureRoot`);
      }
      assertHash(qualification.program.schemaHash, "generatedFamilyRuntime.nomination.program.schemaHash");
      assertHash(qualification.nominationProgramRoot, "generatedFamilyRuntime.nomination.nominationProgramRoot");
      assertHash(qualification.proposalLeafDigest, "generatedFamilyRuntime.nomination.proposalLeafDigest");
      if (qualification.nominationProgramRoot !== nominationProgramRoot(qualification)) {
        throw new TypeError("generated Family nomination program root mismatch");
      }
      const { proposalLeafDigest, ...proposalWithoutLeaf } = qualification;
      if (proposalLeafDigest !== nominationProgramProposalLeafDigest(plan.leafDigest, proposalWithoutLeaf)) {
        throw new TypeError("generated Family nomination program proposal leaf mismatch");
      }
      return Object.freeze({ ...plan, planRef });
    }).sort((left, right) => left.sourcePlanId.localeCompare(right.sourcePlanId));
    if (new Set(sourcePlans.map(plan => plan.sourcePlanId)).size !== sourcePlans.length) throw new TypeError("generated Family source plan ids contain duplicates");
    if (new Set(sourcePlans.map(plan => plan.planRef.sourcePlanRef)).size !== sourcePlans.length) throw new TypeError("generated Family source plan refs contain duplicates");
    if (sourcePlanRoot(sourcePlans) !== family.sourcePlanRoot) throw new TypeError("generated Family source plan root mismatch");
    if (!Array.isArray(entry.sourcePlanRefs) || entry.sourcePlanRefs.length !== sourcePlans.length) throw new TypeError("generated Family catalog source plan set is incomplete");
    const catalogPlanRefs = (entry.sourcePlanRefs as readonly SourcePlanRefV1[]).map((planRef: SourcePlanRefV1, planIndex: number) => decodeSourcePlanRef(planRef, `generatedFamilyRuntime.entry.sourcePlanRefs[${planIndex}]`))
      .sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef));
    const descriptorPlanRefs = sourcePlans.map(plan => plan.planRef).sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef));
    if (catalogPlanRefs.some((planRef, planIndex) => encodeCanonicalJson(planRef) !== encodeCanonicalJson(descriptorPlanRefs[planIndex]))) {
      throw new TypeError("generated Family catalog/runtime source plan mismatch");
    }
    if (!Array.isArray(family.extensions) || family.extensions.length !== entry.extensionRefs.length) {
      throw new TypeError("generated Family extension set " + index + " is incomplete");
    }
    const extensions: GeneratedFamilyRuntimeExtensionV1[] = family.extensions.map((extension: GeneratedFamilyRuntimeExtensionV1, extensionIndex: number) => {
      if (extension === null || typeof extension !== "object") throw new TypeError("generated Family extension " + index + ":" + extensionIndex + " is invalid");
      assertNonEmptyString(extension.modulePath, "generatedFamilyRuntime.families[" + index + "].extensions[" + extensionIndex + "].modulePath");
      assertNonEmptyString(extension.exportName, "generatedFamilyRuntime.families[" + index + "].extensions[" + extensionIndex + "].exportName");
      assertHash(extension.closureRoot, "generatedFamilyRuntime.families[" + index + "].extensions[" + extensionIndex + "].closureRoot");
      if (extension.capabilityRef.stage !== "capability") throw new TypeError("generated Family extension stage mismatch");
      const expected = entry.extensionRefs.find((ref: StageCapabilityRefV1) => ref.capabilityId === extension.capabilityRef.capabilityId);
      if (expected === undefined || !exactStageRef(expected, extension.capabilityRef)) throw new TypeError("generated Family extension ref mismatch");
      return Object.freeze(extension);
    }).sort((left: GeneratedFamilyRuntimeExtensionV1, right: GeneratedFamilyRuntimeExtensionV1) => left.capabilityRef.capabilityId.localeCompare(right.capabilityRef.capabilityId));
    if (new Set(extensions.map((extension: GeneratedFamilyRuntimeExtensionV1) => extension.capabilityRef.capabilityId)).size !== extensions.length) throw new TypeError("generated Family extension set has duplicates");
    if (!Array.isArray(family.actionOwners) || family.actionOwners.length !== entry.actionOwnerRefs.length) {
      throw new TypeError("generated Family action owner set " + index + " is incomplete");
    }
    const actionOwners: GeneratedFamilyRuntimeActionOwnerV1[] = family.actionOwners.map((action: GeneratedFamilyRuntimeActionOwnerV1, actionIndex: number) => {
      if (action === null || typeof action !== "object") throw new TypeError("generated Family action owner " + index + ":" + actionIndex + " is invalid");
      assertNonEmptyString(action.modulePath, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].modulePath");
      assertNonEmptyString(action.exportName, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].exportName");
      assertHash(action.closureRoot, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].closureRoot");
      assertHash(action.ownerRef, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].ownerRef");
      assertNonEmptyString(action.ownerId, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].ownerId");
      assertNonEmptyString(action.version, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].version");
      assertHash(action.schemaHash, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].schemaHash");
      assertHash(action.implementationHash, "generatedFamilyRuntime.families[" + index + "].actionOwners[" + actionIndex + "].implementationHash");
      if (!Array.isArray(action.actionKinds) || action.actionKinds.length === 0 || action.actionKinds.some((kind: string) => typeof kind !== "string" || kind.length === 0)) throw new TypeError("generated Family action kinds are invalid");
      if (!entry.actionOwnerRefs.includes(action.ownerRef)) throw new TypeError("generated Family action owner ref mismatch");
      return Object.freeze({ ...action, actionKinds: Object.freeze([...action.actionKinds]) });
    }).sort((left: GeneratedFamilyRuntimeActionOwnerV1, right: GeneratedFamilyRuntimeActionOwnerV1) => left.ownerRef.localeCompare(right.ownerRef));
    if (new Set(actionOwners.map((action: GeneratedFamilyRuntimeActionOwnerV1) => action.ownerRef)).size !== actionOwners.length) throw new TypeError("generated Family action owner set has duplicates");
    if (!Array.isArray(family.runtimeAdapters)) throw new TypeError("generated Family runtime adapter set " + index + " is invalid");
    const runtimeAdapters: GeneratedFamilyRuntimeAdapterV1[] = family.runtimeAdapters.map((adapter: GeneratedFamilyRuntimeAdapterV1, adapterIndex: number) => {
      if (adapter === null || typeof adapter !== "object") throw new TypeError("generated Family runtime adapter " + index + ":" + adapterIndex + " is invalid");
      assertNonEmptyString(adapter.role, "generatedFamilyRuntime.families[" + index + "].runtimeAdapters[" + adapterIndex + "].role");
      assertNonEmptyString(adapter.modulePath, "generatedFamilyRuntime.families[" + index + "].runtimeAdapters[" + adapterIndex + "].modulePath");
      assertNonEmptyString(adapter.exportName, "generatedFamilyRuntime.families[" + index + "].runtimeAdapters[" + adapterIndex + "].exportName");
      assertHash(adapter.closureRoot, "generatedFamilyRuntime.families[" + index + "].runtimeAdapters[" + adapterIndex + "].closureRoot");
      assertHash(adapter.leafDigest, "generatedFamilyRuntime.families[" + index + "].runtimeAdapters[" + adapterIndex + "].leafDigest");
      if (adapter.capabilityRefs === null || typeof adapter.capabilityRefs !== "object" || Array.isArray(adapter.capabilityRefs)) throw new TypeError("generated Family runtime adapter capability refs are invalid");
      const capabilityRefs: Record<string, StageCapabilityRefV1> = {};
      for (const [role, ref] of Object.entries(adapter.capabilityRefs)) {
        assertNonEmptyString(role, "generated Family runtime adapter capability role");
        if (ref === null || typeof ref !== "object") throw new TypeError("generated Family runtime adapter capability ref is invalid");
        if (
          ref.familyId !== entry.familyId
          || ref.familyDefinitionHash !== entry.familyDefinitionHash
          || ref.stage !== "capability"
        ) throw new TypeError("generated Family runtime adapter capability binding mismatch");
        const declared = entry.extensionRefs.find((candidate: StageCapabilityRefV1) => exactStageRef(candidate, ref));
        if (declared === undefined) throw new TypeError("generated Family runtime adapter capability ref is not release-qualified");
        capabilityRefs[role] = ref;
      }
      if (adapter.actionOwnerRefs === null || typeof adapter.actionOwnerRefs !== "object" || Array.isArray(adapter.actionOwnerRefs)) throw new TypeError("generated Family runtime adapter action refs are invalid");
      const actionOwnerRefs: Record<string, ActionOwnerRef> = {};
      for (const [role, ownerRefInput] of Object.entries(adapter.actionOwnerRefs)) {
        assertNonEmptyString(role, "generated Family runtime adapter action role");
        const ownerRef = assertHash(ownerRefInput, "generated Family runtime adapter action owner ref") as ActionOwnerRef;
        if (!entry.actionOwnerRefs.includes(ownerRef)) throw new TypeError("generated Family runtime adapter action owner ref is not release-qualified");
        actionOwnerRefs[role] = ownerRef;
      }
      const normalized = Object.freeze({
        ...adapter,
        capabilityRefs: Object.freeze(Object.fromEntries(Object.entries(capabilityRefs).sort(([left], [right]) => left.localeCompare(right)))),
        actionOwnerRefs: Object.freeze(Object.fromEntries(Object.entries(actionOwnerRefs).sort(([left], [right]) => left.localeCompare(right)))),
      });
      if (runtimeAdapterLeafDigest(normalized) !== adapter.leafDigest) throw new TypeError("generated Family runtime adapter leaf digest mismatch");
      return normalized;
    }).sort((left: GeneratedFamilyRuntimeAdapterV1, right: GeneratedFamilyRuntimeAdapterV1) => left.role.localeCompare(right.role));
    if (new Set(runtimeAdapters.map(adapter => adapter.role)).size !== runtimeAdapters.length) throw new TypeError("generated Family runtime adapter roles are duplicated");
    if (runtimeAdapterRoot(runtimeAdapters) !== family.runtimeAdapterRoot) throw new TypeError("generated Family runtime adapter root mismatch");
    return Object.freeze({
      ...family,
      stages: Object.freeze(stages),
      sourcePlans: Object.freeze(sourcePlans),
      extensions: Object.freeze(extensions),
      actionOwners: Object.freeze(actionOwners),
      runtimeAdapters: Object.freeze(runtimeAdapters),
    });
  }).sort((left, right) => left.entry.familyId.localeCompare(right.entry.familyId));
  if (new Set(families.map(family => family.entry.familyId)).size !== families.length) throw new TypeError("generated Family runtime has duplicate family ids");
  if (new Set(families.map(family => family.entry.familyDefinitionHash)).size !== families.length) throw new TypeError("generated Family runtime has duplicate definition hashes");
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: descriptor.releaseIntentRoot,
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: descriptor.nominationProgramSetRoot,
    families: Object.freeze(families),
    descriptorRoot: descriptor.descriptorRoot,
  });
  const { descriptorRoot, ...withoutRoot } = normalized;
  if (generatedDescriptorRoot(withoutRoot) !== descriptorRoot) throw new TypeError("generated Family runtime descriptor root mismatch");
  const nominationLeaves = normalized.families.flatMap((family: GeneratedFamilyRuntimeFamilyV1) =>
    family.sourcePlans.map((plan: GeneratedFamilyRuntimeSourcePlanV1) =>
      plan.nominationProgramProposal.proposalLeafDigest));
  if (nominationProgramSetRoot(nominationLeaves) !== normalized.nominationProgramSetRoot) {
    throw new TypeError("generated Family nomination program set mismatch");
  }
  return normalized;
}

/**
 * Production composition entry point. It accepts only the machine-generated
 * descriptor plus authority bindings issued by the deployment boundary. The
 * generic entry+owner primitive below remains available for isolated unit
 * tests; production runtime must not construct its own Family entry set.
 */
export function createGeneratedFamilyRuntimeComposition(
  input: GeneratedFamilyRuntimeCompositionInputV1,
): FamilyRuntimeCompositionV1 {
  if (input === null || typeof input !== "object") throw new TypeError("generated Family runtime composition input is required");
  const descriptor = validateGeneratedDescriptor(input.descriptor);
  if (!Array.isArray(input.authorities) || input.authorities.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime authority set is incomplete");
  }
  if (!Array.isArray(input.definitions) || input.definitions.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime definition set is incomplete");
  }
  if (!Array.isArray(input.extensions) || input.extensions.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime extension set is incomplete");
  }
  if (!Array.isArray(input.actionOwners) || input.actionOwners.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime action owner set is incomplete");
  }
  const runtimeAdapterImports = input.runtimeAdapters ?? descriptor.families.map(() => Object.freeze([]) as readonly object[]);
  if (!Array.isArray(runtimeAdapterImports) || runtimeAdapterImports.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime adapter set is incomplete");
  }
  const authorities = input.authorities.map((authority, index) => {
    if (authority === null || typeof authority !== "object") throw new TypeError("generated Family authority " + index + " is invalid");
    assertHash(authority.familyDefinitionHash, "generatedFamilyRuntime.authorities[" + index + "].familyDefinitionHash");
    assertHash(authority.definitionBindingRoot, "generatedFamilyRuntime.authorities[" + index + "].definitionBindingRoot");
    if (authority.binding === null || typeof authority.binding !== "object") throw new TypeError("generated Family authority " + index + ".binding is invalid");
    if (!Array.isArray(authority.executors) || authority.executors.length !== STAGES.length) throw new TypeError("generated Family authority " + index + ".executors is incomplete");
    return authority;
  });
  if (new Set(authorities.map(authority => authority.familyDefinitionHash)).size !== authorities.length) {
    throw new TypeError("generated Family runtime authorities contain duplicates");
  }
  const authorityByDefinition = new Map(authorities.map(authority => [authority.familyDefinitionHash, authority] as const));
  const bindings = descriptor.families.map((family, index) => {
    const authority = authorityByDefinition.get(family.entry.familyDefinitionHash);
    if (authority === undefined) throw new TypeError("missing generated Family authority " + family.entry.familyId);
    if (authority.definitionBindingRoot !== family.stageDefinitionRoot) {
      throw new TypeError("generated Family authority definition binding mismatch " + family.entry.familyId);
    }
    const definitions = input.definitions[index];
    if (!Array.isArray(definitions) || definitions.length !== STAGES.length) {
      throw new TypeError("generated Family runtime definitions are incomplete " + family.entry.familyId);
    }
    if (
      authority.binding.familyId !== family.entry.familyId
      || authority.binding.familyDefinitionHash !== family.entry.familyDefinitionHash
    ) {
      throw new TypeError("generated Family authority binding identity mismatch " + family.entry.familyId);
    }
    const definitionsByStage = new Map<FamilyStageNameV1, FamilyStageDefinitionV1>();
    for (const rawDefinition of definitions) {
      const definition = deepFreeze(rawDefinition);
      if (definition === null || typeof definition !== "object") throw new TypeError("generated Family runtime definition is invalid " + family.entry.familyId);
      if (definitionsByStage.has(definition.stage)) throw new TypeError("generated Family runtime definition stages contain duplicates " + family.entry.familyId);
      definitionsByStage.set(definition.stage, definition);
    }
    if (definitionsByStage.size !== STAGES.length) throw new TypeError("generated Family runtime definition stages are incomplete " + family.entry.familyId);
    const executorsByStage = new Map<FamilyStageNameV1, RuntimeStageExecutorV1>();
    for (const item of authority.executors) {
      if (item === null || typeof item !== "object" || !STAGES.includes(item.stage)) throw new TypeError("generated Family executor binding is invalid " + family.entry.familyId);
      if (executorsByStage.has(item.stage)) throw new TypeError("generated Family executor stages contain duplicates " + family.entry.familyId);
      if (item.executor === null || typeof item.executor !== "object" || typeof item.executor.execute !== "function") throw new TypeError("generated Family executor is invalid " + family.entry.familyId);
      executorsByStage.set(item.stage, item.executor);
    }
    if (executorsByStage.size !== STAGES.length) throw new TypeError("generated Family executor stages are incomplete " + family.entry.familyId);
    const stages = family.stages.map(stage => {
      const definition = definitionsByStage.get(stage.stage);
      const executor = executorsByStage.get(stage.stage);
      if (definition === undefined || executor === undefined) throw new TypeError("generated Family stage definition/executor missing " + family.entry.familyId + ":" + stage.stage);
      if (
        definition.stage !== stage.stage
        || definition.capabilityId !== stage.stageRef.capabilityId
        || definition.version !== stage.stageRef.version
        || definition.schemaHash !== stage.stageRef.schemaHash
      ) throw new TypeError("generated Family stage definition identity mismatch " + family.entry.familyId + ":" + stage.stage);
      return {
        stageRef: stage.stageRef,
        definition,
        definitionBinding: issueRuntimeStageDefinitionBinding({
          stageRef: stage.stageRef,
          definition,
          descriptorClosureHash: stage.stageRef.interpreterHash,
        }),
        executor,
      };
    });
    const owner = createFamilyRuntimeAuthority({
      binding: authority.binding,
      stages,
    });
    return Object.freeze({ entry: family.entry, owner });
  });
  const base = createFamilyRuntimeComposition({
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    bindings,
  });
  const capabilityPorts = new Map<string, object>();
  const actionOwnerPorts = new Map<string, object>();
  const adapterFactories = new Map<string, FamilySearchAdapterFactoryV1>();
  for (const [familyIndex, family] of descriptor.families.entries()) {
    const extensions = input.extensions[familyIndex];
    const actionOwners = input.actionOwners[familyIndex];
    const adapters = runtimeAdapterImports[familyIndex];
    if (!Array.isArray(extensions) || extensions.length !== family.extensions.length) throw new TypeError("generated Family runtime extension imports are incomplete " + family.entry.familyId);
    if (!Array.isArray(actionOwners) || actionOwners.length !== family.actionOwners.length) throw new TypeError("generated Family runtime action imports are incomplete " + family.entry.familyId);
    if (!Array.isArray(adapters) || adapters.length !== family.runtimeAdapters.length) throw new TypeError("generated Family runtime adapter imports are incomplete " + family.entry.familyId);
    for (const [extensionIndex, extension] of family.extensions.entries()) {
      const port = extensions[extensionIndex];
      if (port === null || (typeof port !== "object" && typeof port !== "function")) throw new TypeError("generated Family runtime extension import is invalid " + family.entry.familyId);
      capabilityPorts.set(`${family.entry.familyDefinitionHash}\u0000${extension.capabilityRef.capabilityId}`, port as object);
    }
    for (const [actionIndex, action] of family.actionOwners.entries()) {
      const port = actionOwners[actionIndex];
      if (port === null || (typeof port !== "object" && typeof port !== "function")) throw new TypeError("generated Family runtime action import is invalid " + family.entry.familyId);
      actionOwnerPorts.set(`${family.entry.familyDefinitionHash}\u0000${action.ownerRef}`, port as object);
    }
    for (const [adapterIndex, adapter] of family.runtimeAdapters.entries()) {
      const supplied = adapters[adapterIndex];
      const factory = typeof supplied === "function" ? supplied : supplied?.factory;
      if (typeof factory !== "function") throw new TypeError("generated Family runtime adapter factory import is invalid " + family.entry.familyId);
      if (typeof supplied === "object" && supplied !== null) {
        const importDescriptor = supplied as Partial<GeneratedFamilyRuntimeAdapterImportV1>;
        if (
          importDescriptor.modulePath !== adapter.modulePath
          || importDescriptor.exportName !== adapter.exportName
          || importDescriptor.closureRoot !== adapter.closureRoot
          || importDescriptor.leafDigest !== adapter.leafDigest
        ) throw new TypeError("generated Family runtime adapter import descriptor mismatch " + family.entry.familyId);
      }
      adapterFactories.set(`${family.entry.familyDefinitionHash}\u0000${adapter.role}`, factory as FamilySearchAdapterFactoryV1);
    }
  }
  const adapterCache = new Map<string, FamilySearchAdapterV1>();
  const coarseDescriptors = new Map<Hash, GeneratedFamilyCoarseProjectionDescriptorV1>();
  for (const family of descriptor.families) {
    const coarse = generatedFamilyCoarseProjectionDescriptorV1(family);
    if (coarse !== null) coarseDescriptors.set(family.entry.familyDefinitionHash, coarse);
  }
  const coarseProducerStates = new WeakMap<object, Readonly<{
    readonly descriptor: GeneratedFamilyCoarseProjectionDescriptorV1;
    readonly service: CoarseProjectionServiceV1;
    readonly releaseProvenanceHash: Hash;
    readonly releaseMembershipRoot: Hash;
    readonly assertCurrent: () => void;
  }>>();
  const coarseProjectionObservations = new WeakMap<object, Readonly<{
    readonly producer: FamilyCoarseProjectionProducerV1;
    readonly observation: FamilyRuntimeCoarseProjectionObservationV1;
  }>>();
  const coarseEdgeSweepObservations = new WeakMap<object, Readonly<{
    readonly producer: FamilyCoarseProjectionProducerV1;
    readonly observation: FamilyRuntimeCoarseEdgeSweepObservationV1;
  }>>();
  const coarseSeams = new Map<Hash, FamilyRuntimeCoarseProjectionSeamV1>();
  let generated: FamilyRuntimeCompositionV1;
  const resolveAdapter = (familyDefinitionHashInput: Hash, roleInput: string): FamilySearchAdapterV1 => {
    const entry = base.require(familyDefinitionHashInput);
    const role = assertNonEmptyString(roleInput, "runtimeAdapterRole");
    const key = `${entry.familyDefinitionHash}\u0000${role}`;
    const existing = adapterCache.get(key);
    if (existing !== undefined) return existing;
    const descriptorAdapter = descriptor.families
      .find(family => family.entry.familyDefinitionHash === entry.familyDefinitionHash)
      ?.runtimeAdapters.find(adapter => adapter.role === role);
    if (descriptorAdapter === undefined) throw new TypeError("Family runtime adapter role is not release-qualified");
    const factory = adapterFactories.get(key);
    if (factory === undefined) throw new TypeError("Family runtime adapter factory is not composed");
    const adapter = factory({
      composition: generated,
      familyDefinitionHash: entry.familyDefinitionHash,
      capabilityRefs: descriptorAdapter.capabilityRefs,
      actionOwnerRefs: descriptorAdapter.actionOwnerRefs,
    });
    if (adapter === null || typeof adapter !== "object") throw new TypeError("Family runtime adapter factory returned an invalid adapter");
    for (const method of ["readState", "projectCoarse", "evaluateExact", "buildAction", "run"] as const) {
      if (typeof adapter[method] !== "function") throw new TypeError("Family runtime adapter is incomplete");
    }
    adapterCache.set(key, adapter);
    return adapter;
  };
  generated = Object.freeze({
    ...base,
    resolveCapability(familyDefinitionHashInput: Hash, capabilityRef: StageCapabilityRefV1): object {
      const entry = base.require(familyDefinitionHashInput, capabilityRef.familyId);
      if (capabilityRef.familyDefinitionHash !== entry.familyDefinitionHash || capabilityRef.stage !== "capability") throw new TypeError("Family capability binding mismatch");
      const declared = entry.extensionRefs.find(ref => ref.capabilityId === capabilityRef.capabilityId);
      if (declared === undefined || !exactStageRef(declared, capabilityRef)) throw new TypeError("Family capability is not release-qualified");
      const port = capabilityPorts.get(`${entry.familyDefinitionHash}\u0000${capabilityRef.capabilityId}`);
      if (!port) throw new TypeError("Family capability port is not composed");
      return port;
    },
    resolveActionOwner(familyDefinitionHashInput: Hash, ownerRefInput: ActionOwnerRef): object {
      const entry = base.require(familyDefinitionHashInput);
      const ownerRef = assertHash(ownerRefInput, "actionOwnerRef") as ActionOwnerRef;
      const declared = entry.actionOwnerRefs.includes(ownerRef);
      if (!declared) throw new TypeError("Family action owner is not release-qualified");
      const port = actionOwnerPorts.get(`${entry.familyDefinitionHash}\u0000${ownerRef}`);
      if (!port) throw new TypeError("Family action owner port is not composed");
      return port;
    },
    resolveAdapter,
    requireAdapter: resolveAdapter,
    resolveCoarseProjection(familyDefinitionHashInput: Hash): FamilyRuntimeCoarseProjectionSeamV1 | null {
      const familyDefinitionHash = assertHash(familyDefinitionHashInput, "familyDefinitionHash");
      if (base.resolve(familyDefinitionHash) === null) return null;
      return coarseSeams.get(familyDefinitionHash) ?? null;
    },
    async issueCoarseProjection(
      producer: FamilyCoarseProjectionProducerV1,
      request: FamilyRuntimeCoarseProjectionRequestV1,
    ): Promise<CoarseProjectionCapabilityV1> {
      if (producer === null || typeof producer !== "object") throw new TypeError("generated Family coarse producer is invalid");
      const producerState = coarseProducerStates.get(producer);
      if (producerState === undefined) throw new TypeError("generated Family coarse producer was not issued by this composition");
      producerState.assertCurrent();
      const binding = readIssuedCoarseRouteBindingV1(request.binding);
      if (!Number.isInteger(request.legIndex) || request.legIndex < 0 || request.legIndex >= binding.legs.length) {
        throw new TypeError("generated Family coarse leg index is invalid");
      }
      const leg = binding.legs[request.legIndex]!;
      const descriptor = producerState.descriptor;
      if (binding.releaseProvenanceHash !== producerState.releaseProvenanceHash) {
        throw new TypeError("generated Family coarse release provenance mismatch");
      }
      const route = generated.resolveRouteHandle(request.issuedHandle, descriptor.familyDefinitionHash);
      if (route.familyDefinitionHash !== descriptor.familyDefinitionHash || route.familyId !== descriptor.familyId) {
        throw new TypeError("generated Family coarse route handle mismatch");
      }
      const routeBindingHash = familySearchRouteBindingHash(route);
      const expectedRouteOwnerRef = familyCoarseRouteOwnerRefV1(descriptor.familyDefinitionHash, routeBindingHash);
      if (!binding.ownerRefs.includes(expectedRouteOwnerRef)) {
        throw new TypeError("generated Family coarse route owner mismatch");
      }
      const source = familySearchSource(request.currentSource.source, "generatedCoarse.currentSource.source");
      if (source.chainId !== binding.source.chainId || source.number !== binding.source.number
        || source.hash !== binding.source.hash || source.stateRoot !== binding.source.stateRoot) {
        throw new TypeError("generated Family coarse current source mismatch");
      }
      const objective = familySearchObjective(request.objective);
      if (objective.objectiveRef !== binding.objectiveRef) throw new TypeError("generated Family coarse objective mismatch");
      const amount = familySearchAmount(request.amount);
      if (amount.inputAssetRef !== leg.inputAssetRef || amount.outputAssetRef !== leg.outputAssetRef) {
        throw new TypeError("generated Family coarse route asset mismatch");
      }
      if (request.sourceRead === null || typeof request.sourceRead !== "object" || typeof request.sourceRead.read !== "function") {
        throw new TypeError("generated Family coarse current-source read port is required");
      }
      const adapterCurrentSource: FamilySearchCurrentSourceV1 = Object.freeze({
        source,
        assertCurrent: request.currentSource.assertCurrent,
      });
      const adapter = resolveAdapter(descriptor.familyDefinitionHash, descriptor.adapter.role);
      await request.currentSource.assertCurrent();
      producerState.assertCurrent();
      let projection: CoarseEdgeProjectionV1;
      let stateOutcomeSnapshot: CanonicalJson | null = null;
      let coarseOutcomeSnapshot: CanonicalJson | null = null;
      const common = {
        edgeId: leg.edgeId,
        transitionRef: leg.transitionRef,
        routeBindingHash: binding.routeBindingHash,
        generationId: binding.generationId,
        graphRoot: binding.graphRoot,
        source: binding.source,
        objectiveRef: binding.objectiveRef,
        ownerRef: descriptor.ownerDescriptor.ownerRef,
        capabilityDigest: hashDomain("aloha/generated-family-coarse-capability/v1", descriptor.ownerDescriptor),
        dependencyRoot: hashDomain("aloha/generated-family-coarse-dependency/v1", {
          requestedArtifactDependencyRoot: route.requestedArtifactDependencyRoot,
          transitionRef: leg.transitionRef,
          inputPortRef: leg.inputPortRef,
          outputPortRef: leg.outputPortRef,
          implementationHash: descriptor.ownerDescriptor.implementationHash,
        }),
        sampleInput: { assetRef: amount.inputAssetRef, amount: amount.amountIn },
      };
      try {
        const rawStateOutcome = await adapter.readState({
          route,
          currentSource: adapterCurrentSource,
          objective,
          amount,
          readPort: request.sourceRead,
          ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        stateOutcomeSnapshot = canonicalObservationValue(rawStateOutcome, "generatedCoarse.stateOutcome");
        const stateOutcome = stateOutcomeSnapshot as unknown as Awaited<ReturnType<FamilySearchAdapterV1["readState"]>>;
        if (stateOutcome.kind === "invalidProgram") throw new TypeError(`generated Family coarse state invalid: ${stateOutcome.code}`);
        if (stateOutcome.kind === "unavailable") {
          projection = sealCoarseEdgeProjectionV1({
            ...common,
            stateFactsRoot: stateOutcome.evidenceHash,
            estimatedOutput: null,
            conservativeOutputUpperBound: null,
            inputCapacityUpperBound: null,
            status: "unavailable",
            reasonCode: `state:${stateOutcome.reasonCode}`,
          });
        } else {
          if (stateOutcome.kind !== "verified") throw new TypeError("generated Family coarse state outcome kind is invalid");
          if (stateOutcome.artifact.routeBindingHash !== routeBindingHash) throw new TypeError("generated Family coarse state route binding mismatch");
          const rawCoarseOutcome = adapter.projectCoarse({ route, currentSource: adapterCurrentSource, objective, amount, state: stateOutcome.artifact });
          coarseOutcomeSnapshot = canonicalObservationValue(rawCoarseOutcome, "generatedCoarse.coarseOutcome");
          const coarseOutcome = coarseOutcomeSnapshot as unknown as ReturnType<FamilySearchAdapterV1["projectCoarse"]>;
          if (coarseOutcome.kind === "invalidProgram") throw new TypeError(`generated Family coarse projection invalid: ${coarseOutcome.code}`);
          if (coarseOutcome.kind === "unavailable") {
            projection = sealCoarseEdgeProjectionV1({
              ...common,
              stateFactsRoot: stateOutcome.artifact.factsRoot,
              estimatedOutput: null,
              conservativeOutputUpperBound: null,
              inputCapacityUpperBound: null,
              status: "unavailable",
              reasonCode: `coarse:${coarseOutcome.reasonCode}`,
            });
          } else {
            if (coarseOutcome.kind !== "verified") throw new TypeError("generated Family coarse projection outcome kind is invalid");
            const artifact = coarseOutcome.artifact;
            if (artifact.routeBindingHash !== routeBindingHash || artifact.objectiveRef !== objective.objectiveRef
              || artifact.source.chainId !== source.chainId || artifact.source.number !== source.number
              || artifact.source.hash !== source.hash || artifact.source.stateRoot !== source.stateRoot
              || artifact.input.assetRef !== amount.inputAssetRef || artifact.input.amount !== amount.amountIn) {
              throw new TypeError("generated Family coarse artifact binding mismatch");
            }
            if (artifact.status === "rankable" && artifact.output === null) throw new TypeError("generated Family coarse rankable output is missing");
            projection = sealCoarseEdgeProjectionV1({
              ...common,
              stateFactsRoot: artifact.stateFactsRoot,
              estimatedOutput: artifact.status === "rankable" ? artifact.output : null,
              // Rank-only until an independent bound verifier is release-qualified.
              conservativeOutputUpperBound: null,
              inputCapacityUpperBound: null,
              status: artifact.status,
              reasonCode: artifact.status === "rankable" ? null : (artifact.reasonCode ?? "coarse-unavailable"),
            });
          }
        }
      } finally {
        await request.currentSource.assertCurrent();
        producerState.assertCurrent();
      }
      if (stateOutcomeSnapshot === null) throw new TypeError("generated Family coarse state observation is missing");
      const capability = Object.freeze(Object.create(null)) as CoarseProjectionCapabilityV1;
      const observationBody = deepFreeze({
        schemaVersion: 1 as const,
        kind: "aloha.family-runtime-coarse-projection-observation-v1" as const,
        familyId: descriptor.familyId,
        familyDefinitionHash: descriptor.familyDefinitionHash,
        releaseMembershipRoot: producerState.releaseMembershipRoot,
        binding,
        legIndex: String(request.legIndex),
        routeHandleBindingHash: routeBindingHash,
        amountHash: familySearchAmountHash(amount),
        projectionId: projection.projectionId,
        stateOutcome: stateOutcomeSnapshot,
        coarseOutcome: coarseOutcomeSnapshot,
      });
      const observation = deepFreeze({
        ...observationBody,
        observationRoot: hashDomain(
          "aloha/family-runtime-coarse-projection-observation/v1",
          observationBody as unknown as CanonicalJson,
        ),
      });
      registerGeneratedFamilyCoarseProjectionResultV1(capability, Object.freeze({
        composition: generated,
        service: producerState.service,
        assertCurrent: producerState.assertCurrent,
        projection,
      }));
      coarseProjectionObservations.set(capability, Object.freeze({ producer, observation }));
      return capability;
    },
    async issueCoarseEdgeSweepProjection(
      producer: FamilyCoarseProjectionProducerV1,
      request: FamilyRuntimeCoarseEdgeSweepRequestV1,
    ): Promise<CoarseProjectionCapabilityV1> {
      if (producer === null || typeof producer !== "object") throw new TypeError("generated Family coarse producer is invalid");
      const producerState = coarseProducerStates.get(producer);
      if (producerState === undefined) throw new TypeError("generated Family coarse producer was not issued by this composition");
      producerState.assertCurrent();
      const binding = readIssuedCoarseEdgeSweepBindingV1(request.binding);
      const descriptor = producerState.descriptor;
      if (binding.familyId !== descriptor.familyId
        || binding.familyDefinitionHash !== descriptor.familyDefinitionHash) {
        throw new TypeError("generated Family coarse edge sweep Family mismatch");
      }
      if (binding.releaseProvenanceHash !== producerState.releaseProvenanceHash) {
        throw new TypeError("generated Family coarse edge sweep release provenance mismatch");
      }
      const route = generated.resolveRouteHandle(request.issuedHandle, descriptor.familyDefinitionHash);
      if (route.familyDefinitionHash !== descriptor.familyDefinitionHash || route.familyId !== descriptor.familyId) {
        throw new TypeError("generated Family coarse edge sweep route handle mismatch");
      }
      const routeBindingHash = familySearchRouteBindingHash(route);
      if (binding.routeBindingHash !== routeBindingHash
        || binding.routeOwnerRef !== familyCoarseRouteOwnerRefV1(descriptor.familyDefinitionHash, routeBindingHash)) {
        throw new TypeError("generated Family coarse edge sweep route owner mismatch");
      }
      const source = familySearchSource(request.currentSource.source, "generatedCoarseEdgeSweep.currentSource.source");
      if (source.chainId !== binding.source.chainId || source.number !== binding.source.number
        || source.hash !== binding.source.hash || source.stateRoot !== binding.source.stateRoot) {
        throw new TypeError("generated Family coarse edge sweep current source mismatch");
      }
      const objective = familySearchObjective(request.objective);
      if (objective.objectiveRef !== binding.objectiveRef) throw new TypeError("generated Family coarse edge sweep objective mismatch");
      const amount = familySearchAmount(request.amount);
      if (amount.inputAssetRef !== binding.inputAssetRef || amount.outputAssetRef !== binding.outputAssetRef) {
        throw new TypeError("generated Family coarse edge sweep asset direction mismatch");
      }
      if (request.sourceRead === null || typeof request.sourceRead !== "object" || typeof request.sourceRead.read !== "function") {
        throw new TypeError("generated Family coarse edge sweep current-source read port is required");
      }
      const adapterCurrentSource: FamilySearchCurrentSourceV1 = Object.freeze({
        source,
        assertCurrent: request.currentSource.assertCurrent,
      });
      const adapter = resolveAdapter(descriptor.familyDefinitionHash, descriptor.adapter.role);
      await request.currentSource.assertCurrent();
      producerState.assertCurrent();
      let projection: CoarseEdgeProjectionV1;
      let stateOutcomeSnapshot: CanonicalJson | null = null;
      let coarseOutcomeSnapshot: CanonicalJson | null = null;
      const common = {
        edgeId: binding.edgeId,
        transitionRef: binding.transitionRef,
        routeBindingHash,
        generationId: binding.generationId,
        graphRoot: binding.graphRoot,
        source: binding.source,
        objectiveRef: binding.objectiveRef,
        ownerRef: descriptor.ownerDescriptor.ownerRef,
        capabilityDigest: hashDomain("aloha/generated-family-coarse-capability/v1", descriptor.ownerDescriptor),
        dependencyRoot: hashDomain("aloha/generated-family-coarse-dependency/v1", {
          requestedArtifactDependencyRoot: route.requestedArtifactDependencyRoot,
          transitionRef: binding.transitionRef,
          inputPortRef: binding.inputPortRef,
          outputPortRef: binding.outputPortRef,
          implementationHash: descriptor.ownerDescriptor.implementationHash,
        }),
        sampleInput: { assetRef: amount.inputAssetRef, amount: amount.amountIn },
      };
      try {
        const rawStateOutcome = await adapter.readState({
          route,
          currentSource: adapterCurrentSource,
          objective,
          amount,
          readPort: request.sourceRead,
          ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        stateOutcomeSnapshot = canonicalObservationValue(rawStateOutcome, "generatedCoarseEdgeSweep.stateOutcome");
        const stateOutcome = stateOutcomeSnapshot as unknown as Awaited<ReturnType<FamilySearchAdapterV1["readState"]>>;
        if (stateOutcome.kind === "invalidProgram") throw new TypeError(`generated Family coarse edge sweep state invalid: ${stateOutcome.code}`);
        if (stateOutcome.kind === "unavailable") {
          projection = sealCoarseEdgeProjectionV1({
            ...common,
            stateFactsRoot: stateOutcome.evidenceHash,
            estimatedOutput: null,
            conservativeOutputUpperBound: null,
            inputCapacityUpperBound: null,
            status: "unavailable",
            reasonCode: `state:${stateOutcome.reasonCode}`,
          });
        } else {
          if (stateOutcome.kind !== "verified") throw new TypeError("generated Family coarse edge sweep state outcome kind is invalid");
          if (stateOutcome.artifact.routeBindingHash !== routeBindingHash) throw new TypeError("generated Family coarse edge sweep state route binding mismatch");
          const rawCoarseOutcome = adapter.projectCoarse({ route, currentSource: adapterCurrentSource, objective, amount, state: stateOutcome.artifact });
          coarseOutcomeSnapshot = canonicalObservationValue(rawCoarseOutcome, "generatedCoarseEdgeSweep.coarseOutcome");
          const coarseOutcome = coarseOutcomeSnapshot as unknown as ReturnType<FamilySearchAdapterV1["projectCoarse"]>;
          if (coarseOutcome.kind === "invalidProgram") throw new TypeError(`generated Family coarse edge sweep projection invalid: ${coarseOutcome.code}`);
          if (coarseOutcome.kind === "unavailable") {
            projection = sealCoarseEdgeProjectionV1({
              ...common,
              stateFactsRoot: stateOutcome.artifact.factsRoot,
              estimatedOutput: null,
              conservativeOutputUpperBound: null,
              inputCapacityUpperBound: null,
              status: "unavailable",
              reasonCode: `coarse:${coarseOutcome.reasonCode}`,
            });
          } else {
            if (coarseOutcome.kind !== "verified") throw new TypeError("generated Family coarse edge sweep projection outcome kind is invalid");
            const artifact = coarseOutcome.artifact;
            if (artifact.routeBindingHash !== routeBindingHash || artifact.objectiveRef !== objective.objectiveRef
              || artifact.source.chainId !== source.chainId || artifact.source.number !== source.number
              || artifact.source.hash !== source.hash || artifact.source.stateRoot !== source.stateRoot
              || artifact.input.assetRef !== amount.inputAssetRef || artifact.input.amount !== amount.amountIn) {
              throw new TypeError("generated Family coarse edge sweep artifact binding mismatch");
            }
            if (artifact.status === "rankable" && artifact.output === null) throw new TypeError("generated Family coarse edge sweep rankable output is missing");
            projection = sealCoarseEdgeProjectionV1({
              ...common,
              stateFactsRoot: artifact.stateFactsRoot,
              estimatedOutput: artifact.status === "rankable" ? artifact.output : null,
              conservativeOutputUpperBound: null,
              inputCapacityUpperBound: null,
              status: artifact.status,
              reasonCode: artifact.status === "rankable" ? null : (artifact.reasonCode ?? "coarse-unavailable"),
            });
          }
        }
      } finally {
        await request.currentSource.assertCurrent();
        producerState.assertCurrent();
      }
      if (stateOutcomeSnapshot === null) throw new TypeError("generated Family coarse edge sweep state observation is missing");
      const capability = Object.freeze(Object.create(null)) as CoarseProjectionCapabilityV1;
      const observationBody = deepFreeze({
        schemaVersion: 1 as const,
        kind: "aloha.family-runtime-coarse-edge-sweep-observation-v1" as const,
        familyId: descriptor.familyId,
        familyDefinitionHash: descriptor.familyDefinitionHash,
        releaseMembershipRoot: producerState.releaseMembershipRoot,
        binding,
        routeHandleBindingHash: routeBindingHash,
        amountHash: familySearchAmountHash(amount),
        projectionId: projection.projectionId,
        stateOutcome: stateOutcomeSnapshot,
        coarseOutcome: coarseOutcomeSnapshot,
      });
      const observation = deepFreeze({
        ...observationBody,
        observationRoot: hashDomain(
          "aloha/family-runtime-coarse-edge-sweep-observation/v1",
          observationBody as unknown as CanonicalJson,
        ),
      });
      registerGeneratedFamilyCoarseProjectionResultV1(capability, Object.freeze({
        composition: generated,
        service: producerState.service,
        assertCurrent: producerState.assertCurrent,
        projection,
      }));
      coarseEdgeSweepObservations.set(capability, Object.freeze({ producer, observation }));
      return capability;
    },
    readCoarseProjectionObservation(
      producer: FamilyCoarseProjectionProducerV1,
      capability: CoarseProjectionCapabilityV1,
    ): FamilyRuntimeCoarseProjectionObservationV1 {
      if (producer === null || typeof producer !== "object") throw new TypeError("generated Family coarse producer is invalid");
      const producerState = coarseProducerStates.get(producer);
      if (producerState === undefined) throw new TypeError("generated Family coarse producer was not issued by this composition");
      if (capability === null || typeof capability !== "object") throw new TypeError("generated Family coarse capability is invalid");
      const issued = coarseProjectionObservations.get(capability);
      if (issued === undefined || issued.producer !== producer) {
        throw new TypeError("generated Family coarse observation was not issued for this producer");
      }
      producerState.assertCurrent();
      return issued.observation;
    },
    readCoarseEdgeSweepObservation(
      producer: FamilyCoarseProjectionProducerV1,
      capability: CoarseProjectionCapabilityV1,
    ): FamilyRuntimeCoarseEdgeSweepObservationV1 {
      if (producer === null || typeof producer !== "object") throw new TypeError("generated Family coarse producer is invalid");
      const producerState = coarseProducerStates.get(producer);
      if (producerState === undefined) throw new TypeError("generated Family coarse producer was not issued by this composition");
      if (capability === null || typeof capability !== "object") throw new TypeError("generated Family coarse capability is invalid");
      const issued = coarseEdgeSweepObservations.get(capability);
      if (issued === undefined || issued.producer !== producer) {
        throw new TypeError("generated Family coarse edge sweep observation was not issued for this producer");
      }
      producerState.assertCurrent();
      return issued.observation;
    },
  });
  registerGeneratedFamilyCoarseProjectionInstallerV1(generated, (value) => {
    const familyDefinitionHash = assertHash(value.familyDefinitionHash, "coarseOwner.familyDefinitionHash");
    const descriptor = coarseDescriptors.get(familyDefinitionHash);
    if (descriptor === undefined) throw new TypeError("generated Family coarse capability is unavailable");
    if (encodeCanonicalJson(value.ownerDescriptor) !== encodeCanonicalJson(descriptor.ownerDescriptor)) {
      throw new TypeError("generated Family coarse owner descriptor mismatch");
    }
    if (value.releaseProvenanceHash === value.releaseMembershipRoot) throw new TypeError("generated Family coarse release roots are not independently bound");
    assertHash(value.releaseProvenanceHash, "coarseOwner.releaseProvenanceHash");
    assertHash(value.releaseMembershipRoot, "coarseOwner.releaseMembershipRoot");
    if (typeof value.assertCurrent !== "function") throw new TypeError("generated Family coarse release fence is required");
    if (coarseSeams.has(familyDefinitionHash)) throw new TypeError("generated Family coarse owner is already installed");
    value.assertCurrent();
    const producer = Object.freeze(Object.create(null)) as FamilyCoarseProjectionProducerV1;
    coarseProducerStates.set(producer, Object.freeze({
      descriptor,
      service: value.service,
      releaseProvenanceHash: value.releaseProvenanceHash,
      releaseMembershipRoot: value.releaseMembershipRoot,
      assertCurrent: value.assertCurrent,
    }));
    coarseSeams.set(familyDefinitionHash, Object.freeze({ producer, service: value.service }));
  });
  generatedCompositionBrands.add(generated);
  return generated;
}

/**
 * The generated release composition is the only caller that should invoke
 * this owner. It binds generated catalog leaves to already-issued Family
 * runtime owners; it never creates a Family authority or accepts a raw
 * definition/callback from Attestation.
 */
export function createFamilyRuntimeComposition(input: FamilyRuntimeCompositionInputV1): FamilyRuntimeCompositionV1 {
  if (input === null || typeof input !== "object") throw new TypeError("Family runtime composition input is required");
  const definitionCatalogRoot = assertHash(input.definitionCatalogRoot, "definitionCatalogRoot");
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) throw new TypeError("Family runtime composition requires release bindings");
  const entries = input.bindings.map(validateBinding).sort((left, right) =>
    entryKey(left).localeCompare(entryKey(right)));
  if (new Set(entries.map(entryKey)).size !== entries.length) throw new TypeError("duplicate Family runtime composition entry");
  if (new Set(entries.map(entry => entry.familyDefinitionHash)).size !== entries.length) throw new TypeError("duplicate Family definition hash");

  const byDefinition = new Map(entries.map(entry => [entry.familyDefinitionHash, entry] as const));
  const byFamilyAndDefinition = new Map(entries.map(entry => [entryKey(entry), entry] as const));
  const sessions = new WeakMap<object, RehydrationSessionStateV1>();
  let active = true;

  const requireActive = (): void => {
    if (!active) throw new Error("Family runtime composition revoked");
  };
  const resolve = (familyDefinitionHashInput: Hash, familyId?: string): FamilyRuntimeCompositionEntryV1 | null => {
    requireActive();
    const familyDefinitionHash = assertHash(familyDefinitionHashInput, "familyDefinitionHash");
    const entry = familyId === undefined
      ? byDefinition.get(familyDefinitionHash)
      : byFamilyAndDefinition.get(`${assertNonEmptyString(familyId, "familyId")}\u0000${familyDefinitionHash}`);
    return entry ?? null;
  };
  const requireEntry = (familyDefinitionHash: Hash, familyId?: string): FamilyRuntimeCompositionEntryV1 => {
    const entry = resolve(familyDefinitionHash, familyId);
    if (!entry) throw new TypeError("Family runtime composition entry is not release-qualified");
    return entry;
  };

  return Object.freeze({
    definitionCatalogRoot,
    compositionRoot: compositionRoot(definitionCatalogRoot, entries),
    entries: Object.freeze(entries),
    resolve,
    require: requireEntry,
    openRehydrationSession(familyDefinitionHashInput: Hash): FamilyRehydrationSessionV1 {
      const entry = requireEntry(familyDefinitionHashInput);
      const session = Object.freeze(Object.create(null)) as FamilyRehydrationSessionV1;
      sessions.set(session, { familyDefinitionHash: entry.familyDefinitionHash });
      return session;
    },
    rehydrateRouteHandle(
      session: FamilyRehydrationSessionV1,
      publication: FamilyRoutePublicationV1,
      projection: FamilyRouteProjectionV1,
      ref: FamilyRouteRehydrationRefV1,
    ): FamilyIssuedRouteHandleV1 {
      requireActive();
      if (session === null || typeof session !== "object") throw new TypeError("rehydration session is opaque");
      const state = sessions.get(session);
      if (!state) throw new TypeError("rehydration session was not issued by this composition");
      const entry = requireEntry(state.familyDefinitionHash);
      if (
        publication.familyDefinitionHash !== entry.familyDefinitionHash
        || ref.familyDefinitionHash !== entry.familyDefinitionHash
        || publication.familyId !== entry.familyId
      ) throw new TypeError("rehydration family binding mismatch");
      return entry.owner.routeHandles.issueRouteHandle(publication, projection, ref);
    },
    resolveRouteHandle(handle: FamilyIssuedRouteHandleV1, familyDefinitionHashInput: Hash): FamilyRouteHandleBindingV1 {
      const entry = requireEntry(familyDefinitionHashInput);
      entry.owner.routeHandles.assertRouteHandleActive(handle);
      return entry.owner.routeHandles.resolveRouteHandle(handle);
    },
    resolveCapability(): object {
      throw new TypeError("Family capability ports require generated runtime composition");
    },
    resolveActionOwner(): object {
      throw new TypeError("Family action owner ports require generated runtime composition");
    },
    resolveAdapter(): FamilySearchAdapterV1 {
      throw new TypeError("Family runtime adapters require generated runtime composition");
    },
    requireAdapter(): FamilySearchAdapterV1 {
      throw new TypeError("Family runtime adapters require generated runtime composition");
    },
    resolveCoarseProjection(): FamilyRuntimeCoarseProjectionSeamV1 | null {
      return null;
    },
    async issueCoarseProjection(): Promise<CoarseProjectionCapabilityV1> {
      throw new TypeError("Family coarse projection producer requires generated runtime composition");
    },
    async issueCoarseEdgeSweepProjection(): Promise<CoarseProjectionCapabilityV1> {
      throw new TypeError("Family coarse edge sweep producer requires generated runtime composition");
    },
    readCoarseProjectionObservation(): FamilyRuntimeCoarseProjectionObservationV1 {
      throw new TypeError("Family coarse projection observations require generated runtime composition");
    },
    readCoarseEdgeSweepObservation(): FamilyRuntimeCoarseEdgeSweepObservationV1 {
      throw new TypeError("Family coarse edge sweep observations require generated runtime composition");
    },
    revoke(): void {
      if (!active) return;
      active = false;
      for (const entry of entries) entry.owner.revoke();
    },
  });
}

export type { FamilyRuntimePortV1, FamilyStageRuntimePortV1 };

// The generated runtime module is the only production composition entry. The
// assembly helper remains internal; only its branded factory assertion and
// opaque capability type are visible to the app boundary.
export {
  assertGeneratedFamilyRuntimeFactory,
} from "./internal/generated-runtime-composition.ts";
export type {
  GeneratedFamilyRuntimeAuthorityCapabilityV1,
  GeneratedFamilyRuntimeFactoryV1,
} from "./internal/generated-runtime-composition.ts";
