import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BLIND_PROFILE,
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  type BlindProducerOutput,
  type BlindProducerPrepareRequest,
  type BlindProducerRevealReady,
  type BlindProducerRevealReleaseRequest,
  type BlindProducerReleaseRequest,
  type BlindProducerRequest,
  type BlindProducerSourceRevealed,
} from "./adapter-family-blind-contract.js";
import { loadBackendAttestation } from
  "./adapter-family-blind-backend-controller.js";
import {
  BLIND_PRODUCTION_RAW_PROFILE,
  productionPrepareControl,
  validateProductionReadyRecord,
} from "./adapter-family-blind-production-raw.js";
import {
  blindProductionArtifactPayloadHash,
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifactDocuments,
  type BlindProductionArtifactReceipts,
} from "../blind-production-artifacts.js";

const root = mkdtempSync(resolve(tmpdir(), "blind-production-harness-"));
const productionEntry = resolve(root, "production-entry.mjs");
const listenerRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const harnessEntry = fileURLToPath(
  new URL("./adapter-family-blind-production-harness.ts", import.meta.url),
);
const controllerEntry = fileURLToPath(
  new URL("./adapter-family-blind-backend-controller.ts", import.meta.url),
);
const defaultAnvil = "/Users/eunice/.foundry/bin/anvil";
const anvilBin = process.env.ANVIL_BIN ?? defaultAnvil;
let backendIdentitySha256 = "";
const base = {
  number: 99,
  hash: hexHash("base-hash"),
  stateRoot: hexHash("base-root"),
};
const source = {
  number: 100,
  hash: hexHash("source-hash"),
  stateRoot: hexHash("source-root"),
};

assert(existsSync(anvilBin), `anvil executable missing: ${anvilBin}`);
const fixtureArtifacts = productionFixtureArtifacts(base, source);
writeFileSync(
  productionEntry,
  productionFixtureSource(fixtureArtifacts.documents, fixtureArtifacts.receipts),
);

const fakeReth = createServer((request, response) => {
  void serveFakeReth(request, response).catch((error) => {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  });
});
let controller: ChildProcess | null = null;
let harness: ChildProcess | null = null;

