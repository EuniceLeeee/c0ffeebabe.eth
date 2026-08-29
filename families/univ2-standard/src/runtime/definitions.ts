import {
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
import type {
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
import type { FrozenProgramEnvelopeV1, ProgramSourceAnchorV1 } from "../../../../packages/request-program/src/index.ts";
import { validateInstancePublication, type InstancePublicationV1 } from "../../../../packages/catalog/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
  candidateEvidenceRoot,
  candidateSubjectHash,
  familyCandidateKey,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type CandidateEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import { nominateUniV2 } from "../stages/nomination.ts";
import { buildIdentityBaseReadRequests, buildIdentityPairReadRequests, uniV2IdentityDescriptorHash, verifyUniV2IdentityStage } from "../stages/identity.ts";
import { materializeUniV2 } from "../stages/materialization.ts";
import { projectUniV2 } from "../stages/projection.ts";
import { canonicalAddress } from "../kernel/codec.ts";
import {
  decodeIdentityMemo,
  decodeMaterializedState,
  decodeNominationCandidate,
  decodeSourceRequest,
  familyCandidateKeyForNomination,
  nominationKeyForPool,
  sourceRequestRoot,
  UNIV2_GET_RESERVES_SELECTOR,
  type UniV2IdentityMemoV1,
  type UniV2MaterializedStateV1,
  type UniV2NominationV1,
  type UniV2SourceRequestV1,
} from "../schema/index.ts";
import { sourceNominationSnapshotHash } from "../history-source-plan.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_VERSION,
  UNIV2_STANDARD_STAGE_IDS,
  UNIV2_STANDARD_STAGE_SCHEMA_HASHES,
  UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
  uniV2IdentityValidityDependencyRoot,
} from "../family-definition.ts";

const VERSION = asCapabilityVersion(UNIV2_STANDARD_FAMILY_VERSION);
const DEFAULT_FEE_BPS = "30";
const READ_PLANS = Object.freeze({
  identity: Object.freeze(["token0", "token1", "factory", "getPair-forward", "getPair-reverse"]),
  reserves: Object.freeze(["getReserves"]),
});

type IdentityPayloadV1 = {
  readonly kind: "family-identity-input";
  readonly nomination: UniV2NominationV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestIds: readonly Hash[];
  readonly evidenceRoot: Hash;
};

type RuntimeIdentityMemoV2 = {
  readonly kind: "univ2-identity-memo";
  readonly familyId: "univ2-standard";
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: UniV2IdentityMemoV1;
};

type MaterializationPayloadV1 = {
  readonly kind: "family-materialization-input";
  readonly identity: RuntimeIdentityMemoV2;
  readonly cutoff: CanonicalCutoffV1;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
};

type ProjectionPayloadV1 = {
  readonly kind: "family-projection-input";
  readonly nomination: UniV2NominationV1;
  readonly identity: RuntimeIdentityMemoV2;
  readonly materialization: {
    readonly kind: "univ2-materialization-output";
    readonly familyId: "univ2-standard";
    readonly familyDefinitionHash: Hash;
    readonly familyCandidateKey: Hash;
    readonly instanceNominationKey: string;
    readonly candidateSubjectHash: Hash;
    readonly candidateEvidenceRoot: Hash;
    readonly identityMemoHash: Hash;
    readonly cutoff: CanonicalCutoffV1;
    readonly pool: string;
    readonly identityFactsHash: Hash;
    readonly state: UniV2MaterializedStateV1;
    readonly sourceRequest: UniV2SourceRequestV1;
  };
  readonly cutoff: CanonicalCutoffV1;
  readonly feeBps: string;
  readonly readPlan: readonly string[];
  readonly requestId: Hash;
  readonly evidenceRoot: Hash;
};

type IdentityObservationV1 = {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: RuntimeIdentityMemoV2;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
};

type RehydrationPayloadV1 = {
  readonly kind: "univ2-verified-memo-reuse-input";
  readonly candidate: CandidateRecordV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly priorPublication: InstancePublicationV1;
  readonly identityMemo: RuntimeIdentityMemoV2;
  readonly readPlan: readonly ["reference"];
  readonly referenceHash: Hash;
  readonly requestId: Hash;
};

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function bytes(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) throw new TypeError(`canonical returned bytes required at ${path}`);
  return result;
}

