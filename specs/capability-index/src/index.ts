import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface CapabilityIndexEntryV1 {
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly dependencyIds: readonly string[];
  /** Build-time direct static root; never exposed by runtime refs. */
  readonly modulePath: string;
  readonly exportName: string;
}

export interface CapabilityIndexV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly CapabilityIndexEntryV1[];
  readonly capabilityIndexRoot: Hash;
}

const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function normalizedEntry(value: unknown, path = "capabilityIndexEntry"): CapabilityIndexEntryV1 {
  const decoded = decodeExactObject(value, {
    capabilityId: (item, itemPath) => {
      const result = assertNonEmptyString(item, itemPath);
      if (!CAPABILITY_ID_RE.test(result)) throw new TypeError(`invalid capability id at ${itemPath}`);
      return result;
    },
    version: (item, itemPath) => {
      const result = assertNonEmptyString(item, itemPath);
      if (!VERSION_RE.test(result)) throw new TypeError(`invalid capability version at ${itemPath}`);
      return result;
    },
    schemaHash: (item, itemPath) => assertHash(item, itemPath),
    interpreterHash: (item, itemPath) => assertHash(item, itemPath),
    dependencyIds: (item, itemPath) => fieldArray(item, (dependency, dependencyPath) => {
      const result = assertNonEmptyString(dependency, dependencyPath);
      if (!CAPABILITY_ID_RE.test(result)) throw new TypeError(`invalid dependency id at ${dependencyPath}`);
      return result;
    }, itemPath),
    modulePath: (item, itemPath) => {
      const result = assertNonEmptyString(item, itemPath);
      if (result.startsWith(".") || result.startsWith("/") || result.startsWith("@") || result.includes("..") || result.includes("\\") || result.includes("?") || result.includes("#")) throw new TypeError(`non-static module path at ${itemPath}`);
      return result;
    },
    exportName: (item, itemPath) => {
      const result = assertNonEmptyString(item, itemPath);
      if (!/^[$A-Z_a-z][$\w]*$/.test(result)) throw new TypeError(`non-static export name at ${itemPath}`);
      return result;
    },
  }, path);
  const dependencies = [...decoded.dependencyIds].sort();
  if (new Set(dependencies).size !== dependencies.length) throw new TypeError(`duplicate dependency at ${path}`);
  if (dependencies.includes(decoded.capabilityId)) throw new TypeError(`self dependency at ${path}`);
  return Object.freeze({ ...decoded, dependencyIds: Object.freeze(dependencies) });
}

function assertAcyclic(entries: readonly CapabilityIndexEntryV1[]): void {
  const byId = new Map(entries.map(entry => [entry.capabilityId, entry] as const));
  if (byId.size !== entries.length) throw new TypeError("duplicate capability id");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`capability dependency cycle ${id}`);
    const entry = byId.get(id);
    if (entry === undefined) throw new TypeError(`unknown capability dependency ${id}`);
    visiting.add(id);
    for (const dependencyId of entry.dependencyIds) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const entry of entries) visit(entry.capabilityId);
}

export function sealCapabilityIndex(entries: readonly CapabilityIndexEntryV1[]): CapabilityIndexV1 {
  const normalized = entries.map((entry, index) => normalizedEntry(entry, `capabilityIndex.entries[${index}]`));
  const sorted = [...normalized].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  assertAcyclic(sorted);
  return deepFreeze({
    schemaVersion: 1 as const,
    entries: Object.freeze(sorted),
    capabilityIndexRoot: hashDomain("aloha/capability-index/v1", sorted),
  });
}

export function decodeCapabilityIndex(value: unknown, path = "capabilityIndex"): CapabilityIndexV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, itemPath) => {
      if (item !== 1) throw new TypeError(`unsupported capability index schema at ${itemPath}`);
      return 1 as const;
    },
    entries: (item, itemPath) => fieldArray(item, (entry, entryPath) => normalizedEntry(entry, entryPath), itemPath),
    capabilityIndexRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const sealed = sealCapabilityIndex(decoded.entries);
  if (sealed.capabilityIndexRoot !== decoded.capabilityIndexRoot) throw new TypeError("capability index root mismatch");
  return sealed;
}

export function capabilityIndexEntry(
  index: CapabilityIndexV1,
  capabilityId: string,
): CapabilityIndexEntryV1 | null {
  const found = index.entries.find(entry => entry.capabilityId === capabilityId);
  return found ?? null;
}
