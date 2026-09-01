import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  readCoarseProjectionServiceV1,
  readCoarseEnumerationBindingV1,
  readCoarseRouteBindingV1,
} from "./internal/state.ts";
import type { CoarseProjectionOwnerDescriptorV1 } from "./internal/qualification-owner.ts";
import type { IssuedPlanningEnumerationV1 } from "../../planner/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";

export interface CoarseSourceV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface CoarseAssetAmountV1 {
  readonly assetRef: Hash;
  readonly amount: string;
}

export interface CoarseOutputUpperBoundV1 extends CoarseAssetAmountV1 {
  /** Qualified owner program proving that this is an absolute output cap for
   * every input no larger than inputCapacityUpperBound. */
  readonly proofProgramRef: Hash;
  readonly proofRoot: Hash;
}

export interface CoarseEdgeProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-edge-projection-v1";
  readonly edgeId: Hash;
  readonly transitionRef: Hash;
  readonly routeBindingHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly objectiveRef: Hash;
  readonly ownerRef: Hash;
  readonly capabilityDigest: Hash;
  readonly dependencyRoot: Hash;
  readonly stateFactsRoot: Hash;
  readonly sampleInput: CoarseAssetAmountV1;
  readonly estimatedOutput: CoarseAssetAmountV1 | null;
  readonly conservativeOutputUpperBound: CoarseOutputUpperBoundV1 | null;
  readonly inputCapacityUpperBound: string | null;
  readonly status: "rankable" | "unavailable";
  readonly reasonCode: string | null;
  readonly projectionId: Hash;
}

/** Family-owner-issued, process-local request capability. The coarse core has
 * no minting API; generated composition may only forward this opaque value to
 * the matching release-qualified owner service. */
export type CoarseProjectionCapabilityV1 = object;
/** Process-local admission created only after an owner capability has been
 * read through its release composition authority. Raw receipt DTOs cannot be
 * passed to the route assessor. */
export type QualifiedCoarseProjectionV1 = object;

export interface QualifiedCoarseProjectionReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.qualified-coarse-projection-receipt-v1";
  readonly releaseProvenanceHash: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly ownerQualificationLeafDigest: Hash;
  readonly ownerDescriptor: CoarseProjectionOwnerDescriptorV1;
  readonly projection: CoarseEdgeProjectionV1;
  readonly boundVerification: CoarseBoundVerificationV1 | null;
  readonly receiptRoot: Hash;
}

export interface CoarseBoundVerificationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-bound-verification-v1";
  readonly projectionId: Hash;
  readonly ownerRef: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly ownerQualificationLeafDigest: Hash;
  readonly proofProgramRef: Hash;
  readonly proofRoot: Hash;
  readonly inputCapacityUpperBound: string;
  readonly outputUpperBound: CoarseOutputUpperBoundV1;
  readonly verifierHash: Hash;
  readonly verificationFactRoot: Hash;
  readonly verificationReceiptRoot: Hash;
}

/** Release-composition-issued process-local owner service. */
export type CoarseProjectionServiceV1 = object;

export interface CoarseRouteLegBindingV1 {
  readonly edgeId: Hash;
  readonly transitionRef: Hash;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
}

export interface CoarseRouteBindingV1 {
  readonly candidateId: Hash;
  readonly orderKey: Hash;
  readonly planningProblemHash: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly dependencySetRef: Hash;
  readonly ownerRefs: readonly Hash[];
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly objectiveRef: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly legs: readonly CoarseRouteLegBindingV1[];
}

export type IssuedCoarseRouteBindingV1 = object;

/**
 * One directed persisted-Graph edge selected by the acceptance-only full
 * Graph sweep.  This is deliberately not a route: it carries no candidate,
 * loop, rank, or planner authority and therefore cannot weaken the closed
 * route invariants enforced by CoarseRouteBindingV1.
 */
export interface CoarseEdgeSweepBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-edge-sweep-binding-v1";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly edgeId: Hash;
  readonly transitionRef: Hash;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
  readonly routeBindingHash: Hash;
  readonly routeOwnerRef: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly graphRoot: Hash;
  readonly readyCutoff: CoarseSourceV1;
  readonly source: CoarseSourceV1;
  readonly objectiveRef: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly bindingRoot: Hash;
}

export type IssuedCoarseEdgeSweepBindingV1 = object;

export interface CoarseRouteProfitUpperBoundV1 {
  readonly assetRef: Hash;
  readonly amount: string;
  readonly composerProgramRef: Hash;
  readonly proofRoot: Hash;
}

export interface CoarseRouteAssessmentV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-route-assessment-v1";
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly objectiveRef: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly releaseMembershipRoot: Hash;
  readonly orderedProjectionIds: readonly Hash[];
  readonly orderedProjectionReceiptRoots: readonly Hash[];
  readonly projectionRoot: Hash;
  readonly status: "rankable" | "bounded-unranked";
  readonly rankAssetRef: Hash;
  readonly rankScore: string | null;
  readonly profitUpperBound: CoarseRouteProfitUpperBoundV1 | null;
  readonly reasonCodes: readonly string[];
  readonly assessmentId: Hash;
}

export type IssuedCoarseRouteAssessmentV1 = object;

export interface CoarseAdmissionObjectiveV1 {
  readonly objectiveRef: Hash;
  readonly numeraireAssetRef: Hash;
  readonly minNetGain: string;
  readonly maxGas: string;
  readonly maxValueAtRisk: string;
}

export interface CoarseEnumerationCandidateV1 {
  readonly binding: IssuedCoarseRouteBindingV1;
  readonly assessment: IssuedCoarseRouteAssessmentV1 | null;
}

export interface CoarseAdmissionPolicyV1 {
  readonly rankedLimit: number;
  readonly boundedUnrankedLimit: number;
}

export interface CoarseEnumerationBindingV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly objective: CoarseAdmissionObjectiveV1;
  readonly policy: CoarseAdmissionPolicyV1;
  readonly fairnessSeed: Hash;
  readonly planningProblemHash: Hash;
  readonly plannerEnumerationRoot: Hash;
  readonly enumerationTruncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  /** Process-local owner denominator. This array is not a wire envelope. */
  readonly candidates: readonly CoarseEnumerationCandidateV1[];
  readonly coarseEnumerationRoot: Hash;
}

export type IssuedCoarseEnumerationBindingV1 = object;

export interface CoarseEnumerationIssueInputV1 {
  readonly plannerEnumeration: IssuedPlanningEnumerationV1;
  readonly generationId: string;
  readonly source: CoarseSourceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly objective: CoarseAdmissionObjectiveV1;
  readonly policy: CoarseAdmissionPolicyV1;
  readonly candidates: readonly CoarseEnumerationCandidateV1[];
}

export interface CoarsePruneReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-proven-prune-v1";
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly assessmentId: Hash;
  readonly projectionRoot: Hash;
  readonly orderedProjectionReceiptRoots: readonly Hash[];
  readonly objectiveRef: Hash;
  readonly numeraireAssetRef: Hash;
  readonly minNetGain: string;
  readonly maxGas: string;
  readonly maxValueAtRisk: string;
  readonly profitUpperBound: CoarseRouteProfitUpperBoundV1;
  readonly pruneReceiptRoot: Hash;
}

export type CoarseAdmissionDispositionV1 =
  | "ranked-selected"
  | "bounded-unranked-selected"
  | "proven-pruned"
  | "not-probed";

export interface CoarseAdmissionEntryV1 {
  readonly candidateId: Hash;
  readonly orderKey: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly dependencySetRef: Hash;
  readonly assessmentId: Hash | null;
  readonly projectionRoot: Hash | null;
  readonly disposition: CoarseAdmissionDispositionV1;
  readonly reasonCode: string;
  readonly pruneReceipt: CoarsePruneReceiptV1 | null;
  readonly entryRoot: Hash;
}

