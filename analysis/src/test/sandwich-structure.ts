import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyWinnerTxStyle,
  partitionPriorMoversByActor,
} from "../cli/bundle-postmortem.js";
import type { RpcClient } from "../rpc/client.js";

interface SandwichFixtureCase {
  block: number;
  txHash: string;
  transactionIndex: number;
  tx: { from: string; to: string; input: string };
  receipt: { from: string; to: string; logs: any[] };
  blockSwaps: any[];
  transactions: Record<string, { from: string; to: string }>;
}

interface SandwichFixture {
  false_atomic: SandwichFixtureCase;
  genuine_sandwich: SandwichFixtureCase;
}

const fixture = JSON.parse(readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sandwich-structure.json",
), "utf8")) as SandwichFixture;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const COFFEE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";

test("0xa6fdcb64 flips from false sandwich to atomic_loop without an external bracketed victim", async () => {
  const sample = fixture.false_atomic;
  const analysis = await classify(sample, []);

  assert.equal(sample.txHash, "0xa6fdcb644754032598cf30a48fc398f5dbdd9061a93eb06555fadd879027c426");
  assert.equal(analysis.winner_style, "atomic_loop");
  assert.equal(analysis.receipt_weth_unwrap_exit, true);

  const prior = partitionPriorMoversByActor([
    { txHash: "0x3b0469c96e9dd3f7ac4246824f5cdd3ca6fba6e2a6fb03fc1beedea4a9a71c96", transactionIndex: 0, emitter: sample.blockSwaps[0]!.address },
    { txHash: "0x0a8750bc93000ff6f3ef29262b8e11171718f012ef2d8491a439eb16fd145f9a", transactionIndex: 1, emitter: sample.blockSwaps[0]!.address },
  ], new Map([
    ["0x3b0469c96e9dd3f7ac4246824f5cdd3ca6fba6e2a6fb03fc1beedea4a9a71c96", COFFEE],
    ["0x0a8750bc93000ff6f3ef29262b8e11171718f012ef2d8491a439eb16fd145f9a", COFFEE],
  ]), COFFEE);
  assert.equal(prior.external.length, 0);
  assert.equal(prior.sameActor.length, 2);
});

test("real ae2Fc483 pre-victim-post bracket remains sandwich", async () => {
  const sample = fixture.genuine_sandwich;
  const analysis = await classify(sample);

  assert.equal(sample.block, 25452319);
  assert.equal(sample.transactionIndex, 3);
  assert.equal(analysis.winner_style, "sandwich");
});

test("an available native prestate trace stays authoritative over an unwrap receipt", async () => {
  const analysis = await classify(fixture.false_atomic, [], true, -0.1);
  assert.equal(analysis.receipt_weth_unwrap_exit, true);
  assert.equal(analysis.winner_style, "unknown");
});

async function classify(
  sample: SandwichFixtureCase,
  pricedDeltas = [{ token: WETH, raw: 1n, symbol: "WETH", decimals: 18 }],
  nativeTraceUsed = false,
  ethDeltaEth = 0,
) {
  return classifyWinnerTxStyle({
    rpc: fixtureRpc(sample),
    txHash: sample.txHash,
    tx: sample.tx,
    receipt: sample.receipt,
    profit: {
      pricedDeltas,
      unpricedDeltas: [],
      beneficiary: sample.tx.to,
      ethDeltaEth,
      nativeTraceUsed,
    },
    transactionIndex: sample.transactionIndex,
    blockNumber: sample.block,
    prestateBlock: sample.block - 1,
  });
}

function fixtureRpc(sample: SandwichFixtureCase): RpcClient {
  return {
    async getLogs(filter: Record<string, unknown>) {
      const address = String(filter.address ?? "").toLowerCase();
      return sample.blockSwaps.filter((log) => log.address.toLowerCase() === address);
    },
    async getTransaction(hash: string) {
      return sample.transactions[hash.toLowerCase()] ?? null;
    },
    async call() {
      throw new Error("fixture has no historical slot0");
    },
    async traceTransaction() {
      throw new Error("fixture has no call trace");
    },
  } as unknown as RpcClient;
}
