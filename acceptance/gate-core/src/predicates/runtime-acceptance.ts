import {
  decodeArtifactBytes,
  decodeArtifactResolutionClaim,
  decodeResolverPolicy,
  decodeRetentionLeaseReceipt,
  type ArtifactResolutionClaimV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../../specs/artifact-resolution/src/index.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeReadOnlyArtifactRef,
  hashReadOnlyArtifactLocator,
  type ReadOnlyArtifactRefV1,
} from "../../../../specs/core-envelope/src/index.ts";
import {
  decodeLegacyAuthorityClosureFacts,
  decodeRuntimeAcceptanceFactLocator,
  decodeRuntimeRestartFacts,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS,
  type LegacyAuthorityClosureFactsV1,
  type RuntimeAcceptanceFactLocatorV1,
  type RuntimeFactRefV1,
  type RuntimeRestartFactsV1,
} from "../../../../specs/runtime-acceptance-facts/src/index.ts";
import {
  evaluateLegacyShapedAuthorityZero,
  evaluateSourceRepositoryProductionClosureZero,
  evaluateRuntimeRestartPredicate,
  LEGACY_SHAPED_AUTHORITY_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC,
  RUNTIME_RESTART_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  RUNTIME_RESTART_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  RUNTIME_RESTART_PREDICATE_SPEC,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC,
  type RuntimeAcceptanceReasonCode,
} from "../../../runtime-acceptance-facts/src/runtime.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";
import type { GateReasonCode, GateVerdict } from "../predicate-contract.ts";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../../specs/qualification/src/index.ts";

const RUNTIME_RESTART_ADAPTER_VERSION = "runtime-restart-gate-core-adapter-v1";
const SOURCE_CLOSURE_ADAPTER_VERSION = "source-repository-production-closure-zero-gate-core-adapter-v3";
const LEGACY_SHAPED_ADAPTER_VERSION = "legacy-shaped-authority-zero-gate-core-adapter-v3";

interface JoinedRuntimeAcceptanceFactV1 {
  readonly locator: RuntimeAcceptanceFactLocatorV1;
  readonly rootRef: ReadOnlyArtifactRefV1;
  readonly bundle: RuntimeRestartFactsV1 | LegacyAuthorityClosureFactsV1;
}

interface RuntimeNestedCanonicalExpectationV1 {
  readonly mode: "canonical";
  readonly schema: {
    readonly id: string;
    readonly version: string;
    readonly schemaHash: Hash;
  };
  readonly decode: (value: unknown) => unknown;
  readonly payload: unknown;
}

interface RuntimeNestedRawExpectationV1 {
  readonly mode: "raw";
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly locatorId: Hash;
  readonly locator: unknown;
}

type RuntimeNestedFactExpectationV1 = RuntimeNestedCanonicalExpectationV1 | RuntimeNestedRawExpectationV1;

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function decodeBundleBytes(
  locator: RuntimeAcceptanceFactLocatorV1,
  bytes: Uint8Array,
): RuntimeRestartFactsV1 | LegacyAuthorityClosureFactsV1 {
  const decoded = decodeCanonicalJson(bytes);
  if (!sameBytes(encodeCanonicalBytes(decoded), bytes)) throw new TypeError("runtime acceptance bundle is not canonical bytes");
  if (locator.factKind === "restart") return decodeRuntimeRestartFacts(decoded as object);
  return decodeLegacyAuthorityClosureFacts(decoded as object);
}

function decodeUniqueRefs(refs: readonly ReadOnlyArtifactRefV1[]): Map<Hash, ReadOnlyArtifactRefV1> {
  const output = new Map<Hash, ReadOnlyArtifactRefV1>();
  for (const value of refs) {
    const decoded = decodeReadOnlyArtifactRef(value);
    if (output.has(decoded.artifactRefId)) throw new TypeError("duplicate normalized artifact ref");
    output.set(decoded.artifactRefId, decoded);
  }
  return output;
}

