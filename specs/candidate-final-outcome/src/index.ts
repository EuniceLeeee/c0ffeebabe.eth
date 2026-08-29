import {
  assertDecimalString,
  assertExactCanonicalBytes,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  hashDomainBytes,
  type CanonicalJson,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type {
  CandidateEvidenceRefV1,
  CandidateRecordV1,
  CanonicalCutoffV1,
} from "../../candidate-partition-authority/src/index.ts";

export type CandidateFinalOutcomeKindV1 = "verified" | "chainProvenRejected" | "retryable" | "invalidProgram";

export type CandidateFinalOutcomeWireV1 = Readonly<Record<string, unknown>> & Readonly<{
  readonly kind: CandidateFinalOutcomeKindV1;
  readonly runCandidateKey: Hash;
  readonly familyCandidateKey: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly outcomeIssuerProof: Readonly<Record<string, unknown>>;
}>;

export type CandidateFinalOutcomeBodyWireV1 = Omit<CandidateFinalOutcomeWireV1, "outcomeIssuerProof">;

export interface CandidateFinalOutcomeContextV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_SIGNATURE = `0x${"00".repeat(64)}`;
const OUTCOME_PROOF_KIND = "aloha.attestation-outcome-issuer-proof";
const IDENTITY_PROOF_KIND = "aloha.attestation-identity-issuer-proof";

function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  assertPlainObject(value, path);
  assertExactKeys(value, keys, path);
  return value as Record<string, unknown>;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return result;
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  const raw = exact(value, ["chainId", "number", "hash", "stateRoot"], path);
  return deepFreeze({
    chainId: assertNonEmptyString(raw.chainId, `${path}.chainId`),
    number: assertDecimalString(raw.number, `${path}.number`),
    hash: nonZeroHash(raw.hash, `${path}.hash`),
    stateRoot: nonZeroHash(raw.stateRoot, `${path}.stateRoot`),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function canonicalObject(value: unknown, path: string): CanonicalJsonObject {
  assertPlainObject(value, path);
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as CanonicalJsonObject;
}

function hexBytes(value: unknown, path: string, allowEmpty = false): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`${path} must be lowercase even-length bytes`);
  }
  if (!allowEmpty && value === "0x") throw new TypeError(`${path} must not be empty`);
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function signature(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]{128}$/.test(value) || value === ZERO_SIGNATURE) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as `0x${string}`;
}

function candidateEvidence(value: unknown, path: string): CandidateEvidenceRefV1 {
  assertPlainObject(value, path);
  const raw = value as Record<string, unknown>;
  if (raw.kind === "source-plan") {
    const sourcePlan = exact(raw, ["kind", "version", "ownerRef", "sourcePlanRef", "evidenceRef", "rawLocatorHash"], path);
    if (sourcePlan.version !== 1) throw new TypeError(`${path}.version is invalid`);
    return deepFreeze({
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: nonZeroHash(sourcePlan.ownerRef, `${path}.ownerRef`),
      sourcePlanRef: nonZeroHash(sourcePlan.sourcePlanRef, `${path}.sourcePlanRef`),
      evidenceRef: nonZeroHash(sourcePlan.evidenceRef, `${path}.evidenceRef`),
      rawLocatorHash: nonZeroHash(sourcePlan.rawLocatorHash, `${path}.rawLocatorHash`),
    });
  }
  if (raw.kind === "recent-log") {
    const log = exact(raw, [
      "kind", "version", "sourcePlanRef", "ownerRef", "blockNumber", "blockHash", "txHash",
      "logIndex", "address", "topic", "rawLocatorHash",
    ], path);
    if (log.version !== 1 || log.sourcePlanRef !== null || log.ownerRef !== null) {
      throw new TypeError(`${path} recent-log source/version is invalid`);
    }
    return deepFreeze({
      kind: "recent-log" as const,
      version: 1 as const,
      sourcePlanRef: null,
      ownerRef: null,
      blockNumber: assertDecimalString(log.blockNumber, `${path}.blockNumber`),
      blockHash: nonZeroHash(log.blockHash, `${path}.blockHash`),
      txHash: nonZeroHash(log.txHash, `${path}.txHash`),
      logIndex: assertDecimalString(log.logIndex, `${path}.logIndex`),
      address: assertNonEmptyString(log.address, `${path}.address`),
      topic: nonZeroHash(log.topic, `${path}.topic`),
      rawLocatorHash: nonZeroHash(log.rawLocatorHash, `${path}.rawLocatorHash`),
    });
  }
  throw new TypeError(`${path}.kind is invalid`);
}

