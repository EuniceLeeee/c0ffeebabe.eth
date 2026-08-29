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
/*
 * Stage runtime types are imported with the physical observation decoder so
 * candidate evidence is verified from raw bytes inside the Family owner.
 */
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
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import {
  candidateSnapshotHash,
  decodeFluidCreditCandidate,
  deriveFluidCreditRoutes,
  identityDescriptorHash,
  materializeFluidCredit,
  nominateFluidCredit,
  verifyFluidCreditIdentityStage,
} from "../stages.ts";
import { FLUID_CREDIT_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import { FLUID_CREDIT_EVIDENCE_TOPIC, FLUID_CREDIT_FACTORY_SOURCE_PLAN_ID, FLUID_CREDIT_FAMILY_ID, FLUID_CREDIT_FAMILY_VERSION, FLUID_CREDIT_PROBE_ACTOR, FLUID_VAULT_FACTORY, FLUID_VAULT_FACTORY_REVERSE_SELECTOR } from "../manifest.ts";
import { FLUID_CREDIT_FACTORY_SOURCE_PLAN_SCHEMA_HASH } from "../metadata.ts";
import { validDecimals } from "../kernel/math.ts";
import {
  canonicalAddress,
  type FluidCreditCandidateV1,
  type FluidCreditIdentityReadFactsV1,
  type FluidCreditIdentityV1,
  type FluidCreditMaterializedStateV1,
  type FluidCreditObservationV1,
  type FluidCreditStateReadFactsV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(FLUID_CREDIT_FAMILY_VERSION);
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/fluid-credit/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/fluid-credit/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/fluid-credit/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/fluid-credit/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/fluid-credit/stage-schema/v1", "rehydration"),
});
const IDENTITY_READ_PLAN = Object.freeze(["identity"]);
const STATE_READ_PLAN = Object.freeze(["state"]);
const NOMINATION_READ_PLAN = Object.freeze(["evidence"]);
const REHYDRATION_READ_PLAN = Object.freeze(["reference"]);
const FLUID_CREDIT_CONTRACT_PATTERN = "fluid-credit-operate-log" as const;
const FLUID_CREDIT_STAGE_IDS = Object.freeze({
  nomination: `family.${FLUID_CREDIT_FAMILY_ID}.nomination`,
  identity: `family.${FLUID_CREDIT_FAMILY_ID}.identity`,
  materialization: `family.${FLUID_CREDIT_FAMILY_ID}.materialization`,
  projection: `family.${FLUID_CREDIT_FAMILY_ID}.projection`,
  rehydration: `family.${FLUID_CREDIT_FAMILY_ID}.rehydration`,
});

type CandidateRecord = CandidateRecordV1;

interface CandidateBinding {
  readonly familyId: typeof FLUID_CREDIT_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
  readonly instanceNominationKey: string;
  readonly candidate: FluidCreditCandidateV1;
}

interface IdentityMemo {
  readonly kind: "fluid-credit-identity-memo";
  readonly version: 1;
  readonly familyId: typeof FLUID_CREDIT_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: FluidCreditIdentityV1;
}

