import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { compileDeclarativeReadFlow, type DeclarativeReadFlow } from "../venues/declarative-read-flow.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { RequiredAdapterRequestError } from "../venues/adapter-request-failure.js";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

// Synthetic inputs test the compiler's work and authority boundaries. They do
// not claim chain admission, live latency or end-to-end resource improvement.
const source = { number: 123, hash: toBeHex(123, 32), generation: 2 };
const address = (n: number) => toBeHex(n, 20);
const op = (name: string, ...args: unknown[]) => ({ op: name, args });
const returned = (id: string) => op("get", op("returned", id), "data");
const request = (id: string, to: string) => ({ id, kind: "eth-call", to,
  data: "0x12345678", completion: "return-data", caller: { kind: "probe-actor" } });
const result = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, source: { ...source },
  completion: "returned", data, provenance: { kind: "fixture", fingerprint: "cpu-regression" } });
const flow: DeclarativeReadFlow = { version: 1, steps: [
  { id: "relationship", requirements: { transports: ["eth-call"] }, requests: [request("related", "$target")],
    result: returned("related") },
  { id: "state", requirements: { transports: ["eth-call"] },
    requests: [request("reserveA", "$steps.relationship"), request("reserveB", "$steps.relationship")],
    result: { a: op("word", returned("reserveA")), b: op("word", returned("reserveB")) } },
  { id: "quote", requirements: { transports: ["eth-call"] }, requests: [request("output", "$steps.relationship")],
    result: op("word", returned("output")) },
], result: { amountIn: "$amountIn", amountOut: "$steps.quote", reserves: "$steps.state" } };

function inputs() {
  return { input: { source: { ...source }, target: address(1), amountIn: 5n },
    initial: [result("related", address(2))], dependent: [
      { stepId: "state", results: [result("reserveB", toBeHex(13, 32)), result("reserveA", toBeHex(7, 32))] },
      { stepId: "quote", results: [result("output", toBeHex(19, 32))] },
    ] };
}

test("one completed view preserves output, context and proof with one decode per round", () => {
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  let rounds = 0;
  const compiled = compileDeclarativeReadFlow(flow, { evaluate: values.evaluate,
    run(statements, environment) { rounds++; return values.run(statements, environment); } });
  const { input, initial, dependent } = inputs();
  const legacy = {
    output: compiled.program.decode({ programInput: input, initialResults: initial, dependentEvidence: dependent }),
    environment: compiled.completedEnvironment(input, initial, dependent),
    results: compiled.observedResults(input, initial, dependent),
    proof: compiled.requestEvidence(input, initial, dependent, "quote", "output"),
  };
  assert.equal(rounds, 12);
  rounds = 0;
  const complete = compiled.complete(input, initial, dependent);
  assert.deepEqual(complete.decode(), { amountIn: 5n, amountOut: 19n, reserves: { a: 7n, b: 13n } });
  assert.deepEqual(complete.decode(), legacy.output);
  const current = complete.environment();
  assert.deepEqual({ ...current, steps: { ...current.steps } },
    { ...legacy.environment, steps: { ...legacy.environment.steps } });
  assert.deepEqual(complete.observedResults(), legacy.results);
  assert.deepEqual(complete.requestEvidence("quote", "output"), legacy.proof);
  assert.deepEqual(complete.observedResults().map(row => row.id), ["related", "reserveA", "reserveB", "output"]);
  assert.equal(rounds, 3, "reading several views must not rerun the source-read decoders");
  assert.throws(() => complete.requestEvidence("state", "output"), /missing/);
  assert.equal(Object.isFrozen(initial), false);
  assert.equal(Object.isFrozen(initial[0]), false);
});

test("completed views never reuse a prior invocation's amount, target, results or source authority", () => {
  const compiled = compileDeclarativeReadFlow(flow, compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} }));
  const { input, initial, dependent } = inputs();
  assert.equal((compiled.complete(input, initial, dependent).decode() as any).amountOut, 19n);
  input.amountIn = 9n;
  Object.assign(initial[0], { data: address(3) });
  Object.assign(dependent[1].results[0], { data: toBeHex(21, 32) });
  const fresh = compiled.complete(input, initial, dependent);
  assert.deepEqual(fresh.decode(), { amountIn: 9n, amountOut: 21n, reserves: { a: 7n, b: 13n } });
  assert.equal((fresh.requestEvidence("quote", "output").request as any).to, address(3));
  input.source.number++;
  assert.throws(() => compiled.complete(input, initial, dependent), /source/);
});

