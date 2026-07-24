import { randomBytes } from "node:crypto";
import {
  blindProductionDeepSeal,
  BLIND_PRODUCTION_RAW_PROFILE,
  type BlindProductionBlockAnchor,
  type BlindProductionPassRecord,
  type BlindProductionPrepareControl,
  type BlindProductionReadyRecord,
  type BlindProductionSourceHeadControl,
} from "../blind-production-audit.js";
import {
  BLIND_SCHEMA_VERSION,
  exactOrderedHash,
  exactSetHash,
  validateBlindProducerOutput,
  type BlindProducerOutput,
  type BlindProducerPrepareRequest,
  type BlindProducerRequest,
} from "./adapter-family-blind-contract.js";
import {
  validateBlindProductionArtifactBinding,
  validateBlindProductionArtifactReceipt,
  type BlindProductionArtifactDocuments,
  type BlindProductionArtifactReceipts,
} from "../blind-production-artifacts.js";

export { BLIND_PRODUCTION_RAW_PROFILE };
export type {
  BlindProductionPassRecord,
  BlindProductionPrepareControl,
  BlindProductionReadyRecord,
  BlindProductionSourceHeadControl,
};

export interface BlindBackendPreparedEvidence {
  readonly type: "base_ready";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly backendIdentitySha256: string;
  readonly backendAttestationSha256: string;
  readonly upstreamKind: BlindLocalUpstreamKind;
  readonly cleanForkId: string;
  readonly basePreStateRoot: string;
}

export type BlindLocalUpstreamKind =
  | "local-reth"
  | "local-content-addressed-state"
  | "local-snapshot";

export interface BlindBackendRevealReadyEvidence {
  readonly type: "reveal_ready";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly cleanForkId: string;
  readonly revealToken: string;
}

export interface BlindBackendFinishedEvidence {
  readonly type: "finished";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly cleanForkId: string;
  readonly loopbackRpcCalls: number;
  readonly nonLoopbackUpstreamRpcCalls: number;
}

export interface BlindBackendRevealedEvidence {
  readonly type: "source_revealed";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly cleanForkId: string;
  readonly switchedAtMonotonicNs: string;
  readonly source: BlindProducerRequest["source"];
}

export function createAttemptNonce(): string {
  return randomBytes(32).toString("hex");
}

export function productionPrepareControl(
  request: BlindProducerPrepareRequest,
  attemptNonce: string,
): BlindProductionPrepareControl {
  assertNonce(attemptNonce);
  return Object.freeze({
    type: "prepare",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    base: request.base,
  });
}

export function productionSourceHeadControl(
  request: BlindProducerRequest,
  attemptNonce: string,
): BlindProductionSourceHeadControl {
  assertNonce(attemptNonce);
  return Object.freeze({
    type: "source_head",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    source: request.source,
  });
}

export function validateProductionReadyRecord(
  record: BlindProductionReadyRecord,
  control: BlindProductionPrepareControl,
): void {
  assertExactKeys(
    record,
    [
      "artifactDocuments",
      "artifacts",
      "attemptNonce",
      "base",
      "profile",
      "type",
    ],
    "production ready",
  );
  assert(record.type === "ready", "production ready type");
  assert(record.profile === BLIND_PRODUCTION_RAW_PROFILE, "production ready profile");
  assert(record.attemptNonce === control.attemptNonce, "production ready nonce");
  assertSameAnchor("production ready base", record.base, control.base);
  validatePreparedArtifactReceipts(record.artifacts);
  validatePreparedArtifactDocuments(
    record.artifactDocuments,
    record.artifacts,
  );
}

/**
 * Trusted, untimed bootstrap validation. The source delta is accepted only
 * from the production process' post-source record and must bind the exact
 * READY artifacts and block anchors observed in the same attempt.
 */