function source(value: unknown, path: string): ExecutionFactSourceV1 {
  return decodeExactObject(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    blockNumber: (item, itemPath) => assertNonEmptyString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
    executorAuthorityRoot: (item, itemPath) => assertHash(item, itemPath),
    workerEpoch: (item, itemPath) => assertNonEmptyString(item, itemPath),
    executorSessionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
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

function candidateEvidence(value: unknown, path: string): CandidateEvidenceRefV1 { return decodeCandidateEvidenceRef(value, path); }

type UniV2CandidateRecordV1 = Omit<CandidateRecordV1, "evidence"> & { readonly evidence: readonly CandidateEvidenceRefV1[]; };

function candidateRecord(value: unknown, path = "univ2.candidate"): UniV2CandidateRecordV1 {
  const decoded = decodeExactObject<UniV2CandidateRecordV1>(value, {
    kind: (item, itemPath) => { if (item !== "aloha.candidate-record") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    version: (item, itemPath) => { if (item !== "2") throw new TypeError(`${itemPath} version mismatch`); return item; },
    familyId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    evidence: (item, itemPath) => fieldArray(item, (entry, entryPath) => candidateEvidence(entry, entryPath), itemPath),
  }, path);
  if (decoded.familyId !== "univ2-standard") throw new TypeError("univ2-candidate-family-mismatch");
  if (decoded.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ2-candidate-definition-mismatch");
  if (decoded.familyCandidateKey !== familyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey)) {
    throw new TypeError("univ2-candidate-key-mismatch");
  }
  if (decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey)) throw new TypeError("univ2-candidate-subject-mismatch");
  if (decoded.candidateEvidenceRoot !== candidateEvidenceRoot(decoded.evidence)) throw new TypeError("univ2-candidate-evidence-root-mismatch");
  if (decoded.evidence.length === 0) throw new TypeError("univ2-candidate-evidence-empty");
  const evidenceKeys = decoded.evidence.map(item => hashDomain("aloha/candidate-evidence-ref/v1", item));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new TypeError("univ2-candidate-evidence-duplicate");
  const sortedEvidenceKeys = [...evidenceKeys].sort();
  if (evidenceKeys.some((item, index) => item !== sortedEvidenceKeys[index])) throw new TypeError("univ2-candidate-evidence-order");
  return deepFreeze(decoded) as UniV2CandidateRecordV1;
}

/**
 * The generic candidate is the only lifecycle input.  Rebuild the Family
 * nomination from every opaque evidence ref; never trust a pool/key/snapshot
 * supplied by the central envelope without re-deriving it here.
 */
function reconstructNomination(candidate: UniV2CandidateRecordV1, cutoff: CanonicalCutoffV1): UniV2NominationV1 {
  let selectedEvidence: UniV2NominationV1["evidence"] | null = null;
  for (const evidence of candidate.evidence) {
    if (evidence.kind === "source-plan") {
      const pool = canonicalAddress(candidate.instanceNominationKey);
      sourceNominationSnapshotHash(pool, cutoff, evidence);
      if (selectedEvidence === null) selectedEvidence = { kind: "source-plan", cutoff, pool, source: evidence };
      continue;
    }
    const result = nominateUniV2({
      pool: evidence.address,
      evidence: {
        cutoff,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        emitter: evidence.address,
        topic0: evidence.topic,
        rawLocatorHash: evidence.rawLocatorHash,
      },
    });
    if (result.status !== "nominated") throw new TypeError(`univ2-candidate-evidence-${result.reasonCode}`);
    if (result.candidate.instanceNominationKey !== candidate.instanceNominationKey) throw new TypeError("univ2-candidate-nomination-key-mismatch");
    if (selectedEvidence === null) selectedEvidence = result.candidate.evidence;
  }
  if (selectedEvidence === null) throw new TypeError("univ2-candidate-evidence-missing");
  const pool = canonicalAddress(candidate.instanceNominationKey);
  return deepFreeze({ pool, instanceNominationKey: pool, candidateSnapshotHash: candidate.candidateSubjectHash, evidence: selectedEvidence });
}

function requireStage(input: FamilyStageGenericInvocationV1, expected: FamilyRuntimeStageV1): void {
  if (input.stage !== expected) throw new TypeError(`univ2-${expected}-stage-mismatch`);
}

function requireNoPriorOutputs(input: FamilyStageGenericInvocationV1): void {
  if (input.identityMemo !== null || input.materializationOutput !== null || input.reusePublication != null) throw new TypeError("univ2-unexpected-prior-stage-output");
}

function requireCutoffMemo(cutoff: CanonicalCutoffV1, memo: RuntimeIdentityMemoV2): void {
  if (!sameCutoff(cutoff, memo.identity.cutoff)) throw new TypeError("univ2-identity-cutoff-mismatch");
}

function requestIds(value: unknown, path: string, expectedLength: number): readonly Hash[] {
  const ids = fieldArray(value, (item, itemPath) => assertHash(item, itemPath), path);
  if (ids.length !== expectedLength || new Set(ids).size !== ids.length) throw new TypeError(`${path} must contain unique exact request ids`);
  return Object.freeze([...ids]);
}

function exactReadPlan(value: unknown, path: string, expected: readonly string[]): readonly string[] {
  const plan = fieldArray(value, (item, itemPath) => assertNonEmptyString(item, itemPath), path);
  if (plan.length !== expected.length || plan.some((item, index) => item !== expected[index])) throw new TypeError(`${path} does not match the UniV2 source contract`);
  return Object.freeze([...plan]);
}

function identityPayload(value: unknown, path = "univ2.identityStagePayload"): IdentityPayloadV1 {
  return decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "family-identity-input") throw new TypeError(`${itemPath} kind mismatch`); return "family-identity-input" as const; },
    nomination: (item, itemPath) => decodeNominationCandidate(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    readPlan: (item, itemPath) => exactReadPlan(item, itemPath, READ_PLANS.identity),
    requestIds: (item, itemPath) => requestIds(item, itemPath, READ_PLANS.identity.length),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function protocolIdentityMemo(value: unknown, path: string): UniV2IdentityMemoV1 {
  const decoded = decodeIdentityMemo(value, path);
  if (decoded.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ2 identity family definition mismatch");
  if (decoded.instanceKey !== decoded.facts.pool) throw new TypeError("univ2 identity instance key mismatch");
  if (decoded.instanceNominationKey !== nominationKeyForPool(decoded.facts.pool)) {
    throw new TypeError("univ2 identity nomination key mismatch");
  }
  if (decoded.factsHash !== hashDomain("aloha/univ2-standard/identity-facts/v1", decoded.facts)) {
    throw new TypeError("univ2 identity facts hash mismatch");
  }
  const requests = [
    ...buildIdentityBaseReadRequests(decoded.facts.pool, decoded.cutoff),
    ...buildIdentityPairReadRequests({
      cutoff: decoded.cutoff,
      factory: decoded.facts.factory,
      token0: decoded.facts.token0,
      token1: decoded.facts.token1,
    }),
  ];
  if (decoded.sourceRequestRoot !== sourceRequestRoot(requests)) {
    throw new TypeError("univ2 identity source request root mismatch");
  }
  return deepFreeze(decoded);
}

function identityMemo(value: unknown, path: string): RuntimeIdentityMemoV2 {
  const decoded = decodeExactObject<RuntimeIdentityMemoV2>(value, {
    kind: (item, itemPath) => { if (item !== "univ2-identity-memo") throw new TypeError(`${itemPath} kind mismatch`); return "univ2-identity-memo"; },
    familyId: (item, itemPath) => { if (item !== "univ2-standard") throw new TypeError(`${itemPath} family mismatch`); return "univ2-standard"; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identity: (item, itemPath) => protocolIdentityMemo(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH || decoded.familyCandidateKey !== familyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.instanceNominationKey !== decoded.identity.instanceNominationKey || decoded.candidateSubjectHash !== decoded.identity.candidateSnapshotHash) throw new TypeError("univ2 identity memo lineage mismatch");
  return deepFreeze(decoded);
}

function identityObservation(value: unknown, path = "univ2.identityObservation"): IdentityObservationV1 {
  const raw = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "identityVerified") throw new TypeError(`${itemPath} kind mismatch`); return "identityVerified" as const; },
    familyInstanceKey: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    identityMemo: (item, itemPath) => canonical(item),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  const memo = identityMemo(raw.identityMemo, `${path}.identityMemo`);
  if (raw.familyInstanceKey !== memo.identity.instanceKey) throw new TypeError(`${path}.familyInstanceKey mismatch`);
  if (raw.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo)) throw new TypeError(`${path}.identityMemoHash mismatch`);
  if (raw.descriptorHash !== uniV2IdentityDescriptorHash(memo.identity.facts)) throw new TypeError(`${path}.descriptorHash mismatch`);
  if (raw.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError(`${path}.evidenceRoot mismatch`);
  return deepFreeze({ ...raw, identityMemo: memo });
}

function materializationPayload(value: unknown, path = "univ2.materializationStagePayload"): MaterializationPayloadV1 {
  return decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "family-materialization-input") throw new TypeError(`${itemPath} kind mismatch`); return "family-materialization-input" as const; },
    identity: (item, itemPath) => identityMemo(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    readPlan: (item, itemPath) => exactReadPlan(item, itemPath, READ_PLANS.reserves),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function projectionMaterialization(value: unknown, path: string): ProjectionPayloadV1["materialization"] {
  const decoded = decodeExactObject<ProjectionPayloadV1["materialization"]>(value, {
    kind: (item, itemPath) => { if (item !== "univ2-materialization-output") throw new TypeError(`${itemPath} kind mismatch`); return "univ2-materialization-output"; },
    familyId: (item, itemPath) => { if (item !== "univ2-standard") throw new TypeError(`${itemPath} family mismatch`); return "univ2-standard"; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => assertNonEmptyString(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    candidateEvidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    pool: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    state: (item, itemPath) => decodeMaterializedState(item, itemPath),
    sourceRequest: (item, itemPath) => decodeSourceRequest(item, itemPath),
  }, path);
  if (decoded.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH || decoded.familyCandidateKey !== familyCandidateKey(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.candidateSubjectHash !== candidateSubjectHash(decoded.familyDefinitionHash, decoded.instanceNominationKey) || decoded.instanceNominationKey !== decoded.pool) throw new TypeError("univ2 materialization candidate lineage mismatch");
  return decoded;
}

function projectionPayload(value: unknown, path = "univ2.projectionStagePayload"): ProjectionPayloadV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "family-projection-input") throw new TypeError(`${itemPath} kind mismatch`); return "family-projection-input" as const; },
    nomination: (item, itemPath) => decodeNominationCandidate(item, itemPath),
    identity: (item, itemPath) => identityMemo(item, itemPath),
    materialization: (item, itemPath) => projectionMaterialization(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    feeBps: (item, itemPath) => {
      const result = assertNonEmptyString(item, itemPath);
      if (!/^(0|[1-9][0-9]*)$/.test(result) || BigInt(result) >= 10_000n) throw new TypeError(`${itemPath} must be a fee below 10000 bps`);
      return result;
    },
    readPlan: (item, itemPath) => exactReadPlan(item, itemPath, READ_PLANS.reserves),
    requestId: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (!sameCutoff(decoded.cutoff, decoded.identity.identity.cutoff) || !sameCutoff(decoded.cutoff, decoded.materialization.cutoff)) throw new TypeError("univ2 projection cutoff mismatch");
  if (decoded.identity.identity.facts.pool !== decoded.materialization.pool || decoded.identity.identity.facts.pool !== decoded.nomination.pool) throw new TypeError("univ2 projection pool mismatch");
  if (decoded.materialization.familyDefinitionHash !== decoded.identity.familyDefinitionHash || decoded.materialization.familyCandidateKey !== decoded.identity.familyCandidateKey || decoded.materialization.instanceNominationKey !== decoded.identity.instanceNominationKey || decoded.materialization.candidateSubjectHash !== decoded.identity.candidateSubjectHash || decoded.materialization.candidateEvidenceRoot !== decoded.identity.candidateEvidenceRoot || decoded.materialization.identityMemoHash !== hashDomain("aloha/identity-memo/v1", decoded.identity)) throw new TypeError("univ2 projection candidate lineage mismatch");
  if (decoded.evidenceRoot !== decoded.identity.candidateEvidenceRoot) throw new TypeError("univ2 projection evidence root mismatch");
  return decoded;
}

function decodeTransportFacts(value: readonly TransportFactV1[], path: string): readonly TransportFactV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must contain returned facts`);
  return Object.freeze(value.map((item, index) => {
    const raw = canonical(item);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${path}[${index}] is not a fact object`);
    const kind = (raw as { readonly kind?: unknown }).kind;
    if (kind === "returned" || kind === "reverted") {
      return decodeExactObject(raw, {
        kind: (field, fieldPath) => { if (field !== kind) throw new TypeError(`${fieldPath} kind mismatch`); return kind; },
        requestId: (field, fieldPath) => assertHash(field, fieldPath),
        requestFingerprint: (field, fieldPath) => assertHash(field, fieldPath),
        dataHex: (field, fieldPath) => bytes(field, fieldPath),
        source: (field, fieldPath) => source(field, fieldPath),
      }, `${path}[${index}]`) as unknown as TransportFactV1;
    }
    if (kind === "transportFailure") throw new TypeError(`${path}[${index}] transport failure must be classified before Family interpretation`);
    throw new TypeError(`${path}[${index}] unknown fact kind`);
  }));
}