export function decodeCandidateRecordV1(value: unknown, path = "candidate"): CandidateRecordV1 {
  const raw = exact(value, [
    "kind", "version", "familyId", "familyDefinitionHash", "instanceNominationKey",
    "familyCandidateKey", "candidateSubjectHash", "candidateEvidenceRoot", "evidence",
  ], path);
  if (raw.kind !== "aloha.candidate-record" || raw.version !== "2" || !Array.isArray(raw.evidence)) {
    throw new TypeError(`${path} kind/version/evidence is invalid`);
  }
  const familyId = assertNonEmptyString(raw.familyId, `${path}.familyId`);
  const familyDefinitionHash = nonZeroHash(raw.familyDefinitionHash, `${path}.familyDefinitionHash`);
  const instanceNominationKey = assertNonEmptyString(raw.instanceNominationKey, `${path}.instanceNominationKey`);
  const familyCandidateKey = nonZeroHash(raw.familyCandidateKey, `${path}.familyCandidateKey`);
  if (familyCandidateKey !== hashDomain("aloha/family-candidate/v2", { familyDefinitionHash, instanceNominationKey })) {
    throw new TypeError(`${path}.familyCandidateKey mismatch`);
  }
  const evidence = raw.evidence.map((entry, index) => candidateEvidence(entry, `${path}.evidence[${index}]`));
  if (evidence.length === 0) throw new TypeError(`${path}.evidence must not be empty`);
  const keyedEvidence = evidence.map(entry => ({ key: hashDomain("aloha/candidate-evidence-ref/v1", entry), value: entry }));
  if (new Set(keyedEvidence.map(entry => entry.key)).size !== keyedEvidence.length
    || keyedEvidence.some((entry, index) => index > 0 && keyedEvidence[index - 1]!.key >= entry.key)) {
    throw new TypeError(`${path}.evidence must be unique and canonically ordered`);
  }
  const candidateSubjectHash = nonZeroHash(raw.candidateSubjectHash, `${path}.candidateSubjectHash`);
  const candidateEvidenceRoot = nonZeroHash(raw.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`);
  if (candidateSubjectHash !== hashDomain("aloha/candidate-subject/v2", { familyDefinitionHash, instanceNominationKey })
    || candidateEvidenceRoot !== hashDomain("aloha/candidate-evidence-set/v2", evidence)) {
    throw new TypeError(`${path} subject/evidence lineage mismatch`);
  }
  return deepFreeze(decodeCanonicalJson(encodeCanonicalBytes({
    kind: "aloha.candidate-record",
    version: "2",
    familyId,
    familyDefinitionHash,
    instanceNominationKey,
    familyCandidateKey,
    candidateSubjectHash,
    candidateEvidenceRoot,
    evidence,
  }))) as unknown as CandidateRecordV1;
}

function identityObservation(value: unknown, path: string) {
  const raw = exact(value, [
    "kind", "familyInstanceKey", "identityMemo", "identityMemoHash", "descriptorHash", "evidenceRoot",
  ], path);
  if (raw.kind !== "identityVerified") throw new TypeError(`${path}.kind is invalid`);
  const memo = decodeCanonicalJson(encodeCanonicalJson(raw.identityMemo));
  const memoHash = nonZeroHash(raw.identityMemoHash, `${path}.identityMemoHash`);
  if (memoHash !== hashDomain("aloha/identity-memo/v1", memo)) throw new TypeError(`${path}.identityMemoHash mismatch`);
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${path}.familyInstanceKey`),
    identityMemo: memo,
    identityMemoHash: memoHash,
    descriptorHash: nonZeroHash(raw.descriptorHash, `${path}.descriptorHash`),
    evidenceRoot: nonZeroHash(raw.evidenceRoot, `${path}.evidenceRoot`),
  });
}

function identityOrigin(value: unknown, path: string): CanonicalJsonObject {
  const raw = canonicalObject(value, path);
  if (raw.kind === "fresh") {
    assertExactKeys(raw, ["kind"], path);
  } else if (raw.kind === "verified-memo-reuse") {
    assertExactKeys(raw, ["kind", "verifiedMemoSetRoot", "proof"], path);
    nonZeroHash(raw.verifiedMemoSetRoot, `${path}.verifiedMemoSetRoot`);
    const proofPath = `${path}.proof`;
    const proofRaw = exact(raw.proof, [
      "kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
      "instanceNominationKey", "cutoff", "oldInstancePublicationHash", "requestedArtifactDependencyRoot",
      "descriptorHash", "validityDependencyRoot", "candidateToCanonicalIdentityBindingProof",
      "identityMemo", "identityMemoHash", "evidenceRoot", "proofHash",
    ], proofPath);
    if (proofRaw.kind !== "verifiedMemoReuseProof") throw new TypeError(`${proofPath}.kind is invalid`);
    const identityMemo = decodeCanonicalJson(encodeCanonicalJson(proofRaw.identityMemo));
    const identityMemoHash = nonZeroHash(proofRaw.identityMemoHash, `${proofPath}.identityMemoHash`);
    if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) {
      throw new TypeError(`${proofPath}.identityMemoHash mismatch`);
    }
    const proofCore = deepFreeze({
      kind: "verifiedMemoReuseProof" as const,
      familyId: assertNonEmptyString(proofRaw.familyId, `${proofPath}.familyId`),
      familyDefinitionHash: nonZeroHash(proofRaw.familyDefinitionHash, `${proofPath}.familyDefinitionHash`),
      familyCandidateKey: nonZeroHash(proofRaw.familyCandidateKey, `${proofPath}.familyCandidateKey`),
      candidateSubjectHash: nonZeroHash(proofRaw.candidateSubjectHash, `${proofPath}.candidateSubjectHash`),
      instanceNominationKey: assertNonEmptyString(proofRaw.instanceNominationKey, `${proofPath}.instanceNominationKey`),
      cutoff: cutoff(proofRaw.cutoff, `${proofPath}.cutoff`),
      oldInstancePublicationHash: nonZeroHash(proofRaw.oldInstancePublicationHash, `${proofPath}.oldInstancePublicationHash`),
      requestedArtifactDependencyRoot: nonZeroHash(proofRaw.requestedArtifactDependencyRoot, `${proofPath}.requestedArtifactDependencyRoot`),
      descriptorHash: nonZeroHash(proofRaw.descriptorHash, `${proofPath}.descriptorHash`),
      validityDependencyRoot: nonZeroHash(proofRaw.validityDependencyRoot, `${proofPath}.validityDependencyRoot`),
      candidateToCanonicalIdentityBindingProof: nonZeroHash(
        proofRaw.candidateToCanonicalIdentityBindingProof,
        `${proofPath}.candidateToCanonicalIdentityBindingProof`,
      ),
      identityMemo: identityMemo as CanonicalJson,
      identityMemoHash,
      evidenceRoot: nonZeroHash(proofRaw.evidenceRoot, `${proofPath}.evidenceRoot`),
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
      throw new TypeError(`${proofPath} identity binding mismatch`);
    }
    if (proofRaw.proofHash !== hashDomain("aloha/verified-memo-reuse-proof/v1", proofCore)) {
      throw new TypeError(`${proofPath}.proofHash mismatch`);
    }
  } else throw new TypeError(`${path}.kind is invalid`);
  return raw;
}

