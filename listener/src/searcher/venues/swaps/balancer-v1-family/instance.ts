import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Descriptor, Identity } from "./types.js";
export function staticBinding(d: Descriptor) {
  return { pool: d.pool, factory: d.factory, model: d.model, poolCodeHash: d.poolCodeHash, factoryCodeHash: d.factoryCodeHash,
    tokens: [...d.tokens], weights: [...d.weights], swapFee: d.swapFee };
}
export const instance = {
  instanceKey: i => instanceKey(i.facts.pool),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.facts.pool),
    ...i.facts, provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }), staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<Identity, Descriptor>;
