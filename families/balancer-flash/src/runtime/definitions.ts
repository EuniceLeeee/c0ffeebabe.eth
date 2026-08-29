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
import {
  asCapabilityId,
  asCapabilityVersion,
  asSchemaRef,
  type SchemaRef,
} from "../../../../packages/capability-contracts/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilyRuntimeStageV1,
  type FamilyStageDefinitionV1,
  type FamilyStageGenericInvocationV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import type {
  FrozenProgramEnvelopeV1,
  ProgramSourceAnchorV1,
} from "../../../../packages/request-program/src/index.ts";
import {
  sealInstancePublication,
  validateInstancePublication,
  type AssetPortV1,
  type InstancePublicationV1,
  type StaticTransitionProjectionDraftV1,
  type StaticTransitionProjectionV1,
} from "../../../../packages/catalog/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  decodeCandidateEvidenceRef,
  familyCandidateKey as discoveryFamilyCandidateKey,
  type CandidateEvidenceRefV1,
  type CandidateRecordV1,
} from "../../../../packages/discovery/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import {
  BALANCER_FLASH_FAMILY_DEFINITION_HASH,
} from "../family-definition.ts";
import {
  BALANCER_FLASH_FAMILY_ID,
  BALANCER_FLASH_FAMILY_VERSION,
  BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC,
  BALANCER_VAULT,
} from "../manifest.ts";
import { BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH } from "../metadata.ts";
import {
  deriveBalancerFlashRoutes,
  identityDescriptorHash,
  materializeBalancerFlash,
  resealBalancerFlashState,
  verifyBalancerFlashIdentityStage,
} from "../stages.ts";
import {
  canonicalAddress,
  type BalancerFlashCandidateV1,
  type BalancerFlashCutoffV1,
  type BalancerFlashIdentityV1,
  type BalancerFlashMaterializedStateV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(BALANCER_FLASH_FAMILY_VERSION);
const IDENTITY_READ_PLAN = Object.freeze(["target", "reverseTarget", "inputAsset", "outputAsset", "candidateEvidence"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);

const STAGE_IDS = Object.freeze({
  nomination: `family.${BALANCER_FLASH_FAMILY_ID}.nomination`,
  identity: `family.${BALANCER_FLASH_FAMILY_ID}.identity`,
  materialization: `family.${BALANCER_FLASH_FAMILY_ID}.materialization`,
  projection: `family.${BALANCER_FLASH_FAMILY_ID}.projection`,
  rehydration: `family.${BALANCER_FLASH_FAMILY_ID}.rehydration`,
});

const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/balancer-flash/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/balancer-flash/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/balancer-flash/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/balancer-flash/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/balancer-flash/stage-schema/v1", "rehydration"),
});

const REQUESTED_ARTIFACT_DEPENDENCY_ROOT = hashDomain(
  "aloha/balancer-flash/requested-artifact-dependencies/v1",
  { familyId: BALANCER_FLASH_FAMILY_ID, version: BALANCER_FLASH_FAMILY_VERSION },
);

type BalancerFlashCandidateRecordV1 = CandidateRecordV1;

interface CandidateBindingV1 {
  readonly familyId: typeof BALANCER_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly instanceNominationKey: string;
  readonly candidate: BalancerFlashCandidateV1;
}

interface IdentityMemoV1 {
  readonly kind: "balancer-flash-identity-memo";
  readonly familyId: typeof BALANCER_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: BalancerFlashIdentityV1;
}

interface NominationPayloadV1 {
  readonly kind: "balancer-flash-nomination-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayloadV1 {
  readonly kind: "balancer-flash-identity-input";
  readonly binding: CandidateBindingV1;
  readonly evidence: CandidateEvidenceRefV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
}

interface MaterializationPayloadV1 {
  readonly kind: "balancer-flash-materialization-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutputV1 {
  readonly kind: "balancer-flash-materialization-output";
  readonly binding: CandidateBindingV1;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly state: BalancerFlashMaterializedStateV1;
}

interface ProjectionPayloadV1 {
  readonly kind: "balancer-flash-projection-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayloadV1 {
  readonly kind: "balancer-flash-rehydration-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
}

interface NominationOutputV1 {
  readonly kind: "balancer-flash-nomination-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly requestId: Hash;
}

