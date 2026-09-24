import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  createVictimSourceGeneration,
  detectImpactTransitionFromLogs,
  type PoolImpactTransition,
} from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS } from
  "../strict-production-family-declarations.js";
import {
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import {
  FLUID_DEX_SWAP_TOPIC,
} from "../venues/swaps/fluid-dex-family/codec.js";
import {
  UNIV2_PAIR_INTERFACE,
} from "../venues/swaps/univ2-abi.js";
import {
  UNIV3_POOL_INTERFACE,
} from "../venues/swaps/univ3-abi.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
} from "../venues/swaps/univ4-abi.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";
import {
  type UniV3PoolContext,
  UNIV2_FIXTURE_FACTORY,
  UNIV3_FIXTURE_FACTORY, UNIV3_FIXTURE_FEE, UNIV3_FIXTURE_TICK_SPACING,
  UNIV3_FIXTURE_LIQUIDITY, UNIV3_FIXTURE_SQRT_PRICE_X96,
} from "../architecture-migration-fixture-replay.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { SwapObservationBindingResolver } from "../venues/swap-observation.js";
import {
  createUniv2ReadyReceiptFixture, createUniv3ReadyReceiptFixture, readyReceiptContext,
} from "./ready-receipt-fixture.js";

const TOKEN0 = "0x1000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const POOL0 = "0x3000000000000000000000000000000000000003";
const POOL1 = "0x4000000000000000000000000000000000000004";
const UNKNOWN_POOL = "0x5000000000000000000000000000000000000005";
const SENDER = "0x6000000000000000000000000000000000000006";
const RECIPIENT = "0x7000000000000000000000000000000000000007";
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_800_000,
  hash: `0x${"61".repeat(32)}`,
  generation: 1,
});

let metadataCalls = 0;
const noMetadataRpc = {
  async call(): Promise<string> {
    metadataCalls++;
    throw new Error("receipt token metadata must come from Ready");
  },
};

type ReceiptLog = {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
};

function eventLog(
  iface: ethers.Interface,
  eventName: string,
  address: string,
  args: readonly unknown[],
): ReceiptLog {
  const fragment = iface.getEvent(eventName);
  assert(fragment, `missing event ${eventName}`);
  const encoded = iface.encodeEventLog(fragment, args);
  return Object.freeze({
    address,
    topics: [...encoded.topics],
    data: encoded.data,
  });
}

function edge(input: {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly poolId?: string;
  readonly v4PoolKey?: NonNullable<TokenEdge["v4PoolKey"]>;
}): TokenEdge {
  return {
    ...input,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    poolToken0: input.v4PoolKey === undefined
      ? TOKEN0
      : input.v4PoolKey.currency0,
    poolToken1: input.v4PoolKey === undefined
      ? TOKEN1
      : input.v4PoolKey.currency1,
  } as TokenEdge;
}

async function transition(
  logs: ReceiptLog[], graph: TokenEdge[], resolveBinding?: SwapObservationBindingResolver,
) {
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: SOURCE.number,
    sourceBlockHash: SOURCE.hash,
    receiptId: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(logs))),
    logs,
    logsCompleteness: "complete-receipt",
  });
  return await detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
    null,
    noMetadataRpc,
    resolveBinding,
  );
}

async function testV2ExactTriggerPartition(): Promise<void> {
  const { graph, root } = await createUniv2ReadyReceiptFixture(SOURCE, {
    pool: POOL0, factory: UNIV2_FIXTURE_FACTORY, token0: TOKEN0, token1: TOKEN1,
    reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 },
  });
  const result = await transition([
    eventLog(UNIV2_PAIR_INTERFACE, "Sync", POOL0, [101n, 202n]),
    eventLog(UNIV2_PAIR_INTERFACE, "Swap", POOL0, [
      SENDER,
      10n,
      0n,
      0n,
      9n,
      RECIPIENT,
    ]),
  ], graph, root.resolveSwapObservationBinding);
  assert.equal(result.complete, true);
  assert.equal(result.steps.length, 1, "Sync is post-state evidence, not a second trigger");
  assert.equal(result.steps[0]?.familyId, "univ2-standard");
  assert.equal(result.impacts[0]?.v2PostState?.reserve0, 101n);
  assert.equal(result.impacts[0]?.v2PostState?.reserve1, 202n);
  assert.equal(result.impacts[0]?.v2PostState?.feeBps, 30n);
  assert.equal(metadataCalls, 0);
}

