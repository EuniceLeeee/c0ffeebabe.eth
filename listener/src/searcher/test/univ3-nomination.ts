import assert from "node:assert/strict";
import { nominateUniv3 } from
  "../venues/swaps/univ3-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { UNIV3_SWAP_TOPIC } from "../venues/swaps/univ3-abi.js";

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
      // The query contract: pool emitter + Swap topic + retained window.
      assert.equal(filter.address, POOL.toLowerCase());
      assert.equal(filter.toBlock, SOURCE.number);
      assert.ok((filter.fromBlock ?? 0) >= SOURCE.number - 100_000);
      assert.deepEqual(filter.topics, [UNIV3_SWAP_TOPIC.toLowerCase()]);
      return Object.freeze([...(logs ?? [])]);
    },
  };
}

async function main(): Promise<void> {
  // Positive: re-materializes the real recent Swap log emitted by the pool.
  const positive = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ3" }),
    })]),
    source: SOURCE,
    provider: mockProvider([Object.freeze({
      address: POOL.toLowerCase(),
      topics: Object.freeze([UNIV3_SWAP_TOPIC.toLowerCase()]),
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
  assert.equal(observation.address, POOL.toLowerCase());
  assert.equal(observation.transactionHash, TX.toLowerCase());
  assert.deepEqual(observation.topics[0], UNIV3_SWAP_TOPIC.toLowerCase());

  // Foreign opaque label is ignored (framework stays family-blind).
  const foreign = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "other" }),
    })]),
    source: SOURCE,
    provider: mockProvider(),
  });
  assert.equal(foreign.length, 0);

  // No recent Swap log yields nothing; no fabrication.
  const noLog = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ3" }),
    })]),
    source: SOURCE,
    provider: mockProvider([]),
  });
  assert.equal(noLog.length, 0);

  console.log("univ3 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
