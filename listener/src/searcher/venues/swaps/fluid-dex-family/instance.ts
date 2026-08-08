import type {
  InstanceSemantics,
  RuntimeRequirement,
} from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import type { FluidDexDescriptor, FluidDexIdentity } from "./types.js";

const FLUID_DEX_RUNTIME_REQUIREMENTS = Object.freeze([
  Object.freeze({
    kind: "source-state" as const,
    freshness: "pinned-block" as const,
  }),
  Object.freeze({
    kind: "quote-completion" as const,
    mode: "return-or-revert-data" as const,
  }),
] satisfies readonly RuntimeRequirement[]);

export const fluidDexInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: FLUID_DEX_RUNTIME_REQUIREMENTS,
      pool: canonicalAddress(identity.facts.pool),
      token0: canonicalAddress(identity.facts.token0),
      token1: canonicalAddress(identity.facts.token1),
      token0Decimals: identity.facts.token0Decimals,
      token1Decimals: identity.facts.token1Decimals,
      factoryBinding: identity.facts.factoryBinding,
      quoteBinding: identity.facts.quoteBinding,
    };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    provenance: Object.freeze([...draft.provenance]),
    runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
    factoryBinding: Object.freeze({ ...draft.factoryBinding }),
    quoteBinding: Object.freeze({ ...draft.quoteBinding }),
  }),
  staticBindingProjection: fluidDexStaticBindingProjection,
} satisfies InstanceSemantics<FluidDexIdentity, FluidDexDescriptor>;

export function fluidDexStaticBindingProjection(descriptor: FluidDexDescriptor) {
  return {
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    token0Decimals: descriptor.token0Decimals,
    token1Decimals: descriptor.token1Decimals,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      dexId: descriptor.factoryBinding.dexId,
      reverseDex: descriptor.factoryBinding.reverseDex,
    },
    quoteBinding: {
      target: descriptor.quoteBinding.target,
      recipient: descriptor.quoteBinding.recipient,
      completion: descriptor.quoteBinding.completion,
      successEncoding: descriptor.quoteBinding.successEncoding,
    },
  };
}