export function validateProductionPassRecordForFreeze(
  record: BlindProductionPassRecord,
  ready: BlindProductionReadyRecord,
  sourceControl: BlindProductionSourceHeadControl,
): void {
  assertExactKeys(
    record,
    [
      "artifactDocuments",
      "artifacts",
      "attemptNonce",
      "base",
      "forcedSelectionCount",
      "graph",
      "opportunities",
      "pricingCoverage",
      "profile",
      "selectionMode",
      "source",
      "stages",
      "telemetry",
      "type",
    ],
    "production pass",
  );
  assert(record.type === "pass", "production pass type");
  assert(record.profile === BLIND_PRODUCTION_RAW_PROFILE, "production pass profile");
  assert(
    record.attemptNonce === ready.attemptNonce &&
      record.attemptNonce === sourceControl.attemptNonce,
    "production pass nonce",
  );
  assertSameAnchor("production pass base", record.base, ready.base);
  assertSameAnchor(
    "production pass source",
    record.source,
    sourceControl.source,
  );
  validateArtifactDocuments(record.artifactDocuments, record.artifacts);
  for (const [label, passReceipt, readyReceipt] of [
    [
      "resolved config",
      record.artifacts.resolvedConfig,
      ready.artifacts.resolvedConfig,
    ],
    ["universe", record.artifacts.universe, ready.artifacts.universe],
    [
      "active family manifest",
      record.artifacts.activeFamilyManifest,
      ready.artifacts.activeFamilyManifest,
    ],
    [
      "base graph view",
      record.artifacts.baseGraphView,
      ready.artifacts.baseGraphView,
    ],
  ] as const) {
    assert(
      passReceipt.sha256 === readyReceipt.sha256,
      `production pass changed READY ${label}`,
    );
  }
  assertArtifactAnchor(
    "production pass base graph",
    record.artifactDocuments.baseGraphView.payload,
    ready.base,
  );
  assertArtifactAnchor(
    "production pass source delta",
    record.artifactDocuments.sourceDelta.payload,
    sourceControl.source,
  );
  assert(
    record.artifactDocuments.sourceDelta.payload.baseGraphViewSha256 ===
      record.artifacts.baseGraphView.sha256,
    "production source delta does not bind READY base graph",
  );
  assertExactKeys(
    record.graph,
    ["orderedEdgeHash", "orderedEdgeIds"],
    "production pass graph",
  );
  assert(
    record.graph.orderedEdgeHash === exactOrderedHash(record.graph.orderedEdgeIds),
    "production pass ordered graph hash",
  );
  assert(
    record.artifactDocuments.sourceDelta.payload
      .orderedCanonicalEdgeIdHash === record.graph.orderedEdgeHash &&
      record.artifactDocuments.sourceDelta.payload.edgeCount ===
        record.graph.orderedEdgeIds.length,
    "production source delta does not match emitted graph",
  );
}

