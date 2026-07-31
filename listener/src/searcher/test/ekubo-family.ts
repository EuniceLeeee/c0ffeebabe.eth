import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ekuboRouterSwapAdapter } from "../../adapters/ekubo.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  createVictimSourceGeneration,
  detectImpactTransitionFromLogs,
} from "../detector/pool-impact.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import { STRICT_IDENTITY_ADMISSION } from "../venues/admission.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolMaterializationContext,
} from "../venues/landed-pool-discovery.js";
import type { ExactQuoteContext } from "../venues/route-leg-adapter.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_FAMILY_LOAD_ISSUES,
  PRODUCTION_FAMILY_MODULES,
} from "../venues/production-registry.js";
import {
  EKUBO_CORE,
  EKUBO_CORE_DEPLOY_BLOCK,
  EKUBO_POOL_INITIALIZED_TOPIC,
  EKUBO_ROUTER,
  EKUBO_ROUTER_PARTIAL_SWAP_SELECTOR,
  EKUBO_ROUTER_SWAP_SELECTOR,
  ekuboRouterIface,
  parseEkuboCoreSwapLog,
} from "../venues/swaps/ekubo/abi.js";
import {
  ekuboPoolDiscovery,
  parseEkuboPoolInitializedLog,
} from "../venues/swaps/ekubo/discovery.js";
import { ekuboAdapter } from "../venues/swaps/ekubo/family.js";
import {
  EKUBO_FAMILY_ID,
} from "../venues/swaps/ekubo/ids.js";
import {
  ekuboPoolId,
  ekuboPoolVariant,
} from "../venues/swaps/ekubo/pool-key.js";

const TARGET_BLOCK = 25_633_846;
const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";

const ORACLE_INITIALIZE: LandedPoolDiscoveryLog = {
  address: EKUBO_CORE,
  topics: [EKUBO_POOL_INITIALIZED_TOPIC],
  data:
    "0x1aa6363e13e84c54044bdde567c19b43514ff269e1c8fb795f0ed90cfc9d1372000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004c46e830bb56ce22735d5d8fc9cb90309317d0f517e506700271aea091b02f42756f5e174af523000000000000000000000000000000000000000000000000000000000000000000000000000000000006cb8b6000000000000000000000000000000000000000080000008d045210ce14b0100",
  blockNumber: "0x1713d75",
};

const CORE_SWAP_DATA =
  "0xd26f20001a72a18c002b00e6710000d68700ce00" +
  "1aa6363e13e84c54044bdde567c19b43514ff269e1c8fb795f0ed90cfc9d1372" +
  "00000000000000000005cce36a9d168bffffffffffffffffa6873a1e37cf4bab" +
  "8000000fb4ed5ce143e2de2d007e5ac5000000000000000d71466b67db2b52dc";

