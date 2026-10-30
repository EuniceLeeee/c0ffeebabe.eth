import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "./declarative-runtime-math.js";
import { badgerSettWithdrawRuntimeMathModel } from "./badger-sett-withdraw-math.js";
import { olympusIndexRuntimeMathModel } from "./olympus-math.js";
import { originStethArmRuntimeQuoteMathModel } from "./origin-steth-arm-math.js";
import { psmRuntimeTermsMathModel } from "./psm-math.js";
import { univ2RuntimeQuoteMathModel } from "./swaps/univ2-family/math.js";

// Protocol migration registers statically imported arithmetic-only models.
// JSON carries names/versions and bindings, never formulas or handler paths.
const models: readonly RuntimeMathModel[] = [
  psmRuntimeTermsMathModel,
  badgerSettWithdrawRuntimeMathModel,
  olympusIndexRuntimeMathModel,
  originStethArmRuntimeQuoteMathModel,
  univ2RuntimeQuoteMathModel,
];
export const declarativeRuntimeMathRegistry = createDeclarativeRuntimeMathRegistry(models);
