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
  FLUID_DEX_FAMILY_DEFINITION_HASH,
} from "../family-definition.ts";
import {
  FLUID_DEX_CONTRACT_EVIDENCE_TOPIC,
  FLUID_DEX_FACTORY,
  FLUID_DEX_FAMILY_ID,
  FLUID_DEX_FAMILY_VERSION,
  FLUID_DEX_SOURCE_WINDOW_BLOCKS,
} from "../manifest.ts";
import { FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH } from "../metadata.ts";
import {
  deriveFluidDexRoutes,
  identityDescriptorHash,
  materializeFluidDex,
  resealFluidDexState,
  verifyFluidDexIdentityStage,
} from "../stages.ts";
import {
  canonicalAddress,
  type FluidDexCandidateV1,
  type FluidDexCutoffV1,
  type FluidDexIdentityV1,
  type FluidDexMaterializedStateV1,
  type FluidDexObservationV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(FLUID_DEX_FAMILY_VERSION);
const IDENTITY_READ_PLAN = Object.freeze(["target", "reverseTarget", "inputAsset", "outputAsset", "candidateEvidence"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);

const STAGE_IDS = Object.freeze({
  nomination: `family.${FLUID_DEX_FAMILY_ID}.nomination`,
  identity: `family.${FLUID_DEX_FAMILY_ID}.identity`,
  materialization: `family.${FLUID_DEX_FAMILY_ID}.materialization`,
  projection: `family.${FLUID_DEX_FAMILY_ID}.projection`,
  rehydration: `family.${FLUID_DEX_FAMILY_ID}.rehydration`,
});

const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/fluid-dex/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/fluid-dex/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/fluid-dex/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/fluid-dex/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/fluid-dex/stage-schema/v1", "rehydration"),
});

const REQUESTED_ARTIFACT_DEPENDENCY_ROOT = hashDomain(
  "aloha/fluid-dex/requested-artifact-dependencies/v1",
  { familyId: FLUID_DEX_FAMILY_ID, version: FLUID_DEX_FAMILY_VERSION },
);

type FluidDexCandidateRecordV1 = CandidateRecordV1;

interface CandidateBindingV1 {
  readonly familyId: typeof FLUID_DEX_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
  readonly instanceNominationKey: string;
  readonly candidate: FluidDexCandidateV1;
}

interface IdentityMemoV1 {
  readonly kind: "fluid-dex-identity-memo";
  readonly version: 1;
  readonly familyId: typeof FLUID_DEX_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: FluidDexIdentityV1;
}

interface NominationPayloadV1 {
  readonly kind: "fluid-dex-nomination-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: FluidDexCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayloadV1 {
  readonly kind: "fluid-dex-identity-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: FluidDexCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
}

interface MaterializationPayloadV1 {
  readonly kind: "fluid-dex-materialization-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: FluidDexCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutputV1 {
  readonly kind: "fluid-dex-materialization-output";
  readonly binding: CandidateBindingV1;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: FluidDexCutoffV1;
  readonly state: FluidDexMaterializedStateV1;
}

interface ProjectionPayloadV1 {
  readonly kind: "fluid-dex-projection-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: FluidDexCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayloadV1 {
  readonly kind: "fluid-dex-rehydration-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: FluidDexCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
}

