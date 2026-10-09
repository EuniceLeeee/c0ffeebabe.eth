import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { CanonicalValue } from "../../canonical-value.js";
import { canonicalAddress } from "./codec.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralIdentity,
} from "./types.js";

type Draft = AlgebraIntegralDescriptor;

export const algebraIntegralInstance = {
  instanceKey: (identity) =>
    instanceKey(canonicalAddress(identity.subject).toLowerCase()),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(canonicalAddress(identity.subject).toLowerCase()),
      provenance: identity.provenance,
      runtimeRequirements: [],
      pool: identity.facts.pool,
      token0: identity.facts.token0,
      token1: identity.facts.token1,
      tickSpacing: identity.facts.tickSpacing,
      factoryBinding: identity.facts.factoryBinding,
      executedFee: identity.facts.executedFee,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      factoryBinding: Object.freeze({ ...draft.factoryBinding }),
      executedFee: Object.freeze({ ...draft.executedFee }),
    });
  },
  staticBindingProjection,
} satisfies InstanceSemantics<
  AlgebraIntegralIdentity,
  AlgebraIntegralDescriptor,
  Draft
>;

/**
 * The static binding deliberately excludes live pool state: price, liquidity and
 * the fee read are per-source pricing facts, not instance identity. A `setFee`
 * on the pool mutates the instance's state key instead (see the mutation index),
 * which reruns identity and recompiles this descriptor.
 */
export function staticBindingProjection(
  descriptor: AlgebraIntegralDescriptor,
): CanonicalValue {
  return {
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    tickSpacing: descriptor.tickSpacing,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
    executedFee: {
      kind: descriptor.executedFee.kind,
      plugin: descriptor.executedFee.plugin,
      pluginConfig: descriptor.executedFee.pluginConfig,
    },
  };
}