interface NominationPayload {
  readonly kind: "fluid-credit-nomination-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface IdentityPayload {
  readonly kind: "fluid-credit-identity-input";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationPayload {
  readonly kind: "fluid-credit-materialization-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface MaterializationOutput {
  readonly kind: "fluid-credit-materialization-output";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly identityMemoHash: Hash;
  readonly identityFactsHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly state: FluidCreditMaterializedStateV1;
}

interface ProjectionPayload {
  readonly kind: "fluid-credit-projection-input";
  readonly binding: CandidateBinding;
  readonly identityMemo: IdentityMemo;
  readonly materialization: MaterializationOutput;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
}

interface RehydrationPayload {
  readonly kind: "fluid-credit-rehydration-input";
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
  readonly kind: "fluid-credit-nomination-verified";
  readonly binding: CandidateBinding;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface RehydrationOutput {
  readonly kind: "fluid-credit-rehydration-verified";
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

function decimals(value: unknown, path: string): number {
  if (typeof value !== "number") throw new TypeError(`${path} must be a number`);
  return validDecimals(value, path);
}

function signedDecimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new TypeError(`${path} must be a signed decimal integer`);
  return value;
}

function selector(value: unknown, path: string): `0x${string}` {
  const result = bytes(value, path);
  if (result.length !== 10) throw new TypeError(`${path} must be one selector word`);
  return result as `0x${string}`;
}

function readPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const result = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the FluidCredit read contract`);
  return Object.freeze([...result]);
}

function candidateEvidence(value: unknown, path: string): CandidateEvidenceRefV1 { return decodeCandidateEvidenceRef(value, path); }

function decodeCandidateRecord(value: unknown, path = "fluid-credit.candidate"): CandidateRecord {
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
  if (decoded.familyId !== FLUID_CREDIT_FAMILY_ID) throw new TypeError("fluid-credit candidate family mismatch");
  if (decoded.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit candidate definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-credit candidate key mismatch");
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-credit candidate subject mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("fluid-credit candidate evidence is empty");
  const hashes = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  const sorted = [...hashes].sort();
  if (new Set(hashes).size !== hashes.length || hashes.some((item, index) => item !== sorted[index])) throw new TypeError("fluid-credit candidate evidence is not canonical");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("fluid-credit candidate evidence root mismatch");
  if (decoded.evidence.some(item => item.kind === "recent-log" && (address(item.address, `${path}.evidence.address`) !== canonicalAddress(decoded.instanceNominationKey) || item.topic !== FLUID_CREDIT_EVIDENCE_TOPIC))) throw new TypeError("fluid-credit candidate evidence target/topic mismatch");
  return deepFreeze(decoded);
}

function internalCandidate(value: unknown, path: string): FluidCreditCandidateV1 {
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
      topic: (field, fieldPath) => assertHash(field, fieldPath),
      rawLocatorHash: (field, fieldPath) => assertHash(field, fieldPath),
    }, itemPath) as FluidCreditObservationV1,
  }, path) as FluidCreditCandidateV1;
  if (decoded.target !== decoded.evidence.target || decoded.instanceNominationKey !== decoded.target || decoded.evidence.topic !== FLUID_CREDIT_EVIDENCE_TOPIC) throw new TypeError("fluid-credit candidate binding mismatch");
  if (decoded.candidateSnapshotHash !== candidateSubjectHash(FLUID_CREDIT_FAMILY_DEFINITION_HASH, decoded.instanceNominationKey)) throw new TypeError("fluid-credit candidate snapshot mismatch");
  return deepFreeze(decoded);
}

function binding(value: unknown, path: string): CandidateBinding {
  const decoded = decodeExactObject(value, {
    familyId: (item, itemPath) => item === FLUID_CREDIT_FAMILY_ID ? FLUID_CREDIT_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => candidateEvidence(entry, entryPath), itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidate: (item, itemPath) => internalCandidate(item, itemPath),
  }, path) as CandidateBinding;
  if (decoded.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit binding definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-credit binding key mismatch");
  if (decoded.candidate.target !== decoded.instanceNominationKey || decoded.candidateSnapshotHash !== decoded.candidate.candidateSnapshotHash || decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence) || decoded.evidence.length === 0 || decoded.candidate.evidence.rawLocatorHash !== primaryEvidence(decoded.evidence).rawLocatorHash) throw new TypeError("fluid-credit binding candidate mismatch");
  return deepFreeze(decoded);
}

function primaryEvidence(evidence: readonly CandidateEvidenceRefV1[]): CandidateEvidenceRefV1 { const selected = evidence.find(item => item.kind === "source-plan") ?? evidence[0]; if (selected === undefined) throw new TypeError("fluid-credit candidate evidence is empty"); return selected; }

function reconstructBinding(value: unknown, cutoffValue: CanonicalCutoffV1): CandidateBinding {
  const record = decodeCandidateRecord(value);
  const selected = primaryEvidence(record.evidence);
  const observation: FluidCreditObservationV1 = {
    kind: "log",
    target: record.instanceNominationKey,
    cutoff: cutoffValue,
    blockNumber: selected.kind === "recent-log" ? selected.blockNumber : cutoffValue.number,
    blockHash: selected.kind === "recent-log" ? selected.blockHash : cutoffValue.hash,
    txHash: selected.kind === "recent-log" ? selected.txHash : cutoffValue.hash,
    logIndex: selected.kind === "recent-log" ? selected.logIndex : "0",
    topic: FLUID_CREDIT_EVIDENCE_TOPIC,
    rawLocatorHash: selected.rawLocatorHash,
  };
  const candidate: FluidCreditCandidateV1 = deepFreeze({ target: record.instanceNominationKey, instanceNominationKey: record.instanceNominationKey, candidateSnapshotHash: record.candidateSubjectHash, evidence: observation });
  return deepFreeze({
    familyId: FLUID_CREDIT_FAMILY_ID,
    familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
    familyCandidateKey: record.familyCandidateKey,
    candidateSnapshotHash: record.candidateSubjectHash,
    candidateEvidenceRoot: record.candidateEvidenceRoot,
    evidence: record.evidence,
    instanceNominationKey: record.instanceNominationKey,
    candidate,
  });
}

function assertBinding(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): void {
  if (bindingValue.familyId !== FLUID_CREDIT_FAMILY_ID || bindingValue.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH || bindingValue.familyCandidateKey !== discoveryFamilyCandidateKey(bindingValue.familyDefinitionHash, bindingValue.instanceNominationKey) || bindingValue.candidateSnapshotHash !== candidateSubjectHash(bindingValue.familyDefinitionHash, bindingValue.instanceNominationKey) || bindingValue.candidateSnapshotHash !== bindingValue.candidate.candidateSnapshotHash || bindingValue.candidateEvidenceRoot !== candidateEvidenceRoot(bindingValue.evidence) || bindingValue.evidence.length === 0 || bindingValue.candidate.evidence.rawLocatorHash !== primaryEvidence(bindingValue.evidence).rawLocatorHash || bindingValue.instanceNominationKey !== bindingValue.candidate.instanceNominationKey) throw new TypeError("fluid-credit payload candidate binding mismatch");
  if (!sameCutoff(bindingValue.candidate.evidence.cutoff, cutoffValue)) throw new TypeError("fluid-credit candidate cutoff mismatch");
}

function identityMemo(value: unknown, path = "fluid-credit.identityMemo"): IdentityMemo {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === FLUID_CREDIT_FAMILY_ID ? FLUID_CREDIT_FAMILY_ID : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => decodeIdentity(item, itemPath),
  }, path) as IdentityMemo;
  if (decoded.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit identity definition mismatch");
  if (decoded.familyCandidateKey !== discoveryFamilyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("fluid-credit identity candidate key mismatch");
  if (!/^0x[0-9a-f]{40}$/.test(decoded.instanceNominationKey) || decoded.candidateSnapshotHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.candidateSnapshotHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("fluid-credit identity lineage mismatch");
  return deepFreeze(decoded);
}

function decodeIdentity(value: unknown, path: string): FluidCreditIdentityV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    facts: (item, itemPath) => decodeExactObject(item, {
      vault: (field, fieldPath) => address(field, fieldPath),
      factory: (field, fieldPath) => address(field, fieldPath),
      vaultId: (field, fieldPath) => decimal(field, fieldPath),
      collateralAsset: (field, fieldPath) => address(field, fieldPath),
      debtAsset: (field, fieldPath) => address(field, fieldPath),
      collateralDecimals: (field, fieldPath) => decimals(field, fieldPath),
      debtDecimals: (field, fieldPath) => decimals(field, fieldPath),
      activeProbeActor: (field, fieldPath) => address(field, fieldPath),
    }, itemPath),
  }, path) as FluidCreditIdentityV1;
  if (decoded.facts.collateralAsset === decoded.facts.debtAsset || decoded.facts.collateralAsset === "0x0000000000000000000000000000000000000000" || decoded.facts.debtAsset === "0x0000000000000000000000000000000000000000") throw new TypeError("fluid-credit identity asset binding mismatch");
  if (decoded.factsHash !== hashDomain("aloha/fluid-credit/identity-facts/v1", decoded.facts) || decoded.instanceKey !== hashDomain("aloha/fluid-credit/instance/v1", decoded.facts)) throw new TypeError("fluid-credit identity facts lineage mismatch");
  return deepFreeze(decoded);
}

function decodeMaterializedState(value: unknown, path: string): FluidCreditMaterializedStateV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    availableCollateral: (item, itemPath) => decimal(item, itemPath),
    debtCapacity: (item, itemPath) => decimal(item, itemPath),
    stateHash: (item, itemPath) => assertHash(item, itemPath),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as FluidCreditMaterializedStateV1;
  if (decoded.stateHash !== hashDomain("aloha/fluid-credit/materialized-state/v1", { identityFactsHash: decoded.identityFactsHash, availableCollateral: decoded.availableCollateral, debtCapacity: decoded.debtCapacity })) throw new TypeError("fluid-credit state hash mismatch");
  return deepFreeze(decoded);
}

function decodeFactData(fact: Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }>, path: string): CanonicalJson {
  const hex = bytes(fact.dataHex, `${path}.dataHex`);
  const raw = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(raw);
}

function boundFact(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], expectedRequestId: Hash): Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }> {
  if (facts.length !== 1) throw new TypeError("fluid-credit transport fact cardinality mismatch");
  const fact = facts[0]!;
  if (fact.kind === "transportFailure") throw new TypeError("fluid-credit transport failure must be classified as retryable");
  if (fact.requestId !== expectedRequestId || fact.requestFingerprint !== program.requestFingerprint || fact.source.chainId !== program.source.chainId || fact.source.blockNumber !== program.source.number || fact.source.blockHash !== program.source.hash || fact.source.stateRoot !== program.source.stateRoot) throw new TypeError("fluid-credit transport fact source/program mismatch");
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

function identityReads(value: unknown, path: string): FluidCreditIdentityReadFactsV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    target: (item, itemPath) => address(item, itemPath),
    factory: (item, itemPath) => address(item, itemPath),
    reverseVault: (item, itemPath) => address(item, itemPath),
    vaultId: (item, itemPath) => decimal(item, itemPath),
    collateralAsset: (item, itemPath) => address(item, itemPath),
    debtAsset: (item, itemPath) => address(item, itemPath),
    collateralDecimals: (item, itemPath) => decimals(item, itemPath),
    debtDecimals: (item, itemPath) => decimals(item, itemPath),
    vaultHasCode: (item, itemPath) => typeof item === "boolean" ? item : (() => { throw new TypeError(`${itemPath} must be boolean`); })(),
    collateralAssetHasCode: (item, itemPath) => typeof item === "boolean" ? item : (() => { throw new TypeError(`${itemPath} must be boolean`); })(),
    debtAssetHasCode: (item, itemPath) => typeof item === "boolean" ? item : (() => { throw new TypeError(`${itemPath} must be boolean`); })(),
    activeProbe: (item, itemPath) => decodeExactObject(item, {
      actor: (field, fieldPath) => address(field, fieldPath),
      collateralAmount: (field, fieldPath) => decimal(field, fieldPath),
      debtAmount: (field, fieldPath) => decimal(field, fieldPath),
      nftId: (field, fieldPath) => decimal(field, fieldPath),
      finalSupply: (field, fieldPath) => decimal(field, fieldPath),
      finalBorrow: (field, fieldPath) => decimal(field, fieldPath),
      collateralDelta: (field, fieldPath) => signedDecimal(field, fieldPath),
      debtDelta: (field, fieldPath) => signedDecimal(field, fieldPath),
    }, itemPath),
  }, path) as FluidCreditIdentityReadFactsV1;
  if (decoded.activeProbe.actor !== FLUID_CREDIT_PROBE_ACTOR) throw new TypeError("fluid-credit active probe actor mismatch");
  return decoded;
}

function identityFact(value: unknown, path: string): { readonly candidateSnapshotHash: Hash; readonly candidateEvidenceBytesHex: string; readonly reads: FluidCreditIdentityReadFactsV1 } {
  return decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-identity-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceBytesHex: (item, itemPath) => bytes(item, itemPath),
    reads: (item, itemPath) => identityReads(item, itemPath),
  }, path);
}

function hexBytes(value: string, path: string): Uint8Array { const hex = bytes(value, path); const raw = new Uint8Array((hex.length - 2) / 2); for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16); return raw; }
function blockTag(value: string): string { return `0x${BigInt(value).toString(16)}`; }
function abiWord(value: string, path: string): bigint { if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${path} ABI word mismatch`); return BigInt(`0x${value}`); }