export interface CoarseAdmissionV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.coarse-admission-v1";
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly plannerEnumerationRoot: Hash;
  readonly coarseEnumerationRoot: Hash;
  readonly fairnessSeed: Hash;
  readonly planningProblemHash: Hash;
  readonly enumerationTruncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  readonly objective: CoarseAdmissionObjectiveV1;
  readonly policy: Readonly<{ readonly rankedLimit: string; readonly boundedUnrankedLimit: string }>;
  readonly denominator: string;
  readonly rankedSelected: string;
  readonly boundedUnrankedSelected: string;
  readonly provenPruned: string;
  readonly notProbed: string;
  readonly outcome: "complete-no-candidate" | "complete-candidates-terminal" | "retryable-incomplete";
  /** Process-local selected view. This array is not a wire envelope. */
  readonly selectedCandidateIds: readonly Hash[];
  /** Process-local complete denominator. This array is not a wire envelope. */
  readonly entries: readonly CoarseAdmissionEntryV1[];
  readonly accountingRoot: Hash;
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const MAX_U256 = (1n << 256n) - 1n;
const qualifiedProjections = new WeakMap<object, QualifiedCoarseProjectionReceiptV1>();
const issuedRouteBindings = new WeakMap<object, CoarseRouteBindingV1>();
const issuedAssessments = new WeakMap<object, CoarseRouteAssessmentV1>();
const generationOwnerServiceCounts = new Map<Hash, Map<Hash, number>>();
const MAX_TRACKED_FAIRNESS_GENERATIONS = 4;
const DENOMINATOR_HASH_TREE_FANOUT = 128;

function boundedOrderedRoot(domain: string, values: readonly unknown[]): Hash {
  let level = values.length === 0
    ? [hashDomain(`${domain}/node/v1`, { level: "0", firstOrdinal: "0", values: [] })]
    : Array.from({ length: Math.ceil(values.length / DENOMINATOR_HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * DENOMINATOR_HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: "0",
        firstOrdinal: String(first),
        values: values.slice(first, first + DENOMINATOR_HASH_TREE_FANOUT),
      });
    });
  let depth = 1;
  while (level.length > 1) {
    const previous = level;
    level = Array.from({ length: Math.ceil(previous.length / DENOMINATOR_HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * DENOMINATOR_HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: String(depth),
        firstOrdinal: String(first),
        values: previous.slice(first, first + DENOMINATOR_HASH_TREE_FANOUT),
      });
    });
    depth += 1;
  }
  return hashDomain(domain, {
    algorithm: "bounded-ordered-tree-v1",
    count: String(values.length),
    treeRoot: level[0]!,
  });
}

function nonZeroHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return result;
}

function positiveDecimal(value: unknown, path: string): string {
  const result = assertDecimalString(value, path);
  if (BigInt(result) <= 0n) throw new TypeError(`${path} must be positive`);
  return result;
}

function u256(value: unknown, path: string, allowZero = true): string {
  const result = assertDecimalString(value, path);
  const integer = BigInt(result);
  if ((!allowZero && integer === 0n) || integer > MAX_U256) throw new TypeError(`${path} is outside uint256`);
  return result;
}

function signed(value: bigint): string {
  return value.toString(10);
}

function source(value: unknown, path: string): CoarseSourceV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    chainId: positiveDecimal(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: nonZeroHash(record.hash, `${path}.hash`),
    stateRoot: nonZeroHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function sameSource(left: CoarseSourceV1, right: CoarseSourceV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function sameRuntimeAuthority(
  left: RuntimeAuthorityProjectionV1,
  right: RuntimeAuthorityProjectionV1,
): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function amount(value: unknown, path: string, allowZero: boolean): CoarseAssetAmountV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["assetRef", "amount"], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    assetRef: nonZeroHash(record.assetRef, `${path}.assetRef`),
    amount: u256(record.amount, `${path}.amount`, allowZero),
  });
}

function upperBound(value: unknown, path: string): CoarseOutputUpperBoundV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["assetRef", "amount", "proofProgramRef", "proofRoot"], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    assetRef: nonZeroHash(record.assetRef, `${path}.assetRef`),
    amount: u256(record.amount, `${path}.amount`),
    proofProgramRef: nonZeroHash(record.proofProgramRef, `${path}.proofProgramRef`),
    proofRoot: nonZeroHash(record.proofRoot, `${path}.proofRoot`),
  });
}

function projectionPayload(value: Omit<CoarseEdgeProjectionV1, "projectionId">): unknown {
  return value;
}

export function sealCoarseEdgeProjectionV1(
  draft: Omit<CoarseEdgeProjectionV1, "schemaVersion" | "kind" | "projectionId">,
): CoarseEdgeProjectionV1 {
  return decodeCoarseEdgeProjectionV1({
    schemaVersion: 1,
    kind: "aloha.coarse-edge-projection-v1",
    ...draft,
    projectionId: hashDomain("aloha/coarse-edge-projection/v1", projectionPayload({
      schemaVersion: 1,
      kind: "aloha.coarse-edge-projection-v1",
      ...draft,
    })),
  });
}

export function decodeCoarseEdgeProjectionV1(value: unknown, path = "coarseProjection"): CoarseEdgeProjectionV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "edgeId", "transitionRef", "routeBindingHash", "generationId", "graphRoot",
    "source", "objectiveRef", "ownerRef", "capabilityDigest", "dependencyRoot", "stateFactsRoot",
    "sampleInput", "estimatedOutput", "conservativeOutputUpperBound", "inputCapacityUpperBound",
    "status", "reasonCode", "projectionId",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.coarse-edge-projection-v1") throw new TypeError(`${path} kind/version mismatch`);
  if (record.status !== "rankable" && record.status !== "unavailable") throw new TypeError(`${path}.status is invalid`);
  const status: CoarseEdgeProjectionV1["status"] = record.status;
  const sampleInput = amount(record.sampleInput, `${path}.sampleInput`, false);
  const estimatedOutput = record.estimatedOutput === null ? null : amount(record.estimatedOutput, `${path}.estimatedOutput`, true);
  const conservativeOutputUpperBound = record.conservativeOutputUpperBound === null
    ? null
    : upperBound(record.conservativeOutputUpperBound, `${path}.conservativeOutputUpperBound`);
  const inputCapacityUpperBound = record.inputCapacityUpperBound === null
    ? null
    : u256(record.inputCapacityUpperBound, `${path}.inputCapacityUpperBound`);
  const reasonCode = record.reasonCode === null ? null : assertNonEmptyString(record.reasonCode, `${path}.reasonCode`);
  if (status === "rankable") {
    if (estimatedOutput === null || reasonCode !== null) throw new TypeError(`${path} rankable projection is incomplete`);
    if (inputCapacityUpperBound !== null && BigInt(inputCapacityUpperBound) < BigInt(sampleInput.amount)) throw new TypeError(`${path} sample exceeds input capacity`);
    if (conservativeOutputUpperBound !== null) {
      if (inputCapacityUpperBound === null) throw new TypeError(`${path} conservative bound has no input capacity`);
      if (conservativeOutputUpperBound.assetRef !== estimatedOutput.assetRef
        || BigInt(conservativeOutputUpperBound.amount) < BigInt(estimatedOutput.amount)) {
        throw new TypeError(`${path} conservative output bound is not conservative`);
      }
    }
  } else if (estimatedOutput !== null || conservativeOutputUpperBound !== null || inputCapacityUpperBound !== null || reasonCode === null) {
    throw new TypeError(`${path} unavailable projection carries usable output`);
  }
  const body: Omit<CoarseEdgeProjectionV1, "projectionId"> = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-edge-projection-v1" as const,
    edgeId: nonZeroHash(record.edgeId, `${path}.edgeId`),
    transitionRef: nonZeroHash(record.transitionRef, `${path}.transitionRef`),
    routeBindingHash: nonZeroHash(record.routeBindingHash, `${path}.routeBindingHash`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    source: source(record.source, `${path}.source`),
    objectiveRef: nonZeroHash(record.objectiveRef, `${path}.objectiveRef`),
    ownerRef: nonZeroHash(record.ownerRef, `${path}.ownerRef`),
    capabilityDigest: nonZeroHash(record.capabilityDigest, `${path}.capabilityDigest`),
    dependencyRoot: nonZeroHash(record.dependencyRoot, `${path}.dependencyRoot`),
    stateFactsRoot: nonZeroHash(record.stateFactsRoot, `${path}.stateFactsRoot`),
    sampleInput,
    estimatedOutput,
    conservativeOutputUpperBound,
    inputCapacityUpperBound,
    status,
    reasonCode,
  });
  const projectionId = nonZeroHash(record.projectionId, `${path}.projectionId`);
  if (projectionId !== hashDomain("aloha/coarse-edge-projection/v1", projectionPayload(body))) throw new TypeError(`${path}.projectionId mismatch`);
  return deepFreeze({ ...body, projectionId });
}

function receiptPayload(value: Omit<QualifiedCoarseProjectionReceiptV1, "receiptRoot">): unknown {
  return value;
}

export function coarseBoundVerificationReceiptRootV1(
  value: Omit<CoarseBoundVerificationV1, "verificationReceiptRoot">,
): Hash {
  return hashDomain("aloha/coarse-bound-verification/v1", value);
}

