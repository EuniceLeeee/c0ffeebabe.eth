/** Fixed-route executor benchmark, NOT admission, discovery or an opportunity replay.
 * Reads real Ready descriptors, calls production emitters/composer/compiler, and
 * executes unsigned transactions only on a fresh loopback Anvil fork. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../src/adapters/index.js";
import { compilePlan } from "../src/compiler.js";
import { buildRawExecuteCalldata } from "../src/shared/executor/botvm-executor.js";
import { buildRuntimeSettlementRoot } from "../src/searcher/simulator/runtime-settlement.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../src/searcher/venues/production-family-composition.js";
import { settlementFamilyParity } from "./settlement-family-parity.js";

const args = new Map(process.argv.slice(2).reduce<string[][]>((out, v, i, a) => {
  if (i % 2 === 0) out.push([v, a[i + 1]!]); return out;
}, []));
const required = (k: string) => { const v = args.get(k); assert(v, k); return resolve(v); };
const out = required("--out"); mkdirSync(out, { recursive: true });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"), (_k, v) =>
  v?.$durableType === "bigint" ? BigInt(v.value) : v);
const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
  JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const evidencePath = required("--input"), readyPath = required("--ready");
const record = read(evidencePath), input = record.execution_input;
const ready = read(readyPath), source = input.sourceHeader;
const executor: string = input.executor, owner: string = input.owner;
const amount = BigInt(record.flash_amount);
const calls = input.simulateParams[0].blockStateCalls[0];
const overrides = calls.blockOverrides;
const route = [
  { pool: "0xa3509a16bbfc5992eb01cc861b615ccd8e937da8", input: input.profitToken },
  { pool: "0xd017617f6f0fd22796e137a8240cc38f52a147b2", input: "0xde30da39c46104798bb5aa3fe8b9e0e1f348163f" },
];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const members = [...load.plugins, ...load.disabledPlugins];
const descriptors = route.map(leg => {
  const memos = Object.values<any>(ready.verifiedMemos).filter(m => same(m.instanceKey, leg.pool));
  assert.equal(memos.length, 1, "unambiguous historical descriptor required"); return memos[0]!;
});
const emit = (index: number, settlement?: any) => {
  const m = descriptors[index]!, plugin: any = members.find(x => x.familyId === m.familyId)?.plugin;
  assert(plugin); const descriptor = m.compiledDescriptor;
  const projected = plugin.routes.project({ descriptor }).find((r: any) => same(r.tokenIn, route[index]!.input));
  assert(projected);
  const leg = plugin.execution.buildRuntimeLeg({ descriptor, route: projected, executor, transactionOrigin: owner,
    source: { number: Number(source.number), hash: source.hash, generation: record.generation }, runtimeEvidence: [], settlement });
  assert(leg); if (settlement) assert.deepEqual(leg.settlementRequest, settlement);
  return { ...leg, tokenIn: projected.tokenIn, tokenOut: projected.tokenOut };
};
const root = buildRuntimeSettlementRoot({ legs: route.map((_, i) => emit(i)), amount,
  minimumProfit: 1n, executor, build: emit }); assert(root);
const scriptHex = ethers.hexlify(compilePlan(root, executor));
const abi = new ethers.Interface(["function execute(bytes)", "function owner() view returns(address)"]);
const calldata = abi.encodeFunctionData("execute", [scriptHex]);
const rawCalldata = buildRawExecuteCalldata(ethers.getBytes(scriptHex));
save("production-raw-input.json", { scriptHex, calldata: rawCalldata,
  calldataHash: ethers.keccak256(rawCalldata), encoding: "executeRaw" });
save("production-input.json", { source, executor, owner, amount, root, scriptHex, calldata,
  calldataHash: ethers.keccak256(calldata), evidenceSha256: sha256(evidencePath), readyFingerprint: ready.checkpointFingerprint,
  descriptors: descriptors.map(m => ({ familyId: m.familyId, descriptor: m.compiledDescriptor,
    memoFingerprint: m.memoFingerprint, familyDefinitionHash: m.familyDefinitionHash })),
  scope: "fixed-route code generation; no new Ready admission or natural enumeration claimed" });

function runtime(path: string) {
  const artifact = read(path), bytes = ethers.getBytes(artifact.deployedBytecode.object);
  for (const entries of Object.values<any>(artifact.deployedBytecode.immutableReferences ?? {}))
    for (const item of entries) { assert.equal(item.length, 32); bytes.set(ethers.getBytes(ethers.zeroPadValue(owner, 32)), item.start); }
  return ethers.hexlify(bytes);
}
const old = runtime(required("--baseline")), candidate = runtime(required("--candidate"));
const variants = [
  { name: "original-solidity", code: old, data: input.calldata },
  { name: "solidity-yul-vm-only", code: candidate, data: input.calldata },
  { name: "solidity-yul-callback", code: candidate, data: calldata },
  { name: "solidity-yul-callback-raw", code: candidate, data: rawCalldata },
];
if (args.has("--variants")) for (const v of read(required("--variants")))
  variants.push({ name: v.name, code: v.artifact ? runtime(v.artifact) : readFileSync(v.runtime, "utf8").trim(), data: calldata });
if (args.has("--huff")) {
  const hex = readFileSync(required("--huff"), "utf8").trim();
  const code = hex.startsWith("0x") ? hex : `0x${hex}`;
  variants.push({ name: "huff-callback", code, data: calldata });
  variants.push({ name: "huff-original-input", code, data: input.calldata });
}
// No wallet/key is used. Never attach to an existing process or a remote RPC.
const rpcConfig = read(required("--rpc-config")); assert(rpcConfig.MAINNET_RPC_URL);
const port = Number(args.get("--port") ?? "18647"); assert(port >= 1024 && port <= 65535);
const localUrl = `http://127.0.0.1:${port}`;
const logFd = openSync(resolve(out, "anvil.log"), "wx");
const child = spawn(args.get("--anvil") ?? "/usr/local/bin/anvil", ["--host", "127.0.0.1", "--port", String(port),
  "--fork-url", rpcConfig.MAINNET_RPC_URL, "--fork-block-number", String(source.number), "--chain-id", "1",
  "--hardfork", "prague", "--no-mining", "--steps-tracing", "--silent"], { stdio: ["ignore", logFd, logFd] });
closeSync(logFd);
let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  assert.equal(new URL(localUrl).hostname, "127.0.0.1");
  const response = await fetch(localUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(60000) });
  const result = await response.json() as any;
  if (result.error) throw new Error(`local ${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}
const erc20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
async function balance(token: string, who: string) {
  return BigInt(await rpc("eth_call", [{ to: token, data: erc20.encodeFunctionData("balanceOf", [who]) }, "latest"]));
}
try {
  let forkReady = false;
  for (let i = 0; i < 90; ++i) {
    if (child.exitCode !== null) throw new Error("task-owned Anvil exited; inspect private local log");
    try { forkReady = (await rpc("eth_chainId")) === "0x1"; } catch { /* startup only */ }
    if (forkReady) break; await delay(500);
  }
  assert(forkReady, "task-owned local fork startup timeout");
  const block = await rpc("eth_getBlockByNumber", ["latest", false]); assert.equal(block.hash, source.hash);
  assert.equal(await rpc("eth_getCode", [executor, "latest"]), old, "baseline must match actual historical runtime");
  const senderBalance = await rpc("eth_getBalance", [owner, "latest"]);
  const senderNonce = await rpc("eth_getTransactionCount", [owner, "latest"]);
  assert(BigInt(senderBalance) >= 0x1000000n * BigInt(overrides.baseFeePerGas),
    "historical sender must cover the shared gas limit without a balance override");
  save("same-state-conditions.json", { sourceHash: block.hash, sourceStateRoot: block.stateRoot,
    owner, executor, senderBalance, senderNonce, gasLimit: "0x1000000", blockOverrides: overrides,
    balancesOverridden: false, nonceOverridden: false, poolStateOverridden: false,
    executorCodeOnlyOverride: true, fullPrefixReplayed: false,
    scope: "production dynamic fixed-route comparison, parent state plus saved target timestamp/base fee" });
  await rpc("anvil_impersonateAccount", [owner]);
  let snapshot = await rpc("evm_snapshot");
  const results: unknown[] = [];
  let expectedGross: bigint | undefined;
  for (const variant of variants) {
    assert(await rpc("evm_revert", [snapshot])); snapshot = await rpc("evm_snapshot");
    assert.equal(await rpc("eth_getBalance", [owner, "latest"]), senderBalance);
    assert.equal(await rpc("eth_getTransactionCount", [owner, "latest"]), senderNonce);
    await rpc("anvil_setCode", [executor, variant.code]);
    const tokens = route.map(r => r.input);
    const before = await Promise.all(tokens.map(t => balance(t, executor)));
    const nativeBefore = BigInt(await rpc("eth_getBalance", [executor, "latest"]));
    await rpc("evm_setNextBlockTimestamp", [Number(BigInt(overrides.time))]);
    await rpc("anvil_setNextBlockBaseFeePerGas", [overrides.baseFeePerGas]);
    const tx = await rpc("eth_sendTransaction", [{ from: owner, to: executor, data: variant.data,
      value: "0x0", gas: "0x1000000", gasPrice: overrides.baseFeePerGas }]);
    await rpc("evm_mine");
    const receipt = await rpc("eth_getTransactionReceipt", [tx]); assert(receipt);
    const after = await Promise.all(tokens.map(t => balance(t, executor)));
    const nativeAfter = BigInt(await rpc("eth_getBalance", [executor, "latest"]));
    const trace = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
    save(`${variant.name}-trace.json`, trace);
    // Anvil's root callTracer gasUsed includes intrinsic gas and refunds,
    // while nested call gasUsed is execution-only. Normalize before comparing
    // executor-exclusive cost with the historical opcode-accounted 3,772.
    const opcodeTrace = await rpc("debug_traceTransaction", [tx, { disableMemory: true, disableStack: true, disableStorage: true }]);
    if (args.get("--save-opcodes") === "true") save(`${variant.name}-opcodes.json`, opcodeTrace);
    const first = opcodeTrace.structLogs[0], last = opcodeTrace.structLogs.at(-1);
    assert(first && last && first.depth === last.depth);
    const executionBeforeRefund = BigInt(first.gas) - BigInt(last.gas) + BigInt(last.gasCost);
    const intrinsicGas = ethers.getBytes(variant.data).reduce((gas, byte) => gas + (byte === 0 ? 4n : 16n), 21000n);
    assert.equal(BigInt(trace.gasUsed), BigInt(receipt.gasUsed));
    let executorExclusiveGas = 0n;
    const queries = { executorBalanceReads: 0, executorReserveReads: 0, executorStaticCalls: 0 };
    const account = (call: any, isRoot = false) => {
      if (same(call.from, executor) && (call.type === "CALL" || call.type === "STATICCALL")) {
        if (call.type === "STATICCALL") queries.executorStaticCalls++;
        if (call.input?.startsWith("0x70a08231")) queries.executorBalanceReads++;
        if (call.input?.startsWith("0x0902f1ac")) queries.executorReserveReads++;
      }
      if (same(call.to, executor)) executorExclusiveGas += (isRoot ? executionBeforeRefund : BigInt(call.gasUsed)) -
        (call.calls ?? []).reduce((sum: bigint, child: any) => sum + BigInt(child.gasUsed), 0n);
      for (const child of call.calls ?? []) account(child);
    };
    account(trace, true);
    const gasRefund = intrinsicGas + executionBeforeRefund - BigInt(receipt.gasUsed);
    assert(gasRefund >= 0n && executorExclusiveGas > 0n);
    save(`${variant.name}-gas-accounting.json`, { intrinsicGas, executionBeforeRefund, gasRefund, executorExclusiveGas,
      firstOpcode: first, lastOpcode: last, method: "root opcode gas delta before refund; subtract direct children for each executor invocation" });
    const gas = BigInt(receipt.gasUsed), gross = after[0]! - before[0]!;
    const result = { name: variant.name, sourceHash: source.hash, targetBlock: Number(BigInt(receipt.blockNumber)),
      status: receipt.status, gas, gross, intrinsicGas, executionBeforeRefund, gasRefund, executorExclusiveGas, queries,
      baseFeeCost: gas * BigInt(overrides.baseFeePerGas),
      surplusBeforeBribe: gross - gas * BigInt(overrides.baseFeePerGas), nativeDelta: nativeAfter - nativeBefore,
      tokenDeltas: tokens.map((t, i) => ({ token: t, before: before[i], after: after[i], delta: after[i]! - before[i]! })),
      runtimeBytes: ethers.getBytes(variant.code).length, runtimeHash: ethers.keccak256(variant.code),
      calldataBytes: ethers.getBytes(variant.data).length, calldataHash: ethers.keccak256(variant.data) };
    results.push(result); save("results.json", results); console.log(JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    assert.equal(receipt.status, "0x1", `${variant.name} must execute successfully`);
    assert.equal(result.targetBlock, Number(source.number) + 1);
    assert(result.runtimeBytes <= 24576, `${variant.name} must meet EIP-170`);
    assert.equal(result.nativeDelta, 0n, "native inventory is unchanged");
    for (const delta of result.tokenDeltas.slice(1)) assert.equal(delta.delta, 0n, "no intermediate position remains");
    assert(gross > 0n, "same-state gross must remain positive");
    expectedGross ??= gross;
    assert.equal(gross, expectedGross, "all variants must reproduce the exact same gross");
  }
  // The same production composer must reject one wei above the achievable
  // floor; a passing profitable sample alone does not validate the safety gate.
  const guarded = buildRuntimeSettlementRoot({ legs: route.map((_, i) => emit(i)), amount,
    minimumProfit: expectedGross! + 1n, executor, build: emit }); assert(guarded);
  const guardedScript = compilePlan(guarded, executor);
  const guardedData = abi.encodeFunctionData("execute", [ethers.hexlify(guardedScript)]);
  const guards = [];
  for (const variant of variants.filter(v => v.data === calldata || v.data === rawCalldata)) {
    assert(await rpc("evm_revert", [snapshot])); snapshot = await rpc("evm_snapshot");
    await rpc("anvil_setCode", [executor, variant.code]);
    const before = await Promise.all(route.map(r => balance(r.input, executor)));
    await rpc("evm_setNextBlockTimestamp", [Number(BigInt(overrides.time))]);
    await rpc("anvil_setNextBlockBaseFeePerGas", [overrides.baseFeePerGas]);
    const tx = await rpc("eth_sendTransaction", [{ from: owner, to: executor,
      data: variant.data === rawCalldata ? buildRawExecuteCalldata(guardedScript) : guardedData,
      value: "0x0", gas: "0x1000000", gasPrice: overrides.baseFeePerGas }]);
    await rpc("evm_mine");
    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    const after = await Promise.all(route.map(r => balance(r.input, executor)));
    assert.equal(receipt.status, "0x0", "unachievable minimum profit must reject");
    assert.deepEqual(after, before, "failed floor must atomically preserve inventory");
    const failed = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
    assert(!failed.output?.startsWith("0x4189e9b0"), "whole-route profit floor is not a pool failure");
    guards.push({ name: variant.name, minimumProfit: expectedGross! + 1n, status: receipt.status, balancesUnchanged: true });
  }
  save("assertions.json", { exactGross: expectedGross, equivalentPositiveRuns: variants.length, minimumProfitGuards: guards });
  if (args.get("--family-parity") === "true") {
    assert(await rpc("evm_revert", [snapshot]));
    await settlementFamilyParity({ rpc, ready, members, source, executor, owner, amount, save,
      versions: variants.filter(v => v.name === "solidity-yul-callback" || v.name === "huff-callback") });
  }
} finally { child.kill("SIGTERM"); }
