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
}

export const DEX_DISCOVERY_CURSOR_SCHEMA_VERSION = 1 as const;

export function discoveryBackfillEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SEARCHER_DISCOVERY_BACKFILL_ENABLED !== "0";
}

export function discoveryHotDexEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SEARCHER_DISCOVERY_HOT_DEX_ENABLED !== "0";
}

export function resolveInitialDexSourceCompleteThrough(input: {
  readonly universeRegistryMatches: boolean;
  readonly universeToBlock: number | null;
  readonly startupLandedDiscoveryFloor: number;
  readonly discoveryToBlock: number;
  readonly trustedThrough: number;
}): number {
  const {
    universeRegistryMatches,
    universeToBlock,
    startupLandedDiscoveryFloor,
    discoveryToBlock,
    trustedThrough,
  } = input;
  if (
    universeRegistryMatches &&
    universeToBlock !== null &&
    universeToBlock >= startupLandedDiscoveryFloor - 1
  ) {
    return discoveryToBlock;
  }
  return trustedThrough >= 0 ? trustedThrough : -1;
}

export function isDexDiscoveryCursor(value: unknown): value is DexDiscoveryCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === DEX_DISCOVERY_CURSOR_SCHEMA_VERSION &&
    Number.isSafeInteger(v.sourceCompleteThrough) &&
    (v.sourceCompleteThrough as number) >= -1 &&
    Number.isSafeInteger(v.graphCompleteThrough) &&
    (v.graphCompleteThrough as number) >= -1 &&
    (v.sourceHash === null || typeof v.sourceHash === "string");
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