function decodeUniqueClaims(claims: readonly ArtifactResolutionClaimV1[]): Map<Hash, ArtifactResolutionClaimV1> {
  const output = new Map<Hash, ArtifactResolutionClaimV1>();
  const byArtifact = new Set<Hash>();
  for (const value of claims) {
    const decoded = decodeArtifactResolutionClaim(value);
    if (output.has(decoded.claimId) || byArtifact.has(decoded.artifactRefId)) throw new TypeError("duplicate normalized artifact claim");
    output.set(decoded.claimId, decoded);
    byArtifact.add(decoded.artifactRefId);
  }
  return output;
}

function decodeUniquePolicies(policies: readonly ResolverPolicyV1[]): Map<Hash, ResolverPolicyV1> {
  const output = new Map<Hash, ResolverPolicyV1>();
  for (const value of policies) {
    const decoded = decodeResolverPolicy(value);
    if (output.has(decoded.policyHash)) throw new TypeError("duplicate normalized resolver policy");
    output.set(decoded.policyHash, decoded);
  }
  return output;
}

function decodeUniqueLeases(leases: readonly RetentionLeaseReceiptV1[]): Map<Hash, RetentionLeaseReceiptV1> {
  const output = new Map<Hash, RetentionLeaseReceiptV1>();
  for (const value of leases) {
    const decoded = decodeRetentionLeaseReceipt(value);
    if (output.has(decoded.receiptId)) throw new TypeError("duplicate normalized retention lease");
    output.set(decoded.receiptId, decoded);
  }
  return output;
}

function bundleFactRefs(bundle: RuntimeRestartFactsV1 | LegacyAuthorityClosureFactsV1): readonly RuntimeFactRefV1[] {
  return bundle.factRefs;
}

function withoutFactRefId(value: { readonly factRefId: Hash }): Readonly<Record<string, unknown>> {
  const { factRefId: _factRefId, ...payload } = value;
  return Object.freeze(payload);
}

function registerNestedExpectation(
  output: Map<Hash, RuntimeNestedFactExpectationV1>,
  value: { readonly factRefId: Hash },
  manifest: {
    readonly id: string;
    readonly version: string;
    readonly schemaHash: Hash;
    readonly schema: { readonly decode: (input: unknown) => unknown };
  },
): void {
  const next = Object.freeze({
    mode: "canonical" as const,
    schema: Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash }),
    decode: (input: unknown): unknown => manifest.schema.decode(input),
    payload: withoutFactRefId(value),
  });
  const previous = output.get(value.factRefId);
  if (previous !== undefined) {
    if (previous.mode !== "canonical" || !sameJson(previous.schema, next.schema) || !sameJson(previous.payload, next.payload)) {
      throw new TypeError("runtime acceptance fact ref is reused for different semantics");
    }
    return;
  }
  output.set(value.factRefId, next);
}

function registerRawExpectation(
  output: Map<Hash, RuntimeNestedFactExpectationV1>,
  artifact: LegacyAuthorityClosureFactsV1["denominator"]["artifacts"][number],
): void {
  if (output.has(artifact.factRefId)) throw new TypeError("runtime acceptance fact ref is reused for raw and semantic facts");
  output.set(artifact.factRefId, Object.freeze({
    mode: "raw",
    contentSha256: artifact.contentSha256,
    byteLength: artifact.byteLength,
    locatorId: artifact.locatorId,
    locator: artifact.locator,
  }));
}

function expectedNestedFacts(
  bundle: RuntimeRestartFactsV1 | LegacyAuthorityClosureFactsV1,
): ReadonlyMap<Hash, RuntimeNestedFactExpectationV1> {
  const output = new Map<Hash, RuntimeNestedFactExpectationV1>();
  if (bundle.kind === "aloha.legacy-authority-closure-facts") {
    for (const artifact of bundle.denominator.artifacts) registerRawExpectation(output, artifact);
    for (const fact of bundle.denominator.closures) {
      registerNestedExpectation(output, fact, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload);
    }
    return output;
  }
  registerNestedExpectation(output, bundle.before, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.processAnchorFactPayload);
  registerNestedExpectation(output, bundle.after, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.processAnchorFactPayload);
  registerNestedExpectation(output, bundle.graphReuse, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.graphReuseFactPayload);
  registerNestedExpectation(output, bundle.difference, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartDifferenceFactPayload);
  registerNestedExpectation(output, bundle.singleTargetProbe, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.singleTargetProbeFactPayload);
  registerNestedExpectation(output, bundle.sigtermRecovery, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.sigtermRecoveryFactPayload);
  const outcomePartitions = [
    bundle.difference.previousCandidates,
    bundle.difference.currentCandidates,
    bundle.singleTargetProbe.beforeOutcomes,
    bundle.singleTargetProbe.afterOutcomes,
    bundle.sigtermRecovery.flushedOutcomes,
    bundle.sigtermRecovery.afterRestartOutcomes,
  ];
  for (const partition of outcomePartitions) {
    for (const item of partition.items) {
      registerNestedExpectation(output, item, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateOutcomeFactPayload);
    }
  }
  const deltaPartitions = [
    bundle.difference.memoReused,
    bundle.difference.newCandidates,
    bundle.difference.invalidatedDependencyClosure,
    bundle.difference.retryable,
    bundle.difference.rejectionNotReused,
    bundle.difference.unchangedOldInstanceAttestations,
  ];
  for (const partition of deltaPartitions) {
    for (const item of partition.items) {
      registerNestedExpectation(output, item, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateDeltaFactPayload);
    }
  }
  return output;
}

