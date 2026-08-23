import {
  decodeWorkerLine,
  encodeWorkerLine,
  assertAuthorityBinding,
  hashAuthorityBinding,
  assertDispatchRequestShape,
  assertRequestShape,
  bindQualifiedWorkerEpoch,
  type RevmWorkerDispatchRequestV1,
  type RevmWorkerDispatchedExecutionV1,
  type RevmWorkerHelloV1,
  type RevmWorkerResponseV1,
  type RevmWorkerSimulateRequestV1,
  type RevmWorkerAuthorityBindingV1,
} from "./protocol.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { monotonicNow, type MonotonicClock } from "../../../packages/scheduler/src/index.ts";
import { assertIssuedRevmWorkerAuthorityIssuer } from "./internal/authority.ts";

export type RevmWorkerState = "starting" | "ready" | "busy" | "retiring" | "dead";

/** Minimal process boundary.  The production adapter maps stdin/stdout and
 * kill/reap to this interface; tests may use an in-memory channel without
 * supplying an EVM implementation. */
export interface RevmWorkerChannel {
  send(line: string): Promise<void> | void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(signal?: string): Promise<void> | void;
  waitForExit(timeoutMs: number): Promise<boolean> | boolean;
}

export interface RevmWorkerFactory {
  spawn(epoch: string): Promise<RevmWorkerChannel>;
}

export interface RevmWorkerQualification {
  readonly engineBuildFingerprint: string;
  readonly executableFingerprint: string;
}

/** Narrow release-composition edge.  The issuer owns the opaque capability
 * and must mint a fresh, epoch-bound binding for every replacement worker. */
export interface RevmWorkerAuthorityIssuer {
  /** Owner chooses the epoch from the release composition; the pool never invents one. */
  issue(): RevmWorkerAuthorityBindingV1;
  assertCurrent(binding: RevmWorkerAuthorityBindingV1): void;
}

export interface NodeRevmWorkerFactoryOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly qualification: RevmWorkerQualification;
}

/**
 * Real child-process adapter.  It only transports the protocol; it does not
 * implement or emulate EVM execution in TypeScript.
 */
export function createNodeRevmWorkerFactory(options: NodeRevmWorkerFactoryOptions): RevmWorkerFactory {
  return Object.freeze({
    async spawn(_epoch: string): Promise<RevmWorkerChannel> {
      const child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return createNodeRevmWorkerChannel(child);
    },
  });
}

export function createNodeRevmWorkerChannel(child: ChildProcessWithoutNullStreams): RevmWorkerChannel {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let buffer = "";
  let exited = false;
  let exitCode: number | null = null;
  let resolveExit: ((code: number | null) => void) | null = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const listener of lineListeners) listener(line);
    }
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    for (const listener of exitListeners) listener(code);
    resolveExit?.(code);
    resolveExit = null;
  });
  return Object.freeze({
    send(line: string): Promise<void> {
      if (exited || child.stdin.destroyed) return Promise.reject(new Error("REVM worker stdin is closed"));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => error ? reject(error) : resolve());
      });
    },
    onLine(listener: (line: string) => void): () => void {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onExit(listener: (code: number | null) => void): () => void {
      exitListeners.add(listener);
      if (exited) listener(exitCode);
      return () => exitListeners.delete(listener);
    },
    kill(signal = "SIGTERM"): void {
      if (!exited) child.kill(signal as NodeJS.Signals);
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (exited) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          if (resolveExit) resolveExit = null;
          resolve(false);
        }, timeoutMs);
        resolveExit = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        };
      });
    },
  });
}

export type RevmWorkerLifecycleCode = "not-ready" | "busy" | "deadline" | "timeout" | "retired" | "worker-error" | "invalid-request" | "invalid-response" | "engine-unqualified" | "queue-full" | "resource-limit";

