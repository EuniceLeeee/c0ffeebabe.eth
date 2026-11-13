import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAddress, toBeHex } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../encoder.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { parseFamilyTransaction } from "./family-transaction-registry.js";
import { assertRegisteredAcceptanceSample, registerTransactionAcceptanceSample, transactionSimulationCase } from "./protocol-json-sample-registration.js";
import { basicRouteAcceptanceStages, verifyBasicRouteAcceptance } from "./protocol-json-basic-facts.js";
import { assertUniqueAcceptanceGraphEdge } from "./family-json-ready.js";

const address = (n: number) => toBeHex(n, 20), blockHash = toBeHex(100, 32);
function fixture(tokenIn = address(4), tokenOut = address(5)) {
  const transaction = parseFamilyTransaction({ version: 1, chainId: 1, transactionHash: toBeHex(101, 32), legs: [{
    id: "forward", familyId: "protocol:fixture", domain: "protocol", instanceKey: address(3), lineageId: "fixture:v1",
    source: { number: 100, hash: blockHash }, tokenIn, tokenOut, amountIn: "17",
    historicalAmountOut: "999999", amountScope: "historical-input", actors: { executor: address(1), owner: address(2) },
  }] });
  const leg = transaction.legs[0]!, sample = transactionSimulationCase(transaction, leg), source = { ...sample.source, generation: 1 };
  const program = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 1n).bytes());
  const force = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes());
  const executions = ["quoted", "runtime"].flatMap(encoding => ["positive", "no-input", "forced-revert"].map(probe => {
    const script = probe === "forced-revert" ? concatBytes(program, force) : program;
    const request = { id: `${encoding}-${probe}`, kind: "effect-delta-simulation", required: false,
      call: { caller: { kind: "executor" }, executionMode: "executor-program", to: sample.executor, data: buildSubscriptCalldata(script) },
      overrideIntent: { caller: { kind: "executor" }, nativeBalanceWei: 17n,
        tokenBalances: [{ token: leg.tokenIn, amount: probe === "no-input" ? 0n : 118n }, { token: leg.tokenOut, amount: 137n }] } };
    return { encoding, probe, recipient: sample.executor, inputMode: "exact", result: "pass", request,
      scriptSha256: createHash("sha256").update(script).digest("hex"), resultEvidence: {
        id: request.id, source, ok: true, completion: probe === "positive" ? "returned" : "reverted-as-declared", data: "0x",
        provenance: { kind: "strict-simulation-transport", fingerprint: "fixture-only-observer" }, effects: {
          tokenDeltas: [{ token: leg.tokenIn, account: sample.executor, delta: probe === "positive" ? -17n : 0n },
            { token: leg.tokenOut, account: sample.executor, delta: probe === "positive" ? 34n : 0n }],
          nativeDeltas: [{ account: sample.executor, delta: 0n }], totalSupplyDeltas: [], logs: [],
        },
      } };
  }));
  const report: any = { source, runtimeConstruction: { exact: 1, quoted: 1, runtimeBuilds: 1, forbiddenDuringRuntimeBuild: 0 },
    samples: [{ id: leg.id, routeKey: "fixture-route", quote: { status: "resolved", amountIn: 17n, amountOut: 34n,
      familyId: sample.familyId, instanceKey: sample.instanceKey, routeKey: "fixture-route", source, generation: source.generation }, executions }] };
  return { transaction, leg, sample, report };
}

test("historical output is reference-only; current quote and independent simulation raw effects must agree", () => {
  const { sample, report } = fixture();
  assert.equal(sample.trials[0]!.expectedAmountOut, undefined);
  const stages = verifyBasicRouteAcceptance(sample, report, true);
  assert.deepEqual(stages.quotedExecution, { status: "pass", required: true, actualAmountIn: "17", actualAmountOut: "34",
    differenceFromExact: "0", controls: { positive: "pass", noInput: "pass", forcedRevert: "pass" } });
  assert.equal(stages.runtimeExecution.differenceFromExact, "0");
  assert.equal(sample.trials[0]!.inputToleranceRawUnits, 0);
  assert.equal(stages.simulationOutputParity.toleranceRawUnits, 1);
});

