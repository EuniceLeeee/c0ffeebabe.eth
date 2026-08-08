import type { RouteProjectionSemantics } from
  "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { eigenpieStaticBindingProjection } from "./binding.js";
import {
  EIGENPIE_FAMILY_ID,
  EIGENPIE_LINEAGE_ID,
} from "./manifest.js";
import type { EigenpieDescriptor, EigenpieRoute } from "./types.js";

export const eigenpieRoutes = {
  project({ descriptor }) {
    const fingerprint = hashCanonical(
      eigenpieStaticBindingProjection(descriptor),
    );
    return Object.freeze([Object.freeze({
      routeKey: routeKey(
        `${EIGENPIE_FAMILY_ID}\u001f${descriptor.instanceKey}\u001fdeposit-asset`,
      ),
      familyId: EIGENPIE_FAMILY_ID,
      lineageId: EIGENPIE_LINEAGE_ID,
      instanceKey: descriptor.instanceKey,
      tokenIn: descriptor.asset,
      tokenOut: descriptor.receipt,
      taxonomy: Object.freeze({
        slotKind: "protocol" as const,
        protocolAction: "wrap" as const,
      }),
      bindingRef: Object.freeze({
        bindingKey: descriptor.instanceKey,
        fingerprint,
      }),
      runtimeRequirements: descriptor.runtimeRequirements,
      target: descriptor.target,
      direction: "deposit-asset" as const,
      adapterId: "eigenpie-deposit-asset" as const,
    })]);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: route.adapterId,
      executionTarget: descriptor.target,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: descriptor.target.toLowerCase(),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<EigenpieDescriptor, EigenpieRoute>;
