import { createHash, randomInt } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { pathToFileURL } from "node:url";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  producerPrepareRequest,
  producerRequest,
  sealProducerOutput,
  sha256Canonical,
  validateBlindRunManifest,
  type BlindProducerOutput,
  type BlindProducerReady,
  type BlindProducerRevealReady,
  type BlindProducerRevealReleaseRequest,
  type BlindProducerReleaseRequest,
  type BlindProducerSourceRevealed,
  type BlindRunCaseId,
  type BlindRuntimeSecretRef,
  type BlindRunManifest,
  type BlindRunOrderEntry,
  type BlindRunProfile,
  type BlindSide,
  type SealedBlindProducerOutput,
} from "./adapter-family-blind-contract.js";
import {
  readAndVerifyBlindModuleClosure,
  readBlindProductionArtifact,
  validateBackendAttestationArtifact,
} from "./adapter-family-blind-artifacts.js";

const OUTPUT_PREFIX = "BLIND_PRODUCER_OUTPUT=";
const BASE_READY_PREFIX = "BLIND_PRODUCER_BASE_READY=";
const REVEAL_READY_PREFIX = "BLIND_PRODUCER_REVEAL_READY=";
const SOURCE_REVEALED_PREFIX = "BLIND_PRODUCER_SOURCE_REVEALED=";

export interface BlindRunnerRuntimeOptions {
  /** Secret env names the trusted runner is authorized to resolve. */
  readonly secretEnvAllowlist?: readonly string[];
  /** Testable trusted runtime environment; defaults to process.env. */
  readonly runtimeEnv?: Readonly<Record<string, string | undefined>>;
}

export interface BlindRunnerAttempt {
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly status: "sealed" | "failed";
  readonly runnerElapsedMs: number;
  readonly outputSha256: string | null;
  readonly error: string | null;
}

export interface BlindRunnerReport {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly manifestSha256: string;
  readonly attempts: readonly BlindRunnerAttempt[];
  readonly sealedOutputsSha256: string;
}

export async function runBlindSentinel(
  manifest: BlindRunManifest,
  outDir: string,
  runtime: BlindRunnerRuntimeOptions = {},
): Promise<{
  readonly report: BlindRunnerReport;
  readonly outputs: readonly SealedBlindProducerOutput[];
}> {
  validateBlindRunManifest(manifest);
  verifyFrozenArtifacts(manifest);
  mkdirSync(outDir, { recursive: true });

  const sessions = {
    baseline: {
      primary: new ProducerSession(
        "baseline",
        "primary",
        manifest,
        outDir,
        runtime,
      ),
      "held-out": new ProducerSession(
        "baseline",
        "held-out",
        manifest,
        outDir,
        runtime,
      ),
    },
    challenger: {
      primary: new ProducerSession(
        "challenger",
        "primary",
        manifest,
        outDir,
        runtime,
      ),
      "held-out": new ProducerSession(
        "challenger",
        "held-out",
        manifest,
        outDir,
        runtime,
      ),
    },
  };
  const allSessions = Object.values(sessions)
    .flatMap((byCase) => Object.values(byCase));
  try {
    await Promise.all(allSessions.map((session) => session.start()));
  } catch (error) {
    await Promise.allSettled(allSessions.map((session) => session.close()));
    writeCombinedProducerLogs(outDir, sessions);
    throw error;
  }

  const attempts: BlindRunnerAttempt[] = [];
  const outputs: SealedBlindProducerOutput[] = [];
  try {
    for (const entry of manifest.runOrder) {
      const session = sessions[entry.side][entry.caseId];
      try {
        const sealed = await session.request(entry);
        outputs.push(sealed);
        attempts.push({
          caseId: entry.caseId,
          side: entry.side,
          runIndex: entry.runIndex,
          status: "sealed",
          runnerElapsedMs: sealed.runnerElapsedMs,
          outputSha256: sealed.outputSha256,
          error: null,
        });
      } catch (error) {
        attempts.push({
          caseId: entry.caseId,
          side: entry.side,
          runIndex: entry.runIndex,
          status: "failed",
          runnerElapsedMs: session.lastElapsedMs(),
          outputSha256: null,
          error: message(error),
        });
      }
    }
  } finally {
    await Promise.allSettled(allSessions.map((session) => session.close()));
    writeCombinedProducerLogs(outDir, sessions);
  }

  const report: BlindRunnerReport = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: manifest.profile,
    experimentId: manifest.experimentId,
    manifestSha256: sha256Canonical(manifest),
    attempts,
    sealedOutputsSha256: sha256Canonical(
      outputs.map((entry) => entry.envelopeSha256).sort(),
    ),
  };
  writeOwnerOnly(
    resolve(outDir, "sealed-producer-outputs.json"),
    `${canonicalJson(outputs)}\n`,
  );
  writeOwnerOnly(
    resolve(outDir, "blind-runner-report.json"),
    `${canonicalJson(report)}\n`,
  );
  return { report, outputs };
}

class ProducerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, {
    readonly startedNs: bigint;
    readonly sourceSwitchedNs: bigint;
    readonly resolve: (output: SealedBlindProducerOutput) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private readonly preparing = new Map<string, {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private readonly revealPreparing = new Map<string, {
    readonly resolve: (ready: BlindProducerRevealReady) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private readonly sourceRevealing = new Map<string, {
    readonly resolve: (revealed: BlindProducerSourceRevealed) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private readonly stdoutLines: string[] = [];
  private readonly stderrLines: string[] = [];
  private readonly secretValues = new Map<string, string>();
  private lastElapsed = 0;
  private exitError: Error | null = null;
  private closing = false;
  private runtimePorts: BlindProducerRuntimePortLease | null = null;

  constructor(
    private readonly side: BlindSide,
    private readonly caseId: BlindRunCaseId,
    private readonly manifest: BlindRunManifest,
    private readonly outDir: string,
    private readonly runtime: BlindRunnerRuntimeOptions,
  ) {}

  async start(): Promise<void> {
    const spec = this.manifest.producers[this.side].cases[this.caseId].command;
    if (!isAbsolute(spec.executable)) {
      throw new Error(`${this.side} producer executable must be absolute`);
    }
    const secretEnv = resolveRuntimeSecretEnv(
      spec.secretEnvRefs ?? [],
      new Set(this.runtime.secretEnvAllowlist ?? []),
      this.runtime.runtimeEnv ?? process.env,
    );
    const producerSurface = canonicalJson({
      argv: spec.argv,
      env: spec.env,
    });
    for (const [name, value] of Object.entries(secretEnv)) {
      if (secretVariants(value).some((variant) => producerSurface.includes(variant))) {
        throw new Error(
          `trusted runtime secret ${name} is duplicated in producer manifest fields`,
        );
      }
      this.secretValues.set(name, value);
    }
    this.runtimePorts = await reserveBlindProducerRuntimePorts(
      blockScanWorkerCount(spec.env),
    );
    this.child = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      env: {
        ...spec.env,
        ...secretEnv,
        ...this.runtimePorts.env,
        BLIND_SENTINEL_MODE: "1",
        SEARCHER_TEST_DISABLE_DOTENV: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closing) {
        this.failAll(new Error(
          `${this.side} producer exited before trusted-runner close ` +
            `code=${String(code)} signal=${String(signal)}`,
        ));
      }
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.stdoutLines.push(this.redact(line));
      if (line.startsWith(BASE_READY_PREFIX)) {
        this.acceptReady(line.slice(BASE_READY_PREFIX.length));
      } else if (line.startsWith(REVEAL_READY_PREFIX)) {
        this.acceptRevealReady(line.slice(REVEAL_READY_PREFIX.length));
      } else if (line.startsWith(SOURCE_REVEALED_PREFIX)) {
        this.acceptSourceRevealed(line.slice(SOURCE_REVEALED_PREFIX.length));
      } else if (line.startsWith(OUTPUT_PREFIX)) {
        this.acceptOutput(line.slice(OUTPUT_PREFIX.length));
      }
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderrLines.push(this.redact(line));
    });
    await new Promise<void>((resolveStarted) => setImmediate(resolveStarted));
    if (this.exitError) throw this.exitError;
  }

  async request(entry: BlindRunOrderEntry): Promise<SealedBlindProducerOutput> {
    if (!this.child || this.exitError) {
      throw this.exitError ?? new Error(`${this.side} producer is not running`);
    }
    if (entry.caseId !== this.caseId) {
      throw new Error(
        `${this.side} ${this.caseId} producer cannot run ${entry.caseId}`,
      );
    }
    const key = runKey(entry);
    this.lastElapsed = 0;
    if (
      this.pending.has(key) ||
      this.preparing.has(key) ||
      this.revealPreparing.has(key) ||
      this.sourceRevealing.has(key)
    ) {
      throw new Error(`duplicate pending producer request ${key}`);
    }
    await this.releaseRuntimePortReservations();
    const prepared = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        if (!this.preparing.delete(key)) return;
        rejectReady(new Error(
          `${key} producer preparation timeout after ${this.manifest.responseTimeoutMs}ms`,
        ));
      }, this.manifest.responseTimeoutMs);
      this.preparing.set(key, {
        resolve: resolveReady,
        reject: rejectReady,
        timer,
      });
    });
    this.child.stdin.write(
      `${canonicalJson(producerPrepareRequest(this.manifest, entry))}\n`,
    );
    await prepared;
    if (this.exitError) throw this.exitError;
    const request = producerRequest(this.manifest, entry);
    const revealReady = new Promise<BlindProducerRevealReady>(
      (resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          if (!this.revealPreparing.delete(key)) return;
          rejectReady(new Error(
            `${key} source-backend reveal preparation timeout after ` +
              `${this.manifest.responseTimeoutMs}ms`,
          ));
        }, this.manifest.responseTimeoutMs);
        this.revealPreparing.set(key, {
          resolve: resolveReady,
          reject: rejectReady,
          timer,
        });
      },
    );
    this.child.stdin.write(`${canonicalJson(request)}\n`);
    const reveal = await revealReady;
    if (this.exitError) throw this.exitError;
    const sourceRevealed = new Promise<BlindProducerSourceRevealed>(
      (resolveRevealed, rejectRevealed) => {
        const timer = setTimeout(() => {
          if (!this.sourceRevealing.delete(key)) return;
          rejectRevealed(new Error(
            `${key} source-backend switch timeout after ` +
              `${this.manifest.responseTimeoutMs}ms`,
          ));
        }, this.manifest.responseTimeoutMs);
        this.sourceRevealing.set(key, {
          resolve: resolveRevealed,
          reject: rejectRevealed,
          timer,
        });
      },
    );
    const revealRelease: BlindProducerRevealReleaseRequest = {
      type: "reveal_release",
      schemaVersion: BLIND_SCHEMA_VERSION,
      profile: this.manifest.profile,
      experimentId: request.experimentId,
      caseId: request.caseId,
      side: request.side,
      runIndex: request.runIndex,
      revealToken: reveal.revealToken,
    };
    // Start timing before the one-use release that atomically switches /rpc.
    // Thus neither the switch nor its acknowledgement can be hidden.
    const startedNs = process.hrtime.bigint();
    this.child.stdin.write(`${canonicalJson(revealRelease)}\n`);
    const revealed = await sourceRevealed;
    if (this.exitError) throw this.exitError;
    const switchedAtNs = BigInt(revealed.switchedAtMonotonicNs);
    if (switchedAtNs < startedNs) {
      throw new Error(`${key} controller switch stamp predates timed release`);
    }
    return new Promise<SealedBlindProducerOutput>((resolveOutput, rejectOutput) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.lastElapsed = elapsedMs(pending.startedNs);
        this.pending.delete(key);
        rejectOutput(new Error(
          `${key} producer response timeout after ${this.manifest.responseTimeoutMs}ms`,
        ));
      }, this.manifest.responseTimeoutMs);
      this.pending.set(key, {
        startedNs,
        sourceSwitchedNs: switchedAtNs,
        resolve: resolveOutput,
        reject: rejectOutput,
        timer,
      });
      const release: BlindProducerReleaseRequest = {
        type: "release",
        schemaVersion: BLIND_SCHEMA_VERSION,
        profile: this.manifest.profile,
        experimentId: request.experimentId,
        caseId: request.caseId,
        side: request.side,
        runIndex: request.runIndex,
        releaseToken: revealed.releaseToken,
      };
      this.child!.stdin.write(`${canonicalJson(release)}\n`);
    });
  }

  lastElapsedMs(): number {
    return this.lastElapsed;
  }

  logs(): {
    readonly stdout: readonly string[];
    readonly stderr: readonly string[];
  } {
    return {
      stdout: this.stdoutLines,
      stderr: this.stderrLines,
    };
  }

  async close(): Promise<void> {
    await this.releaseRuntimePortReservations();
    const child = this.child;
    if (!child) return;
    if (!child.killed && child.exitCode === null) {
      this.closing = true;
      child.stdin.write(`${canonicalJson({ type: "close" })}\n`);
      child.stdin.end();
    }
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    writeOwnerOnly(
      resolve(
        this.outDir,
        `${this.side}-${this.caseId}-producer.stdout.log`,
      ),
      `${this.stdoutLines.join("\n")}\n`,
    );
    writeOwnerOnly(
      resolve(
        this.outDir,
        `${this.side}-${this.caseId}-producer.stderr.log`,
      ),
      `${this.stderrLines.join("\n")}\n`,
    );
    this.child = null;
  }

  private async releaseRuntimePortReservations(): Promise<void> {
    const lease = this.runtimePorts;
    if (!lease) return;
    await lease.release();
  }

  private acceptOutput(raw: string): void {
    let output: BlindProducerOutput;
    try {
      this.assertNoRuntimeSecret(raw);
      output = JSON.parse(raw) as BlindProducerOutput;
    } catch (error) {
      this.failAll(new Error(`${this.side} producer emitted invalid JSON: ${message(error)}`));
      return;
    }
    const key = runKey(output);
    const pending = this.pending.get(key);
    if (!pending) {
      this.failAll(new Error(`${this.side} producer emitted unexpected output ${key}`));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    this.lastElapsed = elapsedMs(pending.startedNs);
    try {
      if (output.side !== this.side) {
        throw new Error(`${key} came from ${this.side} producer`);
      }
      validateOutputUsesFrozenArtifacts(this.manifest, output);
      pending.resolve(sealProducerOutput(
        output,
        this.lastElapsed,
        pending.startedNs,
        pending.sourceSwitchedNs,
      ));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private acceptReady(raw: string): void {
    let ready: BlindProducerReady;
    try {
      ready = JSON.parse(raw) as BlindProducerReady;
    } catch (error) {
      this.failAll(new Error(`${this.side} producer emitted invalid ready JSON: ${message(error)}`));
      return;
    }
    const key = runKey(ready);
    const preparing = this.preparing.get(key);
    if (!preparing) {
      this.failAll(new Error(`${this.side} producer emitted unexpected ready ${key}`));
      return;
    }
    if (
      ready.type !== "base_ready" ||
      ready.schemaVersion !== BLIND_SCHEMA_VERSION ||
      ready.profile !== this.manifest.profile ||
      ready.experimentId !== this.manifest.experimentId ||
      (ready.caseId !== "primary" && ready.caseId !== "held-out") ||
      ready.side !== this.side
    ) {
      this.failAll(new Error(`${this.side} producer emitted invalid ready ${key}`));
      return;
    }
    clearTimeout(preparing.timer);
    this.preparing.delete(key);
    preparing.resolve();
  }

  private acceptRevealReady(raw: string): void {
    let ready: BlindProducerRevealReady;
    try {
      ready = JSON.parse(raw) as BlindProducerRevealReady;
    } catch (error) {
      this.failAll(new Error(
        `${this.side} producer emitted invalid reveal-ready JSON: ${message(error)}`,
      ));
      return;
    }
    const key = runKey(ready);
    const revealing = this.revealPreparing.get(key);
    if (!revealing) {
      this.failAll(new Error(
        `${this.side} producer emitted unexpected reveal-ready ${key}`,
      ));
      return;
    }
    if (
      ready.type !== "reveal_ready" ||
      ready.schemaVersion !== BLIND_SCHEMA_VERSION ||
      ready.profile !== this.manifest.profile ||
      ready.experimentId !== this.manifest.experimentId ||
      (ready.caseId !== "primary" && ready.caseId !== "held-out") ||
      ready.side !== this.side ||
      !/^[0-9a-f]{64}$/.test(ready.revealToken)
    ) {
      this.failAll(new Error(`${this.side} producer emitted invalid reveal-ready ${key}`));
      return;
    }
    clearTimeout(revealing.timer);
    this.revealPreparing.delete(key);
    revealing.resolve(ready);
  }

  private acceptSourceRevealed(raw: string): void {
    let revealed: BlindProducerSourceRevealed;
    try {
      revealed = JSON.parse(raw) as BlindProducerSourceRevealed;
    } catch (error) {
      this.failAll(new Error(
        `${this.side} producer emitted invalid source-revealed JSON: ${message(error)}`,
      ));
      return;
    }
    const key = runKey(revealed);
    const pending = this.sourceRevealing.get(key);
    if (!pending) {
      this.failAll(new Error(
        `${this.side} producer emitted unexpected source-revealed ${key}`,
      ));
      return;
    }
    if (
      revealed.type !== "source_revealed" ||
      revealed.schemaVersion !== BLIND_SCHEMA_VERSION ||
      revealed.profile !== this.manifest.profile ||
      revealed.experimentId !== this.manifest.experimentId ||
      (revealed.caseId !== "primary" &&
        revealed.caseId !== "held-out") ||
      revealed.side !== this.side ||
      !/^[0-9]+$/.test(revealed.switchedAtMonotonicNs) ||
      BigInt(revealed.switchedAtMonotonicNs) > process.hrtime.bigint() ||
      !/^[0-9a-f]{64}$/.test(revealed.releaseToken)
    ) {
      this.failAll(new Error(
        `${this.side} producer emitted invalid source-revealed ${key}`,
      ));
      return;
    }
    clearTimeout(pending.timer);
    this.sourceRevealing.delete(key);
    pending.resolve(revealed);
  }

  private failAll(error: Error): void {
    const redactedError = new Error(this.redact(error.message));
    this.exitError = redactedError;
    for (const preparing of this.preparing.values()) {
      clearTimeout(preparing.timer);
      preparing.reject(redactedError);
    }
    this.preparing.clear();
    for (const revealing of this.revealPreparing.values()) {
      clearTimeout(revealing.timer);
      revealing.reject(redactedError);
    }
    this.revealPreparing.clear();
    for (const revealing of this.sourceRevealing.values()) {
      clearTimeout(revealing.timer);
      revealing.reject(redactedError);
    }
    this.sourceRevealing.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.lastElapsed = elapsedMs(pending.startedNs);
      pending.reject(redactedError);
    }
    this.pending.clear();
  }

  private assertNoRuntimeSecret(value: string): void {
    for (const secret of this.secretValues.values()) {
      if (
        secretVariants(secret).some((variant) =>
          variant.length > 0 && value.includes(variant)
        )
      ) {
        throw new Error("producer output contains a trusted runtime secret");
      }
    }
  }

  private redact(value: string): string {
    let redacted = value;
    for (const [name, secret] of this.secretValues) {
      if (!secret) continue;
      for (const variant of secretVariants(secret)) {
        redacted = redacted.split(variant).join(`[REDACTED:${name}]`);
      }
    }
    return redacted;
  }
}

export interface BlindProducerRuntimePortLease {
  readonly ports: readonly number[];
  readonly env: Readonly<{
    SEARCHER_ANVIL_PORT: string;
    SEARCHER_BLOCKSCAN_ANVIL_PORT: string;
  }>;
  release(): Promise<void>;
}

/**
 * A/B production entries are long-lived concurrently. Their Anvil ports are
 * therefore trusted-runner leases, not semantic manifest configuration.
 * Reserve one ordinary-state port followed by a contiguous block-scan worker
 * range so `basePort + worker` in production main remains valid.
 */
export async function reserveBlindProducerRuntimePorts(
  blockScanWorkers: number,
): Promise<BlindProducerRuntimePortLease> {
  if (
    !Number.isSafeInteger(blockScanWorkers) ||
    blockScanWorkers <= 0 ||
    blockScanWorkers > 64
  ) {
    throw new Error("blind block-scan worker count must be in [1, 64]");
  }
  const servers = await reserveContiguousLoopbackPorts(blockScanWorkers + 1);
  const ports = Object.freeze(servers.map((entry) => entry.port));
  let released = false;
  return {
    ports,
    env: Object.freeze({
      SEARCHER_ANVIL_PORT: String(ports[0]),
      SEARCHER_BLOCKSCAN_ANVIL_PORT: String(ports[1]),
    }),
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await Promise.all(servers.map(({ server }) => closeNetServer(server)));
    },
  };
}

