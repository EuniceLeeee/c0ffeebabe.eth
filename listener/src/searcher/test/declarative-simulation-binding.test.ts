import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, toBeHex } from "ethers";
import { buildDeclarativeExecutionSimulation } from "../venues/declarative-simulation.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import type { DeclarativeConversionExecution } from "../venues/declarative-execution.js";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";

const address = (n: number) => toBeHex(n, 20);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const tokenIn = address(1), tokenOut = address(2), executor = address(3), target = address(4);
const op = (op: string, ...args: any[]) => ({ op, args });
const literal = (value: unknown): any => JSON.parse(JSON.stringify(value,
  (_key, value) => typeof value === "bigint" ? op("uint", value.toString()) : value));
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const execution: DeclarativeConversionExecution = {
  version: 2, settlement: { directOutput: false }, protectedAddresses: [tokenIn, tokenOut, target],
  steps: [{ id: "convert", call: { target, signature: "function convert(uint256) returns(uint256)",
    args: [{ runtime: "amountIn" }], save: { output: 0 } } }],
  effects: [{ kind: "debit", token: tokenIn, account: "$executor", equals: { runtime: "amountIn" } },
    { kind: "credit", token: tokenOut, account: "$recipient", equals: { runtime: "output" } }],
};
const request = buildDeclarativeExecutionSimulation({ kind: "declarative-execution-simulation", id: "proof", amountIn: "$amountIn" },
  { route: { adapterId: "fixture", tokenIn, tokenOut, target }, executor, source, amountIn: 17n }, values, execution);
const success = { id: "proof", ok: true, source, provenance: { kind: "fixture", fingerprint: "actual-observation" },
  completion: "returned", data: "0x", effects: { tokenDeltas: [
    { token: tokenIn, account: executor, delta: -17n }, { token: tokenOut, account: executor, delta: 34n },
  ], nativeDeltas: [{ account: executor, delta: 0n }] } };
const failed = { ...success, completion: "reverted-as-declared", effects: undefined };
const actual = { requests: [request], results: [failed] };

for (const operation of ["simulationActor", "programReceipt"]) {
  const selection = { requestId: "proof", source, tokenIn, amountIn: op("uint", "17"),
    ...(operation === "programReceipt" ? { executor, tokenOut } : {}) };
  test(`${operation} rejects JSON-supplied request/result instead of actual observations`, () => {
    const fake = { ...selection, request: literal(request), result: literal(success) };
    assert.throws(() => values.evaluate(op(operation, fake), actual));
  });
  test(`${operation} selects the actual reverted result by id`, () => {
    assert.throws(() => values.evaluate(op(operation, selection), actual));
    assert.equal(values.evaluate(op(operation, selection), { requests: [request], results: [success] }),
      operation === "simulationActor" ? executor : 34n);
    assert.throws(() => values.evaluate(op(operation, selection), { requests: [request], results: [] }));
    assert.throws(() => values.evaluate(op(operation, selection), { requests: [request], results: [success, success] }));
    assert.throws(() => values.evaluate(op(operation, { ...selection, source: { ...source, number: 101 } }),
      { requests: [request], results: [success] }));
  });
  test(`${operation} cannot shadow observations through named expression arguments`, () => {
    const document = { abi: {}, constants: {}, expressions: { check: op(operation, selection) } };
    assert.throws(() => {
      const compiled = compileDeclarativeValues(document);
      return compiled.evaluate(op("expression", "check", { requests: [literal(request)], results: [literal(success)] }), actual);
    });
  });
  test(`${operation} cannot shadow observations through a local statement`, () => {
    assert.throws(() => values.run([
      { let: "results", value: [literal(success)] }, { return: op(operation, selection) },
    ], actual));
  });
}

test("a declared identity actor cannot replace the issuer executor or origin", async () => {
  let dispatched = 0;
  const code = "0x60006000";
  const transport = createRevmStrictSimulationTransport({ rpcUrl: "http://localhost:8545", executionGasLimit: 1_000_000,
    executorRuntimeCode: { code, keccak256: keccak256(code) }, onFatal() {},
    async leaseFor() { dispatched++; throw new Error("must reject before source dispatch"); } });
  for (const authority of [
    { executor: address(99), transactionOrigin: address(98) },
    { executor, transactionOrigin: executor },
    { executor },
  ]) {
    await assert.rejects(transport.simulate({ request, source, callerAuthority: authority }));
    assert.equal(dispatched, 0);
  }
});
