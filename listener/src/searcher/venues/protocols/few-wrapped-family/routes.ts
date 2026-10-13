import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { projection,assertInvocation } from "./binding.js";
import type { Descriptor,Route } from "./types.js";
export const routes = {
  project:({descriptor:d})=>(["wrap","unwrap"] as const).map(direction=>({
    familyId:d.familyId,lineageId:d.lineageId,instanceKey:d.instanceKey,target:d.target,direction,
    adapterId:`few-${direction}` as const,routeKey:routeKey(`${d.familyId}\u001f${d.target.toLowerCase()}\u001f${direction}`),
    tokenIn:direction==="wrap"?d.asset:d.target,tokenOut:direction==="wrap"?d.target:d.asset,
    taxonomy:{slotKind:"protocol" as const,protocolAction:direction},
    bindingRef:{bindingKey:d.target.toLowerCase(),fingerprint:hashCanonical(projection(d))},runtimeRequirements:d.runtimeRequirements,
  })),
  projectGraph({descriptor:d,route:r}) {assertInvocation(d,r);return {routeActionAdapterId:r.adapterId,executionTarget:d.target,
    venueIdentity:{kind:"address-protocol",target:d.target.toLowerCase()},centralScoreKey:r.routeKey};},
} satisfies RouteProjectionSemantics<Descriptor,Route>;
