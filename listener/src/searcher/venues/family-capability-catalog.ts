import {
  assertDefinedFamilyPlugin,
  definedFamilyPluginContractSummary,
  type AnyDefinedFamilyPlugin,
  type AnyDefinedStrictFamilyPlugin,
  type FamilyDomain,
  type UnifiedObservation,
} from "./adapter-family-plugin.js";
import type { FamilyId } from "./adapter-family-identifiers.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";

export const FAMILY_CAPABILITY_NAMES = Object.freeze([
  "discovery",
  "identity",
  "instance",
  "routes",
  "pricing",
  "exact",
  "execution",
  "victim",
  "funding",
  "credit",
] as const);

export type FamilyCapabilityName =
  (typeof FAMILY_CAPABILITY_NAMES)[number];

export const FAMILY_CAPABILITIES_BY_DOMAIN: Readonly<
  Record<FamilyDomain, readonly FamilyCapabilityName[]>
> = Object.freeze({
  swap: Object.freeze([
    "discovery",
    "identity",
    "instance",
    "routes",
    "pricing",
    "exact",
    "execution",
    "victim",
  ] as const),
  protocol: Object.freeze([
    "discovery",
    "identity",
    "instance",
    "routes",
    "pricing",
    "exact",
    "execution",
    "victim",
  ] as const),
  funding: Object.freeze(["funding"] as const),
  credit: Object.freeze([
    "discovery",
    "identity",
    "instance",
    "routes",
    "execution",
    "credit",
  ] as const),
} as const);

export interface GeneratedCapabilityIdentity {
  readonly familyId: FamilyId;
  readonly capability: FamilyCapabilityName;
  readonly contractVersion: string;
  readonly contentHash: string;
  readonly semanticDependencies: readonly string[];
  /** Traceability only. This value is never part of a cache key. */
  readonly provenanceCommit: string | null;
}

export interface GeneratedCapabilityManifest {
  readonly format: "adapter-family-capabilities-v1";
  readonly entries: readonly GeneratedCapabilityIdentity[];
  readonly manifestHash: string;
}

export type FamilyCapabilityIdentitySet = Readonly<
  Record<FamilyCapabilityName, GeneratedCapabilityIdentity>
>;

export interface DefinedFamilyPluginModuleInput {
  readonly sourceFile: string;
  readonly definitionBoundaryHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
}

export interface LoadedFamilyPlugin {
  readonly sourceFile: string;
  readonly definitionBoundaryHash: string;
  readonly plugin: AnyDefinedFamilyPlugin;
  readonly hashes: FamilyCapabilityIdentitySet;
  readonly applicableCapabilities: readonly FamilyCapabilityName[];
}

export interface LoadedStrictFamilyPlugin {
  readonly sourceFile: string;
  readonly definitionBoundaryHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly hashes: FamilyCapabilityIdentitySet;
  readonly applicableCapabilities: readonly FamilyCapabilityName[];
}

/**
 * Existential runtime box issued only by the central catalog. The concrete
 * generic parameters remain captured by its branded plugin closure; callers
 * must not accept structurally forged boxes from Family code.
 */
export type LoadedFamilyBox = LoadedStrictFamilyPlugin;

const issuedLoadedFamilyBoxes = new WeakSet<object>();

export function assertIssuedLoadedFamilyBox(
  value: unknown,
): asserts value is LoadedFamilyBox {
  if (
    value === null ||
    typeof value !== "object" ||
    !issuedLoadedFamilyBoxes.has(value)
  ) {
    throw new Error("Family runtime box must be issued by the central catalog");
  }
}

export interface FamilyPatternMatch {
  readonly familyId: FamilyId;
  readonly patternId: string;
}

/**
 * The terminal code-capability catalog. It indexes definitions only: no pool,
 * route, Factory child, vault or other chain instance may enter this object.
 */
export class FamilyCapabilityCatalog {
  private readonly families: readonly LoadedStrictFamilyPlugin[];
  private readonly routeFamilies: readonly LoadedFamilyPlugin[];
  private readonly familyById: ReadonlyMap<FamilyId, LoadedStrictFamilyPlugin>;
  private readonly actionOwnerById: ReadonlyMap<string, FamilyId>;
  private readonly callMatches: ReadonlyMap<string, readonly FamilyPatternMatch[]>;
  private readonly logMatches: ReadonlyMap<string, readonly FamilyPatternMatch[]>;
  private readonly addressMatches: ReadonlyMap<
    string,
    readonly FamilyPatternMatch[]
  >;
  readonly catalogHash: string;