test("quoted/runtime allow exactly one output raw unit, keep signed differences, and reject two", () => {
  for (const encoding of ["quoted", "runtime"]) for (const difference of [-2n, -1n, 0n, 1n, 2n]) {
    const { sample, report } = fixture();
    const positive = report.samples[0].executions.find((e: any) => e.encoding === encoding && e.probe === "positive");
    positive.resultEvidence.effects.tokenDeltas[1].delta += difference;
    if (difference < -1n || difference > 1n) {
      assert.throws(() => verifyBasicRouteAcceptance(sample, report, true), /output-shortfall|output-excess/);
      assert.equal(basicRouteAcceptanceStages(sample, report, true).simulationOutputParity.toleranceRawUnits, 1);
    } else {
      const stages = verifyBasicRouteAcceptance(sample, report, true);
      assert.equal(stages[encoding === "quoted" ? "quotedExecution" : "runtimeExecution"].differenceFromExact, difference.toString());
      assert.equal(stages.exact.requestedAmountIn, "17"); assert.equal(stages.exact.quotedAmountOut, "34");
    }
  }
});

test("explicit zero stays strict; invalid tolerances and input debit/inventory violations remain rejected", () => {
  const { sample, report } = fixture();
  const zero = { ...sample, trials: sample.trials.map(t => ({ ...t, outputToleranceRawUnits: 0 as const })) };
  assert.equal(verifyBasicRouteAcceptance(zero, report, true).simulationOutputParity.toleranceRawUnits, 0);
  report.samples[0].executions[0].resultEvidence.effects.tokenDeltas[1].delta = 33n;
  assert.throws(() => verifyBasicRouteAcceptance(zero, report, true), /output-shortfall/);
  for (const field of ["outputToleranceRawUnits", "inputToleranceRawUnits"]) {
    const invalid: any = { ...sample, trials: sample.trials.map(t => ({ ...t, [field]: field === "inputToleranceRawUnits" ? 1 : 2 })) };
    assert.throws(() => verifyBasicRouteAcceptance(invalid, report, true));
  }
  for (const encoding of ["quoted", "runtime"]) for (const debit of [0n, -16n, -18n]) {
    const f = fixture();
    f.report.samples[0].executions.find((e: any) => e.encoding === encoding && e.probe === "positive").resultEvidence.effects.tokenDeltas[0].delta = debit;
    assert.throws(() => verifyBasicRouteAcceptance(f.sample, f.report, true), /nonpositive-debit|input-underdebit|input-overdebit/);
  }
  for (const mutate of [
    (e: any) => { e.tokenDeltas[1].delta = 0n; },
    (e: any) => { e.nativeDeltas[0].delta = -1n; },
    (e: any) => { e.tokenDeltas.push({ token: address(99), account: address(1), delta: -1n }); },
  ]) {
    const f = fixture(); mutate(f.report.samples[0].executions[0].resultEvidence.effects);
    assert.throws(() => verifyBasicRouteAcceptance(f.sample, f.report, true), /nonpositive-credit|native-inventory|protected-token-inventory/);
  }
});

test("funding controls compare address identity while preserving amounts and exact fields", () => {
  const { sample, report } = fixture(getAddress("0xb753428af26e81097e7fd17f40c88aaa3e04902c"),
    getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"));
  for (const execution of report.samples[0].executions) {
    for (const balance of execution.request.overrideIntent.tokenBalances) balance.token = balance.token.toLowerCase();
  }
  assert.equal(verifyBasicRouteAcceptance(sample, report, true).quotedExecution.status, "pass");
  for (const mutate of [
    (r: any) => { r.tokenBalances[0].token = address(99); },
    (r: any) => { r.tokenBalances[0].amount += 1n; },
    (r: any) => { r.tokenBalances.push({ ...r.tokenBalances[0] }); },
    (r: any) => { r.extra = true; },
  ]) {
    const changed = structuredClone(report); mutate(changed.samples[0].executions[0].request.overrideIntent);
    assert.throws(() => verifyBasicRouteAcceptance(sample, changed, true), /preparation differs/);
  }
});

test("wrong requested quote input and two-unit output discrepancy cannot pass via stored result labels", () => {
  for (const mutate of [(r: any) => { r.samples[0].quote.amountIn = 18n; },
    (r: any) => { r.samples[0].executions[0].resultEvidence.effects.tokenDeltas[1].delta = 36n; }]) {
    const { sample, report } = fixture(); mutate(report);
    assert.throws(() => verifyBasicRouteAcceptance(sample, report, true));
    assert.equal(basicRouteAcceptanceStages(sample, report, true).simulationOutputParity.status, "failed");
  }
});

test("raw verifier rejects missing/duplicate controls, missing runtime, foreign observations, altered preparations, and transport failure", () => {
  const mutations = [
    (r: any) => { r.samples[0].executions.pop(); },
    (r: any) => { r.samples[0].executions[1].probe = "positive"; },
    (r: any) => { r.runtimeConstruction.runtimeBuilds = 0; },
    (r: any) => { r.samples[0].executions[0].resultEvidence.effects.tokenDeltas[1].account = address(99); },
    (r: any) => { r.samples[0].executions[0].request.overrideIntent.tokenBalances[0].amount = 119n; },
    (r: any) => { r.samples[0].executions[1].resultEvidence = { ok: false, failure: "out-of-gas" }; },
  ];
  for (const mutate of mutations) { const { sample, report } = fixture(); mutate(report); assert.throws(() => verifyBasicRouteAcceptance(sample, report, true)); }
});

test("no-input and rollback controls must execute the same program, with rollback appended at the end", () => {
  for (const index of [1, 2]) {
    const { sample, report } = fixture(), row = report.samples[0].executions[index];
    const wrong = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 777n).bytes());
    row.request.call.data = buildSubscriptCalldata(wrong); row.scriptSha256 = createHash("sha256").update(wrong).digest("hex");
    assert.throws(() => verifyBasicRouteAcceptance(sample, report, true), /program|rollback/);
  }
});

