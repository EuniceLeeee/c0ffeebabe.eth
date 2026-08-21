import assert from "node:assert/strict";
import { nominateDodoV2 } from
  "../venues/swaps/dodo-v2-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { DODO_V2_SWAP_TOPIC } from "../venues/swaps/dodo-v2-abi.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL = `0x${"a2".repeat(20)}`;
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
    getLogs: async (filter) => {
      assert.equal(filter.address, POOL.toLowerCase());
      assert.equal(filter.toBlock, SOURCE.number);
      assert.equal(filter.fromBlock, SOURCE.number - 14_399);
      assert.deepEqual(filter.topics, [DODO_V2_SWAP_TOPIC.toLowerCase()]);
      return Object.freeze([...(logs ?? [])]);
    },
    getTransactionReceipt: async () => null,
  };
}

async function main(): Promise<void> {
  const positive = await nominateDodoV2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "dodo-v2" }),
    })]),
    source: SOURCE,
    provider: mockProvider([Object.freeze({
      address: POOL.toLowerCase(),
      topics: Object.freeze([DODO_V2_SWAP_TOPIC.toLowerCase()]),
      data: "0x",
      transactionHash: TX.toLowerCase(),
    })]),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "log" }
  >;
  assert.equal(observation.address, POOL.toLowerCase());
  assert.equal(observation.transactionHash, TX.toLowerCase());
  assert.deepEqual(observation.topics[0], DODO_V2_SWAP_TOPIC.toLowerCase());

  const foreign = await nominateDodoV2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "other" }),
    })]),
    source: SOURCE,
    provider: mockProvider(),
  });
  assert.equal(foreign.length, 0);

  const noLog = await nominateDodoV2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "dodo-v2" }),
    })]),
    source: SOURCE,
    provider: mockProvider([]),
  });
  assert.equal(noLog.length, 0);

  console.log("dodo-v2 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