function verifyCandidateEvidence(payload: IdentityPayload, rawBytes: Uint8Array, reads: FluidCreditIdentityReadFactsV1): void {
  const evidence = primaryEvidence(payload.binding.evidence);
  if (sha256Hex(rawBytes) !== evidence.rawLocatorHash || payload.binding.candidate.evidence.rawLocatorHash !== evidence.rawLocatorHash) throw new TypeError("fluid-credit identity raw locator mismatch");
  if (evidence.kind === "recent-log") {
    const raw = decodeEvmLogObservationBytes(rawBytes, "fluid-credit.identity.recentEvidence");
    if (raw.blockNumber !== evidence.blockNumber || raw.blockHash !== evidence.blockHash || raw.transactionHash !== evidence.txHash || raw.logIndex !== evidence.logIndex || raw.address !== evidence.address || raw.address !== payload.binding.instanceNominationKey || raw.topics.length !== 1 || raw.topics[0] !== evidence.topic || raw.topics[0] !== FLUID_CREDIT_EVIDENCE_TOPIC || !/^0x(?:[0-9a-f]{64}){5}$/.test(raw.data) || BigInt(raw.blockNumber) > BigInt(payload.cutoff.number) || BigInt(raw.blockNumber) < BigInt(payload.cutoff.number) - 49n) throw new TypeError("fluid-credit recent evidence binding mismatch");
    return;
  }
  const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes, "fluid-credit.identity.factoryEvidence");
  if (observed.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH || observed.plan.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH || observed.plan.ownerRef !== evidence.ownerRef || observed.plan.sourcePlanRef !== evidence.sourcePlanRef || observed.plan.completeness !== "complete-snapshot" || observed.plan.historyStartBlock !== null || !sameCutoff(observed.cutoff, payload.cutoff) || observed.requestSchemaHash !== FLUID_CREDIT_FACTORY_SOURCE_PLAN_SCHEMA_HASH || observed.request.kind !== "family-source-plan-rpc" || observed.request.version !== 1 || observed.request.method !== "eth_call" || observed.request.target !== FLUID_VAULT_FACTORY || observed.request.manager !== FLUID_VAULT_FACTORY || observed.request.topic !== null || observed.request.lookback !== null || observed.request.chunk !== null || reads.factory !== FLUID_VAULT_FACTORY || reads.reverseVault !== payload.binding.instanceNominationKey) throw new TypeError("fluid-credit factory evidence binding mismatch");
  const params = observed.request.params;
  if (!Array.isArray(params) || params.length !== 2 || params[1] !== blockTag(payload.cutoff.number)) throw new TypeError("fluid-credit factory evidence params mismatch");
  const call = params[0];
  if (call === null || typeof call !== "object" || Array.isArray(call) || Reflect.ownKeys(call).sort().join(",") !== "data,to" || call.to !== FLUID_VAULT_FACTORY || typeof call.data !== "string" || !call.data.startsWith(FLUID_VAULT_FACTORY_REVERSE_SELECTOR) || call.data.length !== FLUID_VAULT_FACTORY_REVERSE_SELECTOR.length + 64 || abiWord(call.data.slice(FLUID_VAULT_FACTORY_REVERSE_SELECTOR.length), "fluid-credit vault id") !== BigInt(reads.vaultId)) throw new TypeError("fluid-credit factory evidence call mismatch");
  if (typeof observed.response !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(observed.response) || canonicalAddress(`0x${observed.response.slice(-40)}`) !== payload.binding.instanceNominationKey) throw new TypeError("fluid-credit factory evidence response mismatch");
}

