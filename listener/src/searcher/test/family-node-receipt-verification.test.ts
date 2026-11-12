import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, toBeHex } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { verifyRecordedExecutionReceipts } from "./family-node-receipt-verification.js";

// These are transport-verifier unit receipts, never registered chain facts.
function fixture(revert = false): any {
  const executor = toBeHex(1, 20), owner = toBeHex(2, 20), token = toBeHex(3, 20);
  const source = { number: 100, hash: toBeHex(100, 32), generation: 1 }, stateRoot = toBeHex(101, 32);
  const code = "0x60006000f3", executorRuntimeCode = { code, keccak256: keccak256(code) };
  const data = buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram().constant(0, 1n).bytes()));
  const request = { id: "unit", kind: "effect-delta-simulation", required: false,
    call: { caller: { kind: "executor" }, executionMode: "executor-program", to: executor, data },
    overrideIntent: { caller: { kind: "executor" }, nativeBalanceWei: 17n, tokenBalances: [{ token, amount: 118n }] },
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"],
    observeTokenBalances: [{ token, account: executor }] };
  const wire = { from: executor, to: executor, data, callerMode: "impersonated-call-frame",
    gasLimit: 0x1000000, executionGasLimit: 0x1000000, transactionOrigin: owner, executorRuntimeCode,
    nativeBalanceWei: "17", tokenDeals: [{ token, to: executor, amount: "118" }], preCalls: [],
    observeTokenBalances: [{ token, account: executor }], observeNativeBalances: [executor], observeTotalSupply: [], observeLogs: true,
    blockNumber: source.number, sourcePin: { chainId: 1, blockHash: source.hash, stateRoot } };
  const response = { ok: true, success: !revert, output: "0x", ...(revert ? { revertReason: "0x" } : {}), gasUsed: "21000", latencyMs: 1,
    sourceAttestation: { kind: "node-attested", blockNumber: source.number, chainId: 1,
      blockHash: source.hash, parentHash: toBeHex(99, 32), stateRoot }, strict: {
      counterfactualExecutorCode: { address: executor, keccak256: executorRuntimeCode.keccak256 },
      outcome: { kind: revert ? "Revert" : "Success", phase: "main", output: "0x", ...(revert ? { nestedHalt: null } : {}) },
      executionGasUsed: "21000", tokenDeltas: revert ? [] : [{ token, account: executor, delta: "-17" }],
      nativeDeltas: revert ? [] : [{ account: executor, before: "17", after: "17", delta: "0" }], totalSupplyDeltas: [], logs: [],
    } };
  const resultEvidence = { id: "unit", ok: true, source, data: "0x", completion: revert ? "reverted-as-declared" : "returned",
    provenance: { kind: "strict-simulation-transport", fingerprint: "offline-unit" }, effects: {
      tokenDeltas: revert ? [] : [{ token, account: executor, delta: -17n }],
      nativeDeltas: revert ? [] : [{ account: executor, delta: 0n }], logs: [],
    } };
  return { executor, owner, source, chainId: 1, stateRoot, executorRuntimeCode,
    simulations: [{ request: wire, response }], executions: [{ request, resultEvidence }] };
}

test("production transport independently decodes recorded success and completed revert", async () => {
  await verifyRecordedExecutionReceipts(fixture());
  await verifyRecordedExecutionReceipts(fixture(true));
});

test("reported pass cannot borrow an unrelated, reused, or altered node receipt", async () => {
  const mutations = [
    (input: any) => { input.simulations = []; },
    (input: any) => { input.simulations[0].request.transactionOrigin = toBeHex(9, 20); },
    (input: any) => { input.simulations[0].request.tokenDeals[0].amount = "999"; },
    (input: any) => { input.simulations[0].response.sourceAttestation.blockHash = toBeHex(9, 32); },
    (input: any) => { input.executions[0].resultEvidence.effects.tokenDeltas[0].delta = -18n; },
    (input: any) => { input.executions.push(structuredClone(input.executions[0])); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); await assert.rejects(verifyRecordedExecutionReceipts(input)); }
});

test("nested out-of-gas and a mutated revert cannot become successful negative controls", async () => {
  const halted = fixture(true); halted.simulations[0].response.strict.outcome.nestedHalt = "out of gas";
  await assert.rejects(verifyRecordedExecutionReceipts(halted));
  const changed = fixture(true); changed.executions[0].resultEvidence.data = "0x1234";
  await assert.rejects(verifyRecordedExecutionReceipts(changed), /revert/);
});
