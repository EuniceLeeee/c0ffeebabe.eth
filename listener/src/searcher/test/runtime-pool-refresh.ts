import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { buildMempoolIntakeWithRouters } from "../main.js";
import {
  MempoolIntakeRefreshSignal,
  prepareRuntimePoolRefresh,
  selectRefreshCandidates,
} from "../runtime-pool-refresh.js";
import { buildStrategyViews, type StrategyViews } from "../strategy-views.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function address(n: number): string {
  return ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

function edge(pool: PoolEntry, tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: pool.address,
    tokenIn,
    tokenOut,
    poolToken0: tokenIn,
    poolToken1: tokenOut,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    score: pool.score,
  };
}

const BASE: PoolEntry = {
  address: address(0xa320),
  adapter: "univ2",
  token0: address(0xb320),
  token1: address(0xc320),
};
const FRESH: PoolEntry = {
  address: address(0xa321),
  adapter: "univ2",
  token0: address(0xb321),
  token1: address(0xc321),
  score: 50,
};
const BASE_GRAPH = [
  edge(BASE, BASE.token0!, BASE.token1!),
  edge(BASE, BASE.token1!, BASE.token0!),
];
const RESERVES = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]).encodeFunctionResult("getReserves", [1_000n, 2_000n, 0]);
const VIEW_OPTS = {
  blockscanMaxPools: 10,
  poolUniverseGeneratedAt: "2026-07-16T00:00:00.000Z",
};

function views(backrunPools: PoolEntry[]): StrategyViews {
  return buildStrategyViews(backrunPools, [], [], VIEW_OPTS);
}

function includesAddress(values: readonly string[], wanted: string): boolean {
  return values.some((value) => value.toLowerCase() === wanted.toLowerCase());
}

