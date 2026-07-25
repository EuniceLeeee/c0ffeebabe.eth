import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLIND_PROFILE,
  BLIND_SCHEMA_VERSION,
  BLIND_TX02_BASE_ANCHOR,
  BLIND_TX02_SOURCE_ANCHOR,
  BLIND_TX02_STRICT_PROFILE,
  BLIND_TX02_TRANSACTION_ID,
  BLIND_TX055_BASE_ANCHOR,
  BLIND_TX055_SOURCE_ANCHOR,
  BLIND_TX055_STRICT_PROFILE,
  BLIND_TX055_TRANSACTION_ID,
  canonicalJson,
  compareBlindRun,
  conversionSeedCommitment,
  exactOrderedHash,
  exactSetHash,
  nearestRankP95,
  revealConversionSelection,
  sealBlindOracle,
  sealProducerOutput,
  validateBlindRunManifest,
  type BlindOracle,
  type BlindProducerOutput,
  type BlindRouteStep,
  type BlindRunManifest,
  type ConversionCandidate,
  type ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";
import {
  assertOracleInvisibleFromProducer,
  compareSealedBlindArtifacts,
} from "./adapter-family-blind-comparator.js";
import {
  buildBlindRunManifest,
  seededInterleavedOrder,
  writeBlindRunManifest,
} from "./adapter-family-blind-manifest.js";
import {
  fileSha256,
  generateBlindProductionArtifact,
  readBlindProductionArtifact,
  writeBlindModuleClosure,
} from "./adapter-family-blind-artifacts.js";
import {
  reserveBlindProducerRuntimePorts,
  runBlindSentinel,
} from "./adapter-family-blind-runner.js";
import {
  blindResolvedRuntimeEnvironment,
} from "../blind-production-sanitize.js";
import {
  blindProductionCanonicalJson,
  blindProductionStageArtifactSha256,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_STAGE_NAMES,
  sealBlindProductionStageArtifact,
  validateBlindProductionControl,
  type BlindProductionStageEvidence,
  type BlindProductionStageSealInput,
} from "../blind-production-audit.js";
import {
  validateProductionPassRecordForFreeze,
} from "./adapter-family-blind-production-raw.js";
import { buildConversionEligibilityPlan } from "./conversion-sentinel-commitment.js";

const root = mkdtempSync(resolve(tmpdir(), "adapter-family-blind-"));

