import {
  decodeArtifactBytes,
  type ArtifactResolutionClaimV1,
} from "../../../../specs/artifact-resolution/src/index.ts";
import {
  encodeCanonicalJson,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeCandidateSet,
  decodeCandidateTerminalReceipt,
  decodeEligibleHeadRecord,
  decodeHeadOrphanReplacementLineage,
  decodeHeadTerminalReceipt,
  decodePerformanceEvent,
  decodePerformanceFactEnvelope,
  decodePerformanceMetricSample,
  decodePerformanceGenerationSegment,
  decodeProductionPerformanceProfile,
  decodePerformanceWindowCommitment,
  decodePerformanceWindowReceipt,
  encodeCandidateSet,
  encodeCandidateTerminalReceipt,
  encodeEligibleHeadRecord,
  encodeHeadOrphanReplacementLineage,
  encodeHeadTerminalReceipt,
  encodePerformanceEvent,
  encodePerformanceMetricSample,
  encodeProductionPerformanceProfile,
  encodePerformanceWindowCommitment,
  encodePerformanceWindowReceipt,
  PERFORMANCE_EVENT_SCHEMA_MANIFEST,
  PERFORMANCE_FACT_ENVELOPE_SCHEMA_MANIFEST,
  PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
  PERFORMANCE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  PERFORMANCE_PREDICATE_SPEC,
  PERFORMANCE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluatePerformancePredicate,
  type CandidateSetV1,
  type CandidateTerminalReceiptV1,
  type EligibleHeadRecordV1,
  type HeadOrphanReplacementLineageV1,
  type HeadTerminalReceiptV1,
  type PerformanceEventV1,
  type PerformanceFactEnvelopeV1,
  type PerformanceMetricSampleV1,
  type PerformanceGenerationSegmentV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceWindowReceiptV1,
  type ProductionPerformanceProfileV1,
  type PerformanceFactBundleV1,
  type PerformanceReasonCode,
} from "../../../performance-facts/src/runtime.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";
import type { GateReasonCode, GateVerdict } from "../predicate-contract.ts";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../../specs/qualification/src/index.ts";

const PERFORMANCE_ADAPTER_VERSION = "performance-gate-core-adapter-v2";

export const PERFORMANCE_PREDICATE_ADAPTER_VERSION = PERFORMANCE_ADAPTER_VERSION;

const profileSchemaRef = Object.freeze({
  id: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.id,
  version: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.version,
  schemaHash: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.schemaHash,
});
const eventSchemaRef = Object.freeze({
  id: PERFORMANCE_EVENT_SCHEMA_MANIFEST.id,
  version: PERFORMANCE_EVENT_SCHEMA_MANIFEST.version,
  schemaHash: PERFORMANCE_EVENT_SCHEMA_MANIFEST.schemaHash,
});

const PERFORMANCE_REASON_MAP: Readonly<Record<PerformanceReasonCode, GateReasonCode>> = Object.freeze({
  "malformed-fact": "schema-invalid",
  "qualified-observation-missing": "predicate-observation-missing",
  "qualified-observation-mismatch": "observation-mismatch",
  "profile-mismatch": "predicate-observation-mismatch",
  "window-commitment-mismatch": "predicate-observation-mismatch",
  "window-start-invalid": "predicate-observation-mismatch",
  "target-count-invalid": "predicate-observation-mismatch",
  "empty-denominator": "predicate-observation-mismatch",
  "ordinal-duplicate": "predicate-observation-mismatch",
  "ordinal-gap": "predicate-observation-mismatch",
  "canonical-chain-mismatch": "predicate-observation-mismatch",
  "head-anchor-mismatch": "predicate-observation-mismatch",
  "lineage-mismatch": "predicate-observation-mismatch",
  "terminal-duplicate": "predicate-observation-mismatch",
  "terminal-missing": "predicate-observation-mismatch",
  "terminal-anchor-mismatch": "predicate-observation-mismatch",
  "terminal-outcome-unhealthy": "predicate-failed",
  "candidate-set-mismatch": "predicate-observation-mismatch",
  "candidate-terminal-mismatch": "predicate-observation-mismatch",
  "candidate-sample-missing": "predicate-observation-mismatch",
  "candidate-sample-count-mismatch": "predicate-observation-mismatch",
  "timing-count-mismatch": "predicate-observation-mismatch",
  "metric-mismatch": "predicate-observation-mismatch",
  "generation-segment-mismatch": "predicate-observation-mismatch",
  "root-mismatch": "predicate-observation-mismatch",
  "excluded-head": "predicate-observation-mismatch",
  "queue-telemetry-invalid": "predicate-failed",
  "permit-conservation-invalid": "predicate-failed",
  "worker-restart-invalid": "predicate-failed",
  "required-six-step-missing": "predicate-failed",
  "required-six-step-cardinality": "predicate-observation-mismatch",
  "budget-exceeded": "predicate-failed",
  "percentile-invalid": "predicate-observation-mismatch",
  "caller-verdict-ignored": "predicate-observation-mismatch",
});

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

