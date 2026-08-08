import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
} from "../funding/morpho-flash-family/parts.js";

export const plugin = defineFundingFamily({
  manifest: morphoFlashManifest,
  funding: morphoFlashFunding,
  actionAdapters: [morphoFlashFamilyOwnedAction],
});
