import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashCanonicalPartition,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export interface CanonicalCutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface BlockRangeV1 {
  readonly from: string;
  readonly to: string;
}

export type SourceCompleteness =
  | "complete-snapshot"
  | "contiguous-history"
  | "point-lookup"
  | "nomination-only";

export interface SourcePlanRefV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly completeness: SourceCompleteness;
  /**
   * The immutable lower bound of a contiguous-history source. Other source
   * kinds must carry null so a plan cannot silently acquire history authority
   * by being reinterpreted at validation time.
   */
  readonly historyStartBlock: string | null;
}

export interface SourcePlanExecutionV1 {
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly outcome: "complete" | "positive-only" | "retryable" | "invalid-program";
  readonly from: string;
  readonly through: string;
  readonly previousAppliedThrough: string | null;
  readonly resultPartitionRoot: Hash;
}

export interface SourceCoverageEntryV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly completeness: SourceCompleteness;
  readonly historyStartBlock: string | null;
  readonly previousAppliedThrough: string | null;
  readonly cutoffHash: Hash;
  readonly from: string;
  readonly appliedThrough: string;
  readonly resultPartitionRoot: Hash;
  readonly contributesOmissionAuthority: boolean;
}

export interface SourceCoverageCertificateV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly entries: readonly SourceCoverageEntryV1[];
  readonly sourceCoverageRoot: Hash;
}

export interface CandidateEvidenceRefV1 {
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly address: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}

export interface CandidateNominationV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: CandidateEvidenceRefV1;
}

export interface CandidateRecordV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
}

const decimal = (value: string, name: string): bigint => BigInt(assertDecimalString(value, name));

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const sourceCompleteness = (value: unknown, path: string): SourceCompleteness => {
  if (
    value !== "complete-snapshot"
    && value !== "contiguous-history"
    && value !== "point-lookup"
    && value !== "nomination-only"
  ) throw new TypeError(`${path} has an invalid source completeness`);
  return value;
};

const sourceOutcome = (value: unknown, path: string): SourcePlanExecutionV1["outcome"] => {
  if (
    value !== "complete"
    && value !== "positive-only"
    && value !== "retryable"
    && value !== "invalid-program"
  ) throw new TypeError(`${path} has an invalid source outcome`);
  return value;
};

export function decodeCanonicalCutoff(
  value: unknown,
  name = "canonicalCutoff",
): CanonicalCutoffV1 {
  return decodeExactObject(value, {
    chainId: (field, path) => assertNonEmptyString(field, path),
    number: (field, path) => assertDecimalString(field, path),
    hash: (field, path) => assertHash(field, path),
    stateRoot: (field, path) => assertHash(field, path),
  }, name);
}

export function validateCanonicalCutoff(value: CanonicalCutoffV1, name = "canonicalCutoff"): void {
  decodeCanonicalCutoff(value, name);
}

export function decodeCandidateEvidenceRef(
  value: unknown,
  name = "candidateEvidence",
): CandidateEvidenceRefV1 {
  return decodeExactObject(value, {
    blockNumber: (field, path) => assertDecimalString(field, path),
    blockHash: (field, path) => assertHash(field, path),
    txHash: (field, path) => assertHash(field, path),
    logIndex: (field, path) => assertDecimalString(field, path),
    address: (field, path) => assertNonEmptyString(field, path),
    topic: (field, path) => assertHash(field, path),
    rawLocatorHash: (field, path) => assertHash(field, path),
  }, name);
}

export function validateCandidateEvidenceRef(value: CandidateEvidenceRefV1, name = "candidateEvidence"): void {
  decodeCandidateEvidenceRef(value, name);
}

export function decodeSourcePlanRef(value: unknown, name = "sourcePlanRef"): SourcePlanRefV1 {
  return decodeExactObject(value, {
    ownerRef: (field, path) => assertHash(field, path),
    sourcePlanRef: (field, path) => assertHash(field, path),
    familyDefinitionHash: (field, path) => assertHash(field, path),
    completeness: sourceCompleteness,
    historyStartBlock: (field, path) => field === null ? null : assertDecimalString(field, path),
  }, name);
}

