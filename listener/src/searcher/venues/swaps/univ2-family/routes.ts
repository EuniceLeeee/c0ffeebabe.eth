import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "./codec.js";
import type { UniV2Descriptor, UniV2Route } from "./types.js";

export const univ2Routes = {
  project({ descriptor }) {
    const bindingFingerprint = hashCanonical(staticBinding(descriptor));
    return Object.freeze([
      route(descriptor, "zero-for-one", bindingFingerprint),
      route(descriptor, "one-for-zero", bindingFingerprint),
    ]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "univ2-swap",
      executionTarget: descriptor.pool,
      venueIdentity: Object.freeze({
        kind: "address-pool",
        pool: lowerAddress(descriptor.pool),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<UniV2Descriptor, UniV2Route>;

function route(
  descriptor: UniV2Descriptor,
  direction: UniV2Route["direction"],
  bindingFingerprint: string,
): UniV2Route {
  const zeroForOne = direction === "zero-for-one";
  const tokenIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const tokenOut = zeroForOne ? descriptor.token1 : descriptor.token0;
  return Object.freeze({
    routeKey: routeKey([
      descriptor.familyId,
      lowerAddress(descriptor.pool),
      lowerAddress(tokenIn),
      lowerAddress(tokenOut),
    ].join("\u001f")),
    familyId: descriptor.familyId,
    lineageId: descriptor.lineageId,
    instanceKey: descriptor.instanceKey,
    tokenIn,
    tokenOut,
    taxonomy: Object.freeze({ slotKind: "swap" as const }),
    bindingRef: Object.freeze({
      bindingKey: lowerAddress(descriptor.pool),
      fingerprint: bindingFingerprint,
    }),
    runtimeRequirements: Object.freeze([]),
    pool: descriptor.pool,
    direction,
    feeBps: descriptor.feeRule.feeBps,
  });
}

function staticBinding(descriptor: UniV2Descriptor) {
  return {
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    feeRule: {
      kind: descriptor.feeRule.kind,
      feeBps: descriptor.feeRule.feeBps,
      evidence: descriptor.feeRule.evidence,
    },
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
  };
}
