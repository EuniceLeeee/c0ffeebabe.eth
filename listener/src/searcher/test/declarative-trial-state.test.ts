import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";
import { compileDeclarativeTrialState, validateDeclarativeTrialState } from "../venues/declarative-trial-state.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";

const ref = { key: "fund:one", schema: "fixture:v1", binding: "bound-instance-and-executor", dependencies: ["oracle:one"] };
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const executor = toBeHex(1, 20);
const input: any = { source, executor, amountIn: 2n, descriptor: {},
  route: { direction: "redeem", bindingRef: { fingerprint: "bound-route" } }, runtimeEvidence: [], prefix: [] };
const observed: AdapterRequestResult[] = [{ id: "source", ok: true, source, completion: "returned", data: toBeHex(100, 32),
  provenance: { kind: "fixture", fingerprint: "fixture" } }];
const op = (op: string, ...args: any[]) => ({ op, args });
const definition: any = { version: 1, reads: [{ id: "fund", refs: [ref], initial: ["$prepared.fund"] }], model: "transition",
  input: { reserve: "$stateReads.fund.0.reserve", amount: "$amountIn" }, amountOut: "$modelResult.amountOut",
  stateChanges: [{ ref: "$stateRefs.fund.0", value: "$modelResult.state" }], stateEffects: ["balance:executor"] };
const models = createDeclarativeMathRegistry([{ id: "fixture:transition", version: 1,
  validateInput(value: any) { if (typeof value.reserve !== "bigint" || typeof value.amount !== "bigint") throw new Error("invalid math input"); },
  evaluate(value: any) { const reserve = value.reserve as bigint, amount = value.amount as bigint;
    const amountOut = reserve * amount / 10n; return { amountOut, state: { reserve: reserve - amountOut } }; },
  validateOutput(value: any) { if (value.amountOut < 0n || value.state.reserve < 0n) throw new Error("negative math output"); },
}]).bind({ version: 1, entries: { transition: { model: "fixture:transition", version: 1 } } });
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const evidence = (input: any, amountOut: bigint) => ({ source: input.source, executor: input.executor,
  direction: input.route.direction, amountIn: input.amountIn, amountOut, bindingFingerprint: input.route.bindingRef.fingerprint });
function compiled(document = definition, changes: any = {}) {
  return compileDeclarativeTrialState(document, { values, models, environment: input => ({ ...input }), evidence, ...changes });
}
function quoteResult(attempt: any) { assert.equal(attempt.status, "quoted"); return attempt.result; }
function seed() { return compiled().fromReadFlow({ ...input, trialState: emptyExactTrialState().view }, { fund: { reserve: 100n } }, observed); }

test("cold trial returns not-applicable; production source reads bootstrap and subsequent trials consume mutations", () => {
  const runtime = compiled(), empty = emptyExactTrialState();
  assert.equal(runtime.model.quote(input).status, "not-applicable");
  assert.equal(runtime.model.quote({ ...input, trialState: empty.view }).status, "not-applicable");
  const first = runtime.fromReadFlow({ ...input, trialState: empty.view }, { fund: { reserve: 100n } }, observed);
  assert.equal(first.amountOut, 20n);
  const after = applyExactTrialState(empty, first.stateChanges!, first.stateEffects);
  const second = quoteResult(runtime.model.quote({ ...input, trialState: after.view }));
  assert.equal(second.amountOut, 16n);
  const again = runtime.fromReadFlow({ ...input, trialState: after.view }, { fund: { reserve: 999n } }, observed);
  assert.equal(again.amountOut, 16n, "fresh baseline cannot reset an existing trial cell");
  assert.equal((after.view.get(ref) as any).reserve, 80n, "quote cannot mutate its supplied snapshot");
  assert.equal(empty.view.get(ref), undefined);
});

test("binding and dependency conflicts propagate even when fresh source data is available", () => {
  const first = seed(), runtime = compiled();
  const after = applyExactTrialState(emptyExactTrialState(), first.stateChanges!, first.stateEffects);
  const invalidated = applyExactTrialState(after, [], ["oracle:one"]);
  const dirtyInput = { ...input, trialState: invalidated.view };
  assert.throws(() => runtime.model.quote(dirtyInput), /invalidated dependency/);
  assert.throws(() => runtime.fromReadFlow(dirtyInput, { fund: { reserve: 999n } }, observed), /invalidated dependency/);
  const wrong = compiled({ ...definition, reads: [{ ...definition.reads[0], refs: [{ ...ref, binding: "other" }] }] });
  assert.throws(() => wrong.model.quote({ ...input, trialState: after.view }), /binding conflict/);
  assert.throws(() => runtime.fromReadFlow({ ...input, prefix: [{}] }, { fund: { reserve: 100n } }, observed), /issued state/);
});

test("bootstrap requires actual same-source transport evidence", () => {
  const runtime = compiled(), prepared = { fund: { reserve: 100n } };
  for (const rows of [[], [{ id: "failed", ok: false, source, failure: "rpc" }],
    observed.map(row => ({ ...row, source: { ...source, number: 101 } })),
    observed.map(row => ({ ...row, provenance: { kind: "", fingerprint: "" } })), [...observed, ...observed]])
    assert.throws(() => runtime.fromReadFlow(input, prepared, rows as any));
  assert.throws(() => runtime.fromReadFlow(input, undefined, observed), /observed source state/);
  assert.throws(() => runtime.fromReadFlow(input, {}, observed), /unavailable/);
});

