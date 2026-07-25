import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  BlindProductionArtifactReceipts,
} from "../blind-production-artifacts.js";
import {
  validateBlindProductionArtifactReceipt,
} from "../blind-production-artifacts.js";
import {
  blindProductionStageArtifactSha256,
  BLIND_PRODUCTION_STAGE_ARTIFACT_SCHEMA_VERSION,
  BLIND_PRODUCTION_STAGE_NAMES,
  type BlindProductionEnumerationStageOpportunity,
  type BlindProductionEvStageOpportunity,
  type BlindProductionFinalSimStageOpportunity,
  type BlindProductionPlannerStageOpportunity,
  type BlindProductionRefineStageOpportunity,
  type BlindProductionStageArtifact,
  type BlindProductionStageEvidence,
  type BlindProductionStageName,
} from "../blind-production-audit.js";

export const BLIND_GENERIC_PROFILE = "adapter-family-strict-blind-v1" as const;
/** Backward-compatible name for callers that intentionally use the generic profile. */
export const BLIND_PROFILE = BLIND_GENERIC_PROFILE;
export const BLIND_TX055_STRICT_PROFILE =
  "adapter-family-tx055-strict-blind-v1" as const;
export const BLIND_TX02_STRICT_PROFILE =
  "adapter-family-tx02-strict-blind-v1" as const;
export type BlindRunProfile =
  | typeof BLIND_GENERIC_PROFILE
  | typeof BLIND_TX055_STRICT_PROFILE
  | typeof BLIND_TX02_STRICT_PROFILE;
export const BLIND_TX055_TRANSACTION_ID =
  "0x055f5c5df75f4a1006d5af0fcff60218b3acb856c3ef988a5089147794908f4b" as const;
export const BLIND_TX055_BASE_ANCHOR = Object.freeze({
  number: 25_585_379,
  hash: "0x1382086ec2b4ec0db6df8d9bb02df8d8a3f7aca44c4bad5c46589b23a5445171",
  stateRoot:
    "0xb8c597965076dffbdd12feb611c48511caaf8e44c3b842a070431ecfe5b82f54",
});
export const BLIND_TX055_SOURCE_ANCHOR = Object.freeze({
  number: 25_585_380,
  hash: "0x6cf953cd24df65a1d0505aa661b8361b69178dbc74eb73085e3531df284c8f22",
  stateRoot:
    "0x8bb7fd340dc4088cf2572be4915b861e5dc5fe4827da2ad56a7672fbbcae678e",
});
export const BLIND_TX02_TRANSACTION_ID =
  "0x02a8b803ed975ebc944d61a218c9438f5ae62615969434046a5d53ab4d1966af" as const;
export const BLIND_TX02_BASE_ANCHOR = Object.freeze({
  number: 25_599_788,
  hash: "0xc55be4805bc2482d7ae99aa693e2c7b6c63925a60b78cd717efff6cc0736ff41",
  stateRoot:
    "0x9a8233914ed7931e0c8d8154711cb50fcc18295b6e348e42bf34c8e97eeca343",
});
export const BLIND_TX02_SOURCE_ANCHOR = Object.freeze({
  number: 25_599_789,
  hash: "0xbdaf5f6640f784373f4e6d644e27dd447f0914db43affbe2f9bc16f7e5bb062a",
  stateRoot:
    "0xdffdabeabb966c54a3023f332531c0d384d884034a5569318723e621cdf1808e",
});
export const BLIND_SCHEMA_VERSION = 1 as const;
export const BLIND_STAGE_NAMES = BLIND_PRODUCTION_STAGE_NAMES;

export type BlindSide = "baseline" | "challenger";
export type BlindRunCaseId = "primary" | "held-out";
export type BlindStageName = BlindProductionStageName;

export interface BlindBlockAnchor {
  readonly number: number;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface BlindArtifactBinding {
  readonly path: string;
  readonly sha256: string;
}

export interface BlindProducerCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Trusted-runner-only runtime injection. The manifest binds only the env
   * reference and value hash; the secret value is resolved from the runner's
   * explicitly allowlisted environment immediately before spawn.
   */
  readonly secretEnvRefs?: readonly BlindRuntimeSecretRef[];
}

export interface BlindRuntimeSecretRef {
  readonly envName: string;
  readonly valueSha256: string;
}

export interface BlindProducerBinding {
  readonly productionEntry: BlindArtifactBinding;
  /** Canonical transitive local-module closure rooted at productionEntry. */
  readonly productionModuleClosure: BlindArtifactBinding;
  /** Frozen thin wrapper that speaks the runner JSONL protocol and imports the entry above. */
  readonly producerHarness: BlindArtifactBinding;
  /**
   * Each side/case pair owns a separate producer process, trusted controller
   * endpoint, and attested backend process/cache.
   */
  readonly cases: Readonly<Record<BlindRunCaseId, BlindProducerSessionBinding>>;
}

export interface BlindProducerSessionBinding {
  readonly command: BlindProducerCommand;
  readonly backendIdentity: BlindArtifactBinding;
}

export interface BlindRunOrderEntry {
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
}

export interface BlindRunInputs {
  readonly resolvedConfig: BlindArtifactBinding;
  readonly universe: BlindArtifactBinding;
  readonly activeFamilyManifest: BlindArtifactBinding;
  readonly baseGraphView: BlindArtifactBinding;
  readonly sourceDelta: BlindArtifactBinding;
}

export interface BlindRunManifest {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly base: BlindBlockAnchor;
  readonly source: BlindBlockAnchor;
  readonly runCountPerSide: number;
  readonly runOrder: readonly BlindRunOrderEntry[];
  readonly p95Algorithm: "nearest-rank-ceil";
  readonly timingLimitMs: number;
  /** Retains slow/failed attempts long enough to capture their terminal evidence. */
  readonly responseTimeoutMs: number;
  readonly inputs: BlindRunInputs;
  /**
   * Independently frozen adjacent-block control. It is executed once per side
   * and never validated against the primary target oracle.
   */
  readonly heldOut: {
    readonly base: BlindBlockAnchor;
    readonly source: BlindBlockAnchor;
    readonly inputs: BlindRunInputs;
  };
  readonly oracleCommitment: string;
  readonly trusted: {
    readonly runner: BlindArtifactBinding;
    readonly oracleBuilder: BlindArtifactBinding;
    readonly comparator: BlindArtifactBinding;
    readonly backendController: BlindArtifactBinding;
    readonly anvilBinary: BlindArtifactBinding;
  };
  readonly producers: Readonly<Record<BlindSide, BlindProducerBinding>>;
}

export interface BlindRouteStep {
  readonly familyId: string;
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly executionVariantKey: string;
}

export type BlindStageEvidence = BlindProductionStageEvidence;

export interface BlindOpportunityEvidence {
  readonly rank: number;
  readonly route: readonly BlindRouteStep[];
  readonly refined: boolean;
  readonly planCount: number;
  readonly simulation: {
    readonly executed: boolean;
    readonly success: boolean;
    readonly profitRaw: string;
    readonly gasUsed: string;
    readonly calldataSha256: string;
    readonly standingPosition: boolean;
  };
  readonly ev: {
    readonly executionStatus: "pass" | "not_run";
    readonly decision: "allow" | "reject";
    readonly reason: string;
  };
}

export interface BlindProducerOutput {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly base: BlindBlockAnchor;
  readonly source: BlindBlockAnchor;
  readonly productionEntrySha256: string;
  readonly resolvedConfigSha256: string;
  readonly universeSha256: string;
  readonly activeFamilyManifestSha256: string;
  readonly baseGraphViewSha256: string;
  readonly sourceDeltaSha256: string;
  readonly backendIdentitySha256: string;
  readonly artifactReceipts: BlindProductionArtifactReceipts;
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
  readonly stages: readonly BlindStageEvidence[];
  readonly graph: {
    readonly orderedEdgeIds: readonly string[];
    readonly orderedEdgeHash: string;
  };
  readonly pricingCoverage: {
    readonly expectedStateKeys: readonly string[];
    readonly resolvedStateKeys: readonly string[];
    readonly expectedStateKeyHash: string;
    readonly resolvedStateKeyHash: string;
    readonly expectedPricedEdgeIds: readonly string[];
    readonly resolvedPricedEdgeIds: readonly string[];
    readonly expectedPricedEdgeHash: string;
    readonly resolvedPricedEdgeHash: string;
  };
  readonly telemetry: {
    readonly dynamicCacheGeneration: number;
    readonly dynamicCacheReset: boolean;
    readonly sourceDeltaApplied: boolean;
    readonly cleanForkId: string;
    readonly backendUpstreamKind:
      | "local-reth"
      | "local-content-addressed-state"
      | "local-snapshot";
    readonly backendAttestationSha256: string;
    readonly basePreStateRoot: string;
    readonly sourceStateRoot: string;
    readonly freshReadCount: number;
    readonly batchCount: number;
    readonly loopbackRpcCalls: number;
    readonly nonLoopbackUpstreamRpcCalls: number;
    readonly incompleteFamilyIds: readonly string[];
  };
  readonly opportunities: readonly BlindOpportunityEvidence[];
}