try {
  const rethPort = await listen(fakeReth);
  const upstreamRpcUrl = `http://127.0.0.1:${rethPort}`;
  const backendAttestationPath = resolve(root, "backend-attestation.json");
  const backendAttestationIssuerKey =
    "trusted-attestation-test-key-with-at-least-32-bytes";
  const unsignedBackendAttestation = {
    schemaVersion: 1,
    profile: "adapter-family-blind-local-backend-attestation-v1",
    upstreamKind: "local-snapshot",
    endpointSha256: hash(upstreamRpcUrl),
    attestationMode: "trusted-file-hmac-sha256",
    localProcessPid: process.pid,
  };
  writeFileSync(
    backendAttestationPath,
    `${canonicalJson({
      ...unsignedBackendAttestation,
      issuerHmacSha256: createHmac(
        "sha256",
        backendAttestationIssuerKey,
      )
        .update(canonicalJson(unsignedBackendAttestation))
        .digest("hex"),
    })}\n`,
    { mode: 0o600 },
  );
  assert.equal(
    statSync(backendAttestationPath).mode & 0o777,
    0o600,
    "backend attestation must be owner-only",
  );
  backendIdentitySha256 = fileHash(backendAttestationPath);
  assert.equal(
    loadBackendAttestation(
      backendAttestationPath,
      upstreamRpcUrl,
      backendAttestationIssuerKey,
    ).sha256,
    backendIdentitySha256,
  );
  const invalidAttestationPath = resolve(root, "invalid-attestation.json");
  writeFileSync(
    invalidAttestationPath,
    `${canonicalJson({
      schemaVersion: 1,
      profile: "adapter-family-blind-local-backend-attestation-v1",
      upstreamKind: "local-reth",
      endpointSha256: hash(upstreamRpcUrl),
      attestationMode: "trusted-file-hmac-sha256",
      localProcessPid: process.pid,
      issuerHmacSha256: "00".repeat(32),
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => loadBackendAttestation(
      invalidAttestationPath,
      upstreamRpcUrl,
      backendAttestationIssuerKey,
    ),
    /issuer authentication failed/,
    "a same-user loopback declaration cannot self-attest as local reth",
  );
  const wrongPidAttestationPath = resolve(root, "wrong-pid-attestation.json");
  const wrongPidDeclaration = {
    ...unsignedBackendAttestation,
    localProcessPid: process.ppid,
  };
  writeFileSync(
    wrongPidAttestationPath,
    `${canonicalJson({
      ...wrongPidDeclaration,
      issuerHmacSha256: createHmac(
        "sha256",
        backendAttestationIssuerKey,
      )
        .update(canonicalJson(wrongPidDeclaration))
        .digest("hex"),
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => loadBackendAttestation(
      wrongPidAttestationPath,
      upstreamRpcUrl,
      backendAttestationIssuerKey,
    ),
    /does not own the configured listening socket/,
    "an authenticated attestation must bind the endpoint to its real PID",
  );
  controller = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      controllerEntry,
      "--upstream-rpc",
      upstreamRpcUrl,
      "--backend-attestation",
      backendAttestationPath,
      "--anvil-bin",
      anvilBin,
      "--startup-timeout-ms",
      "5000",
    ],
    {
      cwd: listenerRoot,
      env: {
        ...process.env,
        BLIND_BACKEND_ATTESTATION_KEY: backendAttestationIssuerKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const controllerLines = createInterface({ input: controller.stdout! });
  const controllerIterator = controllerLines[Symbol.asyncIterator]();
  const controllerStderr: string[] = [];
  createInterface({ input: controller.stderr! }).on(
    "line",
    (line) => controllerStderr.push(line),
  );
  const controllerReady = JSON.parse(
    await nextPrefixed(
      controllerIterator,
      "BLIND_BACKEND_CONTROLLER_READY=",
    ),
  ) as {
    readonly controlUrl: string;
    readonly rpcUrl: string;
  };

  const rejected = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "prepare",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: "00".repeat(32),
      base,
      source,
      backendIdentitySha256,
      targetRoute: ["forbidden"],
    }),
  });
  assert.equal(
    rejected.status,
    400,
    "controller must reject every target-specific control field",
  );

  harness = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      harnessEntry,
      "--production-entry",
      productionEntry,
      "--controller-url",
      controllerReady.controlUrl,
      "--preparation-timeout-ms",
      "5000",
    ],
    {
      cwd: listenerRoot,
      env: {
        ...process.env,
        BLIND_FIXTURE_CONTROLLER_ORIGIN:
          new URL(controllerReady.controlUrl).origin,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const harnessLines = createInterface({ input: harness.stdout! });
  const harnessIterator = harnessLines[Symbol.asyncIterator]();
  const harnessStderr: string[] = [];
  createInterface({ input: harness.stderr! }).on(
    "line",
    (line) => harnessStderr.push(line),
  );

  const common = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: BLIND_PROFILE,
    experimentId: "production-bridge-contract",
    caseId: "primary" as const,
    side: "baseline" as const,
    runIndex: 0,
    base,
    source,
    productionEntrySha256: fileHash(productionEntry),
    resolvedConfigSha256: fixtureArtifacts.receipts.resolvedConfig.sha256,
    universeSha256: fixtureArtifacts.receipts.universe.sha256,
    activeFamilyManifestSha256:
      fixtureArtifacts.receipts.activeFamilyManifest.sha256,
    baseGraphViewSha256: fixtureArtifacts.receipts.baseGraphView.sha256,
    sourceDeltaSha256: fixtureArtifacts.receipts.sourceDelta.sha256,
    backendIdentitySha256,
  };
  const prepare: BlindProducerPrepareRequest = { type: "prepare", ...common };
  const run: BlindProducerRequest = { type: "reveal_request", ...common };
  const producerPrepare = productionPrepareControl(
    prepare,
    "ab".repeat(32),
  );
  const producerPrepareJson = canonicalJson(producerPrepare);
  assert.deepEqual(
    Object.keys(producerPrepare).sort(),
    ["attemptNonce", "base", "profile", "type"],
  );
  assert.equal(producerPrepareJson.includes(source.hash), false);
  assert.equal(producerPrepareJson.includes(source.stateRoot), false);
  assert.throws(
    () => validateProductionReadyRecord({
      type: "ready",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: producerPrepare.attemptNonce,
      base,
      source,
    } as never, producerPrepare),
    /unexpected or missing fields/,
    "READY must not smuggle source N under any extra field",
  );

  const first = await executeAttempt({
    harness,
    harnessIterator,
    controllerRpcUrl: controllerReady.rpcUrl,
    prepare,
    run,
  }).catch((error) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `harness: ${harnessStderr.join(" | ")}\n` +
        `controller: ${controllerStderr.join(" | ")}`,
    );
  });
  assert.equal(first.output.selectionMode, "production");
  assert.equal(first.output.forcedSelectionCount, 0);
  assert.equal(first.output.source.hash, source.hash);
  assert.equal(first.output.telemetry.basePreStateRoot, base.stateRoot);
  assert.equal(first.output.telemetry.sourceStateRoot, source.stateRoot);
  assert.equal(
    first.output.telemetry.backendUpstreamKind,
    "local-snapshot",
  );
  assert.equal(
    first.output.telemetry.backendAttestationSha256,
    backendIdentitySha256,
  );
  assert(first.output.telemetry.loopbackRpcCalls >= 1);
  assert.equal(first.output.telemetry.nonLoopbackUpstreamRpcCalls, 0);
  assert.equal(first.output.opportunities.length, 1);
  assert.equal(first.output.opportunities[0]?.rank, 1);
  assert(
    first.fullAttemptMs > first.releasedElapsedMs,
    "prepare/reveal time must remain outside the release-to-output window",
  );

  const repeatedCommon = { ...common, runIndex: 1 };
  const repeated = await executeAttempt({
    harness,
    harnessIterator,
    controllerRpcUrl: controllerReady.rpcUrl,
    prepare: {
      type: "prepare",
      ...repeatedCommon,
    },
    run: {
      type: "reveal_request",
      ...repeatedCommon,
    },
  });
  assert.notEqual(
    repeated.output.telemetry.cleanForkId,
    first.output.telemetry.cleanForkId,
    "a persistent production process still receives a fresh Anvil fork pair",
  );
  assert.equal(repeated.output.telemetry.nonLoopbackUpstreamRpcCalls, 0);

  harness.stdin!.write(`${canonicalJson({ type: "close" })}\n`);
  harness.stdin!.end();
  await waitForExit(harness);
  assert.equal(harness.exitCode, 0, harnessStderr.join("\n"));

  controller.kill("SIGTERM");
  await waitForExit(controller);
  assert.equal(controller.exitCode, 0, controllerStderr.join("\n"));
  console.log("adapter-family-blind-production-harness PASS");
} finally {
  if (harness && harness.exitCode === null) harness.kill("SIGKILL");
  if (controller && controller.exitCode === null) controller.kill("SIGKILL");
  await new Promise<void>((resolveClose) => fakeReth.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
}

async function executeAttempt(input: {
  readonly harness: ChildProcess;
  readonly harnessIterator: AsyncIterator<string>;
  readonly controllerRpcUrl: string;
  readonly prepare: BlindProducerPrepareRequest;
  readonly run: BlindProducerRequest;
}): Promise<{
  readonly output: BlindProducerOutput;
  readonly fullAttemptMs: number;
  readonly releasedElapsedMs: number;
}> {
  const startedAtMs = performance.now();
  input.harness.stdin!.write(`${canonicalJson(input.prepare)}\n`);
  const ready = JSON.parse(
    await nextPrefixed(input.harnessIterator, "BLIND_PRODUCER_BASE_READY="),
  ) as { readonly type: string; readonly runIndex: number };
  assert.equal(ready.type, "base_ready");
  assert.equal(ready.runIndex, input.prepare.runIndex);
  assertSameRpcAnchor(
    await rpcBlock(input.controllerRpcUrl),
    input.prepare.base,
    "prepared stable endpoint",
  );
  assert.equal(
    await rpcHttpStatus(input.controllerRpcUrl, "anvil_mine", []),
    403,
    "production RPC must reject fork-mutating methods",
  );
  assertSameRpcAnchor(
    await rpcBlock(input.controllerRpcUrl),
    input.prepare.base,
    "mutation-rejected stable endpoint",
  );

  input.harness.stdin!.write(`${canonicalJson(input.run)}\n`);
  const revealReady = JSON.parse(
    await nextPrefixed(
      input.harnessIterator,
      "BLIND_PRODUCER_REVEAL_READY=",
    ),
  ) as BlindProducerRevealReady;
  assert.equal(revealReady.type, "reveal_ready");
  assert.equal(revealReady.runIndex, input.run.runIndex);
  assertSameRpcAnchor(
    await rpcBlock(input.controllerRpcUrl),
    input.run.base,
    "pre-release stable endpoint",
  );

  const revealRelease: BlindProducerRevealReleaseRequest = {
    type: "reveal_release",
    schemaVersion: revealReady.schemaVersion,
    profile: revealReady.profile,
    experimentId: revealReady.experimentId,
    caseId: revealReady.caseId,
    side: revealReady.side,
    runIndex: revealReady.runIndex,
    revealToken: revealReady.revealToken,
  };
  input.harness.stdin!.write(`${canonicalJson(revealRelease)}\n`);
  const sourceRevealed = JSON.parse(
    await nextPrefixed(
      input.harnessIterator,
      "BLIND_PRODUCER_SOURCE_REVEALED=",
    ),
  ) as BlindProducerSourceRevealed;
  assert.equal(sourceRevealed.type, "source_revealed");
  assert.equal(sourceRevealed.runIndex, input.run.runIndex);
  assertSameRpcAnchor(
    await rpcBlock(input.controllerRpcUrl),
    input.run.source,
    "post-release stable endpoint",
  );

  const releasedAtMs = performance.now();
  const release: BlindProducerReleaseRequest = {
    type: "release",
    schemaVersion: sourceRevealed.schemaVersion,
    profile: sourceRevealed.profile,
    experimentId: sourceRevealed.experimentId,
    caseId: sourceRevealed.caseId,
    side: sourceRevealed.side,
    runIndex: sourceRevealed.runIndex,
    releaseToken: sourceRevealed.releaseToken,
  };
  input.harness.stdin!.write(`${canonicalJson(release)}\n`);
  const output = JSON.parse(
    await nextPrefixed(input.harnessIterator, "BLIND_PRODUCER_OUTPUT="),
  ) as BlindProducerOutput;
  const finishedAtMs = performance.now();
  return {
    output,
    fullAttemptMs: finishedAtMs - startedAtMs,
    releasedElapsedMs: finishedAtMs - releasedAtMs,
  };
}

async function serveFakeReth(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(request)) as
    | JsonRpcRequest
    | JsonRpcRequest[];
  const result = Array.isArray(body)
    ? body.map(fakeRethResponse)
    : fakeRethResponse(body);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(result));
}

