import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeAssetIdentityV1, erc20AssetPortBindingV1 } from "../../../../packages/asset-ref/src/index.ts";
import type {
  ExecutionFactSourceV1,
  ProgramInterpretationDraftV1,
  TransportFactV1,
} from "../../../../packages/capability-interpreters/src/index.ts";
import { asCapabilityId, asCapabilityVersion, asSchemaRef, type SchemaRef } from "../../../../packages/capability-contracts/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilyRuntimeStageV1,
  type FamilyStageDefinitionV1,
  type FamilyStageGenericInvocationV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import type { FrozenProgramEnvelopeV1, ProgramSourceAnchorV1 } from "../../../../packages/request-program/src/index.ts";
import {
  sealInstancePublication,
  validateInstancePublication,
  type AssetPortV1,
  type InstancePublicationV1,
  type StaticTransitionProjectionV1,
} from "../../../../packages/catalog/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
  familyCandidateKey as centralFamilyCandidateKey,
  type CandidateEvidenceRefV1,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../../../packages/discovery/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import {
  EIGENPIE_ASSET_DEPOSIT_TOPIC,
  EIGENPIE_FAMILY_ID,
  EIGENPIE_FAMILY_VERSION,
  EIGENPIE_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../manifest.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "../family-definition.ts";
import { decodeEigenpieAssetDepositHistoryEntries } from "../history-source-plan.ts";
import { verifyEigenpieIdentityStage, identityDescriptorHash } from "../identity.ts";
import { materializeEigenpie } from "../instance.ts";
import { deriveEigenpieRoutes } from "../routes.ts";
import type {
  EigenpieCandidateV1,
  EigenpieCutoffV1,
  EigenpieIdentityV1,
  EigenpieMaterializedStateV1,
} from "../types.ts";

type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
type IdentityMemoV1 = {
  readonly kind: "eigenpie-identity-memo";
  readonly familyId: typeof EIGENPIE_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: EigenpieIdentityV1;
};
type NominationPayloadV1 = {
  readonly kind: "eigenpie-nomination-input";
  readonly candidate: CandidateRecordV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly ["candidate"];
  readonly requestId: Hash;
};
type IdentityPayloadV1 = {
  readonly kind: "eigenpie-identity-input";
  readonly candidate: CandidateRecordV1;
  readonly evidence: CandidateEvidenceRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly ["identity"];
  readonly requestId: Hash;
};
type MaterializationPayloadV1 = {
  readonly kind: "eigenpie-materialization-input";
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly ["state"];
  readonly requestId: Hash;
};
type MaterializationOutputV1 = {
  readonly kind: "eigenpie-materialization-output";
  readonly familyId: typeof EIGENPIE_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly instanceKey: string;
  readonly state: EigenpieMaterializedStateV1;
  readonly evidenceRoot: Hash;
};
type ProjectionPayloadV1 = {
  readonly kind: "eigenpie-projection-input";
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly ["state"];
  readonly requestId: Hash;
};
type RehydrationPayloadV1 = {
  readonly kind: "eigenpie-rehydration-input";
  readonly candidate: CandidateRecordV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly ["reference"];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
};
type NominationOutputV1 = {
  readonly kind: "eigenpie-nomination-verified";
  readonly familyId: typeof EIGENPIE_FAMILY_ID;
  readonly candidateSubjectHash: Hash;
  readonly instanceNominationKey: string;
  readonly cutoff: CanonicalCutoffV1;
};
type IdentityOutputV1 = {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: IdentityMemoV1;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
};
type RehydrationOutputV1 = {
  readonly kind: "eigenpie-rehydration-verified";
  readonly familyId: typeof EIGENPIE_FAMILY_ID;
  readonly instanceNominationKey: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly referenceHash: Hash;
};

const VERSION = asCapabilityVersion(EIGENPIE_FAMILY_VERSION);
const STAGE_IDS = Object.freeze({
  nomination: `family.${EIGENPIE_FAMILY_ID}.nomination`,
  identity: `family.${EIGENPIE_FAMILY_ID}.identity`,
  materialization: `family.${EIGENPIE_FAMILY_ID}.materialization`,
  projection: `family.${EIGENPIE_FAMILY_ID}.projection`,
  rehydration: `family.${EIGENPIE_FAMILY_ID}.rehydration`,
});
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/eigenpie/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/eigenpie/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/eigenpie/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/eigenpie/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/eigenpie/stage-schema/v1", "rehydration"),
});
const READ_PLANS = Object.freeze({
  nomination: Object.freeze(["candidate"] as const),
  identity: Object.freeze(["identity"] as const),
  state: Object.freeze(["state"] as const),
  rehydration: Object.freeze(["reference"] as const),
});

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function address(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(result)) throw new TypeError(`${path} must be an address`);
  return `0x${result.slice(2).toLowerCase()}`;
}

