import { assertHash, assertNonEmptyString, decodeExactObject, fieldArray, type Hash } from "../../canonical-codec/src/index.ts";

/** A capability name is semantic data, never a central domain union. */
export type CapabilityId = string & { readonly __capabilityId: unique symbol };
export type CapabilityVersion = string & { readonly __capabilityVersion: unique symbol };
export type SchemaRef = Hash & { readonly __schemaRef: unique symbol };
export type OwnerRef = Hash & { readonly __ownerRef: unique symbol };

export type ArtifactKind =
  | "nomination"
  | "identity"
  | "materialization"
  | "projection"
  | "rehydration"
  | "state"
  | "coarse"
  | "trigger"
  | "exact"
  | "action"
  | "strategy-plan";

export type DeclaredAbsenceReason =
  | "not-applicable"
  | "not-in-release"
  | "requires-future-extension";

export interface CapabilityRefV1 {
  readonly capabilityId: CapabilityId;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
  readonly interpreterHash: Hash;
  readonly ownerRef: OwnerRef;
}

export interface CapabilityIndexEntryV1 {
  readonly capabilityId: CapabilityId;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
  readonly interpreterHash: Hash;
  readonly dependencyIds: readonly CapabilityId[];
}

/**
 * The authoring side only describes a module and its declared dependencies.
 * It never carries a runtime callback, provider, socket, authority token or
 * protocol object.  The catalog compiler resolves the module to a closure.
 */
export interface CapabilityAuthoringDeclarationV1 {
  readonly capabilityId: CapabilityId;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
  readonly interpreterHash: Hash;
  readonly dependencyIds: readonly CapabilityId[];
  readonly artifactKinds: readonly ArtifactKind[];
  readonly modulePath: string;
  readonly exportName: string;
}

export interface ActionOwnerAuthoringDeclarationV1 {
  readonly ownerId: string;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
  readonly implementationHash: Hash;
  readonly actionKinds: readonly string[];
  readonly modulePath: string;
  readonly exportName: string;
}

export interface FamilyFactContractRefV1 {
  readonly factContractId: string;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
}

const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "nomination", "identity", "materialization", "projection", "rehydration",
  "state", "coarse", "trigger", "exact", "action", "strategy-plan",
]);

export function asCapabilityId(value: string, path = "capabilityId"): CapabilityId {
  assertNonEmptyString(value, path);
  if (!CAPABILITY_ID_RE.test(value)) throw new TypeError(`invalid capability id at ${path}`);
  return value as CapabilityId;
}

export function asCapabilityVersion(value: string, path = "version"): CapabilityVersion {
  assertNonEmptyString(value, path);
  if (!VERSION_RE.test(value)) throw new TypeError(`invalid capability version at ${path}`);
  return value as CapabilityVersion;
}

export function asSchemaRef(value: Hash, path = "schemaHash"): SchemaRef {
  assertHash(value, path);
  return value as SchemaRef;
}

export function asOwnerRef(value: Hash, path = "ownerRef"): OwnerRef {
  assertHash(value, path);
  return value as OwnerRef;
}

export function assertArtifactKind(value: unknown, path = "artifactKind"): asserts value is ArtifactKind {
  if (typeof value !== "string" || !ARTIFACT_KINDS.has(value as ArtifactKind)) {
    throw new TypeError(`unknown artifact kind at ${path}`);
  }
}

export function assertCapabilityDeclaration(value: unknown, path = "capability"): CapabilityAuthoringDeclarationV1 {
  const decoded = decodeExactObject(value, {
    capabilityId: (item, itemPath) => asCapabilityId(item as string, itemPath),
    version: (item, itemPath) => asCapabilityVersion(item as string, itemPath),
    schemaHash: (item, itemPath) => asSchemaRef(item as Hash, itemPath),
    interpreterHash: (item, itemPath) => assertHash(item, itemPath),
    dependencyIds: (item, itemPath) => fieldArray(item, (dependency, dependencyPath) => asCapabilityId(dependency as string, dependencyPath), itemPath),
    artifactKinds: (item, itemPath) => fieldArray(item, (kind, kindPath) => {
      assertArtifactKind(kind, kindPath);
      return kind;
    }, itemPath),
    modulePath: (item, itemPath) => assertNonEmptyString(item as string, itemPath),
    exportName: (item, itemPath) => assertNonEmptyString(item as string, itemPath),
  }, path);
  if (!decoded.modulePath.startsWith("./") && !decoded.modulePath.includes("/")) {
    throw new TypeError(`capability modulePath must be repository-relative at ${path}`);
  }
  if (new Set(decoded.dependencyIds).size !== decoded.dependencyIds.length) throw new TypeError(`duplicate capability dependency at ${path}`);
  if (new Set(decoded.artifactKinds).size !== decoded.artifactKinds.length) throw new TypeError(`duplicate capability artifact kind at ${path}`);
  return Object.freeze({ ...decoded, dependencyIds: Object.freeze([...decoded.dependencyIds].sort()), artifactKinds: Object.freeze([...decoded.artifactKinds].sort()) });
}

export function assertCapabilityIndexEntry(value: unknown, path = "capabilityIndexEntry"): CapabilityIndexEntryV1 {
  const decoded = decodeExactObject(value, {
    capabilityId: (item, itemPath) => asCapabilityId(item as string, itemPath),
    version: (item, itemPath) => asCapabilityVersion(item as string, itemPath),
    schemaHash: (item, itemPath) => asSchemaRef(item as Hash, itemPath),
    interpreterHash: (item, itemPath) => assertHash(item, itemPath),
    dependencyIds: (item, itemPath) => fieldArray(item, (dependency, dependencyPath) => asCapabilityId(dependency as string, dependencyPath), itemPath),
  }, path);
  if (new Set(decoded.dependencyIds).size !== decoded.dependencyIds.length) throw new TypeError(`duplicate capability dependency at ${path}`);
  if (decoded.dependencyIds.includes(decoded.capabilityId)) throw new TypeError(`capability self dependency at ${path}`);
  return Object.freeze({ ...decoded, dependencyIds: Object.freeze([...decoded.dependencyIds].sort()) });
}
