import {
  assertGeneratedFamilyRuntimeComposition,
  createGeneratedFamilyRuntimeComposition,
  familyCoarseRouteOwnerRefV1,
  generatedFamilyCoarseProjectionDescriptorV1,
  validateGeneratedFamilyRuntimeDescriptorV1,
  type FamilyRuntimeCompositionV1,
  type FamilyRehydrationSessionV1,
  type FamilyRuntimeCoarseProjectionRequestV1,
  type GeneratedFamilyRuntimeActionOwnerV1,
  type GeneratedFamilyRuntimeAuthorityBindingV1,
  type GeneratedFamilyRuntimeDescriptorV1,
  type GeneratedFamilyRuntimeAdapterImportV1,
} from "../index.ts";
import {
  FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1,
  assertFamilySourcePlanNominationProgram,
  assertFamilySourcePlanRuntime,
  type FamilyPhysicalLifecycleExecutionV1,
  type FamilyPhysicalLifecycleAdapterFactoryV1,
  type FamilyPhysicalLifecycleAdapterV1,
  type FamilyPhysicalLifecyclePortsV1,
  type FamilyPhysicalTransportResultV1,
  type FamilyIssuedRouteHandleV1,
  type FamilyRouteHandleBindingV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanRuntimeV1,
  type FamilyStageDefinitionV1,
  type FamilyStageRuntimePortV1,
} from "../../../family-sdk/runtime/index.ts";
import {
  assertStageCapabilityRef,
  type StageCapabilityRefV1,
} from "../../../family-sdk/runtime-refs/index.ts";
import {
  assertHash,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { SourcePlanRefV1 } from "../../../discovery/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  decodeSignedReleaseRuntimeAuthorityDescriptorV1,
  decodeUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityProjectionV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import type {
  FamilySearchAdapterFactoryV1,
  FamilySearchAdapterV1,
  FamilySearchCompositionResolverV1,
} from "../../../family-sdk/search-runtime/index.ts";
import {
  familySearchAmount,
  familySearchExecutionContext,
  familySearchObjective,
  familySearchRouteBindingHash,
  familySearchSource,
} from "../../../family-sdk/search-runtime/index.ts";
import {
  readIssuedCoarseRouteBindingV1,
  readQualifiedCoarseProjectionReceiptV1,
  readQualifiedCoarseProjectionV1,
  type CoarseEdgeProjectionV1,
  type IssuedCoarseRouteBindingV1,
  type QualifiedCoarseProjectionV1,
} from "../../../coarse-economics/src/index.ts";

/**
 * A release-owned Family runtime capability is intentionally opaque.  The
 * candidate tree has no minting path for this value while the release
 * authority is unqualified; a generated composition therefore cannot be
 * opened with a hand-written array of authority bindings.
 *
 * The non-exported symbol is a type-level extra guard.  Runtime validation is
 * performed by the owner registry below, rather than by checking object
 * shape or a caller supplied root.
 */
declare const generatedFamilyRuntimeAuthorityCapabilityBrand: unique symbol;
export interface GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  readonly [generatedFamilyRuntimeAuthorityCapabilityBrand]: never;
}

export interface GeneratedFamilyRuntimeAssemblyV1 {
  readonly descriptor: GeneratedFamilyRuntimeDescriptorV1;
  readonly definitions: readonly (readonly FamilyStageDefinitionV1[])[];
  readonly extensions: readonly (readonly object[])[];
  readonly actionOwners: readonly (readonly object[])[];
  readonly runtimeAdapters: readonly (readonly (object | GeneratedFamilyRuntimeAdapterImportV1)[])[];
  /** Exact named source-plan imports emitted beside the descriptor. */
  readonly sourcePlans: readonly (readonly FamilySourcePlanRuntimeV1[])[];
  /** Exact named nomination-program imports; qualification code is never imported here. */
  readonly nominationPrograms: readonly (readonly FamilySourcePlanNominationProgramV1[])[];
}

export type GeneratedFamilyRuntimeFactoryV1 = (
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
) => FamilyRuntimeCompositionV1;

/**
 * Internal release-owner metadata for one generated factory.  It is kept in
 * a WeakMap keyed by the branded factory, never on the public function
 * object, so an application cannot replace a root by copying fields.  The
 * final runtime release must exact-join `proposedCapabilitySetRoot` to its
 * signed binding; these values are descriptors only and grant no authority.
 */
export interface GeneratedFamilyRuntimeFactoryMetadataV1 {
  readonly proposedCapabilitySetRoot: Hash;
  readonly nominationProgramSetRoot: Hash;
  readonly nominationProgramProposalLeafDigests: readonly Hash[];
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly descriptorRoot: Hash;
  readonly families: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly lifecycleRefs: GeneratedFamilyRuntimeDescriptorV1["families"][number]["entry"]["lifecycleRefs"];
    readonly stageDefinitionRoot: Hash;
    readonly sourcePlanRoot: Hash;
    readonly sourcePlanRefs: readonly SourcePlanRefV1[];
    readonly extensions: GeneratedFamilyRuntimeDescriptorV1["families"][number]["extensions"];
    readonly runtimeAdapters: GeneratedFamilyRuntimeDescriptorV1["families"][number]["runtimeAdapters"];
    readonly actionOwners: GeneratedFamilyRuntimeDescriptorV1["families"][number]["actionOwners"];
  }>[];
}

/*
 * This registry is deliberately empty in the candidate repository.  The
 * external release boundary is the only place allowed to add an issued
 * capability.  Keeping the read path here means generated output never has
 * to accept descriptor/definition/adapter data from its consumer.
 */
interface GeneratedFamilyRuntimeAuthorityStateV1 {
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runtimeMembershipHash: Hash;
  readonly releaseProvenanceHash?: Hash;
  readonly authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[];
  readonly nominationQualifications?: ReadonlyMap<Hash, Hash>;
  readonly assertCurrent: () => void;
}

export interface GeneratedFamilyUnsignedDryRunAuthorityRegistrationV1 {
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly runtimeAuthority: UnsignedDryRunRuntimeAuthorityDescriptorV1;
  /** Exact generated proposal root. This is declared membership, not qualification. */
  readonly declaredCapabilitySetRoot: Hash;
  readonly nominationProgramSetRoot: Hash;
  readonly authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[];
  readonly assertCurrent: () => void;
}

/**
 * This is an owner-only hand-off from runtime-release-authority.  The
 * generated Family module never accepts a descriptor, authority array, or
 * caller supplied release root from the application.  The owner has already
 * joined those facts to the externally signed runtime binding before calling
 * this function; the callback keeps the capability fenced after rotation or
 * revoke.
 */
