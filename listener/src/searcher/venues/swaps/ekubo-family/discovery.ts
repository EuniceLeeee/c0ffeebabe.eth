import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_ROUTER_SWAP_SELECTOR, ekuboRouterIface } from "../ekubo/abi.js";
import { decodeInitialized, decodeSwapCall, NO_RECEIVER, NO_RECEIVER_SELECTOR } from "./codec.js";
import { ekuboNomination, reverseBindEkubo } from "./nomination.js";
import type { EkuboCandidate } from "./types.js";

export const CALL_ID = "ekubo-vanilla-exact-input";
export const CALL_NO_RECEIVER_ID = "ekubo-vanilla-exact-input-no-receiver";
export const INIT_ID = "ekubo-core-pool-initialized";
export const ekuboDiscovery = {
  evidenceChannel: "nominate", txSeedNominations: true,
  sources: ["landed-log", "observed-call", "canonical-registry"],
  callPatterns: [{ id: CALL_ID, selector: EKUBO_ROUTER_SWAP_SELECTOR as `0x${string}`,
    signature: ekuboRouterIface.getFunction("swap")!.format("sighash"), candidateAddress: { from: "call-target" } },
    { id: CALL_NO_RECEIVER_ID, selector: NO_RECEIVER_SELECTOR as `0x${string}`,
      signature: NO_RECEIVER.getFunction("swap")!.format("sighash"), candidateAddress: { from: "call-target" } }],
  logPatterns: [{ id: INIT_ID, topic: EKUBO_POOL_INITIALIZED_TOPIC as `0x${string}`,
    signature: "PoolInitialized(bytes32,(address,address,bytes32),int32,uint96)" }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (matchedPatternId === CALL_ID || matchedPatternId === CALL_NO_RECEIVER_ID) {
        const selector = matchedPatternId === CALL_ID ? EKUBO_ROUTER_SWAP_SELECTOR : NO_RECEIVER_SELECTOR;
        if (observation.kind !== "call" || observation.data.slice(0, 10).toLowerCase() !== selector) return null;
        const decoded = decodeSwapCall(observation);
        return decoded ? Object.freeze({ candidateKind: decoded.candidateKind, poolId: decoded.poolId, poolKey: decoded.poolKey }) : null;
      }
      if (matchedPatternId === INIT_ID && observation.kind === "log") return decodeInitialized(observation);
      return null;
    } catch { return null; }
  },
  candidateKey: candidate => candidate.poolId.toLowerCase(),
  instanceNominationKey(value) {
    if (value === null || typeof value !== "object") throw new Error("ekubo invalid nomination key");
    const record = value as Readonly<Record<string, unknown>>;
    const id = record.poolId ?? record.address;
    if (typeof id !== "string" || !ethers.isHexString(id, 32)) throw new Error("ekubo invalid pool id");
    return id.toLowerCase();
  },
  nominate: ekuboNomination,
  reverseBinding: { kind: "implementation", reverseBinding: reverseBindEkubo },
} satisfies DiscoverySemantics<EkuboCandidate>;
