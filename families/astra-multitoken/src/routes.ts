import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { AstraInstanceV1, AstraRouteV1 } from "./types.ts";

export function deriveAstraRoutes(instance: AstraInstanceV1): readonly AstraRouteV1[] {
  const routes: AstraRouteV1[] = [];
  let pairIndex = 0;
  for (const tokenIn of instance.identity.tokens) {
    for (const tokenOut of instance.identity.tokens) {
      if (tokenIn === tokenOut) continue;
      const bindingFingerprint = hashDomain("aloha/astra-multitoken/route-binding/v1", { target: instance.target, tokens: instance.identity.tokens, tokenCodeHashes: instance.identity.tokenCodeHashes, weights: instance.identity.weights.map(value => value.toString()) });
      routes.push(Object.freeze({ routeKey: `${instance.instanceKey}:${tokenIn}:${tokenOut}`, instanceKey: instance.instanceKey, target: instance.target, tokenIn, tokenOut, pairIndex, bindingFingerprint }));
      pairIndex += 1;
    }
  }
  return Object.freeze(routes);
}

export function assertAstraRoute(route: AstraRouteV1, instance: AstraInstanceV1): void {
  if (route.instanceKey !== instance.instanceKey || route.target !== instance.target || route.tokenIn === route.tokenOut || !instance.identity.tokens.includes(route.tokenIn) || !instance.identity.tokens.includes(route.tokenOut)) throw new TypeError("astra route identity mismatch");
  const expected = deriveAstraRoutes(instance).find(candidate => candidate.routeKey === route.routeKey);
  if (expected === undefined || expected.bindingFingerprint !== route.bindingFingerprint || expected.pairIndex !== route.pairIndex) throw new TypeError("astra route binding mismatch");
}