function decodeBoundVerification(
  value: unknown,
  projection: CoarseEdgeProjectionV1,
  path: string,
): CoarseBoundVerificationV1 | null {
  if (value === null) return null;
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "projectionId", "ownerRef", "releaseMembershipRoot", "ownerQualificationLeafDigest", "proofProgramRef", "proofRoot",
    "inputCapacityUpperBound", "outputUpperBound", "verifierHash", "verificationFactRoot",
    "verificationReceiptRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.coarse-bound-verification-v1") throw new TypeError(`${path} kind/version mismatch`);
  if (projection.conservativeOutputUpperBound === null || projection.inputCapacityUpperBound === null) throw new TypeError(`${path} verifies a projection without a bound`);
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-bound-verification-v1" as const,
    projectionId: nonZeroHash(record.projectionId, `${path}.projectionId`),
    ownerRef: nonZeroHash(record.ownerRef, `${path}.ownerRef`),
    releaseMembershipRoot: nonZeroHash(record.releaseMembershipRoot, `${path}.releaseMembershipRoot`),
    ownerQualificationLeafDigest: nonZeroHash(record.ownerQualificationLeafDigest, `${path}.ownerQualificationLeafDigest`),
    proofProgramRef: nonZeroHash(record.proofProgramRef, `${path}.proofProgramRef`),
    proofRoot: nonZeroHash(record.proofRoot, `${path}.proofRoot`),
    inputCapacityUpperBound: u256(record.inputCapacityUpperBound, `${path}.inputCapacityUpperBound`),
    outputUpperBound: upperBound(record.outputUpperBound, `${path}.outputUpperBound`),
    verifierHash: nonZeroHash(record.verifierHash, `${path}.verifierHash`),
    verificationFactRoot: nonZeroHash(record.verificationFactRoot, `${path}.verificationFactRoot`),
  });
  if (body.projectionId !== projection.projectionId
    || body.proofProgramRef !== projection.conservativeOutputUpperBound.proofProgramRef
    || body.proofRoot !== projection.conservativeOutputUpperBound.proofRoot
    || body.inputCapacityUpperBound !== projection.inputCapacityUpperBound
    || encodeCanonicalJson(body.outputUpperBound) !== encodeCanonicalJson(projection.conservativeOutputUpperBound)) {
    throw new TypeError(`${path} does not bind the projection bound`);
  }
  const verificationReceiptRoot = nonZeroHash(record.verificationReceiptRoot, `${path}.verificationReceiptRoot`);
  if (verificationReceiptRoot !== coarseBoundVerificationReceiptRootV1(body)) throw new TypeError(`${path}.verificationReceiptRoot mismatch`);
  return deepFreeze({ ...body, verificationReceiptRoot });
}

function ownerDescriptor(value: unknown, path: string): CoarseProjectionOwnerDescriptorV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "ownerRef", "capabilityId", "capabilityVersion", "schemaRef", "interpreterHash",
    "implementationHash", "boundVerifierHash",
  ], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    ownerRef: nonZeroHash(record.ownerRef, `${path}.ownerRef`),
    capabilityId: assertNonEmptyString(record.capabilityId, `${path}.capabilityId`),
    capabilityVersion: assertNonEmptyString(record.capabilityVersion, `${path}.capabilityVersion`),
    schemaRef: nonZeroHash(record.schemaRef, `${path}.schemaRef`),
    interpreterHash: nonZeroHash(record.interpreterHash, `${path}.interpreterHash`),
    implementationHash: nonZeroHash(record.implementationHash, `${path}.implementationHash`),
    boundVerifierHash: nonZeroHash(record.boundVerifierHash, `${path}.boundVerifierHash`),
  });
}

export function qualifiedCoarseProjectionReceiptRootV1(
  value: Omit<QualifiedCoarseProjectionReceiptV1, "receiptRoot">,
): Hash {
  return hashDomain("aloha/qualified-coarse-projection-receipt/v1", receiptPayload(value));
}

/** Pure exact decoder for durable/observer receipt bytes. It grants no owner
 * authority; callers must still join the decoded receipt to an independently
 * observed release, Graph transition, source and Family observation. */
export function decodeQualifiedCoarseProjectionReceiptV1(
  value: unknown,
  path = "qualifiedCoarseProjection",
): QualifiedCoarseProjectionReceiptV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["schemaVersion", "kind", "releaseProvenanceHash", "releaseMembershipRoot", "ownerQualificationLeafDigest", "ownerDescriptor", "projection", "boundVerification", "receiptRoot"], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.qualified-coarse-projection-receipt-v1") {
    throw new TypeError(`${path} kind/version mismatch`);
  }
  const projection = decodeCoarseEdgeProjectionV1(record.projection, `${path}.projection`);
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.qualified-coarse-projection-receipt-v1" as const,
    releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    releaseMembershipRoot: nonZeroHash(record.releaseMembershipRoot, `${path}.releaseMembershipRoot`),
    ownerQualificationLeafDigest: nonZeroHash(record.ownerQualificationLeafDigest, `${path}.ownerQualificationLeafDigest`),
    ownerDescriptor: ownerDescriptor(record.ownerDescriptor, `${path}.ownerDescriptor`),
    projection,
    boundVerification: decodeBoundVerification(record.boundVerification, projection, `${path}.boundVerification`),
  });
  const expectedQualificationLeaf = hashDomain("aloha/coarse-owner-qualification-leaf/v1", body.ownerDescriptor);
  if (body.ownerQualificationLeafDigest !== expectedQualificationLeaf
    || body.ownerDescriptor.ownerRef !== projection.ownerRef) {
    throw new TypeError(`${path} owner qualification mismatch`);
  }
  if (body.boundVerification !== null && (
    body.boundVerification.ownerRef !== body.ownerDescriptor.ownerRef
    || body.boundVerification.releaseMembershipRoot !== body.releaseMembershipRoot
    || body.boundVerification.ownerQualificationLeafDigest !== body.ownerQualificationLeafDigest
    || body.boundVerification.verifierHash !== body.ownerDescriptor.boundVerifierHash
  )) throw new TypeError(`${path} bound owner mismatch`);
  const receiptRoot = nonZeroHash(record.receiptRoot, `${path}.receiptRoot`);
  if (receiptRoot !== qualifiedCoarseProjectionReceiptRootV1(body)) {
    throw new TypeError(`${path}.receiptRoot mismatch`);
  }
  return deepFreeze({ ...body, receiptRoot });
}

export function readQualifiedCoarseProjectionV1(input: {
  readonly service: CoarseProjectionServiceV1;
  readonly capability: CoarseProjectionCapabilityV1;
}): QualifiedCoarseProjectionV1 {
  if (input.capability === null || typeof input.capability !== "object") throw new TypeError("coarse projection capability is invalid");
  if (input.service === null || typeof input.service !== "object") throw new TypeError("coarse projection service is not owner-issued");
  const read = readCoarseProjectionServiceV1(input.service);
  if (read === undefined) throw new TypeError("coarse projection service is not owner-issued");
  const receipt = decodeQualifiedCoarseProjectionReceiptV1(read(input.capability));
  const qualified = Object.freeze(Object.create(null)) as QualifiedCoarseProjectionV1;
  qualifiedProjections.set(qualified, receipt);
  return qualified;
}

/** Receipt inspection only; possession of the returned DTO grants no owner authority. */
export function readQualifiedCoarseProjectionReceiptV1(value: QualifiedCoarseProjectionV1): QualifiedCoarseProjectionReceiptV1 {
  if (value === null || typeof value !== "object") throw new TypeError("qualified coarse projection capability is invalid");
  const receipt = qualifiedProjections.get(value);
  if (receipt === undefined) throw new TypeError("qualified coarse projection capability was not issued");
  return receipt;
}

