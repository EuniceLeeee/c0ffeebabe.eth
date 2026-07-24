import type {
  VictimRuntimeCallControl,
  VictimRuntimeStage,
  VictimRuntimeStageResult,
} from "./victim-runtime-capability.js";

const DEFAULT_VICTIM_RUNTIME_TIMEOUT_MS = 30_000;

/**
 * One family-local late-result fence for victim runtime callbacks. A timeout
 * aborts only the child signal; an uncooperative transport may finish later,
 * but its value can never be published.
 */
export async function settleVictimRuntimeStage<T>(input: {
  readonly familyId: string;
  readonly stage: VictimRuntimeStage;
  readonly timeoutMs?: number;
  readonly work:
    (control: VictimRuntimeCallControl) => Promise<T> | T;
}): Promise<VictimRuntimeStageResult<T>> {
  const timeoutMs = positiveTimeout(
    input.timeoutMs ??
      environmentTimeout("SEARCHER_VICTIM_RUNTIME_CALLBACK_TIMEOUT_MS"),
  );
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + timeoutMs;
  const controller = new AbortController();
  const control = Object.freeze({
    deadlineAtMs,
    signal: controller.signal,
  });

  return await new Promise<VictimRuntimeStageResult<T>>((resolve) => {
    let settled = false;
    const settle = (result: VictimRuntimeStageResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze(result));
    };
    const timer = setTimeout(() => {
      const reason =
        `victim runtime ${input.familyId}/${input.stage} timed out after ${timeoutMs}ms`;
      controller.abort(new Error(reason));
      settle({
        ok: false,
        familyId: input.familyId,
        stage: input.stage,
        elapsedMs: Date.now() - startedAtMs,
        timedOut: true,
        reason,
      });
    }, timeoutMs);

    Promise.resolve()
      .then(() => input.work(control))
      .then((value) => {
        if (controller.signal.aborted || Date.now() >= deadlineAtMs) {
          const reason =
            `victim runtime ${input.familyId}/${input.stage} completed after its deadline`;
          controller.abort(new Error(reason));
          settle({
            ok: false,
            familyId: input.familyId,
            stage: input.stage,
            elapsedMs: Date.now() - startedAtMs,
            timedOut: true,
            reason,
          });
          return;
        }
        settle({
          ok: true,
          familyId: input.familyId,
          stage: input.stage,
          elapsedMs: Date.now() - startedAtMs,
          value,
        });
      })
      .catch((error) => {
        settle({
          ok: false,
          familyId: input.familyId,
          stage: input.stage,
          elapsedMs: Date.now() - startedAtMs,
          timedOut: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function environmentTimeout(name: string): number {
  const raw = process.env[name];
  if (raw === undefined) return DEFAULT_VICTIM_RUNTIME_TIMEOUT_MS;
  return Number(raw);
}

function positiveTimeout(value: number): number {
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_VICTIM_RUNTIME_TIMEOUT_MS;
}
