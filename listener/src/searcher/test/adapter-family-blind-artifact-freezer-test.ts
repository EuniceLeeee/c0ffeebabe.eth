import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { fileURLToPath } from "node:url";
import {
  blindProductionAuditHash,
  blindProductionCanonicalJson,
  BLIND_PRODUCTION_RAW_PROFILE,
} from "../blind-production-audit.js";
import {
  blindProductionArtifactFileSha256,
  blindProductionArtifactPayloadHash,
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifactDocuments,
} from "../blind-production-artifacts.js";
import {
  BLIND_PROFILE,
  canonicalJson,
  type BlindBlockAnchor,
} from "./adapter-family-blind-contract.js";
import {
  BLIND_ARTIFACT_FREEZER_PROFILE,
  freezeBlindProductionArtifacts,
  type BlindArtifactBootstrap,
  type BlindArtifactFreezerSpec,
} from "./adapter-family-blind-artifact-freezer.js";
import {
  fileSha256,
  readBlindProductionArtifact,
  writeBlindModuleClosure,
} from "./adapter-family-blind-artifacts.js";
import {
  buildBlindRunManifest,
} from "./adapter-family-blind-manifest.js";

const root = mkdtempSync(resolve(tmpdir(), "blind-artifact-freezer-"));

async function main(): Promise<void> {
  const primary = {
    base: anchor(99, "primary-base"),
    source: anchor(100, "primary-source"),
  };
  const heldOut = {
    base: anchor(199, "held-out-base"),
    source: anchor(200, "held-out-source"),
  };
  const fixtures = {
    primary: fixtureDocuments(primary.base, primary.source, "primary"),
    "held-out": fixtureDocuments(
      heldOut.base,
      heldOut.source,
      "held-out",
    ),
  };
  const mismatchFixtures = {
    primary: fixtureDocuments(
      primary.base,
      primary.source,
      "primary-mismatch",
    ),
    "held-out": fixtureDocuments(
      heldOut.base,
      heldOut.source,
      "held-out-mismatch",
    ),
  };
  const producerSource = fakeProducerSource(
    fixtures,
    mismatchFixtures,
  );
  const baselineEntry = resolve(root, "baseline-production.mjs");
  const challengerEntry = resolve(root, "challenger-production.mjs");
  writeFileSync(baselineEntry, producerSource);
  writeFileSync(challengerEntry, producerSource);
  const baselineClosure = resolve(root, "baseline-closure.json");
  const challengerClosure = resolve(root, "challenger-closure.json");
  writeBlindModuleClosure(baselineClosure, baselineEntry);
  writeBlindModuleClosure(challengerClosure, challengerEntry);

  const controllers = await Promise.all(
    [0, 1, 2, 3].map((index) => startFakeController(index)),
  );
  try {
    const backendPaths = controllers.map((controller, index) => {
      const path = resolve(root, `backend-${index}.json`);
      const declaration = {
        schemaVersion: 1,
        profile: "adapter-family-blind-local-backend-attestation-v1",
        upstreamKind: "local-snapshot",
        endpointSha256: hash(`backend-endpoint-${index}`),
        attestationMode: "trusted-file-hmac-sha256",
        localProcessPid: process.pid + index + 101,
        issuerHmacSha256: hash(`backend-hmac-${index}`),
      };
      writeFileSync(path, `${canonicalJson(declaration)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      controller.backendIdentitySha256 = fileSha256(path);
      return path;
    });
    const command = (
      entry: string,
      controllerUrl: string,
      variant = "normal",
    ) => ({
      executable: process.execPath,
      argv: [entry],
      cwd: root,
      env: {
        BLIND_SOURCE_CONTROL_URL: controllerUrl,
        FREEZER_VARIANT: variant,
      },
    });
    const spec: BlindArtifactFreezerSpec = {
      schemaVersion: 1,
      profile: BLIND_ARTIFACT_FREEZER_PROFILE,
      runProfile: BLIND_PROFILE,
      captureTimeoutMs: 10_000,
      primary,
      heldOut,
      producers: {
        baseline: {
          productionEntryPath: baselineEntry,
          productionModuleClosurePath: baselineClosure,
          cases: {
            primary: {
              command: command(baselineEntry, controllers[0]!.url),
              backendIdentityPath: backendPaths[0]!,
            },
            "held-out": {
              command: command(baselineEntry, controllers[1]!.url),
              backendIdentityPath: backendPaths[1]!,
            },
          },
        },
        challenger: {
          productionEntryPath: challengerEntry,
          productionModuleClosurePath: challengerClosure,
          cases: {
            primary: {
              command: command(challengerEntry, controllers[2]!.url),
              backendIdentityPath: backendPaths[2]!,
            },
            "held-out": {
              command: command(challengerEntry, controllers[3]!.url),
              backendIdentityPath: backendPaths[3]!,
            },
          },
        },
      },
    };
    const specPath = resolve(root, "freezer-spec.json");
    writeFileSync(specPath, `${canonicalJson(spec)}\n`, { mode: 0o600 });
    chmodSync(specPath, 0o600);
    assert.equal(
      readFileSync(specPath, "utf8").includes("sourceDeltaPath"),
      false,
      "the caller-facing freezer spec must not accept a source delta",
    );

    const outDir = resolve(root, "frozen");
    const cli = fileURLToPath(
      new URL(
        "./adapter-family-blind-artifact-freezer.ts",
        import.meta.url,
      ),
    );
    const result = await runCli([
      "--import",
      "tsx",
      cli,
      "--spec",
      specPath,
      "--out",
      outDir,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /BLIND_ARTIFACT_BOOTSTRAP=/);
    const bootstrap = JSON.parse(
      readFileSync(resolve(outDir, "artifact-bootstrap.json"), "utf8"),
    ) as BlindArtifactBootstrap;
    assert.equal(bootstrap.untimed, true);
    assert.equal(bootstrap.runProfile, BLIND_PROFILE);
    assert.equal(
      bootstrap.captures.baseline.primary.artifactDocumentsSha256,
      bootstrap.captures.challenger.primary.artifactDocumentsSha256,
    );
    assert.equal(
      bootstrap.captures.baseline["held-out"].artifactDocumentsSha256,
      bootstrap.captures.challenger["held-out"].artifactDocumentsSha256,
    );
    for (const [path, kind] of [
      [
        bootstrap.manifestDraftInputPaths.resolvedConfigPath,
        "resolved-config",
      ],
      [
        bootstrap.manifestDraftInputPaths.universePath,
        "production-universe",
      ],
      [
        bootstrap.manifestDraftInputPaths.activeFamilyManifestPath,
        "active-family-manifest",
      ],
      [
        bootstrap.manifestDraftInputPaths.baseGraphViewPath,
        "base-graph-view",
      ],
      [
        bootstrap.manifestDraftInputPaths.sourceDeltaPath,
        "source-delta",
      ],
    ] as const) {
      readBlindProductionArtifact(path, kind);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const frozenSourceDelta = readBlindProductionArtifact(
      bootstrap.manifestDraftInputPaths.sourceDeltaPath,
      "source-delta",
    );
    assert.equal(
      frozenSourceDelta.payload.anchorHash,
      primary.source.hash,
      "source delta must come from the post-source production record",
    );
    assert.equal(
      frozenSourceDelta.payload.baseGraphViewSha256,
      fileSha256(bootstrap.manifestDraftInputPaths.baseGraphViewPath),
      "source delta must bind the frozen READY graph",
    );
    const producerHarnessPath = resolve(root, "frozen-producer-harness.mjs");
    writeFileSync(producerHarnessPath, "export const frozenHarness = true;\n");
    const manifestCommand = (
      entry: string,
      controllerUrl: string,
    ) => ({
      executable: process.execPath,
      argv: [producerHarnessPath, entry],
      cwd: root,
      env: { BLIND_SOURCE_CONTROL_URL: controllerUrl },
    });
    const trustedPath = (name: string) => fileURLToPath(
      new URL(name, import.meta.url),
    );
    const manifest = buildBlindRunManifest({
      profile: BLIND_PROFILE,
      experimentId: "artifact-freezer-e2e",
      base: primary.base,
      source: primary.source,
      runCountPerSide: 20,
      orderSeed: "artifact-freezer-e2e-order",
      timingLimitMs: 10_000,
      responseTimeoutMs: 20_000,
      ...bootstrap.manifestDraftInputPaths,
      heldOut: {
        base: heldOut.base,
        source: heldOut.source,
        ...bootstrap.manifestDraftInputPaths.heldOut,
      },
      oracleCommitment: hash("independently-sealed-oracle"),
      trusted: {
        runnerPath: trustedPath("./adapter-family-blind-runner.ts"),
        oracleBuilderPath: trustedPath("./adapter-family-blind-oracle.ts"),
        comparatorPath: trustedPath(
          "./adapter-family-blind-comparator.ts",
        ),
        backendControllerPath: trustedPath(
          "./adapter-family-blind-backend-controller.ts",
        ),
        anvilBinaryPath: process.execPath,
      },
      producers: {
        baseline: {
          productionEntryPath: baselineEntry,
          productionModuleClosurePath: baselineClosure,
          producerHarnessPath,
          cases: {
            primary: {
              command: manifestCommand(
                baselineEntry,
                controllers[0]!.url,
              ),
              backendIdentityPath: backendPaths[0]!,
            },
            "held-out": {
              command: manifestCommand(
                baselineEntry,
                controllers[1]!.url,
              ),
              backendIdentityPath: backendPaths[1]!,
            },
          },
        },
        challenger: {
          productionEntryPath: challengerEntry,
          productionModuleClosurePath: challengerClosure,
          producerHarnessPath,
          cases: {
            primary: {
              command: manifestCommand(
                challengerEntry,
                controllers[2]!.url,
              ),
              backendIdentityPath: backendPaths[2]!,
            },
            "held-out": {
              command: manifestCommand(
                challengerEntry,
                controllers[3]!.url,
              ),
              backendIdentityPath: backendPaths[3]!,
            },
          },
        },
      },
    });
    assert.equal(
      manifest.inputs.sourceDelta.sha256,
      fileSha256(bootstrap.manifestDraftInputPaths.sourceDeltaPath),
      "bootstrap paths must feed the strict manifest builder without rewriting",
    );

    await assert.rejects(
      freezeBlindProductionArtifacts({
        ...spec,
        sourceDeltaPath: resolve(root, "caller-forged-source-delta.json"),
      } as unknown as BlindArtifactFreezerSpec, resolve(root, "forged")),
      /unexpected or missing fields/,
      "a caller-supplied source delta must fail before producer capture",
    );
    await assert.rejects(
      freezeBlindProductionArtifacts({
        ...spec,
        producers: {
          ...spec.producers,
          challenger: {
            ...spec.producers.challenger,
            cases: {
              ...spec.producers.challenger.cases,
              primary: {
                ...spec.producers.challenger.cases.primary,
                command: command(
                  challengerEntry,
                  controllers[2]!.url,
                  "mismatch",
                ),
              },
            },
          },
        },
      }, resolve(root, "mismatch")),
      /primary baseline\/challenger semantic artifact inputs differ/,
      "the freezer must reject side-specific semantic input drift",
    );
  } finally {
    await Promise.all(controllers.map((controller) => controller.close()));
  }
}

function fixtureDocuments(
  base: BlindBlockAnchor,
  source: BlindBlockAnchor,
  label: string,
): BlindProductionArtifactDocuments {
  const resolvedConfig = createBlindProductionArtifact("resolved-config", {
    configLoaderFingerprint: hash("config-loader"),
    effectiveConfig: { mode: "production", label },
    effectiveConfigSha256: blindProductionArtifactPayloadHash({
      mode: "production",
      label,
    }),
  });
  const universe = createBlindProductionArtifact("production-universe", {
    builderFingerprint: hash("universe-builder"),
    contentSha256: hash(`universe-${label}`),
    poolCount: 2,
    provenanceSha256: hash(`provenance-${label}`),
  });
  const families = [{
    familyId: "fixture-family",
    kind: "swap",
    descriptorSha256: hash("family-descriptor"),
  }];
  const activeFamilyManifest = createBlindProductionArtifact(
    "active-family-manifest",
    {
      families,
      familyCount: families.length,
      registryFingerprint: hash("registry"),
    },
  );
  const baseCoverage = coverage(base);
  const baseGraphView = createBlindProductionArtifact("base-graph-view", {
    anchorNumber: base.number,
    anchorHash: base.hash,
    completenessWatermark: base.number,
    edgeCount: 1,
    orderedEdgeHash: hash(`base-ordered-${label}`),
    orderedCanonicalEdgeIdHash: hash(`base-canonical-${label}`),
    metadataHash: hash(`base-metadata-${label}`),
    ownershipHash: hash(`base-ownership-${label}`),
    perSourceCoverage: baseCoverage,
    perSourceCoverageSha256:
      blindProductionArtifactPayloadHash(baseCoverage),
  });
  const orderedEdgeIds = [`edge:${label}`];
  const orderedEdgeHash = blindProductionAuditHash(orderedEdgeIds);
  const sourceCoverage = coverage(source);
  const sourceDelta = createBlindProductionArtifact("source-delta", {
    anchorNumber: source.number,
    anchorHash: source.hash,
    completenessWatermark: source.number,
    edgeCount: orderedEdgeIds.length,
    orderedEdgeHash,
    orderedCanonicalEdgeIdHash: orderedEdgeHash,
    metadataHash: hash(`source-metadata-${label}`),
    ownershipHash: hash(`source-ownership-${label}`),
    perSourceCoverage: sourceCoverage,
    perSourceCoverageSha256:
      blindProductionArtifactPayloadHash(sourceCoverage),
    baseGraphViewSha256:
      blindProductionArtifactFileSha256(baseGraphView),
    addedEdgeCount: 1,
    addedEdgeHash: hash(`added-${label}`),
    removedEdgeCount: 0,
    removedEdgeHash: hash(`removed-${label}`),
  });
  return {
    resolvedConfig,
    universe,
    activeFamilyManifest,
    baseGraphView,
    sourceDelta,
  };
}

function coverage(anchorValue: BlindBlockAnchor) {
  return [{
    familyId: "fixture-family",
    sourceId: "fixture-source",
    sourceFingerprint: hash("fixture-source-fingerprint"),
    completeThroughBlock: anchorValue.number,
    completeThroughHash: anchorValue.hash,
  }];
}

function fakeProducerSource(
  normal: Record<"primary" | "held-out", BlindProductionArtifactDocuments>,
  mismatch:
    Record<"primary" | "held-out", BlindProductionArtifactDocuments>,
): string {
  const fixtureSource = (
    documents: BlindProductionArtifactDocuments,
  ) => {
    const {
      sourceDelta: _sourceDelta,
      ...preparedDocuments
    } = documents;
    const receipts = {
      resolvedConfig:
        blindProductionArtifactReceipt(documents.resolvedConfig),
      universe: blindProductionArtifactReceipt(documents.universe),
      activeFamilyManifest:
        blindProductionArtifactReceipt(documents.activeFamilyManifest),
      baseGraphView:
        blindProductionArtifactReceipt(documents.baseGraphView),
      sourceDelta: blindProductionArtifactReceipt(documents.sourceDelta),
    };
    const {
      sourceDelta: _sourceReceipt,
      ...preparedReceipts
    } = receipts;
    const edgeLabel = String(
      documents.sourceDelta.payload.orderedCanonicalEdgeIdHash,
    );
    return {
      documents,
      preparedDocuments,
      receipts,
      preparedReceipts,
      orderedEdgeIds: [
        String(documents.resolvedConfig.payload.effectiveConfig).length > 0
          ? `edge:${String(
              (documents.resolvedConfig.payload.effectiveConfig as {
                label?: unknown;
              }).label,
            )}`
          : `edge:${edgeLabel}`,
      ],
      orderedEdgeHash:
        documents.sourceDelta.payload.orderedCanonicalEdgeIdHash,
    };
  };
  const payload = {
    normal: {
      primary: fixtureSource(normal.primary),
      "held-out": fixtureSource(normal["held-out"]),
    },
    mismatch: {
      primary: fixtureSource(mismatch.primary),
      "held-out": fixtureSource(mismatch["held-out"]),
    },
  };
  return `
import readline from "node:readline";
const fixtures = ${JSON.stringify(payload)};
const variant = process.env.FREEZER_VARIANT === "mismatch" ? "mismatch" : "normal";
let active = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.startsWith("BLIND_PRODUCTION_CONTROL=")) return;
  const control = JSON.parse(line.slice("BLIND_PRODUCTION_CONTROL=".length));
  if (control.type === "prepare") {
    const caseId = control.base.number === 99 ? "primary" : "held-out";
    active = { caseId, nonce: control.attemptNonce, base: control.base };
    const fixture = fixtures[variant][caseId];
    process.stdout.write("BLIND_PRODUCTION_READY=" + JSON.stringify({
      type: "ready",
      profile: "${BLIND_PRODUCTION_RAW_PROFILE}",
      attemptNonce: control.attemptNonce,
      base: control.base,
      artifacts: fixture.preparedReceipts,
      artifactDocuments: fixture.preparedDocuments,
    }) + "\\n");
    return;
  }
  if (control.type !== "source_head" || !active ||
      control.attemptNonce !== active.nonce) {
    process.exitCode = 2;
    return;
  }
  const fixture = fixtures[variant][active.caseId];
  process.stdout.write("BLIND_PRODUCTION_RAW=" + JSON.stringify({
    type: "pass",
    profile: "${BLIND_PRODUCTION_RAW_PROFILE}",
    attemptNonce: active.nonce,
    base: active.base,
    source: control.source,
    artifacts: fixture.receipts,
    artifactDocuments: fixture.documents,
    selectionMode: "production",
    forcedSelectionCount: 0,
    stages: [],
    graph: {
      orderedEdgeIds: fixture.orderedEdgeIds,
      orderedEdgeHash: fixture.orderedEdgeHash,
    },
    pricingCoverage: {
      expectedStateKeys: [],
      resolvedStateKeys: [],
      expectedStateKeyHash: "${blindProductionAuditHash([])}",
      resolvedStateKeyHash: "${blindProductionAuditHash([])}",
      expectedPricedEdgeIds: [],
      resolvedPricedEdgeIds: [],
      expectedPricedEdgeHash: "${blindProductionAuditHash([])}",
      resolvedPricedEdgeHash: "${blindProductionAuditHash([])}",
    },
    telemetry: {
      dynamicCacheGeneration: 1,
      dynamicCacheReset: true,
      sourceDeltaApplied: true,
      freshReadCount: 1,
      batchCount: 1,
      incompleteFamilyIds: [],
    },
    opportunities: [],
  }) + "\\n");
  active = null;
});
`;
}

async function startFakeController(index: number): Promise<{
  readonly url: string;
  backendIdentitySha256: string;
  close(): Promise<void>;
}> {
  let active: {
    nonce: string;
    cleanForkId: string;
    source: BlindBlockAnchor;
    revealToken: string;
  } | null = null;
  const holder = {
    url: "",
    backendIdentitySha256: "",
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose())
      );
    },
  };
  const server = createServer(
    (request, response) => {
      void handleController(request, response, (body) => {
        const type = String(body.type);
        if (type === "prepare") {
          active = {
            nonce: String(body.attemptNonce),
            cleanForkId: hash(`clean-${index}-${String(body.attemptNonce)}`),
            source: body.source as BlindBlockAnchor,
            revealToken: hash(`reveal-${index}-${String(body.attemptNonce)}`),
          };
          return {
            type: "base_ready",
            profile: BLIND_PRODUCTION_RAW_PROFILE,
            attemptNonce: active.nonce,
            backendIdentitySha256: holder.backendIdentitySha256,
            backendAttestationSha256: holder.backendIdentitySha256,
            upstreamKind: "local-snapshot",
            cleanForkId: active.cleanForkId,
            basePreStateRoot:
              (body.base as BlindBlockAnchor).stateRoot,
          };
        }
        if (!active || String(body.attemptNonce) !== active.nonce) {
          throw new Error("fake controller attempt mismatch");
        }
        if (type === "reveal_request") {
          return {
            type: "reveal_ready",
            profile: BLIND_PRODUCTION_RAW_PROFILE,
            attemptNonce: active.nonce,
            cleanForkId: active.cleanForkId,
            revealToken: active.revealToken,
          };
        }
        if (type === "release") {
          return {
            type: "source_revealed",
            profile: BLIND_PRODUCTION_RAW_PROFILE,
            attemptNonce: active.nonce,
            cleanForkId: active.cleanForkId,
            switchedAtMonotonicNs: process.hrtime.bigint().toString(),
            source: active.source,
          };
        }
        if (type === "finish") {
          const finished = {
            type: "finished",
            profile: BLIND_PRODUCTION_RAW_PROFILE,
            attemptNonce: active.nonce,
            cleanForkId: active.cleanForkId,
            loopbackRpcCalls: 1,
            nonLoopbackUpstreamRpcCalls: 0,
          };
          active = null;
          return finished;
        }
        throw new Error("fake controller request type");
      });
    },
  );
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen())
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  holder.url = `http://127.0.0.1:${address.port}/control`;
  return holder;
}

async function handleController(
  request: IncomingMessage,
  response: ServerResponse,
  handle: (body: Record<string, unknown>) => object,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    const result = handle(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        Record<string, unknown>,
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(canonicalJson(result));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

async function runCli(args: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [...args], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolveExit) =>
    child.once("exit", (exitCode) => resolveExit(exitCode))
  );
  return { code, stdout, stderr };
}

function anchor(number: number, label: string): BlindBlockAnchor {
  return {
    number,
    hash: `0x${hash(`${label}-hash`)}`,
    stateRoot: `0x${hash(`${label}-root`)}`,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

void main()
  .then(() => {
    process.stdout.write("adapter family blind artifact freezer: ok\n");
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
