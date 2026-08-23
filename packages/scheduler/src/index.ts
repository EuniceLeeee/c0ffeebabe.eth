import { assertExactKeys, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeQualifiedExecutorRegistryEntryV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  type QualifiedExecutorRegistryEntryV1,
} from "../../../specs/release-authority/src/index.ts";

export {
  decodeQualifiedExecutorRegistryEntryV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  normalizeQualifiedExecutorRegistryEntryV1,
} from "../../../specs/release-authority/src/index.ts";
export type { QualifiedExecutorRegistryEntryV1 } from "../../../specs/release-authority/src/index.ts";

/** One process-wide clock contract for all scheduler-owned deadlines. */
export type MonotonicClock = () => number;
export const monotonicNow: MonotonicClock = (): number => performance.now();

/**
 * The scheduler deliberately treats these identifiers as opaque.  In
 * particular, no Family, protocol, or stage identifier is interpreted here.
 */
export type WorkIdentifier = string;
export type WorkPhase = string;
export type WorkClassRef = string;
export type OwnerRef = string;

export const SCHEDULER_LANES = Object.freeze([
  "producer-critical",
  "producer-bulk",
  "startup-RPC-fast",
  "startup-REVM-heavy",
  "background-next-generation",
  "final-sim",
] as const);
export type SchedulerLane = (typeof SCHEDULER_LANES)[number] | (string & {});

export const SCHEDULER_RESOURCES = Object.freeze([
  "rpc",
  "revm-heavy",
  "final-sim",
] as const);
export type SchedulerResource = (typeof SCHEDULER_RESOURCES)[number] | (string & {});

export type RetryClass = "retryable" | "invalid-program";

export interface SchedulerWorkDescriptor {
  readonly workId: WorkIdentifier;
  readonly phase: WorkPhase;
  readonly workClassRef: WorkClassRef;
  readonly ownerRef: OwnerRef;
  readonly lane: SchedulerLane;
  readonly resource: SchedulerResource;
  /** Resource units consumed while the physical operation is unsettled. */
  readonly cost?: number;
  /** Fairness and quota identity; it is intentionally not semantic. */
  readonly quotaKey?: string;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

export interface CallerAuthority {
  readonly callerId: string;
  readonly authorityToken: string;
}

/**
 * The release material that qualifies one executor implementation.  This is
 * deliberately data-only: the registry is the release binding, while the
 * process-local issuer below owns every usable authority capability.
 */
export interface QualifiedExecutorRegistryV1 {
  readonly wireVersion: 1;
  readonly kind: "aloha.qualified-executor-registry";
  readonly entries: readonly QualifiedExecutorRegistryEntryV1[];
  readonly registryRoot: Hash;
}

/** Qualification fact supplied by a controller/dispatch boundary. */
export interface QualifiedExecutorWorkerBindingV1 {
  readonly workerEpoch: string;
  readonly executorKind: string;
  readonly engineBuildFingerprint: Hash;
  readonly executableFingerprint: Hash;
  readonly closureFingerprint: Hash;
  readonly protocolFingerprint: Hash;
  readonly schemaFingerprint: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly candidateCommit: string;
}

const QUALIFIED_EXECUTOR_REGISTRY_KEYS = Object.freeze([
  "wireVersion",
  "kind",
  "entries",
  "registryRoot",
] as const);

function copyQualifiedExecutorRegistryEntries(value: QualifiedExecutorRegistryEntryV1 | readonly QualifiedExecutorRegistryEntryV1[]): readonly QualifiedExecutorRegistryEntryV1[] {
  const entries = Array.isArray(value)
    ? value.map(decodeQualifiedExecutorRegistryEntryV1)
    : [decodeQualifiedExecutorRegistryEntryV1(value)];
  const leaves = entries.map(hashQualifiedExecutorRegistryEntry);
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index - 1]! >= leaves[index]!) throw new TypeError("qualified executor registry entries must be strictly sorted and unique by leaf root");
  }
  return Object.freeze(entries);
}