function boundFacts(
  program: FrozenProgramEnvelopeV1,
  facts: readonly TransportFactV1[],
  ids: readonly Hash[],
): readonly TransportFactV1[] {
  const decoded = decodeTransportFacts(facts, "univ2.transportFacts");
  if (decoded.length !== ids.length || new Set(decoded.map(item => item.requestId)).size !== decoded.length) throw new TypeError("univ2 transport request partition mismatch");
  const byId = new Map(decoded.map(item => [item.requestId, item] as const));
  return Object.freeze(ids.map((id, index) => {
    const fact = byId.get(id);
    if (!fact) throw new TypeError(`univ2 missing request fact ${index}`);
    if (fact.requestFingerprint !== program.requestFingerprint || !sameSource(fact.source, program.source)) throw new TypeError("univ2 transport fact source mismatch");
    return fact;
  }));
}

function invalidCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(code) ? code : fallback;
}

function outputObject(value: unknown, path: string): CanonicalJson {
  const result = canonical(value);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${path} must be an object`);
  return result;
}

function identityOutput(value: unknown): CanonicalJson {
  return outputObject(identityObservation(value, "univ2.identityOutput"), "univ2.identityOutput");
}

function materializationOutput(value: unknown): CanonicalJson {
  const decoded = projectionMaterialization(value, "univ2.materializationOutput");
  if (!sameCutoff(decoded.cutoff, decoded.state.cutoff) || decoded.pool !== decoded.state.pool) throw new TypeError("univ2 materialization output binding mismatch");
  return outputObject(decoded, "univ2.materializationOutput");
}

function publicationOutput(value: unknown): CanonicalJson {
  // Publication validation lives in the generic catalog package; importing
  // it here is intentional, while no Graph/planner authority crosses in.
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError("univ2 projection output must be an object");
  const publication = decoded as unknown as InstancePublicationV1;
  validateInstancePublication(publication);
  const memo = identityMemo(publication.identityMemo, "univ2.projectionOutput.identityMemo");
  if (publication.familyId !== "univ2-standard" || publication.familyDefinitionHash !== memo.familyDefinitionHash || publication.familyCandidateKey !== memo.familyCandidateKey || publication.instanceKey !== memo.identity.instanceKey || publication.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo) || publication.descriptorHash !== uniV2IdentityDescriptorHash(memo.identity.facts) || publication.evidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("univ2 publication lineage mismatch");
  return outputObject(decoded, "univ2.projectionOutput");
}

function priorPublication(value: unknown, path: string): InstancePublicationV1 {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be an object`);
  const publication = decoded as unknown as InstancePublicationV1;
  validateInstancePublication(publication);
  return publication;
}