async function main(): Promise<void> {
  let backendHealthy = false;
  const backend: TokenQueryBackend = {
    call: async () => {
      if (!backendHealthy) throw new Error("transient token query");
      return RESERVES;
    },
  };
  const baseKnown = new Set([BASE.address.toLowerCase()]);

  const first = await prepareRuntimePoolRefresh({
    backend,
    freshPools: [FRESH],
    knownPoolKeys: baseKnown,
    currentBackrunPools: [BASE],
    currentBackrunGraph: BASE_GRAPH,
    currentBlockscanGraph: BASE_GRAPH,
    buildStrategyViews: views,
  });
  assert(first.attemptedPools.length === 1, "first refresh should attempt the fresh pool");
  assert(first.admittedPools.length === 0, "failed edge build must not admit the pool");
  assert(first.failedPools.length === 1, "failed edge build should be attributable");
  assert(!first.knownPoolKeys.has(FRESH.address.toLowerCase()), "failed pool must remain retryable");
  assert(first.backrunGraph.length === BASE_GRAPH.length, "failed refresh must not change graph");
  console.log("[runtime-refresh] transient failure remains retryable: PASS");

  backendHealthy = true;
  const second = await prepareRuntimePoolRefresh({
    backend,
    freshPools: [FRESH],
    knownPoolKeys: first.knownPoolKeys,
    currentBackrunPools: first.strategyViews.backrun,
    currentBackrunGraph: first.backrunGraph,
    currentBlockscanGraph: first.blockscanGraph,
    buildStrategyViews: views,
  });
  assert(second.admittedPools.length === 1, "healthy retry should admit the fresh pool");
  assert(second.backrunGraph.length === BASE_GRAPH.length + 2, "fresh V2 edges should enter backrun graph");
  assert(second.knownPoolKeys.has(FRESH.address.toLowerCase()), "successful pool should become known");
  assert(
    second.tokenIndex.get(FRESH.token0!.toLowerCase())?.has(FRESH.address.toLowerCase()) === true,
    "fresh pool should enter token index",
  );
  assert(
    second.poolAddressMap.get(FRESH.address.toLowerCase()) === FRESH.adapter,
    "fresh pool should enter broad pool map",
  );
  assert(includesAddress(second.flashTokens, FRESH.token0!), "fresh token should enter flash rotation");
  assert(
    second.blockscanGraph?.some(
      (item) => item.target.toLowerCase() === FRESH.address.toLowerCase(),
    ) === true,
    "blockscan-admitted fresh pool should enter blockscan graph",
  );
  const intake = buildMempoolIntakeWithRouters(second.strategyViews.backrun, []);
  assert(
    includesAddress(intake.filteredTargets, FRESH.address),
    "fresh hot pool should enter rebuilt filtered mempool subscription",
  );
  console.log("[runtime-refresh] all backrun and mempool projections advance together: PASS");

  const third = await prepareRuntimePoolRefresh({
    backend,
    freshPools: [FRESH],
    knownPoolKeys: second.knownPoolKeys,
    currentBackrunPools: second.strategyViews.backrun,
    currentBackrunGraph: second.backrunGraph,
    currentBlockscanGraph: second.blockscanGraph,
    buildStrategyViews: views,
  });
  assert(third.attemptedPools.length === 0, "successful pool should not be rebuilt again");
  assert(third.backrunGraph.length === second.backrunGraph.length, "refresh must not duplicate edges");
  console.log("[runtime-refresh] successful admission is idempotent: PASS");

  const blockscanRejectsFresh = (backrunPools: PoolEntry[]): StrategyViews => {
    const built = views(backrunPools);
    return {
      ...built,
      blockscan: built.blockscan.filter(
        (pool) => pool.address.toLowerCase() !== FRESH.address.toLowerCase(),
      ),
    };
  };
  const policyProjection = await prepareRuntimePoolRefresh({
    backend,
    freshPools: [FRESH],
    knownPoolKeys: baseKnown,
    currentBackrunPools: [BASE],
    currentBackrunGraph: BASE_GRAPH,
    currentBlockscanGraph: BASE_GRAPH,
    buildStrategyViews: blockscanRejectsFresh,
  });
  assert(policyProjection.admittedPools.length === 1, "backrun should still admit the fresh pool");
  assert(
    !policyProjection.blockscanGraph?.some(
      (item) => item.target.toLowerCase() === FRESH.address.toLowerCase(),
    ),
    "blockscan graph must honor its own view policy",
  );
  console.log("[runtime-refresh] blockscan admission remains strategy-scoped: PASS");

  const signal = new MempoolIntakeRefreshSignal();
  let reconnects = 0;
  const unsubscribe = signal.subscribe(() => reconnects++);
  signal.notify();
  unsubscribe();
  signal.notify();
  assert(reconnects === 1, "filtered mempool refresh should notify active subscription once");
  console.log("[runtime-refresh] filtered mempool reconnect signal: PASS");

  // Declared protocol venues never re-surface through swap-event discovery, so
  // a boot-time attestation failure must stay retryable via the registry-based
  // candidate feed (main.ts liveRegistry minus knownPoolKeys) until it admits.
  const PSM_POOL: PoolEntry = {
    address: ADDR.SKY_PSM_LITE,
    adapter: "psm",
    fixedTokenIn: ADDR.USDC,
    fixedTokenOut: ADDR.DAI,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "convert",
  };
  const litePsm = new ethers.Interface([
    "function gem() view returns (address)",
    "function dai() view returns (address)",
  ]);
  let psmRpcHealthy = false;
  const psmBackend: TokenQueryBackend = {
    call: async (req) => {
      if (!psmRpcHealthy) throw new Error("transient attestation rpc");
      const selector = req.data.slice(0, 10);
      if (selector === litePsm.getFunction("gem")!.selector) {
        return litePsm.encodeFunctionResult("gem", [ADDR.USDC]);
      }
      if (selector === litePsm.getFunction("dai")!.selector) {
        return litePsm.encodeFunctionResult("dai", [ADDR.DAI]);
      }
      return RESERVES;
    },
  };
  const bootViews = views([BASE, PSM_POOL]);
  // The production timer feeds selectRefreshCandidates(liveRegistry, fresh, known);
  // pin its semantics: unknown registry venues lead, known pools are filtered.
  const retryCandidates = selectRefreshCandidates([PSM_POOL], [], baseKnown);
  assert(retryCandidates.length === 1, "boot-failed protocol venue must be a retry candidate");
  const orderedCandidates = selectRefreshCandidates(
    [PSM_POOL, BASE],
    [FRESH, BASE],
    baseKnown,
  );
  assert(
    orderedCandidates.length === 2 &&
      orderedCandidates[0].address === PSM_POOL.address &&
      orderedCandidates[1].address === FRESH.address,
    "registry retry must lead and known pools must be filtered from both feeds",
  );
  const failedRetry = await prepareRuntimePoolRefresh({
    backend: psmBackend,
    freshPools: retryCandidates,
    knownPoolKeys: baseKnown,
    currentBackrunPools: bootViews.backrun,
    currentBackrunGraph: BASE_GRAPH,
    currentBlockscanGraph: BASE_GRAPH,
    buildStrategyViews: views,
  });
  assert(failedRetry.admittedPools.length === 0, "still-failing attestation must not admit");
  assert(failedRetry.failedPools.length === 1, "attestation failure must stay attributable on refresh");
  assert(
    !failedRetry.knownPoolKeys.has(PSM_POOL.address.toLowerCase()),
    "boot-failed venue must remain retryable",
  );
  psmRpcHealthy = true;
  const healedRetry = await prepareRuntimePoolRefresh({
    backend: psmBackend,
    freshPools: retryCandidates,
    knownPoolKeys: failedRetry.knownPoolKeys,
    currentBackrunPools: failedRetry.strategyViews.backrun,
    currentBackrunGraph: failedRetry.backrunGraph,
    currentBlockscanGraph: failedRetry.blockscanGraph,
    buildStrategyViews: views,
  });
  assert(healedRetry.admittedPools.length === 1, "healed attestation must admit the protocol venue");
  assert(
    healedRetry.backrunGraph.some((item) => item.adapterId === "psm"),
    "psm edge must enter the graph on retry",
  );
  assert(
    healedRetry.strategyViews.backrun.filter(
      (pool) => pool.address.toLowerCase() === PSM_POOL.address.toLowerCase(),
    ).length === 1,
    "retried venue must not duplicate in the strategy view",
  );
  console.log("[runtime-refresh] boot-failed protocol venue retries to admission: PASS");

  console.log("runtime-pool-refresh PASS (6/6)");
}

await main();
