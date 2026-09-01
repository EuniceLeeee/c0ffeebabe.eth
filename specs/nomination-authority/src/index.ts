import { types as nodeTypes } from "node:util";
import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  fieldArray,
  hashCanonicalPartition,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  type CandidateEvidenceRefV1,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../candidate-partition-authority/src/index.ts";

const VERSION = 1 as const;

export const NOMINATION_AUTHORITY_DOMAINS = deepFreeze({
  evidenceRef: "aloha/candidate-evidence-ref/v1",
  claim: "aloha/nomination-claim/v1",
  rawClaims: "aloha/nomination-raw-claims/v1",
  uniqueNomination: "aloha/unique-nomination/v1",
  uniqueNominations: "aloha/unique-nominations/v1",
  familyCandidates: "aloha/nomination-family-candidates/v1",
  familySet: "aloha/nomination-family-set/v1",
  sourcePlanSet: "aloha/nomination-source-plan-set/v1",
  receipt: "aloha/qualified-source-plan-nomination-receipt/v1",
  receiptSet: "aloha/qualified-source-plan-nomination-receipt-set/v1",
  closure: "aloha/nomination-closure/v1",
});

export interface CompleteSourceResultDenominatorV1 {
  readonly kind: "complete-source-result";
  readonly persistedExecutionRoot: Hash;
  readonly resultPartitionRoot: Hash;
}

export interface RecentObservationDenominatorV1 {
  readonly kind: "recent-observation";
  readonly recentObservationRoot: Hash;
  readonly relevantEvidenceRefHashes: readonly Hash[];
  readonly relevantEvidenceRoot: Hash;
  readonly relevantEvidenceCount: string;
}

export interface PointLookupDenominatorV1 {
  readonly kind: "point-lookup";
  readonly persistedExecutionRoot: Hash;
  readonly resultPartitionRoot: Hash;
}

/** A source-backed positive denominator over one exact rolling range. It may
 * nominate observed candidates but never proves that an unobserved instance
 * does not exist. */
export interface RollingObservationDenominatorV1 {
  readonly kind: "rolling-observation";
  readonly persistedExecutionRoot: Hash;
  readonly resultPartitionRoot: Hash;
}

export type NominationDenominatorV1 =
  | CompleteSourceResultDenominatorV1
  | RecentObservationDenominatorV1
  | PointLookupDenominatorV1
  | RollingObservationDenominatorV1;

export interface PlanQualifiedNominationClaimV1 {
  readonly sourcePlanIdentity: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly evidenceRefHash: Hash;
  readonly claimRoot: Hash;
}

export interface UniqueNominationV1 {
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly evidenceRefHashes: readonly Hash[];
  readonly nominationRoot: Hash;
}

export interface QualifiedSourcePlanNominationReceiptV1 {
  readonly kind: "aloha.qualified-source-plan-nomination-receipt";
  readonly version: typeof VERSION;
  readonly cutoff: CanonicalCutoffV1;
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanIdentity: Hash;
  readonly sourcePlanLeafDigest: Hash;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
  readonly qualificationRoot: Hash;
  readonly denominator: NominationDenominatorV1;
  readonly claims: readonly PlanQualifiedNominationClaimV1[];
  readonly rawClaimRoot: Hash;
  readonly rawClaimCount: string;
  readonly uniqueNominations: readonly UniqueNominationV1[];
  readonly uniqueNominationRoot: Hash;
  readonly uniqueNominationCount: string;
  readonly receiptRoot: Hash;
}

export interface FamilyNominationPartitionV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKeys: readonly Hash[];
  readonly candidateSetRoot: Hash;
  readonly candidateCount: string;
}

export interface NominationClosureV1 {
  readonly kind: "aloha.nomination-closure";
  readonly version: typeof VERSION;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRoot: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly sourcePlanIdentities: readonly Hash[];
  readonly sourcePlanSetRoot: Hash;
  readonly sourcePlanCount: string;
  readonly receipts: readonly QualifiedSourcePlanNominationReceiptV1[];
  readonly receiptSetRoot: Hash;
  readonly receiptCount: string;
  readonly rawClaimRoot: Hash;
  readonly rawClaimCount: string;
  readonly uniqueNominationRoot: Hash;
  readonly uniqueNominationCount: string;
  readonly families: readonly FamilyNominationPartitionV1[];
  readonly familySetRoot: Hash;
  readonly familyCount: string;
  readonly candidatePartitionRoot: Hash;
  readonly candidateCount: string;
  readonly root: Hash;
}

export interface NominationClaimChunkRefV1 {
  readonly contentSha256: Hash;
}

export interface NominationClaimChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-claim-chunk-v1";
  readonly sourcePlanIdentity: Hash;
  readonly claims: readonly PlanQualifiedNominationClaimV1[];
  readonly relevantEvidenceRefHashes: readonly Hash[];
  readonly nextClaimChunkRef: NominationClaimChunkRefV1 | null;
}

export interface EncodedNominationClosureV1 {
  readonly manifestBytes: Uint8Array;
  readonly chunks: readonly Readonly<{
    readonly ref: NominationClaimChunkRefV1;
    readonly bytes: Uint8Array;
  }>[];
}

const NOMINATION_CLAIM_CHUNK_MAX_ITEMS = 128;
const NOMINATION_WIRE_MAX_BYTES = 500_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Large materialized partitions are not themselves wire values. Their
 * durable representation is the bounded linked-chunk codec below. */
function materializedArray<T>(
  value: unknown,
  item: (value: unknown, path: string) => T,
  path: string,
): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError(`expected array at ${path}`);
  if (nodeTypes.isProxy(value)) throw new TypeError(`Proxy arrays are not accepted at ${path}`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol"
      || (key !== "length" && (!/^\d+$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError(`array has extra property at ${path}.${String(key)}`);
    }
  }
  const output: T[] = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`sparse or accessor array item at ${itemPath}`);
    }
    output[index] = item(descriptor.value, itemPath);
  }
  return deepFreeze(output);
}

