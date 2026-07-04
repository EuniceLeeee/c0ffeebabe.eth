import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  classifySenderFlow,
  type SenderFlowInput,
  type SenderFlowResult,
} from "../pnl/sender-flow.js";
import { findVictimSource } from "../pnl/victim-source.js";
import { TOPICS, lower } from "../registry/protocols.js";
import { PUBLIC_ROUTERS } from "../registry/routers.js";
import type { RpcClient } from "../rpc/client.js";

const ROUTER = [...PUBLIC_ROUTERS][0];
const EOA = "0x3333333333333333333333333333333333333333";
const SEARCHER_CONTRACT = "0x4444444444444444444444444444444444444444";
const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc";
const BACKRUN_HASH = `0x${"b".repeat(64)}`;
const SOURCE_HASH = `0x${"1".repeat(64)}`;

const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const V3_SWAP_EVENT = V3_SWAP_IFACE.getEvent("Swap")!;

const checks: Array<() => void | Promise<void>> = [
  () => {
    const got = classifySenderFlow(senderInput({ coinbaseTransferWei: 1n }));
    assert.deepEqual(flowSummary(got), ["bundle", "unknown", "high", "coinbase_transfer_bundle"]);
  },
  () => {
    const cases: Array<[boolean | null, SenderFlowResult["source_visibility"]]> = [
      [null, "unknown"],
      [true, "seen_by_us"],
      [false, "not_seen_by_us"],
    ];
    for (const [seenInOurPublicFeed, sourceVisibility] of cases) {
      const got = classifySenderFlow(senderInput({ coinbaseTransferWei: 1n, seenInOurPublicFeed }));
      assert.equal(got.submission_method, "bundle");
      assert.equal(got.source_visibility, sourceVisibility);
    }
  },
  () => {
    const got = classifySenderFlow(senderInput({ maxPriorityFeePerGasWei: 0n }));
    assert.deepEqual(flowSummary(got), ["bundle", "unknown", "high", "zero_priority_tip_bundle"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({
      maxPriorityFeePerGasWei: 0n,
      seenInOurPublicFeed: true,
    }));
    assert.equal(got.submission_method, "bundle");
    assert.equal(got.source_visibility, "seen_by_us");
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: true }));
    assert.deepEqual(flowSummary(got), [
      "public_mempool",
      "seen_by_us",
      "high",
      "seen_in_our_public_feed",
    ]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ to: ROUTER, toHasCode: true }));
    assert.deepEqual(flowSummary(got), ["public_mempool", "unknown", "med", "dest_public_router"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ to: SEARCHER_CONTRACT, toHasCode: true }));
    assert.deepEqual(flowSummary(got), ["unknown", "unknown", "low", "no_discriminating_signal"]);
  },
  () => {
    const got = classifySenderFlow(senderInput());
    assert.deepEqual(flowSummary(got), ["unknown", "unknown", "low", "no_discriminating_signal"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({
      to: ROUTER,
      toHasCode: true,
      maxPriorityFeePerGasWei: 0n,
      priorityTipWei: 0n,
      coinbaseTransferWei: 1n,
      seenInOurPublicFeed: true,
    }));
    assert.deepEqual(flowSummary(got), [
      "bundle",
      "seen_by_us",
      "high",
      "seen_in_our_public_feed,coinbase_transfer_bundle,zero_priority_tip_bundle,dest_public_router",
    ]);
  },
  () => {
    const got = classifySenderFlow(senderInput({
      to: ROUTER,
      toHasCode: true,
      priorityTipWei: 0n,
    }));
    assert.deepEqual(flowSummary(got), [
      "bundle",
      "unknown",
      "high",
      "zero_priority_tip_bundle,dest_public_router",
    ]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: false }));
    assert.equal(got.submission_method, "unknown");
    assert.equal(got.source_visibility, "not_seen_by_us");
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: null }));
    assert.equal(got.submission_method, "unknown");
    assert.equal(got.source_visibility, "unknown");
  },
  () => {
    const got = classifySenderFlow(senderInput({
      to: ROUTER,
      toHasCode: true,
      builder: "builder-x",
      seenInOurPublicFeed: true,
    }));
    assert.deepEqual(got.signals, {
      coinbase_transfer_wei: "0",
      priority_tip_wei: "1",
      max_priority_fee_per_gas_wei: "1",
      seen_in_our_public_feed: true,
      dest_is_public_router: true,
      dest_has_code: true,
      builder: "builder-x",
    });
  },
  async () => {
    const calls: Record<string, unknown>[] = [];
    let classifiedHash = "";
    const rpc = {
      getLogs: async (filter: Record<string, unknown>) => {
        calls.push(filter);
        return [
          v3SwapLog(`0x${"2".repeat(64)}`, 7, 100n, -50n, 0),
          v3SwapLog(SOURCE_HASH, 6, -200n, 100n, 1),
          v3SwapLog(`0x${"3".repeat(64)}`, 9, -500n, 250n, 2),
        ];
      },
    } as unknown as RpcClient;

    const got = await findVictimSource(rpc, {
      hash: BACKRUN_HASH,
      transactionIndex: 8,
      blockNumber: 123,
      legs: [{
        emitter: POOL,
        swapTopic: TOPICS.univ3Swap,
        direction: "0for1",
        poolId: POOL,
      }],
    }, async (hash) => {
      classifiedHash = hash;
      return publicRouterSourceFlow();
    });

    assert.deepEqual(got, {
      atomic: false,
      source_hash: lower(SOURCE_HASH),
      source_pool: lower(POOL),
      source_index: 6,
      backrun_index: 8,
      source_flow: "public-router",
      source_flow_confidence: "high",
      evidence: [
        "nearest_preceding_opposite_dir_same_pool",
        "seen_in_our_public_feed",
        "dest_public_router",
      ],
    });
    assert.equal(classifiedHash, lower(SOURCE_HASH));
    assert.deepEqual(calls[0], {
      address: POOL,
      topics: [TOPICS.univ3Swap],
      fromBlock: "0x7b",
      toBlock: "0x7b",
    });
  },
  async () => {
    const rpc = {
      getLogs: async () => [
        v3SwapLog(SOURCE_HASH, 6, -200n, 100n, 1),
      ],
    } as unknown as RpcClient;

    const got = await findVictimSource(rpc, {
      hash: BACKRUN_HASH,
      transactionIndex: 8,
      blockNumber: 123,
      legs: [{
        emitter: POOL,
        swapTopic: TOPICS.univ3Swap,
        direction: "0for1",
        poolId: POOL,
      }],
    }, async () => classifySenderFlow(senderInput({
      to: SEARCHER_CONTRACT,
      toHasCode: true,
      maxPriorityFeePerGasWei: 0n,
      seenInOurPublicFeed: true,
    })));

    assert.equal(got.source_flow, "unknown");
    assert.equal(got.source_flow_confidence, "low");
  },
  async () => {
    const rpc = {
      getLogs: async () => [
        v3SwapLog(SOURCE_HASH, 6, -200n, 100n, 1),
      ],
    } as unknown as RpcClient;

    const got = await findVictimSource(rpc, {
      hash: BACKRUN_HASH,
      transactionIndex: 8,
      blockNumber: 123,
      legs: [{
        emitter: POOL,
        swapTopic: TOPICS.univ3Swap,
        direction: "0for1",
        poolId: POOL,
      }],
    }, async () => classifySenderFlow(senderInput({
      to: SEARCHER_CONTRACT,
      toHasCode: true,
      maxPriorityFeePerGasWei: 0n,
      seenInOurPublicFeed: false,
    })));

    assert.equal(got.source_flow, "private-orderflow");
    assert.equal(got.source_flow_confidence, "low");
  },
  async () => {
    // Regression lock (C1a branch-order bug): a source swap we SAW, sent to a
    // public router, with a zero effective tip (bundled inclusion) must classify
    // "public-router" — the old fee-first order downgraded exactly this input to
    // flow="private" and hence source_flow="private-orderflow".
    const got = await victimSourceFor({
      to: ROUTER,
      toHasCode: true,
      maxPriorityFeePerGasWei: 0n,
      seenInOurPublicFeed: true,
    });
    assert.equal(got.source_flow, "public-router");
    assert.equal(got.source_flow_confidence, "high");
  },
  async () => {
    // A router-destined bundle we did NOT see is ambiguous (missed public flow
    // vs private submission) — never "private-orderflow" (that proxy requires a
    // non-router contract dest).
    const got = await victimSourceFor({
      to: ROUTER,
      toHasCode: true,
      maxPriorityFeePerGasWei: 0n,
      seenInOurPublicFeed: false,
    });
    assert.equal(got.source_flow, "unknown");
    assert.equal(got.source_flow_confidence, "low");
  },
  async () => {
    const rpc = {
      getLogs: async () => [
        v3SwapLog(`0x${"4".repeat(64)}`, 6, 100n, -50n, 0),
      ],
    } as unknown as RpcClient;

    const got = await findVictimSource(rpc, {
      hash: BACKRUN_HASH,
      transactionIndex: 8,
      blockNumber: 123,
      legs: [{
        emitter: POOL,
        swapTopic: TOPICS.univ3Swap,
        direction: "0for1",
        poolId: POOL,
      }],
    }, async () => {
      throw new Error("classifier should not run without a preceding opposite swap");
    });

    assert.deepEqual(got, {
      atomic: true,
      source_hash: null,
      source_pool: null,
      source_index: null,
      backrun_index: 8,
      source_flow: "none",
      source_flow_confidence: null,
      evidence: ["no_preceding_opposite_swap"],
    });
  },
];