export function decodeCoarseRouteBindingV1(value: CoarseRouteBindingV1): CoarseRouteBindingV1 {
  assertPlainObject(value, "coarseRouteBinding");
  assertExactKeys(value, ["candidateId", "orderKey", "planningProblemHash", "routeHash", "routeBindingHash", "dependencySetRef", "ownerRefs", "generationId", "graphRoot", "source", "objectiveRef", "runtimeAuthority", "releaseProvenanceHash", "legs"], "coarseRouteBinding");
  if (!Array.isArray(value.legs) || value.legs.length === 0) throw new TypeError("coarse route has no legs");
  const legs: CoarseRouteLegBindingV1[] = value.legs.map((leg, index) => {
    assertPlainObject(leg, `coarseRouteBinding.legs[${index}]`);
    assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], `coarseRouteBinding.legs[${index}]`);
    return deepFreeze({
      edgeId: nonZeroHash(leg.edgeId, `coarseRouteBinding.legs[${index}].edgeId`),
      transitionRef: nonZeroHash(leg.transitionRef, `coarseRouteBinding.legs[${index}].transitionRef`),
      inputAssetRef: nonZeroHash(leg.inputAssetRef, `coarseRouteBinding.legs[${index}].inputAssetRef`),
      inputPortRef: nonZeroHash(leg.inputPortRef, `coarseRouteBinding.legs[${index}].inputPortRef`),
      outputAssetRef: nonZeroHash(leg.outputAssetRef, `coarseRouteBinding.legs[${index}].outputAssetRef`),
      outputPortRef: nonZeroHash(leg.outputPortRef, `coarseRouteBinding.legs[${index}].outputPortRef`),
    });
  });
  if (new Set(legs.map(leg => leg.edgeId)).size !== legs.length) throw new TypeError("coarse route contains duplicate edges");
  for (const [index, leg] of legs.entries()) {
    if (leg.outputAssetRef !== legs[(index + 1) % legs.length]!.inputAssetRef) throw new TypeError("coarse route asset continuity mismatch");
  }
  if (!Array.isArray(value.ownerRefs) || value.ownerRefs.length === 0) throw new TypeError("coarse route has no owner refs");
  const ownerRefs = value.ownerRefs.map((ownerRef, index) => nonZeroHash(ownerRef, `coarseRouteBinding.ownerRefs[${index}]`));
  if (new Set(ownerRefs).size !== ownerRefs.length) throw new TypeError("coarse route contains duplicate owner refs");
  for (let index = 1; index < ownerRefs.length; index += 1) {
    if (ownerRefs[index - 1]! >= ownerRefs[index]!) throw new TypeError("coarse route owner refs are not strictly sorted");
  }
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  if (runtimeAuthority.authorityClass !== "signed-release") throw new TypeError("coarse route requires signed runtime authority");
  const releaseProvenanceHash = nonZeroHash(value.releaseProvenanceHash, "coarseRouteBinding.releaseProvenanceHash");
  return deepFreeze({
    candidateId: nonZeroHash(value.candidateId, "coarseRouteBinding.candidateId"),
    orderKey: nonZeroHash(value.orderKey, "coarseRouteBinding.orderKey"),
    planningProblemHash: nonZeroHash(value.planningProblemHash, "coarseRouteBinding.planningProblemHash"),
    routeHash: nonZeroHash(value.routeHash, "coarseRouteBinding.routeHash"),
    routeBindingHash: nonZeroHash(value.routeBindingHash, "coarseRouteBinding.routeBindingHash"),
    dependencySetRef: nonZeroHash(value.dependencySetRef, "coarseRouteBinding.dependencySetRef"),
    ownerRefs: deepFreeze(ownerRefs),
    generationId: assertNonEmptyString(value.generationId, "coarseRouteBinding.generationId"),
    graphRoot: nonZeroHash(value.graphRoot, "coarseRouteBinding.graphRoot"),
    source: source(value.source, "coarseRouteBinding.source"),
    objectiveRef: nonZeroHash(value.objectiveRef, "coarseRouteBinding.objectiveRef"),
    runtimeAuthority,
    releaseProvenanceHash,
    legs: deepFreeze(legs),
  });
}

export function readIssuedCoarseRouteBindingV1(value: unknown): CoarseRouteBindingV1 {
  if (value === null || typeof value !== "object") throw new TypeError("coarse route binding capability is invalid");
  const binding = readCoarseRouteBindingV1(value);
  if (binding === undefined) throw new TypeError("coarse route binding was not issued by the search owner");
  return decodeCoarseRouteBindingV1(binding as CoarseRouteBindingV1);
}

export function coarseEdgeSweepBindingRootV1(
  value: Omit<CoarseEdgeSweepBindingV1, "bindingRoot">,
): Hash {
  return hashDomain("aloha/coarse-edge-sweep-binding/v1", value);
}

export function decodeCoarseEdgeSweepBindingV1(
  value: CoarseEdgeSweepBindingV1,
  path = "coarseEdgeSweepBinding",
): CoarseEdgeSweepBindingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "familyId", "familyDefinitionHash", "edgeId", "transitionRef",
    "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef", "routeBindingHash", "routeOwnerRef",
    "generationId", "readyRecordHash", "graphRoot", "readyCutoff", "source", "objectiveRef",
    "releaseProvenanceHash", "bindingRoot",
  ], path);
  if (value.schemaVersion !== 1 || value.kind !== "aloha.coarse-edge-sweep-binding-v1") {
    throw new TypeError(`${path} kind/version mismatch`);
  }
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-edge-sweep-binding-v1" as const,
    familyId: assertNonEmptyString(value.familyId, `${path}.familyId`),
    familyDefinitionHash: nonZeroHash(value.familyDefinitionHash, `${path}.familyDefinitionHash`),
    edgeId: nonZeroHash(value.edgeId, `${path}.edgeId`),
    transitionRef: nonZeroHash(value.transitionRef, `${path}.transitionRef`),
    inputAssetRef: nonZeroHash(value.inputAssetRef, `${path}.inputAssetRef`),
    inputPortRef: nonZeroHash(value.inputPortRef, `${path}.inputPortRef`),
    outputAssetRef: nonZeroHash(value.outputAssetRef, `${path}.outputAssetRef`),
    outputPortRef: nonZeroHash(value.outputPortRef, `${path}.outputPortRef`),
    routeBindingHash: nonZeroHash(value.routeBindingHash, `${path}.routeBindingHash`),
    routeOwnerRef: nonZeroHash(value.routeOwnerRef, `${path}.routeOwnerRef`),
    generationId: assertNonEmptyString(value.generationId, `${path}.generationId`),
    readyRecordHash: nonZeroHash(value.readyRecordHash, `${path}.readyRecordHash`),
    graphRoot: nonZeroHash(value.graphRoot, `${path}.graphRoot`),
    readyCutoff: source(value.readyCutoff, `${path}.readyCutoff`),
    source: source(value.source, `${path}.source`),
    objectiveRef: nonZeroHash(value.objectiveRef, `${path}.objectiveRef`),
    releaseProvenanceHash: nonZeroHash(value.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
  });
  if (value.inputAssetRef === value.outputAssetRef) throw new TypeError(`${path} direction assets must differ`);
  if (body.readyCutoff.chainId !== body.source.chainId || BigInt(body.source.number) < BigInt(body.readyCutoff.number)) {
    throw new TypeError(`${path} current source is before or outside the Ready chain`);
  }
  const bindingRoot = nonZeroHash(value.bindingRoot, `${path}.bindingRoot`);
  if (bindingRoot !== coarseEdgeSweepBindingRootV1(body)) throw new TypeError(`${path}.bindingRoot mismatch`);
  return deepFreeze({ ...body, bindingRoot });
}

function assessmentPayload(value: Omit<CoarseRouteAssessmentV1, "assessmentId">): unknown {
  return value;
}

