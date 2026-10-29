import { compoundCTokenExchangeRateMathModel } from "./compound-ctoken-math.js";
import { createDeclarativeMathRegistry, type DeclarativeMathModel } from "./declarative-math.js";
import { selfBurnNativeWrapFeeMathModel } from "./self-burn-native-math.js";

// Static, source-hashed math entries are registered here by protocol migration.
// JSON never imports arbitrary files or executable handlers. An absent model
// rejects its nonempty binding; it is not a fallback to a unit-price formula.
const models: readonly DeclarativeMathModel[] = [
  selfBurnNativeWrapFeeMathModel,
  compoundCTokenExchangeRateMathModel,
];
export const declarativeMathRegistry = createDeclarativeMathRegistry(models);
