import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
} from "./morpho-flash-family/parts.js";
import { morphoFlashDiscovery } from
  "./morpho-flash-family/discovery.js";

export const morphoFlashPlugin = defineFundingFamily({
  manifest: morphoFlashManifest,
  discovery: morphoFlashDiscovery,
  funding: morphoFlashFunding,
  actionAdapters: [morphoFlashFamilyOwnedAction],
});

export {
  morphoFlashFamilyOwnedAction,
  morphoFlashDiscovery,
  morphoFlashFunding,
  morphoFlashManifest,
};