  constructor(input: {
    readonly modules: readonly DefinedFamilyPluginModuleInput[];
    readonly generatedManifest: GeneratedCapabilityManifest;
  }) {
    const manifest = validateGeneratedCapabilityManifest(
      input.generatedManifest,
    );
    const generated = indexGeneratedIdentities(manifest.entries);
    const familyById = new Map<FamilyId, LoadedStrictFamilyPlugin>();
    const actionOwnerById = new Map<string, FamilyId>();
    const callMatches = new Map<string, FamilyPatternMatch[]>();
    const logMatches = new Map<string, FamilyPatternMatch[]>();
    const addressMatches = new Map<string, FamilyPatternMatch[]>();
    const loaded: LoadedStrictFamilyPlugin[] = [];
    const loadedRoutes: LoadedFamilyPlugin[] = [];

    for (const module of [...input.modules].sort((left, right) =>
      left.sourceFile.localeCompare(right.sourceFile)
    )) {
      assertDefinedFamilyPlugin(module.plugin);
      const summary = definedFamilyPluginContractSummary(module.plugin);
      if (summary.definitionBoundaryHash !== module.definitionBoundaryHash) {
        throw new Error(
          `${module.sourceFile} definition boundary hash does not match its plugin`,
        );
      }
      if (familyById.has(summary.familyId)) {
        throw new Error(
          `Family capability catalog duplicates ${summary.familyId}`,
        );
      }
      const hashes = capabilitySetForFamily(summary.familyId, generated);
      const applicableCapabilities = FAMILY_CAPABILITIES_BY_DOMAIN[
        summary.domain
      ];
      const family: LoadedStrictFamilyPlugin = Object.freeze({
        sourceFile: module.sourceFile,
        definitionBoundaryHash: module.definitionBoundaryHash,
        plugin: module.plugin,
        hashes,
        applicableCapabilities,
      });
      issuedLoadedFamilyBoxes.add(family);
      familyById.set(summary.familyId, family);
      loaded.push(family);
      if (summary.domain === "swap" || summary.domain === "protocol") {
        loadedRoutes.push(family as LoadedFamilyPlugin);
      }

      for (const actionId of summary.ownedActionAdapterIds) {
        const existing = actionOwnerById.get(actionId);
        if (existing !== undefined) {
          throw new Error(
            `ActionAdapter ${actionId} is owned by both ${existing} and ` +
              summary.familyId,
          );
        }
        actionOwnerById.set(actionId, summary.familyId);
      }

      const discovery = "discovery" in module.plugin
        ? module.plugin.discovery
        : undefined;
      for (const pattern of discovery?.callPatterns ?? []) {
        appendPattern(
          callMatches,
          normalizeHex(pattern.selector, 4, "call selector"),
          { familyId: summary.familyId, patternId: pattern.id },
        );
      }
      for (const pattern of discovery?.logPatterns ?? []) {
        appendPattern(
          logMatches,
          normalizeHex(pattern.topic, 32, "log topic"),
          { familyId: summary.familyId, patternId: pattern.id },
        );
      }
      for (const pattern of discovery?.addressSurfaces ?? []) {
        appendPattern(
          addressMatches,
          addressSurfaceKey(pattern.kind, pattern.fingerprint),
          { familyId: summary.familyId, patternId: pattern.id },
        );
      }
    }

    assertNoGeneratedManifestDrift(generated, familyById);
    this.families = Object.freeze(loaded);
    this.routeFamilies = Object.freeze(loadedRoutes);
    this.familyById = familyById;
    this.actionOwnerById = actionOwnerById;
    this.callMatches = freezePatternIndex(callMatches);
    this.logMatches = freezePatternIndex(logMatches);
    this.addressMatches = freezePatternIndex(addressMatches);
    this.catalogHash = hashCanonical({
      format: "adapter-family-catalog-v1",
      generatedManifestHash: manifest.manifestHash,
      families: loaded.map((family) => ({
        sourceFile: family.sourceFile,
        familyId: family.plugin.manifest.familyId,
        definitionBoundaryHash: family.definitionBoundaryHash,
        capabilities: FAMILY_CAPABILITY_NAMES.map((capability) => ({
          capability,
          applicable: family.applicableCapabilities.includes(capability),
          contractVersion: family.hashes[capability].contractVersion,
          contentHash: family.hashes[capability].contentHash,
        })),
      })),
    });
    Object.freeze(this);
  }

  list(): readonly LoadedFamilyPlugin[] {
    return this.routeFamilies;
  }

  forFamily(familyId: FamilyId): LoadedFamilyPlugin {
    const family = this.familyById.get(familyId);
    if (family === undefined) {
      throw new Error(`Family capability catalog has no ${familyId}`);
    }
    const domain = family.plugin.manifest.domain;
    if (domain !== "swap" && domain !== "protocol") {
      throw new Error(`${familyId} is a ${domain} Domain, not a route Family`);
    }
    return family as LoadedFamilyPlugin;
  }