function stateFact(value: unknown, path: string): FluidCreditStateReadFactsV1 {
  const fields = factObject(value, path);
  return decodeExactObject(fields, {
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    availableCollateral: (item, itemPath) => decimal(item, itemPath),
    debtCapacity: (item, itemPath) => decimal(item, itemPath),
  }, path) as FluidCreditStateReadFactsV1;
}

function identityRequestId(target: string, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/fluid-credit/request-id/v1", { phase: "identity", target, cutoff: cutoffValue });
}
function stateRequestId(instanceKey: string, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/fluid-credit/request-id/v1", { phase: "materialization", target: instanceKey, cutoff: cutoffValue });
}
function nominationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/fluid-credit/request-id/v1", { phase: "nomination", familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, cutoff: cutoffValue });
}
function rehydrationReferenceHash(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/fluid-credit/rehydration-reference/v1", { familyDefinitionHash: bindingValue.familyDefinitionHash, familyCandidateKey: bindingValue.familyCandidateKey, candidateSnapshotHash: bindingValue.candidateSnapshotHash, instanceKey: bindingValue.candidate.target, cutoff: cutoffValue });
}
function rehydrationRequestId(bindingValue: CandidateBinding, cutoffValue: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/fluid-credit/request-id/v1", { phase: "rehydration", target: bindingValue.candidate.target, referenceHash: rehydrationReferenceHash(bindingValue, cutoffValue), cutoff: cutoffValue });
}

