import {
  assertCapabilityDeclaration,
  asCapabilityId,
  asCapabilityVersion,
  asSchemaRef,
  type ActionOwnerAuthoringDeclarationV1,
  type ArtifactKind,
  type CapabilityAuthoringDeclarationV1,
  type CapabilityId,
  type DeclaredAbsenceReason,
  type FamilyFactContractRefV1,
  type SchemaRef,
} from "../../capability-contracts/src/index.ts";
import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export interface ModuleEntrypointV1 {
  readonly modulePath: string;
  readonly exportName: string;
}

export interface AuthoringModuleRefV1 extends ModuleEntrypointV1 {
  readonly artifactKind: ArtifactKind;
  readonly capabilityIds: readonly CapabilityId[];
  readonly schemaRefs: readonly SchemaRef[];
}

export interface FamilyManifestAuthoringV1 {
  readonly familyId: string;
  readonly version: string;
  readonly pluginCodeHash: Hash;
  readonly authorityDeclarationHash: Hash;
  readonly sourcePlanIds: readonly string[];
}

export interface NominationAuthoringModule extends AuthoringModuleRefV1 {
  readonly artifactKind: "nomination";
  readonly sourcePlanIds: readonly string[];
}

export interface IdentityAuthoringModule extends AuthoringModuleRefV1 {
  readonly artifactKind: "identity";
}

export interface MaterializationAuthoringModule extends AuthoringModuleRefV1 {
  readonly artifactKind: "materialization";
}

export interface ProjectionAuthoringModule extends AuthoringModuleRefV1 {
  readonly artifactKind: "projection";
}

export interface RehydrationAuthoringModule extends AuthoringModuleRefV1 {
  readonly artifactKind: "rehydration";
}

export interface FamilyCoreAuthoringV1 {
  readonly nomination: NominationAuthoringModule;
  readonly identity: IdentityAuthoringModule;
  readonly materialization: MaterializationAuthoringModule;
  readonly projection: ProjectionAuthoringModule;
  readonly rehydration: RehydrationAuthoringModule;
}

export type AuthoringCapabilitySlot<C extends CapabilityAuthoringDeclarationV1 = CapabilityAuthoringDeclarationV1> =
  | { readonly kind: "present"; readonly module: C }
  | { readonly kind: "absent"; readonly reason: DeclaredAbsenceReason };

export type CapabilityAuthoringMap = Readonly<Record<string, AuthoringCapabilitySlot>>;

export interface FamilyAuthoringDefinitionV1<Extensions extends CapabilityAuthoringMap = CapabilityAuthoringMap> {
  readonly manifest: FamilyManifestAuthoringV1;
  readonly core: FamilyCoreAuthoringV1;
  readonly extensions: Extensions;
  readonly actionOwners: readonly ActionOwnerAuthoringDeclarationV1[];
  readonly acceptanceDeclarations: readonly FamilyFactContractRefV1[];
}