const RESTART_BUNDLE_SCHEMA_REF = Object.freeze({
  id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.id,
  version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.version,
  schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.schemaHash,
});

const LEGACY_CLOSURE_BUNDLE_SCHEMA_REF = Object.freeze({
  id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.id,
  version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.version,
  schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.schemaHash,
});

/**
 * Resolve the sole predicate locator through GateCore's normalized artifact
 * evidence. Inline bundles are deliberately never accepted. Every nested
 * RuntimeFactRef is joined to its own artifact ref, claim, policy, lease and
 * qualified observation; all joins are exact and orphan-free.
 */
function joinRuntimeAcceptanceFact(
  runtime: PredicateRuntimeFactsV1,
): JoinedRuntimeAcceptanceFactV1 {
  if (runtime.facts.length !== 1) throw new TypeError("runtime acceptance predicate requires exactly one fact locator");
  const locator = decodeRuntimeAcceptanceFactLocator(runtime.facts[0] as object);
  const refs = decodeUniqueRefs(runtime.refs);
  const claims = decodeUniqueClaims(runtime.claims);
  const policies = decodeUniquePolicies(runtime.policies);
  const leases = decodeUniqueLeases(runtime.leases);
  const rootRef = refs.get(locator.artifactRefId);
  if (rootRef === undefined || rootRef.contentSha256 !== locator.contentSha256) throw new TypeError("runtime acceptance top-level artifact ref mismatch");
  const expectedRootSchema = locator.factKind === "restart" ? RESTART_BUNDLE_SCHEMA_REF : LEGACY_CLOSURE_BUNDLE_SCHEMA_REF;
  if (rootRef.mediaType !== "application/json" || !sameJson(rootRef.schema, expectedRootSchema)) throw new TypeError("runtime acceptance top-level schema mismatch");
  const rootClaim = [...claims.values()].find((claim) => claim.artifactRefId === rootRef.artifactRefId);
  if (rootClaim === undefined || rootClaim.outcome !== "content-observed" || rootClaim.observedMirror === null) throw new TypeError("runtime acceptance top-level content claim missing");
  const rootPolicy = policies.get(rootRef.resolverPolicyHash);
  if (rootPolicy === undefined || rootClaim.resolverPolicyHash !== rootPolicy.policyHash || rootClaim.resolverPolicyHash !== rootRef.resolverPolicyHash) throw new TypeError("runtime acceptance top-level policy mismatch");
  const rootLease = leases.get(rootRef.retentionLeaseReceiptId);
  const rootMirror = rootClaim.observedMirror;
  if (rootLease === undefined || rootLease.storeIdentityHash !== rootMirror.storeIdentityHash || rootLease.objectKey !== rootMirror.objectKey || rootLease.contentSha256 !== rootMirror.contentSha256 || rootMirror.storeIdentityHash !== rootRef.immutableMirrorLocator.storeIdentityHash || rootMirror.objectKey !== rootRef.immutableMirrorLocator.objectKey || rootMirror.contentSha256 !== rootRef.contentSha256 || rootMirror.byteLength !== rootRef.byteLength || rootMirror.mediaType !== rootRef.mediaType || !sameJson(rootMirror.schema, rootRef.schema)) throw new TypeError("runtime acceptance top-level mirror/ref mismatch");
  const rootBytes = decodeArtifactBytes(rootMirror.bytes);
  if (sha256Hex(rootBytes) !== rootRef.contentSha256 || String(rootBytes.byteLength) !== rootRef.byteLength || !sameBytes(encodeCanonicalBytes(decodeCanonicalJson(rootBytes)), rootBytes)) throw new TypeError("runtime acceptance top-level canonical mirror mismatch");
  const bundle = decodeBundleBytes(locator, rootBytes);
  const nested = bundleFactRefs(bundle);
  const nestedExpectations = expectedNestedFacts(bundle);
  if (nestedExpectations.size !== nested.length) throw new TypeError("runtime acceptance nested semantic denominator mismatch");
  const expectedRefs = new Set<Hash>([rootRef.artifactRefId]);
  const nestedByArtifact = new Map<Hash, RuntimeFactRefV1>();
  const nestedByFactId = new Map<Hash, RuntimeFactRefV1>();
  for (const factRef of nested) {
    if (nestedByArtifact.has(factRef.artifactRefId) || expectedRefs.has(factRef.artifactRefId)) throw new TypeError("duplicate runtime acceptance nested artifact ref");
    if (nestedByFactId.has(factRef.factId)) throw new TypeError("duplicate runtime acceptance nested fact id");
    nestedByArtifact.set(factRef.artifactRefId, factRef);
    nestedByFactId.set(factRef.factId, factRef);
    expectedRefs.add(factRef.artifactRefId);
    const expectation = nestedExpectations.get(factRef.factId);
    if (expectation === undefined || (expectation.mode === "canonical" && !sameJson(factRef.schema, expectation.schema))) throw new TypeError("runtime acceptance nested semantic schema mismatch");
    const ref = refs.get(factRef.artifactRefId);
    if (ref === undefined || (expectation.mode === "canonical" && ref.mediaType !== "application/json") || ref.contentSha256 !== factRef.contentSha256 || ref.byteLength !== factRef.byteLength || ref.locatorId !== factRef.locatorId || !sameJson(ref.locator, factRef.locator) || ref.schema === null || !sameJson(ref.schema, factRef.schema) || hashReadOnlyArtifactLocator(ref.locator) !== factRef.locatorId) throw new TypeError("runtime acceptance nested fact ref mismatch");
    if (expectation.mode === "raw" && (expectation.contentSha256 !== factRef.contentSha256 || expectation.byteLength !== factRef.byteLength || expectation.locatorId !== factRef.locatorId || !sameJson(expectation.locator, factRef.locator))) throw new TypeError("runtime acceptance raw artifact binding mismatch");
    const claim = [...claims.values()].find((candidate) => candidate.artifactRefId === ref.artifactRefId);
    if (claim === undefined || claim.outcome !== "content-observed" || claim.observedMirror === null || claim.resolverPolicyHash !== ref.resolverPolicyHash) throw new TypeError("runtime acceptance nested claim mismatch");
    const policy = policies.get(ref.resolverPolicyHash);
    const lease = leases.get(ref.retentionLeaseReceiptId);
    const mirror = claim.observedMirror;
    if (policy === undefined || lease === undefined || mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash || mirror.objectKey !== ref.immutableMirrorLocator.objectKey || mirror.contentSha256 !== ref.contentSha256 || mirror.byteLength !== ref.byteLength || mirror.mediaType !== ref.mediaType || !sameJson(mirror.schema, ref.schema) || lease.storeIdentityHash !== mirror.storeIdentityHash || lease.objectKey !== mirror.objectKey || lease.contentSha256 !== mirror.contentSha256) throw new TypeError("runtime acceptance nested mirror/policy/lease mismatch");
    const nestedBytes = decodeArtifactBytes(mirror.bytes);
    if (sha256Hex(nestedBytes) !== ref.contentSha256 || String(nestedBytes.byteLength) !== ref.byteLength) throw new TypeError("runtime acceptance nested bytes mismatch");
    if (expectation.mode === "canonical") {
      const decodedNested = expectation.decode(decodeCanonicalJson(nestedBytes));
      if (!sameBytes(encodeCanonicalBytes(decodedNested), nestedBytes) || !sameJson(decodedNested, expectation.payload)) throw new TypeError("runtime acceptance nested semantic payload mismatch");
    }
  }
  if (refs.size !== expectedRefs.size || [...refs.keys()].some((refId) => !expectedRefs.has(refId))) throw new TypeError("orphan normalized runtime acceptance ref");
  const expectedPolicyIds = new Set([...refs.values()].map((ref) => ref.resolverPolicyHash));
  const expectedLeaseIds = new Set([...refs.values()].map((ref) => ref.retentionLeaseReceiptId));
  if (claims.size !== expectedRefs.size || [...claims.values()].some((claim) => !expectedRefs.has(claim.artifactRefId))) throw new TypeError("orphan normalized runtime acceptance claim");
  if (policies.size !== expectedPolicyIds.size || [...policies.keys()].some((policyHash) => !expectedPolicyIds.has(policyHash))) throw new TypeError("orphan normalized runtime acceptance policy");
  if (leases.size !== expectedLeaseIds.size || [...leases.keys()].some((leaseId) => !expectedLeaseIds.has(leaseId))) throw new TypeError("orphan normalized runtime acceptance lease");
  const expectedClaimByArtifact = new Map<Hash, Hash>();
  for (const claim of claims.values()) expectedClaimByArtifact.set(claim.artifactRefId, claim.claimId);
  const observedPairs = new Map<string, number>();
  const observationIds = new Set<string>();
  for (const observation of runtime.observations) {
    if (observationIds.has(observation.observationId)) throw new TypeError("duplicate qualified runtime acceptance observation");
    observationIds.add(observation.observationId);
    const observedRefs = observation.rawArtifactRefs.map((value) => decodeReadOnlyArtifactRef(value));
    if (observedRefs.length === 0 || observation.observedClaimIds.length === 0) throw new TypeError("empty qualified runtime acceptance observation");
    const observedRefIds = new Set<Hash>();
    const observedClaimIds = new Set<Hash>();
    for (const observedRef of observedRefs) {
      if (observedRefIds.has(observedRef.artifactRefId)) throw new TypeError("duplicate qualified runtime acceptance ref");
      observedRefIds.add(observedRef.artifactRefId);
      const expectedRef = refs.get(observedRef.artifactRefId);
      if (expectedRef === undefined || !sameJson(expectedRef, observedRef)) throw new TypeError("orphan or spliced qualified runtime acceptance ref");
      const claimId = expectedClaimByArtifact.get(observedRef.artifactRefId);
      if (claimId === undefined || !observation.observedClaimIds.includes(claimId)) throw new TypeError("qualified runtime acceptance observation does not bind claim");
      const pair = `${observedRef.artifactRefId}:${claimId}`;
      observedPairs.set(pair, (observedPairs.get(pair) ?? 0) + 1);
    }
    for (const claimId of observation.observedClaimIds) {
      if (observedClaimIds.has(claimId as Hash)) throw new TypeError("duplicate qualified runtime acceptance claim");
      observedClaimIds.add(claimId as Hash);
      const claim = claims.get(claimId as Hash);
      if (claim === undefined || !observedRefs.some((ref) => ref.artifactRefId === claim.artifactRefId)) throw new TypeError("orphan qualified runtime acceptance claim");
    }
  }
  for (const [artifactRefId, claimId] of expectedClaimByArtifact) if (observedPairs.get(`${artifactRefId}:${claimId}`) !== 1) throw new TypeError("missing or duplicate qualified runtime acceptance observation");
  return Object.freeze({ locator, rootRef, bundle });
}

