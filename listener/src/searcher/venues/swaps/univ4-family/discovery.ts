import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_SIGNATURE,
  UNIV4_MODIFY_LIQUIDITY_TOPIC,
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_SWAP_SELECTOR,
  UNIV4_SWAP_SIGNATURE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import { v4PoolId } from "../univ4-common.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from "../univ4-common.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import {
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
  UNIV4_INITIALIZE_PATTERN_ID,
  UNIV4_MODIFY_LIQUIDITY_PATTERN_ID,
  UNIV4_SWAP_CALL_PATTERN_ID,
  UNIV4_SWAP_LOG_PATTERN_ID,
} from "./codec.js";
import type { V4PoolKey } from "../../../planner/token-graph.js";
import type { UniV4Candidate } from "./types.js";
import { nominateUniv4 } from "./nomination.js";
import { reverseBindUniv4 } from "./reverse-binding.js";

export const UNIV4_POOL_SURFACE_PATTERN_ID = "univ4-pool-surface";

export const univ4Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  canonicalIntakeTargets: [
    ADDR.UNISWAP_V4_POOL_MANAGER,
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
    "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  ],
  callPatterns: [{
    id: UNIV4_SWAP_CALL_PATTERN_ID,
    selector: UNIV4_SWAP_SELECTOR,
    signature:
      "swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: UNIV4_INITIALIZE_PATTERN_ID,
    topic: UNIV4_INITIALIZE_TOPIC as `0x${string}`,
    signature:
      "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
    emitter: {
      mode: "singleton-indexed-bytes32",
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topicIndex: 1,
      fromBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
    },
  }, {
    id: UNIV4_SWAP_LOG_PATTERN_ID,
    topic: UNIV4_SWAP_TOPIC as `0x${string}`,
    signature: UNIV4_SWAP_SIGNATURE,
  }, {
    id: UNIV4_MODIFY_LIQUIDITY_PATTERN_ID,
    topic: UNIV4_MODIFY_LIQUIDITY_TOPIC as `0x${string}`,
    signature: UNIV4_MODIFY_LIQUIDITY_SIGNATURE,
  }],
  addressSurfaces: [Object.freeze({
    id: UNIV4_POOL_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "univ4-pool-surface-v1",
  })],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) =>
    `${candidate.manager.toLowerCase()}\u001f${candidate.poolId}`,
  nominate: { nominate: nominateUniv4 },
  reverseBinding: Object.freeze({
    kind: "implementation" as const,
    reverseBinding: reverseBindUniv4,
  }),
} satisfies DiscoverySemantics<UniV4Candidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): UniV4Candidate | null {
  if (
    observation.kind === "address-surface" &&
    matchedPatternId === UNIV4_POOL_SURFACE_PATTERN_ID
  ) {
    const opaque = observation.opaque as Readonly<Record<string, unknown>>;
    const poolId = canonicalPoolId(String(opaque.poolId ?? ""));
    const key = opaque.poolKey as V4PoolKey | undefined;
    if (key === undefined || typeof key !== "object") return null;
    const poolKey = canonicalPoolKey({
      currency0: String(key.currency0),
      currency1: String(key.currency1),
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: String(key.hooks),
    });
    return Object.freeze({
      candidateKind: "univ4-pool-key" as const,
      sourceKind: "pool-surface" as const,
      manager: canonicalAddress(observation.address),
      poolId,
      poolKey,
    });
  }
  if (
    observation.kind === "log" &&
    matchedPatternId === UNIV4_INITIALIZE_PATTERN_ID
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
      candidateKind: "univ4-pool-key" as const,
      sourceKind: "initialize-log" as const,
      manager: canonicalAddress(observation.address),
      poolId: canonicalPoolId(String(decoded.id)),
      poolKey,
    });
  }
  if (
    observation.kind === "call" &&
    matchedPatternId === UNIV4_SWAP_CALL_PATTERN_ID
  ) {
    const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeFunctionData(
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
      candidateKind: "univ4-pool-key" as const,
      sourceKind: "manager-swap-call" as const,
      manager: canonicalAddress(observation.target),
      poolId: v4PoolId(poolKey),
      poolKey,
    });
  }
  // Swap/ModifyLiquidity logs carry only poolId. They remain mutation signals;
  // admitting them without a previously proven complete PoolKey would turn a
  // one-way hash into guessed identity.
  return null;
}
