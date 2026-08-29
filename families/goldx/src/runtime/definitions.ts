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
import type {
  FamilyRuntimeStageV1,
  FamilyStageDefinitionV1,
  FamilyStageGenericInvocationV1,
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
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
  familyCandidateKey as discoveryFamilyCandidateKey,
  type CanonicalCutoffV1,
  type RecentLogEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  GOLDX_FAMILY_ID,
  GOLDX_FAMILY_VERSION,
} from "../manifest.ts";
import { GOLDX_FAMILY_AUTHORING_HASH } from "../family-definition.ts";
import { candidateSnapshotHash, decodeGoldxCandidate } from "../discovery.ts";
import { nominateGoldx } from "../nomination.ts";
import { verifyGoldxIdentityStage, identityDescriptorHash } from "../identity.ts";
import { materializeGoldx } from "../instance.ts";
import { deriveGoldxRoutes } from "../routes.ts";
import type {
  GoldxCandidateV1,
  GoldxCutoffV1,
  GoldxIdentityV1,
  GoldxMaterializedStateV1,
  GoldxObservationV1,
} from "../types.ts";

type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
type CandidateRecordV1 = {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: readonly RecentLogEvidenceRefV1[];
};
type CandidateBindingV1 = {
  readonly familyId: typeof GOLDX_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly instanceNominationKey: string;
  readonly candidate: GoldxCandidateV1;
};
type IdentityMemoV1 = {
  readonly kind: "goldx-identity-memo";
  readonly familyId: typeof GOLDX_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly identity: GoldxIdentityV1;
};
type NominationPayloadV1 = {
  readonly kind: "goldx-nomination-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: GoldxCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type IdentityPayloadV1 = {
  readonly kind: "goldx-identity-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: GoldxCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
};
type MaterializationPayloadV1 = {
  readonly kind: "goldx-materialization-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: GoldxCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type MaterializationOutputV1 = {
  readonly kind: "goldx-materialization-output";
  readonly binding: CandidateBindingV1;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: GoldxCutoffV1;
  readonly state: GoldxMaterializedStateV1;
};
type ProjectionPayloadV1 = {
  readonly kind: "goldx-projection-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: GoldxCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type RehydrationPayloadV1 = {
  readonly kind: "goldx-rehydration-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: GoldxCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
};
type NominationOutputV1 = {
  readonly kind: "goldx-nomination-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: GoldxCutoffV1;
  readonly requestId: Hash;
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
  readonly kind: "goldx-rehydration-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: GoldxCutoffV1;
  readonly instanceKey: string;
  readonly referenceHash: Hash;
  readonly requestId: Hash;
};