function assertIdentityOriginContext(
  origin: CanonicalJsonObject,
  context: CandidateFinalOutcomeContextV1,
  observation: ReturnType<typeof identityObservation>,
): void {
  if (origin.kind !== "verified-memo-reuse") return;
  const proof = origin.proof as CanonicalJsonObject;
  if (
    proof.familyId !== context.candidate.familyId
    || proof.familyDefinitionHash !== context.candidate.familyDefinitionHash
    || proof.familyCandidateKey !== context.candidate.familyCandidateKey
    || proof.candidateSubjectHash !== context.candidate.candidateSubjectHash
    || proof.instanceNominationKey !== context.candidate.instanceNominationKey
    || !sameJson(proof.cutoff, context.cutoff)
    || proof.identityMemoHash !== observation.identityMemoHash
    || !sameJson(proof.identityMemo, observation.identityMemo)
    || proof.descriptorHash !== observation.descriptorHash
    || proof.evidenceRoot !== observation.evidenceRoot
  ) throw new TypeError("identity proof memo-reuse context mismatch");
}

function identitySubjectHash(candidate: CandidateRecordV1, observation: ReturnType<typeof identityObservation>): Hash {
  return hashDomain("aloha/verified-identity-subject/v1", {
    familyDefinitionHash: candidate.familyDefinitionHash,
    familyInstanceKey: observation.familyInstanceKey,
    identityMemo: observation.identityMemo,
    identityMemoHash: observation.identityMemoHash,
    descriptorHash: observation.descriptorHash,
  });
}

function identitySemanticHash(
  context: CandidateFinalOutcomeContextV1,
  observation: ReturnType<typeof identityObservation>,
  origin: CanonicalJsonObject,
  authority: Readonly<{
    readonly releaseProvenanceHash: Hash;
    readonly attestationAuthorityRoot: Hash;
    readonly releaseAuthorityRoot: Hash;
    readonly frameworkAuthorityRoot: Hash;
    readonly executorAuthorityRoot: Hash;
  }>,
): Hash {
  return hashDomain("aloha/attestation-identity-observation/v1", {
    runId: context.runId,
    cutoff: context.cutoff,
    candidatePartitionRoot: context.candidatePartitionRoot,
    candidate: context.candidate,
    identity: observation,
    identityOrigin: origin,
    releaseProvenanceHash: authority.releaseProvenanceHash,
    attestationAuthorityRoot: authority.attestationAuthorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
  });
}

