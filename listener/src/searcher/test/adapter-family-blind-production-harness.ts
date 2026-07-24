import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  BLIND_PRODUCTION_CONTROL_PREFIX as PRODUCTION_CONTROL_PREFIX,
  BLIND_PRODUCTION_RAW_PREFIX as PRODUCTION_RAW_PREFIX,
  BLIND_PRODUCTION_READY_PREFIX as PRODUCTION_READY_PREFIX,
} from "../blind-production-audit.js";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  isBlindRunProfile,
  type BlindProducerPrepareRequest,
  type BlindProducerReady,
  type BlindProducerRevealReady,
  type BlindProducerRevealReleaseRequest,
  type BlindProducerReleaseRequest,
  type BlindProducerRequest,
  type BlindProducerSourceRevealed,
} from "./adapter-family-blind-contract.js";
import {
  BLIND_PRODUCTION_RAW_PROFILE,
  assembleBlindProducerOutput,
  createAttemptNonce,
  productionPrepareControl,
  productionSourceHeadControl,
  validateBackendRevealReadyEvidence,
  validateBackendRevealedEvidence,
  validateProductionReadyRecord,
  type BlindBackendFinishedEvidence,
  type BlindBackendPreparedEvidence,
  type BlindBackendRevealReadyEvidence,
  type BlindBackendRevealedEvidence,
  type BlindProductionPassRecord,
  type BlindProductionPrepareControl,
  type BlindProductionReadyRecord,
} from "./adapter-family-blind-production-raw.js";
import {
  validateBlindProductionArtifactReceipt,
} from "../blind-production-artifacts.js";

const RUNNER_BASE_READY_PREFIX = "BLIND_PRODUCER_BASE_READY=";
const RUNNER_REVEAL_READY_PREFIX = "BLIND_PRODUCER_REVEAL_READY=";
const RUNNER_SOURCE_REVEALED_PREFIX = "BLIND_PRODUCER_SOURCE_REVEALED=";
const RUNNER_OUTPUT_PREFIX = "BLIND_PRODUCER_OUTPUT=";

interface PreparedAttempt {
  readonly request: BlindProducerPrepareRequest;
  readonly attemptNonce: string;
  readonly control: BlindProductionPrepareControl;
  readonly backend: BlindBackendPreparedEvidence;
}

interface ActiveAttempt {
  readonly request: BlindProducerRequest;
  readonly prepared: PreparedAttempt;
  readonly revealed: BlindBackendRevealedEvidence;
  readonly releaseToken: string;
  sourceDelivered: boolean;
}

interface RevealPendingAttempt {
  readonly request: BlindProducerRequest;
  readonly prepared: PreparedAttempt;
  readonly backendReady: BlindBackendRevealReadyEvidence;
}

export class BlindProductionHarness {
  private production: ChildProcessWithoutNullStreams | null = null;
  private prepared: PreparedAttempt | null = null;
  private revealPending: RevealPendingAttempt | null = null;
  private active: ActiveAttempt | null = null;
  private productionReady: {
    readonly control: BlindProductionPrepareControl;
    readonly request: BlindProducerPrepareRequest;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  } | null = null;
  private queue = Promise.resolve();
  private closed = false;

  constructor(
    private readonly productionEntry: string,
    private readonly controllerUrl: string,
    private readonly preparationTimeoutMs: number,
  ) {
    assertLoopbackUrl(controllerUrl);
  }

