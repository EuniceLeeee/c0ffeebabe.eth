import type {SelectorNativeProgram} from "../selector-native-definition.js";
import type {SelectorMutationRole} from "../selector-native-pricing-activity.js";
type Data=Readonly<Record<string,any>>;
export type SelectorPaidRankProfile={readonly economic:readonly string[];readonly assets:readonly string[];
  readonly thirdPartySupplyIndependentAssets?:readonly string[];
  readonly constantIdentifiers?:readonly string[];readonly managedPool?:{readonly manager:string;readonly poolId:string}};
export type SelectorPaidRankRole=(input:{program:SelectorNativeProgram;instance:Data;routes:readonly Data[];
  dependencies:readonly string[];physical:SelectorMutationRole})=>SelectorPaidRankProfile|undefined;