async function testV3LandedPostState(): Promise<void> {
  const pool = ethers.getAddress(`0x${"a3".repeat(20)}`);
  const token0 = ethers.getAddress(`0x${"a1".repeat(20)}`);
  const token1 = ethers.getAddress(`0x${"b2".repeat(20)}`);
  for (const address of [pool, token0, token1]) {
    assert.notEqual(address, address.toLowerCase(), "fixture must exercise checksum letters");
    assert.notEqual(address.slice(2), address.slice(2).toUpperCase());
  }
  const ctx: UniV3PoolContext = {
    pool, factory: UNIV3_FIXTURE_FACTORY, token0, token1,
    fee: UNIV3_FIXTURE_FEE, tickSpacing: UNIV3_FIXTURE_TICK_SPACING,
    liquidity: UNIV3_FIXTURE_LIQUIDITY, sqrtPriceX96: UNIV3_FIXTURE_SQRT_PRICE_X96,
  };
  const { publication, graph, root } = await createUniv3ReadyReceiptFixture(SOURCE, ctx);
  // Same issued instance, independently projected Graph: another root cannot
  // lend its object-bound receipt authority to this root's edges.
  const foreign = readyReceiptContext(publication, SOURCE);
  const v2 = await createUniv2ReadyReceiptFixture(SOURCE, {
    pool: POOL1, factory: UNIV2_FIXTURE_FACTORY, token0: TOKEN0, token1: TOKEN1,
    reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 },
  });
  const foreignFamilyBinding = v2.root.resolveSwapObservationBinding(v2.graph[0]);
  assert(foreignFamilyBinding);

  for (const reverse of [false, true]) {
    const postState = {
      sqrtPriceX96: (1n << 96n) + (reverse ? -7n : 7n),
      liquidity: reverse ? 456n : 123n,
      tick: reverse ? -4 : 4,
    };
    const logs = [eventLog(UNIV3_POOL_INTERFACE, "Swap", pool, [
      SENDER, RECIPIENT, reverse ? -10n : 11n, reverse ? 11n : -10n,
      postState.sqrtPriceX96, postState.liquidity, postState.tick,
    ])];
    const result = await transition(logs, graph, root.resolveSwapObservationBinding);
    assert.equal(result.complete, true);
    assert.equal(result.steps.length, 1);
    assert.equal(result.impacts.length, 1);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.steps[0]?.familyId, "univ3-standard");
    assert.equal(result.impacts[0]?.pool.toLowerCase(), pool.toLowerCase());
    assert.equal(result.impacts[0]?.tokenIn.toLowerCase(), (reverse ? token1 : token0).toLowerCase());
    assert.equal(result.impacts[0]?.tokenOut.toLowerCase(), (reverse ? token0 : token1).toLowerCase());
    assert.equal(result.impacts[0]?.amountIn, 11n);
    assert.deepEqual(result.impacts[0]?.v3PostState, postState);

    const rejected: readonly (readonly [string, PoolImpactTransition])[] = [
      ["missing binding", await transition(logs, graph)],
      ["foreign root", await transition(logs, graph, foreign.root.resolveSwapObservationBinding)],
      ["copied edges", await transition(logs, graph.map((item) => ({ ...item })), root.resolveSwapObservationBinding)],
      ["foreign Family descriptor", await transition(logs, graph, () => foreignFamilyBinding)],
      ["legacy metadata without authority", await transition(logs, graph.map((item) => ({
        ...item, poolToken0: token0, poolToken1: token1,
      })))],
    ];
    for (const [label, failure] of rejected) {
      assert.equal(failure.complete, false, label);
      assert.equal(failure.hashOnlyReplayable, false, label);
      assert.equal(failure.steps.length, 0, label);
      assert.equal(failure.impacts.length, 0, label);
      assert(failure.unresolved.some((item) => item.reason === "observer-decode-failed"), label);
    }
    assert.equal(metadataCalls, 0, "positive and rejected V3 receipts must perform no metadata RPC");
  }
  console.log("ok V3 Ready receipt bindings: checksum addresses, both directions; missing/foreign/legacy authority rejected; zero metadata calls");
}

function v4Key(input: {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly hooks?: string;
}): NonNullable<TokenEdge["v4PoolKey"]> {
  return Object.freeze({
    currency0: input.currency0,
    currency1: input.currency1,
    fee: input.fee,
    tickSpacing: 1,
    hooks: input.hooks ?? ethers.ZeroAddress,
  });
}

