import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  findVenueByFactory,
  findVenueByPoolRegistry,
  findVenueIdentity,
  type VenueId,
} from "./capability.js";
import {
  CURVE_METAREGISTRY,
  isCurveUnderlyingMetadataNotApplicableError,
  resolveCurveUnderlyingMetadata,
} from "./curve-underlying.js";
import {
  allowProvisionalCurveUnderlying,
  allowProvisionalFactories,
  STRICT_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./admission.js";
import type { PoolEntry } from "../planner/token-graph.js";
import {
  isKnownVenueIdentitySource,
  isKnownVenueId,
  isNonemptyRegistryId,
  VENUE_IDENTITY_SOURCES,
  type KnownVenueIdentitySource,
  type VenueIdentitySource,
} from "./registry-ids.js";
export { CURVE_METAREGISTRY } from "./curve-underlying.js";
export {
  VENUE_IDENTITY_SOURCES,
  type VenueIdentitySource,
} from "./registry-ids.js";

export function isVenueIdentitySource(value: unknown): value is KnownVenueIdentitySource {
  return isKnownVenueIdentitySource(value);
}

export interface VenueIdentityMetadata {
  venueId?: VenueId;
  factory?: string;
  identitySource?: VenueIdentitySource;
}

export interface IdentityCallBackend {
  call(req: { to: string; data: string }): Promise<string>;
  getCode?(address: string): Promise<string>;
}

export interface OnchainIdentityResolverContext {
  backend: IdentityCallBackend;
  pool: string;
  poolAdapter: PoolEntry["adapter"];
  /**
   * Full candidate shape. Pair-aware behavior families must re-attest these
   * values on-chain; they are probe inputs, never admission credentials.
   */
  candidate: Readonly<IdentityPoolEntry>;
  admissionPolicy: IdentityAdmissionPolicy;
  isPoolAdapterSupported: (poolAdapter: string) => boolean;
}

export type OnchainIdentityResolver = (
  context: OnchainIdentityResolverContext,
) => Promise<PoolIdentityResult>;

export type IdentityResolverDescriptor =
  | {
      readonly poolAdapter: PoolEntry["adapter"];
      readonly policy: "onchain-resolver";
      readonly resolve: OnchainIdentityResolver;
      /** Custom IDs owned by this policy; known fast-path IDs need no redeclaration. */
      readonly registeredVenueIds?: readonly VenueId[];
      readonly registeredIdentitySources?: readonly VenueIdentitySource[];
      readonly legacyReason?: string;
    }
  | {
      readonly poolAdapter: PoolEntry["adapter"];
      readonly policy: "trusted-singleton-seed";
      readonly canonicalAddress?: string;
      readonly canonicalVenueId?: VenueId;
      readonly canonicalIdentitySource?: VenueIdentitySource;
      /** Custom IDs owned by this policy; known fast-path IDs need no redeclaration. */
      readonly registeredVenueIds?: readonly VenueId[];
      readonly registeredIdentitySources?: readonly VenueIdentitySource[];
      readonly legacyReason?: string;
    };

export class IdentityResolverRegistry {
  private readonly byPoolAdapter = new Map<PoolEntry["adapter"], IdentityResolverDescriptor>();
  private readonly isRoutePoolSupported: (poolAdapter: PoolEntry["adapter"]) => boolean;

  constructor(
    descriptors: readonly IdentityResolverDescriptor[],
    isRoutePoolSupported: (poolAdapter: PoolEntry["adapter"]) => boolean,
  ) {
    this.isRoutePoolSupported = isRoutePoolSupported;
    const registeredVenueIds = new Set<string>();
    const registeredIdentitySources = new Set<string>();
    for (const descriptor of descriptors) {
      assertDescriptorIds(descriptor, registeredVenueIds, registeredIdentitySources);
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

  supportsRoutePool(poolAdapter: string): boolean {
    return this.isRoutePoolSupported(poolAdapter as PoolEntry["adapter"]);
  }

  async resolveOnchain(
    descriptor: Extract<IdentityResolverDescriptor, { policy: "onchain-resolver" }>,
    context: OnchainIdentityResolverContext,
  ): Promise<PoolIdentityResult> {
    return this.validateResolution(descriptor, await descriptor.resolve(context));
  }

  validateResolution(
    descriptor: IdentityResolverDescriptor,
    result: PoolIdentityResult,
  ): PoolIdentityResult {
    if (!result.ok) {
      if (result.venueId !== undefined) {
        this.validateMetadata(descriptor, result.venueId);
      }
      return result;
    }
    if (!this.supportsRoutePool(result.adapter)) {
      throw new Error(
        `identity resolver registry: ${descriptor.poolAdapter} emitted unregistered pool adapter ` +
          result.adapter,
      );
    }
    this.validateMetadata(descriptor, result.venueId, result.identitySource);
    return result;
  }

  validateMetadata(
    descriptor: IdentityResolverDescriptor,
    venueId: VenueId,
    identitySource?: VenueIdentitySource,
  ): void {
    assertOwnedIdentityId(
      descriptor,
      "venue",
      venueId,
      isKnownVenueId,
      descriptor.registeredVenueIds ?? [],
    );
    if (identitySource === undefined) return;
    assertOwnedIdentityId(
      descriptor,
      "identity source",
      identitySource,
      isKnownVenueIdentitySource,
      descriptor.registeredIdentitySources ?? [],
    );
  }
}

function assertDescriptorIds(
  descriptor: IdentityResolverDescriptor,
  registeredVenueIds: Set<string>,
  registeredIdentitySources: Set<string>,
): void {
  if (!isNonemptyRegistryId(descriptor.poolAdapter)) {
    throw new Error("identity resolver registry: empty pool adapter id");
  }
  assertRegisteredIds(
    descriptor,
    "venue",
    descriptor.registeredVenueIds ?? [],
    isKnownVenueId,
    registeredVenueIds,
  );
  assertRegisteredIds(
    descriptor,
    "identity source",
    descriptor.registeredIdentitySources ?? [],
    isKnownVenueIdentitySource,
    registeredIdentitySources,
  );
  if (descriptor.policy !== "trusted-singleton-seed") return;
  if (descriptor.canonicalVenueId !== undefined) {
    assertOwnedIdentityId(
      descriptor,
      "venue",
      descriptor.canonicalVenueId,
      isKnownVenueId,
      descriptor.registeredVenueIds ?? [],
    );
  }
  if (descriptor.canonicalIdentitySource !== undefined) {
    assertOwnedIdentityId(
      descriptor,
      "identity source",
      descriptor.canonicalIdentitySource,
      isKnownVenueIdentitySource,
      descriptor.registeredIdentitySources ?? [],
    );
  }
}

function assertRegisteredIds(
  descriptor: IdentityResolverDescriptor,
  kind: string,
  values: readonly string[],
  isKnown: (value: unknown) => boolean,
  global: Set<string>,
): void {
  const local = new Set<string>();
  for (const value of values) {
    if (!isNonemptyRegistryId(value)) {
      throw new Error(
        `identity resolver registry: ${descriptor.poolAdapter} has empty ${kind} id`,
      );
    }
    if (isKnown(value)) {
      throw new Error(
        `identity resolver registry: ${descriptor.poolAdapter} redeclares known ${kind} ${value}`,
      );
    }
    if (local.has(value) || global.has(value)) {
      throw new Error(
        `identity resolver registry: duplicate registered ${kind} ${value}`,
      );
    }
    local.add(value);
    global.add(value);
  }
}

function assertOwnedIdentityId(
  descriptor: IdentityResolverDescriptor,
  kind: string,
  value: string,
  isKnown: (value: unknown) => boolean,
  registered: readonly string[],
): void {
  if (!isNonemptyRegistryId(value)) {
    throw new Error(
      `identity resolver registry: ${descriptor.poolAdapter} emitted empty ${kind} id`,
    );
  }
  if (!isKnown(value) && !registered.includes(value)) {
    throw new Error(
      `identity resolver registry: ${descriptor.poolAdapter} emitted unregistered ` +
        `${kind} ${value}`,
    );
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
  | "dodo_unregistered"
  | "erc4626_nonstandard"
  | "behavior_mismatch"
  | "untrusted_seed";

/**
 * Transport/read failures carry no negative identity proof and must remain
 * retryable. Every other reason above is a completed, fail-closed identity
 * decision for the current runtime configuration.
 */
export function isRetryablePoolIdentityFailure(
  reason: PoolIdentityFailureReason,
): boolean {
  return reason === "identity_call_failed";
}

export interface IdentityPoolEntry extends VenueIdentityMetadata {
  address: string;
  adapter: string;
  logicalInstanceId?: string;
  token0?: string;
  token1?: string;
  fixedTokenIn?: string;
  fixedTokenOut?: string;
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
const v2FactoryIface = new ethers.Interface([
  "function getPair(address tokenA,address tokenB) view returns (address)",
]);
const v3FactoryIface = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);
const v2IdentityIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const v3IdentityIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const curveMetaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
]);
const balancerV3VaultIface = new ethers.Interface([
  "function isPoolRegistered(address pool) view returns (bool)",
]);
const dodoPoolIface = new ethers.Interface([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
]);
const dodoFactoryIface = new ethers.Interface([
  "function getDODOPool(address baseToken,address quoteToken) view returns (address[] pools)",
]);
const erc4626IdentityIface = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
]);

/**
 * ERC4626 has no universal factory. Its code-owned identity root is the EIP-4626
 * interface itself, re-read at one pinned block. This only attests the family;
 * payout-token evidence remains a mandatory route-probe concern.
 */
export const erc4626IdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
}) => {
  if (poolAdapter !== "erc4626") {
    throw new Error(`erc4626 identity resolver: unsupported pool adapter ${poolAdapter}`);
  }
  if (!backend.getCode) return { ok: false, reason: "identity_call_failed" };
  try {
    const code = await backend.getCode(pool);
    if (code === "0x") return { ok: false, reason: "erc4626_nonstandard" };
    const assetRaw = await backend.call({
      to: pool,
      data: erc4626IdentityIface.encodeFunctionData("asset"),
    });
    const asset = ethers.getAddress(String(
      erc4626IdentityIface.decodeFunctionResult("asset", assetRaw)[0],
    ));
    if (asset === ethers.ZeroAddress || asset.toLowerCase() === pool.toLowerCase()) {
      return { ok: false, reason: "erc4626_nonstandard" };
    }
    const assetCode = await backend.getCode(asset);
    if (assetCode === "0x") return { ok: false, reason: "erc4626_nonstandard" };

    const probes: Array<[string, readonly unknown[]]> = [
      ["totalAssets", []],
      ["totalSupply", []],
      ["convertToShares", [1n]],
      ["convertToAssets", [1n]],
      ["previewDeposit", [1n]],
      ["previewRedeem", [1n]],
    ];
    for (const [fn, args] of probes) {
      const raw = await backend.call({
        to: pool,
        data: erc4626IdentityIface.encodeFunctionData(fn, args),
      });
      erc4626IdentityIface.decodeFunctionResult(fn, raw);
    }
    return {
      ok: true,
      adapter: "erc4626",
      venueId: "erc4626",
      identitySource: "erc4626-standard",
    };
  } catch (error) {
    return {
      ok: false,
      reason: isPermanentErc4626IdentityFailure(error)
        ? "erc4626_nonstandard"
        : "identity_call_failed",
    };
  }
};

