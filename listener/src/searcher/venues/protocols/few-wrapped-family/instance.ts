import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { projection } from "./binding.js";
import type { Identity,Descriptor } from "./types.js";
export const instance = {
  instanceKey:i=>instanceKey(i.target.toLowerCase()),
  compileDraft:i=>({familyId:i.familyId,lineageId:i.lineageId,instanceKey:instanceKey(i.target.toLowerCase()),provenance:i.provenance,
    target:i.target,asset:i.asset,factory:i.factory,codeHash:i.codeHash,assetCodeHash:i.assetCodeHash,factoryCodeHash:i.factoryCodeHash,
    runtimeRequirements:[{kind:"source-state",freshness:"pinned-block"}]}),
  finalizeDescriptor:({draft})=>draft,staticBindingProjection:projection,
} satisfies InstanceSemantics<Identity,Descriptor>;
