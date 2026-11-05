import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as ethers from "ethers";
import { readBlockTouchedStateKeys } from "../blockscan-touched-state.js";
import { StartupActivityCollector } from "../blockscan-startup-catchup.js";
import { parseBlockScanObservedHeader } from "../blockscan-observed-header.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const header = (n: number) => ({ number: n, hash: hash(n), parentHash: hash(n - 1), transactionHashes: [], passiveTouchedAddresses: [] });
// Execute the actual thin main wiring without importing its trading entry point.
const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const start = source.indexOf("  const readContinuationHeader = ");
const end = source.indexOf("  const blockScanRuntimeLoop = new BlockScanRuntimeLoop({", start);
assert(start >= 0 && end > start);
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("production startup RPC rejects unsupported interior or target coverage, including SQL suffix", async () => {
  for (const missing of [101, 102, null]) {
    const provider = { async getLogs() { return []; }, async send() { return []; },
      withBlockActivity(_hash: string, read: () => Promise<unknown>) { return read(); } };
    const dependencies = { activityTransport: { sendWithControl: async (_method: string, [quantity]: string[]) => {
      const n = Number(BigInt(quantity!));
      return n === missing ? { ...header(n), passiveTouchedAddresses: undefined } : header(n);
    } }, parseBlockScanObservedHeader: (value: unknown) => value, ethers, StateCallAbortedError,
      timedActivityRead: (_method: string, _number: number, read: () => Promise<unknown>) => read(),
      config: { rpcUrl: "fixture" }, blockScanChainId: 1n, activityReadFailed: (error: unknown) => { throw error; },
      blockScanActivityProvider: provider, readBlockTouchedStateKeys, StartupActivityCollector,
      ADDR: { UNISWAP_V4_POOL_MANAGER: `0x${"1".repeat(40)}` },
      strictRuntimeRoot: { resolveBlockTouchedStateKeys: () => [] },
    };
    const { readStartupTouched } = new Function(...Object.keys(dependencies),
      `${js}; return { readStartupTouched };`)(...Object.values(dependencies));
    const target = missing === 102 ? { ...header(102), passiveTouchedAddresses: undefined } : header(102);
    const result = Promise.resolve().then(() => readStartupTouched(102, target,
      { previousSource: { number: 100, hash: hash(100) }, deadlineAtMs: Date.now() + 10_000 }));
    if (missing !== null) await assert.rejects(result, /complete consensus activity coverage/);
    else assert.equal((await result).size, 0);
  }
});

const wireHeader = (n: number) => ({
  number: ethers.toQuantity(n), timestamp: ethers.toQuantity(1_800_000_000), hash: hash(n), parentHash: hash(n - 1),
  transactions: [], gasUsed: "0x0", gasLimit: "0x1c9c380", baseFeePerGas: "0x1",
  miner: `0x${"1".repeat(40)}`, nonce: "0x0000000000000000", difficulty: "0x0", mixHash: hash(10),
  stateRoot: hash(11), transactionsRoot: hash(12), receiptsRoot: hash(13), logsBloom: `0x${"00".repeat(256)}`,
  sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", uncles: [], extraData: "0x",
  withdrawals: [], withdrawalsRoot: hash(14), parentBeaconBlockRoot: hash(15), requestsHash: hash(16),
  blobGasUsed: "0x0", excessBlobGas: "0x0",
});
function bindHeader(sendWithControl: (method: string, params: unknown[], control?: unknown) => Promise<unknown>,
  activityReadFailed = (error: unknown): never => { throw error; }) {
  const dependencies = { activityTransport: { sendWithControl }, parseBlockScanObservedHeader, ethers, StateCallAbortedError,
    timedActivityRead: (_method: string, _number: number, read: () => Promise<unknown>) => read(), activityReadFailed,
    blockScanChainId: 1n, blockScanActivityProvider: {}, readBlockTouchedStateKeys, StartupActivityCollector,
    ADDR: {}, strictRuntimeRoot: {},
  };
  return new Function(...Object.keys(dependencies), `${js}; return { readContinuationHeader, readStartupHeader };`)(...Object.values(dependencies));
}

test("historical headers use the shared activity provider and retain the full canonical parser", async () => {
  const calls: unknown[][] = [];
  const { readStartupHeader } = bindHeader(async (method, params, control) => {
    calls.push([method, params, control]); return wireHeader(101);
  });
  const range = { previousSource: header(100) };
  const result = await readStartupHeader(101, range);
  assert.deepEqual(calls, [["eth_getBlockByNumber", ["0x65", true], range]]);
  assert.equal(result.number, 101);
  assert.equal(result.hash, hash(101));
  assert.deepEqual(result.transactionHashes, []);
  assert(result.passiveTouchedAddresses.length > 0);
  await assert.rejects(readStartupHeader(102, range), /height or timestamp mismatch/);
  const malformed = bindHeader(async () => ({ ...wireHeader(101), transactions: undefined }));
  await assert.rejects(malformed.readStartupHeader(101, range), /full activity anchors/);
  const failure = new Error("transport rejected");
  let observed: unknown;
  const rejected = bindHeader(async () => { throw failure; }, error => { observed = error; throw error; });
  await assert.rejects(rejected.readStartupHeader(101, range), error => error === failure);
  assert.equal(observed, failure, "transport failures retain the shared fatal/quota observer");
});

test("cancelled or expired historical reads never dispatch or publish a late header", async () => {
  for (const kind of ["signal", "deadline"] as const) {
    const controller = new AbortController();
    const range = { previousSource: header(100), signal: controller.signal, deadlineAtMs: Date.now() + 10_000 };
    let calls = 0, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const bound = bindHeader(async () => { calls++; await pending; return wireHeader(101); });
    const read = bound.readContinuationHeader(101, range);
    assert.equal(calls, 1);
    if (kind === "signal") controller.abort(); else range.deadlineAtMs = 0;
    const rejected = assert.rejects(read, (error: unknown) => error instanceof StateCallAbortedError && error.kind === kind);
    release(); await rejected;
    await assert.rejects(bound.readContinuationHeader(101, range), StateCallAbortedError);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const bound = bindHeader(async () => { calls++; return wireHeader(101); });
  for (const n of [-1, NaN, 1.5]) await assert.rejects(bound.readContinuationHeader(n, { previousSource: header(100) }), /invalid/);
  await assert.rejects(bound.readContinuationHeader(101, { previousSource: header(100), deadlineAtMs: NaN }), /invalid/);
  assert.equal(calls, 0);
});