function validateIdentityProof(value: unknown, context: CandidateFinalOutcomeContextV1) {
  const raw = exact(value, [
    "kind", "version", "proofHash", "payloadHash", "runId", "cutoff", "candidatePartitionRoot",
    "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "identityObservation", "identitySubjectHash",
    "identitySemanticHash", "identityOrigin", "releaseProvenanceHash", "attestationAuthorityRoot", "frameworkAuthorityRoot",
    "executorAuthorityRoot", "releaseAuthorityRoot", "sequence", "signatureAlgorithm", "issuerKeyId", "signatureHex",
  ], "candidateFinalOutcome.identityProof");
  if (raw.kind !== IDENTITY_PROOF_KIND || raw.version !== "2" || raw.signatureAlgorithm !== "ed25519") {
    throw new TypeError("identity proof kind/version invalid");
  }
  const observation = identityObservation(raw.identityObservation, "candidateFinalOutcome.identityProof.identityObservation");
  const origin = identityOrigin(raw.identityOrigin, "candidateFinalOutcome.identityProof.identityOrigin");
  assertIdentityOriginContext(origin, context, observation);
  const core = deepFreeze({
    kind: IDENTITY_PROOF_KIND,
    version: "2",
    runId: assertNonEmptyString(raw.runId, "identityProof.runId"),
    cutoff: cutoff(raw.cutoff, "identityProof.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "identityProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "identityProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "identityProof.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "identityProof.candidateSubjectHash"),
    identityObservation: observation,
    identitySubjectHash: nonZeroHash(raw.identitySubjectHash, "identityProof.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(raw.identitySemanticHash, "identityProof.identitySemanticHash"),
    identityOrigin: origin,
    releaseProvenanceHash: nonZeroHash(raw.releaseProvenanceHash, "identityProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "identityProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "identityProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "identityProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(raw.releaseAuthorityRoot, "identityProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "identityProof.sequence"),
  });
  const issuerKeyId = nonZeroHash(raw.issuerKeyId, "identityProof.issuerKeyId");
  const payloadHash = hashDomain("aloha/attestation-identity-issuer-proof/payload/v2", core);
  const proofHash = hashDomain("aloha/attestation-identity-issuer-proof/id/v2", { payloadHash, issuerKeyId });
  if (raw.payloadHash !== payloadHash || raw.proofHash !== proofHash) throw new TypeError("identity proof hash mismatch");
  signature(raw.signatureHex, "identityProof.signatureHex");
  if (core.runId !== context.runId || !sameJson(core.cutoff, context.cutoff)
    || core.candidatePartitionRoot !== context.candidatePartitionRoot
    || core.familyDefinitionHash !== context.candidate.familyDefinitionHash
    || core.familyCandidateKey !== context.candidate.familyCandidateKey
    || core.candidateSubjectHash !== context.candidate.candidateSubjectHash
    || core.identitySubjectHash !== identitySubjectHash(context.candidate, observation)
    || core.identitySemanticHash !== identitySemanticHash(context, observation, origin, core)) {
    throw new TypeError("identity proof context mismatch");
  }
  return deepFreeze({ ...core, proofHash, payloadHash, signatureAlgorithm: "ed25519" as const, issuerKeyId, signatureHex: raw.signatureHex });
}

function validateOutcomeProof(value: unknown, context: CandidateFinalOutcomeContextV1) {
  const raw = exact(value, [
    "kind", "version", "proofHash", "payloadHash", "runId", "cutoff", "candidatePartitionRoot",
    "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "outcomeBodyHash",
    "releaseProvenanceHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot",
    "releaseAuthorityRoot", "sequence", "signatureAlgorithm", "issuerKeyId", "signatureHex",
  ], "candidateFinalOutcome.outcomeIssuerProof");
  if (raw.kind !== OUTCOME_PROOF_KIND || raw.version !== "2" || raw.signatureAlgorithm !== "ed25519") {
    throw new TypeError("outcome proof kind/version invalid");
  }
  const core = deepFreeze({
    kind: OUTCOME_PROOF_KIND,
    version: "2",
    runId: assertNonEmptyString(raw.runId, "outcomeProof.runId"),
    cutoff: cutoff(raw.cutoff, "outcomeProof.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "outcomeProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "outcomeProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "outcomeProof.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "outcomeProof.candidateSubjectHash"),
    outcomeBodyHash: nonZeroHash(raw.outcomeBodyHash, "outcomeProof.outcomeBodyHash"),
    releaseProvenanceHash: nonZeroHash(raw.releaseProvenanceHash, "outcomeProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "outcomeProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "outcomeProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "outcomeProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(raw.releaseAuthorityRoot, "outcomeProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "outcomeProof.sequence"),
  });
  const issuerKeyId = nonZeroHash(raw.issuerKeyId, "outcomeProof.issuerKeyId");
  const payloadHash = hashDomain("aloha/attestation-outcome-issuer-proof/payload/v2", core);
  const proofHash = hashDomain("aloha/attestation-outcome-issuer-proof/id/v2", { payloadHash, issuerKeyId });
  if (raw.payloadHash !== payloadHash || raw.proofHash !== proofHash) throw new TypeError("outcome proof hash mismatch");
  signature(raw.signatureHex, "outcomeProof.signatureHex");
  if (core.runId !== context.runId || !sameJson(core.cutoff, context.cutoff)
    || core.candidatePartitionRoot !== context.candidatePartitionRoot
    || core.familyDefinitionHash !== context.candidate.familyDefinitionHash
    || core.familyCandidateKey !== context.candidate.familyCandidateKey
    || core.candidateSubjectHash !== context.candidate.candidateSubjectHash) {
    throw new TypeError("outcome proof context mismatch");
  }
  return deepFreeze({ ...core, proofHash, payloadHash, signatureAlgorithm: "ed25519" as const, issuerKeyId, signatureHex: raw.signatureHex });
}

function persistedCanonicalRecord(value: unknown, keys: readonly string[], path: string) {
  const raw = exact(value, keys, path);
  const canonicalBytesHex = raw.canonicalBytesHex;
  const bytes = hexBytes(canonicalBytesHex, `${path}.canonicalBytesHex`);
  const bodyKey = keys.includes("record") ? "record" : keys.includes("fact") ? "fact" : "observation";
  const body = canonicalObject(raw[bodyKey], `${path}.${bodyKey}`);
  assertExactCanonicalBytes(body, bytes);
  return { raw, body, canonicalBytesHex: canonicalBytesHex as `0x${string}` };
}

function validateRejectionEvidence(value: unknown) {
  const raw = exact(value, [
    "kind", "version", "issuerId", "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot",
    "stage", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "identitySubjectHash",
    "instanceNominationKey", "executorAuthorityRoot", "workerEpoch", "executorSessionHash", "executionSessionHash",
    "request", "transportFacts", "effectObservations", "decisionCode", "decisionBytesHex", "requestFingerprint",
    "orderedTransportFactsRoot", "effectObservationRoot", "decisionBytesHash", "evidenceBundleRoot",
  ], "candidateFinalOutcome.rejectionEvidence");
  if (raw.kind !== "aloha.rejection-evidence-bundle" || raw.version !== "2"
    || raw.issuerId !== "aloha/attestation-rejection-facts/v2") throw new TypeError("rejection evidence kind/version invalid");
  if (!(raw.stage === "identity" || raw.stage === "materialization" || raw.stage === "projection")) throw new TypeError("rejection evidence stage invalid");
  const request = persistedCanonicalRecord(raw.request, ["requestId", "record", "canonicalBytesHex"], "rejectionEvidence.request");
  const requestId = nonZeroHash(request.raw.requestId, "rejectionEvidence.request.requestId");
  if (!Array.isArray(raw.transportFacts) || raw.transportFacts.length === 0 || !Array.isArray(raw.effectObservations)) {
    throw new TypeError("rejection evidence child partition invalid");
  }
  const transportFacts = raw.transportFacts.map((value, index) => {
    const decoded = persistedCanonicalRecord(value, ["ordinal", "requestId", "kind", "fact", "canonicalBytesHex"], `rejectionEvidence.transportFacts[${index}]`);
    if (decoded.raw.ordinal !== String(index) || decoded.raw.requestId !== requestId
      || !(decoded.raw.kind === "returned" || decoded.raw.kind === "reverted")) throw new TypeError("rejection transport lineage invalid");
    return deepFreeze({ ordinal: String(index), requestId, kind: decoded.raw.kind, fact: decoded.body, canonicalBytesHex: decoded.canonicalBytesHex });
  });
  const effectObservations = raw.effectObservations.map((value, index) => {
    const decoded = persistedCanonicalRecord(value, ["ordinal", "requestId", "observation", "canonicalBytesHex"], `rejectionEvidence.effectObservations[${index}]`);
    if (decoded.raw.ordinal !== String(index) || decoded.raw.requestId !== requestId) throw new TypeError("rejection effect lineage invalid");
    return deepFreeze({ ordinal: String(index), requestId, observation: decoded.body, canonicalBytesHex: decoded.canonicalBytesHex });
  });
  const normalized = deepFreeze({
    kind: "aloha.rejection-evidence-bundle",
    version: "2",
    issuerId: "aloha/attestation-rejection-facts/v2",
    runId: assertNonEmptyString(raw.runId, "rejectionEvidence.runId"),
    chainId: assertNonEmptyString(raw.chainId, "rejectionEvidence.chainId"),
    cutoffNumber: assertDecimalString(raw.cutoffNumber, "rejectionEvidence.cutoffNumber"),
    cutoffHash: nonZeroHash(raw.cutoffHash, "rejectionEvidence.cutoffHash"),
    cutoffStateRoot: nonZeroHash(raw.cutoffStateRoot, "rejectionEvidence.cutoffStateRoot"),
    stage: raw.stage,
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "rejectionEvidence.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "rejectionEvidence.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "rejectionEvidence.candidateSubjectHash"),
    identitySubjectHash: raw.identitySubjectHash === null ? null : nonZeroHash(raw.identitySubjectHash, "rejectionEvidence.identitySubjectHash"),
    instanceNominationKey: raw.instanceNominationKey === null ? null : assertNonEmptyString(raw.instanceNominationKey, "rejectionEvidence.instanceNominationKey"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "rejectionEvidence.executorAuthorityRoot"),
    workerEpoch: assertNonEmptyString(raw.workerEpoch, "rejectionEvidence.workerEpoch"),
    executorSessionHash: nonZeroHash(raw.executorSessionHash, "rejectionEvidence.executorSessionHash"),
    executionSessionHash: nonZeroHash(raw.executionSessionHash, "rejectionEvidence.executionSessionHash"),
    request: deepFreeze({ requestId, record: request.body, canonicalBytesHex: request.canonicalBytesHex }),
    transportFacts: deepFreeze(transportFacts),
    effectObservations: deepFreeze(effectObservations),
    decisionCode: assertNonEmptyString(raw.decisionCode, "rejectionEvidence.decisionCode"),
    decisionBytesHex: raw.decisionBytesHex as `0x${string}`,
    requestFingerprint: nonZeroHash(raw.requestFingerprint, "rejectionEvidence.requestFingerprint"),
    orderedTransportFactsRoot: nonZeroHash(raw.orderedTransportFactsRoot, "rejectionEvidence.orderedTransportFactsRoot"),
    effectObservationRoot: nonZeroHash(raw.effectObservationRoot, "rejectionEvidence.effectObservationRoot"),
    decisionBytesHash: nonZeroHash(raw.decisionBytesHash, "rejectionEvidence.decisionBytesHash"),
    evidenceBundleRoot: nonZeroHash(raw.evidenceBundleRoot, "rejectionEvidence.evidenceBundleRoot"),
  });
  const decisionBytes = hexBytes(normalized.decisionBytesHex, "rejectionEvidence.decisionBytesHex");
  if (normalized.requestFingerprint !== hashDomainBytes("aloha/rejection-request-fingerprint/v1", hexBytes(normalized.request.canonicalBytesHex, "request.canonicalBytesHex"))
    || normalized.orderedTransportFactsRoot !== hashCanonicalPartition("aloha/rejection-ordered-transport-facts/v1", normalized.transportFacts)
    || normalized.effectObservationRoot !== hashCanonicalPartition("aloha/rejection-effect-observations/v1", normalized.effectObservations)
    || normalized.decisionBytesHash !== hashDomainBytes("aloha/rejection-decision-bytes/v1", decisionBytes)) {
    throw new TypeError("rejection evidence child root mismatch");
  }
  const { evidenceBundleRoot, ...withoutRoot } = normalized;
  if (evidenceBundleRoot !== hashDomain("aloha/rejection-evidence-bundle/v2", withoutRoot)) throw new TypeError("rejection evidence bundle root mismatch");
  return normalized;
}

function rejectionProofFromEvidence(evidence: ReturnType<typeof validateRejectionEvidence>) {
  const input = {
    stage: evidence.stage,
    chainId: evidence.chainId,
    cutoffNumber: evidence.cutoffNumber,
    familyDefinitionHash: evidence.familyDefinitionHash,
    familyCandidateKey: evidence.familyCandidateKey,
    candidateSubjectHash: evidence.candidateSubjectHash,
    identitySubjectHash: evidence.identitySubjectHash,
    instanceNominationKey: evidence.instanceNominationKey,
    executorAuthorityRoot: evidence.executorAuthorityRoot,
    workerEpoch: evidence.workerEpoch,
    executorSessionHash: evidence.executorSessionHash,
    executionSessionHash: evidence.executionSessionHash,
    cutoffHash: evidence.cutoffHash,
    cutoffStateRoot: evidence.cutoffStateRoot,
    orderedTransportFactsRoot: evidence.orderedTransportFactsRoot,
    effectObservationRoot: evidence.effectObservationRoot,
    decisionCode: evidence.decisionCode,
    decisionBytesHash: evidence.decisionBytesHash,
    requestFingerprint: evidence.requestFingerprint,
    evidenceBundleRoot: evidence.evidenceBundleRoot,
    authorityRoot: hashDomain("aloha/chain-rejection-authority/v2", { familyDefinitionHash: evidence.familyDefinitionHash, stage: evidence.stage }),
  };
  return deepFreeze({ ...input, proofHash: hashDomain("aloha/chain-rejection-proof/v4", input) });
}

function assetIdentity(value: unknown, path: string) {
  const raw = exact(value, ["chainId", "kind", "address"], path);
  const chainId = assertDecimalString(raw.chainId, `${path}.chainId`);
  if (chainId === "0" || BigInt(chainId).toString(10) !== chainId) throw new TypeError(`${path}.chainId is invalid`);
  if (raw.kind === "native") {
    if (raw.address !== null) throw new TypeError(`${path}.address must be null`);
    return deepFreeze({ chainId, kind: "native" as const, address: null });
  }
  if (raw.kind !== "erc20" || typeof raw.address !== "string" || !/^0x[0-9a-f]{40}$/.test(raw.address)
    || raw.address === "0x0000000000000000000000000000000000000000") throw new TypeError(`${path} erc20 identity is invalid`);
  return deepFreeze({ chainId, kind: "erc20" as const, address: raw.address });
}

function assetPort(value: unknown, path: string) {
  const raw = exact(value, ["assetIdentity", "assetRef", "portRef", "ordinal"], path);
  const identity = assetIdentity(raw.assetIdentity, `${path}.assetIdentity`);
  const assetRef = nonZeroHash(raw.assetRef, `${path}.assetRef`);
  if (assetRef !== hashDomain("aloha/asset-ref/v1", identity)) throw new TypeError(`${path}.assetRef mismatch`);
  return deepFreeze({
    assetIdentity: identity,
    assetRef,
    portRef: nonZeroHash(raw.portRef, `${path}.portRef`),
    ordinal: assertDecimalString(raw.ordinal, `${path}.ordinal`),
  });
}

function transitionProjection(value: unknown, path: string, chainId: string) {
  const raw = exact(value, [
    "inputAssetPorts", "outputAssetPorts", "opaqueTransitionRef", "constraintRefs", "staticProjectionHash", "projectionHash",
  ], path);
  if (!Array.isArray(raw.inputAssetPorts) || !Array.isArray(raw.outputAssetPorts)
    || raw.inputAssetPorts.length === 0 || raw.outputAssetPorts.length === 0 || !Array.isArray(raw.constraintRefs)) {
    throw new TypeError(`${path} asset ports/constraints are invalid`);
  }
  const inputAssetPorts = raw.inputAssetPorts.map((entry, index) => assetPort(entry, `${path}.inputAssetPorts[${index}]`));
  const outputAssetPorts = raw.outputAssetPorts.map((entry, index) => assetPort(entry, `${path}.outputAssetPorts[${index}]`));
  if ([...inputAssetPorts, ...outputAssetPorts].some(port => port.assetIdentity.chainId !== chainId)) {
    throw new TypeError(`${path} asset chain mismatch`);
  }
  const constraintRefs = raw.constraintRefs.map((entry, index) => nonZeroHash(entry, `${path}.constraintRefs[${index}]`));
  if (new Set(constraintRefs).size !== constraintRefs.length
    || constraintRefs.some((entry, index) => index > 0 && constraintRefs[index - 1]! >= entry)) {
    throw new TypeError(`${path}.constraintRefs must be unique and sorted`);
  }
  const payload = deepFreeze({
    inputAssetPorts,
    outputAssetPorts,
    opaqueTransitionRef: nonZeroHash(raw.opaqueTransitionRef, `${path}.opaqueTransitionRef`),
    constraintRefs,
    staticProjectionHash: nonZeroHash(raw.staticProjectionHash, `${path}.staticProjectionHash`),
  });
  const projectionHash = nonZeroHash(raw.projectionHash, `${path}.projectionHash`);
  if (projectionHash !== hashDomain("aloha/static-transition-projection/v1", payload)) throw new TypeError(`${path}.projectionHash mismatch`);
  return deepFreeze({ ...payload, projectionHash });
}

function validatePublication(value: unknown, candidate: CandidateRecordV1, identity: ReturnType<typeof identityObservation>, expectedCutoff: CanonicalCutoffV1) {
  const raw = exact(value, [
    "familyId", "familyDefinitionHash", "familyCandidateKey", "instanceKey", "cutoff", "identityMemo",
    "identityMemoHash", "descriptorHash", "staticProjectionMemoHash", "requestedArtifactDependencyRoot",
    "validityDependencyRoot", "transitions", "evidenceRoot", "instancePublicationHash",
  ], "candidateFinalOutcome.publication");
  if (!Array.isArray(raw.transitions)) throw new TypeError("publication transitions invalid");
  const decodedCutoff = cutoff(raw.cutoff, "publication.cutoff");
  const transitions = raw.transitions.map((entry, index) => transitionProjection(entry, `publication.transitions[${index}]`, decodedCutoff.chainId));
  if (new Set(transitions.map(entry => entry.projectionHash)).size !== transitions.length
    || transitions.some((entry, index) => index > 0 && transitions[index - 1]!.projectionHash >= entry.projectionHash)) {
    throw new TypeError("publication transitions must be unique and sorted");
  }
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(raw.identityMemo)) as CanonicalJson;
  const identityMemoHash = nonZeroHash(raw.identityMemoHash, "publication.identityMemoHash");
  if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) throw new TypeError("publication identity memo hash mismatch");
  const payload = deepFreeze({
    familyId: assertNonEmptyString(raw.familyId, "publication.familyId"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "publication.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "publication.familyCandidateKey"),
    instanceKey: assertNonEmptyString(raw.instanceKey, "publication.instanceKey"),
    cutoff: decodedCutoff,
    identityMemo,
    identityMemoHash,
    descriptorHash: nonZeroHash(raw.descriptorHash, "publication.descriptorHash"),
    staticProjectionMemoHash: nonZeroHash(raw.staticProjectionMemoHash, "publication.staticProjectionMemoHash"),
    requestedArtifactDependencyRoot: nonZeroHash(raw.requestedArtifactDependencyRoot, "publication.requestedArtifactDependencyRoot"),
    validityDependencyRoot: nonZeroHash(raw.validityDependencyRoot, "publication.validityDependencyRoot"),
    transitions,
    evidenceRoot: nonZeroHash(raw.evidenceRoot, "publication.evidenceRoot"),
  });
  const publicationHash = nonZeroHash(raw.instancePublicationHash, "publication.instancePublicationHash");
  if (publicationHash !== hashDomain("aloha/instance-publication/v1", payload)
    || payload.familyId !== candidate.familyId || payload.familyDefinitionHash !== candidate.familyDefinitionHash
    || payload.familyCandidateKey !== candidate.familyCandidateKey || payload.instanceKey !== identity.familyInstanceKey
    || !sameJson(payload.cutoff, expectedCutoff) || !sameJson(payload.identityMemo, identity.identityMemo)
    || payload.identityMemoHash !== identity.identityMemoHash || payload.descriptorHash !== identity.descriptorHash
    || payload.evidenceRoot !== identity.evidenceRoot) throw new TypeError("publication lineage mismatch");
  return deepFreeze({ ...payload, instancePublicationHash: publicationHash });
}

function frameworkFailureBinding(
  value: unknown,
  path: string,
  context: CandidateFinalOutcomeContextV1,
  frameworkAuthorityRoot: Hash,
) {
  const raw = exact(value, [
    "issuerId", "authorityRoot", "runId", "familyCandidateKey", "candidateSubjectHash", "stage",
    "failureClass", "failureCode", "attemptCount", "evidenceRoot", "tokenHash",
  ], path);
  if (raw.issuerId !== "aloha/attestation-framework/v1"
    || !(raw.stage === "identity" || raw.stage === "materialization" || raw.stage === "projection" || raw.stage === "framework")
    || !["transport", "rpc", "deadline", "resource", "storage", "queue"].includes(String(raw.failureClass))) {
    throw new TypeError(`${path} kind/stage/class is invalid`);
  }
  const withoutHash = deepFreeze({
    issuerId: "aloha/attestation-framework/v1",
    authorityRoot: nonZeroHash(raw.authorityRoot, `${path}.authorityRoot`),
    runId: assertNonEmptyString(raw.runId, `${path}.runId`),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, `${path}.familyCandidateKey`),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, `${path}.candidateSubjectHash`),
    stage: raw.stage,
    failureClass: raw.failureClass,
    failureCode: assertNonEmptyString(raw.failureCode, `${path}.failureCode`),
    attemptCount: assertDecimalString(raw.attemptCount, `${path}.attemptCount`),
    evidenceRoot: nonZeroHash(raw.evidenceRoot, `${path}.evidenceRoot`),
  });
  const tokenHash = nonZeroHash(raw.tokenHash, `${path}.tokenHash`);
  if (withoutHash.attemptCount === "0"
    || tokenHash !== hashDomain("aloha/framework-failure-token/v1", withoutHash)
    || withoutHash.authorityRoot !== frameworkAuthorityRoot
    || withoutHash.runId !== context.runId
    || withoutHash.familyCandidateKey !== context.candidate.familyCandidateKey
    || withoutHash.candidateSubjectHash !== context.candidate.candidateSubjectHash) {
    throw new TypeError(`${path} hash/context mismatch`);
  }
  return deepFreeze({ ...withoutHash, tokenHash });
}

function failure(
  value: unknown,
  kind: "retryable" | "invalidProgram",
  context: CandidateFinalOutcomeContextV1,
  frameworkAuthorityRoot: Hash,
) {
  const raw = exact(value, ["stage", "failureCode", "attemptCount", "candidateSubjectHash", "evidenceRoot", "frameworkBinding"], "candidateFinalOutcome.failure");
  if (!(raw.stage === "identity" || raw.stage === "materialization" || raw.stage === "projection" || raw.stage === "framework")) throw new TypeError("failure stage invalid");
  const attemptCount = assertDecimalString(raw.attemptCount, "failure.attemptCount");
  if (attemptCount === "0" || raw.candidateSubjectHash !== context.candidate.candidateSubjectHash) throw new TypeError("failure candidate/attempt mismatch");
  const binding = raw.frameworkBinding === null
    ? null
    : frameworkFailureBinding(raw.frameworkBinding, "failure.frameworkBinding", context, frameworkAuthorityRoot);
  if (kind === "invalidProgram" && binding !== null) throw new TypeError("invalidProgram framework binding forbidden");
  if (binding !== null && (binding.stage === "framework" || binding.stage !== raw.stage
    || binding.failureCode !== raw.failureCode || binding.attemptCount !== attemptCount
    || binding.evidenceRoot !== raw.evidenceRoot)) throw new TypeError("framework binding lineage mismatch");
  return deepFreeze({
    stage: raw.stage,
    failureCode: assertNonEmptyString(raw.failureCode, "failure.failureCode"),
    attemptCount,
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "failure.candidateSubjectHash"),
    evidenceRoot: nonZeroHash(raw.evidenceRoot, "failure.evidenceRoot"),
    frameworkBinding: binding,
  });
}

