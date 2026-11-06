import assert from "node:assert/strict";
import { ethers } from "ethers";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../revm-strict-source-simulation.js";
import { RevmSimClient } from "../revm-sim-client.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

/** Source-pinned, read-only local EVM. Only absent executor code can be overlaid. */
export async function openHistoricalFamilyEvm(provider: ethers.JsonRpcProvider, rpcUrl: string,
  source: CanonicalSource, executor: string, owner: string) {
  const header = await provider.send("eth_getBlockByHash", [source.hash, false]);
  assert.equal(Number(BigInt(header.number)), source.number);
  assert.equal(header.hash.toLowerCase(), source.hash.toLowerCase());
  const runtimeCode = loadBotVmRuntimeCode(owner);
  const pin = { blockHash: source.hash, requireCanonical: true };
  const historicalCode = await provider.send("eth_getCode", [executor, pin]);
  assert(historicalCode === "0x" || historicalCode.toLowerCase() === runtimeCode.code.toLowerCase(),
    "refuse replacing unrelated historical executor code");
  const historicalOwner = await provider.send("eth_getCode", [owner, pin]);
  assert(historicalOwner === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(historicalOwner), "refuse unexpected origin code");
  const abort = new AbortController();
  const control = { signal: abort.signal, deadlineAtMs: Date.now() + 240_000 };
  const simulation = createRevmStrictSourceSimulation({
    identity: { source, chainId: 1, rpcUrl, stateRoot: header.stateRoot },
    executorRuntimeCode: runtimeCode, executionGasLimit: 0x1000000, control,
    createClient: ({ onFatal }) => new RevmSimClient({
      executablePath: process.env.SEARCHER_REVM_SIM_BIN, timeoutMs: 85_000, onFatal,
    }),
    onFatal: () => abort.abort(new Error("source-bound receipt simulation failed")),
  });
  const runtime = createStrictCentralAdapterRuntime({
      simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(generation, current) {
        abort.signal.throwIfAborted(); assert.equal(generation, source.generation); assert.deepEqual(current, source);
      } },
      provider: {
        call: async ({ blockTag, ...tx }, n) => {
          assert.equal(blockTag ?? n, source.number);
          return provider.send("eth_call", [tx, pin]);
        },
        getCode: async (address, n) => {
          assert.equal(n, source.number); return provider.send("eth_getCode", [address, pin]);
        },
        getStorage: async (address, slot, n) => {
          assert.equal(n, source.number); return provider.send("eth_getStorageAt", [address, slot, pin]);
        },
      },
    });
  return { runtime, control, runtimeCode, historicalCode, close: () => simulation.closeAndDrain() };
}
