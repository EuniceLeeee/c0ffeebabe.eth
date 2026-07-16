import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  findVenueByFactory,
  findVenueBySeed,
  type VenueId,
} from "./capability.js";
import {
  CURVE_METAREGISTRY,
  resolveCurveUnderlyingMetadata,
} from "./curve-underlying.js";
import {
  allowProvisionalCurveUnderlying,
  allowProvisionalFactories,
  STRICT_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./admission.js";
export { CURVE_METAREGISTRY } from "./curve-underlying.js";

export type IdentityCheckedAdapter =
  | "univ2"
  | "univ3"
  | "curve"
  | "curve-nr"
  | "curve-underlying"
  | "balancer-v3";
export type VenueIdentitySource =
  | "factory-call"
  | "factory-call-provisional"
  | "factory-event"
  | "curve-metaregistry"
  | "curve-metaregistry-underlying"
  | "curve-underlying-provisional"
  | "v4-manager"
  | "balancer-v3-vault"
  | "seed";

export interface VenueIdentityMetadata {
  venueId?: VenueId;
  factory?: string;
  identitySource?: VenueIdentitySource;
}

export interface IdentityCallBackend {
  call(req: { to: string; data: string }): Promise<string>;
}

export type PoolIdentityFailureReason =
  | "identity_call_failed"
  | "unknown_factory"
  | "unsupported_venue"
  | "adapter_mismatch"
  | "curve_unregistered"
  | "balancer_v3_unregistered"
  | "untrusted_seed";

export interface IdentityPoolEntry extends VenueIdentityMetadata {
  address: string;
  adapter: string;
}

export type AttestedPoolEntry<T extends IdentityPoolEntry> = Omit<
  T,
  "adapter" | keyof VenueIdentityMetadata
> & {
  /** Factory identity may correct a V2/V3 event-derived adapter hint. */
  adapter: T["adapter"] | IdentityCheckedAdapter;
  venueId?: VenueId;
  factory?: string;
  identitySource: VenueIdentitySource;
};

export interface RejectedPoolIdentity {
  address: string;
  adapter: string;
  reason: PoolIdentityFailureReason;
  venueId?: VenueId;
  factory?: string;
}

export interface PoolIdentityCache {
  resolutions: Map<string, Promise<PoolIdentityResult>>;
}

export type PoolIdentityResult =
  | {
      ok: true;
      adapter: IdentityCheckedAdapter;
      venueId: VenueId;
      factory?: string;
      identitySource: VenueIdentitySource;
    }
  | {
      ok: false;
      reason: PoolIdentityFailureReason;
      venueId?: VenueId;
      factory?: string;
    };

const factoryIface = new ethers.Interface([
  "function factory() view returns (address)",
]);
const curveMetaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
]);
const balancerV3VaultIface = new ethers.Interface([
  "function isPoolRegistered(address pool) view returns (bool)",
]);

export function requiresOnchainIdentity(adapter: string): adapter is IdentityCheckedAdapter {
  return adapter === "univ2" ||
    adapter === "univ3" ||
    adapter === "curve" ||
    adapter === "curve-nr" ||
    adapter === "curve-underlying" ||
    adapter === "balancer-v3";
}

export async function resolvePoolIdentity(
  backend: IdentityCallBackend,
  address: string,
  adapter: IdentityCheckedAdapter,
  options: {
    admissionPolicy?: IdentityAdmissionPolicy;
  } = {},
): Promise<PoolIdentityResult> {
  const pool = ethers.getAddress(address);
  const policy = options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION;
  if (adapter === "curve" || adapter === "curve-nr" || adapter === "curve-underlying") {
    return resolveCurveIdentity(
      backend,
      pool,
      adapter,
      allowProvisionalCurveUnderlying(policy),
    );
  }
  if (adapter === "balancer-v3") {
    return resolveBalancerV3Identity(backend, pool);
  }
  return resolveFactoryIdentity(
    backend,
    pool,
    adapter,
    allowProvisionalFactories(policy),
  );
}

export function isCanonicalV4Manager(address: string): boolean {
  try {
    return ethers.getAddress(address) === ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
  } catch {
    return false;
  }
}