export function createQualifiedExecutorRegistry(entry: QualifiedExecutorRegistryEntryV1 | readonly QualifiedExecutorRegistryEntryV1[]): QualifiedExecutorRegistryV1 {
  const entries = copyQualifiedExecutorRegistryEntries(entry);
  return Object.freeze({
    wireVersion: 1 as const,
    kind: "aloha.qualified-executor-registry" as const,
    entries,
    registryRoot: hashQualifiedExecutorRegistryRoot(entries),
  });
}

export function assertQualifiedExecutorRegistry(value: unknown): asserts value is QualifiedExecutorRegistryV1 {
  assertExactKeys(value, QUALIFIED_EXECUTOR_REGISTRY_KEYS);
  if (value.wireVersion !== 1 || value.kind !== "aloha.qualified-executor-registry") throw new TypeError("unsupported qualified executor registry");
  const entries = copyQualifiedExecutorRegistryEntries(value.entries as readonly QualifiedExecutorRegistryEntryV1[]);
  if (typeof value.registryRoot !== "string" || value.registryRoot !== hashQualifiedExecutorRegistryRoot(entries)) throw new TypeError("qualified executor registry root does not bind release material");
}

export type QualifiedExecutorAuthorityCapability = object;

export interface QualifiedExecutorAuthorityProvenanceV1 {
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSession: Hash;
  readonly version: number;
}

export interface QualifiedExecutorAuthorityOpenInput {
  readonly worker: QualifiedExecutorWorkerBindingV1;
}

export interface QualifiedExecutorAuthorityIssuer {
  readonly registryRoot: Hash;
  readonly authorityRoot: Hash;
  readonly open: (input: QualifiedExecutorAuthorityOpenInput) => QualifiedExecutorAuthorityCapability;
  readonly rotate: (input: QualifiedExecutorAuthorityOpenInput | QualifiedExecutorAuthorityCapability) => QualifiedExecutorAuthorityCapability;
  readonly revoke: (capability?: QualifiedExecutorAuthorityCapability) => void;
  readonly assert: (capability: QualifiedExecutorAuthorityCapability) => QualifiedExecutorAuthorityProvenanceV1;
  readonly provenance: (capability: QualifiedExecutorAuthorityCapability) => QualifiedExecutorAuthorityProvenanceV1;
}

export interface SchedulerPermit {
  readonly permitId: string;
  readonly work: Readonly<SchedulerWorkDescriptor>;
  readonly caller: Readonly<CallerAuthority>;
  readonly issuedAtMs: number;
  readonly queueWaitMs: number;
  readonly resource: SchedulerResource;
  readonly lane: SchedulerLane;
  readonly signal: AbortSignal;
  assertCaller(caller: CallerAuthority): void;
  assertWork(workId: WorkIdentifier): void;
}

export interface LanePolicy {
  readonly queueCap: number;
  readonly concurrency: number;
  /** Number of resource units reserved for this lane. */
  readonly reserved?: number;
  readonly resource?: SchedulerResource;
}

export interface ResourcePolicy {
  readonly capacity: number;
  readonly maxCost?: number;
}

export interface QuotaPolicy {
  readonly concurrency: number;
}

export interface SchedulerProfile {
  readonly resources?: Readonly<Record<string, ResourcePolicy>>;
  readonly lanes?: Readonly<Record<string, LanePolicy>>;
  readonly quotas?: Readonly<Record<string, QuotaPolicy>>;
  readonly clock?: MonotonicClock;
}

export const DEFAULT_RESOURCE_PROFILE: Readonly<Record<string, ResourcePolicy>> = Object.freeze({
  rpc: Object.freeze({ capacity: 8, maxCost: 1 }),
  revm: Object.freeze({ capacity: 4, maxCost: 1 }),
  "revm-heavy": Object.freeze({ capacity: 4, maxCost: 1 }),
  "final-sim": Object.freeze({ capacity: 2, maxCost: 1 }),
});

