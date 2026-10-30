import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const op = (op: string, ...args: any[]) => ({ op, args });
const address = (n: number) => toBeHex(n, 20);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const math = createDeclarativeMathRegistry([{ id: "fixture:quote", version: 1,
  validateInput(value: any) { assert.equal(typeof value, "bigint"); },
  evaluate: (value: any) => value,
  validateOutput(value: any) { assert.equal(typeof value, "bigint"); },
}]);
function document(): any {
  const doc: any = clone(root);
  doc.standard.modules = { math: { version: 1, entries: { quote: { model: "fixture:quote", version: 1 } } }, quoteFlow: {
    version: 1, sourceKind: "local-math", localStateUnsupportedReason: "fixture has no sequential state model",
    steps: [{ id: "state", requirements: { transports: ["eth-call"] }, requests: [
      { id: "state", kind: "eth-call", to: "$target", data: "0x12345678", completion: "return-data" },
    ], result: op("word", op("get", op("returned", "state"), "data")) }], result: op("model", "quote", "$steps.state"),
  } };
  doc.standard.exact.evidence = op("merge", doc.standard.exact.evidence,
    op("if", op("eq", "$amountOut", op("uint", "0")), { unavailableReason: "input-capacity" }, {}));
  // Zero-input evidence is deliberately different from a positive-input refusal.
  doc.standard.exact.zeroEvidence = { amountIn: "$amountIn", amountOut: "$amountOut", kind: "zero-input" };
  return doc;
}
function setup(doc = document(), fields: Record<string, unknown> = {}) {
  const runtime = createDeclarativeProtocolRuntime(doc, [clone(custodian), clone(infinifi)], { math });
  const descriptor: any = { familyId: root.scope.family, lineageId: runtime.variants[0]!.document.lineageId,
    instanceKey: address(1), vault: address(1), asset: address(2), share: address(1),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [], ...fields };
  const route: any = runtime.definition.routes.project({ descriptor })[0];
  const input: any = { descriptor, route, amountIn: 7n, source, executor: address(10), runtimeEvidence: [] };
  const method: any = runtime.definition.exact.methods(input)[1];
  const response = (amount: bigint): any => ({ id: "state", ok: true, completion: "returned", data: toBeHex(amount, 32),
    source, provenance: { kind: "fixture", fingerprint: "fixture" } });
  const decode = (amount: bigint, results = [response(amount)]) => method.program.decode({
    programInput: input, initialResults: results, dependentEvidence: [],
  });
  return { runtime, input, method, response, decode };
}

test("positive-input zero quote preserves its amount and reason, without execution support", () => {
  const f = setup(), refused = f.decode(0n);
  assert.equal(refused.amountOut, 0n);
  assert.equal(refused.evidence.amountIn, 7n);
  assert.equal(refused.evidence.unavailableReason, "input-capacity");
  assert.notEqual(refused.evidence.kind, "zero-input");
  assert.equal(refused.stateChanges, undefined);
  assert.throws(() => f.runtime.definition.execution.buildFragment({ ...f.input,
    quotedAmountOut: 0n, minAmountOut: 0n, exactEvidence: refused.evidence }));
  const quoted = f.decode(9n);
  assert.equal(quoted.amountOut, 9n);
  assert.equal(quoted.evidence.unavailableReason, undefined);
});

test("zero output is not a substitute for missing reason, wrong source or transport failure", () => {
  for (const unavailableReason of [undefined, "", "   ", 0, false]) {
    const doc = document(); doc.standard.exact.evidence = { ...clone(root.standard.exact.evidence),
      ...(unavailableReason === undefined ? {} : { unavailableReason }) };
    assert.throws(() => setup(doc).decode(0n), /unavailableReason/);
  }
  const f = setup();
  assert.throws(() => f.decode(0n, [{ ...f.response(0n), source: { ...source, generation: 2 } }]));
  assert.throws(() => f.decode(0n, [{ ...f.response(0n), ok: false, failure: "rpc" }]));
});

test("state-only reads are an explicit local-math capability, absent on old JSON", () => {
  assert.equal(setup().method.stateOnlyReads, undefined);
  const doc = document(); doc.standard.exact.stateOnlyReads = true;
  const f = setup(doc);
  assert.equal(f.method.stateOnlyReads, true);
  assert.deepEqual(f.method.program.buildRequests(f.input),
    f.method.program.buildRequests({ ...f.input, amountIn: 99n }));
  assert.equal(f.decode(8n).amountOut, 8n);
  doc.standard.exact.stateOnlyReads = "true";
  assert.throws(() => setup(doc), /explicit boolean/);
  const original: any = clone(root); original.standard.exact.stateOnlyReads = true;
  assert.throws(() => setup(original), /local-math/);
});

