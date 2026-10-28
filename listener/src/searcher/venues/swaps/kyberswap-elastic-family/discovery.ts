import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import { canonicalAddress, lowerAddress } from
  "../../protocols/standard-family/common.js";
import {
  KYSWAP_BURN_RTOKENS_TOPIC,
  KYSWAP_BURN_TOPIC,
  KYSWAP_MINT_TOPIC,
  KYSWAP_MUTATION_LOG_PATTERN_ID,
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SURFACE_PATTERN_ID,
  KYSWAP_SWAP_CALL_PATTERN_ID,
  KYSWAP_SWAP_LOG_PATTERN_ID,
  KYSWAP_SWAP_SELECTOR,
  KYSWAP_SWAP_TOPIC,
} from "./abi.js";
import { decodeSwapLog } from "./codec.js";
import { kyberswapElasticNomination } from "./nomination.js";
import type { KyberSwapCandidate } from "./types.js";

/**
 * Observed `swap` calls and landed `Swap` logs nominate a pool; liquidity
 * `Mint`/`Burn`/`BurnRTokens` logs are observation evidence only, because they
 * never carry a swap direction. The factory reverse binding in identity.ts —
 * not this pattern list — decides admission.
 */
export const kyberswapElasticDiscovery: DiscoverySemantics<
  KyberSwapCandidate
> = {
  evidenceChannel: "nominate" as const,
  sources: Object.freeze([
    "observed-call" as const,
    "landed-log" as const,
    "address-surface" as const,
  ]),
  candidateSources: Object.freeze([
    "observed-interaction" as const,
  ]),
  callPatterns: Object.freeze([
    Object.freeze({
      id: KYSWAP_SWAP_CALL_PATTERN_ID,
      selector: KYSWAP_SWAP_SELECTOR,
      signature: "swap(address,int256,bool,uint160,bytes)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }),
  ]),
  logPatterns: Object.freeze([
    Object.freeze({
      id: KYSWAP_SWAP_LOG_PATTERN_ID,
      topic: KYSWAP_SWAP_TOPIC as `0x${string}`,
      signature: "Swap(address,address,int256,int256,uint160,uint128,int24)",
    }),
    Object.freeze({
      id: KYSWAP_MUTATION_LOG_PATTERN_ID,
      topic: KYSWAP_MINT_TOPIC as `0x${string}`,
      signature: "Mint(address,address,int24,int24,uint128,uint256,uint256)",
    }),
  ]),
  addressSurfaces: Object.freeze([Object.freeze({
    id: KYSWAP_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "kyberswap-elastic-pool-surface-v1",
  })]),
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        matchedPatternId === KYSWAP_SWAP_CALL_PATTERN_ID
      ) {
        KYSWAP_POOL_INTERFACE.decodeFunctionData("swap", observation.data);
        return Object.freeze({
          candidateKind: "kyberswap-elastic-pool" as const,
          pool: canonicalAddress(observation.target),
          sourceKind: "pool-call" as const,
          hintedFactory: null,
        });
      }
      if (observation.kind === "log") {
        const topic = observation.topics[0]?.toLowerCase();
        if (
          matchedPatternId === KYSWAP_SWAP_LOG_PATTERN_ID &&
          topic === KYSWAP_SWAP_TOPIC
        ) {
          const decoded = decodeSwapLog(observation);
          if (decoded === null) return null;
          return Object.freeze({
            candidateKind: "kyberswap-elastic-pool" as const,
            pool: canonicalAddress(observation.address),
            sourceKind: "pool-swap-log" as const,
            hintedFactory: null,
          });
        }
        if (
          matchedPatternId === KYSWAP_MUTATION_LOG_PATTERN_ID &&
          (topic === KYSWAP_MINT_TOPIC ||
            topic === KYSWAP_BURN_TOPIC ||
            topic === KYSWAP_BURN_RTOKENS_TOPIC)
        ) {
          return Object.freeze({
            candidateKind: "kyberswap-elastic-pool" as const,
            pool: canonicalAddress(observation.address),
            sourceKind: "pool-swap-log" as const,
            hintedFactory: null,
          });
        }
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === KYSWAP_SURFACE_PATTERN_ID
      ) {
        return Object.freeze({
          candidateKind: "kyberswap-elastic-pool" as const,
          pool: canonicalAddress(observation.address),
          sourceKind: "pool-surface" as const,
          hintedFactory: null,
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: kyberswapElasticNomination,
  reverseBinding: explicitReverseBindingUnsupported(
    "no capture-channel reverse binding declared; admission is the pool's own " +
      "factory() plus factory.getPool(token0,token1,swapFeeUnits) chain proof " +
      "performed by the identity variant",
  ),
};