function rehydrationPayload(value: unknown, path = "univ2.rehydrationPayload"): RehydrationPayloadV1 {
  return decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "univ2-verified-memo-reuse-input") throw new TypeError(`${itemPath} kind mismatch`); return "univ2-verified-memo-reuse-input" as const; },
    candidate: (item, itemPath) => candidateRecord(item, itemPath),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    priorPublication: (item, itemPath) => priorPublication(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    readPlan: (item, itemPath) => exactReadPlan(item, itemPath, ["reference"]) as readonly ["reference"],
    referenceHash: (item, itemPath) => assertHash(item, itemPath),
    requestId: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function memoReuseProof(value: unknown, path = "univ2.rehydrationOutput"): CanonicalJson {
  return outputObject(decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "verifiedMemoReuseProof") throw new TypeError(`${itemPath} kind mismatch`); return "verifiedMemoReuseProof" as const; },
    familyId: (item, itemPath) => { if (item !== "univ2-standard") throw new TypeError(`${itemPath} family mismatch`); return "univ2-standard" as const; },
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    familyCandidateKey: (item, itemPath) => assertHash(item, itemPath),
    candidateSubjectHash: (item, itemPath) => assertHash(item, itemPath),
    instanceNominationKey: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    cutoff: (item, itemPath) => decodeCanonicalCutoff(item, itemPath),
    oldInstancePublicationHash: (item, itemPath) => assertHash(item, itemPath),
    requestedArtifactDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    descriptorHash: (item, itemPath) => assertHash(item, itemPath),
    validityDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
    candidateToCanonicalIdentityBindingProof: (item, itemPath) => assertHash(item, itemPath),
    identityMemo: (item, itemPath) => identityMemo(item, itemPath),
    identityMemoHash: (item, itemPath) => assertHash(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    proofHash: (item, itemPath) => assertHash(item, itemPath),
  }, path), path);
}

