import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  judgeArchitectureMigration,
  type CanonicalFamilySemanticOutput,
  type CanonicalSemanticItem,
} from "../architecture-migration-parity.js";

const HASH = `0x${"11".repeat(32)}`;
const SHA = (value: string) => createHash("sha256").update(value).digest("hex");
const item = (id: string, value = id): CanonicalSemanticItem => ({
  id,
  semanticHash: SHA(value),
});

function output(input: {
  familyId: string;
  edges?: readonly CanonicalSemanticItem[];
  priced?: readonly CanonicalSemanticItem[];
  exact?: readonly CanonicalSemanticItem[];
  cases?: readonly string[];
  blocker?: string | null;
}): CanonicalFamilySemanticOutput {
  return {
    familyId: input.familyId,
    implementationClosureHash: SHA(`${input.familyId}:closure`),
    exercisedCaseIds: input.cases ?? ["cold", "incremental"],
    frameworkBlocker: input.blocker ?? null,
    instances: [item(`${input.familyId}:instance`)],
    edges: input.edges ?? [item(`${input.familyId}:edge-a`)],
    stateCoverage: [item(`${input.familyId}:state-a`)],
    pricedEdges: input.priced ?? [item(`${input.familyId}:edge-a`)],
    prices: [item(`${input.familyId}:edge-a`, "price:1")],
    failures: [],
    enumeratedRoutes: [item(`${input.familyId}:route-a`)],
    exactQuotes: input.exact ?? [item(`${input.familyId}:quote-a`)],
    executionFragments: [item(`${input.familyId}:fragment-a`)],
    finalSimulations: [item(`${input.familyId}:sim-a`)],
    evidenceRefs: [`fixture:${input.familyId}`],
  };
}

const baseInput = {
  scope: {
    kind: "batch" as const,
    familyIds: ["family:a", "family:b"],
  },
  mode: "pure-refactor" as const,
  inputManifestHash: SHA("input"),
  stateAnchors: [{ number: 1, hash: HASH, stateRoot: HASH }],
  nonMigratedFamilySemanticHashParity: true,
  assembledCommonGraphParity: true,
  performanceDiagnostics: {
    wallMs: 100,
    requestCount: 10,
    batchCount: 2,
    peakConcurrency: 2,
  },
};

const baseline = [output({ familyId: "family:a" }), output({
  familyId: "family:b",
})];
const pass = judgeArchitectureMigration({
  ...baseInput,
  baseline,
  challenger: baseline,
});
assert.equal(pass.aggregateVerdict, "pass");
assert.deepEqual(pass.nonPassFamilyIds, []);
assert(pass.familyResults.every((result) => result.outcome === "pass"));
assert.match(pass.familyResultMatrixHash, /^[0-9a-f]{64}$/);

const sameCountDifferentEdge = judgeArchitectureMigration({
  ...baseInput,
  baseline,
  challenger: [
    output({ familyId: "family:a", edges: [item("family:a:edge-wrong")] }),
    output({ familyId: "family:b" }),
  ],
});
assert.equal(sameCountDifferentEdge.aggregateVerdict, "fail");
assert.equal(sameCountDifferentEdge.familyResults[0].outcome, "semantic-mismatch");
assert.deepEqual(sameCountDifferentEdge.familyResults[0].missingEdges, [
  "family:a:edge-a",
]);
assert.deepEqual(sameCountDifferentEdge.familyResults[0].addedEdges, [
  "family:a:edge-wrong",
]);
assert.deepEqual(
  sameCountDifferentEdge.familyResults[0].unprovenAddedArtifacts,
  ["family:a:edge-wrong"],
);

const missingFamily = judgeArchitectureMigration({
  ...baseInput,
  baseline,
  challenger: [output({ familyId: "family:a" })],
});
assert.equal(missingFamily.aggregateVerdict, "partial");
assert.equal(missingFamily.familyResults[1].outcome, "not-exercised");
assert.deepEqual(missingFamily.nonPassFamilyIds, ["family:b"]);

const frameworkBlocked = judgeArchitectureMigration({
  ...baseInput,
  baseline,
  challenger: [output({ familyId: "family:a", blocker: "transport" }), output({
    familyId: "family:b",
  })],
});
assert.equal(frameworkBlocked.aggregateVerdict, "partial");
assert.equal(frameworkBlocked.familyResults[0].outcome, "framework-blocked");

const declaredAddition = judgeArchitectureMigration({
  ...baseInput,
  mode: "declared-improvement",
  baseline,
  challenger: [output({
    familyId: "family:a",
    edges: [item("family:a:edge-a"), item("family:a:edge-new")],
  }), output({ familyId: "family:b" })],
  declaredDeltas: [{
    familyId: "family:a",
    kind: "verified-addition",
    affectedCanonicalIds: ["family:a:edge-new"],
    independentEvidenceRefs: ["fork:edge-new"],
  }],
});
assert.equal(declaredAddition.aggregateVerdict, "pass");
assert.deepEqual(
  declaredAddition.familyResults[0].unprovenAddedArtifacts,
  [],
);

const declaredCannotOffsetLoss = judgeArchitectureMigration({
  ...baseInput,
  mode: "declared-improvement",
  baseline,
  challenger: [output({
    familyId: "family:a",
    edges: [item("family:a:edge-new")],
  }), output({ familyId: "family:b" })],
  declaredDeltas: [{
    familyId: "family:a",
    kind: "verified-addition",
    affectedCanonicalIds: ["family:a:edge-new", "family:a:edge-a"],
    independentEvidenceRefs: ["fork:edge-new"],
  }],
});
assert.equal(declaredCannotOffsetLoss.aggregateVerdict, "fail");
assert.deepEqual(declaredCannotOffsetLoss.familyResults[0].missingEdges, [
  "family:a:edge-a",
]);

const commonGraphFailed = judgeArchitectureMigration({
  ...baseInput,
  baseline,
  challenger: baseline,
  assembledCommonGraphParity: false,
});
assert.equal(commonGraphFailed.aggregateVerdict, "fail");
assert(commonGraphFailed.familyResults.every((result) => result.outcome === "pass"));

console.log(
  "architecture-migration-parity PASS " +
    "(per-Family semantic sets + non-pass matrix + shared gates)",
);
