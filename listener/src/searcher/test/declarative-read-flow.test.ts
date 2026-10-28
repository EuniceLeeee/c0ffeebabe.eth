import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { compileDeclarativeReadFlow, validateDeclarativeReadFlow, type DeclarativeReadFlow, type ReadFlowInput } from "../venues/declarative-read-flow.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { RequiredAdapterRequestError } from "../venues/adapter-request-failure.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";

const source: CanonicalSource = { number: 123, hash: toBeHex(123, 32), generation: 2 };
const target = toBeHex(5, 20), next = toBeHex(6, 20), input: ReadFlowInput = { source, target };
const expression = (op: string, ...args: any[]) => ({ op, args });
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const result = (id: string, data: string, at = source): AdapterRequestResult => ({ id, ok: true, source: at,
  provenance: { kind: "fixture", fingerprint: "fixture" }, completion: "returned", data });
const field = (id: string) => expression("get", expression("returned", id), "data");
const request = (id: string, target: any): any => ({ id, kind: "eth-call", to: target, data: "0x12345678", completion: "return-data", caller: { kind: "probe-actor" } });
const flow: DeclarativeReadFlow = {
  version: 1,
  steps: [
    { id: "relationship", requirements: { transports: ["eth-call"] }, requests: [request("relationship", "$target")],
      decode: [{ return: { related: field("relationship") } }] },
    { id: "state", requirements: { transports: ["eth-call"] },
      requests: [request("firstState", "$steps.relationship.related"), request("secondState", "$steps.relationship.related")],
      decode: [{ return: { first: expression("word", field("firstState")), second: expression("word", field("secondState")) } }] },
    { id: "quote", requirements: { transports: ["eth-call"] }, requests: [request("quote", "$steps.relationship.related")],
      decode: [{ return: { output: expression("word", field("quote")), context: "$steps.state" } }] },
  ],
  result: "$steps.quote",
};
function firstResults(): AdapterRequestResult[] { return [result("relationship", next)]; }
function stateResults(): AdapterRequestResult[] { return [result("secondState", toBeHex(13, 32)), result("firstState", toBeHex(7, 32))]; }
function exercise(document: DeclarativeReadFlow, answer: (requests: readonly AdapterRequest[]) => readonly AdapterRequestResult[]) {
  const { program } = compileDeclarativeReadFlow(document, values);
  const initialResults = answer(program.buildRequests(input));
  const dependentEvidence: unknown[] = [];
  for (;;) {
    const bound = program.buildDependentProgram!({ programInput: input, initialResults, priorEvidence: dependentEvidence,
      completedRound: dependentEvidence.length });
    if (bound === null) break;
    dependentEvidence.push(bound.decode(answer(bound.requests)));
  }
  return program.decode({ programInput: input, initialResults, dependentEvidence });
}

test("JSON declares three dependency rounds; both independent reads stay in their common round", () => {
  const groups: string[][] = [];
  const output = exercise(flow, requests => {
    groups.push(requests.map(r => r.id));
    if (requests[0].id === "relationship") { assert.equal((requests[0] as any).to, target); return firstResults(); }
    requests.forEach(request => assert.equal((request as any).to, next));
    return requests[0].id === "firstState" ? stateResults() : [result("quote", toBeHex(19, 32))];
  });
  assert.deepEqual(groups, [["relationship"], ["firstState", "secondState"], ["quote"]]);
  assert.deepEqual(output, { output: 19n, context: { first: 7n, second: 13n } });
});

