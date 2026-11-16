import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex, ZeroAddress } from "ethers";
import { resolveTransactionCaseBinding, matchFamilyTransactionInput, type ObservedReadyRoute } from "./family-transaction-matching.js";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";
import type { FamilyTransactionLeg } from "./family-transaction-registry.js";

const A = (n: number) => toBeHex(n, 20), H = (n: number) => toBeHex(n, 32);
const TX = H(90), source = { number: 25000000, hash: H(91) }, pool = A(2), asset = A(3), holder = A(4);
const token = new Interface(["function transferFrom(address,address,uint256)", "function transfer(address,uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const action = new Interface(["function deposit(uint256,address)", "function redeem(uint256,address,address)", "function withdraw(uint256,address,address)"]);
const frame = (to: string, from: string, input: string, path: number[], extra: object = {}) => ({
  type: "call", action: { to, from, input, callType: "call", value: "0x0", gas: "0xffff" }, result: { output: "0x", gasUsed: "0x1" },
  traceAddress: path, transactionHash: TX, blockNumber: source.number, blockHash: source.hash, subtraces: 0, ...extra,
});
const log = (address: string, from: string, to: string, value: bigint, index: number) => ({
  address, ...token.encodeEventLog(token.getEvent("Transfer")!, [from, to, value]), transactionHash: TX,
  blockNumber: toBeHex(source.number), blockHash: source.hash, transactionIndex: "0x0", logIndex: toBeHex(index), removed: false,
});
function fixture() {
  const routes: ObservedReadyRoute[] = ["deposit", "redeem"].map(direction => ({ familyId: "protocol:test", instanceKey: pool,
    lineageId: "standard", routeKey: direction, adapterId: direction, direction, target: pool,
    tokenIn: direction === "deposit" ? asset : pool, tokenOut: direction === "deposit" ? pool : asset,
    matchTrace: (to, selector) => to === pool && selector === action.getFunction(direction)!.selector }));
  const expected: FamilyTransactionLeg = { id: "test", familyId: "protocol:test", domain: "protocol", source,
    instanceKey: pool, lineageId: "standard", tokenIn: asset, tokenOut: pool, amountIn: "7", amountScope: "original" };
  const evidence: ReadyTransactionEvidence = { method: "trace_transaction", receipt: { transactionHash: TX, blockNumber: source.number,
    blockHash: source.hash, transactionIndex: 0, status: 1, logs: [log(asset, holder, pool, 7n, 0), log(pool, ZeroAddress, holder, 5n, 1)] },
    rawTrace: [frame(A(10), holder, "0x12345678", []), frame(pool, holder, action.encodeFunctionData("deposit", [7n, holder]), [0]),
      frame(asset, pool, token.encodeFunctionData("transferFrom", [holder, pool, 7n]), [0, 0])] };
  return { transactionHash: TX, expected, routes, evidence };
}

function withFrameLogs(f: ReturnType<typeof fixture>) {
  const flat = f.evidence.rawTrace as any[], nodes = new Map<string, any>();
  for (const x of flat) nodes.set(JSON.stringify(x.traceAddress), {
    type: "CALL", ...x.action, ...(x.error ? { error: x.error } : {}), calls: [], logs: [],
  });
  for (const x of flat) if (x.traceAddress.length) nodes.get(JSON.stringify(x.traceAddress.slice(0, -1))).calls.push(nodes.get(JSON.stringify(x.traceAddress)));
  // This fixture's receipt logs are produced by its known action.
  nodes.get("[0]").logs = f.evidence.receipt.logs;
  f.evidence = { ...f.evidence, method: "debug_traceTransaction", traceLogsComplete: true, rawTrace: nodes.get("[]") };
  return f;
}

test("inner action uses admitted production matcher and actual input flow; outer selector cannot select a direction", () => {
  const f = fixture(), result = matchFamilyTransactionInput(f);
  assert.equal(result.status, "matched"); assert.equal(result.selected.amountIn, "7");
  assert.deepEqual(result.selected.traceAddress, [0]); assert.equal(result.selected.inputEvidence.kind, "transfer-call");
  assert.equal(result.selected.direction, "deposit"); assert.equal(result.expected.amountIn, "7");
});
test("counterfactual reverse direction and doubled input stay conflicts; fixture is never rewritten", () => {
  const f = fixture(), original = structuredClone(f.expected);
  const reversed = matchFamilyTransactionInput({ ...f, expected: { ...f.expected, tokenIn: pool, tokenOut: asset } });
  assert.equal(reversed.status, "action-conflict"); assert.equal(reversed.observed[0].direction, "deposit");
  assert.equal(reversed.selected, undefined);
  assert.equal(matchFamilyTransactionInput({ ...f, expected: { ...f.expected, amountIn: "14" } }).status, "input-conflict");
  assert.deepEqual(f.expected, original);
});
test("missing direction is separate from unobserved action; event alone cannot manufacture redeem from withdraw", () => {
  const f = fixture();
  assert.equal(matchFamilyTransactionInput({ ...f, routes: f.routes.slice(1) }).status, "direction-not-admitted");
  (f.evidence.rawTrace as any[])[1].action.input = action.encodeFunctionData("withdraw", [7n, holder, holder]);
  assert.equal(matchFamilyTransactionInput(f).status, "action-not-observed");
});
test("share burn proves redeem amount without guessing ABI units; output asset amount is not input", () => {
  const f = fixture(); f.expected = { ...f.expected, tokenIn: pool, tokenOut: asset };
  f.evidence = { ...f.evidence, receipt: { ...f.evidence.receipt,
    logs: [log(pool, holder, ZeroAddress, 7n, 0), log(asset, pool, holder, 9n, 1)] },
    rawTrace: [frame(A(10), holder, "0x12345678", []), frame(pool, holder, action.encodeFunctionData("redeem", [7n, holder, holder]), [0]),
      frame(asset, pool, token.encodeFunctionData("transfer", [holder, 9n]), [0, 0])] };
  const result = matchFamilyTransactionInput(f);
  assert.equal(result.status, "matched"); assert.equal(result.selected.inputEvidence.kind, "burn"); assert.equal(result.selected.amountIn, "7");
});
test("reverted nested invocation cannot borrow another frame's committed logs", () => {
  const f = fixture(); (f.evidence.rawTrace as any[])[1].error = "Reverted";
  assert.equal(matchFamilyTransactionInput(f).status, "action-not-observed");
});
test("duplicate transport tuples and shared-manager logical pools remain unresolved", () => {
  const f = fixture();
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[], frame(asset, pool, token.encodeFunctionData("transferFrom", [holder, pool, 7n]), [0, 1])] };
  assert.equal(matchFamilyTransactionInput(f).status, "evidence-incomplete");
  const g = fixture(); g.routes.push({ ...g.routes[0]!, instanceKey: pool + ":second-pool", routeKey: "another" });
  assert.equal(matchFamilyTransactionInput(g).status, "evidence-incomplete");
});
test("multiple independently admitted Families stay separate and unrelated unknown TX calls do not fail target", () => {
  const f = fixture(); f.routes.push({ ...f.routes[0]!, familyId: "protocol:other" });
  const result = matchFamilyTransactionInput(f); assert.equal(result.status, "matched"); assert.equal(result.observed.length, 2);
  assert.equal(result.selected.familyId, f.expected.familyId);
});
test("foreign TX/source and duplicate trace paths are rejected", () => {
  const f = fixture();
  assert.throws(() => matchFamilyTransactionInput({ ...f, transactionHash: H(95) }), /TX differs/);
  assert.throws(() => matchFamilyTransactionInput({ ...f, expected: { ...f.expected, source: { ...source, hash: H(95) } } }), /source differs/);
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[], (f.evidence.rawTrace as any[])[1]] };
  assert.throws(() => matchFamilyTransactionInput(f), /duplicate trace/);
});

