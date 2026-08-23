import { hashCanonical } from "../../canonical-value.js";
import { univ4Routes as baseRoutes } from "../univ4-family/routes.js";
import type { FeeHookDescriptor, FeeHookRoute } from "./types.js";

/**
 * Same route projection as the standard univ4 Family, with the fee-hook
 * edge action adapter id so graph ownership stays family-local.
 */
export const univ4FeeHookRoutes = {
  project({ descriptor }: { readonly descriptor: FeeHookDescriptor }) {
    return baseRoutes.project({ descriptor }) as unknown as FeeHookRoute[];
  },
  projectGraph({ descriptor, route }: {
    readonly descriptor: FeeHookDescriptor;
    readonly route: FeeHookRoute;
  }) {
    return {
      routeActionAdapterId: "univ4-fee-hook-unlock",
      executionTarget: descriptor.managerBinding.manager,
      venueIdentity: Object.freeze({
        kind: "manager-pool-id" as const,
        manager: descriptor.managerBinding.manager.toLowerCase(),
        poolId: descriptor.poolId.toLowerCase(),
      }),
      centralScoreKey: route.routeKey,
    };
  },
};