export function assembleBlindProducerOutput(input: {
  readonly request: BlindProducerRequest;
  readonly attemptNonce: string;
  readonly prepared: BlindBackendPreparedEvidence;
  readonly revealed: BlindBackendRevealedEvidence;
  readonly finished: BlindBackendFinishedEvidence;
  readonly raw: BlindProductionPassRecord;
}): BlindProducerOutput {
  const { request, attemptNonce, prepared, revealed, finished, raw } = input;
  assertNonce(attemptNonce);
  assert(raw.type === "pass", "production pass type");
  assert(raw.profile === BLIND_PRODUCTION_RAW_PROFILE, "production pass profile");
  assert(raw.attemptNonce === attemptNonce, "production pass nonce");
  assertSameAnchor("production pass base", raw.base, request.base);
  assertSameAnchor("production pass source", raw.source, request.source);
  validateArtifactReceipts(raw.artifacts, request);
  validateArtifactDocuments(raw.artifactDocuments, raw.artifacts);
  validateBackendEvidence(
    request,
    attemptNonce,
    prepared,
    revealed,
    finished,
  );
  assert(
    raw.graph.orderedEdgeHash === exactOrderedHash(raw.graph.orderedEdgeIds),
    "production raw ordered edge hash",
  );
  assertCoverageHash(
    "state",
    raw.pricingCoverage.expectedStateKeys,
    raw.pricingCoverage.expectedStateKeyHash,
  );
  assertCoverageHash(
    "resolved state",
    raw.pricingCoverage.resolvedStateKeys,
    raw.pricingCoverage.resolvedStateKeyHash,
  );
  assertCoverageHash(
    "priced edge",
    raw.pricingCoverage.expectedPricedEdgeIds,
    raw.pricingCoverage.expectedPricedEdgeHash,
  );
  assertCoverageHash(
    "resolved priced edge",
    raw.pricingCoverage.resolvedPricedEdgeIds,
    raw.pricingCoverage.resolvedPricedEdgeHash,
  );

  const output: BlindProducerOutput = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: request.profile,
    experimentId: request.experimentId,
    caseId: request.caseId,
    side: request.side,
    runIndex: request.runIndex,
    base: request.base,
    source: request.source,
    productionEntrySha256: request.productionEntrySha256,
    resolvedConfigSha256: raw.artifacts.resolvedConfig.sha256,
    universeSha256: raw.artifacts.universe.sha256,
    activeFamilyManifestSha256: raw.artifacts.activeFamilyManifest.sha256,
    baseGraphViewSha256: raw.artifacts.baseGraphView.sha256,
    sourceDeltaSha256: raw.artifacts.sourceDelta.sha256,
    backendIdentitySha256: prepared.backendIdentitySha256,
    artifactReceipts: raw.artifacts,
    selectionMode: raw.selectionMode,
    forcedSelectionCount: raw.forcedSelectionCount,
    stages: raw.stages.map((stage) => blindProductionDeepSeal(stage)),
    graph: raw.graph,
    pricingCoverage: raw.pricingCoverage,
    telemetry: {
      ...raw.telemetry,
      cleanForkId: prepared.cleanForkId,
      backendUpstreamKind: prepared.upstreamKind,
      backendAttestationSha256: prepared.backendAttestationSha256,
      basePreStateRoot: prepared.basePreStateRoot,
      sourceStateRoot: revealed.source.stateRoot,
      loopbackRpcCalls: finished.loopbackRpcCalls,
      nonLoopbackUpstreamRpcCalls: finished.nonLoopbackUpstreamRpcCalls,
    },
    opportunities: raw.opportunities,
  };
  validateBlindProducerOutput(output);
  return Object.freeze(output);
}

function validatePreparedArtifactDocuments(
  documents: Omit<BlindProductionArtifactDocuments, "sourceDelta">,
  receipts: Omit<BlindProductionArtifactReceipts, "sourceDelta">,
): void {
  assertExactKeys(
    documents,
    [
      "activeFamilyManifest",
      "baseGraphView",
      "resolvedConfig",
      "universe",
    ],
    "production prepared artifact documents",
  );
  validateBlindProductionArtifactBinding(
    documents.resolvedConfig,
    receipts.resolvedConfig,
    "resolved-config",
  );
  validateBlindProductionArtifactBinding(
    documents.universe,
    receipts.universe,
    "production-universe",
  );
  validateBlindProductionArtifactBinding(
    documents.activeFamilyManifest,
    receipts.activeFamilyManifest,
    "active-family-manifest",
  );
  validateBlindProductionArtifactBinding(
    documents.baseGraphView,
    receipts.baseGraphView,
    "base-graph-view",
  );
}

