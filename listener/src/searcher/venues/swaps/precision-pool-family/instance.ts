import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Descriptor, Identity } from "./types.js";
export function binding(d: Descriptor) {
  return { pool: d.pool, factory: d.factory, token0: d.token0, token1: d.token1, sqrtPLow: d.sqrtPLow, sqrtPHigh: d.sqrtPHigh,
    fee: d.fee, hook: d.hook, feeRecipient: d.feeRecipient, creatorFeeBps: d.creatorFeeBps, codeHash: d.codeHash,
    trustedExecutor: d.trustedExecutor, poolCode: d.poolCode, poolInitCodeHash: d.poolInitCodeHash, factoryCodeHash: d.factoryCodeHash };
}
export const instance = {
  instanceKey: i => instanceKey(i.facts.pool),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.facts.pool), ...i.facts,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }), staticBindingProjection: binding,
} satisfies InstanceSemantics<Identity, Descriptor>;
