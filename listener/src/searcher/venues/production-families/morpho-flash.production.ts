import { defineFundingFamily } from "../adapter-family-plugin.js";
import { morphoFlashCapture } from "../funding/morpho-flash-family/capture.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
} from "../funding/morpho-flash-family/parts.js";
import { morphoFlashDiscovery } from
  "../funding/morpho-flash-family/discovery.js";

export const plugin = defineFundingFamily({
  manifest: morphoFlashManifest,
  capture: morphoFlashCapture,
  discovery: morphoFlashDiscovery,
  funding: morphoFlashFunding,
  actionAdapters: [morphoFlashFamilyOwnedAction],
});