async function main(): Promise<void> {
  assert.deepEqual(
    PRODUCTION_FAMILY_LOAD_ISSUES,
    [],
    "Ekubo production entry must load without an isolated failure",
  );
  assert.equal(
    PRODUCTION_ADAPTER_FAMILIES.forFamily(EKUBO_FAMILY_ID),
    ekuboAdapter,
    "Ekubo must be active through the production registry",
  );
  assert(
    PRODUCTION_FAMILY_MODULES.some((module) =>
      module.sourceFile === "ekubo.production.ts" &&
      module.family.id === EKUBO_FAMILY_ID
    ),
    "Ekubo must be discovered from its family-owned production entry",
  );

  const registry = new AdapterFamilyRegistry([ekuboAdapter]);
  const event = registry.landedEvents().eventsForFamily(EKUBO_FAMILY_ID)[0];
  assert(event, "Ekubo landed event registration");
  assert(
    !registry.pendingTransactionEvidence().familyIds.includes(EKUBO_FAMILY_ID),
    "receipt/blockscan-only Ekubo must not claim pending intake",
  );

  const known = parseEkuboPoolInitializedLog(ORACLE_INITIALIZE);
  assert.equal(ekuboPoolVariant(known.poolKey.config), "oracle");
  assert.equal(ekuboPoolId(known.poolKey), known.poolId);

  const unknownKey = {
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x4444444444444444444444444444444444444444",
    config:
      "0x2222222222222222222222222222222222222222" +
      "000000000000000000000000",
  };
  const unknownPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "bytes32"],
    [unknownKey.token0, unknownKey.token1, unknownKey.config],
  );
  const unknownPoolId = ethers.keccak256(unknownPayload);
  const unknownInitialize: LandedPoolDiscoveryLog = {
    address: EKUBO_CORE,
    topics: [EKUBO_POOL_INITIALIZED_TOPIC],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "tuple(address token0,address token1,bytes32 config)",
        "int32",
        "uint96",
      ],
      [unknownPoolId, unknownKey, 0, 1n << 95n],
    ),
    blockNumber: TARGET_BLOCK - 10,
  };
  assert.equal(
    ekuboPoolVariant(unknownKey.config),
    "extension",
    "unknown extensions are labels, not an admission allowlist",
  );

  const knownSwap = swapLog(known.poolId, CORE_SWAP_DATA);
  const unknownSwap = swapLog(
    unknownPoolId,
    `0x${EKUBO_ROUTER.slice(2).toLowerCase()}` +
      unknownPoolId.slice(2) +
      packBalanceUpdate(2n, -1n).slice(2) +
      ethers.ZeroHash.slice(2),
  );
  const scanFilters: Array<{ fromBlock: number; toBlock: number }> = [];
  const materialized = await ekuboPoolDiscovery.materialize({
    familyId: EKUBO_FAMILY_ID,
    event,
    logs: [knownSwap, unknownSwap],
    retainedPools: [],
    retryablePools: [],
    isKnownPool: () => false,
    fromBlock: TARGET_BLOCK,
    toBlock: TARGET_BLOCK,
    minSwaps: 1,
    admissionPolicy: STRICT_IDENTITY_ADMISSION,
    historicalResolution: "bounded",
    backend: {
      getLogs: async () => [],
      call: async () => {
        throw new Error("unexpected materializer call");
      },
    },
    scanLogs: async (filter) => {
      scanFilters.push({
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock,
      });
      return {
        logs: filter.fromBlock === EKUBO_CORE_DEPLOY_BLOCK
          ? [ORACLE_INITIALIZE, unknownInitialize]
          : [],
        complete: true,
        issues: [],
      };
    },
  } satisfies LandedPoolMaterializationContext);
  assert.equal(materialized.complete, true);
  assert.equal(materialized.pools.length, 2);
  assert(
    scanFilters.some((filter) => filter.fromBlock === EKUBO_CORE_DEPLOY_BLOCK),
    "unresolved PoolKeys must not use an arbitrary historical lookback",
  );
  const largeHistoricalIssues = Array(150_000).fill("historical scan issue");
  const largeIssueMaterialization = await ekuboPoolDiscovery.materialize({
    familyId: EKUBO_FAMILY_ID,
    event,
    logs: [knownSwap],
    retainedPools: [],
    retryablePools: [],
    isKnownPool: () => false,
    fromBlock: TARGET_BLOCK,
    toBlock: TARGET_BLOCK,
    minSwaps: 1,
    admissionPolicy: STRICT_IDENTITY_ADMISSION,
    historicalResolution: "bounded",
    backend: {
      getLogs: async () => [],
      call: async () => {
        throw new Error("unexpected materializer call");
      },
    },
    scanLogs: async (filter) => ({
      logs: filter.fromBlock === EKUBO_CORE_DEPLOY_BLOCK
        ? [ORACLE_INITIALIZE]
        : [],
      complete: true,
      issues: filter.fromBlock === EKUBO_CORE_DEPLOY_BLOCK
        ? largeHistoricalIssues
        : [],
    }),
  } satisfies LandedPoolMaterializationContext);
  assert.equal(
    largeIssueMaterialization.issues?.length,
    largeHistoricalIssues.length,
    "large historical issue sets must materialize without argument-list overflow",
  );
  const knownPool = requirePool(materialized.pools, known.poolId);
  const unknownPool = requirePool(materialized.pools, unknownPoolId);

  const knownEdges = await ekuboAdapter.buildEdges(knownPool);
  const unknownEdges = await ekuboAdapter.buildEdges(unknownPool);
  assert.equal(knownEdges.length, 2);
  assert.equal(unknownEdges.length, 2);
  const parsedSwap = parseEkuboCoreSwapLog(CORE_SWAP_DATA);
  const knownForward = knownEdges[0];
  assert.equal(
    await quoteWithUpdate(knownForward, parsedSwap),
    -parsedSwap.delta1,
  );
  const erc20InputPlan = await ekuboAdapter.buildPlanFragment({
    edge: unknownEdges[0],
    amountIn: 2n,
    amountOut: 1n,
    rawOut: 1n,
    executor: EXECUTOR,
    state: noReadState(),
  });
  assert.equal(erc20InputPlan.requirements.length, 1);
  const approval = erc20InputPlan.requirements[0];
  assert.equal(approval.kind, "approve");
  if (approval.kind !== "approve") throw new Error("missing Ekubo approval");
  assert.equal(
    approval.spender.toLowerCase(),
    EKUBO_ROUTER.toLowerCase(),
    "the Router executes transferFrom and must own the allowance",
  );
  const reverseKnown = swapLog(
    known.poolId,
    `0x${EKUBO_ROUTER.slice(2).toLowerCase()}` +
      known.poolId.slice(2) +
      packBalanceUpdate(-2n, 1n).slice(2) +
      ethers.ZeroHash.slice(2),
  );
  const partialGraphLogs = [knownSwap, reverseKnown].map((log) => ({
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: TARGET_BLOCK,
  }));
  const partialGraphGeneration = createVictimSourceGeneration({
    sourceBlock: TARGET_BLOCK - 1,
    sourceBlockHash: `0x${"11".repeat(32)}`,
    receiptId: "ekubo-partial-graph-fixture",
    receiptBlockNumber: TARGET_BLOCK,
    receiptBlockHash: `0x${"22".repeat(32)}`,
    receiptParentBlockHash: `0x${"11".repeat(32)}`,
    receiptTransactionHash:
      "0x73078d54fe1bac89e934d71a574e290ddb98e9d9a2e44c6ec7ae2a05cc88c823",
    logs: partialGraphLogs,
    logsCompleteness: "complete-receipt",
  });
  const partialGraphTransition = await detectImpactTransitionFromLogs(
    partialGraphLogs,
    [knownForward],
    partialGraphGeneration,
  );
  assert.equal(
    partialGraphTransition.complete,
    true,
    JSON.stringify(partialGraphTransition.unresolved),
  );
  assert.equal(partialGraphTransition.steps.length, 1);
  assert.equal(partialGraphTransition.mutations.length, 1);
  assert.match(
    partialGraphTransition.mutations[0].reason,
    /direction is absent from the admitted graph/,
  );

  const receiptLogs = [{
    address: knownSwap.address,
    topics: [...knownSwap.topics],
    data: knownSwap.data,
    blockNumber: TARGET_BLOCK,
  }];
  const generation = createVictimSourceGeneration({
    sourceBlock: TARGET_BLOCK - 1,
    sourceBlockHash: `0x${"11".repeat(32)}`,
    receiptId: "ekubo-family-fixture",
    receiptBlockNumber: TARGET_BLOCK,
    receiptBlockHash: `0x${"22".repeat(32)}`,
    receiptParentBlockHash: `0x${"11".repeat(32)}`,
    receiptTransactionHash:
      "0x73078d54fe1bac89e934d71a574e290ddb98e9d9a2e44c6ec7ae2a05cc88c823",
    logs: receiptLogs,
    logsCompleteness: "complete-receipt",
  });
  const transition = await detectImpactTransitionFromLogs(
    receiptLogs,
    [...knownEdges, ...unknownEdges],
    generation,
  );
  assert.equal(transition.complete, true);
  assert.equal(transition.steps.length, 1);
  assert.equal(transition.steps[0].impact.poolId, known.poolId);

  const plan = await ekuboAdapter.buildPlanFragment({
    edge: knownForward,
    amountIn: parsedSwap.delta0,
    amountOut: -parsedSwap.delta1,
    rawOut: -parsedSwap.delta1,
    executor: EXECUTOR,
    state: noReadState(),
  });
  assert.deepEqual(
    plan.nodes.map((node) => node.adapterId),
    ["weth-withdraw-amount", "ekubo-router-swap"],
  );
  const encoded = ekuboRouterSwapAdapter.encode(
    plan.nodes[1],
    EXECUTOR,
  );
  assert(encoded.length > 0);
  assert.equal(
    ekuboRouterSwapAdapter.matchTrace(
      EKUBO_ROUTER,
      EKUBO_ROUTER_SWAP_SELECTOR,
    ),
    true,
  );
  assert.equal(
    ekuboRouterSwapAdapter.matchTrace(
      EKUBO_ROUTER,
      EKUBO_ROUTER_PARTIAL_SWAP_SELECTOR,
    ),
    false,
    "the ActionAdapter must not claim partial-fill execution support",
  );
  console.log(
    "ekubo-family PASS (identity/discovery/state/observation/plan/strict-action)",
  );
}

