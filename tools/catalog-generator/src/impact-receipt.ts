import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  dependencyCatalogRoot,
  dependencyLeafDigest,
  type DependencyLeafV1,
} from "../../../packages/artifact-fingerprint/src/pure/index.ts";

export interface CatalogImpactArtifactFactV1 {
  readonly artifactId: string;
  readonly artifactKind: "family" | "strategy";
  readonly familyId: string | null;
  readonly definitionCatalogLeafDigest: Hash;
  readonly requestedDependencyClosure: readonly string[];
  readonly requestedDependencyRoot: Hash;
  readonly memoRoot: Hash;
  /** Proposal identities only. Qualification exists solely in an externally
   * signed RuntimeReleaseBinding nomination qualification entry. */
  readonly nominationProposalLeafDigests: readonly Hash[];
}

export interface CatalogImpactReusableArtifactFactV1 {
  readonly artifactId: string;
  readonly artifactKind: "family" | "strategy";
  readonly familyId: string | null;
  readonly memoRoot: Hash;
  readonly nominationProposalLeafDigests: readonly Hash[];
}

export interface CatalogImpactSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.catalog-impact-snapshot";
  readonly definitionCatalogRoot: Hash;
  readonly capabilityCatalogRoot: Hash;
  readonly capabilities: readonly DependencyLeafV1[];
  readonly artifacts: readonly CatalogImpactArtifactFactV1[];
  readonly snapshotRoot: Hash;
}

export type CatalogImpactPriorOriginV1 =
  | "aloha.greenfield-genesis/v1"
  | "aloha.catalog-impact-advance/v1";

export interface CatalogImpactPriorV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.catalog-impact-prior";
  readonly origin: CatalogImpactPriorOriginV1;
  readonly pinnedSnapshotRoot: Hash;
  readonly snapshot: CatalogImpactSnapshotV1;
  readonly priorIdentityRoot: Hash;
}

export interface CatalogImpactReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.catalog-impact-receipt";
  readonly beforeSnapshotRoot: Hash;
  readonly afterSnapshotRoot: Hash;
  readonly beforeDefinitionCatalogRoot: Hash;
  readonly afterDefinitionCatalogRoot: Hash;
  readonly beforeCapabilityCatalogRoot: Hash;
  readonly afterCapabilityCatalogRoot: Hash;
  readonly changedCapabilityIds: readonly string[];
  readonly changedCapabilityClosure: readonly string[];
  readonly affectedArtifactIds: readonly string[];
  readonly affectedFamilyIds: readonly string[];
  /** Exact ownership-preserving projection. Never flatten these facts into a
   * global root set: equal roots do not prove equal artifact ownership. */
  readonly reusableArtifacts: readonly CatalogImpactReusableArtifactFactV1[];
  readonly receiptRoot: Hash;
}

type CodecInput = string | Uint8Array | object;

function parseInput(value: CodecInput): unknown {
  return typeof value === "string" || value instanceof Uint8Array
    ? decodeCanonicalJson(value)
    : value;
}

function sortedUnique(values: readonly string[], path: string): readonly string[] {
  const sorted = [...values].map((value, index) => assertNonEmptyString(value, `${path}[${index}]`)).sort();
  if (new Set(sorted).size !== sorted.length) throw new TypeError(`${path} contains duplicate values`);
  return Object.freeze(sorted);
}

function hashArray(values: readonly unknown[], domain: string): Hash {
  return hashDomain(domain, values);
}

function decodeCapability(value: unknown, path: string): DependencyLeafV1 {
  assertExactKeys(value, ["id", "version", "schemaHash", "interpreterHash", "dependencyIds", "implementationClosureRoot"], path);
  const item = value as Record<string, unknown>;
  return Object.freeze({
    id: assertNonEmptyString(item.id, `${path}.id`),
    version: assertNonEmptyString(item.version, `${path}.version`),
    schemaHash: assertHash(item.schemaHash, `${path}.schemaHash`),
    interpreterHash: assertHash(item.interpreterHash, `${path}.interpreterHash`),
    dependencyIds: sortedUnique(fieldArray(item.dependencyIds, (entry, entryPath) => assertNonEmptyString(entry, entryPath), `${path}.dependencyIds`), `${path}.dependencyIds`),
    implementationClosureRoot: assertHash(item.implementationClosureRoot, `${path}.implementationClosureRoot`),
  });
}

