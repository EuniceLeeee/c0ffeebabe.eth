import type { ProtocolDomainSemantics } from "./adapter-family-plugin.js";
import { compileDeclarativeOracleVictim } from "./declarative-oracle-victim.js";
import type { compileDeclarativeValues } from "./declarative-values.js";

/** Compile Protocol-only declarations; the shared Family core owns lifecycle.
 * An absent optional module adds neither a capability nor state reads. */
export function compileDeclarativeProtocolDomain(
  raw: Record<string, unknown>,
  values: Pick<ReturnType<typeof compileDeclarativeValues>, "evaluate">,
  oracleVictim?: unknown,
): ProtocolDomainSemantics {
  if (Object.hasOwn(raw, "oracleVictim"))
    throw new Error("oracleVictim must be declared in the root modules block");
  return {
    ...raw,
    // The strict constructor installs its synchronous guard before freezing.
    ...(oracleVictim ? { oracleVictim: { ...compileDeclarativeOracleVictim(oracleVictim, values) } } : {}),
  } as ProtocolDomainSemantics;
}
