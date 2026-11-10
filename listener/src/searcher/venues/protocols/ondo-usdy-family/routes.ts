import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { ondoStaticProjection } from "./instance.js";
import type { OndoDescriptor, OndoRoute } from "./types.js";

export const ondoRoutes = {
  project({ descriptor }) {
    return Object.freeze([Object.freeze({
      routeKey: routeKey(`${FAMILY}\u001f${lowerAddress(descriptor.manager)}`),
      familyId: FAMILY, lineageId: LINEAGE, instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.rwa, tokenOut: descriptor.receive,
      executionAssets: Object.freeze({ input: "erc20" as const, output: "erc20" as const }),
      taxonomy: Object.freeze({ slotKind: "protocol" as const, protocolAction: "redeem" as const }),
      bindingRef: Object.freeze({ bindingKey: lowerAddress(descriptor.manager), fingerprint: hashCanonical(ondoStaticProjection(descriptor)) }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.manager, direction: "redeem" as const, adapterId: "ondo-usdy-redeem" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.manager,
      venueIdentity: Object.freeze({ kind: "address-protocol" as const, target: lowerAddress(descriptor.manager) }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<OndoDescriptor, OndoRoute>;