export const DEFAULT_LANE_PROFILE: Readonly<Record<string, LanePolicy>> = Object.freeze({
  "producer-critical": Object.freeze({
    queueCap: 64,
    concurrency: 8,
    reserved: 4,
    resource: "rpc",
  }),
  "producer-bulk": Object.freeze({
    queueCap: 64,
    concurrency: 8,
    resource: "rpc",
  }),
  "startup-RPC-fast": Object.freeze({
    queueCap: 500,
    concurrency: 8,
    resource: "rpc",
  }),
  "startup-REVM-heavy": Object.freeze({
    queueCap: 32,
    concurrency: 4,
  }),
  "background-next-generation": Object.freeze({
    queueCap: 128,
    concurrency: 4,
    resource: "rpc",
  }),
  "final-sim": Object.freeze({
    queueCap: 2,
    concurrency: 2,
    resource: "final-sim",
    reserved: 2,
  }),
});

export const DEFAULT_QUOTA_PROFILE: Readonly<Record<string, QuotaPolicy>> = Object.freeze({
  rpc: Object.freeze({ concurrency: 2 }),
  "revm-heavy": Object.freeze({ concurrency: 1 }),
  "final-sim": Object.freeze({ concurrency: 1 }),
});

export type SchedulerFailureCode =
  | "aborted"
  | "deadline"
  | "queue-full"
  | "resource-limit"
  | "impossible-cost"
  | "caller-mismatch"
  | "permit-mismatch";

export class SchedulerError extends Error {
  readonly code: SchedulerFailureCode;
  readonly retryClass: RetryClass;
  readonly workId: string;
  readonly resource: SchedulerResource;
  readonly lane: SchedulerLane;

  constructor(input: {
    readonly code: SchedulerFailureCode;
    readonly retryClass?: RetryClass;
    readonly message: string;
    readonly work: SchedulerWorkDescriptor;
  }) {
    super(input.message);
    this.name = "SchedulerError";
    this.code = input.code;
    this.retryClass = input.retryClass ?? "retryable";
    this.workId = input.work.workId;
    this.resource = input.work.resource;
    this.lane = input.work.lane;
  }
}

export interface SchedulerAccounting {
  readonly accepted: number;
  readonly rejected: number;
  readonly queueFull: number;
  readonly resourceLimit: number;
  readonly cancelled: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly notProbed: number;
  readonly permitsIssued: number;
  readonly permitsReleased: number;
}

export interface SchedulerSnapshot {
  readonly activeByResource: Readonly<Record<string, number>>;
  readonly queuedByLane: Readonly<Record<string, number>>;
  readonly activeByLane: Readonly<Record<string, number>>;
  readonly activeByQuota: Readonly<Record<string, number>>;
  readonly accounting: SchedulerAccounting;
}

export interface ScheduledWork<T> {
  readonly work: SchedulerWorkDescriptor;
  readonly caller: CallerAuthority;
  /**
   * The callback owns the physical operation.  `run` releases the permit only
   * after this promise settles, including after cancellation has propagated to
   * the underlying socket/worker.
   */
  readonly execute: (permit: SchedulerPermit) => Promise<T>;
}