const VERSION = asCapabilityVersion(GOLDX_FAMILY_VERSION);
const STAGE_IDS = Object.freeze({
  nomination: `family.${GOLDX_FAMILY_ID}.nomination`,
  identity: `family.${GOLDX_FAMILY_ID}.identity`,
  materialization: `family.${GOLDX_FAMILY_ID}.materialization`,
  projection: `family.${GOLDX_FAMILY_ID}.projection`,
  rehydration: `family.${GOLDX_FAMILY_ID}.rehydration`,
});
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/goldx/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/goldx/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/goldx/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/goldx/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/goldx/stage-schema/v1", "rehydration"),
});
const READ_PLANS = Object.freeze({
  nomination: Object.freeze(["evidence"]),
  identity: Object.freeze(["target", "reverseTarget", "inputAsset", "outputAsset"]),
  state: Object.freeze(["state"]),
  rehydration: Object.freeze(["reference"]),
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

function cutoff(value: unknown, path: string): GoldxCutoffV1 {
  return decodeExactObject<GoldxCutoffV1>(value, {
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

function sameCutoff(left: GoldxCutoffV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function recentEvidence(value: unknown, path: string): RecentLogEvidenceRefV1 {
  const decoded = decodeCandidateEvidenceRef(value, path);
  if (decoded.kind !== "recent-log") throw new TypeError(`${path} must be a recent log`);
  return decoded;
}

function observation(evidence: RecentLogEvidenceRefV1, cutoffValue: GoldxCutoffV1): GoldxObservationV1 {
  return Object.freeze({
    kind: "log",
    cutoff: cutoffValue,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    txHash: evidence.txHash,
    logIndex: evidence.logIndex,
    target: address(evidence.address, "candidate.evidence.address"),
    topic: evidence.topic,
    rawLocatorHash: evidence.rawLocatorHash,
  });
}

function internalCandidate(evidence: RecentLogEvidenceRefV1, cutoffValue: GoldxCutoffV1): GoldxCandidateV1 {
  const observed = observation(evidence, cutoffValue);
  const seed = decodeGoldxCandidate(observed, "goldx-call");
  if (seed === null) throw new TypeError("goldx-candidate-evidence-pattern-mismatch");
  const nominated = nominateGoldx(seed);
  if (nominated.status !== "nominated") throw new TypeError(`goldx-candidate-${nominated.reasonCode}`);
  return nominated.candidate;
}

function candidateRecord(value: unknown, path = "goldx.candidate"): CandidateRecordV1 {
  const decoded = decodeExactObject<CandidateRecordV1>(value, {
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => recentEvidence(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyId !== GOLDX_FAMILY_ID) throw new TypeError("goldx-candidate-family-mismatch");
  if (decoded.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH) throw new TypeError("goldx-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("goldx-candidate-key-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("goldx-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(valueItem => hashDomain("aloha/candidate-evidence-ref/v1", valueItem));
  const sorted = [...evidenceKeys].sort();
  if (new Set(evidenceKeys).size !== evidenceKeys.length || evidenceKeys.some((item, index) => item !== sorted[index])) throw new TypeError("goldx-candidate-evidence-order");
  return deepFreeze(decoded);
}

function candidateBindingFromRecord(value: unknown, cutoffValue: GoldxCutoffV1, path: string): CandidateBindingV1 {
  const record = candidateRecord(value, path);
  let selected: GoldxCandidateV1 | null = null;
  for (const evidence of record.evidence) {
    const candidate = internalCandidate(evidence, cutoffValue);
    if (candidate.instanceNominationKey !== record.instanceNominationKey || candidate.candidateSnapshotHash !== record.candidateSnapshotHash) throw new TypeError("goldx-candidate-lineage-mismatch");
    if (selected !== null && encodeCanonicalJson(selected) !== encodeCanonicalJson(candidate)) throw new TypeError("goldx-candidate-snapshot-duplicate");
    selected = candidate;
  }
  if (selected === null) throw new TypeError("goldx-candidate-missing");
  return Object.freeze({
    familyId: GOLDX_FAMILY_ID,
    familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSnapshotHash,
    instanceNominationKey: record.instanceNominationKey,
    candidate: selected,
  });
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the goldx read contract`);
  return Object.freeze([...result]);
}

function hashes(value: unknown, path: string, expected?: readonly Hash[]): readonly Hash[] {
  const result = fieldArray(value, (item, itemPath) => assertHash(item, itemPath), path);
  if (expected !== undefined && (result.length !== expected.length || result.some((item, index) => item !== expected[index]))) throw new TypeError(`${path} request ids do not match the goldx source plan`);
  return Object.freeze([...result]);
}

function identityRequestId(target: string, cutoffValue: GoldxCutoffV1, operation: string): Hash {
  return hashDomain("aloha/goldx/request-id/v1", { phase: "identity", target, operation, cutoff: cutoffValue });
}

function stateRequestId(target: string, cutoffValue: GoldxCutoffV1): Hash {
  return hashDomain("aloha/goldx/request-id/v1", { phase: "materialization", target, operation: "state", cutoff: cutoffValue });
}

function nominationRequestId(binding: CandidateBindingV1, cutoffValue: GoldxCutoffV1): Hash {
  return hashDomain("aloha/goldx/request-id/v1", { phase: "nomination", target: binding.candidate.target, candidateSnapshotHash: binding.candidateSnapshotHash, cutoff: cutoffValue });
}

function referenceHash(binding: CandidateBindingV1, cutoffValue: GoldxCutoffV1): Hash {
  return hashDomain("aloha/goldx/rehydration-reference/v1", { familyDefinitionHash: binding.familyDefinitionHash, familyCandidateKey: binding.familyCandidateKey, candidateSnapshotHash: binding.candidateSnapshotHash, instanceKey: binding.candidate.target, cutoff: cutoffValue });
}

function rehydrationRequestId(binding: CandidateBindingV1, cutoffValue: GoldxCutoffV1): Hash {
  return hashDomain("aloha/goldx/request-id/v1", { phase: "rehydration", target: binding.candidate.target, referenceHash: referenceHash(binding, cutoffValue), cutoff: cutoffValue });
}

function decodeIdentity(value: unknown, path: string): GoldxIdentityV1 {
  const decoded = decodeExactObject<GoldxIdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject<GoldxIdentityV1["facts"]>(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      inputAsset: (field, fieldPath) => address(field, fieldPath),
      outputAsset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.facts.target) throw new TypeError("goldx-identity-instance-mismatch");
  if (decoded.factsHash !== hashDomain("aloha/goldx/identity-facts/v1", decoded.facts)) throw new TypeError("goldx-identity-facts-hash-mismatch");
  return decoded;
}

function identityMemo(value: unknown, path = "goldx.identityMemo"): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => item === "goldx-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === GOLDX_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH) throw new TypeError("goldx-identity-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("goldx-identity-candidate-key-mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("goldx-identity-lineage-mismatch");
  return deepFreeze(decoded);
}

function identityMemoHash(value: IdentityMemoV1): Hash { return hashDomain("aloha/identity-memo/v1", value); }

function candidateBindingFromInternal(candidate: GoldxCandidateV1, cutoffValue: GoldxCutoffV1): CandidateBindingV1 {
  if (!sameCutoff(candidate.evidence.cutoff, cutoffValue)) throw new TypeError("goldx-candidate-cutoff-mismatch");
  const seed = decodeGoldxCandidate(candidate.evidence, "goldx-call");
  if (seed === null) throw new TypeError("goldx-candidate-evidence-pattern-mismatch");
  const nominated = nominateGoldx(seed);
  if (nominated.status !== "nominated") throw new TypeError(`goldx-candidate-${nominated.reasonCode}`);
  if (encodeCanonicalJson(nominated.candidate) !== encodeCanonicalJson(candidate)) throw new TypeError("goldx-candidate-reconstruction-mismatch");
  return Object.freeze({
    familyId: GOLDX_FAMILY_ID,
    familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH,
    familyCandidateKey: discoveryFamilyCandidateKey(GOLDX_FAMILY_AUTHORING_HASH, candidate.instanceNominationKey),
    candidateSnapshotHash: candidate.candidateSnapshotHash,
    instanceNominationKey: candidate.instanceNominationKey,
    candidate,
  });
}

function assertCandidateBinding(binding: CandidateBindingV1, cutoffValue: GoldxCutoffV1): void {
  const expected = candidateBindingFromInternal(binding.candidate, cutoffValue);
  if (expected.familyId !== binding.familyId || expected.familyDefinitionHash !== binding.familyDefinitionHash || expected.familyCandidateKey !== binding.familyCandidateKey || expected.candidateSnapshotHash !== binding.candidateSnapshotHash || expected.instanceNominationKey !== binding.instanceNominationKey) throw new TypeError("goldx-candidate-binding-mismatch");
}

function assertIdentityBinding(binding: CandidateBindingV1, memo: IdentityMemoV1, cutoffValue: GoldxCutoffV1): void {
  assertCandidateBinding(binding, cutoffValue);
  if (memo.familyId !== binding.familyId || memo.familyDefinitionHash !== binding.familyDefinitionHash || memo.familyCandidateKey !== binding.familyCandidateKey || memo.instanceNominationKey !== binding.instanceNominationKey || memo.candidateSnapshotHash !== binding.candidateSnapshotHash || !sameCutoff(memo.identity.cutoff, cutoffValue) || memo.identity.instanceKey !== binding.candidate.target) throw new TypeError("goldx-identity-lineage-mismatch");
}

function decodeState(value: unknown, path: string): GoldxMaterializedStateV1 {
  const decoded = decodeExactObject<GoldxMaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    unitWad: (item, itemPath) => assertDecimalString(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (BigInt(decoded.unitWad) <= 0n || decoded.stateHash !== hashDomain("aloha/goldx/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, unitWad: decoded.unitWad })) throw new TypeError("goldx-materialized-state-hash-mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "goldx.materializationOutput"): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => item === "goldx-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    state: (item, itemPath) => decodeState(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (!sameCutoff(decoded.state.cutoff, decoded.cutoff) || decoded.state.instanceKey !== decoded.binding.candidate.target || decoded.state.identityFactsHash !== decoded.identityFactsHash) throw new TypeError("goldx-materialization-lineage-mismatch");
  return decoded;
}

function decodeBinding(value: unknown, path: string): CandidateBindingV1 {
  return decodeExactObject<CandidateBindingV1>(value, {
    familyId: (item, itemPath) => item === GOLDX_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidate: (item, itemPath) => {
      const candidate = decodeExactObject<GoldxCandidateV1>(item, {
        target: (field, fieldPath) => address(field, fieldPath),
        instanceNominationKey: (field, fieldPath) => address(field, fieldPath),
        candidateSnapshotHash: (field, fieldPath) => assertHash(field, fieldPath),
        evidence: (field, fieldPath) => decodeExactObject<GoldxObservationV1>(field, {
          kind: (entry, entryPath) => entry === "log" || entry === "call" || entry === "address-surface" ? entry : (() => { throw new TypeError(`${entryPath} kind mismatch`); })(),
          cutoff: (entry, entryPath) => cutoff(entry, entryPath),
          blockNumber: (entry, entryPath) => assertDecimalString(entry, entryPath),
          blockHash: (entry, entryPath) => assertHash(entry, entryPath),
          txHash: (entry, entryPath) => assertHash(entry, entryPath),
          logIndex: (entry, entryPath) => assertDecimalString(entry, entryPath),
          target: (entry, entryPath) => address(entry, entryPath),
          topic: (entry, entryPath) => entry === null ? null : assertHash(entry, entryPath),
          rawLocatorHash: (entry, entryPath) => assertHash(entry, entryPath),
        }, fieldPath),
      }, itemPath);
      if (candidate.target !== candidate.evidence.target || candidate.instanceNominationKey !== candidate.target || candidate.candidateSnapshotHash !== candidateSnapshotHash(candidate.evidence)) throw new TypeError("goldx-binding-candidate-mismatch");
      return candidate;
    },
  }, path);
}

function decodeNominationPayload(value: unknown, path = "goldx.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => item === "goldx-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.nomination),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("goldx-nomination-request-mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "goldx.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => item === "goldx-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.identity),
    requestIds: (item, itemPath) => hashes(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  const expected = READ_PLANS.identity.map(operation => identityRequestId(decoded.binding.candidate.target, decoded.cutoff, operation));
  if (decoded.requestIds.length !== expected.length || decoded.requestIds.some((item, index) => item !== expected[index])) throw new TypeError("goldx-identity-request-mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "goldx.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => item === "goldx-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("goldx-materialization-request-mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "goldx.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => item === "goldx-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("goldx-projection-lineage-mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "goldx.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => item === "goldx-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.rehydration),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== referenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("goldx-rehydration-reference-mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "goldx.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => item === "goldx-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("goldx-nomination-output-request-mismatch");
  return decoded;
}

function decodeIdentityOutput(value: unknown, path = "goldx.identityOutput"): IdentityOutputV1 {
  const decoded = decodeExactObject<IdentityOutputV1>(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateSnapshotHash) throw new TypeError("goldx-identity-output-lineage-mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "goldx.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => item === "goldx-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.candidate.target || decoded.referenceHash !== referenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("goldx-rehydration-output-lineage-mismatch");
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

function decodePublication(value: unknown, path = "goldx.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => item === GOLDX_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => item === GOLDX_FAMILY_AUTHORING_HASH ? item : (() => { throw new TypeError(`${itemPath} definition mismatch`); })(),
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
  if (decoded.identityMemoHash !== identityMemoHash(memo) || decoded.instanceKey !== memo.identity.instanceKey) throw new TypeError("goldx-publication-identity-mismatch");
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
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "goldx.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("goldx transport request partition mismatch");
  const sourceValue = source(program.source, "goldx.program.source");
  const byId = new Map(decoded.map(item => [item.requestId, item] as const));
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`goldx missing transport fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, sourceValue)) throw new TypeError("goldx transport fact source mismatch");
    return fact;
  }));
}

function returned(fact: TransportFactV1, path: string): Extract<TransportFactV1, { readonly kind: "returned" }> {
  if (fact.kind !== "returned") throw new TypeError(`${path} must be a returned fact`);
  return fact;
}

function assertProgramForStage(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0], stage: CoreStage): void {
  const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES[stage]);
  if (input.program.payloadSchemaRef !== schemaHash || input.program.capabilityRef.capabilityId !== asCapabilityId(STAGE_IDS[stage]) || input.program.capabilityRef.schemaHash !== schemaHash || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes) throw new TypeError(`goldx ${stage} program binding mismatch`);
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  if (input.stage !== "nomination") throw new TypeError("goldx-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("goldx-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "goldx.nomination.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "goldx.nomination.candidate");
  return Object.freeze({ kind: "goldx-nomination-input", binding, cutoff: cutoffValue, readPlan: READ_PLANS.nomination, requestId: nominationRequestId(binding, cutoffValue) });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  if (input.stage !== "identity") throw new TypeError("goldx-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("goldx-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "goldx.identity.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "goldx.identity.candidate");
  return Object.freeze({ kind: "goldx-identity-input", binding, cutoff: cutoffValue, readPlan: READ_PLANS.identity, requestIds: READ_PLANS.identity.map(operation => identityRequestId(binding.candidate.target, cutoffValue, operation)) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  if (input.stage !== "materialization") throw new TypeError("goldx-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("goldx-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "goldx.materialization.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "goldx.materialization.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityBinding(binding, memo, cutoffValue);
  return Object.freeze({ kind: "goldx-materialization-input", binding, identityMemo: memo, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  if (input.stage !== "projection") throw new TypeError("goldx-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("goldx-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "goldx.projection.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "goldx.projection.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityBinding(binding, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput);
  if (materialization.binding.familyCandidateKey !== binding.familyCandidateKey || materialization.identityMemoHash !== identityMemoHash(memo) || materialization.identityFactsHash !== memo.identity.factsHash || !sameCutoff(materialization.cutoff, cutoffValue)) throw new TypeError("goldx-projection-materialization-lineage-mismatch");
  return Object.freeze({ kind: "goldx-projection-input", binding, identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayloadV1 {
  if (input.stage !== "rehydration") throw new TypeError("goldx-rehydration-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("goldx-rehydration-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "goldx.rehydration.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "goldx.rehydration.candidate");
  const ref = referenceHash(binding, cutoffValue);
  return Object.freeze({ kind: "goldx-rehydration-input", binding, cutoff: cutoffValue, readPlan: READ_PLANS.rehydration, requestId: rehydrationRequestId(binding, cutoffValue), referenceHash: ref });
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : fallback;
}

function decodeAddressWord(value: string, path: string): string {
  const encoded = bytes(value, path);
  if (encoded.length !== 66 || !/^0+$/.test(encoded.slice(2, 26))) throw new TypeError(`${path} must be a canonical ABI address word`);
  return address(`0x${encoded.slice(-40)}`, path);
}

function decodeHashWord(value: string, path: string): Hash {
  const encoded = bytes(value, path);
  if (encoded.length !== 66) throw new TypeError(`${path} must be one ABI word`);
  return assertHash(encoded, path);
}

function ackData(value: Hash): string { return `0x${value.slice(2)}`; }
function decodeUintWord(value: string, path: string): string {
  const encoded = bytes(value, path);
  if (encoded.length !== 66) throw new TypeError(`${path} must be one ABI word`);
  return assertDecimalString(BigInt(encoded).toString(10), path);
}

function identityOutput(identity: GoldxIdentityV1, binding: CandidateBindingV1): IdentityOutputV1 {
  const memo: IdentityMemoV1 = Object.freeze({ kind: "goldx-identity-memo", familyId: GOLDX_FAMILY_ID, familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH, familyCandidateKey: binding.familyCandidateKey, instanceNominationKey: binding.instanceNominationKey, candidateSnapshotHash: binding.candidateSnapshotHash, identity });
  return Object.freeze({ kind: "identityVerified", familyInstanceKey: identity.instanceKey, identityMemo: memo, identityMemoHash: identityMemoHash(memo), descriptorHash: identityDescriptorHash(identity), evidenceRoot: binding.candidateSnapshotHash });
}

function publication(payload: ProjectionPayloadV1, state: GoldxMaterializedStateV1): InstancePublicationV1 {
  const route = deriveGoldxRoutes(payload.identityMemo.identity)[0];
  if (route === undefined) throw new TypeError("goldx route derivation returned no route");
  const inputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.inputAsset), portRef: hashDomain("aloha/goldx/asset-port/v1", { instanceKey: route.instanceKey, direction: "input", asset: route.inputAsset }), ordinal: "0" };
  const outputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.outputAsset), portRef: hashDomain("aloha/goldx/asset-port/v1", { instanceKey: route.instanceKey, direction: "output", asset: route.outputAsset }), ordinal: "0" };
  const transitionBody = { inputAssetPorts: [inputPort], outputAssetPorts: [outputPort], opaqueTransitionRef: hashDomain("aloha/goldx/transition/v1", { route, stateHash: state.stateHash }), constraintRefs: [route.routeBindingHash, state.stateHash] };
  const transitionDraft = { ...transitionBody, staticProjectionHash: hashDomain("aloha/static-transition-projection/v1", transitionBody) };
  return sealInstancePublication({ familyId: GOLDX_FAMILY_ID, familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH, familyCandidateKey: payload.binding.familyCandidateKey, instanceKey: route.instanceKey, cutoff: payload.cutoff, identityMemo: canonical(payload.identityMemo), identityMemoHash: identityMemoHash(payload.identityMemo), descriptorHash: identityDescriptorHash(payload.identityMemo.identity), staticProjectionMemoHash: hashDomain("aloha/goldx/static-projection/v1", { route, state: state.stateHash }), requestedArtifactDependencyRoot: hashDomain("aloha/goldx/requested-artifacts/v1", { identityFactsHash: payload.identityMemo.identity.factsHash, stateHash: state.stateHash }), validityDependencyRoot: hashDomain("aloha/goldx/validity/v1", { source: payload.cutoff, stateHash: state.stateHash }), transitions: [transitionDraft], evidenceRoot: payload.binding.candidateSnapshotHash });
}

type StageInputV1 = Parameters<FamilyStageDefinitionV1["interpret"]>[0];

function interpretNomination(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "nomination"); const payload = decodeNominationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "goldx.nomination"); if (fact.dataHex !== ackData(payload.binding.candidateSnapshotHash)) throw new TypeError("goldx-nomination-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "goldx-nomination-verified", binding: payload.binding, cutoff: payload.cutoff, requestId: payload.requestId }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "goldx-nomination-invalid") }); }
}

function interpretIdentity(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "identity");
    const payload = decodeIdentityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const result = verifyGoldxIdentityStage({ candidate: payload.binding.candidate, reads: {
      cutoff: payload.cutoff,
      target: decodeAddressWord(returned(facts[0]!, "goldx.identity.target").dataHex, "goldx.identity.target"),
      reverseTarget: decodeAddressWord(returned(facts[1]!, "goldx.identity.reverseTarget").dataHex, "goldx.identity.reverseTarget"),
      inputAsset: decodeAddressWord(returned(facts[2]!, "goldx.identity.inputAsset").dataHex, "goldx.identity.inputAsset"),
      outputAsset: decodeAddressWord(returned(facts[3]!, "goldx.identity.outputAsset").dataHex, "goldx.identity.outputAsset"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: identityOutput(result.identity, payload.binding) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "goldx-identity-invalid") }); }
}

function materializationOutput(payload: MaterializationPayloadV1, state: GoldxMaterializedStateV1): MaterializationOutputV1 {
  return Object.freeze({ kind: "goldx-materialization-output", binding: payload.binding, identityMemoHash: identityMemoHash(payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, cutoff: payload.cutoff, state });
}

function interpretMaterialization(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "materialization");
    const payload = decodeMaterializationPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "goldx.materialization.state");
    const result = materializeGoldx({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      unitWad: decodeUintWord(fact.dataHex, "goldx.materialization.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: materializationOutput(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "goldx-materialization-invalid") }); }
}

function interpretProjection(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "projection");
    const payload = decodeProjectionPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "goldx.projection.state");
    const result = materializeGoldx({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      unitWad: decodeUintWord(fact.dataHex, "goldx.projection.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("goldx-projection-state-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "goldx-projection-invalid") }); }
}

function interpretRehydration(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "rehydration"); const payload = decodeRehydrationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "goldx.rehydration.reference"); if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("goldx-rehydration-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "goldx-rehydration-verified", binding: payload.binding, cutoff: payload.cutoff, instanceKey: payload.binding.candidate.target, referenceHash: payload.referenceHash, requestId: payload.requestId }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "goldx-rehydration-invalid") }); }
}

function definitionBase(stage: CoreStage, payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown }, outputSchemaRef: Hash, outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson }, prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"], interpret: FamilyStageDefinitionV1["interpret"]): FamilyStageDefinitionV1 {
  return deepFreeze({ stage, capabilityId: asCapabilityId(STAGE_IDS[stage]), version: VERSION, schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]), payloadCodec: deepFreeze(payloadCodec), dependencyIds: Object.freeze([]), outputSchemaRef, implementationClosureHash: hashDomain("aloha/goldx/runtime-implementation/v1", { stage, module: "families/goldx/src/runtime/definitions.ts" }), outputCodecHash: hashDomain("aloha/goldx/runtime-output-codec/v1", stage), outputCodec: deepFreeze(outputCodec), prepareIssueValue, interpret });
}

const nominationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.nomination), decodeExact: (value: unknown) => decodeNominationPayload(value) });
const identityPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity), decodeExact: (value: unknown) => decodeIdentityPayload(value) });
const materializationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization), decodeExact: (value: unknown) => decodeMaterializationPayload(value) });
const projectionPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection), decodeExact: (value: unknown) => decodeProjectionPayload(value) });
const rehydrationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.rehydration), decodeExact: (value: unknown) => decodeRehydrationPayload(value) });

