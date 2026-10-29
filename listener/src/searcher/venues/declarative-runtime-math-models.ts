import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "./declarative-runtime-math.js";
import { olympusIndexRuntimeMathModel } from "./olympus-math.js";
import { originStethArmRuntimeQuoteMathModel } from "./origin-steth-arm-math.js";
import { psmRuntimeTermsMathModel } from "./psm-math.js";

// Protocol migration registers statically imported arithmetic-only models.
// JSON carries names/versions and bindings, never formulas or handler paths.
const models: readonly RuntimeMathModel[] = [
  psmRuntimeTermsMathModel,
  olympusIndexRuntimeMathModel,
  originStethArmRuntimeQuoteMathModel,
];
export const declarativeRuntimeMathRegistry = createDeclarativeRuntimeMathRegistry(models);
