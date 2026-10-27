import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { RequiredAdapterRequestError } from "../venues/adapter-request-failure.js";

const operation = (op: string, ...args: unknown[]) => ({ op, args });
const base = () => ({
  inputs: ["requestId", "quantity"],
  abi: { endpoint: ["function convert(uint256) view returns(uint256 status,uint256 output)"] },
  constants: { successCode: "0" },
  expressions: {
    request: operation("encode", "endpoint", "convert", ["$quantity"]),
  },
  programs: {
    response: [
      { let: "returned", value: operation("returned", "$requestId") },
      { let: "status", value: operation("decode", "endpoint", "convert", "$returned.data", 0) },
      { assert: operation("eq", "$status", operation("uint", "$constants.successCode")), error: "conversion_status_rejected" },
      { return: operation("decode", "endpoint", "convert", "$returned.data", 1) },
    ],
  },
});

test("a return status policy is data and changes without a Family handler", () => {
  const definition = base(), abi = new Interface(definition.abi.endpoint);
  const result = (status: bigint) => ({ id: "quote", ok: true, completion: "returned", data: abi.encodeFunctionResult("convert", [status, 29n]) });
  const run = (document: ReturnType<typeof base>, status: bigint) => compileDeclarativeValues(document)
    .evaluate(operation("program", "response", {}), { requestId: "quote", results: [result(status)] });
  assert.equal(run(definition, 0n), 29n);
  assert.throws(() => run(definition, 1n), /conversion_status_rejected/);
  definition.constants.successCode = "1";
  assert.equal(run(definition, 1n), 29n);
  assert.throws(() => run(definition, 0n), /conversion_status_rejected/);
});

test("declarations are snapshotted, input is lossless, ABI names are data", () => {
  const definition = base(), compiled = compileDeclarativeValues(definition);
  const quantity = 9007199254740993n;
  const encoded = compiled.evaluate(operation("expression", "request", {}), { quantity });
  assert.equal(new Interface(definition.abi.endpoint).decodeFunctionData("convert", encoded)[0], quantity);
  definition.abi.endpoint[0] = "function changed(uint256) view returns(uint256 status,uint256 output)";
  assert.equal(compiled.evaluate(operation("expression", "request", {}), { quantity }), encoded);
  const alternate = base(); alternate.abi.endpoint = definition.abi.endpoint;
  alternate.expressions.request = operation("encode", "endpoint", "changed", ["$quantity"]);
  assert.notEqual(compileDeclarativeValues(alternate).evaluate(operation("expression", "request", {}), { quantity }), encoded);
});

test("declared optional inputs may be absent, unbound names and unsafe shapes fail", () => {
  const compiled = compileDeclarativeValues(base());
  assert.equal(compiled.evaluate("$quantity", {}), undefined);
  assert.throws(() => compiled.evaluate("$unknown", {}), /unbound/);
  assert.throws(() => compileDeclarativeValues({ ...base(), constants: { bad: 9007199254740993 } }), /unsafe/);
  assert.throws(() => compileDeclarativeValues({ ...base(), constants: { bad: () => 1 } }), /non-JSON/);
  assert.throws(() => compileDeclarativeValues({ ...base(), programs: { bad: [{ let: "__proto__", value: true }] } }), /binding/);
  assert.throws(() => compileDeclarativeValues({ ...base(), expressions: { bad: operation("eval", "process.exit()") } }), /unknown/);
  assert.throws(() => compileDeclarativeValues({ ...base(), programs: { bad: [{ return: true, ignored: false }] } }), /unknown/);
});

test("named expression and program cycles fail before execution", () => {
  assert.throws(() => compileDeclarativeValues({ ...base(), expressions: { cycle: operation("program", "cycle", {}) },
    programs: { cycle: [{ return: operation("expression", "cycle", {}) }] } }), /cyclic/);
});

test("declarative recovery cannot swallow unresolved transport evidence", () => {
  const compiled = compileDeclarativeValues({ ...base(), programs: {
    guarded: [{ attempt: [{ return: operation("successful", "request") }], catch: [{ return: "rejected" }] }],
  } });
  assert.throws(() => compiled.evaluate(operation("program", "guarded", {}), {
    results: [{ id: "request", ok: false, failure: "rpc" }],
  }), RequiredAdapterRequestError);
  assert.equal(compiled.evaluate(operation("program", "guarded", {}), { results: [] }), "rejected");
});

test("array and power bounds constrain shared interpretation", () => {
  const compiled = compileDeclarativeValues(base());
  assert.equal(compiled.evaluate(operation("pow", operation("uint", "10"), 18), {}), 10n ** 18n);
  assert.throws(() => compiled.evaluate(operation("pow", operation("uint", "10"), 257), {}), /bound/);
  assert.throws(() => compiled.evaluate(operation("map", "$rows", "row", "$row"), { rows: Array(10001).fill(0) }), /budget/);
});
