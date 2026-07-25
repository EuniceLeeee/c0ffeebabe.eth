import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { UNIV2_SWAP_TOPIC } from "./venues/landed-event-registry.js";
import { findVenueByFactory } from "./venues/capability.js";
import {
  V2_LINEAGES,
  V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION,
  TRUSTED_V2_LINEAGES,
  type V2LineageDescriptor,
  type V2LineageSnapshot,
  type V2LineageSnapshotRecord,
} from "./venues/v2-lineage.js";

const DEFAULT_LOOKBACK_BLOCKS = 7_200;
const DEFAULT_LOG_BATCH = 1_000;
const DEFAULT_CONCURRENCY = 16;

const pairIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const factoryIface = new ethers.Interface([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function allPairs(uint256 index) view returns (address pair)",
]);

export interface ProbedV2Pool {
  readonly factory: string;
  readonly pool: string;
  readonly factoryCodeHash: string;
  readonly pairCodeHash: string;
}

export interface VerifiedLineage extends ProbedV2Pool {
  readonly feeBps: number;
}

export interface TrustedFingerprint {
  readonly factoryCodeHash: string;
  readonly pairCodeHash: string;
  readonly feeBps: number;
}

export function fingerprintKey(value: {
  factoryCodeHash: string;
  pairCodeHash: string;
}): string {
  return `${value.factoryCodeHash.toLowerCase()}:${value.pairCodeHash.toLowerCase()}`;
}

export function matchTrustedFingerprints(
  pools: readonly ProbedV2Pool[],
  trusted: readonly TrustedFingerprint[],
): VerifiedLineage[] {
  const feeByFingerprint = new Map<string, Set<number>>();
  for (const item of trusted) {
    const key = fingerprintKey(item);
    feeByFingerprint.set(key, new Set([...(feeByFingerprint.get(key) ?? []), item.feeBps]));
  }
  return pools.flatMap((pool) => {
    const fees = feeByFingerprint.get(fingerprintKey(pool));
    if (!fees || fees.size !== 1) return [];
    return [{ ...pool, feeBps: [...fees][0] }];
  });
}

export function consolidateVerifiedLineages(
  observations: readonly VerifiedLineage[],
): VerifiedLineage[] {
  const grouped = new Map<string, VerifiedLineage[]>();
  for (const observation of observations) {
    const key = observation.factory.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), observation]);
  }
  const out: VerifiedLineage[] = [];
  for (const group of grouped.values()) {
    if (new Set(group.map((item) => item.feeBps)).size !== 1) continue;
    out.push(group[0]);
  }
  return out;
}

export function buildV2LineageSnapshot(
  seed: readonly V2LineageDescriptor[],
  verified: readonly VerifiedLineage[],
  toBlock: number,
  generatedAt = new Date().toISOString(),
): V2LineageSnapshot {
  const byFactory = new Map<string, V2LineageSnapshotRecord>();
  const trustedFactories = new Set(TRUSTED_V2_LINEAGES.map((item) => item.factory.toLowerCase()));
  for (const descriptor of seed) {
    if (trustedFactories.has(descriptor.factory.toLowerCase())) continue;
    // Automatically admitted factories must re-prove their fingerprint on every refresh.
    if (descriptor.venue.startsWith("v2-factory:")) continue;
    const record = toSnapshotRecord(descriptor);
    byFactory.set(descriptor.factory.toLowerCase(), {
      ...record,
      // Legacy rollback field mirrors the cleared fee below.
      discoverable: false,
      measuredFeeRule: null,
    });
  }
  for (const item of verified) {
    const key = item.factory.toLowerCase();
    if (trustedFactories.has(key)) continue;
    const current = byFactory.get(key);
    byFactory.set(key, {
      venue: current?.venue ?? `v2-factory:${key}`,
      factory: ethers.getAddress(item.factory),
      executionFamily: "univ2-standard",
      runtimeAdapter: "univ2",
      discoverable: true,
      quotable: true,
      buildable: true,
      measuredFeeRule: {
        kind: "constant-bps",
        feeBps: item.feeBps,
        evidence:
          `factory+pair runtime bytecode match at block ${toBlock}; ` +
          `factoryCodeHash=${item.factoryCodeHash}; pairCodeHash=${item.pairCodeHash}`,
      },
    });
  }
  return {
    schemaVersion: V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION,
    chainId: 1,
    generatedAt,
    toBlock,
    lineages: [...byFactory.values()].sort((a, b) => a.factory.localeCompare(b.factory)),
  };
}

