import { defineFundingFamily } from "../adapter-family-plugin.js";
import { morphoFlashCapture } from "../funding/morpho-flash-family/capture.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
} from "../funding/morpho-flash-family/parts.js";

export const plugin = defineFundingFamily({
  manifest: morphoFlashManifest,
  capture: morphoFlashCapture,
  funding: morphoFlashFunding,
  actionAdapters: [morphoFlashFamilyOwnedAction],
});
