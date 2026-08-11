import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHITECTURE_MIGRATION_STAGES,
  COMMON_GRAPH_MIGRATION_STAGES,
  PRODUCTION_ARCHITECTURE_MIGRATION_COHORT,
  PRODUCTION_ARCHITECTURE_MIGRATION_FAMILY_IDS,
  buildArchitectureMigrationSideCapture,
  createArchitectureMigrationProductionCaptureIssuer,
  issueArchitectureMigrationSideCapture,
  runArchitectureMigrationBatchParity,
  runArchitectureMigrationParityFiles,
  sealArchitectureMigrationBatchInput,
  validateArchitectureMigrationRequestFile,
  type ArchitectureMigrationBatchInput,
  type ArchitectureMigrationStage,
  type CommonGraphMigrationStage,
  type ProductionArchitectureMigrationFamilyContract,
  type RawArchitectureMigrationSideCapture,
  type RawFamilyMigrationCaseCapture,
  type RawMigrationStageCapture,
  type SealedArchitectureMigrationBatchInput,
  type SealedArchitectureMigrationSideCapture,
} from "../architecture-migration-parity-runner.js";

const SHA = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const HASH = `0x${"11".repeat(32)}`;
const EXPECTED_FAMILY_IDS = [
  "credit:fluid",
  "curve-underlying",
  "custom-swap:angstrom-v4",
  "custom-swap:dodo-v2",
  "flash-loan:balancer-v2",
  "flash-loan:morpho",
  "fluid-dex",
  "protocol:astra-multitoken",
  "protocol:eigenpie",
  "protocol:erc4626",
  "protocol:erc4626-silo-redeem",
  "protocol:ethertoken-native-redeem",
  "protocol:goldx",
  "protocol:metronome-hgusdc",
  "protocol:metronome-synth",
  "protocol:psm",
  "protocol:rocksolid",
  "protocol:self-burn-native",
  "protocol:wsteth",
  "univ2-standard",
  "univ3-standard",
  "univ4",
] as const;

type Side = "baseline" | "challenger";

interface FixtureOptions {
  readonly families?: readonly ProductionArchitectureMigrationFamilyContract[];
  readonly includeCommonGraph?: boolean;
  readonly blocked?: {
    readonly familyId: string;
    readonly stage: ArchitectureMigrationStage;
    readonly side: Side;
  };
  readonly changedFamilyStage?: {
    readonly familyId: string;
    readonly stage: ArchitectureMigrationStage;
    readonly side: Side;
  };
  readonly changedGraphStage?: {
    readonly stage: CommonGraphMigrationStage;
    readonly side: Side;
  };
  readonly stateAnchorNumber?: Readonly<Partial<Record<Side, number>>>;
}

assert.deepEqual(
  PRODUCTION_ARCHITECTURE_MIGRATION_FAMILY_IDS,
  EXPECTED_FAMILY_IDS,
);
assert.equal(PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.length, 22);
assert(PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.every((contract) =>
  contract.activeCapabilities.length + contract.absentCapabilities.length === 10
));

const empty = sealArchitectureMigrationBatchInput(fixtureInput({
  families: [],
  includeCommonGraph: false,
}));
const emptyReceipt = runArchitectureMigrationBatchParity(empty);
assert.equal(emptyReceipt.familyCoverage.length, 22);
assert(emptyReceipt.familyCoverage.every((row) => row.outcome === "not-exercised"));
assert.deepEqual(
  emptyReceipt.parityReceipt.nonPassFamilyIds,
  EXPECTED_FAMILY_IDS,
);
assert.equal(emptyReceipt.parityReceipt.assembledCommonGraphParity, false);
assert.equal(emptyReceipt.parityReceipt.aggregateVerdict, "fail");

const blockedFamily = "custom-swap:dodo-v2";
const blockedInput = sealArchitectureMigrationBatchInput(fixtureInput({
  families: PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.filter(
    (contract) => contract.familyId === blockedFamily,
  ),
  includeCommonGraph: false,
  blocked: {
    familyId: blockedFamily,
    stage: "exactQuotes",
    side: "challenger",
  },
}));
const blockedReceipt = runArchitectureMigrationBatchParity(blockedInput);
const blockedRow = blockedReceipt.familyCoverage.find(
  (row) => row.familyId === blockedFamily,
)!;
assert.equal(blockedRow.outcome, "framework-blocked");
assert.deepEqual(blockedRow.challengerMissingStages, ["exactQuotes"]);
assert(blockedRow.challengerFrameworkBlockers.some((item) =>
  item.includes("transport-unavailable")
));

