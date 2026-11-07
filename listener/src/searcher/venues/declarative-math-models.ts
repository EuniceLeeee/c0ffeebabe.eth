import { univ2MathModels } from "./swaps/univ2-family/math.js";
import { balancerV1MathModels } from "./swaps/balancer-v1-family/math.js";
import { createDeclarativeMathRegistry, type DeclarativeMathModel } from "./declarative-math.js";
import { goldxUnitQuoteMathModel } from "./goldx-math.js";
import { bearQuoteMathModel, xwinLocalStateMathModel, xwinQuoteMathModel } from "./token-conversion-math.js";
import { ellaMathModels } from "./swaps/ella-exchange-family/math.js";
import { univ1MathModels } from "./swaps/univ1-family/math.js";
import { univ3MathModels } from "./swaps/univ3-family/math.js";
import { univ4MathModels } from "./swaps/univ4-family/math.js";
import { univ4FeeHookMathModels } from "./swaps/univ4-fee-hook-family/declarative-math.js";
import { oneswapMathModels } from "./swaps/oneswap-family/declarative-math.js";
import { precisionPoolMathModels } from "./swaps/precision-pool-family/math.js";
import { dodoV2MathModels } from "./swaps/dodo-v2-family/math.js";
import { ekuboMathModels } from "./swaps/ekubo-family/declarative-math.js";
import { algebraIntegralMathModels } from "./swaps/algebra-integral-family/declarative-math.js";
import { selfBurnNativeWrapFeeMathModel } from "./self-burn-native-math.js";
import { psmConversionMathModel } from "./psm-math.js";
import { badgerSettWithdrawMathModel } from "./badger-sett-withdraw-math.js";
import { compoundCTokenExchangeRateMathModel } from "./compound-ctoken-math.js";
import { stakedUsdatEventAssetsMathModel } from "./staked-usdat-math.js";
import { fluidCreditMathModels } from "./credit/fluid-family/math.js";
import { peapodsDebondMathModel, peapodsRuntimeShapeMathModel } from "./peapods-math.js";

// Static, source-hashed math entries are registered here by protocol migration.
// JSON never imports arbitrary files or executable handlers. An absent model
// rejects its nonempty binding; it is not a fallback to a unit-price formula.
const models: readonly DeclarativeMathModel[] = [
  ...univ2MathModels,
  goldxUnitQuoteMathModel,
  bearQuoteMathModel,
  xwinLocalStateMathModel,
  xwinQuoteMathModel,
  ...balancerV1MathModels,
  ...ellaMathModels,
  ...univ1MathModels,
  ...univ3MathModels,
  ...univ4MathModels,
  ...univ4FeeHookMathModels,
  ...oneswapMathModels,
  ...precisionPoolMathModels,
  ...dodoV2MathModels,
  ...ekuboMathModels,
  ...algebraIntegralMathModels,
  selfBurnNativeWrapFeeMathModel,
  psmConversionMathModel,
  badgerSettWithdrawMathModel,
  compoundCTokenExchangeRateMathModel,
  stakedUsdatEventAssetsMathModel,
  ...fluidCreditMathModels,
  peapodsDebondMathModel,
  peapodsRuntimeShapeMathModel,
];
export const declarativeMathRegistry = createDeclarativeMathRegistry(models);
