import { BlockActivityRangeInvalidatedError, MAX_ACTIVITY_TRANSITIONS } from "./blockscan-touched-state.js";

export type StartupCatchupSource = "bigquery" | "rpc";

export function startupCatchupSource(value: string | undefined): StartupCatchupSource {
  if (value === undefined || value === "bigquery") return "bigquery";
  if (value === "rpc") return "rpc";
  throw new Error("startup catchup source must be bigquery or rpc");
}

export interface ActivityRangeControl {
  readonly previousSource: { readonly number: number; readonly hash: string };
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

/** Index lag is a transport boundary, not evidence that the suffix is clean.
 * Collect both sources before returning to the single production price pass. */
export async function collectIndexedStartupActivity<Header extends { readonly number: number; readonly hash: string }>(input: {
  readonly target: Header;
  readonly range: ActivityRangeControl;
  readonly readHeader: (number: number) => Promise<Header>;
  readonly readRange: (number: number, header: Header, range: ActivityRangeControl) => Promise<ReadonlySet<string>>;
  readonly readCutoff: (first: Header, target: Header) => Promise<number | null>;
  readonly readIndexed: (first: Header, target: Header) => Promise<ReadonlySet<string>>;
  readonly onCoverage?: (sqlThrough: number) => void;
}): Promise<ReadonlySet<string>> {
  const { target, range } = input;
  const check = () => {
    range.signal?.throwIfAborted();
    if (range.deadlineAtMs !== undefined && Date.now() >= range.deadlineAtMs) throw new Error("startup activity deadline exceeded");
  };
  check();
  const first = await input.readHeader(range.previousSource.number + 1);
  check();
  if (first.number !== range.previousSource.number + 1 || first.number > target.number) throw new Error("invalid indexed activity interval");
  const cutoff = await input.readCutoff(first, target);
  check();
  if (cutoff !== null && (!Number.isSafeInteger(cutoff) || cutoff < first.number || cutoff > target.number)) {
    throw new Error("index cutoff outside fixed activity interval");
  }
  let previousSource = range.previousSource;
  const touched = new Set<string>();
  if (cutoff !== null) {
    const indexedTarget = cutoff === target.number ? target : await input.readHeader(cutoff);
    check();
    if (indexedTarget.number !== cutoff) throw new Error("indexed activity header height mismatch");
    for (const key of await input.readIndexed(first, indexedTarget)) touched.add(key.toLowerCase());
    check();
    previousSource = { number: cutoff, hash: indexedTarget.hash };
  }
  input.onCoverage?.(previousSource.number);
  if (previousSource.number < target.number) {
    for (const key of await collectStartupActivity({ ...input, range: { ...range, previousSource } })) touched.add(key);
  }
  check();
  return touched;
}

/** 256 is an I/O bound, not a pricing interval. Do not expose a partial union
 * or advance the published source between chunks. The ordinary reader owns
 * coverage and parent-chain verification inside each chunk. */
export async function collectStartupActivity<Header extends { readonly number: number; readonly hash: string }>(input: {
  readonly target: Header;
  readonly range: ActivityRangeControl;
  readonly readHeader: (number: number) => Promise<Header>;
  readonly readRange: (number: number, header: Header, range: ActivityRangeControl) => Promise<ReadonlySet<string>>;
}): Promise<ReadonlySet<string>> {
  const { target, range } = input;
  const check = () => {
    range.signal?.throwIfAborted();
    if (range.deadlineAtMs !== undefined && Date.now() >= range.deadlineAtMs) throw new Error("startup activity deadline exceeded");
  };
  if (!Number.isSafeInteger(target.number) || !Number.isSafeInteger(range.previousSource.number) ||
      range.previousSource.number < 0 || target.number < range.previousSource.number ||
      !/^0x[0-9a-f]{64}$/i.test(target.hash) || !/^0x[0-9a-f]{64}$/i.test(range.previousSource.hash)) {
    throw new Error("invalid startup activity interval");
  }
  check();
  if (target.number === range.previousSource.number && target.hash.toLowerCase() !== range.previousSource.hash.toLowerCase()) {
    throw new BlockActivityRangeInvalidatedError("startup activity same-height source mismatch");
  }
  const touched = new Set<string>();
  let previousSource = { ...range.previousSource };
  while (previousSource.number < target.number) {
    check();
    const number = Math.min(target.number, previousSource.number + MAX_ACTIVITY_TRANSITIONS);
    const header = number === target.number ? target : await input.readHeader(number);
    check();
    if (header.number !== number) throw new Error("startup activity chunk header height mismatch");
    const keys = await input.readRange(number, header, { ...range, previousSource });
    check();
    for (const key of keys) touched.add(key.toLowerCase());
    previousSource = { number, hash: header.hash };
  }
  check();
  return touched;
}