function mapReason(code: RuntimeAcceptanceReasonCode): GateReasonCode {
  switch (code) {
    case "malformed-fact": return "schema-invalid";
    case "content-addressed-fact-missing": return "artifact-claim-missing";
    case "process-anchor-violation": return "process-anchor-mismatch";
    case "aggregate-mismatch": return "predicate-composition-mismatch";
    default: return "predicate-failed";
  }
}

function addReasons(
  reasons: readonly { readonly code: RuntimeAcceptanceReasonCode; readonly path: string }[],
  issues: PredicateIssueSinkV1,
): void {
  for (const reason of reasons) issues.add(mapReason(reason.code), reason.path);
}

function evaluateRestart(runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1): GateVerdict {
  try {
    const joined = joinRuntimeAcceptanceFact(runtime);
    if (joined.locator.factKind !== "restart" || joined.bundle.kind !== "aloha.runtime-restart-facts") throw new TypeError("runtime restart predicate received the wrong fact kind");
    const result = evaluateRuntimeRestartPredicate(joined.bundle);
    addReasons(result.reasons, issues);
    return result.verdict;
  } catch {
    issues.add("predicate-observation-mismatch", "$.predicateFacts");
    return "invalid";
  }
}

const CLOSURE_QUALIFICATION_ORDER = Object.freeze([
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC.predicateId,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC.predicateId,
] as const);