const complete = sealArchitectureMigrationBatchInput(fixtureInput({}));
const completeReceipt = runArchitectureMigrationBatchParity(complete);
assert.equal(completeReceipt.parityReceipt.aggregateVerdict, "pass");
assert.deepEqual(completeReceipt.parityReceipt.nonPassFamilyIds, []);
assert(completeReceipt.familyCoverage.every((row) => row.outcome === "pass"));
assert.equal(completeReceipt.parityReceipt.assembledCommonGraphParity, true);
assert.equal(completeReceipt.acceptance.eligible, false);
assert.equal(completeReceipt.acceptance.verdict, "ineligible");
assert.deepEqual(completeReceipt.heldOutNegativeVerdicts, []);

const heldRaw = fixtureInput({});
const heldChallenger: RawArchitectureMigrationSideCapture = {
  ...heldRaw.challenger,
  familyCases: heldRaw.challenger.familyCases.map((familyCase) =>
    familyCase.familyId === "univ2-standard"
      ? {
          ...familyCase,
          stages: {
            ...familyCase.stages,
            edges: familyCase.stages.edges === undefined ? undefined : {
              ...familyCase.stages.edges,
              items: familyCase.stages.edges.items.map((item, index) =>
                index === 0
                  ? {
                      ...item,
                      value: {
                        ...(item.value as Record<string, unknown>),
                        tokenOut: `0x${"99".repeat(20)}`,
                      },
                    }
                  : item,
              ),
            },
          },
        }
      : familyCase,
  ),
};
const heldOutInput = sealArchitectureMigrationBatchInput({
  ...heldRaw,
  heldOutNegatives: [{
    familyId: "univ2-standard",
    reason: "fixture-held-out-token-mutation",
    baseline: heldRaw.baseline,
    challenger: heldChallenger,
  }],
});
const heldOutReceipt = runArchitectureMigrationBatchParity(heldOutInput);
assert.equal(heldOutReceipt.parityReceipt.aggregateVerdict, "pass");
assert.equal(heldOutReceipt.heldOutNegativeVerdicts.length, 1);
assert.equal(
  heldOutReceipt.heldOutNegativeVerdicts[0]!.outcome,
  "semantic-mismatch",
);
assert.throws(() => runArchitectureMigrationBatchParity(
  sealArchitectureMigrationBatchInput({
    ...heldRaw,
    heldOutNegatives: [{
      familyId: "univ2-standard",
      reason: "identical-pair-must-fail",
      baseline: heldRaw.baseline,
      challenger: heldRaw.challenger,
    }],
  }),
), /held-out negative univ2-standard must produce semantic-mismatch/);

assert.throws(
  () => sealArchitectureMigrationBatchInput({
    ...fixtureInput({}),
    evidenceClass: "sealed-production",
  }),
  /requires the trusted production capture issuer/,
  "a caller cannot promote unit fixtures by self-declaring sealed production",
);

const productionIssuer = createArchitectureMigrationProductionCaptureIssuer();
const rawSealedFixture = fixtureInput({});
const sealedSide = (side: Side) =>
  issueArchitectureMigrationSideCapture(
    productionIssuer,
    rawSealedFixture[side],
  );
const sealedProduction = sealArchitectureMigrationBatchInput({
  ...rawSealedFixture,
  evidenceClass: "sealed-production",
  productionCaptureIssuer: productionIssuer,
  baseline: sealedSide("baseline"),
  challenger: sealedSide("challenger"),
});
const sealedProductionReceipt = runArchitectureMigrationBatchParity(
  sealedProduction,
);
assert.equal(sealedProductionReceipt.evidenceClass, "sealed-production");
assert.equal(sealedProductionReceipt.acceptance.eligible, true);
assert.equal(sealedProductionReceipt.parityReceipt.aggregateVerdict, "pass");
assert.equal(sealedProductionReceipt.baselineCaptureId,
  rawSealedFixture.baseline.closure.captureId);

