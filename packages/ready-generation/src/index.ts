import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { assertPromotablePartition, type AttestationPartitionV1 } from "../../attestation/src/index.ts";
import type { InstanceCatalogV1, InstancePublicationV1 } from "../../catalog/src/index.ts";
import {
  validateSourceCoverageCertificate,
  validateCanonicalCutoff,
  type BlockRangeV1,
  type CanonicalCutoffV1,
  type SourceCoverageCertificateV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import {
  buildPersistedGraph,
  validatePersistedGraphForCatalog,
  type GraphLeaseBindingV1,
  type GraphServingAdmissionGuardPort,
  type GraphServingAdmissionV1,
  type PersistedGraphV1,
} from "../../graph/src/index.ts";
import {
  validatePromotionFreshnessReceipt,
  CanonicalSourceError,
  type PromotionFreshnessAuthorityV1,
  type PromotionFreshnessReceiptV1,
  type PromotionFreshnessRequestV1,
} from "../../canonical-source/src/index.ts";
import { sourcePlanSetRoot } from "../../discovery/src/index.ts";
import type { NominationClosureV1 } from "../../../specs/nomination-authority/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type CurrentRuntimeAuthorityPortV1,
  type RuntimeReleaseProvenanceHashV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
export type {
  CurrentRuntimeAuthorityPortV1,
  RuntimeReleaseProvenanceHashV1,
} from "../../runtime-authority/src/index.ts";

function readCurrentRuntimeAuthority(
  port: CurrentRuntimeAuthorityPortV1,
): ReturnType<CurrentRuntimeAuthorityPortV1["readCurrent"]> {
  if (port === null || typeof port !== "object" || typeof port.readCurrent !== "function") {
    throw new TypeError("current runtime authority port is invalid");
  }
  const value = port.readCurrent();
  assertPlainObject(value, "currentRuntimeAuthority");
  assertExactKeys(value, ["runtimeAuthority", "releaseProvenanceHash"], "currentRuntimeAuthority");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(
    readOwnEnumerableDataProperty(value, "runtimeAuthority", "currentRuntimeAuthority"),
  );
  const rawReleaseProvenanceHash = readOwnEnumerableDataProperty(
    value,
    "releaseProvenanceHash",
    "currentRuntimeAuthority",
  );
  if (runtimeAuthority.authorityClass === "signed-release") {
    return deepFreeze({
      runtimeAuthority,
      releaseProvenanceHash: assertHash(
        rawReleaseProvenanceHash,
        "currentRuntimeAuthority.releaseProvenanceHash",
      ),
    });
  }
  if (rawReleaseProvenanceHash !== null) {
    throw new TypeError("unsigned dry-run runtime authority cannot carry release provenance");
  }
  return deepFreeze({ runtimeAuthority, releaseProvenanceHash: null });
}

function runtimeAuthoritiesEqual(
  left: RuntimeAuthorityProjectionV1,
  right: RuntimeAuthorityProjectionV1,
): boolean {
  return left.authorityClass === right.authorityClass
    && left.authorityBindingHash === right.authorityBindingHash
    && left.implementationCommit === right.implementationCommit;
}

function decodeReleaseProvenanceHash(
  value: unknown,
  runtimeAuthority: RuntimeAuthorityProjectionV1,
  path: string,
): RuntimeReleaseProvenanceHashV1 {
  if (runtimeAuthority.authorityClass === "unsigned-dry-run") {
    if (value !== null) throw new TypeError(`${path} must be null for unsigned dry-run`);
    return null;
  }
  return assertHash(value, path);
}

export interface GenerationRefreshPolicyV1 {
  readonly observationWindowBlocks: "50";
  readonly targetRefreshAgeBlocks: string;
  readonly maxServingAgeBlocks: string;
  readonly minPromotionMarginBlocks: string;
  readonly maxInProgressRuns: "1";
}

export type ReadyPromotionAbandonReasonV1 =
  | "definition-catalog-changed"
  | "source-plan-changed"
  | "policy-changed"
  | "release-binding-changed"
  | "cutoff-revoked"
  | "cutoff-too-old";

export type ReadyPromotionFailureCodeV1 =
  | ReadyPromotionAbandonReasonV1
  | "ready-promotion-input-mismatch"
  | "ready-promotion-stage-mismatch"
  | "ready-promotion-authority-invalid"
  | "ready-promotion-retry"
  | "ready-promotion-fatal";

/**
 * A durable staged promotion may be discarded only for this explicit class.
 * Integrity, storage, CAS and implementation failures deliberately remain
 * ordinary errors: rebuilding on those failures would hide a defect and can
 * turn startup into an unbounded abandon/rebuild loop.
 */
export type ReadyPromotionRecoveryKindV1 = "abandon" | "retry" | "fatal";

const READY_PROMOTION_ERRORS = new WeakSet<object>();
const READY_PROMOTION_ABANDON_AUTHORITIES = new WeakMap<object, {
  readonly stage: ReadyStageIdentityV1;
  readonly reason: ReadyPromotionAbandonReasonV1;
}>();
const READY_PROMOTION_ABANDON_CODES = new Set<ReadyPromotionAbandonReasonV1>([
  "definition-catalog-changed",
  "source-plan-changed",
  "policy-changed",
  "cutoff-revoked",
  "cutoff-too-old",
]);

export interface ReadyPromotionAbandonAuthorizationV1 {
  readonly opaque: object;
}

class ReadyPromotionError extends Error {
  readonly code: ReadyPromotionFailureCodeV1;
  readonly recovery: ReadyPromotionRecoveryKindV1;

  constructor(code: ReadyPromotionFailureCodeV1, recovery: ReadyPromotionRecoveryKindV1) {
    super(code);
    this.name = "ReadyPromotionError";
    this.code = code;
    this.recovery = recovery;
    READY_PROMOTION_ERRORS.add(this);
  }
}

class ReadyPromotionIncompatibleError extends ReadyPromotionError {
  constructor(code: ReadyPromotionAbandonReasonV1) {
    super(code, "abandon");
    this.name = "ReadyPromotionIncompatibleError";
  }
}

export class ReadyPromotionRetryError extends ReadyPromotionError {
  constructor(code: "ready-promotion-retry" = "ready-promotion-retry") {
    super(code, "retry");
    this.name = "ReadyPromotionRetryError";
  }
}

export class ReadyPromotionFatalError extends ReadyPromotionError {
  constructor(code: Exclude<ReadyPromotionFailureCodeV1, ReadyPromotionAbandonReasonV1 | "ready-promotion-retry"> = "ready-promotion-fatal") {
    super(code, "fatal");
    this.name = "ReadyPromotionFatalError";
  }
}

export interface ReadyPromotionErrorDescriptorV1 {
  readonly code: ReadyPromotionFailureCodeV1;
  readonly recovery: ReadyPromotionRecoveryKindV1;
}

/**
 * Cross-package recovery classification.  The WeakSet prevents an arbitrary
 * object with `{ recovery: "abandon" }` from becoming an authority to delete
 * durable state; callers must receive an error issued by this module.
 */
export function readReadyPromotionError(error: unknown): ReadyPromotionErrorDescriptorV1 | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  if (!READY_PROMOTION_ERRORS.has(error)) return null;
  const value = error as { readonly code?: unknown; readonly recovery?: unknown };
  if (
    typeof value.code !== "string"
    || (value.recovery !== "abandon" && value.recovery !== "retry" && value.recovery !== "fatal")
  ) return null;
  if (value.recovery === "abandon") {
    if (!READY_PROMOTION_ABANDON_CODES.has(value.code as ReadyPromotionAbandonReasonV1)) return null;
    return Object.freeze({
      code: value.code as ReadyPromotionFailureCodeV1,
      recovery: value.recovery,
    });
  }
  return Object.freeze({ code: value.code as ReadyPromotionFailureCodeV1, recovery: value.recovery });
}