interface IdentityObservationV1 {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: IdentityMemoV1;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

interface RehydrationOutputV1 {
  readonly kind: "balancer-flash-rehydration-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: BalancerFlashCutoffV1;
  readonly instanceKey: string;
  readonly referenceHash: Hash;
  readonly requestId: Hash;
}

type ReturnedFactV1 = Extract<TransportFactV1, { readonly kind: "returned" }>;

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be an address`);
  return canonicalAddress(value);
}

function cutoff(value: unknown, path: string): BalancerFlashCutoffV1 {
  return decodeExactObject<BalancerFlashCutoffV1>(value, {
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

function sameCutoff(left: BalancerFlashCutoffV1, right: BalancerFlashCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function sameSource(left: ExecutionFactSourceV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId
    && left.blockNumber === right.number
    && left.blockHash === right.hash
    && left.stateRoot === right.stateRoot;
}

function bytes(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) throw new TypeError(`${path} must be lowercase even-length hex bytes`);
  return result;
}

function hexBytes(value: string, path: string): Uint8Array {
  const decoded = bytes(value, path);
  const output = new Uint8Array((decoded.length - 2) / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(decoded.slice(2 + index * 2, 4 + index * 2), 16);
  return output;
}
function blockTag(number: string): string { return `0x${BigInt(number).toString(16)}`; }
function singletonCode(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || /^0x(?:00)+$/.test(value)) throw new TypeError("balancer-flash singleton code is absent");
  return value.toLowerCase();
}
function verifyCandidateEvidence(payload: IdentityPayloadV1, rawBytes: Uint8Array): void {
  if (sha256Hex(rawBytes) !== payload.evidence.rawLocatorHash) throw new TypeError("balancer-flash identity evidence hash mismatch");
  if (payload.evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(rawBytes, "balancer-flash.identity.recentEvidence");
    if (raw.address !== payload.binding.instanceNominationKey || raw.address !== payload.evidence.address || raw.topics[0] !== BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC || raw.topics[0] !== payload.evidence.topic || raw.blockNumber !== payload.evidence.blockNumber || raw.blockHash !== payload.evidence.blockHash || raw.transactionHash !== payload.evidence.txHash || raw.logIndex !== payload.evidence.logIndex) throw new TypeError("balancer-flash recent identity evidence mismatch");
    return;
  }
  const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes, "balancer-flash.identity.singletonEvidence");
  if (observed.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH || observed.plan.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH || observed.plan.completeness !== "complete-snapshot" || observed.plan.historyStartBlock !== null || observed.plan.ownerRef !== payload.evidence.ownerRef || observed.plan.sourcePlanRef !== payload.evidence.sourcePlanRef || !sameCutoff(observed.cutoff, payload.cutoff) || observed.requestSchemaHash !== BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH || observed.request.kind !== "family-source-plan-rpc" || observed.request.version !== 1 || observed.request.method !== "eth_getCode" || observed.request.target !== BALANCER_VAULT || observed.request.manager !== BALANCER_VAULT || observed.request.topic !== null || observed.request.lookback !== null || observed.request.chunk !== null || encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([BALANCER_VAULT, blockTag(payload.cutoff.number)])) throw new TypeError("balancer-flash singleton identity evidence binding mismatch");
  singletonCode(observed.response);
}

function internalCandidate(value: unknown, path: string): BalancerFlashCandidateV1 {
  const decoded = decodeExactObject<BalancerFlashCandidateV1>(value, {
    target: (item, itemPath) => address(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
  }, path);
  if (decoded.instanceNominationKey !== decoded.target) throw new TypeError("balancer-flash-candidate-nomination-key-mismatch");
  return decoded;
}

function candidateRecord(value: unknown, path: string): BalancerFlashCandidateRecordV1 {
  const decoded = decodeExactObject<BalancerFlashCandidateRecordV1>(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return item; },
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyId !== BALANCER_FLASH_FAMILY_ID) throw new TypeError("balancer-flash-candidate-family-mismatch");
  if (decoded.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) {
    throw new TypeError("balancer-flash-candidate-key-mismatch");
  }
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("balancer-flash-candidate-subject-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("balancer-flash-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new TypeError("balancer-flash-candidate-evidence-duplicate");
  const sortedEvidenceKeys = [...evidenceKeys].sort();
  if (evidenceKeys.some((item, index) => item !== sortedEvidenceKeys[index])) throw new TypeError("balancer-flash-candidate-evidence-order");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("balancer-flash-candidate-evidence-root-mismatch");
  if (decoded.evidence.some(item => item.kind === "recent-log" && (address(item.address, `${path}.evidence.address`) !== decoded.instanceNominationKey || item.topic !== BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC))) throw new TypeError("balancer-flash-candidate-evidence-target-mismatch");
  return decoded;
}

function primaryEvidence(record: BalancerFlashCandidateRecordV1): CandidateEvidenceRefV1 {
  const evidence = record.evidence.find(item => item.kind === "source-plan") ?? record.evidence[0];
  if (evidence === undefined) throw new TypeError("balancer-flash-candidate-evidence-empty");
  return evidence;
}

function candidateBindingFromRecord(value: unknown, cutoffValue: BalancerFlashCutoffV1, path: string): CandidateBindingV1 {
  const record = candidateRecord(value, path);
  return Object.freeze({
    familyId: BALANCER_FLASH_FAMILY_ID,
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    candidateEvidenceRoot: record.candidateEvidenceRoot,
    instanceNominationKey: record.instanceNominationKey,
    candidate: Object.freeze({ target: record.instanceNominationKey, instanceNominationKey: record.instanceNominationKey, candidateSnapshotHash: record.candidateSubjectHash, cutoff: cutoffValue }),
  });
}

function assertCandidateBinding(binding: CandidateBindingV1, cutoffValue: BalancerFlashCutoffV1): void {
  if (binding.familyId !== BALANCER_FLASH_FAMILY_ID || binding.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH || binding.familyCandidateKey !== discoveryFamilyCandidateKey(binding.familyDefinitionHash, binding.instanceNominationKey) || binding.candidateSnapshotHash !== candidateSubjectHash(binding.familyDefinitionHash, binding.instanceNominationKey) || binding.candidate.target !== binding.instanceNominationKey || binding.candidate.candidateSnapshotHash !== binding.candidateSnapshotHash || !sameCutoff(binding.candidate.cutoff, cutoffValue)) throw new TypeError("balancer-flash-payload-candidate-binding-mismatch");
}

function requestIds(value: unknown, path: string, expected: readonly Hash[]): readonly Hash[] {
  const decoded = fieldArray(value, (item, itemPath) => assertHash(item, itemPath), path);
  if (decoded.length !== expected.length || new Set(decoded).size !== decoded.length) throw new TypeError(`${path} must contain unique exact request ids`);
  if (decoded.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the Family request contract`);
  return Object.freeze([...decoded]);
}

