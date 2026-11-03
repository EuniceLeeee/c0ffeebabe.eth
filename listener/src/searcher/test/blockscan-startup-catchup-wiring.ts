import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readBlockTouchedStateKeys } from "../blockscan-touched-state.js";

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
    const dependencies = { readBlockScanObservedHeader: async (_url: string, _chain: bigint, n: number) =>
      n === missing ? { ...header(n), passiveTouchedAddresses: undefined } : header(n),
      config: { rpcUrl: "fixture" }, blockScanChainId: 1n, activityReadFailed: (error: unknown) => { throw error; },
      blockScanActivityProvider: provider, readBlockTouchedStateKeys, ADDR: { UNISWAP_V4_POOL_MANAGER: `0x${"1".repeat(40)}` },
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
