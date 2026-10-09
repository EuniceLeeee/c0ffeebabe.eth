import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  ALGEBRA_FACTORY_INTERFACE,
  ALGEBRA_POOL_INTERFACE,
  ALGEBRA_FACTORY_POOL_PATTERN_ID,
  ALGEBRA_FACTORY_POOL_TOPIC,
  ALGEBRA_BURN_LOG_PATTERN_ID,
  ALGEBRA_BURN_TOPIC,
  ALGEBRA_INITIALIZE_LOG_PATTERN_ID,
  ALGEBRA_INITIALIZE_TOPIC,
  ALGEBRA_MINT_LOG_PATTERN_ID,
  ALGEBRA_MINT_TOPIC,
  ALGEBRA_POOL_SURFACE_PATTERN_ID,
  ALGEBRA_SWAP_CALL_PATTERN_ID,
  ALGEBRA_SWAP_LOG_PATTERN_ID,
  ALGEBRA_SWAP_SELECTOR,
  ALGEBRA_SWAP_TOPIC,
} from "./abi.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import { nominateAlgebraIntegral } from "./nomination.js";
import { reverseBindAlgebraIntegral } from "./reverse-binding.js";
import type { AlgebraIntegralCandidate } from "./types.js";

/**
 * Discovery declares WHAT this family can recognize; admission stays the
 * identity variant's chain proof (`factory.poolByPair`). The factory `Pool` log
 * is an observation of a deployment, never an instance allowlist: a decoded
 * candidate still has to pass the reverse binding on chain.
 */
export const algebraIntegralDiscovery: DiscoverySemantics<
  AlgebraIntegralCandidate
> = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: Object.freeze([
    "factory-log" as const,
    "landed-log" as const,
    "observed-call" as const,
    "address-surface" as const,
  ]),
  callPatterns: Object.freeze([Object.freeze({
    id: ALGEBRA_SWAP_CALL_PATTERN_ID,
    selector: ALGEBRA_SWAP_SELECTOR as `0x${string}`,
    signature: "swap(address,bool,int256,uint160,bytes)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  })]),
  logPatterns: Object.freeze([
    Object.freeze({
      id: ALGEBRA_FACTORY_POOL_PATTERN_ID,
      topic: ALGEBRA_FACTORY_POOL_TOPIC as `0x${string}`,
      signature: "Pool(address,address,address)",
    }),
    Object.freeze({
      id: ALGEBRA_SWAP_LOG_PATTERN_ID,
      topic: ALGEBRA_SWAP_TOPIC as `0x${string}`,
      signature:
        "Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)",
    }),
    Object.freeze({
      id: ALGEBRA_INITIALIZE_LOG_PATTERN_ID,
      topic: ALGEBRA_INITIALIZE_TOPIC as `0x${string}`,
      signature: "Initialize(uint160,int24)",
    }),
    Object.freeze({
      id: ALGEBRA_MINT_LOG_PATTERN_ID,
      topic: ALGEBRA_MINT_TOPIC as `0x${string}`,
      signature:
        "Mint(address,address,int24,int24,uint128,uint256,uint256)",
    }),
    Object.freeze({
      id: ALGEBRA_BURN_LOG_PATTERN_ID,
      topic: ALGEBRA_BURN_TOPIC as `0x${string}`,
      signature:
        "Burn(address,int24,int24,uint128,uint256,uint256,uint24)",
    }),
  ]),
  addressSurfaces: Object.freeze([Object.freeze({
    id: ALGEBRA_POOL_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "algebra-integral-pool-surface-v1",
  })]),
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  instanceNominationKey: (candidate) => {
    const value = candidate as Readonly<Record<string, unknown>>;
    return lowerAddress(String(value.pool ?? value.address ?? ""));
  },
  nominate: { nominate: nominateAlgebraIntegral },
  reverseBinding: Object.freeze({
    kind: "implementation" as const,
    reverseBinding: reverseBindAlgebraIntegral,
  }),
};

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): AlgebraIntegralCandidate | null {
  if (
    matchedPatternId === ALGEBRA_FACTORY_POOL_PATTERN_ID &&
    observation.kind === "log" &&
    observation.topics[0]?.toLowerCase() === ALGEBRA_FACTORY_POOL_TOPIC
  ) {
    const decoded = ALGEBRA_FACTORY_INTERFACE.decodeEventLog(
      "Pool",
      observation.data,
      [...observation.topics],
    );
    return Object.freeze({
      candidateKind: "algebra-integral-pool" as const,
      pool: canonicalAddress(String(decoded.pool)),
      sourceKind: "factory-pool-log" as const,
      hintedFactory: canonicalAddress(observation.address),
      hintedToken0: canonicalAddress(String(decoded.token0)),
      hintedToken1: canonicalAddress(String(decoded.token1)),
    });
  }
  if (
    matchedPatternId === ALGEBRA_SWAP_LOG_PATTERN_ID &&
    observation.kind === "log" &&
    observation.topics[0]?.toLowerCase() === ALGEBRA_SWAP_TOPIC
  ) {
    // Decode to prove the payload really is this pool's swap event.
    ALGEBRA_POOL_INTERFACE.decodeEventLog(
      "Swap",
      observation.data,
      [...observation.topics],
    );
    return Object.freeze({
      candidateKind: "algebra-integral-pool" as const,
      pool: canonicalAddress(observation.address),
      sourceKind: "pool-swap-log" as const,
      hintedFactory: null,
      hintedToken0: null,
      hintedToken1: null,
    });
  }
  if (
    matchedPatternId === ALGEBRA_SWAP_CALL_PATTERN_ID &&
    observation.kind === "call"
  ) {
    ALGEBRA_POOL_INTERFACE.decodeFunctionData("swap", observation.data);
    return Object.freeze({
      candidateKind: "algebra-integral-pool" as const,
      pool: canonicalAddress(observation.target),
      sourceKind: "pool-call" as const,
      hintedFactory: null,
      hintedToken0: null,
      hintedToken1: null,
    });
  }
  if (
    matchedPatternId === ALGEBRA_POOL_SURFACE_PATTERN_ID &&
    observation.kind === "address-surface"
  ) {
    // The retain-channel reverse binding may carry chain-truth hints
    // (factory() read at the source block); every hint is re-verified on chain
    // by the identity variant, so a mismatch is a rejection, never a pass.
    const opaque = observation.opaque as Readonly<Record<string, unknown>>;
    return Object.freeze({
      candidateKind: "algebra-integral-pool" as const,
      pool: canonicalAddress(observation.address),
      sourceKind: "pool-surface" as const,
      hintedFactory: typeof opaque.factory === "string" && isAddressLike(opaque.factory)
        ? canonicalAddress(opaque.factory)
        : null,
      hintedToken0: typeof opaque.token0 === "string" && isAddressLike(opaque.token0)
        ? canonicalAddress(opaque.token0)
        : null,
      hintedToken1: typeof opaque.token1 === "string" && isAddressLike(opaque.token1)
        ? canonicalAddress(opaque.token1)
        : null,
    });
  }
  return null;
}

function isAddressLike(value: string): boolean {
  try {
    canonicalAddress(value);
    return true;
  } catch {
    return false;
  }
}
