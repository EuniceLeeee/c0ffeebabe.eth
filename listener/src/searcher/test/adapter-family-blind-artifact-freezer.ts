import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  BLIND_PRODUCTION_CONTROL_PREFIX,
  BLIND_PRODUCTION_RAW_PREFIX,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_READY_PREFIX,
  blindProductionCanonicalJson,
  type BlindProductionPassRecord,
  type BlindProductionReadyRecord,
} from "../blind-production-audit.js";
import type {
  BlindProductionArtifactDocuments,
} from "../blind-production-artifacts.js";
import {
  BLIND_TX055_BASE_ANCHOR,
  BLIND_TX055_SOURCE_ANCHOR,
  BLIND_TX055_STRICT_PROFILE,
  canonicalJson,
  isBlindRunProfile,
  producerControllerUrl,
  sha256Canonical,
  validateProducerCommand,
  type BlindBlockAnchor,
  type BlindProducerCommand,
  type BlindRunCaseId,
  type BlindRunProfile,
  type BlindSide,
} from "./adapter-family-blind-contract.js";
import {
  assertAbsoluteOwnerOnly,
  fileSha256,
  readAndVerifyBlindModuleClosure,
  validateBackendAttestationArtifact,
  writeBlindProductionArtifactDocuments,
} from "./adapter-family-blind-artifacts.js";
import {
  createAttemptNonce,
  validateBackendEvidence,
  validateBackendRevealReadyEvidence,
  validateProductionPassRecordForFreeze,
  validateProductionReadyRecord,
  type BlindBackendFinishedEvidence,
  type BlindBackendPreparedEvidence,
  type BlindBackendRevealReadyEvidence,
  type BlindBackendRevealedEvidence,
  type BlindProductionPrepareControl,
  type BlindProductionSourceHeadControl,
} from "./adapter-family-blind-production-raw.js";
import {
  reserveBlindProducerRuntimePorts,
  type BlindProducerRuntimePortLease,
} from "./adapter-family-blind-runner.js";

export const BLIND_ARTIFACT_FREEZER_PROFILE =
  "adapter-family-blind-artifact-freezer-v1" as const;
export const BLIND_ARTIFACT_BOOTSTRAP_PROFILE =
  "adapter-family-blind-artifact-bootstrap-v1" as const;

export interface BlindArtifactFreezerSessionSpec {
  readonly command: BlindProducerCommand;
  readonly backendIdentityPath: string;
}

export interface BlindArtifactFreezerSpec {
  readonly schemaVersion: 1;
  readonly profile: typeof BLIND_ARTIFACT_FREEZER_PROFILE;
  readonly runProfile: BlindRunProfile;
  /** Liveness bound only; artifact capture is deliberately not benchmarked. */
  readonly captureTimeoutMs: number;
  readonly primary: {
    readonly base: BlindBlockAnchor;
    readonly source: BlindBlockAnchor;
  };
  readonly heldOut: {
    readonly base: BlindBlockAnchor;
    readonly source: BlindBlockAnchor;
  };
  readonly producers: Readonly<Record<BlindSide, {
    readonly productionEntryPath: string;
    readonly productionModuleClosurePath: string;
    readonly cases: Readonly<
      Record<BlindRunCaseId, BlindArtifactFreezerSessionSpec>
    >;
  }>>;
}

export interface BlindArtifactBootstrap {
  readonly schemaVersion: 1;
  readonly profile: typeof BLIND_ARTIFACT_BOOTSTRAP_PROFILE;
  readonly runProfile: BlindRunProfile;
  readonly untimed: true;
  readonly manifestDraftInputPaths: {
    readonly resolvedConfigPath: string;
    readonly universePath: string;
    readonly activeFamilyManifestPath: string;
    readonly baseGraphViewPath: string;
    readonly sourceDeltaPath: string;
    readonly heldOut: {
      readonly resolvedConfigPath: string;
      readonly universePath: string;
      readonly activeFamilyManifestPath: string;
      readonly baseGraphViewPath: string;
      readonly sourceDeltaPath: string;
    };
  };
  readonly captures: Readonly<Record<BlindSide, Readonly<
    Record<BlindRunCaseId, {
      readonly productionEntrySha256: string;
      readonly productionModuleClosureSha256: string;
      readonly controllerEndpointSha256: string;
      readonly backendIdentityPath: string;
      readonly backendIdentitySha256: string;
      readonly readyRecordSha256: string;
      readonly sourceRecordSha256: string;
      readonly artifactDocumentsSha256: string;
    }>
  >>>;
}

