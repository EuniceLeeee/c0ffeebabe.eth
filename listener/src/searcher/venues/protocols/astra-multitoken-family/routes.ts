import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import { routeKey } from "../../adapter-family-identifiers.js";
import { astraBindingFingerprint } from "./binding.js";
import { lowerAddress } from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
} from "./types.js";

export const astraMultiTokenRoutes = {
  project({ descriptor }) {
    const bindingFingerprint = astraBindingFingerprint(descriptor);
    const routes: AstraMultiTokenRoute[] = [];
    let pairIndex = 0;
    for (const tokenIn of descriptor.registryBinding.tokens) {
      for (const tokenOut of descriptor.registryBinding.tokens) {
        if (lowerAddress(tokenIn) === lowerAddress(tokenOut)) continue;
        routes.push(Object.freeze({
          routeKey: routeKey([
            descriptor.familyId,
            lowerAddress(descriptor.target),
            lowerAddress(tokenIn),
            lowerAddress(tokenOut),
          ].join("\u001f")),
          familyId: descriptor.familyId,
          lineageId: descriptor.lineageId,
          instanceKey: descriptor.instanceKey,
          tokenIn,
          tokenOut,
          taxonomy: Object.freeze({
            slotKind: "protocol" as const,
            protocolAction: "convert" as const,
          }),
          bindingRef: Object.freeze({
            bindingKey: lowerAddress(descriptor.target),
            fingerprint: bindingFingerprint,
          }),
          runtimeRequirements: Object.freeze([
            ...descriptor.runtimeRequirements,
          ]),
          target: descriptor.target,
          pairIndex: pairIndex++,
        }));
      }
    }
    return Object.freeze(routes);
  },
  projectGraph({ descriptor, route }) {
    return Object.freeze({
      routeActionAdapterId: "astra-multitoken-change",
      executionTarget: descriptor.target,
      venueIdentity: Object.freeze({
        kind: "address-protocol",
        target: lowerAddress(descriptor.target),
      }),
      centralScoreKey: route.routeKey,
    });
  },
} satisfies RouteProjectionSemantics<
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute
>;
