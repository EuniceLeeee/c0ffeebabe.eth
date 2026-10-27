import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

/** Sparse discovery coverage, never a claim of scanning the enclosing range. */
export interface TransactionObservationScope {
  readonly kind: "transaction-set";
  readonly selectionHash: string;
  readonly transactionCount: number;
}
export interface ReadyTransactionEntry {
  readonly transactionHash: string;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly transactionIndex?: number;
}
export interface ReadyTransactionSelection {
  readonly entries: readonly ReadyTransactionEntry[];
  readonly scope: TransactionObservationScope;
}
const hash32 = /^0x[0-9a-fA-F]{64}$/;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function assertTransactionObservationScope(value: TransactionObservationScope | undefined): void {
  if (value !== undefined && (value === null || value.kind !== "transaction-set" ||
    !/^[0-9a-f]{64}$/.test(value.selectionHash) || !Number.isSafeInteger(value.transactionCount) || value.transactionCount < 1)) {
    throw new Error("invalid Ready transaction observation scope");
  }
}

/** CSV is input data only. Preserve optional block hints for RPC cross-checks. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const finishField = () => { row.push(field.trim()); field = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"') {
      if (field.length || closed) throw new Error("invalid transaction CSV quote");
      quoted = true;
    } else if (ch === ',') finishField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishField();
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else {
      if (closed && ch.trim()) throw new Error("invalid transaction CSV field");
      field += ch;
    }
  }
  if (quoted) throw new Error("unterminated transaction CSV field");
  finishField();
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

export function parseReadyTransactionInput(text: string): ReadyTransactionSelection {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("Ready transaction input is empty");
  const header = rows[0]!.map(value => value.toLowerCase());
  const isCsv = header.includes("transaction_hash");
  if (!isCsv && rows.some(row => row.length !== 1)) throw new Error("transaction CSV requires transaction_hash column");
  if (isCsv && new Set(header).size !== header.length) throw new Error("duplicate transaction CSV columns");
  const entries = new Map<string, ReadyTransactionEntry>();
  const number = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid transaction CSV numeric hint");
    return Number(value);
  };
  for (const row of isCsv ? rows.slice(1) : rows) {
    if (isCsv && row.length !== header.length) throw new Error("transaction CSV column count mismatch");
    const field = (key: string): string | undefined => row[header.indexOf(key)];
    const transactionHash = (isCsv ? field("transaction_hash") : row[0])?.toLowerCase();
    if (!transactionHash || !hash32.test(transactionHash)) throw new Error("invalid transaction hash in Ready input");
    const blockNumber = isCsv ? number(field("block_number")) : undefined;
    const transactionIndex = isCsv ? number(field("transaction_index")) : undefined;
    const blockHash = isCsv ? field("block_hash")?.toLowerCase() || undefined : undefined;
    if (blockHash !== undefined && !hash32.test(blockHash)) throw new Error("invalid block hash in transaction CSV");
    const entry: ReadyTransactionEntry = { transactionHash,
      ...(blockNumber === undefined ? {} : { blockNumber }),
      ...(blockHash === undefined ? {} : { blockHash }),
      ...(transactionIndex === undefined ? {} : { transactionIndex }) };
    const old = entries.get(transactionHash);
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) throw new Error("conflicting duplicate transaction hints: " + transactionHash);
    entries.set(transactionHash, Object.freeze(entry));
  }
  if (!entries.size) throw new Error("Ready transaction input is empty");
  const ordered = Object.freeze([...entries.values()].sort((a, b) => a.transactionHash.localeCompare(b.transactionHash)));
  return Object.freeze({ entries: ordered, scope: Object.freeze({ kind: "transaction-set" as const,
    selectionHash: digest("ready-transaction-input/v1:" + JSON.stringify(ordered)), transactionCount: ordered.length }) });
}

export interface ReadyTransactionReceipt {
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionIndex: number;
  readonly status: 0 | 1;
  readonly logs: readonly unknown[];
}
export type TransactionTraceMethod = "trace_transaction" | "debug_traceTransaction";
export interface ReadyTransactionEvidence {
  readonly receipt: ReadyTransactionReceipt;
  readonly method: TransactionTraceMethod;
  readonly rawTrace: unknown;
}
type Send = (method: string, params: readonly unknown[]) => Promise<unknown>;
const zip = promisify(gzip), unzip = promisify(gunzip);
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function rpcNumber(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("invalid transaction receipt quantity");
  }
  return Number(value);
}
function receiptFromRpc(raw: unknown, entry: ReadyTransactionEntry): ReadyTransactionReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("missing transaction receipt: " + entry.transactionHash);
  const r = raw as Record<string, unknown>;
  const blockNumber = rpcNumber(r.blockNumber), transactionIndex = rpcNumber(r.transactionIndex), status = rpcNumber(r.status);
  if (String(r.transactionHash).toLowerCase() !== entry.transactionHash || !hash32.test(String(r.blockHash)) ||
    (status !== 0 && status !== 1) || !Array.isArray(r.logs)) throw new Error("invalid transaction receipt: " + entry.transactionHash);
  const blockHash = String(r.blockHash).toLowerCase();
  if ((entry.blockNumber !== undefined && entry.blockNumber !== blockNumber) ||
    (entry.blockHash !== undefined && entry.blockHash !== blockHash) ||
    (entry.transactionIndex !== undefined && entry.transactionIndex !== transactionIndex)) {
    throw new Error("transaction receipt disagrees with input hints: " + entry.transactionHash);
  }
  if (status === 0 && r.logs.length !== 0) throw new Error("reverted receipt unexpectedly contains logs");
  const indices = new Set<number>();
  for (const value of r.logs) {
    const log = value as Record<string, unknown> | null;
    if (!log || String(log.transactionHash).toLowerCase() !== entry.transactionHash ||
      String(log.blockHash).toLowerCase() !== blockHash || rpcNumber(log.blockNumber) !== blockNumber ||
      rpcNumber(log.transactionIndex) !== transactionIndex || log.removed === true ||
      !/^0x[0-9a-f]{40}$/i.test(String(log.address)) || !/^0x(?:[0-9a-f]{2})*$/i.test(String(log.data)) ||
      !Array.isArray(log.topics) || log.topics.some(topic => !hash32.test(String(topic)))) {
      throw new Error("receipt log escaped selected transaction or has malformed fields");
    }
    const index = rpcNumber(log.logIndex);
    if (indices.has(index)) throw new Error("duplicate receipt log index");
    indices.add(index);
  }
  return Object.freeze({ transactionHash: entry.transactionHash, blockNumber, blockHash, transactionIndex, status, logs: r.logs });
}

/** Input transport/cache only. Classification, dedupe, strict and Graph stay in Ready. */
export class ReadyTransactionReader {
  readonly #input: { selection: ReadyTransactionSelection; cacheDir: string; send: Send; traceSend: Send;
    concurrency: number; attempts: number; log?: (message: string) => void };
  readonly #receipts = new Map<string, ReadyTransactionReceipt>();
  #prepared: Promise<{ fromBlock: number; toBlock: number }> | undefined;
  #method: TransactionTraceMethod | undefined;
  constructor(input: ReadyTransactionReader["options"]) {
    assertTransactionObservationScope(input.selection.scope);
    if (input.selection.scope.transactionCount !== input.selection.entries.length ||
      input.selection.scope.selectionHash !== digest("ready-transaction-input/v1:" + JSON.stringify(input.selection.entries)) ||
      input.selection.entries.some((entry, index, entries) => !/^0x[0-9a-f]{64}$/.test(entry.transactionHash) ||
        (index > 0 && entries[index - 1]!.transactionHash >= entry.transactionHash))) {
      throw new Error("Ready transaction selection fingerprint mismatch");
    }
    if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || !Number.isSafeInteger(input.attempts) || input.attempts < 1) {
      throw new Error("invalid transaction scan worker bounds");
    }
    this.#input = input;
  }
  // Public structural options type avoids coupling this transport to ethers or Families.
  declare readonly options: { selection: ReadyTransactionSelection; cacheDir: string; send: Send; traceSend: Send;
    concurrency: number; attempts: number; log?: (message: string) => void };
  async #readCache(key: string): Promise<unknown | null> {
    let bytes: Buffer;
    try { bytes = await readFile(join(this.#input.cacheDir, key + ".json.gz")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const envelope = JSON.parse((await unzip(bytes, { maxOutputLength: MAX_ENTRY_BYTES })).toString("utf8"));
    if (envelope?.format !== "ready-transaction-evidence/v1" || envelope.key !== key ||
      envelope.hash !== digest(JSON.stringify(envelope.value))) throw new Error("corrupt Ready transaction cache: " + key);
    return envelope.value;
  }
  async #writeCache(key: string, value: unknown): Promise<void> {
    const data = JSON.stringify({ format: "ready-transaction-evidence/v1", key, hash: digest(JSON.stringify(value)), value });
    if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) throw new Error("Ready transaction evidence exceeds entry limit");
    await mkdir(this.#input.cacheDir, { recursive: true });
    const path = join(this.#input.cacheDir, key + ".json.gz"), tmp = path + "." + randomUUID() + ".tmp";
    await writeFile(tmp, await zip(data), { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  }
  async #request(send: Send, method: string, params: readonly unknown[]): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try { return await send(method, params); }
      catch (error) {
        if (unsupportedTraceMethod(error) || attempt === this.#input.attempts) throw error;
        this.#input.log?.(`retry method=${method} attempt=${attempt + 1}/${this.#input.attempts}`);
        await new Promise<void>(resolve => setTimeout(resolve, attempt * 250));
      }
    }
  }
  prepare(): Promise<{ fromBlock: number; toBlock: number }> {
    return this.#prepared ??= this.#prepare();
  }
  async #prepare(): Promise<{ fromBlock: number; toBlock: number }> {
    if (await this.#request(this.#input.send, "eth_chainId", []) !== "0x1") throw new Error("Ready TX input requires Ethereum mainnet");
    const entries = this.#input.selection.entries;
    let fromBlock = Number.MAX_SAFE_INTEGER, toBlock = 0;
    const blockHashes = new Map<number, string>();
    for (let start = 0; start < entries.length; start += this.#input.concurrency) {
      const results = await Promise.allSettled(entries.slice(start, start + this.#input.concurrency).map(async entry => {
        const key = "receipt-" + entry.transactionHash;
        const cached = await this.#readCache(key);
        const raw = cached ?? await this.#request(this.#input.send, "eth_getTransactionReceipt", [entry.transactionHash]);
        const receipt = receiptFromRpc(raw, entry);
        if (cached === null) await this.#writeCache(key, raw);
        return receipt;
      }));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        const receipt = result.value, prior = blockHashes.get(receipt.blockNumber);
        if (prior !== undefined && prior !== receipt.blockHash) throw new Error("selected transaction receipts disagree on block hash");
        blockHashes.set(receipt.blockNumber, receipt.blockHash);
        this.#receipts.set(receipt.transactionHash, receipt);
        fromBlock = Math.min(fromBlock, receipt.blockNumber); toBlock = Math.max(toBlock, receipt.blockNumber);
      }
      this.#input.log?.(`receipts=${Math.min(start + this.#input.concurrency, entries.length)}/${entries.length}`);
    }
    await this.#writeCache("selection-" + this.#input.selection.scope.selectionHash, this.#input.selection);
    this.#input.log?.(`receipt input complete transactions=${entries.length} blocks=${blockHashes.size} bounds=${fromBlock}-${toBlock}`);
    return { fromBlock, toBlock };
  }
  async #assertFixedCutoff(cutoff: { readonly number: number; readonly hash: string }): Promise<void> {
    const range = await this.prepare();
    const blocks = [...new Map([...this.#receipts.values()].map(receipt => [receipt.blockNumber, receipt.blockHash]))];
    if (cutoff.number !== range.toBlock || !blocks.some(([number, hash]) => number === cutoff.number && hash === cutoff.hash.toLowerCase())) {
      throw new Error("selected transaction evidence differs from frozen Ready cutoff hash");
    }
    // Validate selected headers AFTER the runner freezes its source. The last
    // selected block anchors their shared canonical ancestry; the runner's final
    // canonical fence then guards promotion, including a reorg during tracing.
    for (let start = 0; start < blocks.length; start += this.#input.concurrency) {
      const results = await Promise.allSettled(blocks.slice(start, start + this.#input.concurrency).map(async ([number, hash]) => {
        const block = await this.#request(this.#input.send, "eth_getBlockByNumber", ["0x" + number.toString(16), false]) as Record<string, unknown> | null;
        if (!block || rpcNumber(block.number) !== number || String(block.hash).toLowerCase() !== hash) {
          throw new Error("selected transaction block is no longer canonical: " + number);
        }
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  }
  async #trace(receipt: ReadyTransactionReceipt): Promise<ReadyTransactionEvidence> {
    const key = "trace-" + receipt.transactionHash + "-" + receipt.blockHash;
    const cached = await this.#readCache(key) as { method: TransactionTraceMethod; rawTrace: unknown } | null;
    if (cached !== null) {
      if (!["trace_transaction", "debug_traceTransaction"].includes(cached.method) || cached.rawTrace == null) throw new Error("invalid transaction trace cache");
      return { receipt, ...cached };
    }
    let method = this.#method ?? "trace_transaction", rawTrace: unknown;
    try { rawTrace = await this.#request(this.#input.traceSend, method, [receipt.transactionHash, ...(method === "debug_traceTransaction" ? [{ tracer: "callTracer" }] : [])]); }
    catch (error) {
      if (method !== "trace_transaction" || !unsupportedTraceMethod(error)) throw error;
      method = "debug_traceTransaction";
      rawTrace = await this.#request(this.#input.traceSend, method, [receipt.transactionHash, { tracer: "callTracer" }]);
    }
    if (rawTrace == null) throw new Error("missing selected transaction trace");
    this.#method = method;
    // The production decoder validates the full schema before this is admitted.
    return { receipt, method, rawTrace };
  }
  async scan(cutoff: { readonly number: number; readonly hash: string }, consume: (evidence: ReadyTransactionEvidence) => Promise<void>): Promise<{ successful: number; reverted: number; evidenceHash: string }> {
    await this.#assertFixedCutoff(cutoff);
    let successful = 0, reverted = 0;
    const digestInput = createHash("sha256");
    const receipts = [...this.#receipts.values()];
    for (let start = 0; start < receipts.length; start += this.#input.concurrency) {
      const results = await Promise.allSettled(receipts.slice(start, start + this.#input.concurrency).map(async receipt => {
        const evidence = await this.#trace(receipt);
        await consume(evidence);
        await this.#writeCache("trace-" + receipt.transactionHash + "-" + receipt.blockHash,
          { method: evidence.method, rawTrace: evidence.rawTrace });
        return evidence;
      }));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        digestInput.update(JSON.stringify(result.value)).update("\0");
        if (result.value.receipt.status === 1) successful++; else reverted++;
      }
      this.#input.log?.(`traces=${Math.min(start + this.#input.concurrency, receipts.length)}/${receipts.length} onchainSuccess=${successful} onchainReverted=${reverted}`);
    }
    return { successful, reverted, evidenceHash: digestInput.digest("hex") };
  }
}

function unsupportedTraceMethod(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown }; info?: { error?: { code?: unknown; message?: unknown } } };
  const nested = e.error ?? e.info?.error;
  return e.code === -32601 || nested?.code === -32601 || e.code === "UNSUPPORTED_OPERATION" ||
    /method (?:not found|not supported|is not available|not available)|unsupported method/i.test(String(nested?.message ?? e.message));
}
