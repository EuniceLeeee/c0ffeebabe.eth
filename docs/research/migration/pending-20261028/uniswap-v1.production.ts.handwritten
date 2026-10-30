import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { action } from "../swaps/univ1-family/action.js";
import { capture } from "../swaps/univ1-family/capture.js";
import { discovery } from "../swaps/univ1-family/discovery.js";
import { exact } from "../swaps/univ1-family/exact.js";
import { execution } from "../swaps/univ1-family/execution.js";
import { identity } from "../swaps/univ1-family/identity.js";
import { instance } from "../swaps/univ1-family/instance.js";
import { manifest } from "../swaps/univ1-family/manifest.js";
import { pricing } from "../swaps/univ1-family/pricing.js";
import { routes } from "../swaps/univ1-family/routes.js";
import { swap } from "../swaps/univ1-family/swap.js";
export const plugin = defineSwapFamily({ manifest, discovery, identity, instance, routes, pricing, exact, execution, swap, capture, actionAdapters: [action] });

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_UNISWAP_V1_ENABLED" });