export interface GeneratedFamilyRuntimeAuthorityRegistrationV1 {
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly runtimeAuthority: SignedReleaseRuntimeAuthorityDescriptorV1;
  /** Root carried by the signed runtime binding and exact-joined to the generated descriptor. */
  readonly qualifiedCapabilityRefsRoot: Hash;
  readonly nominationProgramSetRoot: Hash;
  readonly nominationQualifications: readonly Readonly<{
    readonly proposalLeafDigest: Hash;
    readonly qualificationLeafDigest: Hash;
  }>[];
  readonly authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[];
  readonly assertCurrent: () => void;
}

const issuedAuthorities = new WeakMap<object, GeneratedFamilyRuntimeAuthorityStateV1>();
const generatedFactories = new WeakSet<object>();
const generatedFactoryMetadata = new WeakMap<object, GeneratedFamilyRuntimeFactoryMetadataV1>();
interface GeneratedFamilyPhysicalLifecycleFactoryBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly lifecycleRefs: GeneratedFamilyRuntimeDescriptorV1["families"][number]["entry"]["lifecycleRefs"];
  readonly factory: FamilyPhysicalLifecycleAdapterFactoryV1;
}

export interface GeneratedFamilyRuntimeAdapterFactoryBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly descriptor: GeneratedFamilyRuntimeDescriptorV1["families"][number]["runtimeAdapters"][number];
  readonly actualFactory: GeneratedFamilyRuntimeAdapterImportV1["factory"];
}

export interface GeneratedFamilyPhysicalLifecycleBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly lifecycleRefs: GeneratedFamilyRuntimeDescriptorV1["families"][number]["entry"]["lifecycleRefs"];
  readonly adapter: FamilyPhysicalLifecycleAdapterV1;
}

export interface GeneratedFamilyPhysicalLifecycleRouteV1 {
  readonly stageRef: StageCapabilityRefV1;
  readonly execution: FamilyPhysicalLifecycleExecutionV1;
}

const generatedFactoryPhysicalAdapters = new WeakMap<
  object,
  readonly Readonly<GeneratedFamilyPhysicalLifecycleFactoryBindingV1>[]
>();
const generatedFactoryRuntimeAdapters = new WeakMap<
  object,
  readonly Readonly<GeneratedFamilyRuntimeAdapterFactoryBindingV1>[]
>();
const generatedFactorySourcePlans = new WeakMap<object, readonly Readonly<{
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRef: SourcePlanRefV1;
  readonly sourcePlanLeafDigest: Hash;
  readonly sourcePlanSchemaHash: Hash;
  readonly sourcePlanClosureRoot: Hash;
  readonly runtime: FamilySourcePlanRuntimeV1;
  readonly nominationProgram: FamilySourcePlanNominationProgramV1;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
}>[]>();
interface GeneratedFamilySearchAssemblyStateV1 {
  readonly descriptor: GeneratedFamilyRuntimeDescriptorV1;
  readonly extensions: readonly (readonly object[])[];
  readonly actionOwners: readonly (readonly object[])[];
}
const generatedFactorySearchAssemblies = new WeakMap<object, GeneratedFamilySearchAssemblyStateV1>();

export function assertGeneratedFamilyRuntimeFactory(
  value: unknown,
): asserts value is GeneratedFamilyRuntimeFactoryV1 {
  if (typeof value !== "function" || !generatedFactories.has(value)) {
    throw new TypeError("Family runtime factory is not generated and release-authenticated");
  }
}

/** Read-only owner edge; callers cannot mint or alter the metadata. */
export function readGeneratedFamilyRuntimeFactoryMetadata(
  value: unknown,
): GeneratedFamilyRuntimeFactoryMetadataV1 {
  assertGeneratedFamilyRuntimeFactory(value);
  const metadata = generatedFactoryMetadata.get(value);
  if (metadata === undefined) throw new TypeError("generated Family runtime factory metadata is unavailable");
  return metadata;
}

/** Read-only exact named-import identities closed over by generated output. */
export function readGeneratedFamilyRuntimeAdapterFactories(
  value: unknown,
): readonly Readonly<GeneratedFamilyRuntimeAdapterFactoryBindingV1>[] {
  assertGeneratedFamilyRuntimeFactory(value);
  const bindings = generatedFactoryRuntimeAdapters.get(value);
  if (bindings === undefined) throw new TypeError("generated Family runtime adapter factories are unavailable");
  return bindings;
}

/** Exact generated physical denominator.  It is read only by the deployment
 * runtime owner, which supplies the neutral RPC transport and stamps the
 * returned source-less facts with scheduler/release authority. */
export function readGeneratedFamilyPhysicalLifecycleAdapters(
  value: unknown,
): readonly Readonly<GeneratedFamilyPhysicalLifecycleBindingV1>[] {
  assertGeneratedFamilyRuntimeFactory(value);
  const metadata = generatedFactoryMetadata.get(value)!;
  const bindings = generatedFactoryPhysicalAdapters.get(value);
  if (bindings === undefined
    || bindings.length !== metadata.families.length
    || new Set(bindings.map(binding => binding.familyDefinitionHash)).size !== metadata.families.length) {
    throw new TypeError("generated Family physical lifecycle denominator is incomplete");
  }
  return Object.freeze(bindings.map(binding => {
    const adapter = binding.factory();
    if (adapter === null || typeof adapter !== "object"
      || adapter.kind !== "aloha.family-physical-lifecycle-adapter"
      || adapter.version !== 1
      || adapter.familyId !== binding.familyId
      || adapter.familyDefinitionHash !== binding.familyDefinitionHash
      || typeof adapter.execute !== "function") {
      throw new TypeError(`generated Family physical lifecycle adapter is invalid ${binding.familyId}`);
    }
    return Object.freeze({
      familyId: binding.familyId,
      familyDefinitionHash: binding.familyDefinitionHash,
      lifecycleRefs: Object.freeze({ ...binding.lifecycleRefs }),
      adapter,
    });
  }));
}

function sameStageRef(left: StageCapabilityRefV1, right: StageCapabilityRefV1): boolean {
  return left.familyId === right.familyId
    && left.familyDefinitionHash === right.familyDefinitionHash
    && left.stage === right.stage
    && left.capabilityId === right.capabilityId
    && left.version === right.version
    && left.schemaHash === right.schemaHash
    && left.interpreterHash === right.interpreterHash
    && left.ownerRef === right.ownerRef;
}

