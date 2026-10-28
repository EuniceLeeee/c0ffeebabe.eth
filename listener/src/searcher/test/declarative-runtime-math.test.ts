import assert from "node:assert/strict";
import test from "node:test";
import { hexlify } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel, type ExpandedRuntimeMathOperation, type RuntimeMathValue } from "../venues/declarative-runtime-math.js";

const model: RuntimeMathModel = {
  id: "fixture:capacity-debt", version: 1, inputs: ["input", "price", "scale", "capacity"], outputs: ["debt"],
  operations: [
    { name: "scaled", op: "mul", left: { input: "input" }, right: { input: "price" } },
    { name: "floor", op: "div", left: { local: "scaled" }, right: { input: "scale" } },
    { name: "debt", op: "min", left: { local: "floor" }, right: { input: "capacity" } },
  ],
};
const definition = { version: 1, entries: { cost: { model: model.id, version: 1 } } };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const ref = (runtime: string) => ({ runtime });
const inputs = () => ({ input: ref("amountIn"), price: ref("priceReturnedByCall"), scale: 10n, capacity: ref("capacityReturnedByCall") });

// Execute expanded arithmetic with the existing independent bytecode verifier.
// No protocol state, discovery, request scheduler or alternative quote is used.
function execute(operations: readonly ExpandedRuntimeMathOperation[], amount: bigint, price: bigint, capacity: bigint) {
  const program = new RuntimeAmountProgram().constant(1, price).constant(2, capacity);
  const slots = new Map([["amountIn", 0], ["priceReturnedByCall", 1], ["capacityReturnedByCall", 2]]);
  let next = 3;
  function register(value: RuntimeMathValue): number {
    if (typeof value === "bigint") { const index = next++; program.constant(index, value); return index; }
    const index = slots.get(value.runtime); assert.notEqual(index, undefined); return index!;
  }
  for (const operation of operations) {
    const left = register(operation.left), right = register(operation.right), output = next++;
    assert(!slots.has(operation.name)); slots.set(operation.name, output);
    program.math(operation.op, output, left, right);
  }
  return { output: inspectRuntime(hexlify(program.bytes()), amount), slots };
}

test("runtime arithmetic comes from registered TS model and keeps current input unchanged", () => {
  const bound = createDeclarativeRuntimeMathRegistry([model]).bind(definition);
  const operations = bound.expand("cost", inputs(), { debt: "actualDebt" }, "takeMath");
  const { output, slots } = execute(operations, 51n, 7n, 30n);
  assert.equal(output.registers[0], 51n);
  assert.equal(output.registers[slots.get("actualDebt")!], 30n);
  const low = execute(operations, 21n, 7n, 30n);
  assert.equal(low.output.registers[low.slots.get("actualDebt")!], 14n);
  assert.deepEqual(output.calls, []); assert.deepEqual(output.allowances, []);
  assert.deepEqual(bound.aliases, ["cost"]); assert.equal(bound.has("missing"), false);
});

test("expansion is deterministic, uses distinct caller namespaces, and leaves bindings intact", () => {
  const bound = createDeclarativeRuntimeMathRegistry([model]).bind(definition), binding = inputs();
  const first = bound.expand("cost", binding, { debt: "firstDebt" }, "firstMath");
  assert.deepEqual(first, bound.expand("cost", binding, { debt: "firstDebt" }, "firstMath"));
  const second = bound.expand("cost", binding, { debt: "secondDebt" }, "secondMath");
  assert(!first.some(op => second.some(other => op.name === other.name)));
  assert.deepEqual(binding, inputs());
  assert(Object.isFrozen(first) && first.every(Object.isFrozen));
});

test("JSON cannot supply formulas, missing models, unknown versions or handler modules", () => {
  const registry = createDeclarativeRuntimeMathRegistry([model]);
  for (const binding of [
    { version: 2, entries: definition.entries },
    { version: 1, entries: { cost: { model: model.id, version: 2 } } },
    { version: 1, entries: { cost: { model: "missing", version: 1 } } },
    { version: 1, entries: { cost: { ...definition.entries.cost, operations: model.operations } } },
    { version: 1, entries: { cost: { module: "./handler.js", version: 1 } } },
    { version: 1, entries: { cost: { model: model.id, version: 1, evaluate: () => 7n } } },
  ]) assert.throws(() => registry.bind(binding));
  const bound = registry.bind(definition);
  assert.throws(() => bound.expand("missing", inputs(), { debt: "actualDebt" }, "math"), /undefined runtime math alias/);
});

