import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { ContractFactory, Interface, JsonRpcProvider, keccak256, type Contract } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { createNodeFundingCache } from "../simulator/node-input-funding.js";
import { RevmStrictError } from "../revm-sim-client.js";

/** Actual isolated EVM acceptance. The HTTP proxy poisons every trace method;
 * synthetic/mock node receipts are not used in this test. */
test("local EVM: cold-source funded canonical execution measures balances without any trace RPC", {
  skip: process.env.NODE_TRACE_POLICY_EVM_TEST !== "1", timeout: 240_000,
}, async t => {
  const require = createRequire(import.meta.url), solc = require(process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
  const root = new URL("../../../../", import.meta.url), fixture = "listener/src/searcher/test/fixtures/SelectorExecutionFixture.sol";
  const files = ["src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
    "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol", fixture];
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(new URL(file, root), "utf8") }])),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  assert.deepEqual((compiled.errors ?? []).filter((error: { severity: string }) => error.severity === "error"), []);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  // Existing BotVM is above EIP-170 in this build. This explicit local limit
  // relaxation is not production deployment or mainnet-fork evidence.
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--hardfork", "cancun", "--disable-code-size-limit", "--silent"], { stdio: "ignore" });
  let startupError: Error | undefined; child.once("error", error => { startupError = error; });
  const rpcUrl = `http://127.0.0.1:${port}`, provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const clients: NodeStrictClient[] = [], counts: Record<string, number> = {};
  const allowed = new Set(["eth_getBlockByHash", "eth_chainId", "eth_getCode", "eth_call", "eth_createAccessList", "eth_getStorageAt"]);
  const proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), q = JSON.parse(body);
    counts[q.method] = (counts[q.method] ?? 0) + 1;
    if (!allowed.has(q.method)) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "read-only trace-poisoned local proxy" } })); return;
    }
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(10_000) });
      res.statusCode = response.status; res.end(await response.text());
    } catch { res.statusCode = 502; res.end("{}"); }
  });
  t.after(async () => {
    try { await Promise.allSettled(clients.map(client => client.closeAndDrain())); }
    finally {
      await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
      provider.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed;
      }
    }
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error("local anvil stopped");
    try {
      const result = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(500) });
      if ((await result.json() as { result?: string }).result === "0x7a69") { ready = true; break; }
    } catch { /* Only retry startup of this new loopback process. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready); await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const owner = await provider.getSigner(0), origin = (await owner.getAddress()).toLowerCase();
  const deploy = async (file: string, name: string, args: readonly unknown[] = []) => {
    const artifact = compiled.contracts[file][name];
    const result = await new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, owner).deploy(...args);
    await result.waitForDeployment(); return result as unknown as Contract;
  };
  const input = await deploy(fixture, "SelectorExecutionToken"), output = await deploy(fixture, "SelectorExecutionToken");
  const executor = await deploy("src/BotVM.sol", "BotVM");
  const tokenIn = (await input.getAddress()).toLowerCase(), tokenOut = (await output.getAddress()).toLowerCase();
  const actor = (await executor.getAddress()).toLowerCase(), target = await deploy(fixture, "SelectorExecutionAlpha", [tokenIn, tokenOut]);
  const venue = (await target.getAddress()).toLowerCase(), pool = "0x" + "12".repeat(32), amount = 1234n;
  const transact = async (c: Contract, method: string, args: readonly unknown[]) => {
    assert.equal((await (await c.getFunction(method)(...args)).wait())?.status, 1);
  };
  await transact(input, "mint", [actor, 77n]); await transact(output, "mint", [venue, 100_000n]);
  const tokenAbi = new Interface(["function approve(address,uint256) returns(bool)"]);
  const actionAbi = new Interface(["function convertByShape(bytes32,uint256,address) returns(uint256)"]);
  const dataFor = (id: string) => buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram()
    .call(tokenIn, tokenAbi.encodeFunctionData("approve", [venue, amount]))
    .call(venue, actionAbi.encodeFunctionData("convertByShape", [id, amount, actor]))
    .call(tokenIn, tokenAbi.encodeFunctionData("approve", [venue, 0n])).bytes(), amount));
  const code = await provider.getCode(actor), fundingCache = createNodeFundingCache();
  const executorRuntimeCode = { code, keccak256: keccak256(code) };
  for (const [index, rate] of [3n, 5n].entries()) {
    await transact(target, "setRate", [pool, rate]);
    const header = await provider.send("eth_getBlockByNumber", ["latest", false]);
    const client = new NodeStrictClient({ timeoutMs: 10_000, executor: actor, executorRuntimeCode,
      tracePolicy: "forbid", fundingCache }); clients.push(client);
    const request = { rpcUrl: proxyUrl, blockNumber: Number(BigInt(header.number)),
      sourcePin: { blockHash: header.hash, stateRoot: header.stateRoot, chainId: 31337 },
      from: actor, to: actor, callerMode: "impersonated-call-frame" as const, transactionOrigin: origin, data: dataFor(pool),
      tokenDeals: [{ token: tokenIn, to: actor, amount: String(amount) }],
      observeTokenBalances: [{ token: tokenIn, account: actor }, { token: tokenOut, account: actor }], observeNativeBalances: [actor] };
    const result = await client.strictSimulate(request);
    assert.equal(result.success, true); assert.equal(result.strict?.outcome.kind, "Success");
    assert.deepEqual(result.strict?.tokenDeltas, [{ token: tokenIn, account: actor, delta: String(-amount) },
      { token: tokenOut, account: actor, delta: String(amount * rate + 7n) }]);
    assert.equal(result.strict?.nativeDeltas[0]?.delta, "0");
    assert.equal(counts.eth_createAccessList, (index + 1) * 2, "each new source independently observes both accounts");
    assert.equal(counts.eth_getStorageAt, (index + 1) * 2);
    // Real protocol revert cannot be promoted to a completed negative control
    // merely because the outer wrapper returned revert-shaped bytes.
    await assert.rejects(client.strictSimulate({ ...request, data: dataFor("0x" + "00".repeat(32)) }),
      error => error instanceof RevmStrictError && error.kind === "observation");
    await client.closeAndDrain();
  }
  assert.equal(await input.getFunction("balanceOf")(actor), 77n);
  assert.equal(await output.getFunction("balanceOf")(actor), 0n);
  assert(!Object.keys(counts).some(method => method.startsWith("debug_") || method.startsWith("trace_")));
  t.diagnostic(JSON.stringify({ chainId: 31337, tracePolicy: "forbid", codeSizeLimitDisabled: true,
    executorRuntimeBytes: (code.length - 2) / 2, counts, sources: 2, realProtocolRevertsRemainIncomplete: 2 }));
});
