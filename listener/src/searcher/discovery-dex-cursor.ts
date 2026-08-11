import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable DEX graph coverage cursor. Persisted across restarts so a new
 * process can resume the backfill from the last completed block instead of
 * falling back to a deep re-scan of the whole universe window.
 *
 * `sourceCompleteThrough` is meaningless without its canonical block hash:
 * startup must re-verify the hash before trusting the cursor.
 */
export interface DexDiscoveryCursor {
  readonly schemaVersion: 1;
  readonly sourceCompleteThrough: number;
  readonly graphCompleteThrough: number;
  readonly sourceHash: string | null;
  /** Optional applied-cutoff hash: graphCompleteThrough is only trusted when this binds. */
  readonly appliedHash?: string | null;
}

export const DEX_DISCOVERY_CURSOR_SCHEMA_VERSION = 1 as const;

export function discoveryBackfillEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Runtime topology is frozen by default: new pools are only absorbed by the
  // next startup batch. A deployment may explicitly opt back into background
  // backfill with SEARCHER_DISCOVERY_BACKFILL_ENABLED=1.
  return env.SEARCHER_DISCOVERY_BACKFILL_ENABLED === "1";
}

export function discoveryHotDexEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Same freeze policy for per-block hot DEX discovery.
  return env.SEARCHER_DISCOVERY_HOT_DEX_ENABLED === "1";
}

export function resolveInitialDexSourceCompleteThrough(input: {
  readonly universeRegistryMatches: boolean;
  readonly universeToBlock: number | null;
  readonly startupLandedDiscoveryFloor: number;
  readonly discoveryToBlock: number;
  readonly trustedThrough: number;
}): number {
  // The persisted cutoff is the only completeness claim before startup scans
  // the gap. A matching universe is trusted only up to its own toBlock, never
  // silently extended to discoveryToBlock; otherwise a graph-projection
  // failure could advance the cursor past pools that were never applied.
  return input.trustedThrough >= 0 ? input.trustedThrough : -1;
}

export interface StartupDexDiscoveryScan {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly scanBlocksBack: number;
  readonly factoryBlocksBack: number;
  /** True when the scan covers the whole persisted gap, not just a fallback window. */
  readonly fullGap: boolean;
}

export function resolveStartupDexDiscoveryScan(input: {
  readonly sourceCompleteThrough: number;
  readonly discoveryToBlock: number;
  readonly fallbackBlocksBack: number;
  readonly fallbackFactoryBlocksBack: number;
}): StartupDexDiscoveryScan {
  const {
    sourceCompleteThrough,
    discoveryToBlock,
    fallbackBlocksBack,
    fallbackFactoryBlocksBack,
  } = input;
  if (!Number.isSafeInteger(discoveryToBlock) || discoveryToBlock < 0) {
    throw new Error(`invalid startup discovery target ${discoveryToBlock}`);
  }
  const fullGap = sourceCompleteThrough >= 0;
  const rawFromBlock = fullGap
    ? sourceCompleteThrough
    : Math.max(0, discoveryToBlock - fallbackBlocksBack);
  const fromBlock = Math.min(rawFromBlock, discoveryToBlock);
  const scanBlocksBack = Math.max(0, discoveryToBlock - fromBlock);
  const factoryBlocksBack = fullGap
    ? scanBlocksBack
    : Math.max(0, fallbackFactoryBlocksBack);
  return Object.freeze({
    fromBlock,
    toBlock: discoveryToBlock,
    scanBlocksBack,
    factoryBlocksBack,
    fullGap,
  });
}

export function isDexDiscoveryCursor(value: unknown): value is DexDiscoveryCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === DEX_DISCOVERY_CURSOR_SCHEMA_VERSION &&
    Number.isSafeInteger(v.sourceCompleteThrough) &&
    (v.sourceCompleteThrough as number) >= -1 &&
    Number.isSafeInteger(v.graphCompleteThrough) &&
    (v.graphCompleteThrough as number) >= -1 &&
    (v.sourceHash === null || typeof v.sourceHash === "string") &&
    (
      v.appliedHash === undefined ||
      v.appliedHash === null ||
      typeof v.appliedHash === "string"
    );
}

export async function loadDexDiscoveryCursor(
  path: string,
): Promise<DexDiscoveryCursor | null> {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isDexDiscoveryCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveDexDiscoveryCursorAsync(
  path: string,
  cursor: DexDiscoveryCursor,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