export class RevmWorkerLifecycleError extends Error {
  readonly code: RevmWorkerLifecycleCode;
  readonly workerEpoch: string | null;
  readonly requestId: string | null;

  constructor(input: { readonly code: RevmWorkerLifecycleCode; readonly workerEpoch: string | null; readonly requestId?: string | null; readonly message: string }) {
    super(input.message);
    this.name = "RevmWorkerLifecycleError";
    this.code = input.code;
    this.workerEpoch = input.workerEpoch;
    this.requestId = input.requestId ?? null;
  }
}

interface PendingRequest {
  readonly request: RevmWorkerSimulateRequestV1;
  readonly resolve: (response: RevmWorkerResponseV1) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  readonly signal?: AbortSignal;
}

export interface RevmWorkerControllerSnapshot {
  readonly epoch: string;
  readonly state: RevmWorkerState;
  readonly pending: number;
  readonly staleResponses: number;
  readonly retireReason: string | null;
  readonly engineBuildFingerprint: string | null;
  readonly executableFingerprint: string | null;
}

/** One request at a time, with kill/reap before a timed-out worker is reused. */
export class RevmWorkerController {
  private readonly channel: RevmWorkerChannel;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly clock: MonotonicClock;
  private readonly qualification: RevmWorkerQualification;
  private readonly authority: RevmWorkerAuthorityBindingV1;
  private readonly assertAuthorityCurrent: () => void;
  private readonly unsubscribeLine: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly pending = new Map<string, PendingRequest>();
  private _state: RevmWorkerState = "starting";
  private retirePromise: Promise<void> | null = null;
  private retireReason: string | null = null;
  private staleResponses = 0;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private helloResolve: (() => void) | null = null;
  private helloReject: ((error: unknown) => void) | null = null;
  private helloPromise: Promise<void>;
  private hello: RevmWorkerHelloV1 | null = null;