test("native settlement uses the production route assets; WETH denomination alone cannot invent an ETH bridge", () => {
  const f = fixture(); f.expected = { ...f.expected, tokenOut: A(8) }; f.routes[0] = { ...f.routes[0]!, tokenOut: A(8), executionAssets: { input: "erc20", output: "native" } };
  f.evidence = { ...f.evidence, receipt: { ...f.evidence.receipt, logs: f.evidence.receipt.logs.slice(0, 1) },
    rawTrace: [...f.evidence.rawTrace as any[], { ...frame(holder, pool, "0x", [0, 1]),
      action: { from: pool, to: holder, input: "0x", callType: "call", value: "0x5" } }] };
  const result = matchFamilyTransactionInput(f); assert.equal(result.status, "matched");
  assert.deepEqual(result.selected.nativeOutputTraceAddresses, [[0, 1]]);
  f.routes[0] = { ...f.routes[0]!, executionAssets: undefined };
  assert.equal(matchFamilyTransactionInput(f).status, "evidence-incomplete");
});

// Generator regression: current Ready owns lineage, actual action owns route.
test("case generation follows child lineage without changing input or original fixture", () => {
  const f = fixture(), before = structuredClone(f.expected);
  f.routes[0] = { ...f.routes[0]!, lineageId: "child", routeKey: "child-deposit" };
  const binding = resolveTransactionCaseBinding(f);
  assert.deepEqual(binding.resolved, { lineageId: "child", routeKey: "child-deposit" });
  assert.equal(binding.selection, "transaction-action");
  assert.deepEqual(f.expected, before);
  assert.equal(matchFamilyTransactionInput(f).status, "direction-not-admitted");
});
test("same-pair actions use selector, doubled input never changes action or amount", () => {
  const f = fixture();
  f.routes.push({ ...f.routes[0]!, routeKey: "mint", adapterId: "mint", direction: "mint", matchTrace: (_, selector) => selector === "0x94bf804d" });
  f.expected = { ...f.expected, amountIn: "14" };
  assert.equal(resolveTransactionCaseBinding(f).resolved.routeKey, "deposit");
  assert.equal(f.expected.amountIn, "14");
});
test("generator rejects unsupported selectors instead of choosing the same token pair", () => {
  const f = fixture();
  (f.evidence.rawTrace as any[])[1].action.input = "0x94bf804d" + "00".repeat(64);
  assert.throws(() => resolveTransactionCaseBinding(f), /unmapped target selector/);
});
test("ambiguous current action does not fall back to old lineage or first route", () => {
  const f = fixture(); f.routes.push({ ...f.routes[0]!, routeKey: "second", lineageId: "child" });
  assert.throws(() => resolveTransactionCaseBinding(f), /route absent or ambiguous/);
});
test("an explicit missing route cannot be silently replaced by a successful direction", () => {
  const f = fixture(); f.expected = { ...f.expected, routeKey: "old-mint" };
  assert.throws(() => resolveTransactionCaseBinding(f), /action cannot be substituted/);
});
test("explicit simulation actions preserve nonhistorical variants and only refresh lineage", () => {
  const f = fixture(); f.expected = { ...f.expected, tokenIn: pool, tokenOut: asset, routeKey: "redeem" };
  f.routes[1] = { ...f.routes[1]!, lineageId: "child" };
  assert.deepEqual(resolveTransactionCaseBinding(f).resolved, { routeKey: "redeem", lineageId: "child" });
  assert.equal(matchFamilyTransactionInput(f).status, "direction-not-admitted");
});