function expectedFamilyCandidateKey(familyDefinitionHash: Hash, instanceNominationKey: string): Hash {
  return hashDomain("aloha/family-candidate/v2", { familyDefinitionHash, instanceNominationKey });
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeExactObject(value, {
    chainId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    number: (field, fieldPath) => assertDecimalString(field, fieldPath),
    hash: (field, fieldPath) => assertHash(field, fieldPath),
    stateRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function exactSortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  const hashes = fieldArray(value, (field, fieldPath) => assertHash(field, fieldPath), path);
  if (new Set(hashes).size !== hashes.length) throw new TypeError(`${path} contains duplicates`);
  const sorted = [...hashes].sort(compareText);
  if (hashes.some((hash, index) => hash !== sorted[index])) throw new TypeError(`${path} is not canonical order`);
  return hashes;
}

function materializedSortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  const hashes = materializedArray(value, (field, fieldPath) => assertHash(field, fieldPath), path);
  if (new Set(hashes).size !== hashes.length) throw new TypeError(`${path} contains duplicates`);
  const sorted = [...hashes].sort(compareText);
  if (hashes.some((hash, index) => hash !== sorted[index])) throw new TypeError(`${path} is not canonical order`);
  return hashes;
}

function denominator(value: unknown, path: string): NominationDenominatorV1 {
  const kind = readOwnEnumerableDataProperty(value, "kind", path);
  if (kind === "complete-source-result" || kind === "point-lookup" || kind === "rolling-observation") {
    const decoded = decodeExactObject(value, {
      kind: (field, fieldPath) => {
        if (field !== kind) throw new TypeError(`${fieldPath} is invalid`);
        return kind;
      },
      persistedExecutionRoot: (field, fieldPath) => assertHash(field, fieldPath),
      resultPartitionRoot: (field, fieldPath) => assertHash(field, fieldPath),
    }, path);
    return decoded;
  }
  if (kind === "recent-observation") {
    const decoded = decodeExactObject(value, {
      kind: (field, fieldPath) => {
        if (field !== "recent-observation") throw new TypeError(`${fieldPath} is invalid`);
        return "recent-observation" as const;
      },
      recentObservationRoot: (field, fieldPath) => assertHash(field, fieldPath),
      relevantEvidenceRefHashes: exactSortedUniqueHashes,
      relevantEvidenceRoot: (field, fieldPath) => assertHash(field, fieldPath),
      relevantEvidenceCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    }, path);
    if (decoded.relevantEvidenceCount !== String(decoded.relevantEvidenceRefHashes.length)) {
      throw new TypeError(`${path}.relevantEvidenceCount mismatch`);
    }
    const root = hashCanonicalPartition(
      "aloha/relevant-nomination-evidence/v1",
      decoded.relevantEvidenceRefHashes,
    );
    if (decoded.relevantEvidenceRoot !== root) throw new TypeError(`${path}.relevantEvidenceRoot mismatch`);
    return decoded;
  }
  throw new TypeError(`${path}.kind is invalid`);
}

export function nominationEvidenceRefHash(value: CandidateEvidenceRefV1): Hash {
  return hashDomain(NOMINATION_AUTHORITY_DOMAINS.evidenceRef, value);
}

function claimPayload(value: Omit<PlanQualifiedNominationClaimV1, "claimRoot">) {
  return {
    sourcePlanIdentity: value.sourcePlanIdentity,
    familyCandidateKey: value.familyCandidateKey,
    instanceNominationKey: value.instanceNominationKey,
    evidenceRefHash: value.evidenceRefHash,
  };
}

export function nominationClaimRoot(
  value: Omit<PlanQualifiedNominationClaimV1, "claimRoot">,
): Hash {
  return hashDomain(NOMINATION_AUTHORITY_DOMAINS.claim, claimPayload(value));
}

function claim(value: unknown, path: string): PlanQualifiedNominationClaimV1 {
  const decoded = decodeExactObject(value, {
    sourcePlanIdentity: (field, fieldPath) => assertHash(field, fieldPath),
    familyCandidateKey: (field, fieldPath) => assertHash(field, fieldPath),
    instanceNominationKey: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    evidenceRefHash: (field, fieldPath) => assertHash(field, fieldPath),
    claimRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
  if (decoded.claimRoot !== nominationClaimRoot(decoded)) throw new TypeError(`${path}.claimRoot mismatch`);
  return decoded;
}

function uniqueNominationPayload(value: Omit<UniqueNominationV1, "nominationRoot">) {
  return {
    familyCandidateKey: value.familyCandidateKey,
    instanceNominationKey: value.instanceNominationKey,
    evidenceRefHashes: value.evidenceRefHashes,
  };
}

export function uniqueNominationRoot(value: Omit<UniqueNominationV1, "nominationRoot">): Hash {
  return hashDomain(NOMINATION_AUTHORITY_DOMAINS.uniqueNomination, uniqueNominationPayload(value));
}

function uniqueNomination(value: unknown, path: string): UniqueNominationV1 {
  const decoded = decodeExactObject(value, {
    familyCandidateKey: (field, fieldPath) => assertHash(field, fieldPath),
    instanceNominationKey: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    evidenceRefHashes: exactSortedUniqueHashes,
    nominationRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
  if (decoded.evidenceRefHashes.length === 0) throw new TypeError(`${path}.evidenceRefHashes is empty`);
  if (decoded.nominationRoot !== uniqueNominationRoot(decoded)) throw new TypeError(`${path}.nominationRoot mismatch`);
  return decoded;
}

function receiptPayload(value: Omit<QualifiedSourcePlanNominationReceiptV1, "receiptRoot">) {
  const { claims: _claims, uniqueNominations: _uniqueNominations, ...commitment } = value;
  return commitment;
}

export function qualifiedSourcePlanNominationReceiptRoot(
  value: Omit<QualifiedSourcePlanNominationReceiptV1, "receiptRoot">,
): Hash {
  return hashDomain(NOMINATION_AUTHORITY_DOMAINS.receipt, receiptPayload(value));
}

export function decodeQualifiedSourcePlanNominationReceiptV1(
  value: unknown,
  path = "qualifiedSourcePlanNominationReceipt",
): QualifiedSourcePlanNominationReceiptV1 {
  const decoded: QualifiedSourcePlanNominationReceiptV1 = decodeExactObject(value, {
    kind: (field, fieldPath) => {
      if (field !== "aloha.qualified-source-plan-nomination-receipt") throw new TypeError(`${fieldPath} is invalid`);
      return "aloha.qualified-source-plan-nomination-receipt" as const;
    },
    version: (field, fieldPath) => {
      if (field !== VERSION) throw new TypeError(`${fieldPath} is invalid`);
      return VERSION;
    },
    cutoff,
    familyId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    familyDefinitionHash: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanIdentity: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanLeafDigest: (field, fieldPath) => assertHash(field, fieldPath),
    nominationProgramRoot: (field, fieldPath) => assertHash(field, fieldPath),
    nominationProgramProposalLeafDigest: (field, fieldPath) => assertHash(field, fieldPath),
    qualificationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    denominator,
    claims: (field, fieldPath) => materializedArray(field, claim, fieldPath),
    rawClaimRoot: (field, fieldPath) => assertHash(field, fieldPath),
    rawClaimCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    uniqueNominations: (field, fieldPath) => materializedArray(field, uniqueNomination, fieldPath),
    uniqueNominationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    uniqueNominationCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    receiptRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
  if (decoded.claims.some((entry, index) => index > 0 && decoded.claims[index - 1]!.claimRoot >= entry.claimRoot)) {
    throw new TypeError(`${path}.claims is not strict canonical order`);
  }
  if (new Set(decoded.claims.map(entry => entry.claimRoot)).size !== decoded.claims.length) {
    throw new TypeError(`${path}.claims contains duplicates`);
  }
  if (decoded.claims.some(entry => entry.sourcePlanIdentity !== decoded.sourcePlanIdentity)) {
    throw new TypeError(`${path}.claim source plan mismatch`);
  }
  if (decoded.claims.some(entry => entry.familyCandidateKey !== expectedFamilyCandidateKey(
    decoded.familyDefinitionHash,
    entry.instanceNominationKey,
  ))) throw new TypeError(`${path}.claim candidate key mismatch`);
  const rawClaimRoot = hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.rawClaims, decoded.claims);
  if (decoded.rawClaimCount !== String(decoded.claims.length) || decoded.rawClaimRoot !== rawClaimRoot) {
    throw new TypeError(`${path}.raw claim partition mismatch`);
  }
  if (decoded.uniqueNominations.some((entry, index) => index > 0 && decoded.uniqueNominations[index - 1]!.familyCandidateKey >= entry.familyCandidateKey)) {
    throw new TypeError(`${path}.uniqueNominations is not strict canonical order`);
  }
  const grouped = new Map<Hash, { instanceNominationKey: string; evidence: Hash[] }>();
  for (const entry of decoded.claims) {
    const current = grouped.get(entry.familyCandidateKey);
    if (current && current.instanceNominationKey !== entry.instanceNominationKey) {
      throw new TypeError(`${path}.candidate key maps to multiple nomination keys`);
    }
    if (current) current.evidence.push(entry.evidenceRefHash);
    else grouped.set(entry.familyCandidateKey, { instanceNominationKey: entry.instanceNominationKey, evidence: [entry.evidenceRefHash] });
  }
  const expectedUnique = [...grouped.entries()].sort(([left], [right]) => compareText(left, right)).map(([familyCandidateKey, entry]) => {
    const evidenceRefHashes = [...entry.evidence].sort(compareText);
    const base = { familyCandidateKey, instanceNominationKey: entry.instanceNominationKey, evidenceRefHashes };
    return { ...base, nominationRoot: uniqueNominationRoot(base) };
  });
  if (JSON.stringify(expectedUnique) !== JSON.stringify(decoded.uniqueNominations)) {
    throw new TypeError(`${path}.unique nomination partition mismatch`);
  }
  const uniqueRoot = hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.uniqueNominations, decoded.uniqueNominations);
  if (decoded.uniqueNominationCount !== String(decoded.uniqueNominations.length) || decoded.uniqueNominationRoot !== uniqueRoot) {
    throw new TypeError(`${path}.unique nomination root/count mismatch`);
  }
  if (decoded.denominator.kind === "recent-observation") {
    const relevant = new Set(decoded.denominator.relevantEvidenceRefHashes);
    if (decoded.claims.some(entry => !relevant.has(entry.evidenceRefHash))) {
      throw new TypeError(`${path}.claim is outside relevant recent evidence`);
    }
  }
  const { receiptRoot, ...payload } = decoded;
  if (receiptRoot !== qualifiedSourcePlanNominationReceiptRoot(payload)) {
    throw new TypeError(`${path}.receiptRoot mismatch`);
  }
  return decoded;
}

export function sealQualifiedSourcePlanNominationReceiptV1(
  input: Omit<QualifiedSourcePlanNominationReceiptV1,
    "kind" | "version" | "rawClaimRoot" | "rawClaimCount" | "uniqueNominations" |
    "uniqueNominationRoot" | "uniqueNominationCount" | "receiptRoot" | "claims"> & {
      readonly claims: readonly Omit<PlanQualifiedNominationClaimV1, "claimRoot">[];
    },
): QualifiedSourcePlanNominationReceiptV1 {
  const decodedCutoff = cutoff(input.cutoff, "nominationReceipt.cutoff");
  const claims = input.claims.map(value => ({ ...value, claimRoot: nominationClaimRoot(value) }))
    .sort((left, right) => compareText(left.claimRoot, right.claimRoot));
  const grouped = new Map<Hash, { instanceNominationKey: string; evidence: Hash[] }>();
  for (const entry of claims) {
    const current = grouped.get(entry.familyCandidateKey);
    if (current && current.instanceNominationKey !== entry.instanceNominationKey) {
      throw new TypeError("candidate key maps to multiple nomination keys");
    }
    if (current) current.evidence.push(entry.evidenceRefHash);
    else grouped.set(entry.familyCandidateKey, { instanceNominationKey: entry.instanceNominationKey, evidence: [entry.evidenceRefHash] });
  }
  const uniqueNominations = [...grouped.entries()].sort(([left], [right]) => compareText(left, right)).map(([familyCandidateKey, entry]) => {
    const evidenceRefHashes = [...entry.evidence].sort(compareText);
    const base = { familyCandidateKey, instanceNominationKey: entry.instanceNominationKey, evidenceRefHashes };
    return { ...base, nominationRoot: uniqueNominationRoot(base) };
  });
  const base: Omit<QualifiedSourcePlanNominationReceiptV1, "receiptRoot"> = {
    kind: "aloha.qualified-source-plan-nomination-receipt" as const,
    version: VERSION,
    cutoff: decodedCutoff,
    familyId: input.familyId,
    familyDefinitionHash: input.familyDefinitionHash,
    sourcePlanIdentity: input.sourcePlanIdentity,
    sourcePlanLeafDigest: input.sourcePlanLeafDigest,
    nominationProgramRoot: input.nominationProgramRoot,
    nominationProgramProposalLeafDigest: input.nominationProgramProposalLeafDigest,
    qualificationRoot: input.qualificationRoot,
    denominator: input.denominator,
    claims,
    rawClaimRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.rawClaims, claims),
    rawClaimCount: String(claims.length),
    uniqueNominations,
    uniqueNominationRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.uniqueNominations, uniqueNominations),
    uniqueNominationCount: String(uniqueNominations.length),
  };
  return decodeQualifiedSourcePlanNominationReceiptV1({
    ...base,
    receiptRoot: qualifiedSourcePlanNominationReceiptRoot(base),
  });
}

function familyPartition(value: unknown, path: string): FamilyNominationPartitionV1 {
  const decoded = decodeExactObject(value, {
    familyId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    familyDefinitionHash: (field, fieldPath) => assertHash(field, fieldPath),
    familyCandidateKeys: materializedSortedUniqueHashes,
    candidateSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    candidateCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
  }, path);
  if (decoded.candidateCount !== String(decoded.familyCandidateKeys.length)
    || decoded.candidateSetRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.familyCandidates, decoded.familyCandidateKeys)) {
    throw new TypeError(`${path} candidate partition mismatch`);
  }
  return decoded;
}

function familyPartitionCommitment(value: FamilyNominationPartitionV1) {
  return {
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    candidateSetRoot: value.candidateSetRoot,
    candidateCount: value.candidateCount,
  };
}

function familySetRoot(values: readonly FamilyNominationPartitionV1[]): Hash {
  return hashCanonicalPartition(
    NOMINATION_AUTHORITY_DOMAINS.familySet,
    values.map(familyPartitionCommitment),
  );
}

function closurePayload(value: Omit<NominationClosureV1, "root">) {
  const {
    sourcePlanIdentities: _sourcePlanIdentities,
    receipts: _receipts,
    families: _families,
    ...commitment
  } = value;
  return commitment;
}

export function nominationClosureRoot(value: Omit<NominationClosureV1, "root">): Hash {
  return hashDomain(NOMINATION_AUTHORITY_DOMAINS.closure, closurePayload(value));
}

export function decodeNominationClosureV1(value: unknown, path = "nominationClosure"): NominationClosureV1 {
  const decoded: NominationClosureV1 = decodeExactObject(value, {
    kind: (field, fieldPath) => {
      if (field !== "aloha.nomination-closure") throw new TypeError(`${fieldPath} is invalid`);
      return "aloha.nomination-closure" as const;
    },
    version: (field, fieldPath) => {
      if (field !== VERSION) throw new TypeError(`${fieldPath} is invalid`);
      return VERSION;
    },
    cutoff,
    recentObservationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourceExecutionSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourceCoverageRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanIdentities: exactSortedUniqueHashes,
    sourcePlanSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    receipts: (field, fieldPath) => fieldArray(field, decodeQualifiedSourcePlanNominationReceiptV1, fieldPath),
    receiptSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    receiptCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    rawClaimRoot: (field, fieldPath) => assertHash(field, fieldPath),
    rawClaimCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    uniqueNominationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    uniqueNominationCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    families: (field, fieldPath) => fieldArray(field, familyPartition, fieldPath),
    familySetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    familyCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    candidatePartitionRoot: (field, fieldPath) => assertHash(field, fieldPath),
    candidateCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    root: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
  if (decoded.receipts.length === 0) throw new TypeError(`${path}.receipts is empty`);
  if (decoded.receipts.some((entry, index) => index > 0 && decoded.receipts[index - 1]!.sourcePlanIdentity >= entry.sourcePlanIdentity)) {
    throw new TypeError(`${path}.receipts is not strict canonical order`);
  }
  if (decoded.receipts.some(receipt => !sameCutoff(receipt.cutoff, decoded.cutoff))) {
    throw new TypeError(`${path}.receipt cutoff mismatch`);
  }
  const receiptPlanIdentities = decoded.receipts.map(receipt => receipt.sourcePlanIdentity);
  if (decoded.sourcePlanCount !== String(decoded.sourcePlanIdentities.length)
    || decoded.sourcePlanSetRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.sourcePlanSet, decoded.sourcePlanIdentities)
    || JSON.stringify(receiptPlanIdentities) !== JSON.stringify(decoded.sourcePlanIdentities)) {
    throw new TypeError(`${path}.source plan denominator mismatch`);
  }
  if (decoded.receiptCount !== String(decoded.receipts.length)
    || decoded.receiptSetRoot !== hashCanonicalPartition(
      NOMINATION_AUTHORITY_DOMAINS.receiptSet,
      decoded.receipts.map(receipt => receipt.receiptRoot),
    )) {
    throw new TypeError(`${path}.receipt set mismatch`);
  }
  const claims = decoded.receipts.flatMap(receipt => receipt.claims);
  if (new Set(claims.map(entry => entry.claimRoot)).size !== claims.length) throw new TypeError(`${path}.duplicate raw claim`);
  if (decoded.rawClaimCount !== String(claims.length)
    || decoded.rawClaimRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.rawClaims, [...claims].sort((left, right) => compareText(left.claimRoot, right.claimRoot)))) {
    throw new TypeError(`${path}.aggregate raw claim partition mismatch`);
  }
  const globalUnique = aggregateUniqueNominations(claims);
  if (decoded.uniqueNominationCount !== String(globalUnique.length)
    || decoded.uniqueNominationRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.uniqueNominations, globalUnique)) {
    throw new TypeError(`${path}.aggregate unique nomination partition mismatch`);
  }
  if (decoded.families.some((entry, index) => index > 0 && decoded.families[index - 1]!.familyId >= entry.familyId)) {
    throw new TypeError(`${path}.families is not strict canonical order`);
  }
  if (decoded.familyCount !== String(decoded.families.length)
    || decoded.familySetRoot !== familySetRoot(decoded.families)) {
    throw new TypeError(`${path}.family partition mismatch`);
  }
  const expectedFamilies = familyPartitionsFromReceipts(decoded.receipts);
  if (JSON.stringify(expectedFamilies) !== JSON.stringify(decoded.families)) {
    throw new TypeError(`${path}.family receipt/candidate partition mismatch`);
  }
  const { root, ...payload } = decoded;
  if (root !== nominationClosureRoot(payload)) throw new TypeError(`${path}.root mismatch`);
  return decoded;
}

export function sealNominationClosureV1(input: {
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRoot: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly sourcePlanIdentities: readonly Hash[];
  readonly receipts: readonly QualifiedSourcePlanNominationReceiptV1[];
  readonly candidates: readonly CandidateRecordV1[];
  readonly candidatePartitionRoot: Hash;
}): NominationClosureV1 {
  const receipts = input.receipts.map(value => decodeQualifiedSourcePlanNominationReceiptV1(value))
    .sort((left, right) => compareText(left.sourcePlanIdentity, right.sourcePlanIdentity));
  const sourcePlanIdentities = [...input.sourcePlanIdentities].map((value, index) => assertHash(value, `nominationClosure.sourcePlanIdentities[${index}]`)).sort(compareText);
  if (new Set(sourcePlanIdentities).size !== sourcePlanIdentities.length
    || JSON.stringify(sourcePlanIdentities) !== JSON.stringify(receipts.map(receipt => receipt.sourcePlanIdentity))) {
    throw new TypeError("nomination receipts do not exactly cover the declared source plan denominator");
  }
  const claims = receipts.flatMap(receipt => receipt.claims);
  const candidates = [...input.candidates].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  const candidatesByKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
  if (candidatesByKey.size !== candidates.length) throw new TypeError("candidate partition contains duplicate keys");
  const computedCandidatePartitionRoot = hashCanonicalPartition("aloha/candidate-partition/v2", candidates);
  if (input.candidatePartitionRoot !== computedCandidatePartitionRoot) {
    throw new TypeError("candidate partition root does not match nomination candidates");
  }
  const claimedEvidenceByCandidate = new Map<Hash, Set<Hash>>();
  for (const entry of claims) {
    const candidate = candidatesByKey.get(entry.familyCandidateKey);
    const receipt = receipts.find(value => value.sourcePlanIdentity === entry.sourcePlanIdentity);
    if (!candidate || !receipt
      || candidate.instanceNominationKey !== entry.instanceNominationKey
      || candidate.familyId !== receipt.familyId
      || candidate.familyDefinitionHash !== receipt.familyDefinitionHash) {
      throw new TypeError("nomination claim candidate binding mismatch");
    }
    const evidence = claimedEvidenceByCandidate.get(entry.familyCandidateKey) ?? new Set<Hash>();
    evidence.add(entry.evidenceRefHash);
    claimedEvidenceByCandidate.set(entry.familyCandidateKey, evidence);
  }
  for (const candidate of candidates) {
    const expectedEvidence = candidate.evidence.map(nominationEvidenceRefHash).sort(compareText);
    const actualEvidence = [...(claimedEvidenceByCandidate.get(candidate.familyCandidateKey) ?? [])].sort(compareText);
    if (JSON.stringify(expectedEvidence) !== JSON.stringify(actualEvidence)) {
      throw new TypeError("candidate evidence does not exactly match nomination claims");
    }
  }
  const families = familyPartitionsFromReceipts(receipts);
  const unique = aggregateUniqueNominations(claims);
  const base: Omit<NominationClosureV1, "root"> = {
    kind: "aloha.nomination-closure" as const,
    version: VERSION,
    cutoff: input.cutoff,
    recentObservationRoot: input.recentObservationRoot,
    sourceExecutionSetRoot: input.sourceExecutionSetRoot,
    sourceCoverageRoot: input.sourceCoverageRoot,
    sourcePlanIdentities,
    sourcePlanSetRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.sourcePlanSet, sourcePlanIdentities),
    sourcePlanCount: String(sourcePlanIdentities.length),
    receipts,
    receiptSetRoot: hashCanonicalPartition(
      NOMINATION_AUTHORITY_DOMAINS.receiptSet,
      receipts.map(receipt => receipt.receiptRoot),
    ),
    receiptCount: String(receipts.length),
    rawClaimRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.rawClaims, [...claims].sort((left, right) => compareText(left.claimRoot, right.claimRoot))),
    rawClaimCount: String(claims.length),
    uniqueNominationRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.uniqueNominations, unique),
    uniqueNominationCount: String(unique.length),
    families,
    familySetRoot: familySetRoot(families),
    familyCount: String(families.length),
    candidatePartitionRoot: input.candidatePartitionRoot,
    candidateCount: String(candidates.length),
  };
  return decodeNominationClosureV1({ ...base, root: nominationClosureRoot(base) });
}