interface BindingAccumulator extends PredicateIssueSinkV1 {
  readonly invalid: boolean;
}

function createAccumulator(issues: PredicateIssueSinkV1): BindingAccumulator {
  let invalid = false;
  return {
    get invalid() { return invalid; },
    add(code, path) {
      invalid = true;
      issues.add(code, path);
    },
  };
}

function schemaKind(ref: PredicateRuntimeFactsV1["refs"][number]): "profile" | "event" | null {
  if (ref.schema !== null && sameJson(ref.schema, profileSchemaRef)) return "profile";
  if (ref.schema !== null && sameJson(ref.schema, eventSchemaRef)) return "event";
  return null;
}

function mapPredicateReasons(result: ReturnType<typeof evaluatePerformancePredicate>, issues: PredicateIssueSinkV1): void {
  for (const reason of result.reasons) issues.add(PERFORMANCE_REASON_MAP[reason.code], reason.path);
}

interface BoundFactV1 {
  readonly envelope: PerformanceFactEnvelopeV1;
  readonly ref: PredicateRuntimeFactsV1["refs"][number];
  readonly profile: ProductionPerformanceProfileV1 | null;
  readonly event: PerformanceEventV1 | null;
}

function decodeBoundFact(
  value: unknown,
  index: number,
  runtime: PredicateRuntimeFactsV1,
  refsById: ReadonlyMap<Hash, PredicateRuntimeFactsV1["refs"][number]>,
  claimsById: ReadonlyMap<Hash, ArtifactResolutionClaimV1>,
  policiesByHash: ReadonlyMap<Hash, PredicateRuntimeFactsV1["policies"][number]>,
  leasesById: ReadonlyMap<Hash, PredicateRuntimeFactsV1["leases"][number]>,
  accumulator: BindingAccumulator,
): BoundFactV1 | null {
  const path = `$.predicateFacts[${index}]`;
  let envelope: PerformanceFactEnvelopeV1;
  try {
    envelope = decodePerformanceFactEnvelope(value as object);
  } catch {
    accumulator.add("schema-invalid", path);
    return null;
  }
  const ref = refsById.get(envelope.artifactRefId);
  const claim = claimsById.get(envelope.claimId);
  if (ref === undefined) accumulator.add("artifact-ref-mismatch", `${path}.artifactRefId`);
  if (claim === undefined) accumulator.add("artifact-claim-missing", `${path}.claimId`);
  if (ref === undefined || claim === undefined) return null;
  const expectedKind = schemaKind(ref);
  if (expectedKind === null || expectedKind !== envelope.factType) accumulator.add("artifact-content-mismatch", `${path}.factType`);
  if (claim.claimId !== envelope.claimId || claim.artifactRefId !== envelope.artifactRefId) accumulator.add("artifact-claim-mismatch", `${path}.claimId`);
  if (claim.resolverPolicyHash !== ref.resolverPolicyHash) accumulator.add("resolver-policy-mismatch", `${path}.artifactRefId`);
  const policy = policiesByHash.get(ref.resolverPolicyHash);
  const lease = leasesById.get(ref.retentionLeaseReceiptId);
  if (policy === undefined) accumulator.add("resolver-policy-missing", `${path}.artifactRefId`);
  if (lease === undefined) accumulator.add("retention-lease-missing", `${path}.artifactRefId`);
  if (policy === undefined || lease === undefined) return null;
  if (lease.objectKey !== ref.immutableMirrorLocator.objectKey || lease.contentSha256 !== ref.contentSha256) accumulator.add("retention-lease-mismatch", `${path}.artifactRefId`);
  const mirror = claim.observedMirror;
  if (claim.outcome !== "content-observed" || mirror === null) {
    accumulator.add("artifact-claim-mismatch", `${path}.claimId`);
    return null;
  }
  const expectedSchema = envelope.factType === "profile" ? profileSchemaRef : eventSchemaRef;
  if (
    ref.mediaType !== "application/json" || mirror.mediaType !== "application/json" ||
    !sameJson(ref.schema, expectedSchema) || !sameJson(mirror.schema, expectedSchema) ||
    mirror.contentSha256 !== ref.contentSha256 || mirror.byteLength !== ref.byteLength ||
    envelope.contentSha256 !== ref.contentSha256 || envelope.byteLength !== ref.byteLength ||
    mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash ||
    mirror.objectKey !== ref.immutableMirrorLocator.objectKey
  ) {
    accumulator.add("artifact-content-mismatch", `${path}.artifactRefId`);
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeArtifactBytes(mirror.bytes, `${path}.claim.observedMirror.bytes`);
  } catch {
    accumulator.add("artifact-content-mismatch", `${path}.claim.observedMirror.bytes`);
    return null;
  }
  if (sha256Hex(bytes) !== ref.contentSha256 || String(bytes.byteLength) !== ref.byteLength || sha256Hex(bytes) !== envelope.contentSha256) {
    accumulator.add("artifact-content-mismatch", `${path}.contentSha256`);
    return null;
  }
  let profile: ProductionPerformanceProfileV1 | null = null;
  let event: PerformanceEventV1 | null = null;
  try {
    if (envelope.factType === "profile") {
      profile = decodeProductionPerformanceProfile(bytes);
      if (!sameBytes(bytes, encodeProductionPerformanceProfile(profile))) accumulator.add("canonical-bytes-mismatch", `${path}.claim.observedMirror.bytes`);
    } else {
      event = decodePerformanceEvent(bytes);
      if (envelope.sequence === null || event.sequence !== envelope.sequence) accumulator.add("artifact-content-mismatch", `${path}.sequence`);
      if (!sameBytes(bytes, encodePerformanceEvent(event))) accumulator.add("canonical-bytes-mismatch", `${path}.claim.observedMirror.bytes`);
    }
  } catch {
    accumulator.add("schema-invalid", `${path}.claim.observedMirror.bytes`);
    return null;
  }
  const observation = runtime.observations.find((candidate) => candidate.observationId === envelope.observationId);
  if (observation === undefined) {
    accumulator.add("predicate-observation-missing", `${path}.observationId`);
  } else {
    const observedRef = observation.rawArtifactRefs.find((candidate) => candidate.artifactRefId === ref.artifactRefId);
    if (observedRef === undefined || !sameJson(observedRef, ref)) accumulator.add("artifact-ref-mismatch", `${path}.observationId`);
    if (!observation.observedClaimIds.includes(claim.claimId)) accumulator.add("observation-mismatch", `${path}.observationId`);
  }
  return Object.freeze({ envelope, ref, profile, event });
}

