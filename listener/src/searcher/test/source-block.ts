import assert from "node:assert/strict";
import { test } from "node:test";
import { id, keccak256 } from "ethers";
import { buildSourceBlockExecutionInput, sourceBlockRevmRequest, sourceBlockResult as reconcile,
  validateSourceBlockExecutionInput, sourceBlockPostState, sourceBlockTraceDeltas } from "../simulator/source-block.js";
import { buildEthSimulateV1ExecutionInput } from "../simulator/eth-simulate-v1.js";
import { evaluateEv } from "../ev-evaluator.js";
import { parseAtBlockArgs } from "../blockscan-at-block-cli.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy } from "../main.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import type { DaemonResponse } from "../revm-sim-client.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: bigint | number) => `0x${n.toString(16).padStart(64, "0")}`;
const owner = addr(1), executor = addr(2), token = addr(3), other = addr(4), holder = addr(5);
const source = { number: 300, hash: word(300), generation: 7 };
const header = { ...source, parentHash: word(299), timestamp: 1_800_000_000,
  baseFeePerGas: 1_000n, gasLimit: 60_000_000n, gasUsed: 60_000_000n, transactionHashes: [] };
const input = buildSourceBlockExecutionInput({ source, header, stateRoot: word(99), chainId: 1,
  owner, executor, profitToken: token, tokens: [token, other],
  funding: { asset: token, liquidityHolder: holder, target: holder, amount: "100" }, scriptHex: "0x0102" });
const transfer = (from: string, to: string, n: number) => ({ address: token,
  topics: [id("Transfer(address,address,uint256)"), word(BigInt(from)), word(BigInt(to))], data: word(n) });
const response = (): DaemonResponse => ({ ok: true, success: true, output: "0x", gasUsed: "30000", latencyMs: 1,
  sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: 300, blockHash: source.hash, parentHash: header.parentHash, stateRoot: input.stateRoot },
  strict: { outcome: { kind: "Success", phase: "main", output: "0x" }, executionGasUsed: "30000",
    tokenDeltas: sourceBlockRevmRequest(input, "unused").observeTokenBalances!.map((p, i) => ({ ...p, delta: i === 0 ? "25" : "0" })),
    nativeDeltas: [{ account: executor, before: "900", after: "900", delta: "0" }], totalSupplyDeltas: [],
    logs: [transfer(holder, executor, 100), transfer(executor, holder, 100)] } });
const trace = () => ({ type: "CALL", from: owner, to: executor, input: input.calldata, output: "0x", gasUsed: "0x61a8" });
const traceDeltas = ["25", "0", "0", "0", "0", "0"];
const sourceBlockResult = (i: typeof input, r: DaemonResponse, t: unknown) => reconcile(i, r, t, traceDeltas);

