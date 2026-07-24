import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CREDIT_LIVE_MARKER_PATH,
  evaluateStandingGuard,
} from "../standing-guard.js";
import {
  deriveEdgeTaxonomy,
} from "../strategy-taxonomy.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertAllowed(result: ReturnType<typeof evaluateStandingGuard>, label: string): void {
  assert(result.allowed === true, `${label}: expected allowed`);
  assert(result.reason === undefined, `${label}: unexpected reason ${result.reason}`);
}

function assertStandingUnauthorized(
  result: ReturnType<typeof evaluateStandingGuard>,
  label: string,
): void {
  assert(result.allowed === false, `${label}: expected rejection`);
  assert(
    result.reason === "standing_position_unauthorized",
    `${label}: reason ${result.reason}`,
  );
}

function testAbsentMarkerRejectsStandingEdge(tmpDir: string): void {
  const markerPath = join(tmpDir, "absent-marker");
  const result = evaluateStandingGuard([{ leavesStandingPosition: true }], markerPath);
  assertStandingUnauthorized(result, "standing edge without marker");
  console.log("[standing-guard] absent marker rejects standing edge: PASS");
}

function testPresentMarkerAllowsStandingEdge(tmpDir: string): void {
  const markerPath = join(tmpDir, "credit-live");
  writeFileSync(markerPath, "");
  const result = evaluateStandingGuard([{ leavesStandingPosition: true }], markerPath);
  assertAllowed(result, "standing edge with marker");
  console.log("[standing-guard] present marker allows standing edge: PASS");
}

function testAllSwapEdgesAllowed(tmpDir: string): void {
  const edges = [
    { leavesStandingPosition: false },
    { leavesStandingPosition: false },
  ];
  assertAllowed(evaluateStandingGuard(edges, join(tmpDir, "absent-swap-marker")), "all-swap absent marker");
  const markerPath = join(tmpDir, "present-swap-marker");
  writeFileSync(markerPath, "");
  assertAllowed(evaluateStandingGuard(edges, markerPath), "all-swap present marker");
  console.log("[standing-guard] all-swap edges allowed: PASS");
}

function testFinalGuardRederivesTaxonomy(tmpDir: string): void {
  const markerPath = join(tmpDir, "absent-derived-marker");
  const forgedSafeCredit = evaluateStandingGuard([{
    slotKind: "lend",
    leavesStandingPosition: false,
  }], markerPath);
  assert(forgedSafeCredit.allowed === false, "forged safe credit should be rejected");
  assert(
    forgedSafeCredit.reason === "edge_taxonomy_inconsistent",
    `forged safe credit reason ${forgedSafeCredit.reason}`,
  );
  assert(forgedSafeCredit.containsStandingPosition, "credit should be re-derived as standing");
  console.log("[standing-guard] final taxonomy re-derivation: PASS");
}

async function testFluidVaultEdgeFlowsThrough(tmpDir: string): Promise<void> {
  // Fluid is dynamically admitted now; the final guard is deliberately
  // independent of admission provenance and re-derives the same lend taxonomy.
  const edges = [{ slotKind: "lend" as const, ...deriveEdgeTaxonomy("lend") }];
  const result = evaluateStandingGuard(edges, join(tmpDir, "absent-fluid-marker"));
  assertStandingUnauthorized(result, "fluid-vault edge without marker");
  console.log("[standing-guard] fluid-vault edge flows through: PASS");
}

async function main(): Promise<void> {
  assert(
    DEFAULT_CREDIT_LIVE_MARKER_PATH === "/opt/MEV/.credit-live",
    "default marker path changed",
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "mev-standing-guard-"));
  try {
    testAbsentMarkerRejectsStandingEdge(tmpDir);
    testPresentMarkerAllowsStandingEdge(tmpDir);
    testAllSwapEdgesAllowed(tmpDir);
    testFinalGuardRederivesTaxonomy(tmpDir);
    await testFluidVaultEdgeFlowsThrough(tmpDir);
    console.log("standing-guard PASS (5/5)");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