export function createPoolIdentityCache(): PoolIdentityCache {
  return { resolutions: new Map() };
}

export async function attestPoolIdentities<T extends IdentityPoolEntry>(
  backend: IdentityCallBackend,
  pools: readonly T[],
  options: {
    concurrency?: number;
    cache?: PoolIdentityCache;
    seedEntries?: readonly IdentityPoolEntry[];
    admissionPolicy?: IdentityAdmissionPolicy;
  } = {},
): Promise<{ accepted: AttestedPoolEntry<T>[]; rejected: RejectedPoolIdentity[] }> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 32));
  const cache = options.cache ?? createPoolIdentityCache();
  const seedEntries = new Map(
    (options.seedEntries ?? []).map((seed) => [identityPoolKey(seed), seed]),
  );
  const results = await mapLimit(pools, concurrency, async (pool) => {
    if (pool.adapter === "univ4") {
      if (!isCanonicalV4Manager(pool.address)) {
        return {
          accepted: null,
          rejected: rejection(pool, "adapter_mismatch"),
        };
      }
      return {
        accepted: {
          ...pool,
          venueId: "univ4" as VenueId,
          identitySource: "v4-manager" as VenueIdentitySource,
        },
        rejected: null,
      };
    }
    if (!requiresOnchainIdentity(pool.adapter)) {
      const seed = seedEntries.get(identityPoolKey(pool));
      if (!seed) {
        return {
          accepted: null,
          rejected: rejection(pool, "untrusted_seed"),
        };
      }
      const capability = findVenueBySeed(seed.address);
      return {
        accepted: {
          ...pool,
          venueId: capability?.venue ?? seed.venueId,
          identitySource: "seed" as VenueIdentitySource,
        },
        rejected: null,
      };
    }

    // Persisted metadata is evidence for reports, never an admission credential.
    // Re-attest against the local node so a stale or hand-edited universe cannot
    // relabel a selector-compatible contract as a supported venue.
    const resolved = await cachedResolution(
      cache,
      backend,
      pool.address,
      pool.adapter,
      options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION,
    );
    if (!resolved.ok) {
      return {
        accepted: null,
        rejected: rejection(pool, resolved.reason, resolved.venueId, resolved.factory),
      };
    }
    return {
      accepted: {
        ...pool,
        adapter: resolved.adapter,
        venueId: resolved.venueId,
        factory: resolved.factory,
        identitySource: resolved.identitySource,
      },
      rejected: null,
    };
  });

  return {
    accepted: results.flatMap((item) => item.accepted ? [item.accepted] : []) as AttestedPoolEntry<T>[],
    rejected: results.flatMap((item) => item.rejected ? [item.rejected] : []),
  };
}

function identityPoolKey(pool: IdentityPoolEntry): string {
  return `${ethers.getAddress(pool.address).toLowerCase()}:${pool.adapter}`;
}

function cachedResolution(
  cache: PoolIdentityCache,
  backend: IdentityCallBackend,
  address: string,
  adapter: IdentityCheckedAdapter,
  admissionPolicy: IdentityAdmissionPolicy,
): Promise<PoolIdentityResult> {
  const provisionalFactories = allowProvisionalFactories(admissionPolicy);
  const provisionalCurveUnderlying = allowProvisionalCurveUnderlying(admissionPolicy);
  const key = `${address.toLowerCase()}:${adapter}:` +
    `${provisionalFactories ? "factory-provisional" : "factory-strict"}:` +
    `${provisionalCurveUnderlying ? "curve-provisional" : "curve-strict"}`;
  let pending = cache.resolutions.get(key);
  if (!pending) {
    pending = resolvePoolIdentity(backend, address, adapter, {
      admissionPolicy,
    });
    cache.resolutions.set(key, pending);
  }
  return pending;
}

function rejection(
  pool: IdentityPoolEntry,
  reason: RejectedPoolIdentity["reason"],
  venueId?: VenueId,
  factory?: string,
): RejectedPoolIdentity {
  return { address: pool.address, adapter: pool.adapter, reason, venueId, factory };
}

