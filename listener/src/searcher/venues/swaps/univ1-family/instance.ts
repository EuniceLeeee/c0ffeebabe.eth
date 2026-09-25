import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Descriptor, Identity } from "./types.js";
export function staticBinding(d: Descriptor) {
  return { pool: d.pool, token: d.token, factory: d.factory, issuer: d.issuer, implementation: d.implementation,
    codeHash: d.codeHash, implementationCodeHash: d.implementationCodeHash, factoryCodeHash: d.factoryCodeHash,
    decimals: d.decimals, model: d.model };
}
export const instance = {
  instanceKey: i => instanceKey(i.facts.pool),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.facts.pool),
    ...i.facts, provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }), staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<Identity, Descriptor>;
