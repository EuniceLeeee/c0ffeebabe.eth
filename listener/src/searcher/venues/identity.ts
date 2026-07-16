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
import type { PoolEntry } from "../planner/token-graph.js";
export { CURVE_METAREGISTRY } from "./curve-underlying.js";

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

export interface OnchainIdentityResolverContext {
  backend: IdentityCallBackend;
  pool: string;
  poolAdapter: PoolEntry["adapter"];
  admissionPolicy: IdentityAdmissionPolicy;
}

export type OnchainIdentityResolver = (
  context: OnchainIdentityResolverContext,
) => Promise<PoolIdentityResult>;

export type IdentityResolverDescriptor =
  | {
      readonly poolAdapter: PoolEntry["adapter"];
      readonly policy: "onchain-resolver";
      readonly resolve: OnchainIdentityResolver;
      readonly legacyReason?: string;
    }
  | {
      readonly poolAdapter: PoolEntry["adapter"];
      readonly policy: "trusted-singleton-seed";
      readonly canonicalAddress?: string;
      readonly canonicalVenueId?: VenueId;
      readonly canonicalIdentitySource?: VenueIdentitySource;
      readonly legacyReason?: string;
    };

export class IdentityResolverRegistry {
  private readonly byPoolAdapter = new Map<PoolEntry["adapter"], IdentityResolverDescriptor>();

  constructor(descriptors: readonly IdentityResolverDescriptor[]) {
    for (const descriptor of descriptors) {
      if (this.byPoolAdapter.has(descriptor.poolAdapter)) {
        throw new Error(
          `identity resolver registry: duplicate identity policy ${descriptor.poolAdapter}`,
        );
      }
      this.byPoolAdapter.set(descriptor.poolAdapter, Object.freeze({ ...descriptor }));
    }
  }

  list(): readonly IdentityResolverDescriptor[] {
    return [...this.byPoolAdapter.values()];
  }

  forPool(poolAdapter: string): IdentityResolverDescriptor {
    const descriptor = this.byPoolAdapter.get(poolAdapter as PoolEntry["adapter"]);
    if (!descriptor) {
      throw new Error(`identity resolver registry: missing identity policy ${poolAdapter}`);
    }
    return descriptor;
  }
}

export function assertIdentityResolverCoverage(
  routeAdapters: readonly { readonly id: string; readonly poolAdapters: readonly string[] }[],
  registry: IdentityResolverRegistry,
): void {
  const routePoolAdapters = new Set<string>(
    routeAdapters.flatMap((adapter) => adapter.poolAdapters),
  );
  const identityPoolAdapters = new Set<string>(
    registry.list()
      .filter((descriptor) => descriptor.legacyReason === undefined)
      .map((descriptor) => descriptor.poolAdapter),
  );
  const missing = [...routePoolAdapters].filter((adapter) => !identityPoolAdapters.has(adapter));
  const extra = [...identityPoolAdapters].filter((adapter) => !routePoolAdapters.has(adapter));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "identity resolver registry: route coverage mismatch " +
        `missing=[${missing.sort().join(",")}] extra=[${extra.sort().join(",")}]`,
    );
  }
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
  adapter: T["adapter"] | PoolEntry["adapter"];
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
      adapter: PoolEntry["adapter"];
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

export async function resolvePoolIdentity(
  backend: IdentityCallBackend,
  address: string,
  adapter: string,
  options: {
    identityRegistry: IdentityResolverRegistry;
    admissionPolicy?: IdentityAdmissionPolicy;
  },
): Promise<PoolIdentityResult> {
  const pool = ethers.getAddress(address);
  const policy = options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION;
  const descriptor = options.identityRegistry.forPool(adapter);
  if (descriptor.policy === "onchain-resolver") {
    return descriptor.resolve({
      backend,
      pool,
      poolAdapter: descriptor.poolAdapter,
      admissionPolicy: policy,
    });
  }
  return resolveTrustedSingleton(descriptor, pool);
}

export function createPoolIdentityCache(): PoolIdentityCache {
  return { resolutions: new Map() };
}