function hashList(value: unknown, path: string, expectedLength: number): readonly Hash[] {
  const decoded = fieldArray(value, (item, itemPath) => assertHash(item, itemPath), path);
  if (decoded.length !== expectedLength || new Set(decoded).size !== decoded.length) throw new TypeError(`${path} must contain unique request ids`);
  return Object.freeze([...decoded]);
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const decoded = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (decoded.length !== expected.length || decoded.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the Family read contract`);
  return Object.freeze([...decoded]);
}

function identityRequestId(binding: CandidateBindingV1, evidence: CandidateEvidenceRefV1, cutoffValue: BalancerFlashCutoffV1, operation: string): Hash {
  return hashDomain("aloha/balancer-flash/request-id/v1", { phase: "identity", target: binding.instanceNominationKey, candidateSnapshotHash: binding.candidateSnapshotHash, candidateEvidenceRoot: binding.candidateEvidenceRoot, evidence, operation, cutoff: cutoffValue });
}

function stateRequestId(instanceKey: string, cutoffValue: BalancerFlashCutoffV1): Hash {
  return hashDomain("aloha/balancer-flash/request-id/v1", { phase: "materialization", target: instanceKey, operation: "state", cutoff: cutoffValue });
}

function nominationRequestId(binding: CandidateBindingV1, cutoffValue: BalancerFlashCutoffV1): Hash {
  return hashDomain("aloha/balancer-flash/request-id/v1", {
    phase: "nomination",
    target: binding.candidate.target,
    candidateSnapshotHash: binding.candidateSnapshotHash,
    cutoff: cutoffValue,
  });
}

function rehydrationReferenceHash(binding: CandidateBindingV1, cutoffValue: BalancerFlashCutoffV1): Hash {
  return hashDomain("aloha/balancer-flash/rehydration-reference/v1", {
    familyDefinitionHash: binding.familyDefinitionHash,
    familyCandidateKey: binding.familyCandidateKey,
    candidateSnapshotHash: binding.candidateSnapshotHash,
    instanceKey: binding.candidate.target,
    cutoff: cutoffValue,
  });
}

function rehydrationRequestId(binding: CandidateBindingV1, cutoffValue: BalancerFlashCutoffV1): Hash {
  return hashDomain("aloha/balancer-flash/request-id/v1", {
    phase: "rehydration",
    target: binding.candidate.target,
    referenceHash: rehydrationReferenceHash(binding, cutoffValue),
    cutoff: cutoffValue,
  });
}

function identityMemo(value: unknown, path: string): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-identity-memo") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-identity-memo"; },
    familyId: (item, itemPath) => { if (item !== BALANCER_FLASH_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return BALANCER_FLASH_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash identity definition mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey) throw new TypeError("balancer-flash identity nomination key mismatch");
  if (decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash || decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("balancer-flash identity snapshot mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("balancer-flash identity candidate key mismatch");
  return decoded;
}

function decodeIdentity(value: unknown, path: string): BalancerFlashIdentityV1 {
  const decoded = decodeExactObject<BalancerFlashIdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject<BalancerFlashIdentityV1["facts"]>(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      inputAsset: (field, fieldPath) => address(field, fieldPath),
      outputAsset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.facts.target) throw new TypeError("balancer-flash identity instance mismatch");
  if (decoded.facts.inputAsset === decoded.facts.outputAsset) throw new TypeError("balancer-flash identity asset pair invalid");
  if (decoded.factsHash !== hashDomain("aloha/balancer-flash/identity-facts/v1", decoded.facts)) throw new TypeError("balancer-flash identity facts hash mismatch");
  return decoded;
}

function identityMemoHash(value: IdentityMemoV1): Hash {
  return hashDomain("aloha/identity-memo/v1", value);
}

function assertIdentityBinding(binding: CandidateBindingV1, memo: IdentityMemoV1, cutoffValue: BalancerFlashCutoffV1): void {
  assertCandidateBinding(binding, cutoffValue);
  if (
    memo.familyId !== binding.familyId
    || memo.familyDefinitionHash !== binding.familyDefinitionHash
    || memo.familyCandidateKey !== binding.familyCandidateKey
    || memo.instanceNominationKey !== binding.instanceNominationKey
    || memo.candidateSnapshotHash !== binding.candidateSnapshotHash
    || memo.candidateEvidenceRoot !== binding.candidateEvidenceRoot
    || !sameCutoff(memo.identity.cutoff, cutoffValue)
    || memo.identity.instanceKey !== binding.candidate.target
  ) throw new TypeError("balancer-flash identity lineage mismatch");
}

function decodeState(value: unknown, path: string): BalancerFlashMaterializedStateV1 {
  const decoded = decodeExactObject<BalancerFlashMaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    reserveIn: (item, itemPath) => assertDecimalString(item, itemPath),
    reserveOut: (item, itemPath) => assertDecimalString(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stateHash !== resealBalancerFlashState(decoded)) throw new TypeError("balancer-flash materialized state hash mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path: string): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-materialization-output") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-materialization-output"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    state: (item, itemPath) => decodeState(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (
    !sameCutoff(decoded.state.cutoff, decoded.cutoff)
    || decoded.state.instanceKey !== decoded.binding.candidate.target
    || decoded.state.identityFactsHash !== decoded.identityFactsHash
  ) throw new TypeError("balancer-flash materialization output lineage mismatch");
  return decoded;
}

function decodeCandidateBinding(value: unknown, path: string): CandidateBindingV1 {
  const decoded = decodeExactObject<CandidateBindingV1>(value, {
    familyId: (item, itemPath) => { if (item !== BALANCER_FLASH_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return BALANCER_FLASH_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidate: (item, itemPath) => internalCandidate(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash binding definition mismatch");
  return decoded;
}

function decodeNominationPayload(value: unknown, path = "balancer-flash.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-nomination-input") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-nomination-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "balancer-flash.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-identity-input") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-identity-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    evidence: (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestIds: (item, itemPath) => hashList(item, itemPath, IDENTITY_READ_PLAN.length),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  const expectedIds = IDENTITY_READ_PLAN.map(operation => identityRequestId(decoded.binding, decoded.evidence, decoded.cutoff, operation));
  if (decoded.requestIds.length !== expectedIds.length || decoded.requestIds.some((item, index) => item !== expectedIds[index])) throw new TypeError("balancer-flash identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "balancer-flash.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-materialization-input") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-materialization-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("balancer-flash materialization request mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "balancer-flash.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-projection-input") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-projection-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (
    decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey
    || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash
    || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff)
  ) throw new TypeError("balancer-flash projection materialization lineage mismatch");
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("balancer-flash projection request mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "balancer-flash.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-rehydration-input") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-rehydration-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash rehydration reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash rehydration request mismatch");
  return decoded;
}

function decodeIdentityObservation(value: unknown, path = "balancer-flash.identityOutput"): IdentityObservationV1 {
  const decoded = decodeExactObject<IdentityObservationV1>(value, {
    kind: (item, itemPath) => { if (item !== "identityVerified") throw new TypeError(`${itemPath} kind mismatch`); return "identityVerified"; },
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey) throw new TypeError("balancer-flash identity output instance mismatch");
  if (decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo)) throw new TypeError("balancer-flash identity output memo hash mismatch");
  if (decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity)) throw new TypeError("balancer-flash identity output descriptor mismatch");
  if (decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("balancer-flash identity output evidence mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "balancer-flash.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-nomination-verified") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-nomination-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash nomination output request mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "balancer-flash.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "balancer-flash-rehydration-verified") throw new TypeError(`${itemPath} kind mismatch`); return "balancer-flash-rehydration-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.candidate.target) throw new TypeError("balancer-flash rehydration instance mismatch");
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash rehydration output reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("balancer-flash rehydration output request mismatch");
  return decoded;
}

function decodeTransportFact(value: unknown, path: string): TransportFactV1 {
  const raw = canonical(value);
  if (raw === null || Array.isArray(raw)) throw new TypeError(`${path} must be a transport fact object`);
  if (typeof raw !== "object") throw new TypeError(`${path} must be a transport fact object`);
  const kindDescriptor = Object.getOwnPropertyDescriptor(raw, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") throw new TypeError(`${path} fact kind is missing`);
  const kind = kindDescriptor.value;
  if (kind === "returned") {
    return decodeExactObject<Extract<TransportFactV1, { readonly kind: "returned" }>>(value, {
      kind: (item, itemPath) => { if (item !== "returned") throw new TypeError(`${itemPath} kind mismatch`); return "returned"; },
      requestId: (item, itemPath) => assertHash(item, itemPath),
      requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
      dataHex: (item, itemPath) => bytes(item, itemPath),
      source: (item, itemPath) => factSource(item, itemPath),
    }, path);
  }
  if (kind === "reverted") {
    return decodeExactObject<Extract<TransportFactV1, { readonly kind: "reverted" }>>(value, {
      kind: (item, itemPath) => { if (item !== "reverted") throw new TypeError(`${itemPath} kind mismatch`); return "reverted"; },
      requestId: (item, itemPath) => assertHash(item, itemPath),
      requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
      dataHex: (item, itemPath) => bytes(item, itemPath),
      source: (item, itemPath) => factSource(item, itemPath),
    }, path);
  }
  throw new TypeError(`${path} transport failure or unknown fact kind`);
}

function boundFacts(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], ids: readonly Hash[]): readonly TransportFactV1[] {
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "balancer-flash.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("balancer-flash transport request partition mismatch");
  const programSource = source(program.source, "balancer-flash.program.source");
  const byId = new Map<Hash, TransportFactV1>();
  for (const item of decoded) byId.set(item.requestId, item);
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`balancer-flash missing request fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, programSource)) throw new TypeError("balancer-flash transport fact source mismatch");
    return fact;
  }));
}

