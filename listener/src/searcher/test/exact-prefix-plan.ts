import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import ts from "typescript";
import { actualAmountCaseAdapter, actualAmountFlowAdapter } from "../../adapters/actual-amount-flow.js";
import { register } from "../../adapters/registry.js";
import { encodeCall } from "../../encoder.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import { compileExactPrefix, type ExactPrefixPlanStep } from "../exact-prefix-plan.js";
import { planFragmentNodes } from "../solver/plan-fragment-requirements.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";

const EXECUTOR = ethers.toBeHex(1, 20), A = ethers.toBeHex(2, 20), B = ethers.toBeHex(3, 20);
const C = ethers.toBeHex(4, 20), TARGET = ethers.toBeHex(5, 20), SPENDER = ethers.toBeHex(6, 20);
const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes script)"]);
const ACTION = new ethers.Interface(["function apply(uint256 amount)"]);
for (const adapter of PRODUCTION_INFRA_ACTION_ADAPTERS) register(adapter);
register({ id: "prefix-fixture-action", isWrapper: false, field2Offset: null,
  descriptor: { adapterId: "prefix-fixture-action", lineage: "erc20-infra", edgeKind: null,
    action: "guard", canSendValue: false, leavesStandingPositionDefault: false },
  matchTrace: () => false,
  encode: node => encodeCall(node.target, ethers.getBytes(ACTION.encodeFunctionData("apply", [node.amount]))),
});

function step(tokenIn = A, tokenOut = B, amountIn = 10n, amountOut = 20n): ExactPrefixPlanStep {
  return { tokenIn, tokenOut, amountIn, amountOut, fragment: { requirements: [], nodes: [{
    adapterId: "prefix-fixture-action", target: TARGET, tokenIn, tokenOut, amount: amountIn, params: {}, children: [],
  }] } };
}
function decode(calldata: string) {
  const bytes = ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", calldata)[0]);
  const u24 = (at: number) => bytes[at]! * 65536 + bytes[at + 1]! * 256 + bytes[at + 2]!;
  const uint = (at: number) => BigInt(ethers.hexlify(bytes.slice(at, at + 32)));
  assert.equal(bytes[0], 0x09); assert.equal(u24(1), bytes.length - 4);
  const rootAmount = uint(4), tolerance = bytes[36]!, count = bytes[37]!;
  let at = 38;
  const steps: { tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; script: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const tokenIn = ethers.hexlify(bytes.slice(at, at + 20));
    const tokenOut = ethers.hexlify(bytes.slice(at + 20, at + 40));
    assert.equal(bytes[at + 40], 1, "one sealed amount case per prefix step");
    const end = at + 44 + u24(at + 41);
    at += 44;
    const templateLength = u24(at); at += 3;
    const script = bytes.slice(at, at + templateLength); at += templateLength;
    const amountIn = uint(at), amountOut = uint(at + 32);
    assert.equal(bytes[at + 64], 1, "single case reuses its exact base script");
    assert.equal(u24(at + 65), 0, "no byte patches for the only case");
    at += 68; assert.equal(at, end);
    steps.push({ tokenIn, tokenOut, amountIn, amountOut, script });
  }
  assert.equal(at, bytes.length);
  return { rootAmount, tolerance, steps };
}

test("generic prefix compiles deterministic open-path calldata with exact input/output guards", () => {
  const input = [step(), step(B, C, 20n, 1n)];
  const before = structuredClone(input);
  const compiled = compileExactPrefix(input, EXECUTOR);
  assert.deepEqual(compiled, compileExactPrefix(input, EXECUTOR));
  assert.deepEqual(input, before, "compilation never mutates issued fragments");
  assert.deepEqual({ ...compiled, calldata: undefined }, {
    executor: EXECUTOR, inputToken: A, inputAmount: 10n, calldata: undefined,
  });
  const decoded = decode(compiled.calldata);
  assert.equal(decoded.rootAmount, 10n); assert.equal(decoded.tolerance, 0);
  assert.deepEqual(decoded.steps.map(({ tokenIn, tokenOut, amountIn, amountOut }) =>
    ({ tokenIn, tokenOut, amountIn, amountOut })), [
    { tokenIn: A, tokenOut: B, amountIn: 10n, amountOut: 20n },
    { tokenIn: B, tokenOut: C, amountIn: 20n, amountOut: 1n },
  ]);
  for (const [i, value] of decoded.steps.entries()) assert.deepEqual(value.script,
    encodeCall(TARGET, ethers.getBytes(ACTION.encodeFunctionData("apply", [input[i]!.amountIn]))));
  assert.notEqual(decoded.steps.at(-1)!.tokenOut, compiled.inputToken, "prefix need not close");
});

