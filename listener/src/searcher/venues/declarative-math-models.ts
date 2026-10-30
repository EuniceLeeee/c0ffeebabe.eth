import { arcanaAmountMathModel } from "./arcana-migration-math.js";
import { badgerSettWithdrawMathModel } from "./badger-sett-withdraw-math.js";
import { boringWithdrawOutMathModel } from "./boring-vault-teller-math.js";
import { compoundCTokenExchangeRateMathModel } from "./compound-ctoken-math.js";
import { balancerV1MathModels } from "./swaps/balancer-v1-family/math.js";
import { fluidCreditMathModels } from "./credit/fluid-family/math.js";
import { createDeclarativeMathRegistry, type DeclarativeMathModel } from "./declarative-math.js";
import { defaultCollateralQuoteMathModel } from "./default-collateral-math.js";
import { goldxUnitQuoteMathModel } from "./goldx-math.js";
import { metafactoryRedeemMathModel } from "./metafactory-math.js";
import { olympusIndexQuoteMathModel } from "./olympus-math.js";
import { originOusdMintQuoteMathModel } from "./origin-ousd-math.js";
import { originStethArmQuoteMathModel } from "./origin-steth-arm-math.js";
import { peapodsDebondMathModel, peapodsRuntimeShapeMathModel } from "./peapods-math.js";
import { psmConversionMathModel } from "./psm-math.js";
import { selfBurnNativeWrapFeeMathModel } from "./self-burn-native-math.js";
import { stakedUsdatEventAssetsMathModel } from "./staked-usdat-math.js";
import { bearQuoteMathModel, xwinLocalStateMathModel, xwinQuoteMathModel } from "./token-conversion-math.js";
import { ellaMathModels } from "./swaps/ella-exchange-family/math.js";
import { kyberswapElasticMathModels } from "./swaps/kyberswap-elastic-family/declarative-math.js";
import { univ1MathModels } from "./swaps/univ1-family/math.js";
import { univ2MathModels } from "./swaps/univ2-family/math.js";
import { univ3MathModels } from "./swaps/univ3-family/math.js";
import { precisionPoolMathModels } from "./swaps/precision-pool-family/math.js";
import { univ4MathModels } from "./swaps/univ4-family/math.js";

// Static, source-hashed math entries are registered here by protocol migration.
// JSON never imports arbitrary files or executable handlers. An absent model
// rejects its nonempty binding; it is not a fallback to a unit-price formula.
const models: readonly DeclarativeMathModel[] = [
  selfBurnNativeWrapFeeMathModel,
  compoundCTokenExchangeRateMathModel,
  goldxUnitQuoteMathModel,
  psmConversionMathModel,
  stakedUsdatEventAssetsMathModel,
  peapodsRuntimeShapeMathModel,
  peapodsDebondMathModel,
  olympusIndexQuoteMathModel,
  metafactoryRedeemMathModel,
  originOusdMintQuoteMathModel,
  originStethArmQuoteMathModel,
  arcanaAmountMathModel,
  badgerSettWithdrawMathModel,
  boringWithdrawOutMathModel,
  defaultCollateralQuoteMathModel,
  bearQuoteMathModel,
  xwinLocalStateMathModel,
  xwinQuoteMathModel,
  ...balancerV1MathModels,
  ...fluidCreditMathModels,
  ...ellaMathModels,
  ...kyberswapElasticMathModels,
  ...univ1MathModels,
  ...univ2MathModels,
  ...univ3MathModels,
  ...precisionPoolMathModels,
  ...univ4MathModels,
];
export const declarativeMathRegistry = createDeclarativeMathRegistry(models);
