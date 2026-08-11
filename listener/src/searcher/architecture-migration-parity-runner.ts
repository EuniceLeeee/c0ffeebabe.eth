import capabilityShadowArtifact from
  "./generated/family-capability-shadow.generated.json";
import { readFile } from "node:fs/promises";
import {
  judgeArchitectureMigration,
  type ArchitectureMigrationMode,
  type ArchitectureMigrationParityReceipt,
  type ArchitectureStateAnchor,
  type CanonicalFamilySemanticOutput,
  type CanonicalSemanticItem,
  type DeclaredSemanticDelta,
  type FamilyArchitectureParityOutcome,
} from "./architecture-migration-parity.js";
import {
  FAMILY_CAPABILITY_NAMES,
  type FamilyCapabilityName,
} from "./venues/family-capability-catalog.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import { normalizeBaselineMigrationItems } from
  "./architecture-migration-baseline-normalizer.js";

export const ARCHITECTURE_MIGRATION_STAGES = Object.freeze([
  "instances",
  "edges",
  "stateCoverage",
  "pricedEdges",
  "prices",
  "failures",
  "enumeratedRoutes",
  "exactQuotes",
  "executionFragments",
  "finalSimulations",
] as const);

export type ArchitectureMigrationStage =
  (typeof ARCHITECTURE_MIGRATION_STAGES)[number];

export const COMMON_GRAPH_MIGRATION_STAGES = Object.freeze([
  "edges",
  "enumeratedRoutes",
  "exactQuotes",
  "executionFragments",
  "finalSimulations",
] as const);

export type CommonGraphMigrationStage =
  (typeof COMMON_GRAPH_MIGRATION_STAGES)[number];

export type MigrationStageStatus =
  | "exercised"
  | "declared-absent"
  | "framework-blocked";

export interface RawMigrationSemanticItem {
  readonly id: string;
  readonly value: CanonicalValue;
}

export interface RawMigrationStageCapture {
  readonly status: MigrationStageStatus;
  readonly items: readonly RawMigrationSemanticItem[];
  readonly evidenceRefs: readonly string[];
  readonly blocker: string | null;
}

export interface RawFamilyMigrationCaseCapture {
  readonly familyId: string;
  readonly caseId: string;
  readonly inputFingerprint: string;
  readonly stateAnchorNumber: number;
  readonly implementationClosureHash: string;
  readonly stages: Readonly<
    Partial<Record<ArchitectureMigrationStage, RawMigrationStageCapture>>
  >;
}

export interface MigrationClosureDescriptor {
  readonly captureId: string;
  readonly commit: string;
  readonly productionClosureHash: string;
  readonly activationManifestHash: string;
  readonly normalizedConfigHash: string;
  readonly productionPolicyHash: string;
  readonly corpusHash: string;
  readonly evidenceRefs: readonly string[];
}

export interface RawCrossFamilyBinding {
  readonly kind: "action" | "selector" | "state";
  readonly key: string;
  readonly familyId: string;
  readonly value: CanonicalValue;
}

export interface RawCommonGraphMigrationCapture {
  readonly inputFingerprint: string;
  readonly stages: Readonly<
    Partial<Record<CommonGraphMigrationStage, RawMigrationStageCapture>>
  >;
  readonly crossFamilyBindings: readonly RawCrossFamilyBinding[];
}

export interface RawStandaloneSemanticCapture {
  readonly inputFingerprint: string;
  readonly stage: RawMigrationStageCapture;
}

export interface RawArchitectureMigrationSideCapture {
  readonly closure: MigrationClosureDescriptor;
  readonly familyCases: readonly RawFamilyMigrationCaseCapture[];
  readonly commonGraph: RawCommonGraphMigrationCapture | null;
  readonly nonMigratedFamilies: RawStandaloneSemanticCapture | null;
}

export type ArchitectureMigrationEvidenceClass =
  | "unit-contract"
  | "sealed-production";

declare const architectureMigrationProductionCaptureIssuerBrand: unique symbol;

export interface ArchitectureMigrationProductionCaptureIssuer {
  readonly [architectureMigrationProductionCaptureIssuerBrand]: true;
}

declare const sealedProductionSideCaptureBrand: unique symbol;

/**
 * Opaque issuer-bound side capture. Only the trusted production capture
 * issuer can mint it; a caller cannot promote unit fixtures by self-declaring
 * `sealed-production`.
 */
export interface SealedArchitectureMigrationSideCapture {
  readonly [sealedProductionSideCaptureBrand]: true;
}

export interface ArchitectureMigrationBatchInput {
  readonly evidenceClass: ArchitectureMigrationEvidenceClass;
  readonly mode: ArchitectureMigrationMode;
  readonly stateAnchors: readonly ArchitectureStateAnchor[];
  readonly baseline: RawArchitectureMigrationSideCapture;
  readonly challenger: RawArchitectureMigrationSideCapture;
  readonly declaredDeltas?: readonly DeclaredSemanticDelta[];
  readonly performanceDiagnostics: {
    readonly wallMs: number;
    readonly requestCount: number;
    readonly batchCount: number;
    readonly peakConcurrency: number;
  };
}

export interface ArchitectureMigrationCorpusManifest {
  readonly baselinePath: string;
  readonly challengerPath: string;
  readonly evidenceClass: ArchitectureMigrationEvidenceClass;
  readonly mode: ArchitectureMigrationMode;
  readonly stateAnchors: readonly ArchitectureStateAnchor[];
  readonly performanceDiagnostics: ArchitectureMigrationBatchInput["performanceDiagnostics"];
  readonly declaredDeltas?: ArchitectureMigrationBatchInput["declaredDeltas"];
}

export interface SealedProductionArchitectureMigrationBatchInput
  extends Omit<
    ArchitectureMigrationBatchInput,
    "evidenceClass" | "baseline" | "challenger"
  > {
  readonly evidenceClass: "sealed-production";
  readonly baseline: SealedArchitectureMigrationSideCapture;
  readonly challenger: SealedArchitectureMigrationSideCapture;
  readonly productionCaptureIssuer: ArchitectureMigrationProductionCaptureIssuer;
}

declare const SEALED_MIGRATION_BATCH_INPUT: unique symbol;

export type SealedArchitectureMigrationBatchInput =
  Readonly<ArchitectureMigrationBatchInput> & {
    readonly [SEALED_MIGRATION_BATCH_INPUT]: true;
  };

export interface ProductionArchitectureMigrationFamilyContract {
  readonly familyId: string;
  readonly activeCapabilities: readonly FamilyCapabilityName[];
  readonly absentCapabilities: readonly FamilyCapabilityName[];
  readonly requiredStages: readonly ArchitectureMigrationStage[];
  readonly declaredAbsentStages: readonly ArchitectureMigrationStage[];
}