async function refresh(input: {
  rpcUrl: string;
  outPath: string;
  lookbackBlocks: number;
  logBatch: number;
  concurrency: number;
}): Promise<void> {
  const provider = new ethers.JsonRpcProvider(input.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) throw new Error(`V2 lineage refresh requires chainId=1, got ${network.chainId}`);
  const toBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, toBlock - input.lookbackBlocks);
  const candidatePools = await scanCandidatePools(provider, fromBlock, toBlock, input.logBatch);
  const probed = (await mapLimit(candidatePools, input.concurrency, (pool) => {
    return probePool(provider, pool, toBlock);
  })).filter((item): item is ProbedV2Pool => item !== null);
  const trusted = await loadTrustedFingerprints(provider, probed, toBlock);
  const trustedNamedFactories = new Set(TRUSTED_V2_LINEAGES.map((item) => item.factory.toLowerCase()));
  const eligible = probed.filter((item) => {
    if (trustedNamedFactories.has(item.factory.toLowerCase())) return false;
    const identity = findVenueByFactory(item.factory);
    return identity === null ||
      (
        identity.compatibility === "standard" &&
        identity.poolAdapter === "univ2"
      );
  });
  const verified = consolidateVerifiedLineages(matchTrustedFingerprints(eligible, trusted));
  const snapshot = buildV2LineageSnapshot(V2_LINEAGES, verified, toBlock);
  writeSnapshotAtomically(input.outPath, snapshot);
  console.log(
    `[v2-lineages] blocks=${fromBlock}..${toBlock} candidatePools=${candidatePools.length} ` +
      `probed=${probed.length} trustedFingerprints=${trusted.length} ` +
      `autoFactories=${verified.length} lineages=${snapshot.lineages.length} out=${resolve(input.outPath)}`,
  );
}

async function loadTrustedFingerprints(
  provider: ethers.JsonRpcProvider,
  activePools: readonly ProbedV2Pool[],
  blockNumber: number,
): Promise<TrustedFingerprint[]> {
  const trustedByFactory = new Map(TRUSTED_V2_LINEAGES
    .map((item) => [item.factory.toLowerCase(), item] as const));
  const out: TrustedFingerprint[] = [];
  for (const pool of activePools) {
    const descriptor = trustedByFactory.get(pool.factory.toLowerCase());
    if (!descriptor?.measuredFeeRule) continue;
    out.push({
      factoryCodeHash: pool.factoryCodeHash,
      pairCodeHash: pool.pairCodeHash,
      feeBps: Number(descriptor.measuredFeeRule.feeBps),
    });
  }
  for (const descriptor of trustedByFactory.values()) {
    try {
      const pair = await callAddress(provider, descriptor.factory, factoryIface, "allPairs", [0n], blockNumber);
      const probed = await probePool(provider, pair, blockNumber);
      if (!probed || probed.factory.toLowerCase() !== descriptor.factory.toLowerCase()) continue;
      out.push({
        factoryCodeHash: probed.factoryCodeHash,
        pairCodeHash: probed.pairCodeHash,
        feeBps: Number(descriptor.measuredFeeRule!.feeBps),
      });
    } catch {
      // A trusted factory with no enumerable pair contributes no automatic fingerprint.
    }
  }
  const unique = new Map(out.map((item) => [`${fingerprintKey(item)}:${item.feeBps}`, item]));
  return [...unique.values()];
}

async function scanCandidatePools(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
  batchSize: number,
): Promise<string[]> {
  const pools = new Map<string, string>();
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);
    for (const log of await getLogsWithSplit(provider, start, end)) {
      const address = ethers.getAddress(log.address);
      pools.set(address.toLowerCase(), address);
    }
  }
  return [...pools.values()];
}