/** Execute exactly one generated physical adapter.  Routing is derived from
 * the exact generated lifecycle ref; zero or multiple matches fail closed and
 * non-nominated Families are never invoked or awaited. */
export async function executeGeneratedFamilyPhysicalLifecycle(
  factory: GeneratedFamilyRuntimeFactoryV1,
  route: GeneratedFamilyPhysicalLifecycleRouteV1,
  ports: FamilyPhysicalLifecyclePortsV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  assertStageCapabilityRef(route.stageRef, "generatedPhysical.stageRef");
  const execution = route.execution;
  const matches = readGeneratedFamilyPhysicalLifecycleAdapters(factory).filter(binding =>
    binding.familyId === execution.familyId
    && binding.familyDefinitionHash === execution.familyDefinitionHash,
  );
  if (matches.length !== 1) {
    throw new TypeError("generated Family physical lifecycle route is not unique");
  }
  const binding = matches[0]!;
  const expected = binding.lifecycleRefs[execution.stage];
  if (!sameStageRef(route.stageRef, expected)
    || route.stageRef.familyId !== execution.familyId
    || route.stageRef.familyDefinitionHash !== execution.familyDefinitionHash
    || route.stageRef.stage !== execution.stage) {
    throw new TypeError("generated Family physical lifecycle ref mismatch");
  }
  return binding.adapter.execute(execution, ports, signal);
}

/**
 * Owner-only runtime read. A source-plan callback is available only after the
 * same generated factory and opaque release capability have been joined.
 */
export function readGeneratedFamilySourcePlanRuntimes(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): readonly Readonly<{
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRef: SourcePlanRefV1;
  readonly sourcePlanLeafDigest: Hash;
  readonly sourcePlanSchemaHash: Hash;
  readonly sourcePlanClosureRoot: Hash;
  readonly runtime: FamilySourcePlanRuntimeV1;
  readonly nominationProgram: FamilySourcePlanNominationProgramV1;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
  readonly nominationQualificationLeafDigest: Hash;
}>[] {
  const authority = authorityStateFor(factory, capability);
  if (authority.runtimeAuthority.authorityClass !== "signed-release") {
    throw new TypeError("generated Family nomination qualification is unavailable in unsigned dry-run");
  }
  const plans = generatedFactorySourcePlans.get(factory);
  if (plans === undefined) throw new TypeError("generated Family source plan runtime is unavailable");
  return Object.freeze(plans.map(plan => {
    const nominationQualificationLeafDigest = authority.nominationQualifications?.get(plan.nominationProgramProposalLeafDigest);
    if (nominationQualificationLeafDigest === undefined) throw new TypeError("generated Family nomination qualification is unavailable");
    return Object.freeze({ ...plan, nominationQualificationLeafDigest });
  }));
}

/** Exact generated source-plan/program declarations. Unlike the signed read,
 * this carries no qualification leaf and is valid for both authority modes. */
export function readGeneratedFamilySourcePlanDeclarations(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): readonly Readonly<{
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRef: SourcePlanRefV1;
  readonly sourcePlanLeafDigest: Hash;
  readonly sourcePlanSchemaHash: Hash;
  readonly sourcePlanClosureRoot: Hash;
  readonly runtime: FamilySourcePlanRuntimeV1;
  readonly nominationProgram: FamilySourcePlanNominationProgramV1;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
}>[] {
  authorityStateFor(factory, capability);
  const plans = generatedFactorySourcePlans.get(factory);
  if (plans === undefined) throw new TypeError("generated Family source plan declarations are unavailable");
  return Object.freeze(plans.map(plan => Object.freeze({ ...plan })));
}

export function readGeneratedFamilyRuntimeMembership(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): Readonly<{
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runtimeMembershipHash: Hash;
  readonly releaseProvenanceHash?: Hash;
}> {
  const authority = authorityStateFor(factory, capability);
  return Object.freeze({
    runtimeAuthority: authority.runtimeAuthority,
    runtimeMembershipHash: authority.runtimeMembershipHash,
    ...(authority.releaseProvenanceHash === undefined ? {} : { releaseProvenanceHash: authority.releaseProvenanceHash }),
  });
}

function authorityStateFor(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): GeneratedFamilyRuntimeAuthorityStateV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("Family runtime production authority is unavailable");
  const state = issuedAuthorities.get(capability);
  if (state === undefined) throw new TypeError("Family runtime production authority is unavailable");
  if (generatedFactoryMetadata.get(factory) === undefined || state.factory !== factory) {
    throw new TypeError("Family runtime production authority is bound to another generated factory");
  }
  state.assertCurrent();
  return state;
}

function authoritiesFor(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): readonly GeneratedFamilyRuntimeAuthorityBindingV1[] {
  const state = authorityStateFor(factory, capability);
  return state.authorities;
}

function unsignedRuntimeMembershipHash(
  metadata: GeneratedFamilyRuntimeFactoryMetadataV1,
  runtimeAuthority: RuntimeAuthorityProjectionV1,
): Hash {
  return hashDomain("aloha/generated-family-runtime-unsigned-membership/v1", {
    runtimeAuthority,
    proposedCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
    nominationProgramSetRoot: metadata.nominationProgramSetRoot,
    releaseIntentRoot: metadata.releaseIntentRoot,
    definitionCatalogRoot: metadata.definitionCatalogRoot,
    descriptorRoot: metadata.descriptorRoot,
    families: metadata.families.map(family => ({
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      stageDefinitionRoot: family.stageDefinitionRoot,
      sourcePlanRoot: family.sourcePlanRoot,
      runtimeAdapters: family.runtimeAdapters.map(adapter => adapter.leafDigest),
    })),
  });
}

function snapshotAuthorities(
  value: readonly GeneratedFamilyRuntimeAuthorityBindingV1[],
): readonly GeneratedFamilyRuntimeAuthorityBindingV1[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Family runtime production authority is unavailable");
  }
  const authorities = value.map((authority, index) => {
    if (authority === null || typeof authority !== "object") {
      throw new TypeError(`generated Family authority ${index} is invalid`);
    }
    if (authority.binding === null || typeof authority.binding !== "object") {
      throw new TypeError(`generated Family authority ${index}.binding is invalid`);
    }
    if (!Array.isArray(authority.executors) || authority.executors.length !== 5) {
      throw new TypeError(`generated Family authority ${index}.executors is incomplete`);
    }
    return Object.freeze({
      ...authority,
      binding: Object.freeze({ ...authority.binding }),
      executors: Object.freeze(authority.executors.map((executor: GeneratedFamilyRuntimeAuthorityBindingV1["executors"][number]) => Object.freeze({ ...executor }))),
    });
  });
  return Object.freeze(authorities);
}

