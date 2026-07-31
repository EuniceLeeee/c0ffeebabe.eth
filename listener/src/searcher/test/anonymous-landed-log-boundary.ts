import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  PRODUCTION_IDENTITY_ADMISSION,
} from "../venues/admission.js";
import {
  defineSwapLandedEvents,
  LandedEventRegistry,
  observedLandedPoolIdentity,
  singletonAnonymousDataBytes32Emitter,
} from "../venues/landed-event-registry.js";
import {
  discoverLandedPools,
  LandedPoolDiscoveryRegistry,
  type LandedPoolDiscoveryLog,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolMaterializationContext,
} from "../venues/landed-pool-discovery.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";
import { createStrictSwapObservation } from "../venues/swap-observation.js";

const SINGLETON = "0x0000000000000000000000000000000000000100";
const OTHER = "0x0000000000000000000000000000000000000200";
const MATERIALIZED_POOL =
  "0x0000000000000000000000000000000000000300";
const DATA_LENGTH_BYTES = 96;
const IDENTITY_OFFSET_BYTES = 32;
const identity = ethers.zeroPadValue(MATERIALIZED_POOL, 32).toLowerCase();
const validData = ethers.concat([
  ethers.ZeroHash,
  identity,
  ethers.ZeroHash,
]);
const emitter = singletonAnonymousDataBytes32Emitter(
  SINGLETON,
  DATA_LENGTH_BYTES,
  IDENTITY_OFFSET_BYTES,
);
const anonymousSelector = Object.freeze({
  address: ethers.getAddress(SINGLETON),
  dataLengthBytes: DATA_LENGTH_BYTES,
  identityOffsetBytes: IDENTITY_OFFSET_BYTES,
});
const landedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "fixture-anonymous-swap",
    topic: null,
    emitter,
    materialization: "family",
    discovery: {
      poolAdapter: "univ2",
      label: "fixture anonymous swap",
    },
    invalidatesWarmState: true,
  }],
  mutations: [],
});
const observation = createStrictSwapObservation({
  topics: [],
  anonymousLogs: [anonymousSelector],
  canonicalIntakeTargets: [],
  observedPoolIdentity(log) {
    return observedLandedPoolIdentity(landedEvents.swaps[0], log);
  },
  async decodeSwapImpacts() {
    return [];
  },
});
const materializedLogCounts: number[] = [];
const family = {
  id: "fixture-anonymous-family",
  poolAdapters: ["univ2"],
  landedEvents,
  observation,
  poolDiscovery: {
    version: "fixture-anonymous-v1",
    eventIds: ["fixture-anonymous-swap"],
    consumesOpaqueRetries: true,
    async materialize(context: LandedPoolMaterializationContext) {
      materializedLogCounts.push(context.logs.length);
      assert.equal(
        observedLandedPoolIdentity(context.event, context.logs[0]),
        identity,
        "anonymous materialization must receive the bounded bytes32 identity",
      );
      return {
        complete: true,
        pools: [{
          address: MATERIALIZED_POOL,
          adapter: "univ2",
          token0: OTHER,
          token1: SINGLETON,
        }],
      };
    },
  },
} as unknown as SwapAdapter;
const eventRegistry = new LandedEventRegistry([family]);
const discoveryRegistry = new LandedPoolDiscoveryRegistry(
  [family],
  eventRegistry,
);

const validLog: LandedPoolDiscoveryLog = {
  address: SINGLETON,
  topics: [],
  data: validData,
  blockNumber: 100,
};
assert(eventRegistry.isSwapLog(validLog), "bounded anonymous log must match");
assert.equal(
  observedLandedPoolIdentity(landedEvents.swaps[0], validLog),
  identity,
  "bounded anonymous log must expose its declared bytes32 identity",
);
for (
  const unrelated of [
    { ...validLog, address: OTHER },
    { ...validLog, topics: [ethers.ZeroHash] },
    { ...validLog, data: `${validData}00` },
  ]
) {
  assert.equal(
    eventRegistry.isSwapLog(unrelated),
    false,
    "address, topic count, and exact data length bound anonymous ownership",
  );
}

const filters: LandedPoolDiscoveryLogFilter[] = [];
const result = await discoverLandedPools({
  registry: discoveryRegistry,
  backend: {
    async getLogs(filter) {
      filters.push(filter);
      return [
        validLog,
        { ...validLog, address: OTHER },
        { ...validLog, topics: [ethers.ZeroHash] },
        { ...validLog, data: `${validData}00` },
      ];
    },
    async call() {
      throw new Error("anonymous discovery fixture must not read chain state");
    },
  },
  fromBlock: 100,
  toBlock: 100,
  batchSize: 1,
  minSwaps: 1,
  admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  topicScanMode: "union",
  strict: true,
});
assert.deepEqual(
  filters,
  [{
    address: ethers.getAddress(SINGLETON),
    topics: [],
    fromBlock: 100,
    toBlock: 100,
  }],
  "anonymous discovery must use one address-bounded, topic-free log query",
);
assert.deepEqual(
  materializedLogCounts,
  [1],
  "unrelated anonymous logs must be filtered before family materialization",
);
assert.equal(result.logCountsByEventId.get("fixture-anonymous-swap"), 1);
assert.equal(result.materializedPools.length, 1);
assert(
  result.coverage.every((coverage) => coverage.complete),
  "a fully scanned anonymous source must publish complete family-local coverage",
);

assert.throws(
  () =>
    new LandedEventRegistry([{
      ...family,
      landedEvents: defineSwapLandedEvents({
        swaps: [{
          ...landedEvents.swaps[0],
          emitter: singletonAnonymousDataBytes32Emitter(
            SINGLETON,
            48,
            32,
          ),
        }],
        mutations: [],
      }),
    }]),
  /invalid anonymous data bounds/,
  "an anonymous selector whose bytes32 identity exceeds its data must fail closed",
);

console.log("anonymous landed log boundary tests passed");