function aggregateUniqueNominations(
  claims: readonly PlanQualifiedNominationClaimV1[],
): readonly UniqueNominationV1[] {
  const grouped = new Map<Hash, { instanceNominationKey: string; evidence: Set<Hash> }>();
  for (const entry of claims) {
    const current = grouped.get(entry.familyCandidateKey);
    if (current && current.instanceNominationKey !== entry.instanceNominationKey) {
      throw new TypeError("global candidate key maps to multiple nomination keys");
    }
    if (current) current.evidence.add(entry.evidenceRefHash);
    else grouped.set(entry.familyCandidateKey, {
      instanceNominationKey: entry.instanceNominationKey,
      evidence: new Set([entry.evidenceRefHash]),
    });
  }
  return deepFreeze([...grouped.entries()].sort(([left], [right]) => compareText(left, right)).map(([familyCandidateKey, entry]) => {
    const evidenceRefHashes = [...entry.evidence].sort(compareText);
    const base = { familyCandidateKey, instanceNominationKey: entry.instanceNominationKey, evidenceRefHashes };
    return { ...base, nominationRoot: uniqueNominationRoot(base) };
  }));
}

function familyPartitionsFromReceipts(
  receipts: readonly QualifiedSourcePlanNominationReceiptV1[],
): readonly FamilyNominationPartitionV1[] {
  const familyMap = new Map<string, { definition: Hash; keys: Set<Hash> }>();
  for (const receipt of receipts) {
    const current = familyMap.get(receipt.familyId);
    if (current && current.definition !== receipt.familyDefinitionHash) {
      throw new TypeError("family id maps to multiple definitions");
    }
    const state = current ?? { definition: receipt.familyDefinitionHash, keys: new Set<Hash>() };
    for (const claim of receipt.claims) state.keys.add(claim.familyCandidateKey);
    familyMap.set(receipt.familyId, state);
  }
  return deepFreeze([...familyMap.entries()].sort(([left], [right]) => compareText(left, right)).map(([familyId, entry]) => {
    const familyCandidateKeys = [...entry.keys].sort(compareText);
    return {
      familyId,
      familyDefinitionHash: entry.definition,
      familyCandidateKeys,
      candidateSetRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.familyCandidates, familyCandidateKeys),
      candidateCount: String(familyCandidateKeys.length),
    };
  }));
}

