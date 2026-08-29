import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalBytes,
  decodeExactObject,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeReleaseIntent,
  type ReleaseIntentV1,
} from "../../../specs/release-intent/src/index.ts";
import { observeGeneratedJsonConstant } from "./generated-json-constant.ts";

const FAMILY_STAGES = ["nomination", "identity", "materialization", "projection", "rehydration"] as const;
type FamilyStageV1 = (typeof FAMILY_STAGES)[number];

interface CapabilityRefWireV1 {
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly ownerRef: Hash;
}

interface StageCapabilityRefWireV1 extends CapabilityRefWireV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly stage: FamilyStageV1 | "capability";
}

interface SourcePlanRefWireV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly completeness: "complete-snapshot" | "contiguous-history" | "point-lookup" | "nomination-only";
  readonly historyStartBlock: string | null;
}

interface FamilyCatalogEntryWireV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly issuerRef: Hash;
  readonly authorityRef: Hash;
  readonly lifecycleRefs: Readonly<Record<FamilyStageV1, StageCapabilityRefWireV1>>;
  readonly extensionRefs: readonly StageCapabilityRefWireV1[];
  readonly actionOwnerRefs: readonly Hash[];
  readonly factContractRefs: readonly Readonly<{ factContractId: string; version: string; schemaHash: Hash }>[];
  readonly sourcePlanRefs: readonly SourcePlanRefWireV1[];
  readonly definitionCatalogLeafDigest: Hash;
  readonly capabilityCatalogRoot: Hash;
}

interface FamilyCatalogWireV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly entries: readonly FamilyCatalogEntryWireV1[];
  readonly definitionCatalogRoot: Hash;
}

interface RuntimeSourcePlanWireV1 {
  readonly sourcePlanId: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly schemaHash: Hash;
  readonly planRef: SourcePlanRefWireV1;
  readonly leafDigest: Hash;
  readonly nominationProgramProposal: Readonly<{
    program: Readonly<{ modulePath: string; exportName: string; closureRoot: Hash; schemaHash: Hash }>;
    mutationCorpus: Readonly<{ modulePath: string; exportName: string; closureRoot: Hash }>;
    independentOracle: Readonly<{ modulePath: string; exportName: string; closureRoot: Hash }>;
    nominationProgramRoot: Hash;
    proposalLeafDigest: Hash;
  }>;
}

interface RuntimeFamilyWireV1 {
  readonly entry: FamilyCatalogEntryWireV1;
  readonly publicEntry: Readonly<{ modulePath: string; exportName: string; closureRoot: Hash }>;
  readonly stages: readonly Readonly<{
    stage: FamilyStageV1;
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    stageRef: StageCapabilityRefWireV1;
  }>[];
  readonly sourcePlans: readonly RuntimeSourcePlanWireV1[];
  readonly extensions: readonly Readonly<{
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    capabilityRef: StageCapabilityRefWireV1;
  }>[];
  readonly actionOwners: readonly Readonly<{
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    ownerRef: Hash;
    ownerId: string;
    version: string;
    schemaHash: Hash;
    implementationHash: Hash;
    actionKinds: readonly string[];
  }>[];
  readonly runtimeAdapters: readonly Readonly<{
    role: string;
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    capabilityRefs: Readonly<Record<string, StageCapabilityRefWireV1>>;
    actionOwnerRefs: Readonly<Record<string, Hash>>;
    leafDigest: Hash;
  }>[];
  readonly runtimeAdapterRoot: Hash;
  readonly sourcePlanRoot: Hash;
  readonly stageDefinitionRoot: Hash;
}

interface FamilyRuntimeDescriptorWireV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly nominationProgramSetRoot: Hash;
  readonly families: readonly RuntimeFamilyWireV1[];
  readonly descriptorRoot: Hash;
}

interface StrategyCatalogEntryWireV1 {
  readonly strategyId: string;
  readonly strategyDefinitionHash: Hash;
  readonly issuerRef: Hash;
  readonly requiredCapabilityRefs: readonly CapabilityRefWireV1[];
  readonly planningProblemIssuer: Hash;
  readonly constraintSchemaRefs: readonly Hash[];
  readonly factContractRefs: readonly Hash[];
  readonly definitionCatalogLeafDigest: Hash;
  readonly strategyVersion: string;
  readonly requestedCapabilityDependencyRoot: Hash;
  readonly implementationClosureRoot: Hash;
  readonly planningTemplate: Readonly<{
    kind: "closed-loop-template";
    entryAssetPolicy: "any-graph-asset";
    minLegs: string;
    maxLegs: string;
    candidateLimit: string;
    edgeReuse: "forbid";
    constraintSchemaRefs: readonly Hash[];
  }>;
}

