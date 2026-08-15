import assert from "node:assert/strict";
import { ethers } from "ethers";
import { nominateUniv4 } from
  "../venues/swaps/univ4-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../venues/swaps/univ4-abi.js";
import { ADDR } from "../../shared/constants/addresses.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL_ID = `0x${"e1".repeat(32)}`;
const TX = `0x${"d1".repeat(32)}`;
const SENDER = `0x${"f1".repeat(20)}`;
const SWAP_CALLDATA =
  "0xf3cd914c" + "00".repeat(32) + "11".repeat(32) + "22".repeat(32);

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
      // Plugin-owned batched reverse lookup: one manager-wide Swap scan per
      // source block indexes poolId -> newest tx; per-pool trace follows.
      assert.equal(
        filter.address?.toLowerCase(),
        ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
      );
      assert.equal(filter.toBlock, SOURCE.number);
      assert.ok((filter.fromBlock ?? 0) >= SOURCE.number - 100_000);
      assert.deepEqual(filter.topics, [
        UNIV4_SWAP_TOPIC.toLowerCase(),
      ]);
      return Object.freeze([...(options.logs ?? [])]);
    },
    getTransactionReceipt: async () => null,
    traceTransaction: async () => options.trace,
  };
}

function managerSwapTrace(): unknown {
  return Object.freeze({
    to: ADDR.UNISWAP_V4_POOL_MANAGER,
    from: SENDER,
    input: SWAP_CALLDATA,
    calls: Object.freeze([]),
  });
}

async function main(): Promise<void> {
  // Positive: Swap log -> trace -> real PoolManager.swap calldata frame.
  const positive = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      logs: [Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([
          UNIV4_SWAP_TOPIC.toLowerCase(),
          POOL_ID.toLowerCase(),
        ]),
        data: "0x",
        transactionHash: TX.toLowerCase(),
      })],
      trace: managerSwapTrace(),
    }),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "call" }
  >;
  assert.equal(observation.kind, "call");
  assert.equal(observation.target, ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());
  assert.equal(observation.data, SWAP_CALLDATA.toLowerCase());
  assert.equal(observation.transactionHash, TX.toLowerCase());

  // Trace frame nested inside calls is found recursively.
  const nested = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      logs: [Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([
          UNIV4_SWAP_TOPIC.toLowerCase(),
          POOL_ID.toLowerCase(),
        ]),
        data: "0x",
        transactionHash: TX.toLowerCase(),
      })],
      trace: Object.freeze({
        to: `0x${"77".repeat(20)}`,
        from: `0x${"88".repeat(20)}`,
        input: "0x",
        calls: Object.freeze([managerSwapTrace()]),
      }),
    }),
  });
  assert.equal(nested.length, 1);
  assert.equal((nested[0] as Extract<UnifiedObservation, { kind: "call" }>).target,
    ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());

  // Trace without a manager swap frame yields nothing (no fabrication).
  const noFrame = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      logs: [Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([
          UNIV4_SWAP_TOPIC.toLowerCase(),
          POOL_ID.toLowerCase(),
        ]),
        data: "0x",
        transactionHash: TX.toLowerCase(),
      })],
      trace: Object.freeze({
        to: `0x${"77".repeat(20)}`,
        from: `0x${"88".repeat(20)}`,
        input: "0x12345678",
        calls: Object.freeze([]),
      }),
    }),
  });
  assert.equal(noFrame.length, 0);

  // Missing poolId fails closed.
  const badPoolId = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      opaque: Object.freeze({ adapter: "univ4" }),
    })]),
    source: SOURCE,
    provider: mockProvider({}),
  });
  assert.equal(badPoolId.length, 0);

  console.log("univ4 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
