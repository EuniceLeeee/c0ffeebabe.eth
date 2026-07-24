import {
  ADDRESS_LANDED_EVENT_EMITTER,
  CURVE_TOKEN_EXCHANGE_TOPICS,
  defineSwapLandedEvents,
  landedEventTopic,
  type LandedMutationEventDeclaration,
} from "../landed-event-registry.js";

const CURVE_N_COINS = [2, 3, 4, 5, 6, 7, 8] as const;
const CURVE_STATIC_LIQUIDITY_TOPICS = CURVE_N_COINS.flatMap((n) => [
  landedEventTopic(`AddLiquidity(address,uint256[${n}],uint256[${n}],uint256,uint256)`),
  landedEventTopic(`RemoveLiquidity(address,uint256[${n}],uint256[${n}],uint256)`),
  landedEventTopic(
    `RemoveLiquidityImbalance(address,uint256[${n}],uint256[${n}],uint256,uint256)`,
  ),
]);

const curveMutationEvents: readonly LandedMutationEventDeclaration[] = [
  landedEventTopic("AddLiquidity(address,uint256[],uint256[],uint256,uint256)"),
  landedEventTopic("RemoveLiquidity(address,uint256[],uint256[],uint256)"),
  landedEventTopic("RemoveLiquidityImbalance(address,uint256[],uint256[],uint256,uint256)"),
  landedEventTopic("RemoveLiquidityOne(address,uint256,uint256)"),
  landedEventTopic("RemoveLiquidityOne(address,uint256,uint256,uint256)"),
  landedEventTopic("RemoveLiquidityOne(address,int128,uint256,uint256,uint256)"),
  landedEventTopic("RemoveLiquidityOne(address,uint256,uint256,uint256,uint256)"),
  landedEventTopic("RampA(uint256,uint256,uint256,uint256)"),
  landedEventTopic("StopRampA(uint256,uint256)"),
  landedEventTopic("ApplyNewFee(uint256,uint256)"),
  landedEventTopic("NewFee(uint256,uint256)"),
  landedEventTopic("SetNewMATime(uint256,uint256)"),
  ...CURVE_STATIC_LIQUIDITY_TOPICS,
].map((topic, index) => Object.freeze({
  id: `curve-mutation-${index}`,
  topic,
  emitter: ADDRESS_LANDED_EVENT_EMITTER,
}));

export const curvePlainLandedEvents = defineSwapLandedEvents({
  swaps: [
    {
      id: "curve-exchange-i128",
      topic: CURVE_TOKEN_EXCHANGE_TOPICS[0],
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      materialization: "family",
      discovery: { poolAdapter: "curve", label: "curve-i128" },
      invalidatesWarmState: true,
    },
    {
      id: "curve-exchange-uint",
      topic: CURVE_TOKEN_EXCHANGE_TOPICS[1],
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      materialization: "family",
      discovery: { poolAdapter: "curve", label: "curve-uint" },
      invalidatesWarmState: true,
    },
  ],
  mutations: curveMutationEvents,
});

export const curveUnderlyingLandedEvents = defineSwapLandedEvents({
  swaps: [
    {
      id: "curve-underlying-i128",
      topic: CURVE_TOKEN_EXCHANGE_TOPICS[2],
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      materialization: "family",
      discovery: {
        poolAdapter: "curve-underlying",
        label: "curve-underlying",
      },
      invalidatesWarmState: true,
    },
    {
      id: "curve-underlying-uint",
      topic: CURVE_TOKEN_EXCHANGE_TOPICS[3],
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      materialization: "family",
      discovery: {
        poolAdapter: "curve-underlying",
        label: "curve-underlying-uint",
      },
      invalidatesWarmState: true,
    },
  ],
  mutations: curveMutationEvents,
});
