import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolEntry } from "./planner/token-graph.js";
import { isProductionPoolAdapter } from "./venues/pool-adapter-policy.js";

export const DEFAULT_BLOCKSCAN_VIEW_OVERRIDES_PATH = resolve(
  "searcher",
  "pools",
  "blockscan-view-overrides.json",
);

export function loadBlockScanViewOverrides(
  path = DEFAULT_BLOCKSCAN_VIEW_OVERRIDES_PATH,
): PoolEntry[] {
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(`[searcher/live] blockscan-view-overrides file ${path} must be a JSON array; ignoring`);
      return [];
    }
    if (!parsed.every(isPoolEntryLike)) {
      console.warn(`[searcher/live] blockscan-view-overrides file ${path} contains invalid entries; ignoring`);
      return [];
    }
    return parsed;
  } catch {
    console.warn(`[searcher/live] blockscan-view-overrides file ${path} is unreadable or invalid; ignoring`);
    return [];
  }
}

function isPoolEntryLike(value: unknown): value is PoolEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { address?: unknown; adapter?: unknown; fixedSlotKind?: unknown };
  if (typeof entry.address !== "string") return false;
  if (!isProductionPoolAdapter(entry.adapter)) return false;
  if (
    entry.fixedSlotKind !== undefined &&
    entry.fixedSlotKind !== "lend" &&
    entry.fixedSlotKind !== "swap" &&
    entry.fixedSlotKind !== "protocol"
  ) {
    return false;
  }
  return true;
}