function computeCoarseRouteAssessmentV1(input: {
  readonly binding: IssuedCoarseRouteBindingV1;
  readonly projections: readonly QualifiedCoarseProjectionV1[];
}): CoarseRouteAssessmentV1 {
  const binding = readIssuedCoarseRouteBindingV1(input.binding);
  if (!Array.isArray(input.projections) || input.projections.length !== binding.legs.length) throw new TypeError("coarse projection denominator mismatch");
  const receipts = input.projections.map((projection, index) => {
    if (projection === null || typeof projection !== "object") throw new TypeError(`qualified coarse projection ${index} is invalid`);
    const receipt = qualifiedProjections.get(projection);
    if (receipt === undefined) throw new TypeError(`qualified coarse projection ${index} was not admitted`);
    return receipt;
  });
  const projections = receipts.map((receipt, index) => {
    const projection = decodeCoarseEdgeProjectionV1(receipt.projection, `coarseRoute.projections[${index}]`);
    const leg = binding.legs[index]!;
    if (receipt.releaseProvenanceHash !== binding.releaseProvenanceHash
      || projection.edgeId !== leg.edgeId
      || projection.transitionRef !== leg.transitionRef
      || projection.routeBindingHash !== binding.routeBindingHash
      || projection.generationId !== binding.generationId
      || projection.graphRoot !== binding.graphRoot
      || !sameSource(projection.source, binding.source)
      || projection.objectiveRef !== binding.objectiveRef
      || projection.sampleInput.assetRef !== leg.inputAssetRef
      || (projection.estimatedOutput !== null && projection.estimatedOutput.assetRef !== leg.outputAssetRef)) {
      throw new TypeError(`coarse projection ${index} does not bind the route`);
    }
    return projection;
  });
  if (new Set(receipts.map(receipt => receipt.releaseMembershipRoot)).size !== 1) {
    throw new TypeError("coarse route projections do not share one release membership root");
  }
  const releaseMembershipRoot = receipts[0]!.releaseMembershipRoot;
  const unavailable = projections.filter(projection => projection.status === "unavailable");
  let rankScore: string | null = null;
  if (unavailable.length === 0) {
    for (let index = 1; index < projections.length; index += 1) {
      if (projections[index]!.sampleInput.amount !== projections[index - 1]!.estimatedOutput!.amount) {
        throw new TypeError("coarse route estimated amount continuity mismatch");
      }
    }
    const initial = BigInt(projections[0]!.sampleInput.amount);
    const final = BigInt(projections.at(-1)!.estimatedOutput!.amount);
    rankScore = signed(final - initial);
  }
  const orderedProjectionIds = deepFreeze(projections.map(projection => projection.projectionId));
  const orderedProjectionReceiptRoots = deepFreeze(receipts.map(receipt => receipt.receiptRoot));
  const reasonCodes = deepFreeze([...new Set(unavailable.map(projection => projection.reasonCode!))].sort());
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-route-assessment-v1" as const,
    routeHash: binding.routeHash,
    routeBindingHash: binding.routeBindingHash,
    generationId: binding.generationId,
    graphRoot: binding.graphRoot,
    source: binding.source,
    objectiveRef: binding.objectiveRef,
    runtimeAuthority: binding.runtimeAuthority,
    releaseProvenanceHash: binding.releaseProvenanceHash,
    releaseMembershipRoot,
    orderedProjectionIds,
    orderedProjectionReceiptRoots,
    projectionRoot: hashDomain("aloha/coarse-route-projection-root/v1", orderedProjectionIds),
    status: unavailable.length === 0 ? "rankable" as const : "bounded-unranked" as const,
    rankAssetRef: projections[0]!.sampleInput.assetRef,
    rankScore,
    // Per-edge absolute output caps do not prove a route-wide profit bound
    // over ObjectiveProfile.maxValueAtRisk. Until a separately qualified
    // route-domain verifier exists, coarse evidence is rank-only.
    profitUpperBound: null,
    reasonCodes,
  });
  return deepFreeze({ ...body, assessmentId: hashDomain("aloha/coarse-route-assessment/v1", assessmentPayload(body)) });
}

/** Pure receipt projection for evidence/inspection. Admission never accepts
 * this DTO directly; it requires the process-local issued capability below. */
export function assessCoarseRouteV1(input: {
  readonly binding: IssuedCoarseRouteBindingV1;
  readonly projections: readonly QualifiedCoarseProjectionV1[];
}): CoarseRouteAssessmentV1 {
  return computeCoarseRouteAssessmentV1(input);
}

export function issueCoarseRouteAssessmentV1(input: {
  readonly binding: IssuedCoarseRouteBindingV1;
  readonly projections: readonly QualifiedCoarseProjectionV1[];
}): IssuedCoarseRouteAssessmentV1 {
  const assessment = computeCoarseRouteAssessmentV1(input);
  const capability = Object.freeze(Object.create(null)) as IssuedCoarseRouteAssessmentV1;
  issuedAssessments.set(capability, assessment);
  return capability;
}

export function readIssuedCoarseRouteAssessmentV1(value: unknown): CoarseRouteAssessmentV1 {
  if (value === null || typeof value !== "object") throw new TypeError("coarse route assessment capability is invalid");
  const assessment = issuedAssessments.get(value);
  if (assessment === undefined) throw new TypeError("coarse route assessment was not issued");
  return assessment;
}

export function validateCoarseRouteAssessmentV1(value: CoarseRouteAssessmentV1): void {
  assertExactKeys(value, [
    "schemaVersion", "kind", "routeHash", "routeBindingHash", "generationId", "graphRoot", "source",
    "objectiveRef", "runtimeAuthority", "releaseProvenanceHash", "releaseMembershipRoot", "orderedProjectionIds", "orderedProjectionReceiptRoots", "projectionRoot", "status", "rankAssetRef",
    "rankScore", "profitUpperBound", "reasonCodes", "assessmentId",
  ], "coarseRouteAssessment");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  if (runtimeAuthority.authorityClass !== "signed-release") throw new TypeError("coarse route assessment requires signed runtime authority");
  nonZeroHash(value.releaseProvenanceHash, "coarseRouteAssessment.releaseProvenanceHash");
  nonZeroHash(value.releaseMembershipRoot, "coarseRouteAssessment.releaseMembershipRoot");
  const { assessmentId, ...body } = value;
  if (assessmentId !== hashDomain("aloha/coarse-route-assessment/v1", assessmentPayload(body))) throw new TypeError("coarse route assessment id mismatch");
  if (encodeCanonicalJson(value).length === 0) throw new TypeError("coarse route assessment is not canonical");
}

function signedDecimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) throw new TypeError(`${path} is not a canonical signed decimal`);
  return value;
}

function admissionEntryRoot(value: Omit<CoarseAdmissionEntryV1, "entryRoot">): Hash {
  return hashDomain("aloha/coarse-admission-entry/v1", value);
}

type NormalizedEnumerationCandidateV1 = Readonly<{
  readonly bindingCapability: IssuedCoarseRouteBindingV1;
  readonly binding: CoarseRouteBindingV1;
  readonly assessment: IssuedCoarseRouteAssessmentV1 | null;
}>;

function objective(value: CoarseAdmissionObjectiveV1, path: string): CoarseAdmissionObjectiveV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["objectiveRef", "numeraireAssetRef", "minNetGain", "maxGas", "maxValueAtRisk"], path);
  const body = deepFreeze({
    numeraireAssetRef: nonZeroHash(value.numeraireAssetRef, `${path}.numeraireAssetRef`),
    minNetGain: u256(value.minNetGain, `${path}.minNetGain`),
    maxGas: u256(value.maxGas, `${path}.maxGas`),
    maxValueAtRisk: u256(value.maxValueAtRisk, `${path}.maxValueAtRisk`),
  });
  const objectiveRef = nonZeroHash(value.objectiveRef, `${path}.objectiveRef`);
  if (objectiveRef !== hashDomain("aloha/search-objective/v1", body)) throw new TypeError(`${path}.objectiveRef mismatch`);
  return deepFreeze({ objectiveRef, ...body });
}

function policy(value: CoarseAdmissionPolicyV1, path: string): CoarseAdmissionPolicyV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["rankedLimit", "boundedUnrankedLimit"], path);
  if (!Number.isSafeInteger(value.rankedLimit) || value.rankedLimit < 0
    || !Number.isSafeInteger(value.boundedUnrankedLimit) || value.boundedUnrankedLimit < 0) throw new TypeError(`${path} is invalid`);
  return deepFreeze({ rankedLimit: value.rankedLimit, boundedUnrankedLimit: value.boundedUnrankedLimit });
}

function enumerationRootPayload(input: {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: CoarseSourceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly objective: CoarseAdmissionObjectiveV1;
  readonly policy: CoarseAdmissionPolicyV1;
  readonly fairnessSeed: Hash;
  readonly planningProblemHash: Hash;
  readonly plannerEnumerationRoot: Hash;
  readonly enumerationTruncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  readonly candidates: readonly NormalizedEnumerationCandidateV1[];
}): unknown {
  const orderedCandidateRoot = boundedOrderedRoot(
    "aloha/coarse-enumeration-candidates/v1",
    input.candidates.map(candidate => {
      let assessmentCommitment: Readonly<{ readonly status: "missing" | "invalid" }> | Readonly<{
        readonly status: "issued";
        readonly assessmentId: Hash;
      }>;
      if (candidate.assessment === null) {
        assessmentCommitment = Object.freeze({ status: "missing" as const });
      } else {
        try {
          assessmentCommitment = Object.freeze({
            status: "issued" as const,
            assessmentId: readIssuedCoarseRouteAssessmentV1(candidate.assessment).assessmentId,
          });
        } catch {
          assessmentCommitment = Object.freeze({ status: "invalid" as const });
        }
      }
      return {
        candidateId: candidate.binding.candidateId,
        orderKey: candidate.binding.orderKey,
        planningProblemHash: candidate.binding.planningProblemHash,
        routeHash: candidate.binding.routeHash,
        routeBindingHash: candidate.binding.routeBindingHash,
        dependencySetRef: candidate.binding.dependencySetRef,
        ownerRefsRoot: boundedOrderedRoot("aloha/coarse-enumeration-candidate-owner-refs/v1", candidate.binding.ownerRefs),
        assessmentCommitment,
      };
    }),
  );
  return {
    generationId: input.generationId,
    graphRoot: input.graphRoot,
    source: input.source,
    runtimeAuthority: input.runtimeAuthority,
    releaseProvenanceHash: input.releaseProvenanceHash,
    objective: input.objective,
    policy: input.policy,
    fairnessSeed: input.fairnessSeed,
    planningProblemHash: input.planningProblemHash,
    plannerEnumerationRoot: input.plannerEnumerationRoot,
    enumerationTruncated: input.enumerationTruncated,
    observedUniqueCountLowerBound: input.observedUniqueCountLowerBound,
    candidateCount: String(input.candidates.length),
    orderedCandidateRoot,
  };
}