test("proof request evidence is reconstructed from complete ordered source-bound rounds", () => {
  const compiled = compileDeclarativeReadFlow(flow, values);
  const dependent = [{ stepId: "state", results: stateResults() }, { stepId: "quote", results: [result("quote", toBeHex(19, 32))] }];
  const evidence = compiled.requestEvidence(input, firstResults(), dependent, "quote", "quote");
  assert.equal(evidence.request.id, "quote");
  assert.equal((evidence.request as any).to, next);
  assert.equal((evidence.result as any).data, toBeHex(19, 32));
  assert.ok(Object.isFrozen(evidence));
  assert.deepEqual(compiled.observedResults(input, firstResults(), dependent).map(result => result.id),
    ["relationship", "firstState", "secondState", "quote"]);
  assert.throws(() => compiled.observedResults(input, firstResults(), dependent.slice(0, 1)), /incomplete/);
  assert.throws(() => compiled.requestEvidence(input, firstResults(), dependent, "state", "quote"), /missing/);
  assert.throws(() => compiled.requestEvidence(input, firstResults(), dependent.slice(0, 1), "quote", "quote"), /incomplete/);
  assert.throws(() => compiled.requestEvidence(input, firstResults(), [{ stepId: "state", results: stateResults() },
    { stepId: "quote", results: [result("quote", toBeHex(19, 32), { ...source, generation: 3 })] }], "quote", "quote"), /source/);
});

test("the same interpreter accepts one and five steps without any fixed step count", () => {
  for (const count of [1, 5]) {
    const steps = Array.from({ length: count }, (_, i) => ({ id: `step${i}`, requirements: { transports: ["eth-call"] },
      requests: [request(`read${i}`, "$target")], decode: [{ return: expression("word", field(`read${i}`)) }] }));
    let called = 0;
    const output = exercise({ version: 1, steps, result: `$steps.step${count - 1}` }, requests => {
      called++; return [result(requests[0].id, toBeHex(40 + called, 32))];
    });
    assert.equal(called, count); assert.equal(output, BigInt(40 + count));
  }
});

test("a step can declare a result value instead of a single return statement", () => {
  const document: DeclarativeReadFlow = { version: 1, steps: [{ id: "quote", requirements: { transports: ["eth-call"] },
    requests: [request("quote", "$target")], result: expression("word", field("quote")) }], result: "$steps.quote" };
  assert.equal(exercise(document, () => [result("quote", toBeHex(19, 32))]), 19n);
  assert.throws(() => validateDeclarativeReadFlow({ ...document, steps: [{ ...document.steps[0], decode: [{ return: 1 }] }] }), /step/);
  const { result: _result, ...withoutResult } = document.steps[0];
  assert.throws(() => validateDeclarativeReadFlow({ ...document, steps: [withoutResult] }), /step/);
});

test("failed intermediate work cannot declare the following round", () => {
  const { program } = compileDeclarativeReadFlow(flow, values);
  const bound = program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), priorEvidence: [], completedRound: 0 })!;
  assert.throws(() => bound.decode([{ id: "firstState", ok: false, source, failure: "rpc" }, result("secondState", toBeHex(1, 32))]), RequiredAdapterRequestError);
  assert.throws(() => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 1,
    priorEvidence: [{ stepId: "state", results: [{ id: "firstState", ok: false, source, failure: "deadline" }, result("secondState", toBeHex(1, 32))] }] }), RequiredAdapterRequestError);
});

test("unknown, duplicated, missing, wrong-source or forged round results reject", () => {
  const { program } = compileDeclarativeReadFlow(flow, values);
  const nextRound = (initialResults: readonly AdapterRequestResult[]) => program.buildDependentProgram!({
    programInput: input, initialResults, completedRound: 0, priorEvidence: [] });
  for (const results of [[], [...firstResults(), ...firstResults()], [result("other", next)], [result("relationship", next, { ...source, number: source.number + 1 })]])
    assert.throws(() => nextRound(results));
  const bound = nextRound(firstResults())!;
  const evidence = bound.decode(stateResults());
  assert.throws(() => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 0, priorEvidence: [evidence] }), /round mismatch/);
  assert.throws(() => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 1,
    priorEvidence: [{ ...(evidence as any), stepId: "quote" }] }), /order mismatch/);
  assert.throws(() => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 1,
    priorEvidence: [{ ...(evidence as any), value: 999n }] }), /round evidence/);
  assert.throws(() => program.decode({ programInput: input, initialResults: firstResults(), dependentEvidence: [evidence] }), /incomplete/);
});

