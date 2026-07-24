import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  BLIND_PRODUCTION_RAW_PROFILE,
  type BlindBackendFinishedEvidence,
  type BlindBackendPreparedEvidence,
  type BlindBackendRevealReadyEvidence,
  type BlindBackendRevealedEvidence,
  type BlindLocalUpstreamKind,
} from "./adapter-family-blind-production-raw.js";
import { canonicalJson } from "./adapter-family-blind-contract.js";
import {
  loadBlindHistoricalRpcCache,
  type LoadedBlindHistoricalRpcCache,
} from "./adapter-family-blind-content-addressed-rpc.js";

const READY_PREFIX = "BLIND_BACKEND_CONTROLLER_READY=";

interface BlockAnchor {
  readonly number: number;
  readonly hash: string;
  readonly stateRoot: string;
}

interface PrepareRequest {
  readonly type: "prepare";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly base: BlockAnchor;
  readonly source: BlockAnchor;
  readonly backendIdentitySha256: string;
}

interface RevealRequest {
  readonly type: "reveal_request";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly source: BlockAnchor;
  readonly cleanForkId: string;
}

interface RevealReleaseRequest {
  readonly type: "release";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly cleanForkId: string;
  readonly revealToken: string;
}

interface FinishRequest {
  readonly type: "finish";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly cleanForkId: string;
}

type ControlRequest =
  | PrepareRequest
  | RevealRequest
  | RevealReleaseRequest
  | FinishRequest;
type ForkLane = "base" | "source";

interface LocalFork {
  readonly lane: ForkLane;
  readonly rpcUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
}

interface BackendAttempt {
  readonly request: PrepareRequest;
  readonly cleanForkId: string;
  /** Internal Anvil-to-upstream lease; never exposed to the producer. */
  readonly upstreamLease: string;
  phase: "preparing" | "prepared" | "reveal_ready" | "revealed";
  revealToken: string | null;
  activeLane: ForkLane;
  forks: Readonly<Record<ForkLane, LocalFork>> | null;
  inFlightRpc: number;
  loopbackRpcCalls: number;
  nonLoopbackUpstreamRpcCalls: number;
  frozenCacheMissesAtPrepared: number | null;
}

export interface BlindBackendAttestation {
  readonly schemaVersion: 1;
  readonly profile: "adapter-family-blind-local-backend-attestation-v1";
  readonly upstreamKind: BlindLocalUpstreamKind;
  readonly endpointSha256: string;
  readonly attestationMode: "trusted-file-hmac-sha256";
  readonly localProcessPid: number;
  readonly frozenManifestSha256?: string;
  readonly issuerHmacSha256: string;
}

export interface LoadedBackendAttestation {
  readonly declaration: BlindBackendAttestation;
  readonly sha256: string;
}

