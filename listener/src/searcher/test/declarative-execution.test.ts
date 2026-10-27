import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, hexlify, toBeHex } from "ethers";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { buildDeclarativeExecutionProgram, buildDeclarativeRuntimeLeg,
  buildDeclarativeQuotedFragment, createDeclarativeProgramAction } from "../venues/declarative-execution.js";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const INPUT = address("1"), OUTPUT = address("2"), TARGET = address("3"), EXECUTOR = address("4"), RECIPIENT = address("5");
const ref = (runtime: string) => ({ runtime });
// This fixture deliberately uses an unrelated two-result conversion ABI. A
// Family-specific branch cannot satisfy its return-code and amount contracts.
const definition = {
  version: 1 as const, settlement: { directOutput: true }, protectedAddresses: [INPUT, OUTPUT, TARGET],
  preflight: [{ target: TARGET, signature: "function allowed(address) view returns(bool)", args: ["$executor"],
    save: { allowed: 0 }, checks: [{ left: ref("allowed"), operator: "eq", right: true }] }],
  approval: { token: INPUT, spender: TARGET, mode: "exact-clear", requireBool: true, verifyAllowance: true },
  call: { target: TARGET, signature: "function convert(address,uint256) returns(uint256 status,uint256 output)",
    args: ["$recipient", ref("amountIn")], save: { status: 0, output: 1 },
    checks: [{ left: ref("status"), operator: "eq", right: 0 }] },
  effects: [
    { kind: "debit", token: INPUT, account: "$executor", equals: ref("amountIn") },
    { kind: "credit", token: OUTPUT, account: "$recipient", equals: ref("output") },
    { kind: "supply", token: OUTPUT, direction: "increase", equals: ref("output") },
    { kind: "unchanged-token", token: OUTPUT, account: "$executor", when: "$externalRecipient" },
    { kind: "unchanged-native" },
  ],
};
// Only value substitution is mocked. All emitted bytecode is executed by the
// existing independent VM interpreter; no assertions inspect builder internals.
const values = { evaluate(value: any, env: Record<string, any>): any {
  if (typeof value === "string" && value.startsWith("$")) return value.slice(1).split(".").reduce((v, key) => v?.[key], env);
  if (Array.isArray(value)) return value.map(item => this.evaluate(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.evaluate(item, env)]));
  return value;
} };
const context = (external = true) => ({ route: { adapterId: "unrelated-conversion", target: TARGET, tokenIn: INPUT, tokenOut: OUTPUT },
  executor: EXECUTOR, minAmountOut: 1n, amountIn: 77n, quotedAmountOut: 154n,
  ...(external ? { settlement: { kind: "direct-output", recipient: RECIPIENT } } : {}) });
type Fault = "zero-debit" | "under-debit" | "over-debit" | "short-receipt" | "status" | "supply" | "native" | "permission" | "approval" | "return";
function execute(program: string, amount: bigint, external = true, fault?: Fault) {
  const recipient = external ? RECIPIENT : EXECUTOR;
  const balances = new Map([[`${INPUT}:${EXECUTOR}`, amount + 101n], [`${OUTPUT}:${EXECUTOR}`, 103n], [`${OUTPUT}:${RECIPIENT}`, 107n]]);
  const key = (token: string, account: string) => `${token.toLowerCase()}:${account.toLowerCase()}`;
  const balance = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
  const abi = new Interface([
    "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
    "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
    "function allowed(address) view returns(bool)", "function convert(address,uint256) returns(uint256,uint256)",
  ]);
  let supply = 1000n, allowance = 0n, called = 0, native = 11n;
  const outputBefore = balance(OUTPUT, recipient);
  inspectRuntime(program, amount, { nativeBalance: () => native, call(call) {
    const parsed = abi.parseTransaction({ data: call.data }); assert(parsed);
    const name = parsed.name;
    if (name === "balanceOf") return toBeHex(balance(call.target, parsed.args[0]), 32);
    if (name === "totalSupply") return toBeHex(supply, 32);
    if (name === "allowed") return toBeHex(fault === "permission" ? 0n : 1n, 32);
    if (name === "allowance") return toBeHex(allowance, 32);
    if (name === "approve") { allowance = parsed.args[1]; return toBeHex(fault === "approval" ? 0n : 1n, 32); }
    assert.equal(name, "convert"); assert.equal(call.static, false); assert.equal(call.value, 0n);
    assert.equal(parsed.args[0].toLowerCase(), recipient); assert.equal(parsed.args[1], amount); assert.equal(allowance, amount);
    called++;
    const output = amount * 2n;
    const debit = fault === "zero-debit" ? 0n : fault === "under-debit" ? amount - 1n : fault === "over-debit" ? amount + 1n : amount;
    balances.set(key(INPUT, EXECUTOR), balance(INPUT, EXECUTOR) - debit);
    balances.set(key(OUTPUT, recipient), balance(OUTPUT, recipient) + output - (fault === "short-receipt" ? 1n : 0n));
    supply += output - (fault === "supply" ? 1n : 0n);
    if (fault === "native") native--;
    if (fault === "return") return "0x";
    return abi.encodeFunctionResult("convert", [fault === "status" ? 5n : 0n, output]);
  } });
  assert.equal(called, 1); assert.equal(allowance, 0n);
  assert.equal(balance(INPUT, EXECUTOR), 101n); assert.equal(balance(OUTPUT, recipient), outputBefore + amount * 2n);
  if (external) assert.equal(balance(OUTPUT, EXECUTOR), 103n);
}