const forgedSealed = Object.freeze({}) as SealedArchitectureMigrationSideCapture;
assert.throws(
  () => sealArchitectureMigrationBatchInput({
    ...rawSealedFixture,
    evidenceClass: "sealed-production",
    productionCaptureIssuer: productionIssuer,
    baseline: forgedSealed,
    challenger: sealedSide("challenger"),
  }),
  /requires the trusted production capture issuer/,
);

const foreignIssuer = createArchitectureMigrationProductionCaptureIssuer();
assert.throws(
  () => sealArchitectureMigrationBatchInput({
    ...rawSealedFixture,
    evidenceClass: "sealed-production",
    productionCaptureIssuer: foreignIssuer,
    baseline: sealedSide("baseline"),
    challenger: sealedSide("challenger"),
  }),
  /requires the trusted production capture issuer/,
);

assert.throws(
  () => sealArchitectureMigrationBatchInput({
    ...rawSealedFixture,
    baseline: sealedSide("baseline"),
    challenger: sealedSide("challenger"),
  } as unknown as ArchitectureMigrationBatchInput),
  /unit-contract evidence cannot use sealed production captures/,
);

const evidenceStripped = {
  ...rawSealedFixture.baseline,
  familyCases: rawSealedFixture.baseline.familyCases.map((familyCase) => ({
    ...familyCase,
    stages: Object.fromEntries(
      Object.entries(familyCase.stages).map(([stage, stageCapture]) => [
        stage,
        stageCapture === undefined
          ? undefined
          : {
              ...stageCapture,
              evidenceRefs: stageCapture.status === "exercised"
                ? []
                : stageCapture.evidenceRefs,
            },
      ]),
    ),
  })),
} as RawArchitectureMigrationSideCapture;
assert.throws(
  () => issueArchitectureMigrationSideCapture(
    productionIssuer,
    evidenceStripped,
  ),
  /lacks evidenceRefs/,
);

const changed = sealArchitectureMigrationBatchInput(fixtureInput({
  changedFamilyStage: {
    familyId: blockedFamily,
    stage: "edges",
    side: "challenger",
  },
}));
const changedReceipt = runArchitectureMigrationBatchParity(changed);
const changedResult = changedReceipt.parityReceipt.familyResults.find(
  (row) => row.familyId === blockedFamily,
)!;
assert.equal(changedResult.outcome, "semantic-mismatch");
assert.deepEqual(changedResult.changedEdgeMetadata, [`${blockedFamily}:edges`]);

const graphChanged = sealArchitectureMigrationBatchInput(fixtureInput({
  changedGraphStage: {
    stage: "edges",
    side: "challenger",
  },
}));
const graphChangedReceipt = runArchitectureMigrationBatchParity(graphChanged);
assert(graphChangedReceipt.familyCoverage.every((row) => row.outcome === "pass"));
assert.equal(graphChangedReceipt.parityReceipt.assembledCommonGraphParity, false);
assert.equal(graphChangedReceipt.parityReceipt.aggregateVerdict, "fail");
assert.deepEqual(graphChangedReceipt.commonGraphDelta.edges.changedIds, [
  "common:edges",
]);

const sharedReferenceInput = fixtureInput({
  families: [],
  includeCommonGraph: false,
});
const sharedCases: RawFamilyMigrationCaseCapture[] = [];
assert.throws(() => sealArchitectureMigrationBatchInput({
  ...sharedReferenceInput,
  baseline: { ...sharedReferenceInput.baseline, familyCases: sharedCases },
  challenger: { ...sharedReferenceInput.challenger, familyCases: sharedCases },
}), /share an object reference/);

const closureMismatch = fixtureInput({
  families: [],
  includeCommonGraph: false,
});
assert.throws(() => sealArchitectureMigrationBatchInput({
  ...closureMismatch,
  challenger: {
    ...closureMismatch.challenger,
    closure: {
      ...closureMismatch.challenger.closure,
      activationManifestHash: SHA("different-activation"),
    },
  },
}), /activationManifestHash mismatch/);
assert.throws(() => sealArchitectureMigrationBatchInput({
  ...closureMismatch,
  challenger: {
    ...closureMismatch.challenger,
    closure: {
      ...closureMismatch.challenger.closure,
      productionClosureHash:
        closureMismatch.baseline.closure.productionClosureHash,
    },
  },
}), /production closure must be distinct/);

