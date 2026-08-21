import {
  deepFreeze,
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

const decimal = (value: string, name: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} must be canonical decimal`);
  return BigInt(value);
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function assertExactRecord(value: object, expected: readonly string[], name: string): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) throw new TypeError(`${name} has symbol fields`);
  const actual = (keys as string[]).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${name} has unknown or missing fields`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${name}.${key} is not data`);
  }
}

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

export function mergeAndDedupeNominations(
  nominations: readonly CandidateNominationV1[],
): readonly CandidateRecordV1[] {
  const groups = new Map<Hash, {
    nomination: CandidateNominationV1;
    evidence: Map<Hash, CandidateEvidenceRefV1>;
  }>();

  for (const nomination of nominations) {
    assertExactRecord(nomination, [
      "familyId",
      "familyDefinitionHash",
      "instanceNominationKey",
      "candidateSnapshotHash",
      "evidence",
    ], "candidateNomination");
    assertExactRecord(nomination.evidence, [
      "blockNumber",
      "blockHash",
      "txHash",
      "logIndex",
      "address",
      "topic",
      "rawLocatorHash",
    ], "candidateEvidence");
    if (nomination.familyId.length === 0) throw new TypeError("familyId is empty");
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

function coverageEntry(execution: SourcePlanExecutionV1): SourceCoverageEntryV1 {
  assertExactRecord(execution, [
    "plan", "cutoff", "outcome", "from", "through", "previousAppliedThrough", "resultPartitionRoot",
  ], "sourcePlanExecution");
  assertExactRecord(execution.plan, [
    "ownerRef", "sourcePlanRef", "familyDefinitionHash", "completeness",
  ], "sourcePlanRef");
  assertExactRecord(execution.cutoff, ["chainId", "number", "hash", "stateRoot"], "canonicalCutoff");
  if (
    execution.cutoff.hash.length === 0
    || execution.cutoff.stateRoot.length === 0
    || execution.plan.ownerRef.length === 0
    || execution.plan.sourcePlanRef.length === 0
  ) throw new TypeError("coverage identity is incomplete");

  const cutoff = decimal(execution.cutoff.number, "cutoff.number");
  const from = decimal(execution.from, "from");
  const through = decimal(execution.through, "through");
  if (from > through || through > cutoff) throw new Error("source-range-outside-cutoff");
  if (execution.outcome === "retryable") throw new Error("source-retryable");
  if (execution.outcome === "invalid-program") throw new Error("source-invalid-program");

  let contributesOmissionAuthority = false;
  switch (execution.plan.completeness) {
    case "complete-snapshot":
      if (execution.outcome !== "complete" || from !== cutoff || through !== cutoff) {
        throw new Error("incomplete-snapshot-coverage");
      }
      contributesOmissionAuthority = true;
      break;
    case "contiguous-history": {
      if (execution.outcome !== "complete" || through !== cutoff) {
        throw new Error("incomplete-history-coverage");
      }
      const previous = execution.previousAppliedThrough === null
        ? null
        : decimal(execution.previousAppliedThrough, "previousAppliedThrough");
      if (previous !== null && from !== previous + 1n) throw new Error("history-cursor-gap");
      contributesOmissionAuthority = true;
      break;
    }
    case "point-lookup":
      if (execution.outcome !== "complete") throw new Error("point-lookup-incomplete");
      break;
    case "nomination-only":
      if (execution.outcome !== "positive-only" && execution.outcome !== "complete") {
        throw new Error("nomination-only-incomplete");
      }
      break;
  }

  return deepFreeze({
    ownerRef: execution.plan.ownerRef,
    sourcePlanRef: execution.plan.sourcePlanRef,
    familyDefinitionHash: execution.plan.familyDefinitionHash,
    completeness: execution.plan.completeness,
    cutoffHash: execution.cutoff.hash,
    from: execution.from,
    appliedThrough: execution.through,
    resultPartitionRoot: execution.resultPartitionRoot,
    contributesOmissionAuthority,
  });
}

export function sealSourceCoverage(
  cutoff: CanonicalCutoffV1,
  declaredPlans: readonly SourcePlanRefV1[],
  executions: readonly SourcePlanExecutionV1[],
): SourceCoverageCertificateV1 {
  const declared = new Map<string, SourcePlanRefV1>();
  for (const plan of declaredPlans) {
    assertExactRecord(plan, ["ownerRef", "sourcePlanRef", "familyDefinitionHash", "completeness"], "declaredSourcePlan");
    const identity = `${plan.ownerRef}:${plan.sourcePlanRef}`;
    if (declared.has(identity)) throw new Error(`duplicate-declared-source-plan:${identity}`);
    declared.set(identity, plan);
  }
  const seen = new Set<string>();
  const entries = executions.map(execution => {
    if (
      execution.cutoff.chainId !== cutoff.chainId
      || execution.cutoff.number !== cutoff.number
      || execution.cutoff.hash !== cutoff.hash
      || execution.cutoff.stateRoot !== cutoff.stateRoot
    ) throw new Error("coverage-cutoff-mismatch");
    const identity = `${execution.plan.ownerRef}:${execution.plan.sourcePlanRef}`;
    if (seen.has(identity)) throw new Error(`duplicate-source-partition:${identity}`);
    const expectedPlan = declared.get(identity);
    if (
      !expectedPlan
      || expectedPlan.familyDefinitionHash !== execution.plan.familyDefinitionHash
      || expectedPlan.completeness !== execution.plan.completeness
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
  const sourceCoverageRoot = hashDomain("aloha/source-coverage/v1", { cutoff, entries });
  return deepFreeze({ cutoff: deepFreeze({ ...cutoff }), entries, sourceCoverageRoot });
}

export function candidatePartitionRoot(records: readonly CandidateRecordV1[]): Hash {
  for (const record of records) {
    assertExactRecord(record, [
      "familyId",
      "familyDefinitionHash",
      "instanceNominationKey",
      "familyCandidateKey",
      "candidateSnapshotHash",
      "evidence",
    ], "candidateRecord");
    if (
      record.familyId.length === 0
      || record.familyCandidateKey !== familyCandidateKey(record.familyDefinitionHash, record.instanceNominationKey)
      || record.evidence.length === 0
    ) throw new Error("candidate-record-lineage-mismatch");
    const evidenceKeys = record.evidence.map(value => {
      assertExactRecord(value, [
        "blockNumber", "blockHash", "txHash", "logIndex", "address", "topic", "rawLocatorHash",
      ], "candidateEvidence");
      return evidenceKey(value);
    });
    if (new Set(evidenceKeys).size !== evidenceKeys.length) throw new Error("duplicate-candidate-evidence");
    const sortedEvidenceKeys = [...evidenceKeys].sort(compareText);
    if (evidenceKeys.some((key, index) => key !== sortedEvidenceKeys[index])) {
      throw new Error("candidate-evidence-not-canonical-order");
    }
  }
  const keys = records.map(record => record.familyCandidateKey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate-candidate-record");
  const sorted = [...records].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  return hashDomain("aloha/candidate-partition/v1", sorted);
}

export function sourcePlanSetRoot(plans: readonly SourcePlanRefV1[]): Hash {
  const identities = new Set<string>();
  const sorted = plans.map(plan => {
    assertExactRecord(plan, ["ownerRef", "sourcePlanRef", "familyDefinitionHash", "completeness"], "sourcePlanRef");
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
  assertExactRecord(certificate, ["cutoff", "entries", "sourceCoverageRoot"], "sourceCoverageCertificate");
  assertExactRecord(certificate.cutoff, ["chainId", "number", "hash", "stateRoot"], "coverageCutoff");
  const plans = new Map(declaredPlans.map(plan => [`${plan.ownerRef}:${plan.sourcePlanRef}`, plan]));
  if (plans.size !== declaredPlans.length) throw new Error("duplicate-declared-source-plan");
  const seen = new Set<string>();
  for (const entry of certificate.entries) {
    assertExactRecord(entry, [
      "ownerRef",
      "sourcePlanRef",
      "familyDefinitionHash",
      "completeness",
      "cutoffHash",
      "from",
      "appliedThrough",
      "resultPartitionRoot",
      "contributesOmissionAuthority",
    ], "sourceCoverageEntry");
    const identity = `${entry.ownerRef}:${entry.sourcePlanRef}`;
    const plan = plans.get(identity);
    if (!plan || seen.has(identity)) throw new Error("coverage-source-plan-partition-mismatch");
    seen.add(identity);
    const expectedOmission = plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history";
    if (
      entry.familyDefinitionHash !== plan.familyDefinitionHash
      || entry.completeness !== plan.completeness
      || entry.cutoffHash !== certificate.cutoff.hash
      || entry.contributesOmissionAuthority !== expectedOmission
      || (expectedOmission && entry.appliedThrough !== certificate.cutoff.number)
    ) throw new Error("coverage-entry-lineage-mismatch");
  }
  if (seen.size !== plans.size) throw new Error("coverage-source-plan-partition-mismatch");
  const sorted = [...certificate.entries].sort((left, right) => compareText(
    `${left.ownerRef}:${left.sourcePlanRef}`,
    `${right.ownerRef}:${right.sourcePlanRef}`,
  ));
  const expectedRoot = hashDomain("aloha/source-coverage/v1", { cutoff: certificate.cutoff, entries: sorted });
  if (expectedRoot !== certificate.sourceCoverageRoot) throw new Error("source-coverage-root-mismatch");
}