/**
 * Exact owner edge used by runtime-release-authority.  It is intentionally
 * kept out of the package root: application code can only consume the
 * already-issued opaque capability through the generated factory.
 */
export function issueGeneratedFamilyRuntimeAuthorityCapability(
  input: GeneratedFamilyRuntimeAuthorityRegistrationV1,
): GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("Family runtime production authority is unavailable");
  }
  assertGeneratedFamilyRuntimeFactory(input.factory);
  const metadata = generatedFactoryMetadata.get(input.factory);
  if (metadata === undefined) throw new TypeError("Family runtime factory metadata is unavailable");
  assertHash(input.qualifiedCapabilityRefsRoot, "qualifiedCapabilityRefsRoot");
  const signedAuthority = decodeSignedReleaseRuntimeAuthorityDescriptorV1(input.runtimeAuthority);
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(signedAuthority);
  if (metadata.proposedCapabilitySetRoot !== input.qualifiedCapabilityRefsRoot) {
    throw new TypeError("Family runtime factory is not bound to this release capability set");
  }
  assertHash(input.nominationProgramSetRoot, "nominationProgramSetRoot");
  if (metadata.nominationProgramSetRoot !== input.nominationProgramSetRoot) {
    throw new TypeError("Family runtime factory is not bound to this nomination program set");
  }
  if (!Array.isArray(input.nominationQualifications)) throw new TypeError("nomination qualifications are required");
  const proposalLeaves = generatedFactorySourcePlans.get(input.factory)?.map(plan => plan.nominationProgramProposalLeafDigest) ?? [];
  const nominationQualifications = new Map<Hash, Hash>();
  for (const [index, entry] of input.nominationQualifications.entries()) {
    assertHash(entry.proposalLeafDigest, `nominationQualifications[${index}].proposalLeafDigest`);
    assertHash(entry.qualificationLeafDigest, `nominationQualifications[${index}].qualificationLeafDigest`);
    if (nominationQualifications.has(entry.proposalLeafDigest)) throw new TypeError("duplicate nomination qualification proposal");
    nominationQualifications.set(entry.proposalLeafDigest, entry.qualificationLeafDigest);
  }
  if (proposalLeaves.length !== nominationQualifications.size || proposalLeaves.some(leaf => !nominationQualifications.has(leaf))) {
    throw new TypeError("nomination qualification set does not cover the generated program set");
  }
  input.assertCurrent();
  const capability = Object.freeze(Object.create(null)) as GeneratedFamilyRuntimeAuthorityCapabilityV1;
  issuedAuthorities.set(capability, Object.freeze({
    factory: input.factory,
    runtimeAuthority,
    runtimeMembershipHash: signedAuthority.releaseProvenanceHash,
    releaseProvenanceHash: signedAuthority.releaseProvenanceHash,
    authorities: snapshotAuthorities(input.authorities),
    nominationQualifications,
    assertCurrent: input.assertCurrent,
  }));
  return capability;
}


/** Owner-only unsigned dry-run hand-off. The capability is bound to the exact
 * generated declaration and program roots, but contains no qualification
 * leaves, release approval, or signature claim. */
export function issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability(
  input: GeneratedFamilyUnsignedDryRunAuthorityRegistrationV1,
): GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("Family unsigned dry-run authority is unavailable");
  }
  assertGeneratedFamilyRuntimeFactory(input.factory);
  const metadata = generatedFactoryMetadata.get(input.factory);
  if (metadata === undefined) throw new TypeError("Family runtime factory metadata is unavailable");
  assertHash(input.declaredCapabilitySetRoot, "declaredCapabilitySetRoot");
  if (metadata.proposedCapabilitySetRoot !== input.declaredCapabilitySetRoot) {
    throw new TypeError("Family runtime factory is not bound to this declared capability set");
  }
  assertHash(input.nominationProgramSetRoot, "nominationProgramSetRoot");
  if (metadata.nominationProgramSetRoot !== input.nominationProgramSetRoot) {
    throw new TypeError("Family runtime factory is not bound to this nomination program set");
  }
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
    decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(input.runtimeAuthority),
  );
  input.assertCurrent();
  const capability = Object.freeze(Object.create(null)) as GeneratedFamilyRuntimeAuthorityCapabilityV1;
  issuedAuthorities.set(capability, Object.freeze({
    factory: input.factory,
    runtimeAuthority,
    runtimeMembershipHash: unsignedRuntimeMembershipHash(metadata, runtimeAuthority),
    authorities: snapshotAuthorities(input.authorities),
    assertCurrent: input.assertCurrent,
  }));
  return capability;
}

const GENERATED_LIFECYCLE_STAGES = Object.freeze([
  "nomination",
  "identity",
  "materialization",
  "projection",
  "rehydration",
] as const);

/** Opaque generated lifecycle seam.  Attestation receives this value rather
 * than a structural FamilyRuntimeCompositionV1. */
export type GeneratedFamilyLifecycleRuntimePortV1 = object;

interface GeneratedFamilyLifecycleRuntimePortStateV1 {
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly capability: GeneratedFamilyRuntimeAuthorityCapabilityV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly composition: FamilyRuntimeCompositionV1;
}

const issuedLifecycleRuntimePorts = new WeakMap<object, GeneratedFamilyLifecycleRuntimePortStateV1>();

/**
 * Issue the one mode-bound lifecycle/program port accepted by Attestation.
 */
export function issueGeneratedFamilyLifecycleRuntimePort(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
): GeneratedFamilyLifecycleRuntimePortV1 {
  const authority = authorityStateFor(factory, capability);
  const composition = factory(capability);
  const port = Object.freeze(Object.create(null));
  issuedLifecycleRuntimePorts.set(port, Object.freeze({
    factory,
    capability,
    runtimeAuthority: authority.runtimeAuthority,
    composition,
  }));
  return port;
}

function requireLifecycleRuntimePortState(
  value: unknown,
  expectedAuthority?: RuntimeAuthorityProjectionV1,
): GeneratedFamilyLifecycleRuntimePortStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Family lifecycle runtime port is not owner-issued");
  }
  const state = issuedLifecycleRuntimePorts.get(value);
  if (state === undefined) throw new TypeError("Family lifecycle runtime port is not owner-issued");
  const authority = authorityStateFor(state.factory, state.capability);
  if (!sameRuntimeAuthorityProjection(authority.runtimeAuthority, state.runtimeAuthority)) {
    throw new TypeError("Family lifecycle runtime authority changed");
  }
  if (expectedAuthority !== undefined) {
    const expected = decodeRuntimeAuthorityProjectionV1(expectedAuthority);
    if (!sameRuntimeAuthorityProjection(state.runtimeAuthority, expected)) {
      throw new TypeError("Family lifecycle runtime class or binding mismatch");
    }
  }
  return state;
}

