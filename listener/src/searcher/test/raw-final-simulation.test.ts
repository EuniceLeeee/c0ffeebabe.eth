import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import "../../adapters/index.js";
import { RuntimeAmountProgram, runtimeProgramScript, runtimeSettlementFlowHash } from "../../adapters/runtime-amount-program.js";
import { compilePlan } from "../../compiler.js";
import { buildExecuteCalldata, buildRawExecuteCalldata, canUseRawExecuteCalldata,
  loadBotVmRuntimeCode, rawExecutionEntryEnabled } from "../../shared/executor/botvm-executor.js";
import { buildEthSimulateV1ExecutionInput, validateEthSimulateV1ExecutionInput } from "../simulator/eth-simulate-v1.js";
import { directRevertedRuntimeHop } from "../simulator/direct-revert-hop.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const source = { number: 100, hash: "0x" + "a".repeat(64), generation: 7 };
const header = { number: 100, hash: source.hash, parentHash: "0x" + "b".repeat(64),
  timestamp: 1_800_000_000, baseFeePerGas: 1_000_000_000n, gasUsed: 30_000_000n,
  gasLimit: 60_000_000n, transactionHashes: [] };
const owner = "0x" + "1".repeat(40), executor = "0x" + "2".repeat(40), profitToken = "0x" + "3".repeat(40);
const script = runtimeProgramScript(new RuntimeAmountProgram().constant(1, 10n).bytes(), 20n);
const base = { source, header, owner, executor, profitToken, scriptHex: ethers.hexlify(script) };

test("raw entry is explicit, preserves ABI defaults and binds exact wire calldata", () => {
  assert.equal(rawExecutionEntryEnabled(undefined), false);
  assert.equal(rawExecutionEntryEnabled("0"), false);
  assert.equal(rawExecutionEntryEnabled("1"), true);
  for (const flag of ["", "true", "2"]) assert.throws(() => rawExecutionEntryEnabled(flag));
  const abi = buildEthSimulateV1ExecutionInput(base);
  const raw = buildEthSimulateV1ExecutionInput({ ...base, executionEntry: "raw" });
  assert.equal(abi.schemaVersion, 3); assert.equal(raw.schemaVersion, 5);
  assert.equal(abi.calldata, buildExecuteCalldata(script));
  assert.equal(raw.calldata, buildRawExecuteCalldata(script));
  assert.equal(raw.simulateParams[0].blockStateCalls[0].calls[1].data, raw.calldata);
  assert(ethers.getBytes(raw.calldata).length < ethers.getBytes(abi.calldata).length);
  for (const v of [abi, raw]) assert.deepEqual(validateEthSimulateV1ExecutionInput(JSON.parse(JSON.stringify(v))), v);
  for (const field of ["calldata", "schemaVersion"]) {
    const bad: any = structuredClone(raw); bad[field] = abi[field as keyof typeof abi];
    assert.throws(() => validateEthSimulateV1ExecutionInput(bad));
  }
  const bad: any = structuredClone(raw); bad.simulateParams[0].blockStateCalls[0].calls[1].data = abi.calldata;
  assert.throws(() => validateEthSimulateV1ExecutionInput(bad));
});

test("raw diagnostic input preserves authentication and rejects missing proof context", () => {
  const diagnostic = { executorRuntimeCode: loadBotVmRuntimeCode(owner), diagnosticKey: ethers.id("raw-entry-test") };
  const abi = buildEthSimulateV1ExecutionInput({ ...base, ...diagnostic });
  const raw = buildEthSimulateV1ExecutionInput({ ...base, ...diagnostic, executionEntry: "raw" });
  assert.equal(abi.schemaVersion, 4); assert.equal(raw.schemaVersion, 6);
  assert.deepEqual(validateEthSimulateV1ExecutionInput(JSON.parse(JSON.stringify(raw))), raw);
  for (const field of ["diagnosticKey", "executorRuntimeCode"]) {
    const bad: any = structuredClone(raw); delete bad[field];
    assert.throws(() => validateEthSimulateV1ExecutionInput(bad));
  }
  assert.equal(raw.scriptHex, abi.scriptHex);
});

test("outer-calldata-dependent and legacy scripts remain ABI-only", () => {
  for (const unsafe of [Uint8Array.of(5), runtimeProgramScript(new RuntimeAmountProgram().calldata(1, 4).bytes())]) {
    assert.equal(canUseRawExecuteCalldata(unsafe), false);
    assert.throws(() => buildEthSimulateV1ExecutionInput({ ...base, scriptHex: ethers.hexlify(unsafe), executionEntry: "raw" }));
    assert.equal(buildEthSimulateV1ExecutionInput({ ...base, scriptHex: ethers.hexlify(unsafe) }).schemaVersion, 3);
  }
  assert.equal(canUseRawExecuteCalldata(script), true);
});

test("raw authenticated hop evidence attributes only the failed hop and binds calldata", () => {
  const other = "0x" + "4".repeat(40), target = "0x" + "5".repeat(40);
  const legs = [{tokenIn:profitToken,tokenOut:other,program:"0x01030000"},
    {tokenIn:other,tokenOut:profitToken,program:"0x01030000"}];
  const plan: ResolvedPlan = { root: {adapterId:"runtime-amount-flow",target:executor,tokenIn:profitToken,
    tokenOut:profitToken,amount:20n,children:[],params:{legs:JSON.stringify(legs),minimumReturn:21n,
      settlementProgram:ethers.hexlify(new RuntimeAmountProgram().constant(1,10n).bytes())}},
    flashAmount:20n,profitToken,netProfit:0n,templateName:"raw-hop-fixture" };
  const key = ethers.id("raw-failed-hop-key"), flow = runtimeSettlementFlowHash(20n,21n,legs), reason = "0x12345678";
  const input = buildEthSimulateV1ExecutionInput({...base,scriptHex:ethers.hexlify(compilePlan(plan.root,executor)),
    executorRuntimeCode:loadBotVmRuntimeCode(owner),diagnosticKey:key,executionEntry:"raw"});
  const proof = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32","uint256","address","bytes32","bytes32"],[key,0n,target,flow,ethers.keccak256(reason)]));
  const abi = new ethers.Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);
  const evidence = {executionInput:input,gasUsed:"100000",returnData:abi.encodeErrorResult("RuntimeHopFailed",[0n,target,flow,reason,proof])};
  const edges: TokenEdge[] = legs.map(({ tokenIn, tokenOut }) => ({
    adapterId: "mock", target, tokenIn, tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap"),
  }));
  assert.deepEqual(directRevertedRuntimeHop(plan,edges,evidence),{hopIndex:0,callTarget:target,rawReason:reason});
  const bad: any = structuredClone(evidence); bad.executionInput.calldata = buildExecuteCalldata(compilePlan(plan.root,executor));
  assert.equal(directRevertedRuntimeHop(plan,edges,bad),null);
  const fake = {...evidence,returnData:abi.encodeErrorResult("RuntimeHopFailed",[0n,target,flow,reason,ethers.ZeroHash])};
  assert.equal(directRevertedRuntimeHop(plan,edges,fake),null);
});