  listAll(): readonly LoadedStrictFamilyPlugin[] {
    return this.families;
  }

  forStrictFamily(familyId: FamilyId): LoadedStrictFamilyPlugin {
    const family = this.familyById.get(familyId);
    if (family === undefined) {
      throw new Error(`Family capability catalog has no ${familyId}`);
    }
    return family;
  }

  ownerOfAction(actionAdapterId: string): FamilyId {
    const owner = this.actionOwnerById.get(actionAdapterId);
    if (owner === undefined) {
      throw new Error(
        `Family capability catalog has no owner for ${actionAdapterId}`,
      );
    }
    return owner;
  }

  matches(observation: UnifiedObservation): readonly FamilyPatternMatch[] {
    switch (observation.kind) {
      case "call": {
        if (!/^0x[0-9a-fA-F]{8}/.test(observation.data)) return [];
        return this.callMatches.get(observation.data.slice(0, 10).toLowerCase())
          ?? [];
      }
      case "log": {
        const topic = observation.topics[0];
        if (topic === undefined) return [];
        return this.logMatches.get(topic.toLowerCase()) ?? [];
      }
      case "address-surface": {
        const matches: FamilyPatternMatch[] = [];
        appendUniqueMatches(
          matches,
          this.addressMatches.get(addressSurfaceKey("code-hash", observation.codeHash)),
        );
        appendUniqueMatches(
          matches,
          this.addressMatches.get(addressSurfaceKey(
            "proxy-implementation",
            observation.implementationWord,
          )),
        );
        for (const fingerprint of observation.interfaceFingerprints ?? []) {
          appendUniqueMatches(
            matches,
            this.addressMatches.get(addressSurfaceKey("interface", fingerprint)),
          );
        }
        return Object.freeze(matches.sort(comparePatternMatch));
      }
      case "factory-log": {
        // Reverse bootstrap matching: a factory-log incumbent surface is
        // admitted when the Family declares the bootstrap log topic. The
        // closure verifier re-decodes the candidate from the carried log.
        return this.logMatches.get(observation.topic.toLowerCase()) ?? [];
      }
    }
  }
}

export function capabilityManifestHash(
  entries: readonly GeneratedCapabilityIdentity[],
): string {
  return hashCanonical({
    format: "adapter-family-capabilities-v1",
    entries: canonicalCapabilityEntries(entries).map(
      capabilityIdentityProjection,
    ),
  });
}

export function validateGeneratedCapabilityManifest(
  manifest: GeneratedCapabilityManifest,
): GeneratedCapabilityManifest {
  if (!isPlainRecord(manifest)) {
    throw new Error("generated capability manifest must be a plain record");
  }
  assertExactKeys(manifest, ["entries", "format", "manifestHash"]);
  if (manifest.format !== "adapter-family-capabilities-v1") {
    throw new Error(`unsupported capability manifest format ${manifest.format}`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("generated capability manifest entries must be an array");
  }
  const entries = canonicalCapabilityEntries(manifest.entries);
  const expectedHash = capabilityManifestHash(entries);
  if (manifest.manifestHash !== expectedHash) {
    throw new Error("generated capability manifest hash is stale or invalid");
  }
  return Object.freeze({
    format: manifest.format,
    entries,
    manifestHash: expectedHash,
  });
}

function canonicalCapabilityEntries(
  entries: readonly GeneratedCapabilityIdentity[],
): readonly GeneratedCapabilityIdentity[] {
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new Error("generated capability identity must be a plain record");
    }
    assertExactKeys(entry, [
      "capability",
      "contentHash",
      "contractVersion",
      "familyId",
      "provenanceCommit",
      "semanticDependencies",
    ]);
    nonempty(entry.familyId, "capability familyId");
    if (!(FAMILY_CAPABILITY_NAMES as readonly string[]).includes(
      entry.capability,
    )) {
      throw new Error(`unknown Family capability ${entry.capability}`);
    }
    nonempty(entry.contractVersion, "capability contractVersion");
    assertSha256(entry.contentHash, "capability contentHash");
    if (!Array.isArray(entry.semanticDependencies)) {
      throw new Error("capability semanticDependencies must be an array");
    }
    const dependencies = entry.semanticDependencies.map((dependency) =>
      nonempty(dependency, "capability semantic dependency")
    );
    const sortedDependencies = [...new Set(dependencies)].sort();
    if (
      sortedDependencies.length !== dependencies.length ||
      sortedDependencies.some((dependency, index) =>
        dependency !== dependencies[index]
      )
    ) {
      throw new Error(
        `${entry.familyId}/${entry.capability} semantic dependencies ` +
          "must be unique and sorted",
      );
    }
    if (
      entry.provenanceCommit !== null &&
      !/^[0-9a-f]{40,64}$/.test(entry.provenanceCommit)
    ) {
      throw new Error("capability provenanceCommit must be a git object id");
    }
    const key = `${entry.familyId}\0${entry.capability}`;
    if (seen.has(key)) {
      throw new Error(
        `duplicate capability identity ${entry.familyId}/${entry.capability}`,
      );
    }
    seen.add(key);
    return Object.freeze({
      familyId: entry.familyId,
      capability: entry.capability,
      contractVersion: entry.contractVersion,
      contentHash: entry.contentHash,
      semanticDependencies: Object.freeze(sortedDependencies),
      provenanceCommit: entry.provenanceCommit,
    });
  });
  return Object.freeze(normalized.sort((left, right) =>
    left.familyId.localeCompare(right.familyId) ||
    left.capability.localeCompare(right.capability)
  ));
}