function validateArtifactDocuments(
  documents: BlindProductionArtifactDocuments,
  receipts: BlindProductionArtifactReceipts,
): void {
  assertExactKeys(
    documents,
    [
      "activeFamilyManifest",
      "baseGraphView",
      "resolvedConfig",
      "sourceDelta",
      "universe",
    ],
    "production artifact documents",
  );
  validatePreparedArtifactDocuments({
    resolvedConfig: documents.resolvedConfig,
    universe: documents.universe,
    activeFamilyManifest: documents.activeFamilyManifest,
    baseGraphView: documents.baseGraphView,
  }, {
    resolvedConfig: receipts.resolvedConfig,
    universe: receipts.universe,
    activeFamilyManifest: receipts.activeFamilyManifest,
    baseGraphView: receipts.baseGraphView,
  });
  validateBlindProductionArtifactBinding(
    documents.sourceDelta,
    receipts.sourceDelta,
    "source-delta",
  );
}

function validatePreparedArtifactReceipts(
  artifacts: Omit<BlindProductionArtifactReceipts, "sourceDelta">,
): void {
  assertExactKeys(
    artifacts,
    [
      "activeFamilyManifest",
      "baseGraphView",
      "resolvedConfig",
      "universe",
    ],
    "production prepared artifacts",
  );
  validateBlindProductionArtifactReceipt(
    artifacts.resolvedConfig,
    "resolved-config",
  );
  validateBlindProductionArtifactReceipt(
    artifacts.universe,
    "production-universe",
  );
  validateBlindProductionArtifactReceipt(
    artifacts.activeFamilyManifest,
    "active-family-manifest",
  );
  validateBlindProductionArtifactReceipt(
    artifacts.baseGraphView,
    "base-graph-view",
  );
}

function validateArtifactReceipts(
  artifacts: BlindProductionArtifactReceipts,
  request: BlindProducerRequest,
): void {
  assertExactKeys(
    artifacts,
    [
      "activeFamilyManifest",
      "baseGraphView",
      "resolvedConfig",
      "sourceDelta",
      "universe",
    ],
    "production artifacts",
  );
  validatePreparedArtifactReceipts({
    resolvedConfig: artifacts.resolvedConfig,
    universe: artifacts.universe,
    activeFamilyManifest: artifacts.activeFamilyManifest,
    baseGraphView: artifacts.baseGraphView,
  });
  validateBlindProductionArtifactReceipt(
    artifacts.sourceDelta,
    "source-delta",
  );
  for (const [label, actual, expected] of [
    ["resolved config", artifacts.resolvedConfig.sha256, request.resolvedConfigSha256],
    ["universe", artifacts.universe.sha256, request.universeSha256],
    [
      "active family manifest",
      artifacts.activeFamilyManifest.sha256,
      request.activeFamilyManifestSha256,
    ],
    ["base graph view", artifacts.baseGraphView.sha256, request.baseGraphViewSha256],
    ["source delta", artifacts.sourceDelta.sha256, request.sourceDeltaSha256],
  ] as const) {
    assert(actual === expected, `production ${label} artifact mismatch`);
  }
}

export function validateBackendRevealedEvidence(
  revealed: BlindBackendRevealedEvidence,
  request: Pick<BlindProducerRequest, "source">,
  attemptNonce: string,
  prepared: BlindBackendPreparedEvidence,
): void {
  assert(revealed.type === "source_revealed", "backend revealed type");
  assert(revealed.profile === BLIND_PRODUCTION_RAW_PROFILE, "backend revealed profile");
  assert(revealed.attemptNonce === attemptNonce, "backend revealed nonce");
  assert(revealed.cleanForkId === prepared.cleanForkId, "backend revealed clean fork");
  assert(
    /^[0-9]+$/.test(revealed.switchedAtMonotonicNs),
    "backend revealed monotonic stamp",
  );
  assertSameAnchor("backend revealed source", revealed.source, request.source);
}

