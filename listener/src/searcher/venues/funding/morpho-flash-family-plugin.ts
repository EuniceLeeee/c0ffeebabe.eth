import { defineFundingFamily } from "../adapter-family-plugin.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
} from "./morpho-flash-family/parts.js";

export const morphoFlashPlugin = defineFundingFamily({
  manifest: morphoFlashManifest,
  funding: morphoFlashFunding,
  actionAdapters: [morphoFlashFamilyOwnedAction],
});

export {
  morphoFlashFamilyOwnedAction,
  morphoFlashFunding,
  morphoFlashManifest,
};
