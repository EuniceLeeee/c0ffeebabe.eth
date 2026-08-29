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
import { erc20AssetPortBindingV1 } from "../../../../packages/asset-ref/src/index.ts";
import type {
  ExecutionFactSourceV1,
  ProgramInterpretationDraftV1,
  TransportFactV1,
} from "../../../../packages/capability-interpreters/src/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asSchemaRef,
  type SchemaRef,
} from "../../../../packages/capability-contracts/src/index.ts";
import type {
  FamilyRuntimeStageV1,
  FamilyStageDefinitionV1,
  FamilyStageGenericInvocationV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import type {
  FrozenProgramEnvelopeV1,
  ProgramSourceAnchorV1,
} from "../../../../packages/request-program/src/index.ts";
import {
  sealInstancePublication,
  validateInstancePublication,
  type InstancePublicationV1,
} from "../../../../packages/catalog/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
  familyCandidateKey as discoveryFamilyCandidateKey,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type RecentLogEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  candidateSnapshotHash,
  decodeRocksolidCandidate,
  deriveRocksolidRoutes,
  identityDescriptorHash,
  materializeRocksolid,
  nominateRocksolid,
  verifyRocksolidIdentityStage,
} from "../stages.ts";
import { ROCKSOLID_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import { ROCKSOLID_FAMILY_ID, ROCKSOLID_FAMILY_VERSION } from "../manifest.ts";
import {
  canonicalAddress,
  type RocksolidCandidateV1,
  type RocksolidIdentityV1,
  type RocksolidMaterializedStateV1,
  type RocksolidObservationV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(ROCKSOLID_FAMILY_VERSION);
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/rocksolid/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/rocksolid/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/rocksolid/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/rocksolid/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/rocksolid/stage-schema/v1", "rehydration"),
});
const IDENTITY_READ_PLAN = Object.freeze(["identity"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);
const ROCKSOLID_CONTRACT_PATTERN = "rocksolid-call" as const;
const ROCKSOLID_STAGE_IDS = Object.freeze({
  nomination: `family.${ROCKSOLID_FAMILY_ID}.nomination`,
  identity: `family.${ROCKSOLID_FAMILY_ID}.identity`,
  materialization: `family.${ROCKSOLID_FAMILY_ID}.materialization`,
  projection: `family.${ROCKSOLID_FAMILY_ID}.projection`,
  rehydration: `family.${ROCKSOLID_FAMILY_ID}.rehydration`,
});

interface CandidateRecord extends Omit<CandidateRecordV1, "evidence"> {
  readonly evidence: readonly RecentLogEvidenceRefV1[];
}

interface CandidateBinding {
  readonly familyId: typeof ROCKSOLID_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly instanceNominationKey: string;
  readonly candidate: RocksolidCandidateV1;
}

interface IdentityMemo {
  readonly kind: "rocksolid-identity-memo";
  readonly version: 1;
  readonly familyId: typeof ROCKSOLID_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly identity: RocksolidIdentityV1;
}

interface NominationPayload {
  readonly kind: "rocksolid-nomination-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayload {
  readonly kind: "rocksolid-identity-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationPayload {
  readonly kind: "rocksolid-materialization-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutput {
  readonly kind: "rocksolid-materialization-output";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly state: RocksolidMaterializedStateV1;
}

interface ProjectionPayload {
  readonly kind: "rocksolid-projection-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly materialization: MaterializationOutput;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayload {
  readonly kind: "rocksolid-rehydration-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
}

interface IdentityObservation {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: IdentityMemo;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

interface NominationOutput {
  readonly kind: "rocksolid-nomination-verified";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface RehydrationOutput {
  readonly kind: "rocksolid-rehydration-verified";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly instanceKey: string;
  readonly referenceHash: Hash;
  readonly requestId: Hash;
}

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be an address`);
  return canonicalAddress(value);
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeCanonicalCutoff(value, path);
}

function source(value: unknown, path: string): ProgramSourceAnchorV1 {
  return decodeExactObject(value, {
    chainId: (item, itemPath) => assertDecimalString(item, itemPath),
    number: (item, itemPath) => assertDecimalString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function factSource(value: unknown, path: string): ExecutionFactSourceV1 {
  return decodeExactObject(value, {
    chainId: (item, itemPath) => assertDecimalString(item, itemPath),
    blockNumber: (item, itemPath) => assertDecimalString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
    executorAuthorityRoot: (item, itemPath) => assertHash(item, itemPath),
    workerEpoch: (item, itemPath) => assertNonEmptyString(item, itemPath),
    executorSessionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function sameCutoff(left: CanonicalCutoffV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function bytes(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new TypeError(`${path} must be canonical bytes`);
  return value;
}

function decimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

function selector(value: unknown, path: string): `0x${string}` {
  const result = bytes(value, path);
  if (result.length !== 10) throw new TypeError(`${path} must be one selector word`);
  return result as `0x${string}`;
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the wstETH read contract`);
  return Object.freeze([...result]);
}

function candidateEvidence(value: unknown, path: string): RecentLogEvidenceRefV1 {
  const result = decodeCandidateEvidenceRef(value, path);
  if (result.kind !== "recent-log") throw new TypeError("rocksolid source evidence is not a recent log");
  return result;
}

function decodeCandidateRecord(value: unknown, path = "rocksolid.candidate"): CandidateRecord {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return item; },
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => candidateEvidence(entry, entryPath), itemPath),
  }, path) as CandidateRecord;
  if (decoded.familyId !== ROCKSOLID_FAMILY_ID) throw new TypeError("rocksolid candidate family mismatch");
  if (decoded.familyDefinitionHash !== ROCKSOLID_FAMILY_DEFINITION_HASH) throw new TypeError("rocksolid candidate definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("rocksolid candidate key mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("rocksolid candidate evidence is empty");
  const hashes = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  const sorted = [...hashes].sort();
  if (new Set(hashes).size !== hashes.length || hashes.some((item, index) => item !== sorted[index])) throw new TypeError("rocksolid candidate evidence is not canonical");
  if (decoded.evidence.some(item => address(item.address, `${path}.evidence.address`) !== canonicalAddress(decoded.instanceNominationKey))) throw new TypeError("rocksolid candidate evidence target mismatch");
  return deepFreeze(decoded);
}

