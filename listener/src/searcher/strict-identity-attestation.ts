import { ethers } from "ethers";
import type {
  FamilyCapabilityCatalog,
} from "./venues/family-capability-catalog.js";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import {
  executeAdapterFamilyLifecycleBatch,
} from "./venues/adapter-family-runtime.js";
import { executeCatalogCaptureNominations } from
  "./venues/capture-materialization.js";
import { createStrictCentralAdapterRuntime } from
  "./strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";

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
}): Promise<{
  readonly accepted: readonly StrictAttestedPool<Pool>[];
  readonly rejected: readonly StrictRejectedPool<Pool>[];
}> {
  const accepted: StrictAttestedPool<Pool>[] = [];
  const rejected: StrictRejectedPool<Pool>[] = [];
  for (const pool of input.pools) {
    const address = ethers.getAddress(pool.address);
    try {
      // Universal fact check (no protocol semantics): an address with no
      // deployed code cannot carry an on-chain identity observation.
      const deployed = await input.provider.getCode(address, input.source.number);
      if (!ethers.isHexString(deployed) || deployed === "0x") {
        rejected.push({ ...pool, adapter: pool.adapter ?? "", reason: "no deployed code" });
        continue;
      }
      // Observation materialization is plugin-owned: run the catalog-issued
      // nomination capability for this single pool (address + opaque adapter
      // label). The plugin re-materializes the observation it declares
      // (address-surface probe, recent log reverse lookup, or tx seed); the
      // framework only executes and admits. No protocol semantics here.
      const observations = await executeCatalogCaptureNominations({
        catalog: input.catalog,
        source: input.source,
        nominations: Object.freeze([Object.freeze({
          address,
          opaque: Object.freeze({
            ...(pool.adapter === undefined ? {} : { adapter: pool.adapter }),
            ...(pool.adapter === undefined ? {} : { adapterId: pool.adapter }),
          }),
        })]),
        provider: Object.freeze({
          call: (transaction: { readonly to: string; readonly data: string }, blockTag?: number) =>
            input.provider.call(transaction, blockTag ?? 0),
          getCode: (a: string, blockTag?: number) =>
            input.provider.getCode(a, blockTag ?? 0),
          getStorage: (a: string, s: string, blockTag?: number) =>
            input.provider.getStorage(a, s, blockTag ?? 0),
          getLogs: async () => Object.freeze([]),
          getTransactionReceipt: async () => null,
        }),
      });
      const observation = observations[0];
      if (observation === undefined) {
        rejected.push({ ...pool, adapter: pool.adapter ?? "", reason: "no_catalog_match" });
        continue;
      }
      const matches = input.catalog.matches(observation);
      if (matches.length === 0) {
        rejected.push({ ...pool, adapter: pool.adapter ?? "", reason: "no_catalog_match" });
        continue;
      }
      // Prefer the family hinted by the pool's adapter label, else the first
      // catalog match.
      const target = matchFor(input, pool, matches);
      if (target === null) {
        rejected.push({ ...pool, adapter: pool.adapter ?? "", reason: "no_matching_family" });
        continue;
      }
      const family = input.catalog.forFamily(target.familyId);
      const result = await executeAdapterFamilyLifecycleBatch({
        family,
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
        (outcome.status === "verified" ||
          outcome.status === "candidate")
      );
      if (identityOutcome === undefined ||
          identityOutcome.status !== "verified") {
        rejected.push({
          ...pool,
          adapter: pool.adapter ?? "",
          reason: `identity_unverified:${identityOutcome?.reasonCode ?? "no-outcome"}`,
        });
        continue;
      }
      const lineageId = identityOutcome.lineageId ?? "";
      const legacy = input.adapterForLineage?.(lineageId) ?? null;
      accepted.push(Object.freeze({
        ...pool,
        familyId: target.familyId,
        lineageId,
        subject: address,
        adapter: legacy?.adapter ?? String(target.familyId),
        ...(legacy?.venueId === undefined
          ? {}
          : { venueId: legacy.venueId }),
        identitySource: "strict-lifecycle",
      }));
    } catch (error) {
      rejected.push({
        ...pool,
        adapter: pool.adapter ?? "",
        reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
    }
  }
  return { accepted: Object.freeze(accepted), rejected } as const;
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
    const actions = family.plugin.manifest.ownedActionAdapterIds;
    return {
      adapter: actions[0] ?? String(familyId),
      ...(actions[0] === undefined
        ? {}
        : { venueId: actions[0] }),
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
  });
}

function matchFor(
  input: {
    readonly catalog: FamilyCapabilityCatalog;
  },
  pool: { readonly address: string; readonly adapter?: string },
  matches: readonly { readonly familyId: FamilyId; readonly patternId: string }[],
): { readonly familyId: FamilyId; readonly patternId: string } | null {
  if (pool.adapter !== undefined) {
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