function blockScanWorkerCount(
  env: Readonly<Record<string, string>>,
): number {
  const raw = Number(env.SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY ?? "4");
  if (!Number.isSafeInteger(raw) || raw <= 0 || raw > 64) {
    throw new Error(
      "SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY must be an integer in [1, 64]",
    );
  }
  return raw;
}

async function reserveContiguousLoopbackPorts(
  count: number,
): Promise<readonly { readonly port: number; readonly server: NetServer }[]> {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const basePort = randomInt(20_000, 60_000 - count);
    const reserved: Array<{
      readonly port: number;
      readonly server: NetServer;
    }> = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        reserved.push(await reserveLoopbackPort(basePort + offset));
      }
      return reserved;
    } catch {
      await Promise.all(reserved.map(({ server }) => closeNetServer(server)));
    }
  }
  throw new Error(`unable to reserve ${count} contiguous blind Anvil ports`);
}

function reserveLoopbackPort(
  port: number,
): Promise<{ readonly port: number; readonly server: NetServer }> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", rejectPort);
      const address = server.address();
      if (!address || typeof address === "string") {
        void closeNetServer(server);
        rejectPort(new Error("blind Anvil port reservation has no TCP address"));
        return;
      }
      resolvePort({ port: address.port, server });
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function validateOutputUsesFrozenArtifacts(
  manifest: BlindRunManifest,
  output: BlindProducerOutput,
): void {
  const inputs = output.caseId === "primary"
    ? manifest.inputs
    : manifest.heldOut.inputs;
  const sourceDelta = readBlindProductionArtifact(
    inputs.sourceDelta.path,
    "source-delta",
  );
  if (
    sourceDelta.payload.anchorNumber !== output.source.number ||
    String(sourceDelta.payload.anchorHash).toLowerCase() !==
      output.source.hash.toLowerCase()
  ) {
    throw new Error("production output did not consume the frozen source delta anchor");
  }
  if (
    sourceDelta.payload.orderedCanonicalEdgeIdHash !==
      output.graph.orderedEdgeHash ||
    sourceDelta.payload.edgeCount !== output.graph.orderedEdgeIds.length
  ) {
    throw new Error(
      "production output graph does not match the consumed source delta artifact",
    );
  }
}

