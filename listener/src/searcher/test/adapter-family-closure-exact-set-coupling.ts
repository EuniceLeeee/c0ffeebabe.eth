import assert from "node:assert/strict";
import {
  assertClosureStagedExactSetCoupling,
  type ResolvedAdapterFamilySnapshotInventoryClosure,
} from "../adapter-family-snapshot-inventory-closure.js";
import {
  familyId,
  type FamilyId,
} from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

const FAMILY_A = familyId("swap:coupling-a");
const FAMILY_B = familyId("protocol:coupling-b");
const FAMILY_C = familyId("swap:coupling-c");
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});

function closure(families: readonly {
  readonly familyId: string;
  readonly admitted: readonly string[];
}[]): ResolvedAdapterFamilySnapshotInventoryClosure {
  return Object.freeze({
    chainId: "1",
    catalogHash: "catalog-coupling-fixture",
    sourceRegistryFingerprint: "strict-source-registry-v1",
    source: SOURCE,
    checkpointFingerprint: "11".repeat(32),
    expectedRevision: 1,
    expectedPublicationFingerprint: "22".repeat(32),
    inventoryMatrixFingerprint: "33".repeat(32),
    matrixFingerprint: "44".repeat(32),
    closureFingerprint: "55".repeat(32),
    families: Object.freeze(families.map((family) => Object.freeze({
      familyId: family.familyId,
      declaredSourceIds: Object.freeze(["address-surface"]),
      inventoryCount: family.admitted.length,
      inventoryHash: "66".repeat(32),
      inventoryKeys: Object.freeze([...family.admitted]),
      admittedInstancePublicationKeys: Object.freeze([...family.admitted]),
      terminalEvidenceFingerprint: "77".repeat(32),
    }))),
  } as ResolvedAdapterFamilySnapshotInventoryClosure);
}

function staged(
  entries: readonly [FamilyId, readonly string[]][],
): ReadonlyMap<FamilyId, readonly string[]> {
  return new Map(entries.map(([family, keys]) => [
    family,
    Object.freeze([...keys]),
  ]));
}

function testExactMatchPassesOrderInsensitively(): void {
  const resolved = closure([
    { familyId: FAMILY_A, admitted: ["pool:b", "pool:a"] },
    { familyId: FAMILY_B, admitted: ["vault:c"] },
  ]);
  assert.doesNotThrow(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([
      [FAMILY_A, ["pool:b", "pool:a"]],
      [FAMILY_B, ["vault:c"]],
    ]),
  }));
  assert.doesNotThrow(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([
      [FAMILY_A, ["pool:a", "pool:b"]],
      [FAMILY_B, ["vault:c"]],
    ]),
  }));
}

function testMissingOrExtraKeyFails(): void {
  const resolved = closure([
    { familyId: FAMILY_A, admitted: ["pool:a", "pool:b"] },
  ]);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:a"]]]),
  }), /exact-set mismatch for .*coupling-a/);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:a", "pool:b", "pool:x"]]]),
  }), /exact-set mismatch for .*coupling-a/);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:b", "pool:x"]]]),
  }), /missing=pool:a extra=pool:x/);
}

function testMissingOrUnexpectedFamilyFails(): void {
  const resolved = closure([
    { familyId: FAMILY_A, admitted: ["pool:a"] },
    { familyId: FAMILY_B, admitted: ["vault:c"] },
  ]);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:a"]]]),
  }), /expected 1 keys, staged 0/);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([
      [FAMILY_A, ["pool:a"]],
      [FAMILY_B, ["vault:c"]],
      [FAMILY_C, ["pool:x"]],
    ]),
  }), /unexpected Family .*coupling-c/);
}

function testEmptyClosureAndEmptyStagingPasses(): void {
  const resolved = closure([]);
  assert.doesNotThrow(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: new Map(),
  }));
}

function testEmptyAdmittedSetWithEmptyStagingPassesAndExtraFails(): void {
  const resolved = closure([{ familyId: FAMILY_A, admitted: [] }]);
  assert.doesNotThrow(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, []]]),
  }));
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:x"]]]),
  }), /exact-set mismatch/);
}

function testDuplicateClosureFamilyFails(): void {
  const resolved = closure([
    { familyId: FAMILY_A, admitted: ["pool:a"] },
    { familyId: FAMILY_A, admitted: ["pool:b"] },
  ]);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:a"]]]),
  }), /duplicate Family/);
}

function testDuplicateStagedKeyFails(): void {
  const resolved = closure([{ familyId: FAMILY_A, admitted: ["pool:a"] }]);
  assert.throws(() => assertClosureStagedExactSetCoupling({
    closure: resolved,
    stagedByFamily: staged([[FAMILY_A, ["pool:a", "pool:a"]]]),
  }), /duplicate staged key/);
}

async function main(): Promise<void> {
  testExactMatchPassesOrderInsensitively();
  testMissingOrExtraKeyFails();
  testMissingOrUnexpectedFamilyFails();
  testEmptyClosureAndEmptyStagingPasses();
  testEmptyAdmittedSetWithEmptyStagingPassesAndExtraFails();
  testDuplicateClosureFamilyFails();
  testDuplicateStagedKeyFails();
  console.log("adapter-family closure exact-set coupling PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
