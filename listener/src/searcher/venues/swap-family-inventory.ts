import type { PoolEntry } from "../planner/token-graph.js";
import {
  poolRegistryKey,
  type PoolUniverseEntry,
} from "../pool-universe.js";
import type { IdentityAdmissionPolicy } from "./admission.js";
import {
  attestPoolIdentities,
  isRetryablePoolIdentityFailure,
  type AttestedPoolEntry,
  type IdentityCallBackend,
  type IdentityResolverRegistry,
  type RejectedPoolIdentity,
} from "./identity.js";
import type { SwapAdapter } from "./route-leg-adapter.js";
import { attestPoolsStrictFromProvider } from "../strict-identity-attestation.js";

export interface RetainedSwapFamilyInventory {
  readonly pools: readonly PoolUniverseEntry[];
  readonly candidates: number;
  readonly rejected: readonly RejectedPoolIdentity[];
}

/**
 * Rolling Swap activity ranks pools; it must not erase topology that a
 * family already admitted. V2/V3 keep their mature factory/activity path.
 * Every other registered Swap family gets the same durable inventory rule
 * without a central family-id switch.
 *
 * Retained rows are re-attested at current N. A transport failure is not
 * negative identity evidence and therefore aborts publication; a completed
 * negative proof removes only that instance. Freshly observed rows always
 * replace retained rows with their current activity score.
 */
export async function retainVerifiedSwapFamilyInstances(input: {
  readonly families: readonly SwapAdapter[];
  readonly identityRegistry: IdentityResolverRegistry;
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly backend: IdentityCallBackend;
  readonly priorPools: readonly PoolUniverseEntry[];
  readonly freshPools: readonly PoolEntry[];
  /** F6 Pair B: attest retained rows through the generated catalog when set. */
  readonly strictAttestation?: {
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
  };
}): Promise<RetainedSwapFamilyInventory> {
  const ownerByPoolAdapter = new Map<string, string>();
  for (const family of input.families) {
    if (family.matureDexUniverseDiscovery === true) continue;
    for (const poolAdapter of family.poolAdapters) {
      ownerByPoolAdapter.set(poolAdapter, family.id);
    }
  }

  const freshKeys = new Set(input.freshPools.map(poolRegistryKey));
  const candidates = input.priorPools.filter((pool) =>
    ownerByPoolAdapter.has(pool.adapter) &&
    !freshKeys.has(poolRegistryKey(pool))
  );
  const startedAtMs = Date.now();
  console.log(
    `[pool-universe] retained family inventory candidates=${candidates.length} ` +
      `strict=${input.strictAttestation !== undefined}`,
  );
  const attested = input.strictAttestation === undefined
    ? await attestPoolIdentities(input.backend, candidates, {
        identityRegistry: input.identityRegistry,
        admissionPolicy: input.admissionPolicy,
      })
    : await strictRetainedAttestation(candidates, input.strictAttestation);
  console.log(
    `[pool-universe] retained family inventory attestation complete ` +
      `accepted=${attested.accepted.length} rejected=${attested.rejected.length} ` +
      `elapsedMs=${Date.now() - startedAtMs}`,
  );
  const incomplete = attested.rejected.filter((item) =>
    isRetryablePoolIdentityFailure(item.reason)
  );
  if (incomplete.length > 0) {
    throw new Error(
      "swap family inventory identity reads incomplete: " +
        incomplete.map((item) =>
          `${item.adapter}:${item.address}:${item.reason}`
        ).join(", "),
    );
  }

  return Object.freeze({
    pools: Object.freeze(attested.accepted.map((pool) => Object.freeze({
      ...pool,
      score: 0,
      swapCount30d: 0,
      source: `retained-family-inventory:${ownerByPoolAdapter.get(pool.adapter)}`,
      topologyRetained: true as const,
    }))),
    candidates: candidates.length,
    rejected: Object.freeze(attested.rejected),
  });
}


/**
 * F6 Pair B: retained family inventory rows are re-attested through the
 * generated catalog + plugin nomination/lifecycle at the pinned source block.
 * The legacy per-adapter resolver registry never supplies a credential here.
 */
async function strictRetainedAttestation(
  candidates: readonly PoolUniverseEntry[],
  attestation: {
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
  },
): Promise<{
  accepted: AttestedPoolEntry<PoolUniverseEntry>[];
  rejected: RejectedPoolIdentity[];
}> {
  const result = await attestPoolsStrictFromProvider({
    provider: attestation.provider,
    blockNumber: attestation.blockNumber,
    pools: candidates,
    // Central retained-attestation strategy: the retain channel (cold-pool
    // reverse binding from chain truth) runs before the fresh nomination
    // channel. The plugin never decides this order.
    channelOrder: "reverse-binding-first",
  });
  return {
    accepted: result.accepted as unknown as AttestedPoolEntry<PoolUniverseEntry>[],
    rejected: result.rejected as unknown as RejectedPoolIdentity[],
  };
}
