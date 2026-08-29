import {
  assertGeneratedFamilyRuntimeComposition,
  createGeneratedFamilyRuntimeComposition,
  type FamilyRuntimeCompositionV1,
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
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanRuntimeV1,
  type FamilyStageDefinitionV1,
} from "../../../family-sdk/runtime/index.ts";
import {
  assertStageCapabilityRef,
  type StageCapabilityRefV1,
} from "../../../family-sdk/runtime-refs/index.ts";
import { assertHash, type Hash } from "../../../canonical-codec/src/index.ts";
import type { SourcePlanRefV1 } from "../../../discovery/src/index.ts";

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
  readonly authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[];
  readonly nominationQualifications: ReadonlyMap<Hash, Hash>;
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
  const plans = generatedFactorySourcePlans.get(factory);
  if (plans === undefined) throw new TypeError("generated Family source plan runtime is unavailable");
  return Object.freeze(plans.map(plan => {
    const nominationQualificationLeafDigest = authority.nominationQualifications.get(plan.nominationProgramProposalLeafDigest);
    if (nominationQualificationLeafDigest === undefined) throw new TypeError("generated Family nomination qualification is unavailable");
    return Object.freeze({ ...plan, nominationQualificationLeafDigest });
  }));
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
  return authorityStateFor(factory, capability).authorities;
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
    authorities: snapshotAuthorities(input.authorities),
    nominationQualifications,
    assertCurrent: input.assertCurrent,
  }));
  return capability;
}

/**
 * Called only by generated runtime output.  The descriptor and all named
 * imports are closed over here; callers receive only the generated factory
 * and an opaque release capability.
 */
export function createGeneratedFamilyRuntimeFactory(
  assembly: GeneratedFamilyRuntimeAssemblyV1,
): GeneratedFamilyRuntimeFactoryV1 {
  if (!Array.isArray(assembly.sourcePlans) || assembly.sourcePlans.length !== assembly.descriptor.families.length) {
    throw new TypeError("generated Family source plan imports are incomplete");
  }
  const nominationProgramSets = assembly.nominationPrograms;
  if (!Array.isArray(nominationProgramSets) || nominationProgramSets.length !== assembly.descriptor.families.length) {
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
  for (const [familyIndex, family] of assembly.descriptor.families.entries()) {
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
  const physicalBindings: Array<Readonly<GeneratedFamilyPhysicalLifecycleFactoryBindingV1>> = [];
  for (const [familyIndex, family] of assembly.descriptor.families.entries()) {
    const descriptors = family.runtimeAdapters
      .map((descriptor, index) => Object.freeze({ descriptor, index }))
      .filter(value => value.descriptor.role === FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1);
    if (descriptors.length > 1) {
      throw new TypeError(`generated Family physical lifecycle adapter is duplicated ${family.entry.familyId}`);
    }
    if (descriptors.length === 0) continue;
    const { descriptor, index } = descriptors[0]!;
    if (Object.keys(descriptor.capabilityRefs).length !== 0 || Object.keys(descriptor.actionOwnerRefs).length !== 0) {
      throw new TypeError(`generated Family physical lifecycle adapter cannot receive central capabilities ${family.entry.familyId}`);
    }
    const supplied = assembly.runtimeAdapters[familyIndex]?.[index];
    const importDescriptor = typeof supplied === "object" && supplied !== null
      ? supplied as Partial<GeneratedFamilyRuntimeAdapterImportV1>
      : undefined;
    const factory = typeof supplied === "function" ? supplied : importDescriptor?.factory;
    if (typeof factory !== "function") {
      throw new TypeError(`generated Family physical lifecycle adapter import is missing ${family.entry.familyId}`);
    }
    if (importDescriptor !== undefined) {
      if (importDescriptor.modulePath !== descriptor.modulePath
        || importDescriptor.exportName !== descriptor.exportName
        || importDescriptor.closureRoot !== descriptor.closureRoot
        || importDescriptor.leafDigest !== descriptor.leafDigest) {
        throw new TypeError(`generated Family physical lifecycle adapter import descriptor mismatch ${family.entry.familyId}`);
      }
    }
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
      descriptor: assembly.descriptor,
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
  generatedFactoryPhysicalAdapters.set(factory, Object.freeze(physicalBindings));
  generatedFactorySourcePlans.set(factory, Object.freeze(sourcePlanBindings));
  generatedFactoryMetadata.set(factory, Object.freeze({
    proposedCapabilitySetRoot: assembly.descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: assembly.descriptor.nominationProgramSetRoot,
    nominationProgramProposalLeafDigests: Object.freeze(assembly.descriptor.families.flatMap(family =>
      family.sourcePlans.map(plan => plan.nominationProgramProposal.proposalLeafDigest)).sort()),
    releaseIntentRoot: assembly.descriptor.releaseIntentRoot,
    definitionCatalogRoot: assembly.descriptor.definitionCatalogRoot,
    descriptorRoot: assembly.descriptor.descriptorRoot,
    families: Object.freeze(assembly.descriptor.families.map(family => Object.freeze({
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
