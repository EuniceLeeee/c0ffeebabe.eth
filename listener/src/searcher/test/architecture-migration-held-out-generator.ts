import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateHeldOutNegatives,
} from "../generate-architecture-migration-held-out-negatives.js";
import type {
  RawArchitectureMigrationSideCapture,
  RawMigrationStageCapture,
} from "../architecture-migration-parity-runner.js";
import type { CanonicalValue } from "../venues/canonical-value.js";

const directory = await mkdtemp(join(tmpdir(), "s1-held-out-generator-"));
const baselinePath = join(directory, "baseline.json");
const challengerPath = join(directory, "challenger.json");
const side = fixtureSide();
await writeFile(baselinePath, JSON.stringify(side));
await writeFile(challengerPath, JSON.stringify(structuredClone(side)));
const generated = await generateHeldOutNegatives({
  baselinePath,
  challengerPath,
  outputDirectory: join(directory, "negative"),
});
assert.deepEqual(generated.map((item) => item.familyId), [
  "synthetic:alpha",
  "synthetic:beta",
]);
assert(generated.every((item) => item.baselinePath === baselinePath));
for (const item of generated) {
  const mutation = JSON.parse(await readFile(item.challengerPath, "utf8")) as
    RawArchitectureMigrationSideCapture;
  const changed = mutation.familyCases.filter((familyCase) =>
    familyCase.familyId === item.familyId
  );
  assert.equal(changed.length, 1);
  assert.notDeepEqual(changed, side.familyCases.filter((familyCase) =>
    familyCase.familyId === item.familyId
  ));
  assert.deepEqual(
    mutation.familyCases.filter((familyCase) =>
      familyCase.familyId !== item.familyId
    ),
    side.familyCases.filter((familyCase) =>
      familyCase.familyId !== item.familyId
    ),
  );
}
console.log("architecture migration held-out generator PASS");

function fixtureSide(): RawArchitectureMigrationSideCapture {
  const stage = (id: string, value: CanonicalValue): RawMigrationStageCapture => ({
    status: "exercised" as const,
    items: [{ id, value }],
    evidenceRefs: ["onchain:1:synthetic"],
    blocker: null,
  });
  const cases = [
    {
      familyId: "synthetic:beta",
      caseId: "beta",
      inputFingerprint: "b".repeat(64),
      stateAnchorNumber: 1,
      implementationClosureHash: "c".repeat(64),
      stages: {
        instances: stage("beta-item", { amount: "7" }),
      },
    },
    {
      familyId: "synthetic:alpha",
      caseId: "alpha",
      inputFingerprint: "a".repeat(64),
      stateAnchorNumber: 1,
      implementationClosureHash: "d".repeat(64),
      stages: {
        finalSimulations: stage("alpha-item", { success: true }),
      },
    },
  ];
  return {
    closure: {
      captureId: "synthetic-side",
      commit: "a".repeat(40),
      productionClosureHash: "1".repeat(64),
      activationManifestHash: "2".repeat(64),
      normalizedConfigHash: "3".repeat(64),
      productionPolicyHash: "4".repeat(64),
      corpusHash: "5".repeat(64),
      evidenceRefs: ["onchain:1:synthetic"],
    },
    familyCases: cases,
    commonGraph: null,
    nonMigratedFamilies: null,
  };
}