export function decodeSourcePlanExecution(
  value: unknown,
  name = "sourcePlanExecution",
): SourcePlanExecutionV1 {
  return decodeExactObject(value, {
    plan: (field, path) => decodeSourcePlanRef(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    outcome: sourceOutcome,
    from: (field, path) => assertDecimalString(field, path),
    through: (field, path) => assertDecimalString(field, path),
    previousAppliedThrough: (field, path) => field === null ? null : assertDecimalString(field, path),
    resultPartitionRoot: (field, path) => assertHash(field, path),
  }, name);
}

const decodeSourceCoverageEntry = (
  value: unknown,
  name = "sourceCoverageEntry",
): SourceCoverageEntryV1 => decodeExactObject(value, {
  ownerRef: (field, path) => assertHash(field, path),
  sourcePlanRef: (field, path) => assertHash(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  completeness: sourceCompleteness,
  historyStartBlock: (field, path) => field === null ? null : assertDecimalString(field, path),
  previousAppliedThrough: (field, path) => field === null ? null : assertDecimalString(field, path),
  cutoffHash: (field, path) => assertHash(field, path),
  from: (field, path) => assertDecimalString(field, path),
  appliedThrough: (field, path) => assertDecimalString(field, path),
  resultPartitionRoot: (field, path) => assertHash(field, path),
  contributesOmissionAuthority: (field, path) => {
    if (typeof field !== "boolean") throw new TypeError(`${path} must be boolean`);
    return field;
  },
}, name);

export function recentObservationRange(cutoffNumber: string): BlockRangeV1 {
  const cutoff = decimal(cutoffNumber, "cutoffNumber");
  const from = cutoff > 49n ? cutoff - 49n : 0n;
  return deepFreeze({ from: from.toString(), to: cutoff.toString() });
}

export function familyCandidateKey(
  familyDefinitionHash: Hash,
  instanceNominationKey: string,
): Hash {
  if (instanceNominationKey.length === 0) throw new TypeError("instanceNominationKey is empty");
  return hashDomain("aloha/family-candidate/v1", {
    familyDefinitionHash,
    instanceNominationKey,
  });
}

export function runCandidateKey(runId: string, candidateKey: Hash): Hash {
  if (runId.length === 0) throw new TypeError("runId is empty");
  return hashDomain("aloha/run-candidate/v1", { runId, familyCandidateKey: candidateKey });
}

function evidenceKey(value: CandidateEvidenceRefV1): Hash {
  return hashDomain("aloha/candidate-evidence-ref/v1", value);
}

const decodeCandidateNomination = (
  value: unknown,
  name = "candidateNomination",
): CandidateNominationV1 => decodeExactObject(value, {
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  instanceNominationKey: (field, path) => assertNonEmptyString(field, path),
  candidateSnapshotHash: (field, path) => assertHash(field, path),
  evidence: (field, path) => decodeCandidateEvidenceRef(field, path),
}, name);

const decodeCandidateRecord = (
  value: unknown,
  name = "candidateRecord",
): CandidateRecordV1 => decodeExactObject(value, {
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  instanceNominationKey: (field, path) => assertNonEmptyString(field, path),
  familyCandidateKey: (field, path) => assertHash(field, path),
  candidateSnapshotHash: (field, path) => assertHash(field, path),
  evidence: (field, path) => fieldArray(field, (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath), path),
}, name);

export function mergeAndDedupeNominations(
  nominations: readonly CandidateNominationV1[],
): readonly CandidateRecordV1[] {
  const decodedNominations = fieldArray(
    nominations,
    (value, path) => decodeCandidateNomination(value, path),
    "candidateNominations",
  );
  const groups = new Map<Hash, {
    nomination: CandidateNominationV1;
    evidence: Map<Hash, CandidateEvidenceRefV1>;
  }>();

  for (const nomination of decodedNominations) {
    const key = familyCandidateKey(
      nomination.familyDefinitionHash,
      nomination.instanceNominationKey,
    );
    const existing = groups.get(key);
    if (existing) {
      if (
        existing.nomination.familyId !== nomination.familyId
        || existing.nomination.familyDefinitionHash !== nomination.familyDefinitionHash
        || existing.nomination.instanceNominationKey !== nomination.instanceNominationKey
        || existing.nomination.candidateSnapshotHash !== nomination.candidateSnapshotHash
      ) {
        throw new Error(`candidate-key-collision:${key}`);
      }
      existing.evidence.set(evidenceKey(nomination.evidence), nomination.evidence);
      continue;
    }
    groups.set(key, {
      nomination,
      evidence: new Map([[evidenceKey(nomination.evidence), nomination.evidence]]),
    });
  }

  const records = [...groups.entries()].map(([key, group]) => deepFreeze({
    familyId: group.nomination.familyId,
    familyDefinitionHash: group.nomination.familyDefinitionHash,
    instanceNominationKey: group.nomination.instanceNominationKey,
    familyCandidateKey: key,
    candidateSnapshotHash: group.nomination.candidateSnapshotHash,
    evidence: [...group.evidence.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, evidence]) => deepFreeze({ ...evidence })),
  }));
  records.sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  return deepFreeze(records);
}