export interface BlindProducerRequest {
  readonly type: "reveal_request";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly base: BlindBlockAnchor;
  readonly source: BlindBlockAnchor;
  readonly productionEntrySha256: string;
  readonly resolvedConfigSha256: string;
  readonly universeSha256: string;
  readonly activeFamilyManifestSha256: string;
  readonly baseGraphViewSha256: string;
  readonly sourceDeltaSha256: string;
  readonly backendIdentitySha256: string;
}

export interface BlindProducerPrepareRequest
  extends Omit<BlindProducerRequest, "type"> {
  /**
   * Untimed reset/preparation request. `reveal_request` prepares an atomic
   * backend handoff but cannot switch the stable RPC endpoint.
   */
  readonly type: "prepare";
}

export interface BlindProducerReady {
  readonly type: "base_ready";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
}

/**
 * The source fork is fully materialized, but /rpc is still pinned to base.
 * The runner may inspect that invariant before authorizing the switch.
 */
export interface BlindProducerRevealReady {
  readonly type: "reveal_ready";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly revealToken: string;
}

export interface BlindProducerRevealReleaseRequest {
  readonly type: "reveal_release";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly revealToken: string;
}

/**
 * Trusted-controller acknowledgement that /rpc now resolves to source N.
 * Production has still not received source_head. The runner stamps its clock
 * after this message and immediately sends the matching production release.
 */
export interface BlindProducerSourceRevealed {
  readonly type: "source_revealed";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  /** Trusted controller stamp taken immediately after the /rpc lane switch. */
  readonly switchedAtMonotonicNs: string;
  readonly releaseToken: string;
}

export interface BlindProducerReleaseRequest {
  readonly type: "release";
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly caseId: BlindRunCaseId;
  readonly side: BlindSide;
  readonly runIndex: number;
  readonly releaseToken: string;
}

export interface SealedBlindProducerOutput {
  readonly output: BlindProducerOutput;
  readonly outputSha256: string;
  /** Trusted-runner stamp immediately before authorizing the source-N switch. */
  readonly sourceHeadSeenAtMonotonicNs: string;
  /** Trusted-controller stamp taken immediately after the /rpc lane switch. */
  readonly sourceBackendSwitchedAtMonotonicNs: string;
  readonly sealedAtMonotonicNs: string;
  /** Trusted elapsed time from pre-switch release until the output line. */
  readonly runnerElapsedMs: number;
  /** Seal of output plus every trusted timing field above. */
  readonly envelopeSha256: string;
}

export interface BlindOracle {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly source: BlindBlockAnchor;
  readonly transactionId: string;
  readonly targetRoute: readonly BlindRouteStep[];
  readonly expectedOrderedEdgeIds: readonly string[];
  readonly expectedRequiredStateKeys: readonly string[];
  readonly expectedPricedEdgeIds: readonly string[];
  readonly expectedSimulation: {
    readonly success: true;
    readonly profitRaw: string;
    readonly gasUsed: string;
    readonly calldataSha256: string;
    readonly standingPosition: false;
  };
  readonly expectedEv: {
    readonly decision: "allow" | "reject";
    readonly reason: string;
  };
}

export interface BlindOracleReveal {
  readonly oracle: BlindOracle;
  readonly salt: string;
  readonly commitment: string;
}

export interface BlindComparisonReport {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: BlindRunProfile;
  readonly experimentId: string;
  readonly producerOutputsSha256: string;
  readonly oracleCommitment: string;
  readonly semanticStatus: "pass" | "fail";
  readonly timingStatus: "pass" | "fail";
  readonly overall: "pass" | "implemented_not_validated";
  readonly p95Ms: Readonly<Record<BlindSide, number>>;
  readonly failures: readonly string[];
}

export interface ConversionEligibilityPlan {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: "conversion-freshness-selection-v1";
  readonly range: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly rangeHash: string;
  };
  readonly predicateVersion: string;
  readonly predicateSha256: string;
  /** Reveal-preceding commitment to the exact live graph/scanner input manifest. */
  readonly productionInputsSha256: string;
  readonly minEligibleCardinality: number;
  readonly selectionAlgorithm: "sha256-seeded-order-v1";
  readonly seedCommitment: string;
}

export interface ConversionCandidate {
  /** Opaque oracle-side identity. It is never supplied to the producer before freeze. */
  readonly id: string;
  readonly sourceBlock: number;
  readonly evidenceSha256: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function exactOrderedHash(values: readonly string[]): string {
  return sha256Canonical(values);
}

export function exactSetHash(values: readonly string[]): string {
  return sha256Canonical([...new Set(values)].sort());
}

export function validateBlindRunManifest(manifest: BlindRunManifest): void {
  assert(manifest.schemaVersion === BLIND_SCHEMA_VERSION, "manifest schemaVersion");
  assert(isBlindRunProfile(manifest.profile), "manifest profile");
  assert(nonempty(manifest.experimentId), "manifest experimentId");
  validateAnchor("manifest base", manifest.base);
  validateAnchor("manifest source", manifest.source);
  assert(manifest.base.number + 1 === manifest.source.number, "manifest must bind adjacent N-1/N");
  assert(
    manifest.heldOut && typeof manifest.heldOut === "object",
    "manifest held-out case is required",
  );
  validateAnchor("manifest held-out base", manifest.heldOut.base);
  validateAnchor("manifest held-out source", manifest.heldOut.source);
  assert(
    manifest.heldOut.base.number + 1 === manifest.heldOut.source.number,
    "manifest held-out must bind adjacent N-1/N",
  );
  assert(
    !sameAnchor(manifest.heldOut.base, manifest.base) ||
      !sameAnchor(manifest.heldOut.source, manifest.source),
    "manifest held-out block pair must differ from primary",
  );
  assert(
    Number.isSafeInteger(manifest.runCountPerSide) && manifest.runCountPerSide >= 20,
    "manifest runCountPerSide must be >= 20",
  );
  assert(manifest.p95Algorithm === "nearest-rank-ceil", "manifest p95 algorithm");
  assert(
    Number.isFinite(manifest.timingLimitMs) && manifest.timingLimitMs > 0,
    "manifest timingLimitMs",
  );
  if (manifest.profile === BLIND_TX055_STRICT_PROFILE) {
    assert(
      sameAnchor(manifest.base, BLIND_TX055_BASE_ANCHOR),
      "tx055 strict profile base anchor",
    );
    assert(
      sameAnchor(manifest.source, BLIND_TX055_SOURCE_ANCHOR),
      "tx055 strict profile source anchor",
    );
    assert(
      manifest.timingLimitMs === 10_000,
      "tx055 strict profile timingLimitMs must equal 10000",
    );
  }
  if (manifest.profile === BLIND_TX02_STRICT_PROFILE) {
    assert(
      sameAnchor(manifest.base, BLIND_TX02_BASE_ANCHOR),
      "tx02 strict profile base anchor",
    );
    assert(
      sameAnchor(manifest.source, BLIND_TX02_SOURCE_ANCHOR),
      "tx02 strict profile source anchor",
    );
    assert(
      manifest.timingLimitMs === 10_000,
      "tx02 strict profile timingLimitMs must equal 10000",
    );
  }
  assert(
    Number.isSafeInteger(manifest.responseTimeoutMs) &&
      manifest.responseTimeoutMs >= manifest.timingLimitMs,
    "manifest responseTimeoutMs must be an integer >= timingLimitMs",
  );
  assertHash(manifest.oracleCommitment, "manifest oracle commitment");
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
    ...producerSessions(manifest).map((entry) => entry.session.backendIdentity),
  ]) {
    assert(isAbsolute(binding.path), `artifact path must be absolute: ${binding.path}`);
    assertHash(binding.sha256, `artifact ${binding.path}`);
  }
  const controllerUrls = new Set<string>();
  const backendPaths = new Set<string>();
  const backendHashes = new Set<string>();
  for (const side of ["baseline", "challenger"] as const) {
    const producer = manifest.producers[side];
    for (const caseId of ["primary", "held-out"] as const) {
      const session = producer.cases[caseId];
      assert(
        session && typeof session === "object",
        `${side}/${caseId} producer session is required`,
      );
      validateProducerCommand(session.command);
      const producerSurface = canonicalJson({
        argv: session.command.argv,
        env: session.command.env,
      }).toLowerCase();
      assert(
        !producerSurface.includes(manifest.source.hash.toLowerCase()) &&
          !producerSurface.includes(manifest.source.stateRoot.toLowerCase()) &&
          !producerSurface.includes(manifest.heldOut.source.hash.toLowerCase()) &&
          !producerSurface.includes(
            manifest.heldOut.source.stateRoot.toLowerCase(),
          ),
        `${side}/${caseId} command exposes source-N anchor before source_head`,
      );
      assert(
        session.command.argv.includes(producer.producerHarness.path),
        `${side}/${caseId} command must execute its frozen producer harness`,
      );
      assert(
        session.command.argv.includes(producer.productionEntry.path),
        `${side}/${caseId} command must receive its frozen production entry`,
      );
      const controllerUrl = producerControllerUrl(session.command);
      assert(
        !controllerUrls.has(controllerUrl),
        `${side}/${caseId} must use an independent controller endpoint`,
      );
      controllerUrls.add(controllerUrl);
      assert(
        !backendPaths.has(session.backendIdentity.path) &&
          !backendHashes.has(session.backendIdentity.sha256),
        `${side}/${caseId} must use an independent backend attestation`,
      );
      backendPaths.add(session.backendIdentity.path);
      backendHashes.add(session.backendIdentity.sha256);
    }
  }
  assert(
    manifest.producers.baseline.producerHarness.sha256 ===
      manifest.producers.challenger.producerHarness.sha256,
    "baseline/challenger must use a byte-identical producer harness",
  );
  const expectedOrderLength = manifest.runCountPerSide * 2 + 2;
  assert(
    manifest.runOrder.length === expectedOrderLength,
    `manifest runOrder must contain ${expectedOrderLength} entries`,
  );
  const seen = new Set<string>();
  for (const entry of manifest.runOrder) {
    assert(
      entry.caseId === "primary" || entry.caseId === "held-out",
      "runOrder caseId",
    );
    assert(entry.side === "baseline" || entry.side === "challenger", "runOrder side");
    if (entry.caseId === "primary") {
      assert(
        Number.isSafeInteger(entry.runIndex) &&
          entry.runIndex >= 0 &&
          entry.runIndex < manifest.runCountPerSide,
        "runOrder primary index",
      );
    } else {
      assert(entry.runIndex === 0, "runOrder held-out index must be 0");
    }
    const key = runOrderKey(entry);
    assert(!seen.has(key), `duplicate runOrder entry ${key}`);
    seen.add(key);
  }
  for (let index = 0; index < manifest.runCountPerSide; index += 1) {
    for (const side of ["baseline", "challenger"] as const) {
      const key = `primary:${side}:${index}`;
      assert(seen.has(key), `missing runOrder entry ${key}`);
    }
  }
  for (const side of ["baseline", "challenger"] as const) {
    const key = `held-out:${side}:0`;
    assert(seen.has(key), `missing runOrder entry ${key}`);
  }
}

