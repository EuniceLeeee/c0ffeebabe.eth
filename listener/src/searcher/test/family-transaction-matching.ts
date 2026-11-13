import assert from "node:assert/strict";
import { Interface, ZeroAddress } from "ethers";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";
import { observationsFromSelectedTransaction, type RebuildCallObservation } from "../universe-rebuild-production.js";
import type { FamilyTransactionLeg } from "./family-transaction-registry.js";

// ERC20 is the shared asset transport, not a protocol/action classifier.
const TOKEN = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address to,uint256 amount)",
  "function transferFrom(address from,address to,uint256 amount)",
]);
const lower = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const pathKey = (p: readonly number[]) => JSON.stringify(p);
const inside = (child: readonly number[], parent: readonly number[]) => parent.every((v, i) => child[i] === v);
const before = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
};

export interface ObservedReadyRoute {
  familyId: string; instanceKey: string; lineageId: string; routeKey: string;
  adapterId: string; target: string; tokenIn: string; tokenOut: string;
  direction?: string;
  executionAssets?: { input: "erc20" | "native"; output: "erc20" | "native" };
  /** The production Family-owned matcher; no selector table in this runner. */
  matchTrace(target: string, selector: string): boolean;
}
type Transfer = { token: string; from: string; to: string; amount: string; logIndex: number };
type TransferCall = { token: string; from: string; to: string; amount: string; call: RebuildCallObservation };
export interface MatchedTransactionInput {
  familyId: string; instanceKey: string; lineageId: string; routeKey: string;
  adapterId: string; direction?: string; tokenIn: string; tokenOut: string;
  amountIn: string; target: string; selector: string; traceAddress: readonly number[];
  inputEvidence: { kind: "transfer-call" | "prepaid-transfer" | "burn" | "native-call-value"; logIndex?: number; traceAddress?: readonly number[] };
  outputLogIndices: readonly number[];
  nativeOutputTraceAddresses: readonly (readonly number[])[];
}

/** Retain the production decoder and receipt binding. Additionally discard a
 * failed frame AND its descendants: reverted inner calls are not TX facts. */
export function successfulTransactionCalls(evidence: ReadyTransactionEvidence) {
  const frames = new Map<string, any>(), selectors = new Set<string>();
  const add = (raw: any, path: number[]) => {
    assert(raw && Array.isArray(path) && path.every(n => Number.isSafeInteger(n) && n >= 0), "invalid trace path");
    assert(!frames.has(pathKey(path)), "duplicate trace frame");
    const action = raw.action ?? raw;
    frames.set(pathKey(path), { ...raw, path, action });
    if (typeof action.input === "string" && action.input.length >= 10) selectors.add(lower(action.input.slice(0, 10)));
  };
  if (evidence.method === "trace_transaction") {
    assert(Array.isArray(evidence.rawTrace), "transaction trace array required");
    for (const raw of evidence.rawTrace as any[]) add(raw, raw.traceAddress);
  } else {
    const walk = (raw: any, path: number[]) => { add(raw, path); (raw.calls ?? []).forEach((c: any, i: number) => walk(c, [...path, i])); };
    walk(evidence.rawTrace, []);
  }
  const topics = [...new Set(evidence.receipt.logs.flatMap((log: any) => log.topics?.slice(0, 1) ?? []))] as string[];
  const decoded = observationsFromSelectedTransaction(evidence, topics, selectors);
  assert.equal(evidence.receipt.status, 1, "reverted TX cannot supply successful input facts");
  const failed = [...frames.values()].filter(f => typeof f.error === "string").map(f => f.path as number[]);
  const successfulFrames = new Map([...frames].filter(([, frame]) => !failed.some(path => inside(frame.path, path))));
  return { calls: decoded.calls.filter(c => successfulFrames.has(pathKey(c.traceAddress))), frames: successfulFrames };
}

/** Match only the TX's actual action and evidenced input. Absence/ambiguity is
 * retained, never repaired by reversing a route or borrowing a quote amount.
 * Multi-call flows that cannot be unambiguously tied to a receipt stay unresolved. */
