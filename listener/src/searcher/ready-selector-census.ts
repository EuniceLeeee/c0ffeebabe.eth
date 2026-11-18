/**
 * Catalog-independent Ready observations, shared by the TS reader and SQL UDF.
 * This file has no RPC, filesystem, VM or Family dependencies. Event/address
 * correlation is deliberately weaker than call attribution or execution proof.
 */
export interface ReadySelectorPoolIdLayout {
  readonly selector: string;
  readonly wordCount: number;
  /** Zero-based ABI word after the selector. A declaration, never an ABI guess. */
  readonly poolIdWord: number;
  readonly namespace: string;
}
export interface ReadySelectorCensusCall {
  readonly id: string;
  readonly kind: "transaction" | "trace";
  readonly traceAddress: readonly number[] | null;
  readonly target: string | null;
  readonly sender: string | null;
  readonly callType: string | null;
  readonly selector: string | null;
  readonly calldata: string | null;
  readonly params: string | null;
  /** Native call value when supplied; no native asset flow is inferred from logs. */
  readonly value: string | null;
  /** Length only; word alignment does not prove a static ABI. */
  readonly wordCount: number | null;
  readonly executionStatus: "success" | "reverted" | "unknown";
  readonly classification: "raw-call" | "flow-correlated";
  readonly status: "unverified";
  readonly flowIndices: readonly number[];
  readonly flowAttribution: "address-correlation-only";
  readonly poolId?: string;
  readonly poolNamespace?: string;
}
export interface ReadySelectorCensusTokenFlow {
  readonly logIndex: number | null;
  readonly standard: "erc20" | "erc721" | "erc1155";
  readonly token: string;
  readonly from: string;
  readonly to: string;
  /** Exact unsigned decimal strings, never a JavaScript floating point amount. */
  readonly amount: string;
  readonly tokenId?: string;
  readonly batchIndex?: number;
  readonly attribution: "transaction-event";
}
export interface ReadySelectorCensusResource {
  readonly address: string;
  readonly roles: readonly ("log-emitter" | "transfer-sender" | "transfer-recipient")[];
  readonly flowIndices: readonly number[];
  readonly logIndices: readonly number[];
  /** No event signature can establish an unknown internal function selector. */
  readonly selector: null;
  readonly status: "unverified";
}
export interface ReadySelectorCensusTransaction {
  readonly format: "ready-selector-census/v1";
  readonly chainId: number | null;
  readonly transactionHash: string | null;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly transactionIndex: number | null;
  readonly receiptStatus: 0 | 1 | null;
  readonly calls: readonly ReadySelectorCensusCall[];
  /** Every supplied receipt log is retained, including unknown and malformed logs. */
  readonly logs: readonly unknown[];
  readonly tokenFlows: readonly ReadySelectorCensusTokenFlow[];
  readonly resources: readonly ReadySelectorCensusResource[];
  readonly coverage: {
    readonly topLevelInput: "transaction" | "trace-root" | "unavailable";
    readonly internalCalls: "observed-traces" | "unobserved";
    /** SQL trace rows alone are not a proof that a provider enumerated all calls. */
    readonly allInternalCallsEnumerated: false;
    readonly suppliedTraceRows: number;
    readonly suppliedLogRows: number;
    readonly issues: readonly string[];
  };
  readonly status: "unverified";
}
export interface ReadySelectorCensusRecord {
  readonly kind: "selector-census";
  readonly key: string;
  readonly block: number | null;
  readonly tx: string | null;
  readonly score: 0;
  readonly fingerprint: string;
  readonly snapshot: ReadySelectorCensusTransaction;
}

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
  ? v as Record<string, unknown> : {};