function identityRequestSlot(pool: string, cutoff: CanonicalCutoffV1, operation: "getPair-forward" | "getPair-reverse"): Hash {
  return hashDomain("aloha/univ2-standard/identity-request-slot/v1", {
    phase: "identity",
    pool,
    cutoff,
    operation,
  });
}

function prepareIdentityIssueValue(input: FamilyStageGenericInvocationV1): IdentityPayloadV1 {
  requireStage(input, "identity");
  requireNoPriorOutputs(input);
  const cutoff = decodeCanonicalCutoff(input.cutoff, "univ2.identityInvocation.cutoff");
  const candidate = candidateRecord(input.candidate, "univ2.identityInvocation.candidate");
  const nomination = reconstructNomination(candidate, cutoff);
  const base = buildIdentityBaseReadRequests(nomination.pool, cutoff);
  const requestIds = Object.freeze([
    ...base.map(item => item.requestId),
    identityRequestSlot(nomination.pool, cutoff, "getPair-forward"),
    identityRequestSlot(nomination.pool, cutoff, "getPair-reverse"),
  ]);
  return Object.freeze({
    kind: "family-identity-input",
    nomination,
    cutoff,
    readPlan: READ_PLANS.identity,
    requestIds,
    evidenceRoot: candidate.candidateEvidenceRoot,
  });
}

function assertCandidateMemoLineage(
  candidate: CandidateRecordV1,
  nomination: UniV2NominationV1,
  memo: RuntimeIdentityMemoV2,
  cutoff: CanonicalCutoffV1,
): void {
  requireCutoffMemo(cutoff, memo);
  if (candidate.candidateSubjectHash !== memo.candidateSubjectHash || candidate.candidateEvidenceRoot !== memo.candidateEvidenceRoot) throw new TypeError("univ2-candidate-identity-lineage-mismatch");
  if (candidate.familyCandidateKey !== memo.familyCandidateKey || candidate.instanceNominationKey !== memo.instanceNominationKey) throw new TypeError("univ2-candidate-identity-key-mismatch");
  if (nomination.pool !== memo.identity.instanceKey) throw new TypeError("univ2-candidate-identity-instance-mismatch");
  if (memo.familyDefinitionHash !== candidate.familyDefinitionHash) throw new TypeError("univ2-candidate-identity-definition-mismatch");
}

function prepareMaterializationIssueValue(input: FamilyStageGenericInvocationV1): MaterializationPayloadV1 {
  requireStage(input, "materialization");
  if (input.identityMemo === null || input.materializationOutput !== null) throw new TypeError("univ2-materialization-prior-output-mismatch");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "univ2.materializationInvocation.cutoff");
  const candidate = candidateRecord(input.candidate, "univ2.materializationInvocation.candidate");
  const nomination = reconstructNomination(candidate, cutoff);
  const memo = identityMemo(input.identityMemo, "univ2.materializationInvocation.identityMemo");
  assertCandidateMemoLineage(candidate, nomination, memo, cutoff);
  if (nomination.pool !== memo.identity.facts.pool) throw new TypeError("univ2-materialization-pool-mismatch");
  const requestId = hashDomain("aloha/univ2-standard/request-id/v1", {
    phase: "materialization",
    target: memo.identity.facts.pool,
    data: UNIV2_GET_RESERVES_SELECTOR,
    cutoff,
  });
  return Object.freeze({
    kind: "family-materialization-input",
    identity: memo,
    cutoff,
    readPlan: READ_PLANS.reserves,
    requestId,
  });
}