function coverageEntry(execution: unknown): SourceCoverageEntryV1 {
  const decoded = decodeSourcePlanExecution(execution);
  const plan = decoded.plan;
  const cutoff = decoded.cutoff;

  const cutoffNumber = decimal(cutoff.number, "cutoff.number");
  const from = decimal(decoded.from, "from");
  const through = decimal(decoded.through, "through");
  if (from > through || through > cutoffNumber) throw new Error("source-range-outside-cutoff");
  if (decoded.outcome === "retryable") throw new Error("source-retryable");
  if (decoded.outcome === "invalid-program") throw new Error("source-invalid-program");

  let contributesOmissionAuthority = false;
  switch (plan.completeness) {
    case "complete-snapshot":
      if (plan.historyStartBlock !== null || decoded.previousAppliedThrough !== null) {
        throw new Error("snapshot-history-anchor-invalid");
      }
      if (decoded.outcome !== "complete" || from !== cutoffNumber || through !== cutoffNumber) {
        throw new Error("incomplete-snapshot-coverage");
      }
      contributesOmissionAuthority = true;
      break;
    case "contiguous-history": {
      if (decoded.outcome !== "complete" || through !== cutoffNumber) {
        throw new Error("incomplete-history-coverage");
      }
      if (plan.historyStartBlock === null) throw new Error("history-start-missing");
      const historyStart = decimal(plan.historyStartBlock, "plan.historyStartBlock");
      const previous = decoded.previousAppliedThrough === null
        ? null
        : decimal(decoded.previousAppliedThrough, "previousAppliedThrough");
      if (previous === null) {
        if (from !== historyStart) throw new Error("history-start-gap");
      } else {
        if (previous < historyStart || from !== previous + 1n) throw new Error("history-cursor-gap");
      }
      contributesOmissionAuthority = true;
      break;
    }
    case "point-lookup":
      if (plan.historyStartBlock !== null || decoded.previousAppliedThrough !== null) {
        throw new Error("point-lookup-history-anchor-invalid");
      }
      if (decoded.outcome !== "complete" || from !== through) throw new Error("point-lookup-incomplete");
      break;
    case "nomination-only":
      if (plan.historyStartBlock !== null || decoded.previousAppliedThrough !== null) {
        throw new Error("nomination-history-anchor-invalid");
      }
      if (decoded.outcome !== "positive-only" && decoded.outcome !== "complete") {
        throw new Error("nomination-only-incomplete");
      }
      break;
  }

  return deepFreeze({
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
    familyDefinitionHash: plan.familyDefinitionHash,
    completeness: plan.completeness,
    historyStartBlock: plan.historyStartBlock,
    previousAppliedThrough: decoded.previousAppliedThrough,
    cutoffHash: cutoff.hash,
    from: decoded.from,
    appliedThrough: decoded.through,
    resultPartitionRoot: decoded.resultPartitionRoot,
    contributesOmissionAuthority,
  });
}

