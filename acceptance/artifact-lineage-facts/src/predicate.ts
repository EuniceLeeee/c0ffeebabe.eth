import { encodeCanonicalJson, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { decodeArtifactBytes, type ObservedImmutableMirrorV1 } from "../../../specs/artifact-resolution/src/index.ts";
import {
  decodeArtifactLineageClaim,
  decodeArtifactLineageObservation,
  decodeArtifactLineageRawFacts,
  type ArtifactLineageClaimV1,
  type ArtifactLineageCodecInput,
  type ArtifactLineageObservationV1,
  type ArtifactLineagePredicateResult,
  type ArtifactLineageRawFactsInputV1,
  type ArtifactLineageReasonCode,
} from "./schema.ts";

function exactJsonEqual(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function invalidResult(
  reason: ArtifactLineageReasonCode,
  claimId: Hash | null = null,
  observationId: Hash | null = null,
): ArtifactLineagePredicateResult {
  return Object.freeze({ verdict: "invalid", reasons: Object.freeze([reason]), claimId, observationId });
}

function failResult(
  reason: ArtifactLineageReasonCode,
  claimId: Hash,
  observationId: Hash,
): ArtifactLineagePredicateResult {
  return Object.freeze({ verdict: "fail", reasons: Object.freeze([reason]), claimId, observationId });
}

function hexByteLength(value: string): number | null {
  return /^0x(?:[0-9a-f]{2})*$/.test(value) ? (value.length - 2) / 2 : null;
}

function hashBytes(bytes: Uint8Array): Hash {
  return sha256Hex(bytes);
}

function decodeRawFacts(value: unknown): ArtifactLineageRawFactsInputV1 {
  return decodeArtifactLineageRawFacts(value as ArtifactLineageCodecInput);
}

/** Predicate implementation closure. Producer outcome/witness fields are never read. */
export function evaluateArtifactLineagePredicate(
  rawClaim: unknown,
  rawObservation: unknown,
  rawFacts: unknown,
): ArtifactLineagePredicateResult {
  let claim: ArtifactLineageClaimV1;
  try {
    claim = decodeArtifactLineageClaim(rawClaim as ArtifactLineageCodecInput);
  } catch {
    return invalidResult("claim-decode-failed");
  }
  let observation: ArtifactLineageObservationV1;
  try {
    observation = decodeArtifactLineageObservation(rawObservation as ArtifactLineageCodecInput);
  } catch {
    return invalidResult("observation-decode-failed", claim.claimId);
  }
  let raw: ArtifactLineageRawFactsInputV1;
  try {
    raw = decodeRawFacts(rawFacts);
  } catch {
    return invalidResult("raw-shape-invalid", claim.claimId, observation.observationId);
  }

  if (claim.resolutionClaim.outcome !== "content-observed") {
    return invalidResult("resolution-outcome-mismatch", claim.claimId, observation.observationId);
  }
  const claimedMirror = claim.resolutionClaim.observedMirror as ObservedImmutableMirrorV1 | null;
  if (claimedMirror === null) {
    return invalidResult("resolution-outcome-mismatch", claim.claimId, observation.observationId);
  }
  if (raw.rawBytes === null) {
    return invalidResult("raw-bytes-missing", claim.claimId, observation.observationId);
  }
  if (
    observation.rawBytes === null ||
    observation.contentSha256 === null ||
    observation.byteLength === null ||
    observation.mediaType === null
  ) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }

  const rawLength = hexByteLength(raw.rawBytes);
  const observedLength = hexByteLength(observation.rawBytes);
  if (rawLength === null || observedLength === null) {
    return invalidResult("raw-shape-invalid", claim.claimId, observation.observationId);
  }
  let maxByteLength: bigint;
  try {
    maxByteLength = BigInt(claim.resolverPolicy.maxByteLength);
  } catch {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }
  // Check wire lengths before allocating or decoding any hex bytes.
  if (
    BigInt(claim.artifactRef.byteLength) > maxByteLength ||
    BigInt(rawLength) > maxByteLength ||
    BigInt(observedLength) > maxByteLength
  ) {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }

  let observedBytes: Uint8Array;
  let rawBytes: Uint8Array;
  try {
    observedBytes = decodeArtifactBytes(observation.rawBytes);
    rawBytes = decodeArtifactBytes(raw.rawBytes);
  } catch {
    return invalidResult("raw-shape-invalid", claim.claimId, observation.observationId);
  }
  const rawContentSha256 = hashBytes(rawBytes);
  const observedContentSha256 = hashBytes(observedBytes);
  if (
    raw.rawBytes !== observation.rawBytes ||
    claimedMirror.bytes !== observation.rawBytes ||
    observedContentSha256 !== observation.contentSha256 ||
    observedContentSha256 !== rawContentSha256 ||
    String(observedBytes.byteLength) !== observation.byteLength ||
    String(rawBytes.byteLength) !== observation.byteLength
  ) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claim.artifactRef.byteLength !== claimedMirror.byteLength ||
    claim.artifactRef.byteLength !== observation.byteLength ||
    claim.artifactRef.byteLength !== String(rawBytes.byteLength)
  ) {
    return invalidResult("artifact-ref-length-mismatch", claim.claimId, observation.observationId);
  }
  if (observation.artifactRefId !== claim.artifactRef.artifactRefId) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claim.resolverPolicy.allowedLocatorKind !== "content-object" ||
    claim.resolverPolicy.digestAlgorithm !== "sha256" ||
    claim.resolverPolicy.requireExactLengthMediaAndSchema !== true ||
    claim.resolverPolicy.failureOutcome !== "invalid"
  ) {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claimedMirror.storeIdentityHash !== claim.artifactRef.immutableMirrorLocator.storeIdentityHash ||
    claimedMirror.objectKey !== claim.artifactRef.immutableMirrorLocator.objectKey
  ) {
    return invalidResult("object-key-mismatch", claim.claimId, observation.observationId);
  }
  if (claimedMirror.contentSha256 !== observation.contentSha256) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claimedMirror.mediaType !== claim.artifactRef.mediaType ||
    claimedMirror.mediaType !== observation.mediaType ||
    raw.mediaType !== observation.mediaType ||
    raw.mediaType !== claim.artifactRef.mediaType
  ) {
    return invalidResult("media-mismatch", claim.claimId, observation.observationId);
  }
  if (
    !exactJsonEqual(claimedMirror.schema, claim.artifactRef.schema) ||
    !exactJsonEqual(claimedMirror.schema, observation.schema) ||
    !exactJsonEqual(raw.schema, observation.schema) ||
    !exactJsonEqual(raw.schema, claim.artifactRef.schema)
  ) {
    return invalidResult("schema-mismatch", claim.claimId, observation.observationId);
  }
  if (
    !exactJsonEqual(raw.locator, observation.locator) ||
    !exactJsonEqual(raw.locator, claim.artifactRef.locator)
  ) {
    return invalidResult("locator-mismatch", claim.claimId, observation.observationId);
  }
  if (
    !exactJsonEqual(raw.immutableMirrorLocator, observation.immutableMirrorLocator) ||
    !exactJsonEqual(raw.immutableMirrorLocator, claim.artifactRef.immutableMirrorLocator)
  ) {
    return invalidResult("object-key-mismatch", claim.claimId, observation.observationId);
  }
  if (raw.observedStoreEpoch !== observation.observedStoreEpoch || raw.observedStoreEpoch !== claim.observedStoreEpoch) {
    return invalidResult("lease-out-of-range", claim.claimId, observation.observationId);
  }
  const lease = claim.retentionLease;
  const mirror = claim.artifactRef.immutableMirrorLocator;
  if (
    lease.storeIdentityHash !== mirror.storeIdentityHash ||
    lease.objectKey !== mirror.objectKey ||
    lease.contentSha256 !== claim.artifactRef.contentSha256 ||
    claim.artifactRef.retentionLeaseReceiptId !== lease.receiptId
  ) {
    return invalidResult("lease-subject-mismatch", claim.claimId, observation.observationId);
  }
  const epoch = BigInt(raw.observedStoreEpoch);
  if (epoch < BigInt(lease.validFromStoreEpoch) || epoch > BigInt(lease.validThroughStoreEpoch)) {
    return invalidResult("lease-out-of-range", claim.claimId, observation.observationId);
  }
  if (BigInt(lease.validThroughStoreEpoch) - epoch < BigInt(claim.resolverPolicy.minimumRemainingStoreEpochs)) {
    return invalidResult("lease-remaining-too-short", claim.claimId, observation.observationId);
  }
  return rawContentSha256 === claim.artifactRef.contentSha256
    ? Object.freeze({ verdict: "pass", reasons: Object.freeze([]), claimId: claim.claimId, observationId: observation.observationId })
    : failResult("subject-content-mismatch", claim.claimId, observation.observationId);
}