function returned(fact: TransportFactV1, path: string): ReturnedFactV1 {
  if (fact.kind !== "returned") throw new TypeError(`${path} must be a returned fact`);
  return fact;
}

function assertProgramForStage(
  input: Parameters<FamilyStageDefinitionV1["interpret"]>[0],
  stage: FamilyRuntimeStageV1,
  schemaHash: SchemaRef,
  capabilityId: string,
): void {
  if (input.dependencyRefs.length !== 0) throw new TypeError("balancer-flash lifecycle dependency closure is not empty");
  const programSource = source(input.program.source, "balancer-flash.program.source");
  if (
    input.program.payloadSchemaRef !== schemaHash
    || input.program.capabilityRef.capabilityId !== capabilityId
    || input.program.capabilityRef.schemaHash !== schemaHash
    || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes
  ) throw new TypeError(`balancer-flash ${stage} program binding mismatch`);
  if (!Object.isFrozen(programSource)) throw new TypeError("balancer-flash program source must be frozen");
}

function decodeAddressWord(value: string, path: string): string {
  const encoded = bytes(value, path);
  if (encoded.length !== 66 || !encoded.startsWith("0x") || !/^0+$/.test(encoded.slice(2, 26))) throw new TypeError(`${path} must be an ABI address word`);
  return canonicalAddress(`0x${encoded.slice(-40)}`);
}