test("registered models reject I/O, invalid ordering, invalid outputs and aliased names", () => {
  const mutations = [
    (m: any) => { m.handler = () => 1n; },
    (m: any) => { m.operations[0].op = "call"; },
    (m: any) => { m.operations[0].target = "contract"; },
    (m: any) => { m.operations[0].left = { local: "debt" }; },
    (m: any) => { m.operations[0].left = { input: "missing" }; },
    (m: any) => { m.operations[0].left = { input: "input", constant: "1" }; },
    (m: any) => { m.operations[0].name = "input"; },
    (m: any) => { m.operations[1].name = m.operations[0].name; },
    (m: any) => { m.outputs = ["missing"]; },
    (m: any) => { m.outputs = ["debt", "debt"]; },
    (m: any) => { m.inputs.push("input"); },
    (m: any) => { delete m.inputs[0]; },
    (m: any) => { m.operations[0].left = { constant: "-1" }; },
    (m: any) => { m.operations[0].left = { constant: (1n << 256n).toString() }; },
  ];
  for (const mutate of mutations) { const m: any = clone(model); mutate(m); assert.throws(() => createDeclarativeRuntimeMathRegistry([m])); }
  assert.throws(() => createDeclarativeRuntimeMathRegistry([model, model]), /duplicate runtime math model/);
});

test("bindings and outputs reject extra fields, missing inputs, old capture overwrite and r0 writes", () => {
  const bound = createDeclarativeRuntimeMathRegistry([model]).bind(definition);
  const badInputs = [
    { ...inputs(), quote: 100n }, { ...inputs(), input: 7 }, { ...inputs(), input: -1n },
    { ...inputs(), input: 1n << 256n }, { ...inputs(), input: { runtime: "amountIn", quoted: 7n } },
  ];
  for (const binding of badInputs) assert.throws(() => bound.expand("cost", binding as any, { debt: "debt" }, "math"));
  assert.throws(() => bound.expand("cost", {} as any, { debt: "debt" }, "math"));
  for (const target of ["amountIn", "priceReturnedByCall", "capacityReturnedByCall", "mathLocal0", "effect0Before", "approvalResult", "__proto__"])
    assert.throws(() => bound.expand("cost", inputs(), { debt: target }, "math"));
  assert.throws(() => bound.expand("cost", inputs(), { debt: "debt", extra: "extra" }, "math"));
  assert.throws(() => bound.expand("cost", inputs(), { debt: "debt" }, "invalid-namespace"));
  const getter = { ...inputs(), get capacity(): bigint { throw new Error("getter must not run"); } };
  assert.throws(() => bound.expand("cost", getter, { debt: "debt" }, "math"), /invalid runtime math data property/);
});

test("division by zero and uint256 overflow retain existing checked-VM behavior", () => {
  const bound = createDeclarativeRuntimeMathRegistry([model]).bind(definition);
  const zero = bound.expand("cost", { ...inputs(), scale: 0n }, { debt: "debt" }, "math");
  assert.throws(() => execute(zero, 10n, 1n, 20n));
  const overflow = bound.expand("cost", inputs(), { debt: "debt" }, "math");
  assert.throws(() => execute(overflow, (1n << 256n) - 1n, 2n, 20n));
});

test("typed equality produces a checked VM boolean without changing the input", () => {
  const equality: RuntimeMathModel = {
    id: "fixture:equality", version: 1, inputs: ["actual", "expected"], outputs: ["same"],
    operations: [{ name: "same", op: "eq", left: { input: "actual" }, right: { input: "expected" } }],
  };
  const bound = createDeclarativeRuntimeMathRegistry([equality]).bind({
    version: 1, entries: { compare: { model: equality.id, version: 1 } },
  });
  const operations = bound.expand("compare", { actual: ref("priceReturnedByCall"), expected: ref("capacityReturnedByCall") },
    { same: "matches" }, "compareMath");
  for (const [actual, expected, result] of [[41n, 41n, 1n], [41n, 42n, 0n]]) {
    const { output, slots } = execute(operations, 17n, actual!, expected!);
    assert.equal(output.registers[slots.get("matches")!], result);
    assert.equal(output.registers[0], 17n);
    assert.deepEqual(output.calls, []);
  }
});
