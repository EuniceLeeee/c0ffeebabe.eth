import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from "../venues/production-family-composition.js";
import { UNIV2_PAIR_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import { createVictimSourceGeneration, detectImpactTransitionFromLogs } from "../detector/pool-impact.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { BackrunDetector } from "../detector/detector.js";
const EXECUTOR = `0x${"64".repeat(20)}`, ORIGIN = `0x${"65".repeat(20)}`;
const STARTUP: CanonicalSource = Object.freeze({
  number: 25_800_000,
  hash: `0x${"61".repeat(32)}`,
  generation: 1,
});
const pool = Object.freeze({
  pool: ethers.getAddress(`0x${"ab".repeat(20)}`),
  factory: UNIV2_FIXTURE_FACTORY,
  token0: ethers.getAddress(`0x${"ac".repeat(20)}`),
  token1: ethers.getAddress(`0x${"bd".repeat(20)}`),
  reserves: Object.freeze({
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    blockTimestampLast: 1,
  }),
});

const publication = await runUniv2Lifecycle(STARTUP, pool);
const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
  publication.familyId,
);
const startupView = buildFamilyRouteGraphView({
  routes: publication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const root = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets: [],
});

// Real lifecycle-issued Graph has no legacy poolToken fields. Receipt decoding
// must consume the same Ready authority as pricing, not request token metadata.
for (const reverse of [false, true]) {
  const encode = (name: string, args: readonly unknown[]) => ({
    address: pool.pool,
    ...UNIV2_PAIR_INTERFACE.encodeEventLog(UNIV2_PAIR_INTERFACE.getEvent(name)!, args),
  });
  const logs = [
    encode("Sync", [pool.reserves.reserve0, pool.reserves.reserve1]),
    encode("Swap", [ORIGIN, reverse ? 0n : 10n, reverse ? 10n : 0n,
      reverse ? 9n : 0n, reverse ? 0n : 9n, EXECUTOR]),
  ];
  const generation = createVictimSourceGeneration({
    sourceBlock: STARTUP.number, sourceBlockHash: STARTUP.hash,
    receiptId: `ready-binding-${reverse}`, logs, logsCompleteness: "complete-receipt",
  });
  const graph = [...startupView.edges];
  assert(graph.every(edge => edge.poolToken0 === undefined && edge.poolToken1 === undefined));
  const noMetadataRpc = { call: async () => { throw Error("receipt metadata must come from Ready"); } };
  const decoded = await detectImpactTransitionFromLogs(logs, graph, generation, null,
    noMetadataRpc, root.resolveSwapObservationBinding);
  assert.equal(decoded.impacts.length, 1);
  assert.equal(decoded.impacts[0].tokenIn, reverse ? pool.token1 : pool.token0);
  assert.equal(decoded.impacts[0].tokenOut, reverse ? pool.token0 : pool.token1);
  assert.equal(decoded.impacts[0].amountIn, 10n);
  assert.equal(decoded.impacts[0].v2PostState?.feeBps, 30n);
  const missing = await detectImpactTransitionFromLogs(logs, graph, generation, null, noMetadataRpc);
  assert.equal(missing.impacts.length, 0);
  assert(missing.unresolved.some(item => item.reason === "observer-decode-failed"));
  const foreign = await detectImpactTransitionFromLogs(logs, graph.map(edge => ({ ...edge })),
    generation, null, noMetadataRpc, root.resolveSwapObservationBinding);
  assert.equal(foreign.impacts.length, 0, "copied graph cannot borrow another Ready's authority");
  const fragmentGeneration = createVictimSourceGeneration({
    sourceBlock: STARTUP.number, sourceBlockHash: STARTUP.hash,
    receiptId: "fragment", logs, logsCompleteness: "fragment",
  });
  const fragment = await detectImpactTransitionFromLogs(logs, graph, fragmentGeneration,
    null, noMetadataRpc, root.resolveSwapObservationBinding);
  assert.equal(fragment.impacts.length, 1);
  assert.equal(fragment.complete, false);
  assert.equal(fragment.hashOnlyReplayable, false, "Ready binding cannot promote fragment provenance");
  const detector = new BackrunDetector([]);
  detector.setGraph(graph);
  detector.setTokenQuery(noMetadataRpc);
  detector.setSwapObservationBindingResolver(root.resolveSwapObservationBinding);
  const txHash = ethers.id(`trigger-${reverse}`), receiptHash = ethers.id("receipt");
  const opportunities = await detector.detect({
    txHash, blockNumber: STARTUP.number + 1, from: ORIGIN, nonce: 0, to: null,
    input: "0x", rawTx: "0x", minProfit: 1n, victimState: "materialized",
    logs: logs.map(log => ({ ...log, blockNumber: STARTUP.number + 1,
      blockHash: receiptHash, transactionHash: txHash })),
    sourceBlockHash: STARTUP.hash, receiptBlockNumber: STARTUP.number + 1,
    receiptBlockHash: receiptHash, receiptParentBlockHash: STARTUP.hash,
    receiptTransactionHash: txHash, logsCompleteness: "complete-receipt",
  }, {} as never);
  assert.equal(opportunities.length, 1, "live detector forwards Ready binding");
}
console.log("ok strict Ready receipt binding: both V2 directions, missing/foreign authority rejected");
