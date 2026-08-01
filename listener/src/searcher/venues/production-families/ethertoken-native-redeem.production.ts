import {
  etherTokenNativeRedeemActionAdapter,
} from "../../../adapters/ethertoken-native-redeem.js";
import {
  etherTokenNativeRedeemAdapter,
} from "../protocols/ethertoken-native-redeem.js";
import { defineProductionFamilyModule } from "./contract.js";

export const productionFamilyModule = defineProductionFamilyModule({
  family: etherTokenNativeRedeemAdapter,
  actionAdapters: [etherTokenNativeRedeemActionAdapter],
});