function internalCandidate(value: unknown, path: string): RocksolidCandidateV1 {
  const decoded = decodeExactObject(value, {
    target: (item, itemPath) => address(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => decodeExactObject(item, {
      kind: (field, fieldPath) => field === "log" ? "log" as const : (() => { throw new TypeError(`${fieldPath} kind mismatch`); })(),
      cutoff: (field, fieldPath) => cutoff(field, fieldPath),
      blockNumber: (field, fieldPath) => decimal(field, fieldPath),
      blockHash: (field, fieldPath) => assertHash(field, fieldPath),
      txHash: (field, fieldPath) => assertHash(field, fieldPath),
      logIndex: (field, fieldPath) => decimal(field, fieldPath),
      target: (field, fieldPath) => address(field, fieldPath),
      rawLocatorHash: (field, fieldPath) => assertHash(field, fieldPath),
    }, itemPath) as RocksolidObservationV1,
  }, path) as RocksolidCandidateV1;
  if (decoded.target !== decoded.evidence.target || decoded.instanceNominationKey !== decoded.target) throw new TypeError("rocksolid candidate binding mismatch");
  if (decoded.candidateSnapshotHash !== candidateSnapshotHash(decoded.evidence)) throw new TypeError("rocksolid candidate snapshot mismatch");
  return deepFreeze(decoded);
}

function binding(value: unknown, path: string): CandidateBinding {
  const decoded = decodeExactObject(value, {
    familyId: (item, itemPath) => item === ROCKSOLID_FAMILY_ID ? ROCKSOLID_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidate: (item, itemPath) => internalCandidate(item, itemPath),
  }, path) as CandidateBinding;
  if (decoded.familyDefinitionHash !== ROCKSOLID_FAMILY_DEFINITION_HASH) throw new TypeError("rocksolid binding definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("rocksolid binding key mismatch");
  if (decoded.candidate.target !== decoded.instanceNominationKey || decoded.candidateSnapshotHash !== decoded.candidate.candidateSnapshotHash) throw new TypeError("rocksolid binding candidate mismatch");
  return deepFreeze(decoded);
}

function reconstructBinding(value: unknown, cutoffValue: CanonicalCutoffV1): CandidateBinding {
  const record = decodeCandidateRecord(value);
  const candidateEvidence = record.evidence[0]!;
  const observation: RocksolidObservationV1 = {
    kind: "log",
    target: candidateEvidence.address,
    cutoff: cutoffValue,
    blockNumber: candidateEvidence.blockNumber,
    blockHash: candidateEvidence.blockHash,
    txHash: candidateEvidence.txHash,
    logIndex: candidateEvidence.logIndex,
    rawLocatorHash: candidateEvidence.rawLocatorHash,
  };
  const seed = decodeRocksolidCandidate(observation, ROCKSOLID_CONTRACT_PATTERN);
  if (seed === null) throw new TypeError("rocksolid candidate evidence pattern mismatch");
  const nominated = nominateRocksolid(seed);
  if (nominated.status !== "nominated") throw new TypeError(`rocksolid-candidate-${nominated.reasonCode}`);
  if (nominated.candidate.instanceNominationKey !== record.instanceNominationKey || nominated.candidate.candidateSnapshotHash !== record.candidateSubjectHash) throw new TypeError("rocksolid candidate snapshot mismatch");
  return deepFreeze({
    familyId: ROCKSOLID_FAMILY_ID,
    familyDefinitionHash: ROCKSOLID_FAMILY_DEFINITION_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    instanceNominationKey: record.instanceNominationKey,
    candidate: nominated.candidate,
  });
}

function candidateBindingFromInternal(candidate: RocksolidCandidateV1): CandidateBinding {
  return deepFreeze({
    familyId: ROCKSOLID_FAMILY_ID,
    familyDefinitionHash: ROCKSOLID_FAMILY_DEFINITION_HASH,
    familyCandidateKey: discoveryFamilyCandidateKey(ROCKSOLID_FAMILY_DEFINITION_HASH, candidate.instanceNominationKey),
    candidateSnapshotHash: candidate.candidateSnapshotHash,
    instanceNominationKey: candidate.instanceNominationKey,
    candidate,
  });
}

function assertBinding(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): void {
  const expected = candidateBindingFromInternal(bindingValue.candidate);
  if (bindingValue.familyId !== expected.familyId || bindingValue.familyDefinitionHash !== expected.familyDefinitionHash || bindingValue.familyCandidateKey !== expected.familyCandidateKey || bindingValue.candidateSnapshotHash !== expected.candidateSnapshotHash || bindingValue.instanceNominationKey !== expected.instanceNominationKey) throw new TypeError("rocksolid payload candidate binding mismatch");
  if (!sameCutoff(bindingValue.candidate.evidence.cutoff, cutoffValue)) throw new TypeError("rocksolid candidate cutoff mismatch");
}

function identityMemo(value: unknown, path = "rocksolid.identityMemo"): IdentityMemo {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === ROCKSOLID_FAMILY_ID ? ROCKSOLID_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path) as IdentityMemo;
  if (decoded.familyDefinitionHash !== ROCKSOLID_FAMILY_DEFINITION_HASH) throw new TypeError("rocksolid identity definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("rocksolid identity candidate key mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("rocksolid identity lineage mismatch");
  return deepFreeze(decoded);
}

function decodeIdentity(value: unknown, path: string): RocksolidIdentityV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      asset: (field, fieldPath) => address(field, fieldPath),
      receiptToken: (field, fieldPath) => address(field, fieldPath),
      depositSelector: (field, fieldPath) => selector(field, fieldPath),
    }, itemPath),
  }, path) as RocksolidIdentityV1;
  if (decoded.instanceKey !== decoded.facts.target || decoded.facts.asset === decoded.facts.receiptToken) throw new TypeError("rocksolid identity asset binding mismatch");
  if (decoded.factsHash !== hashDomain("aloha/rocksolid/identity-facts/v1", decoded.facts)) throw new TypeError("rocksolid identity facts hash mismatch");
  return deepFreeze(decoded);
}