export function readGeneratedFamilyLifecycleRuntimePort(
  value: GeneratedFamilyLifecycleRuntimePortV1,
  expectedAuthority?: RuntimeAuthorityProjectionV1,
): Readonly<{
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly requireStage: (
    familyDefinitionHash: Hash,
    familyId: string,
    stage: (typeof GENERATED_LIFECYCLE_STAGES)[number],
  ) => FamilyStageRuntimePortV1;
}> {
  const state = requireLifecycleRuntimePortState(value, expectedAuthority);
  return Object.freeze({
    runtimeAuthority: state.runtimeAuthority,
    requireStage(familyDefinitionHashInput, familyId, stage) {
      requireLifecycleRuntimePortState(value, state.runtimeAuthority);
      const familyDefinitionHash = assertHash(familyDefinitionHashInput, "familyDefinitionHash");
      if (typeof familyId !== "string" || familyId.length === 0) {
        throw new TypeError("Family lifecycle familyId is required");
      }
      if (!GENERATED_LIFECYCLE_STAGES.includes(stage)) {
        throw new TypeError("Family lifecycle stage is invalid");
      }
      const metadata = generatedFactoryMetadata.get(state.factory);
      const family = metadata?.families.find(candidate =>
        candidate.familyDefinitionHash === familyDefinitionHash && candidate.familyId === familyId,
      );
      if (family === undefined) throw new TypeError("Family lifecycle definition is not generated");
      const expectedRef = family.lifecycleRefs[stage];
      const binding = state.composition.require(familyDefinitionHash, familyId);
      const resolved = binding.owner.port.getStage(expectedRef);
      if (!sameStageRef(resolved.stageRef, expectedRef)) {
        throw new TypeError("Family lifecycle stage substitution detected");
      }
      return resolved;
    },
  });
}

/** Opaque generated search seam bound to one exact runtime authority. */
export type GeneratedFamilySearchRuntimePortV1 = object;

interface GeneratedFamilySearchRuntimePortStateV1 {
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly capability: GeneratedFamilyRuntimeAuthorityCapabilityV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly routeComposition: FamilyRuntimeCompositionV1;
  readonly rehydrationSessions: Map<Hash, FamilyRehydrationSessionV1>;
  readonly adapters: Map<string, FamilySearchAdapterV1>;
  readonly coarseEvidence: WeakMap<object, Readonly<{
    readonly projection: CoarseEdgeProjectionV1;
    readonly qualified: QualifiedCoarseProjectionV1;
    readonly observation: CanonicalJson;
  }>>;
}

const issuedSearchRuntimePorts = new WeakMap<object, GeneratedFamilySearchRuntimePortStateV1>();

function sameRuntimeAuthorityProjection(
  left: RuntimeAuthorityProjectionV1,
  right: RuntimeAuthorityProjectionV1,
): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

export function issueGeneratedFamilySearchRuntimePort(
  factory: GeneratedFamilyRuntimeFactoryV1,
  capability: GeneratedFamilyRuntimeAuthorityCapabilityV1,
  lifecyclePort?: GeneratedFamilyLifecycleRuntimePortV1,
): GeneratedFamilySearchRuntimePortV1 {
  const authority = authorityStateFor(factory, capability);
  let routeComposition = factory(capability);
  if (lifecyclePort !== undefined) {
    const lifecycle = requireLifecycleRuntimePortState(lifecyclePort, authority.runtimeAuthority);
    if (lifecycle.factory !== factory || lifecycle.capability !== capability) {
      throw new TypeError("Family search/lifecycle runtime binding mismatch");
    }
    routeComposition = lifecycle.composition;
  }
  const port = Object.freeze(Object.create(null));
  issuedSearchRuntimePorts.set(port, {
    factory,
    capability,
    runtimeAuthority: authority.runtimeAuthority,
    routeComposition,
    rehydrationSessions: new Map(),
    adapters: new Map(),
    coarseEvidence: new WeakMap(),
  });
  return port;
}

function requireSearchRuntimePortState(
  value: unknown,
  expectedAuthority?: RuntimeAuthorityProjectionV1,
): GeneratedFamilySearchRuntimePortStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Family search runtime port is not owner-issued");
  }
  const state = issuedSearchRuntimePorts.get(value);
  if (state === undefined) throw new TypeError("Family search runtime port is not owner-issued");
  const authority = authorityStateFor(state.factory, state.capability);
  if (!sameRuntimeAuthorityProjection(authority.runtimeAuthority, state.runtimeAuthority)) {
    throw new TypeError("Family search runtime authority changed");
  }
  if (expectedAuthority !== undefined) {
    const expected = decodeRuntimeAuthorityProjectionV1(expectedAuthority);
    if (!sameRuntimeAuthorityProjection(state.runtimeAuthority, expected)) {
      throw new TypeError("Family search runtime class or binding mismatch");
    }
  }
  return state;
}

