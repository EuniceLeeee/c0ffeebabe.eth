import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex, ZeroAddress } from "ethers";
import { extractObservedCallSamples, ObservedCallEvidenceError } from "../observed-call-evidence.js";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";

const address = (n: number) => toBeHex(n, 20);
const hash = (n: number) => toBeHex(n, 32);
const sender = address(100), recipient = address(101), pool = address(200), tokenIn = address(300), tokenOut = address(301);
const TOKEN = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address to,uint256 amount)", "function transferFrom(address from,address to,uint256 amount)",
  "function balanceOf(address account) view returns(uint256)"]);
const ACTION = new Interface(["function anUnknownConversion(uint256 amount,address recipient)"]);
const receipt = () => ({ transactionHash: hash(1000), blockNumber: 123, blockHash: hash(123), transactionIndex: 2, status: 1 as const, logs: [] as unknown[] });
function frame(from: string, to: string, input: string, calls: any[] = []): any {
  return { type: "CALL", from, to, input, value: "0x0", output: "0x", calls };
}
function log(token: string, from: string, to: string, amount: bigint, index: number): any {
  const event = TOKEN.encodeEventLog(TOKEN.getEvent("Transfer")!, [from, to, amount]);
  return { address: token, ...event, transactionHash: hash(1000), blockHash: hash(123), blockNumber: "0x7b", transactionIndex: "0x2", logIndex: toBeHex(index) };
}
function conversion(input: { target?: string; from?: string; to?: string; amount?: bigint; startIndex?: number } = {}) {
  const target = input.target ?? pool, from = input.from ?? sender, to = input.to ?? recipient, amount = input.amount ?? 123456789012345678901234n;
  const root = frame(from, target, ACTION.encodeFunctionData("anUnknownConversion", [amount, to]), [
    frame(target, tokenIn, TOKEN.encodeFunctionData("transferFrom", [from, target, amount])),
    frame(target, tokenOut, TOKEN.encodeFunctionData("transfer", [to, amount * 2n])),
  ]);
  return { root, logs: [log(tokenIn, from, target, amount, input.startIndex ?? 0), log(tokenOut, target, to, amount * 2n, (input.startIndex ?? 0) + 1)] };
}
function evidence(): ReadyTransactionEvidence {
  const action = conversion();
  return { receipt: { ...receipt(), logs: action.logs }, method: "debug_traceTransaction", rawTrace: action.root };
}
function directMintEvidence(from = sender): ReadyTransactionEvidence {
  const amount = 123456789012345678901234n;
  return { receipt: { ...receipt(), logs: [log(tokenIn, from, tokenOut, amount, 0),
    log(tokenOut, ZeroAddress, recipient, amount * 2n, 1)] }, method: "debug_traceTransaction",
    rawTrace: frame(from, tokenOut, ACTION.encodeFunctionData("anUnknownConversion", [amount, recipient]), [
      frame(tokenOut, tokenIn, TOKEN.encodeFunctionData("transferFrom", [from, tokenOut, amount])),
    ]) };
}
function parity(value: ReadyTransactionEvidence): ReadyTransactionEvidence {
  const rows: any[] = [];
  function visit(raw: any, path: number[]) {
    rows.push({ type: "call", traceAddress: path, subtraces: raw.calls?.length ?? 0,
      transactionHash: value.receipt.transactionHash, blockHash: value.receipt.blockHash, blockNumber: value.receipt.blockNumber,
      transactionPosition: value.receipt.transactionIndex,
      action: { callType: raw.type.toLowerCase(), from: raw.from, to: raw.to, input: raw.input, value: raw.value },
      ...(raw.error ? { error: raw.error } : { result: { gasUsed: "0x1", output: raw.output ?? "0x" } }) });
    (raw.calls ?? []).forEach((child: any, i: number) => visit(child, [...path, i]));
  }
  visit(value.rawTrace, []);
  return { ...value, method: "trace_transaction", rawTrace: rows };
}
const extract = (value = evidence(), options: { target?: string; maxCandidates?: number } = {}) =>
  extractObservedCallSamples({ evidence: value, chainId: 1, ...options });

test("unregistered selector is extracted from actual frame and unique ERC20 transfer facts", () => {
  const result = extract();
  assert.equal(result.samples.length, 1);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.observedTokens, [tokenIn, tokenOut]);
  assert.deepEqual(result.samples[0], { target: pool, calldata: (evidence().rawTrace as any).input, sender, recipient,
    tokenIn, tokenOut, amountIn: "123456789012345678901234", amountOut: "246913578024691357802468",
    source: { chainId: 1, number: 123, hash: hash(123), transactionHash: hash(1000), traceAddress: [] },
    payment: { kind: "approval", spender: pool } });
  assert.deepEqual(result.witnesses[0]!.input.traceAddress, [0]);
  assert.equal(result.witnesses[0]!.output.logIndex, 1);
  assert(!("ready" in result.samples[0]!));
  assert(Object.isFrozen(result.samples[0]));
});