function verifyFrozenArtifacts(manifest: BlindRunManifest): void {
  readBlindProductionArtifact(
    manifest.inputs.resolvedConfig.path,
    "resolved-config",
  );
  readBlindProductionArtifact(
    manifest.inputs.universe.path,
    "production-universe",
  );
  readBlindProductionArtifact(
    manifest.inputs.activeFamilyManifest.path,
    "active-family-manifest",
  );
  readBlindProductionArtifact(
    manifest.inputs.baseGraphView.path,
    "base-graph-view",
  );
  readBlindProductionArtifact(
    manifest.inputs.sourceDelta.path,
    "source-delta",
  );
  const backendDeclarations = (
    ["baseline", "challenger"] as const
  ).flatMap((side) =>
    (["primary", "held-out"] as const).map((caseId) => ({
      side,
      caseId,
      declaration: validateBackendAttestationArtifact(
        manifest.producers[side].cases[caseId].backendIdentity.path,
      ),
    }))
  );
  const backendEndpoints = new Set<string>();
  const backendPids = new Set<number>();
  for (const entry of backendDeclarations) {
    if (
      backendEndpoints.has(entry.declaration.endpointSha256) ||
      backendPids.has(entry.declaration.localProcessPid)
    ) {
      throw new Error(
        `${entry.side}/${entry.caseId} reuses a backend process/cache`,
      );
    }
    backendEndpoints.add(entry.declaration.endpointSha256);
    backendPids.add(entry.declaration.localProcessPid);
  }
  for (const side of ["baseline", "challenger"] as const) {
    readAndVerifyBlindModuleClosure(
      manifest.producers[side].productionModuleClosure.path,
      manifest.producers[side].productionEntry.path,
    );
  }
  for (const binding of [
    ...Object.values(manifest.inputs),
    ...Object.values(manifest.heldOut.inputs),
    manifest.trusted.runner,
    manifest.trusted.oracleBuilder,
    manifest.trusted.comparator,
    manifest.trusted.backendController,
    manifest.trusted.anvilBinary,
    manifest.producers.baseline.productionEntry,
    manifest.producers.challenger.productionEntry,
    manifest.producers.baseline.productionModuleClosure,
    manifest.producers.challenger.productionModuleClosure,
    manifest.producers.baseline.producerHarness,
    manifest.producers.challenger.producerHarness,
    ...(["baseline", "challenger"] as const).flatMap((side) =>
      (["primary", "held-out"] as const).map(
        (caseId) => manifest.producers[side].cases[caseId].backendIdentity,
      )
    ),
  ]) {
    const path = isAbsolute(binding.path)
      ? binding.path
      : resolve(binding.path);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== binding.sha256) {
      throw new Error(`frozen artifact hash mismatch ${path}`);
    }
  }
}

