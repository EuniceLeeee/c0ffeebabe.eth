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

const trueBoolBackend: TokenQueryBackend = {
  call: async () => `0x${"0".repeat(63)}1`,
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

  const fluidDexEntry = POOL_REGISTRY.find((entry) => entry.adapter === "fluid-dex");
  assert(fluidDexEntry !== undefined, "POOL_REGISTRY fluid-dex entry missing");
  const fluidDexEdges = await buildTokenGraph(unusedBackend, [fluidDexEntry]);
  assert(fluidDexEdges.length === 2, `fluid-dex edge count ${fluidDexEdges.length}`);
  assertTaxonomy(fluidDexEdges[0], "swap", false, "fluid-dex edge");

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

  const erc4626Entry = POOL_REGISTRY.find((entry) =>
    entry.adapter === "erc4626" && entry.address.toLowerCase() === ADDR.SUSDS.toLowerCase()
  );
  assert(erc4626Entry !== undefined, "POOL_REGISTRY sUSDS ERC4626 entry missing");
  const erc4626Edges = await buildTokenGraph(unusedBackend, [erc4626Entry]);
  assert(erc4626Edges.length === 2, `erc4626 edge count ${erc4626Edges.length}`);
  const depositEdge = erc4626Edges.find((edge) => edge.adapterId === "erc4626-deposit");
  const redeemEdge = erc4626Edges.find((edge) => edge.adapterId === "erc4626-redeem");
  assert(depositEdge !== undefined, "erc4626 deposit edge missing");
  assert(redeemEdge !== undefined, "erc4626 redeem edge missing");
  assert(depositEdge.protocolAction === "wrap", `erc4626 deposit action ${depositEdge.protocolAction}`);
  assert(redeemEdge.protocolAction === "redeem", `erc4626 redeem action ${redeemEdge.protocolAction}`);
  assertTaxonomy(depositEdge, "protocol", false, "erc4626 deposit protocol/wrap edge");
  assertTaxonomy(redeemEdge, "protocol", false, "erc4626 redeem protocol/redeem edge");

  const hgUsdcEntry = POOL_REGISTRY.find((entry) => entry.adapter === "metronome-hgusdc");
  assert(hgUsdcEntry !== undefined, "Metronome hgUSDC router entry missing");
  assert(
    Boolean(hgUsdcEntry.receiptEmitters
      ?.map((address) => address.toLowerCase())
      .includes(ADDR.HGUSDC.toLowerCase())),
    "Metronome hgUSDC receipt emitter alias missing",
  );
  assert(
    hgUsdcEntry.fixedSlotKind === "protocol" && hgUsdcEntry.fixedProtocolAction === "redeem",
    "Metronome hgUSDC protocol metadata missing",
  );
  const hgUsdcEdges = await buildTokenGraph(unusedBackend, [hgUsdcEntry]);
  const hgUsdcExit = hgUsdcEdges.find((edge) => edge.adapterId === "metronome-hgusdc-exit");
  assert(hgUsdcExit !== undefined, "Metronome hgUSDC exit edge missing");
  assert(
    hgUsdcExit.tokenIn.toLowerCase() === ADDR.MSUSD.toLowerCase() &&
      hgUsdcExit.tokenOut.toLowerCase() === ADDR.USDC.toLowerCase(),
    `Metronome hgUSDC exit edge ${hgUsdcExit.tokenIn}->${hgUsdcExit.tokenOut}`,
  );
  assertTaxonomy(hgUsdcExit, "protocol", false, "Metronome hgUSDC protocol/redeem edge");

  const metronomeEntry = POOL_REGISTRY.find((entry) => entry.adapter === "metronome-synth");
  assert(metronomeEntry !== undefined, "POOL_REGISTRY metronome synth entry missing");
  const metronomeEdges = await buildTokenGraph(trueBoolBackend, [metronomeEntry]);
  assert(metronomeEdges.length === 6, `metronome edge count ${metronomeEdges.length}`);
  const msEthToMsBtc = metronomeEdges.find((edge) =>
    edge.adapterId === "metronome-synth-swap" &&
    edge.tokenIn.toLowerCase() === ADDR.MSETH.toLowerCase() &&
    edge.tokenOut.toLowerCase() === ADDR.MSBTC.toLowerCase()
  );
  assert(msEthToMsBtc !== undefined, "metronome msETH->msBTC edge missing");
  assert(msEthToMsBtc.protocolAction === "convert", `metronome action ${msEthToMsBtc.protocolAction}`);
  assertTaxonomy(msEthToMsBtc, "protocol", false, "metronome synth protocol/convert edge");
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
