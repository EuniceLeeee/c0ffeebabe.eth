import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import {
  deriveEdgeTaxonomy,
  edgeKindFromPoolEntry,
  edgeKindFromSlotKind,
  pathLeavesStandingPosition,
  strategyKindFromTxShape,
} from "../strategy-taxonomy.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertTaxonomy(
  edge: Pick<TokenEdge, "edgeKind" | "leavesStandingPosition">,
  edgeKind: TokenEdge["edgeKind"],
  leavesStandingPosition: boolean,
  label: string,
): void {
  assert(edge.edgeKind === edgeKind, `${label}: edgeKind ${edge.edgeKind}`);
  assert(
    edge.leavesStandingPosition === leavesStandingPosition,
    `${label}: leavesStandingPosition ${edge.leavesStandingPosition}`,
  );
}

const unusedBackend: TokenQueryBackend = {
  call: async () => {
    throw new Error("taxonomy test backend should not be called");
  },
};

function testSlotKindMapping(): void {
  assert(edgeKindFromSlotKind("lend") === "credit", "lend maps to credit");
  assert(edgeKindFromSlotKind("flash") === "flash", "flash maps to flash");
  assert(edgeKindFromSlotKind("swap") === "swap", "swap maps to swap");
  assert(edgeKindFromSlotKind("protocol") === "protocol", "protocol maps to protocol");
  console.log("[taxonomy] edgeKindFromSlotKind: PASS");
}

function testDeriveEdgeTaxonomy(): void {
  assertTaxonomy(deriveEdgeTaxonomy("lend"), "credit", true, "derive lend");
  assertTaxonomy(deriveEdgeTaxonomy("swap"), "swap", false, "derive swap");
  assertTaxonomy(deriveEdgeTaxonomy("flash"), "flash", false, "derive flash");
  // protocol edges: full-value conversions route unguarded; debt mint + undeclared are fail-closed.
  assertTaxonomy(deriveEdgeTaxonomy("protocol", "convert"), "protocol", false, "derive protocol convert");
  assertTaxonomy(deriveEdgeTaxonomy("protocol", "wrap"), "protocol", false, "derive protocol wrap");
  assertTaxonomy(deriveEdgeTaxonomy("protocol", "unwrap"), "protocol", false, "derive protocol unwrap");
  assertTaxonomy(deriveEdgeTaxonomy("protocol", "redeem"), "protocol", false, "derive protocol redeem");
  assertTaxonomy(deriveEdgeTaxonomy("protocol", "mint"), "protocol", true, "derive protocol mint (debt → guarded)");
  assertTaxonomy(deriveEdgeTaxonomy("protocol"), "protocol", true, "derive protocol undeclared (fail-closed)");
  console.log("[taxonomy] deriveEdgeTaxonomy: PASS");
}

async function testTokenGraphEdges(): Promise<void> {
  const fluidEntry = POOL_REGISTRY.find((entry) => entry.adapter === "fluid-vault");
  assert(fluidEntry !== undefined, "POOL_REGISTRY fluid-vault entry missing");
  assert(fluidEntry.fixedSlotKind === "lend", `fluid fixedSlotKind ${fluidEntry.fixedSlotKind}`);

  const fluidEdges = await buildTokenGraph(unusedBackend, [fluidEntry]);
  assert(fluidEdges.length === 1, `fluid edge count ${fluidEdges.length}`);
  assertTaxonomy(fluidEdges[0], "credit", true, "fluid-vault edge");

  const univ3Entry: PoolEntry = {
    address: ADDR.UNISWAP_V3_USDT_WETH,
    adapter: "univ3",
    token0: ADDR.WETH,
    token1: ADDR.USDT,
  };
  const univ3Edges = await buildTokenGraph(unusedBackend, [univ3Entry]);
  assert(univ3Edges.length === 2, `univ3 edge count ${univ3Edges.length}`);
  assertTaxonomy(univ3Edges[0], "swap", false, "univ3 edge");

  const flashEdge: TokenEdge = {
    adapterId: "morpho-flash",
    target: ADDR.MORPHO,
    tokenIn: ADDR.WSTUSR,
    tokenOut: ADDR.WSTUSR,
    slotKind: "flash",
    ...deriveEdgeTaxonomy("flash"),
  };
  assertTaxonomy(flashEdge, "flash", false, "flash edge");

  // A0: the PSM entry is reclassified protocol/convert — a full-value conversion that must NOT
  // leave a standing position (behavior-neutral vs the prior swap classification), and its
  // PoolEntry-level projection must agree with the edge-level derivation.
  const psmEntry = POOL_REGISTRY.find((entry) => entry.adapter === "psm");
  assert(psmEntry !== undefined, "POOL_REGISTRY psm entry missing");
  assert(psmEntry.fixedSlotKind === "protocol", `psm fixedSlotKind ${psmEntry.fixedSlotKind}`);
  assert(psmEntry.fixedProtocolAction === "convert", `psm fixedProtocolAction ${psmEntry.fixedProtocolAction}`);
  const psmEdges = await buildTokenGraph(unusedBackend, [psmEntry]);
  assert(psmEdges.length === 1, `psm edge count ${psmEdges.length}`);
  assert(psmEdges[0].protocolAction === "convert", `psm edge protocolAction ${psmEdges[0].protocolAction}`);
  assertTaxonomy(psmEdges[0], "protocol", false, "psm protocol/convert edge");
  assert(
    edgeKindFromPoolEntry(psmEntry) === psmEdges[0].edgeKind,
    "psm PoolEntry edge kind should agree with the edge-level derivation",
  );
  console.log("[taxonomy] token graph edge taxonomy: PASS");
}

function testStrategyMapping(): void {
  assert(strategyKindFromTxShape("backrun") === "backrun", "backrun maps to backrun");
  assert(strategyKindFromTxShape("atomic_state_arb") === "block-scan", "atomic_state_arb maps to block-scan");
  assert(strategyKindFromTxShape("unknown") === "unknown", "unknown maps to unknown");
  console.log("[taxonomy] strategyKindFromTxShape: PASS");
}

function testPathLeavesStandingPosition(): void {
  assert(pathLeavesStandingPosition([
    { leavesStandingPosition: false },
    { leavesStandingPosition: true },
  ]), "credit path should leave standing position");
  assert(!pathLeavesStandingPosition([
    { leavesStandingPosition: false },
    { leavesStandingPosition: false },
  ]), "all-swap path should not leave standing position");
  assert(!pathLeavesStandingPosition([]), "empty path should not leave standing position");
  console.log("[taxonomy] pathLeavesStandingPosition: PASS");
}

async function main(): Promise<void> {
  testSlotKindMapping();
  testDeriveEdgeTaxonomy();
  await testTokenGraphEdges();
  testStrategyMapping();
  testPathLeavesStandingPosition();
  console.log("taxonomy PASS (5/5)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