export function validateProducerCommand(command: BlindProducerCommand): void {
  assert(isAbsolute(command.executable), "producer executable must be absolute");
  assert(isAbsolute(command.cwd), "producer cwd must be absolute");
  const serialized = canonicalJson({ argv: command.argv, env: command.env }).toLowerCase();
  const forbidden = [
    "ab_expected_",
    "expected_route",
    "expected_pool",
    "expected_token",
    "expected_amount",
    "expected_calldata",
    "winner_hash",
    "target_tx",
    "target_route",
    "target_pool",
    "search_center",
    "--diagnostic",
  ];
  for (const marker of forbidden) {
    assert(!serialized.includes(marker), `producer command leaks forbidden marker ${marker}`);
  }
  for (const argument of command.argv) {
    assert(typeof argument === "string", "producer argv");
    assert(
      !looksPrivateKeyValue(argument) &&
        !/--(?:private|owner|wallet|signer|api|access|secret)[-_]?key(?:=|$)/i
          .test(argument) &&
        !/--(?:password|mnemonic|secret|token)(?:=|$)/i.test(argument),
      "producer argv contains a secret-shaped value/flag",
    );
  }
  for (const [key, value] of Object.entries(command.env)) {
    assert(nonempty(key) && typeof value === "string", "producer env");
    assert(
      !looksSecretEnvName(key),
      `producer secret ${key} must use a runtime secret reference`,
    );
    assert(
      !looksPrivateKeyValue(value),
      `producer env ${key} contains a private-key-shaped value`,
    );
    if (looksLikeUrl(value)) {
      const url = new URL(value);
      assert(isLoopbackHost(url.hostname), `producer URL ${key} must be loopback`);
    }
  }
  const seenSecretRefs = new Set<string>();
  for (const reference of command.secretEnvRefs ?? []) {
    assert(
      /^[A-Z][A-Z0-9_]*$/.test(reference.envName),
      "producer runtime secret env name",
    );
    assert(
      looksSecretEnvName(reference.envName),
      `producer runtime secret ref ${reference.envName} is not a secret env`,
    );
    assert(
      !seenSecretRefs.has(reference.envName) &&
        !(reference.envName in command.env),
      `producer duplicate runtime secret ref ${reference.envName}`,
    );
    assertHash(
      reference.valueSha256,
      `producer runtime secret ${reference.envName} hash`,
    );
    seenSecretRefs.add(reference.envName);
  }
}

export function producerControllerUrl(command: BlindProducerCommand): string {
  const candidates = new Set<string>();
  const fromEnv = command.env.BLIND_SOURCE_CONTROL_URL;
  if (fromEnv) candidates.add(fromEnv);
  for (let index = 0; index < command.argv.length; index += 1) {
    const argument = command.argv[index]!;
    if (argument === "--controller-url") {
      const value = command.argv[index + 1];
      assert(nonempty(value ?? ""), "producer --controller-url value");
      candidates.add(value!);
      index += 1;
    } else if (argument.startsWith("--controller-url=")) {
      candidates.add(argument.slice("--controller-url=".length));
    }
  }
  assert(
    candidates.size === 1,
    "producer must bind exactly one controller endpoint",
  );
  const parsed = new URL([...candidates][0]!);
  assert(
    isLoopbackHost(parsed.hostname),
    "producer controller endpoint must be loopback",
  );
  return parsed.href;
}

export function producerRequest(
  manifest: BlindRunManifest,
  entry: BlindRunOrderEntry,
): BlindProducerRequest {
  validateBlindRunManifest(manifest);
  const run = manifestCase(manifest, entry.caseId);
  return {
    type: "reveal_request",
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: manifest.profile,
    experimentId: manifest.experimentId,
    caseId: entry.caseId,
    side: entry.side,
    runIndex: entry.runIndex,
    base: run.base,
    source: run.source,
    productionEntrySha256: manifest.producers[entry.side].productionEntry.sha256,
    resolvedConfigSha256: run.inputs.resolvedConfig.sha256,
    universeSha256: run.inputs.universe.sha256,
    activeFamilyManifestSha256: run.inputs.activeFamilyManifest.sha256,
    baseGraphViewSha256: run.inputs.baseGraphView.sha256,
    sourceDeltaSha256: run.inputs.sourceDelta.sha256,
    backendIdentitySha256:
      manifest.producers[entry.side].cases[entry.caseId].backendIdentity.sha256,
  };
}

export function producerPrepareRequest(
  manifest: BlindRunManifest,
  entry: BlindRunOrderEntry,
): BlindProducerPrepareRequest {
  return {
    ...producerRequest(manifest, entry),
    type: "prepare",
  };
}

export function sealBlindOracle(oracle: BlindOracle, salt: string): BlindOracleReveal {
  validateBlindOracle(oracle);
  assert(nonempty(salt), "oracle salt");
  return {
    oracle,
    salt,
    commitment: sha256Canonical({ oracle, salt }),
  };
}

export function verifyBlindOracleReveal(
  reveal: BlindOracleReveal,
  expectedCommitment: string,
): void {
  validateBlindOracle(reveal.oracle);
  assertHash(expectedCommitment, "expected oracle commitment");
  assert(
    reveal.commitment === sha256Canonical({ oracle: reveal.oracle, salt: reveal.salt }),
    "oracle reveal commitment mismatch",
  );
  assert(reveal.commitment === expectedCommitment, "oracle reveal does not match manifest");
}