const oneFamily = PRODUCTION_ARCHITECTURE_MIGRATION_COHORT.slice(0, 1);
const fingerprintMismatch = fixtureInput({ families: oneFamily });
assert.throws(() => sealArchitectureMigrationBatchInput({
  ...fingerprintMismatch,
  challenger: {
    ...fingerprintMismatch.challenger,
    familyCases: fingerprintMismatch.challenger.familyCases.map((item) => ({
      ...item,
      inputFingerprint: SHA("different-case-input"),
    })),
  },
}), /case inputFingerprint mismatch/);

const anchorMismatch = fixtureInput({
  families: oneFamily,
  stateAnchorNumber: { baseline: 1, challenger: 2 },
});
assert.throws(
  () => sealArchitectureMigrationBatchInput(anchorMismatch),
  /StateAnchor mismatch/,
);

assert.throws(
  () => runArchitectureMigrationBatchParity(
    fixtureInput({}) as unknown as SealedArchitectureMigrationBatchInput,
  ),
  /locally sealed/,
);
assert(Object.isFrozen(complete));
assert(Object.isFrozen(complete.baseline.familyCases));
assert(Object.isFrozen(complete.baseline.familyCases[0].stages));
assert(Object.isFrozen(completeReceipt));
assert(Object.isFrozen(completeReceipt.familyCoverage[0]));
assert(Object.isFrozen(completeReceipt.commonGraphDelta.edges.changedIds));

await testFileEntryRunsUnitAndSealedBatches();
testRequestFileValidation();
testSideCaptureAssemblerRoundTripsFixtureShape();

console.log(
  "architecture-migration-parity-runner PASS " +
    "(22 real Families + sealed independent captures + shared gates)",
);

async function testFileEntryRunsUnitAndSealedBatches(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-parity-files-"),
  );
  const raw = fixtureInput({});
  const baselinePath = join(directory, "baseline.json");
  const challengerPath = join(directory, "challenger.json");
  await writeFile(baselinePath, JSON.stringify(raw.baseline));
  await writeFile(challengerPath, JSON.stringify(raw.challenger));

  const unitReceipt = await runArchitectureMigrationParityFiles({
    baselinePath,
    challengerPath,
    evidenceClass: "unit-contract",
    mode: "pure-refactor",
    stateAnchors: raw.stateAnchors,
    performanceDiagnostics: raw.performanceDiagnostics,
  });
  assert.equal(unitReceipt.parityReceipt.aggregateVerdict, "pass");
  assert.equal(unitReceipt.acceptance.eligible, false);

  const sealedReceipt = await runArchitectureMigrationParityFiles({
    baselinePath,
    challengerPath,
    evidenceClass: "sealed-production",
    mode: "pure-refactor",
    stateAnchors: raw.stateAnchors,
    performanceDiagnostics: raw.performanceDiagnostics,
    productionCaptureIssuer: productionIssuer,
  });
  assert.equal(sealedReceipt.evidenceClass, "sealed-production");
  assert.equal(sealedReceipt.acceptance.eligible, true);
  assert.equal(sealedReceipt.parityReceipt.aggregateVerdict, "pass");

  await assert.rejects(
    runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "sealed-production",
      mode: "pure-refactor",
      stateAnchors: raw.stateAnchors,
      performanceDiagnostics: raw.performanceDiagnostics,
    }),
    /requires the trusted production capture issuer/,
  );

  const malformedPath = join(directory, "malformed.json");
  await writeFile(malformedPath, JSON.stringify({ not: "a capture" }));
  await assert.rejects(
    runArchitectureMigrationParityFiles({
      baselinePath: malformedPath,
      challengerPath,
      evidenceClass: "unit-contract",
      mode: "pure-refactor",
      stateAnchors: raw.stateAnchors,
      performanceDiagnostics: raw.performanceDiagnostics,
    }),
    /not a raw architecture migration side capture/,
  );
  const badJsonPath = join(directory, "bad.json");
  await writeFile(badJsonPath, "not json");
  await assert.rejects(
    runArchitectureMigrationParityFiles({
      baselinePath: badJsonPath,
      challengerPath,
      evidenceClass: "unit-contract",
      mode: "pure-refactor",
      stateAnchors: raw.stateAnchors,
      performanceDiagnostics: raw.performanceDiagnostics,
    }),
    /JSON|Unexpected/,
  );
}

