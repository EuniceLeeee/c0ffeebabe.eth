import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { AttestationIdentityOriginV1 } from "../internal-authority.ts";
import type { AttestationIdentityObservationCommitmentV1 } from "../commitment.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

function nonZeroHash(value: unknown, context: string): Hash {
  const hash = assertHash(value, context);
  if (hash === ZERO_HASH) throw new TypeError(`${context} must be non-zero`);
  return hash;
}

function cutoff(value: unknown, context: string) {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], context);
  const raw = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(raw.chainId, `${context}.chainId`),
    number: assertDecimalString(raw.number, `${context}.number`),
    hash: nonZeroHash(raw.hash, `${context}.hash`),
    stateRoot: nonZeroHash(raw.stateRoot, `${context}.stateRoot`),
  });
}

export function decodeAttestationIdentityObservationV1(
  value: unknown,
  context = "attestationIdentityObservation",
): AttestationIdentityObservationCommitmentV1 {
  assertExactKeys(value, [
    "kind", "familyInstanceKey", "identityMemo", "identityMemoHash", "descriptorHash", "evidenceRoot",
  ], context);
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "identityVerified") throw new TypeError(`${context}.kind is invalid`);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(raw.identityMemo));
  const identityMemoHash = nonZeroHash(raw.identityMemoHash, `${context}.identityMemoHash`);
  if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) {
    throw new TypeError(`${context}.identityMemoHash does not match identityMemo`);
  }
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${context}.familyInstanceKey`),
    identityMemo: identityMemo as CanonicalJson,
    identityMemoHash,
    descriptorHash: nonZeroHash(raw.descriptorHash, `${context}.descriptorHash`),
    evidenceRoot: nonZeroHash(raw.evidenceRoot, `${context}.evidenceRoot`),
  });
}

export function decodeAttestationIdentityOriginV1(
  value: unknown,
  context = "attestationIdentityOrigin",
): AttestationIdentityOriginV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "fresh") {
    assertExactKeys(value, ["kind"], context);
    return deepFreeze({ kind: "fresh" as const });
  }
  assertExactKeys(value, ["kind", "verifiedMemoSetRoot", "proof"], context);
  if (raw.kind !== "verified-memo-reuse") throw new TypeError(`${context}.kind is invalid`);
  const proofValue = raw.proof;
  assertExactKeys(proofValue, [
    "kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "instanceNominationKey", "cutoff", "oldInstancePublicationHash", "requestedArtifactDependencyRoot",
    "descriptorHash", "validityDependencyRoot", "candidateToCanonicalIdentityBindingProof",
    "identityMemo", "identityMemoHash", "evidenceRoot", "proofHash",
  ], `${context}.proof`);
  const proofRaw = proofValue as Record<string, unknown>;
  if (proofRaw.kind !== "verifiedMemoReuseProof") throw new TypeError(`${context}.proof.kind is invalid`);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(proofRaw.identityMemo));
  const identityMemoHash = nonZeroHash(proofRaw.identityMemoHash, `${context}.proof.identityMemoHash`);
  if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) {
    throw new TypeError(`${context}.proof.identityMemoHash does not match identityMemo`);
  }
  const proofCore = deepFreeze({
    kind: "verifiedMemoReuseProof" as const,
    familyId: assertNonEmptyString(proofRaw.familyId, `${context}.proof.familyId`),
    familyDefinitionHash: nonZeroHash(proofRaw.familyDefinitionHash, `${context}.proof.familyDefinitionHash`),
    familyCandidateKey: nonZeroHash(proofRaw.familyCandidateKey, `${context}.proof.familyCandidateKey`),
    candidateSubjectHash: nonZeroHash(proofRaw.candidateSubjectHash, `${context}.proof.candidateSubjectHash`),
    instanceNominationKey: assertNonEmptyString(proofRaw.instanceNominationKey, `${context}.proof.instanceNominationKey`),
    cutoff: cutoff(proofRaw.cutoff, `${context}.proof.cutoff`),
    oldInstancePublicationHash: nonZeroHash(proofRaw.oldInstancePublicationHash, `${context}.proof.oldInstancePublicationHash`),
    requestedArtifactDependencyRoot: nonZeroHash(proofRaw.requestedArtifactDependencyRoot, `${context}.proof.requestedArtifactDependencyRoot`),
    descriptorHash: nonZeroHash(proofRaw.descriptorHash, `${context}.proof.descriptorHash`),
    validityDependencyRoot: nonZeroHash(proofRaw.validityDependencyRoot, `${context}.proof.validityDependencyRoot`),
    candidateToCanonicalIdentityBindingProof: nonZeroHash(proofRaw.candidateToCanonicalIdentityBindingProof, `${context}.proof.candidateToCanonicalIdentityBindingProof`),
    identityMemo: identityMemo as CanonicalJson,
    identityMemoHash,
    evidenceRoot: nonZeroHash(proofRaw.evidenceRoot, `${context}.proof.evidenceRoot`),
  });
  const expectedBinding = hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
    familyId: proofCore.familyId,
    familyDefinitionHash: proofCore.familyDefinitionHash,
    familyCandidateKey: proofCore.familyCandidateKey,
    candidateSubjectHash: proofCore.candidateSubjectHash,
    instanceNominationKey: proofCore.instanceNominationKey,
    cutoff: proofCore.cutoff,
    oldInstancePublicationHash: proofCore.oldInstancePublicationHash,
    identityMemoHash: proofCore.identityMemoHash,
    descriptorHash: proofCore.descriptorHash,
  });
  if (proofCore.candidateToCanonicalIdentityBindingProof !== expectedBinding) {
    throw new TypeError(`${context}.proof identity binding mismatch`);
  }
  const proofHash = nonZeroHash(proofRaw.proofHash, `${context}.proof.proofHash`);
  if (proofHash !== hashDomain("aloha/verified-memo-reuse-proof/v1", proofCore)) {
    throw new TypeError(`${context}.proof hash mismatch`);
  }
  return deepFreeze({
    kind: "verified-memo-reuse" as const,
    verifiedMemoSetRoot: nonZeroHash(raw.verifiedMemoSetRoot, `${context}.verifiedMemoSetRoot`),
    proof: deepFreeze({ ...proofCore, proofHash }),
  });
}
