import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { mellowQueueStaticProjection } from "./shared.js";
import type {
  MellowQueueDescriptor,
  MellowQueueRoute,
} from "./types.js";

export const mellowQueueRoutes = {
  project({ descriptor }) {
    const deposit = descriptor.kind === "deposit";
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${FAMILY}\u001f${lowerAddress(descriptor.queue)}\u001f${descriptor.kind}`,
      ),
      familyId: FAMILY,
      lineageId: LINEAGE,
      instanceKey: descriptor.instanceKey,
      tokenIn: deposit ? descriptor.asset : descriptor.share,
      tokenOut: deposit ? descriptor.share : descriptor.asset,
      executionAssets: Object.freeze({ input: "erc20" as const, output: "erc20" as const }),
      taxonomy: deposit
        ? Object.freeze({ slotKind: "protocol" as const, protocolAction: "wrap" as const })
        : Object.freeze({ slotKind: "protocol" as const, protocolAction: "redeem" as const }),
      bindingRef: Object.freeze({
        bindingKey: lowerAddress(descriptor.queue),
        fingerprint: hashCanonical(mellowQueueStaticProjection(descriptor)),
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.queue,
      direction: deposit ? "deposit-to-share" as const : "redeem-to-asset" as const,
      adapterId: deposit ? "mellow-deposit" as const : "mellow-redeem" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.queue,
      venueIdentity: Object.freeze({
        kind: "address-protocol" as const,
        target: lowerAddress(descriptor.queue),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<MellowQueueDescriptor, MellowQueueRoute>;
