import type {
  InstanceSemantics,
  RuntimeRequirement,
} from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import type { FluidCreditDescriptor, FluidCreditIdentity } from "./types.js";

const FLUID_CREDIT_RUNTIME_REQUIREMENTS = Object.freeze([
  Object.freeze({
    kind: "source-state" as const,
    freshness: "pinned-block" as const,
  }),
  Object.freeze({
    kind: "execution-actor" as const,
    role: "executor" as const,
  }),
  Object.freeze({
    kind: "effect-observation" as const,
    effects: Object.freeze(["token-delta" as const]),
  }),
] satisfies readonly RuntimeRequirement[]);

export const fluidCreditInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: FLUID_CREDIT_RUNTIME_REQUIREMENTS,
      vault: canonicalAddress(identity.facts.vault),
      supplyToken: canonicalAddress(identity.facts.supplyToken),
      borrowToken: canonicalAddress(identity.facts.borrowToken),
      supplyDecimals: identity.facts.supplyDecimals,
      borrowDecimals: identity.facts.borrowDecimals,
      factoryBinding: identity.facts.factoryBinding,
    };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    provenance: Object.freeze([...draft.provenance]),
    runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
    factoryBinding: Object.freeze({ ...draft.factoryBinding }),
  }),
  staticBindingProjection: fluidCreditStaticBindingProjection,
} satisfies InstanceSemantics<FluidCreditIdentity, FluidCreditDescriptor>;

export function fluidCreditStaticBindingProjection(
  descriptor: FluidCreditDescriptor,
) {
  return {
    vault: descriptor.vault,
    supplyToken: descriptor.supplyToken,
    borrowToken: descriptor.borrowToken,
    supplyDecimals: descriptor.supplyDecimals,
    borrowDecimals: descriptor.borrowDecimals,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      vaultId: descriptor.factoryBinding.vaultId,
      reverseVault: descriptor.factoryBinding.reverseVault,
    },
  };
}