export interface BlindArtifactFreezerRuntimeOptions {
  readonly secretEnvAllowlist?: readonly string[];
  readonly runtimeEnv?: Readonly<Record<string, string | undefined>>;
}

interface CapturedSession {
  readonly ready: BlindProductionReadyRecord;
  readonly source: BlindProductionPassRecord;
  readonly documents: BlindProductionArtifactDocuments;
  readonly evidence: BlindArtifactBootstrap["captures"][BlindSide][BlindRunCaseId];
}

export async function freezeBlindProductionArtifacts(
  spec: BlindArtifactFreezerSpec,
  outDir: string,
  runtime: BlindArtifactFreezerRuntimeOptions = {},
): Promise<BlindArtifactBootstrap> {
  validateFreezerSpec(spec);
  if (!isAbsolute(outDir)) {
    throw new Error("blind artifact freezer output directory must be absolute");
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);

  const captures = {
    baseline: {} as Record<BlindRunCaseId, CapturedSession>,
    challenger: {} as Record<BlindRunCaseId, CapturedSession>,
  };
  for (const caseId of ["primary", "held-out"] as const) {
    for (const side of ["baseline", "challenger"] as const) {
      captures[side][caseId] = await captureSession(
        spec,
        side,
        caseId,
        runtime,
      );
    }
    const baselineHash = sha256Canonical(
      captures.baseline[caseId].documents,
    );
    const challengerHash = sha256Canonical(
      captures.challenger[caseId].documents,
    );
    if (baselineHash !== challengerHash) {
      throw new Error(
        `${caseId} baseline/challenger semantic artifact inputs differ`,
      );
    }
  }

  const primaryPaths = writeBlindProductionArtifactDocuments(
    resolve(outDir, "primary"),
    captures.baseline.primary.documents,
  );
  const heldOutPaths = writeBlindProductionArtifactDocuments(
    resolve(outDir, "held-out"),
    captures.baseline["held-out"].documents,
  );
  const bootstrap: BlindArtifactBootstrap = Object.freeze({
    schemaVersion: 1,
    profile: BLIND_ARTIFACT_BOOTSTRAP_PROFILE,
    runProfile: spec.runProfile,
    untimed: true,
    manifestDraftInputPaths: {
      resolvedConfigPath: primaryPaths["resolved-config"],
      universePath: primaryPaths["production-universe"],
      activeFamilyManifestPath: primaryPaths["active-family-manifest"],
      baseGraphViewPath: primaryPaths["base-graph-view"],
      sourceDeltaPath: primaryPaths["source-delta"],
      heldOut: {
        resolvedConfigPath: heldOutPaths["resolved-config"],
        universePath: heldOutPaths["production-universe"],
        activeFamilyManifestPath: heldOutPaths["active-family-manifest"],
        baseGraphViewPath: heldOutPaths["base-graph-view"],
        sourceDeltaPath: heldOutPaths["source-delta"],
      },
    },
    captures: {
      baseline: {
        primary: captures.baseline.primary.evidence,
        "held-out": captures.baseline["held-out"].evidence,
      },
      challenger: {
        primary: captures.challenger.primary.evidence,
        "held-out": captures.challenger["held-out"].evidence,
      },
    },
  });
  writeOwnerOnly(
    resolve(outDir, "artifact-bootstrap.json"),
    `${canonicalJson(bootstrap)}\n`,
  );
  return bootstrap;
}