export function decodeCoarseEnumerationBindingV1(value: CoarseEnumerationBindingV1): CoarseEnumerationBindingV1 {
  assertPlainObject(value, "coarseEnumeration");
  assertExactKeys(value, ["generationId", "graphRoot", "source", "runtimeAuthority", "releaseProvenanceHash", "objective", "policy", "fairnessSeed", "planningProblemHash", "plannerEnumerationRoot", "enumerationTruncated", "observedUniqueCountLowerBound", "candidates", "coarseEnumerationRoot"], "coarseEnumeration");
  const generationId = assertNonEmptyString(value.generationId, "coarseEnumeration.generationId");
  const graphRoot = nonZeroHash(value.graphRoot, "coarseEnumeration.graphRoot");
  const sourceView = source(value.source, "coarseEnumeration.source");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  if (runtimeAuthority.authorityClass !== "signed-release") throw new TypeError("coarse enumeration requires signed runtime authority");
  const releaseProvenanceHash = nonZeroHash(value.releaseProvenanceHash, "coarseEnumeration.releaseProvenanceHash");
  const normalizedObjective = objective(value.objective, "coarseEnumeration.objective");
  const normalizedPolicy = policy(value.policy, "coarseEnumeration.policy");
  const plannerEnumerationRoot = nonZeroHash(value.plannerEnumerationRoot, "coarseEnumeration.plannerEnumerationRoot");
  const planningProblemHash = nonZeroHash(value.planningProblemHash, "coarseEnumeration.planningProblemHash");
  if (typeof value.enumerationTruncated !== "boolean") throw new TypeError("coarseEnumeration.enumerationTruncated is invalid");
  const observedUniqueCountLowerBound = assertDecimalString(value.observedUniqueCountLowerBound, "coarseEnumeration.observedUniqueCountLowerBound");
  const fairnessSeed = nonZeroHash(value.fairnessSeed, "coarseEnumeration.fairnessSeed");
  const expectedFairnessSeed = hashDomain("aloha/coarse-fairness-seed/v1", { generationId, runtimeAuthority, releaseProvenanceHash, source: sourceView, plannerEnumerationRoot });
  if (fairnessSeed !== expectedFairnessSeed) throw new TypeError("coarseEnumeration.fairnessSeed mismatch");
  if (!Array.isArray(value.candidates)) throw new TypeError("coarseEnumeration.candidates is invalid");
  const normalizedCandidates: readonly NormalizedEnumerationCandidateV1[] = deepFreeze(value.candidates.map((candidate, index) => {
    assertPlainObject(candidate, `coarseEnumeration.candidates[${index}]`);
    assertExactKeys(candidate, ["binding", "assessment"], `coarseEnumeration.candidates[${index}]`);
    const bindingCapability = candidate.binding as IssuedCoarseRouteBindingV1;
    const assessment = candidate.assessment === null
      ? null
      : candidate.assessment as IssuedCoarseRouteAssessmentV1;
    const binding = readIssuedCoarseRouteBindingV1(bindingCapability);
    if (binding.generationId !== generationId || binding.graphRoot !== graphRoot || !sameSource(binding.source, sourceView)
      || !sameRuntimeAuthority(binding.runtimeAuthority, runtimeAuthority)
      || binding.releaseProvenanceHash !== releaseProvenanceHash
      || binding.objectiveRef !== normalizedObjective.objectiveRef) {
      throw new TypeError(`coarseEnumeration.candidates[${index}] binding mismatch`);
    }
    return deepFreeze({ bindingCapability, binding, assessment });
  }));
  if (new Set(normalizedCandidates.map(candidate => candidate.binding.candidateId)).size !== normalizedCandidates.length
    || new Set(normalizedCandidates.map(candidate => candidate.binding.routeHash)).size !== normalizedCandidates.length) throw new TypeError("coarseEnumeration candidate denominator contains duplicates");
  if ((!value.enumerationTruncated && BigInt(observedUniqueCountLowerBound) !== BigInt(normalizedCandidates.length))
    || (value.enumerationTruncated && BigInt(observedUniqueCountLowerBound) <= BigInt(normalizedCandidates.length))) {
    throw new TypeError("coarseEnumeration completeness facts are inconsistent");
  }
  for (let index = 1; index < normalizedCandidates.length; index += 1) {
    if (normalizedCandidates[index - 1]!.binding.orderKey >= normalizedCandidates[index]!.binding.orderKey) throw new TypeError("coarseEnumeration candidate order is not strict");
  }
  const rootInput = { generationId, graphRoot, source: sourceView, runtimeAuthority, releaseProvenanceHash, objective: normalizedObjective, policy: normalizedPolicy, fairnessSeed, planningProblemHash, plannerEnumerationRoot, enumerationTruncated: value.enumerationTruncated, observedUniqueCountLowerBound, candidates: normalizedCandidates };
  const coarseEnumerationRoot = nonZeroHash(value.coarseEnumerationRoot, "coarseEnumeration.coarseEnumerationRoot");
  if (coarseEnumerationRoot !== hashDomain("aloha/coarse-enumeration/v1", enumerationRootPayload(rootInput))) throw new TypeError("coarseEnumeration.coarseEnumerationRoot mismatch");
  return deepFreeze({
    generationId,
    graphRoot,
    source: sourceView,
    runtimeAuthority,
    releaseProvenanceHash,
    objective: normalizedObjective,
    policy: normalizedPolicy,
    fairnessSeed,
    planningProblemHash,
    plannerEnumerationRoot,
    enumerationTruncated: value.enumerationTruncated,
    observedUniqueCountLowerBound,
    candidates: deepFreeze(normalizedCandidates.map(candidate => deepFreeze({ binding: candidate.bindingCapability, assessment: candidate.assessment }))),
    coarseEnumerationRoot,
  });
}

export function coarseEnumerationRootV1(value: Omit<CoarseEnumerationBindingV1, "coarseEnumerationRoot">): Hash {
  const candidates: readonly NormalizedEnumerationCandidateV1[] = value.candidates.map(candidate => deepFreeze({
    bindingCapability: candidate.binding,
    binding: readIssuedCoarseRouteBindingV1(candidate.binding),
    assessment: candidate.assessment,
  }));
  return hashDomain("aloha/coarse-enumeration/v1", enumerationRootPayload({ ...value, candidates }));
}

