import { univ2RuntimeQuoteMathModel, pairCreditDelta, netTokenTransfer } from "./swaps/univ2-family/math.js";
import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "./declarative-runtime-math.js";
import { univ4RuntimeMathModels } from "./swaps/univ4-family/math.js";

// Protocol migration registers statically imported arithmetic-only models.
// JSON carries names/versions and bindings, never formulas or handler paths.
const models: readonly RuntimeMathModel[] = [
  univ2RuntimeQuoteMathModel,
  pairCreditDelta,
  netTokenTransfer,
  ...univ4RuntimeMathModels,
];
export const declarativeRuntimeMathRegistry = createDeclarativeRuntimeMathRegistry(models);
