import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_ADAPTER_SWAP_SELECTOR,
  ANGSTROM_MAINNET_ADAPTER,
} from "../angstrom-attestation.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_SWAP_SIGNATURE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import { v4PoolId } from "../univ4-common.js";
import {
  ANGSTROM_INITIALIZE_PATTERN_ID,
  ANGSTROM_SWAP_CALL_PATTERN_ID,
  ANGSTROM_SWAP_LOG_PATTERN_ID,
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
} from "./codec.js";
import type { AngstromV4Candidate } from "./types.js";
import { nominateAngstromV4 } from "./nomination.js";
import { angstromRuntimeEvidenceFromObservation } from "./evidence.js";

const ANGSTROM_ADAPTER_INTERFACE = new ethers.Interface(
  ANGSTROM_ADAPTER_SWAP_ABI,
);

export const angstromV4Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  callPatterns: [{
    id: ANGSTROM_SWAP_CALL_PATTERN_ID,
    selector: ANGSTROM_ADAPTER_SWAP_SELECTOR as `0x${string}`,
    signature:
      "swap((address,address,uint24,int24,address),bool,uint128,uint128,(uint64,bytes)[],address,uint256)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: ANGSTROM_INITIALIZE_PATTERN_ID,
    topic: UNIV4_INITIALIZE_TOPIC as `0x${string}`,
    signature:
      "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
  }, {
    id: ANGSTROM_SWAP_LOG_PATTERN_ID,
    topic: UNIV4_SWAP_TOPIC as `0x${string}`,
    signature: UNIV4_SWAP_SIGNATURE,
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) =>
    `${candidate.manager.toLowerCase()}\u001f${candidate.poolId}`,
  nominate: { nominate: nominateAngstromV4 },
  runtimeEvidenceFromObservation: angstromRuntimeEvidenceFromObservation,
  reverseBinding: explicitReverseBindingUnsupported(
    "tx-bound family; no reverse-binding registry (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<AngstromV4Candidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): AngstromV4Candidate | null {
  if (
    observation.kind === "log" &&
    matchedPatternId === ANGSTROM_INITIALIZE_PATTERN_ID
  ) {
    const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
      "Initialize",
      observation.data,
      observation.topics,
    );
    const poolKey = canonicalPoolKey({
      currency0: String(decoded.currency0),
      currency1: String(decoded.currency1),
      fee: Number(decoded.fee),
      tickSpacing: Number(decoded.tickSpacing),
      hooks: String(decoded.hooks),
    });
    return Object.freeze({
      candidateKind: "angstrom-v4-pool-key" as const,
      sourceKind: "initialize-log" as const,
      manager: canonicalAddress(observation.address),
      adapter: canonicalAddress(ANGSTROM_MAINNET_ADAPTER),
      poolId: canonicalPoolId(String(decoded.id)),
      poolKey,
    });
  }
  if (
    observation.kind === "call" &&
    matchedPatternId === ANGSTROM_SWAP_CALL_PATTERN_ID
  ) {
    const decoded = ANGSTROM_ADAPTER_INTERFACE.decodeFunctionData(
      "swap",
      observation.data,
    );
    const key = decoded.key;
    const poolKey = canonicalPoolKey({
      currency0: String(key.currency0),
      currency1: String(key.currency1),
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: String(key.hooks),
    });
    return Object.freeze({
      candidateKind: "angstrom-v4-pool-key" as const,
      sourceKind: "adapter-swap-call" as const,
      manager: canonicalAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
      adapter: canonicalAddress(observation.target),
      poolId: v4PoolId(poolKey),
      poolKey,
    });
  }
  // A PoolManager Swap log has only poolId. PoolKey recovery remains a
  // central backfill/materialization operation; this pure decoder will not
  // guess the preimage.
  return null;
}