function requireGeneratedSearchAdapter(
  state: GeneratedFamilySearchRuntimePortStateV1,
  familyDefinitionHashInput: Hash,
  roleInput: string,
): FamilySearchAdapterV1 {
  const familyDefinitionHash = assertHash(familyDefinitionHashInput, "familyDefinitionHash");
  if (typeof roleInput !== "string" || !roleInput.startsWith("search/")) {
    throw new TypeError("Family search runtime adapter role is not supported");
  }
  const role = roleInput;
  const key = `${familyDefinitionHash}\u0000${role}`;
  const cached = state.adapters.get(key);
  if (cached !== undefined) return cached;
  const assembly = generatedFactorySearchAssemblies.get(state.factory);
  if (assembly === undefined) throw new TypeError("generated Family search assembly is unavailable");
  const familyIndex = assembly.descriptor.families.findIndex(
    family => family.entry.familyDefinitionHash === familyDefinitionHash,
  );
  const family = assembly.descriptor.families[familyIndex];
  if (family === undefined) throw new TypeError("Family search runtime definition is not generated");
  const descriptor = family.runtimeAdapters.find(adapter => adapter.role === role);
  if (descriptor === undefined) throw new TypeError("Family search runtime adapter role is not generated");
  const binding = generatedFactoryRuntimeAdapters.get(state.factory)?.find(candidate =>
    candidate.familyDefinitionHash === familyDefinitionHash && candidate.descriptor.role === role,
  );
  if (binding === undefined || typeof binding.actualFactory !== "function") {
    throw new TypeError("Family search runtime adapter factory is unavailable");
  }
  const extensions = assembly.extensions[familyIndex];
  const actionOwners = assembly.actionOwners[familyIndex];
  if (!Array.isArray(extensions) || extensions.length !== family.extensions.length
    || !Array.isArray(actionOwners) || actionOwners.length !== family.actionOwners.length) {
    throw new TypeError("generated Family search resolver imports are incomplete");
  }
  const resolver: FamilySearchCompositionResolverV1 = Object.freeze({
    resolveCapability(definitionHash: Hash, capabilityRef: StageCapabilityRefV1): object {
      if (definitionHash !== familyDefinitionHash || capabilityRef.familyDefinitionHash !== familyDefinitionHash) {
        throw new TypeError("Family search capability binding mismatch");
      }
      const index = family.extensions.findIndex(extension =>
        encodeCanonicalJson(extension.capabilityRef) === encodeCanonicalJson(capabilityRef),
      );
      const port = index < 0 ? undefined : extensions[index];
      if (port === null || (typeof port !== "object" && typeof port !== "function")) {
        throw new TypeError("Family search capability is not generated");
      }
      return port as object;
    },
    resolveActionOwner(definitionHash: Hash, ownerRef: Hash): object {
      if (definitionHash !== familyDefinitionHash) throw new TypeError("Family search action owner binding mismatch");
      const index = family.actionOwners.findIndex(action => action.ownerRef === ownerRef);
      const port = index < 0 ? undefined : actionOwners[index];
      if (port === null || (typeof port !== "object" && typeof port !== "function")) {
        throw new TypeError("Family search action owner is not generated");
      }
      return port as object;
    },
  });
  const adapter = (binding.actualFactory as FamilySearchAdapterFactoryV1)({
    composition: resolver,
    familyDefinitionHash,
    capabilityRefs: descriptor.capabilityRefs,
    actionOwnerRefs: descriptor.actionOwnerRefs,
  });
  if (adapter === null || typeof adapter !== "object") {
    throw new TypeError("Family search runtime adapter factory returned an invalid adapter");
  }
  for (const method of ["readState", "projectCoarse", "evaluateExact", "buildAction", "run"] as const) {
    if (typeof adapter[method] !== "function") throw new TypeError("Family search runtime adapter is incomplete");
  }
  state.adapters.set(key, adapter);
  return adapter;
}

/** Opaque result of one Family projection. The caller can only read it back
 * through the exact generated search port that issued it. */
export type GeneratedFamilyCoarseEvidenceCapabilityV1 = object;

async function issueGeneratedSearchCoarseEvidence(
  port: GeneratedFamilySearchRuntimePortV1,
  state: GeneratedFamilySearchRuntimePortStateV1,
  request: FamilyRuntimeCoarseProjectionRequestV1 & Readonly<{ readonly familyDefinitionHash: Hash }>,
): Promise<GeneratedFamilyCoarseEvidenceCapabilityV1> {
  requireSearchRuntimePortState(port, state.runtimeAuthority);
  const binding = readIssuedCoarseRouteBindingV1(request.binding);
  if (!sameRuntimeAuthorityProjection(binding.runtimeAuthority, state.runtimeAuthority)) {
    throw new TypeError("Family coarse runtime authority binding mismatch");
  }
  if (!Number.isInteger(request.legIndex) || request.legIndex < 0 || request.legIndex >= binding.legs.length) {
    throw new TypeError("Family coarse leg index is invalid");
  }
  const leg = binding.legs[request.legIndex]!;
  const assembly = generatedFactorySearchAssemblies.get(state.factory);
  const familyDefinitionHash = assertHash(request.familyDefinitionHash, "generatedSearchCoarse.familyDefinitionHash");
  const route = state.routeComposition.resolveRouteHandle(
    request.issuedHandle,
    familyDefinitionHash,
  );
  const descriptorFamily = assembly?.descriptor.families.find(candidate =>
    candidate.entry.familyDefinitionHash === route.familyDefinitionHash,
  );
  if (descriptorFamily === undefined || route.familyId !== descriptorFamily.entry.familyId) {
    throw new TypeError("Family coarse route handle is not generated");
  }
  const descriptor = generatedFamilyCoarseProjectionDescriptorV1(descriptorFamily);
  if (descriptor === null) throw new TypeError("Family coarse capability is not generated");
  const routeBindingHash = familySearchRouteBindingHash(route);
  if (!binding.ownerRefs.includes(familyCoarseRouteOwnerRefV1(descriptor.familyDefinitionHash, routeBindingHash))) {
    throw new TypeError("Family coarse route owner mismatch");
  }
  const source = familySearchSource(request.currentSource.source, "generatedSearchCoarse.currentSource.source");
  if (source.chainId !== binding.source.chainId || source.number !== binding.source.number
    || source.hash !== binding.source.hash || source.stateRoot !== binding.source.stateRoot) {
    throw new TypeError("Family coarse current source mismatch");
  }
  const objective = familySearchObjective(request.objective);
  if (objective.objectiveRef !== binding.objectiveRef) throw new TypeError("Family coarse objective mismatch");
  const amount = familySearchAmount(request.amount);
  const execution = familySearchExecutionContext(request.execution, "generatedSearchCoarse.execution");
  if (execution.executorAddress !== amount.recipient) throw new TypeError("Family coarse executor/recipient mismatch");
  if (amount.inputAssetRef !== leg.inputAssetRef || amount.outputAssetRef !== leg.outputAssetRef) {
    throw new TypeError("Family coarse route asset mismatch");
  }
  if (request.sourceRead === null || typeof request.sourceRead !== "object" || typeof request.sourceRead.read !== "function") {
    throw new TypeError("Family coarse current-source read port is required");
  }

  const seam = state.routeComposition.resolveCoarseProjection(descriptor.familyDefinitionHash);
  if (seam === null) throw new TypeError("Family signed coarse owner is unavailable");
  const rawCapability = await state.routeComposition.issueCoarseProjection(seam.producer, request);
  const familyObservation = state.routeComposition.readCoarseProjectionObservation(seam.producer, rawCapability);
  const qualified = readQualifiedCoarseProjectionV1({ service: seam.service, capability: rawCapability });
  const receipt = readQualifiedCoarseProjectionReceiptV1(qualified);
  const projection = receipt.projection;
  const observation = familyObservation as unknown as CanonicalJson;
  const capability = Object.freeze(Object.create(null)) as GeneratedFamilyCoarseEvidenceCapabilityV1;
  state.coarseEvidence.set(capability, Object.freeze({ projection, qualified, observation }));
  return capability;
}

