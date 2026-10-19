import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { createLiveSourceSimulationFactory, prepareForkExecutor } from "../main.js";
import { dryRunBotVmCodeOverrideEnabled, installForkBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import type { DaemonResponse, StrictSimulateRequest } from "../revm-sim-client.js";

const owner = "0x1000000000000000000000000000000000000001";
const executor = "0x00000000000000000000000000000000b07c0de5";
const runtime = Object.freeze({ code: "0x60006000f3", keccak256: ethers.keccak256("0x60006000f3") });
function provider(initial = "0x", readback?: unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  let code = initial;
  return { calls, reset() { code = "0x"; }, provider: {
    async getCode(address: string) { calls.push({ method: "getCode", params: [address] }); return code; },
    async send(method: string, params: unknown[]) {
      calls.push({ method, params });
      if (method === "anvil_setCode") code = String(params[1]);
      if (method === "eth_getCode") return readback === undefined ? code : readback;
      if (!["anvil_setCode", "anvil_setBalance", "anvil_impersonateAccount"].includes(method)) {
        assert.fail(`unexpected mutation ${method}`);
      }
      return null;
    },
  } as unknown as ethers.JsonRpcProvider };
}
test("default preparation preserves code check and exactly the two existing gas preparations", async () => {
  const p = provider("0x6000");
  await prepareForkExecutor(p.provider, owner, executor);
  assert.deepEqual(p.calls, [
    { method: "getCode", params: [executor] },
    { method: "anvil_setBalance", params: [ethers.getAddress(owner), "0x56bc75e2d63100000"] },
    { method: "anvil_impersonateAccount", params: [ethers.getAddress(owner)] },
  ]);
});
test("default missing executor fails before any mutation", async () => {
  const p = provider();
  await assert.rejects(prepareForkExecutor(p.provider, owner, executor), /has no code/);
  assert.deepEqual(p.calls.map(c => c.method), ["getCode"]);
});
test("override adds only exact code install before unchanged owner gas preparation", async () => {
  const p = provider();
  await prepareForkExecutor(p.provider, owner, executor, runtime);
  assert.deepEqual(p.calls, [
    { method: "anvil_setCode", params: [ethers.getAddress(executor), runtime.code] },
    { method: "eth_getCode", params: [ethers.getAddress(executor), "latest"] },
    { method: "anvil_setBalance", params: [ethers.getAddress(owner), "0x56bc75e2d63100000"] },
    { method: "anvil_impersonateAccount", params: [ethers.getAddress(owner)] },
  ]);
});
test("code-only helper never funds, impersonates or submits transactions", async () => {
  const p = provider();
  await installForkBotVmRuntimeCode(p.provider, executor, runtime);
  assert.deepEqual(p.calls.map(c => c.method), ["anvil_setCode", "eth_getCode"]);
});
test("each fork reset reinstalls the same frozen bytes without cached getCode", async () => {
  const p = provider();
  for (let i = 0; i < 2; i++) {
    p.reset(); await prepareForkExecutor(p.provider, owner, executor, runtime);
  }
  assert.equal(p.calls.filter(c => c.method === "getCode").length, 0);
  assert.deepEqual(p.calls.filter(c => c.method === "anvil_setCode").map(c => c.params[1]), [runtime.code, runtime.code]);
});
test("invalid frozen code fails before all RPC mutations", async () => {
  for (const value of [{ code: "0x", keccak256: ethers.keccak256("0x") },
    { code: runtime.code, keccak256: ethers.ZeroHash }, { code: "0x0", keccak256: ethers.ZeroHash }]) {
    const p = provider();
    await assert.rejects(prepareForkExecutor(p.provider, owner, executor, value));
    assert.deepEqual(p.calls, []);
  }
});
test("exact readback mismatch stops before funding or impersonation", async () => {
  for (const readback of ["0x", "0x6000", null]) {
    const p = provider("0x", readback);
    await assert.rejects(prepareForkExecutor(p.provider, owner, executor, runtime), /exact BotVM runtime/);
    assert.deepEqual(p.calls.map(c => c.method), ["anvil_setCode", "eth_getCode"]);
  }
});
test("existing flag gate only permits explicit dry-run with submission disabled", () => {
  assert.equal(dryRunBotVmCodeOverrideEnabled(undefined, true, false), false);
  assert.equal(dryRunBotVmCodeOverrideEnabled("0", true, false), false);
  assert.equal(dryRunBotVmCodeOverrideEnabled("1", true, false), true);
  for (const [flag, dryRun, submit] of [["1", false, false], ["1", true, true], ["invalid", true, false]] as const) {
    assert.throws(() => dryRunBotVmCodeOverrideEnabled(flag, dryRun, submit));
  }
});
test("actual live factory supplies frozen code to executor-program source simulations", async () => {
  const source = { number: 300, hash: `0x${"aa".repeat(32)}`, generation: 5 };
  const calls: StrictSimulateRequest[] = [];
  const factory = createLiveSourceSimulationFactory({ rpcUrl: "http://127.0.0.1:1", chainId: 1,
    // An existing path satisfies the production guard; injected client never spawns it.
    executablePath: fileURLToPath(import.meta.url), timeoutMs: 100, runtimeAbort: new AbortController(),
    executorRuntimeCode: runtime, onFatal() { assert.fail("unexpected fatal"); },
    createClient() { return { isTerminal: false, async strictSimulate(request) {
      calls.push(request);
      return { ok: true, success: true, output: "0x", gasUsed: "1", latencyMs: 0,
        sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: source.number,
          blockHash: source.hash, stateRoot: `0x${"bb".repeat(32)}`, parentHash: `0x${"cc".repeat(32)}` },
        strict: { outcome: { kind: "Success", phase: "main", output: "0x" }, executionGasUsed: "1",
          counterfactualExecutorCode: { address: executor, keccak256: runtime.keccak256 },
          nativeDeltas: [], tokenDeltas: [], totalSupplyDeltas: [], logs: [] } } as DaemonResponse;
    }, async closeAndDrain() {} }; },
  });
  const context = factory({ source, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 } });
  try {
    await context.transport.simulate({ source, callerAuthority: { executor, transactionOrigin: owner },
      request: { id: "executor-program", kind: "effect-delta-simulation",
        call: { caller: { kind: "executor" }, executionMode: "executor-program", to: executor,
          data: buildSubscriptCalldata(new Uint8Array([0])) },
        overrideIntent: { caller: { kind: "executor" } }, observe: ["return-data"] } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.executorRuntimeCode, runtime);
    assert.equal(calls[0]!.from, executor);
    assert.equal(calls[0]!.transactionOrigin, owner);
  } finally { await context.closeAndDrain(); }
});

test("factory without override keeps executor-program fail-closed before any client admission", async () => {
  const source = { number: 300, hash: `0x${"aa".repeat(32)}`, generation: 5 };
  const factory = createLiveSourceSimulationFactory({ rpcUrl: "http://127.0.0.1:1", chainId: 1,
    executablePath: fileURLToPath(import.meta.url), timeoutMs: 100, runtimeAbort: new AbortController(),
    onFatal() { assert.fail("unexpected fatal"); }, createClient() { assert.fail("must reject before client admission"); },
  });
  const context = factory({ source, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 } });
  try {
    await assert.rejects(context.transport.simulate({ source, callerAuthority: { executor, transactionOrigin: owner },
      request: { id: "executor-program", kind: "effect-delta-simulation",
        call: { caller: { kind: "executor" }, executionMode: "executor-program", to: executor,
          data: buildSubscriptCalldata(new Uint8Array([0])) },
        overrideIntent: { caller: { kind: "executor" } }, observe: ["return-data"] } }));
  } finally { await context.closeAndDrain(); }
});