test("vault ERC20 authorization is auxiliary, not an unknown conversion action", () => {
  const f = fixture(), approvals = new Interface(["function approve(address,uint256)"]);
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[],
    frame(pool, holder, approvals.encodeFunctionData("approve", [A(19), 7n]), [1])] };
  assert.equal(resolveTransactionCaseBinding(f).resolved.routeKey, "deposit");
});


test("known action keeps nested unmapped calls as evidence without rejecting its route", () => {
  const f = fixture();
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[],
    frame(pool, A(10), "0xad207501", [0, 1, 0])] };
  const binding = resolveTransactionCaseBinding(f);
  assert.equal(binding.resolved.routeKey, "deposit");
  assert.deepEqual(binding.nestedUnmappedCalls, [{ target: pool, selector: "0xad207501", traceAddress: [0, 1, 0] }]);
});

test("known nested action cannot excuse an unsupported outer action", () => {
  const f = fixture();
  (f.evidence.rawTrace as any[])[0].action.to = pool;
  assert.throws(() => resolveTransactionCaseBinding(f), /unmapped target selector/);
});

test("unattributed sibling calls are diagnostics rather than invented actions", () => {
  const f = fixture();
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[],
    frame(pool, holder, "0x94bf804d" + "00".repeat(64), [1])] };
  assert.throws(() => resolveTransactionCaseBinding(f), /complete frame asset logs required/);
});


