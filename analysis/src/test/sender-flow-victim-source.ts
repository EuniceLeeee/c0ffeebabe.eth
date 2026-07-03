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
    assert.deepEqual(flowSummary(got), ["private", "high", "coinbase_transfer"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ maxPriorityFeePerGasWei: 0n }));
    assert.deepEqual(flowSummary(got), ["private", "high", "zero_priority_tip"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: true }));
    assert.deepEqual(flowSummary(got), ["public", "high", "seen_in_our_public_feed"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ to: ROUTER, toHasCode: true }));
    assert.deepEqual(flowSummary(got), ["public", "med", "dest_public_router"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ to: SEARCHER_CONTRACT, toHasCode: true }));
    assert.deepEqual(flowSummary(got), ["private", "low", "dest_searcher_contract"]);
  },
  () => {
    const got = classifySenderFlow(senderInput());
    assert.deepEqual(flowSummary(got), ["unknown", "low", "no_discriminating_signal"]);
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
    assert.deepEqual(flowSummary(got), ["private", "high", "coinbase_transfer"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({
      to: ROUTER,
      toHasCode: true,
      priorityTipWei: 0n,
    }));
    assert.deepEqual(flowSummary(got), ["private", "high", "zero_priority_tip"]);
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: false }));
    assert.equal(got.flow, "unknown");
  },
  () => {
    const got = classifySenderFlow(senderInput({ seenInOurPublicFeed: null }));
    assert.equal(got.flow, "unknown");
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
      source_flow_confidence: "med",
      evidence: ["nearest_preceding_opposite_dir_same_pool", "dest_public_router"],
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

function flowSummary(result: SenderFlowResult): [string, string, string] {
  return [result.flow, result.confidence, result.evidence.join(",")];
}

function publicRouterSourceFlow(): SenderFlowResult {
  return {
    flow: "public",
    confidence: "med",
    evidence: ["dest_public_router"],
    signals: {
      coinbase_transfer_wei: "0",
      priority_tip_wei: "1",
      max_priority_fee_per_gas_wei: "1",
      seen_in_our_public_feed: null,
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