function assertCurrentClosureQualificationBindings(
  runtime: PredicateRuntimeFactsV1,
  bundle: LegacyAuthorityClosureFactsV1,
): void {
  const bindings = runtime.trustedReleaseQualificationBindings;
  if (bindings === undefined) throw new TypeError("trusted release qualification bindings are missing");
  const selected = CLOSURE_QUALIFICATION_ORDER.map(predicateId => {
    const matches = bindings.filter(binding => binding.predicateId === predicateId);
    if (matches.length !== 1) throw new TypeError(`release qualification binding is not exact for ${predicateId}`);
    return matches[0]!;
  });
  const expectedSpecDigests = Object.freeze([
    SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC.specDigest,
    LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC.specDigest,
  ] as const);
  if (!sameJson(bundle.receipt.predicateSpecDigests, expectedSpecDigests)
    || !sameJson(bundle.receipt.predicateSpecDigests, selected.map(binding => binding.predicateSpecDigest))
    || !sameJson(bundle.receipt.qualificationCertificateIds, selected.map(binding => binding.verifierQualificationId))) {
    throw new TypeError("closure receipt does not bind the current ordered qualification pair");
  }
}

function evaluateSourceClosure(runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1): GateVerdict {
  try {
    const joined = joinRuntimeAcceptanceFact(runtime);
    if (joined.locator.factKind !== "legacy-closure" || joined.bundle.kind !== "aloha.legacy-authority-closure-facts") throw new TypeError("source closure predicate received the wrong fact kind");
    assertCurrentClosureQualificationBindings(runtime, joined.bundle);
    const result = evaluateSourceRepositoryProductionClosureZero(joined.bundle);
    addReasons(result.reasons, issues);
    return result.verdict;
  } catch {
    issues.add("predicate-observation-mismatch", "$.predicateFacts");
    return "invalid";
  }
}

