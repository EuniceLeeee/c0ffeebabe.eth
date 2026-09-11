import { isRpcThrottleError } from "./rpc-throttle-guard.js";

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
  /** Caller-observed non-trace activity (including miner/withdrawals
   * and any protocol-level writes not represented by transaction callTracer).
   * Omission contributes no additional passive addresses to the refresh set. */
  readonly passiveTouchedAddresses?: readonly string[];
}

const MAX_ACTIVITY_TRANSITIONS = 256;
interface CompletedBlockActivity {
  readonly anchor: BlockTouchedCanonicalAnchor;
  readonly touchedKeys: readonly string[];
}
// Completed data only, scoped to the existing reader's provider. A cancelled
// range keeps its settled blocks, never promises, failed children or quote authority.
const completedByProvider = new WeakMap<BlockTouchedProvider, {
  readonly poolManager: string;
  readonly blocks: Map<number, CompletedBlockActivity>;
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
 * Reads log identities and call targets into the single refresh set consumed
 * by block-scan pricing. Optional catch-up covers every transition after the
 * previous source, with at most 256 transitions and no partial-range return.
 * Same-height/same-hash is an empty set without I/O; rollback
 * or same-height reorg rejects before I/O. Ordinary one-block calls are unchanged.
 */
export async function readBlockTouchedStateKeys(
  provider: BlockTouchedProvider,
  blockNumber: number,
  uniswapV4PoolManager: string,
  anchor?: BlockTouchedCanonicalAnchor,
  range?: {
    readonly previousSource: { readonly number: number; readonly hash: string };
    readonly readHeader: (number: number) => Promise<BlockTouchedCanonicalAnchor>;
    readonly signal?: AbortSignal;
    readonly deadlineAtMs?: number;
  },
): Promise<ReadonlySet<string>> {
  // Snapshot before either async read; later caller mutation cannot re-anchor it.
  const pinned = anchor === undefined ? undefined : snapshotAnchor(anchor, blockNumber);
  if (range === undefined) return readTouchedBlock(provider, blockNumber, uniswapV4PoolManager, pinned);
  if (pinned === undefined) throw new Error("activity range requires a canonical target anchor");
  if (!isRecord(range)) throw new Error("malformed activity range");
  const { previousSource, readHeader, signal, deadlineAtMs } = range;
  if (!isRecord(previousSource)) throw new Error("malformed activity range");
  const { number: previousNumber, hash: rawPreviousHash } = previousSource;
  if (!Number.isSafeInteger(previousNumber) || previousNumber < 0 ||
      !matches(HASH_RE, rawPreviousHash) || typeof readHeader !== "function" ||
      (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs))) throw new Error("malformed activity range");
  const previousHash = rawPreviousHash.toLowerCase();
  const transitions = blockNumber - previousNumber;
  if (transitions < 0 || transitions > MAX_ACTIVITY_TRANSITIONS) {
    throw new Error("activity range must contain 0..256 forward transitions; full refresh required");
  }
  const assertOpen = (): void => {
    if (signal?.aborted) throw signal.reason ?? new Error("activity range aborted");
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) throw new Error("activity range deadline exceeded");
  };
  assertOpen();
  const touched = new Set<string>();
  if (transitions === 0) {
    if (previousHash !== pinned.hash) throw new Error("same-height activity range source hash mismatch");
    return touched;
  }
  const poolManager = uniswapV4PoolManager.toLowerCase();
  let memo = completedByProvider.get(provider);
  if (memo === undefined || memo.poolManager !== poolManager) {
    // Log-to-state-key interpretation is part of the existing reader input.
    // Changing it cannot borrow a union parsed for a different manager.
    memo = { poolManager, blocks: new Map() };
    completedByProvider.set(provider, memo);
  }
  const completed = memo.blocks;
  const rejectChain = (message: string): never => {
    completed.clear();
    // Retire this table as well: an older pending invocation may settle later,
    // but cannot refill the provider's current memo after invalidation.
    if (completedByProvider.get(provider)?.blocks === completed) completedByProvider.delete(provider);
    throw new Error(message);
  };
  const cachedTarget = completed.get(blockNumber);
  if (cachedTarget !== undefined && !sameAnchor(cachedTarget.anchor, pinned)) {
    rejectChain("cached activity target anchor mismatch");
  }
  const seenHashes = new Set([previousHash]);
  let lastHash = previousHash;
  for (let number = previousNumber + 1; number <= blockNumber; number++) {
    assertOpen();
    let observation = completed.get(number);
    // The caller already supplied the frozen target header. Only missing
    // historical headers belong to this invocation's incremental reads.
    const header = number === blockNumber ? pinned
      : observation?.anchor ?? snapshotAnchor(await readHeader(number), number);
    assertOpen();
    if (header.parentHash !== lastHash || seenHashes.has(header.hash)) {
      rejectChain("activity range canonical hash chain mismatch or duplicate");
    }
    if (observation !== undefined && !sameAnchor(observation.anchor, header)) {
      rejectChain("cached activity block anchor mismatch");
    }
    if (observation === undefined) {
      const blockTouched = await readTouchedBlock(provider, number, uniswapV4PoolManager, header, assertOpen);
      assertOpen();
      observation = Object.freeze({ anchor: header, touchedKeys: Object.freeze([...blockTouched]) });
      const concurrent = completed.get(number);
      if (concurrent !== undefined && !sameAnchor(concurrent.anchor, header)) {
        rejectChain("cached activity concurrent block anchor mismatch");
      }
      completed.set(number, observation);
      while (completed.size > MAX_ACTIVITY_TRANSITIONS) completed.delete(completed.keys().next().value!);
    }
    for (const key of observation.touchedKeys) touched.add(key);
    seenHashes.add(header.hash);
    lastHash = header.hash;
  }
  assertOpen();
  // Only a whole chain reaching the supplied target returns the shared union.
  // Cached blocks cannot silently relabel a fork. Each caller gets a fresh Set.
  return touched;
}