export function coarseAdmissionAccountingRootV1(value: Omit<CoarseAdmissionV1, "accountingRoot">): Hash {
  if (!Array.isArray(value.selectedCandidateIds) || !Array.isArray(value.entries)) {
    throw new TypeError("coarse admission selected/entry denominator is invalid");
  }
  const entryRoots = value.entries.map((entry, index) => {
    assertPlainObject(entry, `coarseAdmission.entries[${index}]`);
    assertExactKeys(entry, [
      "candidateId", "orderKey", "routeHash", "routeBindingHash", "dependencySetRef", "assessmentId",
      "projectionRoot", "disposition", "reasonCode", "pruneReceipt", "entryRoot",
    ], `coarseAdmission.entries[${index}]`);
    for (const key of ["candidateId", "orderKey", "routeHash", "routeBindingHash", "dependencySetRef"] as const) {
      nonZeroHash(entry[key], `coarseAdmission.entries[${index}].${key}`);
    }
    if (entry.assessmentId !== null) nonZeroHash(entry.assessmentId, `coarseAdmission.entries[${index}].assessmentId`);
    if (entry.projectionRoot !== null) nonZeroHash(entry.projectionRoot, `coarseAdmission.entries[${index}].projectionRoot`);
    if (entry.disposition !== "ranked-selected" && entry.disposition !== "bounded-unranked-selected"
      && entry.disposition !== "proven-pruned" && entry.disposition !== "not-probed") {
      throw new TypeError(`coarseAdmission.entries[${index}].disposition is invalid`);
    }
    assertNonEmptyString(entry.reasonCode, `coarseAdmission.entries[${index}].reasonCode`);
    if ((entry.disposition === "ranked-selected" && (entry.assessmentId === null || entry.projectionRoot === null))
      || (entry.disposition === "proven-pruned") !== (entry.pruneReceipt !== null)) {
      throw new TypeError(`coarseAdmission.entries[${index}] disposition evidence is inconsistent`);
    }
    const { entryRoot, ...body } = entry;
    const normalizedEntryRoot = nonZeroHash(entryRoot, `coarseAdmission.entries[${index}].entryRoot`);
    if (normalizedEntryRoot !== admissionEntryRoot(body as Omit<CoarseAdmissionEntryV1, "entryRoot">)) {
      throw new TypeError(`coarseAdmission.entries[${index}].entryRoot mismatch`);
    }
    return normalizedEntryRoot;
  });
  const entryCandidateIds = value.entries.map(entry => entry.candidateId);
  if (new Set(entryCandidateIds).size !== entryCandidateIds.length) {
    throw new TypeError("coarse admission entry denominator contains duplicates");
  }
  const selectedCandidateIds = value.selectedCandidateIds.map((candidateId, index) => (
    nonZeroHash(candidateId, `coarseAdmission.selectedCandidateIds[${index}]`)
  ));
  if (new Set(selectedCandidateIds).size !== selectedCandidateIds.length) {
    throw new TypeError("coarse admission selected denominator contains duplicates");
  }
  const expectedSelectedCandidateIds = value.entries.flatMap(entry => (
    entry.disposition === "ranked-selected" || entry.disposition === "bounded-unranked-selected"
      ? [entry.candidateId]
      : []
  ));
  if (selectedCandidateIds.length !== expectedSelectedCandidateIds.length
    || selectedCandidateIds.some((candidateId, index) => candidateId !== expectedSelectedCandidateIds[index])) {
    throw new TypeError("coarse admission selected denominator does not match entry dispositions");
  }
  const dispositionCount = (disposition: CoarseAdmissionDispositionV1): string => (
    String(value.entries.filter(entry => entry.disposition === disposition).length)
  );
  if (assertDecimalString(value.denominator, "coarseAdmission.denominator") !== String(value.entries.length)
    || assertDecimalString(value.rankedSelected, "coarseAdmission.rankedSelected") !== dispositionCount("ranked-selected")
    || assertDecimalString(value.boundedUnrankedSelected, "coarseAdmission.boundedUnrankedSelected") !== dispositionCount("bounded-unranked-selected")
    || assertDecimalString(value.provenPruned, "coarseAdmission.provenPruned") !== dispositionCount("proven-pruned")
    || assertDecimalString(value.notProbed, "coarseAdmission.notProbed") !== dispositionCount("not-probed")) {
    throw new TypeError("coarse admission scalar accounting does not match entries");
  }
  const observedUniqueCountLowerBound = BigInt(assertDecimalString(
    value.observedUniqueCountLowerBound,
    "coarseAdmission.observedUniqueCountLowerBound",
  ));
  if ((!value.enumerationTruncated && observedUniqueCountLowerBound !== BigInt(value.entries.length))
    || (value.enumerationTruncated && observedUniqueCountLowerBound <= BigInt(value.entries.length))) {
    throw new TypeError("coarse admission completeness facts do not match entries");
  }
  const rankedLimit = BigInt(assertDecimalString(value.policy.rankedLimit, "coarseAdmission.policy.rankedLimit"));
  const boundedUnrankedLimit = BigInt(assertDecimalString(value.policy.boundedUnrankedLimit, "coarseAdmission.policy.boundedUnrankedLimit"));
  if (BigInt(value.rankedSelected) > rankedLimit || BigInt(value.boundedUnrankedSelected) > boundedUnrankedLimit) {
    throw new TypeError("coarse admission selected counts exceed policy");
  }
  const expectedOutcome: CoarseAdmissionV1["outcome"] = value.entries.length === 0 && !value.enumerationTruncated
    ? "complete-no-candidate"
    : value.enumerationTruncated || value.entries.some(entry => entry.disposition === "not-probed")
      ? "retryable-incomplete"
      : "complete-candidates-terminal";
  if (value.outcome !== expectedOutcome) throw new TypeError("coarse admission outcome does not match entries");
  return hashDomain("aloha/coarse-admission/v1", {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    generationId: value.generationId,
    graphRoot: value.graphRoot,
    source: value.source,
    runtimeAuthority: value.runtimeAuthority,
    releaseProvenanceHash: value.releaseProvenanceHash,
    planningProblemHash: value.planningProblemHash,
    plannerEnumerationRoot: value.plannerEnumerationRoot,
    enumerationTruncated: value.enumerationTruncated,
    observedUniqueCountLowerBound: value.observedUniqueCountLowerBound,
    coarseEnumerationRoot: value.coarseEnumerationRoot,
    fairnessSeed: value.fairnessSeed,
    objective: value.objective,
    policy: value.policy,
    denominator: value.denominator,
    rankedSelected: value.rankedSelected,
    boundedUnrankedSelected: value.boundedUnrankedSelected,
    provenPruned: value.provenPruned,
    notProbed: value.notProbed,
    outcome: value.outcome,
    selectedCandidateCount: String(value.selectedCandidateIds.length),
    orderedSelectedCandidateRoot: boundedOrderedRoot(
      "aloha/coarse-admission-selected-candidates/v1",
      selectedCandidateIds,
    ),
    entryCount: String(value.entries.length),
    orderedEntryRoot: boundedOrderedRoot(
      "aloha/coarse-admission-entries/v1",
      entryRoots,
    ),
  });
}

export function readIssuedCoarseEnumerationBindingV1(value: unknown): CoarseEnumerationBindingV1 {
  if (value === null || typeof value !== "object") throw new TypeError("coarse enumeration capability is invalid");
  const binding = readCoarseEnumerationBindingV1(value);
  if (binding === undefined) throw new TypeError("coarse enumeration was not issued by the search owner");
  return decodeCoarseEnumerationBindingV1(binding as CoarseEnumerationBindingV1);
}

function pruneReceipt(input: {
  readonly binding: CoarseRouteBindingV1;
  readonly assessment: CoarseRouteAssessmentV1;
  readonly objective: CoarseAdmissionObjectiveV1;
}): CoarsePruneReceiptV1 {
  if (input.assessment.profitUpperBound === null) throw new TypeError("coarse prune upper bound is unavailable");
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-proven-prune-v1" as const,
    candidateId: input.binding.candidateId,
    routeHash: input.binding.routeHash,
    routeBindingHash: input.binding.routeBindingHash,
    assessmentId: input.assessment.assessmentId,
    projectionRoot: input.assessment.projectionRoot,
    orderedProjectionReceiptRoots: input.assessment.orderedProjectionReceiptRoots,
    objectiveRef: input.objective.objectiveRef,
    numeraireAssetRef: input.objective.numeraireAssetRef,
    minNetGain: input.objective.minNetGain,
    maxGas: input.objective.maxGas,
    maxValueAtRisk: input.objective.maxValueAtRisk,
    profitUpperBound: input.assessment.profitUpperBound,
  });
  return deepFreeze({ ...body, pruneReceiptRoot: hashDomain("aloha/coarse-proven-prune/v1", body) });
}

type AssessedCandidateV1 = Readonly<{
  readonly binding: CoarseRouteBindingV1;
  readonly assessment: CoarseRouteAssessmentV1 | null;
  readonly reasonCode: string;
}>;

function leastServed<T extends { readonly binding: CoarseRouteBindingV1 }>(
  values: readonly T[],
  limit: number,
  generationFairnessKey: Hash,
  fairnessSeed: Hash,
): readonly T[] {
  if (values.length === 0 || limit === 0) return Object.freeze([]);
  let counts = generationOwnerServiceCounts.get(generationFairnessKey);
  if (counts === undefined) {
    counts = new Map<Hash, number>();
    if (generationOwnerServiceCounts.size === MAX_TRACKED_FAIRNESS_GENERATIONS) {
      generationOwnerServiceCounts.delete(generationOwnerServiceCounts.keys().next().value!);
    }
  } else {
    generationOwnerServiceCounts.delete(generationFairnessKey);
  }
  generationOwnerServiceCounts.set(generationFairnessKey, counts);
  // Rank one admission against one immutable service-count snapshot. Updating
  // counts only after the bounded set is fixed preserves generation-local
  // fairness across admissions without repeatedly sorting a shrinking 30k
  // denominator (quadratic in the admitted limit).
  const selected = values.map(value => {
    const ownerCounts = value.binding.ownerRefs.map(ownerRef => counts.get(ownerRef) ?? 0);
    return {
      value,
      maximumOwnerCount: Math.max(...ownerCounts),
      totalOwnerCount: ownerCounts.reduce((total, ownerCount) => total + ownerCount, 0),
      tie: hashDomain("aloha/coarse-fairness-tie/v1", { fairnessSeed, candidateId: value.binding.candidateId }),
    };
  }).sort((left, right) => (
    left.maximumOwnerCount - right.maximumOwnerCount
    || left.totalOwnerCount - right.totalOwnerCount
    || (left.tie < right.tie ? -1 : left.tie > right.tie ? 1 : 0)
  )).slice(0, limit).map(entry => entry.value);
  for (const next of selected) {
    for (const ownerRef of next.binding.ownerRefs) counts.set(ownerRef, (counts.get(ownerRef) ?? 0) + 1);
  }
  return Object.freeze(selected);
}