function prepareProjectionIssueValue(input: FamilyStageGenericInvocationV1): ProjectionPayloadV1 {
  requireStage(input, "projection");
  if (input.identityMemo === null || input.materializationOutput === null) throw new TypeError("univ2-projection-prior-output-missing");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "univ2.projectionInvocation.cutoff");
  const candidate = candidateRecord(input.candidate, "univ2.projectionInvocation.candidate");
  const nomination = reconstructNomination(candidate, cutoff);
  const memo = identityMemo(input.identityMemo, "univ2.projectionInvocation.identityMemo");
  assertCandidateMemoLineage(candidate, nomination, memo, cutoff);
  const materialization = projectionMaterialization(input.materializationOutput, "univ2.projectionInvocation.materializationOutput");
  if (!sameCutoff(materialization.cutoff, cutoff)) throw new TypeError("univ2-projection-materialization-cutoff-mismatch");
  if (materialization.pool !== memo.identity.facts.pool || materialization.pool !== nomination.pool) throw new TypeError("univ2-projection-materialization-pool-mismatch");
  if (materialization.identityFactsHash !== memo.identity.factsHash) throw new TypeError("univ2-projection-identity-facts-mismatch");
  if (materialization.candidateSubjectHash !== memo.candidateSubjectHash || materialization.candidateEvidenceRoot !== memo.candidateEvidenceRoot || materialization.identityMemoHash !== hashDomain("aloha/identity-memo/v1", memo)) throw new TypeError("univ2-projection-candidate-lineage-mismatch");
  const expectedRequestId = hashDomain("aloha/univ2-standard/request-id/v1", {
    phase: "materialization",
    target: materialization.pool,
    data: UNIV2_GET_RESERVES_SELECTOR,
    cutoff,
  });
  if (materialization.sourceRequest.requestId !== expectedRequestId) throw new TypeError("univ2-projection-source-request-mismatch");
  return Object.freeze({
    kind: "family-projection-input",
    nomination,
    identity: memo,
    materialization,
    cutoff,
    feeBps: DEFAULT_FEE_BPS,
    readPlan: READ_PLANS.reserves,
    requestId: expectedRequestId,
    evidenceRoot: candidate.candidateEvidenceRoot,
  });
}

function prepareRehydrationIssueValue(input: FamilyStageGenericInvocationV1): RehydrationPayloadV1 {
  requireStage(input, "rehydration");
  if (input.identityMemo !== null || input.materializationOutput !== null || input.reusePublication === null) throw new TypeError("univ2-rehydration-prior-publication-required");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "univ2.rehydrationInvocation.cutoff");
  const candidate = candidateRecord(input.candidate, "univ2.rehydrationInvocation.candidate");
  const publication = priorPublication(input.reusePublication, "univ2.rehydrationInvocation.reusePublication");
  const priorMemo = identityMemo(publication.identityMemo, "univ2.rehydrationInvocation.reusePublication.identityMemo");
  if (
    publication.familyId !== "univ2-standard"
    || publication.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    || publication.instanceKey !== candidate.instanceNominationKey
    || publication.requestedArtifactDependencyRoot !== UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT
    || publication.descriptorHash !== uniV2IdentityDescriptorHash(priorMemo.identity.facts)
    || publication.validityDependencyRoot !== uniV2IdentityValidityDependencyRoot(priorMemo.identity.factsHash)
  ) throw new TypeError("univ2-memo-reuse-dependency-or-identity-mismatch");
  const identity = deepFreeze({ ...priorMemo.identity, cutoff, candidateSnapshotHash: candidate.candidateSubjectHash });
  const currentIdentityMemo = deepFreeze({
    kind: "univ2-identity-memo" as const,
    familyId: "univ2-standard" as const,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceNominationKey: candidate.instanceNominationKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    candidateEvidenceRoot: candidate.candidateEvidenceRoot,
    identity,
  });
  const referenceHash = hashDomain("aloha/univ2-standard/verified-memo-reuse-reference/v1", {
    oldInstancePublicationHash: publication.instancePublicationHash,
    familyCandidateKey: candidate.familyCandidateKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    cutoff,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
    descriptorHash: publication.descriptorHash,
    validityDependencyRoot: publication.validityDependencyRoot,
  });
  return deepFreeze({
    kind: "univ2-verified-memo-reuse-input",
    candidate,
    cutoff,
    priorPublication: publication,
    identityMemo: currentIdentityMemo,
    readPlan: ["reference"],
    referenceHash,
    requestId: hashDomain("aloha/univ2-standard/request-id/v1", { phase: "rehydration", target: candidate.instanceNominationKey, cutoff, referenceHash }),
  });
}

function ownerOnlyPrepare(stage: "nomination" | "rehydration") {
  return (_input: FamilyStageGenericInvocationV1): never => {
    throw new TypeError(`univ2-${stage}-owner-only`);
  };
}

