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
  FrameworkFactSetCapabilityV1,
  ProgramInterpretationDraftV1,
  ExecutionFactSourceV1,
  TransportFactV1,
} from "../../../../packages/capability-interpreters/src/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asSchemaRef,
  type SchemaRef,
} from "../../../../packages/capability-contracts/src/index.ts";
import type {
  FamilyStageDefinitionV1,
  FamilyRuntimeStageV1,
  FamilyStageGenericInvocationV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { decodeFamilySourcePlanPhysicalObservation } from "../../../../packages/family-sdk/runtime/index.ts";
import type { FrozenProgramEnvelopeV1, ProgramSourceAnchorV1 } from "../../../../packages/request-program/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
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
  familyCandidateKey,
  type CandidateRecordV1,
  type CandidateEvidenceRefV1,
  type CanonicalCutoffV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  ASTRA_CHANGE_SELECTOR,
  ASTRA_CHANGE_TOPIC,
  ASTRA_FAMILY_ID,
  ASTRA_FAMILY_VERSION,
  ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ASTRA_STAGE_IDS,
} from "../manifest.ts";
import { ASTRA_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import { decodeAstraCandidate } from "../discovery.ts";
import { verifyAstraIdentity } from "../identity.ts";
import { astraInstanceDescriptorHash, compileAstraInstance } from "../instance.ts";
import { deriveAstraRoutes } from "../routes.ts";
import { decodeAstraHistoryEntries } from "../history-source-plan.ts";
import type {
  Address,
  AstraCandidateV1,
  AstraIdentityReadsV1,
  AstraIdentityV1,
  SourceAnchorV1,
} from "../types.ts";

const VERSION = asCapabilityVersion(ASTRA_FAMILY_VERSION);
const STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: hashDomain("aloha/astra-multitoken/stage-schema/v1", "nomination"),
  identity: hashDomain("aloha/astra-multitoken/stage-schema/v1", "identity"),
  materialization: hashDomain("aloha/astra-multitoken/stage-schema/v1", "materialization"),
  projection: hashDomain("aloha/astra-multitoken/stage-schema/v1", "projection"),
  rehydration: hashDomain("aloha/astra-multitoken/stage-schema/v1", "rehydration"),
});

type AstraCoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
type AstraCandidateRecordV1 = CandidateRecordV1;

interface AstraCandidateWitnessV1 {
  readonly target: Address;
  readonly actor: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly observedAmountOut: bigint | null;
  readonly sourceKind: "observed-change-call" | "change-log";
  readonly txHash: Hash;
  readonly logIndex: string;
}