function requestedDependencyRoot(
  closure: readonly string[],
  capabilities: ReadonlyMap<string, DependencyLeafV1>,
  path: string,
): Hash {
  for (const id of closure) {
    const leaf = capabilities.get(id);
    if (leaf === undefined) throw new TypeError(`unknown requested capability ${id} at ${path}`);
    for (const dependencyId of leaf.dependencyIds) {
      if (!closure.includes(dependencyId)) throw new TypeError(`requested dependency closure omits ${dependencyId} at ${path}`);
    }
  }
  return hashDomain("aloha/requested-capability-closure/v1", closure.map(id => ({
    id,
    digest: dependencyLeafDigest(capabilities.get(id)!),
  })));
}

function decodeArtifact(
  value: unknown,
  capabilities: ReadonlyMap<string, DependencyLeafV1>,
  path: string,
): CatalogImpactArtifactFactV1 {
  assertExactKeys(value, ["artifactId", "artifactKind", "familyId", "definitionCatalogLeafDigest", "requestedDependencyClosure", "requestedDependencyRoot", "memoRoot", "nominationProposalLeafDigests"], path);
  const item = value as Record<string, unknown>;
  const artifactKind = item.artifactKind;
  if (artifactKind !== "family" && artifactKind !== "strategy") throw new TypeError(`invalid artifact kind at ${path}.artifactKind`);
  const familyId = item.familyId === null ? null : assertNonEmptyString(item.familyId, `${path}.familyId`);
  if ((artifactKind === "family") !== (familyId !== null)) throw new TypeError(`artifact Family identity mismatch at ${path}`);
  const artifactId = assertNonEmptyString(item.artifactId, `${path}.artifactId`);
  if (artifactKind === "family" ? artifactId !== `family:${familyId}` : !artifactId.startsWith("strategy:")) {
    throw new TypeError(`artifact id/kind mismatch at ${path}`);
  }
  const requestedDependencyClosure = sortedUnique(
    fieldArray(item.requestedDependencyClosure, (entry, entryPath) => assertNonEmptyString(entry, entryPath), `${path}.requestedDependencyClosure`),
    `${path}.requestedDependencyClosure`,
  );
  const requestedRoot = assertHash(item.requestedDependencyRoot, `${path}.requestedDependencyRoot`);
  if (requestedRoot !== requestedDependencyRoot(requestedDependencyClosure, capabilities, path)) {
    throw new TypeError(`requested dependency root mismatch at ${path}`);
  }
  const nominationProposalLeafDigests = sortedUnique(
    fieldArray(item.nominationProposalLeafDigests, (entry, entryPath) => assertHash(entry, entryPath), `${path}.nominationProposalLeafDigests`),
    `${path}.nominationProposalLeafDigests`,
  ) as readonly Hash[];
  if (artifactKind === "strategy" && nominationProposalLeafDigests.length !== 0) {
    throw new TypeError(`Strategy artifact carries nomination proposals at ${path}`);
  }
  return Object.freeze({
    artifactId,
    artifactKind,
    familyId,
    definitionCatalogLeafDigest: assertHash(item.definitionCatalogLeafDigest, `${path}.definitionCatalogLeafDigest`),
    requestedDependencyClosure,
    requestedDependencyRoot: requestedRoot,
    memoRoot: assertHash(item.memoRoot, `${path}.memoRoot`),
    nominationProposalLeafDigests,
  });
}

function reusableArtifactFact(value: CatalogImpactArtifactFactV1): CatalogImpactReusableArtifactFactV1 {
  return Object.freeze({
    artifactId: value.artifactId,
    artifactKind: value.artifactKind,
    familyId: value.familyId,
    memoRoot: value.memoRoot,
    nominationProposalLeafDigests: value.nominationProposalLeafDigests,
  });
}

