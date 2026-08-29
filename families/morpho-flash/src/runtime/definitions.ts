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
  type InstancePublicationV1,
} from "../../../../packages/catalog/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
  familyCandidateKey as discoveryFamilyCandidateKey,
  type CandidateEvidenceRefV1,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  deriveMorphoFlashRoutes,
  identityDescriptorHash,
  materializeMorphoFlash,
  verifyMorphoFlashIdentityStage,
} from "../stages.ts";
import { MORPHO_FLASH_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import { MORPHO_BLUE_SINGLETON, MORPHO_FLASH_EVIDENCE_TOPIC, MORPHO_FLASH_FAMILY_ID, MORPHO_FLASH_FAMILY_VERSION } from "../manifest.ts";
import { MORPHO_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH } from "../metadata.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import {
  canonicalAddress,
  type MorphoFlashCandidateV1,
  type MorphoFlashIdentityReadFactsV1,
  type MorphoFlashIdentityV1,
  type MorphoFlashMaterializedStateV1,
  type MorphoFlashStateReadFactsV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(MORPHO_FLASH_FAMILY_VERSION);
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/morpho-flash/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/morpho-flash/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/morpho-flash/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/morpho-flash/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/morpho-flash/stage-schema/v1", "rehydration"),
});
const IDENTITY_READ_PLAN = Object.freeze(["identity"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);
const MORPHO_FLASH_CONTRACT_PATTERN = "morpho-flash-contract-log" as const;
const MORPHO_FLASH_STAGE_IDS = Object.freeze({
  nomination: `family.${MORPHO_FLASH_FAMILY_ID}.nomination`,
  identity: `family.${MORPHO_FLASH_FAMILY_ID}.identity`,
  materialization: `family.${MORPHO_FLASH_FAMILY_ID}.materialization`,
  projection: `family.${MORPHO_FLASH_FAMILY_ID}.projection`,
  rehydration: `family.${MORPHO_FLASH_FAMILY_ID}.rehydration`,
});

type CandidateRecord = CandidateRecordV1;

interface CandidateBinding {
  readonly familyId: typeof MORPHO_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly instanceNominationKey: string;
  readonly candidate: MorphoFlashCandidateV1;
}

interface IdentityMemo {
  readonly kind: "morpho-flash-identity-memo";
  readonly version: 1;
  readonly familyId: typeof MORPHO_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: MorphoFlashIdentityV1;
}

interface NominationPayload {
  readonly kind: "morpho-flash-nomination-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayload {
  readonly kind: "morpho-flash-identity-input";
  readonly binding: CandidateBinding;
  readonly evidence: CandidateEvidenceRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationPayload {
  readonly kind: "morpho-flash-materialization-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutput {
  readonly kind: "morpho-flash-materialization-output";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly state: MorphoFlashMaterializedStateV1;
}

interface ProjectionPayload {
  readonly kind: "morpho-flash-projection-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly materialization: MaterializationOutput;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayload {
  readonly kind: "morpho-flash-rehydration-input";
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
  readonly kind: "morpho-flash-nomination-verified";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface RehydrationOutput {
  readonly kind: "morpho-flash-rehydration-verified";
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
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the MorphoFlash read contract`);
  return Object.freeze([...result]);
}

function decodeCandidateRecord(value: unknown, path = "morpho-flash.candidate"): CandidateRecord {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return item; },
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path) as CandidateRecord;
  if (decoded.familyId !== MORPHO_FLASH_FAMILY_ID) throw new TypeError("morpho-flash candidate family mismatch");
  if (decoded.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash candidate definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash candidate key mismatch");
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash candidate subject mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("morpho-flash candidate evidence is empty");
  const hashes = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  const sorted = [...hashes].sort();
  if (new Set(hashes).size !== hashes.length || hashes.some((item, index) => item !== sorted[index])) throw new TypeError("morpho-flash candidate evidence is not canonical");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("morpho-flash candidate evidence root mismatch");
  if (decoded.evidence.some(item => item.kind === "recent-log" && (address(item.address, `${path}.evidence.address`) !== canonicalAddress(decoded.instanceNominationKey) || item.topic !== MORPHO_FLASH_EVIDENCE_TOPIC))) throw new TypeError("morpho-flash candidate evidence target/topic mismatch");
  return deepFreeze(decoded);
}

function primaryEvidence(record: CandidateRecord): CandidateEvidenceRefV1 {
  const evidence = record.evidence.find(item => item.kind === "source-plan") ?? record.evidence[0];
  if (evidence === undefined) throw new TypeError("morpho-flash candidate evidence is empty");
  return evidence;
}

function internalCandidate(value: unknown, path: string): MorphoFlashCandidateV1 {
  const decoded = decodeExactObject(value, {
    target: (item, itemPath) => address(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
  }, path) as MorphoFlashCandidateV1;
  if (decoded.instanceNominationKey !== decoded.target) throw new TypeError("morpho-flash candidate binding mismatch");
  return deepFreeze(decoded);
}

function binding(value: unknown, path: string): CandidateBinding {
  const decoded = decodeExactObject(value, {
    familyId: (item, itemPath) => item === MORPHO_FLASH_FAMILY_ID ? MORPHO_FLASH_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidate: (item, itemPath) => internalCandidate(item, itemPath),
  }, path) as CandidateBinding;
  if (decoded.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash binding definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash binding key mismatch");
  if (decoded.candidate.target !== decoded.instanceNominationKey || decoded.candidateSnapshotHash !== decoded.candidate.candidateSnapshotHash) throw new TypeError("morpho-flash binding candidate mismatch");
  if (decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash binding candidate subject mismatch");
  return deepFreeze(decoded);
}

function reconstructBinding(value: unknown, cutoffValue: CanonicalCutoffV1): CandidateBinding {
  const record = decodeCandidateRecord(value);
  const target = canonicalAddress(record.instanceNominationKey);
  return deepFreeze({
    familyId: MORPHO_FLASH_FAMILY_ID,
    familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    candidateEvidenceRoot: record.candidateEvidenceRoot,
    instanceNominationKey: target,
    candidate: { target, instanceNominationKey: target, candidateSnapshotHash: record.candidateSubjectHash, cutoff: cutoffValue },
  });
}

function assertBinding(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): void {
  if (bindingValue.familyId !== MORPHO_FLASH_FAMILY_ID || bindingValue.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH || bindingValue.familyCandidateKey !== discoveryFamilyCandidateKey(bindingValue.familyDefinitionHash, bindingValue.instanceNominationKey) || bindingValue.candidateSnapshotHash !== candidateSubjectHash(bindingValue.familyDefinitionHash, bindingValue.instanceNominationKey) || bindingValue.candidate.target !== bindingValue.instanceNominationKey || bindingValue.candidate.candidateSnapshotHash !== bindingValue.candidateSnapshotHash) throw new TypeError("morpho-flash payload candidate binding mismatch");
  if (!sameCutoff(bindingValue.candidate.cutoff, cutoffValue)) throw new TypeError("morpho-flash candidate cutoff mismatch");
}

function identityMemo(value: unknown, path = "morpho-flash.identityMemo"): IdentityMemo {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === MORPHO_FLASH_FAMILY_ID ? MORPHO_FLASH_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path) as IdentityMemo;
  if (decoded.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash identity definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash identity candidate key mismatch");
  if (!/^0x[0-9a-f]{40}$/.test(decoded.instanceNominationKey) || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash || decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("morpho-flash identity lineage mismatch");
  return deepFreeze(decoded);
}

function decodeIdentity(value: unknown, path: string): MorphoFlashIdentityV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject(item, {
      lender: (field, fieldPath) => address(field, fieldPath),
      asset: (field, fieldPath) => address(field, fieldPath),
      receiver: (field, fieldPath) => address(field, fieldPath),
      feeBps: (field, fieldPath) => decimal(field, fieldPath),
    }, itemPath),
  }, path) as MorphoFlashIdentityV1;
  if (decoded.facts.asset === decoded.facts.receiver || decoded.facts.asset === "0x0000000000000000000000000000000000000000" || decoded.facts.receiver === "0x0000000000000000000000000000000000000000") throw new TypeError("morpho-flash identity asset binding mismatch");
  if (decoded.factsHash !== hashDomain("aloha/morpho-flash/identity-facts/v1", decoded.facts) || decoded.instanceKey !== hashDomain("aloha/morpho-flash/instance/v1", decoded.facts)) throw new TypeError("morpho-flash identity facts lineage mismatch");
  return deepFreeze(decoded);
}

function decodeMaterializedState(value: unknown, path: string): MorphoFlashMaterializedStateV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    availableLiquidity: (item, itemPath) => decimal(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as MorphoFlashMaterializedStateV1;
  if (decoded.stateHash !== hashDomain("aloha/morpho-flash/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, availableLiquidity: decoded.availableLiquidity })) throw new TypeError("morpho-flash state hash mismatch");
  return deepFreeze(decoded);
}

function decodeFactData(fact: Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }>, path: string): CanonicalJson {
  const hex = bytes(fact.dataHex, `${path}.dataHex`);
  const raw = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(raw);
}

function boundFact(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], expectedRequestId: Hash): Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }> {
  if (facts.length !== 1) throw new TypeError("morpho-flash transport fact cardinality mismatch");
  const fact = facts[0]!;
  if (fact.kind === "transportFailure") throw new TypeError("morpho-flash transport failure must be classified as retryable");
  if (fact.requestId !== expectedRequestId || fact.requestFingerprint !== program.requestFingerprint || fact.source.chainId !== program.source.chainId || fact.source.blockNumber !== program.source.number || fact.source.blockHash !== program.source.hash || fact.source.stateRoot !== program.source.stateRoot) throw new TypeError("morpho-flash transport fact source/program mismatch");
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

function identityFact(value: unknown, path: string): { readonly candidateSnapshotHash: Hash; readonly candidateEvidenceBytesHex: string; readonly reads: MorphoFlashIdentityReadFactsV1 } {
  return decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-identity-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceBytesHex: (item, itemPath) => bytes(item, itemPath),
    reads: (item, itemPath) => decodeExactObject(item, {
      cutoff: (field, fieldPath) => cutoff(field, fieldPath),
      target: (field, fieldPath) => address(field, fieldPath),
      reverseLender: (field, fieldPath) => address(field, fieldPath),
      asset: (field, fieldPath) => address(field, fieldPath),
      receiver: (field, fieldPath) => address(field, fieldPath),
      assetHasCode: (field, fieldPath) => typeof field === "boolean" ? field : (() => { throw new TypeError(`${fieldPath} must be boolean`); })(),
      receiverHasCode: (field, fieldPath) => typeof field === "boolean" ? field : (() => { throw new TypeError(`${fieldPath} must be boolean`); })(),
      feeBps: (field, fieldPath) => decimal(field, fieldPath),
    }, itemPath) as MorphoFlashIdentityReadFactsV1,
  }, path);
}

function hexBytes(value: string, path: string): Uint8Array {
  const decoded = bytes(value, path);
  const output = new Uint8Array((decoded.length - 2) / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(decoded.slice(2 + index * 2, 4 + index * 2), 16);
  return output;
}

function blockTag(number: string): string { return `0x${BigInt(number).toString(16)}`; }
function singletonCode(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || /^0x(?:00)+$/.test(value)) throw new TypeError("morpho-flash singleton code is absent");
  return value.toLowerCase();
}
function verifyCandidateEvidence(payload: IdentityPayload, rawBytes: Uint8Array): void {
  if (sha256Hex(rawBytes) !== payload.evidence.rawLocatorHash) throw new TypeError("morpho-flash identity evidence hash mismatch");
  if (payload.evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(rawBytes, "morpho-flash.identity.recentEvidence");
    if (raw.address !== payload.binding.instanceNominationKey || raw.address !== payload.evidence.address || raw.topics[0] !== MORPHO_FLASH_EVIDENCE_TOPIC || raw.topics[0] !== payload.evidence.topic || raw.blockNumber !== payload.evidence.blockNumber || raw.blockHash !== payload.evidence.blockHash || raw.transactionHash !== payload.evidence.txHash || raw.logIndex !== payload.evidence.logIndex) throw new TypeError("morpho-flash recent identity evidence mismatch");
    return;
  }
  const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes, "morpho-flash.identity.singletonEvidence");
  if (
    observed.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH
    || observed.plan.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH
    || observed.plan.completeness !== "complete-snapshot"
    || observed.plan.historyStartBlock !== null
    || observed.plan.ownerRef !== payload.evidence.ownerRef
    || observed.plan.sourcePlanRef !== payload.evidence.sourcePlanRef
    || !sameCutoff(observed.cutoff, payload.cutoff)
    || observed.requestSchemaHash !== MORPHO_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH
    || observed.request.kind !== "family-source-plan-rpc"
    || observed.request.version !== 1
    || observed.request.method !== "eth_getCode"
    || observed.request.target !== canonicalAddress(MORPHO_BLUE_SINGLETON)
    || observed.request.manager !== canonicalAddress(MORPHO_BLUE_SINGLETON)
    || observed.request.topic !== null
    || observed.request.lookback !== null
    || observed.request.chunk !== null
    || encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([MORPHO_BLUE_SINGLETON, blockTag(payload.cutoff.number)])
  ) throw new TypeError("morpho-flash singleton identity evidence binding mismatch");
  singletonCode(observed.response);
}

function stateFact(value: unknown, path: string): MorphoFlashStateReadFactsV1 {
  const fields = factObject(value, path);
  return decodeExactObject(fields, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    availableLiquidity: (item, itemPath) => decimal(item, itemPath),
  }, path) as MorphoFlashStateReadFactsV1;
}

function identityRequestId(bindingValue: CandidateBinding, evidence: CandidateEvidenceRefV1, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/morpho-flash/request-id/v1", { phase: "identity", target: bindingValue.instanceNominationKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, candidateEvidenceRoot: bindingValue.candidateEvidenceRoot, evidence, cutoff: cutoffValue });
}
function stateRequestId(instanceKey: string, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/morpho-flash/request-id/v1", { phase: "materialization", target: instanceKey, cutoff: cutoffValue });
}
function nominationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/morpho-flash/request-id/v1", { phase: "nomination", familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, cutoff: cutoffValue });
}
function rehydrationReferenceHash(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/morpho-flash/rehydration-reference/v1", { familyDefinitionHash: bindingValue.familyDefinitionHash, familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, instanceKey: bindingValue.candidate.target, cutoff: cutoffValue });
}
function rehydrationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/morpho-flash/request-id/v1", { phase: "rehydration", target: bindingValue.candidate.target, referenceHash: rehydrationReferenceHash(bindingValue, cutoffValue), cutoff: cutoffValue });
}

function decodeNominationPayload(value: unknown, path = "morpho-flash.nominationPayload"): NominationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("morpho-flash nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "morpho-flash.identityPayload"): IdentityPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    evidence: (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== identityRequestId(decoded.binding, decoded.evidence, decoded.cutoff)) throw new TypeError("morpho-flash identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "morpho-flash.materializationPayload"): MaterializationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as MaterializationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.instanceNominationKey !== decoded.binding.instanceNominationKey || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("morpho-flash materialization lineage mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "morpho-flash.materializationOutput"): MaterializationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
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
    || decoded.identityMemo.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot
    || decoded.identityFactsHash !== decoded.identityMemo.identity.factsHash
    || decoded.state.identityFactsHash !== decoded.identityFactsHash
    || decoded.state.instanceKey !== decoded.identityMemo.identity.instanceKey
    || !sameCutoff(decoded.state.cutoff, decoded.cutoff)) throw new TypeError("morpho-flash materialization output lineage mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "morpho-flash.projectionPayload"): ProjectionPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as ProjectionPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.identityMemo.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.binding.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("morpho-flash projection lineage mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "morpho-flash.rehydrationPayload"): RehydrationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("morpho-flash rehydration request mismatch");
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const result = canonical(value);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${path} must be an object`);
  return result;
}

function decodeIdentityOutput(value: unknown, path = "morpho-flash.identityOutput"): IdentityObservation {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => assertHash(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityObservation;
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== hashDomain("aloha/identity-memo/v1", decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("morpho-flash identity output lineage mismatch");
  return deepFreeze(decoded);
}

function nominationOutput(value: unknown, path = "morpho-flash.nominationOutput"): NominationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("morpho-flash nomination output mismatch");
  return deepFreeze(decoded);
}

function materializationOutput(value: unknown, path = "morpho-flash.materializationOutput"): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, path), path);
}

