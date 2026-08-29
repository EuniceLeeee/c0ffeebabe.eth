import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityId,
  type CapabilityRefV1,
  type CapabilityVersion,
  type OwnerRef,
  type SchemaRef,
} from "../../capability-contracts/src/index.ts";
import {
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  catalogLeafDigest,
  definitionCatalogRoot,
  type CatalogLeafV1,
} from "../../artifact-fingerprint/src/index.ts";
import type {
  GeneratedStrategyEntryV1 as SharedGeneratedStrategyEntryV1,
} from "../../family-sdk/runtime-refs/index.ts";

/** A static public entrypoint. It is build-time metadata, never a callback. */
export interface ModuleEntrypointV1 {
  readonly modulePath: string;
  readonly exportName: string;
}

/**
 * A strategy asks for semantic capability predicates, not a Family, address,
 * ABI, selector, or protocol. The actual release capability ref is resolved
 * by the catalog compiler from the neutral capability index.
 */
export interface CapabilityPredicateRefV1 {
  readonly capabilityId: CapabilityId;
  readonly minimumVersion: CapabilityVersion;
  readonly schemaRefs: readonly SchemaRef[];
}

export interface PlanningProblemIssuerRefV1 extends ModuleEntrypointV1 {
  readonly ownerRef: OwnerRef;
  readonly implementationHash: Hash;
}

/** One generic graph leg. Asset/selection refs are opaque canonical handles. */
export interface RouteLegIntentV1 {
  readonly fromAssetRef: Hash;
  readonly toAssetRef: Hash;
  readonly selectionRef: Hash;
  readonly requiredCapabilityPredicates: readonly CapabilityPredicateRefV1[];
}

/**
 * A closed-loop intent describes what the planner must compose. It does not
 * name a Family or carry a protocol operation. The planner later resolves the
 * opaque selection refs against the immutable GraphView.
 */
export interface LoopIntentV1 {
  readonly kind: "closed-loop";
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly objectiveRef: Hash;
  readonly constraintSchemaRefs: readonly SchemaRef[];
  readonly legs: readonly RouteLegIntentV1[];
}

/**
 * Build-time Strategy data.  A Strategy must not bake asset identities from a
 * fixture into the release catalog: the concrete LoopIntent is issued later
 * from the active GraphView.  This template is therefore deliberately about
 * graph topology and generic constraints only.
 */
export interface ClosedLoopPlanningTemplateV1 {
  readonly kind: "closed-loop-template";
  readonly entryAssetPolicy: "any-graph-asset";
  readonly minLegs: string;
  readonly maxLegs: string;
  readonly candidateLimit: string;
  readonly edgeReuse: "forbid";
  readonly constraintSchemaRefs: readonly SchemaRef[];
}

/** Neutral planning output shared by Strategy plugins and the generated
 * runtime composition.  The binding/edge payloads are opaque at this layer;
 * Strategy code may only consume the trigger's owner-issued objective and
 * affected set. */
export interface ClosedLoopPlanningProblemDraftV1 {
  readonly kind: "closed-loop";
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly minLegs: string;
  readonly maxLegs: string;
  readonly candidateLimit: string;
  readonly edgeReuse: "forbid";
  readonly requiredAnchorEdgeIds: readonly Hash[];
  readonly constraintSchemaRefs: readonly Hash[];
}

export interface StrategyPlanningProblemIssuerV1 {
  readonly strategyId: string;
  readonly version: string;
  readonly planningTemplateHash: Hash;
  readonly issue: (input: {
    readonly template: ClosedLoopPlanningTemplateV1;
    readonly binding: unknown;
    readonly edges: readonly unknown[];
    readonly trigger: {
      readonly objectiveRef: Hash;
      readonly entryAssetRef: Hash;
      readonly returnAssetRef: Hash;
      readonly affectedEdgeIds: readonly Hash[];
    };
  }) => ClosedLoopPlanningProblemDraftV1;
}

export function strategyPlanningTemplateHash(template: ClosedLoopPlanningTemplateV1): Hash {
  return hashDomain("aloha/strategy-planning-template/v1", template);
}

export interface StrategyAuthoringDefinitionV1 {
  readonly strategyId: string;
  readonly version: string;
  readonly pluginCodeHash: Hash;
  readonly requiredCapabilityPredicates: readonly CapabilityPredicateRefV1[];
  readonly planningProblemIssuer: PlanningProblemIssuerRefV1;
  readonly constraintSchemaRefs: readonly SchemaRef[];
  readonly factContractRefs: readonly SchemaRef[];
  readonly planningTemplate: ClosedLoopPlanningTemplateV1;
  /** Direct static public entry used by the release-intent compiler. */
  readonly modulePath: string;
  readonly exportName: string;
}

