import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer as createSocket } from "node:net";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AbiCoder, ContractFactory, Interface, JsonRpcProvider, getBytes, hexlify, keccak256, toBeHex } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { compileStartupPrefix, startupPrefixReceipts, startupPrefixFailure } from "../simulator/startup-prefix-program.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { buildNodeProgramQuote } from "../simulator/node-program-quote.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";

/** Actual local EVM execution. Raw V1 compatibility is tested independently;
 * no response parent hash, receipt, balance or log is rewritten by the proxy. */
test("local EVM: shared four/six-hop preparation, actual debit and trace-free prefix receipts", {
  skip: process.env.STARTUP_FUNDING_EVM_TEST !== "1", timeout: 120_000,
}, async t => {
  const root = new URL("../../../../", import.meta.url), require = createRequire(import.meta.url);
  const solc = require(process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
  const fixture = "listener/src/searcher/test/fixtures/FundingPreparationToken.sol";
  const files = [fixture, "src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
    "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol"];
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(new URL(file, root), "utf8") }])),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
  assert.deepEqual((compiled.errors ?? []).filter((error: { severity: string }) => error.severity === "error"), []);
  const tokenCode = "0x" + compiled.contracts[fixture].FundingPreparationToken.evm.deployedBytecode.object;
  const socket = createSocket(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--hardfork", "cancun", "--disable-code-size-limit", "--gas-limit", "60000000", "--silent"], { stdio: "ignore" });
  let startError: Error | undefined; child.once("error", error => { startError = error; });
  const url = `http://127.0.0.1:${port}`, provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const clients: NodeStrictClient[] = [], counts: Record<string, number> = {};
  const proxy = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString(), request = JSON.parse(body);
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    if (request.method.startsWith("debug_") || request.method.startsWith("trace_")) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "trace poisoned" } })); return;
    }
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(10_000) });
      res.statusCode = response.status; res.end(await response.text());
    } catch { res.statusCode = 502; res.end("{}"); }
  });
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.closeAndDrain()));
    await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
    provider.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed;
    }
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (startError) throw startError;
    try { if (await provider.send("eth_chainId", []) === "0x7a69") { ready = true; break; } } catch { /* new loopback process */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready);
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const signer = await provider.getSigner(0), owner = (await signer.getAddress()).toLowerCase();
  const artifact = compiled.contracts["src/BotVM.sol"].BotVM;
  const executor = await new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, signer).deploy();
  await executor.waitForDeployment(); const actor = (await executor.getAddress()).toLowerCase();
  const code = await provider.getCode(actor), runtime = { code, keccak256: keccak256(code) };
  assert.equal(getBytes(runtime.code).length, artifact.evm.deployedBytecode.object.length / 2);
  assert.equal(keccak256(await provider.getCode(actor)), runtime.keccak256);
  const tokens = [ADDR.WETH.toLowerCase(), ...Array.from({ length: 8 }, (_, i) => toBeHex(500 + i, 20))];
  const abi = new Interface(["function balanceOf(address) view returns(uint256)", "function mint(address,uint256)", "function burn(address,uint256)"]);
  const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [actor, 0]));
  for (const token of tokens) {
    await provider.send("anvil_setCode", [token, tokenCode]);
    await provider.send("anvil_setStorageAt", [token, slot, toBeHex(100_000n, 32)]);
  }
  await provider.send("evm_mine", []);
  const balance = async (token: string) => BigInt(await provider.call({ to: token, data: abi.encodeFunctionData("balanceOf", [actor]) }));
  const send = async (data: string) => {
    const receipt = await (await signer.sendTransaction({ to: actor, data, gasLimit: 16_777_216 })).wait();
    assert.equal(receipt?.status, 1); return receipt!;
  };
  const leg = (i: number, fail = false) => ({ tokenIn: tokens[i]!, tokenOut: tokens[i + 1]!,
    program: hexlify(new RuntimeAmountProgram().constant(1, 7n).math("sub", 2, 0, 1)
      .call(tokens[i]!, abi.encodeFunctionData("burn", [actor, 0n]), { patches: [{ offset: 36, reg: 2 }] })
      .constant(1, 2n).math("mul", 3, 0, 1)
      .call(tokens[i + 1]!, fail ? "0xffffffff" : abi.encodeFunctionData("mint", [actor, 0n]),
        fail ? {} : { patches: [{ offset: 36, reg: 3 }] }).bytes()) });
  const summaries: Record<string, unknown>[] = [];
  for (const hops of [4, 6]) {
    const snapshot = await provider.send("evm_snapshot", []);
    const input = { amount: 100n, maxInputPathHops: hops, legs: Array.from({ length: hops + 1 }, (_, i) => leg(i)) };
    const program = compileStartupPrefix(input, actor);
    await provider.send("anvil_setBalance", [actor, "0x64"]);
    await provider.send("anvil_setCode", [program.recorder, program.recorderCode]);
    const result = await send(buildExecuteCalldata(getBytes(program.scriptHex)));
    const receipts = startupPrefixReceipts(result.logs, program);
    assert.equal(receipts.length, hops + 2);
    for (let i = 0; i <= hops; i++) {
      const actual = receipts[i + 1]!, budget = 100n * 2n ** BigInt(i);
      assert.deepEqual(actual, { hop: i, amountIn: budget, amountSpent: budget - 7n, amountOut: budget * 2n });
      assert.equal(await balance(tokens[i]!), 100_007n, "only the routed budget is spent; old inventory stays intact");
    }
    assert.equal(await balance(tokens[hops + 1]!), 100_000n + 100n * 2n ** BigInt(hops + 1));
    summaries.push({ maxInputPathHops: hops, actualLegs: hops + 1, initialFundingOnly: true,
      targetBudget: String(receipts.at(-1)!.amountIn), targetSpent: String(receipts.at(-1)!.amountSpent),
      targetOutput: String(receipts.at(-1)!.amountOut), fundingContext: program.fundingContext });
    assert.equal(await provider.send("evm_revert", [snapshot]), true);
  }
  // Existing executors accept diagnostic tags 0..5. The startup compiler uses
  // tag zero with a distinct authenticated flow hash per logical leg, so a
  // sixth preparation leg remains distinguishable from initial funding.
  const failureHops: number[] = [];
  for (const failedHop of [5, -1]) {
    const snapshot = await provider.send("evm_snapshot", []), key = toBeHex(0xd1a6n, 32);
    const input = { amount: 100n, maxInputPathHops: 6,
      legs: Array.from({ length: 7 }, (_, i) => leg(i, i === failedHop)) };
    const program = compileStartupPrefix(input, actor);
    await provider.send("anvil_setBalance", [actor, "0x64"]);
    await provider.send("anvil_setStorageAt", [actor, HOP_DIAGNOSTIC_SLOT, key]);
    await provider.send("anvil_setCode", [program.recorder, program.recorderCode]);
    if (failedHop === -1) await provider.send("anvil_setCode", [tokens[0], "0x60006000fd"]);
    const raw = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: owner, to: actor,
        data: buildExecuteCalldata(getBytes(program.scriptHex)), gas: "0xffffff" }, "latest"] }) })).json() as {
      error?: { data?: string }; result?: unknown;
    };
    assert.equal(typeof raw.error?.data, "string", "actual EVM must supply an authenticated revert envelope");
    const revert = raw.error!.data!;
    assert.equal(startupPrefixFailure(revert, undefined, key, program)?.hop, failedHop);
    assert.equal(startupPrefixFailure(revert, undefined, toBeHex(1, 32), program), undefined, "wrong key cannot attribute a hop");
    const differentFlow = compileStartupPrefix({ ...input, amount: 101n }, actor);
    assert.equal(startupPrefixFailure(revert, undefined, key, differentFlow), undefined, "another flow cannot borrow attribution");
    failureHops.push(failedHop);
    assert.equal(await provider.send("evm_revert", [snapshot]), true);
  }
  // Same actual program, isolated source-N call, one initial token funding.
  const prefix = buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram()
    .call(tokens[1]!, abi.encodeFunctionData("burn", [actor, 100n]))
    .call(tokens[2]!, abi.encodeFunctionData("mint", [actor, 200n])).bytes(), 100n));
  const target = buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram()
    .call(tokens[2]!, abi.encodeFunctionData("burn", [actor, 190n]))
    .call(tokens[3]!, abi.encodeFunctionData("mint", [actor, 400n])).bytes(), 200n));
  const header = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const client = new NodeStrictClient({ timeoutMs: 15_000, executor: actor, executorRuntimeCode: runtime, tracePolicy: "forbid" });
  clients.push(client);
  const request = { rpcUrl: proxyUrl, blockNumber: Number(BigInt(header.number)),
    sourcePin: { blockHash: header.hash, stateRoot: header.stateRoot, chainId: 31337 },
    from: actor, to: actor, callerMode: "impersonated-call-frame" as const, transactionOrigin: owner, data: target,
    trialPrefix: { executor: actor, calldata: prefix, inputToken: tokens[1]!, inputAmount: "100", executorRuntimeCode: runtime },
    observeTokenBalances: [1, 2, 3].map(i => ({ token: tokens[i]!, account: actor })) };
  const response = await client.strictSimulate(request);
  assert.equal(response.success, true);
  assert.deepEqual(response.strict!.tokenDeltas.map(value => BigInt(value.delta)), [0n, -190n, 400n]);
  for (const token of tokens) assert.equal(await balance(token), 100_000n, "eth_call leaves all source balances unchanged");

  // Execute the persistent recorder with actual EVM logs. This proves marker
  // bytecode and target-only attribution without rewriting a V1 wire response.
  const quote = buildNodeProgramQuote({ executor: actor, calls: [{ to: actor, data: prefix }, { to: actor, data: target }],
    observations: [1, 2, 3].map(i => ({ kind: "token" as const, token: tokens[i]!, account: actor })),
    baselineAfterPrefix: true, terminalRevert: false, persistent: true, prefixLogBoundary: true });
  const snapshot = await provider.send("evm_snapshot", []);
  await provider.send("anvil_setStorageAt", [tokens[1], slot, toBeHex(100_100n, 32)]);
  await provider.send("anvil_setCode", [quote.recorder, quote.code]);
  const observed = await send(quote.data);
  const index = observed.logs.findIndex(log => log.address.toLowerCase() === quote.recorder);
  assert.equal(index, 2, "prefix burn/mint logs precede exactly one authenticated boundary");
  assert.deepEqual(observed.logs[index]!.topics, [quote.prefixLogBoundaryTopic]);
  assert.deepEqual(observed.logs.slice(index + 1).map(log => log.address.toLowerCase()), [tokens[2], tokens[3]]);
  const measured = quote.read(await provider.call({ from: actor, to: quote.recorder, data: "0x00000002" }));
  assert.deepEqual(measured.before, [100_000n, 100_200n, 100_000n]);
  assert.deepEqual(measured.after, [100_000n, 100_010n, 100_400n]);
  assert.equal(await provider.send("evm_revert", [snapshot]), true);

  // This bundled Anvil returns parentHash=0 for raw V1. Preserve that actual
  // provider limitation; strict clients must reject it rather than normalizing.
  const v1 = new NodeStrictClient({ timeoutMs: 15_000, executor: actor, executorRuntimeCode: runtime,
    tracePolicy: "forbid", simulationMethod: "eth_simulateV1" }); clients.push(v1);
  await assert.rejects(v1.strictSimulate(request), /header mismatch/);
  assert.equal(Object.keys(counts).some(method => method.startsWith("debug_") || method.startsWith("trace_")), false);
  t.diagnostic(JSON.stringify({ scope: "local-EVM-only; strict V1 transport remains incompatible with bundled Anvil",
    runtimeBytes: getBytes(runtime.code).length, runtimeCodeHash: runtime.keccak256, codeSizeLimitRelaxed: true,
    nativePrefix: summaries, sourceNPrefix: { initialFundingOnly: true, deltas: ["0", "-190", "400"], sourceUnchanged: true },
    prefixBoundaryActualEvm: true, authenticatedFailureHops: failureHops,
    rawV1Rejected: true, rpcCounts: counts, traceRequests: 0 }));
});
