import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ADDR } from "../shared/constants/addresses.js";
import {
  resolveV4PoolKeyViaPositionManager,
  type ParsedV4Initialize,
} from "./build-active-pool-universe.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  type PoolUniverseEntry,
} from "./pool-universe.js";

const DEFAULT_BACKFILL_SCORE = 1;
const POSITION_MANAGER_SOURCE = "v4-positionmanager-poolkeys";

interface MutablePoolUniverseFile extends Record<string, unknown> {
  schemaVersion?: number;
  pools: PoolUniverseEntry[];
}

export interface V4BackfillOptions {
  rpcUrl?: string;
  activePoolsPath?: string;
  positionManagerAddr?: string;
  provider?: ethers.JsonRpcProvider;
}

export interface V4BackfillResult {
  activePoolsPath: string;
  poolId: string;
  added: boolean;
  entry?: PoolUniverseEntry;
}

export async function backfillV4PoolIdIntoActivePools(
  poolId: string,
  opts: V4BackfillOptions = {},
): Promise<V4BackfillResult> {
  const normalizedPoolId = normalizePoolId(poolId);
  const activePoolsPath = opts.activePoolsPath ?? DEFAULT_POOL_UNIVERSE_PATH;
  const file = readPoolUniverseFile(activePoolsPath);
  const existing = file.pools.find((pool) =>
    pool.adapter === "univ4" &&
    typeof pool.poolId === "string" &&
    pool.poolId.toLowerCase() === normalizedPoolId,
  );
  if (existing) {
    return {
      activePoolsPath,
      poolId: normalizedPoolId,
      added: false,
      entry: existing,
    };
  }

  const provider = opts.provider ?? providerFromRpc(opts.rpcUrl);
  const positionManagerAddr = opts.positionManagerAddr ?? ADDR.UNISWAP_V4_POSITION_MANAGER;
  const poolKey = await resolveV4PoolKeyViaPositionManager(
    provider,
    positionManagerAddr,
    normalizedPoolId,
  );
  if (!poolKey) {
    throw new Error(`could not resolve v4 PoolKey for poolId ${normalizedPoolId}`);
  }

  const entry = v4PoolEntryFromResolvedPoolKey(poolKey);
  file.pools.push(entry);
  mkdirSync(dirname(activePoolsPath), { recursive: true });
  writeFileSync(activePoolsPath, JSON.stringify(file, null, 2) + "\n");
  return {
    activePoolsPath,
    poolId: normalizedPoolId,
    added: true,
    entry,
  };
}

export async function backfillV4PoolId(
  poolId: string,
  opts: V4BackfillOptions = {},
): Promise<V4BackfillResult> {
  return backfillV4PoolIdIntoActivePools(poolId, opts);
}

export function v4PoolEntryFromResolvedPoolKey(parsed: ParsedV4Initialize): PoolUniverseEntry {
  const currency0 = normalizeCurrency(parsed.currency0, "currency0");
  const currency1 = normalizeCurrency(parsed.currency1, "currency1");
  const hooks = normalizeCurrency(parsed.hooks, "hooks");
  return {
    address: ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
    adapter: "univ4",
    poolId: normalizePoolId(parsed.poolId),
    currency0,
    currency1,
    fee: parsed.fee,
    tickSpacing: parsed.tickSpacing,
    hooks,
    fixedTokenIn: currency0,
    fixedTokenOut: currency1,
    score: DEFAULT_BACKFILL_SCORE,
    swapCount30d: DEFAULT_BACKFILL_SCORE,
    lastSwapBlock: 0,
    source: parsed.source ?? POSITION_MANAGER_SOURCE,
  };
}

function providerFromRpc(rpcUrl?: string): ethers.JsonRpcProvider {
  const url = rpcUrl ?? process.env.MAINNET_RPC_URL ?? process.env.RPC_URL;
  if (!url) {
    throw new Error("--rpc, MAINNET_RPC_URL, or RPC_URL required for a missing poolId");
  }
  return new ethers.JsonRpcProvider(url);
}

function readPoolUniverseFile(path: string): MutablePoolUniverseFile {
  if (!existsSync(path)) return { schemaVersion: 1, pools: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return { schemaVersion: 1, pools: parsed as PoolUniverseEntry[] };
  if (isRecord(parsed) && Array.isArray(parsed.pools)) {
    return parsed as MutablePoolUniverseFile;
  }
  throw new Error(`active-pools file ${path} must be an array or { pools: [...] }`);
}

function normalizePoolId(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`poolId must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

function normalizeCurrency(value: string, field: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`v4 PoolKey ${field} must be an address or 0x0, got ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args: string[]): {
  poolId: string;
  rpcUrl?: string;
  activePoolsPath?: string;
} {
  let poolId: string | undefined;
  let rpcUrl: string | undefined;
  let activePoolsPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rpc") {
      rpcUrl = args[++i];
      if (!rpcUrl) throw new Error("--rpc requires a URL");
    } else if (arg === "--active-pools") {
      activePoolsPath = args[++i];
      if (!activePoolsPath) throw new Error("--active-pools requires a path");
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("usage: npm run v4-backfill-poolid -- <poolId> [--rpc <url>] [--active-pools <path>]");
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else if (!poolId) {
      poolId = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (!poolId) {
    throw new Error("usage: npm run v4-backfill-poolid -- <poolId> [--rpc <url>] [--active-pools <path>]");
  }
  return { poolId, rpcUrl, activePoolsPath };
}

async function main(): Promise<void> {
  const { poolId, rpcUrl, activePoolsPath } = parseArgs(process.argv.slice(2));
  const result = await backfillV4PoolIdIntoActivePools(poolId, {
    rpcUrl,
    activePoolsPath,
  });
  if (result.added) {
    console.log(`[v4-backfill] added ${result.poolId} to ${result.activePoolsPath}`);
    return;
  }
  console.log(`[v4-backfill] ${result.poolId} already present in ${result.activePoolsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[v4-backfill] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
