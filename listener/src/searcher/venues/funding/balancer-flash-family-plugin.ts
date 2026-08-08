import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  balancerFlashFamilyOwnedAction,
  balancerFlashFunding,
  balancerFlashManifest,
} from "./balancer-flash-family/parts.js";

export const balancerFlashPlugin = defineFundingFamily({
  manifest: balancerFlashManifest,
  funding: balancerFlashFunding,
  actionAdapters: [balancerFlashFamilyOwnedAction],
});

export {
  balancerFlashFamilyOwnedAction,
  balancerFlashFunding,
  balancerFlashManifest,
};
