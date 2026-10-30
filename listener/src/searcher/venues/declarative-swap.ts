import { createDeclarativeFamilyRuntime, type DeclarativeFamilyTypes } from "./declarative-family.js";
import type { SwapFamilyPlugin } from "./adapter-family-plugin.js";
export type TypedDeclarativeSwap<T extends DeclarativeFamilyTypes> = SwapFamilyPlugin<
  T["candidate"], T["identity"], T["descriptor"], T["route"],
  T["pricingDescriptor"], Record<string, any>, T["exactEvidence"],
  T["descriptor"], T["pricingDraft"], unknown, T["pricingStatic"]
>;
type Data = Record<string, any>;
export function createDeclarativeSwapRuntime(raw: Data, children: readonly Data[] = [],
  options: Parameters<typeof createDeclarativeFamilyRuntime>[2] = {}) {
  if (raw.production?.domain !== "swap") throw new Error("expected Swap declaration");
  const runtime = createDeclarativeFamilyRuntime(raw, children, options);
  return { ...runtime, definition: runtime.definition as unknown as TypedDeclarativeSwap<DeclarativeFamilyTypes> };
}
export function compileDeclarativeSwap<T extends DeclarativeFamilyTypes = DeclarativeFamilyTypes>(raw: Data, children: readonly Data[] = []): TypedDeclarativeSwap<T> {
  return createDeclarativeSwapRuntime(raw, children).definition as unknown as TypedDeclarativeSwap<T>;
}
