/** Fixed competitor-call compiler comparison. No search, Ready admission,
 * production policy change, private key or remote transaction submission.
 * Only task-owned loopback Anvil accepts impersonated unsigned test calls. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { ethers } from "ethers";
import "../src/adapters/index.js";
import { compilePlan } from "../src/compiler.js";
import { buildRawExecuteCalldata } from "../src/shared/executor/botvm-executor.js";
import { RuntimeAmountProgram as P, runtimeProgramScript, runtimeCallSequenceScript, runtimeSettlementFlowHash } from "../src/adapters/runtime-amount-program.js";
import type { ResolvedPlanNode } from "../src/types.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
const required = (name: string) => { const value = args.get(name); assert(value, name); return resolve(value); };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const txPath = required("--tx"), tracePath = required("--trace"), candidatePath = required("--candidate");
const huffPath = required("--huff"), out = required("--out");
const huffRawPath = args.has("--huff-raw") ? required("--huff-raw") : undefined;
mkdirSync(out, { recursive: true });
const lock = openSync(resolve(out, "run-lock"), "wx"); closeSync(lock);
const save = (name: string, data: unknown) => writeFileSync(resolve(out, name),
  JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tx = read(txPath).result, historicalTrace = read(tracePath).result;
const executor: string = tx.to, owner: string = tx.from;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
assert(historicalTrace && same(historicalTrace.to, executor) && same(historicalTrace.from, owner));
assert.equal(historicalTrace.input, tx.input);
const executorCalls = (trace: any) => {
  const result: any[] = [];
  const visit = (call: any) => {
    if (same(call.from, executor)) result.push(call);
    for (const child of call.calls ?? []) visit(child);
  };
  visit(trace); return result;
};
const historicalCalls = executorCalls(historicalTrace);
assert.equal(historicalCalls.length, 3, "this pinned comparison is exactly the observed three-call path");
const [opening, transfer, closing] = historicalCalls;
const v3 = new ethers.Interface(["function swap(address,bool,int256,uint160,bytes) returns(int256,int256)"]);
const erc = new ethers.Interface(["function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"]);
const v2 = new ethers.Interface(["function swap(uint256,uint256,address,bytes)"]);
// The peer omits trailing ABI padding on bytes data. Decode the static
// economic parameters without altering the original executable calldata.
function swapParameters(input: string) {
  assert.equal(ethers.dataSlice(input, 0, 4), v3.getFunction("swap")!.selector);
  assert.equal(BigInt(ethers.dataSlice(input, 132, 164)), 160n);
  const dynamicLength = BigInt(ethers.dataSlice(input, 164, 196));
  assert(BigInt(ethers.dataLength(input)) >= 196n + dynamicLength, "complete callback data");
  return Array.from(ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "bool", "int256", "uint160"], ethers.dataSlice(input, 4, 132)));
}
const [recipient, zeroForOne, specified, sqrtLimit] = swapParameters(opening.input);
const [payee, amountIn] = erc.decodeFunctionData("transfer", transfer.input);
const [out0, out1, debtRecipient, debtData] = v2.decodeFunctionData("swap", closing.input);
const [delta0, delta1] = v3.decodeFunctionResult("swap", opening.output);
assert(same(recipient, executor) && same(payee, closing.to) && same(debtRecipient, opening.to));
assert.equal(debtData, "0x");
assert.equal(zeroForOne, false, "pinned GTC direction, not a general Family emitter");
assert.equal(out0, 0n); assert.equal(out1, specified); assert.equal(delta1, specified); assert(delta0 < 0n);
const profitToken: string = transfer.to;
// Minimum return is independently read from the decompiled packed input,
// not inferred from our successful output to relax the competitor's guard.
const minimumReturn = BigInt(ethers.dataSlice(tx.input, 23, 39));
assert.equal(minimumReturn, -delta0);
assert.equal(BigInt(ethers.dataSlice(tx.input, 7, 23)), specified);
assert.equal(BigInt(ethers.dataSlice(tx.input, 66, 82)), amountIn);
const assetB = "0xde30da39c46104798bb5aa3fe8b9e0e1f348163f";
const originalPayment = new P().call(transfer.to, transfer.input).call(closing.to, closing.input);
const legs = [
  { tokenIn: profitToken, tokenOut: assetB, program: ethers.hexlify(originalPayment.bytes()) },
  { tokenIn: assetB, tokenOut: profitToken, program: ethers.hexlify(new P().call(opening.to, opening.input).bytes()) },
];
const flowHash = runtimeSettlementFlowHash(amountIn, minimumReturn, legs);
function compile(minimum: bigint, compact = false): { scriptHex: string; calldata: string; root: ResolvedPlanNode } {
  // Exactly the peer's fixed payment/output. This is an explicit historical
  // fixture, never a replacement for production runtime-actual semantics.
  const payment = new P().diagnosticHop(0, flowHash);
  if (compact) payment.directCall(transfer.to, transfer.input).directCall(closing.to, closing.input);
  else payment.call(transfer.to, transfer.input).call(closing.to, closing.input);
  const callback = compact ? runtimeCallSequenceScript(payment.bytes()) : runtimeProgramScript(payment.bytes());
  const payload = v3.encodeFunctionData("swap", [recipient, zeroForOne, specified, sqrtLimit, callback]);
  const program = new P().diagnosticHop(1, flowHash).call(opening.to, payload,
    { callback: { incomingOffset: 132, outgoingOffset: 196 } });
  if (compact) program.returnedFloor(0, minimum, true);
  else program.load(1, 0).constant(2, 1n << 255n).math("sub", 3, 1, 2)
    .constant(2, (1n << 256n) - minimum).math("sub", 3, 2, 1);
  const root: ResolvedPlanNode = { adapterId: "runtime-amount-flow", target: executor,
    tokenIn: profitToken, tokenOut: profitToken, amount: amountIn, children: [], params: {
      legs: JSON.stringify(legs), minimumReturn: minimum, settlementProgram: ethers.hexlify(program.bytes()),
      ...(compact ? { settlementEncoding: "call-sequence-v2" } : {}) } };
  const scriptHex = ethers.hexlify(compilePlan(root, executor));
  return { scriptHex, root, calldata: new ethers.Interface(["function execute(bytes)"]).encodeFunctionData("execute", [scriptHex]) };
}
const compiled = compile(minimumReturn), tooHigh = compile(minimumReturn + 1n);
const compact = compile(minimumReturn, true), compactTooHigh = compile(minimumReturn + 1n, true);
const raw = buildRawExecuteCalldata(ethers.getBytes(compact.scriptHex));
save("compiled-raw-input.json", { scriptHex: compact.scriptHex, calldata: raw,
  calldataHash: ethers.keccak256(raw), encoding: "executeRaw", compactCallAndReturn: true });
function candidateRuntime() {
  const artifact = read(candidatePath), bytes = ethers.getBytes(artifact.deployedBytecode.object);
  for (const refs of Object.values<any>(artifact.deployedBytecode.immutableReferences ?? {})) for (const ref of refs) {
    assert.equal(ref.length, 32); bytes.set(ethers.getBytes(ethers.zeroPadValue(owner, 32)), ref.start);
  }
  return ethers.hexlify(bytes);
}
const huff = readFileSync(huffPath, "utf8").trim();
const rpcUrl: string = read(required("--rpc-config")).MAINNET_RPC_URL;
assert(rpcUrl);
let rpcId = 0;
async function request(url: string, method: string, params: unknown[] = []): Promise<any> {
  let response: any;
  try {
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(60000) });
    response = await result.json();
  } catch { throw new Error(`RPC transport failed: ${method}`); }
  if (response.error) throw new Error(`RPC rejected ${method}: code ${response.error.code}`);
  return response.result;
}
const target = await request(rpcUrl, "eth_getBlockByHash", [tx.blockHash, false]);
const historicalReceipt = await request(rpcUrl, "eth_getTransactionReceipt", [tx.hash]);
const source = await request(rpcUrl, "eth_getBlockByHash", [target.parentHash, false]);
assert.equal(target.number, tx.blockNumber); assert.equal(historicalReceipt.blockHash, target.hash);
assert.equal(BigInt(target.number), BigInt(source.number) + 1n);
const reservation = createServer();
await new Promise<void>((accept, reject) => {
  reservation.once("error", reject); reservation.listen(0, "127.0.0.1", accept);
});
const address = reservation.address(); assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
const localUrl = `http://127.0.0.1:${port}`;
const rpc = (method: string, params: unknown[] = []) => request(localUrl, method, params);
const log = openSync(resolve(out, "anvil.log"), "wx");
const child = spawn("/usr/local/bin/anvil", ["--host", "127.0.0.1", "--port", String(port), "--fork-url", rpcUrl,
  "--fork-block-number", String(BigInt(source.number)), "--chain-id", "1", "--hardfork", "prague", "--no-mining", "--steps-tracing", "--silent"],
  { stdio: ["ignore", log, log] }); closeSync(log);
const normalizeLogs = (receipt: any) => receipt.logs.map(({ address, topics, data }: any) => ({ address, topics, data }));
const balance = async (token: string) => BigInt(await rpc("eth_call", [{ to: token,
  data: erc.encodeFunctionData("balanceOf", [executor]) }, "latest"]));
const report: any = { scope: "fixed competitor-call compiler comparison, parent state with target environment; no full prefix replay",
  transaction: tx.hash, source, target, historicalGas: BigInt(historicalReceipt.gasUsed),
  txSha256: sha256(txPath), traceSha256: sha256(tracePath), candidateSha256: sha256(candidatePath), huffSha256: sha256(huffPath),
  sameConditions: { owner, executor, amountIn, specified, minimumReturn, accessList: tx.accessList,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, gasLimit: tx.gas, value: tx.value,
    balancesOverridden: false, nonceOverridden: false, poolStateOverridden: false }, results: [], guards: [] };
save("results.json", report);
save("compiled-input.json", { ...compiled, expectedCalls: historicalCalls, flowHash,
  calldataHash: ethers.keccak256(compiled.calldata), deliberateDifferences: ["executor code", "entry encoding", "callback-program encoding", "authenticated failure metadata"] });
try {
  for (let i = 0; ; i++) {
    assert.equal(child.exitCode, null, "task-owned Anvil exited");
    try { assert.equal(await rpc("eth_chainId"), "0x1"); break; } catch { assert(i < 80); await delay(250); }
  }
  assert.equal((await rpc("eth_getBlockByNumber", ["latest", false])).hash, source.hash);
  const peerCode = await rpc("eth_getCode", [executor, "latest"]);
  assert.equal(ethers.keccak256(peerCode), "0xb3fefc6f4dc1701d0c8a2249a37bf73d7d6223ae12c9da2ed39a6633eab7a91a");
  report.parentSenderNonce = await rpc("eth_getTransactionCount", [owner, "latest"]);
  report.historicalSenderNonce = tx.nonce;
  await rpc("anvil_impersonateAccount", [owner]);
  const variants = [
    { name: "peer-original", code: peerCode, data: tx.input },
    { name: "our-compiler-solidity-yul", code: candidateRuntime(), data: compiled.calldata },
    { name: "our-compiler-solidity-yul-raw", code: candidateRuntime(), data: raw },
    { name: "our-compiler-huff", code: huff, data: compiled.calldata },
    ...(huffRawPath ? [{ name: "our-compiler-huff-raw", code: readFileSync(huffRawPath, "utf8").trim(), data: raw }] : []),
  ];
  let snapshot = await rpc("evm_snapshot");
  const reset = async (code: string) => {
    assert(await rpc("evm_revert", [snapshot])); snapshot = await rpc("evm_snapshot");
    await rpc("anvil_setCode", [executor, code]);
    await rpc("anvil_setCoinbase", [target.miner]);
    await rpc("evm_setBlockGasLimit", [target.gasLimit]);
    await rpc("evm_setNextBlockTimestamp", [Number(BigInt(target.timestamp))]);
    await rpc("anvil_setNextBlockBaseFeePerGas", [target.baseFeePerGas]);
  };
  const send = async (data: string) => {
    const hash = await rpc("eth_sendTransaction", [{ from: owner, to: executor, data, value: tx.value, gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList, type: tx.type }]);
    await rpc("evm_mine");
    return { hash, receipt: await rpc("eth_getTransactionReceipt", [hash]) };
  };
  let expectedLogs: any, sharedEnvironment: any;
  for (const variant of variants) {
    await reset(variant.code);
    const before = await Promise.all([balance(profitToken), balance(assetB)]);
    const nativeBefore = await rpc("eth_getBalance", [executor, "latest"]);
    const { hash, receipt } = await send(variant.data);
    const after = await Promise.all([balance(profitToken), balance(assetB)]);
    const trace = await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    const opcodes = await rpc("debug_traceTransaction", [hash, { disableMemory: true, disableStack: true, disableStorage: true }]);
    save(`${variant.name}-trace.json`, trace); save(`${variant.name}-receipt.json`, receipt);
    save(`${variant.name}-opcodes.json`, opcodes);
    assert.equal(receipt.status, "0x1", variant.name);
    assert.equal(receipt.blockNumber, target.number);
    assert.equal(await rpc("eth_getBalance", [executor, "latest"]), nativeBefore);
    assert.equal(after[1]! - before[1]!, 0n);
    const gross = after[0]! - before[0]!;
    assert.equal(gross, minimumReturn - amountIn, "identical exact peer gross");
    const actualCalls = executorCalls(trace);
    assert.equal(actualCalls.length, 3, "no executor queries or additional funding calls");
    const actualOpen = swapParameters(actualCalls[0]!.input);
    assert.deepEqual(actualOpen, [recipient, zeroForOne, specified, sqrtLimit]);
    for (let i = 0; i < 3; i++) {
      assert(same(actualCalls[i].to, historicalCalls[i].to));
      assert.equal(actualCalls[i].output, historicalCalls[i].output);
      if (i > 0) assert.equal(actualCalls[i].input, historicalCalls[i].input, "token payment and direct settlement byte-identical");
    }
    const logs = normalizeLogs(receipt); expectedLogs ??= logs;
    assert.deepEqual(logs, expectedLogs, "all token and pool events identical");
    assert.deepEqual(logs, normalizeLogs(historicalReceipt), "same observed on-chain economic events");
    const first = opcodes.structLogs[0], last = opcodes.structLogs.at(-1);
    const executionBeforeRefund = BigInt(first.gas) - BigInt(last.gas) + BigInt(last.gasCost);
    const intrinsic = ethers.getBytes(variant.data).reduce((sum, byte) => sum + (byte ? 16n : 4n), 21000n)
      + tx.accessList.reduce((sum: bigint, item: any) => sum + 2400n + 1900n * BigInt(item.storageKeys.length), 0n);
    let exclusive = 0n;
    const account = (call: any, root = false) => {
      if (same(call.to, executor)) exclusive += (root ? executionBeforeRefund : BigInt(call.gasUsed))
        - (call.calls ?? []).reduce((sum: bigint, c: any) => sum + BigInt(c.gasUsed), 0n);
      for (const c of call.calls ?? []) account(c);
    }; account(trace, true);
    const actualHeader = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    const actualTransaction = await rpc("eth_getTransactionByHash", [hash]);
    for (const field of ["number", "timestamp", "baseFeePerGas", "miner", "gasLimit"]) {
      assert.equal(actualHeader[field]?.toLowerCase(), target[field]?.toLowerCase(), `same environment: ${field}`);
    }
    const actualEnvironment = Object.fromEntries(["number", "timestamp", "baseFeePerGas", "miner", "mixHash", "gasLimit"]
      .map(field => [field, actualHeader[field]]));
    sharedEnvironment ??= actualEnvironment;
    assert.deepEqual(actualEnvironment, sharedEnvironment, "identical environment for all variants");
    // This Anvil has no setter for PREVRANDAO. Retain its actual value and
    // require the entire executed path to be independent of that field.
    const randaoReads = opcodes.structLogs.filter((step: any) => /^(DIFFICULTY|PREVRANDAO|RANDOM)$/.test(step.op)).length;
    const randaoMatchesHistorical = actualHeader.mixHash === target.mixHash;
    assert(randaoMatchesHistorical || randaoReads === 0, "unrestored historical randomness must be unused");
    assert.equal(actualTransaction.nonce, report.parentSenderNonce, "same unmodified parent sender nonce");
    const row = { name: variant.name, gas: BigInt(receipt.gasUsed), gross, intrinsic, executionBeforeRefund,
      actualNonce: actualTransaction.nonce, actualEnvironment, randaoMatchesHistorical, randaoReads,
      refund: intrinsic + executionBeforeRefund - BigInt(receipt.gasUsed), executorExclusive: exclusive,
      baseFeeCost: BigInt(receipt.gasUsed) * BigInt(target.baseFeePerGas), calldataBytes: ethers.dataLength(variant.data),
      calldataHash: ethers.keccak256(variant.data), runtimeBytes: ethers.dataLength(variant.code), runtimeHash: ethers.keccak256(variant.code),
      executorExternalCalls: actualCalls.length, executorQueries: 0, exactCallEffects: true, exactEvents: true };
    assert(row.runtimeBytes <= 24576); report.results.push(row); save("results.json", report);
    console.log(JSON.stringify(row, (_k, value) => typeof value === "bigint" ? value.toString() : value));
  }
  const peerTooHigh = ethers.getBytes(tx.input);
  peerTooHigh.set(ethers.getBytes(ethers.toBeHex(minimumReturn + 1n, 16)), 23);
  for (const variant of variants) {
    await reset(variant.code);
    const before = await Promise.all([balance(profitToken), balance(assetB)]);
    const { receipt } = await send(variant.name === "peer-original" ? ethers.hexlify(peerTooHigh)
      : variant.name === "our-compiler-solidity-yul-raw" || variant.name === "our-compiler-huff-raw"
        ? buildRawExecuteCalldata(ethers.getBytes(compactTooHigh.scriptHex)) : tooHigh.calldata);
    assert.equal(receipt.status, "0x0", "one wei above competitor return must reject");
    assert.deepEqual(await Promise.all([balance(profitToken), balance(assetB)]), before, "atomic rollback");
    report.guards.push({ name: variant.name, minimumReturn: minimumReturn + 1n, rejected: true, balancesUnchanged: true });
  }
  report.passed = true; save("results.json", report);
  console.log("PASS: same-sender/address/state/amount/access-list compiler comparison; no deployment or broadcast");
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error);
  save("results.json", report); throw error;
} finally { child.kill("SIGTERM"); }
