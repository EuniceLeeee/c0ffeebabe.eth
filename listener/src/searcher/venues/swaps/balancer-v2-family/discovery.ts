import { ethers } from "ethers";
import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { VAULT, VAULT_ABI, poolIdentity, nonzero, same } from "./codec.js";
import { nominate, reverseBinding } from "./nomination.js";
import type { BalancerV2Candidate } from "./types.js";
export const LOG_ID = "balancer-v2-vault-swap", CALL_ID = "balancer-v2-vault-single-swap";
export const SURFACE_ID = "balancer-v2-vault-membership", SURFACE = "balancer-v2-vault-registered-v1";
export const SWAP_TOPIC = VAULT_ABI.getEvent("Swap")!.topicHash as `0x${string}`;
export function decodeSwapLog(log: Pick<Extract<UnifiedObservation, { kind: "log" }>, "address" | "topics" | "data">) {
  try {
    if (!same(log.address, VAULT) || log.topics.length !== 4 || log.topics[0].toLowerCase() !== SWAP_TOPIC ||
        !ethers.isHexString(log.data, 64)) return null;
    const decoded = VAULT_ABI.decodeEventLog("Swap", log.data, log.topics);
    const encoded = VAULT_ABI.encodeEventLog(VAULT_ABI.getEvent("Swap")!, decoded);
    if (encoded.data.toLowerCase() !== log.data.toLowerCase() ||
        encoded.topics.some((topic, i) => topic.toLowerCase() !== log.topics[i].toLowerCase())) return null;
    const id = poolIdentity(String(decoded.poolId)), tokenIn = nonzero(String(decoded.tokenIn)), tokenOut = nonzero(String(decoded.tokenOut));
    if (same(tokenIn, tokenOut) || decoded.amountIn <= 0n || decoded.amountOut <= 0n) return null;
    return { ...id, tokenIn, tokenOut, amountIn: BigInt(decoded.amountIn), amountOut: BigInt(decoded.amountOut) };
  } catch { return null; }
}
export const discovery = {
  evidenceChannel: "nominate" as const, txSeedNominations: true, sources: ["landed-log", "observed-call"],
  logPatterns: [{ id: LOG_ID, topic: SWAP_TOPIC, signature: "Swap(bytes32,address,address,uint256,uint256)",
    emitter: { mode: "singleton-indexed-bytes32" as const, address: VAULT, topicIndex: 1, fromBlock: 0 } }],
  callPatterns: [{ id: CALL_ID, selector: VAULT_ABI.getFunction("swap")!.selector as `0x${string}`,
    signature: VAULT_ABI.getFunction("swap")!.format("sighash"), candidateAddress: { from: "call-target" as const } }],
  addressSurfaces: [{ id: SURFACE_ID, kind: "interface" as const, fingerprint: SURFACE }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      let poolId: string, tokenIn: string | null = null, tokenOut: string | null = null;
      if (observation.kind === "log" && matchedPatternId === LOG_ID) {
        const swap = decodeSwapLog(observation); if (!swap) return null;
        ({ poolId, tokenIn, tokenOut } = swap);
      } else if (observation.kind === "call" && matchedPatternId === CALL_ID) {
        if (!same(observation.target, VAULT)) return null;
        const args = VAULT_ABI.decodeFunctionData("swap", observation.data);
        if (VAULT_ABI.encodeFunctionData("swap", args).toLowerCase() !== observation.data.toLowerCase()) return null;
        if ((args[0].kind !== 0n && args[0].kind !== 1n) || args[0].amount <= 0n) return null;
        poolId = String(args[0].poolId); tokenIn = nonzero(String(args[0].assetIn)); tokenOut = nonzero(String(args[0].assetOut));
        if (same(tokenIn, tokenOut)) return null;
      } else if (observation.kind === "address-surface" && matchedPatternId === SURFACE_ID &&
          observation.interfaceFingerprints?.includes(SURFACE)) {
        poolId = String((observation.opaque as Record<string, unknown> | undefined)?.poolId ?? "");
        if (!same(observation.address, poolIdentity(poolId).pool)) return null;
      } else return null;
      const id = poolIdentity(poolId);
      return Object.freeze({ candidateKind: "balancer-v2-pool" as const, pool: id.pool, poolId: id.poolId,
        hintedTokenIn: tokenIn, hintedTokenOut: tokenOut });
    } catch { return null; }
  },
  candidateKey: c => poolIdentity(c.poolId).poolId,
  instanceNominationKey: c => poolIdentity(String((c as Readonly<Record<string, unknown>>).poolId ?? "")).poolId,
  nominate: { nominate }, reverseBinding: { kind: "implementation" as const, reverseBinding },
} satisfies DiscoverySemantics<BalancerV2Candidate>;