export interface ArchitectureMigrationFamilyCoverageRow {
  readonly familyId: string;
  readonly activeCapabilities: readonly FamilyCapabilityName[];
  readonly requiredStages: readonly ArchitectureMigrationStage[];
  readonly baselineCaseIds: readonly string[];
  readonly challengerCaseIds: readonly string[];
  readonly baselineMissingStages: readonly ArchitectureMigrationStage[];
  readonly challengerMissingStages: readonly ArchitectureMigrationStage[];
  readonly baselineFrameworkBlockers: readonly string[];
  readonly challengerFrameworkBlockers: readonly string[];
  readonly outcome: FamilyArchitectureParityOutcome;
}

export interface ArchitectureMigrationSemanticSetDelta {
  readonly missingIds: readonly string[];
  readonly addedIds: readonly string[];
  readonly changedIds: readonly string[];
}

export interface ArchitectureMigrationCommonGraphDelta {
  readonly baselineCaptureMissing: boolean;
  readonly challengerCaptureMissing: boolean;
  readonly baselineBlockedStages: readonly CommonGraphMigrationStage[];
  readonly challengerBlockedStages: readonly CommonGraphMigrationStage[];
  readonly edges: ArchitectureMigrationSemanticSetDelta;
  readonly enumeratedRoutes: ArchitectureMigrationSemanticSetDelta;
  readonly exactQuotes: ArchitectureMigrationSemanticSetDelta;
  readonly executionFragments: ArchitectureMigrationSemanticSetDelta;
  readonly finalSimulations: ArchitectureMigrationSemanticSetDelta;
  readonly crossFamilyBindings: ArchitectureMigrationSemanticSetDelta;
}

export interface ArchitectureMigrationCrossFamilyConflict {
  readonly side: "baseline" | "challenger";
  readonly kind: RawCrossFamilyBinding["kind"];
  readonly key: string;
  readonly familyIds: readonly string[];
  readonly occurrenceCount: number;
}

export interface ArchitectureMigrationBatchParityReceipt {
  readonly evidenceClass: ArchitectureMigrationEvidenceClass;
  readonly baselineCaptureId: string;
  readonly challengerCaptureId: string;
  readonly parityReceipt: ArchitectureMigrationParityReceipt;
  readonly familyCoverage: readonly ArchitectureMigrationFamilyCoverageRow[];
  readonly commonGraphDelta: ArchitectureMigrationCommonGraphDelta;
  readonly nonMigratedFamilyDelta: ArchitectureMigrationSemanticSetDelta;
  readonly crossFamilyConflicts:
    readonly ArchitectureMigrationCrossFamilyConflict[];
  readonly acceptance: {
    readonly eligible: boolean;
    readonly verdict: "pass" | "partial" | "fail" | "ineligible";
    readonly reasons: readonly string[];
  };
}

const STAGE_CAPABILITIES: Readonly<
  Record<ArchitectureMigrationStage, readonly FamilyCapabilityName[]>
> = Object.freeze({
  instances: Object.freeze(["instance"] as const),
  edges: Object.freeze(["routes"] as const),
  stateCoverage: Object.freeze(["pricing"] as const),
  pricedEdges: Object.freeze(["pricing"] as const),
  prices: Object.freeze(["pricing"] as const),
  failures: FAMILY_CAPABILITY_NAMES,
  enumeratedRoutes: Object.freeze(["routes"] as const),
  exactQuotes: Object.freeze(["exact"] as const),
  executionFragments: Object.freeze(
    ["execution", "funding", "credit"] as const,
  ),
  finalSimulations: Object.freeze(
    ["execution", "funding", "credit"] as const,
  ),
});

export const PRODUCTION_ARCHITECTURE_MIGRATION_COHORT =
  deriveProductionArchitectureMigrationCohort(capabilityShadowArtifact);

export const PRODUCTION_ARCHITECTURE_MIGRATION_FAMILY_IDS = Object.freeze(
  PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.map((item) => item.familyId),
);

const FAMILY_CONTRACTS = new Map(
  PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.map((item) => [item.familyId, item]),
);
const SEALED_INPUTS = new WeakSet<object>();
const productionCaptureIssuers = new WeakSet<object>();
const issuedProductionSideCaptures = new WeakMap<
  object,
  {
    readonly issuer: ArchitectureMigrationProductionCaptureIssuer;
    readonly capture: RawArchitectureMigrationSideCapture;
  }
>();

export function sealArchitectureMigrationBatchInput(
  input:
    | ArchitectureMigrationBatchInput
    | SealedProductionArchitectureMigrationBatchInput,
): SealedArchitectureMigrationBatchInput {
  const evidenceClass = input.evidenceClass;
  const productionCaptureIssuer = "productionCaptureIssuer" in input
    ? input.productionCaptureIssuer
    : undefined;
  const baseline = resolveBatchSideCapture(
    productionCaptureIssuer,
    input.baseline,
    evidenceClass,
  );
  const challenger = resolveBatchSideCapture(
    productionCaptureIssuer,
    input.challenger,
    evidenceClass,
  );
  assertNoSharedObjectReferences(baseline, challenger);
  const clone = structuredClone({
    ...input,
    baseline,
    challenger,
  }) as ArchitectureMigrationBatchInput;
  validateBatchInput(clone);
  const frozen = deepFreeze(clone) as SealedArchitectureMigrationBatchInput;
  SEALED_INPUTS.add(frozen);
  return frozen;
}

export function createArchitectureMigrationProductionCaptureIssuer(): ArchitectureMigrationProductionCaptureIssuer {
  const issuer = Object.freeze({}) as
    ArchitectureMigrationProductionCaptureIssuer;
  productionCaptureIssuers.add(issuer);
  return issuer;
}

export function issueArchitectureMigrationSideCapture(
  issuer: ArchitectureMigrationProductionCaptureIssuer,
  capture: RawArchitectureMigrationSideCapture,
): SealedArchitectureMigrationSideCapture {
  if (!productionCaptureIssuers.has(issuer)) {
    throw new Error("production capture issuer was not centrally issued");
  }
  validateProductionSideCaptureEvidence(capture);
  const handle = Object.freeze({}) as SealedArchitectureMigrationSideCapture;
  issuedProductionSideCaptures.set(handle, Object.freeze({
    issuer,
    capture: deepFreeze(structuredClone(capture)),
  }));
  return handle;
}

