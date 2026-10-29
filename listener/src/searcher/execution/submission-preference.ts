export interface DeferredSubmission<Result> {
  readonly netEvWei: bigint;
  submit(): Promise<Result>;
  discard(reason: "preferred_submitted" | "fallback_superseded" | "pass_cancelled"): Result;
}

/** One source pass only. Preferred submissions keep streaming; loss-accepting
 * fallbacks cannot run until the producer/consumer pass has completed. */
export class SubmissionPreference<Result extends { submitted: boolean; submissionAttempted?: boolean }> {
  private pending: DeferredSubmission<Result>[] = [];
  private preferredSubmitted = false;
  private sealed = false;
  constructor(private readonly control: { signal: AbortSignal; deadlineAtMs: number }) {}

  defer(entry: DeferredSubmission<Result>): void {
    if (this.sealed) throw new Error("submission preference is closed");
    this.pending.push(entry);
  }

  notePreferredSubmission(): void { this.preferredSubmitted = true; }

  async flush(onResult: (entry: DeferredSubmission<Result>, result: Result) => void): Promise<void> {
    if (this.sealed) throw new Error("submission preference already settled");
    this.sealed = true;
    this.pending.sort((a, b) => a.netEvWei === b.netEvWei ? 0 : a.netEvWei > b.netEvWei ? -1 : 1);
    let fallbackSubmitted = false;
    try {
      while (this.pending.length) {
        const entry = this.pending[0]!;
        const skipped = this.preferredSubmitted ? "preferred_submitted" : fallbackSubmitted ? "fallback_superseded" : null;
        if (!skipped) {
          this.control.signal.throwIfAborted();
          if (Date.now() >= this.control.deadlineAtMs) throw new Error("submission fallback deadline elapsed");
        }
        this.pending.shift();
        let result: Result;
        try { result = skipped ? entry.discard(skipped) : await entry.submit(); }
        catch (error) { onResult(entry, entry.discard("pass_cancelled")); throw error; }
        // An indeterminate router/relay result must not trigger another lossy
        // transaction after the first may already have left this process.
        fallbackSubmitted ||= result.submitted || result.submissionAttempted === true;
        onResult(entry, result);
      }
    } finally { this.cancel(onResult); }
  }

  cancel(onResult: (entry: DeferredSubmission<Result>, result: Result) => void): void {
    this.sealed = true;
    const remaining = this.pending;
    this.pending = [];
    for (const entry of remaining) onResult(entry, entry.discard("pass_cancelled"));
  }
}
