import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildV2LineageSnapshot,
  consolidateVerifiedLineages,
  matchTrustedFingerprints,
  type ProbedV2Pool,
  type VerifiedLineage,
} from "../refresh-v2-lineages.js";
import { parseV2LineageSnapshot, V2_LINEAGES } from "../venues/v2-lineage.js";

const pool = "0x0000000000000000000000000000000000001000";
const factory = "0x0000000000000000000000000000000000002000";
const factoryCodeHash = `0x${"11".repeat(32)}`;
const pairCodeHash = `0x${"22".repeat(32)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function probed(overrides: Partial<ProbedV2Pool> = {}): ProbedV2Pool {
  return { factory, pool, factoryCodeHash, pairCodeHash, ...overrides };
}

function verified(overrides: Partial<VerifiedLineage> = {}): VerifiedLineage {
  return { ...probed(), feeBps: 30, ...overrides };
}

function testFingerprintAdmission(): void {
  const trusted = [{ factoryCodeHash, pairCodeHash, feeBps: 30 }];
  assert(matchTrustedFingerprints([probed()], trusted)[0]?.feeBps === 30, "exact dual-codehash match");
  assert(
    matchTrustedFingerprints([probed({ pairCodeHash: `0x${"33".repeat(32)}` })], trusted).length === 0,
    "pair-only mismatch must fail closed",
  );
  assert(
    matchTrustedFingerprints([probed({ factoryCodeHash: `0x${"44".repeat(32)}` })], trusted).length === 0,
    "factory-only mismatch must fail closed",
  );
  assert(
    matchTrustedFingerprints([probed()], [...trusted, { factoryCodeHash, pairCodeHash, feeBps: 25 }]).length === 0,
    "conflicting trusted fingerprints must fail closed",
  );
  console.log("[v2-lineage-refresh] dual runtime fingerprint admission: PASS");
}

function testSnapshotLifecycle(): void {
  assert(
    consolidateVerifiedLineages([verified(), verified({ feeBps: 25 })]).length === 0,
    "same factory with conflicting fees must be quarantined",
  );
  const round1 = buildV2LineageSnapshot(V2_LINEAGES, [verified()], 21_000_000, "2026-07-17T00:00:00.000Z");
  const parsedRound1 = parseV2LineageSnapshot(round1);
  const generated = parsedRound1.find((item) => item.factory.toLowerCase() === factory.toLowerCase());
  assert(generated?.venue === `v2-factory:${factory.toLowerCase()}`, "new factory venue id must be deterministic");
  assert(generated?.measuredFeeRule?.feeBps === 30n, "generated fee must survive snapshot parsing");

  const round2 = buildV2LineageSnapshot(parsedRound1, [], 21_000_001);
  assert(
    !round2.lineages.some((item) => item.factory.toLowerCase() === factory.toLowerCase()),
    "automatic factory must expire when the next refresh has no fresh proof",
  );

  const canonical = V2_LINEAGES.find((item) => item.venue === "univ2")!;
  const maliciousAnchor = {
    ...round1,
    lineages: [{
      venue: canonical.venue,
      factory: "0x000000000000000000000000000000000000dEaD",
      executionFamily: "univ2-standard",
      runtimeAdapter: "univ2",
      discoverable: true,
      quotable: true,
      buildable: true,
      measuredFeeRule: { kind: "constant-bps", feeBps: 999, evidence: "forged" },
    }],
  };
  assertThrows(
    () => parseV2LineageSnapshot(maliciousAnchor),
    "snapshot must not redefine an immutable canonical lineage",
  );

  const unmeasured = V2_LINEAGES.find((item) => item.measuredFeeRule === null)!;
  const measured = buildV2LineageSnapshot(V2_LINEAGES, [verified({ factory: unmeasured.factory })], 1);
  const measuredAfter = measured.lineages.find((item) => item.factory.toLowerCase() === unmeasured.factory.toLowerCase());
  assert(measuredAfter?.venue === unmeasured.venue, "automatic proof must preserve a named lineage label");
  assert(measuredAfter?.measuredFeeRule?.feeBps === 30, "automatic proof must fill an unmeasured named lineage");

  const unsafe = {
    ...round1,
    lineages: [{ ...round1.lineages[0], discoverable: true, measuredFeeRule: null }],
  };
  assertThrows(() => parseV2LineageSnapshot(unsafe), "discoverable lineage without fee must fail closed");
  console.log("[v2-lineage-refresh] snapshot expiry/immutability: PASS");
}

function testExplicitUnsupportedWins(): void {
  const panoramaFactory = "0x82Eeb5A22A25310ac15352197d92d6C17A49602e";
  const snapshot = buildV2LineageSnapshot(V2_LINEAGES, [verified({ factory: panoramaFactory })], 1);
  const dir = mkdtempSync(join(tmpdir(), "v2-lineage-test-"));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify(snapshot));
  try {
    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const {findVenueByFactory}=await import('./src/searcher/venues/capability.ts');` +
        `const c=findVenueByFactory('${panoramaFactory}');` +
        `if(c?.venue!=='panoramaswap-v1'||c.discoverable||c.quotable||c.buildable)process.exit(1);`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SEARCHER_V2_LINEAGES_PATH: path },
      encoding: "utf8",
    });
    assert(child.status === 0, `explicit unsupported identity lost: ${child.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("[v2-lineage-refresh] explicit unsupported factory precedence: PASS");
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

testFingerprintAdmission();
testSnapshotLifecycle();
testExplicitUnsupportedWins();