export function sealSourceCoverage(
  cutoff: CanonicalCutoffV1,
  declaredPlans: readonly SourcePlanRefV1[],
  executions: readonly SourcePlanExecutionV1[],
): SourceCoverageCertificateV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "coverageCutoff");
  const decodedPlans = fieldArray(
    declaredPlans,
    (value, path) => decodeSourcePlanRef(value, path),
    "declaredSourcePlans",
  );
  const decodedExecutions = fieldArray(
    executions,
    (value, path) => decodeSourcePlanExecution(value, path),
    "sourcePlanExecutions",
  );
  const declared = new Map<string, SourcePlanRefV1>();
  for (const plan of decodedPlans) {
    const identity = `${plan.ownerRef}:${plan.sourcePlanRef}`;
    if (declared.has(identity)) throw new Error(`duplicate-declared-source-plan:${identity}`);
    declared.set(identity, plan);
  }
  const seen = new Set<string>();
  const entries = decodedExecutions.map(execution => {
    if (
      execution.cutoff.chainId !== decodedCutoff.chainId
      || execution.cutoff.number !== decodedCutoff.number
      || execution.cutoff.hash !== decodedCutoff.hash
      || execution.cutoff.stateRoot !== decodedCutoff.stateRoot
    ) throw new Error("coverage-cutoff-mismatch");
    const identity = `${execution.plan.ownerRef}:${execution.plan.sourcePlanRef}`;
    if (seen.has(identity)) throw new Error(`duplicate-source-partition:${identity}`);
    const expectedPlan = declared.get(identity);
    if (
      !expectedPlan
      || expectedPlan.familyDefinitionHash !== execution.plan.familyDefinitionHash
      || expectedPlan.completeness !== execution.plan.completeness
      || expectedPlan.historyStartBlock !== execution.plan.historyStartBlock
    ) throw new Error(`undeclared-source-partition:${identity}`);
    seen.add(identity);
    return coverageEntry(execution);
  }).sort((left, right) => compareText(
    `${left.ownerRef}:${left.sourcePlanRef}`,
    `${right.ownerRef}:${right.sourcePlanRef}`,
  ));
  if (seen.size !== declared.size) {
    const missing = [...declared.keys()].filter(identity => !seen.has(identity)).sort();
    throw new Error(`missing-source-partition:${missing.join(",")}`);
  }
  const sourceCoverageRoot = hashDomain("aloha/source-coverage/v1", { cutoff: decodedCutoff, entries });
  return deepFreeze({ cutoff: decodedCutoff, entries, sourceCoverageRoot });
}

