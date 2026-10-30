import assert from "node:assert/strict";
import test from "node:test";
import { MaxUint256, toBeHex } from "ethers";
import { parseProtocolJsonAcceptanceCase, checkProtocolJsonExecutionFacts, checkProtocolJsonRevertFacts,
  type ProtocolJsonExecutionFactInput } from "./protocol-json-acceptance-facts.js";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";

const address = (n: number) => toBeHex(n, 20), tokenIn = address(1), tokenOut = address(2), executor = address(3), recipient = address(4), owner = address(5);
const extra = address(6), other = address(7), source = { number: 12345, hash: toBeHex(12345, 32), generation: 3 };
const caseData = () => ({ version: 1, familyId: "protocol:fixture", instanceKey: "fixture-instance", lineageId: "fixture-lineage",
  source: { number: source.number, hash: source.hash }, executor, owner, transactionHash: toBeHex(999, 32),
  trials: [{ id: "forward", tokenIn, tokenOut, amountIn: "100", expectedAmountOut: "200", recipients: [recipient],
    protectedBalances: [{ token: extra, account: executor }] }] });
function result(debit = 100n, credit = 200n): Extract<AdapterRequestResult, { ok: true }> {
  return { id: "actual", source, ok: true, completion: "returned", data: "0x",
    provenance: { kind: "strict-simulation-transport", fingerprint: "fixture-observation" }, effects: {
      tokenDeltas: [{ token: tokenIn, account: executor, delta: -debit }, { token: tokenOut, account: recipient, delta: credit },
        { token: tokenOut, account: executor, delta: 0n }, { token: tokenIn, account: recipient, delta: 0n }],
      nativeDeltas: [{ account: executor, delta: 0n }],
    } };
}
const input = (r: AdapterRequestResult = result()): ProtocolJsonExecutionFactInput => ({ requestId: "actual", result: r,
  source, tokenIn, tokenOut, executor, recipient, amountIn: 100n, quoteAmountOut: 200n, inputMode: "exact" });
const failed = (r: AdapterRequestResult, code: string, options: Partial<ProtocolJsonExecutionFactInput> = {}) => {
  const facts = checkProtocolJsonExecutionFacts({ ...input(r), ...options }); assert.equal(facts.passed, false);
  assert(facts.violations.some(v => v.code === code), JSON.stringify(facts)); return facts;
};

test("case format is data-only, protocol-generic, normalized and immutable", () => {
  const d = caseData(), parsed = parseProtocolJsonAcceptanceCase(d);
  assert.equal(parsed.familyId, "protocol:fixture"); assert.equal(parsed.trials[0]!.amountIn, "100");
  assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.trials) && Object.isFrozen(parsed.trials[0]!.protectedBalances));
  d.trials[0]!.amountIn = "101"; assert.equal(parsed.trials[0]!.amountIn, "100");
  const minimal = caseData() as any; delete minimal.transactionHash; delete minimal.trials[0].expectedAmountOut;
  delete minimal.trials[0].recipients; delete minimal.trials[0].protectedBalances;
  assert.equal(parseProtocolJsonAcceptanceCase(minimal).trials.length, 1);
});

test("Swap cases require an explicit domain while legacy Protocol cases remain unchanged", () => {
  const legacy = parseProtocolJsonAcceptanceCase(caseData()); assert.equal(legacy.domain, undefined);
  for (const familyId of ["balancer-v1", "custom-swap:dodo-v2", "swap:algebra-integral"]) {
    const raw = { ...caseData(), domain: "swap", familyId };
    const parsed = parseProtocolJsonAcceptanceCase(raw); assert.equal(parsed.domain, "swap");
    assert.equal(parsed.familyId, familyId); assert(Object.isFrozen(parsed));
    const { domain: _domain, ...withoutDomain } = raw;
    assert.throws(() => parseProtocolJsonAcceptanceCase(withoutDomain), /domain/);
  }
  assert.equal(parseProtocolJsonAcceptanceCase({ ...caseData(), domain: "protocol" }).domain, "protocol");
  for (const [domain, familyId] of [["swap", "protocol:fixture"], ["swap", "credit:fixture"],
    ["swap", "funding:fixture"], ["protocol", "balancer-v1"], ["credit", "credit:fixture"],
    [null, "protocol:fixture"], ["swap", "../fixture"], ["swap", " fixture"], ["protocol", "protocol::fixture"]])
    assert.throws(() => parseProtocolJsonAcceptanceCase({ ...caseData(), domain, familyId }), /domain/);
});