interface AstraIdentityPayloadV1 {
  readonly kind: "astra-identity-input";
  readonly target: Address;
  readonly candidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly evidence: CandidateEvidenceRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface AstraMaterializationPayloadV1 {
  readonly kind: "astra-materialization-input";
  readonly target: Address;
  readonly identity: CanonicalJson;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface DecodedAstraMaterializationPayloadV1 extends Omit<AstraMaterializationPayloadV1, "identity"> {
  readonly identity: DecodedIdentityMemoV1;
}

interface AstraProjectionPayloadV1 {
  readonly kind: "astra-projection-input";
  readonly target: Address;
  readonly candidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: CanonicalJson;
  readonly materialization: CanonicalJson;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestId: Hash;
}

interface DecodedAstraProjectionPayloadV1 extends Omit<AstraProjectionPayloadV1, "identity" | "materialization"> {
  readonly identity: DecodedIdentityMemoV1;
  readonly materialization: DecodedMaterializationOutputV1;
}

interface DecodedIdentityMemoV1 {
  readonly memo: CanonicalJson;
  readonly familyDefinitionHash: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly witness: AstraCandidateWitnessV1;
  readonly identity: AstraIdentityV1;
}

interface DecodedMaterializationOutputV1 {
  readonly output: CanonicalJson;
  readonly instanceMemo: CanonicalJson;
  readonly instance: ReturnType<typeof compileAstraInstance>;
  readonly instanceKey: Address;
  readonly candidateSnapshotHash: Hash;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function address(value: unknown, path: string): Address {
  const text = assertNonEmptyString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new TypeError(`${path} must be an address`);
  return `0x${text.slice(2).toLowerCase()}` as Address;
}

function bytes(value: unknown, path: string): string {
  const text = assertNonEmptyString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(text)) throw new TypeError(`${path} must be canonical bytes`);
  return text;
}

function hexBytes(value: string, path: string): Uint8Array {
  const hex = bytes(value, path);
  const result = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return result;
}

function bigintDecimal(value: unknown, path: string): bigint {
  return BigInt(assertDecimalString(value, path));
}

function basicSource(value: unknown, path: string): SourceAnchorV1 {
  return decodeExactObject(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    number: (item, itemPath) => assertDecimalString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function executionSource(value: unknown, path: string): ExecutionFactSourceV1 {
  return decodeExactObject(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    blockNumber: (item, itemPath) => assertDecimalString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
    executorAuthorityRoot: (item, itemPath) => assertHash(item, itemPath),
    workerEpoch: (item, itemPath) => assertNonEmptyString(item, itemPath),
    executorSessionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function sameSource(left: SourceAnchorV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function sameCutoff(left: CanonicalCutoffV1, right: ProgramSourceAnchorV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function witnessJson(value: AstraCandidateWitnessV1): CanonicalJson {
  return canonical({
    target: value.target,
    actor: value.actor,
    tokenIn: value.tokenIn,
    tokenOut: value.tokenOut,
    amountIn: value.amountIn.toString(),
    minAmountOut: value.minAmountOut.toString(),
    observedAmountOut: value.observedAmountOut?.toString() ?? null,
    sourceKind: value.sourceKind,
    txHash: value.txHash,
    logIndex: value.logIndex,
  });
}

function decodeWitness(value: unknown, path: string): AstraCandidateWitnessV1 {
  const decoded = decodeExactObject(value, {
    target: (item, itemPath) => address(item, itemPath),
    actor: (item, itemPath) => address(item, itemPath),
    tokenIn: (item, itemPath) => address(item, itemPath),
    tokenOut: (item, itemPath) => address(item, itemPath),
    amountIn: (item, itemPath) => assertDecimalString(item, itemPath),
    minAmountOut: (item, itemPath) => assertDecimalString(item, itemPath),
    observedAmountOut: (item, itemPath) => item === null ? null : assertDecimalString(item, itemPath),
    sourceKind: (item, itemPath) => {
      if (item !== "observed-change-call" && item !== "change-log") throw new TypeError(`${itemPath} source kind mismatch`);
      return item;
    },
    txHash: (item, itemPath) => assertHash(item, itemPath),
    logIndex: (item, itemPath) => assertDecimalString(item, itemPath),
  }, path);
  if (decoded.sourceKind === "change-log" && decoded.observedAmountOut === null) throw new TypeError(`${path}.observedAmountOut is required for a log witness`);
  return deepFreeze({
    target: decoded.target,
    actor: decoded.actor,
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
    amountIn: BigInt(decoded.amountIn),
    minAmountOut: BigInt(decoded.minAmountOut),
    observedAmountOut: decoded.observedAmountOut === null ? null : BigInt(decoded.observedAmountOut),
    sourceKind: decoded.sourceKind,
    txHash: decoded.txHash,
    logIndex: decoded.logIndex,
  });
}

function word(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function witnessObservation(witness: AstraCandidateWitnessV1, source: SourceAnchorV1) {
  if (witness.sourceKind === "observed-change-call") {
    return {
      kind: "call" as const,
      target: witness.target,
      sender: witness.actor,
      source,
      blockNumber: source.number,
      blockHash: source.hash,
      txHash: witness.txHash,
      logIndex: witness.logIndex,
      dataHex: `${ASTRA_CHANGE_SELECTOR}${word(witness.tokenIn)}${word(witness.tokenOut)}${witness.amountIn.toString(16).padStart(64, "0")}${witness.minAmountOut.toString(16).padStart(64, "0")}`,
    };
  }
  const observed = witness.observedAmountOut;
  if (observed === null) throw new TypeError("Astra log witness has no observed amount");
  return {
    kind: "log" as const,
    target: witness.target,
    source,
    blockNumber: source.number,
    blockHash: source.hash,
    txHash: witness.txHash,
    logIndex: witness.logIndex,
    topics: [ASTRA_CHANGE_TOPIC, `0x${word(witness.tokenIn)}`, `0x${word(witness.tokenOut)}`, `0x${word(witness.actor)}`],
    dataHex: `0x${observed === null ? "" : witness.amountIn.toString(16).padStart(64, "0")}${observed.toString(16).padStart(64, "0")}`,
  };
}

function verifyWitness(witness: AstraCandidateWitnessV1, source: SourceAnchorV1): AstraCandidateV1 {
  const observation = witnessObservation(witness, source);
  const candidate = decodeAstraCandidate(observation, witness.sourceKind === "observed-change-call" ? "astra-change-call" : "astra-change-log");
  if (candidate === null) throw new TypeError("astra candidate witness mismatch");
  return candidate;
}

function candidateRecord(value: unknown, path = "astra.candidate"): AstraCandidateRecordV1 {
  const decoded = decodeExactObject<AstraCandidateRecordV1>(value, {
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
  if (decoded.familyId !== ASTRA_FAMILY_ID) throw new TypeError("astra candidate family mismatch");
  if (decoded.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH) throw new TypeError("astra candidate definition mismatch");
  if (decoded.familyCandidateKey !== familyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("astra candidate key mismatch");
  const target = address(decoded.instanceNominationKey, `${path}.instanceNominationKey`);
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("astra candidate subject mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("astra candidate evidence is empty");
  const evidenceHashes = decoded.evidence.map(value => hashDomain("aloha/candidate-evidence-ref/v1", value));
  const sorted = [...evidenceHashes].sort();
  if (new Set(evidenceHashes).size !== evidenceHashes.length || evidenceHashes.some((value, index) => value !== sorted[index])) throw new TypeError("astra candidate evidence is not canonical");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("astra candidate evidence root mismatch");
  if (decoded.evidence.some(value => value.kind === "recent-log" && (address(value.address, `${path}.evidence.address`) !== target || value.topic !== ASTRA_CHANGE_TOPIC))) throw new TypeError("astra candidate evidence target/topic mismatch");
  return deepFreeze(decoded);
}

function requireStage(input: FamilyStageGenericInvocationV1, expected: FamilyRuntimeStageV1): void {
  if (input.stage !== expected) throw new TypeError(`astra-${expected}-stage-mismatch`);
}

function primaryEvidence(candidate: AstraCandidateRecordV1): CandidateEvidenceRefV1 {
  const evidence = candidate.evidence.find(value => value.kind === "source-plan") ?? candidate.evidence[0];
  if (evidence === undefined) throw new TypeError("astra candidate evidence is empty");
  return evidence;
}

function requestId(
  phase: "identity" | "materialization" | "projection",
  target: Address,
  cutoff: CanonicalCutoffV1,
  identityFactsHash: Hash | null,
  candidateSnapshotHash: Hash,
  candidateEvidenceRootValue: Hash,
  evidence: CandidateEvidenceRefV1 | null,
): Hash {
  return hashDomain("aloha/astra-multitoken/runtime-request/v1", {
    phase,
    target,
    cutoff,
    identityFactsHash,
    candidateSnapshotHash,
    candidateEvidenceRoot: candidateEvidenceRootValue,
    evidence,
  });
}

function decodeIdentityPayload(value: unknown, path = "astra.identityPayload"): AstraIdentityPayloadV1 {
  const decoded = decodeExactObject<AstraIdentityPayloadV1>(value, {
    kind: (item, itemPath) => item === "astra-identity-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    target: (item, itemPath) => address(item, itemPath),
    candidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.candidateKey !== familyCandidateKey(ASTRA_FAMILY_DEFINITION_HASH, decoded.target)) throw new TypeError("astra identity candidate key mismatch");
  if (decoded.requestId !== requestId("identity", decoded.target, decoded.cutoff, null, decoded.candidateSnapshotHash, decoded.candidateEvidenceRoot, decoded.evidence)) throw new TypeError("astra identity request mismatch");
  return decoded;
}

interface AstraIdentityFactV1 {
  readonly kind: "astra-identity-facts";
  readonly version: 1;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceBytesHex: string;
  readonly candidate: AstraCandidateWitnessV1;
  readonly reads: {
    readonly target: Address;
    readonly tokens: readonly Address[];
    readonly tokenCodeHashes: readonly Hash[];
    readonly weights: readonly bigint[];
    readonly changesEnabled: boolean;
    readonly totalPercents: bigint;
    readonly changeFee: bigint;
    readonly inLendingMode: bigint | null;
    readonly activeQuote: bigint;
  };
}

function decodeIdentityFact(value: unknown, path = "astra.identityFact"): AstraIdentityFactV1 {
  const decoded = decodeExactObject<AstraIdentityFactV1>(value, {
    kind: (item, itemPath) => item === "astra-identity-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceBytesHex: (item, itemPath) => bytes(item, itemPath),
    candidate: (item, itemPath) => decodeWitness(item, itemPath),
    reads: (item, itemPath) => decodeExactObject(item, {
      target: (field, fieldPath) => address(field, fieldPath),
      tokens: (field, fieldPath) => fieldArray(field, (entry, entryPath) => address(entry, entryPath), fieldPath),
      tokenCodeHashes: (field, fieldPath) => fieldArray(field, (entry, entryPath) => {
        const hash = assertHash(entry, entryPath);
        if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new TypeError(`${entryPath} must be a 32-byte lowercase hash`);
        return hash;
      }, fieldPath),
      weights: (field, fieldPath) => fieldArray(field, (entry, entryPath) => bigintDecimal(entry, entryPath), fieldPath),
      changesEnabled: (field, fieldPath) => typeof field === "boolean" ? field : (() => { throw new TypeError(`${fieldPath} must be boolean`); })(),
      totalPercents: (field, fieldPath) => bigintDecimal(field, fieldPath),
      changeFee: (field, fieldPath) => bigintDecimal(field, fieldPath),
      inLendingMode: (field, fieldPath) => field === null ? null : bigintDecimal(field, fieldPath),
      activeQuote: (field, fieldPath) => bigintDecimal(field, fieldPath),
    }, itemPath),
  }, path);
  return deepFreeze(decoded);
}

/** Convert a canonical hex byte string to canonical JSON without accepting ABI aliases or text variants. */
function decodeFactData(fact: Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }>, path: string): CanonicalJson {
  const hex = bytes(fact.dataHex, `${path}.dataHex`);
  const raw = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(raw);
}

function boundFact(program: FrozenProgramEnvelopeV1, facts: readonly TransportFactV1[], expectedRequestId: Hash): Extract<TransportFactV1, { readonly kind: "returned" | "reverted" }> {
  if (facts.length !== 1) throw new TypeError("astra transport fact cardinality mismatch");
  const fact = facts[0]!;
  if (fact.kind === "transportFailure") throw new TypeError("astra transport failure must be classified as retryable");
  if (fact.requestId !== expectedRequestId) throw new TypeError("astra transport request id mismatch");
  if (fact.requestFingerprint !== program.requestFingerprint || !sameSource({
    chainId: fact.source.chainId,
    number: fact.source.blockNumber,
    hash: fact.source.blockHash,
    stateRoot: fact.source.stateRoot,
  }, program.source)) throw new TypeError("astra transport fact source/program mismatch");
  return fact;
}

function decodeIdentityMemoIdentity(value: unknown, path: string): {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly actor: Address;
  readonly target: Address;
  readonly tokens: readonly Address[];
  readonly tokenCodeHashes: readonly Hash[];
  readonly weights: readonly bigint[];
  readonly changesEnabled: true;
  readonly totalPercents: bigint;
  readonly changeFee: bigint;
  readonly inLendingMode: bigint | null;
  readonly activeQuote: bigint;
  readonly source: SourceAnchorV1;
  readonly factsHash: Hash;
  readonly instanceKey: Address;
} {
  const decoded = decodeExactObject(value, {
    familyId: (item, itemPath) => item === ASTRA_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    actor: (item, itemPath) => address(item, itemPath),
    target: (item, itemPath) => address(item, itemPath),
    tokens: (item, itemPath) => fieldArray(item, (entry, entryPath) => address(entry, entryPath), itemPath),
    tokenCodeHashes: (item, itemPath) => fieldArray(item, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    weights: (item, itemPath) => fieldArray(item, (entry, entryPath) => bigintDecimal(entry, entryPath), itemPath),
    changesEnabled: (item, itemPath) => item === true ? true as const : (() => { throw new TypeError(`${itemPath} changesEnabled mismatch`); })(),
    totalPercents: (item, itemPath) => bigintDecimal(item, itemPath),
    changeFee: (item, itemPath) => bigintDecimal(item, itemPath),
    inLendingMode: (item, itemPath) => item === null ? null : bigintDecimal(item, itemPath),
    activeQuote: (item, itemPath) => bigintDecimal(item, itemPath),
    source: (item, itemPath) => basicSource(item, itemPath),
    factsHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => address(item, itemPath),
  }, path);
  return deepFreeze(decoded);
}

function identityMemo(value: unknown, path = "astra.identityMemo"): DecodedIdentityMemoV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "astra-identity-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    witness: (item, itemPath) => decodeWitness(item, itemPath),
    identity: (item, itemPath) => decodeIdentityMemoIdentity(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || decoded.identity.familyDefinitionHash !== decoded.familyDefinitionHash) throw new TypeError("astra identity definition lineage mismatch");
  if (decoded.identity.instanceKey !== decoded.identity.target || decoded.identity.target !== decoded.witness.target) throw new TypeError("astra identity instance/target mismatch");
  const candidate = verifyWitness(decoded.witness, decoded.identity.source);
  const reads: AstraIdentityReadsV1 = {
    target: decoded.identity.target,
    tokens: decoded.identity.tokens,
    tokenCodeHashes: decoded.identity.tokenCodeHashes,
    weights: decoded.identity.weights,
    changesEnabled: decoded.identity.changesEnabled,
    totalPercents: decoded.identity.totalPercents,
    changeFee: decoded.identity.changeFee,
    inLendingMode: decoded.identity.inLendingMode,
    activeQuote: decoded.identity.activeQuote,
    source: decoded.identity.source,
  };
  const result = verifyAstraIdentity({ candidate, reads });
  if (result.status !== "verified" || result.identity.factsHash !== decoded.identity.factsHash || result.identity.actor !== decoded.identity.actor) throw new TypeError("astra identity memo facts hash mismatch");
  const memo = canonical(value);
  return deepFreeze({ memo, familyDefinitionHash: decoded.familyDefinitionHash, candidateSnapshotHash: decoded.candidateSnapshotHash, candidateEvidenceRoot: decoded.candidateEvidenceRoot, witness: decoded.witness, identity: result.identity });
}

function identityMemoJson(identity: AstraIdentityV1, witness: AstraCandidateWitnessV1, candidateSnapshotHash: Hash, candidateEvidenceRootValue: Hash): CanonicalJson {
  return canonical({
    kind: "astra-identity-memo",
    version: 1,
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    candidateSnapshotHash,
    candidateEvidenceRoot: candidateEvidenceRootValue,
    witness: witnessJson(witness),
    identity: {
      familyId: ASTRA_FAMILY_ID,
      familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
      actor: identity.actor,
      target: identity.target,
      tokens: identity.tokens,
      tokenCodeHashes: identity.tokenCodeHashes,
      weights: identity.weights.map(value => value.toString()),
      changesEnabled: identity.changesEnabled,
      totalPercents: identity.totalPercents.toString(),
      changeFee: identity.changeFee.toString(),
      inLendingMode: identity.inLendingMode?.toString() ?? null,
      activeQuote: identity.activeQuote.toString(),
      source: identity.source,
      factsHash: identity.factsHash,
      instanceKey: identity.instanceKey,
    },
  });
}

function identityObservation(value: unknown, path = "astra.identityOutput"): CanonicalJson {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "identityVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    familyInstanceKey: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => canonical(item),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const memo = identityMemo(decoded.identityMemo, `${path}.identityMemo`);
  const instance = compileAstraInstance(memo.identity);
  if (decoded.familyInstanceKey !== instance.instanceKey || decoded.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo.memo) || decoded.evidenceRoot !== memo.candidateEvidenceRoot || decoded.descriptorHash !== astraInstanceDescriptorHash(instance)) throw new TypeError("astra identity output lineage mismatch");
  return canonical(decoded);
}

function prepareIdentityIssueValue(input: FamilyStageGenericInvocationV1): AstraIdentityPayloadV1 {
  requireStage(input, "identity");
  if (input.identityMemo !== null || input.materializationOutput !== null) throw new TypeError("astra-identity-prior-output-mismatch");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "astra.identityInvocation.cutoff");
  const candidate = candidateRecord(input.candidate);
  const target = address(candidate.instanceNominationKey, "astra.identityInvocation.target");
  const evidence = primaryEvidence(candidate);
  if (evidence.kind === "recent-log") {
    const through = BigInt(cutoff.number);
    const from = through > 49n ? through - 49n : 0n;
    const observedAt = BigInt(evidence.blockNumber);
    if (observedAt < from || observedAt > through) throw new TypeError("astra recent evidence outside the exact 50-block window");
  }
  const expectedRequestId = requestId("identity", target, cutoff, null, candidate.candidateSubjectHash, candidate.candidateEvidenceRoot, evidence);
  return Object.freeze({ kind: "astra-identity-input", target, candidateKey: candidate.familyCandidateKey, candidateSnapshotHash: candidate.candidateSubjectHash, candidateEvidenceRoot: candidate.candidateEvidenceRoot, evidence, cutoff, requestId: expectedRequestId });
}

function assertCandidateMemoLineage(candidate: AstraCandidateRecordV1, memo: DecodedIdentityMemoV1, cutoff: CanonicalCutoffV1): void {
  const target = address(candidate.instanceNominationKey, "candidate.instanceNominationKey");
  if (candidate.familyCandidateKey !== familyCandidateKey(ASTRA_FAMILY_DEFINITION_HASH, target) || memo.candidateSnapshotHash !== candidate.candidateSubjectHash || memo.candidateEvidenceRoot !== candidate.candidateEvidenceRoot || memo.identity.target !== target || !sameCutoff(memo.identity.source, cutoff)) throw new TypeError("astra candidate/identity lineage mismatch");
  const witness = memo.witness;
  if (!candidate.evidence.some(item => item.kind === "source-plan" || (item.address.toLowerCase() === witness.target && item.txHash === witness.txHash && item.logIndex === witness.logIndex))) throw new TypeError("astra identity witness is not in candidate evidence");
}

function decodeMaterializationPayload(value: unknown, path = "astra.materializationPayload"): DecodedAstraMaterializationPayloadV1 {
  const decoded = decodeExactObject<AstraMaterializationPayloadV1>(value, {
    kind: (item, itemPath) => item === "astra-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    target: (item, itemPath) => address(item, itemPath),
    identity: (item, itemPath) => canonical(item),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const identity = identityMemo(decoded.identity, `${path}.identity`);
  if (identity.identity.target !== decoded.target || !sameCutoff(identity.identity.source, decoded.cutoff) || decoded.requestId !== requestId("materialization", decoded.target, decoded.cutoff, identity.identity.factsHash, identity.candidateSnapshotHash, identity.candidateEvidenceRoot, null)) throw new TypeError("astra materialization identity/cutoff mismatch");
  return deepFreeze({ ...decoded, identity });
}

function materializationWirePayload(value: unknown, path = "astra.materializationPayload"): AstraMaterializationPayloadV1 {
  const decoded = decodeExactObject<AstraMaterializationPayloadV1>(value, {
    kind: (item, itemPath) => item === "astra-materialization-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    target: (item, itemPath) => address(item, itemPath),
    identity: (item, itemPath) => canonical(item),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  decodeMaterializationPayload(decoded, path);
  return decoded;
}

function instanceMemoJson(instance: ReturnType<typeof compileAstraInstance>, identityMemoValue: CanonicalJson): CanonicalJson {
  return canonical({
    kind: "astra-instance-memo",
    version: 1,
    familyId: instance.familyId,
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    instanceKey: instance.instanceKey,
    target: instance.target,
    identityMemo: identityMemoValue,
    runtimeRequirements: instance.runtimeRequirements,
  });
}

function decodeInstanceMemo(value: unknown, path = "astra.instanceMemo"): { readonly memo: CanonicalJson; readonly instance: ReturnType<typeof compileAstraInstance>; readonly identityMemo: DecodedIdentityMemoV1 } {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "astra-instance-memo" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
    familyId: (item, itemPath) => item === ASTRA_FAMILY_ID ? item : (() => { throw new TypeError(`${itemPath} family mismatch`); })(),
    familyDefinitionHash: (item, itemPath) => item === ASTRA_FAMILY_DEFINITION_HASH ? item : (() => { throw new TypeError(`${itemPath} definition mismatch`); })(),
    instanceKey: (item, itemPath) => address(item, itemPath),
    target: (item, itemPath) => address(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    runtimeRequirements: (item, itemPath) => fieldArray(item, (entry, entryPath) => assertNonEmptyString(entry, entryPath), itemPath),
  }, path);
  const instance = compileAstraInstance(decoded.identityMemo.identity);
  if (instance.instanceKey !== decoded.instanceKey || instance.target !== decoded.target || encodeCanonicalJson(instanceMemoJson(instance, decoded.identityMemo.memo)) !== encodeCanonicalJson(canonical(value))) throw new TypeError("astra instance memo binding mismatch");
  return deepFreeze({ memo: canonical(value), instance, identityMemo: decoded.identityMemo });
}

function decodeMaterializationOutput(value: unknown, path = "astra.materializationOutput"): DecodedMaterializationOutputV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => item === "materializationVerified" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    instanceKey: (item, itemPath) => address(item, itemPath),
    instanceMemo: (item, itemPath) => canonical(item),
    instanceMemoHash: (item, itemPath) => assertHash(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const instance = decodeInstanceMemo(decoded.instanceMemo, `${path}.instanceMemo`);
  const identityMemoHash = hashDomain("aloha/identity-memo/v1", instance.identityMemo.memo);
  if (decoded.instanceKey !== instance.instance.instanceKey || decoded.identityMemoHash !== identityMemoHash || decoded.instanceMemoHash !== hashDomain("aloha/astra-multitoken/instance-memo/v1", instance.memo) || decoded.descriptorHash !== astraInstanceDescriptorHash(instance.instance) || decoded.candidateSnapshotHash !== instance.identityMemo.candidateSnapshotHash || decoded.evidenceRoot !== instance.identityMemo.candidateEvidenceRoot) throw new TypeError("astra materialization output lineage mismatch");
  return deepFreeze({ output: canonical(decoded), instanceMemo: instance.memo, instance: instance.instance, instanceKey: decoded.instanceKey, candidateSnapshotHash: decoded.candidateSnapshotHash, identityMemoHash: decoded.identityMemoHash, descriptorHash: decoded.descriptorHash, evidenceRoot: decoded.evidenceRoot });
}

function prepareMaterializationIssueValue(input: FamilyStageGenericInvocationV1): AstraMaterializationPayloadV1 {
  requireStage(input, "materialization");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("astra-materialization-prior-output-mismatch");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "astra.materializationInvocation.cutoff");
  const candidate = candidateRecord(input.candidate);
  const memo = identityMemo(input.identityMemo, "astra.materializationInvocation.identityMemo");
  assertCandidateMemoLineage(candidate, memo, cutoff);
  const target = address(candidate.instanceNominationKey, "astra.materializationInvocation.target");
  return Object.freeze({ kind: "astra-materialization-input" as const, target, identity: memo.memo, cutoff, requestId: requestId("materialization", target, cutoff, memo.identity.factsHash, memo.candidateSnapshotHash, memo.candidateEvidenceRoot, null) });
}

function decodeProjectionPayload(value: unknown, path = "astra.projectionPayload"): DecodedAstraProjectionPayloadV1 {
  const decoded = decodeExactObject<AstraProjectionPayloadV1>(value, {
    kind: (item, itemPath) => item === "astra-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    target: (item, itemPath) => address(item, itemPath),
    candidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => canonical(item),
    materialization: (item, itemPath) => canonical(item),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const identity = identityMemo(decoded.identity, `${path}.identity`);
  const materialization = decodeMaterializationOutput(decoded.materialization, `${path}.materialization`);
  if (decoded.target !== identity.identity.target || decoded.target !== materialization.instance.target || decoded.candidateKey !== familyCandidateKey(ASTRA_FAMILY_DEFINITION_HASH, decoded.target) || decoded.candidateSnapshotHash !== identity.candidateSnapshotHash || decoded.candidateSnapshotHash !== materialization.candidateSnapshotHash || decoded.candidateEvidenceRoot !== identity.candidateEvidenceRoot || decoded.candidateEvidenceRoot !== materialization.evidenceRoot || !sameCutoff(decoded.cutoff, identity.identity.source) || decoded.requestId !== requestId("projection", decoded.target, decoded.cutoff, identity.identity.factsHash, decoded.candidateSnapshotHash, decoded.candidateEvidenceRoot, null)) throw new TypeError("astra projection lineage mismatch");
  return deepFreeze({ ...decoded, identity, materialization });
}

function projectionWirePayload(value: unknown, path = "astra.projectionPayload"): AstraProjectionPayloadV1 {
  const decoded = decodeExactObject<AstraProjectionPayloadV1>(value, {
    kind: (item, itemPath) => item === "astra-projection-input" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
    target: (item, itemPath) => address(item, itemPath),
    candidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSnapshotHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => canonical(item),
    materialization: (item, itemPath) => canonical(item),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  decodeProjectionPayload(decoded, path);
  return decoded;
}

function prepareProjectionIssueValue(input: FamilyStageGenericInvocationV1): AstraProjectionPayloadV1 {
  requireStage(input, "projection");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("astra-projection-prior-output-missing");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "astra.projectionInvocation.cutoff");
  const candidate = candidateRecord(input.candidate);
  const identity = identityMemo(input.identityMemo, "astra.projectionInvocation.identityMemo");
  assertCandidateMemoLineage(candidate, identity, cutoff);
  const materialization = decodeMaterializationOutput(input.materializationOutput, "astra.projectionInvocation.materializationOutput");
  if (materialization.instanceKey !== identity.identity.instanceKey || materialization.identityMemoHash !== hashDomain("aloha/identity-memo/v1", identity.memo)) throw new TypeError("astra projection materialization mismatch");
  const target = address(candidate.instanceNominationKey, "astra.projectionInvocation.target");
  return Object.freeze({ kind: "astra-projection-input" as const, target, candidateKey: candidate.familyCandidateKey, candidateSnapshotHash: candidate.candidateSubjectHash, candidateEvidenceRoot: candidate.candidateEvidenceRoot, identity: identity.memo, materialization: materialization.output, cutoff, requestId: requestId("projection", target, cutoff, identity.identity.factsHash, candidate.candidateSubjectHash, candidate.candidateEvidenceRoot, null) });
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const result = canonical(value);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${path} must be an object`);
  return result;
}

function publicationOutput(value: unknown, path = "astra.projectionOutput"): CanonicalJson {
  const result = outputObject(value, path) as unknown as InstancePublicationV1;
  validateInstancePublication(result);
  const memo = identityMemo(result.identityMemo, `${path}.identityMemo`);
  if (result.familyId !== ASTRA_FAMILY_ID || result.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || result.familyCandidateKey !== familyCandidateKey(ASTRA_FAMILY_DEFINITION_HASH, memo.identity.instanceKey) || result.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo.memo) || result.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("astra projection publication identity mismatch");
  return canonical(result);
}

function projectionDraft(input: DecodedAstraProjectionPayloadV1, program: FrozenProgramEnvelopeV1): InstancePublicationV1 {
  const instance = input.materialization.instance;
  const routes = deriveAstraRoutes(instance);
  const identityMemoValue = input.identity.memo;
  const transitions = routes.map(route => {
    const inputPort = { ...erc20AssetPortBindingV1(input.cutoff.chainId, route.tokenIn), portRef: hashDomain("aloha/astra-multitoken/port/v1", { target: route.target, token: route.tokenIn }), ordinal: "0" };
    const outputPort = { ...erc20AssetPortBindingV1(input.cutoff.chainId, route.tokenOut), portRef: hashDomain("aloha/astra-multitoken/port/v1", { target: route.target, token: route.tokenOut }), ordinal: "0" };
    return { inputAssetPorts: [inputPort], outputAssetPorts: [outputPort], opaqueTransitionRef: hashDomain("aloha/astra-multitoken/transition/v1", route), constraintRefs: [route.bindingFingerprint], staticProjectionHash: hashDomain("aloha/astra-multitoken/static-transition/v1", route) };
  });
  return sealInstancePublication({
    familyId: ASTRA_FAMILY_ID,
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    familyCandidateKey: input.candidateKey,
    instanceKey: instance.instanceKey,
    cutoff: input.cutoff,
    identityMemo: identityMemoValue,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemoValue),
    descriptorHash: astraInstanceDescriptorHash(instance),
    staticProjectionMemoHash: hashDomain("aloha/astra-multitoken/static-projection/v1", routes),
    requestedArtifactDependencyRoot: hashDomain("aloha/astra-multitoken/requested-artifacts/v1", { target: instance.target, identityFactsHash: input.identity.identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/astra-multitoken/validity/v1", { source: program.source, identityFactsHash: input.identity.identity.factsHash }),
    transitions,
    evidenceRoot: input.candidateEvidenceRoot,
  });
}

function sameWitnessCandidate(witness: AstraCandidateWitnessV1, candidate: AstraCandidateV1): boolean {
  return candidate.target === witness.target
    && candidate.actor === witness.actor
    && candidate.tokenIn === witness.tokenIn
    && candidate.tokenOut === witness.tokenOut
    && candidate.amountIn === witness.amountIn
    && candidate.minAmountOut === witness.minAmountOut
    && candidate.observedAmountOut === witness.observedAmountOut
    && candidate.sourceKind === witness.sourceKind
    && candidate.instanceNominationKey === witness.target;
}

const blockTag = (value: string): string => `0x${BigInt(value).toString(16)}`;

function candidateFromRecentEvidence(
  payload: AstraIdentityPayloadV1,
  witness: AstraCandidateWitnessV1,
  rawBytes: Uint8Array,
): AstraCandidateV1 {
  if (witness.sourceKind !== "change-log") throw new TypeError("astra recent log evidence requires a log witness");
  const evidence = payload.evidence;
  if (evidence.kind !== "recent-log") throw new TypeError("astra recent evidence kind mismatch");
  const raw = decodeEvmLogObservationBytes(rawBytes, "astra.identity.recentEvidence");
  if (
    raw.blockNumber !== evidence.blockNumber
    || raw.blockHash !== evidence.blockHash
    || raw.transactionHash !== evidence.txHash
    || raw.logIndex !== evidence.logIndex
    || raw.address !== evidence.address
    || raw.topics[0] !== evidence.topic
  ) throw new TypeError("astra recent evidence locator mismatch");
  const candidate = decodeAstraCandidate({
    kind: "log",
    target: raw.address,
    source: payload.cutoff,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    topics: raw.topics,
    dataHex: raw.data,
  }, "astra-change-log");
  if (candidate === null || !sameWitnessCandidate(witness, candidate)) throw new TypeError("astra recent evidence witness mismatch");
  return candidate;
}

function candidateFromHistoryEvidence(
  payload: AstraIdentityPayloadV1,
  witness: AstraCandidateWitnessV1,
  rawBytes: Uint8Array,
): AstraCandidateV1 {
  if (witness.sourceKind !== "change-log" || witness.observedAmountOut === null) throw new TypeError("astra history evidence requires a log witness");
  const evidence = payload.evidence;
  if (evidence.kind !== "source-plan") throw new TypeError("astra history evidence kind mismatch");
  const observed = decodeFamilySourcePlanPhysicalObservation(rawBytes, "astra.identity.historyEvidence");
  if (
    observed.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH
    || observed.plan.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH
    || observed.plan.ownerRef !== evidence.ownerRef
    || observed.plan.sourcePlanRef !== evidence.sourcePlanRef
    || observed.plan.completeness !== "contiguous-history"
    || observed.plan.historyStartBlock !== "0"
    || !sameCutoff(observed.cutoff, payload.cutoff)
    || observed.requestSchemaHash !== ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    || observed.request.kind !== "family-source-plan-rpc"
    || observed.request.version !== 1
    || observed.request.method !== "eth_getLogs"
    || observed.request.target !== null
    || observed.request.manager !== null
    || observed.request.topic !== ASTRA_CHANGE_TOPIC
  ) throw new TypeError("astra history evidence binding mismatch");
  const lookback = decodeExactObject(observed.request.lookback, {
    from: (item, itemPath) => assertDecimalString(item, itemPath),
    through: (item, itemPath) => assertDecimalString(item, itemPath),
  }, "astra.identity.historyEvidence.lookback");
  const chunk = decodeExactObject(observed.request.chunk, {
    maxBlocks: (item, itemPath) => assertDecimalString(item, itemPath),
  }, "astra.identity.historyEvidence.chunk");
  if (chunk.maxBlocks !== "10000" || BigInt(lookback.from) > BigInt(lookback.through) || BigInt(lookback.through) > BigInt(payload.cutoff.number)) throw new TypeError("astra history evidence range mismatch");
  const expectedFilter = Object.freeze({ fromBlock: blockTag(lookback.from), toBlock: blockTag(lookback.through), topics: Object.freeze([ASTRA_CHANGE_TOPIC]) });
  if (encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([expectedFilter])) throw new TypeError("astra history evidence filter mismatch");
  const matches = decodeAstraHistoryEntries(observed.response, payload.cutoff, BigInt(lookback.from), BigInt(lookback.through)).filter(entry =>
    entry.target === witness.target
    && entry.actor === witness.actor
    && entry.tokenIn === witness.tokenIn
    && entry.tokenOut === witness.tokenOut
    && entry.amountIn === witness.amountIn.toString(10)
    && entry.observedAmountOut === witness.observedAmountOut?.toString(10)
    && entry.txHash === witness.txHash
    && entry.logIndex === witness.logIndex
  );
  if (matches.length !== 1) throw new TypeError("astra history evidence must contain exactly one witness log");
  const candidate = verifyWitness(witness, payload.cutoff);
  if (!sameWitnessCandidate(witness, candidate)) throw new TypeError("astra history evidence witness mismatch");
  return candidate;
}

function candidateFromIdentityEvidence(payload: AstraIdentityPayloadV1, witness: AstraCandidateWitnessV1, rawBytes: Uint8Array): AstraCandidateV1 {
  if (sha256Hex(rawBytes) !== payload.evidence.rawLocatorHash) throw new TypeError("astra identity raw locator mismatch");
  return payload.evidence.kind === "recent-log"
    ? candidateFromRecentEvidence(payload, witness, rawBytes)
    : candidateFromHistoryEvidence(payload, witness, rawBytes);
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(code) ? code : fallback;
}

function interpretIdentity(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeIdentityPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind === "reverted") return Object.freeze({ kind: "invalidProgram", code: "astra-identity-call-reverted" });
    const envelope = decodeIdentityFact(decodeFactData(fact, "astra.identityFact"));
    if (envelope.candidateSnapshotHash !== payload.candidateSnapshotHash || envelope.reads.target !== payload.target) throw new TypeError("astra identity fact payload mismatch");
    const source = basicSource({ chainId: fact.source.chainId, number: fact.source.blockNumber, hash: fact.source.blockHash, stateRoot: fact.source.stateRoot }, "astra.identityFact.source");
    const candidate = candidateFromIdentityEvidence(payload, envelope.candidate, hexBytes(envelope.candidateEvidenceBytesHex, "astra.identityFact.candidateEvidenceBytesHex"));
    if (candidate.target !== payload.target || candidate.instanceNominationKey !== payload.target || !sameSource(candidate.source, payload.cutoff)) throw new TypeError("astra identity candidate/cutoff mismatch");
    const reads: AstraIdentityReadsV1 = { ...envelope.reads, source };
    const result = verifyAstraIdentity({ candidate, reads });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const memo = identityMemoJson(result.identity, envelope.candidate, envelope.candidateSnapshotHash, payload.candidateEvidenceRoot);
    const decodedMemo = identityMemo(memo);
    const instance = compileAstraInstance(decodedMemo.identity);
    return Object.freeze({ kind: "verified", output: { kind: "identityVerified", familyInstanceKey: instance.instanceKey, identityMemo: memo, identityMemoHash: hashDomain("aloha/identity-memo/v1", memo), descriptorHash: astraInstanceDescriptorHash(instance), evidenceRoot: payload.candidateEvidenceRoot } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "astra-identity-invalid") });
  }
}

function materializationOutput(instance: ReturnType<typeof compileAstraInstance>, identity: DecodedIdentityMemoV1, evidenceRoot: Hash): CanonicalJson {
  const instanceMemo = instanceMemoJson(instance, identity.memo);
  return canonical({
    kind: "materializationVerified",
    instanceKey: instance.instanceKey,
    instanceMemo,
    instanceMemoHash: hashDomain("aloha/astra-multitoken/instance-memo/v1", instanceMemo),
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identity.memo),
    descriptorHash: astraInstanceDescriptorHash(instance),
    candidateSnapshotHash: identity.candidateSnapshotHash,
    evidenceRoot,
  });
}

function interpretMaterialization(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeMaterializationPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind === "reverted") return Object.freeze({ kind: "invalidProgram", code: "astra-materialization-call-reverted" });
    const data = decodeExactObject(decodeFactData(fact, "astra.materializationFact"), {
      kind: (item, itemPath) => item === "astra-materialization-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
      version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
      target: (item, itemPath) => address(item, itemPath),
      identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    }, "astra.materializationFact");
    if (data.target !== payload.target || data.identityFactsHash !== payload.identity.identity.factsHash) throw new TypeError("astra materialization fact mismatch");
    return Object.freeze({ kind: "verified", output: materializationOutput(compileAstraInstance(payload.identity.identity), payload.identity, payload.identity.candidateEvidenceRoot) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "astra-materialization-invalid") });
  }
}

function interpretProjection(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = decodeProjectionPayload(input.payload);
    const fact = boundFact(input.program, input.facts, payload.requestId);
    if (fact.kind === "reverted") return Object.freeze({ kind: "invalidProgram", code: "astra-projection-call-reverted" });
    const data = decodeExactObject(decodeFactData(fact, "astra.projectionFact"), {
      kind: (item, itemPath) => item === "astra-projection-facts" ? item : (() => { throw new TypeError(`${itemPath} kind mismatch`); })(),
      version: (item, itemPath) => item === 1 ? 1 as const : (() => { throw new TypeError(`${itemPath} version mismatch`); })(),
      target: (item, itemPath) => address(item, itemPath),
      instanceKey: (item, itemPath) => address(item, itemPath),
      identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    }, "astra.projectionFact");
    if (data.target !== payload.target || data.instanceKey !== payload.materialization.instanceKey || data.identityFactsHash !== payload.identity.identity.factsHash) throw new TypeError("astra projection fact mismatch");
    return Object.freeze({ kind: "verified", output: projectionDraft(payload, input.program) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "astra-projection-invalid") });
  }
}

function ownerOnlyPrepare(stage: "nomination" | "rehydration") {
  return (_input: FamilyStageGenericInvocationV1): never => { throw new TypeError(`astra-${stage}-owner-only`); };
}

function unsupportedPayloadCodec(stage: AstraCoreStage) {
  return Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES[stage]), decodeExact: (value: unknown) => canonical(value) });
}

const unsupportedOutputCodec = Object.freeze({ decodeExact: (value: unknown) => outputObject(value, "astra.ownerOnlyOutput") });
const unsupportedInterpret = (stage: string) => (_input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 => Object.freeze({ kind: "invalidProgram", code: `astra-${stage}-owner-only` });

function definitionBase(
  stage: AstraCoreStage,
  payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown },
  outputSchemaRef: Hash,
  outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson },
  prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"],
  interpret: FamilyStageDefinitionV1["interpret"],
): FamilyStageDefinitionV1 {
  return Object.freeze({
    stage,
    capabilityId: asCapabilityId(ASTRA_STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(STAGE_SCHEMA_HASHES[stage]),
    payloadCodec,
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/astra-multitoken/runtime-implementation/v1", { stage, module: "families/astra-multitoken/src/runtime/definitions.ts" }),
    outputCodecHash: hashDomain("aloha/astra-multitoken/runtime-output-codec/v1", stage),
    outputCodec: Object.freeze(outputCodec),
    prepareIssueValue,
    interpret,
  });
}

const identityPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.identity), decodeExact: (value: unknown) => decodeIdentityPayload(value) });
const materializationPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.materialization), decodeExact: (value: unknown) => materializationWirePayload(value) });
const projectionPayloadCodec = Object.freeze({ schemaRef: asSchemaRef(STAGE_SCHEMA_HASHES.projection), decodeExact: (value: unknown) => projectionWirePayload(value) });

export const ASTRA_NOMINATION_DEFINITION = definitionBase("nomination", unsupportedPayloadCodec("nomination"), hashDomain("aloha/astra-multitoken/runtime-output-schema/v1", "nomination"), unsupportedOutputCodec, ownerOnlyPrepare("nomination"), unsupportedInterpret("nomination"));
export const ASTRA_IDENTITY_DEFINITION = definitionBase("identity", identityPayloadCodec, hashDomain("aloha/astra-multitoken/runtime-output-schema/v1", "identity"), { decodeExact: identityObservation }, prepareIdentityIssueValue, interpretIdentity);
export const ASTRA_MATERIALIZATION_DEFINITION = definitionBase("materialization", materializationPayloadCodec, hashDomain("aloha/astra-multitoken/runtime-output-schema/v1", "materialization"), { decodeExact: value => outputObject(decodeMaterializationOutput(value).output, "astra.materializationOutput") }, prepareMaterializationIssueValue, interpretMaterialization);
export const ASTRA_PROJECTION_DEFINITION = definitionBase("projection", projectionPayloadCodec, hashDomain("aloha/astra-multitoken/runtime-output-schema/v1", "projection"), { decodeExact: value => publicationOutput(value) }, prepareProjectionIssueValue, interpretProjection);
export const ASTRA_REHYDRATION_DEFINITION = definitionBase("rehydration", unsupportedPayloadCodec("rehydration"), hashDomain("aloha/astra-multitoken/runtime-output-schema/v1", "rehydration"), unsupportedOutputCodec, ownerOnlyPrepare("rehydration"), unsupportedInterpret("rehydration"));

export const ASTRA_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  ASTRA_NOMINATION_DEFINITION,
  ASTRA_IDENTITY_DEFINITION,
  ASTRA_MATERIALIZATION_DEFINITION,
  ASTRA_PROJECTION_DEFINITION,
  ASTRA_REHYDRATION_DEFINITION,
]);

export function requireAstraStageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = ASTRA_STAGE_DEFINITIONS.find(value => value.stage === stage);
  if (definition === undefined) throw new Error(`astra stage definition missing: ${stage}`);
  return definition;
}

export function decodeAstraIdentityMemo(value: unknown): CanonicalJson {
  return identityMemo(value).memo;
}