function evaluateLegacyShaped(runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1): GateVerdict {
  try {
    const joined = joinRuntimeAcceptanceFact(runtime);
    if (joined.locator.factKind !== "legacy-closure" || joined.bundle.kind !== "aloha.legacy-authority-closure-facts") throw new TypeError("legacy-shaped predicate received the wrong fact kind");
    assertCurrentClosureQualificationBindings(runtime, joined.bundle);
    const result = evaluateLegacyShapedAuthorityZero(joined.bundle);
    addReasons(result.reasons, issues);
    return result.verdict;
  } catch {
    issues.add("predicate-observation-mismatch", "$.predicateFacts");
    return "invalid";
  }
}

export const RUNTIME_RESTART_PREDICATE_ADAPTER_VERSION = RUNTIME_RESTART_ADAPTER_VERSION;
export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_ADAPTER_VERSION = SOURCE_CLOSURE_ADAPTER_VERSION;
export const LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_ADAPTER_VERSION = LEGACY_SHAPED_ADAPTER_VERSION;

export const RUNTIME_RESTART_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: RUNTIME_RESTART_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: RUNTIME_RESTART_ADAPTER_VERSION,
  predicateSpec: RUNTIME_RESTART_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: RUNTIME_RESTART_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: RUNTIME_RESTART_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive: evaluateRestart,
});

export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: SOURCE_CLOSURE_ADAPTER_VERSION,
  predicateSpec: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive: evaluateSourceClosure,
});

export const LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: LEGACY_SHAPED_ADAPTER_VERSION,
  predicateSpec: LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: LEGACY_SHAPED_AUTHORITY_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive: evaluateLegacyShaped,
});
