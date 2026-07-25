import {
  ethers,
  type JsonRpcError,
  type JsonRpcPayload,
} from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";
import {
  factoryDiscoverySourcesForPoolAdapters,
  type VenueId,
} from "./venues/capability.js";
import {
  attestPoolIdentities,
  type IdentityCallBackend,
} from "./venues/identity.js";
import {
  STRICT_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./venues/admission.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
} from "./venues/production-registry.js";
import {
  discoverLandedPools,
  type LandedPoolDiscoveryCoverage,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolDiscoveryReadBackend,
} from "./venues/landed-pool-discovery.js";

// Factory event topics
const UNIV2_PAIR_CREATED = ethers.id("PairCreated(address,address,address,uint256)");
const UNIV3_POOL_CREATED = ethers.id("PoolCreated(address,address,uint24,int24,address)");

// ─── Factory-based full pool indexing ───────────────────────

const FACTORY_LOG_BATCH = 5000;

export interface DexDiscoveryReadControl {
  /** Absolute wall-clock deadline shared by the enclosing discovery generation. */
  readonly deadlineAtMs?: number;
  /** Aborting this signal aborts the underlying HTTP request, not only its waiter. */
  readonly signal?: AbortSignal;
  /** Optional dedicated background-read semaphore (for DiscoveryBackfillLane). */
  readonly run?: <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

interface FactoryDef {
  address: string;
  topic: string;
  adapter: "univ2" | "univ3";
  venueId: VenueId;
  parsePool: (log: { data: string; topics: string[] }) => string;
}

const FACTORIES: FactoryDef[] = factoryDiscoverySourcesForPoolAdapters(
  PRODUCTION_ADAPTER_FAMILIES.matureDexUniversePoolAdapters(),
).flatMap((identity) => {
  const adapter = identity.poolAdapter;
  return identity.discovery.factories.map((address) => ({
    address,
    adapter,
    venueId: identity.venue,
    topic: adapter === "univ2" ? UNIV2_PAIR_CREATED : UNIV3_POOL_CREATED,
    parsePool: adapter === "univ2"
      // PairCreated data: pair address in first 32 bytes, then uint256.
      ? (log: { data: string }) => ethers.getAddress("0x" + log.data.slice(26, 66))
      // V3 PoolCreated data ends with the pool address.
      : (log: { data: string }) => ethers.getAddress("0x" + log.data.replace("0x", "").slice(-40)),
  }));
});

/**
 * Index pools from factory PairCreated/PoolCreated events over a block range.
 *
 * Full-history scan is too slow for standard RPCs. Two modes:
 *   1. Startup: scan recent N blocks (default 50k ≈ 7 days)
 *   2. Incremental: scan last 25 blocks every refresh cycle
 *
 * For full coverage, pre-generate a pool CSV from Dune/archive and load
 * via loadPoolCsv() at startup.
 */
export async function indexFactoryPools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 50000,
  toBlock?: number,
  options: {
    readonly strict?: boolean;
    readonly control?: DexDiscoveryReadControl;
  } = {},
): Promise<PoolEntry[]> {
  const latest = toBlock ?? (
    hasDexDiscoveryControl(options.control)
      ? await readDexDiscoveryBlockNumber(provider, options.control)
      : await provider.getBlockNumber()
  );
  const fromBlock = Math.max(0, latest - blocksBack);
  const pools: PoolEntry[] = [];

  for (const factory of FACTORIES) {
    throwIfDexDiscoveryCancelled(options.control);
    let count = 0;
    for (let start = fromBlock; start <= latest; start += FACTORY_LOG_BATCH) {
      throwIfDexDiscoveryCancelled(options.control);
      const end = Math.min(start + FACTORY_LOG_BATCH - 1, latest);
      const logs = options.strict
        ? await sendDexDiscoveryRpc<Array<{ data: string; topics: string[] }>>(
            provider,
            "eth_getLogs",
            [factoryLogFilter(factory, start, end)],
            options.control,
          )
        : await getFactoryLogs(
            provider,
            factory,
            start,
            end,
            options.control,
          );
      for (const log of logs) {
        try {
          // score 0: factory pools are prunable (not curated backbone), ranked
          // below swap-active pools but still above nothing.
          pools.push({
            address: factory.parsePool(log),
            adapter: factory.adapter,
            venueId: factory.venueId,
            factory: ethers.getAddress(factory.address),
            identitySource: "factory-event",
            score: 0,
          });
          count++;
        } catch { /* skip malformed */ }
      }
    }
    console.log(`[discovery] ${factory.adapter} factory (${factory.address.slice(0, 10)}): ${count} new pools in last ${blocksBack} blocks`);
  }

  return pools;
}

