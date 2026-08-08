import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  balancerFlashFamilyOwnedAction,
  balancerFlashFunding,
  balancerFlashManifest,
} from "../funding/balancer-flash-family/parts.js";

export const plugin = defineFundingFamily({
  manifest: balancerFlashManifest,
  funding: balancerFlashFunding,
  actionAdapters: [balancerFlashFamilyOwnedAction],
});
