import { univ2RuntimeQuoteMathModel, pairCreditDelta, netTokenTransfer } from "./swaps/univ2-family/math.js";
import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "./declarative-runtime-math.js";
import { univ4RuntimeMathModels } from "./swaps/univ4-family/math.js";
import { ekuboSwapReturnRuntimeMathModel } from "./swaps/ekubo-family/declarative-math.js";
import { psmRuntimeTermsMathModel } from "./protocols/psm-family/psm-math.js";
import { badgerSettWithdrawRuntimeMathModel } from "./protocols/badger-sett-withdraw-family/badger-sett-withdraw-math.js";
import { balancerV2SwapAmountGuard } from "./swaps/balancer-v2-family/declarative-math.js";

// Protocol migration registers statically imported arithmetic-only models.
// JSON carries names/versions and bindings, never formulas or handler paths.
const models: readonly RuntimeMathModel[] = [
  univ2RuntimeQuoteMathModel,
  pairCreditDelta,
  netTokenTransfer,
  ...univ4RuntimeMathModels,
  ekuboSwapReturnRuntimeMathModel,
  psmRuntimeTermsMathModel,
  badgerSettWithdrawRuntimeMathModel,
  balancerV2SwapAmountGuard,
];
export const declarativeRuntimeMathRegistry = createDeclarativeRuntimeMathRegistry(models);
