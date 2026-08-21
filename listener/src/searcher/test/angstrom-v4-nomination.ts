import assert from "node:assert/strict";
import { nominateAngstromV4 } from
  "../venues/swaps/angstrom-v4-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../venues/swaps/univ4-abi.js";
import { ANGSTROM_ADAPTER_SWAP_SELECTOR } from
  "../venues/swaps/angstrom-attestation.js";
import { ADDR } from "../../shared/constants/addresses.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL_ID = `0x${"e1".repeat(32)}`;
const TX = `0x${"d1".repeat(32)}`;
const SENDER = `0x${"f1".repeat(20)}`;
const TARGET = `0x${"a3".repeat(20)}`;
const SWAP_CALLDATA = ANGSTROM_ADAPTER_SWAP_SELECTOR + "00".repeat(32);

function mockProvider(options: {
  readonly logs?: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash: string;
  }[];
  readonly trace?: unknown;
}): CaptureNominationProvider {
  return {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async (filter) => {
      assert.equal(filter.address?.toLowerCase(), ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());
      assert.equal(filter.fromBlock, SOURCE.number - 14_399);
      assert.equal(filter.toBlock, SOURCE.number);
      assert.deepEqual(filter.topics, [
        UNIV4_SWAP_TOPIC.toLowerCase(),
        POOL_ID.toLowerCase(),
      ]);
      return Object.freeze([...(options.logs ?? [])]);
    },
    getTransactionReceipt: async () => null,
    traceTransaction: async () => options.trace,
  };
}

async function main(): Promise<void> {
  const positive = await nominateAngstromV4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "angstrom-v4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      logs: [Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([UNIV4_SWAP_TOPIC.toLowerCase(), POOL_ID.toLowerCase()]),
        data: "0x",
        transactionHash: TX.toLowerCase(),
      })],
      trace: Object.freeze({
        to: TARGET,
        from: SENDER,
        input: SWAP_CALLDATA,
        calls: Object.freeze([]),
      }),
    }),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "call" }
  >;
  assert.equal(observation.kind, "call");
  assert.equal(observation.target, TARGET.toLowerCase());
  assert.equal(observation.data, SWAP_CALLDATA.toLowerCase());

  // Trace without an Angstrom swap frame yields nothing.
  const noFrame = await nominateAngstromV4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "angstrom-v4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      logs: [Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([UNIV4_SWAP_TOPIC.toLowerCase(), POOL_ID.toLowerCase()]),
        data: "0x",
        transactionHash: TX.toLowerCase(),
      })],
      trace: Object.freeze({
        to: TARGET,
        from: SENDER,
        input: "0x12345678",
        calls: Object.freeze([]),
      }),
    }),
  });
  assert.equal(noFrame.length, 0);

  console.log("angstrom-v4 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