async function getLogsWithSplit(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Log[]> {
  try {
    return await provider.getLogs({ fromBlock, toBlock, topics: [UNIV2_SWAP_TOPIC] });
  } catch (error) {
    if (fromBlock >= toBlock) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const [left, right] = await Promise.all([
      getLogsWithSplit(provider, fromBlock, middle),
      getLogsWithSplit(provider, middle + 1, toBlock),
    ]);
    return [...left, ...right];
  }
}

async function probePool(
  provider: ethers.JsonRpcProvider,
  pool: string,
  blockNumber: number,
): Promise<ProbedV2Pool | null> {
  try {
    const [factory, token0, token1, reserves, pairCode] = await Promise.all([
      callAddress(provider, pool, pairIface, "factory", [], blockNumber),
      callAddress(provider, pool, pairIface, "token0", [], blockNumber),
      callAddress(provider, pool, pairIface, "token1", [], blockNumber),
      call(provider, pool, pairIface, "getReserves", [], blockNumber),
      provider.getCode(pool, blockNumber),
    ]);
    if (pairCode === "0x") return null;
    pairIface.decodeFunctionResult("getReserves", reserves);
    const [reverse, factoryCode] = await Promise.all([
      callAddress(provider, factory, factoryIface, "getPair", [token0, token1], blockNumber),
      provider.getCode(factory, blockNumber),
    ]);
    if (reverse.toLowerCase() !== pool.toLowerCase() || factoryCode === "0x") return null;
    return {
      factory,
      pool: ethers.getAddress(pool),
      factoryCodeHash: ethers.keccak256(factoryCode),
      pairCodeHash: ethers.keccak256(pairCode),
    };
  } catch {
    return null;
  }
}

async function callAddress(
  provider: ethers.JsonRpcProvider,
  target: string,
  iface: ethers.Interface,
  functionName: string,
  args: readonly unknown[],
  blockNumber: number,
): Promise<string> {
  const raw = await call(provider, target, iface, functionName, args, blockNumber);
  return ethers.getAddress(String(iface.decodeFunctionResult(functionName, raw)[0]));
}

async function call(
  provider: ethers.JsonRpcProvider,
  target: string,
  iface: ethers.Interface,
  functionName: string,
  args: readonly unknown[],
  blockNumber: number,
): Promise<string> {
  return provider.send("eth_call", [
    { to: target, data: iface.encodeFunctionData(functionName, [...args]) },
    `0x${blockNumber.toString(16)}`,
  ]);
}

function toSnapshotRecord(descriptor: V2LineageDescriptor): V2LineageSnapshotRecord {
  const measured = descriptor.measuredFeeRule !== null;
  return {
    venue: descriptor.venue,
    factory: descriptor.factory,
    executionFamily: descriptor.executionFamily,
    // Rollback compatibility only; current support is registry-derived.
    runtimeAdapter: "univ2",
    discoverable: measured,
    quotable: true,
    buildable: true,
    measuredFeeRule: descriptor.measuredFeeRule
      ? {
          kind: descriptor.measuredFeeRule.kind,
          feeBps: Number(descriptor.measuredFeeRule.feeBps),
          evidence: descriptor.measuredFeeRule.evidence,
        }
      : null,
  };
}

function writeSnapshotAtomically(path: string, snapshot: V2LineageSnapshot): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o444 });
  renameSync(temporary, absolute);
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function positiveInteger(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const rpcUrl = argument("--rpc") ?? process.env.MAINNET_RPC_URL;
  const outPath = argument("--out") ?? process.env.V2_LINEAGE_OUT;
  if (!rpcUrl) throw new Error("--rpc or MAINNET_RPC_URL required");
  if (!outPath) throw new Error("--out or V2_LINEAGE_OUT required");
  await refresh({
    rpcUrl,
    outPath,
    lookbackBlocks: positiveInteger(argument("--blocks"), DEFAULT_LOOKBACK_BLOCKS, "--blocks"),
    logBatch: positiveInteger(argument("--batch"), DEFAULT_LOG_BATCH, "--batch"),
    concurrency: positiveInteger(argument("--concurrency"), DEFAULT_CONCURRENCY, "--concurrency"),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[v2-lineages] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
