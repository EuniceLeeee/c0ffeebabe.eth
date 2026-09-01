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
import { decodeAssetIdentityV1, erc20AssetPortBindingV1, nativeAssetPortBindingV1 } from "../../../../packages/asset-ref/src/index.ts";
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
import { decodeEvmLogObservationBytes, encodeEvmLogObservation } from "../../../../packages/observation/src/index.ts";
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
  type SourcePlanEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import { decodeFamilySourcePlanPhysicalObservation } from "../../../../packages/family-sdk/runtime/index.ts";
import {
  ANGSTROM_V4_FAMILY_DEFINITION_HASH,
} from "../family-definition.ts";
import {
  ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
  ANGSTROM_V4_FAMILY_ID,
  ANGSTROM_V4_FAMILY_VERSION,
  ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../manifest.ts";
import {
  ANGSTROM_MAINNET_HOOK,
  ANGSTROM_V4_POOL_MANAGER,
  ANGSTROM_V4_QUOTER,
  ANGSTROM_V4_STATE_VIEW,
  assertPoolKey,
  decodeAngstromV4InitializeLog,
  poolIdForKey,
} from "../abi.ts";
import {
  candidateSnapshotHash,
  decodeAngstromV4Candidate,
  deriveAngstromV4Routes,
  identityDescriptorHash,
  materializeAngstromV4,
  nominateAngstromV4,
  resealAngstromV4State,
  verifyAngstromV4IdentityStage,
} from "../stages.ts";
import {
  canonicalAddress,
  type AngstromV4CandidateV1,
  type AngstromV4CutoffV1,
  type AngstromV4IdentityV1,
  type AngstromV4MaterializedStateV1,
  type AngstromV4ObservationV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(ANGSTROM_V4_FAMILY_VERSION);
const IDENTITY_READ_PLAN = Object.freeze(["initializeEvidence"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);

const STAGE_IDS = Object.freeze({
  nomination: `family.${ANGSTROM_V4_FAMILY_ID}.nomination`,
  identity: `family.${ANGSTROM_V4_FAMILY_ID}.identity`,
  materialization: `family.${ANGSTROM_V4_FAMILY_ID}.materialization`,
  projection: `family.${ANGSTROM_V4_FAMILY_ID}.projection`,
  rehydration: `family.${ANGSTROM_V4_FAMILY_ID}.rehydration`,
});

const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/angstrom-v4/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/angstrom-v4/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/angstrom-v4/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/angstrom-v4/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/angstrom-v4/stage-schema/v1", "rehydration"),
});

const REQUESTED_ARTIFACT_DEPENDENCY_ROOT = hashDomain(
  "aloha/angstrom-v4/requested-artifact-dependencies/v1",
  { familyId: ANGSTROM_V4_FAMILY_ID, version: ANGSTROM_V4_FAMILY_VERSION },
);

interface AngstromV4CandidateRecordV1 {
  readonly kind: "aloha.candidate-record";
  readonly version: "2";
  readonly familyId: typeof ANGSTROM_V4_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
}

type CandidateBindingV1 = AngstromV4CandidateRecordV1;

interface IdentityMemoV1 {
  readonly kind: "angstrom-v4-identity-memo";
  readonly familyId: typeof ANGSTROM_V4_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: AngstromV4IdentityV1;
}

interface NominationPayloadV1 {
  readonly kind: "angstrom-v4-nomination-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: AngstromV4CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayloadV1 {
  readonly kind: "angstrom-v4-identity-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: AngstromV4CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
}

interface MaterializationPayloadV1 {
  readonly kind: "angstrom-v4-materialization-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: AngstromV4CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutputV1 {
  readonly kind: "angstrom-v4-materialization-output";
  readonly binding: CandidateBindingV1;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: AngstromV4CutoffV1;
  readonly state: AngstromV4MaterializedStateV1;
}

interface ProjectionPayloadV1 {
  readonly kind: "angstrom-v4-projection-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: AngstromV4CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayloadV1 {
  readonly kind: "angstrom-v4-rehydration-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: AngstromV4CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
}

interface NominationOutputV1 {
  readonly kind: "angstrom-v4-nomination-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: AngstromV4CutoffV1;
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
  readonly kind: "angstrom-v4-rehydration-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: AngstromV4CutoffV1;
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

function instanceKey(value: unknown, path: string): string {
  return assertHash(value, path);
}

function cutoff(value: unknown, path: string): AngstromV4CutoffV1 {
  return decodeExactObject<AngstromV4CutoffV1>(value, {
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

function sameCutoff(left: AngstromV4CutoffV1, right: AngstromV4CutoffV1): boolean {
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

function hexBytes(value: unknown, path: string): Uint8Array {
  const encoded = bytes(value, path).slice(2);
  return Uint8Array.from({ length: encoded.length / 2 }, (_, index) => Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16));
}

function observation(value: unknown, path: string): AngstromV4ObservationV1 {
  const decoded = decodeExactObject<AngstromV4ObservationV1>(value, {
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

function candidateRecord(value: unknown, path: string): AngstromV4CandidateRecordV1 {
  const decoded = decodeExactObject<AngstromV4CandidateRecordV1>(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return "aloha.candidate-record"; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return "2"; },
    familyId: (item, itemPath) => { if (item !== ANGSTROM_V4_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return ANGSTROM_V4_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => instanceKey(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== ANGSTROM_V4_FAMILY_DEFINITION_HASH) throw new TypeError("angstrom-v4-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) {
    throw new TypeError("angstrom-v4-candidate-key-mismatch");
  }
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("angstrom-v4-candidate-subject-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("angstrom-v4-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new TypeError("angstrom-v4-candidate-evidence-duplicate");
  const sortedEvidenceKeys = [...evidenceKeys].sort();
  if (evidenceKeys.some((item, index) => item !== sortedEvidenceKeys[index])) throw new TypeError("angstrom-v4-candidate-evidence-order");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("angstrom-v4-candidate-evidence-root-mismatch");
  for (const evidence of decoded.evidence) {
    if (evidence.kind === "recent-log" && (address(evidence.address, `${path}.evidence.address`) !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER) || evidence.topic !== ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC)) {
      throw new TypeError("angstrom-v4-candidate-recent-evidence-pattern-mismatch");
    }
  }
  return deepFreeze(decoded);
}

function candidateBindingFromRecord(value: unknown, cutoffValue: AngstromV4CutoffV1, path: string): CandidateBindingV1 {
  const exactCutoff = cutoff(cutoffValue, `${path}.cutoff`);
  const record = candidateRecord(value, path);
  const through = BigInt(exactCutoff.number);
  const from = through > 49n ? through - 49n : 0n;
  for (const evidence of record.evidence) {
    if (evidence.kind !== "recent-log") continue;
    const block = BigInt(evidence.blockNumber);
    if (block > through) throw new TypeError("angstrom-v4-candidate-evidence-after-cutoff");
    if (block < from) throw new TypeError("angstrom-v4-candidate-evidence-before-window");
  }
  return record;
}

function assertCandidateBinding(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1): void {
  cutoff(cutoffValue, "angstrom-v4.binding.cutoff");
  candidateRecord(binding, "angstrom-v4.payload.candidate");
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

function primaryEvidence(binding: CandidateBindingV1): CandidateEvidenceRefV1 {
  const evidence = binding.evidence[0];
  if (evidence === undefined) throw new TypeError("angstrom-v4 candidate evidence is empty");
  return evidence;
}

function identityRequestId(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1): Hash {
  const evidence = primaryEvidence(binding);
  return hashDomain("aloha/angstrom-v4/request-id/v1", {
    phase: "identity",
    operation: "initializeEvidence",
    poolId: binding.instanceNominationKey,
    evidenceKind: evidence.kind,
    rawLocatorHash: evidence.rawLocatorHash,
    cutoff: cutoffValue,
  });
}

function stateRequestId(instanceKey: string, cutoffValue: AngstromV4CutoffV1): Hash {
  return hashDomain("aloha/angstrom-v4/request-id/v1", { phase: "materialization", target: instanceKey, operation: "state", cutoff: cutoffValue });
}

function nominationRequestId(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1): Hash {
  return hashDomain("aloha/angstrom-v4/request-id/v1", {
    phase: "nomination",
    target: ANGSTROM_V4_POOL_MANAGER,
    candidateSnapshotHash: binding.candidateSubjectHash,
    cutoff: cutoffValue,
  });
}

function rehydrationReferenceHash(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1): Hash {
  return hashDomain("aloha/angstrom-v4/rehydration-reference/v1", {
    familyDefinitionHash: binding.familyDefinitionHash,
    familyCandidateKey: binding.familyCandidateKey,
    candidateSnapshotHash: binding.candidateSubjectHash,
    candidateEvidenceRoot: binding.candidateEvidenceRoot,
    instanceKey: binding.instanceNominationKey,
    cutoff: cutoffValue,
  });
}

function rehydrationRequestId(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1): Hash {
  return hashDomain("aloha/angstrom-v4/request-id/v1", {
    phase: "rehydration",
    target: ANGSTROM_V4_POOL_MANAGER,
    referenceHash: rehydrationReferenceHash(binding, cutoffValue),
    cutoff: cutoffValue,
  });
}

function identityMemo(value: unknown, path: string): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-identity-memo") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-identity-memo"; },
    familyId: (item, itemPath) => { if (item !== ANGSTROM_V4_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return ANGSTROM_V4_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => instanceKey(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== ANGSTROM_V4_FAMILY_DEFINITION_HASH) throw new TypeError("angstrom-v4 identity definition mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey) throw new TypeError("angstrom-v4 identity nomination key mismatch");
  if (decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("angstrom-v4 identity snapshot mismatch");
  if (decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("angstrom-v4 identity subject mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("angstrom-v4 identity candidate key mismatch");
  return decoded;
}

function decodeManagerBinding(value: unknown, path: string): NonNullable<AngstromV4IdentityV1["facts"]["managerBinding"]> {
  const raw = canonical(value);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${path} must be a manager binding object`);
  return decodeExactObject<NonNullable<AngstromV4IdentityV1["facts"]["managerBinding"]>>(raw, {
    manager: (item, itemPath) => address(item, itemPath),
    stateView: (item, itemPath) => address(item, itemPath),
    quoter: (item, itemPath) => address(item, itemPath),
  }, path);
}

function decodeIdentityFacts(value: unknown, path: string): AngstromV4IdentityV1["facts"] {
  const raw = canonical(value);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${path} must be an identity facts object`);
  return decodeExactObject<AngstromV4IdentityV1["facts"]>(raw, {
    target: (item, itemPath) => address(item, itemPath),
    inputAsset: (item, itemPath) => address(item, itemPath),
    outputAsset: (item, itemPath) => address(item, itemPath),
    poolId: (item, itemPath) => assertHash(item, itemPath),
    poolKey: (item, itemPath) => assertPoolKey(item, itemPath),
    managerBinding: (item, itemPath) => decodeManagerBinding(item, itemPath),
  }, path);
}

function decodeIdentity(value: unknown, path: string): AngstromV4IdentityV1 {
  const decoded = decodeExactObject<AngstromV4IdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => instanceKey(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeIdentityFacts(item, itemPath),
  }, path);
  const { poolId, poolKey, managerBinding } = decoded.facts;
  if (
    decoded.instanceKey !== poolId
    || poolIdForKey(poolKey) !== poolId
    || poolKey.hooks !== canonicalAddress(ANGSTROM_MAINNET_HOOK)
    || decoded.facts.target !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER)
    || managerBinding.manager !== decoded.facts.target
    || managerBinding.stateView !== canonicalAddress(ANGSTROM_V4_STATE_VIEW)
    || managerBinding.quoter !== canonicalAddress(ANGSTROM_V4_QUOTER)
    || (decoded.facts.inputAsset !== poolKey.currency0 && decoded.facts.inputAsset !== poolKey.currency1)
    || (decoded.facts.outputAsset !== poolKey.currency0 && decoded.facts.outputAsset !== poolKey.currency1)
    || decoded.facts.inputAsset === decoded.facts.outputAsset
  ) throw new TypeError("angstrom-v4 identity strict PoolKey binding mismatch");
  if (decoded.factsHash !== hashDomain("aloha/angstrom-v4/identity-facts/v1", decoded.facts)) throw new TypeError("angstrom-v4 identity facts hash mismatch");
  return decoded;
}

function identityMemoHash(value: IdentityMemoV1): Hash {
  return hashDomain("aloha/identity-memo/v1", value);
}

function assertIdentityBinding(binding: CandidateBindingV1, memo: IdentityMemoV1, cutoffValue: AngstromV4CutoffV1): void {
  assertCandidateBinding(binding, cutoffValue);
  if (
    memo.familyId !== binding.familyId
    || memo.familyDefinitionHash !== binding.familyDefinitionHash
    || memo.familyCandidateKey !== binding.familyCandidateKey
    || memo.instanceNominationKey !== binding.instanceNominationKey
    || memo.candidateSnapshotHash !== binding.candidateSubjectHash
    || memo.candidateEvidenceRoot !== binding.candidateEvidenceRoot
    || !sameCutoff(memo.identity.cutoff, cutoffValue)
    || memo.identity.instanceKey !== binding.instanceNominationKey
  ) throw new TypeError("angstrom-v4 identity lineage mismatch");
}

function decodeState(value: unknown, path: string): AngstromV4MaterializedStateV1 {
  const decoded = decodeExactObject<AngstromV4MaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => instanceKey(item, itemPath),
    reserveIn: (item, itemPath) => assertDecimalString(item, itemPath),
    reserveOut: (item, itemPath) => assertDecimalString(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stateHash !== resealAngstromV4State(decoded)) throw new TypeError("angstrom-v4 materialized state hash mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path: string): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-materialization-output") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-materialization-output"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    state: (item, itemPath) => decodeState(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (
    !sameCutoff(decoded.state.cutoff, decoded.cutoff)
    || decoded.state.instanceKey !== decoded.binding.instanceNominationKey
    || decoded.state.identityFactsHash !== decoded.identityFactsHash
  ) throw new TypeError("angstrom-v4 materialization output lineage mismatch");
  return decoded;
}

function decodeCandidateBinding(value: unknown, path: string): CandidateBindingV1 {
  return candidateRecord(value, path);
}

function decodeNominationPayload(value: unknown, path = "angstrom-v4.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-nomination-input") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-nomination-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "angstrom-v4.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-identity-input") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-identity-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestIds: (item, itemPath) => hashList(item, itemPath, IDENTITY_READ_PLAN.length),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  const expectedIds = [identityRequestId(decoded.binding, decoded.cutoff)];
  if (decoded.requestIds.length !== expectedIds.length || decoded.requestIds.some((item, index) => item !== expectedIds[index])) throw new TypeError("angstrom-v4 identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "angstrom-v4.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-materialization-input") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-materialization-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("angstrom-v4 materialization request mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "angstrom-v4.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-projection-input") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-projection-input"; },
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
  ) throw new TypeError("angstrom-v4 projection materialization lineage mismatch");
  if (decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("angstrom-v4 projection request mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "angstrom-v4.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-rehydration-input") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-rehydration-input"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 rehydration reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 rehydration request mismatch");
  return decoded;
}

function decodeIdentityObservation(value: unknown, path = "angstrom-v4.identityOutput"): IdentityObservationV1 {
  const decoded = decodeExactObject<IdentityObservationV1>(value, {
    kind: (item, itemPath) => { if (item !== "identityVerified") throw new TypeError(`${itemPath} kind mismatch`); return "identityVerified"; },
    familyInstanceKey: (item, itemPath) => instanceKey(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey) throw new TypeError("angstrom-v4 identity output instance mismatch");
  if (decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo)) throw new TypeError("angstrom-v4 identity output memo hash mismatch");
  if (decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity)) throw new TypeError("angstrom-v4 identity output descriptor mismatch");
  if (decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("angstrom-v4 identity output evidence mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "angstrom-v4.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-nomination-verified") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-nomination-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 nomination output request mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "angstrom-v4.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => { if (item !== "angstrom-v4-rehydration-verified") throw new TypeError(`${itemPath} kind mismatch`); return "angstrom-v4-rehydration-verified"; },
    binding: (item, itemPath) => decodeCandidateBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => instanceKey(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.instanceNominationKey) throw new TypeError("angstrom-v4 rehydration instance mismatch");
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 rehydration output reference mismatch");
  if (decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("angstrom-v4 rehydration output request mismatch");
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
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "angstrom-v4.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("angstrom-v4 transport request partition mismatch");
  const programSource = source(program.source, "angstrom-v4.program.source");
  const byId = new Map<Hash, TransportFactV1>();
  for (const item of decoded) byId.set(item.requestId, item);
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`angstrom-v4 missing request fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, programSource)) throw new TypeError("angstrom-v4 transport fact source mismatch");
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
  if (input.dependencyRefs.length !== 0) throw new TypeError("angstrom-v4 lifecycle dependency closure is not empty");
  const programSource = source(input.program.source, "angstrom-v4.program.source");
  if (
    input.program.payloadSchemaRef !== schemaHash
    || input.program.capabilityRef.capabilityId !== capabilityId
    || input.program.capabilityRef.schemaHash !== schemaHash
    || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes
  ) throw new TypeError(`angstrom-v4 ${stage} program binding mismatch`);
  if (!Object.isFrozen(programSource)) throw new TypeError("angstrom-v4 program source must be frozen");
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

function rpcQuantity(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`);
  return BigInt(value).toString(10);
}

const blockTag = (value: string): string => `0x${BigInt(value).toString(16)}`;

function candidateFromRecentEvidence(
  binding: CandidateBindingV1,
  cutoffValue: AngstromV4CutoffV1,
  evidence: Extract<CandidateEvidenceRefV1, { readonly kind: "recent-log" }>,
  rawBytes: Uint8Array,
): { readonly candidate: AngstromV4CandidateV1; readonly poolKey: ReturnType<typeof assertPoolKey> } {
  const raw = decodeEvmLogObservationBytes(rawBytes, "angstrom-v4.identity.initializeEvidence");
  if (
    raw.blockNumber !== evidence.blockNumber
    || raw.blockHash !== evidence.blockHash
    || raw.transactionHash !== evidence.txHash
    || raw.logIndex !== evidence.logIndex
    || raw.address !== evidence.address
    || raw.topics[0] !== evidence.topic
  ) throw new TypeError("angstrom-v4 identity recent evidence mismatch");
  const initialize = decodeAngstromV4InitializeLog(raw, ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC);
  const decoded = decodeAngstromV4Candidate({
    kind: "log",
    cutoff: cutoffValue,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    target: raw.address,
    topic: evidence.topic,
    rawLocatorHash: evidence.rawLocatorHash,
  }, "angstrom-v4-contract-log");
  if (decoded === null) throw new TypeError("angstrom-v4 recent evidence pattern mismatch");
  const nomination = nominateAngstromV4({ ...decoded, poolId: initialize.poolId });
  if (nomination.status !== "nominated" || nomination.candidate.instanceNominationKey !== binding.instanceNominationKey) {
    throw new TypeError("angstrom-v4 recent evidence candidate mismatch");
  }
  return Object.freeze({ candidate: nomination.candidate, poolKey: initialize.poolKey });
}

function sourcePlanLogCandidate(
  binding: CandidateBindingV1,
  cutoffValue: AngstromV4CutoffV1,
  evidence: SourcePlanEvidenceRefV1,
  rawBytes: Uint8Array,
): { readonly candidate: AngstromV4CandidateV1; readonly poolKey: ReturnType<typeof assertPoolKey> } {
  const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes);
  if (
    observed.familyDefinitionHash !== ANGSTROM_V4_FAMILY_DEFINITION_HASH
    || observed.plan.ownerRef !== evidence.ownerRef
    || observed.plan.sourcePlanRef !== evidence.sourcePlanRef
    || observed.plan.familyDefinitionHash !== ANGSTROM_V4_FAMILY_DEFINITION_HASH
    || observed.plan.completeness !== "rolling-observation"
    || observed.plan.historyStartBlock !== null
    || !sameCutoff(observed.cutoff, cutoffValue)
    || observed.requestSchemaHash !== ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    || observed.request.kind !== "family-source-plan-rpc"
    || observed.request.version !== 1
    || observed.request.method !== "eth_getLogs"
    || observed.request.target !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER)
    || observed.request.manager !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER)
    || observed.request.topic !== ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC
  ) throw new TypeError("angstrom-v4 history evidence binding mismatch");
  const lookback = observed.request.lookback;
  const chunk = observed.request.chunk;
  if (lookback === null || typeof lookback !== "object" || Array.isArray(lookback) || chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) throw new TypeError("angstrom-v4 history evidence range malformed");
  const range = decodeExactObject(lookback, { from: (item, itemPath) => assertDecimalString(item, itemPath), through: (item, itemPath) => assertDecimalString(item, itemPath) }, "angstrom-v4.history.lookback");
  const chunkBinding = decodeExactObject(chunk, { maxBlocks: (item, itemPath) => assertDecimalString(item, itemPath) }, "angstrom-v4.history.chunk");
  if (chunkBinding.maxBlocks !== "10000" || BigInt(range.from) > BigInt(range.through) || BigInt(range.through) > BigInt(cutoffValue.number)) throw new TypeError("angstrom-v4 history evidence range mismatch");
  const expectedFilter = Object.freeze({ address: canonicalAddress(ANGSTROM_V4_POOL_MANAGER), fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC]) });
  if (encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([expectedFilter])) throw new TypeError("angstrom-v4 history evidence filter mismatch");
  if (!Array.isArray(observed.response)) throw new TypeError("angstrom-v4 history evidence response must be logs");
  const matches: { readonly candidate: AngstromV4CandidateV1; readonly poolKey: ReturnType<typeof assertPoolKey> }[] = [];
  for (const [index, value] of observed.response.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`angstrom-v4 history log[${index}] malformed`);
    const log = value as Record<string, CanonicalJson>;
    if (
      Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex"
      || log.address !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER)
      || log.removed !== false
      || typeof log.blockHash !== "string"
      || typeof log.transactionHash !== "string"
      || typeof log.data !== "string"
      || !Array.isArray(log.topics)
      || log.topics.some(topic => typeof topic !== "string")
    ) throw new TypeError(`angstrom-v4 history log[${index}] malformed`);
    const topics = log.topics as readonly Hash[];
    if (topics[0] !== ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC) continue;
    const initialize = decodeAngstromV4InitializeLog({ address: log.address, topics, data: log.data }, ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC);
    if (initialize.poolId !== binding.instanceNominationKey) continue;
    const blockNumber = rpcQuantity(log.blockNumber, `angstrom-v4 history log[${index}].blockNumber`);
    if (BigInt(blockNumber) < BigInt(range.from) || BigInt(blockNumber) > BigInt(range.through)) throw new TypeError("angstrom-v4 history log outside observed range");
    const evmLog = Object.freeze({
      kind: "evm-log" as const,
      version: 1 as const,
      blockNumber,
      blockHash: assertHash(log.blockHash, `angstrom-v4 history log[${index}].blockHash`),
      transactionHash: assertHash(log.transactionHash, `angstrom-v4 history log[${index}].transactionHash`),
      logIndex: rpcQuantity(log.logIndex, `angstrom-v4 history log[${index}].logIndex`),
      address: canonicalAddress(log.address),
      topics: Object.freeze([...topics]),
      data: log.data,
    });
    rpcQuantity(log.transactionIndex, `angstrom-v4 history log[${index}].transactionIndex`);
    const logRawLocatorHash = sha256Hex(encodeEvmLogObservation(evmLog));
    const decoded = decodeAngstromV4Candidate({ kind: "log", cutoff: cutoffValue, blockNumber: evmLog.blockNumber, blockHash: evmLog.blockHash, txHash: evmLog.transactionHash, logIndex: evmLog.logIndex, target: evmLog.address, topic: ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC, rawLocatorHash: logRawLocatorHash }, "angstrom-v4-contract-log");
    if (decoded === null) throw new TypeError("angstrom-v4 history evidence pattern mismatch");
    const nomination = nominateAngstromV4({ ...decoded, poolId: initialize.poolId });
    if (nomination.status !== "nominated") throw new TypeError("angstrom-v4 history candidate rejected");
    matches.push(Object.freeze({ candidate: nomination.candidate, poolKey: initialize.poolKey }));
  }
  if (matches.length !== 1) throw new TypeError("angstrom-v4 history evidence must contain exactly one candidate log");
  return matches[0]!;
}

function candidateFromIdentityEvidence(binding: CandidateBindingV1, cutoffValue: AngstromV4CutoffV1, rawBytes: Uint8Array): { readonly candidate: AngstromV4CandidateV1; readonly poolKey: ReturnType<typeof assertPoolKey> } {
  const evidence = primaryEvidence(binding);
  if (sha256Hex(rawBytes) !== evidence.rawLocatorHash) throw new TypeError("angstrom-v4 identity raw locator mismatch");
  return evidence.kind === "recent-log"
    ? candidateFromRecentEvidence(binding, cutoffValue, evidence, rawBytes)
    : sourcePlanLogCandidate(binding, cutoffValue, evidence, rawBytes);
}

function assetBinding(chainId: string, asset: string) {
  return asset === "0x0000000000000000000000000000000000000000"
    ? nativeAssetPortBindingV1(chainId)
    : erc20AssetPortBindingV1(chainId, asset);
}

function portRef(instanceKey: string, direction: "input" | "output", asset: string): Hash {
  return hashDomain("aloha/angstrom-v4/asset-port/v1", { instanceKey, direction, asset });
}

function transition(
  chainId: string,
  instanceKey: string,
  inputAsset: string,
  outputAsset: string,
  routeBindingHash: Hash,
  state: AngstromV4MaterializedStateV1,
): StaticTransitionProjectionDraftV1 {
  const inputAssetPort: AssetPortV1 = Object.freeze({
    ...assetBinding(chainId, inputAsset),
    portRef: portRef(instanceKey, "input", inputAsset),
    ordinal: "0",
  });
  const outputAssetPort: AssetPortV1 = Object.freeze({
    ...assetBinding(chainId, outputAsset),
    portRef: portRef(instanceKey, "output", outputAsset),
    ordinal: "0",
  });
  const opaqueTransitionRef = hashDomain("aloha/angstrom-v4/transition/v1", {
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
  state: AngstromV4MaterializedStateV1,
): InstancePublicationV1 {
  const routeList = deriveAngstromV4Routes(payload.identityMemo.identity);
  const route = routeList[0];
  if (route === undefined) throw new TypeError("angstrom-v4 route derivation returned no route");
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
    familyId: ANGSTROM_V4_FAMILY_ID,
    familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: route.instanceKey,
    cutoff: payload.cutoff,
    identityMemo,
    identityMemoHash: identityMemoHash(payload.identityMemo),
    descriptorHash: identityDescriptorHash(payload.identityMemo.identity),
    staticProjectionMemoHash: hashDomain("aloha/angstrom-v4/static-projection-memo/v1", transitions),
    requestedArtifactDependencyRoot: REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    validityDependencyRoot: hashDomain("aloha/angstrom-v4/validity-dependencies/v1", {
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

function decodePublication(value: unknown, path = "angstrom-v4.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => { if (item !== ANGSTROM_V4_FAMILY_ID) throw new TypeError(`${itemPath} family mismatch`); return ANGSTROM_V4_FAMILY_ID; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => instanceKey(item, itemPath),
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
  if (decoded.familyDefinitionHash !== ANGSTROM_V4_FAMILY_DEFINITION_HASH) throw new TypeError("angstrom-v4 publication definition mismatch");
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
  ) throw new TypeError("angstrom-v4 publication lineage mismatch");
  const routeList = deriveAngstromV4Routes(memo.identity);
  const route = routeList[0];
  const sealedTransition = decoded.transitions[0];
  if (route === undefined || sealedTransition === undefined) throw new TypeError("angstrom-v4 publication route missing");
  const expectedDraft = transitionDraft(sealedTransition);
  if (decoded.staticProjectionMemoHash !== hashDomain("aloha/angstrom-v4/static-projection-memo/v1", [expectedDraft])) throw new TypeError("angstrom-v4 publication projection memo mismatch");
  const inputPort = sealedTransition.inputAssetPorts[0];
  const outputPort = sealedTransition.outputAssetPorts[0];
  if (sealedTransition.inputAssetPorts.length !== 1 || sealedTransition.outputAssetPorts.length !== 1 || sealedTransition.constraintRefs.length !== 1) throw new TypeError("angstrom-v4 publication transition shape mismatch");
  const stateHash = sealedTransition.constraintRefs[0];
  if (stateHash === undefined) throw new TypeError("angstrom-v4 publication state constraint missing");
  if (sealedTransition.opaqueTransitionRef !== hashDomain("aloha/angstrom-v4/transition/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
    routeBindingHash: route.routeBindingHash,
    stateHash,
  })) throw new TypeError("angstrom-v4 publication transition binding mismatch");
  if (decoded.validityDependencyRoot !== hashDomain("aloha/angstrom-v4/validity-dependencies/v1", {
    identityFactsHash: memo.identity.factsHash,
    stateHash,
  })) throw new TypeError("angstrom-v4 publication validity binding mismatch");
  if (
    inputPort === undefined
    || outputPort === undefined
    || inputPort.ordinal !== "0"
    || outputPort.ordinal !== "0"
    || inputPort.assetRef !== assetBinding(decoded.cutoff.chainId, route.inputAsset).assetRef
    || inputPort.portRef !== portRef(route.instanceKey, "input", route.inputAsset)
    || outputPort.assetRef !== assetBinding(decoded.cutoff.chainId, route.outputAsset).assetRef
    || outputPort.portRef !== portRef(route.instanceKey, "output", route.outputAsset)
  ) throw new TypeError("angstrom-v4 publication asset binding mismatch");
  validateInstancePublication(decoded);
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be an object`);
  return decoded;
}

function identityOutput(value: unknown): CanonicalJson {
  return outputObject(decodeIdentityObservation(value), "angstrom-v4.identityOutput");
}

function materializationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, "angstrom-v4.materializationOutput"), "angstrom-v4.materializationOutput");
}

function projectionOutput(value: unknown): CanonicalJson {
  return outputObject(decodePublication(value), "angstrom-v4.projectionOutput");
}

function nominationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeNominationOutput(value), "angstrom-v4.nominationOutput");
}

function rehydrationOutput(value: unknown): CanonicalJson {
  return outputObject(decodeRehydrationOutput(value), "angstrom-v4.rehydrationOutput");
}

function requireStage(input: FamilyStageGenericInvocationV1, expected: FamilyRuntimeStageV1): void {
  if (input.stage !== expected) throw new TypeError(`angstrom-v4-${expected}-stage-mismatch`);
}

function requireNoPriorOutputs(input: FamilyStageGenericInvocationV1): void {
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("angstrom-v4-unexpected-prior-stage-output");
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  requireStage(input, "nomination");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "angstrom-v4.nominationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "angstrom-v4.nominationInvocation.candidate");
  return Object.freeze({
    kind: "angstrom-v4-nomination-input",
    binding,
    cutoff: cutoffValue,
    readPlan: NOMINATION_READ_PLAN,
    requestId: nominationRequestId(binding, cutoffValue),
  });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  requireStage(input, "identity");
  requireNoPriorOutputs(input);
  const cutoffValue = cutoff(input.cutoff, "angstrom-v4.identityInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "angstrom-v4.identityInvocation.candidate");
  return Object.freeze({
    kind: "angstrom-v4-identity-input",
    binding,
    cutoff: cutoffValue,
    readPlan: IDENTITY_READ_PLAN,
    requestIds: Object.freeze([identityRequestId(binding, cutoffValue)]),
  });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  requireStage(input, "materialization");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("angstrom-v4-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "angstrom-v4.materializationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "angstrom-v4.materializationInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "angstrom-v4.materializationInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  return Object.freeze({
    kind: "angstrom-v4-materialization-input",
    binding,
    identityMemo: memo,
    cutoff: cutoffValue,
    readPlan: STATE_READ_PLAN,
    requestId: stateRequestId(memo.identity.instanceKey, cutoffValue),
  });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  requireStage(input, "projection");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("angstrom-v4-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "angstrom-v4.projectionInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "angstrom-v4.projectionInvocation.candidate");
  const memo = identityMemo(input.identityMemo, "angstrom-v4.projectionInvocation.identityMemo");
  assertIdentityBinding(binding, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput, "angstrom-v4.projectionInvocation.materializationOutput");
  if (
    materialization.binding.familyCandidateKey !== binding.familyCandidateKey
    || materialization.identityMemoHash !== identityMemoHash(memo)
    || materialization.identityFactsHash !== memo.identity.factsHash
    || !sameCutoff(materialization.cutoff, cutoffValue)
  ) throw new TypeError("angstrom-v4-projection-materialization-lineage-mismatch");
  return Object.freeze({
    kind: "angstrom-v4-projection-input",
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
  const cutoffValue = cutoff(input.cutoff, "angstrom-v4.rehydrationInvocation.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "angstrom-v4.rehydrationInvocation.candidate");
  return Object.freeze({
    kind: "angstrom-v4-rehydration-input",
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
    const fact = returned(facts[0]!, "angstrom-v4.nomination");
    if (fact.dataHex !== ackData(payload.binding.candidateSubjectHash)) throw new TypeError("angstrom-v4-nomination-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "angstrom-v4-nomination-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "angstrom-v4-nomination-invalid") });
  }
}

function interpretIdentity(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.identity);
    assertProgramForStage(input, "identity", schemaHash, STAGE_IDS.identity);
    const payload = decodeIdentityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const rawBytes = hexBytes(returned(facts[0]!, "angstrom-v4.identity.initializeEvidence").dataHex, "angstrom-v4.identity.initializeEvidence");
    const resolved = candidateFromIdentityEvidence(payload.binding, payload.cutoff, rawBytes);
    const candidate = resolved.candidate;
    const result = verifyAngstromV4IdentityStage({
      candidate,
      reads: {
        cutoff: payload.cutoff,
        target: candidate.target,
        reverseTarget: ANGSTROM_V4_POOL_MANAGER,
        inputAsset: resolved.poolKey.currency0,
        outputAsset: resolved.poolKey.currency1,
        poolId: candidate.poolId,
        poolKey: resolved.poolKey,
        managerBinding: Object.freeze({ manager: ANGSTROM_V4_POOL_MANAGER, stateView: ANGSTROM_V4_STATE_VIEW, quoter: ANGSTROM_V4_QUOTER }),
      },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const identity = Object.freeze({ ...result.identity, candidateSnapshotHash: payload.binding.candidateSubjectHash });
    const memo: IdentityMemoV1 = Object.freeze({
      kind: "angstrom-v4-identity-memo",
      familyId: ANGSTROM_V4_FAMILY_ID,
      familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
      familyCandidateKey: payload.binding.familyCandidateKey,
      instanceNominationKey: payload.binding.instanceNominationKey,
      candidateSnapshotHash: payload.binding.candidateSubjectHash,
      candidateEvidenceRoot: payload.binding.candidateEvidenceRoot,
      identity,
    });
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "identityVerified",
      familyInstanceKey: identity.instanceKey,
      identityMemo: memo,
      identityMemoHash: identityMemoHash(memo),
      descriptorHash: identityDescriptorHash(identity),
      evidenceRoot: payload.binding.candidateEvidenceRoot,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "angstrom-v4-identity-invalid") });
  }
}

function interpretMaterialization(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.materialization);
    assertProgramForStage(input, "materialization", schemaHash, STAGE_IDS.materialization);
    const payload = decodeMaterializationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "angstrom-v4.materialization.state");
    const reserves = decodeReserveWords(fact.dataHex, "angstrom-v4.materialization.state");
    const result = materializeAngstromV4({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "angstrom-v4-materialization-output",
      binding: payload.binding,
      identityMemoHash: identityMemoHash(payload.identityMemo),
      identityFactsHash: payload.identityMemo.identity.factsHash,
      cutoff: payload.cutoff,
      state: result.state,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "angstrom-v4-materialization-invalid") });
  }
}

function interpretProjection(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.projection);
    assertProgramForStage(input, "projection", schemaHash, STAGE_IDS.projection);
    const payload = decodeProjectionPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "angstrom-v4.projection.state");
    const reserves = decodeReserveWords(fact.dataHex, "angstrom-v4.projection.state");
    const result = materializeAngstromV4({
      identity: payload.identityMemo.identity,
      read: { cutoff: payload.cutoff, instanceKey: payload.identityMemo.identity.instanceKey, reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("angstrom-v4-projection-state-lineage-mismatch");
    if (result.state.identityFactsHash !== payload.identityMemo.identity.factsHash) throw new TypeError("angstrom-v4-projection-identity-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "angstrom-v4-projection-invalid") });
  }
}

function interpretRehydration(input: StageInterpretInputV1): ProgramInterpretationDraftV1 {
  try {
    const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES.rehydration);
    assertProgramForStage(input, "rehydration", schemaHash, STAGE_IDS.rehydration);
    const payload = decodeRehydrationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = returned(facts[0]!, "angstrom-v4.rehydration.reference");
    if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("angstrom-v4-rehydration-ack-mismatch");
    return Object.freeze({ kind: "verified", output: Object.freeze({
      kind: "angstrom-v4-rehydration-verified",
      binding: payload.binding,
      cutoff: payload.cutoff,
      instanceKey: payload.binding.instanceNominationKey,
      referenceHash: payload.referenceHash,
      requestId: payload.requestId,
    }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "angstrom-v4-rehydration-invalid") });
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
    implementationClosureHash: hashDomain("aloha/angstrom-v4/runtime-implementation/v1", {
      stage,
      module: "families/angstrom-v4/src/runtime/definitions.ts",
    }),
    outputCodecHash: hashDomain("aloha/angstrom-v4/runtime-output-codec/v1", stage),
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

export const ANGSTROM_V4_NOMINATION_RUNTIME = definitionBase(
  "nomination",
  nominationPayloadCodec,
  hashDomain("aloha/angstrom-v4/runtime-output-schema/v1", "nomination"),
  Object.freeze({ decodeExact: nominationOutput }),
  prepareNomination,
  interpretNomination,
);

export const ANGSTROM_V4_IDENTITY_RUNTIME = definitionBase(
  "identity",
  identityPayloadCodec,
  hashDomain("aloha/angstrom-v4/runtime-output-schema/v1", "identity"),
  Object.freeze({ decodeExact: identityOutput }),
  prepareIdentity,
  interpretIdentity,
);

export const ANGSTROM_V4_MATERIALIZATION_RUNTIME = definitionBase(
  "materialization",
  materializationPayloadCodec,
  hashDomain("aloha/angstrom-v4/runtime-output-schema/v1", "materialization"),
  Object.freeze({ decodeExact: materializationOutput }),
  prepareMaterialization,
  interpretMaterialization,
);

export const ANGSTROM_V4_PROJECTION_RUNTIME = definitionBase(
  "projection",
  projectionPayloadCodec,
  hashDomain("aloha/angstrom-v4/runtime-output-schema/v1", "projection"),
  Object.freeze({ decodeExact: projectionOutput }),
  prepareProjection,
  interpretProjection,
);

export const ANGSTROM_V4_REHYDRATION_RUNTIME = definitionBase(
  "rehydration",
  rehydrationPayloadCodec,
  hashDomain("aloha/angstrom-v4/runtime-output-schema/v1", "rehydration"),
  Object.freeze({ decodeExact: rehydrationOutput }),
  prepareRehydration,
  interpretRehydration,
);

export const ANGSTROM_V4_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  ANGSTROM_V4_NOMINATION_RUNTIME,
  ANGSTROM_V4_IDENTITY_RUNTIME,
  ANGSTROM_V4_MATERIALIZATION_RUNTIME,
  ANGSTROM_V4_PROJECTION_RUNTIME,
  ANGSTROM_V4_REHYDRATION_RUNTIME,
]);

export function requireAngstromV4StageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = ANGSTROM_V4_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`angstrom-v4 stage definition missing: ${stage}`);
  return definition;
}
