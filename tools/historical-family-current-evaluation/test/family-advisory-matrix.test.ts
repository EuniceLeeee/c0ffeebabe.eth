import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCanonicalBytes, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { encodeSwapCall } from "../../../families/univ4/src/abi.ts";
import {
  buildHistoricalFamilyAdvisoryMatrixV1,
  decodeHistoricalPoolManagerSwapV1,
  HISTORICAL_FAMILY_SPECIMENS_V1,
  loadHistoricalFamilyAdvisoryMatrixV1,
  materializeHistoricalFamilyAdvisoryMatrixV1,
  type HistoricalFamilyAdvisoryMatrixV1,
} from "../src/family-advisory-matrix.ts";
import {
  loadHistoricalFamilyFactBundleV1,
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalRpcObjectInputV1,
  type HistoricalRpcRole,
} from "../../reference-only/historical-family-facts/src/index.ts";

const store = "/Users/eunice/.cache/aloha/historical-family-facts";
const hasSpecimens = HISTORICAL_FAMILY_SPECIMENS_V1.every((item) =>
  existsSync(`${store}/manifests/${item.manifestRoot.slice(2)}.json`)
);

function mirrorSpecimens(directory: string): void {
  for (const specimen of HISTORICAL_FAMILY_SPECIMENS_V1) {
    const source = loadHistoricalFamilyFactBundleV1(store, specimen.manifestRoot);
    const manifest = materializeHistoricalFamilyFactBundleV1(
      directory,
      source.manifest.entries.map((entry): HistoricalRpcObjectInputV1 => ({
        role: entry.role,
        key: entry.key,
        resultBytes: encodeCanonicalBytes(source.results[entry.role]),
      })),
    );
    assert.equal(manifest.manifestRoot, specimen.manifestRoot);
  }
}

function replaceWord(calldata: string, index: number, value: bigint): string {
  const start = 10 + index * 64;
  return `${calldata.slice(0, start)}${value.toString(16).padStart(64, "0")}${calldata.slice(start + 64)}`;
}

test("PoolManager observer exact-binds hookData length and padding", () => {
  const empty = encodeSwapCall({
    currency0: "0x0000000000000000000000000000000000000001",
    currency1: "0x0000000000000000000000000000000000000002",
    fee: "3000",
    tickSpacing: "60",
    hooks: "0x0000000000000000000000000000000000000000",
  }, true, "10");
  assert.equal(decodeHistoricalPoolManagerSwapV1(empty).hookDataLength, 0n);
  const oneByte = `${replaceWord(empty, 9, 1n)}12${"0".repeat(62)}`;
  assert.equal(decodeHistoricalPoolManagerSwapV1(oneByte).hookDataLength, 1n);
  assert.throws(() => decodeHistoricalPoolManagerSwapV1(replaceWord(oneByte, 9, 33n)), /hookData encoding mismatch/);
  assert.throws(() => decodeHistoricalPoolManagerSwapV1(`${oneByte.slice(0, -1)}1`), /padding is non-zero/);
});

test("five cached specimens remain advisory and expose current v4 entry-template contradictions", { skip: !hasSpecimens }, () => {
  const matrix = buildHistoricalFamilyAdvisoryMatrixV1(store);
  assert.equal(matrix.rows.length, 5);
  assert.deepEqual(matrix.rows.map((row) => [row.family, row.currentActionBinding.status]), [
    ["curve-underlying", "unresolved"],
    ["dodo-v2", "unresolved"],
    ["fluid-dex", "unresolved"],
    ["univ4", "contradicted"],
    ["angstrom-v4", "contradicted"],
  ]);
  assert.deepEqual(matrix.rows.map((row) => [row.family, row.currentClosure.releaseDecision]), [
    ["curve-underlying", "include"],
    ["dodo-v2", "include"],
    ["fluid-dex", "include"],
    ["univ4", "exclude"],
    ["angstrom-v4", "exclude"],
  ]);
  for (const row of matrix.rows) {
    assert.equal(row.selectorShape.status, "observed");
    assert.equal(row.reverseIdentity.status, "unresolved");
    assert.equal(row.variantObservation.status, "observed");
    assert.equal(row.effectsForkReplay.status, "unresolved");
    assert.equal(row.qualificationStatus, "unresolved");
    assert.match(row.currentClosure.familyDefinitionHash, /^0x[0-9a-f]{64}$/);
    assert.match(row.currentClosure.implementationSourceDigest, /^0x[0-9a-f]{64}$/);
    if (row.currentClosure.releaseDecision === "include") {
      assert.match(row.currentClosure.definitionCatalogLeafDigest!, /^0x[0-9a-f]{64}$/);
    } else {
      assert.equal(row.currentClosure.definitionCatalogLeafDigest, null);
      assert.deepEqual(row.currentClosure.actionOwnerRefs, []);
    }
  }
  const univ4 = matrix.rows.find((row) => row.family === "univ4")!;
  const angstrom = matrix.rows.find((row) => row.family === "angstrom-v4")!;
  assert.ok(univ4.currentActionBinding.reasonCodes.includes("missing-unlock-callback"));
  assert.ok(angstrom.currentActionBinding.reasonCodes.includes("missing-unlock-callback"));
  assert.deepEqual(angstrom.currentActionBinding.facts, {
    currentEntrySequence: ["direct-swap"],
    currentHookDataLength: "0",
    currentInnerByteLength: "324",
    exactHistoricalBytesRepresentable: false,
    historicalEntrySequence: ["unlock", "callback", "swap"],
    historicalHookDataLength: "85",
    historicalInnerByteLength: "420",
    historicalOuterByteLength: "2852",
  });
});