function bytes(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) throw new TypeError(`${path} must be lowercase even-length bytes`);
  return result;
}

function selector(value: unknown, path: string): `0x${string}` {
  const result = bytes(value, path);
  if (!/^0x[0-9a-f]{8}$/.test(result)) throw new TypeError(`${path} must be a four-byte selector`);
  return result as `0x${string}`;
}

function cutoff(value: unknown, path: string): EigenpieCutoffV1 {
  return decodeExactObject<EigenpieCutoffV1>(value, {
    chainId: (item, itemPath) => assertDecimalString(item, itemPath),
    number: (item, itemPath) => assertDecimalString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function source(value: unknown, path: string): ProgramSourceAnchorV1 {
  return decodeExactObject<ProgramSourceAnchorV1>(value, {
    chainId: (item, itemPath) => assertDecimalString(item, itemPath),
    number: (item, itemPath) => assertDecimalString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function factSource(value: unknown, path: string): ExecutionFactSourceV1 {
  return decodeExactObject<ExecutionFactSourceV1>(value, {
    chainId: (item, itemPath) => assertDecimalString(item, itemPath),
    blockNumber: (item, itemPath) => assertDecimalString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
    executorAuthorityRoot: (item, itemPath) => assertHash(item, itemPath),
    workerEpoch: (item, itemPath) => assertNonEmptyString(item, itemPath),
    executorSessionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function sameCutoff(left: EigenpieCutoffV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function candidateRecord(value: unknown, path = "eigenpie.candidate"): CandidateRecordV1 {
  const decoded = decodeExactObject<CandidateRecordV1>(value, {
    kind: (item, itemPath) => item === "aloha.candidate-record" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === "2" ? item : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH) throw new TypeError("eigenpie-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== centralFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("eigenpie-candidate-key-mismatch");
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("eigenpie-candidate-subject-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("eigenpie-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(valueItem => hashDomain("aloha/candidate-evidence-ref/v1", valueItem));
  const sorted = [...evidenceKeys].sort();
  if (new Set(evidenceKeys).size !== evidenceKeys.length || evidenceKeys.some((item, index) => item !== sorted[index])) throw new TypeError("eigenpie-candidate-evidence-order");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("eigenpie-candidate-evidence-root-mismatch");
  if (decoded.evidence.some(item => item.kind === "recent-log" && (address(item.address, `${path}.evidence.address`) !== decoded.instanceNominationKey || item.topic !== EIGENPIE_ASSET_DEPOSIT_TOPIC))) throw new TypeError("eigenpie-recent-evidence-target-topic-mismatch");
  return deepFreeze(decoded);
}

function primaryEvidence(record: CandidateRecordV1): CandidateEvidenceRefV1 {
  const evidence = record.evidence.find(item => item.kind === "source-plan") ?? record.evidence[0];
  if (evidence === undefined) throw new TypeError("eigenpie-candidate-evidence-empty");
  return evidence;
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the eigenpie read contract`);
  return Object.freeze([...result]);
}

function requestId(phase: string, target: string, cutoffValue: CanonicalCutoffV1, subject: Hash, evidenceRoot: Hash, operation: string, evidence: CandidateEvidenceRefV1 | null = null): Hash {
  return hashDomain("aloha/eigenpie/request-id/v2", { phase, target, cutoff: cutoffValue, candidateSubjectHash: subject, candidateEvidenceRoot: evidenceRoot, operation, evidence });
}

function stateRequestId(memo: IdentityMemoV1, cutoffValue: CanonicalCutoffV1): Hash {
  return requestId("materialization", memo.identity.instanceKey, cutoffValue, memo.candidateSnapshotHash, memo.candidateEvidenceRoot, "state");
}

function referenceHash(candidate: CandidateRecordV1, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/eigenpie/rehydration-reference/v2", { familyDefinitionHash: candidate.familyDefinitionHash, familyCandidateKey: candidate.familyCandidateKey, candidateSubjectHash: candidate.candidateSubjectHash, candidateEvidenceRoot: candidate.candidateEvidenceRoot, instanceNominationKey: candidate.instanceNominationKey, cutoff: cutoffValue });
}

function decodeIdentity(value: unknown, path: string): EigenpieIdentityV1 {
  const decoded = decodeExactObject<EigenpieIdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject<EigenpieIdentityV1["facts"]>(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      inputAsset: (field, fieldPath) => address(field, fieldPath),
      outputAsset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.facts.target) throw new TypeError("eigenpie-identity-instance-mismatch");
  if (decoded.factsHash !== hashDomain("aloha/eigenpie/identity-facts/v1", decoded.facts)) throw new TypeError("eigenpie-identity-facts-hash-mismatch");
  return decoded;
}

function identityMemo(value: unknown, path = "eigenpie.identityMemo"): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH) throw new TypeError("eigenpie-identity-definition-mismatch");
  if (decoded.familyCandidateKey !== centralFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("eigenpie-identity-candidate-key-mismatch");
  if (decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.instanceNominationKey !== decoded.identity.instanceKey || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("eigenpie-identity-lineage-mismatch");
  return deepFreeze(decoded);
}

function identityMemoHash(value: IdentityMemoV1): Hash { return hashDomain("aloha/identity-memo/v1", value); }

function assertIdentityCandidate(candidate: CandidateRecordV1, memo: IdentityMemoV1, cutoffValue: CanonicalCutoffV1): void {
  if (memo.familyDefinitionHash !== candidate.familyDefinitionHash || memo.familyCandidateKey !== candidate.familyCandidateKey || memo.instanceNominationKey !== candidate.instanceNominationKey || memo.candidateSnapshotHash !== candidate.candidateSubjectHash || memo.candidateEvidenceRoot !== candidate.candidateEvidenceRoot || !sameCutoff(memo.identity.cutoff, cutoffValue) || memo.identity.instanceKey !== candidate.instanceNominationKey) throw new TypeError("eigenpie-identity-lineage-mismatch");
}

function decodeState(value: unknown, path: string): EigenpieMaterializedStateV1 {
  const decoded = decodeExactObject<EigenpieMaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stateHash !== hashDomain("aloha/eigenpie/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, factsHash: decoded.factsHash })) throw new TypeError("eigenpie-materialized-state-hash-mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "eigenpie.materializationOutput"): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    state: (item, itemPath) => decodeState(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH || decoded.familyCandidateKey !== centralFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.instanceKey !== decoded.instanceNominationKey || decoded.state.instanceKey !== decoded.instanceKey || decoded.state.identityFactsHash !== decoded.identityFactsHash) throw new TypeError("eigenpie-materialization-lineage-mismatch");
  return decoded;
}

function decodeNominationPayload(value: unknown, path = "eigenpie.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    candidate: (item, itemPath) => candidateRecord(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.nomination) as readonly ["candidate"],
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.requestId !== requestId("nomination", decoded.candidate.instanceNominationKey, decoded.cutoff, decoded.candidate.candidateSubjectHash, decoded.candidate.candidateEvidenceRoot, "candidate")) throw new TypeError("eigenpie-nomination-request-mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "eigenpie.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    candidate: (item, itemPath) => candidateRecord(item, itemPath),
    evidence: (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.identity) as readonly ["identity"],
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (!decoded.candidate.evidence.some(item => encodeCanonicalJson(item) === encodeCanonicalJson(decoded.evidence)) || decoded.requestId !== requestId("identity", decoded.candidate.instanceNominationKey, decoded.cutoff, decoded.candidate.candidateSubjectHash, decoded.candidate.candidateEvidenceRoot, "identity", decoded.evidence)) throw new TypeError("eigenpie-identity-request-mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "eigenpie.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state) as readonly ["state"],
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.requestId !== stateRequestId(decoded.identityMemo, decoded.cutoff)) throw new TypeError("eigenpie-materialization-request-mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "eigenpie.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state) as readonly ["state"],
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.materialization.familyCandidateKey !== decoded.identityMemo.familyCandidateKey || decoded.materialization.candidateSnapshotHash !== decoded.identityMemo.candidateSnapshotHash || decoded.materialization.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot || decoded.materialization.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.state.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.identityMemo, decoded.cutoff)) throw new TypeError("eigenpie-projection-lineage-mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "eigenpie.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    candidate: (item, itemPath) => candidateRecord(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.rehydration) as readonly ["reference"],
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.referenceHash !== referenceHash(decoded.candidate, decoded.cutoff) || decoded.requestId !== requestId("rehydration", decoded.candidate.instanceNominationKey, decoded.cutoff, decoded.candidate.candidateSubjectHash, decoded.candidate.candidateEvidenceRoot, decoded.referenceHash)) throw new TypeError("eigenpie-rehydration-reference-mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "eigenpie.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
  }, path);
  if (decoded.candidateSubjectHash !== candidateSubjectHash(EIGENPIE_FAMILY_AUTHORING_HASH, decoded.instanceNominationKey)) throw new TypeError("eigenpie-nomination-output-subject-mismatch");
  return decoded;
}

function decodeIdentityOutput(value: unknown, path = "eigenpie.identityOutput"): IdentityOutputV1 {
  const decoded = decodeExactObject<IdentityOutputV1>(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("eigenpie-identity-output-lineage-mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "eigenpie.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => item === "eigenpie-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.instanceNominationKey === "0x0000000000000000000000000000000000000000") throw new TypeError("eigenpie-rehydration-output-lineage-mismatch");
  return decoded;
}

function assetPort(value: unknown, path: string): AssetPortV1 {
  return decodeExactObject<AssetPortV1>(value, {
    assetIdentity: (item, itemPath) => decodeAssetIdentityV1(item, itemPath),
    assetRef: (item, itemPath) => assertHash(item, itemPath),
    portRef: (item, itemPath) => assertHash(item, itemPath),
    ordinal: (item, itemPath) => assertDecimalString(item, itemPath),
  }, path);
}

function transition(value: unknown, path: string): StaticTransitionProjectionV1 {
  return decodeExactObject<StaticTransitionProjectionV1>(value, {
    inputAssetPorts: (item, itemPath) => fieldArray(item, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    outputAssetPorts: (item, itemPath) => fieldArray(item, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    opaqueTransitionRef: (item, itemPath) => assertHash(item, itemPath),
    constraintRefs: (item, itemPath) => fieldArray(item, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    staticProjectionHash: (item, itemPath) => assertHash(item, itemPath),
    projectionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function decodePublication(value: unknown, path = "eigenpie.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => item === EIGENPIE_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => item === EIGENPIE_FAMILY_AUTHORING_HASH ? item : (() => { throw new TypeError(`${itemPath} definition mismatch`); })(),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    identityMemo: (item, itemPath) => canonical(identityMemo(item, itemPath)),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    staticProjectionMemoHash: (item, itemPath) => assertHash(item, itemPath),
    requestedArtifactDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    validityDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    transitions: (item, itemPath) => fieldArray(item, (entry, entryPath) => transition(entry, entryPath), itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    instancePublicationHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const memo = identityMemo(decoded.identityMemo, `${path}.identityMemo`);
  if (decoded.identityMemoHash !== identityMemoHash(memo) || decoded.instanceKey !== memo.identity.instanceKey || decoded.familyCandidateKey !== memo.familyCandidateKey || decoded.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("eigenpie-publication-identity-mismatch");
  validateInstancePublication(decoded);
  return decoded;
}

function decodeTransportFact(value: unknown, path: string): TransportFactV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be a transport fact`);
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === "returned") return decodeExactObject<Extract<TransportFactV1, { readonly kind: "returned" }>>(value, {
    kind: (item, itemPath) => item === "returned" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
    dataHex: (item, itemPath) => bytes(item, itemPath),
    source: (item, itemPath) => factSource(item, itemPath),
  }, path);
  if (kind === "reverted") return decodeExactObject<Extract<TransportFactV1, { readonly kind: "reverted" }>>(value, {
    kind: (item, itemPath) => item === "reverted" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
    dataHex: (item, itemPath) => bytes(item, itemPath),
    source: (item, itemPath) => factSource(item, itemPath),
  }, path);
  throw new TypeError(`${path} transport failure or unknown fact kind`);
}

function sameSource(left: ExecutionFactSourceV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId && left.blockNumber === right.number && left.blockHash === right.hash && left.stateRoot === right.stateRoot;
}

function boundFacts(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], ids: readonly Hash[]): readonly TransportFactV1[] {
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "eigenpie.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("eigenpie transport request partition mismatch");
  const sourceValue = source(program.source, "eigenpie.program.source");
  const byId = new Map(decoded.map(item => [item.requestId, item] as const));
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`eigenpie missing transport fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, sourceValue)) throw new TypeError("eigenpie transport fact source mismatch");
    return fact;
  }));
}

function returned(fact: TransportFactV1, path: string): Extract<TransportFactV1, { readonly kind: "returned" }> {
  if (fact.kind !== "returned") throw new TypeError(`${path} must be a returned fact`);
  return fact;
}

function assertProgramForStage(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0], stage: CoreStage): void {
  const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES[stage]);
  if (input.program.payloadSchemaRef !== schemaHash || input.program.capabilityRef.capabilityId !== asCapabilityId(STAGE_IDS[stage]) || input.program.capabilityRef.schemaHash !== schemaHash || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes) throw new TypeError(`eigenpie ${stage} program binding mismatch`);
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  if (input.stage !== "nomination") throw new TypeError("eigenpie-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("eigenpie-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "eigenpie.nomination.cutoff");
  const candidate = candidateRecord(input.candidate, "eigenpie.nomination.candidate");
  return Object.freeze({ kind: "eigenpie-nomination-input", candidate, cutoff: cutoffValue, readPlan: READ_PLANS.nomination, requestId: requestId("nomination", candidate.instanceNominationKey, cutoffValue, candidate.candidateSubjectHash, candidate.candidateEvidenceRoot, "candidate") });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  if (input.stage !== "identity") throw new TypeError("eigenpie-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("eigenpie-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "eigenpie.identity.cutoff");
  const candidate = candidateRecord(input.candidate, "eigenpie.identity.candidate");
  const evidence = primaryEvidence(candidate);
  return Object.freeze({ kind: "eigenpie-identity-input", candidate, evidence, cutoff: cutoffValue, readPlan: READ_PLANS.identity, requestId: requestId("identity", candidate.instanceNominationKey, cutoffValue, candidate.candidateSubjectHash, candidate.candidateEvidenceRoot, "identity", evidence) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  if (input.stage !== "materialization") throw new TypeError("eigenpie-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("eigenpie-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "eigenpie.materialization.cutoff");
  const candidate = candidateRecord(input.candidate, "eigenpie.materialization.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityCandidate(candidate, memo, cutoffValue);
  return Object.freeze({ kind: "eigenpie-materialization-input", identityMemo: memo, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(memo, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  if (input.stage !== "projection") throw new TypeError("eigenpie-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("eigenpie-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "eigenpie.projection.cutoff");
  const candidate = candidateRecord(input.candidate, "eigenpie.projection.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityCandidate(candidate, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput);
  if (materialization.familyCandidateKey !== candidate.familyCandidateKey || materialization.candidateSnapshotHash !== candidate.candidateSubjectHash || materialization.evidenceRoot !== candidate.candidateEvidenceRoot || materialization.identityMemoHash !== identityMemoHash(memo) || materialization.identityFactsHash !== memo.identity.factsHash || !sameCutoff(materialization.state.cutoff, cutoffValue)) throw new TypeError("eigenpie-projection-materialization-lineage-mismatch");
  return Object.freeze({ kind: "eigenpie-projection-input", identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(memo, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayloadV1 {
  if (input.stage !== "rehydration") throw new TypeError("eigenpie-rehydration-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("eigenpie-rehydration-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "eigenpie.rehydration.cutoff");
  const candidate = candidateRecord(input.candidate, "eigenpie.rehydration.candidate");
  const ref = referenceHash(candidate, cutoffValue);
  return Object.freeze({ kind: "eigenpie-rehydration-input", candidate, cutoff: cutoffValue, readPlan: READ_PLANS.rehydration, requestId: requestId("rehydration", candidate.instanceNominationKey, cutoffValue, candidate.candidateSubjectHash, candidate.candidateEvidenceRoot, ref), referenceHash: ref });
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : fallback;
}

function factData(value: string): CanonicalJson {
  const encoded = bytes(value, "eigenpie.factData").slice(2);
  const raw = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  return decodeCanonicalJson(new TextDecoder().decode(raw));
}

function identityFact(value: unknown): { readonly candidateSnapshotHash: Hash; readonly candidateEvidenceBytesHex: string; readonly reads: Parameters<typeof verifyEigenpieIdentityStage>[0]["reads"] } {
  return decodeExactObject(value, {
    kind: (item, itemPath) => item === "eigenpie-identity-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? item : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceBytesHex: (item, itemPath) => bytes(item, itemPath),
    reads: (item, itemPath) => decodeExactObject(item, {
      cutoff: (field, fieldPath) => cutoff(field, fieldPath),
      target: (field, fieldPath) => address(field, fieldPath),
      reverseTarget: (field, fieldPath) => address(field, fieldPath),
      inputAsset: (field, fieldPath) => address(field, fieldPath),
      outputAsset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, "eigenpie.identityFact");
}

function hexBytes(value: string, path: string): Uint8Array {
  const encoded = bytes(value, path).slice(2);
  const raw = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  return raw;
}

function blockTag(value: string): string { return `0x${BigInt(value).toString(16)}`; }

function indexedAddress(value: Hash): string | null { return /^0x0{24}[0-9a-f]{40}$/.test(value) ? address(`0x${value.slice(-40)}`, "eigenpie.indexedAddress") : null; }

function candidateFromIdentityEvidence(payload: IdentityPayloadV1, rawBytes: Uint8Array): EigenpieCandidateV1 {
  if (sha256Hex(rawBytes) !== payload.evidence.rawLocatorHash) throw new TypeError("eigenpie-identity-raw-locator-mismatch");
  let blockNumber: string;
  let blockHash: Hash;
  let txHash: Hash;
  let logIndex: string;
  if (payload.evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(rawBytes, "eigenpie.identity.recentEvidence");
    if (raw.blockNumber !== payload.evidence.blockNumber || raw.blockHash !== payload.evidence.blockHash || raw.transactionHash !== payload.evidence.txHash || raw.logIndex !== payload.evidence.logIndex || raw.address !== payload.evidence.address || raw.address !== payload.candidate.instanceNominationKey || raw.topics.length !== 4 || raw.topics[0] !== payload.evidence.topic || raw.topics[0] !== EIGENPIE_ASSET_DEPOSIT_TOPIC || indexedAddress(raw.topics[1]!) === null || indexedAddress(raw.topics[2]!) === null || indexedAddress(raw.topics[3]!) === null || !/^0x(?:[0-9a-f]{64}){3}$/.test(raw.data)) throw new TypeError("eigenpie-recent-evidence-binding-mismatch");
    const depositAmount = BigInt(`0x${raw.data.slice(2, 66)}`);
    const mintedAmount = BigInt(`0x${raw.data.slice(66, 130)}`);
    const isPreDeposit = BigInt(`0x${raw.data.slice(130, 194)}`);
    const cutoffNumber = BigInt(payload.cutoff.number);
    const windowStart = cutoffNumber >= 49n ? cutoffNumber - 49n : 0n;
    if (depositAmount === 0n || mintedAmount === 0n || isPreDeposit !== 0n || BigInt(raw.blockNumber) < windowStart || BigInt(raw.blockNumber) > cutoffNumber) throw new TypeError("eigenpie-recent-evidence-window-mismatch");
    blockNumber = raw.blockNumber; blockHash = raw.blockHash; txHash = raw.transactionHash; logIndex = raw.logIndex;
  } else {
    const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes, "eigenpie.identity.historyEvidence");
    if (observed.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH || observed.plan.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH || observed.plan.ownerRef !== payload.evidence.ownerRef || observed.plan.sourcePlanRef !== payload.evidence.sourcePlanRef || observed.plan.completeness !== "contiguous-history" || observed.plan.historyStartBlock !== "0" || observed.requestSchemaHash !== EIGENPIE_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observed.request.kind !== "family-source-plan-rpc" || observed.request.version !== 1 || observed.request.method !== "eth_getLogs" || observed.request.target !== null || observed.request.manager !== null || observed.request.topic !== EIGENPIE_ASSET_DEPOSIT_TOPIC || observed.cutoff.chainId !== payload.cutoff.chainId || BigInt(observed.cutoff.number) > BigInt(payload.cutoff.number)) throw new TypeError("eigenpie-history-evidence-binding-mismatch");
    const lookback = decodeExactObject(observed.request.lookback, { from: (item, itemPath) => assertDecimalString(item, itemPath), through: (item, itemPath) => assertDecimalString(item, itemPath) }, "eigenpie.identity.historyEvidence.lookback");
    const chunk = decodeExactObject(observed.request.chunk, { maxBlocks: (item, itemPath) => assertDecimalString(item, itemPath) }, "eigenpie.identity.historyEvidence.chunk");
    const filter = Object.freeze({ fromBlock: blockTag(lookback.from), toBlock: blockTag(lookback.through), topics: Object.freeze([EIGENPIE_ASSET_DEPOSIT_TOPIC]) });
    if (chunk.maxBlocks !== "10000" || BigInt(lookback.from) > BigInt(lookback.through) || BigInt(lookback.through) > BigInt(observed.cutoff.number) || encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([filter])) throw new TypeError("eigenpie-history-evidence-request-mismatch");
    const matches = decodeEigenpieAssetDepositHistoryEntries(observed.response, BigInt(lookback.from), BigInt(lookback.through)).filter(entry => entry.target === payload.candidate.instanceNominationKey);
    const match = matches[0];
    if (match === undefined) throw new TypeError("eigenpie-history-evidence-witness-missing");
    blockNumber = match.blockNumber; blockHash = match.blockHash; txHash = match.txHash; logIndex = match.logIndex;
  }
  return Object.freeze({ target: payload.candidate.instanceNominationKey, instanceNominationKey: payload.candidate.instanceNominationKey, candidateSnapshotHash: payload.candidate.candidateSubjectHash, evidence: Object.freeze({ kind: "log", cutoff: payload.cutoff, blockNumber, blockHash, txHash, logIndex, target: payload.candidate.instanceNominationKey, rawLocatorHash: payload.evidence.rawLocatorHash, topic: EIGENPIE_ASSET_DEPOSIT_TOPIC }) });
}

function decodeHashWord(value: string, path: string): Hash {
  const encoded = bytes(value, path);
  if (encoded.length !== 66) throw new TypeError(`${path} must be one ABI word`);
  return assertHash(encoded, path);
}

function ackData(value: Hash): string { return `0x${value.slice(2)}`; }

function identityOutput(identity: EigenpieIdentityV1, candidate: CandidateRecordV1): IdentityOutputV1 {
  const memo: IdentityMemoV1 = Object.freeze({ kind: "eigenpie-identity-memo", familyId: EIGENPIE_FAMILY_ID, familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, familyCandidateKey: candidate.familyCandidateKey, instanceNominationKey: candidate.instanceNominationKey, candidateSnapshotHash: candidate.candidateSubjectHash, candidateEvidenceRoot: candidate.candidateEvidenceRoot, identity });
  return Object.freeze({ kind: "identityVerified", familyInstanceKey: identity.instanceKey, identityMemo: memo, identityMemoHash: identityMemoHash(memo), descriptorHash: identityDescriptorHash(identity), evidenceRoot: candidate.candidateEvidenceRoot });
}

function publication(payload: ProjectionPayloadV1, state: EigenpieMaterializedStateV1): InstancePublicationV1 {
  const route = deriveEigenpieRoutes(payload.identityMemo.identity)[0];
  if (route === undefined) throw new TypeError("eigenpie route derivation returned no route");
  const inputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.inputAsset), portRef: hashDomain("aloha/eigenpie/asset-port/v1", { instanceKey: route.instanceKey, direction: "input", asset: route.inputAsset }), ordinal: "0" };
  const outputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.outputAsset), portRef: hashDomain("aloha/eigenpie/asset-port/v1", { instanceKey: route.instanceKey, direction: "output", asset: route.outputAsset }), ordinal: "0" };
  const transitionBody = { inputAssetPorts: [inputPort], outputAssetPorts: [outputPort], opaqueTransitionRef: hashDomain("aloha/eigenpie/transition/v1", { route, stateHash: state.stateHash }), constraintRefs: [route.routeBindingHash, state.stateHash] };
  const transitionDraft = { ...transitionBody, staticProjectionHash: hashDomain("aloha/static-transition-projection/v1", transitionBody) };
  return sealInstancePublication({ familyId: EIGENPIE_FAMILY_ID, familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, familyCandidateKey: payload.materialization.familyCandidateKey, instanceKey: route.instanceKey, cutoff: payload.cutoff, identityMemo: canonical(payload.identityMemo), identityMemoHash: identityMemoHash(payload.identityMemo), descriptorHash: identityDescriptorHash(payload.identityMemo.identity), staticProjectionMemoHash: hashDomain("aloha/eigenpie/static-projection/v1", { route, state: state.stateHash }), requestedArtifactDependencyRoot: hashDomain("aloha/eigenpie/requested-artifacts/v1", { identityFactsHash: payload.identityMemo.identity.factsHash, stateHash: state.stateHash }), validityDependencyRoot: hashDomain("aloha/eigenpie/validity/v1", { source: payload.cutoff, stateHash: state.stateHash }), transitions: [transitionDraft], evidenceRoot: payload.materialization.evidenceRoot });
}

type StageInputV1 = Parameters<FamilyStageDefinitionV1["interpret"]>[0];

function interpretNomination(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "nomination"); const payload = decodeNominationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "eigenpie.nomination"); if (fact.dataHex !== ackData(payload.candidate.candidateSubjectHash)) throw new TypeError("eigenpie-nomination-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "eigenpie-nomination-verified", familyId: EIGENPIE_FAMILY_ID, candidateSubjectHash: payload.candidate.candidateSubjectHash, instanceNominationKey: payload.candidate.instanceNominationKey, cutoff: payload.cutoff }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "eigenpie-nomination-invalid") }); }
}

function interpretIdentity(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "identity");
    const payload = decodeIdentityPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "eigenpie.identity");
    const decoded = identityFact(factData(fact.dataHex));
    if (decoded.candidateSnapshotHash !== payload.candidate.candidateSubjectHash || !sameCutoff(decoded.reads.cutoff, payload.cutoff)) throw new TypeError("eigenpie-identity-fact-lineage-mismatch");
    const candidate = candidateFromIdentityEvidence(payload, hexBytes(decoded.candidateEvidenceBytesHex, "eigenpie.identityFact.candidateEvidenceBytesHex"));
    const result = verifyEigenpieIdentityStage({ candidate, reads: decoded.reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: identityOutput(result.identity, payload.candidate) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "eigenpie-identity-invalid") }); }
}

function materializationOutput(payload: MaterializationPayloadV1, state: EigenpieMaterializedStateV1): MaterializationOutputV1 {
  return Object.freeze({ kind: "eigenpie-materialization-output", familyId: EIGENPIE_FAMILY_ID, familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, familyCandidateKey: payload.identityMemo.familyCandidateKey, instanceNominationKey: payload.identityMemo.instanceNominationKey, candidateSnapshotHash: payload.identityMemo.candidateSnapshotHash, identityMemoHash: identityMemoHash(payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, instanceKey: state.instanceKey, state, evidenceRoot: payload.identityMemo.candidateEvidenceRoot });
}

function interpretMaterialization(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "materialization");
    const payload = decodeMaterializationPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "eigenpie.materialization.state");
    const result = materializeEigenpie({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      factsHash: decodeHashWord(fact.dataHex, "eigenpie.materialization.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: materializationOutput(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "eigenpie-materialization-invalid") }); }
}

function interpretProjection(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "projection");
    const payload = decodeProjectionPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "eigenpie.projection.state");
    const result = materializeEigenpie({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      factsHash: decodeHashWord(fact.dataHex, "eigenpie.projection.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("eigenpie-projection-state-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "eigenpie-projection-invalid") }); }
}

function interpretRehydration(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "rehydration"); const payload = decodeRehydrationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "eigenpie.rehydration.reference"); if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("eigenpie-rehydration-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "eigenpie-rehydration-verified", familyId: EIGENPIE_FAMILY_ID, instanceNominationKey: payload.candidate.instanceNominationKey, cutoff: payload.cutoff, referenceHash: payload.referenceHash }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "eigenpie-rehydration-invalid") }); }
}

function definitionBase(stage: CoreStage, payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown }, outputSchemaRef: Hash, outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson }, prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"], interpret: FamilyStageDefinitionV1["interpret"]): FamilyStageDefinitionV1 {
  return deepFreeze({ stage, capabilityId: asCapabilityId(STAGE_IDS[stage]), version: VERSION, schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]), payloadCodec: deepFreeze(payloadCodec), dependencyIds: Object.freeze([]), outputSchemaRef, implementationClosureHash: hashDomain("aloha/eigenpie/runtime-implementation/v1", { stage, module: "families/eigenpie/src/runtime/definitions.ts" }), outputCodecHash: hashDomain("aloha/eigenpie/runtime-output-codec/v1", stage), outputCodec: deepFreeze(outputCodec), prepareIssueValue, interpret });
}

const nominationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.nomination), decodeExact: (value: unknown) => decodeNominationPayload(value) });
const identityPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity), decodeExact: (value: unknown) => decodeIdentityPayload(value) });
const materializationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization), decodeExact: (value: unknown) => decodeMaterializationPayload(value) });
const projectionPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection), decodeExact: (value: unknown) => decodeProjectionPayload(value) });
const rehydrationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.rehydration), decodeExact: (value: unknown) => decodeRehydrationPayload(value) });

export const EIGENPIE_NOMINATION_DEFINITION = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/eigenpie/runtime-output-schema/v1", "nomination"), { decodeExact: value => canonical(decodeNominationOutput(value)) }, prepareNomination, interpretNomination);
export const EIGENPIE_IDENTITY_DEFINITION = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/eigenpie/runtime-output-schema/v1", "identity"), { decodeExact: value => canonical(decodeIdentityOutput(value)) }, prepareIdentity, interpretIdentity);
export const EIGENPIE_MATERIALIZATION_DEFINITION = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/eigenpie/runtime-output-schema/v1", "materialization"), { decodeExact: value => canonical(decodeMaterializationOutput(value)) }, prepareMaterialization, interpretMaterialization);
export const EIGENPIE_PROJECTION_DEFINITION = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/eigenpie/runtime-output-schema/v1", "projection"), { decodeExact: value => canonical(decodePublication(value)) }, prepareProjection, interpretProjection);
export const EIGENPIE_REHYDRATION_DEFINITION = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/eigenpie/runtime-output-schema/v1", "rehydration"), { decodeExact: value => canonical(decodeRehydrationOutput(value)) }, prepareRehydration, interpretRehydration);
export const EIGENPIE_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([EIGENPIE_NOMINATION_DEFINITION, EIGENPIE_IDENTITY_DEFINITION, EIGENPIE_MATERIALIZATION_DEFINITION, EIGENPIE_PROJECTION_DEFINITION, EIGENPIE_REHYDRATION_DEFINITION]);
export const EIGENPIE_STAGE_IDS = STAGE_IDS;
export function requireEigenpieStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 { const definition = EIGENPIE_STAGE_DEFINITIONS.find(item => item.stage === stage); if (definition === undefined) throw new TypeError(`eigenpie stage definition missing: ${stage}`); return definition; }