test("a route key is an immutable selection field, never executable case code", () => {
  const raw: any = caseData(); raw.trials[0].routeKey = "pool:route:0:1";
  const parsed = parseProtocolJsonAcceptanceCase(raw);
  assert.equal(parsed.trials[0]!.routeKey, "pool:route:0:1");
  raw.trials[0].routeKey = "changed"; assert.equal(parsed.trials[0]!.routeKey, "pool:route:0:1");
  for (const routeKey of ["", " trailing ", null, 1, { selector: "0x00" }]) {
    raw.trials[0].routeKey = routeKey; assert.throws(() => parseProtocolJsonAcceptanceCase(raw));
  }
});

test("case JSON cannot decide admission, rejection, success or execution code", () => {
  for (const mutation of [
    (d: any) => { d.descriptor = {}; }, (d: any) => { d.admitted = true; },
    (d: any) => { d.binding = { module: "evil" }; }, (d: any) => { d.trials[0].expected = "reject"; },
    (d: any) => { d.trials[0].passed = true; }, (d: any) => { d.trials[0].handler = () => true; },
    (d: any) => { d.familyId = "swap:fixture"; }, (d: any) => { d.version = 2; },
    (d: any) => { d.source.generation = 3; }, (d: any) => { d.source.hash = "0x1234"; },
    (d: any) => { d.source.number = 1.5; }, (d: any) => { d.executor = toBeHex(0, 20); },
    (d: any) => { d.trials.push(structuredClone(d.trials[0])); }, (d: any) => { d.trials = []; },
    (d: any) => { d.trials[0].tokenOut = d.trials[0].tokenIn; },
    (d: any) => { d.trials[0].recipients.push(recipient); },
    (d: any) => { d.trials[0].protectedBalances.push({ token: extra, account: executor }); },
    (d: any) => { d.trials[0].inputToleranceRawUnits = 2; },
    (d: any) => { d.trials[0].outputToleranceRawUnits = "1"; },
  ]) { const d = caseData(); mutation(d); assert.throws(() => parseProtocolJsonAcceptanceCase(d)); }
  for (const amount of [0, "0", "00", "01", "-1", "1.0", "1e3", "0xff", (MaxUint256 + 1n).toString()]) {
    const d = caseData() as any; d.trials[0].amountIn = amount; assert.throws(() => parseProtocolJsonAcceptanceCase(d));
  }
  let invoked = false; const getter = caseData();
  Object.defineProperty(getter, "executor", { get() { invoked = true; return executor; } });
  assert.throws(() => parseProtocolJsonAcceptanceCase(getter)); assert.equal(invoked, false);
  const sparse = caseData(); sparse.trials = new Array(1); assert.throws(() => parseProtocolJsonAcceptanceCase(sparse));
});

test("actual receipt facts distinguish debit and credit without modifying input or quote", () => {
  const i = input(), facts = checkProtocolJsonExecutionFacts(i);
  assert.equal(facts.passed, true); assert.equal(facts.classification, "executed-as-quoted");
  assert.deepEqual(facts.observed, { actualDebit: "100", actualCredit: "200", requestedInput: "100", quotedOutput: "200",
    expectedOutput: null, inputMode: "exact", inputShortfall: "0", outputShortfall: "0", outputExcess: "0",
    inputToleranceRawUnits: 0, outputToleranceRawUnits: 0 });
  assert.equal(i.amountIn, 100n); assert.equal(i.quoteAmountOut, 200n); assert.doesNotThrow(() => JSON.stringify(facts));
});

