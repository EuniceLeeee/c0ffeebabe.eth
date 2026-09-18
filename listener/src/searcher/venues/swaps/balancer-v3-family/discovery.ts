import { ethers } from "ethers";
import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { VAULT, SWAP_ABI, addressWord, lower, nonzero, same } from "./codec.js";
import { nominateBalancerV3, reverseBindBalancerV3 } from "./nomination.js";
import type { BalancerV3Candidate } from "./types.js";

export const LOG_ID = "balancer-v3-vault-swap";
export const CALL_ID = "balancer-v3-vault-swap-call";
export const SURFACE_ID = "balancer-v3-vault-membership";
export const SURFACE = "balancer-v3-vault-registered-v1";
export const SWAP_TOPIC = SWAP_ABI.getEvent("Swap")!.topicHash as `0x${string}`;
export function decodeSwapLog(observation: Pick<Extract<UnifiedObservation, { kind: "log" }>, "address" | "topics" | "data">) {
  try {
    if (!same(observation.address, VAULT) || observation.topics.length !== 4 ||
        observation.topics[0].toLowerCase() !== SWAP_TOPIC || !ethers.isHexString(observation.data, 128)) return null;
    const pool = nonzero(addressWord(observation.topics[1]));
    const tokenIn = nonzero(addressWord(observation.topics[2]));
    const tokenOut = nonzero(addressWord(observation.topics[3]));
    const args = SWAP_ABI.decodeEventLog("Swap", observation.data, observation.topics);
    if (same(tokenIn, tokenOut) || args.amountIn <= 0n || args.amountOut <= 0n ||
        args.swapFeePercentage >= 10n ** 18n || args.swapFeeAmount > args.amountIn) return null;
    return { pool, tokenIn, tokenOut, amountIn: BigInt(args.amountIn), amountOut: BigInt(args.amountOut) };
  } catch { return null; }
}
export const balancerV3Discovery = {
  evidenceChannel: "nominate" as const, txSeedNominations: true,
  sources: ["landed-log", "observed-call"],
  logPatterns: [{ id: LOG_ID, topic: SWAP_TOPIC,
    signature: "Swap(address,address,address,uint256,uint256,uint256,uint256)",
    emitter: { mode: "singleton-indexed-address" as const, address: VAULT, topicIndex: 1, fromBlock: 0 } }],
  callPatterns: [{ id: CALL_ID, selector: SWAP_ABI.getFunction("swap")!.selector as `0x${string}`,
    signature: SWAP_ABI.getFunction("swap")!.format("sighash"), candidateAddress: { from: "argument" as const, index: 0 } }],
  addressSurfaces: [{ id: SURFACE_ID, kind: "interface" as const, fingerprint: SURFACE }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      let pool: string, tokenIn: string | null = null, tokenOut: string | null = null;
      if (observation.kind === "log" && matchedPatternId === LOG_ID) {
        const log = decodeSwapLog(observation);
        if (!log) return null;
        ({ pool, tokenIn, tokenOut } = log);
      } else if (observation.kind === "call" && matchedPatternId === CALL_ID) {
        if (!same(observation.target, VAULT)) return null;
        const decoded = SWAP_ABI.decodeFunctionData("swap", observation.data);
        if (SWAP_ABI.encodeFunctionData("swap", decoded).toLowerCase() !== observation.data.toLowerCase()) return null;
        const params = decoded[0];
        if ((params.kind !== 0n && params.kind !== 1n) || params.amountGivenRaw <= 0n) return null;
        pool = nonzero(String(params.pool)); tokenIn = nonzero(String(params.tokenIn)); tokenOut = nonzero(String(params.tokenOut));
        if (same(tokenIn, tokenOut)) return null;
      } else if (observation.kind === "address-surface" && matchedPatternId === SURFACE_ID &&
          observation.interfaceFingerprints?.includes(SURFACE)) pool = nonzero(observation.address);
      else return null;
      return Object.freeze({ candidateKind: "balancer-v3-pool" as const, pool: nonzero(pool),
        hintedTokenIn: tokenIn, hintedTokenOut: tokenOut });
    } catch { return null; }
  },
  candidateKey: candidate => lower(candidate.pool),
  instanceNominationKey: candidate => {
    const value = candidate as Readonly<Record<string, unknown>>;
    return lower(String(value.pool ?? value.address ?? ""));
  },
  nominate: { nominate: nominateBalancerV3 },
  reverseBinding: { kind: "implementation" as const, reverseBinding: reverseBindBalancerV3 },
} satisfies DiscoverySemantics<BalancerV3Candidate>;
