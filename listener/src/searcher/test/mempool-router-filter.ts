import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FORCE_INCLUDE_ROUTERS_PATH,
  loadForceIncludeRouters,
} from "../force-include.js";
import { buildMempoolToAddressFilter } from "../main.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function includesAddress(addresses: readonly string[], address: string): boolean {
  const needle = address.toLowerCase();
  return addresses.some((item) => item.toLowerCase() === needle);
}

const DEBRIDGE = "0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251";
const UNIV2_ROUTER02 = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mempool-router-filter-"));
  try {
    const emptyPath = join(dir, "empty-routers.json");
    writeFileSync(emptyPath, JSON.stringify([]));
    const before = buildMempoolToAddressFilter([], emptyPath);
    assert(
      !includesAddress(before, DEBRIDGE),
      "empty router seed should not admit deBridge",
    );

    const seededPath = join(dir, "seeded-routers.json");
    writeFileSync(seededPath, JSON.stringify([DEBRIDGE]));
    const after = buildMempoolToAddressFilter([], seededPath);
    assert(
      includesAddress(after, DEBRIDGE),
      "seeded router file should admit deBridge",
    );

    const committedSeed = loadForceIncludeRouters(DEFAULT_FORCE_INCLUDE_ROUTERS_PATH);
    assert(
      committedSeed.length >= 28,
      `committed router seed should contain >=28 entries (seed baseline), got ${committedSeed.length}`,
    );
    assert(
      includesAddress(committedSeed, DEBRIDGE),
      "committed router seed should include deBridge",
    );
    assert(
      includesAddress(after, UNIV2_ROUTER02),
      "router merge should preserve builtin UniV2 Router02",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("[mempool-router-filter] victim to-gate deBridge admitted false->true PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