function resolveBatchSideCapture(
  issuer: ArchitectureMigrationProductionCaptureIssuer | undefined,
  capture: RawArchitectureMigrationSideCapture |
    SealedArchitectureMigrationSideCapture,
  evidenceClass: ArchitectureMigrationEvidenceClass,
): RawArchitectureMigrationSideCapture {
  if (evidenceClass === "sealed-production") {
    if (
      issuer === undefined ||
      capture === null ||
      typeof capture !== "object" ||
      !Object.isFrozen(capture) ||
      !issuedProductionSideCaptures.has(capture)
    ) {
      throw new Error(
        "sealed-production evidence requires the trusted production capture issuer",
      );
    }
    const record = issuedProductionSideCaptures.get(capture)!;
    if (record.issuer !== issuer) {
      throw new Error(
        "sealed-production evidence requires the trusted production capture issuer",
      );
    }
    return record.capture;
  }
  if (
    capture === null ||
    typeof capture !== "object" ||
    !("closure" in capture)
  ) {
    throw new Error(
      "unit-contract evidence cannot use sealed production captures",
    );
  }
  return capture as RawArchitectureMigrationSideCapture;
}

function validateProductionSideCaptureEvidence(
  capture: RawArchitectureMigrationSideCapture,
): void {
  validateClosure(capture.closure, "production capture");
  for (const familyCase of capture.familyCases) {
    nonempty(familyCase.familyId, "family case familyId");
    nonempty(familyCase.caseId, "family case caseId");
    nonempty(familyCase.inputFingerprint, "family case inputFingerprint");
    nonempty(
      familyCase.implementationClosureHash,
      "family case implementationClosureHash",
    );
    for (const [stage, stageCapture] of Object.entries(familyCase.stages)) {
      if (stageCapture?.status === "exercised") {
        validateEvidenceRefs(
          stageCapture.evidenceRefs,
          `${familyCase.familyId}:${stage}`,
          true,
        );
      }
    }
  }
  const commonGraph = capture.commonGraph;
  if (commonGraph !== null) {
    nonempty(commonGraph.inputFingerprint, "common Graph inputFingerprint");
    for (const [stage, stageCapture] of Object.entries(commonGraph.stages)) {
      if (stageCapture?.status === "exercised") {
        validateEvidenceRefs(
          stageCapture.evidenceRefs,
          `common:${stage}`,
          true,
        );
      }
    }
  }
  const standalone = capture.nonMigratedFamilies;
  if (standalone !== null) {
    nonempty(standalone.inputFingerprint, "standalone inputFingerprint");
    if (standalone.stage.status === "exercised") {
      validateEvidenceRefs(
        standalone.stage.evidenceRefs,
        "standalone",
        true,
      );
    }
  }
}

export function runArchitectureMigrationBatchParity(
  input: SealedArchitectureMigrationBatchInput,
): ArchitectureMigrationBatchParityReceipt {
  if (!SEALED_INPUTS.has(input)) {
    throw new Error(
      "architecture migration runner requires a locally sealed batch input",
    );
  }

  const baseline = normalizeSide(input.baseline, "baseline");
  const challenger = normalizeSide(input.challenger, "challenger");
  const commonGraph = compareCommonGraph(
    input.baseline.commonGraph,
    input.challenger.commonGraph,
  );
  const nonMigrated = compareStandaloneCapture(
    input.baseline.nonMigratedFamilies,
    input.challenger.nonMigratedFamilies,
  );
  const inputManifestHash = hashCanonical(inputManifestProjection(input));
  const scope = Object.freeze({
    kind: "batch" as const,
    familyIds: PRODUCTION_ARCHITECTURE_MIGRATION_FAMILY_IDS,
  });
  const parityReceipt = judgeArchitectureMigration({
    scope,
    mode: input.mode,
    inputManifestHash,
    stateAnchors: input.stateAnchors,
    baseline: baseline.outputs,
    challenger: challenger.outputs,
    declaredDeltas: input.declaredDeltas,
    nonMigratedFamilySemanticHashParity: nonMigrated.parity,
    assembledCommonGraphParity: commonGraph.parity,
    performanceDiagnostics: input.performanceDiagnostics,
  });
  const results = new Map(
    parityReceipt.familyResults.map((result) => [result.familyId, result]),
  );
  const familyCoverage = Object.freeze(
    PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.map((contract) => {
      const before = baseline.coverage.get(contract.familyId)!;
      const after = challenger.coverage.get(contract.familyId)!;
      return deepFreeze({
        familyId: contract.familyId,
        activeCapabilities: contract.activeCapabilities,
        requiredStages: contract.requiredStages,
        baselineCaseIds: before.caseIds,
        challengerCaseIds: after.caseIds,
        baselineMissingStages: before.missingStages,
        challengerMissingStages: after.missingStages,
        baselineFrameworkBlockers: before.blockers,
        challengerFrameworkBlockers: after.blockers,
        outcome: results.get(contract.familyId)!.outcome,
      });
    }),
  );
  const acceptanceEligible = input.evidenceClass === "sealed-production";
  const acceptanceReasons = acceptanceEligible
    ? parityReceipt.aggregateVerdict === "pass"
      ? []
      : ["semantic parity receipt is not pass"]
    : ["unit-contract evidence is not production acceptance evidence"];

  return deepFreeze({
    evidenceClass: input.evidenceClass,
    baselineCaptureId: input.baseline.closure.captureId,
    challengerCaptureId: input.challenger.closure.captureId,
    parityReceipt,
    familyCoverage,
    commonGraphDelta: commonGraph.delta,
    nonMigratedFamilyDelta: nonMigrated.delta,
    crossFamilyConflicts: commonGraph.conflicts,
    acceptance: {
      eligible: acceptanceEligible,
      verdict: acceptanceEligible
        ? parityReceipt.aggregateVerdict
        : "ineligible" as const,
      reasons: Object.freeze(acceptanceReasons),
    },
  });
}

/**
 * Production-shaped file entry for the migration parity harness. Reads one
 * raw side capture JSON per side, then issues/seals through the same trusted
 * batch path: `sealed-production` requires the caller-supplied production
 * capture issuer (evidence refs are re-validated at issue time), while
 * `unit-contract` passes the raw captures through the normal sealing path.
 */