function decodeNominationPayload(value: unknown, path = "fluid-credit.nominationPayload"): NominationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-nomination-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, NOMINATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-credit nomination request mismatch");
  return decoded;
}

function decodeIdentityPayload(value: unknown, path = "fluid-credit.identityPayload"): IdentityPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, IDENTITY_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== identityRequestId(decoded.binding.candidate.target, decoded.cutoff)) throw new TypeError("fluid-credit identity request mismatch");
  return decoded;
}

function decodeMaterializationPayload(value: unknown, path = "fluid-credit.materializationPayload"): MaterializationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as MaterializationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.instanceNominationKey !== decoded.binding.instanceNominationKey || decoded.identityMemo.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("fluid-credit materialization lineage mismatch");
  return decoded;
}

function decodeMaterializationOutput(value: unknown, path = "fluid-credit.materializationOutput"): MaterializationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-materialization-output" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
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
    || !sameCutoff(decoded.state.cutoff, decoded.cutoff)) throw new TypeError("fluid-credit materialization output lineage mismatch");
  return decoded;
}

function decodeProjectionPayload(value: unknown, path = "fluid-credit.projectionPayload"): ProjectionPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => decodeMaterializationOutput(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, STATE_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as ProjectionPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.identityMemo.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.identityMemo.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.materialization.binding.familyCandidateKey !== decoded.binding.familyCandidateKey || decoded.materialization.binding.candidateEvidenceRoot !== decoded.binding.candidateEvidenceRoot || decoded.materialization.identityFactsHash !== decoded.identityMemo.identity.factsHash || !sameCutoff(decoded.materialization.cutoff, decoded.cutoff) || decoded.requestId !== stateRequestId(decoded.identityMemo.identity.instanceKey, decoded.cutoff)) throw new TypeError("fluid-credit projection lineage mismatch");
  return decoded;
}