test("input and output tolerances have separate explicit zero/one/two boundaries", () => {
  for (const tolerance of [0, 1] as const) for (const difference of [0, 1, 2]) {
    const debit = checkProtocolJsonExecutionFacts({ ...input(result(100n - BigInt(difference))), inputToleranceRawUnits: tolerance });
    assert.equal(debit.passed, difference <= tolerance); assert.equal(debit.observed.inputShortfall, String(difference));
    assert.equal(debit.observed.outputShortfall, "0");
    for (const sign of [-1n, 1n]) {
      const credit = checkProtocolJsonExecutionFacts({ ...input(result(100n, 200n + sign * BigInt(difference))), outputToleranceRawUnits: tolerance });
      assert.equal(credit.passed, difference <= tolerance);
      assert.equal(credit.observed[sign < 0n ? "outputShortfall" : "outputExcess"], String(difference));
    }
  }
  failed(result(99n, 199n), "input-underdebit", { outputToleranceRawUnits: 1 });
  failed(result(99n, 199n), "output-shortfall", { inputToleranceRawUnits: 1 });
  failed(result(101n), "input-overdebit", { inputToleranceRawUnits: 1 });
  failed(result(0n), "nonpositive-debit", { amountIn: 1n, inputToleranceRawUnits: 1 });
  failed(result(100n, 0n), "nonpositive-credit", { quoteAmountOut: 1n, outputToleranceRawUnits: 1 });
});

test("maximum mode permits only positive actual debit within the invocation budget", () => {
  for (const debit of [1n, 40n, 100n]) {
    const facts = checkProtocolJsonExecutionFacts({ ...input(result(debit)), inputMode: "maximum" });
    assert.equal(facts.passed, true); assert.equal(facts.observed.inputShortfall, (100n - debit).toString());
  }
  failed(result(0n), "nonpositive-debit", { inputMode: "maximum" });
  failed(result(-1n), "nonpositive-debit", { inputMode: "maximum" });
  failed(result(101n), "input-overdebit", { inputMode: "maximum", inputToleranceRawUnits: 1 });
});

test("completed success labels do not replace source, request identity or unique measured balances", () => {
  for (const [change, code] of [
    [(r: any) => { r.id = "another-request"; }, "request-id"],
    [(r: any) => { r.source = { ...source, hash: toBeHex(9, 32) }; }, "source"],
    [(r: any) => { r.source = { ...source, generation: 4 }; }, "source"],
    [(r: any) => { r.completion = "success"; r.success = true; }, "completion"],
    [(r: any) => { r.completion = "reverted-as-declared"; }, "completion"],
    [(r: any) => { delete r.provenance; }, "provenance"],
    [(r: any) => { delete r.effects; r.passed = true; }, "missing-token-effects"],
    [(r: any) => { r.effects.tokenDeltas = []; }, "missing-token-delta"],
    [(r: any) => { r.effects.tokenDeltas.pop(); }, "missing-token-delta"],
    [(r: any) => { r.effects.tokenDeltas.push({ ...r.effects.tokenDeltas[0] }); }, "duplicate-token-delta"],
    [(r: any) => { r.effects.tokenDeltas[0].delta = "-100"; }, "invalid-token-delta"],
    [(r: any) => { delete r.effects.nativeDeltas; }, "missing-native-effects"],
    [(r: any) => { r.effects.nativeDeltas = []; }, "missing-native-delta"],
    [(r: any) => { r.effects.nativeDeltas.push({ account: executor, delta: 0n }); }, "duplicate-native-delta"],
  ] as const) { const r = structuredClone(result()); change(r); failed(r, code); }
  const rpc = { id: "actual", source, ok: false, failure: "rpc", success: true, effects: result().effects } as any;
  assert.equal(failed(rpc, "transport-failure").classification, "transport-failure");
});