const stringHex = (v: unknown, pattern: RegExp): string | null => typeof v === "string" && pattern.test(v) ? v.toLowerCase() : null;
function integer(v: unknown): number | null {
  if (typeof v !== "number" && (typeof v !== "string" || !/^(?:\d+|0x[0-9a-f]+)$/i.test(v))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function status(v: unknown): 0 | 1 | null {
  const n = integer(v);
  return n === 0 || n === 1 ? n : null;
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function topicAddress(v: unknown): string | null {
  const hex = stringHex(v, WORD);
  return hex && /^0x0{24}/.test(hex) ? "0x" + hex.slice(-40) : null;
}
/** Portable exact uint256 conversion; BigQuery need not implement BigInt. */
function decimal(hex: string): string {
  let result = "0";
  for (const digit of hex.replace(/^0x/, "")) {
    let carry = parseInt(digit, 16), next = "";
    for (let i = result.length - 1; i >= 0; i--) {
      const value = Number(result[i]) * 16 + carry;
      next = String(value % 10) + next; carry = Math.floor(value / 10);
    }
    while (carry) { next = String(carry % 10) + next; carry = Math.floor(carry / 10); }
    result = next.replace(/^0+(?=\d)/, "");
  }
  return result;
}
function path(v: unknown): number[] | null {
  if (v === "") return [];
  if (typeof v === "string" && /^\d+(?:,\d+)*$/.test(v)) v = v.split(",").map(Number);
  if (!Array.isArray(v) || v.some(n => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) return null;
  return [...v] as number[];
}
function validateLayouts(layouts: readonly ReadySelectorPoolIdLayout[]): void {
  const seen = new Set<string>();
  for (const item of layouts) {
    if (!/^0x[0-9a-f]{8}$/i.test(item.selector) || !Number.isSafeInteger(item.wordCount) || item.wordCount < 1 ||
        !Number.isSafeInteger(item.poolIdWord) || item.poolIdWord < 0 || item.poolIdWord >= item.wordCount ||
        typeof item.namespace !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,127}$/i.test(item.namespace))
      throw new Error("invalid Ready selector poolId layout");
    const key = item.selector.toLowerCase() + ":" + item.wordCount;
    if (seen.has(key)) throw new Error("ambiguous Ready selector poolId layout");
    seen.add(key);
  }
}

export function readySelectorCensusFromTransaction(tx: unknown, options: {
  readonly chainId?: number;
  readonly poolIdLayouts?: readonly ReadySelectorPoolIdLayout[];
} = {}): ReadySelectorCensusTransaction {
  const raw = record(tx), issues = new Set<string>(), layouts = options.poolIdLayouts ?? [];
  validateLayouts(layouts);
  const chainId = integer(options.chainId ?? raw.chain_id ?? raw.chainId);
  const transactionHash = stringHex(raw.tx_hash ?? raw.transactionHash, WORD);
  const blockHash = stringHex(raw.block_hash ?? raw.blockHash, WORD);
  const blockNumber = integer(raw.block_number ?? raw.blockNumber);
  const transactionIndex = integer(raw.transaction_index ?? raw.transactionIndex);
  const receiptStatus = status(raw.receipt_status ?? raw.status);
  if (chainId === null || chainId < 1) issues.add("chain-id-unavailable");
  if (transactionHash === null) issues.add("transaction-hash-unavailable");
  if (blockHash === null) issues.add("block-hash-unavailable");
  if (blockNumber === null) issues.add("block-number-unavailable");
  if (transactionIndex === null) issues.add("transaction-index-unavailable");
  if (receiptStatus === null) issues.add("receipt-status-unavailable");
  const logs = Array.isArray(raw.logs) ? clone(raw.logs) : [];
  if (!Array.isArray(raw.logs)) issues.add("receipt-logs-unavailable");
  const traces = Array.isArray(raw.traces) ? raw.traces : [];
  if (raw.truncated === true || raw.incomplete === true) issues.add("source-explicitly-incomplete");
  if (raw.trace_rows_present === true && !traces.length) issues.add("declared-trace-rows-missing");
  const tokenFlows: ReadySelectorCensusTokenFlow[] = [];
  const seenLogs = new Set<number>();
  for (const value of logs) {
    const log = record(value), logIndex = integer(log.log_index ?? log.logIndex);
    const token = stringHex(log.log_address ?? log.address, ADDRESS);
    const topics = Array.isArray(log.topics) ? log.topics : [], signature = stringHex(topics[0], WORD);
    const data = stringHex(log.data, HEX);
    if (logIndex === null) issues.add("log-index-unavailable");
    else if (seenLogs.has(logIndex)) issues.add("duplicate-log-index");
    else seenLogs.add(logIndex);
    if (!token || data === null || !Array.isArray(log.topics) || topics.some(t => stringHex(t, WORD) === null)) {
      issues.add("malformed-log"); continue;
    }
    if (![TRANSFER, SINGLE, BATCH].includes(signature ?? "")) continue;
    const from = topicAddress(topics[signature === TRANSFER ? 1 : 2]);
    const to = topicAddress(topics[signature === TRANSFER ? 2 : 3]);
    if (!from || !to) { issues.add("malformed-transfer-event"); continue; }
    const push = (standard: ReadySelectorCensusTokenFlow["standard"], amount: string,
      tokenId?: string, batchIndex?: number) => tokenFlows.push({ logIndex, standard, token, from, to, amount,
      ...(tokenId === undefined ? {} : { tokenId }), ...(batchIndex === undefined ? {} : { batchIndex }), attribution: "transaction-event" });
    if (signature === TRANSFER && topics.length === 3 && WORD.test(data)) push("erc20", decimal(data));
    else if (signature === TRANSFER && topics.length === 4 && data === "0x") push("erc721", "1", decimal(topics[3] as string));
    else if (signature === SINGLE && topics.length === 4 && topicAddress(topics[1]) && data.length === 130)
      push("erc1155", decimal(data.slice(66)), decimal(data.slice(2, 66)));
    else if (signature === BATCH && topics.length === 4 && topicAddress(topics[1])) {
      // Validate both arrays fully before emitting any flow. Raw logs always remain.
      const body = data.slice(2), words = body.match(/.{64}/g) ?? [];
      const safeWord = (index: number): number | null => index < words.length ? integer(decimal(words[index]!)) : null;
      const idsOffset = safeWord(0), valuesOffset = safeWord(1);
      const offsetWord = (n: number | null): number | null => n !== null && n >= 64 && n % 32 === 0 ? n / 32 : null;
      const idsAt = offsetWord(idsOffset), valuesAt = offsetWord(valuesOffset);
      const count = idsAt === null ? null : safeWord(idsAt), otherCount = valuesAt === null ? null : safeWord(valuesAt);
      if (body.length % 64 || idsAt === null || valuesAt === null || count === null || count !== otherCount ||
          idsAt + count >= words.length || valuesAt + count >= words.length ||
          !(idsAt + count < valuesAt || valuesAt + count < idsAt)) issues.add("malformed-transfer-event");
      else for (let i = 0; i < count; i++) push("erc1155", decimal(words[valuesAt + 1 + i]!), decimal(words[idsAt + 1 + i]!), i);
    } else issues.add("malformed-transfer-event");
  }
  if (receiptStatus === 0 && logs.length) issues.add("reverted-transaction-has-logs");
  const calls: ReadySelectorCensusCall[] = [];
  function appendCall(value: Record<string, unknown>, kind: ReadySelectorCensusCall["kind"],
    traceAddress: number[] | null, executionStatus: ReadySelectorCensusCall["executionStatus"], id: string): void {
    const rawTarget = value.to_address !== undefined ? value.to_address : value.to;
    const target = stringHex(rawTarget, ADDRESS), sender = stringHex(value.from_address ?? value.from, ADDRESS);
    const calldata = stringHex(value.input ?? value.data, HEX);
    const callType = kind === "transaction" ? (target !== null ? "call" : rawTarget === null ? "create" : null)
      : typeof value.call_type === "string" ? value.call_type.toLowerCase()
      : typeof value.trace_type === "string" ? value.trace_type.toLowerCase() : null;
    const selector = calldata && calldata.length >= 10 && callType !== "create" && callType !== "create2" ? calldata.slice(0, 10) : null;
    const params = selector ? "0x" + calldata!.slice(10) : null;
    const wordCount = params !== null && (params.length - 2) % 64 === 0 ? (params.length - 2) / 64 : null;
    if (calldata === null) issues.add(kind + "-calldata-unavailable");
    if (target === null && rawTarget != null) issues.add(kind + "-target-malformed");
    const nativeValue = typeof value.value === "string" && /^\d+$/.test(value.value) ? value.value.replace(/^0+(?=\d)/, "")
      : typeof value.value === "string" && /^0x[0-9a-f]+$/i.test(value.value) ? decimal(value.value.toLowerCase())
      : typeof value.value === "number" && Number.isSafeInteger(value.value) && value.value >= 0 ? String(value.value) : null;
    const flowIndices = tokenFlows.flatMap((flow, i) => target !== null && (flow.from === target || flow.to === target) ? [i] : []);
    const layout = layouts.find(item => item.selector.toLowerCase() === selector && item.wordCount === wordCount);
    calls.push({ id, kind, traceAddress, target, sender,
      callType, selector, calldata, params, value: nativeValue, wordCount, executionStatus, classification: flowIndices.length ? "flow-correlated" : "raw-call",
      status: "unverified", flowIndices, flowAttribution: "address-correlation-only",
      ...(layout ? { poolId: "0x" + params!.slice(2 + layout.poolIdWord * 64, 2 + (layout.poolIdWord + 1) * 64),
        poolNamespace: layout.namespace } : {}) });
  }
  let topLevelInput: ReadySelectorCensusTransaction["coverage"]["topLevelInput"] = "unavailable";
  if (stringHex(raw.input ?? raw.data, HEX) !== null) {
    topLevelInput = "transaction";
    appendCall(raw, "transaction", [], receiptStatus === 1 ? "success" : receiptStatus === 0 ? "reverted" : "unknown", "transaction");
  }
  const frames = traces.map((value, index) => ({ value: record(value), index, traceAddress: path(record(value).trace_address ?? record(value).traceAddress) }));
  const byPath = new Map<string, typeof frames>();
  for (const frame of frames) {
    if (frame.traceAddress === null) { issues.add("malformed-trace-path"); continue; }
    const key = frame.traceAddress.join(","), list = byPath.get(key) ?? []; list.push(frame); byPath.set(key, list);
  }
  if (traces.length && byPath.get("")?.length !== 1) issues.add("trace-root-missing-or-duplicate");
  for (const frame of frames) {
    const { value, traceAddress, index } = frame;
    if (value.incomplete === true || value.truncated === true) issues.add("trace-explicitly-incomplete");
    if (traceAddress !== null && (byPath.get(traceAddress.join(","))?.length ?? 0) > 1) issues.add("duplicate-trace-path");
    let executionStatus: ReadySelectorCensusCall["executionStatus"] = receiptStatus === 0 || status(value.status) === 0 || value.error
      ? "reverted" : receiptStatus === 1 && status(value.status) === 1 ? "success" : "unknown";
    if (traceAddress === null) executionStatus = executionStatus === "reverted" ? "reverted" : "unknown";
    else for (let length = 0; length < traceAddress.length; length++) {
      const ancestors = byPath.get(traceAddress.slice(0, length).join(","));
      if (ancestors?.length !== 1) { issues.add("trace-ancestor-missing-or-duplicate"); executionStatus = executionStatus === "reverted" ? "reverted" : "unknown"; }
      else if (status(ancestors[0]!.value.status) === 0 || ancestors[0]!.value.error) executionStatus = "reverted";
      else if (status(ancestors[0]!.value.status) !== 1 && executionStatus === "success") executionStatus = "unknown";
    }
    if (traceAddress?.length === 0 && topLevelInput === "unavailable" && stringHex(value.input, HEX) !== null) topLevelInput = "trace-root";
    // Retain both a supplied transaction and root frame; identities reveal their relationship.
    appendCall(value, "trace", traceAddress, executionStatus, "trace:" + index + ":" + (traceAddress?.join(",") ?? "?"));
  }
  if (topLevelInput === "unavailable") issues.add("top-level-input-unavailable");
  const resources = new Map<string, { address: string; roles: Set<ReadySelectorCensusResource["roles"][number]>; flowIndices: Set<number>; logIndices: Set<number> }>();
  const resource = (address: string) => {
    let item = resources.get(address);
    if (!item) { item = { address, roles: new Set(), flowIndices: new Set(), logIndices: new Set() }; resources.set(address, item); }
    return item;
  };
  for (const value of logs) {
    const log = record(value), address = stringHex(log.log_address ?? log.address, ADDRESS), index = integer(log.log_index ?? log.logIndex);
    if (address) { const item = resource(address); item.roles.add("log-emitter"); if (index !== null) item.logIndices.add(index); }
  }
  tokenFlows.forEach((flow, index) => {
    for (const [address, role] of [[flow.from, "transfer-sender"], [flow.to, "transfer-recipient"]] as const) {
      const item = resource(address); item.roles.add(role); item.flowIndices.add(index); if (flow.logIndex !== null) item.logIndices.add(flow.logIndex);
    }
  });
  return freeze({ format: "ready-selector-census/v1", chainId: chainId !== null && chainId > 0 ? chainId : null,
    transactionHash, blockNumber, blockHash, transactionIndex, receiptStatus, calls, logs, tokenFlows,
    resources: [...resources.values()].sort((a, b) => a.address.localeCompare(b.address)).map(item => ({ address: item.address,
      roles: [...item.roles].sort(), flowIndices: [...item.flowIndices].sort((a, b) => a - b), logIndices: [...item.logIndices].sort((a, b) => a - b),
      selector: null, status: "unverified" })),
    coverage: { topLevelInput, internalCalls: traces.length ? "observed-traces" : "unobserved", allInternalCallsEnumerated: false,
      suppliedTraceRows: traces.length, suppliedLogRows: logs.length, issues: [...issues].sort() }, status: "unverified" });
}