async function getFactoryLogs(
  provider: ethers.JsonRpcProvider,
  factory: FactoryDef,
  from: number,
  to: number,
  control?: DexDiscoveryReadControl,
): Promise<Array<{ data: string; topics: string[] }>> {
  try {
    return await sendDexDiscoveryRpc(
      provider,
      "eth_getLogs",
      [factoryLogFilter(factory, from, to)],
      control,
    );
  } catch (error) {
    if (isDexDiscoveryCancellationError(error)) throw error;
    throwIfDexDiscoveryCancelled(control, error);
    // Range too large — split into smaller chunks
    const results: Array<{ data: string; topics: string[] }> = [];
    for (let s = from; s <= to; s += 1000) {
      throwIfDexDiscoveryCancelled(control);
      const e = Math.min(s + 999, to);
      try {
        results.push(...await sendDexDiscoveryRpc<
          Array<{ data: string; topics: string[] }>
        >(
          provider,
          "eth_getLogs",
          [factoryLogFilter(factory, s, e)],
          control,
        ));
      } catch (chunkError) {
        if (isDexDiscoveryCancellationError(chunkError)) throw chunkError;
        throwIfDexDiscoveryCancelled(control, chunkError);
        // Non-strict discovery retains the legacy best-effort behavior.
      }
    }
    return results;
  }
}

function factoryLogFilter(
  factory: FactoryDef,
  fromBlock: number,
  toBlock: number,
): Record<string, unknown> {
  return {
    address: factory.address,
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(toBlock),
    topics: [factory.topic],
  };
}

const LOG_BATCH = 50;
const RETRY_LOG_BATCH = 10;

/**
 * Scan recent blocks for swap events to discover active pools.
 * Returns PoolEntry[] ranked by activity (top maxPools).
 */
export async function scanActivePools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
  toBlock?: number,
  options: {
    admissionPolicy?: IdentityAdmissionPolicy;
    /**
     * Source-pinned identity/code reads for an unbounded legacy generation.
     * A controlled generation deliberately uses the provider-backed abortable
     * transport below so every in-flight identity RPC shares its cancellation.
     */
    identityBackend?: IdentityCallBackend;
    /** Numeric source block used by family-owned singleton metadata reads. */
    identityBlockTag?: ethers.BlockTag;
    /**
     * Completeness mode for source-pinned graph generations. Any missing log
     * slice aborts the pass instead of returning a deceptively complete delta.
     */
    strict?: boolean;
    control?: DexDiscoveryReadControl;
  } = {},
): Promise<PoolEntry[]> {
  return [...(await scanActivePoolsDetailed(
    provider,
    blocksBack,
    maxPools,
    toBlock,
    options,
  )).pools];
}

export interface ActivePoolDiscoveryResult {
  readonly pools: readonly PoolEntry[];
  readonly coverage: readonly LandedPoolDiscoveryCoverage[];
  /** True when ranking omitted admitted positives; never completeness-safe. */
  readonly truncated: boolean;
}