function decodeEventPayload(event: PerformanceEventV1): {
  readonly commitment?: PerformanceWindowCommitmentV1;
  readonly head?: EligibleHeadRecordV1;
  readonly lineage?: HeadOrphanReplacementLineageV1;
  readonly candidateSet?: CandidateSetV1;
  readonly candidateTerminal?: CandidateTerminalReceiptV1;
  readonly metric?: PerformanceMetricSampleV1;
  readonly generationSegment?: PerformanceGenerationSegmentV1;
  readonly terminal?: HeadTerminalReceiptV1;
  readonly windowReceipt?: PerformanceWindowReceiptV1;
} {
  try {
    switch (event.eventType) {
      case "window-commitment": return { commitment: decodePerformanceWindowCommitment(event.payload) };
      case "eligible-head": return { head: decodeEligibleHeadRecord(event.payload) };
      case "orphan-replacement": return { lineage: decodeHeadOrphanReplacementLineage(event.payload) };
      case "candidate-set": return { candidateSet: decodeCandidateSet(event.payload) };
      case "candidate-terminal": return { candidateTerminal: decodeCandidateTerminalReceipt(event.payload) };
      case "metric-sample": return { metric: decodePerformanceMetricSample(event.payload) };
      case "head-terminal": return { terminal: decodeHeadTerminalReceipt(event.payload) };
      case "generation-segment": return { generationSegment: decodePerformanceGenerationSegment(event.payload) };
      case "window-receipt": return { windowReceipt: decodePerformanceWindowReceipt(event.payload) };
    }
  } catch {
    throw new TypeError(`performance event payload is not an exact typed fact: ${event.eventType}`);
  }
  throw new TypeError(`unknown performance event type: ${String(event.eventType)}`);
}

