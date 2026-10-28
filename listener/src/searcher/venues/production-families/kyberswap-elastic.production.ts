import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { kyberswapElasticSwapAction } from
  "../swaps/kyberswap-elastic-family/action.js";
import { kyberswapElasticCapture } from
  "../swaps/kyberswap-elastic-family/capture.js";
import { kyberswapElasticDiscovery } from
  "../swaps/kyberswap-elastic-family/discovery.js";
import { kyberswapElasticExact } from
  "../swaps/kyberswap-elastic-family/exact.js";
import { kyberswapElasticExecution } from
  "../swaps/kyberswap-elastic-family/execution.js";
import { kyberswapElasticIdentity } from
  "../swaps/kyberswap-elastic-family/identity.js";
import { kyberswapElasticInstance } from
  "../swaps/kyberswap-elastic-family/instance.js";
import { kyberswapElasticManifest } from
  "../swaps/kyberswap-elastic-family/manifest.js";
import { kyberswapElasticPricing } from
  "../swaps/kyberswap-elastic-family/pricing.js";
import { kyberswapElasticRoutes } from
  "../swaps/kyberswap-elastic-family/routes.js";
import { kyberswapElasticSwap } from
  "../swaps/kyberswap-elastic-family/swap.js";

/**
 * Registered DISABLED by default: adding this family must not change the
 * production default enabled set. Acceptance runs opt in explicitly with
 * SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED=1; whether it becomes enabled by
 * default is an integrator decision.
 */
export const activation = defineFamilyActivation({
  enabled: false,
  envKey: "SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED",
});

export const plugin = defineSwapFamily({
  manifest: kyberswapElasticManifest,
  discovery: kyberswapElasticDiscovery,
  identity: kyberswapElasticIdentity,
  instance: kyberswapElasticInstance,
  routes: kyberswapElasticRoutes,
  pricing: kyberswapElasticPricing,
  exact: kyberswapElasticExact,
  execution: kyberswapElasticExecution,
  swap: kyberswapElasticSwap,
  capture: kyberswapElasticCapture,
  actionAdapters: [kyberswapElasticSwapAction],
});