const override = { code: "0x60006000f3", keccak256: keccak256("0x60006000f3") };
const counterfactualInput = () => buildSourceBlockExecutionInput({ ...input, header, executorRuntimeCode: override });
test("counterfactual code binds hash, executor and both engines without account-state funding", () => {
  const v = counterfactualInput();
  assert(Object.isFrozen(v.executorRuntimeCode));
  assert.deepEqual(validateSourceBlockExecutionInput(JSON.parse(JSON.stringify(v))), v);
  assert.deepEqual(sourceBlockRevmRequest(v, "unused").executorRuntimeCode, override);
  assert.deepEqual(v.traceParams[2].stateOverrides[executor], { code: override.code });
  assert.deepEqual(Object.keys(v.traceParams[2].stateOverrides), [executor]);
  assert(!Object.hasOwn(v.traceParams[2].stateOverrides, owner));
  assert(!Object.hasOwn(sourceBlockRevmRequest(v, "unused"), "nativeBalanceWei"));
  assert.deepEqual(v.funding, input.funding);
  assert.deepEqual(sourceBlockRevmRequest(v, "unused").tokenDeals, []);
  assert.throws(() => sourceBlockResult(v, response(), trace()), /code evidence mismatch/);
  const r = response(); r.strict!.counterfactualExecutorCode = { address: executor, keccak256: override.keccak256 };
  assert.deepEqual(sourceBlockResult(v, r, trace()).sourceBlockEvidence.counterfactualExecutorCode, r.strict!.counterfactualExecutorCode);
  assert.throws(() => sourceBlockResult(input, r, trace()), /code evidence mismatch/);
  assert.equal(sourceBlockResult(input, response(), trace()).sourceBlockEvidence.counterfactualExecutorCode, undefined);
});
for (const change of [
  (v: any) => v.executorRuntimeCode.code = "0x00",
  (v: any) => v.executorRuntimeCode.keccak256 = word(0),
  (v: any) => v.executorRuntimeCode.address = holder,
  (v: any) => v.traceParams[2].stateOverrides[executor].code = "0x00",
  (v: any) => v.traceParams[2].stateOverrides[holder] = { code: override.code },
  (v: any) => v.traceParams[2].stateOverrides[owner] = { balance: "0x21e19e0c9bab2400000" },
  (v: any) => v.nativeBalanceWei = "10000000000000000000000",
  ...["balance", "nonce", "state", "stateDiff", "storage"].flatMap(k => [
    (v: any) => v.executorRuntimeCode[k] = "0x01",
    (v: any) => v.traceParams[2].stateOverrides[executor][k] = "0x01",
  ]),
]) test("counterfactual snapshot rejects code/hash/target/account-state tampering", () => {
  const v = JSON.parse(JSON.stringify(counterfactualInput())); change(v);
  assert.throws(() => validateSourceBlockExecutionInput(v));
});
test("counterfactual builder rejects invalid, empty, extra-field and wrong-hash code", () => {
  for (const executorRuntimeCode of [null, {}, { ...override, code: "0x1" }, { ...override, keccak256: word(0) },
    { code: "0x", keccak256: keccak256("0x") }, { ...override, balance: "0x1" }])
    assert.throws(() => buildSourceBlockExecutionInput({ ...input, header, executorRuntimeCode } as any));
});
for (const postCode of [undefined, "0x00"]) test("independent before/post probes retain overridden code and actual post writes", async () => {
  const v = counterfactualInput(); let probes = 0;
  const deltas = await sourceBlockTraceDeltas(v, async (method, params) => {
    assert.deepEqual(params[1], v.traceParams[1]);
    if (method === "debug_traceCall") {
      assert.deepEqual((params[2] as any).stateOverrides[executor], { code: override.code });
      return { pre: { [executor]: { storage: { [word(0)]: word(42) } } },
        post: { [executor]: { storage: { [word(0)]: word(43) }, ...(postCode ? { code: postCode } : {}) } } };
    }
    if (method === "eth_getBalance") return "0x384";
    assert.equal(method, "eth_call"); assert.equal((params[0] as any).gasPrice, "0x3e8");
    const overlay = params[2] as any, after = probes++ % 2 === 1;
    assert.deepEqual(Object.keys(overlay), [executor]);
    assert.deepEqual(overlay[executor], after ? { code: postCode ?? override.code, stateDiff: { [word(0)]: word(43) } } : { code: override.code });
    return word(after ? 25 : 20);
  });
  assert.deepEqual(deltas, ["5", "5", "5", "5", "5", "0"]);
});