function resolveRuntimeSecretEnv(
  references: readonly BlindRuntimeSecretRef[],
  allowlist: ReadonlySet<string>,
  runtimeEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const reference of references) {
    if (!allowlist.has(reference.envName)) {
      throw new Error(
        `trusted runtime secret ${reference.envName} is not allowlisted`,
      );
    }
    const value = runtimeEnv[reference.envName];
    if (!value) {
      throw new Error(
        `trusted runtime secret ${reference.envName} is unavailable`,
      );
    }
    const actual = createHash("sha256").update(value).digest("hex");
    if (actual !== reference.valueSha256) {
      throw new Error(
        `trusted runtime secret ${reference.envName} hash mismatch`,
      );
    }
    resolved[reference.envName] = value;
  }
  return resolved;
}

function secretVariants(value: string): readonly string[] {
  const variants = new Set([value]);
  const hex = value.match(/^(?:0x)?([0-9a-f]{64})$/i)?.[1];
  if (hex) {
    for (const body of [hex.toLowerCase(), hex.toUpperCase()]) {
      variants.add(body);
      variants.add(`0x${body}`);
      variants.add(`0X${body}`);
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}

function runKey(input: {
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
}): string {
  return `${input.caseId}:${input.side}:${input.runIndex}`;
}

function writeOwnerOnly(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeCombinedProducerLogs(
  outDir: string,
  sessions: Readonly<Record<
    BlindSide,
    Readonly<Record<BlindRunCaseId, ProducerSession>>
  >>,
): void {
  for (const side of ["baseline", "challenger"] as const) {
    for (const stream of ["stdout", "stderr"] as const) {
      const lines = (["primary", "held-out"] as const).flatMap((caseId) =>
        sessions[side][caseId].logs()[stream].map(
          (line) => `[${caseId}] ${line}`,
        )
      );
      writeOwnerOnly(
        resolve(outDir, `${side}-producer.${stream}.log`),
        `${lines.join("\n")}\n`,
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(args: readonly string[]): {
  manifestPath: string;
  outDir: string;
  secretEnvAllowlist: readonly string[];
} {
  let manifestPath = "";
  let outDir = "";
  let secretEnvAllowlist = parseSecretEnvAllowlist(
    process.env.BLIND_TRUSTED_SECRET_ENV_ALLOWLIST ?? "",
  );
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--manifest") manifestPath = value;
    else if (name === "--out") outDir = value;
    else if (name === "--secret-env-allowlist") {
      secretEnvAllowlist = parseSecretEnvAllowlist(value);
    }
    else throw new Error(`unknown argument ${name}`);
  }
  if (!manifestPath || !outDir) {
    throw new Error("usage: --manifest <blind-manifest.json> --out <artifact-dir>");
  }
  return { manifestPath, outDir, secretEnvAllowlist };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifestPath, "utf8")) as BlindRunManifest;
  const { report } = await runBlindSentinel(manifest, args.outDir, {
    secretEnvAllowlist: args.secretEnvAllowlist,
  });
  console.log(`BLIND_RUNNER_REPORT=${canonicalJson(report)}`);
  if (report.attempts.some((attempt) => attempt.status !== "sealed")) process.exitCode = 1;
}

function parseSecretEnvAllowlist(value: string): readonly string[] {
  if (!value.trim()) return [];
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (
    names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("trusted secret env allowlist is invalid");
  }
  return Object.freeze(names);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