function decodeReserveWords(value: string, path: string): { readonly reserveIn: string; readonly reserveOut: string } {
  const encoded = bytes(value, path);
  if (encoded.length !== 130) throw new TypeError(`${path} must contain exactly two ABI uint256 words`);
  return Object.freeze({
    reserveIn: BigInt(`0x${encoded.slice(2, 66)}`).toString(10),
    reserveOut: BigInt(`0x${encoded.slice(66, 130)}`).toString(10),
  });
}

function ackData(hash: Hash): string {
  return `0x${hash.slice(2)}`;
}

function portRef(instanceKey: string, direction: "input" | "output", asset: string): Hash {
  return hashDomain("aloha/balancer-flash/asset-port/v1", { instanceKey, direction, asset });
}

function transition(
  chainId: string,
  instanceKey: string,
  inputAsset: string,
  outputAsset: string,
  routeBindingHash: Hash,
  state: BalancerFlashMaterializedStateV1,
): StaticTransitionProjectionDraftV1 {
  const inputAssetPort: AssetPortV1 = Object.freeze({
    ...erc20AssetPortBindingV1(chainId, inputAsset),
    portRef: portRef(instanceKey, "input", inputAsset),
    ordinal: "0",
  });
  const outputAssetPort: AssetPortV1 = Object.freeze({
    ...erc20AssetPortBindingV1(chainId, outputAsset),
    portRef: portRef(instanceKey, "output", outputAsset),
    ordinal: "0",
  });
  const opaqueTransitionRef = hashDomain("aloha/balancer-flash/transition/v1", {
    instanceKey,
    inputAsset,
    outputAsset,
    routeBindingHash,
    stateHash: state.stateHash,
  });
  const constraintRefs = Object.freeze([state.stateHash]);
  const payload = {
    inputAssetPorts: Object.freeze([inputAssetPort]),
    outputAssetPorts: Object.freeze([outputAssetPort]),
    opaqueTransitionRef,
    constraintRefs,
  };
  return Object.freeze({
    ...payload,
    staticProjectionHash: hashDomain("aloha/static-transition-projection/v1", payload),
  });
}

function publication(
  payload: ProjectionPayloadV1,
  state: BalancerFlashMaterializedStateV1,
): InstancePublicationV1 {
  const routeList = deriveBalancerFlashRoutes(payload.identityMemo.identity);
  const route = routeList[0];
  if (route === undefined) throw new TypeError("balancer-flash route derivation returned no route");
  const draft = transition(
    payload.cutoff.chainId,
    route.instanceKey,
    route.inputAsset,
    route.outputAsset,
    route.routeBindingHash,
    state,
  );
  const transitions = Object.freeze([draft]);
  const identityMemo = canonical(payload.identityMemo);
  return sealInstancePublication({
    familyId: BALANCER_FLASH_FAMILY_ID,
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: route.instanceKey,
    cutoff: payload.cutoff,
    identityMemo,
    identityMemoHash: identityMemoHash(payload.identityMemo),
    descriptorHash: identityDescriptorHash(payload.identityMemo.identity),
    staticProjectionMemoHash: hashDomain("aloha/balancer-flash/static-projection-memo/v1", transitions),
    requestedArtifactDependencyRoot: REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    validityDependencyRoot: hashDomain("aloha/balancer-flash/validity-dependencies/v1", {
      identityFactsHash: payload.identityMemo.identity.factsHash,
      stateHash: state.stateHash,
    }),
    transitions,
    evidenceRoot: payload.binding.candidateEvidenceRoot,
  });
}

function decodeAssetPort(value: unknown, path: string): AssetPortV1 {
  return decodeExactObject<AssetPortV1>(value, {
    assetIdentity: (item, itemPath) => decodeAssetIdentityV1(item, itemPath),
    assetRef: (item, itemPath) => assertHash(item, itemPath),
    portRef: (item, itemPath) => assertHash(item, itemPath),
    ordinal: (item, itemPath) => assertDecimalString(item, itemPath),
  }, path);
}