test("completed view keeps duplicate, missing, unknown, required-failure and round-order checks", () => {
  const compiled = compileDeclarativeReadFlow(flow, compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} }));
  const { input, initial, dependent } = inputs();
  for (const state of [[], [dependent[0].results[0]],
    [dependent[0].results[0], dependent[0].results[0]],
    [result("alien", toBeHex(1, 32)), dependent[0].results[1]]])
    assert.throws(() => compiled.complete(input, initial, [{ stepId: "state", results: state }, dependent[1]]), /result ids/);
  assert.throws(() => compiled.complete(input, initial, [{ stepId: "state", results: [
    { id: "reserveB", ok: false, source, failure: "rpc" }, dependent[0].results[1],
  ] }, dependent[1]]), RequiredAdapterRequestError);
  assert.throws(() => compiled.complete(input, initial, dependent.slice().reverse()), /round order/);
  assert.throws(() => compiled.complete(input, initial, dependent.slice(0, 1)), /incomplete/);
  assert.throws(() => compiled.complete(input, initial, [{ ...dependent[0], unproven: true }, dependent[1]]), /round evidence/);
});

test("evidence-only APIs do not evaluate the flow's final expression", () => {
  const compiled = compileDeclarativeReadFlow({ ...flow, result: "$unknownFinalValue" },
    compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} }));
  const { input, initial, dependent } = inputs();
  const complete = compiled.complete(input, initial, dependent);
  assert.equal(complete.requestEvidence("quote", "output").request.id, "output");
  assert.equal(compiled.requestEvidence(input, initial, dependent, "quote", "output").request.id, "output");
  assert.throws(() => complete.decode(), /unbound/);
});

function runtimeFixture() {
  const runtime = createDeclarativeProtocolRuntime(root, [custodian, infinifi]);
  const descriptor: any = { familyId: root.scope.family, lineageId: runtime.variants[0].document.lineageId,
    instanceKey: address(1), vault: address(1), share: address(1), asset: address(2),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [] };
  return { runtime, descriptor };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("projected route fingerprints reject mutable copies, shallow freezing and changed descriptors", () => {
  for (const frozen of [false, true]) {
    const { runtime, descriptor } = runtimeFixture();
    if (frozen) freeze(descriptor);
    const route = runtime.definition.routes.project({ descriptor })[0];
    for (let i = 0; i < 3; i++) runtime.assertInvocation(descriptor, route);
    const copy = structuredClone(route);
    runtime.assertInvocation(descriptor, copy);
    (copy.bindingRef as any).fingerprint = "changed";
    assert.throws(() => runtime.assertInvocation(descriptor, copy), /binding mismatch/);
    const shallow = Object.freeze(structuredClone(route));
    runtime.assertInvocation(descriptor, shallow);
    (shallow.bindingRef as any).fingerprint = "changed";
    assert.throws(() => runtime.assertInvocation(descriptor, shallow), /binding mismatch/);
    assert.throws(() => runtime.assertInvocation(descriptor, { ...route,
      get target() { throw new Error("route accessor must not be cached"); } }), /accessor|data fields/);
    if (!frozen) {
      descriptor.asset = address(99);
      assert.throws(() => runtime.assertInvocation(descriptor, route), /binding mismatch/);
    }
  }
});

test("route identity cannot bypass the first canonical validation", () => {
  const { runtime, descriptor } = runtimeFixture();
  descriptor.runtimeRequirements = [undefined];
  freeze(descriptor);
  const route = runtime.definition.routes.project({ descriptor })[0];
  assert.throws(() => runtime.assertInvocation(descriptor, route), /unsupported canonical value type/);
  assert.throws(() => runtime.assertInvocation(descriptor, route), /unsupported canonical value type/);
});
