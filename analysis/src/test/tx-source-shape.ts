import assert from "node:assert/strict";
import { ethers } from "ethers";
import test from "node:test";
import { classifyTransactionSource } from "../pnl/tx-source-shape.js";
import type { RpcClient } from "../rpc/client.js";

const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc";
const WINNER_HASH = `0x${"d".repeat(64)}`;
const SOURCE_HASH = `0x${"1".repeat(64)}`;
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const V3_SWAP_EVENT = V3_SWAP_IFACE.getEvent("Swap")!;

test("opposite-direction preceding swap classifies as victim", async () => {
  const rpc = fakeRpc([
    v3SwapLog(SOURCE_HASH, 6, -200n, 100n, 0),
    v3SwapLog(WINNER_HASH, 8, 100n, -50n, 1),
  ]);
  assert.equal(await classifyTransactionSource(rpc, WINNER_HASH), "victim");
});

test("same-direction preceding swap classifies as blockscan", async () => {
  const rpc = fakeRpc([
    v3SwapLog(SOURCE_HASH, 6, 200n, -100n, 0),
    v3SwapLog(WINNER_HASH, 8, 100n, -50n, 1),
  ]);
  assert.equal(await classifyTransactionSource(rpc, WINNER_HASH), "blockscan");
});

test("missing recognized swap legs fails instead of guessing", async () => {
  const rpc = {
    getReceipt: async () => ({
      status: "0x1",
      blockNumber: "0x7b",
      transactionIndex: "0x8",
      logs: [],
    }),
  } as unknown as RpcClient;
  await assert.rejects(
    classifyTransactionSource(rpc, WINNER_HASH),
    /no recognized swap legs/,
  );
});

function fakeRpc(blockLogs: any[]): RpcClient {
  return {
    getReceipt: async () => ({
      status: "0x1",
      blockNumber: "0x7b",
      transactionIndex: "0x8",
      logs: blockLogs.filter((log) => log.transactionHash === WINNER_HASH),
    }),
    getLogs: async () => blockLogs,
  } as unknown as RpcClient;
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

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}