test("quote evidence must match canonical source, executor, direction, amount and binding", () => {
  for (const changed of [{ source: { ...source, generation: 2 } }, { executor: toBeHex(2, 20) }, { direction: "mint" },
    { amountIn: 3n }, { amountOut: 1n }, { bindingFingerprint: "other" }, { executor: undefined }]) {
    const runtime = compiled(definition, { evidence: (i: any, out: bigint) => ({ ...evidence(i, out), ...changed }) });
    assert.throws(() => runtime.fromReadFlow(input, { fund: { reserve: 100n } }, observed));
  }
  assert.throws(() => compiled().fromReadFlow({ ...input, amountIn: 0n }, { fund: { reserve: 100n } }, observed), /positive/);
});

test("transitions use the existing verifier and cannot publish unread or incompletely bound cells", () => {
  for (const changed of [
    { stateChanges: [], stateEffects: [] },
    { stateChanges: [{ ref: { ...ref, key: "unread" }, value: "$modelResult.state" }] },
    { stateChanges: [{ ref: { key: ref.key, schema: ref.schema, binding: ref.binding }, value: "$modelResult.state" }] },
    { stateChanges: [...definition.stateChanges, ...definition.stateChanges] },
    { stateEffects: [""] },
    { stateChanges: [{ ref: "$stateRefs.fund.0", value: "$missing" }] },
  ]) assert.throws(() => compiled({ ...definition, ...changed }).fromReadFlow(input, { fund: { reserve: 100n } }, observed));
  const first = seed(), after = applyExactTrialState(emptyExactTrialState(), first.stateChanges!, first.stateEffects);
  assert.throws(() => after.view.get({ key: "unread-account", schema: "balance:v1", binding: "account", dependencies: ["balance:executor"] }), /invalidated dependency/);
});

test("ordered reads can derive and recheck a dynamic dependency closure", () => {
  const closure = { key: ref.key, schema: ref.schema, binding: ref.binding, dependencies: "$stateReads.initial.0.dependencies" };
  const document = { ...definition, reads: [
    { id: "initial", refs: [{ key: ref.key, schema: ref.schema, binding: ref.binding }], initial: ["$prepared.fund"] },
    { id: "fund", refs: [closure], initial: ["$prepared.fund"] },
    { id: "optional", refs: [{ ...ref, key: "optional" }], onMissing: "continue" },
  ] };
  const runtime = compiled(document);
  const result = runtime.fromReadFlow({ ...input, trialState: emptyExactTrialState().view }, { fund: { reserve: 100n, dependencies: ["oracle:one"] } }, observed);
  assert.equal(result.amountOut, 20n);
  assert.deepEqual(result.stateChanges![0].ref.dependencies, ["fund:one", "oracle:one"]);
  const broken = applyExactTrialState(emptyExactTrialState(), [], ["oracle:one"]);
  assert.throws(() => runtime.fromReadFlow({ ...input, trialState: broken.view }, { fund: { reserve: 100n, dependencies: ["oracle:one"] } }, observed), /invalidated dependency/);
});

test("definition shape, dependencies and plain synchronous model outputs fail closed", () => {
  for (const invalid of [{ ...definition, reads: [] }, { ...definition, version: 2 }, { ...definition, handler: "custom" },
    { ...definition, reads: [{ ...definition.reads[0], refs: "$stateRefs.later" }] },
    { ...definition, reads: [definition.reads[0], definition.reads[0]] }]) assert.throws(() => validateDeclarativeTrialState(invalid));
  assert.throws(() => compiled({ ...definition, model: "absent" }), /registered/);
  const noCells = compiled({ ...definition, reads: [{ id: "fund", refs: [] }], input: { reserve: op("uint", "100"), amount: "$amountIn" },
    stateChanges: [] });
  assert.equal(noCells.model.quote({ ...input, trialState: emptyExactTrialState().view }).status, "not-applicable");
  assert.throws(() => noCells.fromReadFlow(input, {}, observed), /unavailable/);
  assert.throws(() => compiled(definition, { models: { transition: () => Promise.resolve({ amountOut: 1n }) } })
    .fromReadFlow(input, { fund: { reserve: 100n } }, observed), /plain data/);
  const namedValues = compileDeclarativeValues({ abi: {}, constants: {}, expressions: { hidden: "$stateReads.future" } });
  assert.throws(() => compiled({ ...definition, reads: [{ ...definition.reads[0], refs: op("expression", "hidden", {}) }] }, { values: namedValues })
    .fromReadFlow(input, { fund: { reserve: 100n } }, observed), /unavailable trial-state read/);
});

test("compilation and evaluation never freeze or mutate caller-owned data", () => {
  const raw = JSON.parse(JSON.stringify(definition)), prepared = { fund: { reserve: 100n } };
  const runtime = compiled(raw);
  runtime.fromReadFlow(input, prepared, observed);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(prepared.fund), false);
  assert.equal(prepared.fund.reserve, 100n);
  assert.equal(Object.isFrozen(source), false);
});
