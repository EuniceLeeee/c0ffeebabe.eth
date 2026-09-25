import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "../../adapter-family-plugin.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import { ABI, nonzero } from "./codec.js";
import type { Candidate } from "./types.js";
export const LOG_ID = "token-migration-migrated";
export const TOPIC = ABI.getEvent("TokensMigrated")!.topicHash as `0x${string}`;
const callPatterns = ["migrateBIT", "migrateAllBIT"].map(name => ({
  id: `token-migration-${name}`, selector: ABI.getFunction(name)!.selector as `0x${string}`,
  signature: ABI.getFunction(name)!.format("sighash"), candidateAddress: { from: "call-target" as const },
}));
export const discovery = {
  evidenceChannel: "nominate", sources: ["observed-call", "landed-log"],
  candidateSources: ["observed-interaction"], txSeedNominations: true, callPatterns,
  logPatterns: [{ id: LOG_ID, topic: TOPIC, signature: "TokensMigrated(address,uint256,uint256)" }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      let target: string;
      if (observation.kind === "log" && matchedPatternId === LOG_ID) {
        if (observation.topics.length !== 2 || observation.topics[0].toLowerCase() !== TOPIC ||
            !/^0x0{24}[0-9a-fA-F]{40}$/.test(observation.topics[1]) || !/^0x[0-9a-fA-F]{128}$/.test(observation.data)) return null;
        const log = ABI.decodeEventLog("TokensMigrated", observation.data, [...observation.topics]);
        if (BigInt(log[1]) <= 0n) return null;
        target = nonzero(observation.address);
      } else if (observation.kind === "call") {
        const pattern = callPatterns.find(p => p.id === matchedPatternId);
        if (!pattern || observation.data.slice(0, 10).toLowerCase() !== pattern.selector) return null;
        const parsed = ABI.parseTransaction({ data: observation.data });
        if (!parsed || ABI.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== observation.data.toLowerCase()) return null;
        if (parsed.name === "migrateBIT" && BigInt(parsed.args[0]) <= 0n) return null;
        target = nonzero(observation.target);
      } else return null;
      return Object.freeze({ candidateKind: "token-migration" as const, target });
    } catch { return null; }
  },
  candidateKey: c => c.target.toLowerCase(),
  nominate: createTxEvidenceNomination({ opaqueLabels: ["token-migration", "protocol:token-migration"], callPatterns }),
  reverseBinding: explicitReverseBindingUnsupported("Standalone immutable runtime proof; no factory or registry creation claim"),
} satisfies DiscoverySemantics<Candidate>;
