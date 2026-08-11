import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertParityEvidenceBundle,
  writeParityEvidenceBundle,
} from "../architecture-migration-evidence.js";
import {
  architectureMigrationSideJson,
  buildFixtureCaptureCorpus,
  generateArchitectureMigrationSideCapture,
} from "../architecture-migration-capture.js";
import {
  captureUniv2FixtureCase,
} from "../architecture-migration-fixture-replay.js";
import {
  createArchitectureMigrationProductionCaptureIssuer,
  runArchitectureMigrationParityFiles,
} from "../architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_600,
  hash: `0x${"52".repeat(32)}`,
  generation: 60,
});

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "parity-evidence-"));
  try {
    const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
    const corpusFor = (captureId: string, commit: string, closureHash: string) => ({
      ...buildFixtureCaptureCorpus({
        captureId,
        commit,
        source: SOURCE,
        familyCases: [familyCase],
      }),
      productionClosureHash: closureHash,
    });
    const baselinePath = join(directory, "baseline.json");
    const challengerPath = join(directory, "challenger.json");
    await writeFile(
      baselinePath,
      architectureMigrationSideJson(generateArchitectureMigrationSideCapture(
        corpusFor("baseline", "a".repeat(40), "11".repeat(32)),
      )),
    );
    await writeFile(
      challengerPath,
      architectureMigrationSideJson(generateArchitectureMigrationSideCapture(
        corpusFor("challenger", "b".repeat(40), "aa".repeat(32)),
      )),
    );
    const issuer = createArchitectureMigrationProductionCaptureIssuer();
    const receipt = await runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "sealed-production",
      mode: "pure-refactor",
      stateAnchors: corpusFor("x", "a".repeat(40), "11".repeat(32)).stateAnchors,
      performanceDiagnostics: {
        wallMs: 100,
        requestCount: 10,
        batchCount: 1,
        peakConcurrency: 1,
      },
      productionCaptureIssuer: issuer,
    });
    const receiptPath = join(directory, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const bundleDir = join(directory, "bundle");
    const manifest = await writeParityEvidenceBundle({
      baselinePath,
      challengerPath,
      receiptPath,
      outDir: bundleDir,
    });
    assert.equal(manifest.acceptance.eligible, true);
    assert.equal(typeof manifest.acceptance.verdict, "string");
    assert.equal(manifest.baseline.commit, "a".repeat(40));
    assert.equal(manifest.challenger.commit, "b".repeat(40));
    const verified = await assertParityEvidenceBundle(bundleDir);
    assert.equal(verified.baseline.sha256, manifest.baseline.sha256);

    await writeFile(
      join(bundleDir, "challenger.json"),
      `${await readFile(join(bundleDir, "challenger.json"), "utf8")} `,
    );
    await assert.rejects(
      () => assertParityEvidenceBundle(bundleDir),
      /tampered/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log("architecture-migration parity evidence PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
