import { prepareAmountQuoteActivity, type PreparedAmountQuoteActivity } from "./amount-quote-continuity.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

interface BlockTouchedLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly blockHash?: string;
  readonly removed?: boolean;
}

export interface BlockTouchedProvider {
  getLogs(filter: {
    readonly fromBlock: number;
    readonly toBlock: number;
  } | { readonly blockHash: string }): Promise<readonly BlockTouchedLog[]>;
  send(method: string, params: Array<unknown>): Promise<unknown>;
}

export interface BlockTouchedCanonicalAnchor {
  readonly hash: string;
  readonly parentHash: string;
  /** Full already-observed header transaction list, in order; never default missing data to []. */
  readonly transactionHashes: readonly string[];
  /** Complete caller-observed non-trace activity (including miner/withdrawals
   * and any protocol-level writes not represented by transaction callTracer).
   * Omission permits pinned refresh, but cannot establish amount-quote carry. */
  readonly passiveTouchedAddresses?: readonly string[];
}

const anchoredActivities = new WeakMap<ReadonlySet<string>, {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly addresses: readonly string[];
}>();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const CALL_TYPES = new Set(["CALL", "CALLCODE", "DELEGATECALL", "STATICCALL", "CREATE", "CREATE2", "SELFDESTRUCT", "SUICIDE"]);
const ADDRESS_TOPIC_RE = /^0x0{24}[0-9a-fA-F]{40}$/;
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Reads one block's log identities and call targets into the single refresh
 * set consumed by block-scan pricing. Logs retain singleton pool identities;
 * callTracer adds contracts reached through top-level or internal calls.
 */
export async function readBlockTouchedStateKeys(
  provider: BlockTouchedProvider,
  blockNumber: number,
  uniswapV4PoolManager: string,
  anchor?: BlockTouchedCanonicalAnchor,
): Promise<ReadonlySet<string>> {
  // Snapshot before either async read; later caller mutation cannot re-anchor it.
  const pinned = anchor === undefined ? undefined : snapshotAnchor(anchor, blockNumber);
  const traceMethod = pinned === undefined ? "debug_traceBlockByNumber" : "debug_traceBlockByHash";
  const [logsResult, tracesResult] = await Promise.allSettled([
    Promise.resolve().then(() => provider.getLogs(pinned === undefined
      ? { fromBlock: blockNumber, toBlock: blockNumber } : { blockHash: pinned.hash })),
    Promise.resolve().then(() => provider.send(traceMethod, [
      pinned === undefined ? `0x${blockNumber.toString(16)}` : pinned.hash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
    ])),
  ]);
  // The pass owns both reads. A failed sibling must not leave activity I/O
  // running after this generation has been settled and its Funding drained.
  if (logsResult.status === "rejected") throw logsResult.reason;
  if (tracesResult.status === "rejected") throw tracesResult.reason;
  const logs = logsResult.value;
  const traces = tracesResult.value;
  const touched = new Set<string>();
  const addresses = pinned === undefined ? undefined : new Set(pinned.passiveTouchedAddresses);
  const manager = uniswapV4PoolManager.toLowerCase();

  if (pinned !== undefined && !Array.isArray(logs)) throw new Error("anchored block logs must be an array");
  for (const log of logs) {
    if (pinned !== undefined) {
      if (!isRecord(log) || !matches(ADDRESS_RE, log.address) || !matches(HASH_RE, log.blockHash) ||
          log.blockHash.toLowerCase() !== pinned.hash || (log.removed !== undefined && log.removed !== false) ||
          !Array.isArray(log.topics) || Array.from(log.topics).some(topic => !matches(HASH_RE, topic))) {
        throw new Error("anchored block contains malformed or mismatched logs");
      }
      // Pool-manager logs also change their emitter; poolIds are not addresses.
      touched.add(log.address.toLowerCase());
    }
    if (log.address.toLowerCase() === manager) {
      const poolId = log.topics[1];
      if (poolId !== undefined) touched.add(poolId.toLowerCase());
    } else {
      touched.add(log.address.toLowerCase());
    }
    // A direct token donation changes a pool's balance headroom without a
    // pool call or Sync. Reuse these already-fetched logs; ERC721 Transfer
    // has four topics and must not be interpreted as an ERC20 balance move.
    if (log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC) {
      for (const topic of [log.topics[1]!, log.topics[2]!]) {
        if (ADDRESS_TOPIC_RE.test(topic)) {
          touched.add(`0x${topic.slice(-40).toLowerCase()}`);
        }
      }
    }
  }

  if (!Array.isArray(traces)) {
    throw new Error(`${traceMethod} must return an array`);
  }
  if (pinned !== undefined && traces.length !== pinned.transactionHashes.length) {
    throw new Error("anchored block trace transaction count mismatch");
  }
  for (const [index, trace] of traces.entries()) {
    if (!isRecord(trace) || !("result" in trace)) {
      throw new Error(`block trace ${index} is missing its callTracer result`);
    }
    if (trace.error !== undefined && trace.error !== null) {
      throw new Error(`block trace ${index} failed`);
    }
    if (pinned !== undefined && (trace.truncated === true || trace.incomplete === true)) {
      throw new Error(`anchored block trace ${index} is incomplete`);
    }
    if (pinned === undefined) {
      addCallTargets(trace.result, touched);
    } else {
      if (!matches(HASH_RE, trace.txHash) || trace.txHash.toLowerCase() !== pinned.transactionHashes[index]) {
        throw new Error(`anchored block trace ${index} transaction hash mismatch`);
      }
      addAnchoredCallAddresses(trace.result, touched);
    }
  }

  if (pinned !== undefined && addresses !== undefined) {
    for (const address of addresses) touched.add(address);
    for (const key of touched) if (ADDRESS_RE.test(key)) addresses.add(key);
    if (pinned.passiveTouchedAddresses !== undefined) {
      anchoredActivities.set(touched, Object.freeze({
        number: blockNumber, hash: pinned.hash, parentHash: pinned.parentHash,
        addresses: Object.freeze([...addresses]),
      }));
    }
  }
  return touched;
}

