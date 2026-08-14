import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import {
  EIGENPIE_CALL_PATTERN_ID,
  EIGENPIE_DEPOSIT_TOPIC,
  EIGENPIE_INTERFACE,
  EIGENPIE_LOG_PATTERN_ID,
} from "./codec.js";
import type { EigenpieCandidate } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

export const eigenpieDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: Object.freeze(["observed-call" as const, "landed-log" as const]),
  candidateSources: Object.freeze(["observed-interaction" as const]),
  callPatterns: Object.freeze([Object.freeze({
    id: EIGENPIE_CALL_PATTERN_ID,
    selector: EIGENPIE_INTERFACE.getFunction("depositAsset")!
      .selector as `0x${string}`,
    signature: "depositAsset(address,uint256,uint256,address)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
    argumentProjection: Object.freeze([
      Object.freeze({ index: 0, type: "address" as const, name: "asset" }),
      Object.freeze({ index: 1, type: "uint256" as const, name: "amount" }),
    ]),
  })]),
  logPatterns: Object.freeze([Object.freeze({
    id: EIGENPIE_LOG_PATTERN_ID,
    topic: EIGENPIE_DEPOSIT_TOPIC as `0x${string}`,
    signature: "AssetDeposit(address,address,uint256,address,uint256,bool)",
  })]),
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        matchedPatternId === EIGENPIE_CALL_PATTERN_ID
      ) {
        if (observation.sender === undefined) return null;
        const decoded = EIGENPIE_INTERFACE.decodeFunctionData(
          "depositAsset",
          observation.data,
        );
        const amountIn = BigInt(decoded[1]);
        const tokenIn = canonicalAddress(String(decoded[0]));
        if (
          amountIn <= 0n ||
          sameAddress(tokenIn, ethers.ZeroAddress)
        ) return null;
        return Object.freeze({
          candidateKind: "eigenpie-deposit-pair" as const,
          target: canonicalAddress(observation.target),
          actor: canonicalAddress(observation.sender),
          tokenIn,
          amountIn,
          minAmountOut: BigInt(decoded[2]),
          observedAmountOut: null,
          transactionHash: observation.transactionHash ?? null,
        });
      }
      if (
        observation.kind === "log" &&
        matchedPatternId === EIGENPIE_LOG_PATTERN_ID
      ) {
        if (
          observation.topics[0]?.toLowerCase() !== EIGENPIE_DEPOSIT_TOPIC
        ) return null;
        const parsed = EIGENPIE_INTERFACE.parseLog({
          topics: [...observation.topics],
          data: observation.data,
        });
        if (parsed === null || Boolean(parsed.args.isPreDeposit)) return null;
        const amountIn = BigInt(parsed.args.depositAmount);
        const amountOut = BigInt(parsed.args.mintedAmount);
        if (amountIn <= 0n || amountOut <= 0n) return null;
        return Object.freeze({
          candidateKind: "eigenpie-deposit-pair" as const,
          target: canonicalAddress(observation.address),
          actor: canonicalAddress(String(parsed.args.depositor)),
          tokenIn: canonicalAddress(String(parsed.args.asset)),
          amountIn,
          minAmountOut: amountOut,
          observedAmountOut: amountOut,
          transactionHash: observation.transactionHash ?? null,
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => [
    lowerAddress(candidate.target),
    lowerAddress(candidate.tokenIn),
  ].join(":"),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["eigenpie", "protocol:eigenpie"]),
    logPatterns: Object.freeze([{
      id: "eigenpie-deposit",
      topic: EIGENPIE_DEPOSIT_TOPIC as `0x${string}`,
      signature: "Deposit(address,address,uint256)",
    }]),
    callPatterns: Object.freeze([{
      id: "eigenpie-deposit-call",
      selector: EIGENPIE_INTERFACE.getFunction("depositAsset")!
        .selector as `0x${string}`,
      signature: "depositAsset(address,address,uint256)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
} satisfies DiscoverySemantics<EigenpieCandidate>;
