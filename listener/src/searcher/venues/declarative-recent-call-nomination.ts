import { getAddress, isHexString } from "ethers";
import type { CallPattern, CaptureNominationSemantics, UnifiedObservation } from "./adapter-family-plugin.js";
import type { ReadFlowValues } from "./declarative-read-flow.js";
import { findRecentLogHit } from "./recent-log-lookup.js";
import { createTxEvidenceNomination } from "./tx-evidence-nomination.js";

/** A durable pool id can outlive its original calldata. Find the most recent genuine
 * call matching that same id; an unrelated call in the same transaction cannot nominate it. */
export function withRecentCallNomination(input: {
  base: CaptureNominationSemantics;
  declaration: { emitter: string; topic: string; when: unknown; nominationKey: unknown; candidateKey: unknown };
  labels: readonly string[];
  values: ReadFlowValues;
  callPatterns: readonly CallPattern[];
  decode(observation: UnifiedObservation): unknown;
}): CaptureNominationSemantics {
  const { declaration: d, values } = input;
  const emitter = getAddress(d.emitter);
  if (!isHexString(d.topic,32)) throw new Error("invalid recent-call nomination topic");
  const labels = new Set(input.labels.map(s => s.toLowerCase()));
  return { async nominate({nominations,provider,source}) {
    const gathered: UnifiedObservation[] = [];
    for (const nomination of nominations) {
      const row = nomination.opaque;
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          !Object.entries(row).some(([key,value]) => ["adapter","adapterId","venueId","familyId"].includes(key) &&
            typeof value==="string" && labels.has(value.toLowerCase()))) continue;
      const env={ nomination, source };
      if (values.evaluate(d.when,env) !== true) {
        const observed = await input.base.nominate({nominations:[nomination],provider,source});
        for (const observation of observed) if (input.decode(observation)) gathered.push(observation);
        continue;
      }
      const id=values.evaluate(d.nominationKey,env);
      if (!isHexString(id,32) || !provider.traceTransaction) continue;
      const select = createTxEvidenceNomination({ opaqueLabels: input.labels, allMatches:true, callPatterns:input.callPatterns,
        acceptObservation(observation) {
          const candidate=input.decode(observation);
          if (!candidate) return false;
          const actual=values.evaluate(d.candidateKey,{candidate});
          return typeof actual==="string" && actual.toLowerCase()===id.toLowerCase();
        } });
      let found: readonly UnifiedObservation[]=[];
      await findRecentLogHit({provider,source,address:emitter,topics:[d.topic,id],accept:async log=>{
        if (!isHexString(log.transactionHash,32)) return false;
        found = await select.nominate({nominations:[{address:nomination.address,opaque:{...row,txHash:log.transactionHash!}}],
          provider,source});
        return found.length>0;
      }});
      if(found[0])gathered.push(found[0]);
    }
    return Object.freeze(gathered);
  } };
}