test("Parity and callTracer yield identical samples and transfer witnesses", () => {
  assert.deepEqual(extract(parity(evidence())), extract());
});

test("direct action token mint binds its sole receipt event without inventing a transfer call", () => {
  const value = directMintEvidence(), result = extract(value, { target: tokenOut });
  assert.equal(result.samples.length, 1);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.samples[0]!.target, tokenOut);
  assert.equal(result.samples[0]!.tokenOut, tokenOut);
  assert.equal(result.samples[0]!.tokenIn, tokenIn);
  assert.equal(result.samples[0]!.amountOut, "246913578024691357802468");
  assert.deepEqual(result.samples[0]!.payment, { kind: "approval", spender: tokenOut });
  assert.deepEqual(result.witnesses[0]!.input.traceAddress, [0]);
  assert(!Object.hasOwn(result.witnesses[0]!.input, "origin"), "old transfer-call witness shape stays compatible");
  assert.deepEqual(result.witnesses[0]!.output, { token: tokenOut, from: ZeroAddress, to: recipient,
    amount: "246913578024691357802468", logIndex: 1, traceAddress: [], origin: "direct-mint-log" });
  assert.equal((value.rawTrace as any).calls.length, 1, "the trace has no output transfer call");
  assert.deepEqual(extract(parity(value), { target: tokenOut }), result);
});

test("a mint at a different token address cannot borrow the action frame", () => {
  const value = directMintEvidence(), root = value.rawTrace as any;
  root.to = pool; root.calls[0].from = pool;
  root.calls[0].input = TOKEN.encodeFunctionData("transferFrom", [sender, pool, 123456789012345678901234n]);
  const changed = { ...value, receipt: { ...value.receipt, logs: [
    log(tokenIn, sender, pool, 123456789012345678901234n, 0), value.receipt.logs[1],
  ] } };
  assert.equal(extract(changed, { target: pool }).samples.length, 0);
});

test("direct mint attribution rejects any second successful non-static target call including ERC20 transport", () => {
  for (const extraData of [TOKEN.encodeFunctionData("transfer", [sender, 1n]), TOKEN.encodeFunctionData("balanceOf", [sender])]) {
    const router = address(900), value = directMintEvidence(router), action = value.rawTrace;
    const repeated = { ...value, rawTrace: frame(sender, router, "0x11223344", [action,
      frame(router, tokenOut, extraData)]) };
    const result = extract(repeated, { target: tokenOut });
    assert.equal(result.samples.length, 0);
    assert(result.unresolved.some(row => row.reason === "direct-mint-target-invoked-multiple-times"));
  }
});

test("direct mint permits static target reads and excludes reverted sibling invocations", () => {
  const router = address(900), value = directMintEvidence(router), action = value.rawTrace as any;
  action.calls.push({ ...frame(tokenOut, tokenOut, TOKEN.encodeFunctionData("balanceOf", [recipient])), type: "STATICCALL" });
  const repeated = { ...value, rawTrace: frame(sender, router, "0x11223344", [action,
    { ...frame(router, tokenOut, TOKEN.encodeFunctionData("transfer", [sender, 1n])), error: "execution reverted" }]) };
  const result = extract(repeated, { target: tokenOut });
  assert.equal(result.samples.length, 1);
  assert.deepEqual(result.witnesses[0]!.output.traceAddress, [0]);
  assert.equal(result.witnesses[0]!.output.origin, "direct-mint-log");
});

test("duplicate mints and a mint plus a transferred output stay ambiguous", () => {
  for (const extraMint of [log(tokenOut, ZeroAddress, recipient, 1n, 2), log(tokenOut, ZeroAddress, address(500), 0n, 2)]) {
    const value = directMintEvidence();
    const result = extract({ ...value, receipt: { ...value.receipt, logs: [...value.receipt.logs, extraMint] } }, { target: tokenOut });
    assert.equal(result.samples.length, 0);
    assert(result.unresolved.some(row => row.reason === "conversion-token-flow-absent-or-ambiguous"));
  }
  const value = directMintEvidence(), extraToken = address(302);
  (value.rawTrace as any).calls.push(frame(tokenOut, extraToken, TOKEN.encodeFunctionData("transfer", [recipient, 1n])));
  const result = extract({ ...value, receipt: { ...value.receipt, logs: [...value.receipt.logs,
    log(extraToken, tokenOut, recipient, 1n, 2)] } }, { target: tokenOut });
  assert.equal(result.samples.length, 0);
  assert(result.unresolved.some(row => row.reason === "conversion-token-flow-absent-or-ambiguous"));
});

