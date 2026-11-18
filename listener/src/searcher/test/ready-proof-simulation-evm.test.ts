import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { AbiCoder, JsonRpcProvider } from "ethers";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { createNodeStrictSourceSimulation } from "../node-strict-source-simulation.js";
import { createReadyProofSimulation } from "../ready-proof-simulation.js";
import { createStrictCentralAdapterRuntime, type StrictSimulationTransport } from "../strict-central-adapter-runtime.js";

/** Explicit diagnostic trace test on a fresh loopback chain. This does not
 * change the trace-free selector Ready/startup path or attest a production TX. */
test("local EVM executes a declared proof actor and actual executor with the same source-owned simulator", {
  skip: process.env.READY_PROOF_EVM_TEST !== "1", timeout: 60_000,
}, async t => {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const endpoint = socket.address(); assert(endpoint && typeof endpoint !== "string");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil",
    ["--host", "127.0.0.1", "--port", String(endpoint.port), "--chain-id", "31337", "--hardfork", "cancun", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let spawnError: Error | undefined, stderr = "";
  child.once("error", error => { spawnError = error; });
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
  const rpcUrl = `http://127.0.0.1:${endpoint.port}`, provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const contexts: { closeAndDrain(): Promise<void> }[] = [];
  t.after(async () => {
    try { await Promise.allSettled(contexts.map(context => context.closeAndDrain())); }
    finally {
      provider.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await stopped;
      }
    }
  });
  let online = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`local anvil stopped: ${stderr}`);
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(500) });
      online = (await response.json() as { result?: string }).result === "0x7a69"; if (online) break;
    } catch { /* Retry only startup of this test-owned process. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(online, `local node unavailable: ${stderr}`);
  const owner = (await (await provider.getSigner(0)).getAddress()).toLowerCase();
  const executor = `0x${"11".repeat(20)}`, actor = "0x000000000000000000000000000000000000face";
  const target = `0x${"33".repeat(20)}`, occupied = `0x${"44".repeat(20)}`;
  const runtimeCode = loadBotVmRuntimeCode(owner);
  await provider.send("anvil_setCode", [executor, runtimeCode.code]);
  // A real EVM program returns its CALLER and ORIGIN in two ABI words.
  await provider.send("anvil_setCode", [target, "0x336000523260205260406000f3"]);
  await provider.send("anvil_setCode", [occupied, "0x600160005260206000f3"]);
  await provider.send("evm_mine", []);
  const header = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const source = { number: Number(BigInt(header.number)), hash: header.hash.toLowerCase(), generation: 1 };
  const createFrame = (address: string, code: typeof runtimeCode, override: boolean) => createNodeStrictSourceSimulation({
    identity: { source, rpcUrl, chainId: 31337, stateRoot: header.stateRoot }, timeoutMs: 15_000,
    executionGasLimit: 0x1000000, executor: address, executorRuntimeCode: code, allowExecutorCodeOverride: override,
    simulationMethod: "debug_traceCall", tracePolicy: "allow", onFatal(reason) { assert.fail(JSON.stringify(reason)); },
  });
  const primary = createFrame(executor, runtimeCode, false), created: string[] = [];
  contexts.push(primary);
  const simulation = createReadyProofSimulation({ source, executor, transactionOrigin: owner,
    verifiedActors: { proof: actor, occupied }, executorRuntimeCode: runtimeCode, primary, assertOpen() {},
    readCode: (address, at) => provider.send("eth_getCode", [address, { blockHash: at.hash, requireCanonical: true }]),
    createProof(address, code, override) { created.push(address); return createFrame(address, code, override); },
  });
  contexts.push(simulation);
  function invocation(role: "proof" | "occupied" | "executor"): Parameters<StrictSimulationTransport["simulate"]>[0] {
    const caller = role === "executor" ? { kind: "executor" as const } : { kind: "verified-actor" as const, evidenceId: role };
    return { source, callerAuthority: { executor, transactionOrigin: owner, verifiedActors: { proof: actor, occupied } },
      request: { id: "caller-origin-proof", required: true, kind: "effect-delta-simulation",
        call: { caller, executionMode: "impersonated-call-frame", to: target, data: "0x1234" },
        overrideIntent: { caller }, observe: ["return-data"] } };
  }
  await assert.rejects(primary.transport.simulate(invocation("proof")), /strict simulation transport failed/,
    "the original single-executor path rejects this source-pinned proof actor");
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner, verifiedActors: { proof: actor, occupied },
    provider: { call: async () => assert.fail("unexpected provider call"), getCode: async () => assert.fail("unexpected provider read"), getStorage: async () => assert.fail("unexpected storage read") },
    simulator: simulation.transport, generationFence: { assertCurrent(generation, at) { assert.equal(generation, source.generation); assert.deepEqual(at, source); } },
  });
  for (const [role, expected] of [["proof", actor], ["executor", executor]] as const) {
    const inv = invocation(role), result = await executeAdapterWork({ runtime, intent: {
      stage: "runtime-evidence", familyId: "test:proof-evm" as never, source, generation: source.generation, programInput: undefined,
      program: { requirements: () => ({ transports: [inv.request.kind], caller: inv.request.call.caller.kind, effects: inv.request.observe }),
        buildRequests: () => [inv.request], decode: ({ results }) => results },
    } });
    assert.equal(result.status, "resolved", JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value));
    if (result.status === "resolved") {
      const receipt = result.executed.evidence[0]; assert(receipt?.ok);
      assert.equal(receipt.data, AbiCoder.defaultAbiCoder().encode(["address", "address"], [expected, owner]));
      assert.deepEqual(receipt.source, source);
    }
  }
  await assert.rejects(simulation.transport.forRequest!(invocation("occupied")), /different deployed code at source/);
  assert.deepEqual(created, [actor]);
  assert.equal(await provider.send("eth_getCode", [actor, "latest"]), "0x", "proof code exists only inside the isolated simulation");
  assert.equal(await provider.send("eth_getCode", [executor, "latest"]), runtimeCode.code);
});