function decodeTransition(value: unknown, path: string): StaticTransitionProjectionV1 {
  return decodeExactObject<StaticTransitionProjectionV1>(value, {
    inputAssetPorts: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeAssetPort(entry, entryPath), itemPath),
    outputAssetPorts: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeAssetPort(entry, entryPath), itemPath),
    opaqueTransitionRef: (item, itemPath) => assertHash(item, itemPath),
    constraintRefs: (item, itemPath) => fieldArray(item, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    staticProjectionHash: (item, itemPath) => assertHash(item, itemPath),
    projectionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function transitionDraft(value: StaticTransitionProjectionV1): StaticTransitionProjectionDraftV1 {
  return Object.freeze({
    inputAssetPorts: value.inputAssetPorts,
    outputAssetPorts: value.outputAssetPorts,
    opaqueTransitionRef: value.opaqueTransitionRef,
    constraintRefs: value.constraintRefs,
    staticProjectionHash: value.staticProjectionHash,
  });
}

function decodePublication(value: unknown, path = "balancer-flash.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => { if (item !== BALANCER_FLASH_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return BALANCER_FLASH_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    identityMemo: (item) => canonical(item),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    staticProjectionMemoHash: (item, itemPath) => assertHash(item, itemPath),
    requestedArtifactDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    validityDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    transitions: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeTransition(entry, entryPath), itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    instancePublicationHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash publication definition mismatch");
  const memo = identityMemo(decoded.identityMemo, `${path}.identityMemo`);
  if (
    decoded.familyCandidateKey !== memo.familyCandidateKey
    || decoded.instanceKey !== memo.identity.instanceKey
    || !sameCutoff(decoded.cutoff, memo.identity.cutoff)
    || decoded.identityMemoHash !== identityMemoHash(memo)
    || decoded.descriptorHash !== identityDescriptorHash(memo.identity)
    || decoded.evidenceRoot !== memo.candidateEvidenceRoot
    || decoded.requestedArtifactDependencyRoot !== REQUESTED_ARTIFACT_DEPENDENCY_ROOT
    || decoded.transitions.length !== 1
  ) throw new TypeError("balancer-flash publication lineage mismatch");
  const routeList = deriveBalancerFlashRoutes(memo.identity);
  const route = routeList[0];
  const sealedTransition = decoded.transitions[0];
  if (route === undefined || sealedTransition === undefined) throw new TypeError("balancer-flash publication route missing");
  const expectedDraft = transitionDraft(sealedTransition);
  if (decoded.staticProjectionMemoHash !== hashDomain("aloha/balancer-flash/static-projection-memo/v1", [expectedDraft])) throw new TypeError("balancer-flash publication projection memo mismatch");
  const inputPort = sealedTransition.inputAssetPorts[0];
  const outputPort = sealedTransition.outputAssetPorts[0];
  if (sealedTransition.inputAssetPorts.length !== 1 || sealedTransition.outputAssetPorts.length !== 1 || sealedTransition.constraintRefs.length !== 1) throw new TypeError("balancer-flash publication transition shape mismatch");
  const stateHash = sealedTransition.constraintRefs[0];
  if (stateHash === undefined) throw new TypeError("balancer-flash publication state constraint missing");
  if (sealedTransition.opaqueTransitionRef !== hashDomain("aloha/balancer-flash/transition/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
    routeBindingHash: route.routeBindingHash,
    stateHash,
  })) throw new TypeError("balancer-flash publication transition binding mismatch");
  if (decoded.validityDependencyRoot !== hashDomain("aloha/balancer-flash/validity-dependencies/v1", {
    identityFactsHash: memo.identity.factsHash,
    stateHash,
  })) throw new TypeError("balancer-flash publication validity binding mismatch");
  if (
    inputPort === undefined
    || outputPort === undefined
    || inputPort.ordinal !== "0"
    || outputPort.ordinal !== "0"
    || inputPort.assetRef !== erc20AssetPortBindingV1(decoded.cutoff.chainId, route.inputAsset).assetRef
    || inputPort.portRef !== portRef(route.instanceKey, "input", route.inputAsset)
    || outputPort.assetRef !== erc20AssetPortBindingV1(decoded.cutoff.chainId, route.outputAsset).assetRef
    || outputPort.portRef !== portRef(route.instanceKey, "output", route.outputAsset)
  ) throw new TypeError("balancer-flash publication asset binding mismatch");
  validateInstancePublication(decoded);
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be an object`);
  return decoded;
}

function identityOutput(value: unknown): CanonicalJson {
  return outputObject(decodeIdentityObservation(value), "balancer-flash.identityOutput");
}

function materializationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, "balancer-flash.materializationOutput"), "balancer-flash.materializationOutput");
}

function projectionOutput(value: unknown): CanonicalJson {
  return outputObject(decodePublication(value), "balancer-flash.projectionOutput");
}

function nominationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeNominationOutput(value), "balancer-flash.nominationOutput");
}

function rehydrationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeRehydrationOutput(value), "balancer-flash.rehydrationOutput");
}

function requireStage(input: FamilyStageGenericInvocationV1, expected: FamilyRuntimeStageV1): void {
  if (input.stage !== expected) throw new TypeError(`balancer-flash-${expected}-stage-mismatch`);
}

function requireNoPriorOutputs(input: FamilyStageGenericInvocationV1): void {
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("balancer-flash-unexpected-prior-stage-output");
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  requireStage(input, "nomination");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "balancer-flash.nominationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "balancer-flash.nominationInvocation.candidate");
  return Object.freeze({
    kind: "balancer-flash-nomination-input",
    binding,
    cutoff: cutoffValue,
    readPlan: NOMINATION_READ_PLAN,
    requestId: nominationRequestId(binding, cutoffValue),
  });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  requireStage(input, "identity");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "balancer-flash.identityInvocation.cutoff");
  const record = candidateRecord(input.candidate, "balancer-flash.identityInvocation.candidate");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "balancer-flash.identityInvocation.candidate");
  const evidence = primaryEvidence(record);
  return Object.freeze({
    kind: "balancer-flash-identity-input",
    binding,
    evidence,
    cutoff: cutoffValue,
    readPlan: IDENTITY_READ_PLAN,
    requestIds: IDENTITY_READ_PLAN.map(operation => identityRequestId(binding, evidence, cutoffValue, operation)),
  });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  requireStage(input, "materialization");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("balancer-flash-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "balancer-flash.materializationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "balancer-flash.materializationInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "balancer-flash.materializationInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  return Object.freeze({
    kind: "balancer-flash-materialization-input",
    binding,
    identityMemo: memo,
    cutoff: cutoffValue,
    readPlan: STATE_READ_PLAN,
    requestId: stateRequestId(memo.identity.instanceKey, cutoffValue),
  });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  requireStage(input, "projection");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("balancer-flash-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "balancer-flash.projectionInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "balancer-flash.projectionInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "balancer-flash.projectionInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput, "balancer-flash.projectionInvocation.materializationOutput");
  if (
    materialization.binding.familyCandidateKey !== binding.familyCandidateKey
    || materialization.identityMemoHash !== identityMemoHash(memo)
    || materialization.identityFactsHash !== memo.identity.factsHash
    || !sameCutoff(materialization.cutoff, cutoffValue)
  ) throw new TypeError("balancer-flash-projection-materialization-lineage-mismatch");
  return Object.freeze({
    kind: "balancer-flash-projection-input",
    binding,
    identityMemo: memo,
    materialization,
    cutoff: cutoffValue,
    readPlan: STATE_READ_PLAN,
    requestId: stateRequestId(memo.identity.instanceKey, cutoffValue),
  });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayloadV1 {
  requireStage(input, "rehydration");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "balancer-flash.rehydrationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "balancer-flash.rehydrationInvocation.candidate");
  return Object.freeze({
    kind: "balancer-flash-rehydration-input",
    binding,
    cutoff: cutoffValue,
    readPlan: REHYDRATION_READ_PLAN,
    requestId: rehydrationRequestId(binding, cutoffValue),
    referenceHash: rehydrationReferenceHash(binding, cutoffValue),
  });
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : fallback;
}

type StageInterpretInputV1 = Parameters<FamilyStageDefinitionV1["interpret"]>[0];

function interpretNomination(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.nomination);
    assertProgramForStage(input, "nomination", schemaHash, STAGE_IDS.nomination);
    const payload = decodeNominationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "balancer-flash.nomination");
    if (fact.dataHex !== ackData(payload.binding.candidateSnapshotHash)) throw new TypeError("balancer-flash-nomination-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "balancer-flash-nomination-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "balancer-flash-nomination-invalid") });
  }
}

function interpretIdentity(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.identity);
    assertProgramForStage(input, "identity", schemaHash, STAGE_IDS.identity);
    const payload = decodeIdentityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const target = decodeAddressWord(returned(facts[0]!, "balancer-flash.identity.target").dataHex, "balancer-flash.identity.target");
    const reverseTarget = decodeAddressWord(returned(facts[1]!, "balancer-flash.identity.reverseTarget").dataHex, "balancer-flash.identity.reverseTarget");
    const inputAsset = decodeAddressWord(returned(facts[2]!, "balancer-flash.identity.inputAsset").dataHex, "balancer-flash.identity.inputAsset");
    const outputAsset = decodeAddressWord(returned(facts[3]!, "balancer-flash.identity.outputAsset").dataHex, "balancer-flash.identity.outputAsset");
    verifyCandidateEvidence(payload, hexBytes(returned(facts[4]!, "balancer-flash.identity.candidateEvidence").dataHex, "balancer-flash.identity.candidateEvidence"));
    const result = verifyBalancerFlashIdentityStage({
      candidate: payload.binding.candidate,
      reads: { cutoff: payload.cutoff, target, reverseTarget, inputAsset, outputAsset },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo: IdentityMemoV1 = Object.freeze({
      kind: "balancer-flash-identity-memo",
      familyId: BALANCER_FLASH_FAMILY_ID,
      familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
      familyCandidateKey: payload.binding.familyCandidateKey,
      instanceNominationKey: payload.binding.instanceNominationKey,
      candidateSnapshotHash: payload.binding.candidateSnapshotHash,
      candidateEvidenceRoot: payload.binding.candidateEvidenceRoot,
      identity: result.identity,
    });
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "identityVerified",
      familyInstanceKey: result.identity.instanceKey,
      identityMemo: memo,
      identityMemoHash: identityMemoHash(memo),
      descriptorHash: identityDescriptorHash(result.identity),
      evidenceRoot: payload.binding.candidateEvidenceRoot,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "balancer-flash-identity-invalid") });
  }
}

function interpretMaterialization(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.materialization);
    assertProgramForStage(input, "materialization", schemaHash, STAGE_IDS.materialization);
    const payload = decodeMaterializationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "balancer-flash.materialization.state");
    const reserves = decodeReserveWords(fact.dataHex, "balancer-flash.materialization.state");
    const result = materializeBalancerFlash({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "balancer-flash-materialization-output",
      binding: payload.binding,
      identityMemoHash: identityMemoHash(payload.identityMemo),
      identityFactsHash: payload.identityMemo.identity.factsHash,
      cutoff: payload.cutoff,
      state: result.state,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "balancer-flash-materialization-invalid") });
  }
}

function interpretProjection(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.projection);
    assertProgramForStage(input, "projection", schemaHash, STAGE_IDS.projection);
    const payload = decodeProjectionPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "balancer-flash.projection.state");
    const reserves = decodeReserveWords(fact.dataHex, "balancer-flash.projection.state");
    const result = materializeBalancerFlash({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("balancer-flash-projection-state-lineage-mismatch");
    if (result.state.identityFactsHash !== payload.identityMemo.identity.factsHash) throw new TypeError("balancer-flash-projection-identity-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "balancer-flash-projection-invalid") });
  }
}

function interpretRehydration(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.rehydration);
    assertProgramForStage(input, "rehydration", schemaHash, STAGE_IDS.rehydration);
    const payload = decodeRehydrationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "balancer-flash.rehydration.reference");
    if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("balancer-flash-rehydration-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "balancer-flash-rehydration-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      instanceKey: payload.binding.candidate.target,
      referenceHash: payload.referenceHash,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "balancer-flash-rehydration-invalid") });
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
  return deepFreeze({
    stage,
    capabilityId: asCapabilityId(STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]),
    payloadCodec: deepFreeze(payloadCodec),
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/balancer-flash/runtime-implementation/v1", {
      stage,
      module: "families/balancer-flash/src/runtime/definitions.ts",
    }),
    outputCodecHash: hashDomain("aloha/balancer-flash/runtime-output-codec/v1", stage),
    outputCodec: deepFreeze(outputCodec),
    prepareIssueValue,
    interpret,
  });
}

const nominationPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.nomination),
  decodeExact: (value: unknown) => decodeNominationPayload(value),
});
const identityPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity),
  decodeExact: (value: unknown) => decodeIdentityPayload(value),
});
const materializationPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization),
  decodeExact: (value: unknown) => decodeMaterializationPayload(value),
});
const projectionPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection),
  decodeExact: (value: unknown) => decodeProjectionPayload(value),
});
const rehydrationPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.rehydration),
  decodeExact: (value: unknown) => decodeRehydrationPayload(value),
});

export const BALANCER_FLASH_NOMINATION_RUNTIME = definitionBase(
  "nomination",
  nominationPayloadCodec,
  hashDomain("aloha/balancer-flash/runtime-output-schema/v1", "nomination"),
  Object.freeze({ decodeExact: nominationOutput }),
  prepareNomination,
  interpretNomination,
);

export const BALANCER_FLASH_IDENTITY_RUNTIME = definitionBase(
  "identity",
  identityPayloadCodec,
  hashDomain("aloha/balancer-flash/runtime-output-schema/v1", "identity"),
  Object.freeze({ decodeExact: identityOutput }),
  prepareIdentity,
  interpretIdentity,
);

export const BALANCER_FLASH_MATERIALIZATION_RUNTIME = definitionBase(
  "materialization",
  materializationPayloadCodec,
  hashDomain("aloha/balancer-flash/runtime-output-schema/v1", "materialization"),
  Object.freeze({ decodeExact: materializationOutput }),
  prepareMaterialization,
  interpretMaterialization,
);

export const BALANCER_FLASH_PROJECTION_RUNTIME = definitionBase(
  "projection",
  projectionPayloadCodec,
  hashDomain("aloha/balancer-flash/runtime-output-schema/v1", "projection"),
  Object.freeze({ decodeExact: projectionOutput }),
  prepareProjection,
  interpretProjection,
);

export const BALANCER_FLASH_REHYDRATION_RUNTIME = definitionBase(
  "rehydration",
  rehydrationPayloadCodec,
  hashDomain("aloha/balancer-flash/runtime-output-schema/v1", "rehydration"),
  Object.freeze({ decodeExact: rehydrationOutput }),
  prepareRehydration,
  interpretRehydration,
);

export const BALANCER_FLASH_NOMINATION_DEFINITION = BALANCER_FLASH_NOMINATION_RUNTIME;
export const BALANCER_FLASH_IDENTITY_DEFINITION = BALANCER_FLASH_IDENTITY_RUNTIME;
export const BALANCER_FLASH_MATERIALIZATION_DEFINITION = BALANCER_FLASH_MATERIALIZATION_RUNTIME;
export const BALANCER_FLASH_PROJECTION_DEFINITION = BALANCER_FLASH_PROJECTION_RUNTIME;
export const BALANCER_FLASH_REHYDRATION_DEFINITION = BALANCER_FLASH_REHYDRATION_RUNTIME;

export const BALANCER_FLASH_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  BALANCER_FLASH_NOMINATION_RUNTIME,
  BALANCER_FLASH_IDENTITY_RUNTIME,
  BALANCER_FLASH_MATERIALIZATION_RUNTIME,
  BALANCER_FLASH_PROJECTION_RUNTIME,
  BALANCER_FLASH_REHYDRATION_RUNTIME,
]);

export function requireBalancerFlashStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = BALANCER_FLASH_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`balancer-flash stage definition missing: ${stage}`);
  return definition;
}