async function readTouchedBlock(
  provider: BlockTouchedProvider,
  blockNumber: number,
  uniswapV4PoolManager: string,
  pinned?: BlockTouchedCanonicalAnchor,
  assertOpen: () => void = () => {},
): Promise<ReadonlySet<string>> {
  const traceMethod = pinned === undefined ? "debug_traceBlockByNumber" : "debug_traceBlockByHash";
  const [logsResult, tracesResult] = await Promise.allSettled([
    Promise.resolve().then(() => {
      assertOpen();
      return provider.getLogs(pinned === undefined
        ? { fromBlock: blockNumber, toBlock: blockNumber } : { blockHash: pinned.hash });
    }),
    Promise.resolve().then(() => {
      assertOpen();
      return provider.send(traceMethod, [
        pinned === undefined ? `0x${blockNumber.toString(16)}` : pinned.hash,
        { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
      ]);
    }),
  ]);
  // The pass owns both reads. A failed sibling must not leave activity I/O
  // running after this generation has been settled and its Funding drained.
  // Preserve transport-fatal evidence even if its sibling or owner concurrently
  // cancelled this range. The shared classifier retains typed-revert exclusions.
  for (const result of [logsResult, tracesResult]) {
    if (result.status === "rejected" && isRpcThrottleError(result.reason)) throw result.reason;
  }
  assertOpen();
  if (logsResult.status === "rejected") throw logsResult.reason;
  if (tracesResult.status === "rejected") throw tracesResult.reason;
  const logs = logsResult.value;
  const traces = tracesResult.value;
  const touched = new Set<string>();
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

  for (const address of pinned?.passiveTouchedAddresses ?? []) touched.add(address);
  return touched;
}

function sameAnchor(left: BlockTouchedCanonicalAnchor, right: BlockTouchedCanonicalAnchor): boolean {
  const passive = (addresses: readonly string[] | undefined) => addresses === undefined
    ? undefined : JSON.stringify([...new Set(addresses)].sort());
  return left.hash === right.hash && left.parentHash === right.parentHash &&
    left.transactionHashes.length === right.transactionHashes.length &&
    left.transactionHashes.every((hash, index) => hash === right.transactionHashes[index]) &&
    passive(left.passiveTouchedAddresses) === passive(right.passiveTouchedAddresses);
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