export function sealProducerOutput(
  output: BlindProducerOutput,
  runnerElapsedMs: number,
  sourceHeadSeenAtMonotonicNs?: bigint,
  sourceBackendSwitchedAtMonotonicNs?: bigint,
): SealedBlindProducerOutput {
  validateProducerOutputShape(output);
  assert(
    Number.isFinite(runnerElapsedMs) && runnerElapsedMs >= 0,
    "runner elapsed time",
  );
  const sealedAt = process.hrtime.bigint();
  const sourceHeadSeen = sourceHeadSeenAtMonotonicNs ??
    sealedAt - BigInt(Math.max(0, Math.round(runnerElapsedMs * 1_000_000)));
  const sourceBackendSwitched = sourceBackendSwitchedAtMonotonicNs ??
    sourceHeadSeen;
  assert(sourceHeadSeen >= 0n && sourceHeadSeen <= sealedAt, "source-head monotonic stamp");
  assert(
    sourceBackendSwitched >= sourceHeadSeen &&
      sourceBackendSwitched <= sealedAt,
    "source backend switch stamp",
  );
  const envelope = {
    output,
    outputSha256: sha256Canonical(output),
    sourceHeadSeenAtMonotonicNs: sourceHeadSeen.toString(),
    sourceBackendSwitchedAtMonotonicNs: sourceBackendSwitched.toString(),
    sealedAtMonotonicNs: sealedAt.toString(),
    runnerElapsedMs: Number(sealedAt - sourceHeadSeen) / 1_000_000,
  };
  return {
    ...envelope,
    envelopeSha256: sha256Canonical(envelope),
  };
}

export function compareBlindRun(
  manifest: BlindRunManifest,
  sealedOutputs: readonly SealedBlindProducerOutput[],
  reveal: BlindOracleReveal,
): BlindComparisonReport {
  validateBlindRunManifest(manifest);
  verifyBlindOracleReveal(reveal, manifest.oracleCommitment);
  const failures: string[] = [];
  if (reveal.oracle.experimentId !== manifest.experimentId) {
    failures.push("oracle experiment mismatch");
  }
  if (reveal.oracle.profile !== manifest.profile) {
    failures.push("oracle profile mismatch");
  }
  if (
    manifest.profile === BLIND_TX055_STRICT_PROFILE &&
    reveal.oracle.transactionId.toLowerCase() !==
      BLIND_TX055_TRANSACTION_ID.toLowerCase()
  ) {
    failures.push("tx055 strict profile transaction mismatch");
  }
  if (
    manifest.profile === BLIND_TX02_STRICT_PROFILE &&
    reveal.oracle.transactionId.toLowerCase() !==
      BLIND_TX02_TRANSACTION_ID.toLowerCase()
  ) {
    failures.push("tx02 strict profile transaction mismatch");
  }
  if (!sameAnchor(reveal.oracle.source, manifest.source)) {
    failures.push("oracle source mismatch");
  }
  const expectedRunKeys = new Set(
    manifest.runOrder.map(runOrderKey),
  );
  const byRun = new Map<string, SealedBlindProducerOutput>();
  for (let position = 0; position < sealedOutputs.length; position += 1) {
    const sealed = sealedOutputs[position]!;
    let key: string;
    try {
      validateProducerOutputShape(sealed.output);
      assertHash(sealed.outputSha256, "producer output seal");
      assertHash(sealed.envelopeSha256, "producer envelope seal");
      assert(
        Number.isFinite(sealed.runnerElapsedMs) && sealed.runnerElapsedMs >= 0,
        "trusted runner elapsed time",
      );
      const sourceHeadSeen = parseMonotonicNs(
        sealed.sourceHeadSeenAtMonotonicNs,
        "source-head stamp",
      );
      const sealedAt = parseMonotonicNs(
        sealed.sealedAtMonotonicNs,
        "sealed stamp",
      );
      const switchedAt = parseMonotonicNs(
        sealed.sourceBackendSwitchedAtMonotonicNs,
        "source backend switch stamp",
      );
      assert(
        sourceHeadSeen <= switchedAt && switchedAt <= sealedAt,
        "trusted runner monotonic stamp order",
      );
      key = runKey(sealed.output);
    } catch (error) {
      failures.push(`producer output ${position} invalid envelope: ${message(error)}`);
      continue;
    }
    if (sealed.outputSha256 !== sha256Canonical(sealed.output)) {
      failures.push(`producer output seal mismatch ${key}`);
      continue;
    }
    const envelope = {
      output: sealed.output,
      outputSha256: sealed.outputSha256,
      sourceHeadSeenAtMonotonicNs: sealed.sourceHeadSeenAtMonotonicNs,
      sourceBackendSwitchedAtMonotonicNs:
        sealed.sourceBackendSwitchedAtMonotonicNs,
      sealedAtMonotonicNs: sealed.sealedAtMonotonicNs,
      runnerElapsedMs: sealed.runnerElapsedMs,
    };
    if (
      sealed.envelopeSha256 !== sha256Canonical(envelope) ||
      Math.abs(
        sealed.runnerElapsedMs -
          Number(
            parseMonotonicNs(
              sealed.sealedAtMonotonicNs,
              "sealed stamp",
            ) -
              parseMonotonicNs(
                sealed.sourceHeadSeenAtMonotonicNs,
                "source-head stamp",
              ),
          ) / 1_000_000,
      ) > 0.001
    ) {
      failures.push(`producer timing envelope seal mismatch ${key}`);
      continue;
    }
    if (!expectedRunKeys.has(key)) {
      failures.push(`unexpected producer output ${key}`);
      continue;
    }
    if (byRun.has(key)) {
      failures.push(`duplicate producer output ${key}`);
      continue;
    }
    byRun.set(key, sealed);
    validateOutputAgainstManifest(manifest, sealed, reveal.oracle, failures);
  }
  for (const entry of manifest.runOrder) {
    const key = runOrderKey(entry);
    if (!byRun.has(key)) failures.push(`missing producer output ${key}`);
  }
  for (const side of ["baseline", "challenger"] as const) {
    const previousGeneration = new Map<BlindRunCaseId, number>([
      ["primary", 0],
      ["held-out", 0],
    ]);
    const forkIds = new Set<string>();
    for (const entry of manifest.runOrder) {
      if (entry.side !== side) continue;
      const key = runOrderKey(entry);
      const output = byRun.get(key)?.output;
      if (!output) continue;
      if (
        output.telemetry.dynamicCacheGeneration <=
          (previousGeneration.get(entry.caseId) ?? 0)
      ) {
        failures.push(`${key} cache generation did not advance`);
      }
      previousGeneration.set(
        entry.caseId,
        output.telemetry.dynamicCacheGeneration,
      );
      if (forkIds.has(output.telemetry.cleanForkId)) {
        failures.push(`${key} reused clean fork`);
      }
      forkIds.add(output.telemetry.cleanForkId);
    }
  }
  for (let index = 0; index < manifest.runCountPerSide; index += 1) {
    const baseline = byRun.get(`primary:baseline:${index}`);
    const challenger = byRun.get(`primary:challenger:${index}`);
    if (!baseline || !challenger) continue;
    if (sha256Canonical(productionSemantics(baseline.output)) !==
      sha256Canonical(productionSemantics(challenger.output))) {
      failures.push(`semantic mismatch baseline/challenger run ${index}`);
    }
  }
  const heldOutBaseline = byRun.get("held-out:baseline:0");
  const heldOutChallenger = byRun.get("held-out:challenger:0");
  if (
    heldOutBaseline &&
    heldOutChallenger &&
    sha256Canonical(productionSemantics(heldOutBaseline.output)) !==
      sha256Canonical(productionSemantics(heldOutChallenger.output))
  ) {
    failures.push("semantic mismatch baseline/challenger held-out");
  }

  const p95Ms: Record<BlindSide, number> = { baseline: Number.POSITIVE_INFINITY, challenger: Number.POSITIVE_INFINITY };
  for (const side of ["baseline", "challenger"] as const) {
    const elapsed = [...byRun.values()]
      .filter((entry) =>
        entry.output.side === side && entry.output.caseId === "primary"
      )
      .map((entry) => entry.runnerElapsedMs);
    if (elapsed.length === manifest.runCountPerSide) {
      p95Ms[side] = nearestRankP95(elapsed);
    }
  }
  const semanticFailures = failures.filter((failure) => !failure.startsWith("timing:"));
  for (const side of ["baseline", "challenger"] as const) {
    if (!(p95Ms[side] < manifest.timingLimitMs)) {
      failures.push(`timing:${side} p95 ${p95Ms[side]}ms is not < ${manifest.timingLimitMs}ms`);
    }
  }
  const semanticStatus = semanticFailures.length === 0 ? "pass" : "fail";
  const timingStatus = failures.some((failure) => failure.startsWith("timing:")) ? "fail" : "pass";
  return {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: manifest.profile,
    experimentId: manifest.experimentId,
    producerOutputsSha256: sha256Canonical(
      sealedOutputs.map((entry) => entry.envelopeSha256).sort(),
    ),
    oracleCommitment: manifest.oracleCommitment,
    semanticStatus,
    timingStatus,
    overall: semanticStatus === "pass" && timingStatus === "pass"
      ? "pass"
      : "implemented_not_validated",
    p95Ms,
    failures,
  };
}