test("source-block wire freezes B/hash/full calldata; next-block default remains B+1", () => {
  const wire = sourceBlockRevmRequest(input, "http://127.0.0.1:1");
  assert.equal(wire.blockNumber, 300); assert.equal(wire.sourcePin!.blockHash, source.hash);
  assert.equal(wire.callerMode, "top-level"); assert.equal(wire.data, input.calldata);
  assert.deepEqual(wire.tokenDeals, []); assert.deepEqual(wire.preCalls, []);
  assert.equal(input.traceParams[0].gasPrice, "0x3e8");
  assert.deepEqual(input.traceParams[1], { blockHash: source.hash, requireCanonical: true });
  assert(!("blockOverrides" in input.traceParams[2]));
  assert.deepEqual(Object.keys(input.traceParams[2].stateOverrides), [owner]);
  assert.equal(wire.nativeBalanceWei, "10000000000000000000000");
  const ownerOverride = input.traceParams[2].stateOverrides[owner]!;
  assert("balance" in ownerOverride);
  assert.equal(BigInt(ownerOverride.balance), 10_000n * 10n ** 18n);
  assert(Object.isFrozen(input.traceParams[0]));
  assert.deepEqual(validateSourceBlockExecutionInput(JSON.parse(JSON.stringify(input))), input);
  const next = buildEthSimulateV1ExecutionInput({ source, header, executor, owner, profitToken: token, scriptHex: input.scriptHex });
  assert.equal(next.calldata, input.calldata);
  assert.equal(next.simulateParams[0].blockStateCalls[0].blockOverrides.number, "0x12d");
  assert.equal(BigInt(next.simulateParams[0].blockStateCalls[0].blockOverrides.baseFeePerGas), 1125n);
});
for (const change of [
  (v: any) => v.traceParams[1].blockHash = word(299),
  (v: any) => v.traceParams[2].blockOverrides = { number: "0x12c" },
  (v: any) => v.traceParams[0].gasPrice = "0x465",
  (v: any) => v.traceParams[2].stateOverrides[executor] = { balance: "0xff" },
  (v: any) => v.scriptHex = "0xffff",
  (v: any) => v.executionMode = "next-block",
]) test("saved input rejects changed environment/state/calldata", () => {
  const v = JSON.parse(JSON.stringify(input)); change(v); assert.throws(() => validateSourceBlockExecutionInput(v));
});
test("profit is measured balance delta, gas is charged trace gas, repayment is independent", () => {
  const result = sourceBlockResult(input, response(), trace());
  assert.equal(result.grossProfit, 25n); assert.equal(result.netProfit, 25n);
  assert.equal(result.gasUsed, 25000n); assert(result.success);
  assert(result.sourceBlockEvidence.repaymentVerified && result.sourceBlockEvidence.conservationVerified);
});
test("zero profit is a successful EVM execution, not a revert", () => {
  const r = response(); r.strict!.tokenDeltas[0]!.delta = "0";
  const result = reconcile(input, r, trace(), traceDeltas.map(() => "0"));
  assert.equal(result.success, true);
  assert.equal(result.grossProfit, 0n);
  assert.equal(result.failure, undefined);
  assert(result.sourceBlockEvidence.repaymentVerified && result.sourceBlockEvidence.conservationVerified);
});
test("same output with different asset effects is never accepted", () => {
  assert.throws(() => reconcile(input, response(), trace(), ["24", "0", "0", "0", "0", "0"]), /effects disagree/);
  assert.throws(() => reconcile(input, response(), trace()), /effects disagree/);
});
test("post-state overlay zeroes deleted slots, preserves unrelated source state and rejects deleted accounts", () => {
  assert.deepEqual(sourceBlockPostState({ pre: { [token]: { storage: { [word(0)]: word(20), [word(1)]: word(99) } } },
    post: { [token]: { storage: { [word(0)]: word(25) } } } }),
    { [token]: { stateDiff: { [word(0)]: word(25), [word(1)]: word(0) } } });
  assert.throws(() => sourceBlockPostState({ pre: { [token]: { code: "0x1234" } }, post: {} }), /deleted an account/);
});
test("trace balance observations replay actual write-set at B; no header or funding overrides", async () => {
  const calls: string[] = [];
  const deltas = await sourceBlockTraceDeltas(input, async (method, params) => {
    calls.push(method); assert.deepEqual(params[1], input.traceParams[1]);
    if (method === "debug_traceCall") {
      assert.deepEqual(params[0], input.traceParams[0]);
      assert.equal((params[2] as any).tracer, "prestateTracer");
      assert(!("blockOverrides" in (params[2] as object)));
      return { pre: { [token]: { storage: { [word(0)]: word(100) } } }, post: { [token]: { storage: { [word(0)]: word(125) } } } };
    }
    if (method === "eth_getBalance") return "0x0";
    assert.equal(method, "eth_call");
    assert.equal((params[0] as any).gasPrice, input.traceParams[0].gasPrice,
      "balance probes must use the same B GASPRICE as strict_probe");
    if (params.length === 3) assert.deepEqual(params[2], { [token]: { stateDiff: { [word(0)]: word(125) } } });
    return word(params.length === 3 ? 125 : 100);
  });
  assert.deepEqual(deltas, ["25", "25", "25", "25", "25", "0"]);
  assert.equal(calls.length, 12);
});
for (const [name, mutate] of [
  ["wrong source", (r: any) => r.sourceAttestation.blockHash = word(299)],
  ["wrong root", (r: any) => r.sourceAttestation.stateRoot = word(98)],
  ["missing observations", (r: any) => r.strict.tokenDeltas.pop()],
  ["owner funding", (r: any) => r.strict.tokenDeltas[1].delta = "-1"],
  ["other inventory used", (r: any) => r.strict.tokenDeltas[2].delta = "-1"],
  ["native inventory used", (r: any) => r.strict.nativeDeltas[0] = { account: executor, before: "900", after: "899", delta: "-1" }],
  ["lender loss despite repayment log", (r: any) => r.strict.tokenDeltas[4].delta = "-1"],
  ["no borrow witness", (r: any) => r.strict.logs.shift()],
  ["short repayment despite restored balance", (r: any) => r.strict.logs[1].data = word(99)],
  ["undeclared token", (r: any) => r.strict.logs.push({ ...transfer(executor, holder, 1), address: addr(6) })],
] as const) test(`source-block refuses ${name}`, () => {
  const r = response(); mutate(r); assert.throws(() => sourceBlockResult(input, r, trace()));
});
for (const patch of [{ input: "0x" }, { from: holder }, { error: "out of gas" }, { gasUsed: "0x0" }, { gasUsed: "0xffff" }, { output: "0x01" }])
  test("trace mismatch fails closed", () => assert.throws(() => sourceBlockResult(input, response(), { ...trace(), ...patch })));