export class BlindBackendController {
  private readonly server: Server;
  private origin = "";
  private attempt: BackendAttempt | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly listenHost: string,
    private readonly listenPort: number,
    private readonly upstreamRpcUrl: string,
    private readonly backendAttestation: LoadedBackendAttestation,
    private readonly anvilBin: string,
    private readonly startupTimeoutMs: number,
    private readonly frozenRpcCache: LoadedBlindHistoricalRpcCache | null = null,
  ) {
    assertLoopbackUrl(upstreamRpcUrl, "upstream RPC");
    assert(
      backendAttestation.declaration.endpointSha256 === sha256(upstreamRpcUrl),
      "backend attestation endpoint mismatch",
    );
    assert(isAbsolute(anvilBin), "anvil executable must be absolute");
    const contentAddressed =
      backendAttestation.declaration.upstreamKind ===
        "local-content-addressed-state";
    assert(
      contentAddressed === Boolean(frozenRpcCache),
      contentAddressed
        ? "content-addressed backend requires a frozen RPC manifest"
        : "frozen RPC manifest is only valid for content-addressed backend",
    );
    if (frozenRpcCache) {
      assert(
        backendAttestation.declaration.frozenManifestSha256 ===
          frozenRpcCache.manifestSha256,
        "backend attestation frozen manifest mismatch",
      );
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy(asError(error));
          return;
        }
        replyError(response, 500, asError(error).message);
      });
    });
  }

  async start(): Promise<{
    readonly controlUrl: string;
    readonly rpcUrl: string;
  }> {
    if (this.frozenRpcCache) {
      await assertFrozenRpcEndpoint(
        this.upstreamRpcUrl,
        this.frozenRpcCache,
        this.startupTimeoutMs,
      );
    }
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(this.listenPort, this.listenHost, () => resolveListen());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("blind backend controller did not bind TCP");
    }
    this.origin = `http://${formatHost(this.listenHost)}:${address.port}`;
    return {
      controlUrl: `${this.origin}/control`,
      rpcUrl: `${this.origin}/rpc`,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const current = this.attempt;
    this.attempt = null;
    if (current?.forks) {
      this.cleanup = Promise.all([
        stopFork(current.forks.base),
        stopFork(current.forks.source),
      ]).then(() => undefined);
    }
    await this.cleanup;
    await new Promise<void>((resolveClose) => {
      if (!this.server.listening) {
        resolveClose();
        return;
      }
      this.server.close(() => resolveClose());
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin || "http://127.0.0.1");
    if (url.pathname === "/health" && request.method === "GET") {
      replyJson(response, 200, {
        ok: true,
        active: this.attempt?.phase ?? null,
      });
      return;
    }
    if (request.method !== "POST") {
      replyError(response, 405, "POST required");
      return;
    }
    if (url.pathname === "/control") {
      const body = JSON.parse(await readBody(request)) as unknown;
      try {
        replyJson(response, 200, await this.control(body));
      } catch (error) {
        replyError(response, 400, asError(error).message);
      }
      return;
    }
    if (url.pathname === "/rpc") {
      await this.proxyProductionRpc(request, response);
      return;
    }
    const upstreamMatch = url.pathname.match(
      /^\/upstream\/([0-9a-f]{64})\/(base|source)$/,
    );
    if (upstreamMatch) {
      await this.proxyForkUpstream(
        request,
        response,
        upstreamMatch[1]!,
        upstreamMatch[2]! as ForkLane,
      );
      return;
    }
    replyError(response, 404, "unknown blind backend controller path");
  }

  private async control(body: unknown): Promise<
    | BlindBackendPreparedEvidence
    | BlindBackendRevealReadyEvidence
    | BlindBackendRevealedEvidence
    | BlindBackendFinishedEvidence
  > {
    const request = validateControlRequest(body);
    if (request.type === "prepare") return await this.prepare(request);
    if (request.type === "reveal_request") return this.prepareReveal(request);
    if (request.type === "release") return await this.releaseReveal(request);
    return await this.finish(request);
  }

  private async prepare(
    request: PrepareRequest,
  ): Promise<BlindBackendPreparedEvidence> {
    await this.cleanup;
    if (this.closing) throw new Error("blind backend controller is closing");
    if (this.attempt) throw new Error("blind backend controller attempt overlaps");
    assert(
      request.backendIdentitySha256 === this.backendAttestation.sha256,
      "backend identity does not match trusted attestation",
    );
    let frozenStatsBefore: FrozenRpcStats | null = null;
    if (this.frozenRpcCache) {
      assertSameAnchor(
        "frozen cache base",
        this.frozenRpcCache.manifest.base,
        request.base,
      );
      assertSameAnchor(
        "frozen cache source",
        this.frozenRpcCache.manifest.source,
        request.source,
      );
      frozenStatsBefore = await readFrozenRpcStats(
        this.upstreamRpcUrl,
        this.frozenRpcCache.manifestSha256,
        this.startupTimeoutMs,
      );
      assert(
        frozenStatsBefore.misses === 0,
        "frozen historical cache was already tainted by a cache miss",
      );
    }
    const attempt: BackendAttempt = {
      request,
      cleanForkId: randomBytes(32).toString("hex"),
      upstreamLease: randomBytes(32).toString("hex"),
      phase: "preparing",
      revealToken: null,
      activeLane: "base",
      forks: null,
      inFlightRpc: 0,
      loopbackRpcCalls: 0,
      nonLoopbackUpstreamRpcCalls: 0,
      frozenCacheMissesAtPrepared: null,
    };
    this.attempt = attempt;
    let baseFork: LocalFork | null = null;
    let sourceFork: LocalFork | null = null;
    try {
      baseFork = await this.startFork(attempt, "base", request.base);
      sourceFork = await this.startFork(attempt, "source", request.source);
      attempt.forks = { base: baseFork, source: sourceFork };
      if (this.frozenRpcCache && frozenStatsBefore) {
        const frozenStatsAfter = await readFrozenRpcStats(
          this.upstreamRpcUrl,
          this.frozenRpcCache.manifestSha256,
          this.startupTimeoutMs,
        );
        assert(
          frozenStatsAfter.misses === frozenStatsBefore.misses,
          "frozen historical cache missed while preparing clean forks",
        );
        attempt.frozenCacheMissesAtPrepared = frozenStatsAfter.misses;
      }
      attempt.phase = "prepared";
      return {
        type: "base_ready",
        profile: BLIND_PRODUCTION_RAW_PROFILE,
        attemptNonce: request.attemptNonce,
        backendIdentitySha256: request.backendIdentitySha256,
        backendAttestationSha256: this.backendAttestation.sha256,
        upstreamKind: this.backendAttestation.declaration.upstreamKind,
        cleanForkId: attempt.cleanForkId,
        basePreStateRoot: request.base.stateRoot,
      };
    } catch (error) {
      if (this.attempt === attempt) this.attempt = null;
      await Promise.all([
        ...(baseFork ? [stopFork(baseFork)] : []),
        ...(sourceFork ? [stopFork(sourceFork)] : []),
      ]);
      throw error;
    }
  }

  private prepareReveal(
    request: RevealRequest,
  ): BlindBackendRevealReadyEvidence {
    const attempt = this.requireAttempt(
      request.attemptNonce,
      request.cleanForkId,
    );
    assert(attempt.phase === "prepared", "source backend is not prepared");
    assertSameAnchor("source backend", request.source, attempt.request.source);
    const revealToken = randomBytes(32).toString("hex");
    attempt.revealToken = revealToken;
    attempt.phase = "reveal_ready";
    return {
      type: "reveal_ready",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: request.attemptNonce,
      cleanForkId: attempt.cleanForkId,
      revealToken,
    };
  }

  private async releaseReveal(
    request: RevealReleaseRequest,
  ): Promise<BlindBackendRevealedEvidence> {
    const attempt = this.requireAttempt(
      request.attemptNonce,
      request.cleanForkId,
    );
    assert(attempt.phase === "reveal_ready", "source reveal is not ready");
    assert(
      request.revealToken === attempt.revealToken,
      "source reveal token mismatch",
    );
    const deadline = Date.now() + this.startupTimeoutMs;
    while (attempt.inFlightRpc > 0) {
      if (Date.now() >= deadline) {
        throw new Error("base backend still has in-flight RPC during reveal");
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1));
    }
    // This is the sole atomic switch. The preceding reveal_request only
    // establishes a one-use release token, so /rpc remains base until here.
    attempt.activeLane = "source";
    const switchedAtMonotonicNs = process.hrtime.bigint().toString();
    attempt.phase = "revealed";
    attempt.revealToken = null;
    return {
      type: "source_revealed",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: request.attemptNonce,
      cleanForkId: attempt.cleanForkId,
      switchedAtMonotonicNs,
      source: attempt.request.source,
    };
  }

  private async finish(
    request: FinishRequest,
  ): Promise<BlindBackendFinishedEvidence> {
    const attempt = this.requireAttempt(
      request.attemptNonce,
      request.cleanForkId,
    );
    assert(attempt.phase === "revealed", "source backend was not revealed");
    assert(attempt.inFlightRpc === 0, "timed RPC remains in flight at finish");
    if (this.frozenRpcCache) {
      const stats = await readFrozenRpcStats(
        this.upstreamRpcUrl,
        this.frozenRpcCache.manifestSha256,
        this.startupTimeoutMs,
      );
      assert(
        attempt.frozenCacheMissesAtPrepared !== null &&
          stats.misses === attempt.frozenCacheMissesAtPrepared,
        "frozen historical cache missed during the measured run",
      );
    }
    const result: BlindBackendFinishedEvidence = {
      type: "finished",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: request.attemptNonce,
      cleanForkId: attempt.cleanForkId,
      loopbackRpcCalls: attempt.loopbackRpcCalls,
      nonLoopbackUpstreamRpcCalls: attempt.nonLoopbackUpstreamRpcCalls,
    };
    this.attempt = null;
    if (attempt.forks) {
      // Cleanup is deliberately outside the producer timing window. The next
      // untimed prepare waits for this promise before allocating fresh forks.
      this.cleanup = Promise.all([
        stopFork(attempt.forks.base),
        stopFork(attempt.forks.source),
      ]).then(() => undefined);
    }
    return result;
  }

  private requireAttempt(
    attemptNonce: string,
    cleanForkId: string,
  ): BackendAttempt {
    const attempt = this.attempt;
    assert(attempt, "blind backend attempt is missing");
    assert(attempt.request.attemptNonce === attemptNonce, "backend attempt nonce mismatch");
    assert(attempt.cleanForkId === cleanForkId, "backend clean fork mismatch");
    assert(attempt.forks, "backend forks are not ready");
    return attempt;
  }

  private async startFork(
    attempt: BackendAttempt,
    lane: ForkLane,
    anchor: BlockAnchor,
  ): Promise<LocalFork> {
    const port = await reservePort();
    const upstreamUrl =
      `${this.origin}/upstream/${attempt.upstreamLease}/${lane}`;
    const child = spawn(
      this.anvilBin,
      [
        "--fork-url",
        upstreamUrl,
        "--fork-block-number",
        String(anchor.number),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--accounts",
        "0",
        "--disable-default-create2-deployer",
        "--no-mining",
        "--no-rate-limit",
        "--no-storage-caching",
        "--retries",
        "0",
        "--timeout",
        String(this.startupTimeoutMs),
        "--quiet",
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const fork: LocalFork = {
      lane,
      rpcUrl: `http://127.0.0.1:${port}`,
      child,
    };
    const errors: string[] = [];
    child.stderr.on("data", (chunk) => {
      if (errors.length < 32) errors.push(String(chunk).trim());
    });
    try {
      const block = await waitForForkBlock(
        fork,
        anchor,
        this.startupTimeoutMs,
      );
      assertSameAnchor(`anvil ${lane} fork`, block, anchor);
      return fork;
    } catch (error) {
      await stopFork(fork);
      const detail = errors.filter(Boolean).join(" | ");
      throw new Error(
        `failed to materialize ${lane} fork: ${asError(error).message}` +
          (detail ? ` (${detail})` : ""),
      );
    }
  }

  private async proxyProductionRpc(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const attempt = this.attempt;
    if (!attempt?.forks || attempt.phase === "preparing") {
      replyError(response, 503, "blind backend is not prepared");
      return;
    }
    const body = await readBody(request);
    try {
      assertReadOnlyProductionRpc(body);
    } catch (error) {
      replyError(response, 403, asError(error).message);
      return;
    }
    const lane = attempt.activeLane;
    const target = attempt.forks[lane].rpcUrl;
    attempt.inFlightRpc += 1;
    this.recordTimedRpc(attempt, target, body);
    try {
      await forwardJsonRpc(target, body, response);
    } finally {
      attempt.inFlightRpc -= 1;
    }
  }

  private async proxyForkUpstream(
    request: IncomingMessage,
    response: ServerResponse,
    upstreamLease: string,
    lane: ForkLane,
  ): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.upstreamLease !== upstreamLease) {
      replyError(response, 404, "stale blind backend upstream lease");
      return;
    }
    const body = await readBody(request);
    this.recordTimedRpc(attempt, this.upstreamRpcUrl, body);
    await forwardJsonRpc(
      this.upstreamRpcUrl,
      body,
      response,
      { "x-blind-fork-lane": lane },
    );
  }

  private recordTimedRpc(
    attempt: BackendAttempt,
    targetUrl: string,
    body: string,
  ): void {
    if (attempt.phase !== "revealed") return;
    const calls = countJsonRpcCalls(body);
    if (isLoopbackUrl(targetUrl)) attempt.loopbackRpcCalls += calls;
    else attempt.nonLoopbackUpstreamRpcCalls += calls;
  }
}

