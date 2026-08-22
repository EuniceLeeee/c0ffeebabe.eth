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
      assert.equal(
        filter.fromBlock,
        SOURCE.number - 50_399,
        "plugin auxiliary nomination must use the shared exact 7-day " +
          "dormancy nomination range",
      );
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

  // Non-univ4 opaque label fast path: no manager-wide scan, no trace.
  let getLogsCalls = 0;
  const nonUniv4 = await nominateUniv4({
    nominations: Object.freeze([Object.freeze({
      address: `0x${"ab".repeat(20)}`,
      opaque: Object.freeze({ adapter: "univ2-standard" }),
    })]),
    source: SOURCE,
    provider: {
      call: async () => "0x",
      getCode: async () => "0x01",
      getStorage: async () => `0x${"00".repeat(32)}`,
      getLogs: async () => {
        getLogsCalls += 1;
        return Object.freeze([]);
      },
      getTransactionReceipt: async () => null,
      traceTransaction: async () => null,
    },
  });
  assert.equal(nonUniv4.length, 0);
  assert.equal(getLogsCalls, 0, "non-univ4 nomination must not scan logs");

  // P1 (audit): in-flight dedupe. Concurrent cold nominations on one
  // provider + source must share a single manager-wide window build;
  // without the shared promise each worker replays the scan.
  let concurrentGetLogsCalls = 0;
  const concurrentProvider = {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => "0x" + "00".repeat(32),
    getLogs: async (filter: { readonly fromBlock?: number; readonly toBlock?: number }) => {
      concurrentGetLogsCalls += 1;
      return Object.freeze([Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([UNIV4_SWAP_TOPIC.toLowerCase(), POOL_ID]),
        data: "0x",
        transactionHash: TX,
      })]);
    },
    getTransactionReceipt: async () => null,
    traceTransaction: async () => managerSwapTrace(),
  };
  const nomination = Object.freeze({
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    opaque: Object.freeze({ adapter: "univ4", poolId: POOL_ID }),
  });
  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    nominateUniv4({
      nominations: Object.freeze([nomination]),
      source: SOURCE,
      provider: concurrentProvider,
    }),
  ));
  // One build is one exact 14400-block getLogs call; four concurrent cold
  // nominations must share that same in-flight build.
  assert.equal(
    concurrentGetLogsCalls,
    1,
    "concurrent cold nominations must share one window build",
  );
  assert.equal(concurrent[0].length, 1);
  assert.equal(concurrent[3].length, 1);

  // Contract: a different cutoff hash never reuses the settled index.
  let diffHashGetLogsCalls = 0;
  const diffHashProvider = {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => "0x" + "00".repeat(32),
    getLogs: async () => {
      diffHashGetLogsCalls += 1;
      return Object.freeze([Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([UNIV4_SWAP_TOPIC.toLowerCase(), POOL_ID]),
        data: "0x",
        transactionHash: TX,
      })]);
    },
    getTransactionReceipt: async () => null,
    traceTransaction: async () => managerSwapTrace(),
  };
  const otherSource = Object.freeze({
    number: SOURCE.number,
    hash: "0x" + "b2".repeat(32),
    generation: 2,
  });
  await nominateUniv4({
    nominations: Object.freeze([nomination]),
    source: otherSource,
    provider: diffHashProvider,
  });
  const afterDiffHash = diffHashGetLogsCalls;
  assert.equal(
    afterDiffHash,
    1,
    "a different source hash must build its own exact-range index",
  );

  // Contract: a failed build never poisons the settled cache; the next
  // call retries and succeeds.
  let flakyCalls = 0;
  const flakyProvider = {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => "0x" + "00".repeat(32),
    getLogs: async () => {
      flakyCalls += 1;
      // The 14400-block build halves on failure (14400 -> ... -> 56, 9
      // calls) before the hard floor rejects; fail the whole first attempt
      // so the cache stays unpoisoned and the retry rebuilds cleanly.
      if (flakyCalls <= 12) throw new Error("transient rpc");
      return Object.freeze([Object.freeze({
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
        topics: Object.freeze([UNIV4_SWAP_TOPIC.toLowerCase(), POOL_ID]),
        data: "0x",
        transactionHash: TX,
      })]);
    },
    getTransactionReceipt: async () => null,
    traceTransaction: async () => managerSwapTrace(),
  };
  let flakyRejected = false;
  try {
    await nominateUniv4({
      nominations: Object.freeze([nomination]),
      source: SOURCE,
      provider: flakyProvider,
    });
  } catch {
    flakyRejected = true;
  }
  assert.equal(flakyRejected, true, "transient build failure must reject");
  const afterFlakyFailure = flakyCalls;
  const retried = await nominateUniv4({
    nominations: Object.freeze([nomination]),
    source: SOURCE,
    provider: flakyProvider,
  });
  assert.equal(retried.length, 1, "retry after failure must succeed");
  assert.ok(
    flakyCalls > afterFlakyFailure,
    "a failed build must not poison the settled cache (retry rebuilds)",
  );

  console.log("univ4 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