interface QueuedWork<T> {
  readonly input: ScheduledWork<T>;
  readonly queuedAtMs: number;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

interface LaneState {
  readonly policy: LanePolicy;
  readonly ownerQueues: Map<string, QueuedWork<unknown>[]>;
  readonly ownerOrder: string[];
  cursor: number;
  queued: number;
  active: number;
}

interface ResourceState {
  readonly policy: ResourcePolicy;
  active: number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function asReadonlyWork(work: SchedulerWorkDescriptor): Readonly<SchedulerWorkDescriptor> {
  const cost = work.cost ?? 1;
  if (typeof work.workId !== "string" || work.workId.length === 0) throw new TypeError("workId must be non-empty");
  if (typeof work.phase !== "string" || work.phase.length === 0) throw new TypeError("phase must be non-empty");
  if (typeof work.workClassRef !== "string" || work.workClassRef.length === 0) throw new TypeError("workClassRef must be non-empty");
  if (typeof work.ownerRef !== "string" || work.ownerRef.length === 0) throw new TypeError("ownerRef must be non-empty");
  if (typeof work.lane !== "string" || work.lane.length === 0) throw new TypeError("lane must be non-empty");
  if (typeof work.resource !== "string" || work.resource.length === 0) throw new TypeError("resource must be non-empty");
  if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost <= 0) {
    throw new SchedulerError({
      code: "impossible-cost",
      retryClass: "invalid-program",
      message: "work.cost must be a positive safe integer",
      work: { ...work, cost },
    });
  }
  if (work.deadlineAtMs !== undefined && !Number.isFinite(work.deadlineAtMs)) {
    throw new TypeError("work.deadlineAtMs must be finite");
  }
  return Object.freeze({ ...work, cost });
}

function assertCaller(caller: CallerAuthority): void {
  assertExactKeys(caller, ["callerId", "authorityToken"]);
  if (typeof caller.callerId !== "string" || caller.callerId.length === 0) {
    throw new TypeError("caller.callerId must be non-empty");
  }
  if (typeof caller.authorityToken !== "string" || caller.authorityToken.length === 0) {
    throw new TypeError("caller.authorityToken must be non-empty");
  }
}

/**
 * Generic bounded scheduler.  Lane/resource/quota policy is data, so adding a
 * generated capability never requires a central switch or protocol import.
 */
export class WorkScheduler {
  private readonly lanes = new Map<string, LaneState>();
  private readonly resources = new Map<string, ResourceState>();
  private readonly quotas = new Map<string, QuotaPolicy>();
  private readonly activeByQuota = new Map<string, number>();
  private readonly accountingState = {
    accepted: 0,
    rejected: 0,
    queueFull: 0,
    resourceLimit: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    notProbed: 0,
    permitsIssued: 0,
    permitsReleased: 0,
  };
  private permitSequence = 0;
  private readonly clock: MonotonicClock;

  constructor(profile: SchedulerProfile = {}) {
    if (profile.clock !== undefined && typeof profile.clock !== "function") throw new TypeError("scheduler clock must be a function");
    this.clock = profile.clock ?? monotonicNow;
    const resources = { ...DEFAULT_RESOURCE_PROFILE, ...(profile.resources ?? {}) };
    for (const [name, policy] of Object.entries(resources)) {
      const capacity = positiveInteger(policy.capacity, `resource ${name}.capacity`);
      const maxCost = policy.maxCost === undefined
        ? capacity
        : positiveInteger(policy.maxCost, `resource ${name}.maxCost`);
      this.resources.set(name, { policy: Object.freeze({ capacity, maxCost }), active: 0 });
    }
    // A supplied lane profile is an explicit resource envelope.  This keeps a
    // small test/deployment profile from silently inheriting a producer reserve
    // that is larger than its deliberately small custom resource.
    const lanes = profile.lanes === undefined
      ? DEFAULT_LANE_PROFILE
      : profile.lanes;
    for (const [name, raw] of Object.entries(lanes)) {
      const policy: LanePolicy = Object.freeze({
        queueCap: positiveInteger(raw.queueCap, `lane ${name}.queueCap`),
        concurrency: positiveInteger(raw.concurrency, `lane ${name}.concurrency`),
        ...(raw.reserved === undefined ? {} : { reserved: nonNegativeInteger(raw.reserved, `lane ${name}.reserved`) }),
        ...(raw.resource === undefined ? {} : { resource: raw.resource }),
      });
      this.lanes.set(name, {
        policy,
        ownerQueues: new Map(),
        ownerOrder: [],
        cursor: 0,
        queued: 0,
        active: 0,
      });
    }
    for (const [name, raw] of Object.entries({ ...DEFAULT_QUOTA_PROFILE, ...(profile.quotas ?? {}) })) {
      this.quotas.set(name, Object.freeze({ concurrency: positiveInteger(raw.concurrency, `quota ${name}.concurrency`) }));
    }
  }