  constructor(input: { readonly epoch: string; readonly channel: RevmWorkerChannel; readonly qualification: RevmWorkerQualification; readonly authority: RevmWorkerAuthorityBindingV1; readonly assertAuthorityCurrent: () => void; readonly timeoutMs?: number; readonly readyTimeoutMs?: number; readonly clock?: MonotonicClock }) {
    if (input.epoch.length === 0) throw new TypeError("worker epoch must be non-empty");
    if (!input.qualification || input.qualification.engineBuildFingerprint.length === 0 || input.qualification.executableFingerprint.length === 0) throw new TypeError("REVM worker qualification is incomplete");
    this.epoch = input.epoch;
    this.channel = input.channel;
    this.timeoutMs = input.timeoutMs ?? 30_000;
    this.readyTimeoutMs = input.readyTimeoutMs ?? this.timeoutMs;
    this.clock = input.clock ?? monotonicNow;
    this.qualification = Object.freeze({ ...input.qualification });
    assertAuthorityBinding(input.authority);
    if (input.authority.workerEpoch !== input.epoch) throw new TypeError("worker authority epoch does not match controller epoch");
    this.authority = input.authority;
    this.assertAuthorityCurrent = input.assertAuthorityCurrent;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isFinite(this.readyTimeoutMs) || this.readyTimeoutMs <= 0) throw new TypeError("worker timeout must be positive");
    this.helloPromise = new Promise<void>((resolve, reject) => { this.helloResolve = resolve; this.helloReject = reject; });
    this.unsubscribeLine = this.channel.onLine((line) => this.onLine(line));
    this.unsubscribeExit = this.channel.onExit((code) => this.onExit(code));
    this.helloTimer = setTimeout(() => {
      if (this._state === "starting") {
        this.helloReject?.(new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: this.epoch, message: "qualified REVM hello deadline elapsed" }));
        void this.retire("hello-timeout");
      }
    }, this.readyTimeoutMs);
  }

  readonly epoch: string;

  get state(): RevmWorkerState { return this._state; }

  bind(request: RevmWorkerDispatchRequestV1): RevmWorkerSimulateRequestV1 {
    this.assertAuthorityCurrent();
    return bindQualifiedWorkerEpoch(request, this.epoch, this.authority);
  }

  waitUntilReady(): Promise<void> {
    return this.helloPromise;
  }

  async submit(request: RevmWorkerSimulateRequestV1, signal?: AbortSignal): Promise<RevmWorkerResponseV1> {
    if (this._state !== "ready") throw new RevmWorkerLifecycleError({ code: this._state === "busy" ? "busy" : "not-ready", workerEpoch: this.epoch, requestId: request.requestId, message: `worker is ${this._state}` });
    if (request.workerEpoch !== this.epoch) throw new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: this.epoch, requestId: request.requestId, message: "request worker epoch does not match controller" });
    try {
      this.assertAuthorityCurrent();
    } catch (error) {
      throw new RevmWorkerLifecycleError({ code: "engine-unqualified", workerEpoch: this.epoch, requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
    }
    if (hashAuthorityBinding(request.authority) !== hashAuthorityBinding(this.authority)) throw new RevmWorkerLifecycleError({ code: "engine-unqualified", workerEpoch: this.epoch, requestId: request.requestId, message: "request authority does not match worker lease" });
    if (request.deadlineAtMs <= this.clock()) throw new RevmWorkerLifecycleError({ code: "deadline", workerEpoch: this.epoch, requestId: request.requestId, message: "REVM request deadline elapsed" });
    if (signal?.aborted) throw new RevmWorkerLifecycleError({ code: "retired", workerEpoch: this.epoch, requestId: request.requestId, message: "REVM request aborted" });
    try {
      assertRequestShape(request);
    } catch (error) {
      throw new RevmWorkerLifecycleError({ code: "invalid-request", workerEpoch: this.epoch, requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
    }
    if (this.pending.size !== 0) throw new RevmWorkerLifecycleError({ code: "busy", workerEpoch: this.epoch, requestId: request.requestId, message: "worker is single-flight" });
    this._state = "busy";
    return new Promise<RevmWorkerResponseV1>((resolve, reject) => {
      const delay = Math.max(0, Math.min(this.timeoutMs, request.deadlineAtMs - this.clock()));
      const timer = setTimeout(() => {
        const code = request.deadlineAtMs - this.clock() <= 0 ? "deadline" : "timeout";
        void this.retire(code).finally(() => reject(new RevmWorkerLifecycleError({ code, workerEpoch: this.epoch, requestId: request.requestId, message: `REVM worker request ${code}; worker retired` })));
      }, delay);
      const onAbort = (): void => {
        void this.retire("aborted").finally(() => reject(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: this.epoch, requestId: request.requestId, message: "REVM request aborted; worker retired" })));
      };
      this.pending.set(request.requestId, { request, resolve, reject, timer, onAbort, signal });
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(this.channel.send(encodeWorkerLine(request))).catch((error: unknown) => {
        void this.retire("send-failed").finally(() => reject(new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: this.epoch, requestId: request.requestId, message: error instanceof Error ? error.message : String(error) })));
      });
    });
  }

  async retire(reason: string): Promise<void> {
    if (this._state === "dead") return;
    if (this.retirePromise) return this.retirePromise;
    this._state = "retiring";
    this.retireReason = reason;
    this.retirePromise = (async () => {
      if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
      this.helloReject?.(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: this.epoch, message: `worker retired: ${reason}` }));
      this.helloResolve = null;
      this.helloReject = null;
      try {
        await this.channel.kill("SIGTERM");
      } catch {
        // A failed graceful kill is still followed by a bounded reap attempt.
      }
      let exited = false;
      try {
        exited = await this.channel.waitForExit(this.timeoutMs);
      } catch {
        exited = false;
      }
      if (!exited) {
        try {
          await this.channel.kill("SIGKILL");
          await this.channel.waitForExit(this.timeoutMs);
        } catch {
          // The process boundary remains fail-closed even if the OS did not
          // provide a positive reap observation.
        }
      }
      this._state = "dead";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        if (pending.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort);
        const code = reason === "timeout" ? "timeout" : reason === "deadline" ? "deadline" : reason === "invalid-response" ? "invalid-response" : reason === "engine-unqualified" ? "engine-unqualified" : reason === "send-failed" ? "worker-error" : "retired";
        pending.reject(new RevmWorkerLifecycleError({ code, workerEpoch: this.epoch, requestId: pending.request.requestId, message: `worker retired: ${reason}` }));
      }
      this.pending.clear();
      this.unsubscribeLine();
      this.unsubscribeExit();
    })();
    return this.retirePromise;
  }

  snapshot(): RevmWorkerControllerSnapshot {
    return Object.freeze({ epoch: this.epoch, state: this._state, pending: this.pending.size, staleResponses: this.staleResponses, retireReason: this.retireReason, engineBuildFingerprint: this.hello?.engineBuildFingerprint ?? null, executableFingerprint: this.hello?.executableFingerprint ?? null });
  }

  private onLine(line: string): void {
    let decoded: import("./protocol.ts").RevmWorkerMessageV1;
    try {
      decoded = decodeWorkerLine(line);
    } catch {
      this.staleResponses += 1;
      void this.retire("invalid-response");
      return;
    }
    if (decoded.kind === "hello") {
      if (this._state !== "starting" || decoded.workerEpoch !== this.epoch || decoded.engineBuildFingerprint !== this.qualification.engineBuildFingerprint || decoded.executableFingerprint !== this.qualification.executableFingerprint) {
        this.staleResponses += 1;
        this.helloReject?.(new RevmWorkerLifecycleError({ code: "engine-unqualified", workerEpoch: this.epoch, message: "REVM worker hello is not qualified" }));
        void this.retire("engine-unqualified");
        return;
      }
      this.hello = decoded;
      if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
      this._state = "ready";
      this.helloResolve?.();
      this.helloResolve = null;
      this.helloReject = null;
      return;
    }
    if (decoded.kind !== "response" && decoded.kind !== "error") {
      this.staleResponses += 1;
      void this.retire("invalid-response");
      return;
    }
    if (this._state !== "busy") {
      this.staleResponses += 1;
      return;
    }
    const response = decoded;
    if (response.workerEpoch !== this.epoch) {
      this.staleResponses += 1;
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      this.staleResponses += 1;
      return;
    }
    if (response.ownerRef !== pending.request.ownerRef || response.generationId !== pending.request.generationId || response.attemptId !== pending.request.attemptId || response.inputHash !== pending.request.inputHash || response.deadlineAtMs !== pending.request.deadlineAtMs || hashAuthorityBinding(response.authority) !== hashAuthorityBinding(pending.request.authority) || (response.kind === "response" && response.engineBuildFingerprint !== this.qualification.engineBuildFingerprint)) {
      this.staleResponses += 1;
      void this.retire("invalid-response");
      return;
    }
    // The request may have crossed a release-rotation boundary while the
    // physical worker was executing.  The pre-dispatch check is not enough:
    // never settle a response under an authority that is no longer current.
    // Retiring the worker also prevents a late response from being reused by
    // a subsequent request.
    try {
      this.assertAuthorityCurrent();
    } catch {
      this.staleResponses += 1;
      void this.retire("engine-unqualified");
      return;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort);
    this._state = "ready";
    pending.resolve(response);
  }

  private onExit(code: number | null): void {
    if (this._state === "dead") return;
    if (this._state === "retiring") {
      // retire() owns pending rejection while it waits for kill/reap; an exit
      // notification must not downgrade a timeout/retire reason to a generic
      // worker error.
      this._state = "dead";
      this.retireReason = `exit:${code ?? "unknown"}`;
      return;
    }
    this._state = "dead";
    this.retireReason = `exit:${code ?? "unknown"}`;
    this.helloReject?.(new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: this.epoch, message: `worker exited before qualification: ${code ?? "unknown"}` }));
    this.helloResolve = null;
    this.helloReject = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: this.epoch, requestId: pending.request.requestId, message: `worker exited with code ${code ?? "unknown"}` }));
    }
    this.pending.clear();
  }
}

