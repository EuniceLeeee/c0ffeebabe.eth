import assert from "node:assert/strict";
import { nominateUniv4 } from
  "../venues/swaps/univ4-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  UNIV4_INITIALIZE_TOPIC,
} from "../venues/swaps/univ4-abi.js";
import { ADDR } from "../../shared/constants/addresses.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_000_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL_ID = `0x${"e1".repeat(32)}`;
const TX = `0x${"d1".repeat(32)}`;

function mockProvider(logs?: readonly {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
}[]): CaptureNominationProvider {
  return {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async () => Object.freeze([...(logs ?? [])]),
  };
}

async function main(): Promise<void> {
  // Positive: the opaque poolId drives an exact [Initialize, poolId] query
  // against the PoolManager singleton; the real log is returned.
  const positive = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
      topics: Object.freeze([
        UNIV4_INITIALIZE_TOPIC.toLowerCase(),
        POOL_ID.toLowerCase(),
      ]),
      data: "0x",
      transactionHash: TX.toLowerCase(),
    })]),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "log" }
  >;
  assert.equal(observation.kind, "log");
  assert.equal(observation.address, ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());
  assert.equal(observation.transactionHash, TX.toLowerCase());
  assert.deepEqual(observation.topics[1], POOL_ID.toLowerCase());

  // Foreign opaque label ignored.
  const foreign = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "other", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider(),
  });
  assert.equal(foreign.length, 0);

  // Missing or malformed poolId fails closed.
  const badPoolId = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4" }),
    })]),
    source: SOURCE,
    provider: mockProvider(),
  });
  assert.equal(badPoolId.length, 0);

  // No Initialize log for the poolId yields nothing (no fabrication).
  const noLog = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider([]),
  });
  assert.equal(noLog.length, 0);

  console.log("univ4 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