  registerLane(name: string, policy: LanePolicy): void {
    if (this.lanes.has(name)) throw new Error(`lane already registered: ${name}`);
    this.lanes.set(name, {
      policy: Object.freeze({
        queueCap: positiveInteger(policy.queueCap, `lane ${name}.queueCap`),
        concurrency: positiveInteger(policy.concurrency, `lane ${name}.concurrency`),
        ...(policy.reserved === undefined ? {} : { reserved: nonNegativeInteger(policy.reserved, `lane ${name}.reserved`) }),
        ...(policy.resource === undefined ? {} : { resource: policy.resource }),
      }),
      ownerQueues: new Map(),
      ownerOrder: [],
      cursor: 0,
      queued: 0,
      active: 0,
    });
  }

  registerResource(name: string, policy: ResourcePolicy): void {
    if (this.resources.has(name)) throw new Error(`resource already registered: ${name}`);
    const capacity = positiveInteger(policy.capacity, `resource ${name}.capacity`);
    this.resources.set(name, {
      policy: Object.freeze({ capacity, maxCost: policy.maxCost === undefined ? capacity : positiveInteger(policy.maxCost, `resource ${name}.maxCost`) }),
      active: 0,
    });
  }

  registerQuota(name: string, policy: QuotaPolicy): void {
    if (this.quotas.has(name)) throw new Error(`quota already registered: ${name}`);
    this.quotas.set(name, Object.freeze({ concurrency: positiveInteger(policy.concurrency, `quota ${name}.concurrency`) }));
  }

