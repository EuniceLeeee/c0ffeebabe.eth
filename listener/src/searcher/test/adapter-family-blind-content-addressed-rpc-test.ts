import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  existsSync,
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
import {
  BlindBackendController,
  loadBackendAttestation,
} from
  "./adapter-family-blind-backend-controller.js";
import {
  blindHistoricalRpcCacheKey,
  buildBlindHistoricalPrewarmPlan,
  FrozenBlindHistoricalRpcServer,
  loadBlindHistoricalRpcCache,
  materializeBlindHistoricalRpcCache,
} from "./adapter-family-blind-content-addressed-rpc.js";
import {
  validateBackendAttestationArtifact,
} from "./adapter-family-blind-artifacts.js";
import { canonicalJson } from "./adapter-family-blind-contract.js";
import { BLIND_PRODUCTION_RAW_PROFILE } from
  "./adapter-family-blind-production-raw.js";

const root = mkdtempSync(resolve(tmpdir(), "blind-historical-rpc-"));
const cacheDir = resolve(root, "cache");
const base = {
  number: 99,
  hash: hash32("base-hash"),
  stateRoot: hash32("base-state"),
};
const source = {
  number: 100,
  hash: hash32("source-hash"),
  stateRoot: hash32("source-state"),
};
let archiveRequests = 0;

const archive = createServer((request, response) => {
  void handleArchive(request, response).catch((error) => {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  });
});

let frozen: FrozenBlindHistoricalRpcServer | null = null;
let controller: BlindBackendController | null = null;

