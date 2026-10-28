import { createDeclarativeRuntimeMathRegistry, type RuntimeMathModel } from "./declarative-runtime-math.js";

// Protocol migration registers statically imported arithmetic-only models.
// JSON carries names/versions and bindings, never formulas or handler paths.
const models: readonly RuntimeMathModel[] = [];
export const declarativeRuntimeMathRegistry = createDeclarativeRuntimeMathRegistry(models);
