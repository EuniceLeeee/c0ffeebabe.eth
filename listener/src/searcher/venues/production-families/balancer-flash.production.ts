import { defineFamilyActivation } from "./activation.js";
import { defineFundingFamily } from "../adapter-family-plugin.js";
import { balancerFlashCapture } from "../funding/balancer-flash-family/capture.js";
import {
  balancerFlashFamilyOwnedAction,
  balancerFlashFunding,
  balancerFlashManifest,
} from "../funding/balancer-flash-family/parts.js";
import { balancerFlashDiscovery } from
  "../funding/balancer-flash-family/discovery.js";

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_BALANCER_FLASH_ENABLED" });

export const plugin = defineFundingFamily({
  manifest: balancerFlashManifest,
  capture: balancerFlashCapture,
  discovery: balancerFlashDiscovery,
  funding: balancerFlashFunding,
  actionAdapters: [balancerFlashFamilyOwnedAction],
});