try {
  const archiveUrl = await listen(archive);
  const prewarmCalls = [
    { lane: "shared", method: "eth_chainId", params: [] },
    { lane: "shared", method: "eth_gasPrice", params: [] },
    {
      lane: "base",
      method: "eth_getBlockByNumber",
      params: ["0x63", false],
    },
    {
      lane: "base",
      method: "eth_getBlockByNumber",
      params: ["0x63", true],
    },
    {
      lane: "source",
      method: "eth_getBlockByNumber",
      params: ["0x64", false],
    },
    {
      lane: "source",
      method: "eth_getBlockByNumber",
      params: ["0x64", true],
    },
  ] as const;
  const keyed = prewarmCalls.map((call) => blindHistoricalRpcCacheKey(call));
  const plan = buildBlindHistoricalPrewarmPlan({
    base,
    source,
    inputs: {
      resolvedConfigSha256: hash32("resolved-config"),
      universeSha256: hash32("universe"),
      activeFamilyManifestSha256: hash32("families"),
      baseGraphViewSha256: hash32("graph"),
    },
    exporter: {
      implementationSha256: hash32("production-exporter"),
      sourceClosureSha256: hash32("production-exporter-closure"),
      requirementSetSha256: hash32("production-requirements"),
    },
    descriptors: [
      { id: "graph-state:pool-1", domain: "graphState", rpcKeys: [keyed[2]!] },
      { id: "funding:provider-1", domain: "funding", rpcKeys: [keyed[0]!] },
      {
        id: "execution:family-1",
        domain: "executionDependencies",
        rpcKeys: [keyed[1]!],
      },
      {
        id: "simulation:family-1",
        domain: "finalSimulation",
        rpcKeys: [keyed[3]!, keyed[4]!, keyed[5]!],
      },
    ],
    calls: prewarmCalls,
  });
  await materializeBlindHistoricalRpcCache({
    plan,
    archiveRpcUrl: archiveUrl,
    outDir: cacheDir,
  });
  assert.equal(
    archiveRequests,
    plan.calls.length,
    "materialization must fetch every frozen descriptor exactly once",
  );
  assert.equal(statSync(cacheDir).mode & 0o077, 0);
  assert.equal(
    statSync(resolve(cacheDir, "manifest.json")).mode & 0o077,
    0,
  );
  assert.equal(
    statSync(resolve(cacheDir, "prewarm-plan.json")).mode & 0o077,
    0,
  );

  const loaded = loadBlindHistoricalRpcCache(
    resolve(cacheDir, "manifest.json"),
  );
  frozen = new FrozenBlindHistoricalRpcServer(loaded);
  const frozenUrl = await frozen.start();
  const replay = await jsonRpc(
    frozenUrl,
    "base",
    "eth_getBlockByNumber",
    ["0x63", false],
  );
  assert.equal(
    (replay.result as { readonly hash?: string }).hash,
    base.hash,
  );
  const shared = await jsonRpc(frozenUrl, "source", "eth_chainId", []);
  assert.equal(shared.result, "0x1");

  const endpointSha256 = sha256(frozenUrl);
  const attestationPath = resolve(root, "backend-attestation.json");
  const issuerKey = "blind historical backend test issuer key >= 32 bytes";
  const unsignedAttestation = {
    schemaVersion: 1 as const,
    profile: "adapter-family-blind-local-backend-attestation-v1" as const,
    upstreamKind: "local-content-addressed-state" as const,
    endpointSha256,
    attestationMode: "trusted-file-hmac-sha256" as const,
    localProcessPid: process.pid,
    frozenManifestSha256: loaded.manifestSha256,
  };
  writeFileSync(
    attestationPath,
    `${canonicalJson({
      ...unsignedAttestation,
      issuerHmacSha256: createHmac("sha256", issuerKey)
        .update(canonicalJson(unsignedAttestation))
        .digest("hex"),
    })}\n`,
    { mode: 0o600 },
  );
  assert.equal(
    validateBackendAttestationArtifact(attestationPath)
      .frozenManifestSha256,
    loaded.manifestSha256,
    "generic artifact validation must accept and bind content-addressed caches",
  );
  const missingFrozenManifestPath = resolve(
    root,
    "backend-attestation-missing-frozen-manifest.json",
  );
  const {
    frozenManifestSha256: _frozenManifestSha256,
    ...missingFrozenManifest
  } = {
    ...unsignedAttestation,
    issuerHmacSha256: hash32("missing-frozen-manifest-hmac"),
  };
  writeFileSync(
    missingFrozenManifestPath,
    `${canonicalJson(missingFrozenManifest)}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => validateBackendAttestationArtifact(missingFrozenManifestPath),
    /unexpected or missing fields/,
    "content-addressed attestations must declare their frozen manifest",
  );
  const unexpectedFrozenManifestPath = resolve(
    root,
    "backend-attestation-unexpected-frozen-manifest.json",
  );
  writeFileSync(
    unexpectedFrozenManifestPath,
    `${canonicalJson({
      ...unsignedAttestation,
      upstreamKind: "local-snapshot",
      issuerHmacSha256: hash32("unexpected-frozen-manifest-hmac"),
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => validateBackendAttestationArtifact(unexpectedFrozenManifestPath),
    /unexpected or missing fields/,
    "non-content-addressed attestations must not claim a frozen manifest",
  );
  const attestation = loadBackendAttestation(
    attestationPath,
    frozenUrl,
    issuerKey,
    loaded.manifestSha256,
  );
  const attestationSha256 = attestation.sha256;
  assert.throws(
    () => loadBackendAttestation(attestationPath, frozenUrl, issuerKey),
    /not bound to the loaded frozen manifest/,
  );
  const anvilBin = process.env.ANVIL_BIN ??
    "/Users/eunice/.foundry/bin/anvil";
  assert(existsSync(anvilBin), `anvil executable missing: ${anvilBin}`);
  controller = new BlindBackendController(
    "127.0.0.1",
    0,
    frozenUrl,
    attestation,
    anvilBin,
    1_000,
    loaded,
  );
  const controllerReady = await controller.start();
  const wrongAnchor = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "prepare",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: "00".repeat(32),
      base: { ...base, hash: hash32("wrong-base") },
      source,
      backendIdentitySha256: attestationSha256,
    }),
  });
  assert.equal(wrongAnchor.status, 400);
  assert.match(
    canonicalJson(await wrongAnchor.json()),
    /frozen cache base hash mismatch/,
  );
  const attemptNonce = "11".repeat(32);
  const preparedResponse = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "prepare",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce,
      base,
      source,
      backendIdentitySha256: attestationSha256,
    }),
  });
  const preparedBody = await preparedResponse.json() as {
    readonly cleanForkId?: string;
    readonly error?: string;
  };
  assert.equal(
    preparedResponse.status,
    200,
    `content-addressed clean-fork prepare failed: ${preparedBody.error ?? ""} ` +
      canonicalJson(frozen.stats()),
  );
  const cleanForkId = String(preparedBody.cleanForkId);
  const revealReadyResponse = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "reveal_request",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce,
      source,
      cleanForkId,
    }),
  });
  assert.equal(revealReadyResponse.status, 200);
  const revealReady = await revealReadyResponse.json() as {
    readonly revealToken: string;
  };
  const releaseResponse = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "release",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce,
      cleanForkId,
      revealToken: revealReady.revealToken,
    }),
  });
  assert.equal(releaseResponse.status, 200);
  const sourceView = await jsonRpc(
    controllerReady.rpcUrl,
    "source",
    "eth_getBlockByNumber",
    ["latest", false],
  );
  assert.equal(
    (sourceView.result as { readonly hash?: string }).hash,
    source.hash,
  );
  const finishResponse = await fetch(controllerReady.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      type: "finish",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce,
      cleanForkId,
    }),
  });
  assert.equal(finishResponse.status, 200);
  const finished = await finishResponse.json() as {
    readonly loopbackRpcCalls?: number;
    readonly nonLoopbackUpstreamRpcCalls?: number;
  };
  assert(Number(finished.loopbackRpcCalls) > 0);
  assert.equal(finished.nonLoopbackUpstreamRpcCalls, 0);
  await controller.close();
  controller = null;

  assert.throws(
    () => new BlindBackendController(
      "127.0.0.1",
      0,
      frozenUrl,
      {
        ...attestation,
        declaration: {
          ...attestation.declaration,
          frozenManifestSha256: hash32("wrong-manifest"),
        },
      },
      anvilBin,
      1_000,
      loaded,
    ),
    /frozen manifest mismatch/,
  );

  const archiveCountAfterFreeze = archiveRequests;
  const miss = await jsonRpc(
    frozenUrl,
    "source",
    "eth_getBalance",
    ["0x0000000000000000000000000000000000000001", "0x64"],
  );
  assert.equal(
    (miss.error as { readonly code?: number }).code,
    -32099,
    "unfrozen reads must fail closed",
  );
  assert.equal(
    archiveRequests,
    archiveCountAfterFreeze,
    "the frozen server must never fall through to archive RPC",
  );
  assert.equal(frozen.stats().misses, 1);
  const taintedController = new BlindBackendController(
    "127.0.0.1",
    0,
    frozenUrl,
    attestation,
    anvilBin,
    1_000,
    loaded,
  );
  await assert.rejects(
    () => taintedController.start(),
    /already tainted by a cache miss/,
  );
  await taintedController.close();

  await frozen.close();
  frozen = null;

  const manifestPath = resolve(cacheDir, "manifest.json");
  const manifestRaw = readFileSync(manifestPath, "utf8");
  const firstObject = loaded.manifest.entries[0]!.objectSha256;
  const objectPath = resolve(cacheDir, "objects", `${firstObject}.json`);
  const objectRaw = readFileSync(objectPath, "utf8");
  writeFileSync(objectPath, `${objectRaw} `, { mode: 0o600 });
  assert.throws(
    () => loadBlindHistoricalRpcCache(manifestPath),
    /object hash mismatch/,
  );
  writeFileSync(objectPath, objectRaw, { mode: 0o600 });
  chmodSync(objectPath, 0o600);

  const planPath = resolve(cacheDir, "prewarm-plan.json");
  const planRaw = readFileSync(planPath, "utf8");
  writeFileSync(planPath, `${planRaw} `, { mode: 0o600 });
  assert.throws(
    () => loadBlindHistoricalRpcCache(manifestPath),
    /plan file hash mismatch/,
  );
  writeFileSync(planPath, planRaw, { mode: 0o600 });
  chmodSync(planPath, 0o600);

  const parsedManifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  writeFileSync(
    manifestPath,
    `${canonicalJson({
      ...parsedManifest,
      archiveProviderIdentitySha256: hash32("tampered-archive"),
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => loadBlindHistoricalRpcCache(manifestPath),
    /content hash mismatch/,
  );
  writeFileSync(manifestPath, manifestRaw, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);

  const targetMarkedCall = {
    lane: "source" as const,
    method: "eth_call",
    params: [{ target_pool: "0xforbidden" }, "0x64"],
  };
  assert.throws(
    () => buildBlindHistoricalPrewarmPlan({
      base,
      source,
      inputs: plan.inputs,
      exporter: plan.exporter,
      descriptors: descriptorsForOneCall(
        blindHistoricalRpcCacheKey(targetMarkedCall),
      ),
      calls: [targetMarkedCall],
    }),
    /forbidden marker target_pool/,
  );
  const mutableCall = {
    lane: "source" as const,
    method: "eth_call",
    params: [{
      to: "0x0000000000000000000000000000000000000001",
    }, "latest"],
  };
  assert.throws(
    () => buildBlindHistoricalPrewarmPlan({
      base,
      source,
      inputs: plan.inputs,
      exporter: plan.exporter,
      descriptors: descriptorsForOneCall(
        blindHistoricalRpcCacheKey(mutableCall),
      ),
      calls: [mutableCall],
    }),
    /mutable block tag/,
  );
  const unrelatedCall = {
    lane: "shared" as const,
    method: "eth_chainId",
    params: [],
  };
  assert.throws(
    () => buildBlindHistoricalPrewarmPlan({
      base,
      source,
      inputs: plan.inputs,
      exporter: plan.exporter,
      descriptors: descriptorsForOneCall(hash32("not-the-call-key")),
      calls: [unrelatedCall],
    }),
    /references unrelated RPC key/,
  );
  assert.throws(
    () => buildBlindHistoricalPrewarmPlan({
      base,
      source,
      inputs: plan.inputs,
      exporter: plan.exporter,
      descriptors: descriptorsForOneCall(
        blindHistoricalRpcCacheKey(unrelatedCall),
      ).filter((descriptor) => descriptor.domain !== "finalSimulation"),
      calls: [unrelatedCall],
    }),
    /omits domain finalSimulation/,
  );

  console.log("adapter family blind content-addressed RPC: ok");
} finally {
  if (controller) await controller.close();
  if (frozen) await frozen.close();
  await close(archive);
  rmSync(root, { recursive: true, force: true });
}

function descriptorsForOneCall(rpcKey: string) {
  return [
    { id: "graph-state:pool-1", domain: "graphState" as const, rpcKeys: [rpcKey] },
    { id: "funding:provider-1", domain: "funding" as const, rpcKeys: [rpcKey] },
    {
      id: "execution:family-1",
      domain: "executionDependencies" as const,
      rpcKeys: [rpcKey],
    },
    {
      id: "simulation:family-1",
      domain: "finalSimulation" as const,
      rpcKeys: [rpcKey],
    },
  ];
}

async function handleArchive(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  archiveRequests++;
  const body = JSON.parse(await readBody(request)) as {
    readonly id?: unknown;
    readonly method?: unknown;
    readonly params?: readonly unknown[];
  };
  let result: unknown;
  if (body.method === "eth_chainId") {
    result = "0x1";
  } else if (body.method === "eth_gasPrice") {
    result = "0x1";
  } else if (
    body.method === "eth_getBlockByNumber" &&
    body.params?.[0] === "0x63"
  ) {
    result = fakeBlock(base, hash32("base-parent"));
  } else if (
    body.method === "eth_getBlockByNumber" &&
    body.params?.[0] === "0x64"
  ) {
    result = fakeBlock(source, base.hash);
  } else {
    response.statusCode = 500;
    response.end("unexpected fake archive request");
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(canonicalJson({
    jsonrpc: "2.0",
    id: body.id ?? null,
    result,
  }));
}

function fakeBlock(
  anchor: typeof base,
  parentHash: string,
): object {
  return {
    number: `0x${anchor.number.toString(16)}`,
    hash: anchor.hash,
    parentHash,
    nonce: "0x0000000000000000",
    sha3Uncles: hash32("empty-uncles"),
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: hash32(`transactions:${anchor.number}`),
    stateRoot: anchor.stateRoot,
    receiptsRoot: hash32(`receipts:${anchor.number}`),
    miner: `0x${"00".repeat(20)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x200",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: `0x${(1_700_000_000 + anchor.number).toString(16)}`,
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x1",
    mixHash: hash32(`mix:${anchor.number}`),
    withdrawalsRoot: hash32(`withdrawals:${anchor.number}`),
    withdrawals: [],
    parentBeaconBlockRoot: hash32(`beacon:${anchor.number}`),
    blobGasUsed: "0x0",
    excessBlobGas: "0x0",
  };
}

async function jsonRpc(
  url: string,
  lane: "base" | "source",
  method: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-blind-fork-lane": lane,
    },
    body: canonicalJson({ jsonrpc: "2.0", id: 7, method, params }),
  });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolveUrl, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("test archive did not bind"));
        return;
      }
      resolveUrl(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) resolveClose();
    else server.close(() => resolveClose());
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf8"))
    );
    request.on("error", rejectBody);
  });
}

function hash32(value: string): string {
  return `0x${sha256(value)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