try {
  for (const check of checks) await check();
  console.log(`PASS (${checks.length}/${checks.length})`);
  console.log("verdict: fixed");
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function senderInput(overrides: Partial<SenderFlowInput> = {}): SenderFlowInput {
  return {
    txHash: `0x${"a".repeat(64)}`,
    to: EOA,
    toHasCode: false,
    maxPriorityFeePerGasWei: 1n,
    priorityTipWei: 1n,
    coinbaseTransferWei: 0n,
    builder: "",
    seenInOurPublicFeed: null,
    ...overrides,
  };
}

async function victimSourceFor(senderOverrides: Partial<SenderFlowInput>) {
  const rpc = {
    getLogs: async () => [
      v3SwapLog(SOURCE_HASH, 6, -200n, 100n, 1),
    ],
  } as unknown as RpcClient;
  return findVictimSource(rpc, {
    hash: BACKRUN_HASH,
    transactionIndex: 8,
    blockNumber: 123,
    legs: [{
      emitter: POOL,
      swapTopic: TOPICS.univ3Swap,
      direction: "0for1",
      poolId: POOL,
    }],
  }, async () => classifySenderFlow(senderInput(senderOverrides)));
}

function flowSummary(result: SenderFlowResult): [string, string, string, string] {
  return [
    result.submission_method,
    result.source_visibility,
    result.confidence,
    result.evidence.join(","),
  ];
}

function publicRouterSourceFlow(): SenderFlowResult {
  return {
    submission_method: "public_mempool",
    source_visibility: "seen_by_us",
    confidence: "high",
    evidence: ["seen_in_our_public_feed", "dest_public_router"],
    signals: {
      coinbase_transfer_wei: "0",
      priority_tip_wei: "1",
      max_priority_fee_per_gas_wei: "1",
      seen_in_our_public_feed: true,
      dest_is_public_router: true,
      dest_has_code: true,
      builder: "",
    },
  };
}

function v3SwapLog(
  hash: string,
  txIndex: number,
  amount0: bigint,
  amount1: bigint,
  logIndex: number,
): any {
  const encoded = V3_SWAP_IFACE.encodeEventLog(V3_SWAP_EVENT, [
    SENDER,
    RECIPIENT,
    amount0,
    amount1,
    1n,
    1n,
    0,
  ]);
  return {
    address: POOL,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: hash,
    transactionIndex: quantity(txIndex),
    logIndex: quantity(logIndex),
  };
}

function quantity(n: number): string {
  return `0x${n.toString(16)}`;
}