function definitionBase(stage: FamilyRuntimeStageV1, payloadCodec: { readonly schemaRef: SchemaRef; readonly decodeExact: (value: unknown) => unknown }, outputSchemaRef: Hash, outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson }, prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"], interpret: FamilyStageDefinitionV1["interpret"]): FamilyStageDefinitionV1 {
  return Object.freeze({
    stage,
    capabilityId: asCapabilityId(UNIV2_STANDARD_STAGE_IDS[stage]),
    version: VERSION,
    schemaHash: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES[stage]),
    payloadCodec,
    dependencyIds: Object.freeze([]),
    outputSchemaRef,
    implementationClosureHash: hashDomain("aloha/univ2-standard/runtime-implementation/v1", { stage, module: `families/univ2-standard/src/runtime/definitions.ts` }),
    outputCodecHash: hashDomain("aloha/univ2-standard/runtime-output-codec/v1", stage),
    outputCodec,
    prepareIssueValue,
    interpret,
  });
}

const identityPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES.identity),
  decodeExact: (value: unknown) => identityPayload(value),
});
const materializationPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES.materialization),
  decodeExact: (value: unknown) => materializationPayload(value),
});
const projectionPayloadCodec = Object.freeze({
  schemaRef: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES.projection),
  decodeExact: (value: unknown) => projectionPayload(value),
});

function interpretIdentity(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = identityPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, payload.requestIds);
    const result = verifyUniV2IdentityStage({
      nomination: payload.nomination,
      reads: {
        cutoff: payload.cutoff,
        pool: payload.nomination.pool,
        token0ReturnHex: facts[0]!.kind === "returned" ? facts[0]!.dataHex : "0x",
        token1ReturnHex: facts[1]!.kind === "returned" ? facts[1]!.dataHex : "0x",
        factoryReturnHex: facts[2]!.kind === "returned" ? facts[2]!.dataHex : "0x",
        forwardPairReturnHex: facts[3]!.kind === "returned" ? facts[3]!.dataHex : "0x",
        reversePairReturnHex: facts[4]!.kind === "returned" ? facts[4]!.dataHex : "0x",
      },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    const identityMemo: RuntimeIdentityMemoV2 = deepFreeze({
      kind: "univ2-identity-memo",
      familyId: "univ2-standard",
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      familyCandidateKey: familyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, result.identity.instanceNominationKey),
      instanceNominationKey: result.identity.instanceNominationKey,
      candidateSubjectHash: result.identity.candidateSnapshotHash,
      candidateEvidenceRoot: payload.evidenceRoot,
      identity: result.identity,
    });
    return Object.freeze({
      kind: "verified",
      output: Object.freeze({
        kind: "identityVerified" as const,
        familyInstanceKey: result.identity.instanceKey,
        identityMemo,
        identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
        descriptorHash: uniV2IdentityDescriptorHash(result.identity.facts),
        evidenceRoot: payload.evidenceRoot,
      }),
    });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "univ2-identity-invalid") });
  }
}

function interpretMaterialization(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = materializationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = facts[0]!;
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "univ2-reserves-return-required" });
    const result = materializeUniV2({
      identity: payload.identity.identity,
      read: { cutoff: payload.cutoff, pool: payload.identity.identity.facts.pool, reservesReturnHex: fact.dataHex },
    });
    if (result.status === "chain-proven-rejected") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: result.reasonCode });
    return Object.freeze({ kind: "verified", output: {
      kind: "univ2-materialization-output",
      familyId: "univ2-standard",
      familyDefinitionHash: payload.identity.familyDefinitionHash,
      familyCandidateKey: payload.identity.familyCandidateKey,
      instanceNominationKey: payload.identity.instanceNominationKey,
      candidateSubjectHash: payload.identity.candidateSubjectHash,
      candidateEvidenceRoot: payload.identity.candidateEvidenceRoot,
      identityMemoHash: hashDomain("aloha/identity-memo/v1", payload.identity),
      ...result.materialization,
    } });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "univ2-materialization-invalid") });
  }
}

function interpretProjection(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = projectionPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = facts[0]!;
    if (fact.kind !== "returned") return Object.freeze({ kind: "invalidProgram", code: "univ2-projection-reserves-return-required" });
    const materialized = materializeUniV2({
      identity: payload.identity.identity,
      read: { cutoff: payload.cutoff, pool: payload.identity.identity.facts.pool, reservesReturnHex: fact.dataHex },
    });
    if (materialized.status !== "verified") return Object.freeze({ kind: "chainProvenRejected", factSet: input.factSet, decisionCode: materialized.reasonCode });
    if (materialized.materialization.state.stateHash !== payload.materialization.state.stateHash) return Object.freeze({ kind: "invalidProgram", code: "univ2-projection-state-lineage-mismatch" });
    const result = projectUniV2({
      nomination: payload.nomination,
      identity: payload.identity.identity,
      materialization: materialized.materialization,
      feeBps: BigInt(payload.feeBps),
      evidenceRoot: payload.evidenceRoot,
      publicationIdentityMemo: canonical(payload.identity),
    });
    if (result.status !== "verified") return Object.freeze({ kind: "invalidProgram", code: result.reasonCode });
    return Object.freeze({ kind: "verified", output: result.projection.publication });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "univ2-projection-invalid") });
  }
}