/**
 * The shared runtime ref is intentionally reused. This local extension adds
 * only strategy-owned, data-only planning metadata; it adds no callable
 * issuer, Family object, provider, or authority constructor.
 */
export interface GeneratedStrategyCatalogLeafV1 extends SharedGeneratedStrategyEntryV1 {
  readonly strategyVersion: CapabilityVersion;
  readonly requestedCapabilityDependencyRoot: Hash;
  readonly implementationClosureRoot: Hash;
  readonly planningTemplate: ClosedLoopPlanningTemplateV1;
}

export interface StrategyCompilationResultV1 {
  readonly entry: GeneratedStrategyCatalogLeafV1;
  readonly normalizedDefinition: StrategyAuthoringDefinitionV1;
  readonly requestedCapabilityDependencyRoot: Hash;
  readonly requestedCapabilityIds: readonly CapabilityId[];
}

export interface StrategyCatalogV1 {
  readonly schemaVersion: "1";
  readonly kind: "aloha.generated-strategy-catalog";
  readonly entries: readonly GeneratedStrategyCatalogLeafV1[];
  readonly strategyCatalogRoot: Hash;
}

const STRATEGY_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has non-exact keys`);
  }
  return value as Record<string, unknown>;
}

function staticPath(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (
    result.startsWith(".")
    || result.startsWith("/")
    || result.startsWith("@")
    || result.includes("..")
    || result.includes("\\")
    || result.includes("?")
    || result.includes("#")
  ) throw new TypeError(`static repository path required at ${path}`);
  return result;
}

function staticExport(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^[$A-Z_a-z][$\w]*$/.test(result)) throw new TypeError(`static export identifier required at ${path}`);
  return result;
}

function hashArray(value: unknown, path: string): readonly SchemaRef[] {
  const result = fieldArray(value, (item, itemPath) => asSchemaRef(item as Hash, itemPath), path);
  if (new Set(result).size !== result.length) throw new TypeError(`duplicate schema ref at ${path}`);
  return Object.freeze([...result].sort());
}

function capabilityPredicate(value: unknown, path: string): CapabilityPredicateRefV1 {
  const record = exactObject(value, ["capabilityId", "minimumVersion", "schemaRefs"], path);
  return Object.freeze({
    capabilityId: asCapabilityId(record.capabilityId as string, `${path}.capabilityId`),
    minimumVersion: asCapabilityVersion(record.minimumVersion as string, `${path}.minimumVersion`),
    schemaRefs: hashArray(record.schemaRefs, `${path}.schemaRefs`),
  });
}

function predicates(value: unknown, path: string): readonly CapabilityPredicateRefV1[] {
  const result = fieldArray(value, (item, itemPath) => capabilityPredicate(item, itemPath), path);
  const ids = result.map(item => item.capabilityId);
  if (new Set(ids).size !== ids.length) throw new TypeError(`duplicate required capability predicate at ${path}`);
  return Object.freeze([...result].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)));
}

function issuer(value: unknown, path: string): PlanningProblemIssuerRefV1 {
  const record = exactObject(value, ["modulePath", "exportName", "ownerRef", "implementationHash"], path);
  return Object.freeze({
    modulePath: staticPath(record.modulePath, `${path}.modulePath`),
    exportName: staticExport(record.exportName, `${path}.exportName`),
    ownerRef: asOwnerRef(record.ownerRef as Hash, `${path}.ownerRef`),
    implementationHash: assertHash(record.implementationHash, `${path}.implementationHash`),
  });
}

function planningTemplate(value: unknown, path: string): ClosedLoopPlanningTemplateV1 {
  const record = exactObject(value, ["kind", "entryAssetPolicy", "minLegs", "maxLegs", "candidateLimit", "edgeReuse", "constraintSchemaRefs"], path);
  if (record.kind !== "closed-loop-template") throw new TypeError(`unsupported planning template kind at ${path}.kind`);
  if (record.entryAssetPolicy !== "any-graph-asset") throw new TypeError(`unsupported entry asset policy at ${path}.entryAssetPolicy`);
  if (record.edgeReuse !== "forbid") throw new TypeError(`unsupported edge reuse policy at ${path}.edgeReuse`);
  const minLegs = assertNonEmptyString(record.minLegs, `${path}.minLegs`);
  const maxLegs = assertNonEmptyString(record.maxLegs, `${path}.maxLegs`);
  const candidateLimit = assertNonEmptyString(record.candidateLimit, `${path}.candidateLimit`);
  if (!/^[1-9][0-9]*$/.test(minLegs) || !/^[1-9][0-9]*$/.test(maxLegs) || !/^[1-9][0-9]*$/.test(candidateLimit)) {
    throw new TypeError(`planning leg bounds must be positive canonical decimals at ${path}`);
  }
  if (BigInt(minLegs) < 2n || BigInt(maxLegs) < BigInt(minLegs)) {
    throw new TypeError(`invalid closed-loop planning leg bounds at ${path}`);
  }
  return Object.freeze({
    kind: "closed-loop-template" as const,
    entryAssetPolicy: "any-graph-asset" as const,
    minLegs,
    maxLegs,
    candidateLimit,
    edgeReuse: "forbid" as const,
    constraintSchemaRefs: hashArray(record.constraintSchemaRefs, `${path}.constraintSchemaRefs`),
  });
}

export function normalizeStrategyDefinition(value: unknown, path = "strategy"): StrategyAuthoringDefinitionV1 {
  const record = exactObject(value, [
    "strategyId",
    "version",
    "pluginCodeHash",
    "requiredCapabilityPredicates",
    "planningProblemIssuer",
    "constraintSchemaRefs",
    "factContractRefs",
    "planningTemplate",
    "modulePath",
    "exportName",
  ], path);
  const strategyId = assertNonEmptyString(record.strategyId, `${path}.strategyId`);
  if (!STRATEGY_ID_RE.test(strategyId)) throw new TypeError(`invalid strategyId at ${path}.strategyId`);
  const version = assertNonEmptyString(record.version, `${path}.version`);
  if (!VERSION_RE.test(version)) throw new TypeError(`invalid strategy version at ${path}.version`);
  const requiredCapabilityPredicates = predicates(record.requiredCapabilityPredicates, `${path}.requiredCapabilityPredicates`);
  const normalizedPlanningTemplate = planningTemplate(record.planningTemplate, `${path}.planningTemplate`);
  return deepFreeze({
    strategyId,
    version,
    pluginCodeHash: assertHash(record.pluginCodeHash, `${path}.pluginCodeHash`),
    requiredCapabilityPredicates,
    planningProblemIssuer: issuer(record.planningProblemIssuer, `${path}.planningProblemIssuer`),
    constraintSchemaRefs: hashArray(record.constraintSchemaRefs, `${path}.constraintSchemaRefs`),
    factContractRefs: hashArray(record.factContractRefs, `${path}.factContractRefs`),
    planningTemplate: normalizedPlanningTemplate,
    modulePath: staticPath(record.modulePath, `${path}.modulePath`),
    exportName: staticExport(record.exportName, `${path}.exportName`),
  });
}

export function defineStrategy(definition: StrategyAuthoringDefinitionV1): StrategyAuthoringDefinitionV1 {
  return normalizeStrategyDefinition(definition);
}

export function strategyAuthoringDigest(definition: StrategyAuthoringDefinitionV1): Hash {
  return hashDomain("aloha/strategy-authoring-definition/v1", normalizeStrategyDefinition(definition));
}

function capabilityRoot(refs: readonly CapabilityRefV1[]): Hash {
  return hashDomain("aloha/strategy-requested-capability-root/v1", refs.map(ref => ({
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    interpreterHash: ref.interpreterHash,
    ownerRef: ref.ownerRef,
  })).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)));
}

function strategyIssuerRef(definition: StrategyAuthoringDefinitionV1): OwnerRef {
  return asOwnerRef(hashDomain("aloha/strategy-issuer/v1", {
    modulePath: definition.modulePath,
    exportName: definition.exportName,
    pluginCodeHash: definition.pluginCodeHash,
  }));
}

function catalogLeaf(entry: GeneratedStrategyCatalogLeafV1): CatalogLeafV1 {
  return {
    leafId: `strategy:${entry.strategyId}`,
    definitionHash: entry.strategyDefinitionHash,
    requestedDependencyClosure: entry.requiredCapabilityRefs.map(ref => ref.capabilityId),
    implementationClosureRoot: entry.implementationClosureRoot,
  };
}

function normalizeCapabilityRef(value: CapabilityRefV1, path: string): CapabilityRefV1 {
  const record = exactObject(value, ["capabilityId", "version", "schemaHash", "interpreterHash", "ownerRef"], path);
  return Object.freeze({
    capabilityId: asCapabilityId(record.capabilityId as string, `${path}.capabilityId`),
    version: asCapabilityVersion(record.version as string, `${path}.version`),
    schemaHash: asSchemaRef(record.schemaHash as Hash, `${path}.schemaHash`),
    interpreterHash: assertHash(record.interpreterHash, `${path}.interpreterHash`),
    ownerRef: asOwnerRef(record.ownerRef as Hash, `${path}.ownerRef`),
  });
}

/**
 * Compiles a build-time definition against the already-qualified neutral
 * capability refs. No Family implementation or planner/solver is loaded.
 */
export function compileStrategy(
  definition: StrategyAuthoringDefinitionV1,
  capabilityRefs: readonly CapabilityRefV1[],
): StrategyCompilationResultV1 {
  const normalized = normalizeStrategyDefinition(definition);
  const refs = capabilityRefs.map((value, index) => normalizeCapabilityRef(value, `capabilityRefs[${index}]`));
  if (new Set(refs.map(ref => ref.capabilityId)).size !== refs.length) throw new TypeError("duplicate capability ref");
  const byId = new Map(refs.map(ref => [ref.capabilityId, ref] as const));
  const requested = normalized.requiredCapabilityPredicates.map(predicate => {
    const ref = byId.get(predicate.capabilityId);
    if (ref === undefined) throw new TypeError(`missing capability ref for ${predicate.capabilityId}`);
    // The baseline deliberately accepts only an exact qualified version. A
    // range/precedence rule must be a separately versioned capability contract;
    // silently approximating prerelease SemVer would change the dependency
    // closure without changing the strategy declaration.
    if (ref.version !== predicate.minimumVersion) throw new TypeError(`capability version does not exactly satisfy strategy predicate for ${predicate.capabilityId}`);
    return ref;
  }).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const requestedCapabilityDependencyRoot = capabilityRoot(requested);
  const strategyDefinitionHash = hashDomain("aloha/strategy-definition-compiled/v1", {
    authoringDigest: strategyAuthoringDigest(normalized),
    requiredCapabilityRefs: requested,
    requestedCapabilityDependencyRoot,
  });
  const issuerRef = strategyIssuerRef(normalized);
  const entryWithoutLeaf = {
    strategyId: normalized.strategyId,
    strategyDefinitionHash,
    issuerRef,
    requiredCapabilityRefs: Object.freeze(requested),
    planningProblemIssuer: normalized.planningProblemIssuer.ownerRef,
    constraintSchemaRefs: normalized.constraintSchemaRefs,
    factContractRefs: normalized.factContractRefs,
    strategyVersion: asCapabilityVersion(normalized.version),
    requestedCapabilityDependencyRoot,
    implementationClosureRoot: normalized.pluginCodeHash,
    planningTemplate: normalized.planningTemplate,
  };
  const definitionCatalogLeafDigest = catalogLeafDigest({
    leafId: `strategy:${normalized.strategyId}`,
    definitionHash: strategyDefinitionHash,
    requestedDependencyClosure: requested.map(ref => ref.capabilityId),
    implementationClosureRoot: normalized.pluginCodeHash,
  });
  const entry = deepFreeze({ ...entryWithoutLeaf, definitionCatalogLeafDigest });
  return Object.freeze({
    entry,
    normalizedDefinition: normalized,
    requestedCapabilityDependencyRoot,
    requestedCapabilityIds: Object.freeze(requested.map(ref => ref.capabilityId)),
  });
}

function generatedEntry(value: unknown, path: string): GeneratedStrategyCatalogLeafV1 {
  const record = exactObject(value, [
    "strategyId",
    "strategyDefinitionHash",
    "issuerRef",
    "requiredCapabilityRefs",
    "planningProblemIssuer",
    "constraintSchemaRefs",
    "factContractRefs",
    "definitionCatalogLeafDigest",
    "strategyVersion",
    "requestedCapabilityDependencyRoot",
    "implementationClosureRoot",
    "planningTemplate",
  ], path);
  const refs = fieldArray(record.requiredCapabilityRefs, (item, itemPath) => normalizeCapabilityRef(item as CapabilityRefV1, itemPath), `${path}.requiredCapabilityRefs`);
  if (new Set(refs.map(ref => ref.capabilityId)).size !== refs.length) throw new TypeError(`duplicate capability ref at ${path}`);
  const entry = deepFreeze({
    strategyId: assertNonEmptyString(record.strategyId, `${path}.strategyId`),
    strategyDefinitionHash: assertHash(record.strategyDefinitionHash, `${path}.strategyDefinitionHash`),
    issuerRef: asOwnerRef(record.issuerRef as Hash, `${path}.issuerRef`),
    requiredCapabilityRefs: Object.freeze([...refs].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))),
    planningProblemIssuer: asOwnerRef(record.planningProblemIssuer as Hash, `${path}.planningProblemIssuer`),
    constraintSchemaRefs: hashArray(record.constraintSchemaRefs, `${path}.constraintSchemaRefs`),
    factContractRefs: hashArray(record.factContractRefs, `${path}.factContractRefs`),
    definitionCatalogLeafDigest: assertHash(record.definitionCatalogLeafDigest, `${path}.definitionCatalogLeafDigest`),
    strategyVersion: asCapabilityVersion(record.strategyVersion as string, `${path}.strategyVersion`),
    requestedCapabilityDependencyRoot: assertHash(record.requestedCapabilityDependencyRoot, `${path}.requestedCapabilityDependencyRoot`),
    implementationClosureRoot: assertHash(record.implementationClosureRoot, `${path}.implementationClosureRoot`),
    planningTemplate: planningTemplate(record.planningTemplate, `${path}.planningTemplate`),
  });
  if (!STRATEGY_ID_RE.test(entry.strategyId)) throw new TypeError(`invalid strategy id at ${path}.strategyId`);
  if (capabilityRoot(entry.requiredCapabilityRefs) !== entry.requestedCapabilityDependencyRoot) {
    throw new TypeError(`strategy capability dependency root mismatch at ${path}`);
  }
  const expectedLeaf = catalogLeafDigest(catalogLeaf(entry));
  if (entry.definitionCatalogLeafDigest !== expectedLeaf) throw new TypeError(`strategy catalog leaf digest mismatch at ${path}`);
  return entry;
}

export function sealStrategyCatalog(entries: readonly GeneratedStrategyCatalogLeafV1[]): StrategyCatalogV1 {
  const decoded = entries.map((entry, index) => generatedEntry(entry, `strategyCatalog.entries[${index}]`));
  const sorted = [...decoded].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  if (new Set(sorted.map(entry => entry.strategyId)).size !== sorted.length) throw new TypeError("duplicate strategy id");
  const strategyCatalogRoot = hashDomain("aloha/strategy-catalog/v1", sorted.map(entry => entry.definitionCatalogLeafDigest));
  // `definitionCatalogRoot` is intentionally computed from strategy leaves
  // only. The global Family+Strategy root is composed by the release tool.
  definitionCatalogRoot(sorted.map(catalogLeaf));
  return deepFreeze({
    schemaVersion: "1" as const,
    kind: "aloha.generated-strategy-catalog" as const,
    entries: sorted,
    strategyCatalogRoot,
  });
}

export function validateStrategyCatalog(value: StrategyCatalogV1): void {
  const record = exactObject(value, ["schemaVersion", "kind", "entries", "strategyCatalogRoot"], "strategyCatalog");
  if (record.schemaVersion !== "1" || record.kind !== "aloha.generated-strategy-catalog") throw new TypeError("unsupported strategy catalog");
  const catalog = sealStrategyCatalog(fieldArray(record.entries, (item, path) => generatedEntry(item, path), "strategyCatalog.entries"));
  if (catalog.strategyCatalogRoot !== record.strategyCatalogRoot) throw new TypeError("strategy catalog root mismatch");
}

export function strategyCatalogRoot(entries: readonly GeneratedStrategyCatalogLeafV1[]): Hash {
  return sealStrategyCatalog(entries).strategyCatalogRoot;
}

/** Canonical bytes used by release tooling and mutation tests. */
export function encodeStrategyDefinition(definition: StrategyAuthoringDefinitionV1): string {
  return encodeCanonicalJson(normalizeStrategyDefinition(definition));
}

export type { CapabilityId, CapabilityRefV1, CapabilityVersion, OwnerRef, SchemaRef } from "../../capability-contracts/src/index.ts";
export type { GeneratedStrategyEntryV1 as SharedGeneratedStrategyEntryV1 } from "../../family-sdk/runtime-refs/index.ts";
