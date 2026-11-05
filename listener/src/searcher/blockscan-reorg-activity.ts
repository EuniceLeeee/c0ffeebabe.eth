import { BlockActivityRangeInvalidatedError, MAX_ACTIVITY_TRANSITIONS, type BlockTouchedCanonicalAnchor } from "./blockscan-touched-state.js";

export interface ReorgActivitySource {
  readonly number: number;
  readonly hash: string;
}

export interface ReorgActivityHeader extends ReorgActivitySource, BlockTouchedCanonicalAnchor {}

export interface ReorgActivityControl {
  readonly signal?: AbortSignal;
  readonly deadlineAtMs: number;
}

export interface VerifiedReorgActivity {
  readonly previousSource: ReorgActivitySource;
  readonly target: ReorgActivityHeader;
  readonly commonAncestor: ReorgActivityHeader;
  readonly oldDepth: number;
  /** Old branch is tip first; new branch is ancestor first (exclusive). */
  readonly oldBranch: readonly ReorgActivityHeader[];
  readonly newBranch: readonly ReorgActivityHeader[];
  readonly touchedStateKeys: ReadonlySet<string>;
}

const verified = new WeakMap<object, () => Promise<void>>();
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

function invalid(message: string): never {
  throw new BlockActivityRangeInvalidatedError(`reorg activity: ${message}`);
}

function source(value: ReorgActivitySource): ReorgActivitySource {
  if (!Number.isSafeInteger(value.number) || value.number < 0 || !HASH.test(value.hash)) invalid("invalid source identity");
  return Object.freeze({ number: value.number, hash: value.hash.toLowerCase() });
}

function header(value: ReorgActivityHeader | null | undefined): ReorgActivityHeader {
  if (!value) invalid("missing branch header");
  const identity = source(value);
  if (!HASH.test(value.parentHash) || !Array.isArray(value.transactionHashes) ||
      value.transactionHashes.some(hash => typeof hash !== "string" || !HASH.test(hash)) ||
      new Set(value.transactionHashes.map(hash => hash.toLowerCase())).size !== value.transactionHashes.length) {
    invalid("invalid header transaction coverage");
  }
  if (!Array.isArray(value.passiveTouchedAddresses) ||
      value.passiveTouchedAddresses.some(address => typeof address !== "string" || !ADDRESS.test(address))) {
    invalid("missing or invalid passive activity coverage");
  }
  return Object.freeze({ ...identity, parentHash: value.parentHash.toLowerCase(),
    transactionHashes: Object.freeze(value.transactionHashes.map(hash => hash.toLowerCase())),
    passiveTouchedAddresses: Object.freeze(value.passiveTouchedAddresses.map(address => address.toLowerCase())),
  });
}

function immutableKeys(keys: Set<string>): ReadonlySet<string> {
  // Never expose the backing Set, including as forEach's third argument.
  const view: ReadonlySet<string> = Object.freeze({
    size: keys.size,
    has: (key: string) => keys.has(key),
    keys: () => keys.keys(),
    values: () => keys.values(),
    entries: () => keys.entries(),
    [Symbol.iterator]: () => keys[Symbol.iterator](),
    forEach: (callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) => {
      keys.forEach(key => callback.call(thisArg, key, key, view));
    },
  });
  return view;
}

export function isVerifiedReorgActivity(value: unknown): value is VerifiedReorgActivity {
  return typeof value === "object" && value !== null && verified.has(value);
}

/** Recheck immediately before publication: canonicality may change during pricing. */
export async function revalidateReorgActivityTarget(proof: VerifiedReorgActivity): Promise<void> {
  if (!isVerifiedReorgActivity(proof)) invalid("unverified proof");
  await verified.get(proof)!();
}

/** Collect activity, not protocol state. Readers must use the existing anchored
 * classifier for each branch, including orphan blocks by hash. A failure yields
 * no proof, never an empty/partial dirty set or permission for a full warm. */
