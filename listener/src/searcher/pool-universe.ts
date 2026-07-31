import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import type { VenueId } from "./venues/capability.js";
import type { VenueIdentitySource } from "./venues/identity.js";
import {
  isProductionPoolAdapter,
  isProductionVenueId,
  isProductionVenueIdentitySource,
} from "./venues/pool-adapter-policy.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-registry-key.js";
export {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-registry-key.js";
import {
  validateRouteImmutableBinding,
  type RouteImmutableBinding,
} from "./venues/route-immutable-binding.js";

export const DEFAULT_POOL_UNIVERSE_PATH = resolve("searcher", "pools", "active-pools.json");
export const POOL_UNIVERSE_BUILD_MANIFEST_PROFILE =
  "pool-universe-build-manifest-v1" as const;

export interface PoolUniverseEntry extends PoolEntry {
  token0?: string;
  token1?: string;
  underlyingCoins?: string[];
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  swapCount30d?: number;
  lastSwapBlock?: number;
  source?: string;
  /**
   * A family-owned instance that was already admitted on-chain but had no
   * swap in the latest rolling activity window. This is topology inventory,
   * not an activity score, so it survives minScore/top-N selection at score 0.
   */
  topologyRetained?: true;
}

export interface PoolUniverseFile {
  schemaVersion?: number;
  generatedAt?: string;
  fromBlock?: number;
  toBlock?: number;
  registry?: {
    sourceFingerprints?: string[];
  };
  pools: PoolUniverseEntry[];
}

export interface PoolUniverseCoverageMetadata {
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
  readonly generatedAt: string;
  readonly contentSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  /**
   * True only when the sidecar binds these exact universe bytes, range,
   * registry semantics and source block identity.
   */
  readonly manifestVerified: boolean;
  readonly source: {
    readonly number: number;
    readonly hash: string;
    readonly stateRoot: string;
  } | null;
  /**
   * Exact landed-discovery registry that generated this universe. null means
   * an older/unverifiable artifact and cannot authorize current completeness.
   */
  readonly registrySourceFingerprints: readonly string[] | null;
}

export interface PoolUniverseLoadOptions {
  missingOk?: boolean;
  maxPools?: number;
  minScore?: number;
  forceInclude?: string[];
  highSpreadPairQuota?: number;
  highSpreadMinFee?: number;
}

export function poolUniverseCanonicalAnchorMatches(
  metadata: PoolUniverseCoverageMetadata,
  block: {
    readonly number?: number;
    readonly hash?: string | null;
    readonly stateRoot?: string | null;
  } | null,
): boolean {
  const source = metadata.source;
  return metadata.manifestVerified &&
    source !== null &&
    block !== null &&
    block.number === source.number &&
    block.hash?.toLowerCase() === source.hash &&
    block.stateRoot?.toLowerCase() === source.stateRoot;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadPoolUniverse(
  path = DEFAULT_POOL_UNIVERSE_PATH,
  opts: PoolUniverseLoadOptions = {},
): PoolUniverseEntry[] {
  const missingOk = opts.missingOk ?? true;
  if (!existsSync(path)) {
    if (missingOk) return [];
    throw new Error(`pool universe file not found: ${path}`);
  }
  return parsePoolUniverseJson(readFileSync(path, "utf8"), path, opts);
}

/** Parse one already-frozen universe snapshot without re-reading a mutable path. */
export function parsePoolUniverseJson(
  raw: string,
  label: string,
  opts: PoolUniverseLoadOptions = {},
): PoolUniverseEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  const rawPools = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pools)
      ? parsed.pools
      : null;
  if (!rawPools) {
    throw new Error(`pool universe file ${label} must be an array or { pools: [...] }`);
  }

  const minScore = opts.minScore ?? 0;
  const maxPools = opts.maxPools && opts.maxPools > 0 ? opts.maxPools : Infinity;
  const highSpreadPairQuota = Math.max(0, Math.floor(opts.highSpreadPairQuota ?? 0));
  const highSpreadMinFee = Math.max(0, Math.floor(opts.highSpreadMinFee ?? 10_000));
  const parsedPools = rawPools
    .map((entry, i) => parsePoolUniverseEntry(entry, `${label}.pools[${i}]`));
  const activePools = parsedPools
    .filter((pool) => pool.topologyRetained !== true)
    .filter((pool) => (pool.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topologyInventory = parsedPools
    .filter((pool) => pool.topologyRetained === true)
    .sort((a, b) => poolRegistryKey(a).localeCompare(poolRegistryKey(b)));
  const selected = selectRankedPools(
    activePools,
    maxPools,
    highSpreadPairQuota,
    highSpreadMinFee,
  );
  const selectedKeys = new Set(selected.map(poolRegistryKey));
  for (const pool of topologyInventory) {
    const key = poolRegistryKey(pool);
    if (selectedKeys.has(key)) continue;
    selected.push(pool);
    selectedKeys.add(key);
  }

  return appendForceIncluded(
    selected,
    parsedPools,
    opts.forceInclude ?? [],
  );
}

/** Reads only the universe file's generatedAt metadata (loadPoolUniverse discards it). "" if absent/array-form/missing. */
export function loadPoolUniverseGeneratedAt(path = DEFAULT_POOL_UNIVERSE_PATH): string {
  if (!existsSync(path)) return "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.generatedAt === "string") return parsed.generatedAt;
    return "";
  } catch {
    return "";
  }
}

export function loadPoolUniverseCoverageMetadata(
  path = DEFAULT_POOL_UNIVERSE_PATH,
  manifestPath = `${path}.manifest.json`,
): PoolUniverseCoverageMetadata {
  if (!existsSync(path)) {
    return Object.freeze({
      fromBlock: null,
      toBlock: null,
      generatedAt: "",
      contentSha256: "",
      manifestPath,
      manifestSha256: "",
      manifestVerified: false,
      source: null,
      registrySourceFingerprints: null,
    });
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const record = isRecord(parsed) ? parsed : {};
  const fromBlock = safeCoverageBlock(record.fromBlock);
  const toBlock = safeCoverageBlock(record.toBlock);
  const contentSha256 = createHash("sha256").update(raw).digest("hex");
  const registrySourceFingerprints =
    parseRegistrySourceFingerprints(record.registry);
  const manifest = loadVerifiedUniverseManifest({
    manifestPath,
    contentSha256,
    poolCount: Array.isArray(record.pools) ? record.pools.length : null,
    fromBlock,
    toBlock,
    registrySourceFingerprints,
  });
  return Object.freeze({
    fromBlock,
    toBlock,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
    contentSha256,
    manifestPath,
    manifestSha256: manifest.sha256,
    manifestVerified: manifest.source !== null,
    source: manifest.source,
    registrySourceFingerprints,
  });
}

function loadVerifiedUniverseManifest(input: {
  readonly manifestPath: string;
  readonly contentSha256: string;
  readonly poolCount: number | null;
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
  readonly registrySourceFingerprints: readonly string[] | null;
}): {
  readonly sha256: string;
  readonly source: PoolUniverseCoverageMetadata["source"];
} {
  if (!existsSync(input.manifestPath)) {
    return { sha256: "", source: null };
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(input.manifestPath, "utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { sha256: "", source: null };
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (!isRecord(parsed)) return { sha256, source: null };
  const source = isRecord(parsed.source) ? parsed.source : {};
  const inputs = isRecord(parsed.inputs) ? parsed.inputs : {};
  const output = isRecord(parsed.output) ? parsed.output : {};
  const manifestRegistry = isRecord(parsed.registry) ? parsed.registry : {};
  const manifestFingerprints = parseFingerprintArray(
    manifestRegistry.sourceFingerprints,
  );
  const number = safeCoverageBlock(source.number);
  const hash = normalizedHash(source.hash);
  const stateRoot = normalizedHash(source.stateRoot);
  const valid =
    parsed.schemaVersion === 1 &&
    parsed.profile === POOL_UNIVERSE_BUILD_MANIFEST_PROFILE &&
    parsed.chainId === 1 &&
    input.fromBlock !== null &&
    input.toBlock !== null &&
    input.poolCount !== null &&
    input.registrySourceFingerprints !== null &&
    number === input.toBlock &&
    inputs.fromBlock === input.fromBlock &&
    inputs.toBlock === input.toBlock &&
    output.contentSha256 === input.contentSha256 &&
    output.pools === input.poolCount &&
    hash !== null &&
    stateRoot !== null &&
    manifestFingerprints !== null &&
    sameStrings(manifestFingerprints, input.registrySourceFingerprints);
  return {
    sha256,
    source: valid
      ? Object.freeze({ number: number!, hash: hash!, stateRoot: stateRoot! })
      : null,
  };
}

function parseRegistrySourceFingerprints(
  value: unknown,
): readonly string[] | null {
  if (!isRecord(value) || !Array.isArray(value.sourceFingerprints)) {
    return null;
  }
  return parseFingerprintArray(value.sourceFingerprints);
}

function parseFingerprintArray(
  value: unknown,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const fingerprints = value;
  if (
    fingerprints.some((item) =>
      typeof item !== "string" || item.length === 0
    )
  ) {
    return null;
  }
  const canonical = [...fingerprints].sort();
  if (
    new Set(canonical).size !== canonical.length ||
    canonical.some((item, index) => item !== fingerprints[index])
  ) {
    return null;
  }
  return Object.freeze(canonical);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((item, index) => item === right[index]);
}

function normalizedHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function safeCoverageBlock(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function selectRankedPools(
  pools: PoolUniverseEntry[],
  maxPools: number,
  highSpreadPairQuota: number,
  highSpreadMinFee: number,
): PoolUniverseEntry[] {
  if (!Number.isFinite(maxPools) || highSpreadPairQuota <= 0) {
    return pools.slice(0, maxPools);
  }
  const cappedMax = Math.max(0, Math.floor(maxPools));
  if (cappedMax === 0) return [];

  const selected: PoolUniverseEntry[] = [];
  const seenPools = new Set<string>();
  const representedPairs = new Set<string>();
  const primaryLimit = Math.max(0, cappedMax - Math.min(highSpreadPairQuota, cappedMax));

  for (const pool of pools.slice(0, primaryLimit)) {
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  const highSpreadCandidates = pools
    .filter((pool) => !seenPools.has(poolRegistryKey(pool)) && impliedSpreadFee(pool) >= highSpreadMinFee)
    .sort((a, b) =>
      impliedSpreadFee(b) - impliedSpreadFee(a) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
    );
  for (const pool of highSpreadCandidates) {
    if (selected.length >= cappedMax) break;
    const pairKey = unorderedTokenPairKey(pool);
    if (pairKey === null || representedPairs.has(pairKey)) continue;
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  for (const pool of pools) {
    if (selected.length >= cappedMax) break;
    if (seenPools.has(poolRegistryKey(pool))) continue;
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  return selected;
}

function appendSelected(
  pool: PoolUniverseEntry,
  selected: PoolUniverseEntry[],
  seenPools: Set<string>,
  representedPairs: Set<string>,
): void {
  selected.push(pool);
  seenPools.add(poolRegistryKey(pool));
  const pairKey = unorderedTokenPairKey(pool);
  if (pairKey !== null) representedPairs.add(pairKey);
}

function impliedSpreadFee(pool: PoolUniverseEntry): number {
  if (typeof pool.fee === "number") return pool.fee;
  if (pool.adapter === "univ2") return 3000;
  return 0;
}

export function selectPairCompletionPools(
  admittedPools: PoolEntry[],
  candidatePools: PoolUniverseEntry[],
): PoolUniverseEntry[] {
  const admittedPairs = new Set<string>();
  for (const pool of admittedPools) {
    const key = unorderedTokenPairKey(pool);
    if (key) admittedPairs.add(key);
  }
  const admittedPoolKeys = new Set(admittedPools.map(poolRegistryKey));
  for (const pool of candidatePools) {
    if (!admittedPoolKeys.has(poolRegistryKey(pool))) continue;
    const key = unorderedTokenPairKey(pool);
    if (key) admittedPairs.add(key);
  }
  if (admittedPairs.size === 0) return [];
  return candidatePools.filter((pool) => {
    const key = unorderedTokenPairKey(pool);
    return key !== null && admittedPairs.has(key);
  });
}

function appendForceIncluded(
  selected: PoolUniverseEntry[],
  allPools: PoolUniverseEntry[],
  forceInclude: string[],
): PoolUniverseEntry[] {
  if (forceInclude.length === 0) return selected;
  const wantedAddrs = new Set<string>();
  const wantedPoolIds = new Set<string>();
  for (const item of forceInclude) {
    if (ADDRESS_RE.test(item)) {
      wantedAddrs.add(ethers.getAddress(item).toLowerCase());
    } else if (BYTES32_RE.test(item)) {
      wantedPoolIds.add(item.toLowerCase());
    } else {
      throw new Error(`forceInclude entry must be an address or bytes32 poolId: ${item}`);
    }
  }
  // Preserve the historical address-level behavior for every unbound
  // non-V4 row. Only explicitly binding-aware rows opt into multi-instance
  // force inclusion at one physical address.
  const seenAddrs = new Set(
    selected
      .filter((pool) =>
        pool.adapter !== "univ4" && pool.routeBinding === undefined
      )
      .map((pool) => pool.address.toLowerCase()),
  );
  const seenBoundPoolKeys = new Set(
    selected
      .filter((pool) => pool.routeBinding !== undefined)
      .map(poolRegistryKey),
  );
  const seenV4PoolIds = new Set(
    selected
      .filter((pool) => pool.adapter === "univ4" && typeof pool.poolId === "string")
      .map((pool) => pool.poolId!.toLowerCase()),
  );
  const warnedV4 = new Set<string>();
  const out = [...selected];
  for (const pool of allPools) {
    const addressKey = pool.address.toLowerCase();
    if (pool.adapter === "univ4") {
      const poolId = pool.poolId?.toLowerCase();
      if (poolId && wantedPoolIds.has(poolId)) {
        if (seenV4PoolIds.has(poolId)) continue;
        out.push(pool);
        seenV4PoolIds.add(poolId);
        continue;
      }
      if (wantedAddrs.has(addressKey) && !warnedV4.has(addressKey)) {
        console.warn(
          `[pool-universe] forceInclude skipped univ4 entry ${pool.address}: ` +
            "address-only identity is ambiguous for the v4 PoolManager",
        );
        warnedV4.add(addressKey);
      }
      continue;
    }
    if (!wantedAddrs.has(addressKey)) continue;
    if (pool.routeBinding === undefined) {
      if (seenAddrs.has(addressKey)) continue;
      out.push(pool);
      seenAddrs.add(addressKey);
      continue;
    }
    const poolKey = poolRegistryKey(pool);
    if (seenBoundPoolKeys.has(poolKey)) continue;
    out.push(pool);
    seenBoundPoolKeys.add(poolKey);
  }
  return out;
}

function parsePoolUniverseEntry(raw: unknown, field: string): PoolUniverseEntry {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const adapter = raw.adapter;
  if (!isProductionPoolAdapter(adapter)) {
    throw new Error(`${field}.adapter unsupported: ${String(adapter)}`);
  }
  const score = numberField(raw.score, `${field}.score`) ??
    numberField(raw.swapCount30d, `${field}.swapCount30d`) ??
    0;
  const isV4 = adapter === "univ4";
  return {
    address: checksumField(raw.address ?? raw.pool, `${field}.address`),
    adapter,
    venueId: venueIdField(raw.venueId, `${field}.venueId`),
    factory: optionalAddress(raw.factory, `${field}.factory`),
    identitySource: identitySourceField(raw.identitySource, `${field}.identitySource`),
    poolId: stringField(raw.poolId, `${field}.poolId`),
    routeBinding: routeImmutableBindingField(
      raw.routeBinding,
      `${field}.routeBinding`,
    ),
    score,
    fixedTokenIn: isV4
      ? optionalCurrency(raw.fixedTokenIn, `${field}.fixedTokenIn`)
      : optionalAddress(raw.fixedTokenIn, `${field}.fixedTokenIn`),
    fixedTokenOut: isV4
      ? optionalCurrency(raw.fixedTokenOut, `${field}.fixedTokenOut`)
      : optionalAddress(raw.fixedTokenOut, `${field}.fixedTokenOut`),
    fixedSlotKind: parseFixedSlotKind(raw.fixedSlotKind, `${field}.fixedSlotKind`),
    token0: optionalAddress(raw.token0, `${field}.token0`),
    token1: optionalAddress(raw.token1, `${field}.token1`),
    underlyingCoins: optionalAddressArray(raw.underlyingCoins, `${field}.underlyingCoins`),
    currency0: optionalCurrency(raw.currency0, `${field}.currency0`),
    currency1: optionalCurrency(raw.currency1, `${field}.currency1`),
    fee: numberField(raw.fee, `${field}.fee`),
    tickSpacing: numberField(raw.tickSpacing, `${field}.tickSpacing`),
    hooks: optionalCurrency(raw.hooks, `${field}.hooks`),
    swapCount30d: numberField(raw.swapCount30d, `${field}.swapCount30d`),
    lastSwapBlock: numberField(raw.lastSwapBlock, `${field}.lastSwapBlock`),
    source: typeof raw.source === "string" ? raw.source : undefined,
    logicalInstanceId: stringField(
      raw.logicalInstanceId,
      `${field}.logicalInstanceId`,
    ),
    topologyRetained: trueField(
      raw.topologyRetained,
      `${field}.topologyRetained`,
    ),
  };
}

function trueField(value: unknown, field: string): true | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value !== true) throw new Error(`${field} must be true when present`);
  return true;
}

function checksumField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an address string`);
  return ethers.getAddress(value);
}

function optionalAddress(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return checksumField(value, field);
}

function optionalCurrency(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  return checksumField(value, field);
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function venueIdField(value: unknown, field: string): VenueId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a registered venue id or unknown`);
  }
  const normalized = value.toLowerCase();
  if (!isProductionVenueId(normalized)) {
    throw new Error(`${field} must be a registered venue id or unknown`);
  }
  return normalized;
}

function identitySourceField(value: unknown, field: string): VenueIdentitySource | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isProductionVenueIdentitySource(value)) {
    throw new Error(`${field} has unsupported identity source ${String(value)}`);
  }
  return value;
}

function optionalAddressArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an address array`);
  const addresses = value.map((item, index) => checksumField(item, `${field}[${index}]`));
  if (addresses.length < 2) throw new Error(`${field} must contain at least two addresses`);
  return addresses;
}

function numberField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
  return n;
}

function parseFixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "lend" || value === "swap" || value === "protocol") return value;
  throw new Error(`${field} must be "lend", "swap", or "protocol"`);
}

function unorderedTokenPairKey(pool: Pick<PoolEntry, "token0" | "token1">): string | null {
  if (!pool.token0 || !pool.token1) return null;
  return [pool.token0.toLowerCase(), pool.token1.toLowerCase()].sort().join("/");
}

function routeImmutableBindingField(
  value: unknown,
  field: string,
): RouteImmutableBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  try {
    return validateRouteImmutableBinding({
      schema: value.schema as string,
      payload: value.payload as string,
      hash: value.hash as string,
    });
  } catch (error) {
    throw new Error(
      `${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
