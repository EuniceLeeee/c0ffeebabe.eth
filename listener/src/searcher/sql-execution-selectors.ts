import {selectorExecutionPrograms,selectorProgramProjection} from "./venues/selector-program-role.js";
import type { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "./generated/production-family-entries.generated.js";
import type { SelectorNativeExecutionDefinition } from "./venues/selector-native-definition.js";

type Registered = (typeof GENERATED_PRODUCTION_FAMILY_ENTRIES)[number]["module"]["selectorFamilyModule"];

/** An enabled conversion entry must own a validated execution program (including simple ABI legs).
 * This is selector capability, not a successful binding or price for any given pool. */
export function isEnabledSqlExecutionLeg(m: Registered): m is Registered & {definition: SelectorNativeExecutionDefinition} {
  const d = m.definition;
  return m.activation.enabled && (d.domain === "swap" || d.domain === "protocol") && selectorExecutionPrograms(d).length > 0;
}
