import assert from "node:assert/strict";
import { nominateUniv2 } from
  "../venues/swaps/univ2-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { UNIV2_SWAP_TOPIC } from "../venues/swaps/univ2-abi.js";

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
      assert.deepEqual(filter.topics, [UNIV2_SWAP_TOPIC.toLowerCase()]);
      return Object.freeze([...(logs ?? [])]);
    },
    getTransactionReceipt: async () => null,
  };
}

async function main(): Promise<void> {
  // Positive: re-materializes the real recent Swap log emitted by the pool.
  const positive = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ2" }),
    })]),
    source: SOURCE,
    provider: mockProvider([Object.freeze({
      address: POOL.toLowerCase(),
      topics: Object.freeze([UNIV2_SWAP_TOPIC.toLowerCase()]),
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
  assert.deepEqual(observation.topics[0], UNIV2_SWAP_TOPIC.toLowerCase());

  // Foreign opaque label is ignored (framework stays family-blind).
  const foreign = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "other" }),
    })]),
    source: SOURCE,
    provider: mockProvider(),
  });
  assert.equal(foreign.length, 0);

  // No recent Swap log yields nothing from the plugin nomination; the
  // central cold-pool address-surface fallback is tested in
  // strict-identity-attestation (framework decides the fallback, not each
  // plugin).
  const noLog = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ2" }),
    })]),
    source: SOURCE,
    provider: mockProvider([]),
  });
  assert.equal(noLog.length, 0);

  // RPC failure on one nomination is isolated.
  const failing = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ2" }),
    })]),
    source: SOURCE,
    provider: Object.freeze({
      ...mockProvider(),
      getLogs: async () => {
        throw new Error("rpc down");
      },
    }),
  });
  assert.equal(failing.length, 0);

  console.log("univ2 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