function decodeMaterializedState(value: unknown, path: string): RocksolidMaterializedStateV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    materializedHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RocksolidMaterializedStateV1;
  if (decoded.materializedHash !== hashDomain("aloha/rocksolid/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, stateHash: decoded.stateHash })) throw new TypeError("rocksolid materialized state hash mismatch");
  return deepFreeze(decoded);
}

function decodeFactData(fact: Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }>, path: string): CanonicalJson {
  const hex = bytes(fact.dataHex, `${path}.dataHex`);
  const raw = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(raw);
}

function boundFact(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], expectedRequestId: Hash): Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }> {
  if (facts.length !== 1) throw new TypeError("rocksolid transport fact cardinality mismatch");
  const fact = facts[0]!;
  if (fact.kind === "transportFailure") throw new TypeError("rocksolid transport failure must be classified as retryable");
  if (fact.requestId !== expectedRequestId || fact.requestFingerprint !== program.requestFingerprint || fact.source.chainId !== program.source.chainId || fact.source.blockNumber !== program.source.number || fact.source.blockHash !== program.source.hash || fact.source.stateRoot !== program.source.stateRoot) throw new TypeError("rocksolid transport fact source/program mismatch");
  return fact;
}

function factObject(value: unknown, path: string): Record<string, unknown> {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, unknown> = { ...decoded };
  if ("kind" in result) delete result.kind;
  if ("version" in result) delete result.version;
  if ("reads" in result && result.reads !== null && typeof result.reads === "object" && !Array.isArray(result.reads)) return { ...(result.reads as Record<string, unknown>) };
  if ("facts" in result && result.facts !== null && typeof result.facts === "object" && !Array.isArray(result.facts)) return { ...(result.facts as Record<string, unknown>) };
  if ("state" in result && result.state !== null && typeof result.state === "object" && !Array.isArray(result.state)) return { ...(result.state as Record<string, unknown>) };
  return result;
}