async function resolveFactoryIdentity(
  backend: IdentityCallBackend,
  pool: string,
  adapterHint: "univ2" | "univ3",
  allowProvisionalFactories: boolean,
): Promise<PoolIdentityResult> {
  let factory: string;
  try {
    const raw = await backend.call({
      to: pool,
      data: factoryIface.encodeFunctionData("factory"),
    });
    const decoded = factoryIface.decodeFunctionResult("factory", raw);
    factory = ethers.getAddress(String(decoded[0]));
  } catch {
    return { ok: false, reason: "identity_call_failed" };
  }

  const capability = findVenueByFactory(factory);
  if (
    !capability ||
    !capability.runtimeAdapter ||
    !capability.discoverable ||
    !capability.quotable ||
    !capability.buildable ||
    !capability.supported_in_prod
  ) {
    if (!allowProvisionalFactories) {
      return capability
        ? { ok: false, reason: "unsupported_venue", venueId: capability.venue, factory }
        : { ok: false, reason: "unknown_factory", factory };
    }
    // Factory is provenance, not a hard admission gate. Keep the observed V2/V3
    // shape explicit; token-graph ABI checks and mandatory final sim remain fail-closed.
    return {
      ok: true,
      adapter: capability?.runtimeAdapter ?? adapterHint,
      venueId: capability?.venue ?? "unknown",
      factory,
      identitySource: "factory-call-provisional",
    };
  }

  return {
    ok: true,
    adapter: capability.runtimeAdapter,
    venueId: capability.venue,
    factory,
    identitySource: "factory-call",
  };
}

async function resolveCurveIdentity(
  backend: IdentityCallBackend,
  pool: string,
  adapter: "curve" | "curve-nr" | "curve-underlying",
  allowProvisionalCurveUnderlying: boolean,
): Promise<PoolIdentityResult> {
  if (adapter === "curve-underlying") {
    try {
      const metadata = await resolveCurveUnderlyingMetadata(backend, pool, {
        allowDirectPoolFallback: allowProvisionalCurveUnderlying,
      });
      return {
        ok: true,
        adapter,
        venueId: metadata.source === "curve-metaregistry-underlying" ? "curve" : "unknown",
        identitySource: metadata.source,
      };
    } catch {
      return {
        ok: false,
        reason: allowProvisionalCurveUnderlying ? "identity_call_failed" : "curve_unregistered",
        venueId: "curve",
      };
    }
  }
  try {
    const raw = await backend.call({
      to: CURVE_METAREGISTRY,
      data: curveMetaRegistryIface.encodeFunctionData("get_registry_handlers_from_pool", [pool]),
    });
    const decoded = curveMetaRegistryIface.decodeFunctionResult(
      "get_registry_handlers_from_pool",
      raw,
    );
    const handlers = Array.from(decoded[0] as readonly string[]);
    if (!handlers.some((handler) => ethers.getAddress(handler) !== ethers.ZeroAddress)) {
      return { ok: false, reason: "curve_unregistered", venueId: "curve" };
    }
    return {
      ok: true,
      adapter,
      venueId: "curve",
      identitySource: "curve-metaregistry",
    };
  } catch {
    return { ok: false, reason: "identity_call_failed", venueId: "curve" };
  }
}

async function resolveBalancerV3Identity(
  backend: IdentityCallBackend,
  pool: string,
): Promise<PoolIdentityResult> {
  try {
    const raw = await backend.call({
      to: ADDR.BALANCER_V3_VAULT,
      data: balancerV3VaultIface.encodeFunctionData("isPoolRegistered", [pool]),
    });
    const registered = Boolean(
      balancerV3VaultIface.decodeFunctionResult("isPoolRegistered", raw)[0],
    );
    if (!registered) {
      return { ok: false, reason: "balancer_v3_unregistered", venueId: "balancer-v3" };
    }
    return {
      ok: true,
      adapter: "balancer-v3",
      venueId: "balancer-v3",
      identitySource: "balancer-v3-vault",
    };
  } catch {
    return { ok: false, reason: "identity_call_failed", venueId: "balancer-v3" };
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
  return results;
}
