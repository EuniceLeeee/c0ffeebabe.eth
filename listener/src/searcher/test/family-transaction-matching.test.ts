import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex, ZeroAddress } from "ethers";
import { matchFamilyTransactionInput, type ObservedReadyRoute } from "./family-transaction-matching.js";
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
