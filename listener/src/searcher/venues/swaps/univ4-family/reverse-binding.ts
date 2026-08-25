import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import {
  assertPoolKeyIdentity,
  canonicalPoolId,
  canonicalPoolKey,
} from "./codec.js";
import { resolveV4PoolKeyViaPositionManager } from
  "../univ4-pool-discovery.js";
import type { V4PoolKey } from "../../../planner/token-graph.js";
import {
  nominationTransactionHash,
  univ4SwapObservationFromTransaction,
} from "./trace-evidence.js";

/**
 * Plugin-owned retain-channel reverse binding: a univ4 pool's real identity
 * is its 32-byte poolId (the manager never exposes per-pool contracts), so
 * chain truth is recovered from the source block without requiring recent
 * activity. A retained candidate already carries its hash-bound PoolKey; a
 * fresh mutation carries the exact transaction that nominated it, whose real
 * PoolManager.swap frame recovers that PoolKey. PositionManager.poolKeys is
 * the remaining cheap chain source. No path performs an unbounded historical
 * scan: the Family lifecycle independently checks poolId/PoolKey consistency
 * and active manager state at the fixed source block.
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
      let resolved = poolKeyFromOpaque(opaque, poolId);
      if (resolved === null) {
        const viaPositionManager = await resolveV4PoolKeyViaPositionManager(
          // The reverse lookup passes an AbortSignal control as the second
          // call argument; the nomination provider treats that slot as a
          // block tag, so drop it (single-call, no cancellation needed) and
          // pin the read to the source block.
          { call: (req: { to: string; data: string }) =>
              input.provider.call(req, input.source.number) } as never,
          ADDR.UNISWAP_V4_POSITION_MANAGER,
          poolId,
        );
        resolved = viaPositionManager === null
          ? null
          : canonicalPoolKey(viaPositionManager);
      }
      if (resolved === null) {
        const transactionHash = nominationTransactionHash(nomination);
        if (transactionHash !== null) {
          const observation = await univ4SwapObservationFromTransaction({
            transactionHash,
            poolId,
            manager: ADDR.UNISWAP_V4_POOL_MANAGER,
            source: input.source,
            provider: input.provider,
          });
          if (observation !== null) {
            outcomes.push(Object.freeze({
              status: "verified",
              observation,
            }));
            continue;
          }
        }
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "poolkey-unresolved",
        }));
        continue;
      }
      const poolKey: V4PoolKey = canonicalPoolKey(resolved);
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

function poolKeyFromOpaque(
  opaque: Readonly<Record<string, unknown>>,
  poolId: string,
): V4PoolKey | null {
  const raw = opaque.poolKey;
  if (raw === null || typeof raw !== "object") return null;
  const key = raw as Readonly<Record<string, unknown>>;
  try {
    const poolKey = canonicalPoolKey({
      currency0: String(key.currency0),
      currency1: String(key.currency1),
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: String(key.hooks),
    });
    assertPoolKeyIdentity(poolId, poolKey);
    return poolKey;
  } catch {
    return null;
  }
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