async function waitForForkBlock(
  fork: LocalFork,
  anchor: BlockAnchor,
  timeoutMs: number,
): Promise<BlockAnchor> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (fork.child.exitCode !== null) {
      throw new Error(`anvil exited with code ${fork.child.exitCode}`);
    }
    try {
      const block = await rpc<{
        readonly number: string;
        readonly hash: string;
        readonly stateRoot: string;
      }>(
        fork.rpcUrl,
        "eth_getBlockByNumber",
        ["latest", false],
        Math.min(1_000, Math.max(1, deadline - Date.now())),
      );
      if (block) {
        return {
          number: Number(BigInt(block.number)),
          hash: block.hash,
          stateRoot: block.stateRoot,
        };
      }
      lastError = "latest block was null";
    } catch (error) {
      lastError = asError(error).message;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(
    `anvil did not expose block ${anchor.number} within ${timeoutMs}ms` +
      (lastError ? `: ${lastError}` : ""),
  );
}

async function rpc<T>(
  url: string,
  method: string,
  params: readonly unknown[],
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json() as {
    readonly result?: T;
    readonly error?: { readonly message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? "RPC error");
  if (payload.result === undefined) throw new Error("RPC result missing");
  return payload.result;
}

interface FrozenRpcStats {
  readonly manifestSha256: string;
  readonly requests: number;
  readonly misses: number;
}

async function assertFrozenRpcEndpoint(
  upstreamRpcUrl: string,
  expected: LoadedBlindHistoricalRpcCache,
  timeoutMs: number,
): Promise<void> {
  const response = await fetch(
    new URL("/manifest", upstreamRpcUrl),
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) {
    throw new Error(`frozen RPC manifest HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    readonly manifest?: unknown;
    readonly manifestSha256?: unknown;
  };
  assert(
    payload.manifestSha256 === expected.manifestSha256 &&
      canonicalJson(payload.manifest) === canonicalJson(expected.manifest),
    "frozen RPC endpoint does not serve the attested manifest",
  );
  const stats = await readFrozenRpcStats(
    upstreamRpcUrl,
    expected.manifestSha256,
    timeoutMs,
  );
  assert(
    stats.misses === 0,
    "frozen RPC endpoint was already tainted by a cache miss",
  );
}

async function readFrozenRpcStats(
  upstreamRpcUrl: string,
  expectedManifestSha256: string,
  timeoutMs: number,
): Promise<FrozenRpcStats> {
  const response = await fetch(
    new URL("/stats", upstreamRpcUrl),
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) {
    throw new Error(`frozen RPC stats HTTP ${response.status}`);
  }
  const stats = await response.json() as Partial<FrozenRpcStats>;
  assert(
    stats.manifestSha256 === expectedManifestSha256,
    "frozen RPC stats manifest mismatch",
  );
  assert(
    Number.isSafeInteger(stats.requests) && Number(stats.requests) >= 0,
    "frozen RPC request count",
  );
  assert(
    Number.isSafeInteger(stats.misses) && Number(stats.misses) >= 0,
    "frozen RPC miss count",
  );
  return stats as FrozenRpcStats;
}

async function forwardJsonRpc(
  targetUrl: string,
  body: string,
  response: ServerResponse,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Promise<void> {
  const upstream = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...additionalHeaders,
    },
    body,
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  response.statusCode = upstream.status;
  response.setHeader(
    "content-type",
    upstream.headers.get("content-type") ?? "application/json",
  );
  response.end(bytes);
}

function validateControlRequest(value: unknown): ControlRequest {
  assert(value && typeof value === "object", "controller request must be an object");
  const request = value as Record<string, unknown>;
  assert(
    request.profile === BLIND_PRODUCTION_RAW_PROFILE,
    "controller profile mismatch",
  );
  assertNonce(request.attemptNonce);
  if (request.type === "prepare") {
    assertExactKeys(
      request,
      [
        "attemptNonce",
        "backendIdentitySha256",
        "base",
        "profile",
        "source",
        "type",
      ],
      "controller prepare",
    );
    validateAnchor(request.base, "controller base");
    validateAnchor(request.source, "controller source");
    const base = request.base as BlockAnchor;
    const source = request.source as BlockAnchor;
    assert(base.number + 1 === source.number, "controller anchors must be adjacent");
    assertHash(request.backendIdentitySha256, "backend identity");
    return request as unknown as PrepareRequest;
  }
  if (request.type === "reveal_request") {
    assertExactKeys(
      request,
      ["attemptNonce", "cleanForkId", "profile", "source", "type"],
      "controller reveal request",
    );
    validateAnchor(request.source, "controller source");
    assertNonempty(request.cleanForkId, "controller clean fork");
    return request as unknown as RevealRequest;
  }
  if (request.type === "release") {
    assertExactKeys(
      request,
      [
        "attemptNonce",
        "cleanForkId",
        "profile",
        "revealToken",
        "type",
      ],
      "controller reveal release",
    );
    assertNonempty(request.cleanForkId, "controller clean fork");
    assertNonce(request.revealToken);
    return request as unknown as RevealReleaseRequest;
  }
  if (request.type === "finish") {
    assertExactKeys(
      request,
      ["attemptNonce", "cleanForkId", "profile", "type"],
      "controller finish",
    );
    assertNonempty(request.cleanForkId, "controller clean fork");
    return request as unknown as FinishRequest;
  }
  throw new Error("unknown controller request type");
}

function validateAnchor(value: unknown, label: string): void {
  assert(value && typeof value === "object", `${label} must be an object`);
  const anchor = value as Record<string, unknown>;
  assertExactKeys(anchor, ["hash", "number", "stateRoot"], label);
  assert(
    Number.isSafeInteger(anchor.number) && Number(anchor.number) >= 0,
    `${label} number`,
  );
  assertHash(anchor.hash, `${label} hash`);
  assertHash(anchor.stateRoot, `${label} state root`);
}

function assertSameAnchor(
  label: string,
  actual: BlockAnchor,
  expected: BlockAnchor,
): void {
  assert(actual.number === expected.number, `${label} number mismatch`);
  assert(sameHash(actual.hash, expected.hash), `${label} hash mismatch`);
  assert(
    sameHash(actual.stateRoot, expected.stateRoot),
    `${label} state root mismatch`,
  );
}

function sameHash(left: string, right: string): boolean {
  return left.replace(/^0x/i, "").toLowerCase() ===
    right.replace(/^0x/i, "").toLowerCase();
}

function assertNonce(value: unknown): void {
  assert(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    "controller attempt nonce",
  );
}

function assertHash(value: unknown, label: string): void {
  assert(
    typeof value === "string" && /^(?:0x)?[0-9a-f]{64}$/i.test(value),
    `${label} must be a 32-byte hash`,
  );
}

function assertNonempty(value: unknown, label: string): void {
  assert(typeof value === "string" && value.length > 0, label);
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} contains unexpected or missing fields`,
  );
}

function countJsonRpcCalls(body: string): number {
  try {
    const value = JSON.parse(body) as unknown;
    if (Array.isArray(value)) return value.length;
    return value && typeof value === "object" ? 1 : 0;
  } catch {
    return 0;
  }
}

const READ_ONLY_PRODUCTION_RPC_METHODS = new Set([
  "web3_clientVersion",
  "net_version",
  "net_listening",
  "net_peerCount",
  "eth_chainId",
  "eth_syncing",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionReceipt",
  "eth_getUncleByBlockNumberAndIndex",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleCountByBlockNumber",
  "eth_getUncleCountByBlockHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getProof",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
  "eth_createAccessList",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "debug_traceCall",
  "debug_traceTransaction",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "trace_call",
  "trace_callMany",
  "trace_replayTransaction",
  "trace_replayBlockTransactions",
  "trace_transaction",
  "trace_block",
]);

function assertReadOnlyProductionRpc(body: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("production RPC body must be valid JSON");
  }
  const calls = Array.isArray(payload) ? payload : [payload];
  assert(calls.length > 0, "production RPC batch must not be empty");
  for (const call of calls) {
    assert(call && typeof call === "object", "production RPC call must be an object");
    const method = (call as Record<string, unknown>).method;
    assert(
      typeof method === "string" &&
        READ_ONLY_PRODUCTION_RPC_METHODS.has(method),
      `production RPC method ${String(method)} is not read-only allowlisted`,
    );
  }
}

async function stopFork(fork: LocalFork): Promise<void> {
  const child = fork.child;
  if (child.exitCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("failed to reserve anvil port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        rejectBody(new Error("controller request exceeds 16MiB"));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function replyJson(
  response: ServerResponse,
  status: number,
  value: object,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(canonicalJson(value));
}

function replyError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  replyJson(response, status, { error: message });
}

function assertLoopbackUrl(value: string, label: string): void {
  const url = new URL(value);
  assert(
    url.protocol === "http:" || url.protocol === "https:",
    `${label} protocol`,
  );
  assert(isLoopbackHost(url.hostname), `${label} must be loopback`);
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.");
}

function formatHost(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function loadBackendAttestation(
  path: string,
  upstreamRpcUrl: string,
  issuerKey = process.env.BLIND_BACKEND_ATTESTATION_KEY ?? "",
  frozenManifestSha256?: string,
): LoadedBackendAttestation {
  assert(isAbsolute(path), "backend attestation path must be absolute");
  const stat = statSync(path);
  assert(stat.isFile(), "backend attestation must be a regular file");
  assert(
    (stat.mode & 0o077) === 0,
    "backend attestation must be owner-only (0600)",
  );
  if (typeof process.getuid === "function") {
    assert(
      stat.uid === process.getuid(),
      "backend attestation must be owned by the trusted runner user",
    );
  }
  const raw = readFileSync(path);
  const declaration = JSON.parse(raw.toString("utf8")) as
    Partial<BlindBackendAttestation>;
  const keys = Object.keys(declaration).sort();
  const allowed = [
    "attestationMode",
    "endpointSha256",
    "frozenManifestSha256",
    "issuerHmacSha256",
    "localProcessPid",
    "profile",
    "schemaVersion",
    "upstreamKind",
  ];
  assert(
    keys.every((key) => allowed.includes(key)) &&
      [
        "attestationMode",
        "endpointSha256",
        "issuerHmacSha256",
        "localProcessPid",
        "profile",
        "schemaVersion",
        "upstreamKind",
      ].every((key) => keys.includes(key)),
    "backend attestation contains unexpected or missing fields",
  );
  assert(declaration.schemaVersion === 1, "backend attestation schema");
  assert(
    declaration.profile ===
      "adapter-family-blind-local-backend-attestation-v1",
    "backend attestation profile",
  );
  assert(
    [
      "local-reth",
      "local-content-addressed-state",
      "local-snapshot",
    ].includes(String(declaration.upstreamKind)),
    "backend attestation upstream kind is not local",
  );
  assert(
    declaration.attestationMode === "trusted-file-hmac-sha256",
    "backend attestation mode",
  );
  assertHash(declaration.endpointSha256, "backend attestation endpoint hash");
  assertHash(declaration.issuerHmacSha256, "backend attestation issuer HMAC");
  if (declaration.upstreamKind === "local-content-addressed-state") {
    assertHash(
      declaration.frozenManifestSha256,
      "backend attestation frozen manifest",
    );
    assert(
      frozenManifestSha256 === declaration.frozenManifestSha256,
      "backend attestation is not bound to the loaded frozen manifest",
    );
  } else {
    assert(
      declaration.frozenManifestSha256 === undefined,
      "non-content-addressed backend must not declare a frozen manifest",
    );
    assert(
      frozenManifestSha256 === undefined,
      "frozen manifest requires content-addressed backend attestation",
    );
  }
  assert(
    Buffer.byteLength(issuerKey) >= 32,
    "trusted backend attestation issuer key is unavailable/too short",
  );
  const {
    issuerHmacSha256,
    ...unsignedDeclaration
  } = declaration;
  const expectedHmac = createHmac("sha256", issuerKey)
    .update(canonicalJson(unsignedDeclaration))
    .digest("hex");
  assert(
    safeHexEqual(String(issuerHmacSha256), expectedHmac),
    "backend attestation issuer authentication failed",
  );
  assert(
    declaration.endpointSha256 === sha256(upstreamRpcUrl),
    "backend attestation does not bind the configured upstream",
  );
  assert(
    Number.isSafeInteger(declaration.localProcessPid) &&
      Number(declaration.localProcessPid) > 0,
    "backend attestation local PID is required",
  );
  try {
    process.kill(Number(declaration.localProcessPid), 0);
  } catch {
    throw new Error("backend attestation local PID is not alive");
  }
  assertPidOwnsEndpoint(
    Number(declaration.localProcessPid),
    upstreamRpcUrl,
  );
  return Object.freeze({
    declaration: Object.freeze(declaration as BlindBackendAttestation),
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left.toLowerCase(), "hex"),
    Buffer.from(right.toLowerCase(), "hex"),
  );
}

function assertPidOwnsEndpoint(pid: number, endpoint: string): void {
  const url = new URL(endpoint);
  const port = Number(
    url.port || (url.protocol === "https:" ? "443" : "80"),
  );
  assert(Number.isSafeInteger(port) && port > 0, "backend endpoint port");
  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync) ?? "lsof";
  const result = spawnSync(
    lsof,
    [
      "-nP",
      "-a",
      "-p",
      String(pid),
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpn",
    ],
    { encoding: "utf8" },
  );
  assert(
    result.status === 0 &&
      result.stdout.split("\n").some((line) =>
        line.startsWith("n") && line.endsWith(`:${port}`)
      ),
    "backend attestation PID does not own the configured listening socket",
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(args: readonly string[]): {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstreamRpcUrl: string;
  readonly backendAttestationPath: string;
  readonly anvilBin: string;
  readonly startupTimeoutMs: number;
  readonly frozenRpcManifestPath: string | null;
} {
  let listenHost = "127.0.0.1";
  let listenPort = 0;
  let upstreamRpcUrl = "";
  let backendAttestationPath = "";
  let anvilBin = "";
  let startupTimeoutMs = 30_000;
  let frozenRpcManifestPath: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--listen-host") listenHost = value;
    else if (name === "--port") listenPort = Number(value);
    else if (name === "--upstream-rpc") upstreamRpcUrl = value;
    else if (name === "--backend-attestation") backendAttestationPath = value;
    else if (name === "--anvil-bin") anvilBin = value;
    else if (name === "--startup-timeout-ms") startupTimeoutMs = Number(value);
    else if (name === "--frozen-rpc-manifest") {
      frozenRpcManifestPath = value;
    }
    else throw new Error(`unknown argument ${name}`);
  }
  assert(
    listenHost === "127.0.0.1" || listenHost === "::1" || listenHost === "localhost",
    "controller listen host must be loopback",
  );
  assert(
    Number.isSafeInteger(listenPort) && listenPort >= 0 && listenPort <= 65_535,
    "controller port",
  );
  assert(upstreamRpcUrl.length > 0, "--upstream-rpc is required");
  assert(
    isAbsolute(backendAttestationPath),
    "--backend-attestation absolute path is required",
  );
  assert(anvilBin.length > 0, "--anvil-bin is required");
  assert(
    Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs > 0,
    "startup timeout",
  );
  if (frozenRpcManifestPath !== null) {
    assert(
      isAbsolute(frozenRpcManifestPath),
      "--frozen-rpc-manifest must be absolute",
    );
  }
  return {
    listenHost,
    listenPort,
    upstreamRpcUrl,
    backendAttestationPath,
    anvilBin,
    startupTimeoutMs,
    frozenRpcManifestPath,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const frozenRpcCache = args.frozenRpcManifestPath
    ? loadBlindHistoricalRpcCache(args.frozenRpcManifestPath)
    : null;
  const attestation = loadBackendAttestation(
    args.backendAttestationPath,
    args.upstreamRpcUrl,
    process.env.BLIND_BACKEND_ATTESTATION_KEY ?? "",
    frozenRpcCache?.manifestSha256,
  );
  const controller = new BlindBackendController(
    args.listenHost,
    args.listenPort,
    args.upstreamRpcUrl,
    attestation,
    args.anvilBin,
    args.startupTimeoutMs,
    frozenRpcCache,
  );
  const ready = await controller.start();
  process.stdout.write(`${READY_PREFIX}${canonicalJson(ready)}\n`);
  const close = async (): Promise<void> => {
    await controller.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(asError(error).message);
    process.exitCode = 1;
  });
}
