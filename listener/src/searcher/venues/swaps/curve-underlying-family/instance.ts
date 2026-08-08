import type {
  InstanceSemantics,
  RuntimeRequirement,
} from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingIdentity,
} from "./types.js";

const CURVE_UNDERLYING_RUNTIME_REQUIREMENTS = Object.freeze([
  Object.freeze({
    kind: "source-state" as const,
    freshness: "pinned-block" as const,
  }),
  Object.freeze({
    kind: "quote-completion" as const,
    mode: "return-data" as const,
  }),
] satisfies readonly RuntimeRequirement[]);

export const curveUnderlyingInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: CURVE_UNDERLYING_RUNTIME_REQUIREMENTS,
      pool: canonicalAddress(identity.facts.pool),
      coins: Object.freeze([...identity.facts.coins]),
      registryBinding: identity.facts.registryBinding,
      verifiedDirections: Object.freeze([...identity.facts.verifiedDirections]),
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      coins: Object.freeze([...draft.coins]),
      registryBinding: Object.freeze({
        ...draft.registryBinding,
        handlers: Object.freeze([...draft.registryBinding.handlers]),
      }),
      verifiedDirections: Object.freeze(
        draft.verifiedDirections.map((direction) => Object.freeze({ ...direction })),
      ),
    });
  },
  staticBindingProjection: curveUnderlyingStaticBindingProjection,
} satisfies InstanceSemantics<CurveUnderlyingIdentity, CurveUnderlyingDescriptor>;

export function curveUnderlyingStaticBindingProjection(
  descriptor: CurveUnderlyingDescriptor,
) {
  return {
    pool: descriptor.pool,
    coins: descriptor.coins,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      handlers: descriptor.registryBinding.handlers,
      lookupSemantics: descriptor.registryBinding.lookupSemantics,
    },
    verifiedDirections: descriptor.verifiedDirections.map((direction) => ({
      i: direction.i,
      j: direction.j,
      tokenIn: direction.tokenIn,
      tokenOut: direction.tokenOut,
    })),
  };
}