test("only matching top-level EVM revert is a route revert", () => {
  const r = response(); r.success = false; r.output = "0x1234"; r.revertReason = r.output;
  r.strict!.outcome = { kind: "Revert", phase: "main", output: r.output };
  r.strict!.tokenDeltas = []; r.strict!.nativeDeltas = []; r.strict!.logs = [];
  const result = sourceBlockResult(input, r, { ...trace(), output: r.output, error: "execution reverted" });
  assert.equal(result.failure?.kind, "revert"); assert(!result.success);
  assert.throws(() => sourceBlockResult(input, r, { ...trace(), error: "timeout" }));
});
test("EV source fee is B, estimates and bid stay production-owned; next-block remains default", async () => {
  const policy = { profitHaircutBps: 2000, bribeBps: 5000, bribeAllAboveGas: false, evGate: true };
  const valuation = { valueInEth: (_t: string, n: bigint) => n } as any;
  const provider = { async getBlock(tag: unknown) { assert.equal(tag, source.number); return header; } };
  const evaluate = (mode?: { mode: "source-block"; sourceBlockHash: string }) =>
    evaluateEv(provider, token, 100_000_000n, 25000n, policy, valuation, source.number, mode);
  const current = await evaluate({ mode: "source-block", sourceBlockHash: source.hash });
  assert.equal(current.maxBaseFeePerGas, 1000n); assert.equal(current.gasCostEth, 25_000_000n);
  assert.equal(current.expectedProfitEth, 80_000_000n); assert.equal(current.bidEth, 27_500_000n);
  assert.equal(current.netEvWei, 27_500_000n); assert.equal(current.sourceBlockHash, source.hash);
  assert.equal((await evaluate()).maxBaseFeePerGas, 1125n);
  assert(!(await evaluate({ mode: "source-block", sourceBlockHash: word(299) })).feeStateAvailable);
  let reads = 0;
  const changed = await evaluateEv({ async getBlock() { return ++reads === 1 ? header : { ...header, hash: word(299) }; } },
    token, 100_000_000n, 25000n, policy, valuation, source.number, { mode: "source-block", sourceBlockHash: source.hash });
  assert(!changed.feeStateAvailable); assert.equal(changed.sourceBlockHash, null);
  await assert.rejects(evaluateEv(provider, token, 1n, 1n, policy, valuation, undefined, { mode: "source-block", sourceBlockHash: source.hash }));
});
test("CLI explicit source-block flag; live cannot opt into historical execution", async () => {
  const args = ["--ready", "r", "--out", "o", "--block", "300"];
  assert.equal(parseAtBlockArgs(args)!.executionMode, "next-block");
  assert.equal(parseAtBlockArgs([...args, "--execution-mode", "source-block"])!.executionMode, "source-block");
  assert.throws(() => parseAtBlockArgs([...args, "--execution-mode", "anything"]));
  await assert.rejects(maybeSubmitBlockScanAtomic({ historicalExecutionMode: "source-block" } as any), /requires historical read-only/);
});