interface JsonRpcRequest {
  readonly jsonrpc: string;
  readonly id: unknown;
  readonly method: string;
  readonly params?: readonly unknown[];
}

function fakeRethResponse(request: JsonRpcRequest): object {
  try {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: fakeRethResult(request),
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function fakeRethResult(request: JsonRpcRequest): unknown {
  if (request.method === "eth_chainId") return "0x1";
  if (request.method === "net_version") return "1";
  if (request.method === "eth_blockNumber") return hexQuantity(source.number);
  if (request.method === "eth_getBlockByNumber") {
    const blockTag = String(request.params?.[0] ?? "");
    const blockNumber = blockTag === "latest"
      ? source.number
      : Number(BigInt(blockTag));
    if (blockNumber === base.number) return fakeBlock(base, hexHash("base-parent"));
    if (blockNumber === source.number) return fakeBlock(source, base.hash);
    return null;
  }
  if (
    request.method === "eth_getBalance" ||
    request.method === "eth_getTransactionCount"
  ) return "0x0";
  if (request.method === "eth_getCode") return "0x";
  if (request.method === "eth_getStorageAt") return `0x${"00".repeat(32)}`;
  if (request.method === "eth_getLogs") return [];
  if (request.method === "eth_getProof") {
    return {
      address: request.params?.[0],
      accountProof: [],
      balance: "0x0",
      codeHash: hexHash("empty-code"),
      nonce: "0x0",
      storageHash: hexHash("empty-storage"),
      storageProof: [],
    };
  }
  throw new Error(`unsupported fake reth method ${request.method}`);
}

function fakeBlock(
  anchor: typeof base,
  parentHash: string,
): object {
  return {
    number: hexQuantity(anchor.number),
    hash: anchor.hash,
    parentHash,
    nonce: "0x0000000000000000",
    sha3Uncles: hexHash("empty-uncles"),
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: hexHash(`transactions:${anchor.number}`),
    stateRoot: anchor.stateRoot,
    receiptsRoot: hexHash(`receipts:${anchor.number}`),
    miner: `0x${"00".repeat(20)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x200",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: hexQuantity(1_700_000_000 + anchor.number),
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x1",
    mixHash: hexHash(`mix:${anchor.number}`),
    withdrawalsRoot: hexHash(`withdrawals:${anchor.number}`),
    withdrawals: [],
    parentBeaconBlockRoot: hexHash(`beacon:${anchor.number}`),
    blobGasUsed: "0x0",
    excessBlobGas: "0x0",
  };
}

async function rpcBlock(url: string): Promise<typeof base> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  assert.equal(response.ok, true);
  const body = await response.json() as { readonly result: typeof base };
  return body.result;
}

async function rpcHttpStatus(
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.status;
}

function assertSameRpcAnchor(
  actual: typeof base,
  expected: typeof base,
  label: string,
): void {
  assert.equal(Number(BigInt(actual.number)), expected.number, `${label} number`);
  assert.equal(actual.hash.toLowerCase(), expected.hash.toLowerCase(), `${label} hash`);
  assert.equal(
    actual.stateRoot.toLowerCase(),
    expected.stateRoot.toLowerCase(),
    `${label} state root`,
  );
}

function productionFixtureSource(
  documents: BlindProductionArtifactDocuments,
  receipts: BlindProductionArtifactReceipts,
): string {
  const {
    sourceDelta: _sourceDeltaDocument,
    ...preparedDocuments
  } = documents;
  const {
    sourceDelta: _sourceDeltaReceipt,
    ...preparedReceipts
  } = receipts;
  return `
import crypto from "node:crypto";
import readline from "node:readline";
const artifactDocuments = ${JSON.stringify(documents)};
const artifactReceipts = ${JSON.stringify(receipts)};
const preparedArtifactDocuments = ${JSON.stringify(preparedDocuments)};
const preparedArtifactReceipts = ${JSON.stringify(preparedReceipts)};
const h = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(canon(value));
const canon = (value) => Array.isArray(value) ? value.map(canon)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]))
    : value;
const orderedHash = (values) => h(canonical(values));
const setHash = (values) => h(canonical([...new Set(values)].sort()));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.startsWith("BLIND_PRODUCTION_CONTROL=")) return;
  const control = JSON.parse(line.slice("BLIND_PRODUCTION_CONTROL=".length));
  if (control.type === "prepare") {
    if (Object.prototype.hasOwnProperty.call(control, "source")) {
      throw new Error("prepare leaked source N");
    }
    const controllerOrigin = process.env.BLIND_FIXTURE_CONTROLLER_ORIGIN;
    if (!controllerOrigin) throw new Error("fixture controller origin missing");
    void fetch(
      controllerOrigin + "/upstream/" + control.attemptNonce + "/source",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
      },
    ).then((response) => {
      if (response.status !== 404) {
        throw new Error("producer-visible attempt nonce opened source upstream");
      }
      process.stdout.write("BLIND_PRODUCTION_READY=" + JSON.stringify({
        type: "ready",
        profile: control.profile,
        attemptNonce: control.attemptNonce,
        base: control.base,
        artifacts: preparedArtifactReceipts,
        artifactDocuments: preparedArtifactDocuments,
      }) + "\\n");
    }).catch((error) => {
      process.stderr.write(String(error) + "\\n");
      process.exit(1);
    });
    return;
  }
  const edges = ["edge:" + h(control.source.hash + ":edge")];
  const states = ["state:" + h(control.source.hash + ":state")];
  const priced = ["priced:" + h(control.source.hash + ":priced")];
  const route = [{
    familyId: "family:" + h(control.source.hash + ":family").slice(0, 12),
    adapterId: "adapter:" + h(control.source.hash + ":adapter").slice(0, 12),
    target: "0x" + h(control.source.hash + ":target").slice(0, 40),
    tokenIn: "0x" + h(control.source.hash + ":token-in").slice(0, 40),
    tokenOut: "0x" + h(control.source.hash + ":token-out").slice(0, 40),
    executionVariantKey: h(control.source.hash + ":variant"),
  }];
  const graph = {
    orderedEdgeIds: edges,
    orderedEdgeHash: orderedHash(edges),
  };
  const pricingCoverage = {
    expectedStateKeys: states,
    resolvedStateKeys: states,
    expectedStateKeyHash: setHash(states),
    resolvedStateKeyHash: setHash(states),
    expectedPricedEdgeIds: priced,
    resolvedPricedEdgeIds: priced,
    expectedPricedEdgeHash: setHash(priced),
    resolvedPricedEdgeHash: setHash(priced),
  };
  const opportunities = [{
    rank: 1,
    route,
    refined: true,
    planCount: 1,
    simulation: {
      executed: true,
      success: true,
      profitRaw: "1",
      gasUsed: "1",
      calldataSha256: h("calldata"),
      standingPosition: false,
    },
    ev: {
      executionStatus: "pass",
      decision: "reject",
      reason: "below-production-threshold",
    },
  }];
  const stageNames = [
    "state_ready", "enumeration_done", "exact_refine_done",
    "planner_solver_done", "final_sim_done", "ev_decision",
  ];
  let previousArtifactSha256 = null;
  const stages = stageNames.map((name, index) => {
    const artifact = name === "state_ready"
      ? {
          schemaVersion: 1,
          name,
          previousArtifactSha256,
          graph,
          pricingCoverage,
        }
      : {
          schemaVersion: 1,
          name,
          previousArtifactSha256,
          opportunities: opportunities.map((opportunity) => {
            const projected = {
              rank: opportunity.rank,
              route: opportunity.route,
            };
            if (name === "enumeration_done") return projected;
            projected.refined = opportunity.refined;
            if (name === "exact_refine_done") return projected;
            projected.planCount = opportunity.planCount;
            if (name === "planner_solver_done") return projected;
            projected.simulation = opportunity.simulation;
            if (name === "final_sim_done") return projected;
            projected.ev = opportunity.ev;
            return projected;
          }),
        };
    const artifactSha256 = h(canonical(artifact));
    previousArtifactSha256 = artifactSha256;
    return {
      name,
      status: "pass",
      artifact,
      artifactSha256,
      stageMs: 1,
      cumulativeMs: index + 1,
    };
  });
  process.stdout.write("BLIND_PRODUCTION_RAW=" + JSON.stringify({
    type: "pass",
    profile: control.profile,
    attemptNonce: control.attemptNonce,
    base: {
      number: control.source.number - 1,
      hash: "${base.hash}",
      stateRoot: "${base.stateRoot}",
    },
    source: control.source,
    artifacts: artifactReceipts,
    artifactDocuments,
    selectionMode: "production",
    forcedSelectionCount: 0,
    stages,
    graph,
    pricingCoverage,
    telemetry: {
      dynamicCacheGeneration: 1,
      dynamicCacheReset: true,
      sourceDeltaApplied: true,
      freshReadCount: 1,
      batchCount: 1,
      incompleteFamilyIds: [],
    },
    opportunities,
  }) + "\\n");
});
`;
}

function productionFixtureArtifacts(
  baseAnchor: typeof base,
  sourceAnchor: typeof source,
): {
  readonly documents: BlindProductionArtifactDocuments;
  readonly receipts: BlindProductionArtifactReceipts;
} {
  const coverage = (number: number, blockHash: string) => [{
    familyId: "fixture-family",
    sourceId: "fixture-source",
    sourceFingerprint: hash("fixture-source-fingerprint"),
    completeThroughBlock: number,
    completeThroughHash: blockHash,
  }];
  const resolvedConfig = createBlindProductionArtifact(
    "resolved-config",
    {
      configLoaderFingerprint: hash("fixture-config-loader"),
      effectiveConfig: { dryRun: true },
      effectiveConfigSha256:
        blindProductionArtifactPayloadHash({ dryRun: true }),
    },
  );
  const universe = createBlindProductionArtifact(
    "production-universe",
    {
      builderFingerprint: hash("fixture-universe-builder"),
      contentSha256: hash("fixture-universe"),
      poolCount: 1,
      provenanceSha256: hash("fixture-universe-provenance"),
    },
  );
  const activeFamilyManifest = createBlindProductionArtifact(
    "active-family-manifest",
    {
      families: [{
        familyId: "fixture-family",
        kind: "swap",
        descriptorSha256: hash("fixture-family-descriptor"),
      }],
      familyCount: 1,
      registryFingerprint: hash("fixture-family-registry"),
    },
  );
  const baseCoverage = coverage(baseAnchor.number, baseAnchor.hash);
  const baseGraphView = createBlindProductionArtifact(
    "base-graph-view",
    {
      anchorNumber: baseAnchor.number,
      anchorHash: baseAnchor.hash,
      completenessWatermark: baseAnchor.number,
      edgeCount: 1,
      orderedEdgeHash: hash("fixture-base-edge-records"),
      orderedCanonicalEdgeIdHash: hash("fixture-base-edge-ids"),
      metadataHash: hash("fixture-base-metadata"),
      ownershipHash: hash("fixture-base-ownership"),
      perSourceCoverage: baseCoverage,
      perSourceCoverageSha256:
        blindProductionArtifactPayloadHash(baseCoverage),
    },
  );
  const sourceEdges = [`edge:${hash(`${sourceAnchor.hash}:edge`)}`];
  const sourceCoverage = coverage(sourceAnchor.number, sourceAnchor.hash);
  const sourceDelta = createBlindProductionArtifact(
    "source-delta",
    {
      anchorNumber: sourceAnchor.number,
      anchorHash: sourceAnchor.hash,
      completenessWatermark: sourceAnchor.number,
      edgeCount: sourceEdges.length,
      orderedEdgeHash: hash("fixture-source-edge-records"),
      orderedCanonicalEdgeIdHash:
        blindProductionArtifactPayloadHash(sourceEdges),
      metadataHash: hash("fixture-source-metadata"),
      ownershipHash: hash("fixture-source-ownership"),
      perSourceCoverage: sourceCoverage,
      perSourceCoverageSha256:
        blindProductionArtifactPayloadHash(sourceCoverage),
      baseGraphViewSha256:
        blindProductionArtifactReceipt(baseGraphView).sha256,
      addedEdgeCount: 1,
      addedEdgeHash: hash("fixture-added"),
      removedEdgeCount: 0,
      removedEdgeHash: hash("fixture-removed"),
    },
  );
  const documents = {
    resolvedConfig,
    universe,
    activeFamilyManifest,
    baseGraphView,
    sourceDelta,
  };
  return {
    documents,
    receipts: {
      resolvedConfig: blindProductionArtifactReceipt(resolvedConfig),
      universe: blindProductionArtifactReceipt(universe),
      activeFamilyManifest:
        blindProductionArtifactReceipt(activeFamilyManifest),
      baseGraphView: blindProductionArtifactReceipt(baseGraphView),
      sourceDelta: blindProductionArtifactReceipt(sourceDelta),
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hexHash(value: string): string {
  return `0x${hash(value)}`;
}

function hexQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("fake reth did not bind TCP"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function nextPrefixed(
  lines: AsyncIterator<string>,
  prefix: string,
): Promise<string> {
  for (;;) {
    const next = await lines.next();
    if (next.done) break;
    const line = next.value;
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  throw new Error(`process closed before ${prefix}`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}