type PersistedNominationDenominatorV1 = Exclude<
  NominationDenominatorV1,
  RecentObservationDenominatorV1
> | Omit<RecentObservationDenominatorV1, "relevantEvidenceRefHashes">;

interface PersistedNominationReceiptManifestV1 extends Omit<
  QualifiedSourcePlanNominationReceiptV1,
  "claims" | "uniqueNominations" | "denominator"
> {
  readonly denominator: PersistedNominationDenominatorV1;
  readonly claimChunkCount: string;
  readonly firstClaimChunkRef: NominationClaimChunkRefV1 | null;
}

interface NominationClosureManifestV1 extends Omit<
  NominationClosureV1,
  "kind" | "version" | "receipts" | "families"
> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-closure-manifest-v1";
  readonly receiptManifests: readonly PersistedNominationReceiptManifestV1[];
}

function claimChunkRef(value: unknown, path: string): NominationClaimChunkRefV1 {
  return decodeExactObject(value, {
    contentSha256: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
}

function persistedReceiptManifest(
  value: unknown,
  path: string,
): PersistedNominationReceiptManifestV1 {
  return decodeExactObject(value, {
    kind: (field, fieldPath) => {
      if (field !== "aloha.qualified-source-plan-nomination-receipt") throw new TypeError(`${fieldPath} is invalid`);
      return "aloha.qualified-source-plan-nomination-receipt" as const;
    },
    version: (field, fieldPath) => {
      if (field !== VERSION) throw new TypeError(`${fieldPath} is invalid`);
      return VERSION;
    },
    cutoff,
    familyId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    familyDefinitionHash: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanIdentity: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanLeafDigest: (field, fieldPath) => assertHash(field, fieldPath),
    nominationProgramRoot: (field, fieldPath) => assertHash(field, fieldPath),
    nominationProgramProposalLeafDigest: (field, fieldPath) => assertHash(field, fieldPath),
    qualificationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    denominator: (field, fieldPath): PersistedNominationDenominatorV1 => {
      const kind = readOwnEnumerableDataProperty(field, "kind", fieldPath);
      if (kind !== "recent-observation") return denominator(field, fieldPath) as PersistedNominationDenominatorV1;
      return decodeExactObject(field, {
        kind: value => {
          if (value !== "recent-observation") throw new TypeError(`${fieldPath}.kind is invalid`);
          return "recent-observation" as const;
        },
        recentObservationRoot: (value, path) => assertHash(value, path),
        relevantEvidenceRoot: (value, path) => assertHash(value, path),
        relevantEvidenceCount: (value, path) => assertDecimalString(value, path),
      }, fieldPath);
    },
    rawClaimRoot: (field, fieldPath) => assertHash(field, fieldPath),
    rawClaimCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    uniqueNominationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    uniqueNominationCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    receiptRoot: (field, fieldPath) => assertHash(field, fieldPath),
    claimChunkCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    firstClaimChunkRef: (field, fieldPath) => field === null ? null : claimChunkRef(field, fieldPath),
  }, path);
}

function buildClaimChunks(
  receipt: QualifiedSourcePlanNominationReceiptV1,
): readonly Readonly<{ readonly ref: NominationClaimChunkRefV1; readonly bytes: Uint8Array }>[] {
  const relevantEvidenceRefHashes = receipt.denominator.kind === "recent-observation"
    ? receipt.denominator.relevantEvidenceRefHashes
    : [];
  const groups = Array.from(
    { length: Math.ceil(Math.max(receipt.claims.length, relevantEvidenceRefHashes.length) / NOMINATION_CLAIM_CHUNK_MAX_ITEMS) },
    (_, index) => Object.freeze({
      claims: receipt.claims.slice(
        index * NOMINATION_CLAIM_CHUNK_MAX_ITEMS,
        (index + 1) * NOMINATION_CLAIM_CHUNK_MAX_ITEMS,
      ),
      relevantEvidenceRefHashes: relevantEvidenceRefHashes.slice(
        index * NOMINATION_CLAIM_CHUNK_MAX_ITEMS,
        (index + 1) * NOMINATION_CLAIM_CHUNK_MAX_ITEMS,
      ),
    }),
  );
  const output: Array<Readonly<{ readonly ref: NominationClaimChunkRefV1; readonly bytes: Uint8Array }>> = new Array(groups.length);
  let nextClaimChunkRef: NominationClaimChunkRefV1 | null = null;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const chunk: NominationClaimChunkV1 = deepFreeze({
      schemaVersion: 1 as const,
      kind: "aloha.nomination-claim-chunk-v1" as const,
      sourcePlanIdentity: receipt.sourcePlanIdentity,
      claims: groups[index]!.claims,
      relevantEvidenceRefHashes: groups[index]!.relevantEvidenceRefHashes,
      nextClaimChunkRef,
    });
    const bytes = encodeCanonicalBytes(chunk);
    if (bytes.byteLength > NOMINATION_WIRE_MAX_BYTES) {
      throw new TypeError("nomination claim chunk exceeds durable byte cap");
    }
    const ref = deepFreeze({ contentSha256: sha256Hex(bytes) });
    output[index] = Object.freeze({ ref, bytes: bytes.slice() });
    nextClaimChunkRef = ref;
  }
  return Object.freeze(output);
}

export function encodeNominationClosureV1(value: NominationClosureV1): Uint8Array {
  return encodeCanonicalBytes(decodeNominationClosureV1(value));
}

export function decodeNominationClosureBytesV1(value: Uint8Array): NominationClosureV1 {
  return decodeNominationClosureV1(decodeCanonicalJson(value));
}

export function encodePersistedNominationClosureV1(value: NominationClosureV1): EncodedNominationClosureV1 {
  const closure = decodeNominationClosureV1(value);
  const chunks: Array<Readonly<{ readonly ref: NominationClaimChunkRefV1; readonly bytes: Uint8Array }>> = [];
  const receiptManifests = closure.receipts.map(receipt => {
    const receiptChunks = buildClaimChunks(receipt);
    chunks.push(...receiptChunks);
    const { claims: _claims, uniqueNominations: _uniqueNominations, denominator: fullDenominator, ...persisted } = receipt;
    const persistedDenominator: PersistedNominationDenominatorV1 = fullDenominator.kind === "recent-observation"
      ? deepFreeze({
        kind: fullDenominator.kind,
        recentObservationRoot: fullDenominator.recentObservationRoot,
        relevantEvidenceRoot: fullDenominator.relevantEvidenceRoot,
        relevantEvidenceCount: fullDenominator.relevantEvidenceCount,
      })
      : fullDenominator;
    return deepFreeze({
      ...persisted,
      denominator: persistedDenominator,
      claimChunkCount: String(receiptChunks.length),
      firstClaimChunkRef: receiptChunks[0]?.ref ?? null,
    });
  });
  const { receipts: _receipts, families: _families, kind: _kind, version: _version, ...persistedClosure } = closure;
  const manifest: NominationClosureManifestV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.nomination-closure-manifest-v1" as const,
    ...persistedClosure,
    receiptManifests,
  });
  const manifestBytes = encodeCanonicalBytes(manifest);
  if (manifestBytes.byteLength > NOMINATION_WIRE_MAX_BYTES) {
    throw new TypeError("nomination closure manifest exceeds durable byte cap");
  }
  return Object.freeze({ manifestBytes: manifestBytes.slice(), chunks: Object.freeze(chunks) });
}