export function candidateFinalOutcomeBodyHash(
  value: CandidateFinalOutcomeWireV1 | CandidateFinalOutcomeBodyWireV1,
): Hash {
  const { outcomeIssuerProof: _proof, ...body } = value;
  return hashDomain("aloha/candidate-final-outcome-body/v1", body);
}

export function candidateFinalOutcomeHash(value: CandidateFinalOutcomeWireV1): Hash {
  return hashDomain("aloha/candidate-final-outcome/v1", value);
}

export function validateCandidateFinalOutcomeV1(
  contextInput: CandidateFinalOutcomeContextV1,
  value: unknown,
): CandidateFinalOutcomeWireV1 {
  const context = deepFreeze({
    runId: assertNonEmptyString(contextInput.runId, "candidateFinalOutcome.runId"),
    cutoff: cutoff(contextInput.cutoff, "candidateFinalOutcome.cutoff"),
    candidatePartitionRoot: nonZeroHash(contextInput.candidatePartitionRoot, "candidateFinalOutcome.candidatePartitionRoot"),
    candidate: decodeCandidateRecordV1(contextInput.candidate),
  });
  assertPlainObject(value, "candidateFinalOutcome");
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (!(kind === "verified" || kind === "chainProvenRejected" || kind === "retryable" || kind === "invalidProgram")) throw new TypeError("candidate outcome kind invalid");
  const commonKeys = ["kind", "runCandidateKey", "familyCandidateKey", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "identityProof", "outcomeIssuerProof"];
  const variantKeys = kind === "verified" ? ["instanceKey", "publication"] : kind === "chainProvenRejected" ? ["proof", "rejectionEvidence"] : ["failure"];
  assertExactKeys(raw, [...commonKeys, ...variantKeys], "candidateFinalOutcome");
  const authority = {
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "candidateFinalOutcome.attestationAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(raw.releaseAuthorityRoot, "candidateFinalOutcome.releaseAuthorityRoot"),
    releaseProvenanceHash: nonZeroHash(raw.releaseProvenanceHash, "candidateFinalOutcome.releaseProvenanceHash"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "candidateFinalOutcome.executorAuthorityRoot"),
  };
  if (raw.familyCandidateKey !== context.candidate.familyCandidateKey
    || raw.runCandidateKey !== hashDomain("aloha/run-candidate/v1", { runId: context.runId, familyCandidateKey: context.candidate.familyCandidateKey })) {
    throw new TypeError("candidate outcome candidate/run mismatch");
  }
  const outcomeProof = validateOutcomeProof(raw.outcomeIssuerProof, context);
  if (outcomeProof.releaseProvenanceHash !== authority.releaseProvenanceHash
    || outcomeProof.attestationAuthorityRoot !== authority.attestationAuthorityRoot
    || outcomeProof.executorAuthorityRoot !== authority.executorAuthorityRoot
    || outcomeProof.releaseAuthorityRoot !== authority.releaseAuthorityRoot) throw new TypeError("candidate outcome authority mismatch");
  const identity = raw.identityProof === null ? null : validateIdentityProof(raw.identityProof, context);
  if (identity !== null && (identity.releaseProvenanceHash !== authority.releaseProvenanceHash
    || identity.attestationAuthorityRoot !== authority.attestationAuthorityRoot
    || identity.executorAuthorityRoot !== authority.executorAuthorityRoot
    || identity.releaseAuthorityRoot !== authority.releaseAuthorityRoot
    || identity.frameworkAuthorityRoot !== outcomeProof.frameworkAuthorityRoot
    || identity.issuerKeyId !== outcomeProof.issuerKeyId)) throw new TypeError("identity/outcome authority mismatch");
  let normalized: Record<string, unknown>;
  if (kind === "verified") {
    if (identity === null) throw new TypeError("verified identity proof missing");
    const publication = validatePublication(raw.publication, context.candidate, identity.identityObservation, context.cutoff);
    const instanceKey = assertNonEmptyString(raw.instanceKey, "candidateFinalOutcome.instanceKey");
    if (instanceKey !== publication.instanceKey) throw new TypeError("verified instance key mismatch");
    normalized = { kind, runCandidateKey: raw.runCandidateKey, familyCandidateKey: raw.familyCandidateKey, instanceKey, publication, identityProof: identity, outcomeIssuerProof: outcomeProof, ...authority };
  } else if (kind === "chainProvenRejected") {
    const evidence = validateRejectionEvidence(raw.rejectionEvidence);
    const proof = rejectionProofFromEvidence(evidence);
    if (!sameJson(proof, raw.proof)) throw new TypeError("rejection proof is not derived from evidence");
    if (evidence.runId !== context.runId || evidence.chainId !== context.cutoff.chainId || evidence.cutoffNumber !== context.cutoff.number
      || evidence.cutoffHash !== context.cutoff.hash || evidence.cutoffStateRoot !== context.cutoff.stateRoot
      || evidence.familyDefinitionHash !== context.candidate.familyDefinitionHash
      || evidence.familyCandidateKey !== context.candidate.familyCandidateKey
      || evidence.candidateSubjectHash !== context.candidate.candidateSubjectHash
      || evidence.executorAuthorityRoot !== authority.executorAuthorityRoot
      || (evidence.stage === "identity") !== (identity === null)
      || (identity !== null && identity.identitySubjectHash !== evidence.identitySubjectHash)) throw new TypeError("rejection context mismatch");
    normalized = { kind, runCandidateKey: raw.runCandidateKey, familyCandidateKey: raw.familyCandidateKey, proof, rejectionEvidence: evidence, identityProof: identity, outcomeIssuerProof: outcomeProof, ...authority };
  } else {
    normalized = { kind, runCandidateKey: raw.runCandidateKey, familyCandidateKey: raw.familyCandidateKey, failure: failure(raw.failure, kind, context, outcomeProof.frameworkAuthorityRoot), identityProof: identity, outcomeIssuerProof: outcomeProof, ...authority };
  }
  const result = deepFreeze(decodeCanonicalJson(encodeCanonicalBytes(normalized)) as CandidateFinalOutcomeWireV1);
  if (!sameJson(result, value)) throw new TypeError("candidate outcome canonical lineage mismatch");
  if (candidateFinalOutcomeBodyHash(result) !== outcomeProof.outcomeBodyHash) throw new TypeError("candidate outcome proof body hash mismatch");
  return result;
}