for (const profit of [25n, 0n]) test(`production final gate records successful source-block execution at profit ${profit} without submission`, async () => {
  const r = response(); r.strict!.tokenDeltas[0]!.delta = profit.toString();
  const sim = reconcile(input, r, trace(), [profit.toString(), ...traceDeltas.slice(1)]);
  const raw = { number: "0x12c", hash: source.hash, parentHash: header.parentHash, stateRoot: input.stateRoot,
    timestamp: `0x${header.timestamp.toString(16)}`, baseFeePerGas: "0x3e8", gasUsed: "0x3938700", gasLimit: "0x3938700", transactions: [] };
  const methods: string[] = [];
  const runtime = createFinalSimulationWorkRuntime({ reservedResources: [{ id: "source-only", value: null }],
    runner: { async simulate() { return sim; } }, generationFence: { assertCurrent(g, s) { assert.equal(g, 7); assert.equal(s.hash, source.hash); } },
    planIdentity: { bytesHex: () => input.scriptHex, resultBytesHex: (r: typeof sim) => r.scriptHex }, timeoutMs: 5000, maxQueued: 1 });
  let evaluation: any;
  try {
    const result = await maybeSubmitBlockScanAtomic({ historicalReadOnly: true, historicalExecutionMode: "source-block",
      config: { ...resolveBlockScanAtomicPolicy({}), dryRun: true, blockScanSubmit: false, evGate: true, finalVerifyFloorBps: 0n },
      provider: { async getBlock() { throw new Error("cached numeric provider must not be used"); }, async send(method: string, params: unknown[]) {
        methods.push(method); assert.equal(method, "eth_getBlockByNumber"); assert.equal(params[0], "0x12c"); return raw;
      } } as any,
      finalSimulationRuntime: runtime, sourceGeneration: 7, sourceBlock: 300, sourceBlockHash: source.hash,
      opp: { seedEdges: [], flashToken: token, affectedTokens: [], cycleId: "fixture", cycleFingerprint: "fixture", leavesStandingPosition: false } as any,
      resolved: { root: { adapterId: "fixture", target: holder, tokenIn: token, tokenOut: token, amount: 100n, params: {}, children: [] },
        profitToken: token, flashAmount: 100n, netProfit: 25n, templateName: "fixture" },
      bundleRouter: { async submit() { throw new Error("must not submit"); } }, submissionCoordinator: { offer() { throw new Error("must not submit"); } },
      ring: "fixture", protoRing: false, plans: 1, passDeadlineAtMs: Date.now() + 5000, simRejects: new BlockScanSimRejectCache(),
      profitTokenValuation: { valueInEth: (_t: string, n: bigint) => n * 1_000_000_000n } as any,
      signal: new AbortController().signal, collectBlindAudit: true, strategyVersions: { strategy_view_version: "fixture", blockscan_view_hash: source.hash },
      onHistoricalEv(e) { evaluation = e; },
    });
    assert.equal(result.finalSimStatus, "succeeded");
    assert.equal(result.decision, profit > 0n ? "blockscan_submit_disabled" : "final_verify_failed");
    assert(!result.submitted);
    if (profit > 0n) {
      assert.equal(evaluation.evaluation.maxBaseFeePerGas, 1000n);
      assert.equal(evaluation.evaluation.gasUnits, 25000n); assert.equal(evaluation.calldata, input.calldata);
      assert.equal(methods.length, 4);
    } else {
      assert.equal(evaluation, undefined); assert.equal(methods.length, 1);
    }
  } finally { runtime.close(); }
});