export async function runArchitectureMigrationParityFiles(
  input: {
    readonly baselinePath: string;
    readonly challengerPath: string;
    readonly evidenceClass: ArchitectureMigrationEvidenceClass;
    readonly mode: ArchitectureMigrationMode;
    readonly stateAnchors: readonly ArchitectureStateAnchor[];
    readonly performanceDiagnostics: ArchitectureMigrationBatchInput["performanceDiagnostics"];
    readonly declaredDeltas?: readonly DeclaredSemanticDelta[];
    readonly productionCaptureIssuer?: ArchitectureMigrationProductionCaptureIssuer;
  },
): Promise<ArchitectureMigrationBatchParityReceipt> {
  const readSide = async (
    path: string,
  ): Promise<RawArchitectureMigrationSideCapture> => {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("closure" in parsed)
    ) {
      throw new Error(
        `${path} is not a raw architecture migration side capture`,
      );
    }
    return parsed as RawArchitectureMigrationSideCapture;
  };
  const baseline = await readSide(input.baselinePath);
  const challenger = await readSide(input.challengerPath);
  const issuer = input.productionCaptureIssuer;
  let batch: ArchitectureMigrationBatchInput |
    SealedProductionArchitectureMigrationBatchInput;
  if (input.evidenceClass === "sealed-production") {
    if (issuer === undefined) {
      throw new Error(
        "sealed-production evidence requires the trusted production capture issuer",
      );
    }
    batch = {
      ...input,
      evidenceClass: "sealed-production",
      productionCaptureIssuer: issuer,
      baseline: issueArchitectureMigrationSideCapture(issuer, baseline),
      challenger: issueArchitectureMigrationSideCapture(issuer, challenger),
    };
  } else {
    const { productionCaptureIssuer: _ignored, ...unitInput } = input;
    batch = {
      ...unitInput,
      evidenceClass: "unit-contract",
      baseline,
      challenger,
    };
  }
  return runArchitectureMigrationBatchParity(
    sealArchitectureMigrationBatchInput(batch),
  );
}

/**
 * Validates the on-disk batch request that the node workflow feeds to
 * `architecture-migration-parity:run`: both side-capture paths, the evidence
 * class/mode, state anchors and performance diagnostics must be well-formed
 * before any capture file is read or any issuer is minted.
 */
