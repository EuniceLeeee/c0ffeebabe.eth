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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  return value;
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
    claims: (field, fieldPath) => fieldArray(field, claim, fieldPath),
    rawClaimRoot: (field, fieldPath) => assertHash(field, fieldPath),
    rawClaimCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
    uniqueNominations: (field, fieldPath) => fieldArray(field, uniqueNomination, fieldPath),
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
    familyCandidateKeys: exactSortedUniqueHashes,
    candidateSetRoot: (field, fieldPath) => assertHash(field, fieldPath),
    candidateCount: (field, fieldPath) => assertDecimalString(field, fieldPath),
  }, path);
  if (decoded.candidateCount !== String(decoded.familyCandidateKeys.length)
    || decoded.candidateSetRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.familyCandidates, decoded.familyCandidateKeys)) {
    throw new TypeError(`${path} candidate partition mismatch`);
  }
  return decoded;
}

function closurePayload(value: Omit<NominationClosureV1, "root">) {
  return value;
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
    || decoded.receiptSetRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.receiptSet, decoded.receipts)) {
    throw new TypeError(`${path}.receipt set mismatch`);
  }
  const claims = decoded.receipts.flatMap(receipt => receipt.claims);
  if (new Set(claims.map(entry => entry.claimRoot)).size !== claims.length) throw new TypeError(`${path}.duplicate raw claim`);
  const evidenceOwners = new Map<Hash, Hash>();
  for (const entry of claims) {
    const existing = evidenceOwners.get(entry.evidenceRefHash);
    if (existing !== undefined && existing !== entry.familyCandidateKey) {
      throw new TypeError(`${path}.same evidence maps to two candidate keys`);
    }
    evidenceOwners.set(entry.evidenceRefHash, entry.familyCandidateKey);
  }
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
    || decoded.familySetRoot !== hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.familySet, decoded.families)) {
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
    receiptSetRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.receiptSet, receipts),
    receiptCount: String(receipts.length),
    rawClaimRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.rawClaims, [...claims].sort((left, right) => compareText(left.claimRoot, right.claimRoot))),
    rawClaimCount: String(claims.length),
    uniqueNominationRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.uniqueNominations, unique),
    uniqueNominationCount: String(unique.length),
    families,
    familySetRoot: hashCanonicalPartition(NOMINATION_AUTHORITY_DOMAINS.familySet, families),
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

export function encodeNominationClosureV1(value: NominationClosureV1): Uint8Array {
  return encodeCanonicalBytes(decodeNominationClosureV1(value));
}

export function decodeNominationClosureBytesV1(value: Uint8Array): NominationClosureV1 {
  return decodeNominationClosureV1(decodeCanonicalJson(value));
}

export function nominationPlanGrantsOmissionAuthority(
  receipt: QualifiedSourcePlanNominationReceiptV1,
): boolean {
  const decoded = decodeQualifiedSourcePlanNominationReceiptV1(receipt);
  return decoded.denominator.kind === "complete-source-result";
}