function byOrdinal<T extends { readonly ordinal: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => BigInt(left.ordinal) < BigInt(right.ordinal) ? -1 : BigInt(left.ordinal) > BigInt(right.ordinal) ? 1 : 0);
}

function assembleBundle(bound: readonly BoundFactV1[], accumulator: BindingAccumulator): PerformanceFactBundleV1 | null {
  const profiles = bound.filter((fact) => fact.profile !== null).map((fact) => fact.profile!);
  const events = bound.filter((fact) => fact.event !== null).map((fact) => fact.event!);
  if (profiles.length !== 1) accumulator.add("predicate-observation-mismatch", "$.predicateFacts.profile");
  if (events.length === 0) accumulator.add("predicate-observation-missing", "$.predicateFacts.events");
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index.toString()) accumulator.add("predicate-observation-mismatch", `$.predicateFacts[${index}].sequence`);
  }
  const payloads = events.map((event) => {
    try { return decodeEventPayload(event); } catch { accumulator.add("schema-invalid", `$.predicateFacts.event.${event.sequence}`); return {}; }
  });
  const commitments = payloads.flatMap((payload) => payload.commitment === undefined ? [] : [payload.commitment]);
  const receipts = payloads.flatMap((payload) => payload.windowReceipt === undefined ? [] : [payload.windowReceipt]);
  if (commitments.length !== 1) accumulator.add("predicate-observation-mismatch", "$.predicateFacts.commitment");
  if (receipts.length !== 1) accumulator.add("predicate-observation-mismatch", "$.predicateFacts.windowReceipt");
  const commitment = commitments[0];
  const windowReceipt = receipts[0];
  if (commitment === undefined || windowReceipt === undefined || profiles.length !== 1) return null;
  for (const event of events) if (event.windowId !== commitment.windowId) accumulator.add("predicate-observation-mismatch", `$.predicateFacts.event.${event.sequence}.windowId`);
  const lineages = byOrdinal(payloads.flatMap((payload) => payload.lineage === undefined ? [] : [payload.lineage]));
  const orphanIds = new Set(lineages.map((lineage) => lineage.orphanHeadRecordId));
  const allHeads = payloads.flatMap((payload) => payload.head === undefined ? [] : [payload.head]);
  const headsByOrdinal = new Map<string, EligibleHeadRecordV1[]>();
  for (const head of allHeads) headsByOrdinal.set(head.ordinal, [...(headsByOrdinal.get(head.ordinal) ?? []), head]);
  for (const [ordinal, candidates] of headsByOrdinal.entries()) {
    if (candidates.length < 2) continue;
    const active = candidates.filter((head) => !orphanIds.has(head.headRecordId));
    const lineageForOrdinal = lineages.filter((lineage) => lineage.ordinal === ordinal);
    if (active.length !== 1 || candidates.some((head) => head.headRecordId !== active[0]!.headRecordId && !orphanIds.has(head.headRecordId)) || lineageForOrdinal.length !== candidates.length - 1 || lineageForOrdinal.some((lineage) => !candidates.some((head) => head.headRecordId === lineage.orphanHeadRecordId || head.headRecordId === lineage.replacementHeadRecordId))) {
      accumulator.add("predicate-observation-mismatch", `$.predicateFacts.heads.${ordinal}`);
    }
  }
  const activeHeadsByOrdinal = new Map<string, EligibleHeadRecordV1>();
  for (const head of allHeads) if (!orphanIds.has(head.headRecordId)) activeHeadsByOrdinal.set(head.ordinal, head);
  const heads = byOrdinal([...activeHeadsByOrdinal.values()]);
  const activeRoots = new Map(heads.map((head) => [head.ordinal, head.candidateSetRoot] as const));
  const candidateSets = byOrdinal(payloads.flatMap((payload) => payload.candidateSet !== undefined && activeRoots.get(payload.candidateSet.ordinal) === payload.candidateSet.candidateSetRoot ? [payload.candidateSet] : []));
  const metrics = byOrdinal(payloads.flatMap((payload) => payload.metric === undefined ? [] : [payload.metric]));
  const terminals = byOrdinal(payloads.flatMap((payload) => payload.terminal === undefined ? [] : [payload.terminal]));
  const generationSegments = [...payloads.flatMap((payload) => payload.generationSegment === undefined ? [] : [payload.generationSegment])]
    .sort((left, right) => BigInt(left.segmentOrdinal) < BigInt(right.segmentOrdinal) ? -1 : 1);
  const candidateTerminals = [...payloads.flatMap((payload) => payload.candidateTerminal === undefined ? [] : [payload.candidateTerminal])]
    .sort((left, right) => BigInt(left.ordinal) < BigInt(right.ordinal) || (left.ordinal === right.ordinal && left.receiptId < right.receiptId) ? -1 : 1);
  return Object.freeze({ profile: profiles[0]!, commitment, heads, lineages, candidateSets, candidateTerminals, metrics, terminals, generationSegments, windowReceipt });
}

