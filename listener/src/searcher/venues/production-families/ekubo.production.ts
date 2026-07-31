import { ekuboRouterSwapAdapter } from "../../../adapters/ekubo.js";
import { ekuboAdapter } from "../swaps/ekubo/family.js";
import { defineProductionFamilyModule } from "./contract.js";

export const productionFamilyModule = defineProductionFamilyModule({
  family: ekuboAdapter,
  actionAdapters: [ekuboRouterSwapAdapter],
});