/** Prepare once per source, outside the quote-row loop. Copies/legacy sets have no proof. */
export function amountQuoteActivityForTouched(
  touched: ReadonlySet<string>, source: CanonicalSource,
): PreparedAmountQuoteActivity | null {
  const anchor = anchoredActivities.get(touched);
  if (anchor === undefined || source === null || source === undefined) return null;
  const snapshot = { number: source.number, hash: source.hash, generation: source.generation };
  if (snapshot.number !== anchor.number || !matches(HASH_RE, snapshot.hash) || snapshot.hash.toLowerCase() !== anchor.hash) return null;
  return prepareAmountQuoteActivity({ source: snapshot, parentHash: anchor.parentHash,
    touchedAddresses: new Set(anchor.addresses), complete: true });
}

function snapshotAnchor(anchor: BlockTouchedCanonicalAnchor, number: number): BlockTouchedCanonicalAnchor {
  if (!isRecord(anchor) || !Number.isSafeInteger(number) || number < 0 ||
      !matches(HASH_RE, anchor.hash) || !matches(HASH_RE, anchor.parentHash) ||
      !Array.isArray(anchor.transactionHashes)) throw new Error("malformed canonical block activity anchor");
  const hashes = new Set<string>();
  for (const hash of anchor.transactionHashes) {
    if (!matches(HASH_RE, hash) || hashes.has(hash.toLowerCase())) throw new Error("malformed or duplicate anchored transaction hash");
    hashes.add(hash.toLowerCase());
  }
  const passive = anchor.passiveTouchedAddresses;
  const passiveSnapshot: string[] = [];
  if (passive !== undefined) {
    if (!Array.isArray(passive)) throw new Error("malformed passive block activity addresses");
    for (const address of passive) {
      if (!matches(ADDRESS_RE, address)) throw new Error("malformed passive block activity addresses");
      passiveSnapshot.push(address.toLowerCase());
    }
  }
  return Object.freeze({ hash: anchor.hash.toLowerCase(), parentHash: anchor.parentHash.toLowerCase(),
    transactionHashes: Object.freeze([...hashes]),
    ...(passive === undefined ? {} : { passiveTouchedAddresses: Object.freeze(passiveSnapshot) }),
  });
}

function addAnchoredCallAddresses(root: unknown, touched: Set<string>): void {
  // Require completed callTracer fields, not a target-only projection. As with
  // getLogs, completeness still relies on the provider honoring the requested
  // full tracer: a silently omitted, otherwise well-formed subtree is not attestable here.
  const pending = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!isRecord(frame) || seen.has(frame) || typeof frame.type !== "string" || !CALL_TYPES.has(frame.type) ||
        !matches(ADDRESS_RE, frame.from) || !matches(QUANTITY_RE, frame.gas) || !matches(QUANTITY_RE, frame.gasUsed) ||
        !matches(BYTES_RE, frame.input) || (frame.output !== undefined && !matches(BYTES_RE, frame.output)) ||
        (frame.value !== undefined && !matches(QUANTITY_RE, frame.value)) ||
        (frame.error !== undefined && (typeof frame.error !== "string" || !frame.error)) ||
        frame.truncated === true || frame.incomplete === true) {
      throw new Error("anchored block trace contains a malformed or incomplete call frame");
    }
    seen.add(frame);
    touched.add(frame.from.toLowerCase());
    if (matches(ADDRESS_RE, frame.to)) {
      // CALL targets, created addresses, and SELFDESTRUCT recipients use `to`.
      touched.add(frame.to.toLowerCase());
    } else if (frame.to !== undefined || (frame.type !== "CREATE" && frame.type !== "CREATE2") || !frame.error) {
      throw new Error("anchored block trace contains a malformed call target");
    }
    if (frame.calls !== undefined) {
      if (!Array.isArray(frame.calls)) throw new Error("anchored block trace contains malformed nested calls");
      for (const child of frame.calls) pending.push(child);
    }
  }
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
}

function addCallTargets(frame: unknown, touched: Set<string>): void {
  if (!isRecord(frame)) {
    throw new Error("block trace contains a malformed call frame");
  }
  if (typeof frame.to === "string" && ADDRESS_RE.test(frame.to)) {
    touched.add(frame.to.toLowerCase());
  } else if (
    frame.to !== undefined ||
    (frame.type !== "CREATE" && frame.type !== "CREATE2")
  ) {
    throw new Error("block trace contains a malformed call target");
  }
  // A failed creation may not have a destination yet, but its nested calls
  // still contribute activity. Malformed responses never prove clean state.
  if (frame.calls === undefined) return;
  if (!Array.isArray(frame.calls)) {
    throw new Error("block trace contains malformed nested calls");
  }
  for (const child of frame.calls) addCallTargets(child, touched);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