function decodeReusableArtifact(value: unknown, path: string): CatalogImpactReusableArtifactFactV1 {
  assertExactKeys(value, ["artifactId", "artifactKind", "familyId", "memoRoot", "nominationProposalLeafDigests"], path);
  const item = value as Record<string, unknown>;
  const artifactKind = item.artifactKind;
  if (artifactKind !== "family" && artifactKind !== "strategy") throw new TypeError(`invalid reusable artifact kind at ${path}.artifactKind`);
  const familyId = item.familyId === null ? null : assertNonEmptyString(item.familyId, `${path}.familyId`);
  if ((artifactKind === "family") !== (familyId !== null)) throw new TypeError(`reusable artifact Family identity mismatch at ${path}`);
  const artifactId = assertNonEmptyString(item.artifactId, `${path}.artifactId`);
  if (artifactKind === "family" ? artifactId !== `family:${familyId}` : !artifactId.startsWith("strategy:")) {
    throw new TypeError(`reusable artifact id/kind mismatch at ${path}`);
  }
  const nominationProposalLeafDigests = sortedUnique(
    fieldArray(item.nominationProposalLeafDigests, (entry, entryPath) => assertHash(entry, entryPath), `${path}.nominationProposalLeafDigests`),
    `${path}.nominationProposalLeafDigests`,
  ) as readonly Hash[];
  if (artifactKind === "strategy" && nominationProposalLeafDigests.length !== 0) {
    throw new TypeError(`reusable Strategy artifact carries nomination proposals at ${path}`);
  }
  return Object.freeze({
    artifactId,
    artifactKind,
    familyId,
    memoRoot: assertHash(item.memoRoot, `${path}.memoRoot`),
    nominationProposalLeafDigests,
  });
}

function snapshotRoot(value: Omit<CatalogImpactSnapshotV1, "snapshotRoot">): Hash {
  return hashDomain("aloha/catalog-impact-snapshot/v1", value);
}