test("a missing ordinary runtime cannot be marked optional for a conversion", () => {
  const { sample, report } = fixture(); assert.throws(() => verifyBasicRouteAcceptance(sample, report, false), /cannot be waived/);
});

test("quote identity and Credit policy remain bound to this case", () => {
  for (const mutate of [(q: any) => { q.familyId = "protocol:other"; }, (q: any) => { q.instanceKey = address(9); },
    (q: any) => { q.routeKey = "reverse"; }, (q: any) => { q.source = { ...q.source, generation: 99 }; }]) {
    const { sample, report } = fixture(); mutate(report.samples[0].quote);
    assert.throws(() => verifyBasicRouteAcceptance(sample, report, true));
  }
  const { sample, report } = fixture();
  const credit = { ...sample, domain: "credit" as const, trials: sample.trials.map(t => ({ ...t, credit: { debtBps: 7500 } })) };
  Object.assign(report.samples[0].quote, { collateralAmount: 17n, debtBps: 7500n, blocksPrefixInversion: true });
  assert.equal(verifyBasicRouteAcceptance(credit, report, false).runtimeExecution.status, "not-declared");
  report.samples[0].quote.debtBps = 5000n;
  assert.throws(() => verifyBasicRouteAcceptance(credit, report, false), /policy/);
});

test("registry registration binds direction, actors, input and policy, and detects subsequent seed mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "family-seed-registration-"));
  try {
    mkdirSync(join(root, "family-transactions"));
    const { transaction, leg, sample } = fixture(), path = join(root, "family-transactions", `${transaction.transactionHash}.json`);
    writeFileSync(path, JSON.stringify(transaction));
    const registration = registerTransactionAcceptanceSample(sample, path, leg.id, root);
    assertRegisteredAcceptanceSample(sample, registration);
    assert.throws(() => registerTransactionAcceptanceSample({ ...sample, owner: address(9) }, path, leg.id, root), /differs/);
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    assert.throws(() => assertRegisteredAcceptanceSample(sample, registration), /changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint comparison requires exactly one complete target edge, not a nonempty unrelated graph", () => {
  const edge: any = { canonicalEdgeId: "family:edge", instanceKey: address(3), executionVariantKey: "route-binding",
    adapterId: "family-action", target: address(3), tokenIn: address(4), tokenOut: address(5), slotKind: "protocol",
    protocolAction: "redeem", edgeKind: "conversion", leavesStandingPosition: false, score: 0 };
  assert.equal(assertUniqueAcceptanceGraphEdge([edge], edge), edge);
  assert.throws(() => assertUniqueAcceptanceGraphEdge([{ ...edge, canonicalEdgeId: "other", instanceKey: address(10) }], edge), /unique/);
  assert.throws(() => assertUniqueAcceptanceGraphEdge([edge, edge], edge), /unique/);
  for (const property of ["target", "tokenOut", "slotKind", "leavesStandingPosition"]) {
    const changed = { ...edge }; delete changed[property];
    assert.throws(() => assertUniqueAcceptanceGraphEdge([changed], edge), /differs/);
  }
});