export const GOLDX_NOMINATION_DEFINITION = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/goldx/runtime-output-schema/v1", "nomination"), { decodeExact: value => canonical(decodeNominationOutput(value)) }, prepareNomination, interpretNomination);
export const GOLDX_IDENTITY_DEFINITION = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/goldx/runtime-output-schema/v1", "identity"), { decodeExact: value => canonical(decodeIdentityOutput(value)) }, prepareIdentity, interpretIdentity);
export const GOLDX_MATERIALIZATION_DEFINITION = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/goldx/runtime-output-schema/v1", "materialization"), { decodeExact: value => canonical(decodeMaterializationOutput(value)) }, prepareMaterialization, interpretMaterialization);
export const GOLDX_PROJECTION_DEFINITION = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/goldx/runtime-output-schema/v1", "projection"), { decodeExact: value => canonical(decodePublication(value)) }, prepareProjection, interpretProjection);
export const GOLDX_REHYDRATION_DEFINITION = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/goldx/runtime-output-schema/v1", "rehydration"), { decodeExact: value => canonical(decodeRehydrationOutput(value)) }, prepareRehydration, interpretRehydration);
export const GOLDX_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([GOLDX_NOMINATION_DEFINITION, GOLDX_IDENTITY_DEFINITION, GOLDX_MATERIALIZATION_DEFINITION, GOLDX_PROJECTION_DEFINITION, GOLDX_REHYDRATION_DEFINITION]);
export const GOLDX_STAGE_IDS = STAGE_IDS;
export function requireGoldxStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 { const definition = GOLDX_STAGE_DEFINITIONS.find(item => item.stage === stage); if (definition === undefined) throw new TypeError(`goldx stage definition missing: ${stage}`); return definition; }
