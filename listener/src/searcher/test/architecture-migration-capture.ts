import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  architectureMigrationSideJson,
  buildFixtureCaptureCorpus,
  generateArchitectureMigrationSideCapture,
  validateArchitectureMigrationCaptureCorpus,
  writeArchitectureMigrationSideCapture,
} from "../architecture-migration-capture.js";
import {
  captureUniv2FixtureCase,
  captureUniv2RealCase,
} from "../architecture-migration-fixture-replay.js";
import {
  createArchitectureMigrationProductionCaptureIssuer,
  runArchitectureMigrationParityFiles,
} from "../architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_500,
  hash: `0x${"51".repeat(32)}`,
  generation: 50,
});

function corpusFor(captureId: string, commit: string, productionClosureHash: string) {
  return {
    ...buildFixtureCaptureCorpus({
      captureId,
      commit,
      source: SOURCE,
      familyCases: [],
    }),
    productionClosureHash,
  };
}

async function testCorpusValidation(): Promise<void> {
  const valid = corpusFor("baseline", "a".repeat(40), "11".repeat(32));
  assert.doesNotThrow(() => validateArchitectureMigrationCaptureCorpus(valid));
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({ ...valid, captureId: "" }),
    /captureId must be a non-empty string/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      evidenceRefs: [],
    }),
    /evidenceRefs must be non-empty/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      stateAnchors: [],
    }),
    /stateAnchors must be non-empty/,
  );
  assert.throws(
    () => validateArchitectureMigrationCaptureCorpus({
      ...valid,
      familyCases: null,
    }),
    /familyCases must be an array/,
  );
}

async function testFixtureReplayProducesCanonicalCase(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  assert.equal(familyCase.familyId, "univ2-standard");
  assert.equal(familyCase.stateAnchorNumber, SOURCE.number);
  assert.equal(familyCase.stages.instances?.status, "exercised");
  assert.equal(familyCase.stages.edges?.status, "exercised");
  assert.equal(familyCase.stages.prices?.status, "framework-blocked");
  assert.equal(familyCase.stages.finalSimulations?.status, "framework-blocked");
  assert((familyCase.stages.instances?.items.length ?? 0) >= 1);
  assert((familyCase.stages.edges?.items.length ?? 0) >= 1);
}

async function testRealCaseUsesDescriptorPoolAndBlocksPrices(): Promise<void> {
  const realPool = `0x${"61".repeat(20)}`;
  const realTokenA = `0x${"71".repeat(20)}`;
  const realTokenB = `0x${"72".repeat(20)}`;
  const familyCase = await captureUniv2RealCase({
    source: SOURCE,
    pool: realPool,
    tokenA: realTokenA,
    tokenB: realTokenB,
  });
  assert.equal(familyCase.stages.prices?.status, "framework-blocked");
  assert(familyCase.stages.edges!.items[0]!.id.includes(realPool.toLowerCase()));
  assert.equal(familyCase.stages.instances?.items.length, 1);
  const pricesOn = await captureUniv2RealCase({
    source: SOURCE,
    pool: realPool,
    tokenA: realTokenA,
    tokenB: realTokenB,
    reserves: {
      reserve0: "1000000000000000000",
      reserve1: "2000000000000000000",
    },
  });
  assert.equal(pricesOn.stages.prices?.status, "exercised");
  assert.equal(pricesOn.stages.prices?.items.length, 2);
  assert(pricesOn.stages.prices!.items[0]!.id.includes(
    `${realPool.toLowerCase()}:${realTokenA.toLowerCase()}>` +
      `${realTokenB.toLowerCase()}`,
  ));
}

async function testWriteAndGenerateRoundTrip(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-capture-"),
  );
  try {
    const outPath = join(directory, "side.json");
    const corpus = corpusFor("baseline", "a".repeat(40), "11".repeat(32));
    const captureId = await writeArchitectureMigrationSideCapture(corpus, outPath);
    assert.equal(captureId, "baseline");
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.deepEqual(written, generateArchitectureMigrationSideCapture(corpus));
    assert.equal(written.closure.captureId, "baseline");
    assert(Object.isFrozen(
      generateArchitectureMigrationSideCapture(corpus).closure.evidenceRefs,
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function testEndToEndSealedParity(): Promise<void> {
  const familyCase = await captureUniv2FixtureCase({ source: SOURCE });
  const baselineCorpus = {
    ...corpusFor("baseline", "a".repeat(40), "11".repeat(32)),
    familyCases: [familyCase],
  };
  const challengerCorpus = {
    ...corpusFor("challenger", "b".repeat(40), "aa".repeat(32)),
    familyCases: [familyCase],
  };
  const directory = await mkdtemp(
    join(tmpdir(), "architecture-migration-capture-e2e-"),
  );
  try {
    const baselinePath = join(directory, "baseline.json");
    const challengerPath = join(directory, "challenger.json");
    await writeFile(
      baselinePath,
      architectureMigrationSideJson(
        generateArchitectureMigrationSideCapture(baselineCorpus),
      ),
    );
    await writeFile(
      challengerPath,
      architectureMigrationSideJson(
        generateArchitectureMigrationSideCapture(challengerCorpus),
      ),
    );
    const issuer = createArchitectureMigrationProductionCaptureIssuer();
    const receipt = await runArchitectureMigrationParityFiles({
      baselinePath,
      challengerPath,
      evidenceClass: "sealed-production",
      mode: "pure-refactor",
      stateAnchors: baselineCorpus.stateAnchors,
      performanceDiagnostics: {
        wallMs: 100,
        requestCount: 10,
        batchCount: 1,
        peakConcurrency: 1,
      },
      productionCaptureIssuer: issuer,
    });
    assert.equal(receipt.evidenceClass, "sealed-production");
    assert.equal(receipt.acceptance.eligible, true);
    assert.equal(receipt.parityReceipt.aggregateVerdict, "fail");
    assert.equal(receipt.parityReceipt.nonPassFamilyIds.length, 22);
    assert(receipt.parityReceipt.nonPassFamilyIds.includes("univ2-standard"));
    const univ2Row = receipt.familyCoverage.find(
      (row) => row.familyId === "univ2-standard",
    )!;
    assert.equal(univ2Row.outcome, "framework-blocked");
    assert.equal(
      receipt.familyCoverage.filter((row) => row.outcome === "framework-blocked")
        .length,
      1,
    );
    assert.equal(
      receipt.familyCoverage.filter((row) => row.outcome === "not-exercised")
        .length,
      21,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testCorpusValidation();
  await testFixtureReplayProducesCanonicalCase();
  await testRealCaseUsesDescriptorPoolAndBlocksPrices();
  await testWriteAndGenerateRoundTrip();
  await testEndToEndSealedParity();
  console.log("architecture-migration capture harness PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
