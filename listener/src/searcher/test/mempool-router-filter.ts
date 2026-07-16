import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FORCE_INCLUDE_ROUTERS_PATH,
  loadForceIncludeRouters,
} from "../force-include.js";
import {
  buildMempoolIntakeWithRouters,
  buildMempoolToAddressFilter,
  hashOnlyImpactReplayAdmitted,
  isMempoolIntakeTarget,
  victimSourceMode,
} from "../main.js";
import { ADDR } from "../../shared/constants/addresses.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function includesAddress(addresses: readonly string[], address: string): boolean {
  const needle = address.toLowerCase();
  return addresses.some((item) => item.toLowerCase() === needle);
}

const DEBRIDGE = "0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251";
const UNIV2_ROUTER02 = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const LONGTAIL_POOL = "0x0000000000000000000000000000000000000a11";

async function main(): Promise<void> {
  assert(victimSourceMode(false, false, false) === "disabled", "disabled lane has no victim source");
  assert(victimSourceMode(true, true, false) === "public-mempool", "public-only mode excludes MEV-Share");
  assert(victimSourceMode(true, false, true) === "mev-share", "MEV-Share-only mode remains explicit");
  assert(victimSourceMode(true, true, true) === "both", "dual-source mode remains explicit");
  let emptySourceRejected = false;
  try {
    victimSourceMode(true, false, false);
  } catch {
    emptySourceRejected = true;
  }
  assert(emptySourceRejected, "enabled backrun lane rejects an empty victim-source set");
  assert(hashOnlyImpactReplayAdmitted("univ2-swap"), "V2 hash-only replay remains admitted");
  assert(
    !hashOnlyImpactReplayAdmitted("balancer-v3-unlock"),
    "Balancer V3 receipt observation must remain public-raw-tx only",
  );
  assert(
    !hashOnlyImpactReplayAdmitted("curve-exchange-underlying"),
    "Curve underlying receipt observation must remain public-raw-tx only",
  );

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
      "adapter intake should include UniV2 Router02",
    );
    assert(
      includesAddress(before, ADDR.BALANCER_V3_ROUTER) &&
        includesAddress(before, ADDR.BALANCER_V3_VAULT),
      "Balancer V3 adapter should admit its canonical Router and Vault",
    );

    const previousTopN = process.env.SEARCHER_MEMPOOL_FILTER_TOP_N;
    process.env.SEARCHER_MEMPOOL_FILTER_TOP_N = "0";
    try {
      const intake = buildMempoolIntakeWithRouters([{
        address: LONGTAIL_POOL,
        adapter: "univ2",
        score: 1,
      }], []);
      assert(
        includesAddress(intake.fullTargets, LONGTAIL_POOL),
        "local firehose should retain every graph pool",
      );
      assert(
        !includesAddress(intake.filteredTargets, LONGTAIL_POOL),
        "external provider filter may load-shed a non-hot graph pool",
      );
      assert(intake.filteredTruncated, "external coverage gap should be explicit");

      const liveTargets = new Set<string>();
      assert(
        !isMempoolIntakeTarget(LONGTAIL_POOL, new Set(), liveTargets),
        "new graph pool should be absent before refresh",
      );
      liveTargets.add(LONGTAIL_POOL.toLowerCase());
      assert(
        isMempoolIntakeTarget(LONGTAIL_POOL, new Set(), liveTargets),
        "mutable graph target set should admit a pool added by refresh",
      );
    } finally {
      if (previousTopN === undefined) delete process.env.SEARCHER_MEMPOOL_FILTER_TOP_N;
      else process.env.SEARCHER_MEMPOOL_FILTER_TOP_N = previousTopN;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("[mempool-router-filter] adapter/dynamic/full-local intake coverage PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