test("direct mint rejects extra burns, share transfers, zero output and output to its own target", () => {
  for (const extraFlow of [log(tokenOut, sender, ZeroAddress, 1n, 2), log(tokenOut, sender, address(501), 1n, 2)]) {
    const value = directMintEvidence();
    const result = extract({ ...value, receipt: { ...value.receipt, logs: [...value.receipt.logs, extraFlow] } }, { target: tokenOut });
    assert.equal(result.samples.length, 0);
    assert(result.unresolved.some(row => row.reason === "direct-mint-extra-or-invalid-token-flow"));
  }
  for (const output of [log(tokenOut, ZeroAddress, recipient, 0n, 1), log(tokenOut, ZeroAddress, tokenOut, 1n, 1),
    log(tokenOut, ZeroAddress, ZeroAddress, 1n, 1)]) {
    const value = directMintEvidence();
    assert.equal(extract({ ...value, receipt: { ...value.receipt, logs: [value.receipt.logs[0], output] } }, { target: tokenOut }).samples.length, 0);
  }
});

test("direct mint still needs its real input transfer and refuses callback or delegate execution", () => {
  for (const change of [
    (root: any) => { root.calls = []; },
    (root: any) => { root.calls.push(frame(tokenOut, sender, "0x11223344")); },
    (root: any) => { root.calls.push({ ...frame(tokenOut, address(600), "0x11223344"), type: "DELEGATECALL" }); },
  ]) {
    const value = directMintEvidence(); change(value.rawTrace);
    assert.equal(extract(value, { target: tokenOut }).samples.length, 0);
  }
});

test("a burn-only conversion does not acquire an invented payment mode", () => {
  const amount = 123456789012345678901234n;
  const value = { receipt: { ...receipt(), logs: [log(tokenIn, sender, ZeroAddress, amount, 0),
    log(tokenOut, tokenIn, recipient, amount * 2n, 1)] }, method: "debug_traceTransaction" as const,
    rawTrace: frame(sender, tokenIn, ACTION.encodeFunctionData("anUnknownConversion", [amount, recipient]), [
      frame(tokenIn, tokenOut, TOKEN.encodeFunctionData("transfer", [recipient, amount * 2n])),
    ]) };
  assert.equal(extract(value, { target: tokenIn }).samples.length, 0);
});

test("prepaid sibling transfer is bound to the direct action, not its outer router", () => {
  const amount = 999n;
  const root = frame(sender, address(900), "0x11223344", [
    frame(address(900), tokenIn, TOKEN.encodeFunctionData("transferFrom", [sender, pool, amount])),
    frame(address(900), pool, ACTION.encodeFunctionData("anUnknownConversion", [amount, sender]), [
      frame(pool, tokenOut, TOKEN.encodeFunctionData("transfer", [sender, amount * 2n])),
    ]),
  ]);
  const value = { receipt: { ...receipt(), logs: [log(tokenIn, sender, pool, amount, 0), log(tokenOut, pool, sender, amount * 2n, 1)] },
    method: "debug_traceTransaction" as const, rawTrace: root };
  const result = extract(value);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0]!.target, pool);
  assert.equal(result.samples[0]!.sender, address(900));
  assert.deepEqual(result.samples[0]!.payment, { kind: "prepaid" });
  assert.deepEqual(result.samples[0]!.source.traceAddress, [1]);
  assert(result.unresolved.some(row => row.target === address(900) && row.reason === "nested-execution-or-callback-not-supported"));
});

test("a reverted call and its descendants cannot duplicate or supply transfer facts", () => {
  const value = evidence(), root = value.rawTrace as any;
  const duplicate = structuredClone(root.calls[0]);
  root.calls.unshift({ ...frame(pool, address(777), "0x11223344", [duplicate]), error: "execution reverted" });
  const result = extract(parity(value));
  assert.equal(result.samples.length, 1);
  assert.deepEqual(result.witnesses[0]!.input.traceAddress, [1]);
});

test("a reverted transaction supplies no successful sample", () => {
  const value = evidence();
  const result = extract({ ...value, receipt: { ...value.receipt, status: 0, logs: [] } });
  assert.equal(result.samples.length, 0);
  assert.deepEqual(result.unresolved, [{ reason: "transaction-reverted" }]);
});

test("repeated transfer tuples remain ambiguous even with a plausible calldata amount", () => {
  const value = evidence();
  const duplicate = { ...(value.receipt.logs[0] as any), logIndex: "0x2" };
  const result = extract({ ...value, receipt: { ...value.receipt, logs: [...value.receipt.logs, duplicate] } });
  assert.equal(result.samples.length, 0);
  assert(result.unresolved.some(row => row.reason === "transfer-evidence-absent-or-ambiguous"));
});