function testRequestFileValidation(): void {
  const valid = fixtureInput({});
  const request = {
    baselinePath: "/tmp/baseline.json",
    challengerPath: "/tmp/challenger.json",
    evidenceClass: "unit-contract",
    mode: "pure-refactor",
    stateAnchors: valid.stateAnchors,
    performanceDiagnostics: valid.performanceDiagnostics,
  };
  assert.doesNotThrow(() => validateArchitectureMigrationRequestFile(request));
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      baselinePath: "",
    }),
    /baselinePath must be a non-empty path/,
  );
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      evidenceClass: "self-declared",
    }),
    /evidenceClass must be unit-contract or sealed-production/,
  );
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      stateAnchors: [],
    }),
    /stateAnchors must be a non-empty array/,
  );
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      performanceDiagnostics: { ...valid.performanceDiagnostics, wallMs: -1 },
    }),
    /performanceDiagnostics.wallMs must be non-negative/,
  );
  assert.throws(
    () => validateArchitectureMigrationRequestFile(null),
    /batch request must be an object/,
  );
  assert.doesNotThrow(() => validateArchitectureMigrationRequestFile({
    ...request,
    evidenceClass: "sealed-production",
  }));
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      baselinePath: "/tmp/same.json",
      challengerPath: "/tmp/same.json",
    }),
    /paths must be distinct/,
  );
  assert.throws(
    () => validateArchitectureMigrationRequestFile({
      ...request,
      stateAnchors: [{}],
    }),
    /invalid stateAnchor/,
  );
}

function testSideCaptureAssemblerRoundTripsFixtureShape(): void {
  const side = rawSealedFixture.baseline;
  const rebuilt = buildArchitectureMigrationSideCapture({
    captureId: side.closure.captureId,
    commit: side.closure.commit,
    productionClosureHash: side.closure.productionClosureHash,
    activationManifestHash: side.closure.activationManifestHash,
    normalizedConfigHash: side.closure.normalizedConfigHash,
    productionPolicyHash: side.closure.productionPolicyHash,
    corpusHash: side.closure.corpusHash,
    evidenceRefs: side.closure.evidenceRefs,
    familyCases: side.familyCases,
    commonGraph: side.commonGraph,
    nonMigratedFamilies: side.nonMigratedFamilies,
  });
  assert.deepEqual(rebuilt, side);
  const normalized = buildArchitectureMigrationSideCapture({
    captureId: side.closure.captureId,
    commit: side.closure.commit,
    productionClosureHash: side.closure.productionClosureHash,
    activationManifestHash: side.closure.activationManifestHash,
    normalizedConfigHash: side.closure.normalizedConfigHash,
    productionPolicyHash: side.closure.productionPolicyHash,
    corpusHash: side.closure.corpusHash,
    evidenceRefs: ["z", "a", "z", "b"],
    familyCases: side.familyCases,
    commonGraph: side.commonGraph,
    nonMigratedFamilies: side.nonMigratedFamilies,
  });
  assert.deepEqual(normalized.closure.evidenceRefs, ["a", "b", "z"]);
  assert(Object.isFrozen(normalized.closure.evidenceRefs));
  assert.throws(() => buildArchitectureMigrationSideCapture({
    captureId: "",
    commit: rebuilt.closure.commit,
    productionClosureHash: rebuilt.closure.productionClosureHash,
    activationManifestHash: rebuilt.closure.activationManifestHash,
    normalizedConfigHash: rebuilt.closure.normalizedConfigHash,
    productionPolicyHash: rebuilt.closure.productionPolicyHash,
    corpusHash: rebuilt.closure.corpusHash,
    evidenceRefs: rebuilt.closure.evidenceRefs,
    familyCases: rebuilt.familyCases,
    commonGraph: rebuilt.commonGraph,
    nonMigratedFamilies: rebuilt.nonMigratedFamilies,
  }), /captureId/);
}