function identityFact(value: unknown, path: string): RocksolidIdentityV1["facts"] {
  const fields = factObject(value, path);
  return decodeExactObject(fields, {
    target: (item, itemPath) => address(item, itemPath),
    asset: (item, itemPath) => address(item, itemPath),
    receiptToken: (item, itemPath) => address(item, itemPath),
    depositSelector: (item, itemPath) => selector(item, itemPath),
  }, path);
}

function stateFact(value: unknown, path: string): { readonly instanceKey: string; readonly stateHash: Hash } {
  const fields = factObject(value, path);
  return decodeExactObject(fields, {
    instanceKey: (item, itemPath) => address(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function identityRequestId(target: string, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/rocksolid/request-id/v1", { phase: "identity", target, cutoff: cutoffValue });
}
function stateRequestId(instanceKey: string, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/rocksolid/request-id/v1", { phase: "materialization", target: instanceKey, cutoff: cutoffValue });
}
function nominationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/rocksolid/request-id/v1", { phase: "nomination", familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, cutoff: cutoffValue });
}
function rehydrationReferenceHash(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/rocksolid/rehydration-reference/v1", { familyDefinitionHash: bindingValue.familyDefinitionHash, familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, instanceKey: bindingValue.candidate.target, cutoff: cutoffValue });
}
function rehydrationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/rocksolid/request-id/v1", { phase: "rehydration", target: bindingValue.candidate.target, referenceHash: rehydrationReferenceHash(bindingValue, cutoffValue), cutoff: cutoffValue });
}

function decodeNominationPayload(value: unknown, path = "rocksolid.nominationPayload"): NominationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("rocksolid nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "rocksolid.identityPayload"): IdentityPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== identityRequestId(decoded.binding.candidate.target, decoded.cutoff)) throw new TypeError("rocksolid identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "rocksolid.materializationPayload"): MaterializationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as MaterializationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.instanceNominationKey !== decoded.binding.instanceNominationKey || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("rocksolid materialization lineage mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "rocksolid.materializationOutput"): MaterializationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    state: (item, itemPath) => decodeMaterializedState(item, itemPath),
  }, path) as MaterializationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemoHash !== hashDomain("aloha/identity-memo/v1", decoded.identityMemo)
    || decoded.identityMemo.familyCandidateKey !== decoded.binding.familyCandidateKey
    || decoded.identityMemo.instanceNominationKey !== decoded.binding.instanceNominationKey
    || decoded.identityMemo.candidateSnapshotHash !== decoded.binding.candidateSnapshotHash
    || decoded.identityFactsHash !== decoded.identityMemo.identity.factsHash
    || decoded.state.identityFactsHash !== decoded.identityFactsHash
    || decoded.state.instanceKey !== decoded.identityMemo.identity.instanceKey
    || !sameCutoff(decoded.state.cutoff, decoded.cutoff)) throw new TypeError("rocksolid materialization output lineage mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "rocksolid.projectionPayload"): ProjectionPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as ProjectionPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("rocksolid projection lineage mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "rocksolid.rehydrationPayload"): RehydrationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("rocksolid rehydration request mismatch");
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const result = canonical(value);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${path} must be an object`);
  return result;
}

function decodeIdentityOutput(value: unknown, path = "rocksolid.identityOutput"): IdentityObservation {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityObservation;
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== hashDomain("aloha/identity-memo/v1", decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateSnapshotHash) throw new TypeError("rocksolid identity output lineage mismatch");
  return deepFreeze(decoded);
}

function nominationOutput(value: unknown, path = "rocksolid.nominationOutput"): NominationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("rocksolid nomination output mismatch");
  return deepFreeze(decoded);
}

function materializationOutput(value: unknown, path = "rocksolid.materializationOutput"): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, path), path);
}

function projectionOutput(value: unknown, path = "rocksolid.projectionOutput"): CanonicalJson {
  const result = outputObject(value, path) as unknown as InstancePublicationV1;
  validateInstancePublication(result);
  if (result.familyId !== ROCKSOLID_FAMILY_ID || result.familyDefinitionHash !== ROCKSOLID_FAMILY_DEFINITION_HASH) throw new TypeError("rocksolid projection publication identity mismatch");
  return canonical(result);
}

function rehydrationOutput(value: unknown, path = "rocksolid.rehydrationOutput"): RehydrationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "rocksolid-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.candidate.target || decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("rocksolid rehydration output mismatch");
  return deepFreeze(decoded);
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(code) ? code : fallback;
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayload {
  if (input.stage !== "nomination") throw new TypeError("rocksolid-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("rocksolid-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "rocksolid.nominationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  return deepFreeze({ kind: "rocksolid-nomination-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: NOMINATION_READ_PLAN, requestId: nominationRequestId(candidateBinding, cutoffValue) });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayload {
  if (input.stage !== "identity") throw new TypeError("rocksolid-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("rocksolid-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "rocksolid.identityInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  return deepFreeze({ kind: "rocksolid-identity-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: IDENTITY_READ_PLAN, requestId: identityRequestId(candidateBinding.candidate.target, cutoffValue) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayload {
  if (input.stage !== "materialization") throw new TypeError("rocksolid-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("rocksolid-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "rocksolid.materializationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "rocksolid.materializationInvocation.identityMemo");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || memo.candidateSnapshotHash !== candidateBinding.candidateSnapshotHash) throw new TypeError("rocksolid-materialization-identity-lineage-mismatch");
  return deepFreeze({ kind: "rocksolid-materialization-input", binding: candidateBinding, identityMemo: memo, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayload {
  if (input.stage !== "projection") throw new TypeError("rocksolid-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("rocksolid-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "rocksolid.projectionInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "rocksolid.projectionInvocation.identityMemo");
  const materialization = decodeMaterializationOutput(input.materializationOutput, "rocksolid.projectionInvocation.materializationOutput");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || materialization.binding.familyCandidateKey !== candidateBinding.familyCandidateKey || materialization.identityFactsHash !== memo.identity.factsHash) throw new TypeError("rocksolid-projection-lineage-mismatch");
  return deepFreeze({ kind: "rocksolid-projection-input", binding: candidateBinding, identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayload {
  if (input.stage !== "rehydration") throw new TypeError("rocksolid-rehydration-stage-mismatch");
  if (input.materializationOutput !== null) throw new TypeError("rocksolid-rehydration-materialization-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "rocksolid.rehydrationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const referenceHash = rehydrationReferenceHash(candidateBinding, cutoffValue);
  return deepFreeze({ kind: "rocksolid-rehydration-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: REHYDRATION_READ_PLAN, requestId: rehydrationRequestId(candidateBinding, cutoffValue), referenceHash });
}

function interpretNomination(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeNominationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "rocksolid-nomination-fact-required" });
    if (fact.dataHex !== `0x${payload.binding.candidateSnapshotHash.slice(2)}`) return Object.freeze({ kind: "invalidProgram", code: "rocksolid-nomination-evidence-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "rocksolid-nomination-verified", binding: payload.binding, cutoff: payload.cutoff, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "rocksolid-nomination-invalid") });
  }
}

function interpretIdentity(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeIdentityPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "rocksolid-identity-fact-required" });
    const reads = identityFact(decodeFactData(fact, "rocksolid.identityFact"), "rocksolid.identityFact");
    if (reads.target !== payload.binding.candidate.target) throw new TypeError("rocksolid identity target mismatch");
    const result = verifyRocksolidIdentityStage({ candidate: payload.binding.candidate, reads: { cutoff: payload.cutoff, ...reads, reverseTarget: reads.target } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo: IdentityMemo = { kind: "rocksolid-identity-memo", version: 1, familyId: ROCKSOLID_FAMILY_ID, familyDefinitionHash: ROCKSOLID_FAMILY_DEFINITION_HASH, familyCandidateKey: payload.binding.familyCandidateKey, instanceNominationKey: result.identity.instanceKey, candidateSnapshotHash: result.identity.candidateSnapshotHash, identity: result.identity };
    return Object.freeze({ kind: "verified", output: { kind: "identityVerified", familyInstanceKey: result.identity.instanceKey, identityMemo: memo, identityMemoHash: hashDomain("aloha/identity-memo/v1", memo), descriptorHash: identityDescriptorHash(result.identity), evidenceRoot: result.identity.candidateSnapshotHash } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "rocksolid-identity-invalid") });
  }
}

function interpretMaterialization(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeMaterializationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "rocksolid-materialization-fact-required" });
    const reads = stateFact(decodeFactData(fact, "rocksolid.stateFact"), "rocksolid.stateFact");
    const result = materializeRocksolid({ identity: payload.identityMemo.identity, read: { cutoff: payload.cutoff, ...reads } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const output: MaterializationOutput = { kind: "rocksolid-materialization-output", binding: payload.binding, identityMemo: payload.identityMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, cutoff: payload.cutoff, state: result.state };
    return Object.freeze({ kind: "verified", output });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "rocksolid-materialization-invalid") });
  }
}

function publication(payload: ProjectionPayload, program: FrozenProgramEnvelopeV1): InstancePublicationV1 {
  const identity = payload.identityMemo.identity;
  const routes = deriveRocksolidRoutes(identity);
  const transitions = routes.map(route => ({
    inputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.inputAsset), portRef: hashDomain("aloha/rocksolid/port/v1", { target: route.instanceKey, asset: route.inputAsset }), ordinal: "0" }],
    outputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.outputAsset), portRef: hashDomain("aloha/rocksolid/port/v1", { target: route.instanceKey, asset: route.outputAsset }), ordinal: "0" }],
    opaqueTransitionRef: hashDomain("aloha/rocksolid/transition/v1", route),
    constraintRefs: [route.routeBindingHash],
    staticProjectionHash: hashDomain("aloha/rocksolid/static-transition/v1", route),
  }));
  return sealInstancePublication({
    familyId: ROCKSOLID_FAMILY_ID,
    familyDefinitionHash: ROCKSOLID_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: identity.instanceKey,
    cutoff: payload.cutoff,
    identityMemo: canonical(payload.identityMemo),
    identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo),
    descriptorHash: identityDescriptorHash(identity),
    staticProjectionMemoHash: hashDomain("aloha/rocksolid/static-projection/v1", routes),
    requestedArtifactDependencyRoot: hashDomain("aloha/rocksolid/requested-artifacts/v1", { instanceKey: identity.instanceKey, identityFactsHash: identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/rocksolid/validity/v1", { source: program.source, identityFactsHash: identity.factsHash }),
    transitions,
    evidenceRoot: payload.binding.candidateSnapshotHash,
  });
}

function interpretProjection(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeProjectionPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "rocksolid-projection-fact-required" });
    const reads = stateFact(decodeFactData(fact, "rocksolid.projectionStateFact"), "rocksolid.projectionStateFact");
    const result = materializeRocksolid({ identity: payload.identityMemo.identity, read: { cutoff: payload.cutoff, ...reads } });
    if (result.status !== "verified") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.materializedHash !== payload.materialization.state.materializedHash) return Object.freeze({ kind: "invalidProgram", code: "rocksolid-projection-state-lineage-mismatch" });
    return Object.freeze({ kind: "verified", output: publication(payload, input.program) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "rocksolid-projection-invalid") });
  }
}

function interpretRehydration(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeRehydrationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned" || fact.dataHex !== `0x${payload.referenceHash.slice(2)}`) return Object.freeze({ kind: "invalidProgram", code: "rocksolid-rehydration-reference-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "rocksolid-rehydration-verified", binding: payload.binding, cutoff: payload.cutoff, instanceKey: payload.binding.candidate.target, referenceHash: payload.referenceHash, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "rocksolid-rehydration-invalid") });
  }
}

function definitionBase(
  stage: FamilyRuntimeStageV1,
  payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown },
  outputSchemaRef: Hash,
  outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson },
  prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"],
  interpret: FamilyStageDefinitionV1["interpret"],
): FamilyStageDefinitionV1 {
  return Object.freeze({
    stage,
    capabilityId: asCapabilityId(ROCKSOLID_STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]),
    payloadCodec,
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/rocksolid/runtime-implementation/v1", { stage, module: "families/rocksolid/src/runtime/definitions.ts" }),
    outputCodecHash: hashDomain("aloha/rocksolid/runtime-output-codec/v1", stage),
    outputCodec: deepFreeze(outputCodec),
    prepareIssueValue,
    interpret,
  });
}

const nominationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.nomination), decodeExact: (value: unknown) => decodeNominationPayload(value) });
const identityPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity), decodeExact: (value: unknown) => decodeIdentityPayload(value) });
const materializationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization), decodeExact: (value: unknown) => decodeMaterializationPayload(value) });
const projectionPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection), decodeExact: (value: unknown) => decodeProjectionPayload(value) });
const rehydrationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.rehydration), decodeExact: (value: unknown) => decodeRehydrationPayload(value) });

export const ROCKSOLID_NOMINATION_RUNTIME = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/rocksolid/runtime-output-schema/v1", "nomination"), { decodeExact: value => outputObject(nominationOutput(value), "rocksolid.nominationOutput") }, prepareNomination, interpretNomination);
export const ROCKSOLID_IDENTITY_RUNTIME = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/rocksolid/runtime-output-schema/v1", "identity"), { decodeExact: value => outputObject(decodeIdentityOutput(value), "rocksolid.identityOutput") }, prepareIdentity, interpretIdentity);
export const ROCKSOLID_MATERIALIZATION_RUNTIME = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/rocksolid/runtime-output-schema/v1", "materialization"), { decodeExact: value => materializationOutput(value) }, prepareMaterialization, interpretMaterialization);
export const ROCKSOLID_PROJECTION_RUNTIME = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/rocksolid/runtime-output-schema/v1", "projection"), { decodeExact: value => projectionOutput(value) }, prepareProjection, interpretProjection);
export const ROCKSOLID_REHYDRATION_RUNTIME = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/rocksolid/runtime-output-schema/v1", "rehydration"), { decodeExact: value => outputObject(rehydrationOutput(value), "rocksolid.rehydrationOutput") }, prepareRehydration, interpretRehydration);

export const ROCKSOLID_NOMINATION_DEFINITION = ROCKSOLID_NOMINATION_RUNTIME;
export const ROCKSOLID_IDENTITY_DEFINITION = ROCKSOLID_IDENTITY_RUNTIME;
export const ROCKSOLID_MATERIALIZATION_DEFINITION = ROCKSOLID_MATERIALIZATION_RUNTIME;
export const ROCKSOLID_PROJECTION_DEFINITION = ROCKSOLID_PROJECTION_RUNTIME;
export const ROCKSOLID_REHYDRATION_DEFINITION = ROCKSOLID_REHYDRATION_RUNTIME;

export const ROCKSOLID_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  ROCKSOLID_NOMINATION_DEFINITION,
  ROCKSOLID_IDENTITY_DEFINITION,
  ROCKSOLID_MATERIALIZATION_DEFINITION,
  ROCKSOLID_PROJECTION_DEFINITION,
  ROCKSOLID_REHYDRATION_DEFINITION,
]);

export function requireRocksolidStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = ROCKSOLID_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`rocksolid stage definition missing: ${stage}`);
  return definition;
}
