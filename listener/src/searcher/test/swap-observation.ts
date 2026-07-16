import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import {
  CURVE_TOKEN_EXCHANGE_TOPICS,
  LANDED_MUTATION_EVENTS,
  LANDED_SWAP_EVENTS,
  LANDED_WARM_EVENT_TOPICS,
  assertLandedEventCoverage,
  isLandedSwapTopic,
} from "../venues/landed-event-registry.js";
import { scanAddressLandedSwapActivity } from "../venues/landed-event-scanner.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";

const V2_IFACE = new ethers.Interface([
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);
const BALANCER_V3_IFACE = new ethers.Interface([
  "event Swap(address indexed pool,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 swapFeePercentage,uint256 swapFeeAmount)",
]);
const V3_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);

function eventLog(
  iface: ethers.Interface,
  event: string,
  address: string,
  args: readonly unknown[],
): { address: string; topics: string[]; data: string } {
  const fragment = iface.getEvent(event);
  if (!fragment) throw new Error(`missing event ${event}`);
  const encoded = iface.encodeEventLog(fragment, args);
  return { address, topics: [...encoded.topics], data: encoded.data };
}

function edge(input: Partial<TokenEdge> & Pick<TokenEdge, "adapterId" | "target">): TokenEdge {
  return {
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    ...input,
  };
}

async function testReceiptLevelV2Correlation(): Promise<void> {
  const graph = [edge({
    adapterId: "univ2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const impacts = await detectImpactFromLogs([
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "univ2-swap");
  assert(impact !== undefined, "V2 Swap should decode from the receipt");
  assert(impact.v2PostState?.reserve0 === 101n, "V2 observer should pair the Sync reserve0");
  assert(impact.v2PostState?.reserve1 === 202n, "V2 observer should pair the Sync reserve1");
}

async function testV2FinalReceiptStateAndMalformedIsolation(): Promise<void> {
  const graph = [edge({
    adapterId: "univ2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const malformed = eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]);
  malformed.data = "0x1234";
  const impacts = await detectImpactFromLogs([
    malformed,
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
    eventLog(V2_IFACE, "Sync", POOL, [111n, 193n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ], graph);
  assert(impacts.length === 1, `identical V2 swaps should dedupe to one impact, got ${impacts.length}`);
  assert(impacts[0].v2PostState?.reserve0 === 111n, "V2 impact should carry final receipt reserve0");
  assert(impacts[0].v2PostState?.reserve1 === 193n, "V2 impact should carry final receipt reserve1");
}

async function testBalancerV3IndexedPoolIdentity(): Promise<void> {
  const graph = [edge({ adapterId: "balancer-v3-unlock", target: POOL })];
  const impacts = await detectImpactFromLogs([
    eventLog(BALANCER_V3_IFACE, "Swap", ADDR.BALANCER_V3_VAULT, [
      POOL,
      TOKEN0,
      TOKEN1,
      123n,
      120n,
      1n,
      3n,
    ]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "balancer-v3-unlock");
  assert(impact !== undefined, "Balancer V3 Vault event should match the indexed pool");
  assert(impact.pool.toLowerCase() === POOL.toLowerCase(), "Vault emitter must not replace pool identity");
  assert(impact.amountIn === 123n && impact.amountOut === 120n, "Balancer V3 amounts");
}

async function testCrossFamilyReceiptOrder(): Promise<void> {
  const v3Pool = "0x0000000000000000000000000000000000000c03";
  const graph = [
    edge({
      adapterId: "univ3-swap",
      target: v3Pool,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
  ];
  const impacts = await detectImpactFromLogs([
    eventLog(V3_IFACE, "Swap", v3Pool, [SENDER, RECIPIENT, 10n, -9n, 1n << 96n, 123n, 1]),
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ], graph);
  assert(impacts[0]?.matchedAdapterId === "univ3-swap", "first log impact must stay first");
  assert(impacts[1]?.matchedAdapterId === "univ2-swap", "later V2 impact must stay second");
}

function testRegistryConformance(): void {
  assertLandedEventCoverage(PRODUCTION_ROUTE_ADAPTERS.swaps);
  for (const adapter of PRODUCTION_ROUTE_ADAPTERS.swaps) {
    assert(adapter.observation.topics.length > 0, `${adapter.id} observation topics`);
    assert(
      adapter.observation.canonicalIntakeTargets.every((target) => ethers.isAddress(target)),
      `${adapter.id} canonical intake targets`,
    );
  }
  assert(CURVE_TOKEN_EXCHANGE_TOPICS.length === 4, "all Curve plain/underlying swap topics");
  assert(
    LANDED_SWAP_EVENTS.every((event) => isLandedSwapTopic(event.topic)),
    "debug swap classification must derive from landed events",
  );
  const warmTopics = new Set(LANDED_WARM_EVENT_TOPICS);
  assert(
    LANDED_MUTATION_EVENTS.every((event) => warmTopics.has(event.topic)),
    "warm invalidation must contain every landed mutation event",
  );
  assert(
    LANDED_SWAP_EVENTS
      .filter((event) => event.invalidatesWarmState)
      .every((event) => warmTopics.has(event.topic)),
    "warm invalidation must contain every state-changing swap event",
  );
  let missingEventError = "";
  try {
    assertLandedEventCoverage([
      ...PRODUCTION_ROUTE_ADAPTERS.swaps,
      { id: "custom-swap:synthetic", observation: { topics: [ethers.ZeroHash] } },
    ]);
  } catch (error) {
    missingEventError = error instanceof Error ? error.message : String(error);
  }
  assert(
    missingEventError.includes("missing=[custom-swap:synthetic]"),
    "synthetic swap family without landed events must fail explicitly",
  );
}

async function testSharedAddressScanner(): Promise<void> {
  const queried = new Set<string>();
  const result = await scanAddressLandedSwapActivity({
    fromBlock: 10,
    toBlock: 11,
    batchSize: 1,
    async getLogs(event, fromBlock) {
      queried.add(event.id);
      if (event.id !== "curve-underlying-uint") return [];
      return [{ address: POOL, blockNumber: fromBlock }];
    },
  });
  const activity = result.activity.get(POOL.toLowerCase());
  assert(activity?.count === 2, "shared scanner must aggregate both block batches");
  assert(activity.lastSwapBlock === 11, "shared scanner last swap block");
  assert(
    activity.adapterCounts.get("curve-underlying") === 2,
    "shared scanner must project descriptor pool adapter",
  );
  assert(
    queried.has("univ2-swap") && queried.has("balancer-v3-swap") === false,
    "shared address scanner must query address emitters only",
  );
}

await testReceiptLevelV2Correlation();
await testV2FinalReceiptStateAndMalformedIsolation();
await testBalancerV3IndexedPoolIdentity();
await testCrossFamilyReceiptOrder();
testRegistryConformance();
await testSharedAddressScanner();
console.log("swap-observation PASS (receipt V2 + Balancer V3 + log order + registry)");