interface QueuedSubmission {
  readonly request: RevmWorkerDispatchRequestV1;
  readonly resolve: (execution: RevmWorkerDispatchedExecutionV1) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

export interface RevmWorkerPoolSnapshot {
  readonly workers: readonly RevmWorkerControllerSnapshot[];
  readonly queued: number;
  readonly activeByOwner: Readonly<Record<string, number>>;
  readonly queueFull: number;
  readonly resourceLimit: number;
  readonly retired: number;
}

export interface RevmWorkerPoolOptions {
  readonly factory: RevmWorkerFactory;
  readonly qualification: RevmWorkerQualification;
  readonly authority: RevmWorkerAuthorityIssuer;
  readonly maxWorkers?: number;
  readonly queueCap?: number;
  readonly timeoutMs?: number;
  readonly perOwnerConcurrency?: number;
  readonly clock?: MonotonicClock;
}

/** Fixed, bounded, fair worker pool.  There is intentionally no local
 * simulation implementation when a worker is unavailable. */
export class RevmWorkerPool {
  private readonly factory: RevmWorkerFactory;
  private readonly qualification: RevmWorkerQualification;
  private readonly authority: RevmWorkerAuthorityIssuer;
  private readonly maxWorkers: number;
  private readonly queueCap: number;
  private readonly timeoutMs: number;
  private readonly perOwnerConcurrency: number;
  private readonly clock: MonotonicClock;
  private readonly controllers: RevmWorkerController[] = [];
  private readonly queue: QueuedSubmission[] = [];
  private readonly activeByOwner = new Map<string, number>();
  private readonly ownerOrder: string[] = [];
  private cursor = 0;
  private starting = 0;
  private queueFull = 0;
  private resourceLimit = 0;
  private retired = 0;
  private draining = false;
  private closed = false;