export function candidatePartitionRoot(records: readonly CandidateRecordV1[]): Hash {
  const decoded = decodeCandidateRecords(records, "candidateRecords");
  for (const record of decoded) {
    if (
      record.familyCandidateKey !== familyCandidateKey(record.familyDefinitionHash, record.instanceNominationKey)
      || record.evidence.length === 0
    ) throw new Error("candidate-record-lineage-mismatch");
    const evidenceKeys = record.evidence.map(value => evidenceKey(value));
    if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new Error("duplicate-candidate-evidence");
    const sortedEvidenceKeys = [...evidenceKeys].sort(compareText);
    if (evidenceKeys.some((key, index) => key !== sortedEvidenceKeys[index])) {
      throw new Error("candidate-evidence-not-canonical-order");
    }
  }
  const keys = decoded.map(record => record.familyCandidateKey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate-candidate-record");
  const sorted = [...decoded].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  return hashCanonicalPartition("aloha/candidate-partition/v1", sorted);
}

const decodeCandidateRecords = (
  value: unknown,
  name: string,
): readonly CandidateRecordV1[] => fieldArray(
  value,
  (item, path) => decodeCandidateRecord(item, path),
  name,
);

export function sourcePlanSetRoot(plans: readonly SourcePlanRefV1[]): Hash {
  const identities = new Set<string>();
  const decoded = fieldArray(plans, (value, path) => decodeSourcePlanRef(value, path), "sourcePlanRefs");
  const sorted = decoded.map(plan => {
    const identity = `${plan.ownerRef}:${plan.sourcePlanRef}`;
    if (identities.has(identity)) throw new Error("duplicate-source-plan");
    identities.add(identity);
    return plan;
  }).sort((left, right) => compareText(`${left.ownerRef}:${left.sourcePlanRef}`, `${right.ownerRef}:${right.sourcePlanRef}`));
  return hashDomain("aloha/source-plan-set/v1", sorted);
}

export function validateSourceCoverageCertificate(
  certificate: SourceCoverageCertificateV1,
  declaredPlans: readonly SourcePlanRefV1[],
): void {
  const decodedCertificate = decodeExactObject(certificate, {
    cutoff: (value, path) => decodeCanonicalCutoff(value, path),
    entries: (value, path) => fieldArray(value, (entry, entryPath) => decodeSourceCoverageEntry(entry, entryPath), path),
    sourceCoverageRoot: (value, path) => assertHash(value, path),
  }, "sourceCoverageCertificate");
  const decodedPlans = fieldArray(
    declaredPlans,
    (value, path) => decodeSourcePlanRef(value, path),
    "declaredSourcePlans",
  );
  const plans = new Map(decodedPlans.map(plan => [`${plan.ownerRef}:${plan.sourcePlanRef}`, plan]));
  if (plans.size !== decodedPlans.length) throw new Error("duplicate-declared-source-plan");
  const seen = new Set<string>();
  const cutoffNumber = decimal(decodedCertificate.cutoff.number, "coverageCutoff.number");
  for (const entry of decodedCertificate.entries) {
    const identity = `${entry.ownerRef}:${entry.sourcePlanRef}`;
    const plan = plans.get(identity);
    if (!plan || seen.has(identity)) throw new Error("coverage-source-plan-partition-mismatch");
    seen.add(identity);
    const expectedOmission = plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history";
    const from = decimal(entry.from, "sourceCoverageEntry.from");
    const appliedThrough = decimal(entry.appliedThrough, "sourceCoverageEntry.appliedThrough");
    if (from > appliedThrough || appliedThrough > cutoffNumber) {
      throw new Error("coverage-entry-range-outside-cutoff");
    }
    const rangeMatchesCompleteness = plan.completeness === "complete-snapshot"
      ? from === cutoffNumber && appliedThrough === cutoffNumber
      : plan.completeness === "contiguous-history"
        ? appliedThrough === cutoffNumber
        : plan.completeness === "point-lookup"
          ? from === appliedThrough
          : true;
    if (
      entry.ownerRef !== plan.ownerRef
      || entry.sourcePlanRef !== plan.sourcePlanRef
      || entry.familyDefinitionHash !== plan.familyDefinitionHash
      || entry.completeness !== plan.completeness
      || entry.historyStartBlock !== plan.historyStartBlock
      || entry.cutoffHash !== decodedCertificate.cutoff.hash
      || !rangeMatchesCompleteness
      || (expectedOmission && entry.appliedThrough !== decodedCertificate.cutoff.number)
    ) throw new Error("coverage-entry-lineage-mismatch");
    const previous = entry.previousAppliedThrough === null
      ? null
      : decimal(entry.previousAppliedThrough, "sourceCoverageEntry.previousAppliedThrough");
    if (plan.completeness === "contiguous-history") {
      if (plan.historyStartBlock === null) throw new Error("coverage-history-start-missing");
      const historyStart = decimal(plan.historyStartBlock, "sourcePlanRef.historyStartBlock");
      if (previous === null) {
        if (from !== historyStart) throw new Error("coverage-history-start-gap");
      } else if (previous < historyStart || from !== previous + 1n) {
        throw new Error("coverage-history-cursor-gap");
      }
    } else if (plan.historyStartBlock !== null || previous !== null) {
      throw new Error("coverage-history-anchor-invalid");
    }
    const expectedContribution = plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history";
    if (entry.contributesOmissionAuthority !== expectedContribution) {
      throw new Error("coverage-entry-lineage-mismatch");
    }
  }
  if (seen.size !== plans.size) throw new Error("coverage-source-plan-partition-mismatch");
  const sorted = [...decodedCertificate.entries].sort((left, right) => compareText(
    `${left.ownerRef}:${left.sourcePlanRef}`,
    `${right.ownerRef}:${right.sourcePlanRef}`,
  ));
  if (decodedCertificate.entries.some((entry, index) => entry !== sorted[index])) {
    throw new Error("coverage-entry-order-mismatch");
  }
  const expectedRoot = hashDomain("aloha/source-coverage/v1", { cutoff: decodedCertificate.cutoff, entries: sorted });
  if (expectedRoot !== decodedCertificate.sourceCoverageRoot) throw new Error("source-coverage-root-mismatch");
}