export function authorizeReadyPromotionAbandon(
  error: unknown,
  stage: ReadyStageIdentityV1,
): ReadyPromotionAbandonAuthorizationV1 | null {
  const descriptor = readReadyPromotionError(error);
  if (descriptor?.recovery !== "abandon") return null;
  validateReadyStageIdentity(stage);
  const normalizedStage = decodeCanonicalJson(
    encodeCanonicalBytes(stage),
  ) as unknown as ReadyStageIdentityV1;
  validateReadyStageIdentity(normalizedStage);
  const opaque = Object.freeze({});
  READY_PROMOTION_ABANDON_AUTHORITIES.set(opaque, deepFreeze({
    stage: normalizedStage,
    reason: descriptor.code as ReadyPromotionAbandonReasonV1,
  }));
  return Object.freeze({ opaque });
}

export function assertReadyPromotionAbandonAuthorization(
  value: ReadyPromotionAbandonAuthorizationV1,
  stage: ReadyStageIdentityV1,
): ReadyPromotionAbandonReasonV1 {
  validateReadyStageIdentity(stage);
  if (value === null || typeof value !== "object") throw new ReadyPromotionFatalError("ready-promotion-authority-invalid");
  if (Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, "opaque")) {
    throw new ReadyPromotionFatalError("ready-promotion-authority-invalid");
  }
  const opaque = (value as { readonly opaque?: unknown }).opaque;
  const binding = opaque !== null && typeof opaque === "object"
    ? READY_PROMOTION_ABANDON_AUTHORITIES.get(opaque)
    : undefined;
  const expectedBytes = binding ? encodeCanonicalBytes(binding.stage) : null;
  const suppliedBytes = encodeCanonicalBytes(stage);
  if (
    !binding
    || expectedBytes === null
    || expectedBytes.byteLength !== suppliedBytes.byteLength
    || expectedBytes.some((byte, index) => byte !== suppliedBytes[index])
  ) {
    throw new ReadyPromotionFatalError("ready-promotion-authority-invalid");
  }
  return binding.reason;
}