test("known action cannot cover an unknown call at a different candidate target", () => {
  const f = fixture();
  f.routes.push({ ...f.routes[0]!, target: A(20), routeKey: "other-target", matchTrace: () => false });
  f.evidence = { ...f.evidence, rawTrace: [...f.evidence.rawTrace as any[],
    frame(A(20), pool, "0xad207501", [0, 1])] };
  assert.throws(() => resolveTransactionCaseBinding(f), /complete frame asset logs required/);
});


test("an unknown sibling moving route assets remains an adaptation gap", () => {
  const f = fixture();
  f.evidence.rawTrace = [...f.evidence.rawTrace as any[],
    frame(pool, holder, "0x94bf804d", [1]),
    frame(asset, pool, token.encodeFunctionData("transferFrom", [holder, pool, 9n]), [1, 0])];
  assert.throws(() => resolveTransactionCaseBinding(f), /unmapped target selector with asset flow/);
});

test("CALL-form view beside a share burn cannot invalidate the redeem action", () => {
  const f = fixture(); f.expected = { ...f.expected, tokenIn: pool, tokenOut: asset };
  f.evidence = { ...f.evidence, receipt: { ...f.evidence.receipt,
    logs: [log(pool, holder, ZeroAddress, 7n, 0), log(asset, pool, holder, 9n, 1)] },
    rawTrace: [frame(A(10), holder, "0x12345678", []),
      frame(pool, holder, action.encodeFunctionData("redeem", [7n, holder, holder]), [0]),
      frame(asset, pool, token.encodeFunctionData("transfer", [holder, 9n]), [0, 0]),
      frame(pool, holder, "0x18160ddd", [1])] };
  withFrameLogs(f);
  assert.equal(matchFamilyTransactionInput(f).status, "matched");
  assert.equal(resolveTransactionCaseBinding(f).resolved.routeKey, "redeem");
});


test("unknown burn cannot donate receipt evidence to a sibling known redeem", () => {
  const f = fixture(); f.expected = { ...f.expected, tokenIn: pool, tokenOut: asset };
  f.evidence = { ...f.evidence, receipt: { ...f.evidence.receipt,
    logs: [log(pool, holder, ZeroAddress, 7n, 0), log(asset, pool, holder, 9n, 1)] },
    rawTrace: [frame(A(10), holder, "0x12345678", []), frame(pool, holder, "0xdeadbeef", [0]),
      frame(pool, holder, action.encodeFunctionData("redeem", [7n, holder, holder]), [1]),
      frame(asset, pool, token.encodeFunctionData("transfer", [holder, 9n]), [1, 0])] };
  assert.notEqual(matchFamilyTransactionInput(f).status, "matched");
  assert.throws(() => resolveTransactionCaseBinding(f), /complete frame asset logs required/);
  withFrameLogs(f);
  assert.throws(() => resolveTransactionCaseBinding(f), /unmapped target selector with asset flow/);
  (f.evidence.rawTrace as any).calls[0].input = "0x";
  assert.notEqual(matchFamilyTransactionInput(f).status, "matched");
  assert.throws(() => resolveTransactionCaseBinding(f), /unmapped target selector with asset flow/);
});