test("exact descriptor mutations cannot silently reclassify a cached v4 specimen", { skip: !hasSpecimens }, () => {
  const univ4 = HISTORICAL_FAMILY_SPECIMENS_V1.find((item) => item.family === "univ4")!;
  assert.throws(
    () => buildHistoricalFamilyAdvisoryMatrixV1(store, [{ ...univ4, unlockFrameSelector: "0x00000000" }]),
    /selector\/target mismatch/,
  );
  const angstrom = HISTORICAL_FAMILY_SPECIMENS_V1.find((item) => item.family === "angstrom-v4")!;
  assert.throws(
    () => buildHistoricalFamilyAdvisoryMatrixV1(store, [{ ...angstrom, hook: "0x0000000000000000000000000000000000000000" }]),
    /adapter\/hook\/pool event binding mismatch/,
  );
  const dodo = HISTORICAL_FAMILY_SPECIMENS_V1.find((item) => item.family === "dodo-v2")!;
  assert.throws(
    () => buildHistoricalFamilyAdvisoryMatrixV1(store, [{ ...dodo, eventTopic0: `0x${"0".repeat(64)}` }]),
    /exact specimen log is not unique/,
  );
});

test("materialized matrix is rebuilt from raw specimens and rejects nested fact tampering", { skip: !hasSpecimens }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-family-matrix-store-"));
  try {
    mirrorSpecimens(directory);
    const matrix = buildHistoricalFamilyAdvisoryMatrixV1(directory);
    const path = materializeHistoricalFamilyAdvisoryMatrixV1(directory, matrix);
    assert.deepEqual(loadHistoricalFamilyAdvisoryMatrixV1(directory, matrix.matrixRoot), matrix);
    const tampered = structuredClone(matrix) as unknown as {
      rows: Array<{ txHash: Hash }>;
      matrixRoot: Hash;
    };
    tampered.rows[0]!.txHash = `0x${"f".repeat(64)}` as Hash;
    tampered.matrixRoot = matrix.matrixRoot;
    assert.throws(
      () => materializeHistoricalFamilyAdvisoryMatrixV1(
        directory,
        tampered as unknown as HistoricalFamilyAdvisoryMatrixV1,
      ),
      /does not exactly match a rebuild/,
    );
    writeFileSync(path, encodeCanonicalBytes(tampered as unknown as CanonicalJson));
    assert.throws(
      () => loadHistoricalFamilyAdvisoryMatrixV1(directory, matrix.matrixRoot),
      /do not exactly match a rebuild/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed DODO event words cannot survive an immutable derived specimen", { skip: !hasSpecimens }, () => {
  const dodo = HISTORICAL_FAMILY_SPECIMENS_V1.find((item) => item.family === "dodo-v2")!;
  const original = loadHistoricalFamilyFactBundleV1(store, dodo.manifestRoot);
  const receipt = structuredClone(original.results.receipt) as Record<string, CanonicalJson>;
  const logs = receipt.logs as Array<Record<string, CanonicalJson>>;
  const event = logs.find((item) => item.logIndex === dodo.eventLogIndex)!;
  const data = event.data as string;
  event.data = `0x${"f".repeat(24)}${data.slice(26)}`;
  const byRole = original.manifest.entries.map((entry): HistoricalRpcObjectInputV1 => ({
    role: entry.role,
    key: entry.key,
    resultBytes: encodeCanonicalBytes(entry.role === "receipt" ? receipt : original.results[entry.role]),
  }));
  const directory = mkdtempSync(join(tmpdir(), "aloha-family-matrix-mutation-"));
  try {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, byRole);
    assert.throws(
      () => buildHistoricalFamilyAdvisoryMatrixV1(directory, [{ ...dodo, manifestRoot: manifest.manifestRoot }]),
      /invalid address word/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