export function matchFamilyTransactionInput(input: {
  transactionHash: string; evidence: ReadyTransactionEvidence; routes: readonly ObservedReadyRoute[]; expected: FamilyTransactionLeg;
}) {
  const { evidence, routes, expected } = input;
  assert(same(evidence.receipt.transactionHash, input.transactionHash), "matching TX differs from registered sample");
  assert(expected.source && evidence.receipt.blockNumber === expected.source.number && same(evidence.receipt.blockHash, expected.source.hash),
    "matching source differs from registered sample");
  const { calls, frames } = successfulTransactionCalls(evidence);
  const transfers: Transfer[] = [];
  for (const log of evidence.receipt.logs as any[]) {
    if (log.topics?.length !== 3 || !same(log.topics[0], TOKEN.getEvent("Transfer")!.topicHash)) continue;
    const decoded = TOKEN.decodeEventLog("Transfer", log.data, log.topics);
    transfers.push({ token: lower(log.address), from: lower(decoded[0]), to: lower(decoded[1]),
      amount: decoded[2].toString(), logIndex: Number(log.logIndex) });
  }
  const tokenCalls: TransferCall[] = [];
  for (const call of calls) {
    let decoded;
    try { decoded = TOKEN.parseTransaction({ data: call.data }); } catch { continue; }
    if (!decoded) continue;
    const from = decoded.name === "transferFrom" ? String(decoded.args[0]) : call.sender;
    if (!from) continue;
    tokenCalls.push({ token: lower(call.target), from: lower(from),
      to: lower(String(decoded.args[decoded.name === "transferFrom" ? 1 : 0])),
      amount: decoded.args[decoded.name === "transferFrom" ? 2 : 1].toString(), call });
  }
  const transferLog = (c: TransferCall) => transfers.filter(t => t.token === c.token && t.from === c.from && t.to === c.to && t.amount === c.amount);
  const sameTransfer = (a: TransferCall, b: TransferCall) => a.token === b.token && a.from === b.from && a.to === b.to && a.amount === b.amount;
  const mutableCalls = (target: string) => [...frames.values()].filter(f => same(f.action.to ?? "", target) &&
    lower(String(f.action.callType ?? f.type)) === "call");
  const observed: MatchedTransactionInput[] = [], unresolved: Record<string, unknown>[] = [];
  for (const route of routes) {
    const actionCalls = calls.filter(c => same(c.target, route.target) && route.matchTrace(c.target, c.data.slice(0, 10)));
    for (const call of actionCalls) {
      const context = { familyId: route.familyId, instanceKey: route.instanceKey, routeKey: route.routeKey,
        selector: call.data.slice(0, 10), traceAddress: call.traceAddress };
      // A trace transfer is tied to a receipt only when that tuple occurs once
      // in BOTH. Repeated identical transfers require richer evidence, not guessing.
      const proved = tokenCalls.filter(c => transferLog(c).length === 1 && tokenCalls.filter(other => sameTransfer(c, other)).length === 1);
      const nested = proved.filter(c => same(c.token, route.tokenIn) && inside(c.call.traceAddress, call.traceAddress) &&
        !same(c.from, route.target) && (same(c.to, route.target) || same(c.from, call.sender ?? "")) && c.amount !== "0");
      const inputs: { amount: string; proof: MatchedTransactionInput["inputEvidence"] }[] = nested.map(c => ({ amount: c.amount,
        proof: { kind: "transfer-call", logIndex: transferLog(c)[0]!.logIndex, traceAddress: c.call.traceAddress } }));
      if (!inputs.length && mutableCalls(route.target).length === 1) {
        // Router-prepaid input: independently observed transfer into this exact
        // pool before its sole action. Shared managers remain ambiguous below.
        const prepaid = proved.filter(c => same(c.token, route.tokenIn) && same(c.to, route.target) &&
          before(c.call.traceAddress, call.traceAddress) && !inside(call.traceAddress, c.call.traceAddress) && c.amount !== "0");
        for (const c of prepaid) inputs.push({ amount: c.amount,
          proof: { kind: "prepaid-transfer", logIndex: transferLog(c)[0]!.logIndex, traceAddress: c.call.traceAddress } });
      }
      if (!inputs.length && same(route.tokenIn, route.target) && call.sender) {
        // A share burn may be internal Solidity code and have no transfer call.
        // Only the holder's unique burn and a sole mutable invocation qualify.
        const mutable = mutableCalls(route.target);
        if (mutable.length === 1) for (const t of transfers.filter(t => same(t.token, route.tokenIn) && same(t.from, call.sender!) && t.to === ZeroAddress && t.amount !== "0"))
          inputs.push({ amount: t.amount, proof: { kind: "burn", logIndex: t.logIndex } });
      }
      if (route.executionAssets?.input === "native" || same(route.tokenIn, ZeroAddress)) {
        const value = BigInt(frames.get(pathKey(call.traceAddress))?.action.value ?? "0x0");
        if (value > 0n) inputs.push({ amount: value.toString(), proof: { kind: "native-call-value", traceAddress: call.traceAddress } });
      }
      const soleInvocation = mutableCalls(route.target).length === 1;
      const outputs = transfers.filter(t => same(t.token, route.tokenOut) && t.amount !== "0" && (
        soleInvocation && (same(t.from, route.target) || same(route.tokenOut, route.target) && t.from === ZeroAddress) ||
        proved.some(c => c.token === t.token && transferLog(c)[0]?.logIndex === t.logIndex && inside(c.call.traceAddress, call.traceAddress))));
      const nativeOutputs = (route.executionAssets?.output === "native" || same(route.tokenOut, ZeroAddress)) ? [...frames.values()].filter(f =>
        inside(f.path, call.traceAddress) && f.path.length > call.traceAddress.length &&
        same(f.action.from ?? "", route.target) && BigInt(f.action.value ?? "0x0") > 0n && lower(String(f.action.callType ?? f.type)) === "call") : [];
      if (inputs.length !== 1 || outputs.length === 0 && !nativeOutputs.length) {
        unresolved.push({ ...context, reason: inputs.length !== 1 ? "input-flow-absent-or-ambiguous" : "output-token-flow-unproven",
          inputCandidates: inputs, outputLogIndices: outputs.map(t => t.logIndex) }); continue;
      }
      observed.push({ ...context, lineageId: route.lineageId, adapterId: route.adapterId, direction: route.direction,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn: inputs[0]!.amount, target: route.target,
        inputEvidence: inputs[0]!.proof, outputLogIndices: outputs.map(t => t.logIndex), nativeOutputTraceAddresses: nativeOutputs.map(f => f.path) });
    }
  }
  // Address/token pairs do not distinguish multiple pools inside one manager.
  const unique = observed.filter(row => {
    const rivals = observed.filter(other => other.familyId === row.familyId && pathKey(other.traceAddress) === pathKey(row.traceAddress) &&
      same(other.tokenIn, row.tokenIn) && same(other.tokenOut, row.tokenOut));
    if (rivals.length !== 1) { unresolved.push({ ...row, reason: "logical-instance-or-route-ambiguous" }); return false; }
    return true;
  });
  const targetRoutes = routes.filter(r => r.familyId === expected.familyId && same(r.instanceKey, expected.instanceKey ?? "") &&
    r.lineageId === expected.lineageId && same(r.tokenIn, expected.tokenIn ?? "") && same(r.tokenOut, expected.tokenOut ?? "") &&
    (expected.routeKey === undefined || r.routeKey === expected.routeKey));
  const matching = unique.filter(row => targetRoutes.some(r => r.familyId === row.familyId && same(r.instanceKey, row.instanceKey) && r.routeKey === row.routeKey) && row.amountIn === expected.amountIn);
  const status = targetRoutes.length !== 1 ? "direction-not-admitted"
    : matching.length === 1 ? "matched"
    : unique.some(row => targetRoutes.some(r => r.familyId === row.familyId && same(r.instanceKey, row.instanceKey) && r.routeKey === row.routeKey)) ? "input-conflict"
    : unique.some(row => row.familyId === expected.familyId && same(row.instanceKey, expected.instanceKey ?? "")) ? "action-conflict"
    : unresolved.some(row => row.routeKey === targetRoutes[0]!.routeKey) ? "evidence-incomplete" : "action-not-observed";
  return JSON.parse(JSON.stringify({ version: 1, transactionHash: evidence.receipt.transactionHash, source: expected.source, status, expected: { familyId: expected.familyId, instanceKey: expected.instanceKey,
    lineageId: expected.lineageId, tokenIn: expected.tokenIn, tokenOut: expected.tokenOut, amountIn: expected.amountIn, routeKey: expected.routeKey },
    observed: unique, unresolved,
    targetCalls: calls.filter(c => same(c.target, expected.instanceKey ?? "")).map(c => ({ target: c.target, selector: c.data.slice(0, 10), traceAddress: c.traceAddress })), ...(status === "matched" ? { selected: matching[0]! } : {}),
    claim: "TX action/input binding only; Ready and execution acceptance remain independent gates" }));
}