function swapLog(
  poolId: string,
  data: string,
): LandedPoolDiscoveryLog {
  const parsed = parseEkuboCoreSwapLog(data);
  assert.equal(parsed.poolId, poolId.toLowerCase());
  return {
    address: EKUBO_CORE,
    topics: [],
    data,
    blockNumber: TARGET_BLOCK,
  };
}

function requirePool(
  pools: readonly PoolEntry[],
  poolId: string,
): PoolEntry {
  const pool = pools.find((candidate) =>
    candidate.poolId?.toLowerCase() === poolId.toLowerCase()
  );
  assert(pool, `missing materialized Ekubo pool ${poolId}`);
  return pool;
}

async function quoteWithUpdate(
  edge: TokenEdge,
  update: ReturnType<typeof parseEkuboCoreSwapLog>,
): Promise<bigint> {
  const response = ekuboRouterIface.encodeFunctionResult("quote", [
    packBalanceUpdate(update.delta0, update.delta1),
    update.stateAfter,
  ]);
  const state = {
    call: async (request: { readonly to: string; readonly data: string }) => {
      assert.equal(request.to.toLowerCase(), EKUBO_ROUTER.toLowerCase());
      assert.equal(request.data.slice(0, 10), "0x3bc52842");
      return response;
    },
  } as StateBackend;
  return ekuboAdapter.quoteExact({
    state,
    target: edge.target,
    edgeAdapterId: edge.adapterId,
    amountIn: update.delta0,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    edge,
  } satisfies ExactQuoteContext);
}

function packBalanceUpdate(delta0: bigint, delta1: bigint): string {
  const mask = (1n << 128n) - 1n;
  const packed = ((delta0 & mask) << 128n) | (delta1 & mask);
  return ethers.toBeHex(packed, 32);
}

function noReadState(): StateBackend {
  return {
    call: async () => {
      throw new Error("Ekubo plan build performed unexpected I/O");
    },
  } as unknown as StateBackend;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
