import { hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";

export interface DependencyLeafV1 {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly dependencyIds: readonly string[];
  readonly implementationClosureRoot: Hash;
}

export interface ArtifactDependencyClaimV1 {
  readonly artifactId: string;
  readonly requestedCapabilityIds: readonly string[];
  readonly requestedDependencyClosure: readonly string[];
  readonly requestedDependencyRoot: Hash;
}

export interface CatalogLeafV1 {
  readonly leafId: string;
  readonly definitionHash: Hash;
  readonly requestedDependencyClosure: readonly string[];
  readonly implementationClosureRoot: Hash;
}

export interface CatalogImpactV1 {
  readonly changedLeafIds: readonly string[];
  readonly affectedLeafIds: readonly string[];
  readonly reusableLeafIds: readonly string[];
  readonly beforeRoot: Hash;
  readonly afterRoot: Hash;
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort();
  if (sorted.some(value => typeof value !== "string" || value.length === 0)) throw new TypeError(`${label} contains empty value`);
  if (new Set(sorted).size !== sorted.length) throw new TypeError(`${label} contains duplicate value`);
  return Object.freeze(sorted);
}

export function dependencyLeafDigest(leaf: DependencyLeafV1): Hash {
  const dependencyIds = sortedUnique(leaf.dependencyIds, "dependencyIds");
  return hashDomain("aloha/capability-leaf/v1", {
    id: leaf.id,
    version: leaf.version,
    schemaHash: leaf.schemaHash,
    interpreterHash: leaf.interpreterHash,
    dependencyIds,
    implementationClosureRoot: leaf.implementationClosureRoot,
  });
}

export function dependencyCatalogRoot(leaves: readonly DependencyLeafV1[]): Hash {
  const digests = leaves.map(dependencyLeafDigest).sort();
  if (new Set(leaves.map(leaf => leaf.id)).size !== leaves.length) throw new TypeError("duplicate capability leaf id");
  return hashDomain("aloha/capability-catalog/v1", digests);
}

export function artifactDependencyRoot(
  requestedCapabilityIds: readonly string[],
  capabilityLeaves: readonly DependencyLeafV1[],
): { readonly requestedDependencyClosure: readonly string[]; readonly requestedDependencyRoot: Hash } {
  const byId = new Map(capabilityLeaves.map(leaf => [leaf.id, leaf] as const));
  const requested = sortedUnique(requestedCapabilityIds, "requestedCapabilityIds");
  const closure = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (closure.has(id)) return;
    const leaf = byId.get(id);
    if (leaf === undefined) throw new TypeError(`unknown capability dependency ${id}`);
    if (visiting.has(id)) throw new TypeError(`capability dependency cycle ${id}`);
    visiting.add(id);
    for (const dependencyId of leaf.dependencyIds) visit(dependencyId);
    visiting.delete(id);
    closure.add(id);
  };
  for (const id of requested) visit(id);
  const requestedDependencyClosure = sortedUnique([...closure], "requestedDependencyClosure");
  const requestedDependencyRoot = hashDomain("aloha/requested-capability-closure/v1", requestedDependencyClosure.map(id => {
    const leaf = byId.get(id)!;
    return { id, digest: dependencyLeafDigest(leaf) };
  }));
  return Object.freeze({ requestedDependencyClosure, requestedDependencyRoot });
}

export function catalogLeafDigest(leaf: CatalogLeafV1): Hash {
  return hashDomain("aloha/definition-catalog-leaf/v1", {
    leafId: leaf.leafId,
    definitionHash: leaf.definitionHash,
    requestedDependencyClosure: sortedUnique(leaf.requestedDependencyClosure, "requestedDependencyClosure"),
    implementationClosureRoot: leaf.implementationClosureRoot,
  });
}

export function definitionCatalogRoot(leaves: readonly CatalogLeafV1[]): Hash {
  const ids = leaves.map(leaf => leaf.leafId);
  if (new Set(ids).size !== ids.length) throw new TypeError("duplicate definition catalog leaf id");
  return hashDomain("aloha/definition-catalog/v1", leaves.map(catalogLeafDigest).sort());
}

export function computeCatalogImpact(before: readonly CatalogLeafV1[], after: readonly CatalogLeafV1[]): CatalogImpactV1 {
  const beforeById = new Map(before.map(leaf => [leaf.leafId, catalogLeafDigest(leaf)] as const));
  const afterById = new Map(after.map(leaf => [leaf.leafId, catalogLeafDigest(leaf)] as const));
  if (beforeById.size !== before.length || afterById.size !== after.length) throw new TypeError("duplicate definition catalog leaf id");
  const changedLeafIds = [...afterById.keys()].filter(id => beforeById.get(id) !== afterById.get(id)).sort();
  const affectedLeafIds = [...after].filter(leaf =>
    changedLeafIds.some(changed => leaf.requestedDependencyClosure.includes(changed)) || changedLeafIds.includes(leaf.leafId),
  ).map(leaf => leaf.leafId).sort();
  const reusableLeafIds = [...afterById.keys()].filter(id => !affectedLeafIds.includes(id)).sort();
  return Object.freeze({
    changedLeafIds: Object.freeze(changedLeafIds),
    affectedLeafIds: Object.freeze(affectedLeafIds),
    reusableLeafIds: Object.freeze(reusableLeafIds),
    beforeRoot: definitionCatalogRoot(before),
    afterRoot: definitionCatalogRoot(after),
  });
}