try {
  const baselinePortLease = await reserveBlindProducerRuntimePorts(4);
  const challengerPortLease = await reserveBlindProducerRuntimePorts(4);
  try {
    assert.equal(baselinePortLease.ports.length, 5);
    assert.equal(challengerPortLease.ports.length, 5);
    assert.equal(
      baselinePortLease.ports.some((port) =>
        challengerPortLease.ports.includes(port)
      ),
      false,
      "concurrent producer sessions must receive disjoint Anvil ports",
    );
    for (const lease of [baselinePortLease, challengerPortLease]) {
      assert(
        lease.ports.every((port, index) =>
          index === 0 || port === lease.ports[index - 1]! + 1
        ),
        "block-scan worker lease must remain a contiguous port range",
      );
    }
  } finally {
    await Promise.all([
      baselinePortLease.release(),
      challengerPortLease.release(),
    ]);
  }

  const semanticEnvironment = blindResolvedRuntimeEnvironment({
    SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "100",
    SEARCHER_RUNTIME_COMMIT: "baseline-sha",
    SEARCHER_ANVIL_PORT: "31000",
    SEARCHER_BLOCKSCAN_ANVIL_PORT: "31001",
    SEARCHER_LIVE_RPC_URL: "http://127.0.0.1:32000/rpc",
    SEARCHER_POOL_UNIVERSE_PATH: "/tmp/baseline-universe.json",
    SEARCHER_REVM_SIM_BIN: "/tmp/baseline/revm-sim",
    BLIND_SOURCE_CONTROL_URL: "http://127.0.0.1:32000/control",
  });
  assert.deepEqual(
    semanticEnvironment,
    blindResolvedRuntimeEnvironment({
      SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "100",
      SEARCHER_RUNTIME_COMMIT: "challenger-sha",
      SEARCHER_ANVIL_PORT: "41000",
      SEARCHER_BLOCKSCAN_ANVIL_PORT: "41001",
      SEARCHER_LIVE_RPC_URL: "http://127.0.0.1:42000/rpc",
      SEARCHER_POOL_UNIVERSE_PATH: "/tmp/challenger-universe.json",
      SEARCHER_REVM_SIM_BIN: "/tmp/challenger/revm-sim",
      BLIND_SOURCE_CONTROL_URL: "http://127.0.0.1:42000/control",
    }),
    "runtime commit, local transports and artifact paths are non-semantic leases",
  );
  assert.notDeepEqual(
    semanticEnvironment,
    blindResolvedRuntimeEnvironment({
      SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "101",
      SEARCHER_RUNTIME_COMMIT: "challenger-sha",
      SEARCHER_ANVIL_PORT: "41000",
      SEARCHER_BLOCKSCAN_ANVIL_PORT: "41001",
    }),
    "a real search-policy difference must still change resolved config",
  );
  assert.throws(
    () => blindResolvedRuntimeEnvironment({
      SEARCHER_TARGET_RPC_URL: "http://127.0.0.1:43000/rpc",
    }),
    /rejects target-specific environment/,
    "a transport-shaped name cannot hide target-specific producer input",
  );

  assert.equal(
    BLIND_PRODUCTION_RAW_PROFILE,
    "adapter-family-production-raw-v2",
    "the chained stage-artifact contract must use a new raw profile",
  );
  assert.throws(
    () => validateBlindProductionControl({
      type: "prepare",
      profile: "adapter-family-production-raw-v1",
      attemptNonce: hash("legacy-raw-attempt"),
      base: {
        number: 1,
        hash: hash("legacy-raw-base"),
        stateRoot: hash("legacy-raw-state-root"),
      },
    }),
    /profile mismatch/,
    "a legacy final-derived raw-v1 producer cannot enter the v2 contract",
  );
  assert.throws(
    () => validateProductionPassRecordForFreeze({
      type: "pass",
      profile: "adapter-family-production-raw-v1",
      attemptNonce: hash("legacy-raw-attempt"),
      base: null,
      source: null,
      artifacts: null,
      artifactDocuments: null,
      selectionMode: "production",
      forcedSelectionCount: 0,
      stages: [],
      graph: null,
      pricingCoverage: null,
      telemetry: null,
      opportunities: [],
    } as never, null as never, null as never),
    /production pass profile/,
    "the trusted freezer must reject a legacy raw-v1 pass record",
  );

  const mutableStageOpportunity = {
    rank: 1,
    route: fixtureRoute(hash("stage-mutation-source")),
    refined: false,
    planCount: 0,
    simulation: {
      executed: false,
      success: false,
      profitRaw: "0",
      gasUsed: "0",
      calldataSha256: hash("empty-calldata"),
      standingPosition: false,
    },
    ev: {
      executionStatus: "not_run" as const,
      decision: "reject" as const,
      reason: "not_evaluated",
    },
  };
  const mutableStageInput: BlindProductionStageSealInput = {
    graph: {
      orderedEdgeIds: ["edge:stage-mutation"],
      orderedEdgeHash: exactOrderedHash(["edge:stage-mutation"]),
    },
    pricingCoverage: {
      expectedStateKeys: ["state:stage-mutation"],
      resolvedStateKeys: ["state:stage-mutation"],
      expectedStateKeyHash: exactSetHash(["state:stage-mutation"]),
      resolvedStateKeyHash: exactSetHash(["state:stage-mutation"]),
      expectedPricedEdgeIds: ["priced:stage-mutation"],
      resolvedPricedEdgeIds: ["priced:stage-mutation"],
      expectedPricedEdgeHash: exactSetHash(["priced:stage-mutation"]),
      resolvedPricedEdgeHash: exactSetHash(["priced:stage-mutation"]),
    },
    opportunities: [mutableStageOpportunity],
  };
  const stateStage = sealBlindProductionStageArtifact(
    "state_ready",
    null,
    mutableStageInput,
  );
  const earlyEnumerationStage = sealBlindProductionStageArtifact(
    "enumeration_done",
    stateStage.artifactSha256,
    mutableStageInput,
  );
  const earlyEnumerationJson = blindProductionCanonicalJson(
    earlyEnumerationStage.artifact,
  );
  mutableStageOpportunity.refined = true;
  mutableStageOpportunity.planCount = 1;
  const lateEnumerationStage = sealBlindProductionStageArtifact(
    "enumeration_done",
    stateStage.artifactSha256,
    mutableStageInput,
  );
  assert.equal(
    blindProductionCanonicalJson(earlyEnumerationStage.artifact),
    earlyEnumerationJson,
    "late opportunity mutation must not rewrite an earlier stage artifact",
  );
  assert.equal(Object.isFrozen(earlyEnumerationStage.artifact), true);
  assert.equal(
    Object.isFrozen(
      earlyEnumerationStage.artifact.name === "enumeration_done"
        ? earlyEnumerationStage.artifact.opportunities[0]!.route
        : null,
    ),
    true,
    "stage artifacts must be deeply sealed",
  );
  assert.equal(
    earlyEnumerationStage.artifactSha256,
    lateEnumerationStage.artifactSha256,
    "late refine/planner mutation must not affect the enumeration projection",
  );

  const files = Object.fromEntries([
    "config",
    "universe",
    "active",
    "base-graph",
    "source-delta",
    "held-out-base-graph",
    "held-out-source-delta",
    "baseline-primary-backend",
    "baseline-held-out-backend",
    "challenger-primary-backend",
    "challenger-held-out-backend",
    "baseline-entry",
    "challenger-entry",
  ].map((name) => {
    const isEntry = name.endsWith("-entry");
    const path = resolve(root, `${name}.${isEntry ? "mjs" : "json"}`);
    writeFileSync(
      path,
      isEntry ? "export const blindProductionEntry = true;\n" : `${name}\n`,
    );
    return [name, path];
  }));
  const producerPath = resolve(root, "fixture-producer.mjs");
  writeFileSync(producerPath, fixtureProducerSource());
  const trustedPaths = {
    runner: fileURLToPath(new URL("./adapter-family-blind-runner.ts", import.meta.url)),
    oracleBuilder: fileURLToPath(new URL("./adapter-family-blind-oracle.ts", import.meta.url)),
    comparator: fileURLToPath(new URL("./adapter-family-blind-comparator.ts", import.meta.url)),
  };

  const base = {
    number: 99,
    hash: hash("base-hash"),
    stateRoot: hash("base-root"),
  };
  const source = {
    number: 100,
    hash: hash("source-hash"),
    stateRoot: hash("source-root"),
  };
  const heldOutBase = {
    number: 100,
    hash: hash("held-out-base-hash"),
    stateRoot: hash("held-out-base-root"),
  };
  const heldOutSource = {
    number: 101,
    hash: hash("held-out-source-hash"),
    stateRoot: hash("held-out-source-root"),
  };
  const route = fixtureRoute(source.hash);
  const orderedEdges = fixtureOrderedEdges(source.hash);
  const stateKeys = fixtureStateKeys(source.hash);
  const pricedEdges = fixturePricedEdges(source.hash);
  const oracle: BlindOracle = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: BLIND_PROFILE,
    experimentId: "offline-contract",
    source,
    transactionId: hash("private-transaction"),
    targetRoute: route,
    expectedOrderedEdgeIds: orderedEdges,
    expectedRequiredStateKeys: stateKeys,
    expectedPricedEdgeIds: pricedEdges,
    expectedSimulation: {
      success: true,
      profitRaw: "1",
      gasUsed: "1",
      calldataSha256: hash("generic-calldata"),
      standingPosition: false,
    },
    expectedEv: {
      decision: "reject",
      reason: "below-production-threshold",
    },
  };
  const reveal = sealBlindOracle(oracle, "root-only-oracle-salt");
  generateBlindProductionArtifact(files.config!, "resolved-config", {
    configLoaderFingerprint: hash("fixture-config-loader"),
    effectiveConfig: { dryRun: true, maxCandidates: 20 },
    effectiveConfigSha256: hashCanonical({ dryRun: true, maxCandidates: 20 }),
  });
  generateBlindProductionArtifact(files.universe!, "production-universe", {
    builderFingerprint: hash("fixture-universe-builder"),
    contentSha256: hash("fixture-universe-content"),
    poolCount: 2,
    provenanceSha256: hash("fixture-universe-provenance"),
  });
  generateBlindProductionArtifact(files.active!, "active-family-manifest", {
    families: [{
      familyId: "fixture-family",
      kind: "swap",
      descriptorSha256: hash("fixture-family-descriptor"),
    }],
    familyCount: 1,
    registryFingerprint: hash("fixture-registry"),
  });
  generateBlindProductionArtifact(files["base-graph"]!, "base-graph-view", {
    anchorNumber: base.number,
    anchorHash: base.hash,
    completenessWatermark: base.number,
    edgeCount: 1,
    orderedEdgeHash: hash("fixture-base-edges"),
    orderedCanonicalEdgeIdHash: hash("fixture-base-canonical-edges"),
    metadataHash: hash("fixture-base-metadata"),
    ownershipHash: hash("fixture-base-ownership"),
    perSourceCoverage: [{
      familyId: "fixture-family",
      sourceId: "fixture-source",
      sourceFingerprint: hash("fixture-source-fingerprint"),
      completeThroughBlock: base.number,
      completeThroughHash: base.hash,
    }],
    perSourceCoverageSha256: hashCanonical([{
      familyId: "fixture-family",
      sourceId: "fixture-source",
      sourceFingerprint: hash("fixture-source-fingerprint"),
      completeThroughBlock: base.number,
      completeThroughHash: base.hash,
    }]),
  });
  generateBlindProductionArtifact(files["source-delta"]!, "source-delta", {
    anchorNumber: source.number,
    anchorHash: source.hash,
    completenessWatermark: source.number,
    edgeCount: orderedEdges.length,
    orderedEdgeHash: exactOrderedHash(orderedEdges),
    orderedCanonicalEdgeIdHash: exactOrderedHash(orderedEdges),
    metadataHash: hash("fixture-source-metadata"),
    ownershipHash: hash("fixture-source-ownership"),
    perSourceCoverage: [{
      familyId: "fixture-family",
      sourceId: "fixture-source",
      sourceFingerprint: hash("fixture-source-fingerprint"),
      completeThroughBlock: source.number,
      completeThroughHash: source.hash,
    }],
    perSourceCoverageSha256: hashCanonical([{
      familyId: "fixture-family",
      sourceId: "fixture-source",
      sourceFingerprint: hash("fixture-source-fingerprint"),
      completeThroughBlock: source.number,
      completeThroughHash: source.hash,
    }]),
    baseGraphViewSha256: fileSha256(files["base-graph"]!),
    addedEdgeCount: 1,
    addedEdgeHash: hash("fixture-added-edges"),
    removedEdgeCount: 0,
    removedEdgeHash: hash("fixture-removed-edges"),
  });
  generateBlindProductionArtifact(
    files["held-out-base-graph"]!,
    "base-graph-view",
    {
      anchorNumber: heldOutBase.number,
      anchorHash: heldOutBase.hash,
      completenessWatermark: heldOutBase.number,
      edgeCount: 1,
      orderedEdgeHash: hash("held-out-base-edges"),
      orderedCanonicalEdgeIdHash: hash("held-out-base-canonical-edges"),
      metadataHash: hash("held-out-base-metadata"),
      ownershipHash: hash("held-out-base-ownership"),
      perSourceCoverage: [{
        familyId: "fixture-family",
        sourceId: "fixture-source",
        sourceFingerprint: hash("fixture-source-fingerprint"),
        completeThroughBlock: heldOutBase.number,
        completeThroughHash: heldOutBase.hash,
      }],
      perSourceCoverageSha256: hashCanonical([{
        familyId: "fixture-family",
        sourceId: "fixture-source",
        sourceFingerprint: hash("fixture-source-fingerprint"),
        completeThroughBlock: heldOutBase.number,
        completeThroughHash: heldOutBase.hash,
      }]),
    },
  );
  const heldOutEdges = fixtureOrderedEdges(heldOutSource.hash);
  generateBlindProductionArtifact(
    files["held-out-source-delta"]!,
    "source-delta",
    {
      anchorNumber: heldOutSource.number,
      anchorHash: heldOutSource.hash,
      completenessWatermark: heldOutSource.number,
      edgeCount: heldOutEdges.length,
      orderedEdgeHash: exactOrderedHash(heldOutEdges),
      orderedCanonicalEdgeIdHash: exactOrderedHash(heldOutEdges),
      metadataHash: hash("held-out-source-metadata"),
      ownershipHash: hash("held-out-source-ownership"),
      perSourceCoverage: [{
        familyId: "fixture-family",
        sourceId: "fixture-source",
        sourceFingerprint: hash("fixture-source-fingerprint"),
        completeThroughBlock: heldOutSource.number,
        completeThroughHash: heldOutSource.hash,
      }],
      perSourceCoverageSha256: hashCanonical([{
        familyId: "fixture-family",
        sourceId: "fixture-source",
        sourceFingerprint: hash("fixture-source-fingerprint"),
        completeThroughBlock: heldOutSource.number,
        completeThroughHash: heldOutSource.hash,
      }]),
      baseGraphViewSha256: fileSha256(files["held-out-base-graph"]!),
      addedEdgeCount: 1,
      addedEdgeHash: hash("held-out-added-edges"),
      removedEdgeCount: 0,
      removedEdgeHash: hash("held-out-removed-edges"),
    },
  );
  for (const [index, name] of [
    "baseline-primary-backend",
    "baseline-held-out-backend",
    "challenger-primary-backend",
    "challenger-held-out-backend",
  ].entries()) {
    const backendAttestation = {
      schemaVersion: 1,
      profile: "adapter-family-blind-local-backend-attestation-v1",
      upstreamKind: "local-snapshot",
      endpointSha256: hash(`fixture-loopback-endpoint-${index}`),
      attestationMode: "trusted-file-hmac-sha256",
      localProcessPid: process.pid + index + 1,
      issuerHmacSha256: hash(`fixture-attestation-hmac-${index}`),
    };
    writeFileSync(
      files[name]!,
      `${canonicalJson(backendAttestation)}\n`,
      { mode: 0o600 },
    );
    chmodSync(files[name]!, 0o600);
  }
  const baselineClosurePath = resolve(root, "baseline-module-closure.json");
  const challengerClosurePath = resolve(root, "challenger-module-closure.json");
  const baselineDependencyPath = resolve(root, "baseline-dependency.mjs");
  const challengerDependencyPath = resolve(root, "challenger-dependency.mjs");
  writeFileSync(baselineDependencyPath, "export const dependency = 'baseline';\n");
  writeFileSync(challengerDependencyPath, "export const dependency = 'challenger';\n");
  writeFileSync(
    files["baseline-entry"]!,
    "import './baseline-dependency.mjs';\nexport const blindProductionEntry = true;\n",
  );
  writeFileSync(
    files["challenger-entry"]!,
    "import './challenger-dependency.mjs';\nexport const blindProductionEntry = true;\n",
  );
  writeBlindModuleClosure(baselineClosurePath, files["baseline-entry"]!);
  writeBlindModuleClosure(challengerClosurePath, files["challenger-entry"]!);
  const backendControllerPath = fileURLToPath(
    new URL("./adapter-family-blind-backend-controller.ts", import.meta.url),
  );
  const placeholderConfigPath = resolve(root, "placeholder-config.json");
  writeFileSync(placeholderConfigPath, "config\n", { mode: 0o600 });
  chmodSync(placeholderConfigPath, 0o600);
  assert.throws(
    () => readBlindProductionArtifact(
      placeholderConfigPath,
      "resolved-config",
    ),
    /not JSON/,
    "request-echo placeholder input must not enter a blind manifest",
  );
  const runtimePrivateKey = `0x${"aB".repeat(32)}`;
  const runtimePrivateKeySha256 = hash(runtimePrivateKey);
  const fixtureCommand = (
    productionEntryPath: string,
    controllerPort: number,
  ) => ({
    executable: process.execPath,
    argv: [producerPath, productionEntryPath],
    cwd: root,
    env: {
      BLIND_SOURCE_CONTROL_URL:
        `http://127.0.0.1:${controllerPort}/control`,
    },
    secretEnvRefs: [{
      envName: "PRIVATE_KEY",
      valueSha256: runtimePrivateKeySha256,
    }],
  });
  const manifest = buildBlindRunManifest({
    experimentId: oracle.experimentId,
    base,
    source,
    runCountPerSide: 20,
    orderSeed: "frozen-interleave-seed",
    timingLimitMs: 10_000,
    responseTimeoutMs: 20_000,
    resolvedConfigPath: files.config!,
    universePath: files.universe!,
    activeFamilyManifestPath: files.active!,
    baseGraphViewPath: files["base-graph"]!,
    sourceDeltaPath: files["source-delta"]!,
    heldOut: {
      base: heldOutBase,
      source: heldOutSource,
      resolvedConfigPath: files.config!,
      universePath: files.universe!,
      activeFamilyManifestPath: files.active!,
      baseGraphViewPath: files["held-out-base-graph"]!,
      sourceDeltaPath: files["held-out-source-delta"]!,
    },
    oracleCommitment: reveal.commitment,
    trusted: {
      runnerPath: trustedPaths.runner,
      oracleBuilderPath: trustedPaths.oracleBuilder,
      comparatorPath: trustedPaths.comparator,
      backendControllerPath,
      anvilBinaryPath: process.execPath,
    },
    producers: {
      baseline: {
        productionEntryPath: files["baseline-entry"]!,
        productionModuleClosurePath: baselineClosurePath,
        producerHarnessPath: producerPath,
        cases: {
          primary: {
            command: fixtureCommand(files["baseline-entry"]!, 32_001),
            backendIdentityPath: files["baseline-primary-backend"]!,
          },
          "held-out": {
            command: fixtureCommand(files["baseline-entry"]!, 32_002),
            backendIdentityPath: files["baseline-held-out-backend"]!,
          },
        },
      },
      challenger: {
        productionEntryPath: files["challenger-entry"]!,
        productionModuleClosurePath: challengerClosurePath,
        producerHarnessPath: producerPath,
        cases: {
          primary: {
            command: fixtureCommand(files["challenger-entry"]!, 42_001),
            backendIdentityPath: files["challenger-primary-backend"]!,
          },
          "held-out": {
            command: fixtureCommand(files["challenger-entry"]!, 42_002),
            backendIdentityPath: files["challenger-held-out-backend"]!,
          },
        },
      },
    },
  });

  validateBlindRunManifest(manifest);
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      producers: {
        ...manifest.producers,
        baseline: {
          ...manifest.producers.baseline,
          cases: {
            ...manifest.producers.baseline.cases,
            "held-out": {
              ...manifest.producers.baseline.cases["held-out"],
              command: manifest.producers.baseline.cases.primary.command,
            },
          },
        },
      },
    }),
    /independent controller endpoint/,
    "each side/case session must own a distinct trusted controller",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      producers: {
        ...manifest.producers,
        baseline: {
          ...manifest.producers.baseline,
          cases: {
            ...manifest.producers.baseline.cases,
            "held-out": {
              ...manifest.producers.baseline.cases["held-out"],
              backendIdentity:
                manifest.producers.baseline.cases.primary.backendIdentity,
            },
          },
        },
      },
    }),
    /independent backend attestation/,
    "each side/case session must own a distinct backend attestation",
  );
  const tx055StrictManifest: BlindRunManifest = {
    ...manifest,
    profile: BLIND_TX055_STRICT_PROFILE,
    base: BLIND_TX055_BASE_ANCHOR,
    source: BLIND_TX055_SOURCE_ANCHOR,
    timingLimitMs: 10_000,
  };
  validateBlindRunManifest(tx055StrictManifest);
  sealBlindOracle({
    ...oracle,
    profile: BLIND_TX055_STRICT_PROFILE,
    source: BLIND_TX055_SOURCE_ANCHOR,
    transactionId: BLIND_TX055_TRANSACTION_ID,
  }, "tx055-strict-oracle-salt");
  assert.throws(
    () => sealBlindOracle({
      ...oracle,
      profile: BLIND_TX055_STRICT_PROFILE,
      source: BLIND_TX055_SOURCE_ANCHOR,
    }, "tx055-wrong-oracle-salt"),
    /tx055 strict oracle transaction/,
    "tx055 strict profile must pin the target transaction",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx055StrictManifest,
      base: {
        ...BLIND_TX055_BASE_ANCHOR,
        stateRoot: hash("wrong-tx055-base-root"),
      },
    }),
    /tx055 strict profile base anchor/,
    "tx055 strict profile must pin the base block hash and state root",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx055StrictManifest,
      source: {
        ...BLIND_TX055_SOURCE_ANCHOR,
        hash: hash("wrong-tx055-source-hash"),
      },
    }),
    /tx055 strict profile source anchor/,
    "tx055 strict profile must pin the source block hash and state root",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx055StrictManifest,
      timingLimitMs: 9_999,
    }),
    /timingLimitMs must equal 10000/,
    "tx055 strict profile must pin the ten-second threshold",
  );
  const tx02StrictManifest: BlindRunManifest = {
    ...manifest,
    profile: BLIND_TX02_STRICT_PROFILE,
    base: BLIND_TX02_BASE_ANCHOR,
    source: BLIND_TX02_SOURCE_ANCHOR,
    timingLimitMs: 10_000,
  };
  validateBlindRunManifest(tx02StrictManifest);
  sealBlindOracle({
    ...oracle,
    profile: BLIND_TX02_STRICT_PROFILE,
    source: BLIND_TX02_SOURCE_ANCHOR,
    transactionId: BLIND_TX02_TRANSACTION_ID,
  }, "tx02-strict-oracle-salt");
  assert.throws(
    () => sealBlindOracle({
      ...oracle,
      profile: BLIND_TX02_STRICT_PROFILE,
      source: BLIND_TX02_SOURCE_ANCHOR,
    }, "tx02-wrong-oracle-salt"),
    /tx02 strict oracle transaction/,
    "tx02 strict profile must pin the target transaction",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx02StrictManifest,
      base: {
        ...BLIND_TX02_BASE_ANCHOR,
        stateRoot: hash("wrong-tx02-base-root"),
      },
    }),
    /tx02 strict profile base anchor/,
    "tx02 strict profile must pin the base block hash and state root",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx02StrictManifest,
      source: {
        ...BLIND_TX02_SOURCE_ANCHOR,
        hash: hash("wrong-tx02-source-hash"),
      },
    }),
    /tx02 strict profile source anchor/,
    "tx02 strict profile must pin the source block hash and state root",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...tx02StrictManifest,
      timingLimitMs: 9_999,
    }),
    /tx02 strict profile timingLimitMs must equal 10000/,
    "tx02 strict profile must pin the ten-second threshold",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      heldOut: undefined as never,
    }),
    /held-out case is required/,
    "held-out input case is mandatory",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      runOrder: manifest.runOrder.filter(
        (entry) => entry.caseId !== "held-out",
      ),
    }),
    /runOrder must contain 42 entries/,
    "twenty repeats of the fixed pair cannot replace the held-out control",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      heldOut: {
        ...manifest.heldOut,
        base: manifest.base,
        source: manifest.source,
      },
    }),
    /held-out block pair must differ/,
    "held-out cannot alias the primary fixed block pair",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      heldOut: {
        ...manifest.heldOut,
        source: {
          ...manifest.heldOut.source,
          number: manifest.heldOut.base.number + 2,
        },
      },
    }),
    /held-out must bind adjacent/,
    "held-out anchors must remain adjacent",
  );
  assert.equal(
    canonicalJson(manifest).includes(runtimePrivateKey),
    false,
    "manifest must bind only the runtime secret reference/hash",
  );
  const writtenManifestPath = resolve(root, "blind-manifest.json");
  writeBlindRunManifest(writtenManifestPath, manifest);
  assert.equal(
    statSync(writtenManifestPath).mode & 0o777,
    0o600,
    "trusted manifest must remain owner-only",
  );
  assert.equal(manifest.runOrder.length, 42);
  assert.deepEqual(
    seededInterleavedOrder(20, "frozen-interleave-seed"),
    manifest.runOrder,
    "run order must be frozen and reproducible",
  );
  const baselinePrimaryCommand =
    manifest.producers.baseline.cases.primary.command;
  const withBaselinePrimaryCommand = (
    command: typeof baselinePrimaryCommand,
  ): BlindRunManifest => ({
    ...manifest,
    producers: {
      ...manifest.producers,
      baseline: {
        ...manifest.producers.baseline,
        cases: {
          ...manifest.producers.baseline.cases,
          primary: {
            ...manifest.producers.baseline.cases.primary,
            command,
          },
        },
      },
    },
  });
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      env: { PRIVATE_KEY: runtimePrivateKey },
    })),
    /must use a runtime secret reference/,
    "plain secret values must never enter the manifest",
  );
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      env: { WALLET_KEY: runtimePrivateKey },
    })),
    /runtime secret reference/,
    "secret aliases must use the trusted runtime injection path",
  );
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      env: { INNOCENT_ALIAS: runtimePrivateKey },
    })),
    /private-key-shaped/,
    "a renamed private key must not bypass manifest validation",
  );
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      argv: [...baselinePrimaryCommand.argv, runtimePrivateKey],
    })),
    /secret-shaped/,
    "a private key must not enter the manifest through argv",
  );
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      env: { AB_EXPECTED_ROUTE_JSON: "hidden" },
    })),
    /forbidden marker/,
    "producer-facing expected route must fail closed",
  );
  assert.throws(
    () => validateBlindRunManifest(withBaselinePrimaryCommand({
      ...baselinePrimaryCommand,
      env: { SOURCE_HASH_EARLY: source.hash },
    })),
    /(?:exposes source-N anchor|private-key-shaped)/,
    "the production process must not learn source N from argv/env",
  );
  assert.throws(
    () => validateBlindRunManifest({
      ...manifest,
      producers: {
        ...manifest.producers,
        challenger: {
          ...manifest.producers.challenger,
          producerHarness: {
            ...manifest.producers.challenger.producerHarness,
            sha256: hash("different-harness"),
          },
        },
      },
    }),
    /byte-identical producer harness/,
    "both sides must run the same frozen production bridge bytes",
  );

  const frozenConfigContents = readFileSync(files.config!, "utf8");
  writeFileSync(files.config!, "tampered-config\n");
  await assert.rejects(
    runBlindSentinel(manifest, resolve(root, "tampered-run")),
    /(?:not JSON|frozen artifact hash mismatch)/,
    "trusted runner must re-hash every frozen producer input before execution",
  );
  writeFileSync(files.config!, frozenConfigContents);
  const heldOutDeltaContents = readFileSync(
    files["held-out-source-delta"]!,
    "utf8",
  );
  writeFileSync(files["held-out-source-delta"]!, "tampered-held-out\n");
  await assert.rejects(
    runBlindSentinel(manifest, resolve(root, "tampered-held-out")),
    /(?:not JSON|frozen artifact hash mismatch)/,
    "trusted runner must independently hash the held-out input set",
  );
  writeFileSync(
    files["held-out-source-delta"]!,
    heldOutDeltaContents,
  );
  const baselineDependencyContents = readFileSync(
    baselineDependencyPath,
    "utf8",
  );
  writeFileSync(
    baselineDependencyPath,
    `${baselineDependencyContents}// tampered\n`,
  );
  await assert.rejects(
    runBlindSentinel(manifest, resolve(root, "tampered-module-closure")),
    /production module import closure changed/,
    "trusted runner must bind the transitive production module closure",
  );
  writeFileSync(baselineDependencyPath, baselineDependencyContents);

  const runDir = resolve(root, "run");
  await assert.rejects(
    runBlindSentinel(manifest, resolve(root, "missing-secret-allowlist"), {
      runtimeEnv: { PRIVATE_KEY: runtimePrivateKey },
    }),
    /is not allowlisted/,
    "runtime secrets require an explicit trusted-runner allowlist",
  );
  await assert.rejects(
    runBlindSentinel(manifest, resolve(root, "wrong-secret-value"), {
      secretEnvAllowlist: ["PRIVATE_KEY"],
      runtimeEnv: { PRIVATE_KEY: `0x${"22".repeat(32)}` },
    }),
    /hash mismatch/,
    "runtime secret injection must match the frozen presence hash",
  );
  const runStartedAtMs = performance.now();
  const executed = await runBlindSentinel(manifest, runDir, {
    secretEnvAllowlist: ["PRIVATE_KEY"],
    runtimeEnv: { PRIVATE_KEY: runtimePrivateKey },
  });
  const runWallMs = performance.now() - runStartedAtMs;
  assert.equal(executed.report.attempts.length, 42);
  assert(executed.report.attempts.every((attempt) => attempt.status === "sealed"));
  assert.equal(executed.outputs.length, 42);
  assert.throws(
    () => sealProducerOutput({
      ...executed.outputs[0]!.output,
      artifactReceipts: {
        ...executed.outputs[0]!.output.artifactReceipts,
        sourceDelta: {
          ...executed.outputs[0]!.output.artifactReceipts.sourceDelta,
          consumed: false,
        } as never,
      },
    }, executed.outputs[0]!.runnerElapsedMs),
    /was not consumed/,
    "an unused frozen artifact cannot be represented by a request echo",
  );
  assert(
    executed.outputs.every((entry) => entry.runnerElapsedMs >= 20),
    "trusted timing must include the post-release source-switch acknowledgement",
  );
  assert.notEqual(base.stateRoot, source.stateRoot);
  assert(
    executed.outputs.every((entry) =>
      entry.output.telemetry.basePreStateRoot ===
        (entry.output.caseId === "primary"
          ? base.stateRoot
          : heldOutBase.stateRoot) &&
      entry.output.telemetry.sourceStateRoot ===
        (entry.output.caseId === "primary"
          ? source.stateRoot
          : heldOutSource.stateRoot)
    ),
    "every sealed attempt binds distinct N-1 and source-N state roots",
  );
  assert.equal(
    JSON.parse(readFileSync(resolve(runDir, "sealed-producer-outputs.json"), "utf8")).length,
    42,
  );
  for (const artifact of [
    "sealed-producer-outputs.json",
    "blind-runner-report.json",
    "baseline-producer.stdout.log",
    "baseline-producer.stderr.log",
    "challenger-producer.stdout.log",
    "challenger-producer.stderr.log",
    "baseline-primary-producer.stdout.log",
    "baseline-primary-producer.stderr.log",
    "baseline-held-out-producer.stdout.log",
    "baseline-held-out-producer.stderr.log",
    "challenger-primary-producer.stdout.log",
    "challenger-primary-producer.stderr.log",
    "challenger-held-out-producer.stdout.log",
    "challenger-held-out-producer.stderr.log",
  ]) {
    const path = resolve(runDir, artifact);
    const artifactContents = readFileSync(path, "utf8");
    assert.equal(
      artifactContents.includes(runtimePrivateKey),
      false,
      `${artifact} must not contain a runtime secret`,
    );
    assert.equal(
      artifactContents.includes(runtimePrivateKey.slice(2).toUpperCase()),
      false,
      `${artifact} must not contain a normalized runtime secret`,
    );
    assert.equal(
      statSync(path).mode & 0o777,
      0o600,
      `${artifact} must remain owner-only`,
    );
  }
  assert(
    ["baseline", "challenger"].every((side) =>
      readFileSync(resolve(runDir, `${side}-producer.stderr.log`), "utf8")
        .includes("[REDACTED:PRIVATE_KEY]")
    ),
    "trusted runner must redact runtime secrets emitted by a producer",
  );
  const runtimePortRanges = [
    ...fixtureRuntimePortRanges(
      readFileSync(resolve(runDir, "baseline-producer.stderr.log"), "utf8"),
    ),
    ...fixtureRuntimePortRanges(
      readFileSync(resolve(runDir, "challenger-producer.stderr.log"), "utf8"),
    ),
  ];
  assert.equal(runtimePortRanges.length, 4);
  runtimePortRanges.forEach((ports, index) => {
    const otherPorts = runtimePortRanges
      .filter((_, otherIndex) => otherIndex !== index)
      .flat();
    assert.equal(
      ports.some((port) => otherPorts.includes(port)),
      false,
      "runner-injected producer Anvil ranges must remain pairwise disjoint",
    );
  });
  const timedMs = executed.outputs.reduce(
    (sum, output) => sum + output.runnerElapsedMs,
    0,
  );
  assert(
    runWallMs - timedMs >= 1_500,
    "trusted runner timing must exclude the harness source-backend reveal delay",
  );

  const report = compareSealedBlindArtifacts({
    manifest,
    outputs: executed.outputs,
    reveal,
  });
  assert.equal(report.semanticStatus, "pass");
  assert.equal(report.timingStatus, "pass");
  assert.equal(report.overall, "pass");
  assert.equal(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);

  const forced = executed.outputs.map((entry, index) => index === 0
    ? sealProducerOutput(
      { ...entry.output, forcedSelectionCount: 1 },
      entry.runnerElapsedMs,
    )
    : entry);
  const forcedReport = compareBlindRun(manifest, forced, reveal);
  assert.equal(forcedReport.semanticStatus, "fail");
  assert(
    forcedReport.failures.some((failure) => failure.includes("naturally selected")),
    "forced selection must be visible in comparator failures",
  );

  const wrongDelta = executed.outputs.map((entry, index) => index === 0
    ? sealProducerOutput({
      ...entry.output,
      sourceDeltaSha256: hash("wrong-source-delta"),
      artifactReceipts: {
        ...entry.output.artifactReceipts,
        sourceDelta: {
          ...entry.output.artifactReceipts.sourceDelta,
          sha256: hash("wrong-source-delta"),
        },
      },
    }, entry.runnerElapsedMs)
    : entry);
  const wrongDeltaReport = compareBlindRun(manifest, wrongDelta, reveal);
  assert.equal(wrongDeltaReport.semanticStatus, "fail");
  assert(
    wrongDeltaReport.failures.some((failure) => failure.includes("N source delta mismatch")),
    "baseline and challenger must prove the same frozen N delta",
  );

  const conflatedRoots = executed.outputs.map((entry, index) => index === 0
    ? sealProducerOutput({
      ...entry.output,
      telemetry: {
        ...entry.output.telemetry,
        basePreStateRoot: entry.output.telemetry.sourceStateRoot,
      },
    }, entry.runnerElapsedMs)
    : entry);
  const conflatedRootsReport = compareBlindRun(manifest, conflatedRoots, reveal);
  assert.equal(conflatedRootsReport.semanticStatus, "fail");
  assert(
    conflatedRootsReport.failures.some((failure) =>
      failure.includes("fresh local source-state evidence incomplete")
    ),
    "the comparator must reject a source root relabelled as the N-1 root",
  );

  const failedSimulation = executed.outputs.map((entry, index) => index === 0
    ? sealProducerOutput(resealProductionStages(entry.output, {
      opportunities: entry.output.opportunities.map((opportunity, opportunityIndex) =>
        opportunityIndex === 0
          ? {
            ...opportunity,
            simulation: { ...opportunity.simulation, success: false },
          }
          : opportunity),
    }), entry.runnerElapsedMs)
    : entry);
  const failedSimulationReport = compareBlindRun(manifest, failedSimulation, reveal);
  assert.equal(failedSimulationReport.semanticStatus, "fail");
  assert(
    failedSimulationReport.failures.some((failure) =>
      failure.includes("did not complete six-stage execution")),
    "failed final simulation cannot satisfy the six-stage semantic contract",
  );

  const sharedWrongCalldata = executed.outputs.map((entry) =>
    sealProducerOutput(resealProductionStages(entry.output, {
      opportunities: entry.output.opportunities.map((opportunity) => ({
        ...opportunity,
        simulation: {
          ...opportunity.simulation,
          calldataSha256: hash("same-wrong-calldata-on-both-sides"),
        },
      })),
    }), entry.runnerElapsedMs)
  );
  const sharedWrongCalldataReport = compareBlindRun(
    manifest,
    sharedWrongCalldata,
    reveal,
  );
  assert.equal(sharedWrongCalldataReport.semanticStatus, "fail");
  assert(
    sharedWrongCalldataReport.failures.some((failure) =>
      failure.includes("did not complete six-stage execution")
    ),
    "byte-identical but oracle-wrong calldata must not pass",
  );

  const timingTampered = executed.outputs.map((entry, index) => index === 0
    ? { ...entry, runnerElapsedMs: 0 }
    : entry);
  const timingTamperedReport = compareBlindRun(
    manifest,
    timingTampered,
    reveal,
  );
  assert.equal(timingTamperedReport.semanticStatus, "fail");
  assert(
    timingTamperedReport.failures.some((failure) =>
      failure.includes("timing envelope seal mismatch")
    ),
    "elapsed/stamp edits must invalidate the trusted timing envelope",
  );

  const slow = executed.outputs.map((entry) =>
    sealProducerOutput(entry.output, 10_000)
  );
  const slowReport = compareBlindRun(manifest, slow, reveal);
  assert.equal(slowReport.semanticStatus, "pass");
  assert.equal(slowReport.timingStatus, "fail");
  assert.equal(slowReport.overall, "implemented_not_validated");

  const oneOutput = executed.outputs[0]!.output;
  assert.throws(
    () => sealProducerOutput({
      ...oneOutput,
      telemetry: {
        ...oneOutput.telemetry,
        backendUpstreamKind: "test-fixture",
      },
    } as unknown as BlindProducerOutput, 5),
    /backend upstream kind/,
    "strict producer evidence must reject fixture-only backend labels",
  );
  assert.throws(
    () => sealProducerOutput({
      ...oneOutput,
      stages: oneOutput.stages.slice(0, 5),
    } as BlindProducerOutput, 5),
    /six stages/,
    "missing physical stage must not seal",
  );
  const enumerationStage = oneOutput.stages[1]!;
  if (enumerationStage.artifact.name !== "enumeration_done") {
    throw new Error("fixture enumeration stage artifact mismatch");
  }
  const tamperedEnumerationArtifact = {
    ...enumerationStage.artifact,
    opportunities: enumerationStage.artifact.opportunities.map(
      (opportunity, index) =>
        index === 0
          ? { ...opportunity, rank: opportunity.rank + 1 }
          : opportunity,
    ),
  };
  assert.throws(
    () => sealProducerOutput({
      ...oneOutput,
      stages: oneOutput.stages.map((stage, index) =>
        index === 1
          ? {
              ...stage,
              artifact: tamperedEnumerationArtifact,
            } as BlindProductionStageEvidence
          : stage
      ),
    }, 5),
    /stage artifact hash mismatch/,
    "editing a stage artifact without its hash must not seal",
  );
  assert.throws(
    () => sealProducerOutput({
      ...oneOutput,
      stages: oneOutput.stages.map((stage, index) =>
        index === oneOutput.stages.length - 1
          ? {
              ...stage,
              artifactSha256: hash("tampered-stage-hash"),
            }
          : stage
      ),
    }, 5),
    /stage artifact hash mismatch/,
    "editing a stage artifact hash must not seal",
  );
  const refineStage = oneOutput.stages[2]!;
  if (refineStage.artifact.name !== "exact_refine_done") {
    throw new Error("fixture refine stage artifact mismatch");
  }
  const brokenChainArtifact = {
    ...refineStage.artifact,
    previousArtifactSha256: hash("wrong-previous-stage"),
  };
  assert.throws(
    () => sealProducerOutput({
      ...oneOutput,
      stages: oneOutput.stages.map((stage, index) =>
        index === 2
          ? {
              ...stage,
              artifact: brokenChainArtifact,
              artifactSha256:
                blindProductionStageArtifactSha256(brokenChainArtifact),
            } as BlindProductionStageEvidence
          : stage
      ),
    }, 5),
    /previous artifact hash chain/,
    "a rehashed artifact with a broken previous-stage link must not seal",
  );

  const leakedManifest = withBaselinePrimaryCommand({
    ...baselinePrimaryCommand,
    env: {
      ...baselinePrimaryCommand.env,
      SAFE_LABEL: route[0]!.target,
    },
  });
  assert.throws(
    () => assertOracleInvisibleFromProducer(leakedManifest, reveal),
    /sealed oracle value/,
    "post-hoc comparator must audit direct oracle-value leakage",
  );

  const conversionSecret = { seed: "root-only-seed", salt: "root-only-salt" };
  const conversionInput = {
    range: {
      fromBlock: 1_000,
      toBlock: 2_000,
      rangeHash: hash("conversion-range"),
    },
    predicateVersion: "erc4626-or-wsteth-update-v1",
    predicateSha256: hash("conversion-predicate"),
    productionInputsSha256: hash("conversion-production-inputs"),
    minEligibleCardinality: 32,
    selectionAlgorithm: "sha256-seeded-order-v1" as const,
  };
  const conversionPlan = buildConversionEligibilityPlan(conversionInput, conversionSecret);
  const candidates: ConversionCandidate[] = Array.from({ length: 32 }, (_, index) => ({
    id: `opaque-candidate-${index}`,
    sourceBlock: 1_100 + index,
    evidenceSha256: hash(`candidate-${index}`),
  }));
  const selected = revealConversionSelection({
    plan: conversionPlan,
    candidates,
    ...conversionSecret,
  });
  const selectedReordered = revealConversionSelection({
    plan: conversionPlan,
    candidates: [...candidates].reverse(),
    ...conversionSecret,
  });
  assert.equal(selected.freshnessEvidence, "selected");
  assert.equal(selected.selected?.id, selectedReordered.selected?.id);
  assert.equal(selected.eligibleSetSha256, selectedReordered.eligibleSetSha256);
  assert.equal(
    conversionPlan.seedCommitment,
    conversionSeedCommitment({
      ...conversionSecret,
      rangeHash: conversionInput.range.rangeHash,
      predicateSha256: conversionInput.predicateSha256,
      productionInputsSha256: conversionInput.productionInputsSha256,
    }),
  );
  assert.equal(
    conversionPlan.seedCommitment,
    hash(
      conversionSecret.seed +
        conversionSecret.salt +
        conversionInput.range.rangeHash +
        conversionInput.predicateSha256 +
        conversionInput.productionInputsSha256,
    ),
    "commitment must bind seed, range, predicate and frozen production inputs",
  );
  assert.throws(
    () => revealConversionSelection({
      plan: conversionPlan,
      candidates,
      seed: "wrong",
      salt: conversionSecret.salt,
    }),
    /seed reveal mismatch/,
  );
  assert.equal(
    revealConversionSelection({
      plan: conversionPlan,
      candidates: candidates.slice(0, 31),
      ...conversionSecret,
    }).freshnessEvidence,
    "missing",
    "too-small frozen candidate set must not be hand-picked",
  );
  assert.throws(
    () => buildConversionEligibilityPlan({
      ...conversionInput,
      minEligibleCardinality: 1,
    }, conversionSecret),
    />= 32/,
  );

  console.log("adapter-family-blind-contract PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function fixtureProducerSource(): string {
  return `
import readline from "node:readline";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const productionEntry = await import(pathToFileURL(process.argv[2]).href);
if (productionEntry.blindProductionEntry !== true) {
  throw new Error("fixture harness did not load its frozen production entry");
}
if (!/^0x[0-9a-f]{64}$/i.test(process.env.PRIVATE_KEY ?? "")) {
  throw new Error("fixture harness did not receive the trusted runtime secret");
}
process.stderr.write("fixture-secret-redaction=" + process.env.PRIVATE_KEY + "\\n");
process.stderr.write(
  "fixture-secret-normalized=" +
    process.env.PRIVATE_KEY.slice(2).toUpperCase() +
    "\\n",
);
process.stderr.write(
  "fixture-runtime-ports=" +
    process.env.SEARCHER_ANVIL_PORT + "," +
    process.env.SEARCHER_BLOCKSCAN_ANVIL_PORT + "\\n",
);
const h = (value) => crypto.createHash("sha256").update(value).digest("hex");
const route = (sourceHash) => [{
  familyId: "family:" + h(sourceHash + ":family").slice(0, 12),
  adapterId: "adapter:" + h(sourceHash + ":adapter").slice(0, 12),
  target: "0x" + h(sourceHash + ":target").slice(0, 40),
  tokenIn: "0x" + h(sourceHash + ":token-in").slice(0, 40),
  tokenOut: "0x" + h(sourceHash + ":token-out").slice(0, 40),
  executionVariantKey: h(sourceHash + ":variant"),
}];
const orderedEdges = (sourceHash) => ["edge:" + h(sourceHash + ":edge")];
const stateKeys = (sourceHash) => ["state:" + h(sourceHash + ":state")];
const pricedEdges = (sourceHash) => ["priced:" + h(sourceHash + ":priced")];
const canonical = (value) => JSON.stringify(canon(value));
const canon = (value) => Array.isArray(value) ? value.map(canon)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]))
    : value;
const exactOrderedHash = (values) => h(canonical(values));
const exactSetHash = (values) => h(canonical([...new Set(values)].sort()));
const rl = readline.createInterface({ input: process.stdin });
let pendingReveal = null;
let pendingRun = null;
let generation = 0;
let sessionCaseId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "close") {
    process.exit(0);
  }
  if (message.type === "prepare") {
    if (sessionCaseId === null) sessionCaseId = message.caseId;
    if (sessionCaseId !== message.caseId) {
      throw new Error(
        "fixture production session reused across primary and held-out cases",
      );
    }
    process.stdout.write("BLIND_PRODUCER_BASE_READY=" + JSON.stringify({
      type: "base_ready",
      schemaVersion: message.schemaVersion,
      profile: message.profile,
      experimentId: message.experimentId,
      caseId: message.caseId,
      side: message.side,
      runIndex: message.runIndex,
    }) + "\\n");
    return;
  }
  if (message.type === "reveal_request") {
    if (pendingReveal || pendingRun) throw new Error("overlapping fixture reveal");
    const revealToken = h(
      "reveal:" + message.experimentId + ":" + message.caseId + ":" +
        message.side + ":" + message.runIndex,
    );
    pendingReveal = { request: message, revealToken };
    setTimeout(() => {
      process.stdout.write("BLIND_PRODUCER_REVEAL_READY=" + JSON.stringify({
        type: "reveal_ready",
        schemaVersion: message.schemaVersion,
        profile: message.profile,
        experimentId: message.experimentId,
        caseId: message.caseId,
        side: message.side,
        runIndex: message.runIndex,
        revealToken,
      }) + "\\n");
    }, 50);
    return;
  }
  if (message.type === "reveal_release") {
    if (!pendingReveal || pendingRun) {
      throw new Error("fixture expected pending source reveal");
    }
    if (
      message.revealToken !== pendingReveal.revealToken ||
      message.experimentId !== pendingReveal.request.experimentId ||
      message.caseId !== pendingReveal.request.caseId ||
      message.side !== pendingReveal.request.side ||
      message.runIndex !== pendingReveal.request.runIndex
    ) {
      throw new Error("fixture reveal release mismatch");
    }
    const releaseToken = h(
      "source:" + message.experimentId + ":" + message.caseId + ":" +
        message.side + ":" + message.runIndex,
    );
    const switchedAtMonotonicNs = process.hrtime.bigint().toString();
    pendingRun = { request: pendingReveal.request, releaseToken };
    pendingReveal = null;
    setTimeout(() => {
      process.stdout.write("BLIND_PRODUCER_SOURCE_REVEALED=" + JSON.stringify({
        type: "source_revealed",
        schemaVersion: message.schemaVersion,
        profile: message.profile,
        experimentId: message.experimentId,
        caseId: message.caseId,
        side: message.side,
        runIndex: message.runIndex,
        switchedAtMonotonicNs,
        releaseToken,
      }) + "\\n");
    }, 25);
    return;
  }
  if (message.type !== "release" || !pendingRun || pendingReveal) {
    throw new Error("fixture expected trusted release");
  }
  if (
    message.releaseToken !== pendingRun.releaseToken ||
    message.experimentId !== pendingRun.request.experimentId ||
    message.caseId !== pendingRun.request.caseId ||
    message.side !== pendingRun.request.side ||
    message.runIndex !== pendingRun.request.runIndex
  ) {
    throw new Error("fixture release mismatch");
  }
  const released = pendingRun.request;
  pendingRun = null;
  const request = released;
  generation++;
  const edges = orderedEdges(request.source.hash);
  const states = stateKeys(request.source.hash);
  const priced = pricedEdges(request.source.hash);
  const graph = {
    orderedEdgeIds: edges,
    orderedEdgeHash: exactOrderedHash(edges),
  };
  const pricingCoverage = {
    expectedStateKeys: states,
    resolvedStateKeys: states,
    expectedStateKeyHash: exactSetHash(states),
    resolvedStateKeyHash: exactSetHash(states),
    expectedPricedEdgeIds: priced,
    resolvedPricedEdgeIds: priced,
    expectedPricedEdgeHash: exactSetHash(priced),
    resolvedPricedEdgeHash: exactSetHash(priced),
  };
  const opportunities = [{
    rank: 1,
    route: route(request.source.hash),
    refined: true,
    planCount: 1,
    simulation: {
      executed: true,
      success: true,
      profitRaw: "1",
      gasUsed: "1",
      calldataSha256: h("generic-calldata"),
      standingPosition: false,
    },
    ev: {
      executionStatus: "pass",
      decision: "reject",
      reason: "below-production-threshold",
    },
  }];
  let previousArtifactSha256 = null;
  const stages = [
    "state_ready", "enumeration_done", "exact_refine_done",
    "planner_solver_done", "final_sim_done", "ev_decision",
  ].map((name) => {
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
      stageMs: 0,
      cumulativeMs: 0,
    };
  });
  const output = {
    schemaVersion: request.schemaVersion,
    profile: request.profile,
    experimentId: request.experimentId,
    caseId: request.caseId,
    side: request.side,
    runIndex: request.runIndex,
    base: request.base,
    source: request.source,
    productionEntrySha256: request.productionEntrySha256,
    resolvedConfigSha256: request.resolvedConfigSha256,
    universeSha256: request.universeSha256,
    activeFamilyManifestSha256: request.activeFamilyManifestSha256,
    baseGraphViewSha256: request.baseGraphViewSha256,
    sourceDeltaSha256: request.sourceDeltaSha256,
    backendIdentitySha256: request.backendIdentitySha256,
    artifactReceipts: {
      resolvedConfig: {
        kind: "resolved-config",
        sha256: request.resolvedConfigSha256,
        consumed: true,
      },
      universe: {
        kind: "production-universe",
        sha256: request.universeSha256,
        consumed: true,
      },
      activeFamilyManifest: {
        kind: "active-family-manifest",
        sha256: request.activeFamilyManifestSha256,
        consumed: true,
      },
      baseGraphView: {
        kind: "base-graph-view",
        sha256: request.baseGraphViewSha256,
        consumed: true,
      },
      sourceDelta: {
        kind: "source-delta",
        sha256: request.sourceDeltaSha256,
        consumed: true,
      },
    },
    selectionMode: "production",
    forcedSelectionCount: 0,
    stages,
    graph,
    pricingCoverage,
    telemetry: {
      dynamicCacheGeneration: generation,
      dynamicCacheReset: true,
      sourceDeltaApplied: true,
      cleanForkId: request.caseId + ":" + request.side + ":" + request.runIndex,
      backendUpstreamKind: "local-snapshot",
      backendAttestationSha256: request.backendIdentitySha256,
      basePreStateRoot: request.base.stateRoot,
      sourceStateRoot: request.source.stateRoot,
      freshReadCount: 1,
      batchCount: 1,
      loopbackRpcCalls: 1,
      nonLoopbackUpstreamRpcCalls: 0,
      incompleteFamilyIds: [],
    },
    opportunities,
  };
  process.stdout.write("BLIND_PRODUCER_OUTPUT=" + JSON.stringify(output) + "\\n");
});
`;
}