export function validateBackendRevealReadyEvidence(
  ready: BlindBackendRevealReadyEvidence,
  attemptNonce: string,
  prepared: BlindBackendPreparedEvidence,
): void {
  assert(ready.type === "reveal_ready", "backend reveal ready type");
  assert(ready.profile === BLIND_PRODUCTION_RAW_PROFILE, "backend reveal ready profile");
  assert(ready.attemptNonce === attemptNonce, "backend reveal ready nonce");
  assert(ready.cleanForkId === prepared.cleanForkId, "backend reveal ready clean fork");
  assert(/^[0-9a-f]{64}$/.test(ready.revealToken), "backend reveal token");
}

export function validateBackendEvidence(
  request: Pick<
    BlindProducerRequest,
    "backendIdentitySha256" | "base" | "source"
  >,
  attemptNonce: string,
  prepared: BlindBackendPreparedEvidence,
  revealed: BlindBackendRevealedEvidence,
  finished: BlindBackendFinishedEvidence,
): void {
  assert(prepared.type === "base_ready", "backend prepared type");
  assert(prepared.profile === BLIND_PRODUCTION_RAW_PROFILE, "backend prepared profile");
  assert(prepared.attemptNonce === attemptNonce, "backend prepared nonce");
  assert(
    prepared.backendIdentitySha256 === request.backendIdentitySha256,
    "backend identity mismatch",
  );
  assert(isHash(prepared.backendIdentitySha256), "backend identity hash");
  assert(
    prepared.backendAttestationSha256 === request.backendIdentitySha256,
    "backend attestation binding",
  );
  assert(
    [
      "local-reth",
      "local-content-addressed-state",
      "local-snapshot",
    ].includes(prepared.upstreamKind),
    "backend upstream kind",
  );
  assert(nonempty(prepared.cleanForkId), "backend clean fork id");
  assert(isHash(prepared.basePreStateRoot), "backend base pre-state root");
  assert(
    prepared.basePreStateRoot.toLowerCase() ===
      request.base.stateRoot.toLowerCase(),
    "backend base root",
  );
  validateBackendRevealedEvidence(
    revealed,
    request,
    attemptNonce,
    prepared,
  );

  assert(finished.type === "finished", "backend finished type");
  assert(finished.profile === BLIND_PRODUCTION_RAW_PROFILE, "backend finished profile");
  assert(finished.attemptNonce === attemptNonce, "backend finished nonce");
  assert(finished.cleanForkId === prepared.cleanForkId, "backend clean fork changed");
  assert(
    Number.isSafeInteger(finished.loopbackRpcCalls) &&
      finished.loopbackRpcCalls >= 0,
    "backend loopback call count",
  );
  assert(
    Number.isSafeInteger(finished.nonLoopbackUpstreamRpcCalls) &&
      finished.nonLoopbackUpstreamRpcCalls >= 0,
    "backend upstream call count",
  );
}

function assertArtifactAnchor(
  label: string,
  payload: Readonly<Record<string, unknown>>,
  anchor: BlindProducerRequest["base"],
): void {
  assert(
    payload.anchorNumber === anchor.number &&
      String(payload.anchorHash).toLowerCase() === anchor.hash.toLowerCase(),
    `${label} anchor mismatch`,
  );
}

function assertCoverageHash(
  label: string,
  values: readonly string[],
  hash: string,
): void {
  assert(hash === exactSetHash(values), `${label} coverage hash`);
}

function assertSameAnchor(
  label: string,
  actual: BlindProductionBlockAnchor,
  expected: BlindProductionBlockAnchor,
): void {
  assert(actual.number === expected.number, `${label} number`);
  assert(actual.hash.toLowerCase() === expected.hash.toLowerCase(), `${label} hash`);
  assert(
    actual.stateRoot.toLowerCase() === expected.stateRoot.toLowerCase(),
    `${label} state root`,
  );
}

function assertNonce(value: string): void {
  assert(/^[0-9a-f]{64}$/.test(value), "attempt nonce");
}

function isHash(value: string): boolean {
  return /^(?:0x)?[0-9a-f]{64}$/i.test(value);
}

function nonempty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
