import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcClient } from "../rpc/client.js";
import { mapLimit, uniq } from "../util.js";
import { ADDR, TOPICS, lower } from "./protocols.js";

export interface V4PoolKey {
  currency0: string;
  currency1: string;
}

// Full history: the specific Initialize-topic + poolId query returns 1 log, so
// Alchemy's 10k-block range cap does not bite (it only limits many-result queries).
const V4_POOL_MANAGER_DEPLOY_BLOCK = "0x0";
const DEFAULT_CACHE_PATH = fileURLToPath(new URL("../../outputs/v4-poolkeys.json", import.meta.url));

export async function resolveV4PoolKeys(
  poolIds: string[],
  rpc: RpcClient,
  cachePath = DEFAULT_CACHE_PATH,
): Promise<Map<string, V4PoolKey>> {
  const wanted = uniq(poolIds.map(lower).filter(isBytes32));
  const cache = await readCache(cachePath);
  const missing = wanted.filter((poolId) => !cache.has(poolId));

  const resolved = await mapLimit(missing, 3, async (poolId) => {
    try {
      const logs = await rpc.getLogs({
        address: ADDR.UNIV4_POOL_MANAGER,
        topics: [TOPICS.univ4Initialize, poolId],
        fromBlock: V4_POOL_MANAGER_DEPLOY_BLOCK,
        toBlock: "latest",
      });
      const first = logs[0];
      const currency0 = indexedAddress(first?.topics?.[2]);
      const currency1 = indexedAddress(first?.topics?.[3]);
      if (!currency0 || !currency1) return null;
      return [poolId, { currency0, currency1 }] as const;
    } catch {
      return null;
    }
  });

  let changed = false;
  for (const item of resolved) {
    if (!item) continue;
    cache.set(item[0], item[1]);
    changed = true;
  }
  if (changed) await writeCache(cachePath, cache);

  const out = new Map<string, V4PoolKey>();
  for (const poolId of wanted) {
    const key = cache.get(poolId);
    if (key) out.set(poolId, key);
  }
  return out;
}

async function readCache(path: string): Promise<Map<string, V4PoolKey>> {
  try {
    const raw = await readFile(resolve(path), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const out = new Map<string, V4PoolKey>();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [poolId, value] of Object.entries(parsed)) {
      if (!isBytes32(lower(poolId)) || !value || typeof value !== "object") continue;
      const item = value as Partial<V4PoolKey>;
      if (!isAddress(item.currency0) || !isAddress(item.currency1)) continue;
      out.set(lower(poolId), {
        currency0: lower(item.currency0),
        currency1: lower(item.currency1),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

async function writeCache(path: string, cache: Map<string, V4PoolKey>): Promise<void> {
  const target = resolve(path);
  const obj = Object.fromEntries([...cache.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(obj, null, 2)}\n`);
}

function indexedAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(topic)) return null;
  return lower(`0x${topic.slice(26)}`);
}

function isBytes32(value: string): boolean {
  return /^0x[a-f0-9]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}