test("prefix uses unchanged shared approval minima, grant ceilings and transfer order", () => {
  const base = step();
  const fragment = { ...base.fragment, requirements: [
    { kind: "approve" as const, token: A, spender: SPENDER, amount: ethers.MaxUint256 },
    { kind: "approve" as const, token: A, spender: SPENDER, amount: 50n },
    { kind: "approve" as const, token: C, spender: SPENDER, amount: ethers.MaxUint256 },
    { kind: "transfer-to-pool" as const, token: A, pool: TARGET, amount: 10n },
  ] };
  const nodes = planFragmentNodes(fragment, A, 10n);
  assert.deepEqual(nodes.map(node => node.adapterId), [
    "erc20-approve", "erc20-approve", "erc20-approve", "erc20-transfer", "prefix-fixture-action",
  ]);
  assert.deepEqual(nodes.slice(0, 3).map(node => node.params.minimumAllowance), [10n, 50n, ethers.MaxUint256]);
  assert.deepEqual(nodes.slice(0, 3).map(node => node.amount), [ethers.MaxUint256, 50n, ethers.MaxUint256]);
  const encoded = decode(compileExactPrefix([{ ...base, fragment }], EXECUTOR).calldata).steps[0]!.script;
  for (const [i, minimum] of [10n, 50n, ethers.MaxUint256].entries()) {
    assert.equal(encoded[i * 105], 0x0a);
    assert.equal(BigInt(ethers.hexlify(encoded.slice(i * 105 + 41, i * 105 + 73))), minimum);
  }
  assert.equal(encoded[315], 0x00, "transfer follows conditional allowances");
  for (const amount of [0n, -1n, 1n << 256n]) assert.throws(() => planFragmentNodes({ ...base.fragment,
    requirements: [{ kind: "approve", token: A, spender: SPENDER, amount }] }, A, 10n), /approval/);
});

test("prefix rejects zero amounts, oversized words, identity legs and disconnected chains", () => {
  for (const invalid of [[], Array.from({ length: 7 }, () => step()), [step(A, A)],
    [step(A, B, 0n)], [step(A, B, 10n, 0n)], [step(A, B, 1n << 256n)],
    [step(A, B, 10n, 1n << 256n)], [step(), step(C, A, 20n, 30n)],
    [step(), step(B, C, 19n, 30n)], [step(ethers.ZeroAddress)],
    [{ ...step(), fragment: { requirements: [], nodes: [] } }]]) {
    assert.throws(() => compileExactPrefix(invalid, EXECUTOR), /prefix|amount-flow/);
  }
  assert.throws(() => compileExactPrefix([step()], ethers.ZeroAddress), /address/);
  const six = Array.from({ length: 6 }, (_, i) => step(i % 2 ? B : A, i % 2 ? A : B, 10n, 10n));
  assert.equal(decode(compileExactPrefix(six, EXECUTOR).calldata).steps.length, 6);
});

function flow(prefix: boolean, closed: boolean): ResolvedPlanNode {
  const mode: Record<string, string> = prefix ? { mode: "quote-prefix" } : {};
  const children = [step(), step(B, closed ? A : C, 20n, 30n)].map((value): ResolvedPlanNode => ({
    adapterId: "actual-amount-step", target: EXECUTOR, tokenIn: value.tokenIn, tokenOut: value.tokenOut,
    amount: value.amountIn, params: {}, children: [{ adapterId: "actual-amount-case", target: EXECUTOR,
      tokenIn: value.tokenIn, tokenOut: value.tokenOut, amount: value.amountIn,
      params: { ...mode, quotedAmountOut: value.amountOut }, children: value.fragment.nodes.slice() }],
  }));
  return { adapterId: "actual-amount-flow", target: EXECUTOR, tokenIn: A, tokenOut: closed ? A : C,
    amount: 10n, params: { ...mode, toleranceRawUnits: prefix ? 0n : 1n }, children };
}
test("open paths require explicit zero-tolerance prefix mode; ordinary closed mode stays unchanged", () => {
  const encode = (root: ResolvedPlanNode) => actualAmountFlowAdapter.encode(root, EXECUTOR, new Uint8Array([1]));
  assert.equal(encode(flow(false, true))[36], 1);
  assert.throws(() => encode(flow(false, false)), /root/);
  assert.equal(encode(flow(true, false))[36], 0);
  assert.equal(encode(flow(true, true))[36], 0);
  const relaxed = flow(true, false); relaxed.params.toleranceRawUnits = 1n;
  assert.throws(() => encode(relaxed), /root/);
  const unmarked = flow(false, true); unmarked.params.toleranceRawUnits = 0n;
  assert.throws(() => encode(unmarked), /root/);
  const multiple = flow(true, false); multiple.children[1]!.children.push({ ...multiple.children[1]!.children[0]!, amount: 21n });
  assert.throws(() => encode(multiple), /prefix/);
  const wrongAmount = flow(true, false); wrongAmount.children[1]!.children[0]!.amount = 19n;
  assert.throws(() => encode(wrongAmount), /prefix/);
  const one = flow(true, false).children[0]!.children[0]!; one.params.quotedAmountOut = 1n;
  assert.doesNotThrow(() => actualAmountCaseAdapter.encode(one, EXECUTOR, new Uint8Array([1])));
  delete one.params.mode;
  assert.throws(() => actualAmountCaseAdapter.encode(one, EXECUTOR, new Uint8Array([1])), /case/);
});

test("prefix builder AST has no protocol imports, names or semantic dispatch", () => {
  const source = ts.createSourceFile("exact-prefix-plan.ts", readFileSync(new URL("../exact-prefix-plan.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isPropertyAccessExpression(node)) assert(!["familyId", "lineageId", "descriptor", "pool", "factory", "fee"].includes(node.name.text));
    if (ts.isStringLiteral(node)) assert(!/uniswap|univ[234]|curve|fluid|ekubo|balancer|xwin|sat1/i.test(node.text));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(imports.every(value => !/venues\/(swaps|protocols|credit)|solver\/.*math/.test(value)));
});
