import { factoryIdentityResolver } from "../../../identity.js";
import type { SwapAdapter } from "../../../route-leg-adapter.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from "../../../production-family-composition.js";
import { createStrictRegistryProjection } from "../../../strict-catalog-registry-projection.js";

const projected = createStrictRegistryProjection(PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG)
  .find(family => family.id === "univ2-standard");
if (!projected || projected.kind !== "swap") throw new Error("production UniV2 projection is unavailable");

// Registry tests opt into their own pending observers. All Family declarations
// come from the public strict projection, with no previous adapter import.
export const univ2AdapterFixture = {
  ...projected,
  poolAdapters: ["univ2"],
  identityPolicies: [{ poolAdapter: "univ2", policy: "onchain-resolver", resolve: factoryIdentityResolver }],
} satisfies SwapAdapter;