export function nearestRankP95(samples: readonly number[]): number {
  assert(samples.length > 0, "p95 requires samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

export function conversionSeedCommitment(input: {
  readonly seed: string;
  readonly salt: string;
  readonly rangeHash: string;
  readonly predicateSha256: string;
  readonly productionInputsSha256: string;
}): string {
  assert(nonempty(input.seed) && nonempty(input.salt), "conversion seed/salt");
  assertHash(input.rangeHash, "conversion range hash");
  assertHash(input.predicateSha256, "conversion predicate hash");
  assertHash(input.productionInputsSha256, "conversion production inputs hash");
  return createHash("sha256")
    .update(input.seed)
    .update(input.salt)
    .update(input.rangeHash)
    .update(input.predicateSha256)
    .update(input.productionInputsSha256)
    .digest("hex");
}

export function validateConversionEligibilityPlan(plan: ConversionEligibilityPlan): void {
  assert(plan.schemaVersion === BLIND_SCHEMA_VERSION, "conversion plan schema");
  assert(plan.profile === "conversion-freshness-selection-v1", "conversion plan profile");
  assert(
    Number.isSafeInteger(plan.range.fromBlock) &&
      Number.isSafeInteger(plan.range.toBlock) &&
      plan.range.fromBlock >= 0 &&
      plan.range.toBlock >= plan.range.fromBlock,
    "conversion range",
  );
  assertHash(plan.range.rangeHash, "conversion range hash");
  assert(nonempty(plan.predicateVersion), "conversion predicate version");
  assertHash(plan.predicateSha256, "conversion predicate hash");
  assertHash(plan.productionInputsSha256, "conversion production inputs hash");
  assert(
    Number.isSafeInteger(plan.minEligibleCardinality) &&
      plan.minEligibleCardinality >= 32,
    "conversion minEligibleCardinality must be >= 32",
  );
  assert(plan.selectionAlgorithm === "sha256-seeded-order-v1", "conversion algorithm");
  assertHash(plan.seedCommitment, "conversion seed commitment");
}

export function revealConversionSelection(input: {
  readonly plan: ConversionEligibilityPlan;
  readonly candidates: readonly ConversionCandidate[];
  readonly seed: string;
  readonly salt: string;
}): {
  readonly selected: ConversionCandidate | null;
  readonly freshnessEvidence: "selected" | "missing";
  readonly eligibleSetSha256: string;
} {
  validateConversionEligibilityPlan(input.plan);
  assert(
    conversionSeedCommitment({
      seed: input.seed,
      salt: input.salt,
      rangeHash: input.plan.range.rangeHash,
      predicateSha256: input.plan.predicateSha256,
      productionInputsSha256: input.plan.productionInputsSha256,
    }) === input.plan.seedCommitment,
    "conversion seed reveal mismatch",
  );
  const unique = new Map<string, ConversionCandidate>();
  for (const candidate of input.candidates) {
    assert(nonempty(candidate.id), "conversion candidate id");
    assert(
      Number.isSafeInteger(candidate.sourceBlock) &&
        candidate.sourceBlock >= input.plan.range.fromBlock &&
        candidate.sourceBlock <= input.plan.range.toBlock,
      "conversion candidate outside frozen range",
    );
    assertHash(candidate.evidenceSha256, "conversion candidate evidence");
    assert(!unique.has(candidate.id), `duplicate conversion candidate ${candidate.id}`);
    unique.set(candidate.id, candidate);
  }
  const candidates = [...unique.values()];
  const eligibleSetSha256 = exactSetHash(candidates.map((candidate) => sha256Canonical(candidate)));
  if (candidates.length < input.plan.minEligibleCardinality) {
    return { selected: null, freshnessEvidence: "missing", eligibleSetSha256 };
  }
  const selected = candidates
    .map((candidate) => ({
      candidate,
      score: sha256Canonical({ seed: input.seed, candidate }),
    }))
    .sort((a, b) => a.score.localeCompare(b.score))[0]!.candidate;
  return { selected, freshnessEvidence: "selected", eligibleSetSha256 };
}

function validateBlindOracle(oracle: BlindOracle): void {
  assert(oracle.schemaVersion === BLIND_SCHEMA_VERSION, "oracle schema");
  assert(isBlindRunProfile(oracle.profile), "oracle profile");
  assert(nonempty(oracle.experimentId), "oracle experiment");
  validateAnchor("oracle source", oracle.source);
  assertHash(oracle.transactionId, "oracle transaction");
  if (oracle.profile === BLIND_TX055_STRICT_PROFILE) {
    assert(
      sameAnchor(oracle.source, BLIND_TX055_SOURCE_ANCHOR),
      "tx055 strict oracle source anchor",
    );
    assert(
      oracle.transactionId.toLowerCase() ===
        BLIND_TX055_TRANSACTION_ID.toLowerCase(),
      "tx055 strict oracle transaction",
    );
  }
  if (oracle.profile === BLIND_TX02_STRICT_PROFILE) {
    assert(
      sameAnchor(oracle.source, BLIND_TX02_SOURCE_ANCHOR),
      "tx02 strict oracle source anchor",
    );
    assert(
      oracle.transactionId.toLowerCase() ===
        BLIND_TX02_TRANSACTION_ID.toLowerCase(),
      "tx02 strict oracle transaction",
    );
  }
  assert(oracle.targetRoute.length > 0, "oracle target route");
  validateRoute("oracle target route", oracle.targetRoute);
  assert(oracle.expectedOrderedEdgeIds.length > 0, "oracle ordered edges");
  assert(oracle.expectedRequiredStateKeys.length > 0, "oracle state keys");
  assert(oracle.expectedPricedEdgeIds.length > 0, "oracle priced edges");
  validateUniqueStrings("oracle ordered edges", oracle.expectedOrderedEdgeIds);
  validateUniqueStrings("oracle state keys", oracle.expectedRequiredStateKeys);
  validateUniqueStrings("oracle priced edges", oracle.expectedPricedEdgeIds);
  assert(oracle.expectedSimulation.success === true, "oracle simulation success");
  assert(
    /^-?[0-9]+$/.test(oracle.expectedSimulation.profitRaw),
    "oracle simulation profit",
  );
  assert(
    /^[0-9]+$/.test(oracle.expectedSimulation.gasUsed),
    "oracle simulation gas",
  );
  assertHash(
    oracle.expectedSimulation.calldataSha256,
    "oracle simulation calldata",
  );
  assert(
    oracle.expectedSimulation.standingPosition === false,
    "oracle simulation standing position",
  );
  assert(
    oracle.expectedEv.decision === "allow" || oracle.expectedEv.decision === "reject",
    "oracle EV decision",
  );
  assert(nonempty(oracle.expectedEv.reason), "oracle EV reason");
}

function validateProducerOutputShape(output: BlindProducerOutput): void {
  assert(output.schemaVersion === BLIND_SCHEMA_VERSION, "producer schema");
  assert(isBlindRunProfile(output.profile), "producer profile");
  assert(nonempty(output.experimentId), "producer experiment");
  assert(
    output.caseId === "primary" || output.caseId === "held-out",
    "producer caseId",
  );
  assert(output.side === "baseline" || output.side === "challenger", "producer side");
  assert(Number.isSafeInteger(output.runIndex) && output.runIndex >= 0, "producer run index");
  validateAnchor("producer base", output.base);
  validateAnchor("producer source", output.source);
  for (const hash of [
    output.productionEntrySha256,
    output.resolvedConfigSha256,
    output.universeSha256,
    output.activeFamilyManifestSha256,
    output.baseGraphViewSha256,
    output.sourceDeltaSha256,
    output.backendIdentitySha256,
    output.graph.orderedEdgeHash,
    output.pricingCoverage.expectedStateKeyHash,
    output.pricingCoverage.resolvedStateKeyHash,
    output.pricingCoverage.expectedPricedEdgeHash,
    output.pricingCoverage.resolvedPricedEdgeHash,
  ]) {
    assertHash(hash, "producer binding");
  }
  for (const [receipt, kind, expected] of [
    [
      output.artifactReceipts.resolvedConfig,
      "resolved-config",
      output.resolvedConfigSha256,
    ],
    [
      output.artifactReceipts.universe,
      "production-universe",
      output.universeSha256,
    ],
    [
      output.artifactReceipts.activeFamilyManifest,
      "active-family-manifest",
      output.activeFamilyManifestSha256,
    ],
    [
      output.artifactReceipts.baseGraphView,
      "base-graph-view",
      output.baseGraphViewSha256,
    ],
    [
      output.artifactReceipts.sourceDelta,
      "source-delta",
      output.sourceDeltaSha256,
    ],
  ] as const) {
    validateBlindProductionArtifactReceipt(receipt, kind);
    assert(receipt.sha256 === expected, `producer ${kind} receipt binding`);
  }
  assert(output.selectionMode === "production", "producer selection mode");
  assert(
    Number.isSafeInteger(output.forcedSelectionCount) && output.forcedSelectionCount >= 0,
    "producer forced selection count",
  );
  assert(output.stages.length === BLIND_STAGE_NAMES.length, "producer six stages");
  let cumulative = 0;
  let previousArtifactSha256: string | null = null;
  for (let index = 0; index < BLIND_STAGE_NAMES.length; index += 1) {
    const stage = output.stages[index]!;
    validateStageEvidence(
      stage,
      BLIND_STAGE_NAMES[index]!,
      previousArtifactSha256,
    );
    assert(Number.isFinite(stage.stageMs) && stage.stageMs >= 0, "producer stageMs");
    assert(Number.isFinite(stage.cumulativeMs) && stage.cumulativeMs >= cumulative, "producer cumulativeMs");
    assert(stage.cumulativeMs + 0.001 >= cumulative + stage.stageMs, "producer stage timing");
    cumulative = stage.cumulativeMs;
    previousArtifactSha256 = stage.artifactSha256;
  }
  validateStageProjectionChain(output);
  validateUniqueStrings("producer ordered edges", output.graph.orderedEdgeIds);
  validateUniqueStrings("producer expected state keys", output.pricingCoverage.expectedStateKeys);
  validateUniqueStrings("producer resolved state keys", output.pricingCoverage.resolvedStateKeys);
  validateUniqueStrings("producer expected priced edges", output.pricingCoverage.expectedPricedEdgeIds);
  validateUniqueStrings("producer resolved priced edges", output.pricingCoverage.resolvedPricedEdgeIds);
  const telemetry = output.telemetry;
  assert(Number.isSafeInteger(telemetry.dynamicCacheGeneration), "producer cache generation");
  assert(typeof telemetry.dynamicCacheReset === "boolean", "producer cache reset");
  assert(typeof telemetry.sourceDeltaApplied === "boolean", "producer source delta");
  assert(nonempty(telemetry.cleanForkId), "producer clean fork");
  assert(
    [
      "local-reth",
      "local-content-addressed-state",
      "local-snapshot",
    ].includes(telemetry.backendUpstreamKind),
    "producer backend upstream kind",
  );
  assertHash(
    telemetry.backendAttestationSha256,
    "producer backend attestation",
  );
  assertHash(telemetry.basePreStateRoot, "producer base pre-state root");
  assertHash(telemetry.sourceStateRoot, "producer source state root");
  assert(Number.isSafeInteger(telemetry.freshReadCount), "producer fresh read count");
  assert(Number.isSafeInteger(telemetry.batchCount), "producer batch count");
  assert(
    Number.isSafeInteger(telemetry.loopbackRpcCalls) &&
      telemetry.loopbackRpcCalls >= 0,
    "producer loopback call count",
  );
  assert(
    Number.isSafeInteger(telemetry.nonLoopbackUpstreamRpcCalls) &&
      telemetry.nonLoopbackUpstreamRpcCalls >= 0,
    "producer non-loopback call count",
  );
  validateUniqueStrings("producer incomplete families", telemetry.incompleteFamilyIds);
  assert(Array.isArray(output.opportunities), "producer opportunities");
  const routeHashes = new Set<string>();
  for (const opportunity of output.opportunities) {
    assert(
      Number.isSafeInteger(opportunity.rank) && opportunity.rank > 0,
      "producer opportunity rank",
    );
    validateRoute("producer opportunity route", opportunity.route);
    const routeHash = sha256Canonical(opportunity.route);
    assert(!routeHashes.has(routeHash), "producer duplicate opportunity route");
    routeHashes.add(routeHash);
    assert(typeof opportunity.refined === "boolean", "producer refined flag");
    assert(
      Number.isSafeInteger(opportunity.planCount) && opportunity.planCount >= 0,
      "producer plan count",
    );
    assert(typeof opportunity.simulation.executed === "boolean", "producer simulation executed");
    assert(typeof opportunity.simulation.success === "boolean", "producer simulation success");
    assert(/^-?[0-9]+$/.test(opportunity.simulation.profitRaw), "producer profitRaw");
    assert(/^[0-9]+$/.test(opportunity.simulation.gasUsed), "producer gasUsed");
    assertHash(opportunity.simulation.calldataSha256, "producer calldata hash");
    assert(
      typeof opportunity.simulation.standingPosition === "boolean",
      "producer standing-position flag",
    );
    assert(
      opportunity.ev.executionStatus === "pass" ||
        opportunity.ev.executionStatus === "not_run",
      "producer EV execution status",
    );
    assert(
      opportunity.ev.decision === "allow" || opportunity.ev.decision === "reject",
      "producer EV decision",
    );
    assert(nonempty(opportunity.ev.reason), "producer EV reason");
  }
}

function validateStageEvidence(
  stage: BlindStageEvidence,
  expectedName: BlindStageName,
  expectedPreviousArtifactSha256: string | null,
): void {
  assertExactKeys(stage, [
    "artifact",
    "artifactSha256",
    "cumulativeMs",
    "name",
    "stageMs",
    "status",
  ], `producer ${expectedName} stage`);
  assert(stage.name === expectedName, `producer ${expectedName} stage name`);
  assert(
    stage.status === "pass" ||
      stage.status === "fail" ||
      stage.status === "not_run" ||
      stage.status === "bypassed",
    "producer stage status",
  );
  assertHash(stage.artifactSha256, "producer stage artifact");
  const artifact = stage.artifact;
  assert(
    artifact.schemaVersion ===
      BLIND_PRODUCTION_STAGE_ARTIFACT_SCHEMA_VERSION,
    `producer ${expectedName} artifact schema`,
  );
  assert(
    artifact.name === expectedName,
    `producer ${expectedName} artifact name`,
  );
  assert(
    artifact.previousArtifactSha256 === expectedPreviousArtifactSha256,
    `producer ${expectedName} previous artifact hash chain`,
  );
  if (artifact.previousArtifactSha256 !== null) {
    assertHash(
      artifact.previousArtifactSha256,
      `producer ${expectedName} previous artifact`,
    );
  }
  if (artifact.name === "state_ready") {
    assertExactKeys(artifact, [
      "graph",
      "name",
      "previousArtifactSha256",
      "pricingCoverage",
      "schemaVersion",
    ], `producer ${expectedName} artifact`);
    validateStageGraph(artifact.graph);
    validateStagePricingCoverage(artifact.pricingCoverage);
  } else {
    assertExactKeys(artifact, [
      "name",
      "opportunities",
      "previousArtifactSha256",
      "schemaVersion",
    ], `producer ${expectedName} artifact`);
    validateStageOpportunities(artifact.name, artifact.opportunities);
  }
  assert(
    stage.artifactSha256 ===
      blindProductionStageArtifactSha256(artifact),
    `producer ${expectedName} stage artifact hash mismatch`,
  );
}

function validateStageGraph(
  graph: Extract<
    BlindProductionStageArtifact,
    { readonly name: "state_ready" }
  >["graph"],
): void {
  assertExactKeys(
    graph,
    ["orderedEdgeHash", "orderedEdgeIds"],
    "producer state graph artifact",
  );
  assert(Array.isArray(graph.orderedEdgeIds), "producer state graph edges");
  validateUniqueStrings("producer state graph edges", graph.orderedEdgeIds);
  assertHash(graph.orderedEdgeHash, "producer state graph hash");
  assert(
    graph.orderedEdgeHash === exactOrderedHash(graph.orderedEdgeIds),
    "producer state graph ordered hash mismatch",
  );
}

function validateStagePricingCoverage(
  coverage: Extract<
    BlindProductionStageArtifact,
    { readonly name: "state_ready" }
  >["pricingCoverage"],
): void {
  assertExactKeys(coverage, [
    "expectedPricedEdgeHash",
    "expectedPricedEdgeIds",
    "expectedStateKeyHash",
    "expectedStateKeys",
    "resolvedPricedEdgeHash",
    "resolvedPricedEdgeIds",
    "resolvedStateKeyHash",
    "resolvedStateKeys",
  ], "producer state pricing artifact");
  for (const [label, values, hash] of [
    [
      "expected state",
      coverage.expectedStateKeys,
      coverage.expectedStateKeyHash,
    ],
    [
      "resolved state",
      coverage.resolvedStateKeys,
      coverage.resolvedStateKeyHash,
    ],
    [
      "expected priced edge",
      coverage.expectedPricedEdgeIds,
      coverage.expectedPricedEdgeHash,
    ],
    [
      "resolved priced edge",
      coverage.resolvedPricedEdgeIds,
      coverage.resolvedPricedEdgeHash,
    ],
  ] as const) {
    assert(Array.isArray(values), `producer state ${label} values`);
    validateUniqueStrings(`producer state ${label} values`, values);
    assertHash(hash, `producer state ${label} hash`);
    assert(
      hash === exactSetHash(values),
      `producer state ${label} hash mismatch`,
    );
  }
}

function validateStageOpportunities(
  name: Exclude<BlindStageName, "state_ready">,
  opportunities:
    | readonly BlindProductionEnumerationStageOpportunity[]
    | readonly BlindProductionRefineStageOpportunity[]
    | readonly BlindProductionPlannerStageOpportunity[]
    | readonly BlindProductionFinalSimStageOpportunity[]
    | readonly BlindProductionEvStageOpportunity[],
): void {
  assert(Array.isArray(opportunities), `producer ${name} opportunities`);
  const expectedKeys = {
    enumeration_done: ["rank", "route"],
    exact_refine_done: ["rank", "refined", "route"],
    planner_solver_done: ["planCount", "rank", "refined", "route"],
    final_sim_done: [
      "planCount",
      "rank",
      "refined",
      "route",
      "simulation",
    ],
    ev_decision: [
      "ev",
      "planCount",
      "rank",
      "refined",
      "route",
      "simulation",
    ],
  } as const;
  const ranks = new Set<number>();
  const routes = new Set<string>();
  for (const opportunity of opportunities) {
    assertExactKeys(
      opportunity,
      expectedKeys[name],
      `producer ${name} opportunity`,
    );
    assert(
      Number.isSafeInteger(opportunity.rank) && opportunity.rank > 0,
      `producer ${name} opportunity rank`,
    );
    assert(!ranks.has(opportunity.rank), `producer ${name} duplicate rank`);
    ranks.add(opportunity.rank);
    validateRoute(`producer ${name} route`, opportunity.route);
    const routeHash = sha256Canonical(opportunity.route);
    assert(!routes.has(routeHash), `producer ${name} duplicate route`);
    routes.add(routeHash);
    if (name !== "enumeration_done") {
      const refined = opportunity as BlindProductionRefineStageOpportunity;
      assert(
        typeof refined.refined === "boolean",
        `producer ${name} refined`,
      );
    }
    if (
      name === "planner_solver_done" ||
      name === "final_sim_done" ||
      name === "ev_decision"
    ) {
      const planned = opportunity as BlindProductionPlannerStageOpportunity;
      assert(
        Number.isSafeInteger(planned.planCount) && planned.planCount >= 0,
        `producer ${name} planCount`,
      );
    }
    if (name === "final_sim_done" || name === "ev_decision") {
      validateStageSimulation(
        (opportunity as BlindProductionFinalSimStageOpportunity).simulation,
        `producer ${name} simulation`,
      );
    }
    if (name === "ev_decision") {
      validateStageEv(
        (opportunity as BlindProductionEvStageOpportunity).ev,
        "producer ev_decision EV",
      );
    }
  }
}

function validateStageSimulation(
  simulation: BlindProductionFinalSimStageOpportunity["simulation"],
  label: string,
): void {
  assertExactKeys(simulation, [
    "calldataSha256",
    "executed",
    "gasUsed",
    "profitRaw",
    "standingPosition",
    "success",
  ], label);
  assert(typeof simulation.executed === "boolean", `${label} executed`);
  assert(typeof simulation.success === "boolean", `${label} success`);
  assert(/^-?[0-9]+$/.test(simulation.profitRaw), `${label} profitRaw`);
  assert(/^[0-9]+$/.test(simulation.gasUsed), `${label} gasUsed`);
  assertHash(simulation.calldataSha256, `${label} calldata`);
  assert(
    typeof simulation.standingPosition === "boolean",
    `${label} standing position`,
  );
}

function validateStageEv(
  ev: BlindProductionEvStageOpportunity["ev"],
  label: string,
): void {
  assertExactKeys(
    ev,
    ["decision", "executionStatus", "reason"],
    label,
  );
  assert(
    ev.executionStatus === "pass" || ev.executionStatus === "not_run",
    `${label} execution status`,
  );
  assert(
    ev.decision === "allow" || ev.decision === "reject",
    `${label} decision`,
  );
  assert(nonempty(ev.reason), `${label} reason`);
}

function validateStageProjectionChain(output: BlindProducerOutput): void {
  const state = output.stages[0]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "state_ready" }
  >;
  const enumeration = output.stages[1]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "enumeration_done" }
  >;
  const refine = output.stages[2]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "exact_refine_done" }
  >;
  const planner = output.stages[3]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "planner_solver_done" }
  >;
  const finalSim = output.stages[4]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "final_sim_done" }
  >;
  const ev = output.stages[5]!.artifact as Extract<
    BlindProductionStageArtifact,
    { readonly name: "ev_decision" }
  >;
  assert(
    sha256Canonical(state.graph) === sha256Canonical(output.graph),
    "producer state artifact graph does not bind final graph",
  );
  assert(
    sha256Canonical(state.pricingCoverage) ===
      sha256Canonical(output.pricingCoverage),
    "producer state artifact pricing does not bind final coverage",
  );
  assertStageOpportunityPrefix(
    enumeration.opportunities,
    refine.opportunities,
    ["rank", "route"],
    "enumeration/refine",
  );
  assertStageOpportunityPrefix(
    refine.opportunities,
    planner.opportunities,
    ["rank", "route", "refined"],
    "refine/planner",
  );
  assertStageOpportunityPrefix(
    planner.opportunities,
    finalSim.opportunities,
    ["rank", "route", "refined", "planCount"],
    "planner/final-sim",
  );
  assertStageOpportunityPrefix(
    finalSim.opportunities,
    ev.opportunities,
    ["rank", "route", "refined", "planCount", "simulation"],
    "final-sim/EV",
  );
  assert(
    sha256Canonical(ev.opportunities) ===
      sha256Canonical(output.opportunities),
    "producer EV artifact does not bind final opportunities",
  );
}