function evaluateLive(runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1): GateVerdict {
  const accumulator = createAccumulator(issues);
  const refsById = new Map<Hash, PredicateRuntimeFactsV1["refs"][number]>();
  for (const [index, ref] of runtime.refs.entries()) {
    if (refsById.has(ref.artifactRefId)) accumulator.add("artifact-ref-mismatch", `$.artifactRefs[${index}]`);
    refsById.set(ref.artifactRefId, ref);
  }
  const claimsById = new Map<Hash, ArtifactResolutionClaimV1>();
  const claimsByRef = new Map<Hash, ArtifactResolutionClaimV1>();
  for (const [index, claim] of runtime.claims.entries()) {
    if (claimsById.has(claim.claimId) || claimsByRef.has(claim.artifactRefId)) accumulator.add("artifact-claim-mismatch", `$.artifactClaims[${index}]`);
    if (!refsById.has(claim.artifactRefId)) accumulator.add("artifact-claim-mismatch", `$.artifactClaims[${index}].artifactRefId`);
    claimsById.set(claim.claimId, claim);
    claimsByRef.set(claim.artifactRefId, claim);
  }
  const policiesByHash = new Map(runtime.policies.map((policy) => [policy.policyHash, policy] as const));
  const leasesById = new Map(runtime.leases.map((lease) => [lease.receiptId, lease] as const));
  for (const [index, ref] of runtime.refs.entries()) {
    if (!claimsByRef.has(ref.artifactRefId)) accumulator.add("artifact-claim-missing", `$.artifactRefs[${index}]`);
    if (!policiesByHash.has(ref.resolverPolicyHash)) accumulator.add("resolver-policy-missing", `$.artifactRefs[${index}]`);
    if (!leasesById.has(ref.retentionLeaseReceiptId)) accumulator.add("retention-lease-missing", `$.artifactRefs[${index}]`);
  }
  if (new Set(runtime.policies.map((policy) => policy.policyHash)).size !== runtime.policies.length) accumulator.add("resolver-policy-mismatch", "$.resolverPolicies");
  if (new Set(runtime.leases.map((lease) => lease.receiptId)).size !== runtime.leases.length) accumulator.add("retention-lease-mismatch", "$.retentionLeases");
  for (const policy of runtime.policies) if (!runtime.refs.some((ref) => ref.resolverPolicyHash === policy.policyHash)) accumulator.add("resolver-policy-mismatch", "$.resolverPolicies");
  for (const lease of runtime.leases) if (!runtime.refs.some((ref) => ref.retentionLeaseReceiptId === lease.receiptId)) accumulator.add("retention-lease-mismatch", "$.retentionLeases");
  const performanceRefs = runtime.refs.filter((ref) => schemaKind(ref) !== null);
  if (performanceRefs.length === 0) accumulator.add("predicate-observation-missing", "$.artifactRefs");
  if (runtime.facts.length !== performanceRefs.length) accumulator.add("predicate-observation-mismatch", "$.predicateFacts");
  const bound: BoundFactV1[] = [];
  const envelopeIds = new Set<Hash>();
  const envelopeRefIds = new Set<Hash>();
  const envelopeClaimIds = new Set<Hash>();
  for (const [index, value] of runtime.facts.entries()) {
    const fact = decodeBoundFact(value, index, runtime, refsById, claimsById, policiesByHash, leasesById, accumulator);
    if (fact === null) continue;
    if (envelopeIds.has(fact.envelope.envelopeId)) accumulator.add("predicate-observation-mismatch", `$.predicateFacts[${index}].envelopeId`);
    if (envelopeRefIds.has(fact.envelope.artifactRefId)) accumulator.add("artifact-ref-mismatch", `$.predicateFacts[${index}].artifactRefId`);
    if (envelopeClaimIds.has(fact.envelope.claimId)) accumulator.add("artifact-claim-mismatch", `$.predicateFacts[${index}].claimId`);
    envelopeIds.add(fact.envelope.envelopeId);
    envelopeRefIds.add(fact.envelope.artifactRefId);
    envelopeClaimIds.add(fact.envelope.claimId);
    bound.push(fact);
  }
  const performanceRefIds = new Set(performanceRefs.map((ref) => ref.artifactRefId));
  if (performanceRefIds.size !== envelopeRefIds.size || [...performanceRefIds].some((id) => !envelopeRefIds.has(id))) accumulator.add("artifact-ref-mismatch", "$.predicateFacts");
  const performanceClaimIds = new Set(performanceRefs.map((ref) => claimsByRef.get(ref.artifactRefId)?.claimId).filter((id): id is Hash => id !== undefined));
  if (performanceClaimIds.size !== envelopeClaimIds.size || [...performanceClaimIds].some((id) => !envelopeClaimIds.has(id))) accumulator.add("artifact-claim-mismatch", "$.predicateFacts");
  const observationCounts = new Map<Hash, number>();
  for (const observation of runtime.observations) {
    const seen = new Set<Hash>();
    for (const ref of observation.rawArtifactRefs) {
      if (schemaKind(ref) === null) continue;
      if (seen.has(ref.artifactRefId)) accumulator.add("observation-mismatch", `$.observations.${observation.observationId}.rawArtifactRefs`);
      seen.add(ref.artifactRefId);
      const normalized = refsById.get(ref.artifactRefId);
      if (normalized === undefined || !sameJson(normalized, ref)) accumulator.add("artifact-ref-mismatch", `$.observations.${observation.observationId}.rawArtifactRefs`);
      observationCounts.set(ref.artifactRefId, (observationCounts.get(ref.artifactRefId) ?? 0) + 1);
      const claim = claimsByRef.get(ref.artifactRefId);
      if (claim === undefined || !observation.observedClaimIds.includes(claim.claimId)) accumulator.add("observation-mismatch", `$.observations.${observation.observationId}`);
    }
  }
  for (const ref of performanceRefs) if (observationCounts.get(ref.artifactRefId) !== 1) accumulator.add("predicate-observation-missing", `$.artifactRefs.${ref.artifactRefId}`);
  if (bound.length !== performanceRefs.length) return "invalid";
  for (let index = 0; index < bound.length; index += 1) {
    const envelope = bound[index]!.envelope;
    if (index === 0 && envelope.factType !== "profile") accumulator.add("predicate-observation-mismatch", "$.predicateFacts[0].factType");
    if (index > 0 && (envelope.factType !== "event" || envelope.sequence !== (index - 1).toString())) accumulator.add("predicate-observation-mismatch", `$.predicateFacts[${index}].sequence`);
  }
  const bundle = assembleBundle(bound, accumulator);
  if (bundle === null || accumulator.invalid) return "invalid";
  const result = evaluatePerformancePredicate(bundle);
  mapPredicateReasons(result, issues);
  return result.verdict;
}

export const PERFORMANCE_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: PERFORMANCE_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: PERFORMANCE_ADAPTER_VERSION,
  predicateSpec: PERFORMANCE_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: PERFORMANCE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: PERFORMANCE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive,
});