  async run<T>(input: ScheduledWork<T>): Promise<T> {
    const work = asReadonlyWork(input.work);
    assertCaller(input.caller);
    const lane = this.lanes.get(work.lane);
    if (!lane) throw new SchedulerError({ code: "resource-limit", message: `lane is not registered: ${work.lane}`, work });
    if (work.cost! > lane.policy.concurrency) {
      this.accountingState.rejected += 1;
      this.accountingState.resourceLimit += 1;
      throw new SchedulerError({ code: "impossible-cost", retryClass: "invalid-program", message: `lane cannot admit work cost ${work.cost}`, work });
    }
    const resourceName = lane.policy.resource ?? work.resource;
    if (resourceName !== work.resource) {
      throw new SchedulerError({ code: "resource-limit", message: `work resource does not match lane resource`, work });
    }
    const resource = this.resources.get(work.resource);
    if (!resource || work.cost! > resource.policy.capacity || work.cost! > (resource.policy.maxCost ?? resource.policy.capacity)) {
      this.accountingState.rejected += 1;
      this.accountingState.resourceLimit += 1;
      throw new SchedulerError({ code: "impossible-cost", retryClass: "invalid-program", message: `resource cannot admit work cost ${work.cost}`, work });
    }
    const quotaKey = work.quotaKey ?? work.resource;
    if (work.quotaKey !== undefined && (typeof work.quotaKey !== "string" || work.quotaKey.length === 0)) {
      this.accountingState.rejected += 1;
      this.accountingState.resourceLimit += 1;
      throw new SchedulerError({ code: "resource-limit", retryClass: "invalid-program", message: "quotaKey must be non-empty", work });
    }
    const quota = work.quotaKey === undefined
      ? this.quotas.get(work.resource)
      : this.quotas.get(work.quotaKey);
    if (quota && work.cost! > quota.concurrency) {
      this.accountingState.rejected += 1;
      this.accountingState.resourceLimit += 1;
      throw new SchedulerError({ code: "impossible-cost", retryClass: "invalid-program", message: `quota cannot admit work cost ${work.cost}`, work });
    }
    if (work.signal?.aborted) {
      this.accountingState.cancelled += 1;
      throw new SchedulerError({ code: "aborted", message: "work was aborted before admission", work });
    }
    if (work.deadlineAtMs !== undefined && work.deadlineAtMs <= this.clock()) {
      this.accountingState.cancelled += 1;
      throw new SchedulerError({ code: "deadline", message: "work deadline elapsed before admission", work });
    }
    const immediate = this.tryAdmit(work, input.caller, input.execute, lane, resource, quotaKey);
    if (immediate !== undefined) return immediate;
    if (lane.queued >= lane.policy.queueCap) {
      this.accountingState.rejected += 1;
      this.accountingState.queueFull += 1;
      throw new SchedulerError({ code: "queue-full", message: `lane queue is full: ${work.lane}`, work });
    }
    return new Promise<T>((resolve, reject) => {
      const queuedAtMs = this.clock();
      let queued!: QueuedWork<T>;
      const onAbort = (): void => {
        if (queued.settled) return;
        queued.settled = true;
        this.removeQueued(lane, queued);
        if (queued.timer !== undefined) clearTimeout(queued.timer);
        work.signal?.removeEventListener("abort", onAbort);
        this.accountingState.cancelled += 1;
        reject(new SchedulerError({ code: "aborted", message: "queued work was aborted", work }));
        this.drainLane(work.lane);
      };
      queued = { input: { ...input, work }, queuedAtMs, resolve, reject, signal: work.signal ?? new AbortController().signal, onAbort, timer: undefined, settled: false };
      const queue = lane.ownerQueues.get(work.ownerRef) ?? [];
      if (!lane.ownerQueues.has(work.ownerRef)) {
        lane.ownerQueues.set(work.ownerRef, queue);
        lane.ownerOrder.push(work.ownerRef);
      }
      queue.push(queued as QueuedWork<unknown>);
      lane.queued += 1;
      work.signal?.addEventListener("abort", onAbort, { once: true });
      if (work.deadlineAtMs !== undefined) {
        const delay = Math.max(0, work.deadlineAtMs - this.clock());
        queued.timer = setTimeout(() => {
          if (queued.settled) return;
          queued.settled = true;
          this.removeQueued(lane, queued);
          work.signal?.removeEventListener("abort", onAbort);
          this.accountingState.cancelled += 1;
          reject(new SchedulerError({ code: "deadline", message: "queued work deadline elapsed", work }));
          this.drainLane(work.lane);
        }, delay);
      }
      this.drainLane(work.lane);
    });
  }

  markBlocked(count = 1): void {
    nonNegativeInteger(count, "blocked count");
    this.accountingState.blocked += count;
  }

  markNotProbed(count = 1): void {
    nonNegativeInteger(count, "notProbed count");
    this.accountingState.notProbed += count;
  }

  snapshot(): SchedulerSnapshot {
    const activeByResource: Record<string, number> = {};
    const queuedByLane: Record<string, number> = {};
    const activeByLane: Record<string, number> = {};
    for (const [name, resource] of this.resources) activeByResource[name] = resource.active;
    for (const [name, lane] of this.lanes) {
      queuedByLane[name] = lane.queued;
      activeByLane[name] = lane.active;
    }
    const activeByQuota: Record<string, number> = {};
    for (const [key, value] of this.activeByQuota) activeByQuota[key] = value;
    return Object.freeze({
      activeByResource: Object.freeze(activeByResource),
      queuedByLane: Object.freeze(queuedByLane),
      activeByLane: Object.freeze(activeByLane),
      activeByQuota: Object.freeze(activeByQuota),
      accounting: Object.freeze({ ...this.accountingState }),
    });
  }

  assertPermitConservation(): void {
    const snapshot = this.snapshot();
    const active = Object.values(snapshot.activeByResource).reduce((sum, value) => sum + value, 0);
    if (snapshot.accounting.permitsIssued - snapshot.accounting.permitsReleased !== active) {
      throw new Error("scheduler permit conservation violated");
    }
  }