test("reconstruction is stateless across invocations and depends on actual prior results", () => {
  const { program } = compileDeclarativeReadFlow(flow, values);
  const a = program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 0, priorEvidence: [] })!;
  const evidence = a.decode(stateResults());
  const make = () => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 1, priorEvidence: [evidence] })!;
  assert.deepEqual(make().requests, make().requests);
  const alternate = toBeHex(99, 20);
  const b = program.buildDependentProgram!({ programInput: input, initialResults: [result("relationship", alternate)], completedRound: 0, priorEvidence: [] })!;
  assert.equal((a.requests[0] as any).to, next); assert.equal((b.requests[0] as any).to, alternate);
});

test("registration rejects duplicate IDs, forward/unknown step references, missing fields and executable values", () => {
  const clone = () => JSON.parse(JSON.stringify(flow));
  for (const mutate of [
    (d: any) => { d.steps[1].id = d.steps[0].id; },
    (d: any) => { d.steps[0].requests[0].to = "$steps.quote.output"; },
    (d: any) => { d.result = "$steps.missing"; },
    (d: any) => { d.result = "$steps"; },
    (d: any) => { d.steps[0].handler = "unsafe"; },
    (d: any) => { d.steps[0].decode = [{ return: 1, assert: true }]; },
    (d: any) => { d.steps[0].requests = () => []; },
    (d: any) => { d.steps = []; },
    (d: any) => { d.version = 2; },
  ]) { const definition = clone(); mutate(definition); assert.throws(() => validateDeclarativeReadFlow(definition)); }
  const duplicate = clone(); duplicate.steps[1].requests[0].id = "relationship";
  const { program } = compileDeclarativeReadFlow(duplicate, values);
  assert.throws(() => program.buildDependentProgram!({ programInput: input, initialResults: firstResults(), completedRound: 0, priorEvidence: [] }), /request ids/);
});

test("source is captured for a bound round and malformed source cannot construct requests", () => {
  const mutable = { ...input, source: { ...source } };
  const { start } = compileDeclarativeReadFlow(flow, values);
  const bound = start(mutable);
  mutable.source.number++;
  assert.doesNotThrow(() => bound.decode(firstResults()));
  assert.throws(() => start({ ...input, source: { ...source, hash: "invalid" } }), /canonical source/);
});


test("explicit optional failures remain observable to JSON decode without becoming required failures", () => {
  const document: DeclarativeReadFlow = { version: 1, steps: [{ id: "probe", requirements: { transports: ["eth-call"] },
    requests: [{ ...request("probe", "$target"), required: false }],
    decode: [{ return: expression("shape", "probe") }] }], result: "$steps.probe" };
  const { program } = compileDeclarativeReadFlow(document, values);
  const initialResults: AdapterRequestResult[] = [{ id: "probe", ok: false, source, failure: "rpc" }];
  assert.equal(program.decode({ programInput: input, initialResults, dependentEvidence: [] }), "missing");
});


test("forward references hidden in a named expression cannot silently coalesce to an unproven target", () => {
  const hidden = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {
    hidden: expression("coalesce", "$steps.quote.output", "$target"),
  } });
  const document = JSON.parse(JSON.stringify(flow));
  document.steps[0].requests[0].to = expression("expression", "hidden", {});
  const { program } = compileDeclarativeReadFlow(document, hidden);
  assert.throws(() => program.buildRequests(input), /unavailable read-flow step/);
});

test("building and decoding a flow does not freeze or mutate caller-owned arrays or decoded objects", () => {
  const requests = [request("read", target)], output = { output: 1n };
  const document: DeclarativeReadFlow = { version: 1, steps: [{ id: "only", requirements: { transports: ["eth-call"] },
    requests: "$requests", decode: [{ return: "$output" }] }], result: "$steps.only" };
  const { program } = compileDeclarativeReadFlow(document, values);
  const at = { ...input, requests, output };
  program.buildRequests(at);
  const decoded = program.decode({ programInput: at, initialResults: [result("read", "0x")], dependentEvidence: [] });
  assert.deepEqual(decoded, { output: 1n });
  assert.equal(Object.isFrozen(requests), false); assert.equal(Object.isFrozen(requests[0]), false);
  assert.equal(Object.isFrozen(output), false); assert.equal(Object.isFrozen(decoded), true);
});