function projectionOutput(value: unknown, path = "morpho-flash.projectionOutput"): CanonicalJson {
  const result = outputObject(value, path) as unknown as InstancePublicationV1;
  validateInstancePublication(result);
  if (result.familyId !== MORPHO_FLASH_FAMILY_ID || result.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash projection publication identity mismatch");
  return canonical(result);
}

function rehydrationOutput(value: unknown, path = "morpho-flash.rehydrationOutput"): RehydrationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "morpho-flash-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("morpho-flash rehydration output mismatch");
  return deepFreeze(decoded);
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(code) ? code : fallback;
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayload {
  if (input.stage !== "nomination") throw new TypeError("morpho-flash-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("morpho-flash-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "morpho-flash.nominationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  return deepFreeze({ kind: "morpho-flash-nomination-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: NOMINATION_READ_PLAN, requestId: nominationRequestId(candidateBinding, cutoffValue) });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayload {
  if (input.stage !== "identity") throw new TypeError("morpho-flash-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("morpho-flash-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "morpho-flash.identityInvocation.cutoff");
  const record = decodeCandidateRecord(input.candidate);
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const evidence = primaryEvidence(record);
  return deepFreeze({ kind: "morpho-flash-identity-input", binding: candidateBinding, evidence, cutoff: cutoffValue, readPlan: IDENTITY_READ_PLAN, requestId: identityRequestId(candidateBinding, evidence, cutoffValue) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayload {
  if (input.stage !== "materialization") throw new TypeError("morpho-flash-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("morpho-flash-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "morpho-flash.materializationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "morpho-flash.materializationInvocation.identityMemo");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || memo.candidateSnapshotHash !== candidateBinding.candidateSnapshotHash || memo.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot) throw new TypeError("morpho-flash-materialization-identity-lineage-mismatch");
  return deepFreeze({ kind: "morpho-flash-materialization-input", binding: candidateBinding, identityMemo: memo, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayload {
  if (input.stage !== "projection") throw new TypeError("morpho-flash-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("morpho-flash-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "morpho-flash.projectionInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "morpho-flash.projectionInvocation.identityMemo");
  const materialization = decodeMaterializationOutput(input.materializationOutput, "morpho-flash.projectionInvocation.materializationOutput");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || memo.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot || materialization.binding.familyCandidateKey !== candidateBinding.familyCandidateKey || materialization.binding.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot || materialization.identityFactsHash !== memo.identity.factsHash) throw new TypeError("morpho-flash-projection-lineage-mismatch");
  return deepFreeze({ kind: "morpho-flash-projection-input", binding: candidateBinding, identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayload {
  if (input.stage !== "rehydration") throw new TypeError("morpho-flash-rehydration-stage-mismatch");
  if (input.materializationOutput !== null) throw new TypeError("morpho-flash-rehydration-materialization-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "morpho-flash.rehydrationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const referenceHash = rehydrationReferenceHash(candidateBinding, cutoffValue);
  return deepFreeze({ kind: "morpho-flash-rehydration-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: REHYDRATION_READ_PLAN, requestId: rehydrationRequestId(candidateBinding, cutoffValue), referenceHash });
}

function interpretNomination(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeNominationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-nomination-fact-required" });
    if (fact.dataHex !== `0x${payload.binding.candidateSnapshotHash.slice(2)}`) return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-nomination-evidence-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "morpho-flash-nomination-verified", binding: payload.binding, cutoff: payload.cutoff, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "morpho-flash-nomination-invalid") });
  }
}

function interpretIdentity(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeIdentityPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-identity-fact-required" });
    const decoded = identityFact(decodeFactData(fact, "morpho-flash.identityFact"), "morpho-flash.identityFact");
    if (decoded.candidateSnapshotHash !== payload.binding.candidateSnapshotHash) throw new TypeError("morpho-flash identity subject mismatch");
    verifyCandidateEvidence(payload, hexBytes(decoded.candidateEvidenceBytesHex, "morpho-flash.identityFact.candidateEvidenceBytesHex"));
    if (decoded.reads.target !== payload.binding.candidate.target) throw new TypeError("morpho-flash identity target mismatch");
    const result = verifyMorphoFlashIdentityStage({ candidate: payload.binding.candidate, reads: decoded.reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo: IdentityMemo = { kind: "morpho-flash-identity-memo", version: 1, familyId: MORPHO_FLASH_FAMILY_ID, familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH, familyCandidateKey: payload.binding.familyCandidateKey, instanceNominationKey: payload.binding.instanceNominationKey, candidateSnapshotHash: result.identity.candidateSnapshotHash, candidateEvidenceRoot: payload.binding.candidateEvidenceRoot, identity: result.identity };
    return Object.freeze({ kind: "verified", output: { kind: "identityVerified", familyInstanceKey: result.identity.instanceKey, identityMemo: memo, identityMemoHash: hashDomain("aloha/identity-memo/v1", memo), descriptorHash: identityDescriptorHash(result.identity), evidenceRoot: payload.binding.candidateEvidenceRoot } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "morpho-flash-identity-invalid") });
  }
}

function interpretMaterialization(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeMaterializationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-materialization-fact-required" });
    const reads = stateFact(decodeFactData(fact, "morpho-flash.stateFact"), "morpho-flash.stateFact");
    const result = materializeMorphoFlash({ identity: payload.identityMemo.identity, read: reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const output: MaterializationOutput = { kind: "morpho-flash-materialization-output", binding: payload.binding, identityMemo: payload.identityMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, cutoff: payload.cutoff, state: result.state };
    return Object.freeze({ kind: "verified", output });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "morpho-flash-materialization-invalid") });
  }
}

function publication(payload: ProjectionPayload, program: FrozenProgramEnvelopeV1): InstancePublicationV1 {
  const identity = payload.identityMemo.identity;
  const routes = deriveMorphoFlashRoutes(identity);
  const transitions = routes.map(route => ({
    inputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.asset), portRef: hashDomain("aloha/morpho-flash/port/v1", { target: route.instanceKey, asset: route.asset, account: route.receiver }), ordinal: "0" }],
    outputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.asset), portRef: hashDomain("aloha/morpho-flash/port/v1", { target: route.instanceKey, asset: route.asset, account: route.lender }), ordinal: "0" }],
    opaqueTransitionRef: hashDomain("aloha/morpho-flash/transition/v1", route),
    constraintRefs: [route.routeBindingHash],
    staticProjectionHash: hashDomain("aloha/morpho-flash/static-transition/v1", route),
  }));
  return sealInstancePublication({
    familyId: MORPHO_FLASH_FAMILY_ID,
    familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: identity.instanceKey,
    cutoff: payload.cutoff,
    identityMemo: canonical(payload.identityMemo),
    identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo),
    descriptorHash: identityDescriptorHash(identity),
    staticProjectionMemoHash: hashDomain("aloha/morpho-flash/static-projection/v1", routes),
    requestedArtifactDependencyRoot: hashDomain("aloha/morpho-flash/requested-artifacts/v1", { instanceKey: identity.instanceKey, identityFactsHash: identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/morpho-flash/validity/v1", { source: program.source, identityFactsHash: identity.factsHash }),
    transitions,
    evidenceRoot: payload.binding.candidateEvidenceRoot,
  });
}

function interpretProjection(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeProjectionPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-projection-fact-required" });
    const reads = stateFact(decodeFactData(fact, "morpho-flash.projectionStateFact"), "morpho-flash.projectionStateFact");
    const result = materializeMorphoFlash({ identity: payload.identityMemo.identity, read: reads });
    if (result.status !== "verified") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-projection-state-lineage-mismatch" });
    return Object.freeze({ kind: "verified", output: publication(payload, input.program) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "morpho-flash-projection-invalid") });
  }
}

function interpretRehydration(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeRehydrationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-rehydration-reference-mismatch" });
    const data = factObject(decodeFactData(fact, "morpho-flash.rehydrationFact"), "morpho-flash.rehydrationFact");
    const reference = decodeExactObject(data, { referenceHash: (item, itemPath) => assertHash(item, itemPath), instanceKey: (item, itemPath) => assertHash(item, itemPath) }, "morpho-flash.rehydrationFact");
    if (reference.referenceHash !== payload.referenceHash) return Object.freeze({ kind: "invalidProgram", code: "morpho-flash-rehydration-reference-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "morpho-flash-rehydration-verified", binding: payload.binding, cutoff: payload.cutoff, instanceKey: reference.instanceKey, referenceHash: payload.referenceHash, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "morpho-flash-rehydration-invalid") });
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
    capabilityId: asCapabilityId(MORPHO_FLASH_STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]),
    payloadCodec,
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/morpho-flash/runtime-implementation/v1", { stage, module: "families/morpho-flash/src/runtime/definitions.ts" }),
    outputCodecHash: hashDomain("aloha/morpho-flash/runtime-output-codec/v1", stage),
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

export const MORPHO_FLASH_NOMINATION_RUNTIME = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/morpho-flash/runtime-output-schema/v1", "nomination"), { decodeExact: value => outputObject(nominationOutput(value), "morpho-flash.nominationOutput") }, prepareNomination, interpretNomination);
export const MORPHO_FLASH_IDENTITY_RUNTIME = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/morpho-flash/runtime-output-schema/v1", "identity"), { decodeExact: value => outputObject(decodeIdentityOutput(value), "morpho-flash.identityOutput") }, prepareIdentity, interpretIdentity);
export const MORPHO_FLASH_MATERIALIZATION_RUNTIME = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/morpho-flash/runtime-output-schema/v1", "materialization"), { decodeExact: value => materializationOutput(value) }, prepareMaterialization, interpretMaterialization);
export const MORPHO_FLASH_PROJECTION_RUNTIME = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/morpho-flash/runtime-output-schema/v1", "projection"), { decodeExact: value => projectionOutput(value) }, prepareProjection, interpretProjection);
export const MORPHO_FLASH_REHYDRATION_RUNTIME = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/morpho-flash/runtime-output-schema/v1", "rehydration"), { decodeExact: value => outputObject(rehydrationOutput(value), "morpho-flash.rehydrationOutput") }, prepareRehydration, interpretRehydration);

export const MORPHO_FLASH_NOMINATION_DEFINITION = MORPHO_FLASH_NOMINATION_RUNTIME;
export const MORPHO_FLASH_IDENTITY_DEFINITION = MORPHO_FLASH_IDENTITY_RUNTIME;
export const MORPHO_FLASH_MATERIALIZATION_DEFINITION = MORPHO_FLASH_MATERIALIZATION_RUNTIME;
export const MORPHO_FLASH_PROJECTION_DEFINITION = MORPHO_FLASH_PROJECTION_RUNTIME;
export const MORPHO_FLASH_REHYDRATION_DEFINITION = MORPHO_FLASH_REHYDRATION_RUNTIME;

export const MORPHO_FLASH_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  MORPHO_FLASH_NOMINATION_DEFINITION,
  MORPHO_FLASH_IDENTITY_DEFINITION,
  MORPHO_FLASH_MATERIALIZATION_DEFINITION,
  MORPHO_FLASH_PROJECTION_DEFINITION,
  MORPHO_FLASH_REHYDRATION_DEFINITION,
]);

export function requireMorphoFlashStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = MORPHO_FLASH_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`morpho-flash stage definition missing: ${stage}`);
  return definition;
}
