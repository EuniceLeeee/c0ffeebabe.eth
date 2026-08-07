import { existsSync, readFileSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import type {
  BlockSource,
  StateReadProvenance,
} from "./venues/blockscan-state-capability.js";

/**
 * Resumable warm cache for block-scan state.
 *
 * The cold-start warm must read every state key once; on a large graph that
 * costs minutes and can exceed both the pass deadline and the V8 heap on the
 * way (whole-family atomic reads hold every descriptor + result at once).
 * Persisting each resolved state key's raw reads as it completes turns the
 * warm into a resumable lane: a crashed/aborted warm keeps everything already
 * written, and a restart re-decodes those keys from cache instead of re-reading
 * them from RPC. The file is append-only JSONL (one key per line); a restart
 * compacts it when stale superseded lines dominate.
 *
 * Only raw, source-pinned read results are cached — never decoded family
 * snapshots — so the cache stays protocol-agnostic and reuses the family's
 * registered decode path on hydration.
 */
export const BLOCKSCAN_STATE_CACHE_SCHEMA_VERSION = 2;

export interface CachedBlockScanStateRead {
  readonly localId: string;
  readonly data: string;
  readonly provenance: StateReadProvenance;
}

export interface CachedBlockScanStateKey {
  readonly schemaVersion: typeof BLOCKSCAN_STATE_CACHE_SCHEMA_VERSION;
  readonly familyId: string;
  readonly stateKey: string;
  readonly source: BlockSource;
  /** Sorted adapter-local read ids; every id has exactly one entry in reads. */
  readonly requiredReadKeys: readonly string[];
  readonly reads: readonly CachedBlockScanStateRead[];
  /** Coordinator-computed schemaInputFingerprint at save time ("" for legacy). */
  readonly specFingerprint: string;
  /** CompiledStateInstance.instanceFingerprint at save time ("" for legacy). */
  readonly instanceFingerprint: string;
  /** Adapter-owned snapshot compatibility fingerprint at save time. */
  readonly snapshotCompatibilityFingerprint: string;
  readonly savedAtMs: number;
}

export interface LoadedBlockScanStateCache {
  readonly entries: ReadonlyMap<string, CachedBlockScanStateKey>;
  readonly lineCount: number;
}

const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;

function isValidProvenance(
  provenance: unknown,
): provenance is StateReadProvenance {
  if (typeof provenance !== "object" || provenance === null) return false;
  const value = provenance as {
    kind?: unknown;
    source?: unknown;
    requireCanonical?: unknown;
    forkId?: unknown;
  };
  if (value.kind !== "eip1898" && value.kind !== "immutable-fork") {
    return false;
  }
  if (!isValidBlockSource(value.source)) return false;
  if (value.kind === "eip1898") {
    return value.requireCanonical === true;
  }
  return typeof value.forkId === "string" && value.forkId.length > 0;
}

function isValidBlockSource(source: unknown): source is BlockSource {
  if (typeof source !== "object" || source === null) return false;
  const value = source as {
    number?: unknown;
    hash?: unknown;
    generation?: unknown;
  };
  return (
    typeof value.number === "number" &&
    Number.isSafeInteger(value.number) &&
    value.number >= 0 &&
    typeof value.hash === "string" &&
    BLOCK_HASH_RE.test(value.hash) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0
  );
}

export function isValidCachedBlockScanStateKey(
  value: unknown,
): value is CachedBlockScanStateKey {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CachedBlockScanStateKey>;
  if (entry.schemaVersion !== BLOCKSCAN_STATE_CACHE_SCHEMA_VERSION) {
    return false;
  }
  if (typeof entry.familyId !== "string" || entry.familyId.length === 0) {
    return false;
  }
  if (typeof entry.stateKey !== "string" || entry.stateKey.length === 0) {
    return false;
  }
  if (!isValidBlockSource(entry.source)) return false;
  if (
    !Array.isArray(entry.requiredReadKeys) ||
    entry.requiredReadKeys.length === 0 ||
    entry.requiredReadKeys.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) ||
    new Set(entry.requiredReadKeys).size !== entry.requiredReadKeys.length
  ) {
    return false;
  }
  if (!Array.isArray(entry.reads) || entry.reads.length === 0) {
    return false;
  }
  if (
    typeof entry.specFingerprint !== "string" ||
    typeof entry.instanceFingerprint !== "string" ||
    typeof entry.snapshotCompatibilityFingerprint !== "string"
  ) {
    return false;
  }
  const readByLocalId = new Map<string, CachedBlockScanStateRead>();
  for (const read of entry.reads) {
    if (
      typeof read !== "object" ||
      read === null ||
      typeof read.localId !== "string" ||
      read.localId.length === 0 ||
      typeof read.data !== "string" ||
      read.data.length === 0 ||
      !isValidProvenance(read.provenance) ||
      readByLocalId.has(read.localId)
    ) {
      return false;
    }
    readByLocalId.set(read.localId, read);
  }
  if (!entry.requiredReadKeys.every((id) => readByLocalId.has(id))) {
    return false;
  }
  // Every cached result must be pinned to the entry's own source block.
  for (const read of entry.reads) {
    const provenanceSource = read.provenance.source;
    if (
      provenanceSource.number !== entry.source.number ||
      provenanceSource.hash !== entry.source.hash
    ) {
      return false;
    }
  }
  return (
    typeof entry.savedAtMs === "number" &&
    Number.isFinite(entry.savedAtMs) &&
    entry.savedAtMs > 0
  );
}

export function loadBlockScanStateCache(
  path: string,
): LoadedBlockScanStateCache {
  if (!existsSync(path)) {
    return { entries: new Map(), lineCount: 0 };
  }
  let lineCount = 0;
  const entries = new Map<string, CachedBlockScanStateKey>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries, lineCount };
  }
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    lineCount++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isValidCachedBlockScanStateKey(parsed)) continue;
    entries.set(parsed.stateKey, parsed);
  }
  return { entries, lineCount };
}

export async function appendBlockScanStateCache(
  path: string,
  entry: CachedBlockScanStateKey,
): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function compactBlockScanStateCache(
  path: string,
  entries: ReadonlyMap<string, CachedBlockScanStateKey>,
): Promise<void> {
  const lines: string[] = [];
  for (const entry of entries.values()) {
    lines.push(JSON.stringify(entry));
  }
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${lines.join("\n")}\n`, "utf8");
  await rename(tmpPath, path);
}
