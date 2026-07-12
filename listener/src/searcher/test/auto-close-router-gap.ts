import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import {
  autoCloseRouterGap,
  type ResolveSourceSwapToFn,
} from "../auto-close-router-gap.js";
import { loadForceIncludeRouters } from "../force-include.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const C_GAP = "0x" + "11".repeat(32);
const C_ADMITTED = "0x" + "22".repeat(32);
const C_ATOMIC = "0x" + "33".repeat(32);
const C_SANDWICH = "0x" + "44".repeat(32);
const C_UNKNOWN = "0x" + "55".repeat(32);
const C_KEEPER = "0x" + "66".repeat(32);
const C_RFQ = "0x" + "77".repeat(32);
const C_INVENTORY = "0x" + "88".repeat(32);
const GAP_ROUTER = ethers.getAddress("0x1000000000000000000000000000000000000001");
const ADMITTED_ROUTER = ethers.getAddress("0x2000000000000000000000000000000000000002");

function writeReport(path: string, routeGapDecisive: boolean): void {
  writeFileSync(
    path,
    JSON.stringify({
      verdict: { route_gap_decisive: routeGapDecisive },
      analyzed_competitors: [
        { hash: C_GAP, winner_style: "atomic_loop" },
        { hash: C_ADMITTED, winner_style: "atomic_loop" },
        { hash: C_ATOMIC, winner_style: "atomic_loop" },
        { hash: C_SANDWICH, winner_style: "sandwich" },
        { hash: C_UNKNOWN, winner_style: "unknown" },
        { hash: C_KEEPER, winner_style: "keeper_claim" },
        { hash: C_RFQ, winner_style: "rfq_fill" },
        { hash: C_INVENTORY, winner_style: "inventory_vault_rebalance" },
      ],
    }, null, 2) + "\n",
  );
}

function resolver(): { fn: ResolveSourceSwapToFn; calls: string[] } {
  const calls: string[] = [];
  const sourceByHash = new Map<string, string | null>([
    [C_GAP, GAP_ROUTER.toLowerCase()],
    [C_ADMITTED, ADMITTED_ROUTER.toLowerCase()],
    [C_ATOMIC, null],
  ]);
  return {
    calls,
    fn: async (hash: string) => {
      calls.push(hash);
      if (!sourceByHash.has(hash)) throw new Error(`unexpected resolver call ${hash}`);
      return { sourceTo: sourceByHash.get(hash) ?? null };
    },
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-router-gap-"));
  try {
    const report = join(dir, "report.json");
    const falseReport = join(dir, "report-false.json");
    const forceInclude = join(dir, "force-include-routers.json");
    const falseForceInclude = join(dir, "force-include-routers-false.json");
    const findings = join(dir, "auto-close-router-findings.jsonl");
    writeReport(report, true);
    writeReport(falseReport, false);

    const firstResolver = resolver();
    const first = await autoCloseRouterGap({
      reportPath: report,
      currentAllowlist: new Set([ADMITTED_ROUTER.toLowerCase()]),
      resolveSourceSwapToFn: firstResolver.fn,
      forceIncludePath: forceInclude,
      findingsPath: findings,
      append: true,
      log: () => undefined,
    });

    assert(first.routeGapDecisive, "route_gap true result should remain decisive");
    assertArrayEq(first.routersAdded, [GAP_ROUTER], "out-of-allowlist router should append");
    assertArrayEq(first.alreadyAdmitted, [ADMITTED_ROUTER], "admitted router should be a no-op");
    assertArrayEq(first.noSourceSwap, [C_ATOMIC], "atomic competitor should record no source swap");
    assertArrayEq(
      first.skippedNonComparable,
      [C_SANDWICH, C_UNKNOWN, C_KEEPER, C_RFQ, C_INVENTORY],
      "every non-atomic or unknown winner should be skipped",
    );
    assertArrayEq(first.failed.map((failure) => failure.hash), [], "fixture should not fail");
    assert(
      firstResolver.calls.length === 3,
      "only atomic-loop competitors should call resolver",
    );
    assertArrayEq(
      loadForceIncludeRouters(forceInclude),
      [GAP_ROUTER],
      "force-include router file should contain only the gap router",
    );

    const secondResolver = resolver();
    const second = await autoCloseRouterGap({
      reportPath: report,
      currentAllowlist: new Set([ADMITTED_ROUTER.toLowerCase()]),
      resolveSourceSwapToFn: secondResolver.fn,
      forceIncludePath: forceInclude,
      findingsPath: findings,
      append: true,
      log: () => undefined,
    });
    assertArrayEq(second.routersAdded, [], "second run should not append a duplicate");
    assertArrayEq(
      loadForceIncludeRouters(forceInclude),
      [GAP_ROUTER],
      "second run should leave one force-include router entry",
    );

    const falseResolver = resolver();
    const falseResult = await autoCloseRouterGap({
      reportPath: falseReport,
      currentAllowlist: new Set([ADMITTED_ROUTER.toLowerCase()]),
      resolveSourceSwapToFn: falseResolver.fn,
      forceIncludePath: falseForceInclude,
      findingsPath: join(dir, "false-findings.jsonl"),
      append: true,
      log: () => undefined,
    });
    assert(!falseResult.routeGapDecisive, "route_gap false should return false");
    assertArrayEq(falseResult.routersAdded, [], "route_gap false should not append");
    assert(!existsSync(falseForceInclude), "route_gap false should not write force-include");
    assertArrayEq(falseResolver.calls, [], "route_gap false should not resolve competitors");

    const findingKinds = readFileSync(findings, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { kind?: string }).kind);
    assert(findingKinds.includes("router_added"), "findings should record router_added");
    assert(findingKinds.includes("already_admitted"), "findings should record already_admitted");
    assert(findingKinds.includes("no_source_swap"), "findings should record no_source_swap");
    assert(
      findingKinds.includes("skipped_non_comparable"),
      "findings should record skipped_non_comparable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    "[auto-close-router-gap] out-of-allowlist source router appended, " +
      "admitted/atomic/non-atomic skipped, idempotent PASS",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