export async function attestPoolIdentities<T extends IdentityPoolEntry>(
  backend: IdentityCallBackend,
  pools: readonly T[],
  options: {
    identityRegistry: IdentityResolverRegistry;
    concurrency?: number;
    cache?: PoolIdentityCache;
    seedEntries?: readonly IdentityPoolEntry[];
    admissionPolicy?: IdentityAdmissionPolicy;
  },
): Promise<{ accepted: AttestedPoolEntry<T>[]; rejected: RejectedPoolIdentity[] }> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 32));
  const cache = options.cache ?? createPoolIdentityCache();
  const seedEntries = new Map(
    (options.seedEntries ?? []).map((seed) => [identityPoolKey(seed), seed]),
  );
  const results = await mapLimit(pools, concurrency, async (pool) => {
    const descriptor = options.identityRegistry.forPool(pool.adapter);
    if (descriptor.policy === "trusted-singleton-seed") {
      if (descriptor.canonicalAddress !== undefined) {
        const resolved = resolveTrustedSingleton(descriptor, pool.address);
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
            identitySource: resolved.identitySource,
          },
          rejected: null,
        };
      }
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
      descriptor,
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
  descriptor: Extract<IdentityResolverDescriptor, { policy: "onchain-resolver" }>,
  admissionPolicy: IdentityAdmissionPolicy,
): Promise<PoolIdentityResult> {
  const provisionalFactories = allowProvisionalFactories(admissionPolicy);
  const provisionalCurveUnderlying = allowProvisionalCurveUnderlying(admissionPolicy);
  const key = `${address.toLowerCase()}:${descriptor.poolAdapter}:` +
    `${provisionalFactories ? "factory-provisional" : "factory-strict"}:` +
    `${provisionalCurveUnderlying ? "curve-provisional" : "curve-strict"}`;
  let pending = cache.resolutions.get(key);
  if (!pending) {
    pending = descriptor.resolve({
      backend,
      pool: ethers.getAddress(address),
      poolAdapter: descriptor.poolAdapter,
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

export const factoryIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  admissionPolicy,
}) => {
  if (poolAdapter !== "univ2" && poolAdapter !== "univ3") {
    throw new Error(`factory identity resolver: unsupported pool adapter ${poolAdapter}`);
  }
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
    if (!allowProvisionalFactories(admissionPolicy)) {
      return capability
        ? { ok: false, reason: "unsupported_venue", venueId: capability.venue, factory }
        : { ok: false, reason: "unknown_factory", factory };
    }
    // Factory is provenance, not a hard admission gate. Keep the observed V2/V3
    // shape explicit; token-graph ABI checks and mandatory final sim remain fail-closed.
    return {
      ok: true,
      adapter: capability?.runtimeAdapter ?? poolAdapter,
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
};

export const curveIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  admissionPolicy,
}) => {
  if (poolAdapter !== "curve" && poolAdapter !== "curve-nr" && poolAdapter !== "curve-underlying") {
    throw new Error(`curve identity resolver: unsupported pool adapter ${poolAdapter}`);
  }
  if (poolAdapter === "curve-underlying") {
    const allowProvisional = allowProvisionalCurveUnderlying(admissionPolicy);
    try {
      const metadata = await resolveCurveUnderlyingMetadata(backend, pool, {
        allowDirectPoolFallback: allowProvisional,
      });
      return {
        ok: true,
        adapter: poolAdapter,
        venueId: metadata.source === "curve-metaregistry-underlying" ? "curve" : "unknown",
        identitySource: metadata.source,
      };
    } catch {
      return {
        ok: false,
        reason: allowProvisional ? "identity_call_failed" : "curve_unregistered",
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
      adapter: poolAdapter,
      venueId: "curve",
      identitySource: "curve-metaregistry",
    };
  } catch {
    return { ok: false, reason: "identity_call_failed", venueId: "curve" };
  }
};

export const balancerV3IdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
}) => {
  if (poolAdapter !== "balancer-v3") {
    throw new Error(`Balancer V3 identity resolver: unsupported pool adapter ${poolAdapter}`);
  }
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
};

function resolveTrustedSingleton(
  descriptor: Extract<IdentityResolverDescriptor, { policy: "trusted-singleton-seed" }>,
  address: string,
): PoolIdentityResult {
  if (descriptor.canonicalAddress === undefined) {
    return { ok: false, reason: "untrusted_seed" };
  }
  try {
    if (ethers.getAddress(address) !== ethers.getAddress(descriptor.canonicalAddress)) {
      return { ok: false, reason: "adapter_mismatch" };
    }
  } catch {
    return { ok: false, reason: "adapter_mismatch" };
  }
  return {
    ok: true,
    adapter: descriptor.poolAdapter,
    venueId: descriptor.canonicalVenueId ?? "unknown",
    identitySource: descriptor.canonicalIdentitySource ?? "seed",
  };
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
