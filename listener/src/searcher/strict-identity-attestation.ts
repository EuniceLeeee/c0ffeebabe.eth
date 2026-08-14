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
  getCode(address: string, blockTag: number): Promise<string>;
  getStorage(
    address: string,
    slot: string,
    blockTag: number,
  ): Promise<string>;
}

export async function attestPoolIdentitiesStrict(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly provider: StrictIdentityProvider;
  readonly runtime: CentralAdapterRuntime;
  readonly source: CanonicalSource;
  readonly pools: readonly {
    readonly address: string;
    readonly adapter?: string;
  }[];
}): Promise<{
  readonly accepted: readonly {
    readonly address: string;
    readonly familyId: FamilyId;
    readonly lineageId: string;
    readonly subject: string;
  }[];
  readonly rejected: readonly {
    readonly address: string;
    readonly reason: string;
  }[];
}> {
  const accepted: {
    readonly address: string;
    readonly familyId: FamilyId;
    readonly lineageId: string;
    readonly subject: string;
  }[] = [];
  const rejected: { readonly address: string; readonly reason: string }[] = [];
  for (const pool of input.pools) {
    const address = ethers.getAddress(pool.address);
    try {
      const observation = await addressSurfaceObservation(
        input.provider,
        input.source,
        address,
      );
      const matches = input.catalog.matches(observation);
      if (matches.length === 0) {
        rejected.push({ address, reason: "no_catalog_match" });
        continue;
      }
      // Prefer the family hinted by the pool's adapter label, else the first
      // catalog match.
      const target = matchFor(input, pool, matches);
      if (target === null) {
        rejected.push({ address, reason: "no_matching_family" });
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
          address,
          reason: `identity_unverified:${identityOutcome?.reasonCode ?? "no-outcome"}`,
        });
        continue;
      }
      accepted.push(Object.freeze({
        address,
        familyId: target.familyId,
        lineageId: identityOutcome.lineageId ?? "",
        subject: address,
      }));
    } catch (error) {
      rejected.push({
        address,
        reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
    }
  }
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}

async function addressSurfaceObservation(
  provider: StrictIdentityProvider,
  source: CanonicalSource,
  address: string,
): Promise<UnifiedObservation> {
  const code = await provider.getCode(address, source.number);
  if (!ethers.isHexString(code) || code === "0x") {
    throw new Error("no deployed code");
  }
  const implementationWord = await provider.getStorage(
    address,
    EIP1967_IMPLEMENTATION_SLOT,
    source.number,
  );
  return Object.freeze({
    kind: "address-surface" as const,
    source,
    address: address.toLowerCase(),
    codeHash: ethers.keccak256(code).toLowerCase(),
    implementationWord: ethers.zeroPadValue(implementationWord, 32).toLowerCase(),
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