export async function scanActivePoolsDetailed(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
  toBlock?: number,
  options: {
    admissionPolicy?: IdentityAdmissionPolicy;
    identityBackend?: IdentityCallBackend;
    identityBlockTag?: ethers.BlockTag;
    strict?: boolean;
    control?: DexDiscoveryReadControl;
  } = {},
): Promise<ActivePoolDiscoveryResult> {
  const latest = toBlock ?? (
    hasDexDiscoveryControl(options.control)
      ? await readDexDiscoveryBlockNumber(provider, options.control)
      : await provider.getBlockNumber()
  );
  const fromBlock = Math.max(0, latest - blocksBack);
  const discoveryBackend = ethersPoolDiscoveryBackend(
    provider,
    options.identityBlockTag,
    options.control,
  );
  const landed = await discoverLandedPools({
    registry: PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery(),
    backend: discoveryBackend,
    fromBlock,
    toBlock: latest,
    batchSize: LOG_BATCH,
    minSwaps: 1,
    admissionPolicy:
      options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION,
    strict: options.strict,
    signal: options.control?.signal,
  });
  const poolCounts = landed.activity;

  const candidates: PoolEntry[] = [
    ...[...poolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([addr, item]) => ({
      address: ethers.getAddress(addr),
      adapter: bestAdapter(item.adapterCounts),
      score: item.count,
    })),
    ...landed.materializedPools,
  ].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  throwIfDexDiscoveryCancelled(options.control);
  const { accepted, rejected } = await attestPoolIdentities(
    hasDexDiscoveryControl(options.control)
      ? discoveryBackend
      : options.identityBackend ?? provider,
    candidates,
    {
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: options.admissionPolicy,
    },
  );
  throwIfDexDiscoveryCancelled(options.control);
  if (
    options.strict &&
    rejected.some((item) => item.reason === "identity_call_failed")
  ) {
    throw new Error(
      "strict active-pool discovery could not complete source-pinned identity reads",
    );
  }
  const boundedMaxPools = Number.isFinite(maxPools)
    ? Math.max(0, Math.floor(maxPools))
    : accepted.length;
  const truncated = accepted.length > boundedMaxPools;
  if (options.strict && truncated) {
    throw new Error(
      "strict active-pool discovery cannot publish completeness after " +
        `truncating ${accepted.length} admitted pools to ${boundedMaxPools}`,
    );
  }
  const ranked = accepted.slice(0, boundedMaxPools);
  const provisional = accepted.filter(
    (pool) => pool.identitySource === "factory-call-provisional",
  ).length;
  const rejectedByReason = new Map<string, number>();
  for (const item of rejected) {
    rejectedByReason.set(item.reason, (rejectedByReason.get(item.reason) ?? 0) + 1);
  }
  const rejectedSummary = [...rejectedByReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");

  console.log(
    `[discovery] scanned ${blocksBack} blocks: ` +
      `${poolCounts.size + landed.materializedPools.length} candidates ` +
      `(materialized=${landed.materializedPools.length}), ` +
      `${accepted.length} identity-admitted (provisional=${provisional}), taking top ${ranked.length}` +
      (rejectedSummary ? `, rejected(${rejectedSummary})` : ""),
  );

  return {
    pools: Object.freeze(ranked),
    coverage: landed.coverage,
    truncated,
  };
}

function ethersPoolDiscoveryBackend(
  provider: ethers.JsonRpcProvider,
  blockTag?: ethers.BlockTag,
  control?: DexDiscoveryReadControl,
): LandedPoolDiscoveryReadBackend & IdentityCallBackend {
  return {
    getLogs(
      filter: LandedPoolDiscoveryLogFilter,
      nestedControl?: { readonly signal?: AbortSignal },
    ) {
      const mergedControl = mergeDexDiscoveryReadControls(
        control,
        nestedControl,
      );
      const params = [{
        ...(filter.address === undefined ? {} : { address: filter.address }),
        topics: [...filter.topics],
        fromBlock: ethers.toQuantity(filter.fromBlock),
        toBlock: ethers.toQuantity(filter.toBlock),
      }];
      return hasDexDiscoveryControl(mergedControl)
        ? sendDexDiscoveryRpc(provider, "eth_getLogs", params, mergedControl)
        : provider.send("eth_getLogs", params);
    },
    call(
      req: { readonly to: string; readonly data: string },
      nestedControl?: { readonly signal?: AbortSignal },
    ) {
      const mergedControl = mergeDexDiscoveryReadControls(
        control,
        nestedControl,
      );
      if (!hasDexDiscoveryControl(mergedControl)) {
        return provider.call({
          ...req,
          ...(blockTag === undefined ? {} : { blockTag }),
        });
      }
      return sendDexDiscoveryRpc<string>(
        provider,
        "eth_call",
        [
          provider.getRpcTransaction({ to: req.to, data: req.data }),
          blockTag === undefined ? "latest" : normalizeDexDiscoveryBlockTag(blockTag),
        ],
        mergedControl,
      );
    },
    getCode(address: string) {
      if (!hasDexDiscoveryControl(control)) {
        return provider.getCode(address, blockTag);
      }
      return sendDexDiscoveryRpc<string>(
        provider,
        "eth_getCode",
        [
          ethers.getAddress(address),
          blockTag === undefined ? "latest" : normalizeDexDiscoveryBlockTag(blockTag),
        ],
        control,
      );
    },
  };
}

let dexDiscoveryRpcId = 0;

async function readDexDiscoveryBlockNumber(
  provider: ethers.JsonRpcProvider,
  control?: DexDiscoveryReadControl,
): Promise<number> {
  const raw = await sendDexDiscoveryRpc<string>(
    provider,
    "eth_blockNumber",
    [],
    control,
  );
  const value = Number(BigInt(raw));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid DEX discovery block number ${raw}`);
  }
  return value;
}

/**
 * Ethers does not expose an AbortSignal for one provider request. Reuse the
 * configured connection/auth, but send through fetch so cancellation closes
 * the actual HTTP transport instead of only racing the caller's Promise.
 */
export async function sendDexDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: readonly unknown[],
  control: DexDiscoveryReadControl = {},
): Promise<T> {
  validateDexDiscoveryControl(control);
  if (!hasDexDiscoveryControl(control)) {
    return provider.send(method, [...params]) as Promise<T>;
  }
  throwIfDexDiscoveryCancelled(control);
  if (control.run) {
    const { run, ...unbudgeted } = control;
    return run((budgetSignal) =>
      sendDexDiscoveryRpc<T>(provider, method, params, {
        ...unbudgeted,
        signal: mergeDexDiscoverySignals(
          unbudgeted.signal,
          budgetSignal,
        ),
      }));
  }
  const payload: JsonRpcPayload = {
    id: ++dexDiscoveryRpcId,
    jsonrpc: "2.0",
    method,
    params: [...params],
  };
  const connection = provider._getConnection();
  const controller = new AbortController();
  const detachParent = linkDexDiscoveryAbort(control.signal, controller);
  let deadlineExpired = false;
  const deadlineDelay = control.deadlineAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, control.deadlineAtMs - Date.now());
  const deadlineTimer = Number.isFinite(deadlineDelay)
    ? setTimeout(() => {
        deadlineExpired = true;
        controller.abort(dexDiscoveryDeadlineError(control.deadlineAtMs!));
      }, deadlineDelay)
    : null;
  try {
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { ...connection.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    throwIfDexDiscoveryCancelled(control);
    if (!response.ok) {
      throw new Error(
        `DEX discovery ${method} HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = await response.json() as Partial<JsonRpcError> & {
      result?: unknown;
    };
    throwIfDexDiscoveryCancelled(control);
    if (body.error) throw provider.getRpcError(payload, body as JsonRpcError);
    if (!("result" in body)) {
      throw new Error(`DEX discovery ${method} returned no result`);
    }
    return body.result as T;
  } catch (error) {
    if (control.signal?.aborted) {
      throw control.signal.reason ?? dexDiscoveryAbortError(error);
    }
    if (
      deadlineExpired ||
      (
        control.deadlineAtMs !== undefined &&
        Date.now() >= control.deadlineAtMs
      )
    ) {
      throw dexDiscoveryDeadlineError(control.deadlineAtMs!, error);
    }
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    detachParent();
  }
}