export function sealCatalogImpactSnapshotV1(input: {
  readonly definitionCatalogRoot: Hash;
  readonly capabilities: readonly DependencyLeafV1[];
  readonly artifacts: readonly CatalogImpactArtifactFactV1[];
}): CatalogImpactSnapshotV1 {
  const capabilities = input.capabilities.map((value, index) => decodeCapability(value, `catalogImpactSnapshot.capabilities[${index}]`))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(capabilities.map(value => value.id)).size !== capabilities.length) throw new TypeError("duplicate catalog impact capability id");
  const capabilityById = new Map(capabilities.map(value => [value.id, value] as const));
  for (const capability of capabilities) for (const dependencyId of capability.dependencyIds) {
    if (!capabilityById.has(dependencyId)) throw new TypeError(`unknown catalog impact capability dependency ${dependencyId}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`catalog impact capability dependency cycle ${id}`);
    visiting.add(id);
    for (const dependencyId of capabilityById.get(id)!.dependencyIds) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const capability of capabilities) visit(capability.id);
  const artifacts = input.artifacts.map((value, index) => decodeArtifact(value, capabilityById, `catalogImpactSnapshot.artifacts[${index}]`))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(artifacts.map(value => value.artifactId)).size !== artifacts.length) throw new TypeError("duplicate catalog impact artifact id");
  const definitionCatalogRoot = assertHash(input.definitionCatalogRoot, "catalogImpactSnapshot.definitionCatalogRoot");
  const expectedDefinitionRoot = hashArray(artifacts.map(value => value.definitionCatalogLeafDigest).sort(), "aloha/definition-catalog/v1");
  if (definitionCatalogRoot !== expectedDefinitionRoot) throw new TypeError("catalog impact definition root mismatch");
  const withoutRoot = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.catalog-impact-snapshot" as const,
    definitionCatalogRoot,
    capabilityCatalogRoot: dependencyCatalogRoot(capabilities),
    capabilities: Object.freeze(capabilities),
    artifacts: Object.freeze(artifacts),
  });
  return deepFreeze({ ...withoutRoot, snapshotRoot: snapshotRoot(withoutRoot) });
}

export function decodeCatalogImpactSnapshotV1(value: CodecInput): CatalogImpactSnapshotV1 {
  const parsed = parseInput(value);
  assertExactKeys(parsed, ["schemaVersion", "kind", "definitionCatalogRoot", "capabilityCatalogRoot", "capabilities", "artifacts", "snapshotRoot"], "catalogImpactSnapshot");
  const item = parsed as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.kind !== "aloha.catalog-impact-snapshot") throw new TypeError("unsupported catalog impact snapshot");
  const capabilities = fieldArray(item.capabilities, decodeCapability, "catalogImpactSnapshot.capabilities");
  const provisional = new Map(capabilities.map(value => [value.id, value] as const));
  const artifacts = fieldArray(item.artifacts, (entry, path) => decodeArtifact(entry, provisional, path), "catalogImpactSnapshot.artifacts");
  const sealed = sealCatalogImpactSnapshotV1({
    definitionCatalogRoot: assertHash(item.definitionCatalogRoot, "catalogImpactSnapshot.definitionCatalogRoot"),
    capabilities,
    artifacts,
  });
  if (assertHash(item.capabilityCatalogRoot, "catalogImpactSnapshot.capabilityCatalogRoot") !== sealed.capabilityCatalogRoot) throw new TypeError("catalog impact capability root mismatch");
  if (assertHash(item.snapshotRoot, "catalogImpactSnapshot.snapshotRoot") !== sealed.snapshotRoot) throw new TypeError("catalog impact snapshot root mismatch");
  return sealed;
}

export function encodeCatalogImpactSnapshotV1(value: CatalogImpactSnapshotV1): Uint8Array {
  return encodeCanonicalBytes(decodeCatalogImpactSnapshotV1(value));
}

/** Exact Family ownership projection bound by the external deployment fact. */
export function catalogImpactFamilyProposalOwnershipRootV1(value: CatalogImpactSnapshotV1): Hash {
  const snapshot = decodeCatalogImpactSnapshotV1(value);
  return hashDomain("aloha/catalog-impact-family-proposal-ownership/v1", snapshot.artifacts
    .filter(artifact => artifact.artifactKind === "family")
    .map(artifact => ({
      artifactId: artifact.artifactId,
      familyId: artifact.familyId,
      definitionCatalogLeafDigest: artifact.definitionCatalogLeafDigest,
      requestedDependencyRoot: artifact.requestedDependencyRoot,
      memoRoot: artifact.memoRoot,
      nominationProposalLeafDigests: artifact.nominationProposalLeafDigests,
    })));
}

function priorIdentityRoot(value: Omit<CatalogImpactPriorV1, "priorIdentityRoot">): Hash {
  return hashDomain("aloha/catalog-impact-prior/v1", value);
}

export function sealCatalogImpactPriorV1(
  origin: CatalogImpactPriorOriginV1,
  snapshotInput: CatalogImpactSnapshotV1,
): CatalogImpactPriorV1 {
  if (origin !== "aloha.greenfield-genesis/v1" && origin !== "aloha.catalog-impact-advance/v1") {
    throw new TypeError("invalid catalog impact prior origin");
  }
  const snapshot = decodeCatalogImpactSnapshotV1(snapshotInput);
  if (origin === "aloha.greenfield-genesis/v1" && (snapshot.capabilities.length !== 0 || snapshot.artifacts.length !== 0)) {
    throw new TypeError("catalog impact genesis prior must be the explicit empty greenfield snapshot");
  }
  const withoutRoot = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.catalog-impact-prior" as const,
    origin,
    pinnedSnapshotRoot: snapshot.snapshotRoot,
    snapshot,
  });
  return deepFreeze({ ...withoutRoot, priorIdentityRoot: priorIdentityRoot(withoutRoot) });
}

export function catalogImpactGenesisPriorV1(): CatalogImpactPriorV1 {
  const snapshot = sealCatalogImpactSnapshotV1({
    definitionCatalogRoot: hashDomain("aloha/definition-catalog/v1", []),
    capabilities: [],
    artifacts: [],
  });
  return sealCatalogImpactPriorV1("aloha.greenfield-genesis/v1", snapshot);
}

export function decodeCatalogImpactPriorV1(value: CodecInput): CatalogImpactPriorV1 {
  const parsed = parseInput(value);
  assertExactKeys(parsed, ["schemaVersion", "kind", "origin", "pinnedSnapshotRoot", "snapshot", "priorIdentityRoot"], "catalogImpactPrior");
  const item = parsed as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.kind !== "aloha.catalog-impact-prior") throw new TypeError("unsupported catalog impact prior");
  const origin = item.origin;
  if (origin !== "aloha.greenfield-genesis/v1" && origin !== "aloha.catalog-impact-advance/v1") throw new TypeError("invalid catalog impact prior origin");
  const sealed = sealCatalogImpactPriorV1(origin, decodeCatalogImpactSnapshotV1(item.snapshot as object));
  if (assertHash(item.pinnedSnapshotRoot, "catalogImpactPrior.pinnedSnapshotRoot") !== sealed.pinnedSnapshotRoot) throw new TypeError("catalog impact prior pin mismatch");
  if (assertHash(item.priorIdentityRoot, "catalogImpactPrior.priorIdentityRoot") !== sealed.priorIdentityRoot) throw new TypeError("catalog impact prior identity root mismatch");
  return sealed;
}

export function encodeCatalogImpactPriorV1(value: CatalogImpactPriorV1): Uint8Array {
  return encodeCanonicalBytes(decodeCatalogImpactPriorV1(value));
}

function changedCapabilityClosure(
  changed: readonly string[],
  before: CatalogImpactSnapshotV1,
  after: CatalogImpactSnapshotV1,
): readonly string[] {
  const affected = new Set(changed);
  const leaves = [...before.capabilities, ...after.capabilities];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const leaf of leaves) {
      if (!affected.has(leaf.id) && leaf.dependencyIds.some(id => affected.has(id))) {
        affected.add(leaf.id);
        expanded = true;
      }
    }
  }
  return Object.freeze([...affected].sort());
}

function receiptRoot(value: Omit<CatalogImpactReceiptV1, "receiptRoot">): Hash {
  return hashDomain("aloha/catalog-impact-receipt/v1", value);
}

export function createCatalogImpactReceiptV1(input: {
  readonly pinnedBeforeSnapshotRoot: Hash;
  readonly before: CatalogImpactSnapshotV1;
  readonly after: CatalogImpactSnapshotV1;
}): CatalogImpactReceiptV1 {
  const before = decodeCatalogImpactSnapshotV1(input.before);
  const after = decodeCatalogImpactSnapshotV1(input.after);
  if (assertHash(input.pinnedBeforeSnapshotRoot, "pinnedBeforeSnapshotRoot") !== before.snapshotRoot) {
    throw new TypeError("pinned prior catalog impact snapshot root mismatch");
  }
  const beforeCapabilities = new Map(before.capabilities.map(value => [value.id, dependencyLeafDigest(value)] as const));
  const afterCapabilities = new Map(after.capabilities.map(value => [value.id, dependencyLeafDigest(value)] as const));
  const capabilityIds = new Set([...beforeCapabilities.keys(), ...afterCapabilities.keys()]);
  const changedCapabilityIds = [...capabilityIds].filter(id => beforeCapabilities.get(id) !== afterCapabilities.get(id)).sort();
  const capabilityClosure = changedCapabilityClosure(changedCapabilityIds, before, after);
  const beforeArtifacts = new Map(before.artifacts.map(value => [value.artifactId, value] as const));
  const afterArtifacts = new Map(after.artifacts.map(value => [value.artifactId, value] as const));
  const artifactIds = new Set([...beforeArtifacts.keys(), ...afterArtifacts.keys()]);
  const affectedArtifactIds = [...artifactIds].filter(id => {
    const prior = beforeArtifacts.get(id);
    const current = afterArtifacts.get(id);
    if (prior === undefined || current === undefined) return true;
    if (Buffer.from(encodeCanonicalBytes(prior)).compare(Buffer.from(encodeCanonicalBytes(current))) !== 0) return true;
    return current.requestedDependencyClosure.some(capabilityId => capabilityClosure.includes(capabilityId));
  }).sort();
  const affected = new Set(affectedArtifactIds);
  const reusable = after.artifacts.filter(value => !affected.has(value.artifactId));
  const affectedFamilyIds = [...new Set(affectedArtifactIds.flatMap(id => {
    const artifact = afterArtifacts.get(id) ?? beforeArtifacts.get(id);
    return artifact?.familyId === null || artifact?.familyId === undefined ? [] : [artifact.familyId];
  }))].sort();
  const withoutRoot = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.catalog-impact-receipt" as const,
    beforeSnapshotRoot: before.snapshotRoot,
    afterSnapshotRoot: after.snapshotRoot,
    beforeDefinitionCatalogRoot: before.definitionCatalogRoot,
    afterDefinitionCatalogRoot: after.definitionCatalogRoot,
    beforeCapabilityCatalogRoot: before.capabilityCatalogRoot,
    afterCapabilityCatalogRoot: after.capabilityCatalogRoot,
    changedCapabilityIds: Object.freeze(changedCapabilityIds),
    changedCapabilityClosure: capabilityClosure,
    affectedArtifactIds: Object.freeze(affectedArtifactIds),
    affectedFamilyIds: Object.freeze(affectedFamilyIds),
    reusableArtifacts: Object.freeze(reusable.map(reusableArtifactFact)),
  });
  return deepFreeze({ ...withoutRoot, receiptRoot: receiptRoot(withoutRoot) });
}

function decodeStringArray(value: unknown, path: string): readonly string[] {
  return sortedUnique(fieldArray(value, (entry, entryPath) => assertNonEmptyString(entry, entryPath), path), path);
}

export function decodeCatalogImpactReceiptV1(value: CodecInput): CatalogImpactReceiptV1 {
  const parsed = parseInput(value);
  assertExactKeys(parsed, [
    "schemaVersion", "kind", "beforeSnapshotRoot", "afterSnapshotRoot", "beforeDefinitionCatalogRoot",
    "afterDefinitionCatalogRoot", "beforeCapabilityCatalogRoot", "afterCapabilityCatalogRoot", "changedCapabilityIds",
    "changedCapabilityClosure", "affectedArtifactIds", "affectedFamilyIds", "reusableArtifacts", "receiptRoot",
  ], "catalogImpactReceipt");
  const item = parsed as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.kind !== "aloha.catalog-impact-receipt") throw new TypeError("unsupported catalog impact receipt");
  const withoutRoot = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.catalog-impact-receipt" as const,
    beforeSnapshotRoot: assertHash(item.beforeSnapshotRoot, "catalogImpactReceipt.beforeSnapshotRoot"),
    afterSnapshotRoot: assertHash(item.afterSnapshotRoot, "catalogImpactReceipt.afterSnapshotRoot"),
    beforeDefinitionCatalogRoot: assertHash(item.beforeDefinitionCatalogRoot, "catalogImpactReceipt.beforeDefinitionCatalogRoot"),
    afterDefinitionCatalogRoot: assertHash(item.afterDefinitionCatalogRoot, "catalogImpactReceipt.afterDefinitionCatalogRoot"),
    beforeCapabilityCatalogRoot: assertHash(item.beforeCapabilityCatalogRoot, "catalogImpactReceipt.beforeCapabilityCatalogRoot"),
    afterCapabilityCatalogRoot: assertHash(item.afterCapabilityCatalogRoot, "catalogImpactReceipt.afterCapabilityCatalogRoot"),
    changedCapabilityIds: decodeStringArray(item.changedCapabilityIds, "catalogImpactReceipt.changedCapabilityIds"),
    changedCapabilityClosure: decodeStringArray(item.changedCapabilityClosure, "catalogImpactReceipt.changedCapabilityClosure"),
    affectedArtifactIds: decodeStringArray(item.affectedArtifactIds, "catalogImpactReceipt.affectedArtifactIds"),
    affectedFamilyIds: decodeStringArray(item.affectedFamilyIds, "catalogImpactReceipt.affectedFamilyIds"),
    reusableArtifacts: Object.freeze([...fieldArray(item.reusableArtifacts, decodeReusableArtifact, "catalogImpactReceipt.reusableArtifacts")]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))),
  });
  if (new Set(withoutRoot.reusableArtifacts.map(value => value.artifactId)).size !== withoutRoot.reusableArtifacts.length) {
    throw new TypeError("catalogImpactReceipt.reusableArtifacts contains duplicate artifact ids");
  }
  const result = deepFreeze({ ...withoutRoot, receiptRoot: assertHash(item.receiptRoot, "catalogImpactReceipt.receiptRoot") });
  if (result.receiptRoot !== receiptRoot(withoutRoot)) throw new TypeError("catalog impact receipt root mismatch");
  return result;
}

export function encodeCatalogImpactReceiptV1(value: CatalogImpactReceiptV1): Uint8Array {
  return encodeCanonicalBytes(decodeCatalogImpactReceiptV1(value));
}

export function verifyCatalogImpactReceiptV1(input: {
  readonly receipt: CodecInput;
  readonly pinnedBeforeSnapshotRoot: Hash;
  readonly before: CatalogImpactSnapshotV1;
  readonly after: CatalogImpactSnapshotV1;
}): CatalogImpactReceiptV1 {
  const decoded = decodeCatalogImpactReceiptV1(input.receipt);
  const expected = createCatalogImpactReceiptV1(input);
  if (Buffer.from(encodeCatalogImpactReceiptV1(decoded)).compare(Buffer.from(encodeCatalogImpactReceiptV1(expected))) !== 0) {
    throw new TypeError("catalog impact receipt does not match pinned generator facts");
  }
  return expected;
}
