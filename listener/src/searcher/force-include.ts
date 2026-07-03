import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";

export const DEFAULT_FORCE_INCLUDE_POOLIDS_PATH = resolve(
  "searcher",
  "pools",
  "force-include-poolids.json",
);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadForceIncludePoolIds(
  path = DEFAULT_FORCE_INCLUDE_POOLIDS_PATH,
): string[] {
  if (!existsSync(path)) return [];

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    console.warn(`[searcher/live] forceInclude file ${path} must be a JSON array; ignoring`);
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const normalized = normalizeForceIncludeEntry(parsed[i]);
    if (!normalized) {
      console.warn(
        `[searcher/live] forceInclude skipped invalid entry ${path}[${i}]: ${String(parsed[i])}`,
      );
      continue;
    }
    appendUnique(out, seen, normalized);
  }
  return out;
}

export function mergeForceIncludePoolIds(
  envEntries: readonly string[],
  fileEntries: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of envEntries) appendUnique(out, seen, entry);
  for (const entry of fileEntries) appendUnique(out, seen, entry);
  return out;
}

export interface AppendForceIncludePoolIdsResult {
  path: string;
  entries: string[];
  added: string[];
}

export function appendForceIncludePoolIds(
  entries: readonly string[],
  path = DEFAULT_FORCE_INCLUDE_POOLIDS_PATH,
): AppendForceIncludePoolIdsResult {
  const out = loadForceIncludePoolIds(path);
  const seen = new Set(out.map((entry) => entry.toLowerCase()));
  const added: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeForceIncludeEntry(entry);
    if (!normalized) {
      throw new Error(`forceInclude entry must be an address or bytes32 poolId: ${entry}`);
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    added.push(normalized);
  }

  if (added.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  }

  return { path, entries: out, added };
}

function normalizeForceIncludeEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (BYTES32_RE.test(trimmed)) return trimmed.toLowerCase();
  if (!ADDRESS_RE.test(trimmed)) return null;
  try {
    return ethers.getAddress(trimmed);
  } catch {
    return null;
  }
}

function appendUnique(out: string[], seen: Set<string>, entry: string): void {
  const normalized = normalizeForceIncludeEntry(entry);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}