function resealProductionStages(
  output: BlindProducerOutput,
  overrides: Partial<
    Pick<BlindProducerOutput, "graph" | "pricingCoverage" | "opportunities">
  >,
): BlindProducerOutput {
  const rebound = { ...output, ...overrides };
  const input: BlindProductionStageSealInput = {
    graph: rebound.graph,
    pricingCoverage: rebound.pricingCoverage,
    opportunities: rebound.opportunities,
  };
  let previousArtifactSha256: string | null = null;
  const stages = BLIND_PRODUCTION_STAGE_NAMES.map((name, index) => {
    const current = output.stages[index]!;
    const sealed = sealBlindProductionStageArtifact(
      name,
      previousArtifactSha256,
      input,
    );
    previousArtifactSha256 = sealed.artifactSha256;
    return {
      ...current,
      name,
      artifact: sealed.artifact,
      artifactSha256: sealed.artifactSha256,
    };
  });
  return { ...rebound, stages };
}

function fixtureRoute(sourceHash: string): BlindRouteStep[] {
  return [{
    familyId: `family:${hash(`${sourceHash}:family`).slice(0, 12)}`,
    adapterId: `adapter:${hash(`${sourceHash}:adapter`).slice(0, 12)}`,
    target: `0x${hash(`${sourceHash}:target`).slice(0, 40)}`,
    tokenIn: `0x${hash(`${sourceHash}:token-in`).slice(0, 40)}`,
    tokenOut: `0x${hash(`${sourceHash}:token-out`).slice(0, 40)}`,
    executionVariantKey: hash(`${sourceHash}:variant`),
  }];
}

function fixtureOrderedEdges(sourceHash: string): string[] {
  return [`edge:${hash(`${sourceHash}:edge`)}`];
}

function fixtureStateKeys(sourceHash: string): string[] {
  return [`state:${hash(`${sourceHash}:state`)}`];
}

function fixturePricedEdges(sourceHash: string): string[] {
  return [`priced:${hash(`${sourceHash}:priced`)}`];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureRuntimePortRanges(log: string): number[][] {
  const matches = [...log.matchAll(/fixture-runtime-ports=(\d+),(\d+)/g)];
  assert.equal(
    matches.length,
    2,
    "each side must receive separate primary and held-out port leases",
  );
  return matches.map((match) => {
    const statePort = Number(match[1]);
    const blockScanBasePort = Number(match[2]);
    return [
      statePort,
      blockScanBasePort,
      blockScanBasePort + 1,
      blockScanBasePort + 2,
      blockScanBasePort + 3,
    ];
  });
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