function assertStageOpportunityPrefix(
  earlier: readonly unknown[],
  later: readonly object[],
  keys: readonly string[],
  label: string,
): void {
  const projected = later.map((opportunity) => {
    const fields = opportunity as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => [key, fields[key]]));
  });
  assert(
    sha256Canonical(earlier) === sha256Canonical(projected),
    `producer stage projection changed across ${label}`,
  );
}

export function validateBlindProducerOutput(output: BlindProducerOutput): void {
  validateProducerOutputShape(output);
}

function validateOutputAgainstManifest(
  manifest: BlindRunManifest,
  sealed: SealedBlindProducerOutput,
  oracle: BlindOracle,
  failures: string[],
): void {
  const output = sealed.output;
  try {
    validateProducerOutputShape(output);
  } catch (error) {
    failures.push(`${runKey(output)} invalid output: ${message(error)}`);
    return;
  }
  const key = runKey(output);
  const run = manifestCase(manifest, output.caseId);
  if (output.experimentId !== manifest.experimentId) failures.push(`${key} experiment mismatch`);
  if (output.profile !== manifest.profile) failures.push(`${key} profile mismatch`);
  if (!sameAnchor(output.base, run.base)) failures.push(`${key} base mismatch`);
  if (!sameAnchor(output.source, run.source)) failures.push(`${key} source mismatch`);
  if (output.productionEntrySha256 !== manifest.producers[output.side].productionEntry.sha256) {
    failures.push(`${key} production entry mismatch`);
  }
  for (const [label, actual, expected] of [
    ["config", output.resolvedConfigSha256, run.inputs.resolvedConfig.sha256],
    ["universe", output.universeSha256, run.inputs.universe.sha256],
    ["active manifest", output.activeFamilyManifestSha256, run.inputs.activeFamilyManifest.sha256],
    ["N-1 graph view", output.baseGraphViewSha256, run.inputs.baseGraphView.sha256],
    ["N source delta", output.sourceDeltaSha256, run.inputs.sourceDelta.sha256],
    [
      "backend identity",
      output.backendIdentitySha256,
      manifest.producers[output.side].cases[output.caseId].backendIdentity.sha256,
    ],
  ] as const) {
    if (actual !== expected) failures.push(`${key} ${label} mismatch`);
  }
  if (output.selectionMode !== "production" || output.forcedSelectionCount !== 0) {
    failures.push(`${key} target was not naturally selected`);
  }
  if (output.stages.some((stage) => stage.status !== "pass")) {
    failures.push(`${key} has failed/not-run/bypassed stage`);
  }
  const lastStage = output.stages.at(-1);
  if (lastStage && sealed.runnerElapsedMs + 1 < lastStage.cumulativeMs) {
    failures.push(`${key} producer timing exceeds trusted runner timing`);
  }
  if (output.graph.orderedEdgeHash !== exactOrderedHash(output.graph.orderedEdgeIds)) {
    failures.push(`${key} invalid ordered graph hash`);
  }
  if (
    output.caseId === "primary" &&
    exactOrderedHash(output.graph.orderedEdgeIds) !==
      exactOrderedHash(oracle.expectedOrderedEdgeIds)
  ) {
    failures.push(`${key} graph does not match sealed oracle`);
  }
  const coverage = output.pricingCoverage;
  if (
    coverage.expectedStateKeyHash !== exactSetHash(coverage.expectedStateKeys) ||
    coverage.resolvedStateKeyHash !== exactSetHash(coverage.resolvedStateKeys) ||
    coverage.expectedPricedEdgeHash !== exactSetHash(coverage.expectedPricedEdgeIds) ||
    coverage.resolvedPricedEdgeHash !== exactSetHash(coverage.resolvedPricedEdgeIds)
  ) {
    failures.push(`${key} invalid coverage hash`);
  }
  if (coverage.resolvedStateKeyHash !== coverage.expectedStateKeyHash) {
    failures.push(`${key} incomplete/wrong current-N state coverage`);
  }
  if (coverage.resolvedPricedEdgeHash !== coverage.expectedPricedEdgeHash) {
    failures.push(`${key} incomplete/wrong priced-edge coverage`);
  }
  if (
    output.caseId === "primary" &&
    (
      coverage.expectedStateKeyHash !==
        exactSetHash(oracle.expectedRequiredStateKeys) ||
      coverage.expectedPricedEdgeHash !==
        exactSetHash(oracle.expectedPricedEdgeIds)
    )
  ) {
    failures.push(`${key} primary coverage does not match sealed oracle`);
  }
  const telemetry = output.telemetry;
  if (
    !Number.isSafeInteger(telemetry.dynamicCacheGeneration) ||
    telemetry.dynamicCacheGeneration <= 0 ||
    !telemetry.dynamicCacheReset ||
    !telemetry.sourceDeltaApplied ||
    !nonempty(telemetry.cleanForkId) ||
    telemetry.backendAttestationSha256 !==
      manifest.producers[output.side].cases[output.caseId].backendIdentity.sha256 ||
    telemetry.basePreStateRoot.toLowerCase() !==
      run.base.stateRoot.toLowerCase() ||
    telemetry.sourceStateRoot.toLowerCase() !==
      run.source.stateRoot.toLowerCase() ||
    !Number.isSafeInteger(telemetry.freshReadCount) ||
    telemetry.freshReadCount <= 0 ||
    !Number.isSafeInteger(telemetry.batchCount) ||
    telemetry.batchCount <= 0 ||
    telemetry.nonLoopbackUpstreamRpcCalls !== 0 ||
    telemetry.incompleteFamilyIds.length !== 0
  ) {
    failures.push(`${key} fresh local source-state evidence incomplete`);
  }
  if (output.caseId === "held-out") return;
  const target = targetOpportunity(output, oracle.targetRoute);
  if (!target) {
    failures.push(`${key} target route not naturally enumerated`);
  } else if (
    target.rank <= 0 ||
    !target.refined ||
    target.planCount <= 0 ||
    !target.simulation.executed ||
    target.simulation.success !== oracle.expectedSimulation.success ||
    target.simulation.profitRaw !== oracle.expectedSimulation.profitRaw ||
    target.simulation.gasUsed !== oracle.expectedSimulation.gasUsed ||
    target.simulation.calldataSha256 !==
      oracle.expectedSimulation.calldataSha256 ||
    target.simulation.standingPosition !==
      oracle.expectedSimulation.standingPosition ||
    target.ev.executionStatus !== "pass" ||
    target.ev.decision !== oracle.expectedEv.decision ||
    target.ev.reason !== oracle.expectedEv.reason
  ) {
    failures.push(`${key} target did not complete six-stage execution`);
  }
}