  private tryAdmit<T>(
    work: Readonly<SchedulerWorkDescriptor>,
    caller: CallerAuthority,
    execute: (permit: SchedulerPermit) => Promise<T>,
    lane: LaneState,
    resource: ResourceState,
    quotaKey: string,
  ): Promise<T> | undefined {
    if (!this.canAdmit(work, lane, resource, quotaKey)) return undefined;
    return this.start(work, caller, execute, lane, resource, quotaKey, 0);
  }

  private canAdmit(work: Readonly<SchedulerWorkDescriptor>, lane: LaneState, resource: ResourceState, quotaKey: string): boolean {
    if (lane.active + work.cost! > lane.policy.concurrency) return false;
    if (resource.active + work.cost! > resource.policy.capacity) return false;
    const quota = work.quotaKey === undefined
      ? this.quotas.get(work.resource)
      : this.quotas.get(work.quotaKey);
    if ((this.activeByQuota.get(quotaKey) ?? 0) + work.cost! > (quota?.concurrency ?? Number.POSITIVE_INFINITY)) return false;
    const reserved = [...this.lanes.values()]
      .filter((entry) => (entry.policy.resource ?? "") === work.resource && (entry.policy.reserved ?? 0) > 0)
      .reduce((sum, entry) => sum + Math.max(0, (entry.policy.reserved ?? 0) - (entry === lane ? entry.active : 0)), 0);
    const isReservedLane = (lane.policy.reserved ?? 0) > 0;
    if (!isReservedLane && resource.active + work.cost! > resource.policy.capacity - reserved) return false;
    return true;
  }

