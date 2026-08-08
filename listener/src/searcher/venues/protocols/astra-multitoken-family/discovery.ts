import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  ASTRA_MULTITOKEN_CHANGE_SELECTOR,
  ASTRA_MULTITOKEN_CHANGE_TOPIC,
  ASTRA_MULTITOKEN_INTERFACE,
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "./codec.js";
import type { AstraMultiTokenCandidate } from "./types.js";

export const ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID =
  "astra-multitoken-change-call";
export const ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID =
  "astra-multitoken-change-log";

export const astraMultiTokenDiscovery = {
  sources: ["observed-call", "landed-log"],
  callPatterns: [{
    id: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    selector: ASTRA_MULTITOKEN_CHANGE_SELECTOR,
    signature: "change(address,address,uint256,uint256)",
    candidateAddress: { from: "call-target" },
    argumentProjection: [{ index: 0, type: "address", name: "tokenIn" }, {
      index: 1,
      type: "address",
      name: "tokenOut",
    }],
  }],
  logPatterns: [{
    id: ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID,
    topic: ASTRA_MULTITOKEN_CHANGE_TOPIC,
    signature:
      "Change(address,address,address,uint256,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        matchedPatternId === ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID
      ) {
        return decodeCallCandidate(observation);
      }
      if (
        observation.kind === "log" &&
        matchedPatternId === ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID
      ) {
        return decodeLogCandidate(observation);
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => [
    lowerAddress(candidate.target),
    hashCanonical({
      sourceKind: candidate.sourceKind,
      actor: lowerAddress(candidate.actor),
      tokenIn: lowerAddress(candidate.tokenIn),
      tokenOut: lowerAddress(candidate.tokenOut),
      amountIn: candidate.amountIn,
      observedAmountOut: candidate.observedAmountOut,
      minAmountOut: candidate.minAmountOut,
      transactionHash: candidate.transactionHash?.toLowerCase() ?? null,
    }),
  ].join(":"),
} satisfies DiscoverySemantics<AstraMultiTokenCandidate>;

function decodeCallCandidate(
  observation: Extract<UnifiedObservation, { readonly kind: "call" }>,
): AstraMultiTokenCandidate | null {
  if (observation.sender === undefined) return null;
  const decoded = ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
    "change",
    observation.data,
  );
  return candidate({
    sourceKind: "observed-change-call",
    target: observation.target,
    actor: observation.sender,
    tokenIn: String(decoded[0]),
    tokenOut: String(decoded[1]),
    amountIn: BigInt(decoded[2]),
    observedAmountOut: null,
    minAmountOut: BigInt(decoded[3]),
    transactionHash: observation.transactionHash ?? null,
  });
}

function decodeLogCandidate(
  observation: Extract<UnifiedObservation, { readonly kind: "log" }>,
): AstraMultiTokenCandidate | null {
  if (
    observation.topics[0]?.toLowerCase() !==
      ASTRA_MULTITOKEN_CHANGE_TOPIC
  ) {
    return null;
  }
  const decoded = ASTRA_MULTITOKEN_INTERFACE.decodeEventLog(
    "Change",
    observation.data,
    observation.topics,
  );
  const amountOut = BigInt(decoded.returnAmount);
  return candidate({
    sourceKind: "change-log",
    target: observation.address,
    actor: String(decoded.changer),
    tokenIn: String(decoded.fromToken),
    tokenOut: String(decoded.toToken),
    amountIn: BigInt(decoded.amount),
    observedAmountOut: amountOut,
    minAmountOut: amountOut,
    transactionHash: observation.transactionHash ?? null,
  });
}

function candidate(input: Omit<AstraMultiTokenCandidate, "candidateKind">):
  AstraMultiTokenCandidate | null {
  const target = canonicalAddress(input.target);
  const actor = canonicalAddress(input.actor);
  const tokenIn = canonicalAddress(input.tokenIn);
  const tokenOut = canonicalAddress(input.tokenOut);
  if (
    sameAddress(tokenIn, tokenOut) ||
    input.amountIn <= 0n ||
    input.minAmountOut < 0n ||
    (input.observedAmountOut !== null &&
      input.observedAmountOut <= 0n)
  ) {
    return null;
  }
  return Object.freeze({
    candidateKind: "astra-multitoken-contract" as const,
    ...input,
    target,
    actor,
    tokenIn,
    tokenOut,
  });
}
