import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { PAIR, SWAP_EVENT, SWAP_SELECTOR, SWAP_TOPIC, address } from "./codec.js";
import { decodeSwapLog } from "./simulation.js";
import type { Candidate } from "./types.js";

export const LOG = "ammalgam-pair-swap-log";
export const CALL = "ammalgam-pair-swap-call";

function candidate(pair: string): Candidate {
  return { candidateKind: "ammalgam-pair", pair: address(pair) };
}

export const discovery = {
  evidenceChannel: "nominate",
  txSeedNominations: true,
  sources: ["landed-log", "observed-call"],
  logPatterns: [{
    id: LOG,
    topic: SWAP_TOPIC as `0x${string}`,
    signature: SWAP_EVENT.format("sighash"),
  }],
  callPatterns: [{
    id: CALL,
    selector: SWAP_SELECTOR as `0x${string}`,
    signature: PAIR.getFunction("swap")!.format("sighash"),
    candidateAddress: { from: "call-target" },
  }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "log" && id === LOG) {
        return decodeSwapLog(o) ? candidate(o.address) : null;
      }
      if (o.kind === "call" && id === CALL) {
        const decoded = PAIR.decodeFunctionData("swap", o.data);
        address(decoded[2] as string);
        return PAIR.encodeFunctionData("swap", decoded).toLowerCase() === o.data.toLowerCase()
          ? candidate(o.target)
          : null;
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: c => c.pair,
  instanceNominationKey: c => (c as Candidate).pair,
  nominate: {
    async nominate({ nominations, source, provider }) {
      const out: UnifiedObservation[] = [];
      const receipts = new Map<string, Awaited<ReturnType<typeof provider.getTransactionReceipt>>>();
      for (const nomination of nominations) {
        const opaque = nomination.opaque && typeof nomination.opaque === "object" && !Array.isArray(nomination.opaque)
          ? nomination.opaque as Readonly<Record<string, unknown>>
          : {};
        const tx = nomination.evidence?.transactionHash ?? opaque.transactionHash;
        if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) continue;
        const hash = tx.toLowerCase();
        if (!receipts.has(hash)) receipts.set(hash, await provider.getTransactionReceipt(hash));
        const receipt = receipts.get(hash);
        if (!receipt || receipt.blockNumber === undefined || !Number.isSafeInteger(receipt.blockNumber) ||
            receipt.blockNumber > source.number) continue;
        const expectedBlock = nomination.evidence?.blockNumber ?? opaque.blockNumber;
        if (expectedBlock !== undefined && expectedBlock !== receipt.blockNumber) continue;
        for (const log of receipt.logs) {
          if (address(log.address) !== address(nomination.address)) continue;
          if (!decodeSwapLog(log)) continue;
          out.push({ kind: "log", source, ...log, transactionHash: hash });
        }
      }
      return out;
    },
  },
  reverseBinding: {
    kind: "explicitly-unsupported",
    reason: "A cold pair address carries no self-describing market; landed Swap/Sync logs nominate a pair and identity binds the beacon proxy, the installed AmmalgamPair implementation and the pair's own underlyingTokens.",
  },
} satisfies DiscoverySemantics<Candidate>;