export function readGeneratedFamilySearchRuntimePort(
  value: unknown,
  expectedAuthority?: RuntimeAuthorityProjectionV1,
): Readonly<{
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly resolveRouteHandle: (
    handle: FamilyIssuedRouteHandleV1,
    familyDefinitionHash: Hash,
  ) => FamilyRouteHandleBindingV1;
  /** Graph-owner-only use: issue from the same generated composition later
   * used by this port to resolve the handle. No rehydration session escapes. */
  readonly issueRouteHandle: (
    publication: Parameters<FamilyRuntimeCompositionV1["rehydrateRouteHandle"]>[1],
    projection: Parameters<FamilyRuntimeCompositionV1["rehydrateRouteHandle"]>[2],
    ref: Parameters<FamilyRuntimeCompositionV1["rehydrateRouteHandle"]>[3],
  ) => FamilyIssuedRouteHandleV1;
  readonly requireAdapter: (familyDefinitionHash: Hash, role: string) => FamilySearchAdapterV1;
  readonly issueCoarseEvidence: (
    request: FamilyRuntimeCoarseProjectionRequestV1 & Readonly<{ readonly familyDefinitionHash: Hash }>,
  ) => Promise<GeneratedFamilyCoarseEvidenceCapabilityV1>;
  readonly readCoarseEvidence: (capability: GeneratedFamilyCoarseEvidenceCapabilityV1) => Readonly<{
    readonly projection: CoarseEdgeProjectionV1;
    readonly qualified: QualifiedCoarseProjectionV1;
    readonly observation: CanonicalJson;
  }>;
}> {
  const state = requireSearchRuntimePortState(value, expectedAuthority);
  return Object.freeze({
    runtimeAuthority: state.runtimeAuthority,
    resolveRouteHandle: (handle, familyDefinitionHash) => {
      requireSearchRuntimePortState(value, state.runtimeAuthority);
      return state.routeComposition.resolveRouteHandle(handle, familyDefinitionHash);
    },
    issueRouteHandle: (publication, projection, ref) => {
      requireSearchRuntimePortState(value, state.runtimeAuthority);
      let session = state.rehydrationSessions.get(publication.familyDefinitionHash);
      if (session === undefined) {
        session = state.routeComposition.openRehydrationSession(publication.familyDefinitionHash);
        state.rehydrationSessions.set(publication.familyDefinitionHash, session);
      }
      return state.routeComposition.rehydrateRouteHandle(session, publication, projection, ref);
    },
    requireAdapter: (familyDefinitionHash: Hash, role: string) => {
      requireSearchRuntimePortState(value, state.runtimeAuthority);
      return requireGeneratedSearchAdapter(state, familyDefinitionHash, role);
    },
    issueCoarseEvidence: request => issueGeneratedSearchCoarseEvidence(value as GeneratedFamilySearchRuntimePortV1, state, request),
    readCoarseEvidence: capability => {
      requireSearchRuntimePortState(value, state.runtimeAuthority);
      if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
        throw new TypeError("Family coarse evidence capability is invalid");
      }
      const result = state.coarseEvidence.get(capability);
      if (result === undefined) throw new TypeError("Family coarse evidence capability was not issued by this runtime");
      return result;
    },
  });
}

/**
 * Called only by generated runtime output.  The descriptor and all named
 * imports are closed over here; callers receive only the generated factory
 * and an opaque release capability.
 */
