import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import {
  DEFAULT_FORCE_INCLUDE_POOLIDS_PATH,
  loadForceIncludePoolIds,
  mergeForceIncludePoolIds,
} from "../force-include.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function poolAddress(n: number): string {
  return ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
}

const CFG_V4_POOL_ID = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "force-include-"));
  try {
    const fixture = join(dir, "force-include-poolids.json");
    const address = poolAddress(0xa11ce);
    const poolId = "0x" + "22".repeat(32);
    const upperPoolId = "0x" + poolId.slice(2).toUpperCase();
    writeFileSync(fixture, JSON.stringify([
      address.toLowerCase(),
      upperPoolId,
      "not-a-pool",
      address,
      poolId,
    ]));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    let loaded: string[] = [];
    try {
      loaded = loadForceIncludePoolIds(fixture);
    } finally {
      console.warn = originalWarn;
    }
    assertArrayEq(loaded, [address, poolId], "loader should return valid address + poolId once");
    assert(
      warnings.some((line) => line.includes("forceInclude skipped invalid entry")),
      "loader should warn for invalid entries",
    );
    console.log("[force-include] load/validate/dedup fixture: PASS");

    const missing = loadForceIncludePoolIds(join(dir, "missing.json"));
    assertArrayEq(missing, [], "missing force-include file should default to empty");
    console.log("[force-include] missing file defaults empty: PASS");

    const envAddress = poolAddress(0xb0b);
    const merged = mergeForceIncludePoolIds(
      [envAddress],
      [CFG_V4_POOL_ID, envAddress.toLowerCase(), "0x" + CFG_V4_POOL_ID.slice(2).toUpperCase()],
    );
    assertArrayEq(
      merged,
      [envAddress, CFG_V4_POOL_ID],
      "merge should preserve env then file order and dedup across sources",
    );
    console.log("[force-include] env+file merge unique: PASS");

    const seed = loadForceIncludePoolIds(DEFAULT_FORCE_INCLUDE_POOLIDS_PATH);
    assert(
      seed.includes(CFG_V4_POOL_ID),
      `seed file should contain ${CFG_V4_POOL_ID}`,
    );
    console.log("[force-include] committed seed file parses: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    "expected_transition: force-include list now sourced from a committed file " +
      "(survives deploy) -> 0x267d01...9348cd9c is force-included durably",
  );
  console.log("verdict: fixed");
  console.log("force-include PASS (4/4)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
