import type { AdapterWorkControl, CentralCallerAuthority } from "./adapter-work-intent.js";
import type { AdapterRequest, CanonicalSource, ObservedEffects } from "./venues/adapter-request-program.js";

/** Framework-compiled execution of authenticated earlier Exact handles.
 * The input balance is a quote-only seed, never final-simulation funding. */
export interface CompiledExactPrefix {
  readonly executor: string;
  readonly calldata: string;
  readonly inputToken: string;
  readonly inputAmount: bigint;
}

export interface ExactPrefixReadInput {
  readonly prefix: CompiledExactPrefix;
  readonly request: AdapterRequest;
  readonly source: CanonicalSource;
  readonly callerAuthority: CentralCallerAuthority;
  readonly control?: AdapterWorkControl;
}

export interface ExactPrefixReadResult {
  readonly data: string;
  readonly completion: "returned" | "reverted-as-declared";
  readonly effects?: ObservedEffects;
}
