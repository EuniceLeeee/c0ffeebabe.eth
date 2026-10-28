import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { AbiCoder, Interface, getBytes, hexlify, keccak256, zeroPadValue } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { EthSimulateV1Simulator } from "../simulator/eth-simulate-v1.js";
import { compileStartupPrefix, startupPrefixReceipts, startupPrefixFailure,
  STARTUP_RECEIPT_TOPIC, type StartupPrefixLeg } from "../simulator/startup-prefix-program.js";
import { createStartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";
import type { BlockScanObservedHeader } from "../blockscan-observed-header.js";

const actor = `0x${"12".repeat(20)}`, owner = `0x${"34".repeat(20)}`;
const tokens = [ADDR.WETH, ...[5, 6, 7, 8, 9].map(n => `0x${String(n).repeat(40)}`)];
const ABI = new Interface(["function balanceOf(address) view returns(uint256)", "function mint(address,uint256)",
  "function burn(address,uint256)", "function deposit() payable"]);
const WORD = AbiCoder.defaultAbiCoder();
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
type Part = string | { label: string } | { pushLabel: string };
// Tiny token fixture only. Storage is balance[address], deliberately unlike a
// Solidity mapping. The tested path may not probe or override these slots.
function fixtureTokenCode(): string {
  const jump = (name: string): Part => ({ pushLabel: name });
  const mark = (name: string): Part => ({ label: name });
  const parts: Part[] = ["60003560e01c"];
  for (const name of ["balanceOf", "mint", "burn", "deposit"]) parts.push("8063" + ABI.getFunction(name)!.selector.slice(2) + "14", jump(name), "57");
  parts.push(mark("fail"), "60006000fd",
    mark("balanceOf"), "506004355460005260206000f3",
    mark("deposit"), "5033543401335560006000f3",
    mark("mint"), "5060043560005260243560205260005154602051016000515560006000f3",
    mark("burn"), "506004356000526024356020526020516000515410", jump("fail"), "57",
    "60205160005154036000515560006000f3");
  const labels = new Map<string, number>(); let at = 0;
  for (const part of parts) { if (typeof part !== "string" && "label" in part) labels.set(part.label, at); at += typeof part === "string" ? part.length / 2 : "label" in part ? 1 : 3; }
  return "0x" + parts.map(part => typeof part === "string" ? part : "label" in part ? "5b" :
    `61${labels.get(part.pushLabel)!.toString(16).padStart(4, "0")}`).join("");
}
function leg(index: number, divisor = 1n, fail = false): StartupPrefixLeg {
  const tokenIn = tokens[index]!, tokenOut = tokens[index + 1]!;
  const p = new RuntimeAmountProgram().call(tokenIn, ABI.encodeFunctionData("burn", [actor, 0]), { patches: [{ offset: 36, reg: 0 }] })
    .constant(1, divisor).math("div", 2, 0, 1)
    .call(tokenOut, fail ? "0xffffffff" : ABI.encodeFunctionData("mint", [actor, 0]),
      fail ? {} : { patches: [{ offset: 36, reg: 2 }] });
  return { tokenIn, tokenOut, program: hexlify(p.bytes()) };
}
const path = { amount: 100n, legs: Array.from({ length: 5 }, (_, i) => leg(i, i === 0 ? 2n : 1n)) };
const compiled = compileStartupPrefix(path, actor);
assert(compiled.scriptHex.startsWith("0x0e"));
assert.throws(() => compileStartupPrefix({ ...path, legs: [...path.legs, leg(0)] }, actor));
assert.throws(() => compileStartupPrefix({ ...path, legs: [leg(1)] }, actor));
assert.throws(() => compileStartupPrefix({ ...path, amount: 0n }, actor));
assert.equal(startupPrefixFailure("0x", undefined, word(7n), compiled), undefined);
const builtin = new Interface(["error Error(string)", "error Panic(uint256)"]);
for (const data of [builtin.encodeErrorResult("Error", ["ordinary execution revert"]),
  builtin.encodeErrorResult("Panic", [0x11]), "0x1234", "0x12345678"]) {
  assert.equal(startupPrefixFailure(data, undefined, word(7n), compiled), undefined,
    "ordinary and malformed reverts must remain unattributed, not stop screening");
}
assert.throws(() => startupPrefixReceipts([], compiled), /coverage/);

const child = spawn("anvil", ["--host", "127.0.0.1", "--port", "0", "--accounts", "0", "--no-mining",
  "--hardfork", "cancun", "--gas-limit", "60000000", "--base-fee", "1000000000"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "", spawnError: Error | undefined;
child.stdout.on("data", chunk => output += String(chunk)); child.stderr.on("data", chunk => output += String(chunk));
child.on("error", error => spawnError = error);
const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let proxy: ReturnType<typeof createServer> | undefined;
try {
  const until = Date.now() + 10_000;
  while (!/Listening on 127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError;
    assert(child.exitCode === null && Date.now() < until, "Anvil startup"); await delay(10);
  }
  const endpoint = `http://${output.match(/Listening on (127\.0\.0\.1:\d+)/)![1]}`;
  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    const data = await response.json() as any; assert.equal(data.error, undefined, JSON.stringify(data.error)); return data.result;
  };
  for (const token of tokens) {
    await rpc("anvil_setCode", [token, fixtureTokenCode()]);
    await rpc("anvil_setStorageAt", [token, zeroPadValue(actor, 32), word(1000n)]);
  }
  const rawHeader = await rpc("eth_getBlockByNumber", ["latest", false]);
  const header: BlockScanObservedHeader = { number: Number(BigInt(rawHeader.number)), hash: rawHeader.hash,
    parentHash: rawHeader.parentHash, timestamp: Number(BigInt(rawHeader.timestamp)),
    baseFeePerGas: BigInt(rawHeader.baseFeePerGas), gasUsed: BigInt(rawHeader.gasUsed), gasLimit: BigInt(rawHeader.gasLimit), transactionHashes: [] };
  const source = { number: header.number, hash: header.hash, generation: 1 };
  const requests: any[] = []; let wrongParent = false, fakeReceipt = false, throttle = false, quota = false;
  let normalizedAnvilParent = false;
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ ...request, at: performance.now() });
        if (throttle) { throttle = false; res.writeHead(429); res.end("rate limited"); return; }
        if (quota) { res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32005, message: "monthly quota exhausted" } })); return; }
        const result = await rpc(request.method, request.params);
        if (request.method === "eth_simulateV1") {
          assert.equal(request.params[1].blockHash, source.hash);
          assert.equal(request.params[0].blockStateCalls[0].calls.length, 1, "whole path must be one transaction");
          const overrides = request.params[0].blockStateCalls[0].stateOverrides;
          assert(tokens.every(token => !Object.keys(overrides).some(a => a.toLowerCase() === token.toLowerCase())), "no intermediate token overrides");
          assert.equal(BigInt(overrides[actor].balance), 100n);
          // Anvil 1.7.1 omits the simulated parent. Normalize only that known
          // test-provider field; wrong-parent regression below keeps production
          // source checking strict. All EVM call results remain untouched.
          if (result[0].parentHash === word(0n)) { normalizedAnvilParent = true; result[0].parentHash = source.hash; }
          const main = result[0].calls[0];
          if (main.status === "0x0" && main.error?.code === -3200) {
            assert.equal(main.error.message, "execution failed");
            const selector = new Interface(["error RuntimeHopFailed(uint256,address,bytes32,bytes,bytes32)"])
              .getError("RuntimeHopFailed")!.selector;
            assert.equal(main.returnData.slice(0, 10), selector, "only normalize our real EVM diagnostic revert");
            main.error.code = 3;
          }
          if (wrongParent) result[0].parentHash = word(9n);
          if (fakeReceipt) result[0].calls[0].logs = [{ address: compiled.recorder,
            topics: [STARTUP_RECEIPT_TOPIC], data: WORD.encode(["uint256", "uint256", "uint256"], [0, 100, 100]) }];
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      } catch (error) { console.error("local-only fixture failure", error); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32099, message: String(error) } })); }
    });
  });
  await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(proxy.address() as any).port}`;
  const runtime = loadBotVmRuntimeCode(owner);
  const simulator = new EthSimulateV1Simulator(url, actor, owner, runtime);
  const control = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 });
  const result = await simulator.simulateStartupPrefix({ ...path, source, header }, control());
  assert.equal(result.kind, "success", JSON.stringify(result, (_, v) => typeof v === "bigint" ? String(v) : v));
  assert.deepEqual(result.receipts.map(r => [r.hop, r.amountIn, r.amountOut]),
    [[-1, 100n, 100n], [0, 100n, 50n], [1, 50n, 50n], [2, 50n, 50n], [3, 50n, 50n], [4, 50n, 50n]]);
  assert.equal(result.receipts.at(-1)!.amountIn, 50n, "use real prefix receipt, not old 100 input");
  const again = await simulator.simulateStartupPrefix({ ...path, source, header }, control());
  assert.deepEqual(again.receipts, result.receipts); assert.equal(again.gasUsed, result.gasUsed);
  assert.equal(await rpc("eth_getStorageAt", [tokens[1], zeroPadValue(actor, 32), "latest"]), word(1000n), "simulation must not persist state");
  for (const failedHop of [0, 2, 4]) {
    const legs = path.legs.map((value, i) => i === failedHop ? leg(i, 1n, true) : value);
    const rejected = await simulator.simulateStartupPrefix({ ...path, legs, source, header }, control());
    assert.equal(rejected.kind, "revert"); assert.equal(rejected.failure?.hop, failedHop);
    assert.deepEqual(rejected.receipts, [], "reverted transaction cannot fabricate retained receipts");
    const failedProgram = compileStartupPrefix({ ...path, legs }, actor);
    const key = requests.at(-1).params[0].blockStateCalls[0].stateOverrides[actor].stateDiff[HOP_DIAGNOSTIC_SLOT];
    assert.equal(startupPrefixFailure(rejected.returnData, undefined, key, failedProgram)?.hop, failedHop);
    assert.equal(startupPrefixFailure(rejected.returnData, undefined, word(1n), failedProgram), undefined, "forged hop proof is not attribution");
  }
  const noPrefix = await simulator.simulateStartupPrefix({ amount: 100n, legs: [], source, header }, control());
  assert.deepEqual(noPrefix.receipts, [{ hop: -1, amountIn: 100n, amountOut: 100n }]);
  wrongParent = true;
  await assert.rejects(simulator.simulateStartupPrefix({ ...path, source, header }, control()), /header mismatch/); wrongParent = false;
  fakeReceipt = true;
  await assert.rejects(simulator.simulateStartupPrefix({ ...path, source, header }, control()), /receipt/); fakeReceipt = false;
  const dispatch = createStartupNodeSimulation({ rpcUrl: url, chainId: 31337n, executor: actor, transactionOrigin: owner,
    executorRuntimeCode: runtime, scheduler: new RethTransportScheduler({ capacity: 8, producerReserved: 4,
      retryDelayMs: 5, maxRetryDelayMs: 10 }), requestsPerSecond: 50 });
  const invoke = () => dispatch({ ...path, source, control: control(), callerAuthority: { executor: actor, transactionOrigin: owner } });
  const first = requests.length;
  await Promise.all(Array.from({ length: 8 }, invoke));
  const dispatched = requests.slice(first);
  assert.equal(dispatched.filter(r => r.method === "eth_getBlockByNumber").length, 1);
  assert.equal(dispatched.filter(r => r.method === "eth_simulateV1").length, 8);
  assert(dispatch.stats().maxCuIn1000Ms <= 2000);
  assert(dispatched.every(r => ["eth_getBlockByNumber", "eth_simulateV1"].includes(r.method)), "no balance probing or REVM");
  let before = requests.length;
  throttle = true; await invoke();
  assert.equal(requests.length, before + 2, "retry must consume another paced permit");
  before = requests.length; quota = true;
  await assert.rejects(invoke(), /quota exhausted/);
  assert.equal(requests.length, before + 1, "spent quota must not retry"); quota = false;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(dispatch({ ...path, source, control: { ...control(), signal: aborted.signal },
    callerAuthority: { executor: actor, transactionOrigin: owner } }));
  await assert.rejects(dispatch({ ...path, source, control: control(), callerAuthority: { executor: actor, transactionOrigin: tokens[1]! } }), /authority/);
  await rpc("anvil_setCode", [ADDR.WETH, "0x60006000fd"]);
  const unfunded = await simulator.simulateStartupPrefix({ ...path, source, header }, control());
  assert.equal(unfunded.failure?.hop, -1, "initial wrapping failure is not a target failure");
  console.log(JSON.stringify({ test: "startup-prefix-node", result: "pass", actualReceiptPropagation: true,
    oneTransaction: true, noTokenOverrides: true, authenticatedFailureHops: [0, 2, 4],
    normalizedAnvilParent, strictWrongParentRejected: true, stats: dispatch.stats() }));
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
  child.kill("SIGTERM"); await exited;
}