function isPermanentErc4626IdentityFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set(["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT", "NUMERIC_FAULT"]).has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|could not decode|invalid (?:result|data|address)|unsupported operation/i
    .test(message);
}

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
    return options.identityRegistry.resolveOnchain(descriptor, {
      backend,
      pool,
      poolAdapter: descriptor.poolAdapter,
      candidate: { address: pool, adapter: descriptor.poolAdapter },
      admissionPolicy: policy,
      isPoolAdapterSupported: (candidate) => options.identityRegistry.supportsRoutePool(candidate),
    });
  }
  return options.identityRegistry.validateResolution(
    descriptor,
    resolveTrustedSingleton(descriptor, pool),
  );
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
        const resolved = options.identityRegistry.validateResolution(
          descriptor,
          resolveTrustedSingleton(descriptor, pool.address),
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
      const venueId = seed.venueId;
      if (venueId !== undefined) {
        options.identityRegistry.validateMetadata(descriptor, venueId, "seed");
      }
      return {
        accepted: {
          ...pool,
          venueId,
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
      pool,
      descriptor,
      options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION,
      options.identityRegistry,
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
  candidate: IdentityPoolEntry,
  descriptor: Extract<IdentityResolverDescriptor, { policy: "onchain-resolver" }>,
  admissionPolicy: IdentityAdmissionPolicy,
  identityRegistry: IdentityResolverRegistry,
): Promise<PoolIdentityResult> {
  const key = identityResolutionKey(candidate, descriptor, admissionPolicy);
  let pending = cache.resolutions.get(key);
  if (!pending) {
    const pool = ethers.getAddress(candidate.address);
    pending = identityRegistry.resolveOnchain(descriptor, {
      backend,
      pool,
      poolAdapter: descriptor.poolAdapter,
      candidate: { ...candidate, address: pool },
      admissionPolicy,
      isPoolAdapterSupported: (candidate) => identityRegistry.supportsRoutePool(candidate),
    });
    cache.resolutions.set(key, pending);
  }
  return pending;
}

function identityResolutionKey(
  candidate: IdentityPoolEntry,
  descriptor: Extract<IdentityResolverDescriptor, { policy: "onchain-resolver" }>,
  admissionPolicy: IdentityAdmissionPolicy,
): string {
  return JSON.stringify([
    ethers.getAddress(candidate.address).toLowerCase(),
    descriptor.poolAdapter,
    candidate.logicalInstanceId ?? null,
    candidate.token0?.toLowerCase() ?? null,
    candidate.token1?.toLowerCase() ?? null,
    candidate.fixedTokenIn?.toLowerCase() ?? null,
    candidate.fixedTokenOut?.toLowerCase() ?? null,
    allowProvisionalFactories(admissionPolicy),
    allowProvisionalCurveUnderlying(admissionPolicy),
  ]);
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
  candidate,
  admissionPolicy,
  isPoolAdapterSupported,
}) => {
  if (poolAdapter !== "univ2" && poolAdapter !== "univ3") {
    throw new Error(`factory identity resolver: unsupported pool adapter ${poolAdapter}`);
  }
  const standardPoolAdapter = poolAdapter === "univ2" ? "univ2" : "univ3";
  let factory: string;
  try {
    const raw = await backend.call({
      to: pool,
      data: factoryIface.encodeFunctionData("factory"),
    });
    const decoded = factoryIface.decodeFunctionResult("factory", raw);
    factory = ethers.getAddress(String(decoded[0]));
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }

  const identity = findVenueByFactory(factory);
  if (identity?.compatibility === "incompatible") {
    return {
      ok: false,
      reason: "unsupported_venue",
      venueId: identity.venue,
      factory,
    };
  }
  if (identity?.compatibility === "standard") {
    if (!isPoolAdapterSupported(identity.poolAdapter)) {
      return {
        ok: false,
        reason: "unsupported_venue",
        venueId: identity.venue,
        factory,
      };
    }
    const binding = identity.poolAdapter === "univ2"
      ? await proveStandardV2Behavior(
        backend,
        pool,
        factory,
        candidate,
      )
      : await proveCanonicalV3FactoryBinding(
        backend,
        pool,
        factory,
        candidate,
      );
    if (!binding.ok) {
      return {
        ok: false,
        reason: binding.reason,
        venueId: identity.venue,
        factory,
      };
    }
    return {
      ok: true,
      adapter: identity.poolAdapter,
      venueId: identity.venue,
      factory,
      identitySource: "factory-call",
    };
  }

  if (!allowProvisionalFactories(admissionPolicy)) {
    return { ok: false, reason: "unknown_factory", factory };
  }
  const behaviorProof = await proveProvisionalFactoryPoolBehavior(
    backend,
    pool,
    factory,
    standardPoolAdapter,
    candidate,
  );
  if (!behaviorProof.ok) {
    return {
      ok: false,
      reason: behaviorProof.reason,
      factory,
    };
  }
  // Factory is provenance, not a hard admission gate. Unknown factories must
  // nevertheless prove the complete standard V2/V3 read surface before they
  // can reuse one of those execution families.
  return {
    ok: true,
    adapter: poolAdapter,
    venueId: "unknown",
    factory,
    identitySource: "factory-call-provisional",
  };
};

async function proveCanonicalV3FactoryBinding(
  backend: IdentityCallBackend,
  pool: string,
  factory: string,
  candidate: Readonly<IdentityPoolEntry>,
): Promise<ProvisionalFactoryBehaviorProof> {
  let rawPool: readonly [string, string, string];
  try {
    rawPool = await Promise.all([
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("token0"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("token1"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("fee"),
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }
  if (
    !hasExactStaticReturnShape(rawPool[0], 1) ||
    !hasExactStaticReturnShape(rawPool[1], 1) ||
    !hasExactStaticReturnShape(rawPool[2], 1)
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }

  let token0: string;
  let token1: string;
  let fee: bigint;
  try {
    token0 = ethers.getAddress(String(
      v3IdentityIface.decodeFunctionResult("token0", rawPool[0])[0],
    ));
    token1 = ethers.getAddress(String(
      v3IdentityIface.decodeFunctionResult("token1", rawPool[1])[0],
    ));
    fee = BigInt(v3IdentityIface.decodeFunctionResult("fee", rawPool[2])[0]);
  } catch {
    return { ok: false, reason: "behavior_mismatch" };
  }
  if (
    fee < 0n ||
    fee > 0xffffffn ||
    !tokensProveCandidatePair(token0, token1, candidate)
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }

  const [tokenA, tokenB] = sortTokenPair(token0, token1);
  try {
    const rawBinding = await backend.call({
      to: factory,
      data: v3FactoryIface.encodeFunctionData("getPool", [
        tokenA,
        tokenB,
        fee,
      ]),
    });
    if (!hasExactStaticReturnShape(rawBinding, 1)) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const boundPool = ethers.getAddress(String(
      v3FactoryIface.decodeFunctionResult("getPool", rawBinding)[0],
    ));
    return boundPool === ethers.getAddress(pool)
      ? { ok: true }
      : { ok: false, reason: "behavior_mismatch" };
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }
}

type ProvisionalFactoryBehaviorProof =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: Extract<
        PoolIdentityFailureReason,
        "identity_call_failed" | "behavior_mismatch"
      >;
    };

async function proveProvisionalFactoryPoolBehavior(
  backend: IdentityCallBackend,
  pool: string,
  factory: string,
  poolAdapter: "univ2" | "univ3",
  candidate: Readonly<IdentityPoolEntry>,
): Promise<ProvisionalFactoryBehaviorProof> {
  return poolAdapter === "univ2"
    ? proveStandardV2Behavior(backend, pool, factory, candidate)
    : proveProvisionalV3Behavior(backend, pool, candidate);
}

async function proveStandardV2Behavior(
  backend: IdentityCallBackend,
  pool: string,
  factory: string,
  candidate: Readonly<IdentityPoolEntry>,
): Promise<ProvisionalFactoryBehaviorProof> {
  let raw: readonly [string, string, string];
  try {
    raw = await Promise.all([
      backend.call({
        to: pool,
        data: v2IdentityIface.encodeFunctionData("token0"),
      }),
      backend.call({
        to: pool,
        data: v2IdentityIface.encodeFunctionData("token1"),
      }),
      backend.call({
        to: pool,
        data: v2IdentityIface.encodeFunctionData("getReserves"),
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }
  if (
    !hasExactStaticReturnShape(raw[0], 1) ||
    !hasExactStaticReturnShape(raw[1], 1) ||
    !hasExactStaticReturnShape(raw[2], 3)
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }
  try {
    const token0 = ethers.getAddress(String(
      v2IdentityIface.decodeFunctionResult("token0", raw[0])[0],
    ));
    const token1 = ethers.getAddress(String(
      v2IdentityIface.decodeFunctionResult("token1", raw[1])[0],
    ));
    v2IdentityIface.decodeFunctionResult("getReserves", raw[2]);
    if (!tokensProveCandidatePair(token0, token1, candidate)) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const rawBinding = await backend.call({
      to: factory,
      data: v2FactoryIface.encodeFunctionData("getPair", [token0, token1]),
    });
    if (!hasExactStaticReturnShape(rawBinding, 1)) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const boundPool = ethers.getAddress(String(
      v2FactoryIface.decodeFunctionResult("getPair", rawBinding)[0],
    ));
    return boundPool === ethers.getAddress(pool)
      ? { ok: true }
      : { ok: false, reason: "behavior_mismatch" };
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }
}

async function proveProvisionalV3Behavior(
  backend: IdentityCallBackend,
  pool: string,
  candidate: Readonly<IdentityPoolEntry>,
): Promise<ProvisionalFactoryBehaviorProof> {
  let raw: readonly [string, string, string, string, string, string];
  try {
    raw = await Promise.all([
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("token0"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("token1"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("fee"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("tickSpacing"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("slot0"),
      }),
      backend.call({
        to: pool,
        data: v3IdentityIface.encodeFunctionData("liquidity"),
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: provisionalBehaviorCallFailureReason(error),
    };
  }
  if (
    !hasExactStaticReturnShape(raw[0], 1) ||
    !hasExactStaticReturnShape(raw[1], 1) ||
    !hasExactStaticReturnShape(raw[2], 1) ||
    !hasExactStaticReturnShape(raw[3], 1) ||
    !hasExactStaticReturnShape(raw[4], 7) ||
    !hasExactStaticReturnShape(raw[5], 1)
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }
  try {
    const token0 = ethers.getAddress(String(
      v3IdentityIface.decodeFunctionResult("token0", raw[0])[0],
    ));
    const token1 = ethers.getAddress(String(
      v3IdentityIface.decodeFunctionResult("token1", raw[1])[0],
    ));
    v3IdentityIface.decodeFunctionResult("fee", raw[2]);
    const tickSpacing = BigInt(
      v3IdentityIface.decodeFunctionResult("tickSpacing", raw[3])[0],
    );
    // sqrtPriceX96 may legitimately be zero before initialization. Requiring
    // exact successful decoding, rather than a positive value, distinguishes
    // that state from a selector lookalike or a reverting fake pool.
    v3IdentityIface.decodeFunctionResult("slot0", raw[4]);
    v3IdentityIface.decodeFunctionResult("liquidity", raw[5]);
    return tickSpacing > 0n && tokensProveCandidatePair(token0, token1, candidate)
      ? { ok: true }
      : { ok: false, reason: "behavior_mismatch" };
  } catch {
    return { ok: false, reason: "behavior_mismatch" };
  }
}

function hasExactStaticReturnShape(raw: string, words: number): boolean {
  try {
    return ethers.isHexString(raw) && ethers.dataLength(raw) === words * 32;
  } catch {
    return false;
  }
}

/**
 * A canonical eth_call revert at the pinned identity block is negative
 * behavior evidence: a standard V2/V3 pool must expose these view methods.
 * Transport, deadline, and provider failures remain retryable. Do not infer
 * this distinction from error text.
 */
function provisionalBehaviorCallFailureReason(
  error: unknown,
): "identity_call_failed" | "behavior_mismatch" {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  return new Set([
      "CALL_EXCEPTION",
      "BAD_DATA",
      "INVALID_ARGUMENT",
      "NUMERIC_FAULT",
    ]).has(code)
    ? "behavior_mismatch"
    : "identity_call_failed";
}

function tokensProveCandidatePair(
  token0: string,
  token1: string,
  candidate: Readonly<IdentityPoolEntry>,
): boolean {
  if (token0.toLowerCase() === token1.toLowerCase()) return false;
  try {
    if (
      candidate.token0 !== undefined &&
      token0 !== ethers.getAddress(candidate.token0)
    ) {
      return false;
    }
    if (
      candidate.token1 !== undefined &&
      token1 !== ethers.getAddress(candidate.token1)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sortTokenPair(token0: string, token1: string): readonly [string, string] {
  return BigInt(token0) < BigInt(token1)
    ? [token0, token1]
    : [token1, token0];
}

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
    } catch (error) {
      return {
        ok: false,
        reason: isCurveUnderlyingMetadataNotApplicableError(error)
          ? allowProvisional
            ? "behavior_mismatch"
            : "curve_unregistered"
          : "identity_call_failed",
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
  } catch (error) {
    return {
      ok: false,
      reason: isCurveRegistryMiss(error)
        ? "curve_unregistered"
        : "identity_call_failed",
      venueId: "curve",
    };
  }
};

function isCurveRegistryMiss(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (code === "CALL_EXCEPTION") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted(?:: no registry)?|\\bno registry\\b/i.test(message);
}

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

export const dodoV2IdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  isPoolAdapterSupported,
}) => {
  if (poolAdapter !== "dodo-v2") {
    throw new Error(`DODO V2 identity resolver: unsupported pool adapter ${poolAdapter}`);
  }

  let baseToken: string;
  let quoteToken: string;
  try {
    const [baseRaw, quoteRaw] = await Promise.all([
      backend.call({ to: pool, data: dodoPoolIface.encodeFunctionData("_BASE_TOKEN_") }),
      backend.call({ to: pool, data: dodoPoolIface.encodeFunctionData("_QUOTE_TOKEN_") }),
    ]);
    baseToken = ethers.getAddress(String(
      dodoPoolIface.decodeFunctionResult("_BASE_TOKEN_", baseRaw)[0],
    ));
    quoteToken = ethers.getAddress(String(
      dodoPoolIface.decodeFunctionResult("_QUOTE_TOKEN_", quoteRaw)[0],
    ));
    if (
      baseToken === ethers.ZeroAddress ||
      quoteToken === ethers.ZeroAddress ||
      baseToken === quoteToken
    ) {
      return { ok: false, reason: "identity_call_failed", venueId: "dodo-v2" };
    }
  } catch {
    return { ok: false, reason: "identity_call_failed", venueId: "dodo-v2" };
  }

  const identity = findVenueIdentity("dodo-v2");
  if (
    identity?.discovery.mode !== "pool-registry" ||
    identity.compatibility !== "standard" ||
    identity.poolAdapter !== "dodo-v2" ||
    !isPoolAdapterSupported(identity.poolAdapter)
  ) {
    return { ok: false, reason: "unsupported_venue", venueId: "dodo-v2" };
  }
  const registries = identity.discovery.registries;
  let successfulCalls = 0;
  for (const registry of registries) {
    try {
      const factory = ethers.getAddress(registry);
      const raw = await backend.call({
        to: factory,
        data: dodoFactoryIface.encodeFunctionData("getDODOPool", [baseToken, quoteToken]),
      });
      const pools = Array.from(
        dodoFactoryIface.decodeFunctionResult("getDODOPool", raw)[0] as readonly string[],
      ).map((candidate) => ethers.getAddress(candidate));
      successfulCalls++;
      if (!pools.some((candidate) => candidate === pool)) continue;

      const capability = findVenueByPoolRegistry(factory);
      if (
        !capability ||
        capability.compatibility !== "standard" ||
        capability.poolAdapter !== "dodo-v2" ||
        !isPoolAdapterSupported(capability.poolAdapter)
      ) {
        return { ok: false, reason: "unsupported_venue", venueId: "dodo-v2", factory };
      }
      return {
        ok: true,
        adapter: "dodo-v2",
        venueId: "dodo-v2",
        factory,
        identitySource: "dodo-factory-registry",
      };
    } catch {
      // A failed registry call does not invalidate a listing in another canonical registry.
    }
  }
  return successfulCalls === 0
    ? { ok: false, reason: "identity_call_failed", venueId: "dodo-v2" }
    : { ok: false, reason: "dodo_unregistered", venueId: "dodo-v2" };
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
