import { createDeclarativeFamilyRuntime, type DeclarativeFamilyTypes } from "./declarative-family.js";
import type { CreditFamilyPlugin } from "./adapter-family-plugin.js";
export type TypedDeclarativeCredit<T extends DeclarativeFamilyTypes> = CreditFamilyPlugin<
  T["candidate"], T["identity"], T["descriptor"], T["route"], T["exactEvidence"],
  T["descriptor"], unknown, T["pricingDescriptor"], Record<string, any>, T["pricingDraft"], T["pricingStatic"]
>;
type Data = Record<string, any>;
/** Credit reuses the Family lifecycle. Risk evidence remains domain-specific;
 * no runtime execution capability is inferred from the shared compiler. */
export function createDeclarativeCreditRuntime(raw: Data, children: readonly Data[] = [],
  options: Parameters<typeof createDeclarativeFamilyRuntime>[2] = {}) {
  if (raw.production?.domain !== "credit") throw new Error("expected Credit declaration");
  const runtime = createDeclarativeFamilyRuntime(raw, children, options);
  return { ...runtime, definition: runtime.definition as unknown as TypedDeclarativeCredit<DeclarativeFamilyTypes> };
}
export function compileDeclarativeCredit<T extends DeclarativeFamilyTypes = DeclarativeFamilyTypes>(raw: Data, children: readonly Data[] = []): TypedDeclarativeCredit<T> {
  return createDeclarativeCreditRuntime(raw, children).definition as unknown as TypedDeclarativeCredit<T>;
}
