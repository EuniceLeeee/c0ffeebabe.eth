import { Interface, ZeroAddress } from "ethers";
import type { ReadyTransactionEvidence } from "./ready-transaction-input.js";
import type { ObservedCallSample } from "./venues/observed-call-template.js";

// ERC20 transport is the only ABI understood here. Action selectors and pool
// identities are deliberately not classified by this evidence collector.
const TOKEN = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address to,uint256 amount)",
  "function transferFrom(address from,address to,uint256 amount)",
  "function approve(address spender,uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const TRANSFER_TOPIC = TOKEN.getEvent("Transfer")!.topicHash.toLowerCase();
const TRANSPORT_SELECTORS = new Set(["transfer", "transferFrom", "approve", "balanceOf", "allowance", "totalSupply", "decimals"]
  .map(name => TOKEN.getFunction(name)!.selector));
const MAX_FRAMES = 20_000, MAX_LOGS = 20_000, MAX_DEPTH = 32, MAX_ACTIONS = 256;
const MAX_CALLDATA_BYTES = 128 * 1024;

export class ObservedCallEvidenceError extends Error {
  constructor(readonly reason: string) {
    super(`observed call evidence: ${reason}`);
    this.name = "ObservedCallEvidenceError";
  }
}
export interface ObservedCallUnresolved {
  readonly reason: string;
  readonly target?: string;
  readonly traceAddress?: readonly number[];
  readonly detail?: string;
}
export interface ObservedCallTransferWitness {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly logIndex: number;
  readonly traceAddress: readonly number[];
  /** Absent for the original transfer-call witness shape. A direct mint binds
   * its receipt log to the uniquely executing token/action frame; it must not
   * pretend that an ERC20 transfer function was called. */
  readonly origin?: "transfer-call" | "direct-mint-log";
}
export interface ObservedCallExtraction {
  readonly samples: readonly ObservedCallSample[];
  readonly unresolved: readonly ObservedCallUnresolved[];
  /** Asset candidates for later balance protection, not a complete asset proof. */
  readonly observedTokens: readonly string[];
  readonly witnesses: readonly {
    readonly sampleIndex: number;
    readonly input: ObservedCallTransferWitness;
    readonly output: ObservedCallTransferWitness;
  }[];
}
interface Frame {
  readonly path: readonly number[];
  readonly type: string;
  readonly from: string;
  readonly to?: string;
  readonly input: string;
  readonly value: bigint;
  readonly error: boolean;
  failed: boolean;
  readonly subtraces: number;
}
interface Transfer {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly logIndex: number;
}
interface TransferCall extends Omit<Transfer, "logIndex"> {
  readonly frame: Frame;
  readonly operation: "transfer" | "transferFrom";
}
type ProvedTransfer = TransferCall & { readonly log: Transfer };

function invalid(reason: string): never { throw new ObservedCallEvidenceError(reason); }
function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`invalid-${label}`);
  return value as Record<string, any>;
}
function address(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(`invalid-${label}`);
  return value.toLowerCase();
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(`invalid-${label}`);
  return value.toLowerCase();
}
function natural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`invalid-${label}`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return natural(Number(BigInt(value)), label);
  return natural(value, label);
}
function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) invalid(`invalid-${label}`);
  return BigInt(value);
}
function bytes(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || value.length > 2 + MAX_CALLDATA_BYTES * 2)
    invalid(`invalid-${label}`);
  return value.toLowerCase();
}
const key = (path: readonly number[]) => path.join(".");
const inside = (child: readonly number[], parent: readonly number[]) => child.length >= parent.length && parent.every((part, i) => child[i] === part);
const before = (left: readonly number[], right: readonly number[]) => {
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! < right[i]!;
  return left.length < right.length;
};
const tuple = (value: Omit<Transfer, "logIndex">) => `${value.token}:${value.from}:${value.to}:${value.amount}`;