export function exactOutcomePartitionRootV1(input: Readonly<{
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly outcomes: readonly CandidateFinalOutcomeWireV1[];
}>): Hash {
  assertNonEmptyString(input.runId, "exactOutcomePartition.runId");
  cutoff(input.cutoff, "exactOutcomePartition.cutoff");
  nonZeroHash(input.candidatePartitionRoot, "exactOutcomePartition.candidatePartitionRoot");
  for (const [key, value] of Object.entries({
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    releaseAuthorityRoot: input.releaseAuthorityRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    executorAuthorityRoot: input.executorAuthorityRoot,
  })) nonZeroHash(value, `exactOutcomePartition.${key}`);
  const outcomes = [...input.outcomes].sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
  if (new Set(outcomes.map(outcome => outcome.familyCandidateKey)).size !== outcomes.length
    || outcomes.some(outcome => outcome.attestationAuthorityRoot !== input.attestationAuthorityRoot
      || outcome.releaseAuthorityRoot !== input.releaseAuthorityRoot
      || outcome.releaseProvenanceHash !== input.releaseProvenanceHash
      || outcome.executorAuthorityRoot !== input.executorAuthorityRoot)) {
    throw new TypeError("exact outcome partition authority/key mismatch");
  }
  return hashDomain("aloha/exact-outcome-partition/v1", {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    releaseAuthorityRoot: input.releaseAuthorityRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    executorAuthorityRoot: input.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
  });
}

export function encodeCandidateFinalOutcomeV1(value: CandidateFinalOutcomeWireV1): Uint8Array {
  return encodeCanonicalBytes(value);
}