async function captureSession(
  spec: BlindArtifactFreezerSpec,
  side: BlindSide,
  caseId: BlindRunCaseId,
  runtime: BlindArtifactFreezerRuntimeOptions,
): Promise<CapturedSession> {
  const producer = spec.producers[side];
  const session = producer.cases[caseId];
  const anchors = caseId === "primary" ? spec.primary : spec.heldOut;
  const controllerUrl = producerControllerUrl(session.command);
  const backendIdentitySha256 = fileSha256(session.backendIdentityPath);
  const attemptNonce = createAttemptNonce();
  const prepareControl: BlindProductionPrepareControl = {
    type: "prepare",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    base: anchors.base,
  };
  const sourceControl: BlindProductionSourceHeadControl = {
    type: "source_head",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    source: anchors.source,
  };
  const portLease = await reserveBlindProducerRuntimePorts(
    blockScanWorkerCount(session.command.env),
  );
  const child = new RawProductionCapture(
    session.command,
    producer.productionEntryPath,
    spec.captureTimeoutMs,
    portLease,
    resolveSecrets(session.command, runtime),
  );
  try {
    await child.start();
    const prepared = await callController<BlindBackendPreparedEvidence>(
      controllerUrl,
      {
        ...prepareControl,
        source: anchors.source,
        backendIdentitySha256,
      },
      spec.captureTimeoutMs,
    );
    const readyPromise = child.nextReady();
    child.writeControl(prepareControl);
    const ready = await readyPromise;
    validateProductionReadyRecord(ready, prepareControl);

    const revealReady =
      await callController<BlindBackendRevealReadyEvidence>(
        controllerUrl,
        {
          type: "reveal_request",
          profile: BLIND_PRODUCTION_RAW_PROFILE,
          attemptNonce,
          source: anchors.source,
          cleanForkId: prepared.cleanForkId,
        },
        spec.captureTimeoutMs,
      );
    validateBackendRevealReadyEvidence(
      revealReady,
      attemptNonce,
      prepared,
    );
    const revealed = await callController<BlindBackendRevealedEvidence>(
      controllerUrl,
      {
        type: "release",
        profile: BLIND_PRODUCTION_RAW_PROFILE,
        attemptNonce,
        cleanForkId: prepared.cleanForkId,
        revealToken: revealReady.revealToken,
      },
      spec.captureTimeoutMs,
    );
    const sourcePromise = child.nextSource();
    child.writeControl(sourceControl);
    const source = await sourcePromise;
    const finished = await callController<BlindBackendFinishedEvidence>(
      controllerUrl,
      {
        type: "finish",
        profile: BLIND_PRODUCTION_RAW_PROFILE,
        attemptNonce,
        cleanForkId: prepared.cleanForkId,
      },
      spec.captureTimeoutMs,
    );
    validateBackendEvidence(
      {
        backendIdentitySha256,
        base: anchors.base,
        source: anchors.source,
      },
      attemptNonce,
      prepared,
      revealed,
      finished,
    );
    validateProductionPassRecordForFreeze(source, ready, sourceControl);
    return {
      ready,
      source,
      documents: source.artifactDocuments,
      evidence: {
        productionEntrySha256: fileSha256(producer.productionEntryPath),
        productionModuleClosureSha256:
          fileSha256(producer.productionModuleClosurePath),
        controllerEndpointSha256: sha256(controllerUrl),
        backendIdentityPath: session.backendIdentityPath,
        backendIdentitySha256,
        readyRecordSha256: sha256Canonical(ready),
        sourceRecordSha256: sha256Canonical(source),
        artifactDocumentsSha256: sha256Canonical(source.artifactDocuments),
      },
    };
  } finally {
    await child.close();
  }
}

class RawProductionCapture {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyWaiter: RecordWaiter<BlindProductionReadyRecord> | null = null;
  private sourceWaiter: RecordWaiter<BlindProductionPassRecord> | null = null;
  private readonly stderr: string[] = [];
  private exitError: Error | null = null;