test("executor old output, recipient old input and native inventory cannot subsidize receipt", () => {
  for (const index of [2, 3]) {
    const r = structuredClone(result()); (r.effects!.tokenDeltas![index]! as any).delta = -1n;
    failed(r, "protected-token-inventory");
  }
  const native = structuredClone(result()); (native.effects!.nativeDeltas![0]! as any).delta = -1n;
  failed(native, "native-inventory");
  const crossRebate = structuredClone(result()); (crossRebate.effects!.tokenDeltas![3]! as any).delta = 1n;
  failed(crossRebate, "protected-token-inventory");
});

test("additional protected pairs must each have independently observed zero delta", () => {
  const protectedBalances = [{ token: extra, account: other }];
  failed(result(), "missing-token-delta", { protectedBalances });
  const r = structuredClone(result()); (r.effects!.tokenDeltas! as any[]).push({ token: extra, account: other, delta: 0n });
  assert.equal(checkProtocolJsonExecutionFacts({ ...input(r), protectedBalances }).passed, true);
  (r.effects!.tokenDeltas![4]! as any).delta = -1n;
  failed(r, "protected-token-inventory", { protectedBalances });
  assert.throws(() => checkProtocolJsonExecutionFacts({ ...input(), protectedBalances: [{ token: tokenIn, account: executor }] }));
  failed(result(), "expected-output", { expectedAmountOut: 202n });
  assert.equal(checkProtocolJsonExecutionFacts({ ...input(), expectedAmountOut: 201n, outputToleranceRawUnits: 1 }).passed, true);
});

const reverted = (empty = false) => {
  const r = result(0n, 0n);
  return { ...r, completion: "reverted-as-declared" as const, effects: empty ? { tokenDeltas: [], nativeDeltas: [] } : r.effects };
};
test("negative probes recognize only completed EVM rejection and distinguish rollback evidence", () => {
  for (const probe of ["no-input", "forced-revert"] as const) for (const empty of [false, true]) {
    const facts = checkProtocolJsonRevertFacts({ ...input(reverted(empty)), probe });
    assert.equal(facts.passed, true); assert.equal(facts.classification, "observed-revert");
    assert.equal(facts.rollbackEvidence, empty ? "completed-evm-revert" : "observed-zero-balances");
    assert.equal(facts.observed.measuredZeroBalances, !empty);
  }
});

test("RPC failures, missing/partial rollback observations and fake success cannot pass negative probes", () => {
  const rejects = (r: AdapterRequestResult) => {
    const facts = checkProtocolJsonRevertFacts({ ...input(r), probe: "forced-revert" });
    assert.equal(facts.passed, false); assert.equal(facts.rollbackEvidence, undefined); return facts;
  };
  rejects(result());
  for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const)
    assert.equal(rejects({ id: "actual", source, ok: false, failure }).classification, "transport-failure");
  for (const change of [
    (r: any) => { delete r.effects; }, (r: any) => { delete r.effects.nativeDeltas; },
    (r: any) => { delete r.effects.tokenDeltas; }, (r: any) => { r.provenance.kind = "synthetic"; },
    (r: any) => { r.source = { ...source, number: source.number + 1 }; },
    (r: any) => { r.effects.tokenDeltas = [{ token: tokenIn, account: executor, delta: 0n }]; },
    (r: any) => { r.effects.logs = [{ address: executor, topics: [], data: "0x" }]; },
  ]) { const r = reverted(true); change(r); rejects(r); }
  for (const change of [
    (r: any) => { r.effects.tokenDeltas[0].delta = -1n; },
    (r: any) => { r.effects.nativeDeltas[0].delta = -1n; },
    (r: any) => { r.effects.tokenDeltas.pop(); },
    (r: any) => { r.effects.tokenDeltas.push(r.effects.tokenDeltas[0]); },
    (r: any) => { r.effects.totalSupplyDeltas = [{ token: tokenIn, delta: 1n }]; },
  ]) { const r = reverted(); change(r); rejects(r); }
});