export function createGeneratedFamilyRuntimeFactory(
  assembly: GeneratedFamilyRuntimeAssemblyV1,
): GeneratedFamilyRuntimeFactoryV1 {
  if (assembly === null || typeof assembly !== "object") {
    throw new TypeError("generated Family runtime assembly is required");
  }
  const descriptor = validateGeneratedFamilyRuntimeDescriptorV1(assembly.descriptor);
  if (!Array.isArray(assembly.runtimeAdapters)
    || assembly.runtimeAdapters.length !== descriptor.families.length) {
    throw new TypeError("generated Family runtime adapter imports are incomplete");
  }
  if (!Array.isArray(assembly.sourcePlans) || assembly.sourcePlans.length !== descriptor.families.length) {
    throw new TypeError("generated Family source plan imports are incomplete");
  }
  const nominationProgramSets = assembly.nominationPrograms;
  if (!Array.isArray(nominationProgramSets) || nominationProgramSets.length !== descriptor.families.length) {
    throw new TypeError("generated Family nomination program imports are incomplete");
  }
  const sourcePlanBindings: Array<Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly sourcePlanRef: SourcePlanRefV1;
    readonly sourcePlanLeafDigest: Hash;
    readonly sourcePlanSchemaHash: Hash;
    readonly sourcePlanClosureRoot: Hash;
    readonly runtime: FamilySourcePlanRuntimeV1;
    readonly nominationProgram: FamilySourcePlanNominationProgramV1;
    readonly nominationProgramRoot: Hash;
    readonly nominationProgramProposalLeafDigest: Hash;
  }>> = [];
  for (const [familyIndex, family] of descriptor.families.entries()) {
    const imports = assembly.sourcePlans[familyIndex];
    const nominationPrograms = nominationProgramSets[familyIndex];
    if (!Array.isArray(imports) || imports.length !== family.sourcePlans.length) {
      throw new TypeError("generated Family source plan imports are incomplete " + family.entry.familyId);
    }
    if (!Array.isArray(nominationPrograms) || nominationPrograms.length !== family.sourcePlans.length) {
      throw new TypeError("generated Family nomination program imports are incomplete " + family.entry.familyId);
    }
    for (const [planIndex, descriptor] of family.sourcePlans.entries()) {
      const imported = imports[planIndex]!;
      const nominationProgram = nominationPrograms[planIndex]!;
      assertFamilySourcePlanRuntime(imported, "generatedFamilySourcePlan");
      assertFamilySourcePlanNominationProgram(nominationProgram, "generatedFamilySourcePlanNominationProgram");
      if (
        imported.sourcePlanId !== descriptor.sourcePlanId
        || imported.completeness !== descriptor.planRef.completeness
        || imported.historyStartBlock !== descriptor.planRef.historyStartBlock
        || imported.schemaHash !== descriptor.schemaHash
      ) throw new TypeError("generated Family source plan import identity mismatch " + family.entry.familyId + ":" + descriptor.sourcePlanId);
      if (nominationProgram.schemaHash !== descriptor.nominationProgramProposal.program.schemaHash) {
        throw new TypeError("generated Family nomination program schema mismatch " + family.entry.familyId + ":" + descriptor.sourcePlanId);
      }
      sourcePlanBindings.push(Object.freeze({
        familyId: family.entry.familyId,
        familyDefinitionHash: family.entry.familyDefinitionHash,
        sourcePlanRef: Object.freeze({ ...descriptor.planRef }),
        sourcePlanLeafDigest: descriptor.leafDigest,
        sourcePlanSchemaHash: descriptor.schemaHash,
        sourcePlanClosureRoot: descriptor.closureRoot,
        runtime: imported,
        nominationProgram,
        nominationProgramRoot: descriptor.nominationProgramProposal.nominationProgramRoot,
        nominationProgramProposalLeafDigest: descriptor.nominationProgramProposal.proposalLeafDigest,
      }));
    }
  }
  const runtimeAdapterBindings: Array<Readonly<GeneratedFamilyRuntimeAdapterFactoryBindingV1>> = [];
  const physicalBindings: Array<Readonly<GeneratedFamilyPhysicalLifecycleFactoryBindingV1>> = [];
  for (const [familyIndex, family] of descriptor.families.entries()) {
    const suppliedAdapters = assembly.runtimeAdapters[familyIndex];
    if (!Array.isArray(suppliedAdapters) || suppliedAdapters.length !== family.runtimeAdapters.length) {
      throw new TypeError(`generated Family runtime adapter imports are incomplete ${family.entry.familyId}`);
    }
    for (const [adapterIndex, descriptor] of family.runtimeAdapters.entries()) {
      const supplied = suppliedAdapters[adapterIndex];
      if (supplied === null || typeof supplied !== "object" || typeof supplied.factory !== "function") {
        throw new TypeError(`generated Family runtime adapter import descriptor is missing ${family.entry.familyId}:${descriptor.role}`);
      }
      if (supplied.modulePath !== descriptor.modulePath
        || supplied.exportName !== descriptor.exportName
        || supplied.closureRoot !== descriptor.closureRoot
        || supplied.leafDigest !== descriptor.leafDigest) {
        throw new TypeError(`generated Family runtime adapter import descriptor mismatch ${family.entry.familyId}:${descriptor.role}`);
      }
      runtimeAdapterBindings.push(Object.freeze({
        familyId: family.entry.familyId,
        familyDefinitionHash: family.entry.familyDefinitionHash,
        descriptor: Object.freeze({
          ...descriptor,
          capabilityRefs: Object.freeze(Object.fromEntries(Object.entries(descriptor.capabilityRefs)
            .map(([role, ref]) => [role, Object.freeze({ ...ref })]))),
          actionOwnerRefs: Object.freeze({ ...descriptor.actionOwnerRefs }),
        }),
        actualFactory: supplied.factory,
      }));
    }
    const descriptors = family.runtimeAdapters
      .map((descriptor, index) => Object.freeze({ descriptor, index }))
      .filter(value => value.descriptor.role === FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1);
    if (descriptors.length > 1) {
      throw new TypeError(`generated Family physical lifecycle adapter is duplicated ${family.entry.familyId}`);
    }
    if (descriptors.length === 0) continue;
    const { descriptor } = descriptors[0]!;
    if (Object.keys(descriptor.capabilityRefs).length !== 0 || Object.keys(descriptor.actionOwnerRefs).length !== 0) {
      throw new TypeError(`generated Family physical lifecycle adapter cannot receive central capabilities ${family.entry.familyId}`);
    }
    const factory = runtimeAdapterBindings.find(binding =>
      binding.familyDefinitionHash === family.entry.familyDefinitionHash
      && binding.descriptor.role === descriptor.role)?.actualFactory;
    if (typeof factory !== "function") throw new TypeError(`generated Family physical lifecycle adapter import is missing ${family.entry.familyId}`);
    physicalBindings.push(Object.freeze({
      familyId: family.entry.familyId,
      familyDefinitionHash: family.entry.familyDefinitionHash,
      lifecycleRefs: family.entry.lifecycleRefs,
      factory: factory as FamilyPhysicalLifecycleAdapterFactoryV1,
    }));
  }
  const compositions = new WeakMap<object, FamilyRuntimeCompositionV1>();
  const factory: GeneratedFamilyRuntimeFactoryV1 = (capability) => {
    const authorities = authoritiesFor(factory, capability);
    const existing = compositions.get(capability as object);
    if (existing !== undefined) return existing;
    const composition = createGeneratedFamilyRuntimeComposition({
      descriptor,
      authorities,
      definitions: assembly.definitions,
      extensions: assembly.extensions,
      actionOwners: assembly.actionOwners,
      runtimeAdapters: assembly.runtimeAdapters,
    });
    assertGeneratedFamilyRuntimeComposition(composition);
    compositions.set(capability as object, composition);
    return composition;
  };
  generatedFactories.add(factory);
  generatedFactoryRuntimeAdapters.set(factory, Object.freeze(runtimeAdapterBindings));
  generatedFactoryPhysicalAdapters.set(factory, Object.freeze(physicalBindings));
  generatedFactorySourcePlans.set(factory, Object.freeze(sourcePlanBindings));
  generatedFactorySearchAssemblies.set(factory, Object.freeze({
    descriptor,
    extensions: Object.freeze(assembly.extensions.map(ports => Object.freeze([...ports]))),
    actionOwners: Object.freeze(assembly.actionOwners.map(ports => Object.freeze([...ports]))),
  }));
  generatedFactoryMetadata.set(factory, Object.freeze({
    proposedCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: descriptor.nominationProgramSetRoot,
    nominationProgramProposalLeafDigests: Object.freeze(descriptor.families.flatMap(family =>
      family.sourcePlans.map(plan => plan.nominationProgramProposal.proposalLeafDigest)).sort()),
    releaseIntentRoot: descriptor.releaseIntentRoot,
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    descriptorRoot: descriptor.descriptorRoot,
    families: Object.freeze(descriptor.families.map(family => Object.freeze({
      familyId: family.entry.familyId,
      familyDefinitionHash: family.entry.familyDefinitionHash,
      lifecycleRefs: Object.freeze({ ...family.entry.lifecycleRefs }),
      stageDefinitionRoot: family.stageDefinitionRoot,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlanRefs: Object.freeze(family.sourcePlans.map(plan => Object.freeze({ ...plan.planRef }))),
      extensions: family.extensions,
      runtimeAdapters: family.runtimeAdapters,
      actionOwners: Object.freeze(family.actionOwners.map(owner => Object.freeze({ ...owner }))),
    }))),
  }));
  return factory;
}