function trialDocument(): any {
  const doc = document();
  delete doc.standard.modules.quoteFlow.localStateUnsupportedReason;
  doc.standard.modules.quoteFlow.result = { amountOut: op("model", "quote", "$steps.state"), fund: { reserve: "$steps.state" } };
  doc.standard.exact.amountOut = "$quoteResult.amountOut";
  const ref = { key: "fixture:state", schema: "fixture:v1", binding: "$route.bindingRef.fingerprint", dependencies: [] };
  doc.standard.modules.trialState = { version: 1, when: op("eq", "$descriptor.accessProven", true),
    unsupportedReason: "permission-dependent-state", reads: [{ id: "fund", refs: [ref], initial: ["$prepared.fund"] }],
    model: "quote", input: "$stateReads.fund.0.reserve", amountOut: "$modelResult",
    stateChanges: [{ ref: "$stateRefs.fund.0", value: { reserve: op("uint", "0") } }], stateEffects: ["balance:executor"] };
  return doc;
}

test("trial eligibility is descriptor-specific while a cold source quote remains available", () => {
  const doc = trialDocument();
  const unavailable = setup(doc, { accessProven: false });
  assert.equal(unavailable.method.trialState.unsupportedReason, "permission-dependent-state");
  assert.equal(unavailable.decode(9n).amountOut, 9n);
  assert.equal(unavailable.decode(9n).stateChanges, undefined);
  assert.equal(unavailable.decode(0n).evidence.unavailableReason, "input-capacity");
  const supported = setup(doc, { accessProven: true });
  assert.equal(typeof supported.method.trialState.quote, "function");
  assert.equal(supported.decode(9n).stateChanges.length, 1);
  assert.equal(supported.decode(0n).stateChanges, undefined);
  doc.standard.modules.trialState.when = "not-a-boolean";
  assert.throws(() => setup(doc), /condition must resolve to boolean/);
  delete doc.standard.modules.trialState.unsupportedReason;
  assert.throws(() => setup(doc), /unsupportedReason/);
});

test("empty-request guards reject the same changed input on cold and local trial paths", () => {
  const doc = trialDocument();
  doc.standard.modules.trialState.stateChanges[0].value.reserve = "$modelResult";
  doc.standard.exact.guardProgram = "permissionGuard";
  doc.standard.readPrograms.permissionGuard = { requests: [], decode: [
    { assert: op("eq", "$amountIn", op("uint", "7")), error: "pure guard refuses this input" },
    { return: true },
  ] };
  const f = setup(doc, { accessProven: true }), first = f.decode(9n);
  const state = applyExactTrialState(emptyExactTrialState(), first.stateChanges, first.stateEffects);
  const hot = { ...f.input, trialState: state.view };
  assert.equal(f.method.trialState.quote(hot).result.amountOut, 9n);
  const changed = { ...hot, amountIn: 8n };
  assert.throws(() => f.method.program.decode({ programInput: changed,
    initialResults: [f.response(9n)], dependentEvidence: [] }), /pure guard refuses this input/);
  assert.throws(() => f.method.trialState.quote(changed), /pure guard refuses this input/);
  assert.equal((state.view.get(first.stateChanges[0].ref) as any).reserve, 9n);
});

test("empty-request guard results feed output checks on both cold and local trial paths", () => {
  const doc = trialDocument();
  doc.standard.modules.trialState.stateChanges[0].value.reserve = "$modelResult";
  doc.standard.exact.guardProgram = "outputGuard";
  doc.standard.readPrograms.outputGuard = { requests: [], decode: [{ return: { allowedOutput: "$amountIn" } }] };
  doc.standard.exact.outputChecks = [
    { assert: op("eq", "$amountOut", "$guardResult.allowedOutput"), error: "guard output bound failed" },
  ];
  const f = setup(doc, { accessProven: true }), first = f.decode(7n);
  const state = applyExactTrialState(emptyExactTrialState(), first.stateChanges, first.stateEffects);
  const hot = { ...f.input, trialState: state.view };
  assert.equal(f.method.trialState.quote(hot).result.amountOut, 7n);
  const changed = { ...hot, amountIn: 8n };
  assert.throws(() => f.method.program.decode({ programInput: changed,
    initialResults: [f.response(7n)], dependentEvidence: [] }), /guard output bound failed/);
  assert.throws(() => f.method.trialState.quote(changed), /guard output bound failed/);
  assert.equal((state.view.get(first.stateChanges[0].ref) as any).reserve, 7n);
});