interface StrategyCatalogWireV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly entries: readonly StrategyCatalogEntryWireV1[];
  readonly definitionCatalogRoot: Hash;
}

export interface FullFamilyReleaseArtifactObserverInputV1 {
  readonly releaseIntentCanonicalBytes: Uint8Array;
  readonly familyCatalogSourceBytes: Uint8Array;
  readonly runtimeCompositionSourceBytes: Uint8Array;
  readonly strategyCatalogSourceBytes?: Uint8Array;
}

export interface ObservedFullFamilyProjectionV1 {
  readonly familyId: string;
  readonly manifestRoot: Hash;
  readonly publicEntry: Readonly<{ modulePath: string; exportName: string }>;
  readonly familyDefinitionHash: Hash;
  readonly definitionCatalogLeafDigest: Hash;
  readonly capabilityCatalogRoot: Hash;
  readonly lifecycleOwnerRefs: Readonly<Record<FamilyStageV1, Hash>>;
  readonly capabilityOwnerRefs: readonly Readonly<{ capabilityId: string; ownerRef: Hash }>[];
  readonly actionOwnerRefs: readonly Hash[];
  readonly sourcePlanRoot: Hash;
  readonly sourcePlanRefs: readonly SourcePlanRefWireV1[];
}

export type ObservedGlobalDefinitionCatalogRootV1 =
  | Readonly<{
    kind: "complete";
    definitionCatalogRoot: Hash;
    familyDefinitionCatalogRoot: Hash;
    strategyDefinitionCatalogRoot: Hash;
  }>
  | Readonly<{
    kind: "missing";
    reason: "strategy-catalog-source-not-supplied";
    familyDefinitionCatalogRoot: Hash;
    runtimeDeclaredDefinitionCatalogRoot: Hash;
  }>;

export type ObservedOptionalSourceHashV1 =
  | Readonly<{ kind: "observed"; contentSha256: Hash }>
  | Readonly<{ kind: "missing"; reason: "strategy-catalog-source-not-supplied" }>;

export interface FullFamilyReleaseArtifactObservationV1 {
  readonly sourceContentSha256: Readonly<{
    releaseIntent: Hash;
    familyCatalog: Hash;
    runtimeComposition: Hash;
    strategyCatalog: ObservedOptionalSourceHashV1;
  }>;
  readonly releaseIntentRoot: Hash;
  readonly familyDefinitionCatalogRoot: Hash;
  readonly runtimeDescriptorRoot: Hash;
  readonly globalDefinitionCatalogRoot: ObservedGlobalDefinitionCatalogRootV1;
  readonly families: readonly ObservedFullFamilyProjectionV1[];
}

function concreteBytes(value: unknown, path: string): Uint8Array {
  if (value === null || typeof value !== "object" || !ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError(`${path} must be a concrete Uint8Array`);
  }
  return Uint8Array.from(value as Uint8Array);
}

function exactString(value: unknown, path: string): string {
  return assertNonEmptyString(value, path);
}

function exactHash(value: unknown, path: string): Hash {
  return assertHash(value, path);
}

function exactOne(value: unknown, path: string): 1 {
  if (value !== 1) throw new TypeError(`unsupported schema version at ${path}`);
  return 1;
}

function familyId(value: unknown, path: string): string {
  const result = exactString(value, path);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) throw new TypeError(`invalid family id at ${path}`);
  return result;
}

function decimalOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`invalid canonical decimal at ${path}`);
  return value;
}

function exactArray<T>(value: unknown, decoder: (item: unknown, path: string) => T, path: string): readonly T[] {
  return fieldArray(value, decoder, path);
}

function assertSortedUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate entry at ${path}`);
  if (values.some((value, index) => index > 0 && values[index - 1]!.localeCompare(value) > 0)) {
    throw new TypeError(`entries are not canonically sorted at ${path}`);
  }
}

function exactCanonical(left: unknown, right: unknown, message: string): void {
  if (encodeCanonicalJson(left) !== encodeCanonicalJson(right)) throw new TypeError(message);
}

function capabilityRef(value: unknown, path: string): CapabilityRefWireV1 {
  return decodeExactObject(value, {
    capabilityId: exactString,
    version: exactString,
    schemaHash: exactHash,
    interpreterHash: exactHash,
    ownerRef: exactHash,
  }, path);
}

function stageRef(value: unknown, path: string): StageCapabilityRefWireV1 {
  return decodeExactObject(value, {
    familyId,
    familyDefinitionHash: exactHash,
    stage: (item, itemPath) => {
      if (![...FAMILY_STAGES, "capability"].includes(item as never)) throw new TypeError(`invalid Family stage at ${itemPath}`);
      return item as StageCapabilityRefWireV1["stage"];
    },
    capabilityId: exactString,
    version: exactString,
    schemaHash: exactHash,
    interpreterHash: exactHash,
    ownerRef: exactHash,
  }, path);
}

function sourcePlanRef(value: unknown, path: string): SourcePlanRefWireV1 {
  const decoded = decodeExactObject(value, {
    ownerRef: exactHash,
    sourcePlanRef: exactHash,
    familyDefinitionHash: exactHash,
    completeness: (item, itemPath) => {
      if (!["complete-snapshot", "contiguous-history", "point-lookup", "nomination-only"].includes(item as string)) {
        throw new TypeError(`invalid source completeness at ${itemPath}`);
      }
      return item as SourcePlanRefWireV1["completeness"];
    },
    historyStartBlock: decimalOrNull,
  }, path);
  if ((decoded.completeness === "contiguous-history") !== (decoded.historyStartBlock !== null)) {
    throw new TypeError(`source history binding mismatch at ${path}`);
  }
  return decoded;
}

function lifecycleRefs(value: unknown, path: string): Readonly<Record<FamilyStageV1, StageCapabilityRefWireV1>> {
  return decodeExactObject(value, {
    nomination: stageRef,
    identity: stageRef,
    materialization: stageRef,
    projection: stageRef,
    rehydration: stageRef,
  }, path);
}

function familyCatalogEntry(value: unknown, path: string): FamilyCatalogEntryWireV1 {
  const entry = decodeExactObject(value, {
    familyId,
    familyDefinitionHash: exactHash,
    issuerRef: exactHash,
    authorityRef: exactHash,
    lifecycleRefs,
    extensionRefs: (item, itemPath) => exactArray(item, stageRef, itemPath),
    actionOwnerRefs: (item, itemPath) => exactArray(item, exactHash, itemPath),
    factContractRefs: (item, itemPath) => exactArray(item, (fact, factPath) => decodeExactObject(fact, {
      factContractId: exactString,
      version: exactString,
      schemaHash: exactHash,
    }, factPath), itemPath),
    sourcePlanRefs: (item, itemPath) => exactArray(item, sourcePlanRef, itemPath),
    definitionCatalogLeafDigest: exactHash,
    capabilityCatalogRoot: exactHash,
  }, path);
  for (const stage of FAMILY_STAGES) {
    const ref = entry.lifecycleRefs[stage];
    if (ref.familyId !== entry.familyId || ref.familyDefinitionHash !== entry.familyDefinitionHash || ref.stage !== stage) {
      throw new TypeError(`Family lifecycle binding mismatch at ${path}.${stage}`);
    }
  }
  for (const ref of entry.extensionRefs) {
    if (ref.familyId !== entry.familyId || ref.familyDefinitionHash !== entry.familyDefinitionHash || ref.stage !== "capability") {
      throw new TypeError(`Family capability binding mismatch at ${path}`);
    }
  }
  for (const ref of entry.sourcePlanRefs) {
    if (ref.familyDefinitionHash !== entry.familyDefinitionHash) throw new TypeError(`Family source plan binding mismatch at ${path}`);
  }
  assertSortedUnique(entry.extensionRefs.map(ref => ref.capabilityId), `${path}.extensionRefs`);
  assertSortedUnique(entry.actionOwnerRefs, `${path}.actionOwnerRefs`);
  assertSortedUnique(entry.factContractRefs.map(ref => ref.factContractId), `${path}.factContractRefs`);
  assertSortedUnique(entry.sourcePlanRefs.map(ref => ref.sourcePlanRef), `${path}.sourcePlanRefs`);
  return entry;
}

function familyCatalog(value: unknown): FamilyCatalogWireV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: exactOne,
    releaseIntentRoot: exactHash,
    capabilityIndexRoot: exactHash,
    proposedCapabilitySetRoot: exactHash,
    entries: (item, path) => exactArray(item, familyCatalogEntry, path),
    definitionCatalogRoot: exactHash,
  }, "familyCatalog");
  if (decoded.entries.length === 0) throw new TypeError("Family catalog is empty");
  assertSortedUnique(decoded.entries.map(entry => entry.familyId), "familyCatalog.entries");
  if (new Set(decoded.entries.map(entry => entry.familyDefinitionHash)).size !== decoded.entries.length) {
    throw new TypeError("duplicate Family definition hash in Family catalog");
  }
  const root = hashDomain("aloha/family-definition-catalog/v1", decoded.entries.map(entry => entry.definitionCatalogLeafDigest).sort());
  if (root !== decoded.definitionCatalogRoot) throw new TypeError("Family definition catalog root mismatch");
  return decoded;
}

function entrypoint(value: unknown, path: string): Readonly<{ modulePath: string; exportName: string; closureRoot: Hash }> {
  return decodeExactObject(value, { modulePath: exactString, exportName: exactString, closureRoot: exactHash }, path);
}

function entrypointWithSchema(value: unknown, path: string): Readonly<{ modulePath: string; exportName: string; closureRoot: Hash; schemaHash: Hash }> {
  return decodeExactObject(value, { modulePath: exactString, exportName: exactString, closureRoot: exactHash, schemaHash: exactHash }, path);
}

function runtimeSourcePlan(value: unknown, path: string): RuntimeSourcePlanWireV1 {
  const plan = decodeExactObject(value, {
    sourcePlanId: exactString,
    modulePath: exactString,
    exportName: exactString,
    closureRoot: exactHash,
    schemaHash: exactHash,
    planRef: sourcePlanRef,
    leafDigest: exactHash,
    nominationProgramProposal: (item, itemPath) => decodeExactObject(item, {
      program: entrypointWithSchema,
      mutationCorpus: entrypoint,
      independentOracle: entrypoint,
      nominationProgramRoot: exactHash,
      proposalLeafDigest: exactHash,
    }, itemPath),
  }, path);
  const leafDigest = hashDomain("aloha/family-source-plan-leaf/v1", {
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
  if (leafDigest !== plan.leafDigest) throw new TypeError(`source plan leaf mismatch at ${path}`);
  const nominationRoot = hashDomain("aloha/family-source-plan-nomination-program/v1", plan.nominationProgramProposal.program);
  if (nominationRoot !== plan.nominationProgramProposal.nominationProgramRoot) throw new TypeError(`nomination program root mismatch at ${path}`);
  const proposalLeaf = hashDomain("aloha/source-plan-nomination-program-proposal-leaf/v1", {
    sourcePlanLeafDigest: plan.leafDigest,
    program: plan.nominationProgramProposal.program,
    mutationCorpus: plan.nominationProgramProposal.mutationCorpus,
    independentOracle: plan.nominationProgramProposal.independentOracle,
    nominationProgramRoot: plan.nominationProgramProposal.nominationProgramRoot,
  });
  if (proposalLeaf !== plan.nominationProgramProposal.proposalLeafDigest) throw new TypeError(`nomination proposal leaf mismatch at ${path}`);
  return plan;
}

function exactRecord<T>(value: unknown, decoder: (item: unknown, path: string) => T, path: string): Readonly<Record<string, T>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`expected record at ${path}`);
  const result: Record<string, T> = Object.create(null) as Record<string, T>;
  const keys = Object.keys(value).sort();
  if (keys.some((key, index) => index > 0 && Object.keys(value)[index] !== key)) throw new TypeError(`record is not sorted at ${path}`);
  for (const key of keys) {
    exactString(key, `${path}.key`);
    result[key] = decoder((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
  return Object.freeze(result);
}

function adapterLeaf(adapter: RuntimeFamilyWireV1["runtimeAdapters"][number]): Hash {
  const refPayload = (ref: StageCapabilityRefWireV1): Record<string, unknown> => ({
    stage: ref.stage,
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    interpreterHash: ref.interpreterHash,
    ownerRef: ref.ownerRef,
  });
  return hashDomain("aloha/family-runtime-adapter-leaf/v1", {
    role: adapter.role,
    modulePath: adapter.modulePath,
    exportName: adapter.exportName,
    closureRoot: adapter.closureRoot,
    capabilityRefs: Object.entries(adapter.capabilityRefs).map(([role, ref]) => ({ role, ref: refPayload(ref) })),
    actionOwnerRefs: Object.entries(adapter.actionOwnerRefs).map(([role, ownerRef]) => ({ role, ownerRef })),
  });
}

function runtimeFamily(value: unknown, path: string): RuntimeFamilyWireV1 {
  const family = decodeExactObject(value, {
    entry: familyCatalogEntry,
    publicEntry: entrypoint,
    stages: (item, itemPath) => exactArray(item, (stage, stagePath) => decodeExactObject(stage, {
      stage: (name, namePath) => {
        if (!FAMILY_STAGES.includes(name as FamilyStageV1)) throw new TypeError(`invalid runtime stage at ${namePath}`);
        return name as FamilyStageV1;
      },
      modulePath: exactString,
      exportName: exactString,
      closureRoot: exactHash,
      stageRef,
    }, stagePath), itemPath),
    sourcePlans: (item, itemPath) => exactArray(item, runtimeSourcePlan, itemPath),
    extensions: (item, itemPath) => exactArray(item, (extension, extensionPath) => decodeExactObject(extension, {
      modulePath: exactString,
      exportName: exactString,
      closureRoot: exactHash,
      capabilityRef: stageRef,
    }, extensionPath), itemPath),
    actionOwners: (item, itemPath) => exactArray(item, (action, actionPath) => decodeExactObject(action, {
      modulePath: exactString,
      exportName: exactString,
      closureRoot: exactHash,
      ownerRef: exactHash,
      ownerId: exactString,
      version: exactString,
      schemaHash: exactHash,
      implementationHash: exactHash,
      actionKinds: (kinds, kindsPath) => exactArray(kinds, exactString, kindsPath),
    }, actionPath), itemPath),
    runtimeAdapters: (item, itemPath) => exactArray(item, (adapter, adapterPath) => decodeExactObject(adapter, {
      role: exactString,
      modulePath: exactString,
      exportName: exactString,
      closureRoot: exactHash,
      capabilityRefs: (refs, refsPath) => exactRecord(refs, stageRef, refsPath),
      actionOwnerRefs: (refs, refsPath) => exactRecord(refs, exactHash, refsPath),
      leafDigest: exactHash,
    }, adapterPath), itemPath),
    runtimeAdapterRoot: exactHash,
    sourcePlanRoot: exactHash,
    stageDefinitionRoot: exactHash,
  }, path);
  if (family.stages.length !== FAMILY_STAGES.length) throw new TypeError(`runtime Family stage set is incomplete at ${path}`);
  assertSortedUnique(family.stages.map(stage => stage.stage), `${path}.stages`);
  for (const stage of family.stages) {
    const catalogRef = family.entry.lifecycleRefs[stage.stage];
    if (stage.stageRef.familyId !== family.entry.familyId || stage.stageRef.familyDefinitionHash !== family.entry.familyDefinitionHash || stage.stageRef.stage !== stage.stage) {
      throw new TypeError(`runtime stage binding mismatch at ${path}`);
    }
    exactCanonical(stage.stageRef, catalogRef, `runtime/catalog lifecycle ref mismatch at ${path}`);
  }
  const stageDefinitionRoot = hashDomain("aloha/family-runtime-definition-set/v1", family.stages.map(stage => ({
    stage: stage.stage,
    modulePath: stage.modulePath,
    exportName: stage.exportName,
    closureRoot: stage.closureRoot,
    stageRef: stage.stageRef,
  })));
  if (stageDefinitionRoot !== family.stageDefinitionRoot) throw new TypeError(`stage definition root mismatch at ${path}`);
  if (family.sourcePlans.length === 0) throw new TypeError(`runtime Family source plan set is empty at ${path}`);
  assertSortedUnique(family.sourcePlans.map(plan => plan.sourcePlanId), `${path}.sourcePlans`);
  assertSortedUnique(family.sourcePlans.map(plan => plan.planRef.sourcePlanRef).sort(), `${path}.sourcePlanRefs`);
  const sourcePlanRoot = hashDomain("aloha/family-source-plan-set/v1", family.sourcePlans.map(plan => plan.leafDigest).sort());
  if (sourcePlanRoot !== family.sourcePlanRoot) throw new TypeError(`source plan root mismatch at ${path}`);
  const catalogPlans = [...family.entry.sourcePlanRefs].sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef));
  const runtimePlans = family.sourcePlans.map(plan => plan.planRef).sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef));
  exactCanonical(runtimePlans, catalogPlans, `runtime/catalog source plan refs mismatch at ${path}`);
  assertSortedUnique(family.extensions.map(extension => extension.capabilityRef.capabilityId), `${path}.extensions`);
  const extensionRefs = family.extensions.map(extension => extension.capabilityRef);
  exactCanonical(extensionRefs, family.entry.extensionRefs, `runtime/catalog capability owner refs mismatch at ${path}`);
  assertSortedUnique(family.actionOwners.map(action => action.ownerRef), `${path}.actionOwners`);
  exactCanonical(family.actionOwners.map(action => action.ownerRef), family.entry.actionOwnerRefs, `runtime/catalog action owner refs mismatch at ${path}`);
  assertSortedUnique(family.runtimeAdapters.map(adapter => adapter.role), `${path}.runtimeAdapters`);
  for (const adapter of family.runtimeAdapters) {
    for (const ref of Object.values(adapter.capabilityRefs)) {
      if (!family.entry.extensionRefs.some(candidate => encodeCanonicalJson(candidate) === encodeCanonicalJson(ref))) {
        throw new TypeError(`runtime adapter capability ref is not catalog-owned at ${path}`);
      }
    }
    for (const ownerRef of Object.values(adapter.actionOwnerRefs)) {
      if (!family.entry.actionOwnerRefs.includes(ownerRef)) throw new TypeError(`runtime adapter action ref is not catalog-owned at ${path}`);
    }
    if (adapterLeaf(adapter) !== adapter.leafDigest) throw new TypeError(`runtime adapter leaf mismatch at ${path}`);
  }
  const adapterRoot = hashDomain("aloha/family-runtime-adapter-set/v1", family.runtimeAdapters.map(adapter => adapter.leafDigest).sort());
  if (adapterRoot !== family.runtimeAdapterRoot) throw new TypeError(`runtime adapter root mismatch at ${path}`);
  return family;
}

function familyRuntimeDescriptor(value: unknown): FamilyRuntimeDescriptorWireV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: exactOne,
    releaseIntentRoot: exactHash,
    definitionCatalogRoot: exactHash,
    proposedCapabilitySetRoot: exactHash,
    nominationProgramSetRoot: exactHash,
    families: (item, path) => exactArray(item, runtimeFamily, path),
    descriptorRoot: exactHash,
  }, "familyRuntimeDescriptor");
  if (decoded.families.length === 0) throw new TypeError("runtime Family descriptor is empty");
  assertSortedUnique(decoded.families.map(family => family.entry.familyId), "familyRuntimeDescriptor.families");
  if (new Set(decoded.families.map(family => family.entry.familyDefinitionHash)).size !== decoded.families.length) {
    throw new TypeError("duplicate Family definition hash in runtime descriptor");
  }
  const { descriptorRoot: _descriptorRoot, ...descriptorWithoutRoot } = decoded;
  if (hashDomain("aloha/generated-family-runtime-descriptor/v1", descriptorWithoutRoot) !== decoded.descriptorRoot) {
    throw new TypeError("runtime Family descriptor root mismatch");
  }
  const nominationLeaves = decoded.families.flatMap(family => family.sourcePlans.map(plan => plan.nominationProgramProposal.proposalLeafDigest)).sort();
  if (new Set(nominationLeaves).size !== nominationLeaves.length) throw new TypeError("duplicate nomination proposal leaf");
  if (hashDomain("aloha/source-plan-nomination-program-set/v1", nominationLeaves) !== decoded.nominationProgramSetRoot) {
    throw new TypeError("nomination program set root mismatch");
  }
  return decoded;
}

function strategyCatalogEntry(value: unknown, path: string): StrategyCatalogEntryWireV1 {
  const entry = decodeExactObject(value, {
    strategyId: exactString,
    strategyDefinitionHash: exactHash,
    issuerRef: exactHash,
    requiredCapabilityRefs: (item, itemPath) => exactArray(item, capabilityRef, itemPath),
    planningProblemIssuer: exactHash,
    constraintSchemaRefs: (item, itemPath) => exactArray(item, exactHash, itemPath),
    factContractRefs: (item, itemPath) => exactArray(item, exactHash, itemPath),
    definitionCatalogLeafDigest: exactHash,
    strategyVersion: exactString,
    requestedCapabilityDependencyRoot: exactHash,
    implementationClosureRoot: exactHash,
    planningTemplate: (item, itemPath) => decodeExactObject(item, {
      kind: (field, fieldPath) => {
        if (field !== "closed-loop-template") throw new TypeError(`invalid planning template kind at ${fieldPath}`);
        return "closed-loop-template" as const;
      },
      entryAssetPolicy: (field, fieldPath) => {
        if (field !== "any-graph-asset") throw new TypeError(`invalid entry asset policy at ${fieldPath}`);
        return "any-graph-asset" as const;
      },
      minLegs: exactString,
      maxLegs: exactString,
      candidateLimit: exactString,
      edgeReuse: (field, fieldPath) => {
        if (field !== "forbid") throw new TypeError(`invalid edge reuse policy at ${fieldPath}`);
        return "forbid" as const;
      },
      constraintSchemaRefs: (refs, refsPath) => exactArray(refs, exactHash, refsPath),
    }, itemPath),
  }, path);
  assertSortedUnique(entry.requiredCapabilityRefs.map(ref => ref.capabilityId), `${path}.requiredCapabilityRefs`);
  const leaf = hashDomain("aloha/definition-catalog-leaf/v1", {
    leafId: `strategy:${entry.strategyId}`,
    definitionHash: entry.strategyDefinitionHash,
    requestedDependencyClosure: entry.requiredCapabilityRefs.map(ref => ref.capabilityId).sort(),
    implementationClosureRoot: entry.implementationClosureRoot,
  });
  if (leaf !== entry.definitionCatalogLeafDigest) throw new TypeError(`strategy definition leaf mismatch at ${path}`);
  return entry;
}

function strategyCatalog(value: unknown): StrategyCatalogWireV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: exactOne,
    releaseIntentRoot: exactHash,
    capabilityIndexRoot: exactHash,
    proposedCapabilitySetRoot: exactHash,
    entries: (item, path) => exactArray(item, strategyCatalogEntry, path),
    definitionCatalogRoot: exactHash,
  }, "strategyCatalog");
  assertSortedUnique(decoded.entries.map(entry => entry.strategyId), "strategyCatalog.entries");
  const root = hashDomain("aloha/strategy-definition-catalog/v1", decoded.entries.map(entry => entry.definitionCatalogLeafDigest).sort());
  if (root !== decoded.definitionCatalogRoot) throw new TypeError("Strategy definition catalog root mismatch");
  return decoded;
}

function exactFamilySets(release: ReleaseIntentV1, catalog: FamilyCatalogWireV1, runtime: FamilyRuntimeDescriptorWireV1): void {
  const releaseIds = release.families.map(entry => entry.familyId);
  const catalogIds = catalog.entries.map(entry => entry.familyId);
  const runtimeIds = runtime.families.map(entry => entry.entry.familyId);
  exactCanonical(catalogIds, releaseIds, "release-intent/Family catalog exact set mismatch");
  exactCanonical(runtimeIds, releaseIds, "release-intent/runtime Family exact set mismatch");
  for (let index = 0; index < release.families.length; index += 1) {
    const releaseEntry = release.families[index]!;
    const catalogEntry = catalog.entries[index]!;
    const runtimeFamily = runtime.families[index]!;
    exactCanonical(runtimeFamily.entry, catalogEntry, `Family catalog/runtime entry mismatch for ${releaseEntry.familyId}`);
    if (releaseEntry.modulePath !== runtimeFamily.publicEntry.modulePath || releaseEntry.exportName !== runtimeFamily.publicEntry.exportName) {
      throw new TypeError(`release-intent/runtime public entry mismatch for ${releaseEntry.familyId}`);
    }
  }
}

/**
 * Observes the release artifacts as inert bytes. Generated source is parsed as
 * an AST literal and is never imported or executed. Mismatched or spliced
 * artifacts throw; the returned projection contains observations only.
 */
export function observeFullFamilyReleaseArtifacts(
  input: FullFamilyReleaseArtifactObserverInputV1,
): FullFamilyReleaseArtifactObservationV1 {
  if (input === null || typeof input !== "object") throw new TypeError("full-family release artifact input is required");
  const releaseBytes = concreteBytes(input.releaseIntentCanonicalBytes, "releaseIntentCanonicalBytes");
  const familySourceBytes = concreteBytes(input.familyCatalogSourceBytes, "familyCatalogSourceBytes");
  const runtimeSourceBytes = concreteBytes(input.runtimeCompositionSourceBytes, "runtimeCompositionSourceBytes");
  const release = decodeReleaseIntent(decodeCanonicalBytes(releaseBytes));
  const familyObservation = observeGeneratedJsonConstant(familySourceBytes, {
    sourceFileName: "generated/family-catalog/index.ts",
    constantName: "FAMILY_CATALOG",
    requireExported: true,
    assertionTypeName: null,
  });
  const runtimeObservation = observeGeneratedJsonConstant(runtimeSourceBytes, {
    sourceFileName: "generated/runtime-composition/index.ts",
    constantName: "FAMILY_RUNTIME_DESCRIPTOR",
    requireExported: false,
    assertionTypeName: "GeneratedFamilyRuntimeDescriptorV1",
  });
  const catalog = familyCatalog(familyObservation.value);
  const runtime = familyRuntimeDescriptor(runtimeObservation.value);
  if (release.releaseIntentRoot !== catalog.releaseIntentRoot || release.releaseIntentRoot !== runtime.releaseIntentRoot) {
    throw new TypeError("release intent root splice");
  }
  if (catalog.proposedCapabilitySetRoot !== runtime.proposedCapabilitySetRoot) {
    throw new TypeError("proposed capability set root mismatch");
  }
  exactFamilySets(release, catalog, runtime);

  let strategySourceHash: ObservedOptionalSourceHashV1 = Object.freeze({
    kind: "missing",
    reason: "strategy-catalog-source-not-supplied",
  });
  let globalDefinitionCatalogRoot: ObservedGlobalDefinitionCatalogRootV1;
  if (input.strategyCatalogSourceBytes === undefined) {
    globalDefinitionCatalogRoot = Object.freeze({
      kind: "missing",
      reason: "strategy-catalog-source-not-supplied",
      familyDefinitionCatalogRoot: catalog.definitionCatalogRoot,
      runtimeDeclaredDefinitionCatalogRoot: runtime.definitionCatalogRoot,
    });
  } else {
    const strategySourceBytes = concreteBytes(input.strategyCatalogSourceBytes, "strategyCatalogSourceBytes");
    const strategyObservation = observeGeneratedJsonConstant(strategySourceBytes, {
      sourceFileName: "generated/strategy-catalog/index.ts",
      constantName: "STRATEGY_CATALOG",
      requireExported: true,
      assertionTypeName: null,
    });
    strategySourceHash = Object.freeze({ kind: "observed", contentSha256: strategyObservation.sourceContentSha256 });
    const strategies = strategyCatalog(strategyObservation.value);
    if (strategies.releaseIntentRoot !== release.releaseIntentRoot) throw new TypeError("Strategy catalog release intent root splice");
    if (strategies.capabilityIndexRoot !== catalog.capabilityIndexRoot) throw new TypeError("Family/Strategy capability index root mismatch");
    if (strategies.proposedCapabilitySetRoot !== catalog.proposedCapabilitySetRoot) throw new TypeError("Family/Strategy proposed capability set root mismatch");
    exactCanonical(strategies.entries.map(entry => entry.strategyId), release.strategies.map(entry => entry.strategyId), "release-intent/Strategy catalog exact set mismatch");
    const combined = [...catalog.entries.map(entry => entry.definitionCatalogLeafDigest), ...strategies.entries.map(entry => entry.definitionCatalogLeafDigest)].sort();
    if (new Set(combined).size !== combined.length) throw new TypeError("duplicate global definition catalog leaf");
    const globalRoot = hashDomain("aloha/definition-catalog/v1", combined);
    if (globalRoot !== runtime.definitionCatalogRoot) throw new TypeError("global definition catalog root mismatch");
    globalDefinitionCatalogRoot = Object.freeze({
      kind: "complete",
      definitionCatalogRoot: globalRoot,
      familyDefinitionCatalogRoot: catalog.definitionCatalogRoot,
      strategyDefinitionCatalogRoot: strategies.definitionCatalogRoot,
    });
  }

  const families = release.families.map((releaseEntry, index): ObservedFullFamilyProjectionV1 => {
    const catalogEntry = catalog.entries[index]!;
    const runtimeFamily = runtime.families[index]!;
    return Object.freeze({
      familyId: releaseEntry.familyId,
      manifestRoot: releaseEntry.manifestRoot,
      publicEntry: Object.freeze({ modulePath: releaseEntry.modulePath, exportName: releaseEntry.exportName }),
      familyDefinitionHash: catalogEntry.familyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      capabilityCatalogRoot: catalogEntry.capabilityCatalogRoot,
      lifecycleOwnerRefs: Object.freeze(Object.fromEntries(FAMILY_STAGES.map(stage => [stage, catalogEntry.lifecycleRefs[stage].ownerRef]))) as Readonly<Record<FamilyStageV1, Hash>>,
      capabilityOwnerRefs: Object.freeze(catalogEntry.extensionRefs.map(ref => Object.freeze({ capabilityId: ref.capabilityId, ownerRef: ref.ownerRef }))),
      actionOwnerRefs: Object.freeze([...catalogEntry.actionOwnerRefs]),
      sourcePlanRoot: runtimeFamily.sourcePlanRoot,
      sourcePlanRefs: Object.freeze([...catalogEntry.sourcePlanRefs]),
    });
  });
  return Object.freeze({
    sourceContentSha256: Object.freeze({
      releaseIntent: sha256Hex(releaseBytes),
      familyCatalog: familyObservation.sourceContentSha256,
      runtimeComposition: runtimeObservation.sourceContentSha256,
      strategyCatalog: strategySourceHash,
    }),
    releaseIntentRoot: release.releaseIntentRoot,
    familyDefinitionCatalogRoot: catalog.definitionCatalogRoot,
    runtimeDescriptorRoot: runtime.descriptorRoot,
    globalDefinitionCatalogRoot,
    families: Object.freeze(families),
  });
}