function v4Log(
  key: NonNullable<TokenEdge["v4PoolKey"]>,
  amount0: bigint,
  amount1: bigint,
): ReceiptLog {
  return eventLog(
    UNIV4_POOL_MANAGER_INTERFACE,
    "Swap",
    ADDR.UNISWAP_V4_POOL_MANAGER,
    [
      v4PoolId(key),
      SENDER,
      amount0,
      amount1,
      1n << 96n,
      456n,
      2,
      key.fee,
    ],
  );
}

async function testV4PoolIdentityAndWethAlias(): Promise<void> {
  const key0 = v4Key({
    currency0: ethers.ZeroAddress,
    currency1: TOKEN1,
    fee: 500,
  });
  const key1 = v4Key({
    currency0: ethers.ZeroAddress,
    currency1: TOKEN1,
    fee: 3_000,
  });
  const graph = [key0, key1].map((key) => edge({
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: ADDR.WETH,
    tokenOut: TOKEN1,
    poolId: v4PoolId(key),
    v4PoolKey: key,
  }));
  const result = await transition([
    v4Log(key0, -9n, 10n),
    v4Log(key1, -11n, 12n),
  ], graph);
  assert.equal(result.complete, true);
  assert.equal(result.steps.length, 2, "different V4 poolIds must not collapse");
  assert.deepEqual(
    new Set(result.steps.map((step) => step.impact.poolId)),
    new Set([v4PoolId(key0), v4PoolId(key1)]),
  );
  assert(result.impacts.every((impact) =>
    impact.tokenIn.toLowerCase() === ADDR.WETH.toLowerCase() &&
    impact.tokenOut.toLowerCase() === TOKEN1.toLowerCase()
  ));
}

async function testAngstromDoesNotInventAmountOut(): Promise<void> {
  const key = v4Key({
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 0x80_0000,
    hooks: ANGSTROM_MAINNET_HOOK,
  });
  const graph = [edge({
    adapterId: "angstrom-v4-swap",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    poolId: v4PoolId(key),
    v4PoolKey: key,
  })];
  const result = await transition([v4Log(key, -13n, 14n)], graph);
  assert.equal(result.complete, true);
  assert.equal(result.steps[0]?.familyId, "custom-swap:angstrom-v4");
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0]?.amountOut, undefined);
}

async function testFluidAndForeignEdgesFailClosed(): Promise<void> {
  const fluidGraph = [edge({
    adapterId: "fluid-dex-swap",
    target: POOL0,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
  })];
  const fluid = await transition([{
    address: POOL0,
    topics: [FLUID_DEX_SWAP_TOPIC],
    data: "0x",
  }], fluidGraph);
  assert.equal(fluid.complete, false);
  assert.equal(fluid.impacts.length, 0);
  assert(fluid.unresolved.some((item) =>
    item.familyIds.includes("fluid-dex") &&
    item.reason === "observer-decode-failed"
  ));

  const foreign = await transition([
    eventLog(UNIV2_PAIR_INTERFACE, "Swap", UNKNOWN_POOL, [
      SENDER,
      10n,
      0n,
      0n,
      9n,
      RECIPIENT,
    ]),
  ], [edge({
    adapterId: "foreign-swap",
    target: UNKNOWN_POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
  })]);
  assert.equal(foreign.complete, true);
  assert.equal(foreign.impacts.length, 0, "foreign edges cannot gain strict admission by topic");
}

for (const familyId of [
  "univ2-standard", "univ3-standard", "univ4",
  "custom-swap:angstrom-v4", "fluid-dex",
]) {
  assert(PRODUCTION_STRICT_FAMILY_DECLARATIONS.swapObservationGroups.some(
    (group) => group.familyIds.includes(familyId),
  ), `missing production receipt observer ${familyId}`);
}
await testV2ExactTriggerPartition();
await testV3LandedPostState();
await testV4PoolIdentityAndWethAlias();
await testAngstromDoesNotInventAmountOut();
await testFluidAndForeignEdgesFailClosed();

const poolImpactSource = readFileSync(
  new URL("../detector/pool-impact.ts", import.meta.url),
  "utf8",
);
assert.equal(
  poolImpactSource.includes("PRODUCTION_ADAPTER_FAMILIES"),
  false,
  "receipt detector must not restore central legacy Family authority",
);

console.log("strict receipt authority PASS");