export function validateArchitectureMigrationRequestFile(
  request: unknown,
): ArchitectureMigrationCorpusManifest {
  if (request === null || typeof request !== "object") {
    throw new Error("batch request must be an object");
  }
  const candidate = request as Partial<ArchitectureMigrationCorpusManifest>;
  for (const key of ["baselinePath", "challengerPath"] as const) {
    const value = candidate[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${key} must be a non-empty path`);
    }
  }
  if (candidate.baselinePath === candidate.challengerPath) {
    throw new Error("baseline and challenger paths must be distinct");
  }
  if (
    candidate.evidenceClass !== "unit-contract" &&
    candidate.evidenceClass !== "sealed-production"
  ) {
    throw new Error("evidenceClass must be unit-contract or sealed-production");
  }
  if (
    candidate.mode !== "pure-refactor" &&
    candidate.mode !== "declared-improvement"
  ) {
    throw new Error("mode must be pure-refactor or declared-improvement");
  }
  if (!Array.isArray(candidate.stateAnchors) || candidate.stateAnchors.length === 0) {
    throw new Error("stateAnchors must be a non-empty array");
  }
  for (const anchor of candidate.stateAnchors) {
    if (anchor === null || typeof anchor !== "object") {
      throw new Error("stateAnchors entries must be objects");
    }
    const value = anchor as Partial<ArchitectureStateAnchor>;
    if (
      typeof value.number !== "number" ||
      !Number.isSafeInteger(value.number) ||
      value.number < 0 ||
      typeof value.hash !== "string" ||
      value.hash.trim() === "" ||
      typeof value.stateRoot !== "string" ||
      value.stateRoot.trim() === ""
    ) {
      throw new Error(
        `invalid stateAnchor ${String(value.number ?? "?")}`,
      );
    }
  }
  const diagnostics = candidate.performanceDiagnostics;
  if (diagnostics === null || typeof diagnostics !== "object") {
    throw new Error("performanceDiagnostics must be an object");
  }
  for (const key of ["wallMs", "requestCount", "batchCount", "peakConcurrency"] as const) {
    const value = diagnostics[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`performanceDiagnostics.${key} must be non-negative`);
    }
  }
  return request as ArchitectureMigrationCorpusManifest;
}

/**
 * Assembles one raw side capture from replay outputs. The node capture
 * harness calls this after executing a frozen corpus on a pinned commit;
 * the batch validation and trusted issuer still run afterwards.
 */
export function buildArchitectureMigrationSideCapture(input: {
  readonly captureId: string;
  readonly commit: string;
  readonly productionClosureHash: string;
  readonly activationManifestHash: string;
  readonly normalizedConfigHash: string;
  readonly productionPolicyHash: string;
  readonly corpusHash: string;
  readonly evidenceRefs: readonly string[];
  readonly familyCases: readonly RawFamilyMigrationCaseCapture[];
  readonly commonGraph?: RawCommonGraphMigrationCapture | null;
  readonly nonMigratedFamilies?: RawStandaloneSemanticCapture | null;
}): RawArchitectureMigrationSideCapture {
  const closure: MigrationClosureDescriptor = Object.freeze({
    captureId: nonempty(input.captureId, "captureId"),
    commit: nonempty(input.commit, "commit"),
    productionClosureHash: nonempty(
      input.productionClosureHash,
      "productionClosureHash",
    ),
    activationManifestHash: nonempty(
      input.activationManifestHash,
      "activationManifestHash",
    ),
    normalizedConfigHash: nonempty(
      input.normalizedConfigHash,
      "normalizedConfigHash",
    ),
    productionPolicyHash: nonempty(
      input.productionPolicyHash,
      "productionPolicyHash",
    ),
    corpusHash: nonempty(input.corpusHash, "corpusHash"),
    evidenceRefs: Object.freeze(
      [...new Set(input.evidenceRefs)].sort(),
    ),
  });
  return Object.freeze({
    closure,
    familyCases: Object.freeze([...input.familyCases]),
    commonGraph: input.commonGraph ?? null,
    nonMigratedFamilies: input.nonMigratedFamilies ?? null,
  });
}

interface SideFamilyCoverage {
  readonly caseIds: readonly string[];
  readonly missingStages: readonly ArchitectureMigrationStage[];
  readonly blockers: readonly string[];
}

function normalizeSide(
  capture: RawArchitectureMigrationSideCapture,
  side: "baseline" | "challenger",
): {
  readonly outputs: readonly CanonicalFamilySemanticOutput[];
  readonly coverage: ReadonlyMap<string, SideFamilyCoverage>;
} {
  const casesByFamily = new Map<string, RawFamilyMigrationCaseCapture[]>();
  for (const item of capture.familyCases) {
    const cases = casesByFamily.get(item.familyId) ?? [];
    cases.push(item);
    casesByFamily.set(item.familyId, cases);
  }
  const outputs: CanonicalFamilySemanticOutput[] = [];
  const coverage = new Map<string, SideFamilyCoverage>();
  for (const contract of PRODUCTION_ARCHITECTURE_MIGRATION_COHORT) {
    const cases = [...(casesByFamily.get(contract.familyId) ?? [])].sort(
      (left, right) => left.caseId.localeCompare(right.caseId),
    );
    if (cases.length === 0) {
      coverage.set(contract.familyId, deepFreeze({
        caseIds: [],
        missingStages: contract.requiredStages,
        blockers: [],
      }));
      continue;
    }
    const missingStages = new Set<ArchitectureMigrationStage>();
    const blockers: string[] = [];
    const required = new Set(contract.requiredStages);
    for (const item of cases) {
      for (const stage of ARCHITECTURE_MIGRATION_STAGES) {
        const expected = required.has(stage) ? "exercised" : "declared-absent";
        const actual = item.stages[stage];
        if (actual?.status !== expected) {
          missingStages.add(stage);
          blockers.push(
            `${item.caseId}:${stage}:expected-${expected}-received-` +
              `${actual?.status ?? "missing"}`,
          );
        }
        if (actual?.status === "framework-blocked") {
          blockers.push(`${item.caseId}:${stage}:${actual.blocker}`);
        }
      }
    }
    const evidenceRefs = new Set(capture.closure.evidenceRefs);
    for (const item of cases) {
      for (const stage of Object.values(item.stages)) {
        for (const evidenceRef of stage?.evidenceRefs ?? []) {
          evidenceRefs.add(evidenceRef);
        }
      }
    }
    const normalized: CanonicalFamilySemanticOutput = deepFreeze({
      familyId: contract.familyId,
      implementationClosureHash: cases[0].implementationClosureHash,
      exercisedCaseIds: Object.freeze(cases.map((item) => item.caseId)),
      frameworkBlocker: blockers.length === 0
        ? null
        : [...new Set(blockers)].sort().join(";"),
      instances: normalizeFamilyStage(cases, "instances", side === "baseline"),
      edges: normalizeFamilyStage(cases, "edges", side === "baseline"),
      stateCoverage: normalizeFamilyStage(
        cases,
        "stateCoverage",
        side === "baseline",
      ),
      pricedEdges: normalizeFamilyStage(
        cases,
        "pricedEdges",
        side === "baseline",
      ),
      prices: normalizeFamilyStage(cases, "prices", side === "baseline"),
      failures: normalizeFamilyStage(cases, "failures", side === "baseline"),
      enumeratedRoutes: normalizeFamilyStage(
        cases,
        "enumeratedRoutes",
        side === "baseline",
      ),
      exactQuotes: normalizeFamilyStage(
        cases,
        "exactQuotes",
        side === "baseline",
      ),
      executionFragments: normalizeFamilyStage(
        cases,
        "executionFragments",
        side === "baseline",
      ),
      finalSimulations: normalizeFamilyStage(
        cases,
        "finalSimulations",
        side === "baseline",
      ),
      evidenceRefs: Object.freeze([...evidenceRefs].sort()),
    });
    outputs.push(normalized);
    coverage.set(contract.familyId, deepFreeze({
      caseIds: normalized.exercisedCaseIds,
      missingStages: Object.freeze([...missingStages].sort()),
      blockers: Object.freeze([...new Set(blockers)].sort()),
    }));
  }
  return Object.freeze({
    outputs: Object.freeze(outputs),
    coverage,
  });
}

function normalizeFamilyStage(
  cases: readonly RawFamilyMigrationCaseCapture[],
  stage: ArchitectureMigrationStage,
  normalizeBaseline: boolean,
): readonly CanonicalSemanticItem[] {
  const observations = new Map<
    string,
    { readonly caseId: string; readonly value: CanonicalValue }[]
  >();
  for (const item of cases) {
    const stageCapture = item.stages[stage];
    if (stageCapture?.status !== "exercised") continue;
    const rawItems = normalizeBaseline
      ? normalizeBaselineMigrationItems(stage, stageCapture.items)
      : stageCapture.items;
    for (const raw of rawItems) {
      const values = observations.get(raw.id) ?? [];
      values.push({ caseId: item.caseId, value: raw.value });
      observations.set(raw.id, values);
    }
  }
  return Object.freeze([...observations]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, values]) => Object.freeze({
      id,
      semanticHash: hashCanonical(values
        .sort((left, right) => left.caseId.localeCompare(right.caseId))
        .map((item) => ({ caseId: item.caseId, value: item.value }))),
    })));
}

function compareCommonGraph(
  baseline: RawCommonGraphMigrationCapture | null,
  challenger: RawCommonGraphMigrationCapture | null,
): {
  readonly parity: boolean;
  readonly delta: ArchitectureMigrationCommonGraphDelta;
  readonly conflicts: readonly ArchitectureMigrationCrossFamilyConflict[];
} {
  const baselineBlocked = blockedCommonGraphStages(baseline);
  const challengerBlocked = blockedCommonGraphStages(challenger);
  const deltas = Object.fromEntries(COMMON_GRAPH_MIGRATION_STAGES.map((stage) => [
    stage,
    compareSemanticItems(
      normalizeBaselineMigrationItems(
        stage,
        exercisedItems(baseline?.stages[stage]),
      ),
      exercisedItems(challenger?.stages[stage]),
    ),
  ])) as Record<CommonGraphMigrationStage, ArchitectureMigrationSemanticSetDelta>;
  const baselineBindings = normalizeBindings(baseline?.crossFamilyBindings ?? []);
  const challengerBindings = normalizeBindings(
    challenger?.crossFamilyBindings ?? [],
  );
  const bindingDelta = compareCanonicalItems(
    baselineBindings.items,
    challengerBindings.items,
  );
  const conflicts = Object.freeze([
    ...baselineBindings.conflicts.map((item) => ({
      ...item,
      side: "baseline" as const,
    })),
    ...challengerBindings.conflicts.map((item) => ({
      ...item,
      side: "challenger" as const,
    })),
  ]);
  const delta = deepFreeze({
    baselineCaptureMissing: baseline === null,
    challengerCaptureMissing: challenger === null,
    baselineBlockedStages: baselineBlocked,
    challengerBlockedStages: challengerBlocked,
    edges: deltas.edges,
    enumeratedRoutes: deltas.enumeratedRoutes,
    exactQuotes: deltas.exactQuotes,
    executionFragments: deltas.executionFragments,
    finalSimulations: deltas.finalSimulations,
    crossFamilyBindings: bindingDelta,
  });
  const parity = baseline !== null &&
    challenger !== null &&
    baselineBlocked.length === 0 &&
    challengerBlocked.length === 0 &&
    conflicts.length === 0 &&
    [
      ...Object.values(deltas),
      bindingDelta,
    ].every(deltaIsEmpty);
  return Object.freeze({ parity, delta, conflicts });
}

function compareStandaloneCapture(
  baseline: RawStandaloneSemanticCapture | null,
  challenger: RawStandaloneSemanticCapture | null,
): {
  readonly parity: boolean;
  readonly delta: ArchitectureMigrationSemanticSetDelta;
} {
  const delta = compareSemanticItems(
    exercisedItems(baseline?.stage),
    exercisedItems(challenger?.stage),
  );
  return Object.freeze({
    parity: baseline !== null &&
      challenger !== null &&
      baseline.stage.status === "exercised" &&
      challenger.stage.status === "exercised" &&
      deltaIsEmpty(delta),
    delta,
  });
}

function exercisedItems(
  capture: RawMigrationStageCapture | undefined,
): readonly RawMigrationSemanticItem[] {
  return capture?.status === "exercised" ? capture.items : [];
}

function blockedCommonGraphStages(
  capture: RawCommonGraphMigrationCapture | null,
): readonly CommonGraphMigrationStage[] {
  if (capture === null) return COMMON_GRAPH_MIGRATION_STAGES;
  return Object.freeze(COMMON_GRAPH_MIGRATION_STAGES.filter(
    (stage) => capture.stages[stage]?.status !== "exercised",
  ));
}

function compareSemanticItems(
  baseline: readonly RawMigrationSemanticItem[],
  challenger: readonly RawMigrationSemanticItem[],
): ArchitectureMigrationSemanticSetDelta {
  return compareCanonicalItems(
    canonicalizeRawItems(baseline),
    canonicalizeRawItems(challenger),
  );
}

function canonicalizeRawItems(
  items: readonly RawMigrationSemanticItem[],
): readonly CanonicalSemanticItem[] {
  return Object.freeze(items.map((item) => Object.freeze({
    id: item.id,
    semanticHash: hashCanonical(item.value),
  })));
}

function compareCanonicalItems(
  baseline: readonly CanonicalSemanticItem[],
  challenger: readonly CanonicalSemanticItem[],
): ArchitectureMigrationSemanticSetDelta {
  const before = new Map(baseline.map((item) => [item.id, item.semanticHash]));
  const after = new Map(challenger.map((item) => [item.id, item.semanticHash]));
  return deepFreeze({
    missingIds: [...before.keys()].filter((id) => !after.has(id)).sort(),
    addedIds: [...after.keys()].filter((id) => !before.has(id)).sort(),
    changedIds: [...before.keys()]
      .filter((id) => after.has(id) && before.get(id) !== after.get(id))
      .sort(),
  });
}

function deltaIsEmpty(delta: ArchitectureMigrationSemanticSetDelta): boolean {
  return delta.missingIds.length === 0 &&
    delta.addedIds.length === 0 &&
    delta.changedIds.length === 0;
}

function normalizeBindings(bindings: readonly RawCrossFamilyBinding[]): {
  readonly items: readonly CanonicalSemanticItem[];
  readonly conflicts: readonly Omit<
    ArchitectureMigrationCrossFamilyConflict,
    "side"
  >[];
} {
  const grouped = new Map<string, RawCrossFamilyBinding[]>();
  for (const binding of bindings) {
    const id = `${binding.kind}:${binding.key}`;
    const values = grouped.get(id) ?? [];
    values.push(binding);
    grouped.set(id, values);
  }
  const items: CanonicalSemanticItem[] = [];
  const conflicts: Omit<ArchitectureMigrationCrossFamilyConflict, "side">[] = [];
  for (const [id, values] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const sorted = values.map((item) => ({
      familyId: item.familyId,
      value: item.value,
    })).sort((left, right) =>
      left.familyId.localeCompare(right.familyId) ||
      hashCanonical(left.value).localeCompare(hashCanonical(right.value))
    );
    items.push(Object.freeze({ id, semanticHash: hashCanonical(sorted) }));
    if (values.length > 1) {
      const [kind, ...keyParts] = id.split(":");
      conflicts.push(deepFreeze({
        kind: kind as RawCrossFamilyBinding["kind"],
        key: keyParts.join(":"),
        familyIds: [...new Set(values.map((item) => item.familyId))].sort(),
        occurrenceCount: values.length,
      }));
    }
  }
  return Object.freeze({
    items: Object.freeze(items),
    conflicts: Object.freeze(conflicts),
  });
}

function inputManifestProjection(
  input: SealedArchitectureMigrationBatchInput,
): CanonicalValue {
  const shared = input.baseline.closure;
  return {
    mode: input.mode,
    familyIds: PRODUCTION_ARCHITECTURE_MIGRATION_FAMILY_IDS,
    activationManifestHash: shared.activationManifestHash,
    normalizedConfigHash: shared.normalizedConfigHash,
    productionPolicyHash: shared.productionPolicyHash,
    corpusHash: shared.corpusHash,
    stateAnchors: input.stateAnchors.map((anchor) => ({
      number: anchor.number,
      hash: anchor.hash,
      stateRoot: anchor.stateRoot,
    })),
    declaredDeltas: (input.declaredDeltas ?? []).map((delta) => ({
      familyId: delta.familyId,
      kind: delta.kind,
      affectedCanonicalIds: delta.affectedCanonicalIds,
      independentEvidenceRefs: delta.independentEvidenceRefs,
    })),
  };
}

function validateBatchInput(input: ArchitectureMigrationBatchInput): void {
  if (
    input.evidenceClass !== "unit-contract" &&
    input.evidenceClass !== "sealed-production"
  ) {
    throw new Error("invalid architecture migration evidence class");
  }
  if (input.mode !== "pure-refactor" && input.mode !== "declared-improvement") {
    throw new Error("invalid architecture migration mode");
  }
  const anchorNumbers = validateAnchors(input.stateAnchors);
  validateClosure(input.baseline.closure, "baseline");
  validateClosure(input.challenger.closure, "challenger");
  assertDistinctClosureIdentity(input.baseline.closure, input.challenger.closure);
  assertSameFrozenInputs(input.baseline.closure, input.challenger.closure);
  const baselineCases = validateSideCapture(input.baseline, "baseline", anchorNumbers);
  const challengerCases = validateSideCapture(
    input.challenger,
    "challenger",
    anchorNumbers,
  );
  assertSameCaseInputs(baselineCases, challengerCases);
  assertSameOptionalCaptureInput(
    input.baseline.commonGraph,
    input.challenger.commonGraph,
    "common Graph",
  );
  assertSameOptionalCaptureInput(
    input.baseline.nonMigratedFamilies,
    input.challenger.nonMigratedFamilies,
    "non-migrated Family",
  );
  validatePerformanceDiagnostics(input.performanceDiagnostics);
}

function validateClosure(
  closure: MigrationClosureDescriptor,
  side: string,
): void {
  nonempty(closure.captureId, `${side} captureId`);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(closure.commit)) {
    throw new Error(`${side} commit must be a lowercase git object id`);
  }
  for (const [key, value] of Object.entries({
    productionClosureHash: closure.productionClosureHash,
    activationManifestHash: closure.activationManifestHash,
    normalizedConfigHash: closure.normalizedConfigHash,
    productionPolicyHash: closure.productionPolicyHash,
    corpusHash: closure.corpusHash,
  })) {
    assertSha256(value, `${side} ${key}`);
  }
  validateEvidenceRefs(closure.evidenceRefs, `${side} closure`, true);
}

function assertDistinctClosureIdentity(
  baseline: MigrationClosureDescriptor,
  challenger: MigrationClosureDescriptor,
): void {
  if (baseline.captureId === challenger.captureId) {
    throw new Error("baseline/challenger captureId must be distinct");
  }
  if (baseline.commit === challenger.commit) {
    throw new Error("baseline/challenger commit must be distinct");
  }
  if (baseline.productionClosureHash === challenger.productionClosureHash) {
    throw new Error("baseline/challenger production closure must be distinct");
  }
}

function assertSameFrozenInputs(
  baseline: MigrationClosureDescriptor,
  challenger: MigrationClosureDescriptor,
): void {
  for (const key of [
    "activationManifestHash",
    "normalizedConfigHash",
    "productionPolicyHash",
    "corpusHash",
  ] as const) {
    if (baseline[key] !== challenger[key]) {
      throw new Error(`baseline/challenger ${key} mismatch`);
    }
  }
}

function validateAnchors(
  anchors: readonly ArchitectureStateAnchor[],
): ReadonlySet<number> {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error("architecture migration batch requires StateAnchors");
  }
  const numbers = new Set<number>();
  for (const anchor of anchors) {
    if (!Number.isSafeInteger(anchor.number) || anchor.number < 0) {
      throw new Error(`invalid StateAnchor number ${anchor.number}`);
    }
    if (numbers.has(anchor.number)) {
      throw new Error(`duplicate StateAnchor number ${anchor.number}`);
    }
    numbers.add(anchor.number);
    if (!/^0x[0-9a-fA-F]{64}$/.test(anchor.hash)) {
      throw new Error("StateAnchor hash must be bytes32");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(anchor.stateRoot)) {
      throw new Error("StateAnchor stateRoot must be bytes32");
    }
  }
  return numbers;
}

function validateSideCapture(
  capture: RawArchitectureMigrationSideCapture,
  side: "baseline" | "challenger",
  anchorNumbers: ReadonlySet<number>,
): ReadonlyMap<string, RawFamilyMigrationCaseCapture> {
  if (!Array.isArray(capture.familyCases)) {
    throw new Error(`${side} familyCases must be an array`);
  }
  const cases = new Map<string, RawFamilyMigrationCaseCapture>();
  const familyClosures = new Map<string, string>();
  for (const item of capture.familyCases) {
    if (!FAMILY_CONTRACTS.has(item.familyId)) {
      throw new Error(`${side} capture contains non-production Family ${item.familyId}`);
    }
    nonempty(item.caseId, `${side} caseId`);
    assertSha256(item.inputFingerprint, `${side} case inputFingerprint`);
    assertSha256(
      item.implementationClosureHash,
      `${side} case implementationClosureHash`,
    );
    if (!anchorNumbers.has(item.stateAnchorNumber)) {
      throw new Error(
        `${side} case ${item.familyId}/${item.caseId} references unknown ` +
          `StateAnchor ${item.stateAnchorNumber}`,
      );
    }
    validateStageRecord(item.stages, `${side} ${item.familyId}/${item.caseId}`);
    const key = `${item.familyId}\u0000${item.caseId}`;
    if (cases.has(key)) throw new Error(`${side} duplicates case ${key}`);
    cases.set(key, item);
    const closure = familyClosures.get(item.familyId);
    if (closure !== undefined && closure !== item.implementationClosureHash) {
      throw new Error(`${side} ${item.familyId} uses multiple implementation closures`);
    }
    familyClosures.set(item.familyId, item.implementationClosureHash);
  }
  if (capture.commonGraph !== null) {
    assertSha256(
      capture.commonGraph.inputFingerprint,
      `${side} common Graph inputFingerprint`,
    );
    validateStageRecord(
      capture.commonGraph.stages,
      `${side} common Graph`,
      COMMON_GRAPH_MIGRATION_STAGES,
    );
    for (const binding of capture.commonGraph.crossFamilyBindings) {
      if (!["action", "selector", "state"].includes(binding.kind)) {
        throw new Error(`${side} common Graph has invalid binding kind`);
      }
      nonempty(binding.key, `${side} binding key`);
      if (!FAMILY_CONTRACTS.has(binding.familyId)) {
        throw new Error(`${side} binding has unknown Family ${binding.familyId}`);
      }
      hashCanonical(binding.value);
    }
  }
  if (capture.nonMigratedFamilies !== null) {
    assertSha256(
      capture.nonMigratedFamilies.inputFingerprint,
      `${side} non-migrated inputFingerprint`,
    );
    validateStageCapture(
      capture.nonMigratedFamilies.stage,
      `${side} non-migrated Families`,
    );
    if (capture.nonMigratedFamilies.stage.status === "declared-absent") {
      throw new Error("non-migrated Family capture cannot be declared-absent");
    }
  }
  return cases;
}

function validateStageRecord(
  stages: Readonly<Partial<Record<ArchitectureMigrationStage, RawMigrationStageCapture>>>,
  label: string,
  allowed: readonly ArchitectureMigrationStage[] = ARCHITECTURE_MIGRATION_STAGES,
): void {
  if (stages === null || typeof stages !== "object" || Array.isArray(stages)) {
    throw new Error(`${label} stages must be a record`);
  }
  const allowedSet = new Set<string>(allowed);
  for (const [stage, capture] of Object.entries(stages)) {
    if (!allowedSet.has(stage)) throw new Error(`${label} has unknown stage ${stage}`);
    if (capture !== undefined) validateStageCapture(capture, `${label} ${stage}`);
  }
}

function validateStageCapture(
  capture: RawMigrationStageCapture,
  label: string,
): void {
  if (![
    "exercised",
    "declared-absent",
    "framework-blocked",
  ].includes(capture.status)) {
    throw new Error(`${label} has invalid stage status`);
  }
  if (!Array.isArray(capture.items)) throw new Error(`${label} items must be an array`);
  const ids = new Set<string>();
  for (const item of capture.items) {
    nonempty(item.id, `${label} item id`);
    if (ids.has(item.id)) throw new Error(`${label} duplicates item ${item.id}`);
    ids.add(item.id);
    hashCanonical(item.value);
  }
  if (capture.status !== "exercised" && capture.items.length > 0) {
    throw new Error(`${label} non-exercised stage cannot contain semantic items`);
  }
  validateEvidenceRefs(
    capture.evidenceRefs,
    label,
    capture.status !== "declared-absent",
  );
  if (capture.status === "framework-blocked") {
    nonempty(capture.blocker, `${label} blocker`);
  } else if (capture.blocker !== null) {
    throw new Error(`${label} ${capture.status} stage cannot declare a blocker`);
  }
}

function assertSameCaseInputs(
  baseline: ReadonlyMap<string, RawFamilyMigrationCaseCapture>,
  challenger: ReadonlyMap<string, RawFamilyMigrationCaseCapture>,
): void {
  const keys = new Set([...baseline.keys(), ...challenger.keys()]);
  for (const key of keys) {
    const before = baseline.get(key);
    const after = challenger.get(key);
    if (before === undefined || after === undefined) {
      throw new Error(`baseline/challenger case set mismatch at ${key}`);
    }
    if (before.inputFingerprint !== after.inputFingerprint) {
      throw new Error(`baseline/challenger case inputFingerprint mismatch at ${key}`);
    }
    if (before.stateAnchorNumber !== after.stateAnchorNumber) {
      throw new Error(`baseline/challenger StateAnchor mismatch at ${key}`);
    }
  }
}

function assertSameOptionalCaptureInput(
  baseline: { readonly inputFingerprint: string } | null,
  challenger: { readonly inputFingerprint: string } | null,
  label: string,
): void {
  if (
    baseline !== null &&
    challenger !== null &&
    baseline.inputFingerprint !== challenger.inputFingerprint
  ) {
    throw new Error(`baseline/challenger ${label} inputFingerprint mismatch`);
  }
}

function validateEvidenceRefs(
  refs: readonly string[],
  label: string,
  required: boolean,
): void {
  if (!Array.isArray(refs)) throw new Error(`${label} evidenceRefs must be an array`);
  if (required && refs.length === 0) throw new Error(`${label} lacks evidenceRefs`);
  const seen = new Set<string>();
  for (const ref of refs) {
    nonempty(ref, `${label} evidenceRef`);
    if (seen.has(ref)) throw new Error(`${label} duplicates evidenceRef ${ref}`);
    seen.add(ref);
  }
}

function validatePerformanceDiagnostics(
  diagnostics: ArchitectureMigrationBatchInput["performanceDiagnostics"],
): void {
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid performance diagnostic ${key}=${value}`);
    }
  }
}