function receiptTransfers(evidence: ReadyTransactionEvidence): readonly Transfer[] {
  const receipt = evidence.receipt;
  hash(receipt.transactionHash, "transaction-hash"); hash(receipt.blockHash, "block-hash");
  natural(receipt.blockNumber, "block-number"); natural(receipt.transactionIndex, "transaction-index");
  if (receipt.status !== 0 && receipt.status !== 1) invalid("invalid-receipt-status");
  if (!Array.isArray(receipt.logs) || receipt.logs.length > MAX_LOGS) invalid("receipt-log-budget-exceeded");
  if (receipt.status === 0 && receipt.logs.length) invalid("reverted-receipt-has-logs");
  const indices = new Set<number>(), transfers: Transfer[] = [];
  for (const raw of receipt.logs) {
    const log = record(raw, "receipt-log"), token = address(log.address, "log-address");
    const index = number(log.logIndex, "log-index");
    if (indices.has(index)) invalid("duplicate-log-index");
    indices.add(index);
    if (hash(log.transactionHash, "log-transaction-hash") !== receipt.transactionHash.toLowerCase() ||
        hash(log.blockHash, "log-block-hash") !== receipt.blockHash.toLowerCase() ||
        number(log.blockNumber, "log-block-number") !== receipt.blockNumber ||
        number(log.transactionIndex, "log-transaction-index") !== receipt.transactionIndex || log.removed === true)
      invalid("log-source-mismatch");
    const data = bytes(log.data, "log-data");
    if (!Array.isArray(log.topics)) invalid("invalid-log-topics");
    const topics = log.topics.map((topic: unknown) => hash(topic, "log-topic"));
    // ERC721 shares this event signature but has a fourth indexed topic.
    if (topics[0] !== TRANSFER_TOPIC || topics.length !== 3) continue;
    if (data.length !== 66 || !topics.slice(1).every(topic => /^0x0{24}[0-9a-f]{40}$/.test(topic)))
      invalid("malformed-erc20-transfer");
    const decoded = TOKEN.decodeEventLog("Transfer", data, topics);
    transfers.push(Object.freeze({ token, from: String(decoded[0]).toLowerCase(), to: String(decoded[1]).toLowerCase(),
      amount: decoded[2].toString(), logIndex: index }));
  }
  return Object.freeze(transfers);
}