function interpretRehydration(input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
  try {
    const payload = rehydrationPayload(input.payload);
    const facts = boundFacts(input.program, input.facts, [payload.requestId]);
    const fact = facts[0]!;
    if (fact.kind !== "returned" || fact.dataHex !== `0x${payload.referenceHash.slice(2)}`) {
      return Object.freeze({ kind: "invalidProgram", code: "univ2-rehydration-reference-mismatch" });
    }
    const identityMemoHash = hashDomain("aloha/identity-memo/v1", payload.identityMemo);
    const candidateToCanonicalIdentityBindingProof = hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
      familyId: "univ2-standard",
      familyDefinitionHash: payload.candidate.familyDefinitionHash,
      familyCandidateKey: payload.candidate.familyCandidateKey,
      candidateSubjectHash: payload.candidate.candidateSubjectHash,
      instanceNominationKey: payload.candidate.instanceNominationKey,
      cutoff: payload.cutoff,
      oldInstancePublicationHash: payload.priorPublication.instancePublicationHash,
      identityMemoHash,
      descriptorHash: payload.priorPublication.descriptorHash,
    });
    const proofPayload = {
      kind: "verifiedMemoReuseProof" as const,
      familyId: "univ2-standard" as const,
      familyDefinitionHash: payload.candidate.familyDefinitionHash,
      familyCandidateKey: payload.candidate.familyCandidateKey,
      candidateSubjectHash: payload.candidate.candidateSubjectHash,
      instanceNominationKey: payload.candidate.instanceNominationKey,
      cutoff: payload.cutoff,
      oldInstancePublicationHash: payload.priorPublication.instancePublicationHash,
      requestedArtifactDependencyRoot: payload.priorPublication.requestedArtifactDependencyRoot,
      descriptorHash: payload.priorPublication.descriptorHash,
      validityDependencyRoot: payload.priorPublication.validityDependencyRoot,
      candidateToCanonicalIdentityBindingProof,
      identityMemo: payload.identityMemo,
      identityMemoHash,
      evidenceRoot: payload.candidate.candidateEvidenceRoot,
    };
    return Object.freeze({ kind: "verified", output: Object.freeze({ ...proofPayload, proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", proofPayload) }) });
  } catch (error) {
    return Object.freeze({ kind: "invalidProgram", code: invalidCode(error, "univ2-rehydration-invalid") });
  }
}

function unsupportedPayloadCodec(stage: "nomination" | "rehydration") {
  return Object.freeze({
    schemaRef: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES[stage]),
    decodeExact: (value: unknown) => canonical(value),
  });
}
const unsupportedOutputCodec = Object.freeze({ decodeExact: (value: unknown) => outputObject(value, "univ2.unsupportedOutput") });
const unsupportedInterpret = (stage: string) => (_input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 => Object.freeze({ kind: "invalidProgram", code: `univ2-${stage}-owner-only` });

export const UNIV2_STANDARD_NOMINATION_DEFINITION = definitionBase(
  "nomination",
  unsupportedPayloadCodec("nomination"),
  hashDomain("aloha/univ2-standard/runtime-output-schema/v1", "nomination"),
  unsupportedOutputCodec,
  ownerOnlyPrepare("nomination"),
  unsupportedInterpret("nomination"),
);

export const UNIV2_STANDARD_IDENTITY_DEFINITION = definitionBase(
  "identity",
  identityPayloadCodec,
  hashDomain("aloha/univ2-standard/runtime-output-schema/v1", "identity"),
  { decodeExact: identityOutput },
  prepareIdentityIssueValue,
  interpretIdentity,
);

export const UNIV2_STANDARD_MATERIALIZATION_DEFINITION = definitionBase(
  "materialization",
  materializationPayloadCodec,
  hashDomain("aloha/univ2-standard/runtime-output-schema/v1", "materialization"),
  { decodeExact: materializationOutput },
  prepareMaterializationIssueValue,
  interpretMaterialization,
);

export const UNIV2_STANDARD_PROJECTION_DEFINITION = definitionBase(
  "projection",
  projectionPayloadCodec,
  hashDomain("aloha/univ2-standard/runtime-output-schema/v1", "projection"),
  { decodeExact: publicationOutput },
  prepareProjectionIssueValue,
  interpretProjection,
);

export const UNIV2_STANDARD_REHYDRATION_DEFINITION = definitionBase(
  "rehydration",
  { schemaRef: asSchemaRef(UNIV2_STANDARD_STAGE_SCHEMA_HASHES.rehydration), decodeExact: (value: unknown) => rehydrationPayload(value) },
  hashDomain("aloha/univ2-standard/runtime-output-schema/v1", "rehydration"),
  { decodeExact: memoReuseProof },
  prepareRehydrationIssueValue,
  interpretRehydration,
);

export const UNIV2_STANDARD_STAGE_DEFINITIONS: readonly FamilyStageDefinitionV1[] = Object.freeze([
  UNIV2_STANDARD_NOMINATION_DEFINITION,
  UNIV2_STANDARD_IDENTITY_DEFINITION,
  UNIV2_STANDARD_MATERIALIZATION_DEFINITION,
  UNIV2_STANDARD_PROJECTION_DEFINITION,
  UNIV2_STANDARD_REHYDRATION_DEFINITION,
]);

export function requireUniV2StageDefinition(stage: FamilyRuntimeStageV1): FamilyStageDefinitionV1 {
  const definition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(value => value.stage === stage);
  if (!definition) throw new Error(`univ2 stage definition missing: ${stage}`);
  return definition;
}