function indexGeneratedIdentities(
  entries: readonly GeneratedCapabilityIdentity[],
): ReadonlyMap<string, GeneratedCapabilityIdentity> {
  return new Map(entries.map((entry) => [
    `${entry.familyId}\0${entry.capability}`,
    entry,
  ]));
}

function capabilityIdentityProjection(
  identity: GeneratedCapabilityIdentity,
): CanonicalValue {
  return {
    familyId: identity.familyId,
    capability: identity.capability,
    contractVersion: identity.contractVersion,
    contentHash: identity.contentHash,
    semanticDependencies: identity.semanticDependencies,
    provenanceCommit: identity.provenanceCommit,
  };
}

function capabilitySetForFamily(
  familyId: FamilyId,
  generated: ReadonlyMap<string, GeneratedCapabilityIdentity>,
): FamilyCapabilityIdentitySet {
  const values = Object.fromEntries(FAMILY_CAPABILITY_NAMES.map((capability) => {
    const identity = generated.get(`${familyId}\0${capability}`);
    if (identity === undefined) {
      throw new Error(
        `generated capability manifest is missing ${familyId}/${capability}`,
      );
    }
    return [capability, identity];
  })) as Record<FamilyCapabilityName, GeneratedCapabilityIdentity>;
  return Object.freeze(values);
}

function assertNoGeneratedManifestDrift(
  generated: ReadonlyMap<string, GeneratedCapabilityIdentity>,
  families: ReadonlyMap<FamilyId, LoadedStrictFamilyPlugin>,
): void {
  for (const identity of generated.values()) {
    if (!families.has(identity.familyId)) {
      throw new Error(
        `generated capability manifest contains inactive Family ` +
          identity.familyId,
      );
    }
  }
}

function appendPattern(
  index: Map<string, FamilyPatternMatch[]>,
  key: string,
  match: FamilyPatternMatch,
): void {
  const values = index.get(key) ?? [];
  values.push(Object.freeze(match));
  index.set(key, values);
}

function freezePatternIndex(
  input: ReadonlyMap<string, readonly FamilyPatternMatch[]>,
): ReadonlyMap<string, readonly FamilyPatternMatch[]> {
  return new Map([...input].map(([key, values]) => [
    key,
    Object.freeze([...values].sort(comparePatternMatch)),
  ]));
}

function comparePatternMatch(
  left: FamilyPatternMatch,
  right: FamilyPatternMatch,
): number {
  return left.familyId.localeCompare(right.familyId) ||
    left.patternId.localeCompare(right.patternId);
}

function appendUniqueMatches(
  output: FamilyPatternMatch[],
  matches: readonly FamilyPatternMatch[] | undefined,
): void {
  if (matches === undefined) return;
  const keys = new Set(output.map((match) =>
    `${match.familyId}\0${match.patternId}`
  ));
  for (const match of matches) {
    const key = `${match.familyId}\0${match.patternId}`;
    if (!keys.has(key)) {
      output.push(match);
      keys.add(key);
    }
  }
}

function addressSurfaceKey(kind: string, fingerprint: string): string {
  nonempty(fingerprint, "address surface fingerprint");
  return `${kind}\0${fingerprint.toLowerCase()}`;
}

function normalizeHex(value: string, bytes: number, label: string): string {
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (!pattern.test(value)) throw new Error(`${label} must be ${bytes} bytes`);
  return value.toLowerCase();
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    throw new Error("generated capability records cannot contain symbol keys");
  }
  const sorted = (actual as string[]).sort();
  const wanted = [...expected].sort();
  if (
    sorted.length !== wanted.length ||
    sorted.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(
      `generated capability record keys must be exactly ${wanted.join(",")}`,
    );
  }
  for (const key of sorted) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(
        "generated capability records require enumerable data fields",
      );
    }
  }
}