function successfulFrames(evidence: ReadyTransactionEvidence): readonly Frame[] {
  const frames = new Map<string, Frame>(), receipt = evidence.receipt;
  function add(rawValue: unknown, pathValue: unknown, debug: boolean): void {
    const raw = record(rawValue, "trace-frame");
    if (!Array.isArray(pathValue) || pathValue.length > MAX_DEPTH) invalid("invalid-trace-path");
    const path = pathValue.map(part => natural(part, "trace-path-part"));
    if (frames.size >= MAX_FRAMES) invalid("trace-frame-budget-exceeded");
    if (frames.has(key(path))) invalid("duplicate-trace-path");
    for (const [name, expected] of [["transactionHash", receipt.transactionHash], ["blockHash", receipt.blockHash]] as const)
      if (raw[name] !== undefined && hash(raw[name], `trace-${name}`) !== expected.toLowerCase()) invalid("trace-source-mismatch");
    if (raw.blockNumber !== undefined && number(raw.blockNumber, "trace-block-number") !== receipt.blockNumber ||
        raw.transactionPosition !== undefined && number(raw.transactionPosition, "trace-transaction-index") !== receipt.transactionIndex)
      invalid("trace-source-mismatch");
    const action = debug ? raw : record(raw.action, "trace-action");
    const type = String(debug ? raw.type : raw.type === "call" ? action.callType : raw.type).toLowerCase();
    if (!["call", "staticcall", "delegatecall", "callcode", "create", "create2", "selfdestruct", "suicide"].includes(type)) invalid("unsupported-trace-frame-type");
    if (raw.error != null && (typeof raw.error !== "string" || !raw.error.length)) invalid("invalid-trace-error");
    const error = typeof raw.error === "string";
    const selfdestruct = type === "selfdestruct" || type === "suicide";
    const from = address(selfdestruct && !debug ? action.address : action.from, "trace-from");
    const target = selfdestruct && !debug ? action.refundAddress : action.to ?? (!debug ? raw.result?.address : undefined);
    const to = target == null && error && (type === "create" || type === "create2") ? undefined : address(target, "trace-to");
    const input = selfdestruct ? "0x" : bytes(debug ? raw.input : type === "create" ? action.init : action.input, "trace-input");
    const value = quantity((selfdestruct && !debug ? action.balance : action.value) ?? "0x0", "trace-value");
    if (debug) {
      if (raw.output !== undefined) bytes(raw.output, "trace-output");
      if (raw.calls !== undefined && !Array.isArray(raw.calls)) invalid("invalid-trace-children");
    } else if (!error && ["call", "staticcall", "delegatecall", "callcode"].includes(type)) {
      bytes(record(raw.result, "trace-result").output, "trace-output");
    }
    frames.set(key(path), { path: Object.freeze(path), type, from, to, input, value, error, failed: error,
      subtraces: debug ? (raw.calls?.length ?? 0) : natural(raw.subtraces, "subtrace-count") });
  }
  if (evidence.method === "trace_transaction") {
    if (!Array.isArray(evidence.rawTrace) || evidence.rawTrace.length > MAX_FRAMES) invalid("invalid-transaction-trace");
    for (const raw of evidence.rawTrace) add(raw, record(raw, "trace-frame").traceAddress, false);
  } else if (evidence.method === "debug_traceTransaction") {
    const pending: { raw: unknown; path: number[] }[] = [{ raw: evidence.rawTrace, path: [] }];
    const seen = new Set<object>();
    while (pending.length) {
      const { raw, path } = pending.pop()!;
      const row = record(raw, "trace-frame");
      if (seen.has(row)) invalid("cyclic-or-reused-trace-frame");
      seen.add(row); add(row, path, true);
      for (let i = (row.calls?.length ?? 0) - 1; i >= 0; i--) pending.push({ raw: row.calls[i], path: [...path, i] });
    }
  } else invalid("unsupported-trace-method");
  if (!frames.has("") || frames.get("")!.type !== "call") invalid("missing-call-root");
  const children = new Map<string, number[]>();
  for (const frame of frames.values()) {
    if (!frame.path.length) continue;
    const parent = key(frame.path.slice(0, -1));
    if (!frames.has(parent)) invalid("missing-trace-parent");
    const indices = children.get(parent) ?? [];
    indices.push(frame.path.at(-1)!); children.set(parent, indices);
  }
  for (const frame of frames.values()) {
    const indices = (children.get(key(frame.path)) ?? []).sort((a, b) => a - b);
    if (indices.length !== frame.subtraces || indices.some((value, index) => value !== index)) invalid("incomplete-trace-children");
  }
  for (const frame of [...frames.values()].sort((a, b) => a.path.length - b.path.length)) {
    if (frame.path.length && frames.get(key(frame.path.slice(0, -1)))!.failed) frame.failed = true;
  }
  if (frames.get("")!.failed && receipt.status === 1) invalid("receipt-trace-status-mismatch");
  return Object.freeze([...frames.values()]);
}

/** Nominate bounded direct conversions from *unfiltered* successful TX frames.
 * Malformed/incomplete evidence throws; valid unsupported structures are kept
 * as unresolved. No returned sample grants identity, route, or Ready authority.
 * ABI inference and current-state execution probes are separate later steps. */
