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
  familyCandidateKey as discoveryFamilyCandidateKey,
  type CandidateEvidenceRefV1,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../../../packages/discovery/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import {
  ERC4626_FAMILY_ID,
  ERC4626_FAMILY_VERSION,
  ERC4626_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ERC4626_WITHDRAW_TOPIC,
} from "../manifest.ts";
import { ERC4626_FAMILY_AUTHORING_HASH } from "../family-definition.ts";
import { verifyErc4626IdentityStage, identityDescriptorHash } from "../identity.ts";
import { materializeErc4626 } from "../instance.ts";
import { deriveErc4626Routes } from "../routes.ts";
import { decodeErc4626WithdrawHistoryEntries } from "../history-source-plan.ts";
import type {
  Erc4626CandidateV1,
  Erc4626CutoffV1,
  Erc4626IdentityV1,
  Erc4626MaterializedStateV1,
  Erc4626ObservationV1,
} from "../types.ts";

type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
type CandidateBindingV1 = CandidateRecordV1;
type IdentityMemoV1 = {
  readonly kind: "erc4626-identity-memo";
  readonly familyId: typeof ERC4626_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: Erc4626IdentityV1;
};
type NominationPayloadV1 = {
  readonly kind: "erc4626-nomination-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type IdentityPayloadV1 = {
  readonly kind: "erc4626-identity-input";
  readonly binding: CandidateBindingV1;
  readonly evidence: CandidateEvidenceRefV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
};
type MaterializationPayloadV1 = {
  readonly kind: "erc4626-materialization-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type MaterializationOutputV1 = {
  readonly kind: "erc4626-materialization-output";
  readonly binding: CandidateBindingV1;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: Erc4626CutoffV1;
  readonly state: Erc4626MaterializedStateV1;
};
type ProjectionPayloadV1 = {
  readonly kind: "erc4626-projection-input";
  readonly binding: CandidateBindingV1;
  readonly identityMemo: IdentityMemoV1;
  readonly materialization: MaterializationOutputV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};
type RehydrationPayloadV1 = {
  readonly kind: "erc4626-rehydration-input";
  readonly binding: CandidateBindingV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly referenceHash: Hash;
};
type NominationOutputV1 = {
  readonly kind: "erc4626-nomination-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: Erc4626CutoffV1;
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
  readonly kind: "erc4626-rehydration-verified";
  readonly binding: CandidateBindingV1;
  readonly cutoff: Erc4626CutoffV1;
  readonly instanceKey: string;
  readonly referenceHash: Hash;
  readonly requestId: Hash;
};

