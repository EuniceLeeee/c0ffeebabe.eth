import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  balancerFlashFamilyOwnedAction,
  balancerFlashFunding,
  balancerFlashManifest,
} from "./balancer-flash-family/parts.js";
import { balancerFlashDiscovery } from
  "./balancer-flash-family/discovery.js";

export const balancerFlashPlugin = defineFundingFamily({
  manifest: balancerFlashManifest,
  discovery: balancerFlashDiscovery,
  funding: balancerFlashFunding,
  actionAdapters: [balancerFlashFamilyOwnedAction],
});

export {
  balancerFlashFamilyOwnedAction,
  balancerFlashDiscovery,
  balancerFlashFunding,
  balancerFlashManifest,
};
