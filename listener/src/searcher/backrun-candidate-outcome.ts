import type { LiveFinalState } from "./live-fixture-recorder.js";
import { RevmFatalError } from "./revm-sim-client.js";

export type BackrunCandidateStage = "solver" | "final_verify" | "ev" | "submit_gate";

/** The scheduler may rethrow its deadline after a consumer already recorded it. */
export function backrunConsumerFailureIsTerminal(
  stage: BackrunCandidateStage, signal: AbortSignal, deadlineAtMs: number,
): boolean {
  return stage !== "solver" && (signal.aborted || Date.now() >= deadlineAtMs);
}

/** Expected overlay failures may reject a candidate; a latched backend fault may not. */
export async function settleBackrunFinalOverlay<T>(operation: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: unknown }
> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof RevmFatalError) throw error;
    return { ok: false, error };
  }
}

/** Keep execution/infrastructure failures distinct from quote economics. */
export function backrunCandidateFailure(
  stage: BackrunCandidateStage,
  error: unknown,
  timedOut: boolean,
): { stage: BackrunCandidateStage; reason: string; state: LiveFinalState; quoteTimeout: boolean; fatal: boolean } {
  const fatal = error instanceof RevmFatalError;
  const quoteTimeout = stage === "solver" && timedOut && !fatal;
  const state: LiveFinalState = stage === "solver" && !fatal
    ? quoteTimeout ? "quote-timeout" : "no-profitable-quote"
    : "final-verify-failed";
  return { stage, state, quoteTimeout, fatal,
    reason: fatal ? error.fatal.kind : stage === "solver" ? state
      : `${stage}-${timedOut ? "timeout" : "error"}` };
}
