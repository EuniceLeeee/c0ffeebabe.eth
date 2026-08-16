import { ethers } from "ethers";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import {
  executeAdapterFamilyLifecycleBatch,
  executeCreditFamilyInstanceLifecycle,
} from "./venues/adapter-family-runtime.js";
import type { LoadedFamilyPlugin } from
  "./venues/family-capability-catalog.js";
import {
  executeCatalogCaptureNominations,
  executeCatalogReverseBindings,
} from "./venues/capture-materialization.js";
import { createStrictCentralAdapterRuntime } from
  "./strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from
  "./venues/production-verified-actors.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Strict Pool B replacement for the legacy IdentityResolverRegistry
 * attestation: each candidate pool is re-observed at the canonical source
 * (code hash + EIP-1967 word read through the central runtime), matched
 * against the generated catalog, and admitted only when the owning plugin's
 * identity stage issues a verified identity. The legacy cache/registry never
 * supplies an admission credential; the strict lifecycle re-derives it.
 */
export interface StrictIdentityProvider {
  call(
    transaction: { readonly to: string; readonly data: string },
    blockTag: number,
  ): Promise<string>;
  getCode(address: string, blockTag: number): Promise<string>;
  getStorage(
    address: string,
    slot: string,
    blockTag: number,
  ): Promise<string>;
  /**
   * Optional nomination capabilities, passed through to plugin-owned
   * nomination (recent-log reverse lookup, tx seed). Absent means the
   * nomination falls back to the fail-closed empty implementation; the
   * plugin then keeps candidates unresolved instead of fabricating
   * evidence.
   */
  getLogs?(filter: {
    readonly address?: string;
    readonly fromBlock?: number;
    readonly toBlock?: number;
    readonly topics?: readonly (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
  getTransactionReceipt?(transactionHash: string): Promise<{
    readonly blockNumber?: number;
    readonly logs: readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[];
  } | null>;
  traceTransaction?(transactionHash: string): Promise<unknown>;
}

export type StrictAttestedPool<Pool extends {
  readonly address: string;
  readonly adapter?: string;
} = { readonly address: string; readonly adapter?: string }> = Pool & {
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly subject: string;
  /** Legacy-compatible adapter label for the transition bridge only. */
  readonly adapter: string;
  readonly venueId?: string;
  readonly identitySource: string;
}

export type StrictRejectedPool<Pool extends {
  readonly address: string;
  readonly adapter?: string;
}> = Pool & {
  readonly adapter: string;
  readonly reason: string;
};

export async function attestPoolIdentitiesStrict<
  Pool extends { readonly address: string; readonly adapter?: string },
>(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly provider: StrictIdentityProvider;
  readonly runtime: CentralAdapterRuntime;
  readonly source: CanonicalSource;
  readonly pools: readonly Pool[];
  /**
   * Maps a verified identity lineage back to the legacy adapter/venue
   * labels consumed by still-legacy planner/solver call sites during the
   * transition. Returns null when no legacy label exists (family is
   * strict-only); the pool is then still accepted with its strict labels.
   */
  readonly adapterForLineage?: (lineageId: string) => {
    readonly adapter: string;
    readonly venueId?: string;
  } | null;
  /**
   * Central evidence-channel order for this attestation batch. Default
   * "nominate-first" keeps fresh discovery on the plugin nomination channel
   * (recent observation / trace evidence). "reverse-binding-first" runs the
   * retain channel first (cold-pool reverse binding from chain truth) and
   * only falls through to fresh nomination when the retain channel produced
   * no admissible observation — the central retained-attestation strategy.
   * The plugin never decides this order.
   */
  readonly channelOrder?: "reverse-binding-first" | "nominate-first";
}): Promise<{
  readonly accepted: readonly StrictAttestedPool<Pool>[];
  readonly rejected: readonly StrictRejectedPool<Pool>[];
}> {
  const accepted: (StrictAttestedPool<Pool> | null)[] =
    new Array(input.pools.length).fill(null);
  const rejected: (StrictRejectedPool<Pool> | null)[] =
    new Array(input.pools.length).fill(null);
  const total = input.pools.length;
  const startedAtMs = Date.now();
  // Generic bounded concurrency: startup universe/retained sets are tens of
  // thousands of rows and each row performs multiple provider round-trips;
  // serial attestation would take hours. Per-row error isolation and result
  // ordering are preserved; there is no per-family branch here.
  const ATTESTATION_CONCURRENCY = 24;
  let completed = 0;
  let next = 0;
  // One stable nomination provider for the whole batch: plugin-owned
  // source-keyed caches (e.g. a manager-wide swap index) key on provider
  // identity, so a fresh wrapper per pool would rebuild the index for every
  // row. The provider closes over the same underlying reads for all rows.
  const nominationProvider = Object.freeze({
    call: (transaction: { readonly to: string; readonly data: string }, blockTag?: number) =>
      input.provider.call(transaction, blockTag ?? input.source.number),
    getCode: (a: string, blockTag?: number) =>
      input.provider.getCode(a, blockTag ?? input.source.number),
    getStorage: (a: string, s: string, blockTag?: number) =>
      input.provider.getStorage(a, s, blockTag ?? input.source.number),
    // Nomination capabilities are passed through when the caller supplies
    // them (recent-log reverse lookup, tx seed); absent means fail-closed
    // empty implementations.
    getLogs: input.provider.getLogs === undefined
      ? async () => Object.freeze([])
      : (filter: {
          readonly address?: string;
          readonly fromBlock?: number;
          readonly toBlock?: number;
          readonly topics?: readonly (string | null)[];
        }) => input.provider.getLogs!(filter),
    getTransactionReceipt:
      input.provider.getTransactionReceipt === undefined
      ? async () => null
      : (hash: string) => input.provider.getTransactionReceipt!(hash),
    ...(input.provider.traceTransaction === undefined
      ? {}
      : {
          traceTransaction: (hash: string) =>
            input.provider.traceTransaction!(hash),
        }),
  });
  const processPool = async (index: number): Promise<void> => {
    const pool = input.pools[index];
    const address = ethers.getAddress(pool.address);
    try {
      // Universal fact check (no protocol semantics): an address with no
      // deployed code cannot carry an on-chain identity observation.
      const deployed = await input.provider.getCode(address, input.source.number);
      if (!ethers.isHexString(deployed) || deployed === "0x") {
        rejected[index] = { ...pool, adapter: pool.adapter ?? "", reason: "no deployed code" };
        return;
      }
      // Observation materialization is plugin-owned: run the catalog-issued
      // capability for this single pool (address + opaque adapter label).
      // The central evidence-channel order decides whether the retain
      // channel (cold-pool reverse binding from chain truth) runs before
      // the fresh nomination channel (recent log / trace evidence); the
      // plugin never decides this order. No protocol semantics here.
      const nominations = Object.freeze([Object.freeze({
        address,
        // Pool entry fields (adapter, poolId, factory, tokens, ...) ride in
        // the plugin-owned opaque payload; the framework does not interpret
        // any of them, the owning plugin's nomination consumes what it
        // declares. Zero protocol semantics in central paths.
        opaque: Object.freeze(entryOpaque(pool)) as never,
      })]);
      let observations: readonly UnifiedObservation[];
      if (input.channelOrder === "reverse-binding-first") {
        // Retain channel first: reverse binding needs no recent activity and
        // is the cheap chain-truth path for retained rows. Fall through to
        // the fresh nomination channel only when it produced no admissible
        // observation (explicit unsupported / failed / no match).
        observations = await executeCatalogReverseBindings({
          catalog: input.catalog,
          source: input.source,
          nominations,
          provider: nominationProvider,
        });
        if (observations.length === 0) {
          observations = await executeCatalogCaptureNominations({
            catalog: input.catalog,
            source: input.source,
            nominations,
            provider: nominationProvider,
          });
        }
      } else {
        observations = await executeCatalogCaptureNominations({
          catalog: input.catalog,
          source: input.source,
          nominations,
          provider: nominationProvider,
        });
      }
      let observation: UnifiedObservation | undefined = observations[0];
      if (observation === undefined) {
        // Central generic fallback (no per-family logic): when the plugin
        // nomination produced no observation (e.g. a cold pool with no Swap
        // in the retained window), re-materialize the address surface from
        // deployed code plus every catalog-declared interface fingerprint.
        // Catalog matching + chain reverse verification still decide
        // admission; the fallback is provenance, never an allowlist.
        observation = await centralAddressSurfaceFallback(
          input.catalog,
          input.provider,
          input.source,
          address,
          pool.adapter,
          entryOpaque(pool),
        );
        if (observation === undefined) {
          rejected[index] = { ...pool, adapter: pool.adapter ?? "", reason: "no_catalog_match" };
          return;
        }
      }
      const matches = input.catalog.matches(observation);
      if (matches.length === 0) {
        rejected[index] = { ...pool, adapter: pool.adapter ?? "", reason: "no_catalog_match" };
        return;
      }
      // Prefer the family hinted by the pool's adapter label, else the first
      // catalog match.
      const target = matchFor(input, pool, matches);
      if (target === null) {
        rejected[index] = { ...pool, adapter: pool.adapter ?? "", reason: "no_matching_family" };
        return;
      }
      const family = input.catalog.forStrictFamily(target.familyId);
      if (family.plugin.manifest.domain === "credit") {
        // Credit families have their own instance lifecycle (identity +
        // instance only, no route publication). The central framework runs
        // the catalog-issued credit capability; no credit semantics here.
        const creditResult = await executeCreditFamilyInstanceLifecycle({
          family,
          match: Object.freeze({
            matchedPatternId: target.patternId,
            observation,
          }),
          source: input.source,
          generation: input.source.generation,
          runtime: input.runtime,
        });
        if (creditResult.instance === null) {
          const rejection = creditResult.outcomes.find((outcome) =>
            outcome.stage === "identity" &&
            outcome.status === "rejected"
          );
          const anyIdentity = creditResult.outcomes.find((outcome) =>
            outcome.stage === "identity"
          );
          rejected[index] = {
            ...pool,
            adapter: pool.adapter ?? "",
            reason: rejection === undefined
              ? anyIdentity === undefined
                ? "identity_unverified:no-outcome"
                : `identity_unverified:${anyIdentity.status}:${anyIdentity.reasonCode ?? "no-reason"}`
              : `identity_rejected:${rejection.reasonCode ?? "no-reason"}`,
          };
          return;
        }
        const lineageId = creditResult.instance.lineageId;
        const legacy = input.adapterForLineage?.(lineageId) ?? null;
        accepted[index] = Object.freeze({
          ...pool,
          familyId: target.familyId,
          lineageId,
          subject: address,
          adapter: legacy?.adapter ?? pool.adapter ?? String(target.familyId),
          ...(legacy?.venueId === undefined
            ? {}
            : { venueId: legacy.venueId }),
          identitySource: "strict-lifecycle",
        });
        return;
      }
      const result = await executeAdapterFamilyLifecycleBatch({
        family: family as unknown as LoadedFamilyPlugin,
        matches: Object.freeze([Object.freeze({
          matchedPatternId: target.patternId,
          observation,
        })]),
        source: input.source,
        generation: input.source.generation,
        runtime: input.runtime,
        publisher: { publish: () => undefined },
      });
      const identityOutcome = result.outcomes.find((outcome) =>
        outcome.stage === "identity" &&
        outcome.status === "verified"
      );
      if (identityOutcome === undefined) {
        const rejection = result.outcomes.find((outcome) =>
          outcome.stage === "identity" &&
          outcome.status === "rejected"
        );
        const anyIdentity = result.outcomes.find((outcome) =>
          outcome.stage === "identity"
        );
        rejected[index] = {
          ...pool,
          adapter: pool.adapter ?? "",
          reason: rejection === undefined
            ? anyIdentity === undefined
              ? "identity_unverified:no-outcome"
              : `identity_unverified:${anyIdentity.status}:${
                  anyIdentity.reasonCode ?? "no-reason"
                }`
            : `identity_rejected:${rejection.reasonCode ?? "no-reason"}`,
        };
        return;
      }
      const lineageId = identityOutcome.lineageId ?? "";
      const legacy = input.adapterForLineage?.(lineageId) ?? null;
      accepted[index] = Object.freeze({
        ...pool,
        familyId: target.familyId,
        lineageId,
        subject: address,
        // The legacy adapter label comes from the lineage projection; when
        // absent, keep the candidate's own pool adapter label so downstream
        // consumers that key on pool adapters (e.g. protocol discovery's
        // poolAdapters admission) still match.
        adapter: legacy?.adapter ?? pool.adapter ?? String(target.familyId),
        ...(legacy?.venueId === undefined
          ? {}
          : { venueId: legacy.venueId }),
        identitySource: "strict-lifecycle",
      });
    } catch (error) {
      rejected[index] = {
        ...pool,
        adapter: pool.adapter ?? "",
        reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      };
    } finally {
      completed += 1;
      if (completed % 500 === 0) {
        console.log(
          `[pool-universe] strict attestation ${completed}/${total} ` +
            `elapsedMs=${Date.now() - startedAtMs}`,
        );
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(ATTESTATION_CONCURRENCY, Math.max(1, total)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= total) break;
        await processPool(index);
      }
    },
  );
  await Promise.all(workers);
  return {
    accepted: Object.freeze(
      accepted.filter((item): item is StrictAttestedPool<Pool> => item !== null),
    ),
    rejected: rejected.filter(
      (item): item is StrictRejectedPool<Pool> => item !== null,
    ),
  } as const;
}

/**
 * Batch entry used by main.ts startup: attests four pool sets (pinned warm,
 * universe, blockscan universe, blockscan overrides) through the strict
 * identity stage with one provider-backed runtime. Returns one result per
 * set, in input order.
 */
export async function attestStartupPoolSetsStrict<
  Pool extends { readonly address: string; readonly adapter?: string },
>(input: {
  readonly provider: StrictIdentityProvider;
  readonly source: CanonicalSource;
  readonly poolSets: readonly (readonly Pool[])[];
}): Promise<readonly {
  readonly accepted: readonly StrictAttestedPool<Pool>[];
  readonly rejected: readonly StrictRejectedPool<Pool>[];
}[]> {
  const runtime = createMinimalIdentityRuntime(input.provider);
  const results: {
    readonly accepted: readonly StrictAttestedPool<Pool>[];
    readonly rejected: readonly StrictRejectedPool<Pool>[];
  }[] = [];
  for (const pools of input.poolSets) {
    results.push(await attestPoolIdentitiesStrict({
      catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      provider: input.provider,
      runtime,
      source: input.source,
      pools,
      adapterForLineage: (lineageId) => legacyLabelsForLineage(lineageId),
    }));
  }
  return Object.freeze(results);
}

function legacyLabelsForLineage(lineageId: string): {
  readonly adapter: string;
  readonly venueId?: string;
} | null {
  const familyId = lineageId.split(":")[0];
  if (familyId === undefined || familyId === "") return null;
  try {
    const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(familyId as never);
    // The legacy universe pool row keys on the family's declared
    // pool-adapter label (plugin-owned manifest field), not the action
    // adapter id; fall back to the action adapter only when the family
    // declares no pool adapter label.
    const poolAdapters = family.plugin.manifest.poolAdapterIds ?? [];
    const label = poolAdapters[0] ??
      family.plugin.manifest.ownedActionAdapterIds[0];
    return {
      adapter: label ?? String(familyId),
      ...(label === undefined
        ? {}
        : { venueId: label }),
    };
  } catch {
    return null;
  }
}

function createMinimalIdentityRuntime(
  provider: StrictIdentityProvider,
): CentralAdapterRuntime {
  return createStrictCentralAdapterRuntime({
    provider,
    generationFence: Object.freeze({
      kind: "catalog-relative" as const,
      assertCurrent: () => undefined,
      verifyCanonicalSource: () => true,
    }),
    // Family-declared verified-actor callers (evidence id -> probe actor)
    // bind through the same central authority as production; families that
    // declare none stay fail-closed.
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
  });
}

/**
 * Copies the pool entry's own fields into the plugin-owned opaque payload
 * (adapter label, poolId, factory, tokens, ...). The framework copies
 * verbatim without interpreting any field; the owning plugin's nomination
 * consumes the subset it declares. No protocol semantics in central paths.
 */
/**
 * Central generic cold-pool fallback: re-materialize an address-surface
 * observation from deployed code plus every catalog-declared interface
 * fingerprint (dynamic enumeration over the catalog; no per-family list in
 * central code). Admission still runs through catalog matching and the
 * family lifecycle identity stage; this only supplies the observation.
 */
export async function centralAddressSurfaceFallback(
  catalog: FamilyCapabilityCatalog,
  provider: StrictIdentityProvider,
  source: CanonicalSource,
  address: string,
  adapterHint?: string,
  opaque?: Readonly<Record<string, unknown>>,
): Promise<UnifiedObservation | undefined> {
  const code = await provider.getCode(address, source.number);
  if (!ethers.isHexString(code) || code === "0x") return undefined;
  // Collect interface fingerprints only from the family that owns the
  // pool-adapter hint (plugin-declared manifest field). Without an owner
  // the fallback stays fail-closed instead of guessing a family: the
  // observation must match the family that will verify identity.
  const fingerprints: string[] = [];
  if (adapterHint !== undefined) {
    let familyId: FamilyId;
    try {
      familyId = catalog.ownerOfPoolAdapter(adapterHint);
    } catch {
      return undefined;
    }
    const family = catalog.forStrictFamily(familyId);
    if (!("discovery" in family.plugin)) return undefined;
    for (const surface of family.plugin.discovery.addressSurfaces ?? []) {
      if (surface.kind === "interface") fingerprints.push(surface.fingerprint);
    }
  }
  if (fingerprints.length === 0) return undefined;
  return Object.freeze({
    kind: "address-surface" as const,
    source,
    address: ethers.getAddress(address).toLowerCase(),
    codeHash: ethers.keccak256(code).toLowerCase(),
    implementationWord: ethers.zeroPadValue("0x", 32).toLowerCase(),
    interfaceFingerprints: Object.freeze([...new Set(fingerprints)]),
    ...(opaque === undefined ? {} : { opaque }),
  } as never);
}

function entryOpaque(pool: { readonly address: string; readonly adapter?: string }): Record<string, unknown> {
  const opaque: Record<string, unknown> = {};
  if (pool.adapter !== undefined) {
    opaque.adapter = pool.adapter;
    opaque.adapterId = pool.adapter;
  }
  for (const [key, value] of Object.entries(pool)) {
    if (key === "address" || key === "adapter") continue;
    if (value === undefined) continue;
    opaque[key] = value;
  }
  return opaque;
}

function matchFor(
  input: {
    readonly catalog: FamilyCapabilityCatalog;
  },
  pool: { readonly address: string; readonly adapter?: string },
  matches: readonly { readonly familyId: FamilyId; readonly patternId: string }[],
): { readonly familyId: FamilyId; readonly patternId: string } | null {
  if (pool.adapter !== undefined) {
    // Prefer the family that owns the pool-adapter label (plugin-declared
    // manifest field; catalog-projected, never a central label table),
    // then the action-owner hint, then the first catalog match.
    try {
      const familyId = input.catalog.ownerOfPoolAdapter(pool.adapter);
      const match = matches.find((candidate) => candidate.familyId === familyId);
      if (match !== undefined) return match;
    } catch {
      // fall through to action-owner hint
    }
    try {
      const familyId = input.catalog.ownerOfAction(pool.adapter);
      const match = matches.find((candidate) => candidate.familyId === familyId);
      if (match !== undefined) return match;
    } catch {
      // fall through to first match
    }
  }
  return matches[0] ?? null;
}


/**
 * F6 Pair B: shared strict attestation entry for the still-legacy discovery
 * consumers (active-pool-discovery, live-discovery-coordinator,
 * build-active-pool-universe). Accepts an ethers-shaped read provider pinned
 * by the caller, resolves the canonical source hash for the given block, and
 * runs the same catalog + plugin lifecycle attestation as startup. The
 * framework only executes catalog-issued capabilities; no protocol semantics.
 */
export async function attestPoolsStrictFromProvider<Pool extends {
  readonly address: string;
  readonly adapter?: string;
}>(input: {
  readonly provider: {
    call(transaction: { readonly to: string; readonly data: string }, blockTag?: number): Promise<string>;
    getCode(address: string, blockTag?: number): Promise<string>;
    getStorage(address: string, slot: string, blockTag?: number): Promise<string>;
    getLogs?(filter: {
      readonly address?: string;
      readonly fromBlock?: number;
      readonly toBlock?: number;
      readonly topics?: readonly (string | null)[];
    }): Promise<readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[]>;
    getTransactionReceipt?(transactionHash: string): Promise<{
      readonly blockNumber?: number;
      readonly logs: readonly {
        readonly address: string;
        readonly topics: readonly string[];
        readonly data: string;
        readonly transactionHash?: string;
      }[];
    } | null>;
    traceTransaction?(transactionHash: string): Promise<unknown>;
  };
  readonly blockNumber: number;
  readonly pools: readonly Pool[];
  /**
   * Central evidence-channel order (see attestPoolIdentitiesStrict).
   * Retained re-attestation passes "reverse-binding-first" (retain channel
   * from chain truth before fresh nomination); fresh discovery keeps the
   * default "nominate-first".
   */
  readonly channelOrder?: "reverse-binding-first" | "nominate-first";
  /**
   * F8: production-shaped runtime for identity attestation. Defaults to the
   * minimal provider runtime; families whose identity needs an
   * effect-delta simulation transport (erc4626/fluid/silo/self-burn) stay
   * fail-closed unless the caller supplies a runtime with the production
   * revm simulation transport.
   */
  readonly runtime?: CentralAdapterRuntime;
}): Promise<{
  readonly accepted: readonly StrictAttestedPool<Pool>[];
  readonly rejected: readonly StrictRejectedPool<Pool>[];
}> {
  const provider = input.provider as unknown as StrictIdentityProvider;
  const hash = await readBlockHash(provider, input.blockNumber);
  return attestPoolIdentitiesStrict({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    provider,
    runtime: input.runtime ?? createMinimalIdentityRuntime(provider),
    source: Object.freeze({
      number: input.blockNumber,
      hash,
      generation: input.blockNumber,
    }),
    pools: input.pools,
    adapterForLineage: (lineageId) => legacyLabelsForLineage(lineageId),
    ...(input.channelOrder === undefined
      ? {}
      : { channelOrder: input.channelOrder }),
  });
}

async function readBlockHash(
  provider: StrictIdentityProvider,
  blockNumber: number,
): Promise<string> {
  // The strict provider shape has no getBlock; use the call surface via
  // eth_getBlockByNumber through the provider's raw transport when present.
  const raw = (provider as unknown as {
    send?(method: string, params: unknown[]): Promise<unknown>;
  });
  if (raw.send !== undefined) {
    const block = await raw.send("eth_getBlockByNumber", [
      ethers.toQuantity(blockNumber),
      false,
    ]);
    const record = block as { readonly hash?: string } | null;
    if (record !== null && typeof record?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.hash)) {
      return record.hash.toLowerCase();
    }
  }
  // Last-resort canonical placeholder: an all-zero hash fails any source
  // binding downstream, so callers must provide a hash-capable provider.
  return "0x" + "0".repeat(64);
}