function validateDexDiscoveryControl(control: DexDiscoveryReadControl): void {
  if (
    control.deadlineAtMs !== undefined &&
    !Number.isFinite(control.deadlineAtMs)
  ) {
    throw new Error(
      `invalid DEX discovery deadline ${String(control.deadlineAtMs)}`,
    );
  }
}

function hasDexDiscoveryControl(
  control: DexDiscoveryReadControl | undefined,
): boolean {
  return control?.deadlineAtMs !== undefined ||
    control?.signal !== undefined ||
    control?.run !== undefined;
}

export function mergeDexDiscoveryReadControls(
  parent: DexDiscoveryReadControl | undefined,
  nested: DexDiscoveryReadControl | undefined,
): DexDiscoveryReadControl {
  const signals = [parent?.signal, nested?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const deadlines = [parent?.deadlineAtMs, nested?.deadlineAtMs].filter(
    (deadline): deadline is number => deadline !== undefined,
  );
  return {
    ...(deadlines.length === 0
      ? {}
      : { deadlineAtMs: Math.min(...deadlines) }),
    ...(signals.length === 0
      ? {}
      : {
          signal: mergeDexDiscoverySignals(...signals),
        }),
    ...((parent?.run ?? nested?.run) === undefined
      ? {}
      : { run: parent?.run ?? nested?.run }),
  };
}

function mergeDexDiscoverySignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function linkDexDiscoveryAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function throwIfDexDiscoveryCancelled(
  control: DexDiscoveryReadControl | undefined,
  cause?: unknown,
): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? dexDiscoveryAbortError(cause);
  }
  if (
    control?.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw dexDiscoveryDeadlineError(control.deadlineAtMs, cause);
  }
}

function isDexDiscoveryCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "ABORTED" || code === "DEADLINE_EXCEEDED";
}

function dexDiscoveryAbortError(cause?: unknown): Error {
  return Object.assign(
    new Error(
      "DEX discovery aborted",
      cause === undefined ? undefined : { cause },
    ),
    { code: "ABORTED" },
  );
}

function dexDiscoveryDeadlineError(
  deadlineAtMs: number,
  cause?: unknown,
): Error {
  return Object.assign(
    new Error(
      `DEX discovery deadline expired at ${deadlineAtMs}`,
      cause === undefined ? undefined : { cause },
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
}

function normalizeDexDiscoveryBlockTag(blockTag: ethers.BlockTag): string {
  try {
    return ethers.toQuantity(blockTag);
  } catch {
    if (blockTag === "latest") return blockTag;
    throw new Error(
      `DEX discovery requires a numeric block tag, received ${String(blockTag)}`,
    );
  }
}

function bestAdapter(
  adapterCounts: Map<PoolEntry["adapter"], number>,
): PoolEntry["adapter"] {
  return [...adapterCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function mergePoolRegistries(base: PoolEntry[], extra: PoolEntry[]): PoolEntry[] {
  const seen = new Set(base.map(poolRegistryKey));
  const merged = [...base];
  for (const p of extra) {
    const key = poolRegistryKey(p);
    if (!seen.has(key)) {
      merged.push(p);
      seen.add(key);
    }
  }
  return merged;
}

/**
 * Merge rows that may already have a behavior-probed protocol owner. Ordinary
 * DEX entries remain physical-keyed because their projection key is identical
 * to poolRegistryKey.
 */
export function mergePoolProjectionRows(
  base: readonly PoolEntry[],
  extra: readonly PoolEntry[],
): PoolEntry[] {
  const seen = new Set(base.map(poolProjectionRowKey));
  const merged = [...base];
  for (const pool of extra) {
    const key = poolProjectionRowKey(pool);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pool);
  }
  return merged;
}