function targetOpportunity(
  output: BlindProducerOutput,
  expectedRoute: readonly BlindRouteStep[],
): BlindOpportunityEvidence | null {
  const hash = sha256Canonical(expectedRoute);
  return output.opportunities.find((opportunity) => sha256Canonical(opportunity.route) === hash) ?? null;
}

function productionSemantics(output: BlindProducerOutput): unknown {
  return {
    artifactReceipts: output.artifactReceipts,
    stages: output.stages.map(({ name, status, artifact, artifactSha256 }) => ({
      name,
      status,
      artifact,
      artifactSha256,
    })),
    graph: output.graph,
    pricingCoverage: output.pricingCoverage,
    opportunities: output.opportunities,
  };
}

function validateRoute(label: string, route: readonly BlindRouteStep[]): void {
  assert(Array.isArray(route) && route.length > 0, `${label} must be non-empty`);
  for (const step of route) {
    assertExactKeys(step, [
      "adapterId",
      "executionVariantKey",
      "familyId",
      "target",
      "tokenIn",
      "tokenOut",
    ], `${label} step`);
    assert(nonempty(step.familyId), `${label} family`);
    assert(nonempty(step.adapterId), `${label} adapter`);
    assert(nonempty(step.target), `${label} target`);
    assert(nonempty(step.tokenIn), `${label} tokenIn`);
    assert(nonempty(step.tokenOut), `${label} tokenOut`);
    assert(nonempty(step.executionVariantKey), `${label} execution variant`);
  }
}

