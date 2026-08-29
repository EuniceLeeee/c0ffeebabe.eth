import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  defineSchema,
  fieldArray,
  hashDomain,
  objectSchema,
  arraySchema,
  literalSchema,
  type CodecSchema,
  type Hash,
  type Infer,
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

/**
 * Proposed capability refs are a separate, unqualified build input from the
 * authoring/index view. The catalog compiler may consume these refs, but it
 * may not derive their ownerRef from a Family definition or from the local
 * capability index. The final runtime release binding signs and exact-joins
 * this proposed set root; this envelope itself grants no authority.
 */
const PROPOSED_CAPABILITY_SET_DOMAIN = "aloha/proposed-capability-set/v1";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function releaseStringSchema(
  kind: string,
  pattern: RegExp,
): CodecSchema<string> {
  return defineSchema({ kind, pattern: pattern.source }, (value, path = "$") => {
    if (typeof value !== "string" || value.length === 0 || !pattern.test(value)) {
      throw new TypeError(`invalid release-qualified capability string at ${path}`);
    }
    return value;
  });
}

const releaseQualifiedCapabilityRefSchema = objectSchema({
  capabilityId: releaseStringSchema("release-qualified-capability-id", CAPABILITY_ID_RE),
  version: releaseStringSchema("release-qualified-capability-version", VERSION_RE),
  schemaHash: defineSchema({ kind: "release-qualified-capability-schema-hash" }, (value, path = "$") => assertHash(value, path)),
  interpreterHash: defineSchema({ kind: "release-qualified-capability-interpreter-hash" }, (value, path = "$") => assertHash(value, path)),
  ownerRef: defineSchema({ kind: "release-qualified-capability-owner-ref" }, (value, path = "$") => assertHash(value, path)),
});

export type ReleaseQualifiedCapabilityRefV1 = Infer<typeof releaseQualifiedCapabilityRefSchema>;

export interface ReleaseQualifiedCapabilitySetV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.proposed-capability-set";
  readonly refs: readonly ReleaseQualifiedCapabilityRefV1[];
  readonly root: Hash;
}

const releaseQualifiedCapabilitySetSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.proposed-capability-set"),
  refs: arraySchema(releaseQualifiedCapabilityRefSchema),
  root: defineSchema({ kind: "release-qualified-capability-set-root" }, (value, path = "$") => assertHash(value, path)),
});

function normalizeReleaseQualifiedCapabilityRef(
  value: unknown,
  path = "releaseQualifiedCapabilityRef",
): ReleaseQualifiedCapabilityRefV1 {
  const decoded = releaseQualifiedCapabilityRefSchema.decode(value, path);
  for (const [field, hash] of [
    ["schemaHash", decoded.schemaHash],
    ["interpreterHash", decoded.interpreterHash],
    ["ownerRef", decoded.ownerRef],
  ] as const) {
    if (hash === ZERO_HASH) throw new TypeError(`release-qualified capability ${field} must be non-zero at ${path}`);
  }
  return deepFreeze(decoded);
}

export function decodeReleaseQualifiedCapabilityRefV1(
  value: unknown,
  path = "releaseQualifiedCapabilityRef",
): ReleaseQualifiedCapabilityRefV1 {
  return normalizeReleaseQualifiedCapabilityRef(value, path);
}

function sortedReleaseQualifiedCapabilityRefs(
  refs: readonly ReleaseQualifiedCapabilityRefV1[],
): readonly ReleaseQualifiedCapabilityRefV1[] {
  const normalized = refs.map((ref, index) => normalizeReleaseQualifiedCapabilityRef(ref, `releaseQualifiedCapabilityRefs[${index}]`));
  const sorted = [...normalized].sort((left, right) => {
    const byId = left.capabilityId.localeCompare(right.capabilityId);
    if (byId !== 0) return byId;
    return left.version.localeCompare(right.version);
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.capabilityId === current.capabilityId && previous.version === current.version) {
      throw new TypeError("release-qualified capability refs must be unique by capabilityId/version");
    }
  }
  return Object.freeze(sorted);
}

export function hashReleaseQualifiedCapabilityRefV1(
  value: ReleaseQualifiedCapabilityRefV1,
): Hash {
  return hashDomain("aloha/proposed-capability-ref/v1", normalizeReleaseQualifiedCapabilityRef(value));
}

export function hashReleaseQualifiedCapabilityRefsRoot(
  refs: readonly ReleaseQualifiedCapabilityRefV1[],
): Hash {
  const normalized = sortedReleaseQualifiedCapabilityRefs(refs);
  return hashDomain(PROPOSED_CAPABILITY_SET_DOMAIN, {
    refs: normalized,
    leafRoots: normalized.map(hashReleaseQualifiedCapabilityRefV1),
  });
}

export function sealReleaseQualifiedCapabilitySetV1(
  refs: readonly ReleaseQualifiedCapabilityRefV1[],
): ReleaseQualifiedCapabilitySetV1 {
  const normalized = sortedReleaseQualifiedCapabilityRefs(refs);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.proposed-capability-set" as const,
    refs: normalized,
    root: hashReleaseQualifiedCapabilityRefsRoot(normalized),
  });
}

export function decodeReleaseQualifiedCapabilitySetV1(value: unknown): ReleaseQualifiedCapabilitySetV1 {
  const decoded = releaseQualifiedCapabilitySetSchema.decode(value);
  const sealed = sealReleaseQualifiedCapabilitySetV1(decoded.refs);
  if (decoded.root !== sealed.root) throw new TypeError("release-qualified capability set root mismatch");
  return sealed;
}

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
