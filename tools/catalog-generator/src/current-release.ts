import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityRefV1,
} from "../../../packages/capability-contracts/src/index.ts";
import { encodeCanonicalJson, hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import {
  normalizeFamilyDefinition,
  type FamilyAuthoringDefinitionV1,
  type ModuleEntrypointV1,
} from "../../../packages/family-sdk/authoring/index.ts";
import {
  normalizeStrategyDefinition,
  type StrategyAuthoringDefinitionV1,
} from "../../../packages/strategy-sdk/src/index.ts";
import {
  decodeCatalogCompilerClosureFacts,
  type CatalogCompilerClosureFactV1,
} from "../../../specs/catalog-compiler/src/index.ts";
import {
  decodeReleaseQualifiedCapabilitySetV1,
  sealCapabilityIndex,
  type ReleaseQualifiedCapabilityRefV1,
  type ReleaseQualifiedCapabilitySetV1,
} from "../../../specs/capability-index/src/index.ts";
import {
  sealReleaseIntent,
  type FamilyReleaseIntentEntryV1,
} from "../../../specs/release-intent/src/index.ts";
import {
  CURVE_UNDERLYING_DEFINITION,
} from "../../../families/curve-underlying/src/family-definition.ts";
import {
  DODO_V2_DEFINITION,
} from "../../../families/dodo-v2/src/family-definition.ts";
import {
  FLUID_DEX_DEFINITION,
} from "../../../families/fluid-dex/src/family-definition.ts";
import {
  UNIV2_STANDARD_DEFINITION,
} from "../../../families/univ2-standard/src/family-definition.ts";
import {
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";
import { NATIVE_EQUIVALENT_VALUATION_OWNER_DECLARATION_V1 } from "../../../valuation-owners/native-equivalent/src/declaration.ts";
import {
  NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1,
  NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1,
  NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1,
} from "../../../valuation-owners/native-equivalent/src/qualification.ts";
import type { CatalogGenerationInputV1 } from "./index.ts";
import {
  catalogImpactGenesisPriorV1,
  decodeCatalogImpactPriorV1,
  type CatalogImpactPriorV1,
} from "./impact-receipt.ts";

interface CurrentReleaseFamilySourceV1 {
  readonly definition: FamilyAuthoringDefinitionV1;
  readonly modulePath: string;
  readonly exportName: string;
}

export type CurrentReleaseFamilyExclusionReasonV1 =
  | "source-nomination-only"
  | "complete-source-evidence-not-consumed-by-stage-runtime"
  | "exact-capability-absent"
  | "exact-effect-observation-absent"
  | "qualified-state-authority-absent"
  | "qualified-funding-authority-absent"
  | "qualified-credit-authority-absent"
  | "execution-program-blocked"
  | "final-simulation-blocked"
  | "optional-instance-without-complete-source-partition";

export interface CurrentReleaseFamilyDecisionV1 {
  readonly familyId: string;
  readonly decision: "include" | "exclude";
  readonly exclusionReasons: readonly CurrentReleaseFamilyExclusionReasonV1[];
}

interface CurrentReleaseStrategySourceV1 {
  readonly definition: StrategyAuthoringDefinitionV1;
  readonly modulePath: string;
  readonly exportName: string;
}

export interface CurrentCatalogCompilerEntrypointSpecV1 extends ModuleEntrypointV1 {
  /** Which exact boundary closure kind is allowed to supply this export. */
  readonly preferredKind: "compiler-root" | "package-entrypoint";
}

export interface CatalogCompilerClosureCandidateV1 {
  readonly entrypoint: string;
  readonly entrypointId: string;
  readonly kind: "compiler-root" | "package-entrypoint";
  readonly configPath: string;
  readonly packageManifestPath: string | null;
}

function packageOwnedTsconfigPath(packageManifestPath: string | null): string | null {
  if (packageManifestPath === null || !packageManifestPath.endsWith("/package.json")) return null;
  const directory = packageManifestPath.slice(0, -"/package.json".length);
  return directory.length === 0 ? "tsconfig.json" : `${directory}/tsconfig.json`;
}

/**
 * Select the release-owned closure without depending on consumer order.
 * Public package exports are observed in every consumer Program, but only
 * the closure compiled by the package's own exact tsconfig can supply the
 * package entrypoint. Compiler roots have no consumer fan-out and remain
 * exact by kind/path; the caller still enforces cardinality.
 */
export function selectCatalogCompilerClosureCandidates(
  closures: readonly CatalogCompilerClosureCandidateV1[],
  spec: CurrentCatalogCompilerEntrypointSpecV1,
): readonly CatalogCompilerClosureCandidateV1[] {
  const matching = closures.filter(closure =>
    closure.entrypoint === spec.modulePath && closure.kind === spec.preferredKind,
  );
  if (spec.preferredKind === "compiler-root") return matching;
  return matching.filter(closure =>
    packageOwnedTsconfigPath(closure.packageManifestPath) === closure.configPath,
  );
}

/**
 * The production release compiler imports only included Families. Excluded
 * packages are deliberately absent from this module's dependency closure so
 * an unrelated Family (including a future LP Family) cannot invalidate or
 * force requalification of this release.
 */
const CURRENT_RELEASE_FAMILY_SOURCES: readonly CurrentReleaseFamilySourceV1[] = Object.freeze([
  Object.freeze({ definition: CURVE_UNDERLYING_DEFINITION, modulePath: "families/curve-underlying/src/public.ts", exportName: "CURVE_UNDERLYING_DEFINITION" }),
  Object.freeze({ definition: DODO_V2_DEFINITION, modulePath: "families/dodo-v2/src/public.ts", exportName: "DODO_V2_DEFINITION" }),
  Object.freeze({ definition: FLUID_DEX_DEFINITION, modulePath: "families/fluid-dex/src/public.ts", exportName: "FLUID_DEX_DEFINITION" }),
  Object.freeze({ definition: UNIV2_STANDARD_DEFINITION, modulePath: "families/univ2-standard/src/public.ts", exportName: "UNIV2_STANDARD_DEFINITION" }),
]);

const CURRENT_RELEASE_EXCLUSIONS: readonly CurrentReleaseFamilyDecisionV1[] = Object.freeze([
  Object.freeze({ familyId: "angstrom-v4", decision: "exclude", exclusionReasons: Object.freeze(["execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "astra-multitoken", decision: "exclude", exclusionReasons: Object.freeze(["exact-effect-observation-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "balancer-flash", decision: "exclude", exclusionReasons: Object.freeze(["qualified-funding-authority-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "eigenpie", decision: "exclude", exclusionReasons: Object.freeze(["qualified-state-authority-absent", "exact-effect-observation-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "erc4626", decision: "exclude", exclusionReasons: Object.freeze(["exact-capability-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "erc4626-silo-redeem", decision: "exclude", exclusionReasons: Object.freeze(["exact-effect-observation-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "ethertoken-native-redeem", decision: "exclude", exclusionReasons: Object.freeze(["exact-effect-observation-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "fluid-credit", decision: "exclude", exclusionReasons: Object.freeze(["qualified-credit-authority-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "goldx", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only"] as const) }),
  Object.freeze({ familyId: "metronome-hgusdc", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only", "exact-capability-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "metronome-synth", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only", "exact-capability-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "morpho-flash", decision: "exclude", exclusionReasons: Object.freeze(["qualified-funding-authority-absent", "execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "psm", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only"] as const) }),
  Object.freeze({ familyId: "rocksolid", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only"] as const) }),
  Object.freeze({ familyId: "self-burn-native", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only"] as const) }),
  Object.freeze({ familyId: "wsteth", decision: "exclude", exclusionReasons: Object.freeze(["source-nomination-only"] as const) }),
  Object.freeze({ familyId: "univ3-standard", decision: "exclude", exclusionReasons: Object.freeze(["execution-program-blocked", "final-simulation-blocked"] as const) }),
  Object.freeze({ familyId: "univ4", decision: "exclude", exclusionReasons: Object.freeze(["execution-program-blocked", "final-simulation-blocked"] as const) }),
]);

function validateIncludedFamily(source: CurrentReleaseFamilySourceV1): void {
  const definition = normalizeFamilyDefinition(source.definition);
  if (!definition.manifest.sourcePlans.some(plan => plan.completeness !== "nomination-only")) {
    throw new TypeError(`included Family lacks a complete source ${definition.manifest.familyId}`);
  }
  const exact = definition.extensions[`family.${definition.manifest.familyId}.exact`];
  if (exact?.kind !== "present") throw new TypeError(`included Family lacks exact capability ${definition.manifest.familyId}`);
  const actionOwnerIds = new Set(definition.actionOwners.map(owner => owner.ownerId));
  const adapterActionOwnerIds = new Set(Object.values(definition.runtimeAdapters ?? {}).flatMap(adapter => Object.values(adapter.actionOwnerIds)));
  if (actionOwnerIds.size === 0 || [...actionOwnerIds].some(ownerId => !adapterActionOwnerIds.has(ownerId))) {
    throw new TypeError(`included Family lacks execution ownership ${definition.manifest.familyId}`);
  }
}
for (const source of CURRENT_RELEASE_FAMILY_SOURCES) validateIncludedFamily(source);

const CURRENT_RELEASE_FAMILY_DECISIONS: readonly CurrentReleaseFamilyDecisionV1[] = Object.freeze([
  ...CURRENT_RELEASE_FAMILY_SOURCES.map(source => Object.freeze({
    familyId: source.definition.manifest.familyId,
    decision: "include" as const,
    exclusionReasons: Object.freeze([]),
  })),
  ...CURRENT_RELEASE_EXCLUSIONS,
].sort((left, right) => left.familyId.localeCompare(right.familyId)));
if (new Set(CURRENT_RELEASE_FAMILY_DECISIONS.map(item => item.familyId)).size !== CURRENT_RELEASE_FAMILY_DECISIONS.length) {
  throw new TypeError("current release decision ledger contains duplicate Family ids");
}

/** Review/report data only; excluded rows are not release compiler inputs. */
export function currentReleaseFamilyDecisions(): readonly CurrentReleaseFamilyDecisionV1[] {
  return CURRENT_RELEASE_FAMILY_DECISIONS;
}

const CURRENT_RELEASE_STRATEGY_SOURCES: readonly CurrentReleaseStrategySourceV1[] = Object.freeze([
  Object.freeze({
    definition: ROUTE_CYCLE_STRATEGY,
    modulePath: "strategies/route-cycle/src/index.ts",
    exportName: "ROUTE_CYCLE_STRATEGY",
  }),
]);

const CURRENT_RELEASE_VALUATION_OWNERS = Object.freeze([Object.freeze({
  declaration: NATIVE_EQUIVALENT_VALUATION_OWNER_DECLARATION_V1,
  qualificationSpec: NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1,
  criticalMutationCorpus: NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1,
  independentOracleCases: NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1,
})]);

function publicEntry(source: CurrentReleaseFamilySourceV1): FamilyReleaseIntentEntryV1 {
  return Object.freeze({
    familyId: source.definition.manifest.familyId,
    manifestRoot: hashDomain("aloha/family-manifest/v1", source.definition.manifest),
    modulePath: source.modulePath,
    exportName: source.exportName,
  });
}

function strategyPublicEntry(source: CurrentReleaseStrategySourceV1) {
  const definition = normalizeStrategyDefinition(source.definition);
  return Object.freeze({
    strategyId: definition.strategyId,
    manifestRoot: hashDomain("aloha/strategy-manifest/v1", {
      strategyId: definition.strategyId,
      version: definition.version,
      pluginCodeHash: definition.pluginCodeHash,
    }),
    modulePath: source.modulePath,
    exportName: source.exportName,
  });
}

function inputPath(repositoryRoot: string): string {
  return resolve(repositoryRoot, "generated/catalog-generation.inputs.json");
}

export interface CurrentCatalogInputFileV1 {
  readonly compilerClosures: readonly CatalogCompilerClosureFactV1[];
  /**
   * Pre-commit capability projection. It intentionally has no runtime
   * bindingId or issuer proof: this self-hash is build input only, never a
   * qualification verdict. The final RuntimeReleaseBinding must exact-join
   * the same set root after the candidate commit exists.
   */
  readonly proposedCapabilitySet: ReleaseQualifiedCapabilitySetV1;
  readonly priorCatalogImpact: CatalogImpactPriorV1;
}

export function readCurrentCatalogInput(repositoryRoot: string, externalSetValue?: unknown): CurrentCatalogInputFileV1 {
  const value = JSON.parse(readFileSync(inputPath(repositoryRoot), "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("current catalog input must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["compilerClosures", "proposedCapabilitySet", "priorCatalogImpact"];
  const actualKeys = Object.keys(record).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new TypeError("current catalog input has non-exact fields; legacy qualifiedCapabilityRefs is not accepted");
  }
  if (!Array.isArray(record.compilerClosures)) {
    throw new TypeError("current catalog input requires compilerClosures");
  }
  const compilerClosures = decodeCatalogCompilerClosureFacts(record.compilerClosures);
  const rawSet = externalSetValue ?? record.proposedCapabilitySet;
  if (rawSet === undefined) {
    throw new TypeError("current catalog input requires a pre-commit proposed capability set from the release boundary");
  }
  const proposedCapabilitySet = decodeReleaseQualifiedCapabilitySetV1(rawSet);
  if (record.priorCatalogImpact === undefined) throw new TypeError("current catalog input requires explicit priorCatalogImpact");
  const priorCatalogImpact = decodeCatalogImpactPriorV1(record.priorCatalogImpact as object);
  const genesisPrior = catalogImpactGenesisPriorV1();
  if (encodeCanonicalJson(priorCatalogImpact) !== encodeCanonicalJson(genesisPrior)) {
    throw new TypeError("current release requires the exact greenfield genesis catalog impact prior");
  }
  return Object.freeze({ compilerClosures, proposedCapabilitySet, priorCatalogImpact });
}

/**
 * Return every named compiler entrypoint consumed by the current release BOM.
 * The list is derived from the Family authoring definition; it is not a
 * second hand-maintained list of source files. A package entrypoint is
 * preferred only for the public Family entry; all semantic/runtime exports
 * must come from their isolated compiler-root closure.
 */
export function currentCatalogCompilerEntrypointSpecs(): readonly CurrentCatalogCompilerEntrypointSpecV1[] {
  const byKey = new Map<string, CurrentCatalogCompilerEntrypointSpecV1>();
  const add = (
    entrypoint: ModuleEntrypointV1,
    preferredKind: CurrentCatalogCompilerEntrypointSpecV1["preferredKind"],
  ): void => {
    const key = `${entrypoint.modulePath}#${entrypoint.exportName}`;
    const existing = byKey.get(key);
    if (existing === undefined || (preferredKind === "package-entrypoint" && existing.preferredKind !== "package-entrypoint")) {
      byKey.set(key, Object.freeze({
        modulePath: entrypoint.modulePath,
        exportName: entrypoint.exportName,
        preferredKind,
      }));
    }
  };
  for (const source of CURRENT_RELEASE_FAMILY_SOURCES) {
    const definition = normalizeFamilyDefinition(source.definition);
    add({ modulePath: source.modulePath, exportName: source.exportName }, "package-entrypoint");
    for (const module of [
      definition.core.nomination,
      definition.core.identity,
      definition.core.materialization,
      definition.core.projection,
      definition.core.rehydration,
    ]) add(module, "compiler-root");
    for (const plan of definition.manifest.sourcePlans) {
      add(plan, "compiler-root");
      if (plan.nominationProgram.kind === "present") {
        add(plan.nominationProgram.program, "compiler-root");
        add(plan.nominationProgram.program.mutationCorpus, "compiler-root");
        add(plan.nominationProgram.program.independentOracle, "compiler-root");
      }
    }
    for (const slot of Object.values(definition.extensions)) if (slot.kind === "present") add(slot.module, "compiler-root");
    for (const action of definition.actionOwners) add(action, "compiler-root");
    for (const adapter of Object.values(definition.runtimeAdapters ?? {})) add(adapter, "compiler-root");
  }
  for (const source of CURRENT_RELEASE_STRATEGY_SOURCES) {
    const definition = normalizeStrategyDefinition(source.definition);
    add({ modulePath: source.modulePath, exportName: source.exportName }, "package-entrypoint");
    add(definition.planningProblemIssuer, "compiler-root");
  }
  for (const source of CURRENT_RELEASE_VALUATION_OWNERS) {
    add({ modulePath: source.declaration.modulePath, exportName: source.declaration.exportName }, "compiler-root");
    add({ modulePath: source.declaration.qualificationModulePath, exportName: source.declaration.qualificationSpecExportName }, "compiler-root");
    add({ modulePath: source.declaration.qualificationModulePath, exportName: source.declaration.criticalMutationCorpusExportName }, "compiler-root");
    add({ modulePath: source.declaration.qualificationModulePath, exportName: source.declaration.independentOracleCasesExportName }, "compiler-root");
  }
  add({ modulePath: "tools/catalog-generator/src/index.ts", exportName: "generateCatalogWithImpact" }, "compiler-root");
  return Object.freeze([...byKey.values()].sort((left, right) =>
    `${left.modulePath}#${left.exportName}`.localeCompare(`${right.modulePath}#${right.exportName}`),
  ));
}

/** Render the exact external compiler-input envelope without deriving facts. */
export function renderCatalogCompilerInput(
  input: CurrentCatalogInputFileV1,
): string {
  return `${JSON.stringify({
    compilerClosures: input.compilerClosures,
    proposedCapabilitySet: input.proposedCapabilitySet,
    priorCatalogImpact: input.priorCatalogImpact,
  }, null, 2)}\n`;
}

/** Persist only facts projected from a boundary compiler receipt. */
export function writeCatalogCompilerInput(
  repositoryRoot: string,
  compilerClosures: readonly CatalogCompilerClosureFactV1[],
  proposedCapabilitySet: ReleaseQualifiedCapabilitySetV1,
): void {
  const current = readCurrentCatalogInput(repositoryRoot);
  writeFileSync(inputPath(repositoryRoot), renderCatalogCompilerInput({
    compilerClosures,
    proposedCapabilitySet,
    priorCatalogImpact: current.priorCatalogImpact,
  }));
}

/** One-time explicit greenfield authoring operation; normal reads never synthesize this fact. */
export function initializeCurrentCatalogImpactGenesis(repositoryRoot: string): CatalogImpactPriorV1 {
  const path = inputPath(repositoryRoot);
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("current catalog input must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["compilerClosures", "proposedCapabilitySet"].sort())) {
    throw new TypeError("catalog impact genesis initialization requires the exact pre-impact input envelope");
  }
  if (existsSync(resolve(repositoryRoot, "generated/catalog-impact.snapshot.json")) || existsSync(resolve(repositoryRoot, "generated/catalog-impact.receipt.json"))) {
    throw new TypeError("catalog impact genesis initialization is no longer allowed after impact outputs exist");
  }
  const compilerClosures = decodeCatalogCompilerClosureFacts(record.compilerClosures);
  const proposedCapabilitySet = decodeReleaseQualifiedCapabilitySetV1(record.proposedCapabilitySet);
  const priorCatalogImpact = catalogImpactGenesisPriorV1();
  writeFileSync(path, renderCatalogCompilerInput({ compilerClosures, proposedCapabilitySet, priorCatalogImpact }));
  return priorCatalogImpact;
}

function presentCapabilities(sources: readonly CurrentReleaseFamilySourceV1[]) {
  return sources.flatMap(source => Object.values(source.definition.extensions).flatMap(slot =>
    slot.kind === "present" ? [slot.module] : [],
  ));
}

export interface CurrentCatalogCapabilityProposalSpecV1 extends CurrentCatalogCompilerEntrypointSpecV1 {
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: ReleaseQualifiedCapabilityRefV1["schemaHash"];
  readonly interpreterHash: ReleaseQualifiedCapabilityRefV1["interpreterHash"];
}

/**
 * Reviewed capability declarations whose owner refs must be projected by the
 * boundary from their exact compiler closures.  No owner identity is derived
 * in this catalog package.
 */
export function currentCatalogCapabilityProposalSpecs(): readonly CurrentCatalogCapabilityProposalSpecV1[] {
  return Object.freeze(presentCapabilities(CURRENT_RELEASE_FAMILY_SOURCES).map(capability => Object.freeze({
    capabilityId: capability.capabilityId,
    version: capability.version,
    schemaHash: capability.schemaHash,
    interpreterHash: capability.interpreterHash,
    modulePath: capability.modulePath,
    exportName: capability.exportName,
    preferredKind: "compiler-root" as const,
  })).sort((left, right) => {
    const byId = left.capabilityId.localeCompare(right.capabilityId);
    return byId !== 0 ? byId : left.version.localeCompare(right.version);
  }));
}

function proposedCapabilityRefs(
  capabilities: ReturnType<typeof presentCapabilities>,
  proposed: ReleaseQualifiedCapabilitySetV1,
): readonly CapabilityRefV1[] {
  if (capabilities.length !== proposed.refs.length) {
    throw new TypeError("current proposed capability set does not equal the release Family extension set");
  }
  const byIdentity = new Map(proposed.refs.map(ref => [`${ref.capabilityId}\u001f${ref.version}`, ref] as const));
  if (byIdentity.size !== proposed.refs.length) {
    throw new TypeError("current proposed capability set contains duplicate identities");
  }
  for (const capability of capabilities) {
    const ref = byIdentity.get(`${capability.capabilityId}\u001f${capability.version}`);
    if (
      ref === undefined
      || ref.schemaHash !== capability.schemaHash
      || ref.interpreterHash !== capability.interpreterHash
    ) {
      throw new TypeError(`current proposed capability binding mismatch ${capability.capabilityId}`);
    }
  }
  return Object.freeze(proposed.refs.map(ref => Object.freeze({
    capabilityId: asCapabilityId(ref.capabilityId),
    version: asCapabilityVersion(ref.version),
    schemaHash: asSchemaRef(ref.schemaHash),
    interpreterHash: ref.interpreterHash,
    ownerRef: asOwnerRef(ref.ownerRef),
  })));
}

/**
 * Resolve the exact current production input. The external release/build
 * boundary owns `generated/catalog-generation.inputs.json`; missing,
 * malformed, stale or extra facts fail closed. The catalog generator owns the
 * one exact closure-set join, so this release BOM does not duplicate per-stage
 * or per-Family checks.
 */
export function currentCatalogInput(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  externalQualifiedCapabilitySet?: unknown,
): CatalogGenerationInputV1 {
  const current = readCurrentCatalogInput(repositoryRoot, externalQualifiedCapabilitySet);
  const sources = [...CURRENT_RELEASE_FAMILY_SOURCES].sort((left, right) =>
    left.definition.manifest.familyId.localeCompare(right.definition.manifest.familyId),
  );
  const familyIds = sources.map(source => source.definition.manifest.familyId);
  if (new Set(familyIds).size !== familyIds.length) {
    throw new TypeError("current release contains duplicate Family ids");
  }
  const capabilities = presentCapabilities(sources);
  const capabilityIndex = sealCapabilityIndex(capabilities.map(capability => ({
    capabilityId: capability.capabilityId,
    version: capability.version,
    schemaHash: capability.schemaHash,
    interpreterHash: capability.interpreterHash,
    dependencyIds: capability.dependencyIds,
    modulePath: capability.modulePath,
    exportName: capability.exportName,
  })));
  const families = Object.freeze(sources.map(source => Object.freeze({
    definition: source.definition,
    publicEntry: publicEntry(source),
  })));
  const strategySources = [...CURRENT_RELEASE_STRATEGY_SOURCES].sort((left, right) =>
    left.definition.strategyId.localeCompare(right.definition.strategyId),
  );
  const strategies = Object.freeze(strategySources.map(source => Object.freeze({
    definition: source.definition,
    publicEntry: strategyPublicEntry(source),
  })));
  const refs = proposedCapabilityRefs(capabilities, current.proposedCapabilitySet);
  return Object.freeze({
    repositoryRoot,
    releaseIntent: sealReleaseIntent(
      families.map(family => family.publicEntry),
      strategies.map(strategy => strategy.publicEntry),
    ),
    capabilityIndex,
    proposedCapabilityRefs: refs,
    compilerClosures: current.compilerClosures,
    families,
    strategies,
    valuationOwners: CURRENT_RELEASE_VALUATION_OWNERS,
  });
}
