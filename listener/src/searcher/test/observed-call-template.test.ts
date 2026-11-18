import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import {
  bindObservedCallTemplate, observedCallTemplatePatches, OBSERVED_CALL_MAX_AMOUNT,
  synthesizeObservedCallTemplates, validateObservedCallTemplate,
  type ObservedCallSample, type ObservedCallTemplate,
} from "../venues/observed-call-template.js";

const address = (byte: string) => `0x${byte.repeat(40)}`;
const TARGET = address("1"), INPUT = address("2"), OUTPUT = address("3");
const SENDER = address("4"), RECIPIENT = address("5"), EXECUTOR = address("6");
const abi = new Interface(["function convert(uint256 amount,address recipient,uint256 minimum)"]);
function sample(overrides: Partial<ObservedCallSample> = {}): ObservedCallSample {
  return { target: TARGET, calldata: abi.encodeFunctionData("convert", [1000n, RECIPIENT, 19n]),
    sender: SENDER, recipient: RECIPIENT, tokenIn: INPUT, tokenOut: OUTPUT,
    amountIn: "1000", amountOut: "2100", source: { chainId: 1, number: 100,
      hash: toBeHex(100, 32), transactionHash: toBeHex(101, 32), traceAddress: [0, 2] },
    payment: { kind: "approval", spender: TARGET }, ...overrides };
}
function candidates(value = sample(), maximum?: number): readonly ObservedCallTemplate[] {
  const result = synthesizeObservedCallTemplates(value, maximum === undefined ? {} : { maxCandidates: maximum });
  if (result.status !== "candidates") assert.fail(JSON.stringify(result));
  return result.templates;
}
function unsupported(value: ObservedCallSample, reason: string, maximum?: number) {
  assert.deepEqual(synthesizeObservedCallTemplates(value, maximum === undefined ? {} : { maxCandidates: maximum }),
    { status: "unsupported", reason });
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("unknown selector is preserved while actual input and recipient are rebound", () => {
  const [template] = candidates();
  assert.equal(template!.amountInOffset, 4);
  assert.deepEqual(template!.executorOffsets, [36]);
  assert.equal(template!.selector, abi.getFunction("convert")!.selector);
  const result = bindObservedCallTemplate(template!, { amountIn: 2300n, executor: EXECUTOR });
  assert.equal(result, abi.encodeFunctionData("convert", [2300n, EXECUTOR, 19n]));
  assert.deepEqual(observedCallTemplatePatches(template!), [
    { offset: 4, reference: "amountIn" }, { offset: 36, reference: "executor" },
  ]);
  assert.equal(Object.isFrozen(template), true);
  assert.equal(Object.isFrozen(template!.sample.source.traceAddress), true);
});

test("historical output is provenance and never supplies the new output or minimum", () => {
  const first = candidates()[0]!, changed = candidates(sample({ amountOut: "999999999999999999999999" }))[0]!;
  assert.notEqual(first.templateHash, changed.templateHash);
  assert.equal(bindObservedCallTemplate(first, { amountIn: 999n, executor: EXECUTOR }),
    bindObservedCallTemplate(changed, { amountIn: 999n, executor: EXECUTOR }));
  assert.equal(abi.decodeFunctionData("convert", bindObservedCallTemplate(changed, { amountIn: 999n, executor: EXECUTOR }))[2], 19n);
});

test("repeated amounts create alternatives instead of choosing or patching all matches", () => {
  const fn = new Interface(["function route(uint256 amount,uint256 limit,address recipient)"]);
  const original = sample({ calldata: fn.encodeFunctionData("route", [1000n, 1000n, RECIPIENT]) });
  const templates = candidates(original);
  assert.deepEqual(templates.map(t => t.amountInOffset), [4, 36]);
  assert.notEqual(templates[0]!.templateHash, templates[1]!.templateHash);
  assert.deepEqual([...fn.decodeFunctionData("route", bindObservedCallTemplate(templates[0]!, { amountIn: 1500n, executor: EXECUTOR }))],
    [1500n, 1000n, EXECUTOR]);
  assert.deepEqual([...fn.decodeFunctionData("route", bindObservedCallTemplate(templates[1]!, { amountIn: 1500n, executor: EXECUTOR }))],
    [1000n, 1500n, EXECUTOR]);
  unsupported(original, "candidate-budget-exceeded", 1);
});

test("caller and receiver words both bind to the execution actor", () => {
  const fn = new Interface(["function route(address payer,uint256 amount,address receiver,address refund)"]);
  const [template] = candidates(sample({ calldata: fn.encodeFunctionData("route", [SENDER, 1000n, RECIPIENT, SENDER]) }));
  assert.deepEqual(template!.executorOffsets, [4, 68, 100]);
  assert.deepEqual([...fn.decodeFunctionData("route", bindObservedCallTemplate(template!, { amountIn: 1200n, executor: EXECUTOR }))],
    [EXECUTOR, 1200n, EXECUTOR, EXECUTOR]);
});

test("implicit msg.sender receipt needs no invented recipient argument", () => {
  const fn = new Interface(["function convert(uint256)"]);
  const [template] = candidates(sample({ recipient: SENDER, calldata: fn.encodeFunctionData("convert", [1000n]), payment: { kind: "prepaid" } }));
  assert.deepEqual(template!.executorOffsets, []);
  assert.equal(bindObservedCallTemplate(template!, { amountIn: 1001n, executor: EXECUTOR }), fn.encodeFunctionData("convert", [1001n]));
  unsupported(sample({ calldata: fn.encodeFunctionData("convert", [1000n]) }), "recipient-not-bound-in-call");
});

test("token/index/limit words stay byte-for-byte unchanged", () => {
  const fn = new Interface(["function route(address input,address output,uint256 index,uint256 amount,address receiver,uint256 minimum)"]);
  const original = fn.encodeFunctionData("route", [INPUT, OUTPUT, 2n, 1000n, RECIPIENT, 700n]);
  const [template] = candidates(sample({ calldata: original }));
  assert.deepEqual([...fn.decodeFunctionData("route", bindObservedCallTemplate(template!, { amountIn: 1100n, executor: EXECUTOR }))],
    [INPUT, OUTPUT, 2n, 1100n, EXECUTOR, 700n]);
});

test("dynamic ABI heads and packed calldata do not become patchable word templates", () => {
  const fn = new Interface(["function route(uint256,bytes)"]);
  unsupported(sample({ recipient: SENDER, calldata: fn.encodeFunctionData("route", [1000n, "0x1234"]) }), "dynamic-head-shaped-calldata");
  unsupported(sample({ calldata: `0x12345678${"11".repeat(20)}${"22".repeat(16)}` }), "packed-or-empty-calldata");
  unsupported(sample({ calldata: "0x12345678" }), "packed-or-empty-calldata");
});

test("amount matching never guesses a packed value or output quantity", () => {
  unsupported(sample({ amountIn: "1001" }), "input-word-not-found");
  unsupported(sample({ amountIn: "2100" }), "input-word-not-found");
});

test("candidate and calldata limits fail closed without truncation", () => {
  const calldata = `0x12345678${toBeHex(1000n, 32).slice(2).repeat(17)}`;
  unsupported(sample({ calldata, recipient: SENDER }), "candidate-budget-exceeded");
  unsupported(sample({ calldata: `0x12345678${"0".repeat(64 * 33)}` }), "calldata-word-budget-exceeded");
  unsupported(sample(), "invalid-candidate-budget", 17);
  unsupported(sample(), "invalid-candidate-budget", 0);
});

test("input bounds preserve positive interpretation without assuming a signed ABI", () => {
  const t = candidates()[0]!;
  assert.equal(BigInt(`0x${bindObservedCallTemplate(t, { amountIn: OBSERVED_CALL_MAX_AMOUNT, executor: EXECUTOR }).slice(10, 74)}`), OBSERVED_CALL_MAX_AMOUNT);
  for (const amountIn of [0n, -1n, OBSERVED_CALL_MAX_AMOUNT + 1n])
    assert.throws(() => bindObservedCallTemplate(t, { amountIn, executor: EXECUTOR }), /invalid-runtime-input/);
  unsupported(sample({ amountIn: (OBSERVED_CALL_MAX_AMOUNT + 1n).toString() }), "input-outside-positive-signed-range");
});

test("canonical lossless data survives serialization and property ordering", () => {
  const t = candidates()[0]!;
  validateObservedCallTemplate(clone(t));
  const reordered = Object.fromEntries(Object.entries(clone(t)).reverse());
  validateObservedCallTemplate(reordered);
  assert.equal(bindObservedCallTemplate(reordered, { amountIn: 1777n, executor: EXECUTOR }),
    abi.encodeFunctionData("convert", [1777n, EXECUTOR, 19n]));
  for (const amountIn of ["0", "01", "1e3", "1.0", "-1", "9".repeat(79)])
    unsupported(sample({ amountIn }), "invalid-amount-in");
});

test("source position and complete provenance are required", () => {
  const original = sample();
  for (const source of [
    { ...original.source, chainId: 0 }, { ...original.source, number: -1 },
    { ...original.source, traceAddress: [-1] }, { ...original.source, traceAddress: [0.5] },
    { ...original.source, traceAddress: Array.from({ length: 33 }, () => 0) },
  ]) unsupported(sample({ source }), "invalid-source-position");
  unsupported(sample({ source: { ...original.source, hash: "0x1234" } }), "invalid-block-hash");
  unsupported(sample({ source: { ...original.source, transactionHash: "0x1234" } }), "invalid-transaction-hash");
});

test("persisted templates cannot expand patch scope or change provenance unnoticed", () => {
  const original = candidates()[0]!;
  const mutations: ((value: any) => void)[] = [
    t => { t.amountInOffset = 5; }, t => { t.amountInOffset = 68; },
    t => { t.executorOffsets.push(68); }, t => { t.executorOffsets = []; },
    t => { t.selector = "0x00000001"; }, t => { t.calldataTemplate += "00"; },
    t => { t.sample.target = address("7"); }, t => { t.sample.source.number++; },
    t => { t.sample.payment.spender = address("8"); }, t => { t.templateHash = toBeHex(1, 32); },
    t => { t.program = "0x00"; }, t => { t.version = 2; },
  ];
  for (const mutate of mutations) { const changed = clone(original); mutate(changed); assert.throws(() => validateObservedCallTemplate(changed)); }
});

test("actor collisions and arbitrary extra setup fields are rejected", () => {
  for (const executor of [TARGET, INPUT, OUTPUT])
    assert.throws(() => bindObservedCallTemplate(candidates()[0]!, { amountIn: 1000n, executor }), /executor-overlaps/);
  unsupported(sample({ recipient: TARGET }), "actor-overlaps-target-or-asset");
  unsupported(sample({ sender: INPUT }), "actor-overlaps-target-or-asset");
  unsupported(sample({ tokenOut: INPUT }), "same-input-output-token");
  unsupported({ ...sample(), value: "1" } as ObservedCallSample, "invalid-sample-fields");
  unsupported({ ...sample(), preCalls: [] } as ObservedCallSample, "invalid-sample-fields");
  unsupported(sample({ payment: { kind: "prepaid", recipient: address("8") } as any }), "invalid-payment-fields");
});

test("getters cannot replace top-level JSON facts", () => {
  const value = sample();
  Object.defineProperty(value, "amountIn", { enumerable: true, get() { throw new Error("must not evaluate getter"); } });
  unsupported(value, "invalid-sample-fields");
});

test("nested getters and sparse provenance arrays cannot forge source or payment", () => {
  const payment: any = {};
  Object.defineProperty(payment, "kind", { enumerable: true, get() { throw new Error("must not evaluate getter"); } });
  unsupported(sample({ payment }), "invalid-payment-fields");
  const sparse = new Array<number>(1);
  unsupported(sample({ source: { ...sample().source, traceAddress: sparse } }), "invalid-source-position");
  const traceAddress = [0];
  Object.defineProperty(traceAddress, "0", { enumerable: true, get() { throw new Error("must not evaluate getter"); } });
  unsupported(sample({ source: { ...sample().source, traceAddress } }), "invalid-source-position");
  const template = clone(candidates()[0]!);
  Object.defineProperty(template.executorOffsets, "0", { enumerable: true, get() { throw new Error("must not evaluate getter"); } });
  assert.throws(() => validateObservedCallTemplate(template), /invalid-template-patches/);
});
