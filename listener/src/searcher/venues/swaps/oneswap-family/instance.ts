import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Descriptor, Identity } from "./types.js";
export function binding(d: Descriptor) {
  return { pool: d.pool, factory: d.factory, stock: d.stock, money: d.money, ones: d.ones, isOnlySwap: d.isOnlySwap,
    stockUnit: d.stockUnit, priceMul: d.priceMul, priceDiv: d.priceDiv, implementation: d.implementation,
    codeHash: d.codeHash, implementationCodeHash: d.implementationCodeHash, factoryCodeHash: d.factoryCodeHash };
}
export const instance = {
  instanceKey: i => instanceKey(i.facts.pool),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.facts.pool), ...i.facts,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }), staticBindingProjection: binding,
} satisfies InstanceSemantics<Identity, Descriptor>;