function fixtureInput(options: FixtureOptions): ArchitectureMigrationBatchInput {
  return {
    evidenceClass: "unit-contract",
    mode: "pure-refactor",
    stateAnchors: [
      { number: 1, hash: HASH, stateRoot: HASH },
      { number: 2, hash: `0x${"22".repeat(32)}`, stateRoot: `0x${"33".repeat(32)}` },
    ],
    baseline: sideCapture("baseline", options),
    challenger: sideCapture("challenger", options),
    performanceDiagnostics: {
      wallMs: 100,
      requestCount: 44,
      batchCount: 2,
      peakConcurrency: 4,
    },
  };
}

function sideCapture(
  side: Side,
  options: FixtureOptions,
): RawArchitectureMigrationSideCapture {
  const families = options.families ?? PRODUCTION_ARCHITECTURE_MIGRATION_COHORT;
  return {
    closure: {
      captureId: `${side}:fixture-capture`,
      commit: SHA(`${side}:commit`),
      productionClosureHash: SHA(`${side}:production-closure`),
      activationManifestHash: SHA("shared:activation-manifest"),
      normalizedConfigHash: SHA("shared:normalized-config"),
      productionPolicyHash: SHA("shared:production-policy"),
      corpusHash: SHA("shared:corpus"),
      evidenceRefs: [`fixture:${side}:closure`],
    },
    familyCases: families.map((contract) => familyCase(side, contract, options)),
    commonGraph: options.includeCommonGraph === false
      ? null
      : commonGraphCapture(side, options),
    nonMigratedFamilies: {
      inputFingerprint: SHA("shared:non-migrated-input"),
      stage: {
        status: "exercised",
        items: [],
        evidenceRefs: [`fixture:${side}:non-migrated`],
        blocker: null,
      },
    },
  };
}

function familyCase(
  side: Side,
  contract: ProductionArchitectureMigrationFamilyContract,
  options: FixtureOptions,
): RawFamilyMigrationCaseCapture {
  const required = new Set(contract.requiredStages);
  return {
    familyId: contract.familyId,
    caseId: "canonical",
    inputFingerprint: SHA(`${contract.familyId}:canonical-input`),
    stateAnchorNumber: options.stateAnchorNumber?.[side] ?? 1,
    implementationClosureHash: SHA(`${side}:${contract.familyId}:closure`),
    stages: Object.fromEntries(ARCHITECTURE_MIGRATION_STAGES.map((stage) => [
      stage,
      familyStageCapture(side, contract.familyId, stage, required.has(stage), options),
    ])),
  };
}

function familyStageCapture(
  side: Side,
  familyId: string,
  stage: ArchitectureMigrationStage,
  required: boolean,
  options: FixtureOptions,
): RawMigrationStageCapture {
  if (
    options.blocked?.side === side &&
    options.blocked.familyId === familyId &&
    options.blocked.stage === stage
  ) {
    return {
      status: "framework-blocked",
      items: [],
      evidenceRefs: [`fixture:${side}:${familyId}:${stage}:blocked`],
      blocker: "transport-unavailable",
    };
  }
  if (!required) {
    return {
      status: "declared-absent",
      items: [],
      evidenceRefs: [],
      blocker: null,
    };
  }
  const changed = options.changedFamilyStage?.side === side &&
    options.changedFamilyStage.familyId === familyId &&
    options.changedFamilyStage.stage === stage;
  return {
    status: "exercised",
    items: stage === "failures"
      ? []
      : [{
        id: `${familyId}:${stage}`,
        value: { semantic: changed ? "changed" : "stable" },
      }],
    evidenceRefs: [`fixture:${side}:${familyId}:${stage}`],
    blocker: null,
  };
}

function commonGraphCapture(
  side: Side,
  options: FixtureOptions,
) {
  return {
    inputFingerprint: SHA("shared:common-graph-input"),
    stages: Object.fromEntries(COMMON_GRAPH_MIGRATION_STAGES.map((stage) => {
      const changed = options.changedGraphStage?.side === side &&
        options.changedGraphStage.stage === stage;
      return [stage, {
        status: "exercised" as const,
        items: [{
          id: `common:${stage}`,
          value: { semantic: changed ? "changed" : "stable" },
        }],
        evidenceRefs: [`fixture:${side}:common:${stage}`],
        blocker: null,
      }];
    })),
    crossFamilyBindings: [{
      kind: "action" as const,
      key: "fixture-action",
      familyId: "univ2-standard",
      value: { selector: "0x12345678" },
    }],
  };
}