const FAMILY_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ABSENCE_REASONS = new Set<DeclaredAbsenceReason>(["not-applicable", "not-in-release", "requires-future-extension"]);
const ARTIFACTS = new Set<ArtifactKind>([
  "nomination", "identity", "materialization", "projection", "rehydration", "state", "coarse", "trigger", "exact", "action", "strategy-plan",
]);

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${path} has non-exact keys`);
  return value as Record<string, unknown>;
}

function modulePath(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (result.startsWith(".") || result.startsWith("/") || result.startsWith("@") || result.includes("..") || result.includes("\\") || result.includes("?") || result.includes("#")) {
    throw new TypeError(`modulePath must be a static repository path at ${path}`);
  }
  return result;
}

function exportName(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^[$A-Z_a-z][$\w]*$/.test(result)) throw new TypeError(`exportName must be a static identifier at ${path}`);
  return result;
}

function entrypoint(value: unknown, path: string): ModuleEntrypointV1 {
  const record = exactObject(value, ["modulePath", "exportName"], path);
  return Object.freeze({ modulePath: modulePath(record.modulePath, `${path}.modulePath`), exportName: exportName(record.exportName, `${path}.exportName`) });
}

function capabilityIds(value: unknown, path: string): readonly CapabilityId[] {
  const result = fieldArray(value, (item, itemPath) => asCapabilityId(item as string, itemPath), path);
  if (new Set(result).size !== result.length) throw new TypeError(`duplicate capability id at ${path}`);
  return Object.freeze([...result].sort());
}

function schemaRefs(value: unknown, path: string): readonly SchemaRef[] {
  const result = fieldArray(value, (item, itemPath) => asSchemaRef(item as Hash, itemPath), path);
  if (new Set(result).size !== result.length) throw new TypeError(`duplicate schema ref at ${path}`);
  return Object.freeze([...result].sort());
}

function moduleRef<K extends ArtifactKind>(value: unknown, path: string, expectedKind: K): AuthoringModuleRefV1 & { readonly artifactKind: K } {
  const record = exactObject(value, ["modulePath", "exportName", "artifactKind", "capabilityIds", "schemaRefs"], path);
  if (record.artifactKind !== expectedKind || !ARTIFACTS.has(record.artifactKind as ArtifactKind)) throw new TypeError(`module artifact kind mismatch at ${path}`);
  return Object.freeze({
    ...entrypoint({ modulePath: record.modulePath, exportName: record.exportName }, path),
    artifactKind: expectedKind,
    capabilityIds: capabilityIds(record.capabilityIds, `${path}.capabilityIds`),
    schemaRefs: schemaRefs(record.schemaRefs, `${path}.schemaRefs`),
  });
}

function normalizedModuleRef<K extends ArtifactKind>(record: Record<string, unknown>, path: string, expectedKind: K): AuthoringModuleRefV1 & { readonly artifactKind: K } {
  return moduleRef({
    modulePath: record.modulePath,
    exportName: record.exportName,
    artifactKind: record.artifactKind,
    capabilityIds: record.capabilityIds,
    schemaRefs: record.schemaRefs,
  }, path, expectedKind);
}

function nominationModule(value: unknown, path: string): NominationAuthoringModule {
  const record = exactObject(value, ["modulePath", "exportName", "artifactKind", "capabilityIds", "schemaRefs", "sourcePlanIds"], path);
  return Object.freeze({ ...normalizedModuleRef(record, path, "nomination"), sourcePlanIds: stringSet(record.sourcePlanIds, `${path}.sourcePlanIds`) });
}

function stringSet(value: unknown, path: string): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (new Set(result).size !== result.length) throw new TypeError(`duplicate string at ${path}`);
  return Object.freeze([...result].sort());
}

function manifest(value: unknown, path: string): FamilyManifestAuthoringV1 {
  const record = exactObject(value, ["familyId", "version", "pluginCodeHash", "authorityDeclarationHash", "sourcePlanIds"], path);
  const familyId = assertNonEmptyString(record.familyId, `${path}.familyId`);
  if (!FAMILY_ID_RE.test(familyId)) throw new TypeError(`invalid familyId at ${path}.familyId`);
  const version = assertNonEmptyString(record.version, `${path}.version`);
  if (!VERSION_RE.test(version)) throw new TypeError(`invalid family version at ${path}.version`);
  return Object.freeze({
    familyId,
    version,
    pluginCodeHash: assertHash(record.pluginCodeHash, `${path}.pluginCodeHash`),
    authorityDeclarationHash: assertHash(record.authorityDeclarationHash, `${path}.authorityDeclarationHash`),
    sourcePlanIds: stringSet(record.sourcePlanIds, `${path}.sourcePlanIds`),
  });
}

function actionOwner(value: unknown, path: string): ActionOwnerAuthoringDeclarationV1 {
  const record = exactObject(value, ["ownerId", "version", "schemaHash", "implementationHash", "actionKinds", "modulePath", "exportName"], path);
  const ownerId = assertNonEmptyString(record.ownerId, `${path}.ownerId`);
  const version = assertNonEmptyString(record.version, `${path}.version`);
  if (!VERSION_RE.test(version)) throw new TypeError(`invalid action owner version at ${path}.version`);
  const actionKinds = stringSet(record.actionKinds, `${path}.actionKinds`);
  return Object.freeze({
    ownerId,
    version: asCapabilityVersion(version, `${path}.version`),
    schemaHash: asSchemaRef(record.schemaHash as Hash, `${path}.schemaHash`),
    implementationHash: assertHash(record.implementationHash, `${path}.implementationHash`),
    actionKinds,
    modulePath: modulePath(record.modulePath, `${path}.modulePath`),
    exportName: exportName(record.exportName, `${path}.exportName`),
  });
}

function factContract(value: unknown, path: string): FamilyFactContractRefV1 {
  const record = exactObject(value, ["factContractId", "version", "schemaHash"], path);
  return Object.freeze({
    factContractId: assertNonEmptyString(record.factContractId, `${path}.factContractId`),
    version: asCapabilityVersion(record.version as string, `${path}.version`),
    schemaHash: asSchemaRef(record.schemaHash as Hash, `${path}.schemaHash`),
  });
}

function core(value: unknown, path: string): FamilyCoreAuthoringV1 {
  const record = exactObject(value, ["nomination", "identity", "materialization", "projection", "rehydration"], path);
  return Object.freeze({
    nomination: nominationModule(record.nomination, `${path}.nomination`),
    identity: moduleRef(record.identity, `${path}.identity`, "identity") as IdentityAuthoringModule,
    materialization: moduleRef(record.materialization, `${path}.materialization`, "materialization") as MaterializationAuthoringModule,
    projection: moduleRef(record.projection, `${path}.projection`, "projection") as ProjectionAuthoringModule,
    rehydration: moduleRef(record.rehydration, `${path}.rehydration`, "rehydration") as RehydrationAuthoringModule,
  });
}

function extensionSlot(value: unknown, path: string): AuthoringCapabilitySlot {
  const record = exactObject(value, ["kind", ...(value !== null && typeof value === "object" && "kind" in value && (value as { kind?: unknown }).kind === "present" ? ["module"] : ["reason"])], path);
  if (record.kind === "present") return Object.freeze({ kind: "present", module: assertCapabilityDeclaration(record.module, `${path}.module`) });
  if (record.kind === "absent" && typeof record.reason === "string" && ABSENCE_REASONS.has(record.reason as DeclaredAbsenceReason)) return Object.freeze({ kind: "absent", reason: record.reason as DeclaredAbsenceReason });
  throw new TypeError(`invalid extension slot at ${path}`);
}

function extensions(value: unknown, path: string): CapabilityAuthoringMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, AuthoringCapabilitySlot> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const id = asCapabilityId(key, `${path}.${key}`);
    const slot = extensionSlot(item, `${path}.${key}`);
    if (slot.kind === "present" && slot.module.capabilityId !== id) throw new TypeError(`extension key/module mismatch at ${path}.${key}`);
    result[id] = slot;
  }
  return Object.freeze(result);
}

export function normalizeFamilyDefinition<E extends CapabilityAuthoringMap = CapabilityAuthoringMap>(value: unknown, path = "family"): FamilyAuthoringDefinitionV1<E> {
  const record = exactObject(value, ["manifest", "core", "extensions", "actionOwners", "acceptanceDeclarations"], path);
  const actionOwners = fieldArray(record.actionOwners, (item, itemPath) => actionOwner(item, itemPath), `${path}.actionOwners`);
  const ownerIds = actionOwners.map(owner => owner.ownerId);
  if (new Set(ownerIds).size !== ownerIds.length) throw new TypeError(`duplicate action owner at ${path}.actionOwners`);
  const factContracts = fieldArray(record.acceptanceDeclarations, (item, itemPath) => factContract(item, itemPath), `${path}.acceptanceDeclarations`);
  const factIds = factContracts.map(fact => fact.factContractId);
  if (new Set(factIds).size !== factIds.length) throw new TypeError(`duplicate fact contract at ${path}.acceptanceDeclarations`);
  const normalized = {
    manifest: manifest(record.manifest, `${path}.manifest`),
    core: core(record.core, `${path}.core`),
    extensions: extensions(record.extensions, `${path}.extensions`) as E,
    actionOwners: Object.freeze([...actionOwners].sort((left, right) => left.ownerId.localeCompare(right.ownerId))),
    acceptanceDeclarations: Object.freeze([...factContracts].sort((left, right) => left.factContractId.localeCompare(right.factContractId))),
  } as FamilyAuthoringDefinitionV1<E>;
  return deepFreeze(normalized);
}

export function defineFamily<E extends CapabilityAuthoringMap>(definition: FamilyAuthoringDefinitionV1<E>): FamilyAuthoringDefinitionV1<E> {
  return normalizeFamilyDefinition<E>(definition);
}

/** Hashes only build-time meaning and declarations; no runtime object can use it as authority. */
export function familyAuthoringDigest(definition: FamilyAuthoringDefinitionV1): Hash {
  const normalized = normalizeFamilyDefinition(definition);
  return hashDomain("aloha/family-authoring-definition/v1", normalized);
}

export type { ActionOwnerAuthoringDeclarationV1, CapabilityAuthoringDeclarationV1, CapabilityId, FamilyFactContractRefV1, SchemaRef } from "../../capability-contracts/src/index.ts";