function decodeRehydrationPayload(value: unknown, path = "fluid-credit.rehydrationPayload"): RehydrationPayload {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-rehydration-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    readPlan: (item, itemPath) => readPlan(item, itemPath, REHYDRATION_READ_PLAN),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationPayload;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-credit rehydration request mismatch");
  return decoded;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const result = canonical(value);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${path} must be an object`);
  return result;
}

function decodeIdentityOutput(value: unknown, path = "fluid-credit.identityOutput"): IdentityObservation {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => assertHash(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path) as IdentityObservation;
  if (decoded.familyInstanceKey !== decoded.identityMemo.identity.instanceKey || decoded.identityMemoHash !== hashDomain("aloha/identity-memo/v1", decoded.identityMemo) || decoded.descriptorHash !== identityDescriptorHash(decoded.identityMemo.identity) || decoded.evidenceRoot !== decoded.identityMemo.candidateEvidenceRoot) throw new TypeError("fluid-credit identity output lineage mismatch");
  return deepFreeze(decoded);
}

function nominationOutput(value: unknown, path = "fluid-credit.nominationOutput"): NominationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-nomination-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as NominationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.requestId !== nominationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-credit nomination output mismatch");
  return deepFreeze(decoded);
}

function materializationOutput(value: unknown, path = "fluid-credit.materializationOutput"): CanonicalJson {
  return outputObject(decodeMaterializationOutput(value, path), path);
}

function projectionOutput(value: unknown, path = "fluid-credit.projectionOutput"): CanonicalJson {
  const result = outputObject(value, path) as unknown as InstancePublicationV1;
  validateInstancePublication(result);
  const memo = identityMemo(result.identityMemo, `${path}.identityMemo`);
  if (result.familyId !== FLUID_CREDIT_FAMILY_ID || result.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH || result.familyCandidateKey !== memo.familyCandidateKey || result.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo) || result.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("fluid-credit projection publication identity mismatch");
  return canonical(result);
}

function rehydrationOutput(value: unknown, path = "fluid-credit.rehydrationOutput"): RehydrationOutput {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "fluid-credit-rehydration-verified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    binding: (item, itemPath) => binding(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    instanceKey: (item, itemPath) => assertHash(item, itemPath),
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path) as RehydrationOutput;
  assertBinding(decoded.binding, decoded.cutoff);
  if (decoded.referenceHash !== rehydrationReferenceHash(decoded.binding, decoded.cutoff) || decoded.requestId !== rehydrationRequestId(decoded.binding, decoded.cutoff)) throw new TypeError("fluid-credit rehydration output mismatch");
  return deepFreeze(decoded);
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(code) ? code : fallback;
}

function prepareNomination(input: FamilyStageGenericInvocationV1): NominationPayload {
  if (input.stage !== "nomination") throw new TypeError("fluid-credit-nomination-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("fluid-credit-nomination-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "fluid-credit.nominationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  return deepFreeze({ kind: "fluid-credit-nomination-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: NOMINATION_READ_PLAN, requestId: nominationRequestId(candidateBinding, cutoffValue) });
}

function prepareIdentity(input: FamilyStageGenericInvocationV1): IdentityPayload {
  if (input.stage !== "identity") throw new TypeError("fluid-credit-identity-stage-mismatch");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("fluid-credit-identity-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "fluid-credit.identityInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  return deepFreeze({ kind: "fluid-credit-identity-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: IDENTITY_READ_PLAN, requestId: identityRequestId(candidateBinding.candidate.target, cutoffValue) });
}

function prepareMaterialization(input: FamilyStageGenericInvocationV1): MaterializationPayload {
  if (input.stage !== "materialization") throw new TypeError("fluid-credit-materialization-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("fluid-credit-materialization-prior-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "fluid-credit.materializationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "fluid-credit.materializationInvocation.identityMemo");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || memo.candidateSnapshotHash !== candidateBinding.candidateSnapshotHash || memo.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot) throw new TypeError("fluid-credit-materialization-identity-lineage-mismatch");
  return deepFreeze({ kind: "fluid-credit-materialization-input", binding: candidateBinding, identityMemo: memo, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareProjection(input: FamilyStageGenericInvocationV1): ProjectionPayload {
  if (input.stage !== "projection") throw new TypeError("fluid-credit-projection-stage-mismatch");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("fluid-credit-projection-prior-output-missing");
  const cutoffValue = cutoff(input.cutoff, "fluid-credit.projectionInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const memo = identityMemo(input.identityMemo, "fluid-credit.projectionInvocation.identityMemo");
  const materialization = decodeMaterializationOutput(input.materializationOutput, "fluid-credit.projectionInvocation.materializationOutput");
  if (memo.familyCandidateKey !== candidateBinding.familyCandidateKey || memo.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot || materialization.binding.familyCandidateKey !== candidateBinding.familyCandidateKey || materialization.binding.candidateEvidenceRoot !== candidateBinding.candidateEvidenceRoot || materialization.identityFactsHash !== memo.identity.factsHash) throw new TypeError("fluid-credit-projection-lineage-mismatch");
  return deepFreeze({ kind: "fluid-credit-projection-input", binding: candidateBinding, identityMemo: memo, materialization, cutoff: cutoffValue, readPlan: STATE_READ_PLAN, requestId: stateRequestId(memo.identity.instanceKey, cutoffValue) });
}

function prepareRehydration(input: FamilyStageGenericInvocationV1): RehydrationPayload {
  if (input.stage !== "rehydration") throw new TypeError("fluid-credit-rehydration-stage-mismatch");
  if (input.materializationOutput !== null) throw new TypeError("fluid-credit-rehydration-materialization-output-mismatch");
  const cutoffValue = cutoff(input.cutoff, "fluid-credit.rehydrationInvocation.cutoff");
  const candidateBinding = reconstructBinding(input.candidate, cutoffValue);
  const referenceHash = rehydrationReferenceHash(candidateBinding, cutoffValue);
  return deepFreeze({ kind: "fluid-credit-rehydration-input", binding: candidateBinding, cutoff: cutoffValue, readPlan: REHYDRATION_READ_PLAN, requestId: rehydrationRequestId(candidateBinding, cutoffValue), referenceHash });
}

function interpretNomination(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeNominationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-nomination-fact-required" });
    if (fact.dataHex !== `0x${payload.binding.candidateSnapshotHash.slice(2)}`) return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-nomination-evidence-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "fluid-credit-nomination-verified", binding: payload.binding, cutoff: payload.cutoff, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-credit-nomination-invalid") });
  }
}

function interpretIdentity(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeIdentityPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-identity-fact-required" });
    const decoded = identityFact(decodeFactData(fact, "fluid-credit.identityFact"), "fluid-credit.identityFact");
    if (decoded.candidateSnapshotHash !== payload.binding.candidateSnapshotHash || !sameCutoff(decoded.reads.cutoff, payload.cutoff)) throw new TypeError("fluid-credit identity fact snapshot mismatch");
    verifyCandidateEvidence(payload, hexBytes(decoded.candidateEvidenceBytesHex, "fluid-credit.identityFact.candidateEvidenceBytesHex"), decoded.reads);
    const reads = decoded.reads;
    if (reads.target !== payload.binding.candidate.target) throw new TypeError("fluid-credit identity target mismatch");
    const result = verifyFluidCreditIdentityStage({ candidate: payload.binding.candidate, reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo: IdentityMemo = { kind: "fluid-credit-identity-memo", version: 1, familyId: FLUID_CREDIT_FAMILY_ID, familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH, familyCandidateKey: payload.binding.familyCandidateKey, instanceNominationKey: payload.binding.instanceNominationKey, candidateSnapshotHash: result.identity.candidateSnapshotHash, candidateEvidenceRoot: payload.binding.candidateEvidenceRoot, identity: result.identity };
    return Object.freeze({ kind: "verified", output: { kind: "identityVerified", familyInstanceKey: result.identity.instanceKey, identityMemo: memo, identityMemoHash: hashDomain("aloha/identity-memo/v1", memo), descriptorHash: identityDescriptorHash(result.identity), evidenceRoot: payload.binding.candidateEvidenceRoot } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-credit-identity-invalid") });
  }
}

function interpretMaterialization(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeMaterializationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-materialization-fact-required" });
    const reads = stateFact(decodeFactData(fact, "fluid-credit.stateFact"), "fluid-credit.stateFact");
    const result = materializeFluidCredit({ identity: payload.identityMemo.identity, read: reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const output: MaterializationOutput = { kind: "fluid-credit-materialization-output", binding: payload.binding, identityMemo: payload.identityMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo), identityFactsHash: payload.identityMemo.identity.factsHash, cutoff: payload.cutoff, state: result.state };
    return Object.freeze({ kind: "verified", output });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-credit-materialization-invalid") });
  }
}

function publication(payload: ProjectionPayload, program: FrozenProgramEnvelopeV1): InstancePublicationV1 {
  const identity = payload.identityMemo.identity;
  const routes = deriveFluidCreditRoutes(identity);
  const transitions = routes.map(route => ({
    inputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.collateralAsset), portRef: hashDomain("aloha/fluid-credit/port/v1", { target: route.instanceKey, asset: route.collateralAsset }), ordinal: "0" }],
    outputAssetPorts: [{ ...erc20AssetPortBindingV1(payload.cutoff.chainId, route.debtAsset), portRef: hashDomain("aloha/fluid-credit/port/v1", { target: route.instanceKey, asset: route.debtAsset }), ordinal: "0" }],
    opaqueTransitionRef: hashDomain("aloha/fluid-credit/transition/v1", route),
    constraintRefs: [route.routeBindingHash],
    staticProjectionHash: hashDomain("aloha/fluid-credit/static-transition/v1", route),
  }));
  return sealInstancePublication({
    familyId: FLUID_CREDIT_FAMILY_ID,
    familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
    familyCandidateKey: payload.binding.familyCandidateKey,
    instanceKey: identity.instanceKey,
    cutoff: payload.cutoff,
    identityMemo: canonical(payload.identityMemo),
    identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identityMemo),
    descriptorHash: identityDescriptorHash(identity),
    staticProjectionMemoHash: hashDomain("aloha/fluid-credit/static-projection/v1", routes),
    requestedArtifactDependencyRoot: hashDomain("aloha/fluid-credit/requested-artifacts/v1", { instanceKey: identity.instanceKey, identityFactsHash: identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/fluid-credit/validity/v1", { source: program.source, identityFactsHash: identity.factsHash }),
    transitions,
    evidenceRoot: payload.binding.candidateEvidenceRoot,
  });
}

function interpretProjection(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeProjectionPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-projection-fact-required" });
    const reads = stateFact(decodeFactData(fact, "fluid-credit.projectionStateFact"), "fluid-credit.projectionStateFact");
    const result = materializeFluidCredit({ identity: payload.identityMemo.identity, read: reads });
    if (result.status !== "verified") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    if (result.state.stateHash !== payload.materialization.state.stateHash) return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-projection-state-lineage-mismatch" });
    return Object.freeze({ kind: "verified", output: publication(payload, input.program) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-credit-projection-invalid") });
  }
}

function interpretRehydration(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeRehydrationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-rehydration-reference-mismatch" });
    const data = factObject(decodeFactData(fact, "fluid-credit.rehydrationFact"), "fluid-credit.rehydrationFact");
    const reference = decodeExactObject(data, { referenceHash: (item, itemPath) => assertHash(item, itemPath), instanceKey: (item, itemPath) => assertHash(item, itemPath) }, "fluid-credit.rehydrationFact");
    if (reference.referenceHash !== payload.referenceHash) return Object.freeze({ kind: "invalidProgram", code: "fluid-credit-rehydration-reference-mismatch" });
    return Object.freeze({ kind: "verified", output: { kind: "fluid-credit-rehydration-verified", binding: payload.binding, cutoff: payload.cutoff, instanceKey: reference.instanceKey, referenceHash: payload.referenceHash, requestId: payload.requestId } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "fluid-credit-rehydration-invalid") });
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
    capabilityId: asCapabilityId(FLUID_CREDIT_STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]),
    payloadCodec,
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/fluid-credit/runtime-implementation/v1", { stage, module: "families/fluid-credit/src/runtime/definitions.ts" }),
    outputCodecHash: hashDomain("aloha/fluid-credit/runtime-output-codec/v1", stage),
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

export const FLUID_CREDIT_NOMINATION_RUNTIME = definitionBase("nomination", nominationPayloadCodec, hashDomain("aloha/fluid-credit/runtime-output-schema/v1", "nomination"), { decodeExact: value => outputObject(nominationOutput(value), "fluid-credit.nominationOutput") }, prepareNomination, interpretNomination);
export const FLUID_CREDIT_IDENTITY_RUNTIME = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/fluid-credit/runtime-output-schema/v1", "identity"), { decodeExact: value => outputObject(decodeIdentityOutput(value), "fluid-credit.identityOutput") }, prepareIdentity, interpretIdentity);
export const FLUID_CREDIT_MATERIALIZATION_RUNTIME = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/fluid-credit/runtime-output-schema/v1", "materialization"), { decodeExact: value => materializationOutput(value) }, prepareMaterialization, interpretMaterialization);
export const FLUID_CREDIT_PROJECTION_RUNTIME = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/fluid-credit/runtime-output-schema/v1", "projection"), { decodeExact: value => projectionOutput(value) }, prepareProjection, interpretProjection);
export const FLUID_CREDIT_REHYDRATION_RUNTIME = definitionBase("rehydration", rehydrationPayloadCodec, hashDomain("aloha/fluid-credit/runtime-output-schema/v1", "rehydration"), { decodeExact: value => outputObject(rehydrationOutput(value), "fluid-credit.rehydrationOutput") }, prepareRehydration, interpretRehydration);

export const FLUID_CREDIT_NOMINATION_DEFINITION = FLUID_CREDIT_NOMINATION_RUNTIME;
export const FLUID_CREDIT_IDENTITY_DEFINITION = FLUID_CREDIT_IDENTITY_RUNTIME;
export const FLUID_CREDIT_MATERIALIZATION_DEFINITION = FLUID_CREDIT_MATERIALIZATION_RUNTIME;
export const FLUID_CREDIT_PROJECTION_DEFINITION = FLUID_CREDIT_PROJECTION_RUNTIME;
export const FLUID_CREDIT_REHYDRATION_DEFINITION = FLUID_CREDIT_REHYDRATION_RUNTIME;

export const FLUID_CREDIT_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  FLUID_CREDIT_NOMINATION_DEFINITION,
  FLUID_CREDIT_IDENTITY_DEFINITION,
  FLUID_CREDIT_MATERIALIZATION_DEFINITION,
  FLUID_CREDIT_PROJECTION_DEFINITION,
  FLUID_CREDIT_REHYDRATION_DEFINITION,
]);

export function requireFluidCreditStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = FLUID_CREDIT_STAGE_DEFINITIONS.find(item => item.stage === stage);
  if (definition === undefined) throw new TypeError(`fluid-credit stage definition missing: ${stage}`);
  return definition;
}