export interface CurrentPromotionConfigurationV1 {
  readonly definitionCatalogRoot: Hash;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface ReadyPromotionAuthorityBindingV1 {
  readonly expectedRevision: string;
  readonly expectedInProgressRunId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly generationRefreshPolicyHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
}

/**
 * The durable identity of one staged promotion.  Every recovery operation
 * receives this complete value; a bare run id or root revision is not an
 * ownership proof and is intentionally insufficient.
 */
export interface ReadyStageIdentityV1 {
  readonly stageStorageHash: Hash;
  readonly runId: string;
  readonly expectedRevision: string;
  readonly sealedRevision: string;
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
  readonly readyBaseHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly generationRefreshPolicyHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
}

export function validateReadyStageIdentity(value: ReadyStageIdentityV1): void {
  assertPlainObject(value, "readyStageIdentity");
  assertExactKeys(value, [
    "stageStorageHash",
    "runId",
    "expectedRevision",
    "sealedRevision",
    "stageRevision",
    "stageRecordHash",
    "readyBaseHash",
    "cutoff",
    "generationRefreshPolicyHash",
    "definitionCatalogRoot",
    "runtimeAuthority",
    "releaseProvenanceHash",
    "candidatePartitionProofStorageHash",
    "nominationClosureRoot",
    "nominationClosureStorageHash",
  ], "readyStageIdentity");
  assertHash(value.stageStorageHash, "readyStageIdentity.stageStorageHash");
  assertNonEmptyString(value.runId, "readyStageIdentity.runId");
  assertDecimalString(value.expectedRevision, "readyStageIdentity.expectedRevision");
  assertDecimalString(value.sealedRevision, "readyStageIdentity.sealedRevision");
  assertDecimalString(value.stageRevision, "readyStageIdentity.stageRevision");
  assertHash(value.stageRecordHash, "readyStageIdentity.stageRecordHash");
  assertHash(value.readyBaseHash, "readyStageIdentity.readyBaseHash");
  validateCanonicalCutoff(value.cutoff, "readyStageIdentity.cutoff");
  assertHash(value.generationRefreshPolicyHash, "readyStageIdentity.generationRefreshPolicyHash");
  assertHash(value.definitionCatalogRoot, "readyStageIdentity.definitionCatalogRoot");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  decodeReleaseProvenanceHash(
    value.releaseProvenanceHash,
    runtimeAuthority,
    "readyStageIdentity.releaseProvenanceHash",
  );
  assertHash(value.candidatePartitionProofStorageHash, "readyStageIdentity.candidatePartitionProofStorageHash");
  assertHash(value.nominationClosureRoot, "readyStageIdentity.nominationClosureRoot");
  assertHash(value.nominationClosureStorageHash, "readyStageIdentity.nominationClosureStorageHash");
  if (BigInt(value.stageRevision) !== BigInt(value.expectedRevision) + 1n) {
    throw new Error("readyStageIdentity.revision-lineage-mismatch");
  }
  if (value.sealedRevision !== value.expectedRevision) {
    throw new Error("readyStageIdentity.sealed-revision-mismatch");
  }
}

export type ReadyPromotionDurableStateV1 =
  | {
    readonly kind: "committed";
    readonly stage: ReadyStageIdentityV1;
    readonly ready: ReadyGenerationV1;
  }
  | {
    readonly kind: "staged";
    readonly stage: ReadyStageIdentityV1;
  }
  | {
    readonly kind: "absent";
    readonly stage: ReadyStageIdentityV1;
    readonly activeReady: ReadyGenerationV1 | null;
  };

export type ReadyPromotionAbandonResultV1 =
  | { readonly kind: "abandoned"; readonly stage: ReadyStageIdentityV1 }
  | { readonly kind: "committed"; readonly stage: ReadyStageIdentityV1; readonly ready: ReadyGenerationV1 };

export interface ReadyPromotionAuthorityV1 {
  readonly opaque: object;
}

export interface ReadyPromotionAuthorityIssueV1 {
  readonly expectedRevision: string;
  readonly expectedInProgressRunId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface ReadyPromotionAuthorityGuardPort {
  assertConfiguration(binding: {
    readonly definitionCatalogRoot: Hash;
    readonly generationRefreshPolicyHash: Hash;
    readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
    readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  }): void;
  assertActive(authority: ReadyPromotionAuthorityV1): ReadyPromotionAuthorityBindingV1;
}

export interface ReadyPromotionAuthorityPort extends ReadyPromotionAuthorityGuardPort {
  issue(input: ReadyPromotionAuthorityIssueV1): ReadyPromotionAuthorityV1;
  revoke(authority: ReadyPromotionAuthorityV1): void;
}

const issuedPromotionAuthorityPorts = new WeakSet<object>();

export function assertIssuedReadyPromotionAuthorityPort(value: unknown): ReadyPromotionAuthorityPort {
  if (value === null || typeof value !== "object" || !issuedPromotionAuthorityPorts.has(value)) {
    throw new TypeError("ready promotion authority port is not issued");
  }
  return value as ReadyPromotionAuthorityPort;
}

export interface ReadyGenerationV1 {
  readonly generationId: string;
  readonly parentGenerationId: string | null;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRange: BlockRangeV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly edgeCount: string;
  readonly instanceCount: string;
  readonly promotionFreshness: PromotionFreshnessReceiptV1;
  readonly promotionRevision: string;
  readonly promotedAtMonotonicNs: string;
  readonly readyRecordHash: Hash;
}

/**
 * The immutable generation payload that can be validated and durably staged
 * before the final provider freshness observation.  It deliberately contains
 * no promotion receipt, revision, or record hash: those are issued only by
 * activation after freshness has been observed.
 */
export type ReadyGenerationBaseV1 = Omit<
  ReadyGenerationV1,
  "promotionFreshness" | "promotionRevision" | "promotedAtMonotonicNs" | "readyRecordHash"
>;

export type {
  SealedRunBindingV1,
  SealedRunCapabilityV1,
  SealedRunReaderPortV1,
} from "../../sealed-run-runtime/src/contract.ts";
import {
  type SealedRunCapabilityV1,
  type SealedRunReaderPortV1,
  type SealedRunSnapshotV1,
} from "../../sealed-run-runtime/src/contract.ts";
import { assertCheckpointSealedRunReader } from "../../sealed-run-runtime/src/internal/reader-consumer.ts";

export interface CanonicalFenceV1 {
  readonly token: string;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly cutoff: CanonicalCutoffV1;
}

export interface CanonicalFencePort {
  assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void>;
  ageInBlocks(cutoff: CanonicalCutoffV1): Promise<string>;
  recentObservationRange(cutoff: CanonicalCutoffV1): BlockRangeV1;
  withCanonicalFence<T>(cutoff: CanonicalCutoffV1, work: (fence: CanonicalFenceV1) => Promise<T>): Promise<T>;
  observePromotionFreshness(
    fence: CanonicalFenceV1,
    request: PromotionFreshnessRequestV1,
  ): Promise<PromotionFreshnessAuthorityV1>;
  assertPromotionFreshness(
    fence: CanonicalFenceV1,
    authority: PromotionFreshnessAuthorityV1,
  ): void;
}

export interface ReadyStageInputV1 {
  readonly authority: ReadyPromotionAuthorityV1;
  readonly policy: GenerationRefreshPolicyV1;
  readonly expectedRevision: string;
  readonly expectedInProgressRunId: string;
  readonly fence: CanonicalFenceV1;
  readonly graph: PersistedGraphV1;
  readonly instanceCatalog: InstanceCatalogV1;
  readonly ready: ReadyGenerationBaseV1;
}

export interface ReadyStageResultV1 {
  readonly stage: ReadyStageIdentityV1;
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
}

export interface ReadyActivationInputV1 {
  readonly authority: ReadyPromotionAuthorityV1;
  readonly policy: GenerationRefreshPolicyV1;
  readonly expectedRevision: string;
  readonly expectedInProgressRunId: string;
  readonly fence: CanonicalFenceV1;
  readonly freshness: PromotionFreshnessAuthorityV1;
  readonly stage: ReadyStageIdentityV1;
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
  readonly promotedAtMonotonicNs: string;
}

export interface ReadyCommitResultV1 {
  readonly promotionRevision: string;
  readonly readyRecordHash: Hash;
}

export interface ReadyStorePort {
  putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash>;
  stageReadyCAS(input: ReadyStageInputV1): Promise<ReadyStageResultV1>;
  activateReadyCAS(input: ReadyActivationInputV1): Promise<ReadyCommitResultV1>;
  /**
   * Reads the one root-reachable active ready record. Implementations must
   * exact-decode the closure and fence the read against canonical source and
   * release rotation; a caller cannot supply a ready record to this method.
   */
  loadActiveReady(): Promise<ReadyGenerationV1 | null>;
  loadReadyClosure(ready: ReadyGenerationV1): Promise<{
    readonly sourceCoverage: SourceCoverageCertificateV1;
    readonly nominationClosure: NominationClosureV1;
    readonly instanceCatalog: InstanceCatalogV1;
    readonly graph: PersistedGraphV1;
  }>;
  assertContentRoot(kind: "candidate-partition" | "verified-memo-set", root: Hash): Promise<void>;
  assertReadyAuthorityActive(binding: {
    readonly generationId: string;
    readonly readyRecordHash: Hash;
    readonly generationRefreshPolicyHash: Hash;
    readonly definitionCatalogRoot: Hash;
    readonly instanceCatalogRoot: Hash;
    readonly graphRoot: Hash;
    readonly cutoff: CanonicalCutoffV1;
    readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
    readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
    readonly candidatePartitionProofStorageHash: Hash;
    readonly nominationClosureRoot: Hash;
    readonly nominationClosureStorageHash: Hash;
  }): void;
}

export interface ReadyPromotionInputV1 {
  readonly sealedRun: SealedRunCapabilityV1;
  readonly instanceCatalog: InstanceCatalogV1;
  readonly parentGenerationId: string | null;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface ServingValidationInputV1 {
  readonly ready: ReadyGenerationV1;
  readonly expectedDefinitionCatalogRoot: Hash;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface CurrentDefinitionCatalogV1 {
  readonly definitionCatalogRoot: Hash;
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

/**
 * The catalog view accepted when deciding whether an active ready generation
 * can be reused. It intentionally has no Family or storage fields: the
 * service obtains those from the checkpoint-owned durable closure.
 */
export interface ReadyReusableCatalogV1 {
  readonly definitionCatalogRoot: Hash;
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

const decimal = (value: string, name: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} is not canonical decimal`);
  return BigInt(value);
};

export function generationRefreshPolicyHash(policy: GenerationRefreshPolicyV1): Hash {
  assertPlainObject(policy, "generationRefreshPolicy");
  assertExactKeys(policy, ["observationWindowBlocks", "targetRefreshAgeBlocks", "maxServingAgeBlocks", "minPromotionMarginBlocks", "maxInProgressRuns"], "generationRefreshPolicy");
  if (policy.observationWindowBlocks !== "50" || policy.maxInProgressRuns !== "1") {
    throw new Error("unsupported-generation-policy");
  }
  const target = decimal(policy.targetRefreshAgeBlocks, "targetRefreshAgeBlocks");
  const maximum = decimal(policy.maxServingAgeBlocks, "maxServingAgeBlocks");
  const margin = decimal(policy.minPromotionMarginBlocks, "minPromotionMarginBlocks");
  if (target >= maximum || margin >= maximum) throw new Error("invalid-generation-policy");
  return hashDomain("aloha/generation-refresh-policy/v1", policy);
}

export function readyGenerationBaseHash(ready: ReadyGenerationBaseV1): Hash {
  validateReadyGenerationBase(ready);
  return hashDomain("aloha/ready-generation-base/v1", ready);
}

export function sourcePlanRootForCoverage(
  sourceCoverage: SourceCoverageCertificateV1,
): Hash {
  return sourcePlanSetRoot(sourceCoverage.entries.map(entry => ({
    ownerRef: entry.ownerRef,
    sourcePlanRef: entry.sourcePlanRef,
    familyDefinitionHash: entry.familyDefinitionHash,
    completeness: entry.completeness,
    historyStartBlock: entry.historyStartBlock,
  })));
}

export function createReadyPromotionAuthority(
  currentConfiguration: () => CurrentPromotionConfigurationV1,
  runtimeAuthorityPort: CurrentRuntimeAuthorityPortV1,
): ReadyPromotionAuthorityPort {
  const issued = new WeakMap<object, ReadyPromotionAuthorityBindingV1>();

  const current = (): {
    readonly definitionCatalogRoot: Hash;
    readonly policyHash: Hash;
    readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
    readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
  } => {
    const value = currentConfiguration();
    assertPlainObject(value, "currentPromotionConfiguration");
    assertExactKeys(value, ["definitionCatalogRoot", "policy"], "currentPromotionConfiguration");
    const { runtimeAuthority, releaseProvenanceHash } = readCurrentRuntimeAuthority(runtimeAuthorityPort);
    return deepFreeze({
      definitionCatalogRoot: assertHash(
        readOwnEnumerableDataProperty(value, "definitionCatalogRoot", "currentPromotionConfiguration"),
        "currentPromotionConfiguration.definitionCatalogRoot",
      ),
      policyHash: generationRefreshPolicyHash(
        readOwnEnumerableDataProperty(value, "policy", "currentPromotionConfiguration") as GenerationRefreshPolicyV1,
      ),
      runtimeAuthority,
      releaseProvenanceHash,
    });
  };

  const decodeAuthority = (authority: ReadyPromotionAuthorityV1): object => {
    assertPlainObject(authority, "readyPromotionAuthority");
    assertExactKeys(authority, ["opaque"], "readyPromotionAuthority");
    const opaque = readOwnEnumerableDataProperty(authority, "opaque", "readyPromotionAuthority");
    if (opaque === null || typeof opaque !== "object") {
      throw new TypeError("readyPromotionAuthority.opaque is invalid");
    }
    return opaque;
  };

  const assertBindingCurrent = (binding: ReadyPromotionAuthorityBindingV1): void => {
    const configuration = current();
    if (
      binding.definitionCatalogRoot !== configuration.definitionCatalogRoot
      || binding.generationRefreshPolicyHash !== configuration.policyHash
      || !runtimeAuthoritiesEqual(binding.runtimeAuthority, configuration.runtimeAuthority)
      || binding.releaseProvenanceHash !== configuration.releaseProvenanceHash
    ) {
      throw new ReadyPromotionIncompatibleError(
        binding.definitionCatalogRoot !== configuration.definitionCatalogRoot
          ? "definition-catalog-changed"
          : binding.generationRefreshPolicyHash !== configuration.policyHash
            ? "policy-changed"
            : "release-binding-changed",
      );
    }
  };

  const port = Object.freeze({
    issue(rawInput: ReadyPromotionAuthorityIssueV1) {
      assertPlainObject(rawInput, "readyPromotionIssue");
      assertExactKeys(rawInput, [
        "expectedRevision",
        "expectedInProgressRunId",
        "cutoff",
        "definitionCatalogRoot",
        "instanceCatalogRoot",
        "graphRoot",
        "runtimeAuthority",
        "releaseProvenanceHash",
        "candidatePartitionProofStorageHash",
        "nominationClosureRoot",
        "nominationClosureStorageHash",
        "policy",
      ], "readyPromotionIssue");
      const input = decodeCanonicalJson(encodeCanonicalBytes(rawInput)) as unknown as ReadyPromotionAuthorityIssueV1;
      const configuration = current();
      if (typeof input.expectedInProgressRunId !== "string" || input.expectedInProgressRunId.length === 0) {
        throw new TypeError("readyPromotionIssue.expectedInProgressRunId is invalid");
      }
      const binding = deepFreeze({
        expectedRevision: assertDecimalString(input.expectedRevision, "readyPromotionIssue.expectedRevision"),
        expectedInProgressRunId: input.expectedInProgressRunId,
        cutoff: deepFreeze({ ...input.cutoff }),
        definitionCatalogRoot: assertHash(input.definitionCatalogRoot, "readyPromotionIssue.definitionCatalogRoot"),
        instanceCatalogRoot: assertHash(input.instanceCatalogRoot, "readyPromotionIssue.instanceCatalogRoot"),
        graphRoot: assertHash(input.graphRoot, "readyPromotionIssue.graphRoot"),
        runtimeAuthority: decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority),
        releaseProvenanceHash: decodeReleaseProvenanceHash(
          input.releaseProvenanceHash,
          decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority),
          "readyPromotionIssue.releaseProvenanceHash",
        ),
        candidatePartitionProofStorageHash: assertHash(input.candidatePartitionProofStorageHash, "readyPromotionIssue.candidatePartitionProofStorageHash"),
        nominationClosureRoot: assertHash(input.nominationClosureRoot, "readyPromotionIssue.nominationClosureRoot"),
        nominationClosureStorageHash: assertHash(input.nominationClosureStorageHash, "readyPromotionIssue.nominationClosureStorageHash"),
        generationRefreshPolicyHash: generationRefreshPolicyHash(input.policy),
      });
      validateCanonicalCutoff(binding.cutoff, "readyPromotionIssue.cutoff");
      if (
        binding.definitionCatalogRoot !== configuration.definitionCatalogRoot
        || binding.generationRefreshPolicyHash !== configuration.policyHash
        || !runtimeAuthoritiesEqual(binding.runtimeAuthority, configuration.runtimeAuthority)
        || binding.releaseProvenanceHash !== configuration.releaseProvenanceHash
      ) {
        throw new ReadyPromotionIncompatibleError(
          binding.definitionCatalogRoot !== configuration.definitionCatalogRoot
            ? "definition-catalog-changed"
            : binding.generationRefreshPolicyHash !== configuration.policyHash
              ? "policy-changed"
              : "release-binding-changed",
        );
      }
      const opaque = Object.freeze({});
      issued.set(opaque, binding);
      return Object.freeze({ opaque });
    },
    assertConfiguration(binding: {
      readonly definitionCatalogRoot: Hash;
      readonly generationRefreshPolicyHash: Hash;
      readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
      readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
    }) {
      assertPlainObject(binding, "readyPromotionConfiguration");
      assertExactKeys(binding, ["definitionCatalogRoot", "generationRefreshPolicyHash", "runtimeAuthority", "releaseProvenanceHash"], "readyPromotionConfiguration");
      const configuration = current();
      if (
        assertHash(
          readOwnEnumerableDataProperty(binding, "definitionCatalogRoot", "readyPromotionConfiguration"),
          "readyPromotionConfiguration.definitionCatalogRoot",
        ) !== configuration.definitionCatalogRoot
        || assertHash(
          readOwnEnumerableDataProperty(binding, "generationRefreshPolicyHash", "readyPromotionConfiguration"),
          "readyPromotionConfiguration.generationRefreshPolicyHash",
        ) !== configuration.policyHash
        || !runtimeAuthoritiesEqual(decodeRuntimeAuthorityProjectionV1(
          readOwnEnumerableDataProperty(binding, "runtimeAuthority", "readyPromotionConfiguration"),
        ), configuration.runtimeAuthority)
        || decodeReleaseProvenanceHash(
          readOwnEnumerableDataProperty(binding, "releaseProvenanceHash", "readyPromotionConfiguration"),
          decodeRuntimeAuthorityProjectionV1(
            readOwnEnumerableDataProperty(binding, "runtimeAuthority", "readyPromotionConfiguration"),
          ),
          "readyPromotionConfiguration.releaseProvenanceHash",
        ) !== configuration.releaseProvenanceHash
      ) {
        throw new ReadyPromotionIncompatibleError(
          assertHash(
            readOwnEnumerableDataProperty(binding, "definitionCatalogRoot", "readyPromotionConfiguration"),
            "readyPromotionConfiguration.definitionCatalogRoot",
          ) !== configuration.definitionCatalogRoot
            ? "definition-catalog-changed"
            : assertHash(
              readOwnEnumerableDataProperty(binding, "generationRefreshPolicyHash", "readyPromotionConfiguration"),
              "readyPromotionConfiguration.generationRefreshPolicyHash",
            ) !== configuration.policyHash
              ? "policy-changed"
              : "release-binding-changed",
        );
      }
    },
    assertActive(authority: ReadyPromotionAuthorityV1) {
      const opaque = decodeAuthority(authority);
      const binding = issued.get(opaque);
      if (!binding) throw new Error("ready-promotion-authority-not-issued");
      assertBindingCurrent(binding);
      return binding;
    },
    revoke(authority: ReadyPromotionAuthorityV1) {
      issued.delete(decodeAuthority(authority));
    },
  });
  issuedPromotionAuthorityPorts.add(port);
  return port;
}

export function validateReadyGenerationBase(ready: ReadyGenerationBaseV1): void {
  assertPlainObject(ready, "readyGenerationBase");
  assertExactKeys(ready, [
    "generationId",
    "parentGenerationId",
    "generationRefreshPolicyHash",
    "cutoff",
    "recentObservationRange",
    "definitionCatalogRoot",
    "sourceCoverageRoot",
    "candidatePartitionRoot",
    "nominationClosureRoot",
    "nominationClosureStorageHash",
    "candidatePartitionProofStorageHash",
    "runtimeAuthority",
    "releaseProvenanceHash",
    "exactOutcomePartitionRoot",
    "verifiedMemoSetRoot",
    "instanceCatalogRoot",
    "graphRoot",
    "edgeCount",
    "instanceCount",
  ], "readyGenerationBase");
  assertHash(ready.generationId, "readyGenerationBase.generationId");
  if (ready.parentGenerationId !== null) assertHash(ready.parentGenerationId, "readyGenerationBase.parentGenerationId");
  assertHash(ready.generationRefreshPolicyHash, "readyGenerationBase.generationRefreshPolicyHash");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(ready.runtimeAuthority);
  decodeReleaseProvenanceHash(
    ready.releaseProvenanceHash,
    runtimeAuthority,
    "readyGenerationBase.releaseProvenanceHash",
  );
  validateCanonicalCutoff(ready.cutoff, "readyGenerationBase.cutoff");
  assertPlainObject(ready.recentObservationRange, "readyGenerationBase.recentObservationRange");
  assertExactKeys(ready.recentObservationRange, ["from", "to"], "readyGenerationBase.recentObservationRange");
  const from = BigInt(assertDecimalString(ready.recentObservationRange.from, "readyGenerationBase.recentObservationRange.from"));
  const to = BigInt(assertDecimalString(ready.recentObservationRange.to, "readyGenerationBase.recentObservationRange.to"));
  if (from > to || ready.recentObservationRange.to !== ready.cutoff.number) throw new Error("ready-observation-range-mismatch");
  for (const [name, value] of [
    ["definitionCatalogRoot", ready.definitionCatalogRoot],
    ["sourceCoverageRoot", ready.sourceCoverageRoot],
    ["candidatePartitionRoot", ready.candidatePartitionRoot],
    ["nominationClosureRoot", ready.nominationClosureRoot],
    ["nominationClosureStorageHash", ready.nominationClosureStorageHash],
    ["candidatePartitionProofStorageHash", ready.candidatePartitionProofStorageHash],
    ["exactOutcomePartitionRoot", ready.exactOutcomePartitionRoot],
    ["verifiedMemoSetRoot", ready.verifiedMemoSetRoot],
    ["instanceCatalogRoot", ready.instanceCatalogRoot],
    ["graphRoot", ready.graphRoot],
  ] as const) assertHash(value, `readyGeneration.${name}`);
  for (const [name, value] of [
    ["edgeCount", ready.edgeCount],
    ["instanceCount", ready.instanceCount],
  ] as const) assertDecimalString(value, `readyGeneration.${name}`);
}

export function validateReadyGeneration(ready: ReadyGenerationV1): void {
  assertPlainObject(ready, "readyGeneration");
  assertExactKeys(ready, [
    "generationId",
    "parentGenerationId",
    "generationRefreshPolicyHash",
    "cutoff",
    "recentObservationRange",
    "definitionCatalogRoot",
    "sourceCoverageRoot",
    "candidatePartitionRoot",
    "nominationClosureRoot",
    "nominationClosureStorageHash",
    "candidatePartitionProofStorageHash",
    "runtimeAuthority",
    "releaseProvenanceHash",
    "exactOutcomePartitionRoot",
    "verifiedMemoSetRoot",
    "instanceCatalogRoot",
    "graphRoot",
    "edgeCount",
    "instanceCount",
    "promotionFreshness",
    "promotionRevision",
    "promotedAtMonotonicNs",
    "readyRecordHash",
  ], "readyGeneration");
  const base: ReadyGenerationBaseV1 = {
    generationId: ready.generationId,
    parentGenerationId: ready.parentGenerationId,
    generationRefreshPolicyHash: ready.generationRefreshPolicyHash,
    cutoff: ready.cutoff,
    recentObservationRange: ready.recentObservationRange,
    definitionCatalogRoot: ready.definitionCatalogRoot,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    candidatePartitionRoot: ready.candidatePartitionRoot,
    nominationClosureRoot: ready.nominationClosureRoot,
    nominationClosureStorageHash: ready.nominationClosureStorageHash,
    candidatePartitionProofStorageHash: ready.candidatePartitionProofStorageHash,
    runtimeAuthority: ready.runtimeAuthority,
    releaseProvenanceHash: ready.releaseProvenanceHash,
    exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
    instanceCatalogRoot: ready.instanceCatalogRoot,
    graphRoot: ready.graphRoot,
    edgeCount: ready.edgeCount,
    instanceCount: ready.instanceCount,
  };
  validateReadyGenerationBase(base);
  assertHash(ready.readyRecordHash, "readyGeneration.readyRecordHash");
  assertDecimalString(ready.promotionRevision, "readyGeneration.promotionRevision");
  assertDecimalString(ready.promotedAtMonotonicNs, "readyGeneration.promotedAtMonotonicNs");
  const promotionFreshness = validatePromotionFreshnessReceipt(ready.promotionFreshness);
  if (
    !sameCutoff(promotionFreshness.cutoff, ready.cutoff)
    || promotionFreshness.generationRefreshPolicyHash !== ready.generationRefreshPolicyHash
  ) throw new Error("ready-promotion-freshness-binding-mismatch");
  const payload = {
    generationId: ready.generationId,
    parentGenerationId: ready.parentGenerationId,
    generationRefreshPolicyHash: ready.generationRefreshPolicyHash,
    cutoff: ready.cutoff,
    recentObservationRange: ready.recentObservationRange,
    definitionCatalogRoot: ready.definitionCatalogRoot,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    candidatePartitionRoot: ready.candidatePartitionRoot,
    nominationClosureRoot: ready.nominationClosureRoot,
    nominationClosureStorageHash: ready.nominationClosureStorageHash,
    candidatePartitionProofStorageHash: ready.candidatePartitionProofStorageHash,
    runtimeAuthority: ready.runtimeAuthority,
    releaseProvenanceHash: ready.releaseProvenanceHash,
    exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
    instanceCatalogRoot: ready.instanceCatalogRoot,
    graphRoot: ready.graphRoot,
    edgeCount: ready.edgeCount,
    instanceCount: ready.instanceCount,
    promotionFreshness,
    promotedAtMonotonicNs: ready.promotedAtMonotonicNs,
    promotionRevision: ready.promotionRevision,
  };
  if (hashDomain("aloha/ready-generation/v1", payload) !== ready.readyRecordHash) {
    throw new Error("ready-record-hash-mismatch");
  }
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

export function assertVerifiedPublicationCatalog(
  verifiedPublications: readonly InstancePublicationV1[],
  instanceCatalog: InstanceCatalogV1,
): void {
  const verifiedPublicationHashes = verifiedPublications
    .map(publication => publication.instancePublicationHash)
    .sort();
  const catalogPublicationHashes = instanceCatalog.publications
    .map(publication => publication.instancePublicationHash)
    .sort();
  if (
    verifiedPublicationHashes.length !== catalogPublicationHashes.length
    || verifiedPublicationHashes.some((hash, index) => hash !== catalogPublicationHashes[index])
  ) throw new Error("verified-publication-catalog-mismatch");
}

function assertPromotionInput(input: ReadyPromotionInputV1, run: SealedRunSnapshotV1): void {
  const { instanceCatalog } = input;
  if (input.parentGenerationId !== run.parentGenerationId) {
    throw new Error("parent-generation-binding-mismatch");
  }
  assertPromotablePartition(run.partition, run.candidateKeys);
  if (run.partition.runId !== run.runId || !sameCutoff(run.partition.cutoff, run.cutoff)) {
    throw new Error("attestation-run-binding-mismatch");
  }
  if (run.partition.releaseProvenanceHash !== run.releaseProvenanceHash) {
    throw new Error("attestation-release-provenance-mismatch");
  }
  if (!sameCutoff(run.sourceCoverage.cutoff, run.cutoff)) throw new Error("coverage-cutoff-mismatch");
  if (run.sourceCoverage.sourceCoverageRoot.length === 0) throw new Error("coverage-root-missing");
  if (!sameCutoff(instanceCatalog.cutoff, run.cutoff)) throw new Error("instance-catalog-cutoff-mismatch");
  const verifiedPublications = run.partition.outcomes
    .filter(outcome => outcome.kind === "verified")
    .map(outcome => outcome.publication);
  assertVerifiedPublicationCatalog(verifiedPublications, instanceCatalog);
}

function assertReadyStageResult(
  result: ReadyStageResultV1,
  run: SealedRunSnapshotV1,
  instanceCatalog: InstanceCatalogV1,
  ready: ReadyGenerationBaseV1,
  policyHash: Hash,
  runtimeAuthority: RuntimeAuthorityProjectionV1,
): void {
  validateReadyStageIdentity(result.stage);
  if (
    result.stageRevision !== result.stage.stageRevision
    || result.stageRecordHash !== result.stage.stageRecordHash
    || result.stage.runId !== run.runId
    || result.stage.expectedRevision !== run.checkpointRevision
    || result.stage.sealedRevision !== run.checkpointRevision
    || !sameCutoff(result.stage.cutoff, run.cutoff)
    || result.stage.generationRefreshPolicyHash !== policyHash
    || result.stage.definitionCatalogRoot !== run.definitionCatalogRoot
    || !runtimeAuthoritiesEqual(result.stage.runtimeAuthority, runtimeAuthority)
    || result.stage.releaseProvenanceHash !== run.releaseProvenanceHash
    || result.stage.candidatePartitionProofStorageHash !== run.candidatePartitionProofStorageHash
    || result.stage.nominationClosureRoot !== run.nominationClosureRoot
    || result.stage.nominationClosureStorageHash !== run.nominationClosureStorageHash
    || !runtimeAuthoritiesEqual(ready.runtimeAuthority, runtimeAuthority)
    || ready.releaseProvenanceHash !== run.releaseProvenanceHash
    || ready.candidatePartitionProofStorageHash !== run.candidatePartitionProofStorageHash
    || ready.nominationClosureRoot !== run.nominationClosureRoot
    || ready.nominationClosureStorageHash !== run.nominationClosureStorageHash
    || result.stage.readyBaseHash !== readyGenerationBaseHash(ready)
    || ready.instanceCatalogRoot !== instanceCatalog.instanceCatalogRoot
  ) {
    throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
  }
}

function classifyCanonicalPromotionError(error: unknown): unknown {
  if (!(error instanceof CanonicalSourceError)) return error;
  if (error.code === "promotion-stale") {
    return new ReadyPromotionIncompatibleError("cutoff-too-old");
  }
  // A stale observation is the only canonical result that is a safe typed
  // abandon.  Chain/number/hash/state-root/header mismatches are integrity
  // failures: converting them to an abandon authority would let corruption
  // or a malformed provider response delete a durable staged closure.
  return error;
}

export class ReadyGenerationServiceV1 implements GraphServingAdmissionGuardPort {
  readonly #expectedCaller: object;
  readonly #store: ReadyStorePort;
  readonly #canonical: CanonicalFencePort;
  readonly #monotonicNow: () => string;
  readonly #currentDefinitionCatalog: () => CurrentDefinitionCatalogV1;
  readonly #promotionAuthority: ReadyPromotionAuthorityPort;
  readonly #sealedRunReader: SealedRunReaderPortV1;
  readonly #runtimeAuthorityPort: CurrentRuntimeAuthorityPortV1;
  readonly #servingAdmissions = new WeakMap<object, ServingValidationInputV1>();

  constructor(
    expectedCaller: object,
    store: ReadyStorePort,
    canonical: CanonicalFencePort,
    monotonicNow: () => string,
    currentDefinitionCatalog: () => CurrentDefinitionCatalogV1,
    promotionAuthority: ReadyPromotionAuthorityPort,
    sealedRunReader: SealedRunReaderPortV1,
    runtimeAuthorityPort: CurrentRuntimeAuthorityPortV1,
  ) {
    this.#expectedCaller = expectedCaller;
    this.#store = store;
    this.#canonical = canonical;
    this.#monotonicNow = monotonicNow;
    this.#currentDefinitionCatalog = currentDefinitionCatalog;
    this.#promotionAuthority = promotionAuthority;
    this.#sealedRunReader = assertCheckpointSealedRunReader(sealedRunReader);
    readCurrentRuntimeAuthority(runtimeAuthorityPort);
    this.#runtimeAuthorityPort = runtimeAuthorityPort;
  }

  /** Owner seam used by narrow release facades before decoding caller data. */
  assertOwnerCurrent(): void {
    readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
  }

  /**
   * Reuse is an admission decision, not a storage lookup. The active record
   * comes only from the checkpoint owner, then the same serving validator used
   * for a newly promoted generation proves its catalog, source-plan, policy,
   * release, canonical-age, content-root and authority bindings.
   *
   * A stale cutoff or an expected configuration change means "not reusable"
   * and lets GenerationBuilder obtain a new fixed cutoff. Any other storage,
   * canonical, or closure-integrity error remains fatal and is not converted
   * into a rebuild.
   */
  async findLatestReusable(
    catalog: ReadyReusableCatalogV1,
    policy: GenerationRefreshPolicyV1,
  ): Promise<ReadyGenerationV1 | null> {
    const policyHash = generationRefreshPolicyHash(policy);
    const currentCatalog = this.#currentDefinitionCatalog();
    if (
      catalog.definitionCatalogRoot !== currentCatalog.definitionCatalogRoot
      || sourcePlanSetRoot(catalog.declaredSourcePlans) !== sourcePlanSetRoot(currentCatalog.declaredSourcePlans)
    ) return null;

    let ready: ReadyGenerationV1 | null;
    try {
      ready = await this.#store.loadActiveReady();
    } catch (error) {
      if (error instanceof CanonicalSourceError && error.code === "promotion-stale") return null;
      throw error;
    }
    if (ready === null) return null;
    validateReadyGeneration(ready);
    const currentAuthority = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    if (
      ready.generationRefreshPolicyHash !== policyHash
      || ready.definitionCatalogRoot !== catalog.definitionCatalogRoot
      || ready.releaseProvenanceHash !== currentAuthority.releaseProvenanceHash
      || !runtimeAuthoritiesEqual(ready.runtimeAuthority, currentAuthority.runtimeAuthority)
    ) return null;

    try {
      await this.#validateServingBinding({
        ready,
        expectedDefinitionCatalogRoot: catalog.definitionCatalogRoot,
        policy,
      });
    } catch (error) {
      if (error instanceof CanonicalSourceError && error.code === "promotion-stale") return null;
      if (
        error instanceof Error
        && [
          "serving-definition-catalog-mismatch",
          "serving-policy-mismatch",
          "serving-release-binding-mismatch",
          "serving-generation-stale",
        ].includes(error.message)
      ) return null;
      throw error;
    }
    return ready;
  }

  async promote(caller: object, input: ReadyPromotionInputV1): Promise<ReadyGenerationV1> {
    if (caller !== this.#expectedCaller) throw new Error("promotion-caller-unauthorized");
    const { instanceCatalog, policy } = input;
    const run = this.#sealedRunReader.readForPromotion(input.sealedRun, instanceCatalog);
    assertPromotionInput(input, run);
    const currentAuthority = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    const currentReleaseProvenanceHash = currentAuthority.releaseProvenanceHash;
    const currentRuntimeAuthority = currentAuthority.runtimeAuthority;
    if (
      run.releaseProvenanceHash !== currentReleaseProvenanceHash
    ) {
      throw new ReadyPromotionIncompatibleError("release-binding-changed");
    }
    const currentCatalog = this.#currentDefinitionCatalog();
    if (run.definitionCatalogRoot !== currentCatalog.definitionCatalogRoot) {
      throw new ReadyPromotionIncompatibleError("definition-catalog-changed");
    }
    if (sourcePlanRootForCoverage(run.sourceCoverage) !== sourcePlanSetRoot(currentCatalog.declaredSourcePlans)) {
      throw new ReadyPromotionIncompatibleError("source-plan-changed");
    }
    this.#promotionAuthority.assertConfiguration({
      definitionCatalogRoot: run.definitionCatalogRoot,
      generationRefreshPolicyHash: generationRefreshPolicyHash(policy),
      runtimeAuthority: currentRuntimeAuthority,
      releaseProvenanceHash: run.releaseProvenanceHash,
    });
    validateSourceCoverageCertificate(run.sourceCoverage, currentCatalog.declaredSourcePlans);
    const expectedRange = this.#canonical.recentObservationRange(run.cutoff);
    if (
      run.recentObservationRange.from !== expectedRange.from
      || run.recentObservationRange.to !== expectedRange.to
    ) throw new Error("recent-observation-range-mismatch");
    await this.#assertPromotionCanonical(run.cutoff);
    const latest = decimal(policy.maxServingAgeBlocks, "maxServingAgeBlocks")
      - decimal(policy.minPromotionMarginBlocks, "minPromotionMarginBlocks");

    const graph = buildPersistedGraph(instanceCatalog);
    const instanceCatalogContentHash = await this.#store.putContentAndFsync("instance-catalog", instanceCatalog);
    const graphContentHash = await this.#store.putContentAndFsync("persisted-graph", graph);
    if (instanceCatalogContentHash !== instanceCatalog.instanceCatalogRoot) {
      throw new Error("instance-catalog-content-hash-mismatch");
    }
    if (graphContentHash !== graph.graphRoot) throw new Error("graph-content-hash-mismatch");

    const policyHash = generationRefreshPolicyHash(policy);
    const generationId = hashDomain("aloha/ready-generation-id/v1", {
      parentGenerationId: input.parentGenerationId,
      runId: run.runId,
      cutoff: run.cutoff,
      definitionCatalogRoot: run.definitionCatalogRoot,
      instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
      graphRoot: graph.graphRoot,
      policyHash,
      runtimeAuthority: currentRuntimeAuthority,
      releaseProvenanceHash: run.releaseProvenanceHash,
      candidatePartitionProofStorageHash: run.candidatePartitionProofStorageHash,
      nominationClosureRoot: run.nominationClosureRoot,
      nominationClosureStorageHash: run.nominationClosureStorageHash,
    });
    const readyBase = deepFreeze({
      generationId,
      parentGenerationId: input.parentGenerationId,
      generationRefreshPolicyHash: policyHash,
      cutoff: run.cutoff,
      recentObservationRange: run.recentObservationRange,
      definitionCatalogRoot: run.definitionCatalogRoot,
      sourceCoverageRoot: run.sourceCoverage.sourceCoverageRoot,
      candidatePartitionRoot: run.candidatePartitionRoot,
      nominationClosureRoot: run.nominationClosureRoot,
      nominationClosureStorageHash: run.nominationClosureStorageHash,
      candidatePartitionProofStorageHash: run.candidatePartitionProofStorageHash,
      runtimeAuthority: currentRuntimeAuthority,
      releaseProvenanceHash: run.releaseProvenanceHash,
      exactOutcomePartitionRoot: run.partition.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: run.verifiedMemoSetRoot,
      instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
      graphRoot: graph.graphRoot,
      edgeCount: graph.edgeCount,
      instanceCount: instanceCatalog.instanceCount,
    });
    let committed: {
      readonly result: ReadyCommitResultV1;
      readonly readyBase: ReadyGenerationBaseV1;
      readonly freshness: PromotionFreshnessReceiptV1;
      readonly promotedAtMonotonicNs: string;
    };
    try {
      committed = await this.#canonical.withCanonicalFence(run.cutoff, async fence => {
      const fencedAuthority = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
      if (fencedAuthority.releaseProvenanceHash !== run.releaseProvenanceHash) {
        throw new ReadyPromotionIncompatibleError("release-binding-changed");
      }
      if (!runtimeAuthoritiesEqual(fencedAuthority.runtimeAuthority, currentRuntimeAuthority)) {
        throw new ReadyPromotionIncompatibleError("release-binding-changed");
      }
      const fencedCatalog = this.#currentDefinitionCatalog();
      if (run.definitionCatalogRoot !== fencedCatalog.definitionCatalogRoot) {
        throw new ReadyPromotionIncompatibleError("definition-catalog-changed");
      }
      if (sourcePlanRootForCoverage(run.sourceCoverage) !== sourcePlanSetRoot(fencedCatalog.declaredSourcePlans)) {
        throw new ReadyPromotionIncompatibleError("source-plan-changed");
      }
      validateSourceCoverageCertificate(run.sourceCoverage, fencedCatalog.declaredSourcePlans);
      const authority = this.#promotionAuthority.issue({
        expectedRevision: run.checkpointRevision,
        expectedInProgressRunId: run.runId,
        cutoff: run.cutoff,
        definitionCatalogRoot: run.definitionCatalogRoot,
        instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
        graphRoot: graph.graphRoot,
        runtimeAuthority: currentRuntimeAuthority,
        releaseProvenanceHash: run.releaseProvenanceHash,
        candidatePartitionProofStorageHash: run.candidatePartitionProofStorageHash,
        nominationClosureRoot: run.nominationClosureRoot,
        nominationClosureStorageHash: run.nominationClosureStorageHash,
        policy,
      });
      try {
        // Stage the complete, expensive closure first.  This transaction leaves
        // the existing ready generation and the in-progress run untouched from
        // a serving perspective.  Only the following activation may publish it.
        const stage = await this.#store.stageReadyCAS({
          authority,
          policy,
          expectedRevision: run.checkpointRevision,
          expectedInProgressRunId: run.runId,
          fence,
          graph,
          instanceCatalog,
          ready: readyBase,
        });
        assertReadyStageResult(stage, run, instanceCatalog, readyBase, policyHash, currentRuntimeAuthority);
        const freshness = await this.#canonical.observePromotionFreshness(fence, {
          cutoff: run.cutoff,
          maxPromotionAgeBlocks: latest.toString(),
          generationRefreshPolicyHash: policyHash,
        });
        const promotedAtMonotonicNs = this.#monotonicNow();
        decimal(promotedAtMonotonicNs, "promotedAtMonotonicNs");
        const result = await this.#store.activateReadyCAS({
          authority,
          policy,
          expectedRevision: run.checkpointRevision,
          expectedInProgressRunId: run.runId,
          fence,
          freshness,
          stage: stage.stage,
          stageRevision: stage.stageRevision,
          stageRecordHash: stage.stageRecordHash,
          promotedAtMonotonicNs,
        });
        return deepFreeze({ result, readyBase, freshness: freshness.receipt, promotedAtMonotonicNs });
      } finally {
        this.#promotionAuthority.revoke(authority);
      }
      });
    } catch (error) {
      throw classifyCanonicalPromotionError(error);
    }
    const readyPayload = {
      ...committed.readyBase,
      promotionFreshness: committed.freshness,
      promotedAtMonotonicNs: committed.promotedAtMonotonicNs,
      promotionRevision: committed.result.promotionRevision,
    };
    const expectedReadyRecordHash = hashDomain("aloha/ready-generation/v1", readyPayload);
    if (committed.result.readyRecordHash !== expectedReadyRecordHash) {
      throw new Error("ready-record-hash-mismatch");
    }
    const ready = deepFreeze({ ...readyPayload, readyRecordHash: committed.result.readyRecordHash });
    const currentAfterCommit = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    if (
      currentAfterCommit.releaseProvenanceHash !== ready.releaseProvenanceHash
      || !runtimeAuthoritiesEqual(currentAfterCommit.runtimeAuthority, ready.runtimeAuthority)
    ) {
      throw new ReadyPromotionIncompatibleError("release-binding-changed");
    }
    await this.#assertPromotionCanonical(run.cutoff);
    this.#store.assertReadyAuthorityActive({
      generationId: ready.generationId,
      readyRecordHash: ready.readyRecordHash,
      generationRefreshPolicyHash: ready.generationRefreshPolicyHash,
      cutoff: ready.cutoff,
      definitionCatalogRoot: ready.definitionCatalogRoot,
      instanceCatalogRoot: ready.instanceCatalogRoot,
      graphRoot: ready.graphRoot,
      runtimeAuthority: ready.runtimeAuthority,
      releaseProvenanceHash: ready.releaseProvenanceHash,
      candidatePartitionProofStorageHash: ready.candidatePartitionProofStorageHash,
      nominationClosureRoot: ready.nominationClosureRoot,
      nominationClosureStorageHash: ready.nominationClosureStorageHash,
    });
    await this.#assertPromotionCanonical(run.cutoff);
    return ready;
  }

  async #assertPromotionCanonical(cutoff: CanonicalCutoffV1): Promise<void> {
    try {
      await this.#canonical.assertStillCanonical(cutoff);
    } catch (error) {
      throw classifyCanonicalPromotionError(error);
    }
  }

  async validateServing(rawInput: ServingValidationInputV1): Promise<GraphServingAdmissionV1> {
    const input = decodeCanonicalJson(encodeCanonicalBytes(rawInput)) as unknown as ServingValidationInputV1;
    await this.#validateServingBinding(input);
    const opaque = Object.freeze({});
    this.#servingAdmissions.set(opaque, deepFreeze(input));
    return Object.freeze({ opaque });
  }

  async assertServingBindingCurrent(binding: GraphLeaseBindingV1): Promise<void> {
    const currentBefore = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    if (
      currentBefore.releaseProvenanceHash !== binding.releaseProvenanceHash
      || !runtimeAuthoritiesEqual(currentBefore.runtimeAuthority, binding.runtimeAuthority)
    ) {
      throw new Error("serving-release-binding-mismatch");
    }
    this.#promotionAuthority.assertConfiguration({
      definitionCatalogRoot: binding.definitionCatalogRoot,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      runtimeAuthority: binding.runtimeAuthority,
      releaseProvenanceHash: binding.releaseProvenanceHash,
    });
    await this.#canonical.assertStillCanonical(binding.cutoff);
    this.#store.assertReadyAuthorityActive(binding);
    await this.#canonical.assertStillCanonical(binding.cutoff);
    const currentAfter = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    if (
      currentAfter.releaseProvenanceHash !== binding.releaseProvenanceHash
      || !runtimeAuthoritiesEqual(currentAfter.runtimeAuthority, binding.runtimeAuthority)
    ) {
      throw new Error("serving-release-binding-mismatch");
    }
  }

  async #validateServingBinding(input: ServingValidationInputV1): Promise<GraphLeaseBindingV1> {
    validateReadyGeneration(input.ready);
    const expectedPolicyHash = generationRefreshPolicyHash(input.policy);
    const currentCatalog = this.#currentDefinitionCatalog();
    if (
      input.ready.definitionCatalogRoot !== input.expectedDefinitionCatalogRoot
      || input.ready.definitionCatalogRoot !== currentCatalog.definitionCatalogRoot
    ) {
      throw new Error("serving-definition-catalog-mismatch");
    }
    if (input.ready.generationRefreshPolicyHash !== expectedPolicyHash) {
      throw new Error("serving-policy-mismatch");
    }
    const currentAuthority = readCurrentRuntimeAuthority(this.#runtimeAuthorityPort);
    const currentReleaseProvenanceHash = currentAuthority.releaseProvenanceHash;
    const currentRuntimeAuthority = currentAuthority.runtimeAuthority;
    if (
      input.ready.releaseProvenanceHash !== currentReleaseProvenanceHash
      || !runtimeAuthoritiesEqual(input.ready.runtimeAuthority, currentRuntimeAuthority)
    ) {
      throw new Error("serving-release-binding-mismatch");
    }
    this.#promotionAuthority.assertConfiguration({
      definitionCatalogRoot: input.ready.definitionCatalogRoot,
      generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
      runtimeAuthority: input.ready.runtimeAuthority,
      releaseProvenanceHash: input.ready.releaseProvenanceHash,
    });
    await this.#canonical.assertStillCanonical(input.ready.cutoff);
    const age = decimal(await this.#canonical.ageInBlocks(input.ready.cutoff), "servingAge");
    if (age > decimal(input.policy.maxServingAgeBlocks, "maxServingAgeBlocks")) {
      throw new Error("serving-generation-stale");
    }
    const readyPayload = {
      generationId: input.ready.generationId,
      parentGenerationId: input.ready.parentGenerationId,
      generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
      cutoff: input.ready.cutoff,
      recentObservationRange: input.ready.recentObservationRange,
      definitionCatalogRoot: input.ready.definitionCatalogRoot,
      sourceCoverageRoot: input.ready.sourceCoverageRoot,
      candidatePartitionRoot: input.ready.candidatePartitionRoot,
      nominationClosureRoot: input.ready.nominationClosureRoot,
      nominationClosureStorageHash: input.ready.nominationClosureStorageHash,
      candidatePartitionProofStorageHash: input.ready.candidatePartitionProofStorageHash,
      runtimeAuthority: input.ready.runtimeAuthority,
      releaseProvenanceHash: input.ready.releaseProvenanceHash,
      exactOutcomePartitionRoot: input.ready.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: input.ready.verifiedMemoSetRoot,
      instanceCatalogRoot: input.ready.instanceCatalogRoot,
      graphRoot: input.ready.graphRoot,
      edgeCount: input.ready.edgeCount,
      instanceCount: input.ready.instanceCount,
      promotionFreshness: input.ready.promotionFreshness,
      promotedAtMonotonicNs: input.ready.promotedAtMonotonicNs,
      promotionRevision: input.ready.promotionRevision,
    };
    if (hashDomain("aloha/ready-generation/v1", readyPayload) !== input.ready.readyRecordHash) {
      throw new Error("serving-ready-record-hash-mismatch");
    }
    const closure = await this.#store.loadReadyClosure(input.ready);
    validateSourceCoverageCertificate(closure.sourceCoverage, currentCatalog.declaredSourcePlans);
    if (closure.sourceCoverage.sourceCoverageRoot !== input.ready.sourceCoverageRoot) {
      throw new Error("serving-source-coverage-root-mismatch");
    }
    if (closure.nominationClosure.root !== input.ready.nominationClosureRoot
      || closure.nominationClosure.candidatePartitionRoot !== input.ready.candidatePartitionRoot
      || !sameCutoff(closure.nominationClosure.cutoff, input.ready.cutoff)) {
      throw new Error("serving-nomination-closure-mismatch");
    }
    validatePersistedGraphForCatalog(closure.graph, closure.instanceCatalog);
    if (
      closure.instanceCatalog.instanceCatalogRoot !== input.ready.instanceCatalogRoot
      || closure.instanceCatalog.instanceCount !== input.ready.instanceCount
      || closure.graph.graphRoot !== input.ready.graphRoot
      || closure.graph.edgeCount !== String(closure.graph.edges.length)
    ) throw new Error("serving-ready-closure-mismatch");
    await this.#store.assertContentRoot("candidate-partition", input.ready.candidatePartitionRoot);
    await this.#store.assertContentRoot("verified-memo-set", input.ready.verifiedMemoSetRoot);
    await this.#canonical.assertStillCanonical(input.ready.cutoff);
    this.#store.assertReadyAuthorityActive({
      generationId: input.ready.generationId,
      readyRecordHash: input.ready.readyRecordHash,
      generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
      definitionCatalogRoot: input.ready.definitionCatalogRoot,
      instanceCatalogRoot: input.ready.instanceCatalogRoot,
      graphRoot: input.ready.graphRoot,
      cutoff: input.ready.cutoff,
      runtimeAuthority: input.ready.runtimeAuthority,
      releaseProvenanceHash: input.ready.releaseProvenanceHash,
      candidatePartitionProofStorageHash: input.ready.candidatePartitionProofStorageHash,
      nominationClosureRoot: input.ready.nominationClosureRoot,
      nominationClosureStorageHash: input.ready.nominationClosureStorageHash,
    });
    const binding = deepFreeze({
      generationId: input.ready.generationId,
      readyRecordHash: input.ready.readyRecordHash,
      generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
      cutoff: deepFreeze({ ...input.ready.cutoff }),
      definitionCatalogRoot: input.ready.definitionCatalogRoot,
      instanceCatalogRoot: input.ready.instanceCatalogRoot,
      graphRoot: input.ready.graphRoot,
      runtimeAuthority: input.ready.runtimeAuthority,
      releaseProvenanceHash: input.ready.releaseProvenanceHash,
      candidatePartitionProofStorageHash: input.ready.candidatePartitionProofStorageHash,
      nominationClosureRoot: input.ready.nominationClosureRoot,
      nominationClosureStorageHash: input.ready.nominationClosureStorageHash,
    });
    return binding;
  }

  async consumeServingAdmission(rawAdmission: GraphServingAdmissionV1): Promise<GraphLeaseBindingV1> {
    assertPlainObject(rawAdmission, "graphServingAdmission");
    assertExactKeys(rawAdmission, ["opaque"], "graphServingAdmission");
    const opaque = readOwnEnumerableDataProperty(rawAdmission, "opaque", "graphServingAdmission");
    if (typeof opaque !== "object" || opaque === null) {
      throw new TypeError("graphServingAdmission.opaque is invalid");
    }
    const input = this.#servingAdmissions.get(opaque);
    if (!input) throw new Error("graph-serving-admission-not-issued");
    this.#servingAdmissions.delete(opaque);
    return this.#validateServingBinding(input);
  }
}