test("a Transfer log without its matching transfer call is not input evidence", () => {
  const value = evidence();
  (value.rawTrace as any).calls.shift();
  const result = extract(value);
  assert.equal(result.samples.length, 0);
  assert(result.unresolved.some(row => row.reason === "prepaid-input-absent-or-ambiguous"));
});

test("multiple invocations at one target cannot be collapsed into a logical pool", () => {
  const first = conversion({ from: address(900), amount: 1001n }), second = conversion({ from: address(900), amount: 2001n, startIndex: 2 });
  const value = { receipt: { ...receipt(), logs: [...first.logs, ...second.logs] }, method: "debug_traceTransaction" as const,
    rawTrace: frame(sender, address(900), "0x11223344", [first.root, second.root]) };
  const result = extract(value, { target: pool });
  assert.equal(result.samples.length, 0);
  assert.equal(result.unresolved.filter(row => row.reason === "target-invoked-multiple-times").length, 2);
});

test("clean direct calls inside a larger transaction are separate; budget overflow never emits a partial subset", () => {
  const first = conversion({ from: address(900), amount: 1001n }), second = conversion({ target: address(201), from: address(900), amount: 2001n, startIndex: 2 });
  const value = { receipt: { ...receipt(), logs: [...first.logs, ...second.logs] }, method: "debug_traceTransaction" as const,
    rawTrace: frame(sender, address(900), "0x11223344", [first.root, second.root]) };
  assert.equal(extract(value).samples.length, 2);
  const result = extract(value, { maxCandidates: 1 });
  assert.equal(result.samples.length, 0);
  assert.equal(result.witnesses.length, 0);
  assert(result.unresolved.some(row => row.reason === "candidate-budget-exceeded"));
});

test("native value, mutable callback, and mixed manager token flows remain unsupported", () => {
  for (const change of [
    (root: any) => { root.value = "0x1"; },
    (root: any) => { root.calls.push(frame(pool, sender, "0x11223344")); },
  ]) {
    const value = evidence(); change(value.rawTrace);
    assert.equal(extract(value, { target: pool }).samples.length, 0);
  }
  const value = evidence(), root = value.rawTrace as any;
  root.calls.push(frame(pool, tokenOut, TOKEN.encodeFunctionData("transfer", [address(888), 10n])));
  const result = extract({ ...value, receipt: { ...value.receipt, logs: [...value.receipt.logs, log(tokenOut, pool, address(888), 10n, 2)] } }, { target: pool });
  assert.equal(result.samples.length, 0);
  assert(result.unresolved.some(row => row.reason === "conversion-token-flow-absent-or-ambiguous"));
});

test("token proxy delegate internals are allowed while action delegate execution is unresolved", () => {
  const value = evidence(), root = value.rawTrace as any;
  root.calls[0].calls = [{ ...frame(tokenIn, address(700), root.calls[0].input), type: "DELEGATECALL" }];
  assert.equal(extract(value).samples.length, 1);
  root.calls.push({ ...frame(pool, address(701), "0x11223344"), type: "DELEGATECALL" });
  assert.equal(extract(value, { target: pool }).samples.length, 0);
});

test("malformed or cross-source evidence throws instead of reporting a supported candidate", () => {
  for (const change of [
    (value: any) => { value.receipt.logs[0].transactionHash = hash(9999); },
    (value: any) => { value.receipt.logs[0].blockHash = hash(9999); },
    (value: any) => { value.receipt.logs[1].logIndex = value.receipt.logs[0].logIndex; },
    (value: any) => { value.rawTrace.error = "reverted"; },
  ]) {
    const value = evidence(); change(value);
    assert.throws(() => extract(value), ObservedCallEvidenceError);
  }
  const value = parity(evidence());
  (value.rawTrace as any[]).splice(1, 1);
  assert.throws(() => extract(value), /incomplete-trace-children/);
  const missing = parity(evidence());
  (missing.rawTrace as any[])[1].traceAddress = [3, 0];
  assert.throws(() => extract(missing), /missing-trace-parent/);
});

test("explicit missing target and transfers involving zero addresses never confer authority", () => {
  assert.equal(extract(evidence(), { target: address(999) }).unresolved[0]!.reason, "target-call-not-observed");
  const value = evidence(), root = value.rawTrace as any;
  root.calls[1].input = TOKEN.encodeFunctionData("transfer", [ZeroAddress, 246913578024691357802468n]);
  const result = extract({ ...value, receipt: { ...value.receipt, logs: [value.receipt.logs[0], log(tokenOut, pool, ZeroAddress, 246913578024691357802468n, 1)] } });
  assert.equal(result.samples.length, 0);
});