function decodeClaimChunk(
  value: Uint8Array,
  expectedRef: NominationClaimChunkRefV1,
  path: string,
): NominationClaimChunkV1 {
  if (value.byteLength > NOMINATION_WIRE_MAX_BYTES || sha256Hex(value) !== expectedRef.contentSha256) {
    throw new TypeError(`${path} content mismatch`);
  }
  return decodeExactObject(decodeCanonicalJson(value), {
    schemaVersion: field => {
      if (field !== 1) throw new TypeError(`${path}.schemaVersion is invalid`);
      return 1 as const;
    },
    kind: field => {
      if (field !== "aloha.nomination-claim-chunk-v1") throw new TypeError(`${path}.kind is invalid`);
      return "aloha.nomination-claim-chunk-v1" as const;
    },
    sourcePlanIdentity: (field, fieldPath) => assertHash(field, fieldPath),
    claims: (field, fieldPath) => fieldArray(field, claim, fieldPath),
    relevantEvidenceRefHashes: exactSortedUniqueHashes,
    nextClaimChunkRef: (field, fieldPath) => field === null ? null : claimChunkRef(field, fieldPath),
  }, path);
}

export function decodePersistedNominationClosureV1(
  manifestBytes: Uint8Array,
  readChunk: (ref: NominationClaimChunkRefV1) => Uint8Array,
): NominationClosureV1 {
  if (manifestBytes.byteLength > NOMINATION_WIRE_MAX_BYTES) {
    throw new TypeError("nomination closure manifest exceeds durable byte cap");
  }
  const manifest: NominationClosureManifestV1 = decodeExactObject(decodeCanonicalJson(manifestBytes), {
    schemaVersion: field => {
      if (field !== 1) throw new TypeError("nomination closure manifest schema version mismatch");
      return 1 as const;
    },
    kind: field => {
      if (field !== "aloha.nomination-closure-manifest-v1") throw new TypeError("nomination closure manifest kind mismatch");
      return "aloha.nomination-closure-manifest-v1" as const;
    },
    cutoff,
    recentObservationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourceExecutionSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourceCoverageRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanIdentities: exactSortedUniqueHashes,
    sourcePlanSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    sourcePlanCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    receiptManifests: (field, fieldPath) => fieldArray(field, persistedReceiptManifest, fieldPath),
    receiptSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    receiptCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    rawClaimRoot: (field, fieldPath) => assertHash(field, fieldPath),
    rawClaimCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    uniqueNominationRoot: (field, fieldPath) => assertHash(field, fieldPath),
    uniqueNominationCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    familySetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    familyCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    candidatePartitionRoot: (field, fieldPath) => assertHash(field, fieldPath),
    candidateCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    root: (field, fieldPath) => assertHash(field, fieldPath),
  }, "nominationClosureManifest");
  const receipts = manifest.receiptManifests.map((receiptManifest, receiptIndex) => {
    const claims: PlanQualifiedNominationClaimV1[] = [];
    const relevantEvidenceRefHashes: Hash[] = [];
    const seen = new Set<Hash>();
    let ref = receiptManifest.firstClaimChunkRef;
    while (ref !== null) {
      if (BigInt(seen.size) >= BigInt(receiptManifest.claimChunkCount)) {
        throw new TypeError(`nomination receipt ${receiptIndex} claim chunk range mismatch`);
      }
      if (seen.has(ref.contentSha256)) throw new TypeError(`nomination receipt ${receiptIndex} claim chunk cycle`);
      seen.add(ref.contentSha256);
      const chunk = decodeClaimChunk(readChunk(ref), ref, `nominationClaimChunk[${receiptIndex}:${seen.size - 1}]`);
      if (chunk.sourcePlanIdentity !== receiptManifest.sourcePlanIdentity
        || (chunk.claims.length === 0 && chunk.relevantEvidenceRefHashes.length === 0)
        || chunk.claims.length > NOMINATION_CLAIM_CHUNK_MAX_ITEMS
        || chunk.relevantEvidenceRefHashes.length > NOMINATION_CLAIM_CHUNK_MAX_ITEMS) {
        throw new TypeError(`nomination receipt ${receiptIndex} claim chunk binding mismatch`);
      }
      claims.push(...chunk.claims);
      relevantEvidenceRefHashes.push(...chunk.relevantEvidenceRefHashes);
      ref = chunk.nextClaimChunkRef;
    }
    const partitionItemCount = BigInt(receiptManifest.rawClaimCount)
      + (receiptManifest.denominator.kind === "recent-observation"
        ? BigInt(receiptManifest.denominator.relevantEvidenceCount)
        : 0n);
    if (receiptManifest.claimChunkCount !== String(seen.size)
      || (partitionItemCount === 0n) !== (receiptManifest.firstClaimChunkRef === null)) {
      throw new TypeError(`nomination receipt ${receiptIndex} claim chunk denominator mismatch`);
    }
    const {
      rawClaimRoot,
      rawClaimCount,
      uniqueNominationRoot,
      uniqueNominationCount,
      receiptRoot,
      claimChunkCount: _claimChunkCount,
      firstClaimChunkRef: _firstClaimChunkRef,
      kind: _receiptKind,
      version: _receiptVersion,
      ...receiptInput
    } = receiptManifest;
    const restoredDenominator: NominationDenominatorV1 = receiptInput.denominator.kind === "recent-observation"
      ? deepFreeze({ ...receiptInput.denominator, relevantEvidenceRefHashes })
      : receiptInput.denominator;
    if (receiptInput.denominator.kind !== "recent-observation" && relevantEvidenceRefHashes.length !== 0) {
      throw new TypeError(`nomination receipt ${receiptIndex} carries unexpected recent evidence`);
    }
    const receipt = sealQualifiedSourcePlanNominationReceiptV1({
      ...receiptInput,
      denominator: restoredDenominator,
      claims,
    });
    if (receipt.rawClaimRoot !== rawClaimRoot
      || receipt.rawClaimCount !== rawClaimCount
      || receipt.uniqueNominationRoot !== uniqueNominationRoot
      || receipt.uniqueNominationCount !== uniqueNominationCount
      || receipt.receiptRoot !== receiptRoot) {
      throw new TypeError(`nomination receipt ${receiptIndex} manifest binding mismatch`);
    }
    return receipt;
  });
  const families = familyPartitionsFromReceipts(receipts);
  const { schemaVersion: _schemaVersion, kind: _manifestKind, receiptManifests: _receiptManifests, ...closureFields } = manifest;
  return decodeNominationClosureV1({
    kind: "aloha.nomination-closure",
    version: VERSION,
    ...closureFields,
    receipts,
    families,
  });
}

export function nominationPlanGrantsOmissionAuthority(
  receipt: QualifiedSourcePlanNominationReceiptV1,
): boolean {
  const decoded = decodeQualifiedSourcePlanNominationReceiptV1(receipt);
  return decoded.denominator.kind === "complete-source-result";
}
