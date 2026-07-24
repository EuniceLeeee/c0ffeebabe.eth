import type { IdentityAdmissionPolicy } from "./venues/admission.js";
import {
  attestPoolIdentities,
  createPoolIdentityCache,
  isRetryablePoolIdentityFailure,
  type AttestedPoolEntry,
  type IdentityCallBackend,
  type IdentityPoolEntry,
  type IdentityResolverRegistry,
  type RejectedPoolIdentity,
} from "./venues/identity.js";

export interface SourcePinnedIdentityBackend extends IdentityCallBackend {
  readonly sourceBlock: number;
}

export interface StartupDexIdentityRetryState<T extends IdentityPoolEntry> {
  readonly accepted: readonly AttestedPoolEntry<T>[];
  readonly remaining: readonly T[];
}

export interface StartupDexPermanentIdentityRejection<T extends IdentityPoolEntry> {
  readonly candidate: T;
  readonly rejection: RejectedPoolIdentity;
}

export interface StartupDexIdentityRetryStage<T extends IdentityPoolEntry>
  extends StartupDexIdentityRetryState<T> {
  readonly sourceBlock: number;
  readonly permanentlyRejected: readonly StartupDexPermanentIdentityRejection<T>[];
}

interface IdentityAttempt<T extends IdentityPoolEntry> {
  readonly candidate: T;
  readonly accepted: AttestedPoolEntry<T> | null;
  readonly rejection: RejectedPoolIdentity | null;
}

/**
 * Prepare, but do not publish, the next startup DEX identity state.
 *
 * The caller supplies a backend pinned to current block N. Retryable transport
 * failures remain in `remaining`; completed negative identity proofs disappear;
 * newly attested candidates join `accepted`. A fresh per-stage cache prevents a
 * failed Promise from an older source block from poisoning the current-N retry.
 */
export async function prepareStartupDexIdentityRetryStage<
  T extends IdentityPoolEntry,
>(input: {
  readonly currentN: number;
  readonly backend: SourcePinnedIdentityBackend;
  readonly state: StartupDexIdentityRetryState<T>;
  readonly identityRegistry: IdentityResolverRegistry;
  readonly concurrency?: number;
  readonly seedEntries?: readonly IdentityPoolEntry[];
  readonly admissionPolicy?: IdentityAdmissionPolicy;
}): Promise<StartupDexIdentityRetryStage<T>> {
  assertCurrentNBackend(input.currentN, input.backend);
  const concurrency = normalizeConcurrency(input.concurrency);
  const cache = createPoolIdentityCache();
  const attempts = await mapLimit(
    input.state.remaining,
    concurrency,
    async (candidate): Promise<IdentityAttempt<T>> => {
      const result = await attestPoolIdentities(input.backend, [candidate], {
        identityRegistry: input.identityRegistry,
        concurrency: 1,
        cache,
        seedEntries: input.seedEntries,
        admissionPolicy: input.admissionPolicy,
      });
      if (result.accepted.length === 1 && result.rejected.length === 0) {
        return {
          candidate,
          accepted: result.accepted[0],
          rejection: null,
        };
      }
      if (result.accepted.length === 0 && result.rejected.length === 1) {
        return {
          candidate,
          accepted: null,
          rejection: result.rejected[0],
        };
      }
      throw new Error(
        "startup DEX identity retry expected exactly one decision per candidate",
      );
    },
  );

  const newlyAccepted: AttestedPoolEntry<T>[] = [];
  const remaining: T[] = [];
  const permanentlyRejected: StartupDexPermanentIdentityRejection<T>[] = [];
  for (const attempt of attempts) {
    if (attempt.accepted !== null) {
      newlyAccepted.push(attempt.accepted);
      continue;
    }
    if (attempt.rejection === null) {
      throw new Error("startup DEX identity retry produced an empty decision");
    }
    if (isRetryablePoolIdentityFailure(attempt.rejection.reason)) {
      remaining.push(attempt.candidate);
    } else {
      permanentlyRejected.push({
        candidate: attempt.candidate,
        rejection: attempt.rejection,
      });
    }
  }

  return Object.freeze({
    sourceBlock: input.currentN,
    accepted: Object.freeze([
      ...input.state.accepted,
      ...newlyAccepted,
    ]) as readonly AttestedPoolEntry<T>[],
    remaining: Object.freeze(remaining),
    permanentlyRejected: Object.freeze(permanentlyRejected),
  });
}

function assertCurrentNBackend(
  currentN: number,
  backend: SourcePinnedIdentityBackend,
): void {
  if (!Number.isSafeInteger(currentN) || currentN < 0) {
    throw new Error(`invalid startup DEX identity current block ${currentN}`);
  }
  if (backend.sourceBlock !== currentN) {
    throw new Error(
      `startup DEX identity backend is pinned to ${backend.sourceBlock}, expected ${currentN}`,
    );
  }
}

function normalizeConcurrency(value: number | undefined): number {
  const concurrency = value ?? 32;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`invalid startup DEX identity concurrency ${String(concurrency)}`);
  }
  return Math.max(1, Math.floor(concurrency));
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(limit, Math.max(1, items.length)) },
      () => worker(),
    ),
  );
  return results;
}