interface NominationOutputV1 {
  readonly kind: "fluid-dex-nomination-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: FluidDexCutoffV1;
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
  readonly kind: "fluid-dex-rehydration-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: FluidDexCutoffV1;
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

function cutoff(value: unknown, path: string): FluidDexCutoffV1 {
  return decodeExactObject<FluidDexCutoffV1>(value, {
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

function sameCutoff(left: FluidDexCutoffV1, right: FluidDexCutoffV1): boolean {
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

function observation(value: unknown, path: string): FluidDexObservationV1 {
  const decoded = decodeExactObject<FluidDexObservationV1>(value, {
    kind: (item, itemPath) => { if (item !== "log") throw new TypeError(`${itemPath} kind mismatch`); return "log"; },
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    blockNumber: (item, itemPath) => assertDecimalString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    txHash: (item, itemPath) => assertHash(item, itemPath),
    logIndex: (item, itemPath) => assertDecimalString(item, itemPath),
    target: (item, itemPath) => address(item, itemPath),
    topic: (item, itemPath) => assertHash(item, itemPath),
    rawLocatorHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  return decoded;
}

function internalCandidate(value: unknown, path: string): FluidDexCandidateV1 {
  const decoded = decodeExactObject<FluidDexCandidateV1>(value, {
    target: (item, itemPath) => address(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => observation(item, itemPath),
  }, path);
  if (decoded.target !== decoded.evidence.target) throw new TypeError("fluid-dex-candidate-evidence-target-mismatch");
  if (decoded.instanceNominationKey !== decoded.target) throw new TypeError("fluid-dex-candidate-nomination-key-mismatch");
  if (decoded.candidateSnapshotHash !== candidateSubjectHash(FLUID_DEX_FAMILY_DEFINITION_HASH, decoded.instanceNominationKey)) throw new TypeError("fluid-dex-candidate-snapshot-mismatch");
  return deepFreeze(decoded);
}

function candidateRecord(value: unknown, path: string): FluidDexCandidateRecordV1 {
  const decoded = decodeExactObject<FluidDexCandidateRecordV1>(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return item; },
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyId !== FLUID_DEX_FAMILY_ID) throw new TypeError("fluid-dex-candidate-family-mismatch");
  if (decoded.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) {
    throw new TypeError("fluid-dex-candidate-key-mismatch");
  }
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-dex-candidate-subject-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("fluid-dex-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new TypeError("fluid-dex-candidate-evidence-duplicate");
  const sortedEvidenceKeys = [...evidenceKeys].sort();
  if (evidenceKeys.some((item, index) => item !== sortedEvidenceKeys[index])) throw new TypeError("fluid-dex-candidate-evidence-order");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("fluid-dex-candidate-evidence-root-mismatch");
  if (decoded.evidence.some(item => item.kind === "recent-log" && (address(item.address, `${path}.evidence.address`) !== address(decoded.instanceNominationKey, `${path}.instanceNominationKey`) || item.topic !== FLUID_DEX_CONTRACT_EVIDENCE_TOPIC))) throw new TypeError("fluid-dex-candidate-evidence-target-topic-mismatch");
  return deepFreeze(decoded);
}

function primaryEvidence(evidence: readonly CandidateEvidenceRefV1[]): CandidateEvidenceRefV1 {
  const selected = evidence.find(item => item.kind === "source-plan") ?? evidence[0];
  if (selected === undefined) throw new TypeError("fluid-dex-candidate-evidence-empty");
  return selected;
}

function candidateBindingFromRecord(value: unknown, cutoffValue: FluidDexCutoffV1, path: string): CandidateBindingV1 {
  const record = candidateRecord(value, path);
  const selected = primaryEvidence(record.evidence);
  const candidate = internalCandidate({
    target: record.instanceNominationKey,
    instanceNominationKey: record.instanceNominationKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    evidence: {
      kind: "log",
      cutoff: cutoffValue,
      blockNumber: selected.kind === "recent-log" ? selected.blockNumber : cutoffValue.number,
      blockHash: selected.kind === "recent-log" ? selected.blockHash : cutoffValue.hash,
      txHash: selected.kind === "recent-log" ? selected.txHash : cutoffValue.hash,
      logIndex: selected.kind === "recent-log" ? selected.logIndex : "0",
      target: record.instanceNominationKey,
      topic: FLUID_DEX_CONTRACT_EVIDENCE_TOPIC,
      rawLocatorHash: selected.rawLocatorHash,
    },
  }, `${path}.internalCandidate`);
  return deepFreeze({
    familyId: FLUID_DEX_FAMILY_ID,
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    candidateEvidenceRoot: record.candidateEvidenceRoot,
    evidence: record.evidence,
    instanceNominationKey: record.instanceNominationKey,
    candidate,
  });
}

function assertCandidateBinding(binding: CandidateBindingV1, cutoffValue: FluidDexCutoffV1): void {
  if (binding.familyId !== FLUID_DEX_FAMILY_ID
    || binding.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH
    || binding.familyCandidateKey !== discoveryFamilyCandidateKey(binding.familyDefinitionHash, binding.instanceNominationKey)
    || binding.candidateSnapshotHash !== candidateSubjectHash(binding.familyDefinitionHash, binding.instanceNominationKey)
    || binding.candidateEvidenceRoot !== candidateEvidenceRoot(binding.evidence)
    || binding.evidence.length === 0
    || binding.candidate.evidence.rawLocatorHash !== primaryEvidence(binding.evidence).rawLocatorHash
    || binding.instanceNominationKey !== binding.candidate.instanceNominationKey
    || binding.candidateSnapshotHash !== binding.candidate.candidateSnapshotHash
    || !sameCutoff(binding.candidate.evidence.cutoff, cutoffValue)) throw new TypeError("fluid-dex-payload-candidate-binding-mismatch");
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

function identityRequestId(target: string, cutoffValue: FluidDexCutoffV1, operation: string): Hash {
  return hashDomain("aloha/fluid-dex/request-id/v1", { phase: "identity", target, operation, cutoff: cutoffValue });
}

function stateRequestId(instanceKey: string, cutoffValue: FluidDexCutoffV1): Hash {
  return hashDomain("aloha/fluid-dex/request-id/v1", { phase: "materialization", target: instanceKey, operation: "state", cutoff: cutoffValue });
}

function nominationRequestId(binding: CandidateBindingV1, cutoffValue: FluidDexCutoffV1): Hash {
  return hashDomain("aloha/fluid-dex/request-id/v1", {
    phase: "nomination",
    target: binding.candidate.target,
    candidateSnapshotHash: binding.candidateSnapshotHash,
    cutoff: cutoffValue,
  });
}

function rehydrationReferenceHash(binding: CandidateBindingV1, cutoffValue: FluidDexCutoffV1): Hash {
  return hashDomain("aloha/fluid-dex/rehydration-reference/v1", {
    familyDefinitionHash: binding.familyDefinitionHash,
    familyCandidateKey: binding.familyCandidateKey,
    candidateSnapshotHash: binding.candidateSnapshotHash,
    instanceKey: binding.candidate.target,
    cutoff: cutoffValue,
  });
}

function rehydrationRequestId(binding: CandidateBindingV1, cutoffValue: FluidDexCutoffV1): Hash {
  return hashDomain("aloha/fluid-dex/request-id/v1", {
    phase: "rehydration",
    target: binding.candidate.target,
    referenceHash: rehydrationReferenceHash(binding, cutoffValue),
    cutoff: cutoffValue,
  });
}

function identityMemo(value: unknown, path: string): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-identity-memo") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-identity-memo"; },
    version: (item, itemPath) => { if (item !== 1) throw new TypeError(`${itemPath} version mismatch`); return 1; },
    familyId: (item, itemPath) => { if (item !== FLUID_DEX_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return FLUID_DEX_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex identity definition mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey) throw new TypeError("fluid-dex identity nomination key mismatch");
  if (decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash || decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-dex identity snapshot mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-dex identity candidate key mismatch");
  return decoded;
}

function decodeIdentity(value: unknown, path: string): FluidDexIdentityV1 {
  const decoded = decodeExactObject<FluidDexIdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject<FluidDexIdentityV1["facts"]>(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      inputAsset: (field, fieldPath) => address(field, fieldPath),
      outputAsset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.facts.target) throw new TypeError("fluid-dex identity instance mismatch");
  if (decoded.facts.inputAsset === decoded.facts.outputAsset) throw new TypeError("fluid-dex identity asset pair invalid");
  if (decoded.factsHash !== hashDomain("aloha/fluid-dex/identity-facts/v1", decoded.facts)) throw new TypeError("fluid-dex identity facts hash mismatch");
  return decoded;
}

function identityMemoHash(value: IdentityMemoV1): Hash {
  return hashDomain("aloha/identity-memo/v1", value);
}

function assertIdentityBinding(binding: CandidateBindingV1, memo: IdentityMemoV1, cutoffValue: FluidDexCutoffV1): void {
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
  ) throw new TypeError("fluid-dex identity lineage mismatch");
}

function decodeState(value: unknown, path: string): FluidDexMaterializedStateV1 {
  const decoded = decodeExactObject<FluidDexMaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    reserveIn: (item, itemPath) => assertDecimalString(item, itemPath),
    reserveOut: (item, itemPath) => assertDecimalString(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stateHash !== resealFluidDexState(decoded)) throw new TypeError("fluid-dex materialized state hash mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path: string): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-materialization-output") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-materialization-output"; },
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
  ) throw new TypeError("fluid-dex materialization output lineage mismatch");
  return decoded;
}

function decodeCandidateBinding(value: unknown, path: string): CandidateBindingV1 {
  const decoded = decodeExactObject<CandidateBindingV1>(value, {
    familyId: (item, itemPath) => { if (item !== FLUID_DEX_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return FLUID_DEX_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidate: (item, itemPath) => internalCandidate(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex binding definition mismatch");
  return decoded;
}

function decodeNominationPayload(value: unknown, path = "fluid-dex.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-nomination-input") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-nomination-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "fluid-dex.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-identity-input") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-identity-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestIds: (item, itemPath) => hashList(item, itemPath, IDENTITY_READ_PLAN.length),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  const expectedIds = IDENTITY_READ_PLAN.map(operation => identityRequestId(decoded.binding.candidate.target, decoded.cutoff, operation));
  if (decoded.requestIds.length !== expectedIds.length || decoded.requestIds.some((item, index) => item !== expectedIds[index])) throw new TypeError("fluid-dex identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "fluid-dex.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-materialization-input") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-materialization-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("fluid-dex materialization request mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "fluid-dex.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-projection-input") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-projection-input"; },
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
    || decoded.materialization.binding.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot
    || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash
    || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff)
  ) throw new TypeError("fluid-dex projection materialization lineage mismatch");
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("fluid-dex projection request mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "fluid-dex.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-rehydration-input") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-rehydration-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex rehydration reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex rehydration request mismatch");
  return decoded;
}

function decodeIdentityObservation(value: unknown, path = "fluid-dex.identityOutput"): IdentityObservationV1 {
  const decoded = decodeExactObject<IdentityObservationV1>(value, {
    kind: (item, itemPath) => { if (item !== "identityVerified") throw new TypeError(`${itemPath} kind mismatch`); return "identityVerified"; },
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey) throw new TypeError("fluid-dex identity output instance mismatch");
  if (decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo)) throw new TypeError("fluid-dex identity output memo hash mismatch");
  if (decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity)) throw new TypeError("fluid-dex identity output descriptor mismatch");
  if (decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("fluid-dex identity output evidence mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "fluid-dex.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-nomination-verified") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-nomination-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex nomination output request mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "fluid-dex.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "fluid-dex-rehydration-verified") throw new TypeError(`${itemPath} kind mismatch`); return "fluid-dex-rehydration-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.candidate.target) throw new TypeError("fluid-dex rehydration instance mismatch");
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex rehydration output reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-dex rehydration output request mismatch");
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
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "fluid-dex.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("fluid-dex transport request partition mismatch");
  const programSource = source(program.source, "fluid-dex.program.source");
  const byId = new Map<Hash, TransportFactV1>();
  for (const item of decoded) byId.set(item.requestId, item);
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`fluid-dex missing request fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, programSource)) throw new TypeError("fluid-dex transport fact source mismatch");
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
  if (input.dependencyRefs.length !== 0) throw new TypeError("fluid-dex lifecycle dependency closure is not empty");
  const programSource = source(input.program.source, "fluid-dex.program.source");
  if (
    input.program.payloadSchemaRef !== schemaHash
    || input.program.capabilityRef.capabilityId !== capabilityId
    || input.program.capabilityRef.schemaHash !== schemaHash
    || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes
  ) throw new TypeError(`fluid-dex ${stage} program binding mismatch`);
  if (!Object.isFrozen(programSource)) throw new TypeError("fluid-dex program source must be frozen");
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

function rawBytes(value: string, path: string): Uint8Array {
  const hex = bytes(value, path);
  const result = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

function blockTag(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

const GET_DEX_ADDRESS_SELECTOR = "0x12e366aa";

function verifyCandidateEvidence(payload: IdentityPayloadV1, value: Uint8Array): void {
  const evidence = primaryEvidence(payload.binding.evidence);
  if (sha256Hex(value) !== evidence.rawLocatorHash || payload.binding.candidate.evidence.rawLocatorHash !== evidence.rawLocatorHash) throw new TypeError("fluid-dex identity raw locator mismatch");
  if (evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(value, "fluid-dex.identity.recentEvidence");
    if (raw.blockNumber !== evidence.blockNumber
      || raw.blockHash !== evidence.blockHash
      || raw.transactionHash !== evidence.txHash
      || raw.logIndex !== evidence.logIndex
      || raw.address !== evidence.address
      || raw.address !== payload.binding.instanceNominationKey
      || raw.topics.length < 2
      || raw.topics[0] !== evidence.topic
      || raw.topics[0] !== FLUID_DEX_CONTRACT_EVIDENCE_TOPIC
      || !/^0x(?:[0-9a-f]{64}){2,}$/.test(raw.data)
      || BigInt(`0x${raw.data.slice(2, 66)}`) === 0n
      || BigInt(`0x${raw.data.slice(66, 130)}`) === 0n
      || BigInt(raw.blockNumber) > BigInt(payload.cutoff.number)
      || BigInt(raw.blockNumber) < BigInt(payload.cutoff.number) - BigInt(FLUID_DEX_SOURCE_WINDOW_BLOCKS - 1)) throw new TypeError("fluid-dex recent evidence binding mismatch");
    return;
  }
  const observed = decodeFamilySourcePlanPhysicalObservation(value, "fluid-dex.identity.factoryEvidence");
  if (observed.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH
    || observed.plan.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH
    || observed.plan.ownerRef !== evidence.ownerRef
    || observed.plan.sourcePlanRef !== evidence.sourcePlanRef
    || observed.plan.completeness !== "complete-snapshot"
    || observed.plan.historyStartBlock !== null
    || !sameCutoff(observed.cutoff, payload.cutoff)
    || observed.requestSchemaHash !== FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH
    || observed.request.kind !== "family-source-plan-rpc"
    || observed.request.version !== 1
    || observed.request.method !== "eth_call"
    || observed.request.target !== FLUID_DEX_FACTORY
    || observed.request.manager !== FLUID_DEX_FACTORY
    || observed.request.topic !== null
    || observed.request.lookback !== null
    || observed.request.chunk !== null) throw new TypeError("fluid-dex factory evidence binding mismatch");
  const params = observed.request.params;
  if (!Array.isArray(params) || params.length !== 2 || params[1] !== blockTag(payload.cutoff.number)) throw new TypeError("fluid-dex factory evidence params mismatch");
  const call = params[0];
  if (call === null || typeof call !== "object" || Array.isArray(call) || Reflect.ownKeys(call).sort().join(",") !== "data,to" || call.to !== FLUID_DEX_FACTORY || typeof call.data !== "string" || !call.data.startsWith(GET_DEX_ADDRESS_SELECTOR) || call.data.length !== GET_DEX_ADDRESS_SELECTOR.length + 64 || BigInt(`0x${call.data.slice(GET_DEX_ADDRESS_SELECTOR.length)}`) < 1n) throw new TypeError("fluid-dex factory evidence call mismatch");
  if (typeof observed.response !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(observed.response) || canonicalAddress(`0x${observed.response.slice(-40)}`) !== payload.binding.instanceNominationKey) throw new TypeError("fluid-dex factory evidence response mismatch");
}

function portRef(instanceKey: string, direction: "input" | "output", asset: string): Hash {
  return hashDomain("aloha/fluid-dex/asset-port/v1", { instanceKey, direction, asset });
}

function transition(
  chainId: string,
  instanceKey: string,
  inputAsset: string,
  outputAsset: string,
  routeBindingHash: Hash,
  state: FluidDexMaterializedStateV1,
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
  const opaqueTransitionRef = hashDomain("aloha/fluid-dex/transition/v1", {
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
  state: FluidDexMaterializedStateV1,
): InstancePublicationV1 {
  const routeList = deriveFluidDexRoutes(payload.identityMemo.identity);
  const route = routeList[0];
  if (route === undefined) throw new TypeError("fluid-dex route derivation returned no route");
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
    familyId: FLUID_DEX_FAMILY_ID,
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: route.instanceKey,
    cutoff: payload.cutoff,
    identityMemo,
    identityMemoHash: identityMemoHash(payload.identityMemo),
    descriptorHash: identityDescriptorHash(payload.identityMemo.identity),
    staticProjectionMemoHash: hashDomain("aloha/fluid-dex/static-projection-memo/v1", transitions),
    requestedArtifactDependencyRoot: REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    validityDependencyRoot: hashDomain("aloha/fluid-dex/validity-dependencies/v1", {
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

function decodePublication(value: unknown, path = "fluid-dex.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => { if (item !== FLUID_DEX_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return FLUID_DEX_FAMILY_ID; },
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
  if (decoded.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex publication definition mismatch");
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
  ) throw new TypeError("fluid-dex publication lineage mismatch");
  const routeList = deriveFluidDexRoutes(memo.identity);
  const route = routeList[0];
  const sealedTransition = decoded.transitions[0];
  if (route === undefined || sealedTransition === undefined) throw new TypeError("fluid-dex publication route missing");
  const expectedDraft = transitionDraft(sealedTransition);
  if (decoded.staticProjectionMemoHash !== hashDomain("aloha/fluid-dex/static-projection-memo/v1", [expectedDraft])) throw new TypeError("fluid-dex publication projection memo mismatch");
  const inputPort = sealedTransition.inputAssetPorts[0];
  const outputPort = sealedTransition.outputAssetPorts[0];
  if (sealedTransition.inputAssetPorts.length !== 1 || sealedTransition.outputAssetPorts.length !== 1 || sealedTransition.constraintRefs.length !== 1) throw new TypeError("fluid-dex publication transition shape mismatch");
  const stateHash = sealedTransition.constraintRefs[0];
  if (stateHash === undefined) throw new TypeError("fluid-dex publication state constraint missing");
  if (sealedTransition.opaqueTransitionRef !== hashDomain("aloha/fluid-dex/transition/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
    routeBindingHash: route.routeBindingHash,
    stateHash,
  })) throw new TypeError("fluid-dex publication transition binding mismatch");
  if (decoded.validityDependencyRoot !== hashDomain("aloha/fluid-dex/validity-dependencies/v1", {
    identityFactsHash: memo.identity.factsHash,
    stateHash,
  })) throw new TypeError("fluid-dex publication validity binding mismatch");
  if (
    inputPort === undefined
    || outputPort === undefined
    || inputPort.ordinal !== "0"
    || outputPort.ordinal !== "0"
    || inputPort.assetRef !== erc20AssetPortBindingV1(decoded.cutoff.chainId, route.inputAsset).assetRef
    || inputPort.portRef !== portRef(route.instanceKey, "input", route.inputAsset)
    || outputPort.assetRef !== erc20AssetPortBindingV1(decoded.cutoff.chainId, route.outputAsset).assetRef
    || outputPort.portRef !== portRef(route.instanceKey, "output", route.outputAsset)
  ) throw new TypeError("fluid-dex publication asset binding mismatch");
  validateInstancePublication(decoded);
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be an object`);
  return decoded;
}

function identityOutput(value: unknown): CanonicalJson {
  return outputObject(decodeIdentityObservation(value), "fluid-dex.identityOutput");
}

function materializationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, "fluid-dex.materializationOutput"), "fluid-dex.materializationOutput");
}

function projectionOutput(value: unknown): CanonicalJson {
  return outputObject(decodePublication(value), "fluid-dex.projectionOutput");
}

function nominationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeNominationOutput(value), "fluid-dex.nominationOutput");
}

function rehydrationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeRehydrationOutput(value), "fluid-dex.rehydrationOutput");
}