export async function collectReorgActivity(input: {
  readonly previousSource: ReorgActivitySource;
  readonly target: ReorgActivityHeader;
  readonly readCanonicalHeader: (number: number) => Promise<ReorgActivityHeader | null | undefined>;
  readonly readHeaderByHash: (hash: string) => Promise<ReorgActivityHeader | null | undefined>;
  readonly readTouched: (number: number, anchor: ReorgActivityHeader, control: ReorgActivityControl) => Promise<ReadonlySet<string>>;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs: number;
  readonly maxDepth?: number;
  readonly maxCatchupBlocks?: number;
}): Promise<VerifiedReorgActivity> {
  const { readCanonicalHeader, readHeaderByHash, readTouched } = input;
  const previousSource = source(input.previousSource);
  const target = header(input.target);
  const maxDepth = input.maxDepth ?? 8;
  const maxCatchupBlocks = input.maxCatchupBlocks ?? MAX_ACTIVITY_TRANSITIONS;
  const control = Object.freeze({ signal: input.signal, deadlineAtMs: input.deadlineAtMs });
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || !Number.isSafeInteger(maxCatchupBlocks) || maxCatchupBlocks < 1 ||
      !Number.isFinite(control.deadlineAtMs)) invalid("invalid recovery bounds");
  if (target.number <= previousSource.number) invalid("target must advance previous source");
  const check = () => {
    control.signal?.throwIfAborted();
    if (Date.now() >= control.deadlineAtMs) invalid("deadline exceeded");
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BlockActivityRangeInvalidatedError("reorg activity: deadline exceeded")),
          Math.min(2_147_483_647, Math.max(1, control.deadlineAtMs - Date.now())));
        abort = () => reject(control.signal?.reason ?? new Error("reorg activity aborted"));
        control.signal?.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([operation(), cancellation]);
      check();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) control.signal?.removeEventListener("abort", abort);
    }
  };
  const canonical = async (number: number) => {
    const result = header(await read(() => readCanonicalHeader(number)));
    if (result.number !== number) invalid("canonical header height mismatch");
    return result;
  };
  const oldBranch: ReorgActivityHeader[] = [];
  let cursor = header(await read(() => readHeaderByHash(previousSource.hash)));
  if (cursor.number !== previousSource.number || cursor.hash !== previousSource.hash) invalid("old tip identity mismatch");
  let commonAncestor: ReorgActivityHeader;
  while (true) {
    const current = await canonical(cursor.number);
    if (current.hash === cursor.hash) {
      commonAncestor = current;
      break;
    }
    if (oldBranch.length >= maxDepth || cursor.number === 0) invalid("common ancestor exceeds recovery depth");
    oldBranch.push(cursor);
    const parent = header(await read(() => readHeaderByHash(cursor.parentHash)));
    if (parent.hash !== cursor.parentHash || parent.number !== cursor.number - 1) invalid("old branch parent mismatch");
    cursor = parent;
  }
  // The retired branch may have won back canonicality before recovery starts.
  // In that case the retained tip is the ancestor; verify the full forward
  // range normally, rather than leaving recovery permanently armed.
  if (target.number - commonAncestor.number > maxCatchupBlocks) invalid("new branch exceeds recovery bound");
  const newBranch: ReorgActivityHeader[] = [];
  let parent = commonAncestor;
  for (let number = commonAncestor.number + 1; number <= target.number; number++) {
    const next = await canonical(number);
    if (next.parentHash !== parent.hash) invalid("new branch parent mismatch");
    if (number === target.number && next.hash !== target.hash) invalid("target changed during recovery");
    newBranch.push(next);
    parent = next;
  }
  const touched = new Set<string>();
  for (const block of [...oldBranch, ...newBranch]) {
    for (const key of await read(() => readTouched(block.number, block, control))) {
      if (typeof key !== "string" || key.length === 0) invalid("invalid touched state key");
      touched.add(key.toLowerCase());
    }
    check();
  }
  const revalidate = async () => {
    const current = await canonical(target.number);
    if (current.hash !== target.hash) invalid("target changed during recovery");
  };
  await revalidate();
  const proof = Object.freeze({ previousSource, target: newBranch[newBranch.length - 1]!, commonAncestor,
    oldDepth: oldBranch.length, oldBranch: Object.freeze(oldBranch), newBranch: Object.freeze(newBranch),
    touchedStateKeys: immutableKeys(touched),
  });
  verified.set(proof, revalidate);
  return proof;
}
