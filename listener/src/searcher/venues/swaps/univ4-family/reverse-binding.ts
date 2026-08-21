import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import {
  canonicalPoolId,
  canonicalPoolKey,
} from "./codec.js";
import {
  resolveV4PoolKeyViaPositionManager,
  resolveV4InitsBackward,
} from "../univ4-pool-discovery.js";
import { UNIV4_INITIALIZE_TOPIC } from "../univ4-abi.js";
import type { V4PoolKey } from "../../../planner/token-graph.js";

/**
 * Plugin-owned retain-channel reverse binding: a univ4 pool's real identity
 * is its 32-byte poolId (the manager never exposes per-pool contracts), so
 * chain truth is recovered from the source block without requiring recent
 * activity. Primary source: the PositionManager poolKeys reverse lookup
 * (eth_call). Fallback: the indexed Initialize-log reverse scan (topics
 * [Initialize, poolId]) which covers every pool, including router-side pools
 * that never flowed through the official position manager. A candidate
 * without a poolId in its opaque payload is explicitly unsupported; a
 * lookup that fails to resolve is a failed outcome. Identity still
 * re-verifies the pool key against the manager at the source block in the
 * family lifecycle.
 */
export async function reverseBindUniv4(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv4OpaqueLabel(opaque)) {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "not-univ4-opaque",
      }));
      continue;
    }
    const poolId = opaquePoolId(opaque);
    if (poolId === null) {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "missing-pool-id",
      }));
      continue;
    }
    try {
      let resolved = await resolveV4PoolKeyViaPositionManager(
        // The reverse lookup passes an AbortSignal control as the second
        // call argument; the nomination provider treats that slot as a
        // block tag, so drop it (single-call, no cancellation needed) and
        // pin the read to the source block.
        { call: (req: { to: string; data: string }) =>
            input.provider.call(req, input.source.number) } as never,
        ADDR.UNISWAP_V4_POSITION_MANAGER,
        poolId,
      );
      if (resolved === null) {
        // PositionManager reverse lookup misses pools whose liquidity never
        // flowed through the official position manager (router-side pools).
        // Every pool still has exactly one Initialize log carrying the full
        // PoolKey: fall back to the indexed Initialize reverse scan (same
        // chain truth, no recent activity needed) from the source block back
        // toward the manager deploy block.
        const backfilled = await resolveV4InitsBackward(
          Object.freeze({
            getLogs: (filter: {
              readonly address?: string;
              readonly fromBlock?: number;
              readonly toBlock?: number;
              readonly topics?: readonly (string | null)[];
            }) => input.provider.getLogs(filter),
          }) as never,
          ADDR.UNISWAP_V4_POOL_MANAGER,
          UNIV4_INITIALIZE_TOPIC,
          [poolId],
          input.source.number,
        );
        resolved = backfilled.get(poolId) ?? null;
        if (resolved === null) {
          outcomes.push(Object.freeze({
            status: "failed",
            reason: "initialize-backfill-null",
          }));
          continue;
        }
      }
      const poolKey: V4PoolKey = canonicalPoolKey({
        currency0: resolved.currency0,
        currency1: resolved.currency1,
        fee: resolved.fee,
        tickSpacing: resolved.tickSpacing,
        hooks: resolved.hooks,
      });
      const code = await input.provider.getCode(
        ADDR.UNISWAP_V4_POOL_MANAGER,
        input.source.number,
      );
      if (!ethers.isHexString(code) || code === "0x") {
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "manager-code-unreadable",
        }));
        continue;
      }
      outcomes.push(Object.freeze({
        status: "verified",
        observation: Object.freeze({
          kind: "address-surface",
          source: input.source,
          address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
          codeHash: ethers.keccak256(code).toLowerCase(),
          implementationWord: ethers.zeroPadValue("0x", 32).toLowerCase(),
          interfaceFingerprints: Object.freeze(["univ4-pool-surface-v1"]),
          opaque: Object.freeze({
            poolId: canonicalPoolId(poolId).toLowerCase(),
            poolKey,
          } as never),
        }),
      }));
    } catch (error) {
      outcomes.push(Object.freeze({
        status: "failed",
        reason: error instanceof Error
          ? error.message.slice(0, 120)
          : "reverse-lookup-error",
      }));
    }
  }
  return Object.freeze(outcomes);
}

export function isUniv4OpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "univ4" || label === "univ4-standard");
}

export function opaquePoolId(
  opaque: Readonly<Record<string, unknown>>,
): string | null {
  const raw = opaque.poolId ?? opaque.id;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  try {
    return canonicalPoolId(String(raw)).toLowerCase();
  } catch {
    return null;
  }
}