  constructor(options: RevmWorkerPoolOptions) {
    this.factory = options.factory;
    this.qualification = Object.freeze({ ...options.qualification });
    this.authority = assertIssuedRevmWorkerAuthorityIssuer(options.authority);
    this.maxWorkers = options.maxWorkers ?? 4;
    this.queueCap = options.queueCap ?? 32;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.perOwnerConcurrency = options.perOwnerConcurrency ?? 1;
    this.clock = options.clock ?? monotonicNow;
    if (!this.qualification || typeof this.qualification.engineBuildFingerprint !== "string" || this.qualification.engineBuildFingerprint.length === 0 || typeof this.qualification.executableFingerprint !== "string" || this.qualification.executableFingerprint.length === 0) throw new TypeError("REVM worker qualification is incomplete");
    for (const [value, name] of [[this.maxWorkers, "maxWorkers"], [this.queueCap, "queueCap"], [this.timeoutMs, "timeoutMs"], [this.perOwnerConcurrency, "perOwnerConcurrency"]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
    }
  }

  submit(
    request: RevmWorkerDispatchRequestV1,
    signal?: AbortSignal,
  ): Promise<RevmWorkerDispatchedExecutionV1> {
    this.pruneDead();
    if (this.closed) return Promise.reject(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: null, requestId: request.requestId, message: "REVM worker pool is closed" }));
    try {
      assertDispatchRequestShape(request);
    } catch (error) {
      return Promise.reject(new RevmWorkerLifecycleError({ code: "invalid-request", workerEpoch: null, requestId: request.requestId, message: error instanceof Error ? error.message : String(error) }));
    }
    if (request.deadlineAtMs <= this.clock()) return Promise.reject(new RevmWorkerLifecycleError({ code: "deadline", workerEpoch: null, requestId: request.requestId, message: "REVM request deadline elapsed while queued" }));
    if (signal?.aborted) return Promise.reject(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: null, requestId: request.requestId, message: "REVM request was aborted while queued" }));
    if ((this.activeByOwner.get(request.ownerRef) ?? 0) >= this.perOwnerConcurrency) {
      this.resourceLimit += 1;
      return Promise.reject(new RevmWorkerLifecycleError({ code: "resource-limit", workerEpoch: null, requestId: request.requestId, message: "owner REVM quota is full" }));
    }
    const idle = this.controllers.find((controller) => controller.state === "ready");
    if (!idle && this.queue.length >= this.queueCap) {
      this.queueFull += 1;
      return Promise.reject(new RevmWorkerLifecycleError({ code: "queue-full", workerEpoch: null, requestId: request.requestId, message: "REVM waiting queue is full" }));
    }
    return new Promise<RevmWorkerDispatchedExecutionV1>((resolve, reject) => {
      const queued: QueuedSubmission = { request, resolve, reject, signal, timer: undefined, settled: false };
      queued.timer = setTimeout(() => {
        if (queued.settled) return;
        queued.settled = true;
        this.removeQueued(queued);
        reject(new RevmWorkerLifecycleError({ code: "deadline", workerEpoch: null, requestId: request.requestId, message: "REVM request deadline elapsed while queued" }));
        void this.drain();
      }, Math.max(0, request.deadlineAtMs - this.clock()));
      const onAbort = (): void => {
        if (queued.settled) return;
        queued.settled = true;
        this.removeQueued(queued);
        if (queued.timer !== undefined) clearTimeout(queued.timer);
        reject(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: null, requestId: request.requestId, message: "REVM request was aborted while queued" }));
        void this.drain();
      };
      queued.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(queued);
      if (!this.ownerOrder.includes(request.ownerRef)) this.ownerOrder.push(request.ownerRef);
      void this.drain();
    });
  }

  async retireAll(): Promise<void> {
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      queued.settled = true;
      this.disposeQueued(queued);
      queued.reject(new RevmWorkerLifecycleError({ code: "retired", workerEpoch: null, requestId: queued.request.requestId, message: "REVM worker pool shut down" }));
    }
    this.ownerOrder.length = 0;
    await Promise.all(this.controllers.map((controller) => controller.retire("pool-shutdown")));
    this.pruneDead();
  }

  snapshot(): RevmWorkerPoolSnapshot {
    this.pruneDead();
    const activeByOwner: Record<string, number> = {};
    for (const [owner, count] of this.activeByOwner) activeByOwner[owner] = count;
    return Object.freeze({ workers: Object.freeze(this.controllers.map((controller) => controller.snapshot())), queued: this.queue.length, activeByOwner: Object.freeze(activeByOwner), queueFull: this.queueFull, resourceLimit: this.resourceLimit, retired: this.retired });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        this.pruneDead();
        let controller = this.controllers.find((candidate) => candidate.state === "ready");
        if (!controller && this.controllers.length + this.starting < this.maxWorkers && this.queue.length > 0) {
          this.starting += 1;
          try {
            const authority = this.authority.issue();
            assertAuthorityBinding(authority);
            const epoch = authority.workerEpoch;
            const channel = await this.factory.spawn(epoch);
            controller = new RevmWorkerController({ epoch, channel, qualification: this.qualification, authority, assertAuthorityCurrent: () => this.authority.assertCurrent(authority), timeoutMs: this.timeoutMs, clock: this.clock });
            this.controllers.push(controller);
            await controller.waitUntilReady();
          } catch (error) {
            const failed = this.queue.shift();
            if (failed) {
              failed.settled = true;
              this.disposeQueued(failed);
              failed.reject(new RevmWorkerLifecycleError({ code: "worker-error", workerEpoch: null, requestId: failed.request.requestId, message: error instanceof Error ? error.message : String(error) }));
            }
            if (controller && controller.state !== "dead") await controller.retire("qualification-failed");
            controller = undefined;
          } finally {
            this.starting -= 1;
          }
        }
        if (!controller) return;
        const queued = this.nextQueued(controller);
        if (!queued) return;
        const owner = queued.request.ownerRef;
        this.disposeQueued(queued);
        queued.settled = true;
        this.activeByOwner.set(owner, (this.activeByOwner.get(owner) ?? 0) + 1);
        let request: RevmWorkerSimulateRequestV1;
        try {
          request = controller.bind(queued.request);
        } catch (error) {
          const remaining = (this.activeByOwner.get(owner) ?? 1) - 1;
          if (remaining <= 0) this.activeByOwner.delete(owner);
          else this.activeByOwner.set(owner, remaining);
          queued.reject(error);
          void this.drain();
          continue;
        }
        void controller.submit(request, queued.signal).then(
          (response) => queued.resolve(Object.freeze({ request, response })),
          queued.reject,
        ).finally(() => {
          const remaining = (this.activeByOwner.get(owner) ?? 1) - 1;
          if (remaining <= 0) this.activeByOwner.delete(owner);
          else this.activeByOwner.set(owner, remaining);
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private nextQueued(controller: RevmWorkerController): QueuedSubmission | undefined {
    const ownerCount = this.ownerOrder.length;
    for (let offset = 0; offset < ownerCount; offset += 1) {
      if (this.ownerOrder.length === 0) return undefined;
      const index = (this.cursor + offset) % this.ownerOrder.length;
      const owner = this.ownerOrder[index];
      if ((this.activeByOwner.get(owner) ?? 0) >= this.perOwnerConcurrency) continue;
      const queueIndex = this.queue.findIndex((entry) => entry.request.ownerRef === owner);
      if (queueIndex < 0) continue;
      const [queued] = this.queue.splice(queueIndex, 1);
      if (!queued || queued.settled) continue;
      if (queued.request.deadlineAtMs <= this.clock()) {
        queued.settled = true;
        this.disposeQueued(queued);
        queued.reject(new RevmWorkerLifecycleError({ code: "deadline", workerEpoch: null, requestId: queued.request.requestId, message: "REVM request deadline elapsed while queued" }));
        continue;
      }
      this.cursor = this.ownerOrder.length === 0 ? 0 : (index + 1) % this.ownerOrder.length;
      if (!this.queue.some((entry) => entry.request.ownerRef === owner)) {
        this.ownerOrder.splice(index, 1);
        if (this.cursor >= this.ownerOrder.length) this.cursor = 0;
      }
      return queued;
    }
    return undefined;
  }

  private removeQueued(queued: QueuedSubmission): void {
    const index = this.queue.indexOf(queued);
    if (index >= 0) this.queue.splice(index, 1);
    this.disposeQueued(queued);
    const owner = queued.request.ownerRef;
    if (!this.queue.some((entry) => entry.request.ownerRef === owner)) {
      const ownerIndex = this.ownerOrder.indexOf(owner);
      if (ownerIndex >= 0) this.ownerOrder.splice(ownerIndex, 1);
      if (this.cursor >= this.ownerOrder.length) this.cursor = 0;
    }
  }

  private disposeQueued(queued: QueuedSubmission): void {
    if (queued.timer !== undefined) clearTimeout(queued.timer);
    if (queued.signal && queued.onAbort) queued.signal.removeEventListener("abort", queued.onAbort);
  }

  private pruneDead(): void {
    const live = this.controllers.filter((controller) => controller.state !== "dead");
    this.retired += this.controllers.length - live.length;
    this.controllers.splice(0, this.controllers.length, ...live);
  }
}