function runKey(
  output: Pick<BlindProducerOutput, "caseId" | "side" | "runIndex">,
): string {
  return `${output.caseId}:${output.side}:${output.runIndex}`;
}

function runOrderKey(
  entry: Pick<BlindRunOrderEntry, "caseId" | "side" | "runIndex">,
): string {
  return `${entry.caseId}:${entry.side}:${entry.runIndex}`;
}

function manifestCase(
  manifest: BlindRunManifest,
  caseId: BlindRunCaseId,
): {
  readonly base: BlindBlockAnchor;
  readonly source: BlindBlockAnchor;
  readonly inputs: BlindRunInputs;
} {
  return caseId === "primary"
    ? {
        base: manifest.base,
        source: manifest.source,
        inputs: manifest.inputs,
      }
    : manifest.heldOut;
}

function producerSessions(
  manifest: BlindRunManifest,
): readonly {
  readonly side: BlindSide;
  readonly caseId: BlindRunCaseId;
  readonly session: BlindProducerSessionBinding;
}[] {
  return (["baseline", "challenger"] as const).flatMap((side) =>
    (["primary", "held-out"] as const).map((caseId) => ({
      side,
      caseId,
      session: manifest.producers[side].cases[caseId],
    }))
  );
}

export function isBlindRunProfile(value: unknown): value is BlindRunProfile {
  return value === BLIND_GENERIC_PROFILE ||
    value === BLIND_TX055_STRICT_PROFILE ||
    value === BLIND_TX02_STRICT_PROFILE;
}

function validateAnchor(label: string, anchor: BlindBlockAnchor): void {
  assert(Number.isSafeInteger(anchor.number) && anchor.number >= 0, `${label} number`);
  assertHash(anchor.hash, `${label} hash`);
  assertHash(anchor.stateRoot, `${label} state root`);
}

function sameAnchor(left: BlindBlockAnchor, right: BlindBlockAnchor): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.stateRoot.toLowerCase() === right.stateRoot.toLowerCase();
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} contains unexpected or missing fields`,
  );
}

function assertHash(value: string, label: string): void {
  assert(/^(?:0x)?[0-9a-f]{64}$/i.test(value), `${label} must be sha256/bytes32 hex`);
}

function validateUniqueStrings(label: string, values: readonly string[]): void {
  assert(values.every(nonempty), `${label} contains empty value`);
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
}

function nonempty(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?|wss?):\/\//i.test(value);
}

function looksSecretEnvName(value: string): boolean {
  return /(?:^|_)(?:PRIVATE_KEY|OWNER_PRIVATE_KEY|WALLET_KEY|SIGNER_KEY|API_KEY|ACCESS_KEY(?:_ID)?|SECRET_KEY|KEYSTORE|MNEMONIC|PASSWORD|SECRET|TOKEN)(?:$|_)/
    .test(value.toUpperCase());
}

function looksPrivateKeyValue(value: string): boolean {
  return /^(?:0x)?[0-9a-f]{64}$/i.test(value.trim());
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}

function assert(condition: unknown, messageText: string): asserts condition {
  if (!condition) throw new Error(messageText);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMonotonicNs(value: string, label: string): bigint {
  assert(/^[0-9]+$/.test(value), label);
  return BigInt(value);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}