const VERSION = asCapabilityVersion(ERC4626_FAMILY_VERSION);
const STAGE_IDS = Object.freeze({
  nomination: `family.${ERC4626_FAMILY_ID}.nomination`,
  identity: `family.${ERC4626_FAMILY_ID}.identity`,
  materialization: `family.${ERC4626_FAMILY_ID}.materialization`,
  projection: `family.${ERC4626_FAMILY_ID}.projection`,
  rehydration: `family.${ERC4626_FAMILY_ID}.rehydration`,
});
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/erc4626/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/erc4626/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/erc4626/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/erc4626/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/erc4626/stage-schema/v1", "rehydration"),
});
const READ_PLANS = Object.freeze({
  nomination: Object.freeze(["evidence"]),
  identity: Object.freeze(["candidateEvidence", "target", "reverseTarget", "asset"]),
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

function hexBytes(value: string, path: string): Uint8Array {
  const encoded = bytes(value, path).slice(2);
  return Uint8Array.from(
    { length: encoded.length / 2 },
    (_, index) => Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16),
  );
}

function blockTag(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

function selector(value: unknown, path: string): `0x${string}` {
  const result = bytes(value, path);
  if (!/^0x[0-9a-f]{8}$/.test(result)) throw new TypeError(`${path} must be a four-byte selector`);
  return result as `0x${string}`;
}

function cutoff(value: unknown, path: string): Erc4626CutoffV1 {
  return decodeExactObject<Erc4626CutoffV1>(value, {
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

function sameCutoff(left: Erc4626CutoffV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function candidateRecord(value: unknown, path = "erc4626.candidate"): CandidateRecordV1 {
  const decoded = decodeExactObject<CandidateRecordV1>(value, {
    kind: (item, itemPath) => item === "aloha.candidate-record" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === "2" ? item : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === ERC4626_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => decodeCandidateEvidenceRef(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== ERC4626_FAMILY_AUTHORING_HASH) throw new TypeError("erc4626-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("erc4626-candidate-key-mismatch");
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("erc4626-candidate-subject-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("erc4626-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(valueItem => hashDomain("aloha/candidate-evidence-ref/v1", valueItem));
  const sorted = [...evidenceKeys].sort();
  if (new Set(evidenceKeys).size !== evidenceKeys.length || evidenceKeys.some((item, index) => item !== sorted[index])) throw new TypeError("erc4626-candidate-evidence-order");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("erc4626-candidate-evidence-root-mismatch");
  return deepFreeze(decoded);
}

function candidateBindingFromRecord(value: unknown, cutoffValue: Erc4626CutoffV1, path: string): CandidateBindingV1 {
  const record = candidateRecord(value, path);
  for (const evidence of record.evidence) {
    if (evidence.kind !== "recent-log") continue;
    if (address(evidence.address, `${path}.evidence.address`) !== record.instanceNominationKey || evidence.topic !== ERC4626_WITHDRAW_TOPIC) throw new TypeError("erc4626-recent-evidence-binding-mismatch");
    const block = BigInt(evidence.blockNumber);
    const end = BigInt(cutoffValue.number);
    if (block > end || block < end - 49n) throw new TypeError("erc4626-recent-evidence-window-mismatch");
  }
  return record;
}

function primaryEvidence(binding: CandidateBindingV1): CandidateEvidenceRefV1 {
  const evidence = binding.evidence.find(item => item.kind === "source-plan") ?? binding.evidence[0];
  if (evidence === undefined) throw new TypeError("erc4626-candidate-evidence-empty");
  return evidence;
}

function indexedAddress(value: Hash, path: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} must be a canonical indexed address`);
  return address(`0x${value.slice(-40)}`, path);
}

function assertWithdrawLog(value: ReturnType<typeof decodeEvmLogObservationBytes>, path: string): void {
  if (value.topics.length !== 4 || value.topics[0] !== ERC4626_WITHDRAW_TOPIC || !/^0x(?:[0-9a-f]{64}){2}$/.test(value.data)) {
    throw new TypeError(`${path} is not a canonical ERC4626 Withdraw log`);
  }
  indexedAddress(value.topics[1]!, `${path}.sender`);
  indexedAddress(value.topics[2]!, `${path}.receiver`);
  indexedAddress(value.topics[3]!, `${path}.owner`);
}

function physicalEvidenceRef(
  observation: ReturnType<typeof decodeFamilySourcePlanPhysicalObservation>,
  rawLocatorHash: Hash,
): Hash {
  return hashDomain("aloha/source-plan-physical-evidence/v1", {
    runtimeAuthority: observation.runtimeAuthority,
    sourceAuthorityRoot: observation.sourceAuthorityRoot,
    sourceAnchorRoot: observation.sourceAnchorRoot,
    requestId: observation.requestId,
    rawLocatorHash,
  });
}

function candidateFromEvidence(
  payload: IdentityPayloadV1,
  rawBytes: Uint8Array,
): Erc4626CandidateV1 {
  if (sha256Hex(rawBytes) !== payload.evidence.rawLocatorHash) throw new TypeError("erc4626-identity-evidence-hash-mismatch");
  if (payload.evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(rawBytes, "erc4626.identity.recentEvidence");
    if (
      raw.address !== payload.binding.instanceNominationKey
      || raw.address !== address(payload.evidence.address, "erc4626.identity.recentEvidence.address")
      || raw.topics[0] !== payload.evidence.topic
      || raw.blockNumber !== payload.evidence.blockNumber
      || raw.blockHash !== payload.evidence.blockHash
      || raw.transactionHash !== payload.evidence.txHash
      || raw.logIndex !== payload.evidence.logIndex
    ) throw new TypeError("erc4626-recent-identity-evidence-mismatch");
    assertWithdrawLog(raw, "erc4626.identity.recentEvidence");
    const evidence: Erc4626ObservationV1 = Object.freeze({
      kind: "log",
      cutoff: payload.cutoff,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      txHash: raw.transactionHash,
      logIndex: raw.logIndex,
      target: raw.address,
      topic: ERC4626_WITHDRAW_TOPIC,
      rawLocatorHash: payload.evidence.rawLocatorHash,
    });
    return Object.freeze({
      target: payload.binding.instanceNominationKey,
      instanceNominationKey: payload.binding.instanceNominationKey,
      candidateSnapshotHash: payload.binding.candidateSubjectHash,
      evidence,
    });
  }

  const observation = decodeFamilySourcePlanPhysicalObservation(rawBytes, "erc4626.identity.historyEvidence");
  const lookback = decodeExactObject<{ readonly from: string; readonly through: string }>(observation.request.lookback, {
    from: (item, itemPath) => assertDecimalString(item, itemPath),
    through: (item, itemPath) => assertDecimalString(item, itemPath),
  }, "erc4626.identity.historyEvidence.lookback");
  const from = BigInt(lookback.from);
  const through = BigInt(lookback.through);
  const cutoffNumber = BigInt(payload.cutoff.number);
  const observationCutoffNumber = BigInt(observation.cutoff.number);
  const expectedThrough = from + 9_999n > observationCutoffNumber ? observationCutoffNumber : from + 9_999n;
  const filter = { fromBlock: blockTag(lookback.from), toBlock: blockTag(lookback.through), topics: [ERC4626_WITHDRAW_TOPIC] };
  if (
    observation.familyDefinitionHash !== ERC4626_FAMILY_AUTHORING_HASH
    || observation.plan.familyDefinitionHash !== ERC4626_FAMILY_AUTHORING_HASH
    || observation.plan.ownerRef !== payload.evidence.ownerRef
    || observation.plan.sourcePlanRef !== payload.evidence.sourcePlanRef
    || observation.plan.completeness !== "rolling-observation"
    || observation.plan.historyStartBlock !== null
    || observation.cutoff.chainId !== payload.cutoff.chainId
    || observationCutoffNumber > cutoffNumber
    || observation.requestSchemaHash !== ERC4626_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    || observation.request.kind !== "family-source-plan-rpc"
    || observation.request.version !== 1
    || observation.request.method !== "eth_getLogs"
    || observation.request.target !== null
    || observation.request.manager !== null
    || observation.request.topic !== ERC4626_WITHDRAW_TOPIC
    || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: "10000" })
    || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter])
    || from > through
    || through !== expectedThrough
    || through > observationCutoffNumber
    || physicalEvidenceRef(observation, payload.evidence.rawLocatorHash) !== payload.evidence.evidenceRef
  ) throw new TypeError("erc4626-history-identity-evidence-binding-mismatch");
  const entry = decodeErc4626WithdrawHistoryEntries(observation.response, from, through)
    .find(item => item.target === payload.binding.instanceNominationKey);
  if (entry === undefined) throw new TypeError("erc4626-history-identity-target-missing");
  const evidence: Erc4626ObservationV1 = Object.freeze({
    kind: "log",
    cutoff: payload.cutoff,
    blockNumber: entry.blockNumber,
    blockHash: entry.blockHash,
    txHash: entry.txHash,
    logIndex: entry.logIndex,
    target: entry.target,
    topic: ERC4626_WITHDRAW_TOPIC,
    rawLocatorHash: payload.evidence.rawLocatorHash,
  });
  return Object.freeze({
    target: payload.binding.instanceNominationKey,
    instanceNominationKey: payload.binding.instanceNominationKey,
    candidateSnapshotHash: payload.binding.candidateSubjectHash,
    evidence,
  });
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the erc4626 read contract`);
  return Object.freeze([...result]);
}

function hashes(value: unknown, path: string, expected?: readonly Hash[]): readonly Hash[] {
  const result = fieldArray(value, (item, itemPath) => assertHash(item, itemPath), path);
  if (expected !== undefined && (result.length !== expected.length || result.some((item, index) => item !== expected[index]))) throw new TypeError(`${path} request ids do not match the erc4626 source plan`);
  return Object.freeze([...result]);
}

function requestId(phase: string, binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1, operation: string, evidence: CandidateEvidenceRefV1 | null = null): Hash {
  return hashDomain("aloha/erc4626/request-id/v2", { phase, target: binding.instanceNominationKey, candidateSubjectHash: binding.candidateSubjectHash, candidateEvidenceRoot: binding.candidateEvidenceRoot, operation, evidence, cutoff: cutoffValue });
}

function identityRequestId(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1, operation: string, evidence: CandidateEvidenceRefV1): Hash {
  return requestId("identity", binding, cutoffValue, operation, operation === "candidateEvidence" ? evidence : null);
}

function stateRequestId(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1): Hash {
  return requestId("materialization", binding, cutoffValue, "state");
}

function nominationRequestId(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1): Hash {
  return requestId("nomination", binding, cutoffValue, "candidate");
}

function referenceHash(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1): Hash {
  return hashDomain("aloha/erc4626/rehydration-reference/v2", { familyDefinitionHash: binding.familyDefinitionHash, familyCandidateKey: binding.familyCandidateKey, candidateSubjectHash: binding.candidateSubjectHash, candidateEvidenceRoot: binding.candidateEvidenceRoot, instanceKey: binding.instanceNominationKey, cutoff: cutoffValue });
}

function rehydrationRequestId(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1): Hash {
  return requestId("rehydration", binding, cutoffValue, referenceHash(binding, cutoffValue));
}

function decodeIdentity(value: unknown, path: string): Erc4626IdentityV1 {
  const decoded = decodeExactObject<Erc4626IdentityV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject<Erc4626IdentityV1["facts"]>(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      asset: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.facts.target) throw new TypeError("erc4626-identity-instance-mismatch");
  if (decoded.factsHash !== hashDomain("aloha/erc4626/identity-facts/v1", decoded.facts)) throw new TypeError("erc4626-identity-facts-hash-mismatch");
  return decoded;
}

function identityMemo(value: unknown, path = "erc4626.identityMemo"): IdentityMemoV1 {
  const decoded = decodeExactObject<IdentityMemoV1>(value, {
    kind: (item, itemPath) => item === "erc4626-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyId: (item, itemPath) => item === ERC4626_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => address(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== ERC4626_FAMILY_AUTHORING_HASH) throw new TypeError("erc4626-identity-definition-mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("erc4626-identity-candidate-key-mismatch");
  if (decoded.instanceNominationKey !== decoded.identity.instanceKey || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("erc4626-identity-lineage-mismatch");
  return deepFreeze(decoded);
}

function identityMemoHash(value: IdentityMemoV1): Hash { return hashDomain("aloha/identity-memo/v1", value); }

function assertCandidateBinding(binding: CandidateBindingV1, cutoffValue: Erc4626CutoffV1): void {
  candidateBindingFromRecord(binding, cutoffValue, "erc4626.binding");
}

function assertIdentityBinding(binding: CandidateBindingV1, memo: IdentityMemoV1, cutoffValue: Erc4626CutoffV1): void {
  assertCandidateBinding(binding, cutoffValue);
  if (memo.familyId !== binding.familyId || memo.familyDefinitionHash !== binding.familyDefinitionHash || memo.familyCandidateKey !== binding.familyCandidateKey || memo.instanceNominationKey !== binding.instanceNominationKey || memo.candidateSnapshotHash !== binding.candidateSubjectHash || memo.candidateEvidenceRoot !== binding.candidateEvidenceRoot || !sameCutoff(memo.identity.cutoff, cutoffValue) || memo.identity.instanceKey !== binding.instanceNominationKey) throw new TypeError("erc4626-identity-lineage-mismatch");
}

function decodeState(value: unknown, path: string): Erc4626MaterializedStateV1 {
  const decoded = decodeExactObject<Erc4626MaterializedStateV1>(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stateHash !== hashDomain("aloha/erc4626/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, factsHash: decoded.factsHash })) throw new TypeError("erc4626-materialized-state-hash-mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "erc4626.materializationOutput"): MaterializationOutputV1 {
  const decoded = decodeExactObject<MaterializationOutputV1>(value, {
    kind: (item, itemPath) => item === "erc4626-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    state: (item, itemPath) => decodeState(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (!sameCutoff(decoded.state.cutoff, decoded.cutoff) || decoded.state.instanceKey !== decoded.binding.instanceNominationKey || decoded.state.identityFactsHash !== decoded.identityFactsHash) throw new TypeError("erc4626-materialization-lineage-mismatch");
  return decoded;
}

function decodeBinding(value: unknown, path: string): CandidateBindingV1 {
  return candidateRecord(value, path);
}

function decodeNominationPayload(value: unknown, path = "erc4626.nominationPayload"): NominationPayloadV1 {
  const decoded = decodeExactObject<NominationPayloadV1>(value, {
    kind: (item, itemPath) => item === "erc4626-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.nomination),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-nomination-request-mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "erc4626.identityPayload"): IdentityPayloadV1 {
  const decoded = decodeExactObject<IdentityPayloadV1>(value, {
    kind: (item, itemPath) => item === "erc4626-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    evidence: (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.identity),
    requestIds: (item, itemPath) => hashes(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (encodeCanonicalJson(decoded.evidence) !== encodeCanonicalJson(primaryEvidence(decoded.binding))) throw new TypeError("erc4626-identity-primary-evidence-mismatch");
  const expected = READ_PLANS.identity.map(operation => identityRequestId(decoded.binding, decoded.cutoff, operation, decoded.evidence));
  if (decoded.requestIds.length !== expected.length || decoded.requestIds.some((item, index) => item !== expected[index])) throw new TypeError("erc4626-identity-request-mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "erc4626.materializationPayload"): MaterializationPayloadV1 {
  const decoded = decodeExactObject<MaterializationPayloadV1>(value, {
    kind: (item, itemPath) => item === "erc4626-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.requestId !== stateRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-materialization-request-mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "erc4626.projectionPayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject<ProjectionPayloadV1>(value, {
    kind: (item, itemPath) => item === "erc4626-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.state),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertIdentityBinding(decoded.binding, decoded.identityMemo, decoded.cutoff);
  if (decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.binding.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.materialization.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-projection-lineage-mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "erc4626.rehydrationPayload"): RehydrationPayloadV1 {
  const decoded = decodeExactObject<RehydrationPayloadV1>(value, {
    kind: (item, itemPath) => item === "erc4626-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, READ_PLANS.rehydration),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== referenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-rehydration-reference-mismatch");
  return decoded;
}

function decodeNominationOutput(value: unknown, path = "erc4626.nominationOutput"): NominationOutputV1 {
  const decoded = decodeExactObject<NominationOutputV1>(value, {
    kind: (item, itemPath) => item === "erc4626-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-nomination-output-request-mismatch");
  return decoded;
}

function decodeIdentityOutput(value: unknown, path = "erc4626.identityOutput"): IdentityOutputV1 {
  const decoded = decodeExactObject<IdentityOutputV1>(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== identityMemoHash(decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("erc4626-identity-output-lineage-mismatch");
  return decoded;
}

function decodeRehydrationOutput(value: unknown, path = "erc4626.rehydrationOutput"): RehydrationOutputV1 {
  const decoded = decodeExactObject<RehydrationOutputV1>(value, {
    kind: (item, itemPath) => item === "erc4626-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => decodeBinding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  assertCandidateBinding(decoded.binding, decoded.cutoff);
  if (decoded.instanceKey !== decoded.binding.instanceNominationKey || decoded.referenceHash !== referenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("erc4626-rehydration-output-lineage-mismatch");
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

function decodePublication(value: unknown, path = "erc4626.projectionOutput"): InstancePublicationV1 {
  const decoded = decodeExactObject<InstancePublicationV1>(value, {
    familyId: (item, itemPath) => item === ERC4626_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => item === ERC4626_FAMILY_AUTHORING_HASH ? item : (() => { throw new TypeError(`${itemPath} definition mismatch`); })(),
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
  if (decoded.familyCandidateKey !== memo.familyCandidateKey || decoded.identityMemoHash !== identityMemoHash(memo) || decoded.instanceKey !== memo.identity.instanceKey || decoded.descriptorHash !== identityDescriptorHash(memo.identity) || decoded.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("erc4626-publication-identity-mismatch");
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
  const decoded = fieldArray(facts, (item, itemPath) => decodeTransportFact(item, itemPath), "erc4626.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("erc4626 transport request partition mismatch");
  const sourceValue = source(program.source, "erc4626.program.source");
  const byId = new Map(decoded.map(item => [item.requestId, item] as const));
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (fact === undefined) throw new TypeError(`erc4626 missing transport fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, sourceValue)) throw new TypeError("erc4626 transport fact source mismatch");
    return fact;
  }));
}

function returned(fact: TransportFactV1, path: string): Extract<TransportFactV1, { readonly kind: "returned" }> {
  if (fact.kind !== "returned") throw new TypeError(`${path} must be a returned fact`);
  return fact;
}

function assertProgramForStage(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0], stage: CoreStage): void {
  const schemaHash = asSchemaRef(STAGE_SCHEMA_HASHES[stage]);
  if (input.program.payloadSchemaRef !== schemaHash || input.program.capabilityRef.capabilityId !== asCapabilityId(STAGE_IDS[stage]) || input.program.capabilityRef.schemaHash !== schemaHash || encodeCanonicalJson(canonical(input.payload)) !== input.program.canonicalPayloadBytes) throw new TypeError(`erc4626 ${stage} program binding mismatch`);
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayloadV1 {
  if (input.stage !== "nomination") throw new TypeError("erc4626-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("erc4626-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "erc4626.nomination.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "erc4626.nomination.candidate");
  return Object.freeze({ kind: "erc4626-nomination-input", binding, cutoff: cutoffValue, readPlan: READ_PLANS.nomination, requestId: nominationRequestId(binding, cutoffValue) });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  if (input.stage !== "identity") throw new TypeError("erc4626-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("erc4626-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "erc4626.identity.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "erc4626.identity.candidate");
  const evidence = primaryEvidence(binding);
  return Object.freeze({ kind: "erc4626-identity-input", binding, evidence, cutoff: cutoffValue, readPlan: READ_PLANS.identity, requestIds: READ_PLANS.identity.map(operation => identityRequestId(binding, cutoffValue, operation, evidence)) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  if (input.stage !== "materialization") throw new TypeError("erc4626-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("erc4626-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "erc4626.materialization.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "erc4626.materialization.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityBinding(binding, memo, cutoffValue);
  return Object.freeze({ kind: "erc4626-materialization-input", binding, identityMemo: memo, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(binding, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  if (input.stage !== "projection") throw new TypeError("erc4626-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("erc4626-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "erc4626.projection.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "erc4626.projection.candidate");
  const memo = identityMemo(input.identityMemo);
  assertIdentityBinding(binding, memo, cutoffValue);
  const materialization = decodeMaterializationOutput(input.materializationOutput);
  if (encodeCanonicalJson(materialization.binding) !== encodeCanonicalJson(binding) || materialization.identityMemoHash !== identityMemoHash(memo) || materialization.identityFactsHash !== memo.identity.factsHash || !sameCutoff(materialization.cutoff, cutoffValue)) throw new TypeError("erc4626-projection-materialization-lineage-mismatch");
  return Object.freeze({ kind: "erc4626-projection-input", binding, identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: READ_PLANS.state, requestId: stateRequestId(binding, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayloadV1 {
  if (input.stage !== "rehydration") throw new TypeError("erc4626-rehydration-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("erc4626-rehydration-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "erc4626.rehydration.cutoff");
  const binding = candidateBindingFromRecord(input.candidate, cutoffValue, "erc4626.rehydration.candidate");
  const ref = referenceHash(binding, cutoffValue);
  return Object.freeze({ kind: "erc4626-rehydration-input", binding, cutoff: cutoffValue, readPlan: READ_PLANS.rehydration, requestId: rehydrationRequestId(binding, cutoffValue), referenceHash: ref });
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

function identityOutput(identity: Erc4626IdentityV1, binding: CandidateBindingV1): IdentityOutputV1 {
  const memo: IdentityMemoV1 = Object.freeze({ kind: "erc4626-identity-memo", familyId: ERC4626_FAMILY_ID, familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH, familyCandidateKey: binding.familyCandidateKey, instanceNominationKey: binding.instanceNominationKey, candidateSnapshotHash: binding.candidateSubjectHash, candidateEvidenceRoot: binding.candidateEvidenceRoot, identity });
  return Object.freeze({ kind: "identityVerified", familyInstanceKey: identity.instanceKey, identityMemo: memo, identityMemoHash: identityMemoHash(memo), descriptorHash: identityDescriptorHash(identity), evidenceRoot: binding.candidateEvidenceRoot });
}

function publication(payload: ProjectionPayloadV1, state: Erc4626MaterializedStateV1): InstancePublicationV1 {
  const route = deriveErc4626Routes(payload.identityMemo.identity)[0];
  if (route === undefined) throw new TypeError("erc4626 route derivation returned no route");
  const inputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.inputAsset), portRef: hashDomain("aloha/erc4626/asset-port/v1", { instanceKey: route.instanceKey, direction: "input", asset: route.inputAsset }), ordinal: "0" };
  const outputPort: AssetPortV1 = { ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.outputAsset), portRef: hashDomain("aloha/erc4626/asset-port/v1", { instanceKey: route.instanceKey, direction: "output", asset: route.outputAsset }), ordinal: "0" };
  const transitionBody = { inputAssetPorts: [inputPort], outputAssetPorts: [outputPort], opaqueTransitionRef: hashDomain("aloha/erc4626/transition/v1", { route, stateHash: state.stateHash }), constraintRefs: [route.routeBindingHash, state.stateHash] };
  const transitionDraft = { ...transitionBody, staticProjectionHash: hashDomain("aloha/static-transition-projection/v1", transitionBody) };
  return sealInstancePublication({ familyId: ERC4626_FAMILY_ID, familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH, familyCandidateKey: payload.binding.familyCandidateKey, instanceKey: route.instanceKey, cutoff: payload.cutoff, identityMemo: canonical(payload.identityMemo), identityMemoHash: identityMemoHash(payload.identityMemo), descriptorHash: identityDescriptorHash(payload.identityMemo.identity), staticProjectionMemoHash: hashDomain("aloha/erc4626/static-projection/v1", { route, state: state.stateHash }), requestedArtifactDependencyRoot: hashDomain("aloha/erc4626/requested-artifacts/v1", { identityFactsHash: payload.identityMemo.identity.factsHash, stateHash: state.stateHash }), validityDependencyRoot: hashDomain("aloha/erc4626/validity/v1", { source: payload.cutoff, stateHash: state.stateHash }), transitions: [transitionDraft], evidenceRoot: payload.binding.candidateEvidenceRoot });
}

type StageInputV1 = Parameters<FamilyStageDefinitionV1["interpret"]>[0];

function interpretNomination(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "nomination"); const payload = decodeNominationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "erc4626.nomination"); if (fact.dataHex !== ackData(payload.binding.candidateSubjectHash)) throw new TypeError("erc4626-nomination-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "erc4626-nomination-verified", binding: payload.binding, cutoff: payload.cutoff, requestId: payload.requestId }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "erc4626-nomination-invalid") }); }
}

function interpretIdentity(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "identity");
    const payload = decodeIdentityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const candidate = candidateFromEvidence(payload, hexBytes(returned(facts[0]!, "erc4626.identity.candidateEvidence").dataHex, "erc4626.identity.candidateEvidence"));
    const result = verifyErc4626IdentityStage({ candidate, reads: {
      cutoff: payload.cutoff,
      target: decodeAddressWord(returned(facts[1]!, "erc4626.identity.target").dataHex, "erc4626.identity.target"),
      reverseTarget: decodeAddressWord(returned(facts[2]!, "erc4626.identity.reverseTarget").dataHex, "erc4626.identity.reverseTarget"),
      asset: decodeAddressWord(returned(facts[3]!, "erc4626.identity.asset").dataHex, "erc4626.identity.asset"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: identityOutput(result.identity, payload.binding) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "erc4626-identity-invalid") }); }
}

function materializationOutput(payload: MaterializationPayloadV1, state: Erc4626MaterializedStateV1): MaterializationOutputV1 {
  return Object.freeze({ kind: "erc4626-materialization-output", binding: payload.binding, identityMemoHash: identityMemoHash(payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, cutoff: payload.cutoff, state });
}

function interpretMaterialization(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "materialization");
    const payload = decodeMaterializationPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "erc4626.materialization.state");
    const result = materializeErc4626({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      factsHash: decodeHashWord(fact.dataHex, "erc4626.materialization.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: materializationOutput(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "erc4626-materialization-invalid") }); }
}

function interpretProjection(input: StageInputV1): ProgramInterpretationDraftV1 {
  try {
    assertProgramForStage(input, "projection");
    const payload = decodeProjectionPayload(input.payload);
    const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "erc4626.projection.state");
    const result = materializeErc4626({ identity: payload.identityMemo.identity, read: {
      cutoff: payload.cutoff,
      instanceKey: payload.identityMemo.identity.instanceKey,
      factsHash: decodeHashWord(fact.dataHex, "erc4626.projection.state"),
    } });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) throw new TypeError("erc4626-projection-state-lineage-mismatch");
    return Object.freeze({ kind: "verified", output: publication(payload, result.state) });
  } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "erc4626-projection-invalid") }); }
}

function interpretRehydration(input: StageInputV1): ProgramInterpretationDraftV1 {
  try { assertProgramForStage(input, "rehydration"); const payload = decodeRehydrationPayload(input.payload); const fact = returned(boundFacts(input.program, input.facts, [payload.requestId])[0]!, "erc4626.rehydration.reference"); if (fact.dataHex !== ackData(payload.referenceHash)) throw new TypeError("erc4626-rehydration-ack-mismatch"); return Object.freeze({ kind: "verified", output: Object.freeze({ kind: "erc4626-rehydration-verified", binding: payload.binding, cutoff: payload.cutoff, instanceKey: payload.binding.instanceNominationKey, referenceHash: payload.referenceHash, requestId: payload.requestId }) }); } catch (error) { return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "erc4626-rehydration-invalid") }); }
}

function definitionBase(stage: CoreStage, payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown }, outputSchemaRef: Hash, outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson }, prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"], interpret: FamilyStageDefinitionV1["interpret"]): FamilyStageDefinitionV1 {
  return deepFreeze({ stage, capabilityId: asCapabilityId(STAGE_IDS[stage]), version: VERSION, schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]), payloadCodec: deepFreeze(payloadCodec), dependencyIds: Object.freeze([]), outputSchemaRef, implementationClosureHash: hashDomain("aloha/erc4626/runtime-implementation/v1", { stage, module: "families/erc4626/src/runtime/definitions.ts" }), outputCodecHash: hashDomain("aloha/erc4626/runtime-output-codec/v1", stage), outputCodec: deepFreeze(outputCodec), prepareIssueValue, interpret });
}

const nominationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.nomination), decodeExact: (value: unknown) => decodeNominationPayload(value) });
const identityPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity), decodeExact: (value: unknown) => decodeIdentityPayload(value) });
const materializationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization), decodeExact: (value: unknown) => decodeMaterializationPayload(value) });
const projectionPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection), decodeExact: (value: unknown) => decodeProjectionPayload(value) });
const rehydrationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.rehydration), decodeExact: (value: unknown) => decodeRehydrationPayload(value) });

export const ERC4626_NOMINATION_DEFINITION = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/erc4626/runtime-output-schema/v1", "nomination"), { decodeExact: value => canonical(decodeNominationOutput(value)) }, prepareNomination, interpretNomination);
export const ERC4626_IDENTITY_DEFINITION = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/erc4626/runtime-output-schema/v1", "identity"), { decodeExact: value => canonical(decodeIdentityOutput(value)) }, prepareIdentity, interpretIdentity);
export const ERC4626_MATERIALIZATION_DEFINITION = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/erc4626/runtime-output-schema/v1", "materialization"), { decodeExact: value => canonical(decodeMaterializationOutput(value)) }, prepareMaterialization, interpretMaterialization);
export const ERC4626_PROJECTION_DEFINITION = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/erc4626/runtime-output-schema/v1", "projection"), { decodeExact: value => canonical(decodePublication(value)) }, prepareProjection, interpretProjection);
export const ERC4626_REHYDRATION_DEFINITION = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/erc4626/runtime-output-schema/v1", "rehydration"), { decodeExact: value => canonical(decodeRehydrationOutput(value)) }, prepareRehydration, interpretRehydration);
export const ERC4626_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([ERC4626_NOMINATION_DEFINITION, ERC4626_IDENTITY_DEFINITION, ERC4626_MATERIALIZATION_DEFINITION, ERC4626_PROJECTION_DEFINITION, ERC4626_REHYDRATION_DEFINITION]);
export const ERC4626_STAGE_IDS = STAGE_IDS;
export function requireErc4626StageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 { const definition = ERC4626_STAGE_DEFINITIONS.find(item => item.stage === stage); if (definition === undefined) throw new TypeError(`erc4626 stage definition missing: ${stage}`); return definition; }
