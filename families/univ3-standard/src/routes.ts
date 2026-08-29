import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type UniV3IdentityV1, type UniV3RouteV1 } from "./types.ts";

export function deriveUniV3Routes(identity: UniV3IdentityV1): readonly UniV3RouteV1[] {
  const { token0, token1, pool } = identity.facts;
  const routes = [
    { instanceKey: pool, inputToken: token0, outputToken: token1, zeroForOne: true },
    { instanceKey: pool, inputToken: token1, outputToken: token0, zeroForOne: false },
  ].map(route => Object.freeze({ ...route, routeBindingHash: hashDomain("aloha/univ3-standard/route-binding/v1", route) }));
  return Object.freeze(routes);
}

export function assertUniV3Route(route: UniV3RouteV1, identity: UniV3IdentityV1): void {
  if (route.instanceKey !== identity.instanceKey || ![identity.facts.token0, identity.facts.token1].includes(canonicalAddress(route.inputToken)) || ![identity.facts.token0, identity.facts.token1].includes(canonicalAddress(route.outputToken)) || route.inputToken === route.outputToken) throw new TypeError("univ3 route identity mismatch");
  const expected = hashDomain("aloha/univ3-standard/route-binding/v1", { instanceKey: route.instanceKey, inputToken: route.inputToken, outputToken: route.outputToken, zeroForOne: route.zeroForOne });
  if (route.routeBindingHash !== expected) throw new TypeError("univ3 route binding mismatch");
}