for (const external of [false, true]) test(`declared conversion protects old inventory, receiver and temporary approval: external=${external}`, () => {
  const input = context(external);
  const program = hexlify(buildDeclarativeExecutionProgram(definition, input, values).bytes());
  execute(program, 91n, external);
  execute(program, 123n, external);
});
for (const fault of ["zero-debit", "under-debit", "over-debit", "short-receipt", "status", "supply", "native", "permission", "approval", "return"] as const) {
  test(`declarative runtime rejects ${fault}`, () => {
    const program = hexlify(buildDeclarativeExecutionProgram(definition, context(), values).bytes());
    assert.throws(() => execute(program, 91n, true, fault));
  });
}
test("quoted and runtime share the same program while input is supplied at execution", () => {
  const input = context(false);
  const runtime = buildDeclarativeRuntimeLeg(definition, input, values)!;
  const quoted = buildDeclarativeQuotedFragment(definition, input, values);
  assert.equal(runtime.program, quoted.nodes[0]!.params.runtimeAmountProgram);
  execute(runtime.program, 91n, false); // Deliberately differs from quoted input 77.
  const action = createDeclarativeProgramAction({ adapterId: "unrelated-conversion", lineage: "synthetic",
    edgeKind: "protocol", action: "convert", canSendValue: false, leavesStandingPositionDefault: false },
    [{ signature: "function convert(address,uint256) returns(uint256,uint256)" }]);
  const script = action.encode(quoted.nodes[0] as any, EXECUTOR, new Uint8Array());
  assert.equal(script[0], 0x0e); assert.equal(BigInt(hexlify(script.slice(1, 33))), 77n);
  assert.throws(() => action.encode({ ...quoted.nodes[0], amount: 0n } as any, EXECUTOR, new Uint8Array()));
});
test("unsupported callback requests cannot silently fall back to quoted execution", () => {
  assert.equal(buildDeclarativeRuntimeLeg(definition, { ...context(), settlement: { kind: "deferred-input" } }, values), null);
  assert.throws(() => buildDeclarativeExecutionProgram(definition, { ...context(), settlement: { kind: "quote-output" } }, values));
});
test("mandatory receipt checks cannot be omitted by a declaration", () => {
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition, effects: [] }, context(), values));
  assert.throws(() => execute(hexlify(buildDeclarativeExecutionProgram(definition, { ...context(), minAmountOut: 183n }, values).bytes()), 91n));
});
test("unknown fields and unresolved runtime captures reject before execution", () => {
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition, handler: "legacy-handler" } as any, context(), values));
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition,
    call: { ...definition.call, args: ["$recipient", ref("missingCapture")] } }, context(), values));
  const quotedInput = { ...definition, call: { ...definition.call, args: ["$recipient", "$amountIn"] } };
  assert.throws(() => buildDeclarativeRuntimeLeg(quotedInput, context(), values));
  assert.throws(() => buildDeclarativeQuotedFragment(quotedInput, context(), values));
});
test("source-bound definitions cannot construct from missing source or pending evidence", () => {
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition, requireCanonicalSource: true }, context(), values));
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition, rejectRuntimeEvidence: true },
    { ...context(), runtimeEvidence: [{}] }, values));
});
test("invalid return layout and unsafe minimum cannot enter the emitted program", () => {
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition,
    call: { ...definition.call, save: { status: 0, output: 2 } } }, context(), values));
  assert.throws(() => buildDeclarativeExecutionProgram(definition,
    { ...context(), minAmountOut: Number.MAX_SAFE_INTEGER + 1 }, values));
  assert.throws(() => buildDeclarativeExecutionProgram({ ...definition,
    call: { ...definition.call, save: { effect0Before: 0, output: 1 } } }, context(), values));
});

test("runtime construction never reads quoted-input, quote-output, evidence or minimum getters", () => {
  const input = context(false);
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
    Object.defineProperty(input, key, { enumerable: true, get() { throw new Error("forbidden runtime read: " + key); } });
  const leg = buildDeclarativeRuntimeLeg(definition, input, values);
  assert(leg); execute(leg.program, 91n, false);
});