  acceptRunnerLine(line: string): void {
    this.queue = this.queue
      .then(async () => {
        const message = JSON.parse(line) as {
          type?: unknown;
        };
        if (message.type === "close") {
          await this.close();
        } else if (message.type === "prepare") {
          await this.prepare(message as BlindProducerPrepareRequest);
        } else if (message.type === "reveal_request") {
          await this.prepareReveal(message as BlindProducerRequest);
        } else if (message.type === "reveal_release") {
          await this.releaseReveal(
            message as BlindProducerRevealReleaseRequest,
          );
        } else if (message.type === "release") {
          this.release(message as BlindProducerReleaseRequest);
        } else {
          throw new Error("blind production harness received unknown runner message");
        }
      })
      .catch((error) => this.fatal(error));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.production;
    this.production = null;
    if (child && child.exitCode === null && !child.killed) {
      child.stdin.end();
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  }

  private async prepare(request: BlindProducerPrepareRequest): Promise<void> {
    validatePrepareRequest(request);
    if (this.closed) throw new Error("blind production harness is closed");
    if (
      this.active ||
      this.prepared ||
      this.revealPending ||
      this.productionReady
    ) {
      throw new Error("blind production harness received overlapping prepare");
    }
    const attemptNonce = createAttemptNonce();
    const control = productionPrepareControl(request, attemptNonce);
    const backend = await this.callController<BlindBackendPreparedEvidence>({
      ...control,
      // The trusted controller may materialize N while the production entry
      // receives only the base anchor and opaque attempt lease below.
      source: request.source,
      backendIdentitySha256: request.backendIdentitySha256,
    });
    const prepared = { request, attemptNonce, control, backend };
    this.prepared = prepared;
    this.ensureProduction();
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        if (this.productionReady?.control.attemptNonce !== attemptNonce) return;
        this.productionReady = null;
        rejectReady(new Error(
          `production entry did not become ready within ${this.preparationTimeoutMs}ms`,
        ));
      }, this.preparationTimeoutMs);
      this.productionReady = {
        control,
        request,
        resolve: resolveReady,
        reject: rejectReady,
        timer,
      };
      this.writeProductionControl(control);
    });
    const ready: BlindProducerReady = {
      type: "base_ready",
      schemaVersion: BLIND_SCHEMA_VERSION,
      profile: request.profile,
      experimentId: request.experimentId,
      caseId: request.caseId,
      side: request.side,
      runIndex: request.runIndex,
    };
    process.stdout.write(
      `${RUNNER_BASE_READY_PREFIX}${canonicalJson(ready)}\n`,
    );
  }

  private async prepareReveal(request: BlindProducerRequest): Promise<void> {
    validateRunRequest(request);
    const prepared = this.prepared;
    if (!prepared || this.active || this.revealPending) {
      throw new Error("blind production run has no exclusive prepared attempt");
    }
    assertSameAttempt(request, prepared.request);
    this.prepared = null;
    const backendReady =
      await this.callController<BlindBackendRevealReadyEvidence>({
        type: "reveal_request",
        profile: BLIND_PRODUCTION_RAW_PROFILE,
        attemptNonce: prepared.attemptNonce,
        source: request.source,
        cleanForkId: prepared.backend.cleanForkId,
      });
    validateBackendRevealReadyEvidence(
      backendReady,
      prepared.attemptNonce,
      prepared.backend,
    );
    this.revealPending = { request, prepared, backendReady };
    const ready: BlindProducerRevealReady = {
      type: "reveal_ready",
      schemaVersion: BLIND_SCHEMA_VERSION,
      profile: request.profile,
      experimentId: request.experimentId,
      caseId: request.caseId,
      side: request.side,
      runIndex: request.runIndex,
      revealToken: backendReady.revealToken,
    };
    process.stdout.write(
      `${RUNNER_REVEAL_READY_PREFIX}${canonicalJson(ready)}\n`,
    );
  }

  private async releaseReveal(
    request: BlindProducerRevealReleaseRequest,
  ): Promise<void> {
    validateRevealReleaseRequest(request);
    const pending = this.revealPending;
    if (!pending || this.active) {
      throw new Error("blind production source reveal has no pending attempt");
    }
    assertRevealReleaseMatches(request, pending);
    this.revealPending = null;
    const revealed = await this.callController<BlindBackendRevealedEvidence>({
      type: "release",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: pending.prepared.attemptNonce,
      cleanForkId: pending.prepared.backend.cleanForkId,
      revealToken: pending.backendReady.revealToken,
    });
    validateBackendRevealedEvidence(
      revealed,
      pending.request,
      pending.prepared.attemptNonce,
      pending.prepared.backend,
    );
    const releaseToken = createAttemptNonce();
    this.active = {
      request: pending.request,
      prepared: pending.prepared,
      revealed,
      releaseToken,
      sourceDelivered: false,
    };
    const sourceRevealed: BlindProducerSourceRevealed = {
      type: "source_revealed",
      schemaVersion: BLIND_SCHEMA_VERSION,
      profile: pending.request.profile,
      experimentId: pending.request.experimentId,
      caseId: pending.request.caseId,
      side: pending.request.side,
      runIndex: pending.request.runIndex,
      switchedAtMonotonicNs: revealed.switchedAtMonotonicNs,
      releaseToken,
    };
    process.stdout.write(
      `${RUNNER_SOURCE_REVEALED_PREFIX}${canonicalJson(sourceRevealed)}\n`,
    );
  }

  private release(request: BlindProducerReleaseRequest): void {
    validateReleaseRequest(request);
    const active = this.active;
    if (!active || active.sourceDelivered) {
      throw new Error("blind production release has no exclusive revealed attempt");
    }
    assertReleaseMatches(request, active);
    active.sourceDelivered = true;
    this.writeProductionControl(
      productionSourceHeadControl(
        active.request,
        active.prepared.attemptNonce,
      ),
    );
  }

  private ensureProduction(): void {
    if (this.production) return;
    const child = spawn(
      process.execPath,
      [...process.execArgv, this.productionEntry],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BLIND_SENTINEL_MODE: "1",
          SEARCHER_TEST_DISABLE_DOTENV: "1",
          SEARCHER_BLIND_RAW_AUDIT: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.production = child;
    child.on("error", (error) => this.fatal(error));
    child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.fatal(new Error(
          `production entry exited code=${String(code)} signal=${String(signal)}`,
        ));
      }
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith(PRODUCTION_READY_PREFIX)) {
        this.acceptProductionReady(line.slice(PRODUCTION_READY_PREFIX.length));
      } else if (line.startsWith(PRODUCTION_RAW_PREFIX)) {
        void this.acceptProductionPass(line.slice(PRODUCTION_RAW_PREFIX.length))
          .catch((error) => this.fatal(error));
      } else {
        process.stderr.write(`[blind-production] ${line}\n`);
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      process.stderr.write(`[blind-production] ${line}\n`);
    });
  }

  private acceptProductionReady(raw: string): void {
    const pending = this.productionReady;
    if (!pending) {
      this.fatal(new Error("production entry emitted unexpected ready record"));
      return;
    }
    try {
      const record = JSON.parse(raw) as BlindProductionReadyRecord;
      validateProductionReadyRecord(record, pending.control);
      for (const [label, receipt, expected] of [
        [
          "resolved config",
          record.artifacts.resolvedConfig,
          pending.request.resolvedConfigSha256,
        ],
        ["universe", record.artifacts.universe, pending.request.universeSha256],
        [
          "active family manifest",
          record.artifacts.activeFamilyManifest,
          pending.request.activeFamilyManifestSha256,
        ],
        [
          "base graph view",
          record.artifacts.baseGraphView,
          pending.request.baseGraphViewSha256,
        ],
      ] as const) {
        validateBlindProductionArtifactReceipt(receipt, receipt.kind);
        if (receipt.sha256 !== expected) {
          throw new Error(`production ${label} artifact mismatch`);
        }
      }
      clearTimeout(pending.timer);
      this.productionReady = null;
      pending.resolve();
    } catch (error) {
      clearTimeout(pending.timer);
      this.productionReady = null;
      pending.reject(asError(error));
    }
  }

  private async acceptProductionPass(raw: string): Promise<void> {
    const active = this.active;
    if (!active?.sourceDelivered) {
      throw new Error("production entry emitted pass before trusted source release");
    }
    this.active = null;
    const record = JSON.parse(raw) as BlindProductionPassRecord;
    if (record.attemptNonce !== active.prepared.attemptNonce) {
      throw new Error("production entry emitted stale/foreign pass nonce");
    }
    const finished = await this.callController<BlindBackendFinishedEvidence>({
      type: "finish",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: active.prepared.attemptNonce,
      cleanForkId: active.prepared.backend.cleanForkId,
    });
    const output = assembleBlindProducerOutput({
      request: active.request,
      attemptNonce: active.prepared.attemptNonce,
      prepared: active.prepared.backend,
      revealed: active.revealed,
      finished,
      raw: record,
    });
    process.stdout.write(`${RUNNER_OUTPUT_PREFIX}${canonicalJson(output)}\n`);
  }

  private writeProductionControl(control: object): void {
    const child = this.production;
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error("production entry is not running");
    }
    child.stdin.write(`${PRODUCTION_CONTROL_PREFIX}${canonicalJson(control)}\n`);
  }

  private async callController<T>(body: object): Promise<T> {
    const response = await fetch(this.controllerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson(body),
      signal: AbortSignal.timeout(this.preparationTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(
        `blind backend controller HTTP ${response.status}` +
          (detail ? `: ${detail}` : ""),
      );
    }
    return await response.json() as T;
  }

  private fatal(error: unknown): void {
    const failure = asError(error);
    const pending = this.productionReady;
    if (pending) {
      clearTimeout(pending.timer);
      this.productionReady = null;
      pending.reject(failure);
    }
    process.stderr.write(`blind production harness fatal: ${failure.message}\n`);
    void this.close().finally(() => {
      process.exitCode = 1;
      process.stdin.destroy();
    });
  }
}