  constructor(
    private readonly command: BlindProducerCommand,
    private readonly productionEntryPath: string,
    private readonly timeoutMs: number,
    private readonly portLease: BlindProducerRuntimePortLease,
    private readonly secretEnv: Readonly<Record<string, string>>,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command.executable, [...this.command.argv], {
      cwd: this.command.cwd,
      env: {
        ...this.command.env,
        ...this.secretEnv,
        ...this.portLease.env,
        BLIND_SENTINEL_MODE: "1",
        SEARCHER_TEST_DISABLE_DOTENV: "1",
        SEARCHER_BLIND_RAW_AUDIT: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(
        `artifact freezer producer exited before capture completed ` +
          `entry=${this.productionEntryPath} code=${String(code)} ` +
          `signal=${String(signal)}`,
      ));
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.startsWith(BLIND_PRODUCTION_READY_PREFIX)) {
        this.acceptReady(line.slice(BLIND_PRODUCTION_READY_PREFIX.length));
      } else if (line.startsWith(BLIND_PRODUCTION_RAW_PREFIX)) {
        this.acceptSource(line.slice(BLIND_PRODUCTION_RAW_PREFIX.length));
      }
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      if (this.stderr.length < 100) this.stderr.push(line);
    });
    await new Promise<void>((resolveStarted) => setImmediate(resolveStarted));
    await this.portLease.release();
    if (this.exitError) throw this.exitError;
  }

  nextReady(): Promise<BlindProductionReadyRecord> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.readyWaiter) {
      throw new Error("artifact freezer already waits for READY");
    }
    return new Promise((resolveRecord, rejectRecord) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        rejectRecord(this.timeoutError("READY"));
      }, this.timeoutMs);
      this.readyWaiter = { resolve: resolveRecord, reject: rejectRecord, timer };
    });
  }

  nextSource(): Promise<BlindProductionPassRecord> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.sourceWaiter) {
      throw new Error("artifact freezer already waits for source record");
    }
    return new Promise((resolveRecord, rejectRecord) => {
      const timer = setTimeout(() => {
        this.sourceWaiter = null;
        rejectRecord(this.timeoutError("source"));
      }, this.timeoutMs);
      this.sourceWaiter = { resolve: resolveRecord, reject: rejectRecord, timer };
    });
  }

  writeControl(control: object): void {
    if (!this.child || this.exitError) {
      throw this.exitError ?? new Error("artifact freezer producer is absent");
    }
    this.child.stdin.write(
      `${BLIND_PRODUCTION_CONTROL_PREFIX}${canonicalJson(control)}\n`,
    );
  }

  async close(): Promise<void> {
    await this.portLease.release();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit())
      ),
      new Promise<void>((resolveTimeout) =>
        setTimeout(resolveTimeout, 2_000)
      ),
    ]);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }

  private acceptReady(raw: string): void {
    const waiter = this.readyWaiter;
    if (!waiter) {
      this.fail(new Error("producer emitted unsolicited/duplicate READY"));
      return;
    }
    try {
      const record = JSON.parse(raw) as BlindProductionReadyRecord;
      clearTimeout(waiter.timer);
      this.readyWaiter = null;
      waiter.resolve(record);
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private acceptSource(raw: string): void {
    const waiter = this.sourceWaiter;
    if (!waiter) {
      this.fail(new Error("producer emitted source record before trusted release"));
      return;
    }
    try {
      const record = JSON.parse(raw) as BlindProductionPassRecord;
      clearTimeout(waiter.timer);
      this.sourceWaiter = null;
      waiter.resolve(record);
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private fail(error: Error): void {
    if (!this.exitError) this.exitError = error;
    for (const waiter of [this.readyWaiter, this.sourceWaiter]) {
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiter = null;
    this.sourceWaiter = null;
  }

  private timeoutError(phase: string): Error {
    const suffix = this.stderr.length > 0
      ? ` stderr=${this.stderr.join(" | ").slice(0, 1_000)}`
      : "";
    return new Error(
      `artifact freezer ${phase} timeout after ${this.timeoutMs}ms${suffix}`,
    );
  }
}

interface RecordWaiter<T> {
  readonly resolve: (record: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function validateFreezerSpec(spec: BlindArtifactFreezerSpec): void {
  assertExactKeys(spec, [
    "captureTimeoutMs",
    "heldOut",
    "primary",
    "producers",
    "profile",
    "runProfile",
    "schemaVersion",
  ], "artifact freezer spec");
  if (
    spec.schemaVersion !== 1 ||
    spec.profile !== BLIND_ARTIFACT_FREEZER_PROFILE ||
    !isBlindRunProfile(spec.runProfile) ||
    !Number.isSafeInteger(spec.captureTimeoutMs) ||
    spec.captureTimeoutMs <= 0
  ) {
    throw new Error("artifact freezer spec schema is invalid");
  }
  validateCaseAnchors("primary", spec.primary);
  validateCaseAnchors("held-out", spec.heldOut);
  if (
    sameAnchor(spec.primary.base, spec.heldOut.base) &&
    sameAnchor(spec.primary.source, spec.heldOut.source)
  ) {
    throw new Error("artifact freezer held-out pair must differ");
  }
  if (spec.runProfile === BLIND_TX055_STRICT_PROFILE) {
    if (
      !sameAnchor(spec.primary.base, BLIND_TX055_BASE_ANCHOR) ||
      !sameAnchor(spec.primary.source, BLIND_TX055_SOURCE_ANCHOR)
    ) {
      throw new Error("tx055 freezer profile anchor mismatch");
    }
  }
  const controllerUrls = new Set<string>();
  const backendPaths = new Set<string>();
  const backendHashes = new Set<string>();
  const backendEndpoints = new Set<string>();
  const backendPids = new Set<number>();
  assertExactKeys(
    spec.producers,
    ["baseline", "challenger"],
    "artifact freezer producers",
  );
  for (const side of ["baseline", "challenger"] as const) {
    const producer = spec.producers[side];
    if (!producer) throw new Error(`artifact freezer missing ${side}`);
    assertExactKeys(producer, [
      "cases",
      "productionEntryPath",
      "productionModuleClosurePath",
    ], `${side} producer`);
    if (
      !isAbsolute(producer.productionEntryPath) ||
      !isAbsolute(producer.productionModuleClosurePath)
    ) {
      throw new Error(`${side} producer paths must be absolute`);
    }
    readAndVerifyBlindModuleClosure(
      producer.productionModuleClosurePath,
      producer.productionEntryPath,
    );
    assertExactKeys(
      producer.cases,
      ["held-out", "primary"],
      `${side} producer cases`,
    );
    for (const caseId of ["primary", "held-out"] as const) {
      const session = producer.cases[caseId];
      if (!session) throw new Error(`artifact freezer missing ${side}/${caseId}`);
      assertExactKeys(
        session,
        ["backendIdentityPath", "command"],
        `${side}/${caseId} session`,
      );
      assertExactKeys(
        session.command,
        [
          "argv",
          "cwd",
          "env",
          "executable",
          ...(session.command.secretEnvRefs ? ["secretEnvRefs"] : []),
        ],
        `${side}/${caseId} command`,
      );
      for (const reference of session.command.secretEnvRefs ?? []) {
        assertExactKeys(
          reference,
          ["envName", "valueSha256"],
          `${side}/${caseId} secret reference`,
        );
      }
      validateProducerCommand(session.command);
      if (!session.command.argv.includes(producer.productionEntryPath)) {
        throw new Error(
          `${side}/${caseId} command must execute its frozen production entry`,
        );
      }
      const controllerUrl = producerControllerUrl(session.command);
      const backend = validateBackendAttestationArtifact(
        session.backendIdentityPath,
      );
      const backendHash = fileSha256(session.backendIdentityPath);
      if (
        controllerUrls.has(controllerUrl) ||
        backendPaths.has(session.backendIdentityPath) ||
        backendHashes.has(backendHash) ||
        backendEndpoints.has(backend.endpointSha256) ||
        backendPids.has(backend.localProcessPid)
      ) {
        throw new Error(
          `${side}/${caseId} must own an independent controller/backend`,
        );
      }
      controllerUrls.add(controllerUrl);
      backendPaths.add(session.backendIdentityPath);
      backendHashes.add(backendHash);
      backendEndpoints.add(backend.endpointSha256);
      backendPids.add(backend.localProcessPid);
    }
  }
}

function validateCaseAnchors(
  label: string,
  value: {
    readonly base: BlindBlockAnchor;
    readonly source: BlindBlockAnchor;
  },
): void {
  assertExactKeys(value, ["base", "source"], `${label} anchors`);
  validateAnchor(`${label} base`, value.base);
  validateAnchor(`${label} source`, value.source);
  if (value.base.number + 1 !== value.source.number) {
    throw new Error(`${label} freezer anchors must be adjacent`);
  }
}

function validateAnchor(label: string, anchor: BlindBlockAnchor): void {
  assertExactKeys(anchor, ["hash", "number", "stateRoot"], label);
  if (
    !Number.isSafeInteger(anchor.number) ||
    anchor.number < 0 ||
    !isHash(anchor.hash) ||
    !isHash(anchor.stateRoot)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

async function callController<T>(
  url: string,
  body: object,
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `artifact freezer controller HTTP ${response.status}: ` +
        `${(await response.text()).slice(0, 1_000)}`,
    );
  }
  return await response.json() as T;
}

function resolveSecrets(
  command: BlindProducerCommand,
  runtime: BlindArtifactFreezerRuntimeOptions,
): Record<string, string> {
  const allowlist = new Set(runtime.secretEnvAllowlist ?? []);
  const environment = runtime.runtimeEnv ?? process.env;
  const result: Record<string, string> = {};
  for (const reference of command.secretEnvRefs ?? []) {
    if (!allowlist.has(reference.envName)) {
      throw new Error(
        `artifact freezer secret ${reference.envName} is not allowlisted`,
      );
    }
    const value = environment[reference.envName];
    if (!value) {
      throw new Error(
        `artifact freezer secret ${reference.envName} is unavailable`,
      );
    }
    if (sha256(value) !== reference.valueSha256) {
      throw new Error(
        `artifact freezer secret ${reference.envName} hash mismatch`,
      );
    }
    result[reference.envName] = value;
  }
  return result;
}

function blockScanWorkerCount(env: Readonly<Record<string, string>>): number {
  const parsed = Number.parseInt(
    env.SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY ?? "4",
    10,
  );
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(32, parsed)
    : 4;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function sameAnchor(left: BlindBlockAnchor, right: BlindBlockAnchor): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.stateRoot.toLowerCase() === right.stateRoot.toLowerCase();
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^(?:0x)?[0-9a-f]{64}$/i.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeOwnerOnly(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readFreezerSpec(path: string): BlindArtifactFreezerSpec {
  assertAbsoluteOwnerOnly(path);
  const raw = readFileSync(path, "utf8");
  const spec = JSON.parse(raw) as BlindArtifactFreezerSpec;
  if (raw !== `${blindProductionCanonicalJson(spec)}\n`) {
    throw new Error("artifact freezer spec must be canonical JSON");
  }
  return spec;
}

function parseArgs(args: readonly string[]): {
  readonly specPath: string;
  readonly outDir: string;
  readonly secretEnvAllowlist: readonly string[];
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error(`${name ?? "argument"} requires a value`);
    values.set(name, value);
  }
  const specPath = values.get("--spec");
  const outDir = values.get("--out");
  if (!specPath || !outDir) {
    throw new Error(
      "usage: --spec <owner-only-canonical.json> --out <absolute-dir> " +
        "[--secret-env-allowlist NAME,NAME]",
    );
  }
  return {
    specPath,
    outDir,
    secretEnvAllowlist: (values.get("--secret-env-allowlist") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bootstrap = await freezeBlindProductionArtifacts(
    readFreezerSpec(args.specPath),
    args.outDir,
    { secretEnvAllowlist: args.secretEnvAllowlist },
  );
  process.stdout.write(
    `BLIND_ARTIFACT_BOOTSTRAP=${canonicalJson(bootstrap)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${asError(error).message}\n`);
    process.exitCode = 1;
  });
}