function deriveProductionArchitectureMigrationCohort(
  artifact: unknown,
): readonly ProductionArchitectureMigrationFamilyContract[] {
  const value = artifact as {
    readonly format?: unknown;
    readonly exact?: unknown;
    readonly legacy?: unknown;
    readonly issues?: unknown;
    readonly complete?: unknown;
  };
  if (
    value.format !== "adapter-family-capability-shadow-v1" ||
    value.complete !== true ||
    !Array.isArray(value.exact) ||
    !Array.isArray(value.legacy) ||
    value.legacy.length !== 0 ||
    !Array.isArray(value.issues) ||
    value.issues.length !== 0
  ) {
    throw new Error("architecture migration cohort requires a complete exact artifact");
  }
  const families = new Map<string, Map<FamilyCapabilityName, boolean>>();
  for (const raw of value.exact) {
    const record = raw as {
      readonly identity?: { readonly familyId?: unknown; readonly capability?: unknown };
      readonly root?: { readonly absence?: unknown };
    };
    const familyId = nonempty(record.identity?.familyId, "generated Family id");
    const capability = record.identity?.capability;
    if (!FAMILY_CAPABILITY_NAMES.includes(capability as FamilyCapabilityName)) {
      throw new Error(`${familyId} has invalid generated capability ${String(capability)}`);
    }
    const absence = record.root?.absence;
    if (absence !== null && absence !== "declared-absent") {
      throw new Error(`${familyId}/${String(capability)} has invalid absence`);
    }
    const capabilities = families.get(familyId) ?? new Map();
    if (capabilities.has(capability as FamilyCapabilityName)) {
      throw new Error(`${familyId} duplicates generated capability ${String(capability)}`);
    }
    capabilities.set(capability as FamilyCapabilityName, absence === null);
    families.set(familyId, capabilities);
  }
  return deepFreeze([...families]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, capabilities]) => {
      for (const capability of FAMILY_CAPABILITY_NAMES) {
        if (!capabilities.has(capability)) {
          throw new Error(`${familyId} lacks generated capability ${capability}`);
        }
      }
      const activeCapabilities = FAMILY_CAPABILITY_NAMES.filter(
        (capability) => capabilities.get(capability) === true,
      );
      const absentCapabilities = FAMILY_CAPABILITY_NAMES.filter(
        (capability) => capabilities.get(capability) === false,
      );
      const requiredStages = ARCHITECTURE_MIGRATION_STAGES.filter((stage) =>
        STAGE_CAPABILITIES[stage].some((capability) =>
          activeCapabilities.includes(capability)
        )
      );
      const required = new Set(requiredStages);
      return {
        familyId,
        activeCapabilities,
        absentCapabilities,
        requiredStages,
        declaredAbsentStages: ARCHITECTURE_MIGRATION_STAGES.filter(
          (stage) => !required.has(stage),
        ),
      };
    }));
}

function assertNoSharedObjectReferences(
  baseline: object,
  challenger: object,
): void {
  const baselineObjects = collectObjectReferences(baseline);
  const challengerObjects = collectObjectReferences(challenger);
  for (const value of challengerObjects) {
    if (baselineObjects.has(value)) {
      throw new Error(
        "baseline/challenger captures share an object reference; " +
          "capture both closures independently",
      );
    }
  }
}

function collectObjectReferences(root: object): Set<object> {
  const values = new Set<object>();
  const pending: object[] = [root];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (values.has(value)) continue;
    values.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return values;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as object)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}