export function admitCoarseRoutesV1(input: { readonly enumeration: IssuedCoarseEnumerationBindingV1 }): CoarseAdmissionV1 {
  const enumeration = readIssuedCoarseEnumerationBindingV1(input.enumeration);
  const candidates = enumeration.candidates.map(candidate => ({
    binding: readIssuedCoarseRouteBindingV1(candidate.binding),
    assessmentCapability: candidate.assessment,
  }));
  const rankable: Array<{ readonly binding: CoarseRouteBindingV1; readonly assessment: CoarseRouteAssessmentV1 }> = [];
  const unranked: AssessedCandidateV1[] = [];
  const assessments = new Map<Hash, CoarseRouteAssessmentV1>();
  for (const candidate of candidates) {
    if (candidate.assessmentCapability === null) {
      unranked.push({ binding: candidate.binding, assessment: null, reasonCode: "invalid-assessment:coarse route assessment capability is invalid" });
      continue;
    }
    let assessment: CoarseRouteAssessmentV1;
    try {
      assessment = readIssuedCoarseRouteAssessmentV1(candidate.assessmentCapability);
      validateCoarseRouteAssessmentV1(assessment);
      if (assessment.routeHash !== candidate.binding.routeHash
        || assessment.routeBindingHash !== candidate.binding.routeBindingHash
        || assessment.generationId !== enumeration.generationId
        || assessment.graphRoot !== enumeration.graphRoot
        || !sameSource(assessment.source, enumeration.source)
        || !sameRuntimeAuthority(assessment.runtimeAuthority, enumeration.runtimeAuthority)
        || assessment.releaseProvenanceHash !== enumeration.releaseProvenanceHash
        || assessment.objectiveRef !== enumeration.objective.objectiveRef) throw new TypeError("assessment-binding-mismatch");
    } catch (error) {
      unranked.push({ binding: candidate.binding, assessment: null, reasonCode: error instanceof Error ? `invalid-assessment:${error.message}` : "invalid-assessment" });
      continue;
    }
    assessments.set(candidate.binding.candidateId, assessment);
    if (assessment.status === "bounded-unranked") {
      unranked.push({ binding: candidate.binding, assessment, reasonCode: assessment.reasonCodes.join(",") || "projection-unavailable" });
      continue;
    }
    if (assessment.rankAssetRef !== enumeration.objective.numeraireAssetRef) {
      unranked.push({ binding: candidate.binding, assessment, reasonCode: "rank-asset-not-objective-numeraire" });
      continue;
    }
    signedDecimal(assessment.rankScore, "coarseAdmission.assessment.rankScore");
    rankable.push({ binding: candidate.binding, assessment });
  }
  rankable.sort((left, right) => {
    const scoreOrder = BigInt(right.assessment.rankScore!) - BigInt(left.assessment.rankScore!);
    return scoreOrder < 0n ? -1 : scoreOrder > 0n ? 1 : left.binding.orderKey < right.binding.orderKey ? -1 : 1;
  });
  const generationFairnessKey = hashDomain("aloha/coarse-generation-fairness/v1", {
    generationId: enumeration.generationId,
    graphRoot: enumeration.graphRoot,
    runtimeAuthority: enumeration.runtimeAuthority,
    releaseProvenanceHash: enumeration.releaseProvenanceHash,
  });
  const rankedSelected: Array<{ readonly binding: CoarseRouteBindingV1; readonly assessment: CoarseRouteAssessmentV1 }> = [];
  for (let index = 0; index < rankable.length && rankedSelected.length < enumeration.policy.rankedLimit;) {
    const score = rankable[index]!.assessment.rankScore;
    const boundary: typeof rankable = [];
    while (index < rankable.length && rankable[index]!.assessment.rankScore === score) boundary.push(rankable[index++]!);
    rankedSelected.push(...leastServed(
      boundary,
      enumeration.policy.rankedLimit - rankedSelected.length,
      generationFairnessKey,
      enumeration.fairnessSeed,
    ));
  }
  const unrankedSelected = leastServed(
    unranked,
    enumeration.policy.boundedUnrankedLimit,
    generationFairnessKey,
    enumeration.fairnessSeed,
  );
  const rankedIds = new Set(rankedSelected.map(value => value.binding.candidateId));
  const unrankedIds = new Set(unrankedSelected.map(value => value.binding.candidateId));
  const rankableByCandidateId = new Map(rankable.map(value => [value.binding.candidateId, value]));
  const unrankedByCandidateId = new Map(unranked.map(value => [value.binding.candidateId, value]));
  const entries = candidates.map(candidate => {
    const ranked = rankableByCandidateId.get(candidate.binding.candidateId);
    const unrankedValue = unrankedByCandidateId.get(candidate.binding.candidateId);
    const assessment = assessments.get(candidate.binding.candidateId) ?? null;
    const prune = null;
    const disposition: CoarseAdmissionDispositionV1 = rankedIds.has(candidate.binding.candidateId) ? "ranked-selected"
        : unrankedIds.has(candidate.binding.candidateId) ? "bounded-unranked-selected" : "not-probed";
    const reasonCode = disposition === "ranked-selected" ? "ranked-top-k"
        : disposition === "bounded-unranked-selected" ? unrankedValue?.reasonCode ?? "bounded-unranked"
          : ranked !== undefined ? "ranked-budget" : "bounded-unranked-budget";
    const body = deepFreeze({
      candidateId: candidate.binding.candidateId,
      orderKey: candidate.binding.orderKey,
      routeHash: candidate.binding.routeHash,
      routeBindingHash: candidate.binding.routeBindingHash,
      dependencySetRef: candidate.binding.dependencySetRef,
      assessmentId: assessment?.assessmentId ?? null,
      projectionRoot: assessment?.projectionRoot ?? null,
      disposition,
      reasonCode,
      pruneReceipt: prune,
    });
    return deepFreeze({ ...body, entryRoot: admissionEntryRoot(body) });
  });
  const selectedCandidateIds = deepFreeze(entries.filter(entry => entry.disposition === "ranked-selected" || entry.disposition === "bounded-unranked-selected").map(entry => entry.candidateId));
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-admission-v1" as const,
    generationId: enumeration.generationId,
    graphRoot: enumeration.graphRoot,
    source: enumeration.source,
    runtimeAuthority: enumeration.runtimeAuthority,
    releaseProvenanceHash: enumeration.releaseProvenanceHash,
    planningProblemHash: enumeration.planningProblemHash,
    plannerEnumerationRoot: enumeration.plannerEnumerationRoot,
    enumerationTruncated: enumeration.enumerationTruncated,
    observedUniqueCountLowerBound: enumeration.observedUniqueCountLowerBound,
    coarseEnumerationRoot: enumeration.coarseEnumerationRoot,
    fairnessSeed: enumeration.fairnessSeed,
    objective: enumeration.objective,
    policy: deepFreeze({ rankedLimit: enumeration.policy.rankedLimit.toString(), boundedUnrankedLimit: enumeration.policy.boundedUnrankedLimit.toString() }),
    denominator: candidates.length.toString(),
    rankedSelected: entries.filter(entry => entry.disposition === "ranked-selected").length.toString(),
    boundedUnrankedSelected: entries.filter(entry => entry.disposition === "bounded-unranked-selected").length.toString(),
    provenPruned: "0",
    notProbed: entries.filter(entry => entry.disposition === "not-probed").length.toString(),
    outcome: candidates.length === 0 && !enumeration.enumerationTruncated
      ? "complete-no-candidate" as const
      : enumeration.enumerationTruncated || entries.some(entry => entry.disposition === "not-probed")
        ? "retryable-incomplete" as const
        : "complete-candidates-terminal" as const,
    selectedCandidateIds,
    entries: deepFreeze(entries),
  });
  return deepFreeze({ ...body, accountingRoot: coarseAdmissionAccountingRootV1(body) });
}
