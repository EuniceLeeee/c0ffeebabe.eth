import { createDeclarativeFamilyRuntime, type DeclarativeFamilyTypes, type TypedDeclarativeProtocol } from "./declarative-family.js";
export type { DeclarativeFamilyTypes, TypedDeclarativeProtocol } from "./declarative-family.js";
type Data = Record<string, any>;
/** Compatibility entry; all lifecycle and execution are shared with Swap. */
export function createDeclarativeProtocolRuntime(raw: Data, children: readonly Data[] = [],
  options: Parameters<typeof createDeclarativeFamilyRuntime>[2] = {}) {
  if (raw.production?.domain !== "protocol") throw new Error("expected Protocol declaration");
  const runtime = createDeclarativeFamilyRuntime(raw, children, options);
  return { ...runtime, definition: runtime.definition as unknown as TypedDeclarativeProtocol<DeclarativeFamilyTypes> };
}
export function compileDeclarativeProtocol(raw: Data, children?: readonly Data[]): ReturnType<typeof createDeclarativeProtocolRuntime>["definition"];
export function compileDeclarativeProtocol<T extends DeclarativeFamilyTypes>(raw: Data, children?: readonly Data[]): TypedDeclarativeProtocol<T>;
export function compileDeclarativeProtocol(raw: Data, children: readonly Data[] = []): unknown {
  return createDeclarativeProtocolRuntime(raw, children).definition;
}