function validatePrepareRequest(request: BlindProducerPrepareRequest): void {
  assert(request.type === "prepare", "prepare request type");
  validateCommonRequest(request);
}

function validateRunRequest(request: BlindProducerRequest): void {
  assert(request.type === "reveal_request", "reveal request type");
  validateCommonRequest(request);
}

function validateRevealReleaseRequest(
  request: BlindProducerRevealReleaseRequest,
): void {
  assert(request.type === "reveal_release", "reveal release request type");
  validateReleaseEnvelope(request, "reveal release");
  assert(/^[0-9a-f]{64}$/.test(request.revealToken), "reveal release token");
}

function validateReleaseRequest(request: BlindProducerReleaseRequest): void {
  assert(request.type === "release", "release request type");
  validateReleaseEnvelope(request, "release");
  assert(/^[0-9a-f]{64}$/.test(request.releaseToken), "release request token");
}

function validateReleaseEnvelope(
  request: {
    readonly schemaVersion: number;
    readonly profile: string;
    readonly caseId: string;
    readonly side: string;
    readonly runIndex: number;
  },
  label: string,
): void {
  assert(request.schemaVersion === BLIND_SCHEMA_VERSION, `${label} schema`);
  assert(isBlindRunProfile(request.profile), `${label} profile`);
  assert(
    request.caseId === "primary" || request.caseId === "held-out",
    `${label} caseId`,
  );
  assert(
    request.side === "baseline" || request.side === "challenger",
    `${label} side`,
  );
  assert(
    Number.isSafeInteger(request.runIndex) && request.runIndex >= 0,
    `${label} index`,
  );
}