  private start<T>(
    work: Readonly<SchedulerWorkDescriptor>,
    caller: CallerAuthority,
    execute: (permit: SchedulerPermit) => Promise<T>,
    lane: LaneState,
    resource: ResourceState,
    quotaKey: string,
    queueWaitMs: number,
  ): Promise<T> {
    this.accountingState.accepted += 1;
    lane.active += work.cost!;
    resource.active += work.cost!;
    this.activeByQuota.set(quotaKey, (this.activeByQuota.get(quotaKey) ?? 0) + work.cost!);
    this.accountingState.permitsIssued += work.cost!;
    const controller = new AbortController();
    const linkedAbort = (): void => controller.abort(work.signal?.reason);
    work.signal?.addEventListener("abort", linkedAbort, { once: true });
    let released = false;
    const permitId = `${work.workId}:${++this.permitSequence}`;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      work.signal?.removeEventListener("abort", linkedAbort);
      lane.active -= work.cost!;
      resource.active -= work.cost!;
      this.activeByQuota.set(quotaKey, (this.activeByQuota.get(quotaKey) ?? 0) - work.cost!);
      this.accountingState.permitsReleased += work.cost!;
      this.drainLane(work.lane);
    };
    const permit: SchedulerPermit = {
      permitId,
      work,
      caller: Object.freeze({ ...caller }),
      issuedAtMs: this.clock(),
      queueWaitMs,
      resource: work.resource,
      lane: work.lane,
      signal: controller.signal,
      assertCaller: (candidate: CallerAuthority): void => {
        if (candidate.callerId !== caller.callerId || candidate.authorityToken !== caller.authorityToken) {
          throw new SchedulerError({ code: "caller-mismatch", message: "caller authority does not own permit", work });
        }
      },
      assertWork: (workId: string): void => {
        if (workId !== work.workId) throw new SchedulerError({ code: "permit-mismatch", message: "work does not own permit", work });
      },
    };
    if (work.deadlineAtMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new SchedulerError({ code: "deadline", message: "work deadline elapsed", work }));
      }, Math.max(0, work.deadlineAtMs - this.clock()));
    }
    const complete = Promise.resolve()
      .then(() => execute(permit))
      .then((value) => {
        this.accountingState.completed += 1;
        return value;
      }, (error: unknown) => {
        this.accountingState.failed += 1;
        throw error;
      })
      .finally(release);
    // `run` owns the physical callback.  Its returned promise is deliberately
    // chained without an early logical timeout so release follows settlement.
    return complete;
  }

  private removeQueued<T>(lane: LaneState, queued: QueuedWork<T>): void {
    const owner = queued.input.work.ownerRef;
    const queue = lane.ownerQueues.get(owner);
    if (!queue) return;
    const index = queue.indexOf(queued as QueuedWork<unknown>);
    if (index >= 0) {
      queue.splice(index, 1);
      lane.queued -= 1;
    }
    if (queue.length === 0) {
      lane.ownerQueues.delete(owner);
      const ownerIndex = lane.ownerOrder.indexOf(owner);
      if (ownerIndex >= 0) {
        lane.ownerOrder.splice(ownerIndex, 1);
        if (lane.cursor >= lane.ownerOrder.length) lane.cursor = 0;
      }
    }
  }

  private drainLane(name: string): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    let progressed = true;
    while (progressed && lane.queued > 0) {
      progressed = false;
      const count = lane.ownerOrder.length;
      if (count === 0) return;
      for (let offset = 0; offset < count; offset += 1) {
        if (lane.ownerOrder.length === 0) return;
        const index = (lane.cursor + offset) % lane.ownerOrder.length;
        const owner = lane.ownerOrder[index];
        const queue = lane.ownerQueues.get(owner);
        const queued = queue?.[0];
        if (!queued || queued.settled) {
          if (queued && queue) queue.shift();
          continue;
        }
        const work = queued.input.work;
        const resource = this.resources.get(work.resource);
        const quotaKey = work.quotaKey ?? work.resource;
        if (work.signal?.aborted) {
          queued.settled = true;
          queue!.shift();
          lane.queued -= 1;
          work.signal.removeEventListener("abort", queued.onAbort);
          this.accountingState.cancelled += 1;
          queued.reject(new SchedulerError({ code: "aborted", message: "queued work was aborted", work }));
          progressed = true;
          break;
        }
        if (work.deadlineAtMs !== undefined && work.deadlineAtMs <= this.clock()) {
          queued.settled = true;
          queue!.shift();
          lane.queued -= 1;
          work.signal?.removeEventListener("abort", queued.onAbort);
          if (queued.timer !== undefined) clearTimeout(queued.timer);
          this.accountingState.cancelled += 1;
          queued.reject(new SchedulerError({ code: "deadline", message: "queued work deadline elapsed", work }));
          progressed = true;
          break;
        }
        if (!resource || !this.canAdmit(work, lane, resource, quotaKey)) {
          this.accountingState.blocked += 1;
          continue;
        }
        queued.settled = true;
        queue!.shift();
        lane.queued -= 1;
        if (queue!.length === 0) {
          lane.ownerQueues.delete(owner);
          lane.ownerOrder.splice(index, 1);
          if (lane.cursor >= lane.ownerOrder.length) lane.cursor = 0;
        } else {
          lane.cursor = (index + 1) % lane.ownerOrder.length;
        }
        if (queued.timer !== undefined) clearTimeout(queued.timer);
        work.signal?.removeEventListener("abort", queued.onAbort);
        const queuedWaitMs = Math.max(0, this.clock() - queued.queuedAtMs);
        const result = this.start(work, queued.input.caller, queued.input.execute, lane, resource, quotaKey, queuedWaitMs);
        result.then(queued.resolve, queued.reject);
        progressed = true;
        break;
      }
    }
  }
}

export const Scheduler = WorkScheduler;
export const createWorkScheduler = (profile: SchedulerProfile = {}): WorkScheduler => new WorkScheduler(profile);
export const createScheduler = createWorkScheduler;

/** Stable receipt hash useful to evidence writers without exposing policy internals. */
export function hashSchedulerReceipt(receipt: unknown): Hash {
  return hashDomain("aloha/scheduler-receipt/v1", receipt);
}