export function extractObservedCallSamples(input: {
  readonly evidence: ReadyTransactionEvidence;
  readonly chainId: number;
  readonly target?: string;
  readonly maxCandidates?: number;
}): ObservedCallExtraction {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) invalid("invalid-chain-id");
  const maximum = input.maxCandidates ?? 32;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) invalid("invalid-candidate-budget");
  const target = input.target === undefined ? undefined : address(input.target, "selected-target");
  if (target === ZeroAddress) invalid("zero-selected-target");
  const transfers = receiptTransfers(input.evidence), observedTokens = Object.freeze([...new Set(transfers.map(t => t.token))].sort());
  const samples: ObservedCallSample[] = [], unresolved: ObservedCallUnresolved[] = [], witnesses: ObservedCallExtraction["witnesses"][number][] = [];
  const result = (): ObservedCallExtraction => Object.freeze({ samples: Object.freeze(samples), unresolved: Object.freeze(unresolved),
    observedTokens, witnesses: Object.freeze(witnesses) });
  if (input.evidence.receipt.status === 0) {
    unresolved.push(Object.freeze({ reason: "transaction-reverted" })); return result();
  }
  const allFrames = successfulFrames(input.evidence), frames = allFrames.filter(frame => !frame.failed);
  const assets = new Set(observedTokens), calls: TransferCall[] = [];
  for (const frame of frames) {
    if (frame.type !== "call" || !frame.to || !assets.has(frame.to)) continue;
    let decoded;
    try { decoded = TOKEN.parseTransaction({ data: frame.input }); } catch { continue; }
    if (!decoded || decoded.name !== "transfer" && decoded.name !== "transferFrom") continue;
    const pull = decoded.name === "transferFrom";
    calls.push({ token: frame.to, from: pull ? String(decoded.args[0]).toLowerCase() : frame.from,
      to: String(decoded.args[pull ? 1 : 0]).toLowerCase(), amount: decoded.args[pull ? 2 : 1].toString(),
      operation: decoded.name, frame });
  }
  const logTuples = new Map<string, Transfer[]>(), callTuples = new Map<string, TransferCall[]>();
  for (const transfer of transfers) { const k = tuple(transfer), list = logTuples.get(k) ?? []; list.push(transfer); logTuples.set(k, list); }
  for (const call of calls) { const k = tuple(call), list = callTuples.get(k) ?? []; list.push(call); callTuples.set(k, list); }
  const proved: ProvedTransfer[] = calls.flatMap(call => {
    const logs = logTuples.get(tuple(call));
    return logs?.length === 1 && callTuples.get(tuple(call))!.length === 1 ? [{ ...call, log: logs[0]! }] : [];
  });
  const transport = (frame: Frame) => !!frame.to && assets.has(frame.to) && TRANSPORT_SELECTORS.has(frame.input.slice(0, 10));
  const ancestorPaths = new Set<string>(), transferEndpoints = new Set<string>();
  for (const call of calls) for (let depth = 0; depth < call.frame.path.length; depth++) ancestorPaths.add(key(call.frame.path.slice(0, depth)));
  for (const transfer of transfers) { transferEndpoints.add(transfer.from); transferEndpoints.add(transfer.to); }
  const actions = frames.filter(frame => frame.type === "call" && frame.to && !transport(frame) &&
    (target === undefined ? ancestorPaths.has(key(frame.path)) || transferEndpoints.has(frame.to)
      : frame.to === target));
  if (actions.length > MAX_ACTIONS) {
    unresolved.push(Object.freeze({ reason: "action-candidate-budget-exceeded", detail: `${actions.length} action frames exceed ${MAX_ACTIONS}; select a target` }));
    return result();
  }
  if (target && !actions.length) unresolved.push(Object.freeze({ target, reason: allFrames.some(f => f.to === target && f.failed)
    ? "target-call-reverted" : "target-call-not-observed" }));
  const witness = (transfer: ProvedTransfer): ObservedCallTransferWitness => Object.freeze({ token: transfer.token,
    from: transfer.from, to: transfer.to, amount: transfer.amount, logIndex: transfer.log.logIndex, traceAddress: transfer.frame.path });
  for (const action of actions) {
    const reject = (reason: string, detail?: string) => unresolved.push(Object.freeze({ target: action.to!, traceAddress: action.path, reason,
      ...(detail === undefined ? {} : { detail }) }));
    const subtree = frames.filter(frame => inside(frame.path, action.path));
    if (subtree.some(frame => frame.value !== 0n)) { reject("native-value-not-supported"); continue; }
    if (action.input.length < 10) { reject("action-calldata-missing"); continue; }
    if (frames.filter(frame => frame.type === "call" && frame.to === action.to && !transport(frame)).length !== 1) {
      reject("target-invoked-multiple-times"); continue;
    }
    const nestedCalls = calls.filter(call => call.amount !== "0" && inside(call.frame.path, action.path));
    const nested = proved.filter(call => call.amount !== "0" && inside(call.frame.path, action.path));
    if (nested.length !== nestedCalls.length) { reject("transfer-evidence-absent-or-ambiguous"); continue; }
    // Allow token proxy internals; any other mutable descendant needs a richer
    // recipe (router, callback, batching, create, or delegate execution).
    const transferFrames = calls.filter(call => inside(call.frame.path, action.path)).map(call => call.frame);
    const complex = subtree.some(frame => frame !== action && frame.type !== "staticcall" && !transferFrames.includes(frame) &&
      !(frame.type === "delegatecall" && transferFrames.some(parent => inside(frame.path, parent.path))));
    if (complex) { reject("nested-execution-or-callback-not-supported"); continue; }
    const incoming = nested.filter(call => call.operation === "transferFrom" && call.from === action.from && call.to === action.to && call.frame.from === action.to);
    const outgoing = nested.filter(call => call.from === action.to && call.to !== action.to && call.to !== ZeroAddress);
    const targetMints = transfers.filter(transfer => transfer.token === action.to && transfer.from === ZeroAddress);
    if (incoming.length > 1 || outgoing.length + targetMints.length !== 1) {
      reject("conversion-token-flow-absent-or-ambiguous"); continue;
    }
    const directMint = targetMints[0];
    if (directMint) {
      // With receipt-only logs, a mint can be attributed without guessing only
      // when the issuing token IS the action target and that address has one
      // successful non-static invocation in the entire transaction. Count even
      // ERC20 transport calls: they could emit another log at this address.
      if (frames.filter(frame => frame.to === action.to && frame.type !== "staticcall").length !== 1) {
        reject("direct-mint-target-invoked-multiple-times"); continue;
      }
      // No fee mint, burn, second output, self transfer or zero-amount companion
      // event can borrow the sole action's attribution. This remains evidence
      // of an observed mint, not proof of its economic or debt semantics.
      if (directMint.amount === "0" || directMint.to === ZeroAddress || directMint.to === action.to ||
          transfers.filter(transfer => transfer.token === action.to).length !== 1) {
        reject("direct-mint-extra-or-invalid-token-flow"); continue;
      }
    }
    let paid = incoming[0];
    let payment: ObservedCallSample["payment"];
    if (paid) payment = Object.freeze({ kind: "approval", spender: paid.frame.from });
    else {
      const prepaid = proved.filter(call => call.amount !== "0" && call.to === action.to &&
        (call.from === action.from || call.frame.from === action.from) && before(call.frame.path, action.path) &&
        key(call.frame.path.slice(0, -1)) === key(action.path.slice(0, -1)));
      if (prepaid.length !== 1) { reject("prepaid-input-absent-or-ambiguous"); continue; }
      paid = prepaid[0]!; payment = Object.freeze({ kind: "prepaid" });
    }
    const received = directMint ?? outgoing[0]!.log;
    const expectedNestedTransfers = (payment.kind === "approval" ? 1 : 0) + (directMint ? 0 : 1);
    if (nested.length !== expectedNestedTransfers || paid.log.logIndex === received.logIndex) { reject("additional-token-flow-not-supported"); continue; }
    if (paid.token === received.token) { reject("same-input-output-token"); continue; }
    if ([action.to, paid.token, received.token].includes(action.from) || [action.to, paid.token, received.token].includes(received.to)) {
      reject("actor-overlaps-target-or-asset"); continue;
    }
    if (transfers.some(t => t.amount !== "0" && (t.from === action.to || t.to === action.to) &&
        t.logIndex !== paid.log.logIndex && t.logIndex !== received.logIndex)) { reject("unattributed-target-token-flow"); continue; }
    const receipt = input.evidence.receipt;
    samples.push(Object.freeze({ target: action.to!, calldata: action.input, sender: action.from, recipient: received.to,
      tokenIn: paid.token, tokenOut: received.token, amountIn: paid.amount, amountOut: received.amount,
      source: Object.freeze({ chainId: input.chainId, number: receipt.blockNumber, hash: receipt.blockHash.toLowerCase(),
        transactionHash: receipt.transactionHash.toLowerCase(), traceAddress: action.path }), payment }));
    const outputWitness: ObservedCallTransferWitness = directMint
      ? Object.freeze({ ...directMint, traceAddress: action.path, origin: "direct-mint-log" as const })
      : witness(outgoing[0]!);
    witnesses.push(Object.freeze({ sampleIndex: samples.length - 1, input: witness(paid), output: outputWitness }));
    if (samples.length > maximum) {
      samples.length = 0; witnesses.length = 0;
      unresolved.push(Object.freeze({ reason: "candidate-budget-exceeded", detail: `more than ${maximum} direct conversions; no partial selection issued` }));
      return result();
    }
  }
  if (!samples.length && !unresolved.length) unresolved.push(Object.freeze({ reason: "no-direct-erc20-conversion-observed" }));
  return result();
}