function validateCommonRequest(
  request: Omit<BlindProducerRequest, "type"> & { readonly type: string },
): void {
  assert(request.schemaVersion === BLIND_SCHEMA_VERSION, "runner request schema");
  assert(isBlindRunProfile(request.profile), "runner request profile");
  assert(
    request.caseId === "primary" || request.caseId === "held-out",
    "runner request caseId",
  );
  assert(request.side === "baseline" || request.side === "challenger", "runner request side");
  assert(Number.isSafeInteger(request.runIndex) && request.runIndex >= 0, "runner request index");
}

function assertSameAttempt(
  run: BlindProducerRequest,
  prepare: BlindProducerPrepareRequest,
): void {
  const { type: _runType, ...runComparable } = run;
  const { type: _prepareType, ...prepareComparable } = prepare;
  assert(
    canonicalJson(runComparable) === canonicalJson(prepareComparable),
    "run request does not match prepared attempt",
  );
}

function assertReleaseMatches(
  release: BlindProducerReleaseRequest,
  active: ActiveAttempt,
): void {
  assert(release.releaseToken === active.releaseToken, "release token mismatch");
  assert(release.experimentId === active.request.experimentId, "release experiment mismatch");
  assert(release.caseId === active.request.caseId, "release case mismatch");
  assert(release.side === active.request.side, "release side mismatch");
  assert(release.runIndex === active.request.runIndex, "release index mismatch");
}

function assertRevealReleaseMatches(
  release: BlindProducerRevealReleaseRequest,
  pending: RevealPendingAttempt,
): void {
  assert(
    release.revealToken === pending.backendReady.revealToken,
    "reveal release token mismatch",
  );
  assert(
    release.experimentId === pending.request.experimentId,
    "reveal release experiment mismatch",
  );
  assert(
    release.caseId === pending.request.caseId,
    "reveal release case mismatch",
  );
  assert(release.side === pending.request.side, "reveal release side mismatch");
  assert(
    release.runIndex === pending.request.runIndex,
    "reveal release index mismatch",
  );
}

function assertLoopbackUrl(value: string): void {
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", "controller URL protocol");
  const hostname = url.hostname.toLowerCase();
  assert(
    hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]",
    "blind backend controller must be loopback",
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(args: readonly string[]): {
  productionEntry: string;
  controllerUrl: string;
  preparationTimeoutMs: number;
} {
  let productionEntry = "";
  let controllerUrl = process.env.BLIND_SOURCE_CONTROL_URL ?? "";
  let preparationTimeoutMs = Number(
    process.env.BLIND_PREPARATION_TIMEOUT_MS ?? "120000",
  );
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--production-entry") productionEntry = value;
    else if (name === "--controller-url") controllerUrl = value;
    else if (name === "--preparation-timeout-ms") preparationTimeoutMs = Number(value);
    else throw new Error(`unknown argument ${name}`);
  }
  if (!productionEntry || !controllerUrl) {
    throw new Error(
      "usage: --production-entry <absolute-main-entry> " +
        "--controller-url <loopback-controller-url>",
    );
  }
  if (!isAbsolute(productionEntry)) {
    throw new Error("production entry must be absolute");
  }
  if (!Number.isSafeInteger(preparationTimeoutMs) || preparationTimeoutMs <= 0) {
    throw new Error("preparation timeout must be a positive integer");
  }
  return { productionEntry, controllerUrl, preparationTimeoutMs };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const harness = new BlindProductionHarness(
    args.productionEntry,
    args.controllerUrl,
    args.preparationTimeoutMs,
  );
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => harness.acceptRunnerLine(line));
  input.on("close", () => void harness.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(asError(error).message);
    process.exitCode = 1;
  }
}
