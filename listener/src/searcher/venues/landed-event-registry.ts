import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { PoolEntry } from "../planner/token-graph.js";

export type LandedEventEmitter =
  | { readonly mode: "address" }
  | {
      readonly mode: "singleton-indexed-address";
      readonly address: string;
      readonly topicIndex: number;
    }
  | {
      readonly mode: "singleton-indexed-bytes32";
      readonly address: string;
      readonly topicIndex: number;
    };

export interface LandedSwapEventDescriptor {
  readonly id: string;
  readonly topic: string;
  readonly executionFamilies: readonly string[];
  readonly emitter: LandedEventEmitter;
  readonly discovery: {
    readonly poolAdapter: PoolEntry["adapter"];
    readonly label: string;
  };
  readonly invalidatesWarmState: boolean;
}

export interface LandedMutationEventDescriptor {
  readonly id: string;
  readonly topic: string;
  readonly executionFamilies: readonly string[];
  readonly emitter: LandedEventEmitter;
}

const topic = (signature: string): string => ethers.id(signature).toLowerCase();

export const UNIV2_SWAP_TOPIC = topic(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
);
export const UNIV2_SYNC_TOPIC = topic("Sync(uint112,uint112)");
export const UNIV3_SWAP_TOPIC = topic(
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
);
export const PANCAKE_V3_SWAP_TOPIC = topic(
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
);
export const UNIV4_INITIALIZE_TOPIC = topic(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
export const UNIV4_SWAP_TOPIC = topic(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
export const UNIV4_MODIFY_LIQUIDITY_TOPIC = topic(
  "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
);
export const BALANCER_V3_SWAP_TOPIC = topic(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
export const CURVE_TOKEN_EXCHANGE_TOPICS = Object.freeze([
  topic("TokenExchange(address,int128,uint256,int128,uint256)"),
  topic("TokenExchange(address,uint256,uint256,uint256,uint256)"),
  topic("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
  topic("TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)"),
]);

const ADDRESS_EMITTER = Object.freeze({ mode: "address" } as const);
const V4_EMITTER = Object.freeze({
  mode: "singleton-indexed-bytes32" as const,
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  topicIndex: 1,
});
const BALANCER_V3_EMITTER = Object.freeze({
  mode: "singleton-indexed-address" as const,
  address: ADDR.BALANCER_V3_VAULT,
  topicIndex: 1,
});
const swapEvent = (
  descriptor: LandedSwapEventDescriptor,
): Readonly<LandedSwapEventDescriptor> => Object.freeze(descriptor);

export const LANDED_SWAP_EVENTS: readonly LandedSwapEventDescriptor[] = Object.freeze([
  swapEvent({
    id: "univ3-swap",
    topic: UNIV3_SWAP_TOPIC,
    executionFamilies: ["univ3-standard"],
    emitter: ADDRESS_EMITTER,
    discovery: { poolAdapter: "univ3", label: "univ3" },
    invalidatesWarmState: true,
  }),
  swapEvent({
    id: "pancake-v3-swap",
    topic: PANCAKE_V3_SWAP_TOPIC,
    executionFamilies: ["univ3-standard"],
    emitter: ADDRESS_EMITTER,
    discovery: { poolAdapter: "univ3", label: "pancake-v3" },
    invalidatesWarmState: true,
  }),
  swapEvent({
    id: "univ2-swap",
    topic: UNIV2_SWAP_TOPIC,
    executionFamilies: ["univ2-standard"],
    emitter: ADDRESS_EMITTER,
    discovery: { poolAdapter: "univ2", label: "univ2" },
    // Sync is the exact reserve publication and remains the V2 invalidation event.
    invalidatesWarmState: false,
  }),
  ...CURVE_TOKEN_EXCHANGE_TOPICS.map((eventTopic, index): LandedSwapEventDescriptor =>
    swapEvent({
      id: [
        "curve-exchange-i128",
        "curve-exchange-uint",
        "curve-underlying-i128",
        "curve-underlying-uint",
      ][index],
      topic: eventTopic,
      executionFamilies: ["curve-plain", "curve-underlying"],
      emitter: ADDRESS_EMITTER,
      discovery: {
        poolAdapter: index < 2 ? "curve" : "curve-underlying",
        label: ["curve-i128", "curve-uint", "curve-underlying", "curve-underlying-uint"][index],
      },
      invalidatesWarmState: true,
    })
  ),
  swapEvent({
    id: "univ4-swap",
    topic: UNIV4_SWAP_TOPIC,
    executionFamilies: ["univ4"],
    emitter: V4_EMITTER,
    discovery: { poolAdapter: "univ4", label: "univ4" },
    invalidatesWarmState: true,
  }),
  swapEvent({
    id: "balancer-v3-swap",
    topic: BALANCER_V3_SWAP_TOPIC,
    executionFamilies: ["balancer-v3"],
    emitter: BALANCER_V3_EMITTER,
    discovery: { poolAdapter: "balancer-v3", label: "balancer-v3" },
    invalidatesWarmState: true,
  }),
]);

const CURVE_N_COINS = [2, 3, 4, 5, 6, 7, 8] as const;
const CURVE_STATIC_LIQUIDITY_TOPICS = CURVE_N_COINS.flatMap((n) => [
  topic(`AddLiquidity(address,uint256[${n}],uint256[${n}],uint256,uint256)`),
  topic(`RemoveLiquidity(address,uint256[${n}],uint256[${n}],uint256)`),
  topic(`RemoveLiquidityImbalance(address,uint256[${n}],uint256[${n}],uint256,uint256)`),
]);

export const LANDED_MUTATION_EVENTS: readonly LandedMutationEventDescriptor[] = Object.freeze([
  Object.freeze({
    id: "univ2-sync",
    topic: UNIV2_SYNC_TOPIC,
    executionFamilies: ["univ2-standard"],
    emitter: ADDRESS_EMITTER,
  }),
  Object.freeze({
    id: "univ3-mint",
    topic: topic("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
    executionFamilies: ["univ3-standard"],
    emitter: ADDRESS_EMITTER,
  }),
  Object.freeze({
    id: "univ3-burn",
    topic: topic("Burn(address,int24,int24,uint128,uint256,uint256)"),
    executionFamilies: ["univ3-standard"],
    emitter: ADDRESS_EMITTER,
  }),
  Object.freeze({
    id: "univ4-modify-liquidity",
    topic: UNIV4_MODIFY_LIQUIDITY_TOPIC,
    executionFamilies: ["univ4"],
    emitter: V4_EMITTER,
  }),
  ...[
    topic("AddLiquidity(address,uint256[],uint256[],uint256,uint256)"),
    topic("RemoveLiquidity(address,uint256[],uint256[],uint256)"),
    topic("RemoveLiquidityImbalance(address,uint256[],uint256[],uint256,uint256)"),
    topic("RemoveLiquidityOne(address,uint256,uint256)"),
    topic("RemoveLiquidityOne(address,uint256,uint256,uint256)"),
    topic("RemoveLiquidityOne(address,int128,uint256,uint256,uint256)"),
    topic("RemoveLiquidityOne(address,uint256,uint256,uint256,uint256)"),
    topic("RampA(uint256,uint256,uint256,uint256)"),
    topic("StopRampA(uint256,uint256)"),
    topic("ApplyNewFee(uint256,uint256)"),
    topic("NewFee(uint256,uint256)"),
    topic("SetNewMATime(uint256,uint256)"),
    ...CURVE_STATIC_LIQUIDITY_TOPICS,
  ].map((eventTopic, index): LandedMutationEventDescriptor => Object.freeze({
    id: `curve-mutation-${index}`,
    topic: eventTopic,
    executionFamilies: ["curve-plain", "curve-underlying"],
    emitter: ADDRESS_EMITTER,
  })),
]);

export const LANDED_SWAP_EVENT_TOPICS = Object.freeze(
  [...new Set(LANDED_SWAP_EVENTS.map((event) => event.topic))],
);
export const LANDED_WARM_EVENT_TOPICS = Object.freeze([
  ...new Set([
    ...LANDED_SWAP_EVENTS
      .filter((event) => event.invalidatesWarmState)
      .map((event) => event.topic),
    ...LANDED_MUTATION_EVENTS.map((event) => event.topic),
  ]),
]);

const SWAP_EVENTS_BY_TOPIC = groupByTopic(LANDED_SWAP_EVENTS);

export function landedSwapEventsForFamily(family: string): readonly LandedSwapEventDescriptor[] {
  return LANDED_SWAP_EVENTS.filter((event) => event.executionFamilies.includes(family));
}

export function landedSwapTopicsForFamily(family: string): readonly string[] {
  return [...new Set(landedSwapEventsForFamily(family).map((event) => event.topic))];
}

export function landedSwapEventsForTopic(eventTopic: string): readonly LandedSwapEventDescriptor[] {
  return SWAP_EVENTS_BY_TOPIC.get(eventTopic.toLowerCase()) ?? [];
}

export function isLandedSwapTopic(eventTopic: string | null | undefined): boolean {
  return typeof eventTopic === "string" && SWAP_EVENTS_BY_TOPIC.has(eventTopic.toLowerCase());
}

export function observedLandedPoolIdentity(
  event: Pick<LandedSwapEventDescriptor | LandedMutationEventDescriptor, "topic" | "emitter">,
  log: { address: string; topics: readonly string[] },
): string | null {
  if (log.topics[0]?.toLowerCase() !== event.topic) return null;
  if (event.emitter.mode === "address") {
    try {
      return ethers.getAddress(log.address).toLowerCase();
    } catch {
      return null;
    }
  }
  if (log.address.toLowerCase() !== event.emitter.address.toLowerCase()) return null;
  const indexed = log.topics[event.emitter.topicIndex];
  if (!indexed) return null;
  if (event.emitter.mode === "singleton-indexed-bytes32") return indexed.toLowerCase();
  try {
    return ethers.getAddress(`0x${indexed.slice(-40)}`).toLowerCase();
  } catch {
    return null;
  }
}

export function assertLandedEventCoverage(
  swapAdapters: readonly {
    readonly id: string;
    readonly observation: { readonly topics: readonly string[] };
  }[],
): void {
  const adapterFamilies = new Set(swapAdapters.map((adapter) => String(adapter.id)));
  const eventFamilies = new Set(LANDED_SWAP_EVENTS.flatMap((event) => event.executionFamilies));
  const missingFamilies = [...adapterFamilies].filter((family) => !eventFamilies.has(family));
  const extraFamilies = [...eventFamilies].filter((family) => !adapterFamilies.has(family));
  const topicMismatches: string[] = [];
  for (const adapter of swapAdapters) {
    const expected = new Set(landedSwapTopicsForFamily(adapter.id));
    const actual = new Set(adapter.observation.topics.map((eventTopic) => eventTopic.toLowerCase()));
    if (
      expected.size !== actual.size ||
      [...expected].some((eventTopic) => !actual.has(eventTopic))
    ) {
      topicMismatches.push(String(adapter.id));
    }
  }
  if (missingFamilies.length > 0 || extraFamilies.length > 0 || topicMismatches.length > 0) {
    throw new Error(
      "landed-event registry: route coverage mismatch " +
        `missing=[${missingFamilies.sort().join(",")}] ` +
        `extra=[${extraFamilies.sort().join(",")}] ` +
        `topics=[${topicMismatches.sort().join(",")}]`,
    );
  }
}

function groupByTopic<T extends { topic: string }>(
  events: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const event of events) {
    const items = grouped.get(event.topic) ?? [];
    items.push(event);
    grouped.set(event.topic, items);
  }
  return grouped;
}
