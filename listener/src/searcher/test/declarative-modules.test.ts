import assert from "node:assert/strict";
import test from "node:test";
import { createDeclarativeModuleCatalog, type DeclarativeModule } from "../venues/declarative-modules.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const module = (key: string, depends: readonly string[] = []): DeclarativeModule => ({ key, versions: {
  1: { required: ["value"], validate(block) { if (typeof block.value !== "string") throw new Error("value must be text"); },
    compile: block => block.value, dependencies: () => depends },
} });

test("catalogue evolution preserves old compiled values and only exposes an empty new module", () => {
  const old = { alpha: { version: 1, value: "retained" } };
  const before = createDeclarativeModuleCatalog([module("alpha")]).read(old);
  const catalog = createDeclarativeModuleCatalog([module("alpha"), module("future")]);
  const after = catalog.read(old);
  assert.equal(before.require("alpha"), after.require("alpha"));
  assert.deepEqual(after.blocks.future, {});
  assert.equal(after.coverage.find(r => r.key === "future")?.state, "undefined");
  assert.deepEqual(after.blocks, catalog.read(after.blocks).blocks);
  assert.deepEqual(after.coverage, catalog.read({ ...old, future: {} }).coverage);
  assert.deepEqual(Object.keys(old), ["alpha"]);
  assert.throws(() => after.require("future"), /unavailable/);
});

test("empty dependencies block only the action that consumes them", () => {
  const catalog = createDeclarativeModuleCatalog([module("independent"), module("first", ["second"]), module("second")]);
  const state = catalog.read({ independent: { version: 1, value: "ok" }, first: { version: 1, value: "no" } });
  assert.equal(state.require("independent"), "ok");
  assert.deepEqual(state.coverage.find(r => r.key === "first"), { key: "first", state: "blocked", version: 1, missingDependencies: ["second"] });
  assert.throws(() => state.require("first"), /unavailable/);
});

test("invalid nonempty definitions, unknown keys/versions and cycles never masquerade as empty", () => {
  const catalog = createDeclarativeModuleCatalog([module("first")]);
  for (const raw of [{ typo: {} }, { first: null }, { first: [] }, { first: { version: 2, value: "x" } },
    { first: { version: 1 } }, { first: { version: 1, value: 3 } }, { first: { version: 1, value: "x", handler: "x" } }])
    assert.throws(() => catalog.read(raw));
  assert.throws(() => catalog.read(JSON.parse('{"__proto__":{}}')));
  assert.throws(() => catalog.read({ get first() { throw new Error("must not evaluate a getter"); } }), /invalid module data property/);
  assert.throws(() => createDeclarativeModuleCatalog([module("first"), module("first")]));
  assert.throws(() => createDeclarativeModuleCatalog([module("first", ["other"])]).read({ first: { version: 1, value: "x" } }));
  assert.throws(() => createDeclarativeModuleCatalog([module("first", ["second"]), module("second", ["first"])]).read({
    first: { version: 1, value: "x" }, second: { version: 1, value: "y" },
  }), /cyclic/);
});

const registry = createDeclarativeMathRegistry([{
  id: "fixture:ratio", version: 1,
  validateInput(input) {
    const value = input as any;
    assert.equal(typeof value.amount, "bigint"); assert.equal(typeof value.rate, "bigint");
    assert(value.amount >= 0n && value.rate > 0n);
  },
  evaluate(input) { const value = input as { amount: bigint; rate: bigint }; return { output: value.amount / value.rate }; },
  validateOutput(output) { assert.equal(typeof (output as any).output, "bigint"); assert((output as any).output >= 0n); },
}]);
test("math stays in statically registered TS and accepts immutable named integer inputs", () => {
  const models = registry.bind({ version: 1, entries: { quote: { model: "fixture:ratio", version: 1 } } });
  const expression = { op: "model", args: ["quote", { amount: "$amount", rate: "$rate" }] };
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: { output: expression } }, {}, models);
  assert.deepEqual(values.evaluate(expression, { amount: 23n, rate: 3n }), { output: 7n });
  assert.throws(() => values.evaluate(expression, { amount: 23n, rate: 0n }));
  assert.throws(() => values.evaluate(expression, { amount: 23, rate: 3n }));
  assert.throws(() => compileDeclarativeValues({ abi: {}, constants: {}, expressions: { output: expression } }), /unknown math model/);
  assert.throws(() => registry.bind({ version: 1, entries: { quote: { model: "fixture:ratio", version: 2 } } }), /unregistered/);
  assert.throws(() => registry.bind({ version: 1, entries: { quote: { model: "fixture:ratio", version: 1, module: "./bad.js" } } }));
});

test("math entries cannot mutate caller inputs or return async/lossy values", () => {
  const input = { value: 1n };
  const bad = createDeclarativeMathRegistry([{ id: "fixture:bad", version: 1, validateInput() {},
    evaluate(value) { (value as any).value = 2n; return value; }, validateOutput() {} }]);
  assert.throws(() => bad.bind({ version: 1, entries: { bad: { model: "fixture:bad", version: 1 } } }).bad(input));
  assert.equal(input.value, 1n);
  const asyncModel = createDeclarativeMathRegistry([{ id: "fixture:async", version: 1, validateInput() {},
    evaluate: (() => Promise.resolve(1n)) as any, validateOutput() {} }]);
  assert.throws(() => asyncModel.bind({ version: 1, entries: { bad: { model: "fixture:async", version: 1 } } }).bad(1n), /lossless/);
});

test("async module validation or compilation cannot be reported compiled", () => {
  const asynchronous = (part: "validate" | "compile") => createDeclarativeModuleCatalog([{ key: "async", versions: {
    1: { required: [], validate() {}, compile: () => 1, [part]: async () => undefined },
  } }]);
  for (const part of ["validate", "compile"] as const)
    assert.throws(() => asynchronous(part).read({ async: { version: 1 } }), /synchronous/);
});
test("async input/output validators cannot bypass a math contract", () => {
  for (const name of ["validateInput", "validateOutput"] as const) {
    const registry = createDeclarativeMathRegistry([{ id: "fixture:async-check", version: 1,
      validateInput() {}, evaluate: value => value, validateOutput() {}, [name]: async () => undefined }]);
    const functions = registry.bind({ version: 1, entries: { check: { model: "fixture:async-check", version: 1 } } });
    assert.throws(() => functions.check(1n), /synchronous/);
  }
});
