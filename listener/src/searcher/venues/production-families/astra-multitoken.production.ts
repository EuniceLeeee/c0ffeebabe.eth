import { astraMultiTokenChangeActionAdapter } from "../../../adapters/astra-multitoken.js";
import { astraMultiTokenAdapter } from "../protocols/astra-multitoken.js";
import { defineProductionFamilyModule } from "./contract.js";

export const productionFamilyModule = defineProductionFamilyModule({
  family: astraMultiTokenAdapter,
  actionAdapters: [astraMultiTokenChangeActionAdapter],
});
