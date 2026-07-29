import type {
  ExecutionFamilyId,
  PendingTransactionEvidenceHead,
} from "./venues/route-leg-adapter.js";

export type PendingEvidenceTaskPriority = "canonical" | "unknown";

interface PendingEvidenceTask<T> {
  readonly work: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/** One newHeads-fed canonical snapshot shared by every pending transaction. */
export class PendingEvidenceHeadSnapshot {
  private latest: PendingTransactionEvidenceHead | undefined;
  private loading: Promise<PendingTransactionEvidenceHead> | undefined;
  private version = 0;

  update(head: PendingTransactionEvidenceHead): void {
    this.latest = Object.freeze({ ...head });
    this.version += 1;
  }

  current(
    load: () => Promise<PendingTransactionEvidenceHead>,
  ): Promise<PendingTransactionEvidenceHead> {
    if (this.latest) return Promise.resolve(this.latest);
    if (this.loading) return this.loading;
    const version = this.version;
    this.loading = load().then((loaded) => {
      if (this.version !== version && this.latest) return this.latest;
      this.update(loaded);
      return this.latest!;
    }).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
}

/**
 * Evidence RPC never consumes the canonical transaction-fetch workers.
 * Canonical route work drains first; speculative unknown-target observation
 * has an independent bounded backlog.
 */
export class PendingEvidenceTaskScheduler {
  private readonly canonical: PendingEvidenceTask<unknown>[] = [];
  private readonly unknownByLane = new Map<
    string,
    PendingEvidenceTask<unknown>[]
  >();
  private unknownCursor = 0;
  private active = 0;

  constructor(
    private readonly concurrency: number,
    private readonly unknownCapacityPerLane: number,
  ) {
    assertPositiveSafeInteger(concurrency, "evidence task concurrency");
    assertPositiveSafeInteger(
      unknownCapacityPerLane,
      "unknown evidence task capacity per lane",
    );
  }

  run<T>(
    priority: PendingEvidenceTaskPriority,
    work: () => Promise<T>,
    lane = "kernel",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: PendingEvidenceTask<T> = { work, resolve, reject };
      if (priority === "canonical") {
        this.canonical.push(task as PendingEvidenceTask<unknown>);
      } else {
        const queue = this.unknownByLane.get(lane) ?? [];
        if (queue.length >= this.unknownCapacityPerLane) {
          reject(new Error("unknown evidence task queue full"));
          return;
        }
        queue.push(task as PendingEvidenceTask<unknown>);
        this.unknownByLane.set(lane, queue);
      }
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const task = this.canonical.shift() ?? this.dequeueUnknown();
      if (!task) return;
      this.active += 1;
      void task.work().then(task.resolve, task.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private dequeueUnknown(): PendingEvidenceTask<unknown> | undefined {
    const active = [...this.unknownByLane.entries()]
      .filter(([, queue]) => queue.length > 0);
    if (active.length === 0) return undefined;
    const index = this.unknownCursor % active.length;
    this.unknownCursor = (index + 1) % active.length;
    const [lane, queue] = active[index];
    const task = queue.shift();
    if (queue.length === 0) this.unknownByLane.delete(lane);
    return task;
  }
}

/**
 * Keeps canonical intake independent from evidence-promoted unknown targets.
 * Unknown traffic is capped and queued per family, then drained round-robin so
 * one faulty matcher cannot evict canonical or sibling-family transactions.
 */
export class PendingEvidenceAdmissionQueue<T> {
  private readonly canonical: T[] = [];
  private readonly byFamily = new Map<ExecutionFamilyId, T[]>();
  private readonly admissionHeads = new Map<
    string,
    {
      readonly attempts: Map<ExecutionFamilyId, number>;
      readonly committed: Map<ExecutionFamilyId, number>;
    }
  >();
  private cursor = 0;

  constructor(
    private readonly canonicalCapacity: number,
    familyCount: number,
    private readonly admissionsPerFamilyPerHead: number,
  ) {
    assertPositiveSafeInteger(canonicalCapacity, "canonical queue capacity");
    assertPositiveSafeInteger(familyCount, "evidence family count");
    assertPositiveSafeInteger(
      admissionsPerFamilyPerHead,
      "evidence admissions per family/head",
    );
    this.familyCapacity = Math.max(
      1,
      Math.floor(canonicalCapacity / familyCount),
    );
  }

  private readonly familyCapacity: number;

  beginUnknownAttempt(
    familyId: ExecutionFamilyId,
    headHash: string,
  ): boolean {
    const normalizedHeadHash = headHash.toLowerCase();
    let state = this.admissionHeads.get(normalizedHeadHash);
    if (!state) {
      state = {
        attempts: new Map(),
        committed: new Map(),
      };
      this.admissionHeads.set(normalizedHeadHash, state);
      while (this.admissionHeads.size > 4) {
        this.admissionHeads.delete(
          this.admissionHeads.keys().next().value!,
        );
      }
    }
    const attempts = state.attempts.get(familyId) ?? 0;
    const committed = state.committed.get(familyId) ?? 0;
    if (attempts + committed >= this.admissionsPerFamilyPerHead) {
      return false;
    }
    state.attempts.set(familyId, attempts + 1);
    return true;
  }

  finishUnknownAttempt(
    familyId: ExecutionFamilyId,
    headHash: string,
    commitAdmission: boolean,
  ): boolean {
    const state = this.admissionHeads.get(headHash.toLowerCase());
    if (!state) return false;
    const attempts = state.attempts.get(familyId) ?? 0;
    if (attempts === 0) return false;
    if (attempts <= 1) state.attempts.delete(familyId);
    else state.attempts.set(familyId, attempts - 1);
    if (!commitAdmission) return false;
    const committed = state.committed.get(familyId) ?? 0;
    if (committed >= this.admissionsPerFamilyPerHead) return false;
    state.committed.set(familyId, committed + 1);
    return true;
  }

  enqueueCanonical(item: T): void {
    this.canonical.push(item);
    if (this.canonical.length > this.canonicalCapacity) this.canonical.shift();
  }

  enqueueEvidence(familyId: ExecutionFamilyId, item: T): void {
    const queue = this.byFamily.get(familyId) ?? [];
    queue.push(item);
    if (queue.length > this.familyCapacity) queue.shift();
    this.byFamily.set(familyId, queue);
  }

  dequeue(): T | undefined {
    const canonical = this.canonical.shift();
    if (canonical !== undefined) return canonical;
    const active = [...this.byFamily.entries()]
      .filter(([, queue]) => queue.length > 0);
    if (active.length === 0) return undefined;
    const index = this.cursor % active.length;
    this.cursor = (index + 1) % active.length;
    return active[index][1].shift();
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