function requireStage(input: FamilyStageGenericInvocationV1, expected: FamilyRuntimeStageV1): void {
  if (input.stage !== expected) throw new TypeError(`fluid-dex-${expected}-stage-mismatch`);
}

function requireNoPriorOutputs(input: FamilyStageGenericInvocationV1): void {
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("fluid-dex-unexpected-prior-stage-output");
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  requireStage(input, "nomination");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "fluid-dex.nominationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "fluid-dex.nominationInvocation.candidate");
  return Object.freeze({
    kind: "fluid-dex-nomination-input",
    binding,
    cutoff: cutoffValue,
    readPlan: NOMINATION_READ_PLAN,
    requestId: nominationRequestId(binding, cutoffValue),
  });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  requireStage(input, "identity");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "fluid-dex.identityInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "fluid-dex.identityInvocation.candidate");
  return Object.freeze({
    kind: "fluid-dex-identity-input",
    binding,
    cutoff: cutoffValue,
    readPlan: IDENTITY_READ_PLAN,
    requestIds: IDENTITY_READ_PLAN.map(operation => identityRequestId(binding.candidate.target, cutoffValue, operation)),
  });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  requireStage(input, "materialization");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("fluid-dex-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "fluid-dex.materializationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "fluid-dex.materializationInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "fluid-dex.materializationInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  return Object.freeze({
    kind: "fluid-dex-materialization-input",
    binding,
    identityMemo: memo,
    cutoff: cutoffValue,
    readPlan: STATE_READ_PLAN,
    requestId: stateRequestId(memo.identity.instanceKey, cutoffValue),
  });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  requireStage(input, "projection");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("fluid-dex-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "fluid-dex.projectionInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "fluid-dex.projectionInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "fluid-dex.projectionInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput, "fluid-dex.projectionInvocation.materializationOutput");
  if (
    materialization.binding.familyCandidateKey !== binding.familyCandidateKey
    || materialization.binding.candidateEvidenceRoot !== binding.candidateEvidenceRoot
    || materialization.identityMemoHash !== identityMemoHash(memo)
    || materialization.identityFactsHash !== memo.identity.factsHash
    || !sameCutoff(materialization.cutoff, cutoffValue)
  ) throw new TypeError("fluid-dex-projection-materialization-lineage-mismatch");
  return Object.freeze({
    kind: "fluid-dex-projection-input",
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
  const cutoffValue = cutoff(input.cutoff, "fluid-dex.rehydrationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "fluid-dex.rehydrationInvocation.candidate");
  return Object.freeze({
    kind: "fluid-dex-rehydration-input",
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
    const fact = returned(facts[0]!, "fluid-dex.nomination");
    if (fact.dataHex !== ackData(payload.binding.candidateSnapshotHash)) throw new TypeError("fluid-dex-nomination-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "fluid-dex-nomination-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-dex-nomination-invalid") });
  }
}

function interpretIdentity(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.identity);
    assertProgramForStage(input, "identity", schemaHash, STAGE_IDS.identity);
    const payload = decodeIdentityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const target = decodeAddressWord(returned(facts[0]!, "fluid-dex.identity.target").dataHex, "fluid-dex.identity.target");
    const reverseTarget = decodeAddressWord(returned(facts[1]!, "fluid-dex.identity.reverseTarget").dataHex, "fluid-dex.identity.reverseTarget");
    const inputAsset = decodeAddressWord(returned(facts[2]!, "fluid-dex.identity.inputAsset").dataHex, "fluid-dex.identity.inputAsset");
    const outputAsset = decodeAddressWord(returned(facts[3]!, "fluid-dex.identity.outputAsset").dataHex, "fluid-dex.identity.outputAsset");
    verifyCandidateEvidence(payload, rawBytes(returned(facts[4]!, "fluid-dex.identity.candidateEvidence").dataHex, "fluid-dex.identity.candidateEvidence"));
    const result = verifyFluidDexIdentityStage({
      candidate: payload.binding.candidate,
      reads: { cutoff: payload.cutoff, target, reverseTarget, inputAsset, outputAsset },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo: IdentityMemoV1 = Object.freeze({
      kind: "fluid-dex-identity-memo",
      version: 1,
      familyId: FLUID_DEX_FAMILY_ID,
      familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
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
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-dex-identity-invalid") });
  }
}

function interpretMaterialization(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.materialization);
    assertProgramForStage(input, "materialization", schemaHash, STAGE_IDS.materialization);
    const payload = decodeMaterializationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "fluid-dex.materialization.state");
    const reserves = decodeReserveWords(fact.dataHex, "fluid-dex.materialization.state");
    const result = materializeFluidDex({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "fluid-dex-materialization-output",
      binding: payload.binding,
      identityMemoHash: identityMemoHash(payload.identityMemo),
      identityFactsHash: payload.identityMemo.identity.factsHash,
      cutoff: payload.cutoff,
      state: result.state,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-dex-materialization-invalid") });
  }
}

function interpretProjection(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.projection);
    assertProgramForStage(input, "projection", schemaHash, STAGE_IDS.projection);
    const payload = decodeProjectionPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "fluid-dex.projection.state");
    const reserves = decodeReserveWords(fact.dataHex, "fluid-dex.projection.state");
    const result = materializeFluidDex({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("fluid-dex-projection-state-lineage-mismatch");
    if (result.state.identityFactsHash !== payload.identityMemo.identity.factsHash) throw new TypeError("fluid-dex-projection-identity-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-dex-projection-invalid") });
  }
}

function interpretRehydration(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.rehydration);
    assertProgramForStage(input, "rehydration", schemaHash, STAGE_IDS.rehydration);
    const payload = decodeRehydrationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "fluid-dex.rehydration.reference");
    if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("fluid-dex-rehydration-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "fluid-dex-rehydration-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      instanceKey: payload.binding.candidate.target,
      referenceHash: payload.referenceHash,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-dex-rehydration-invalid") });
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
    implementationClosureHash: hashDomain("aloha/fluid-dex/runtime-implementation/v1", {
      stage,
      module: "families/fluid-dex/src/runtime/definitions.ts",
    }),
    outputCodecHash: hashDomain("aloha/fluid-dex/runtime-output-codec/v1", stage),
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

export const FLUID_DEX_NOMINATION_RUNTIME = definitionBase(
  "nomination",
  nominationPayloadCodec,
  hashDomain("aloha/fluid-dex/runtime-output-schema/v1", "nomination"),
  Object.freeze({ decodeExact: nominationOutput }),
  prepareNomination,
  interpretNomination,
);

export const FLUID_DEX_IDENTITY_RUNTIME = definitionBase(
  "identity",
  identityPayloadCodec,
  hashDomain("aloha/fluid-dex/runtime-output-schema/v1", "identity"),
  Object.freeze({ decodeExact: identityOutput }),
  prepareIdentity,
  interpretIdentity,
);

export const FLUID_DEX_MATERIALIZATION_RUNTIME = definitionBase(
  "materialization",
  materializationPayloadCodec,
  hashDomain("aloha/fluid-dex/runtime-output-schema/v1", "materialization"),
  Object.freeze({ decodeExact: materializationOutput }),
  prepareMaterialization,
  interpretMaterialization,
);

export const FLUID_DEX_PROJECTION_RUNTIME = definitionBase(
  "projection",
  projectionPayloadCodec,
  hashDomain("aloha/fluid-dex/runtime-output-schema/v1", "projection"),
  Object.freeze({ decodeExact: projectionOutput }),
  prepareProjection,
  interpretProjection,
);

export const FLUID_DEX_REHYDRATION_RUNTIME = definitionBase(
  "rehydration",
  rehydrationPayloadCodec,
  hashDomain("aloha/fluid-dex/runtime-output-schema/v1", "rehydration"),
  Object.freeze({ decodeExact: rehydrationOutput }),
  prepareRehydration,
  interpretRehydration,
);

export const FLUID_DEX_NOMINATION_DEFINITION = FLUID_DEX_NOMINATION_RUNTIME;
export const FLUID_DEX_IDENTITY_DEFINITION = FLUID_DEX_IDENTITY_RUNTIME;
export const FLUID_DEX_MATERIALIZATION_DEFINITION = FLUID_DEX_MATERIALIZATION_RUNTIME;
export const FLUID_DEX_PROJECTION_DEFINITION = FLUID_DEX_PROJECTION_RUNTIME;
export const FLUID_DEX_REHYDRATION_DEFINITION = FLUID_DEX_REHYDRATION_RUNTIME;

export const FLUID_DEX_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  FLUID_DEX_NOMINATION_RUNTIME,
  FLUID_DEX_IDENTITY_RUNTIME,
  FLUID_DEX_MATERIALIZATION_RUNTIME,
  FLUID_DEX_PROJECTION_RUNTIME,
  FLUID_DEX_REHYDRATION_RUNTIME,
]);

export function requireFluidDexStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = FLUID_DEX_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`fluid-dex stage definition missing: ${stage}`);
  return definition;
}
