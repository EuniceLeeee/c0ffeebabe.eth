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
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface CanonicalCutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export type SourceCompletenessV1 = "complete-snapshot" | "contiguous-history" | "point-lookup" | "nomination-only";

export interface SourcePlanRefV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly completeness: SourceCompletenessV1;
  readonly historyStartBlock: string | null;
}

export interface SourcePlanEvidenceRefV1 {
  readonly kind: "source-plan";
  readonly version: 1;
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly evidenceRef: Hash;
  readonly rawLocatorHash: Hash;
}

export interface SourcePlanEvidenceReceiptV1 {
  readonly kind: "source-plan-evidence";
  readonly version: 1;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly refs: readonly SourcePlanEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
  readonly evidenceRoot: Hash;
}

export interface SourcePlanExecutionV1 {
  readonly kind: "source-plan-execution";
  readonly version: 1;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly outcome: "complete" | "positive-only" | "retryable" | "invalid-program";
  readonly from: string;
  readonly through: string;
  readonly previousAppliedThrough: string | null;
  readonly resultPartitionRoot: Hash;
  readonly opaqueResult: CanonicalJson;
  readonly sourceEvidenceRefs: readonly SourcePlanEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
  readonly sourceEvidenceRoot: Hash;
  readonly executionRoot: Hash;
}

export interface SourceCoverageEntryV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly completeness: SourceCompletenessV1;
  readonly historyStartBlock: string | null;
  readonly previousAppliedThrough: string | null;
  readonly cutoffHash: Hash;
  readonly from: string;
  readonly appliedThrough: string;
  readonly resultPartitionRoot: Hash;
  readonly executionRoot: Hash;
  readonly contributesOmissionAuthority: boolean;
}

export interface SourceCoverageCertificateV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly entries: readonly SourceCoverageEntryV1[];
  readonly sourceCoverageRoot: Hash;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const decimal = (value: string, path: string): bigint => BigInt(assertDecimalString(value, path));

function sourceCompleteness(value: unknown, path: string): SourceCompletenessV1 {
  if (value !== "complete-snapshot" && value !== "contiguous-history"
    && value !== "point-lookup" && value !== "nomination-only") {
    throw new TypeError(`${path} has an invalid source completeness`);
  }
  return value;
}

function sourceOutcome(value: unknown, path: string): SourcePlanExecutionV1["outcome"] {
  if (value !== "complete" && value !== "positive-only" && value !== "retryable" && value !== "invalid-program") {
    throw new TypeError(`${path} has an invalid source outcome`);
  }
  return value;
}

function versionOne(value: unknown, path: string): 1 {
  if (value !== 1) throw new TypeError(`${path} has an unsupported version`);
  return 1;
}

export function decodeFullFamilyCanonicalCutoff(value: unknown, path = "canonicalCutoff"): CanonicalCutoffV1 {
  return deepFreeze(decodeExactObject(value, {
    chainId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    number: (field, itemPath) => assertDecimalString(field, itemPath),
    hash: (field, itemPath) => assertHash(field, itemPath),
    stateRoot: (field, itemPath) => assertHash(field, itemPath),
  }, path));
}

export function decodeFullFamilySourcePlanRef(value: unknown, path = "sourcePlanRef"): SourcePlanRefV1 {
  return deepFreeze(decodeExactObject(value, {
    ownerRef: (field, itemPath) => assertHash(field, itemPath),
    sourcePlanRef: (field, itemPath) => assertHash(field, itemPath),
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    completeness: sourceCompleteness,
    historyStartBlock: (field, itemPath) => field === null ? null : assertDecimalString(field, itemPath),
  }, path));
}

export function fullFamilySourcePlanIdentity(value: Pick<SourcePlanRefV1, "ownerRef" | "sourcePlanRef">): Hash {
  return hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: assertHash(value.ownerRef, "sourcePlanIdentity.ownerRef"),
    sourcePlanRef: assertHash(value.sourcePlanRef, "sourcePlanIdentity.sourcePlanRef"),
  });
}

function decodeEvidenceRef(value: unknown, path: string): SourcePlanEvidenceRefV1 {
  return deepFreeze(decodeExactObject(value, {
    kind: (field, itemPath) => field === "source-plan" ? ("source-plan" as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: versionOne,
    ownerRef: (field, itemPath) => assertHash(field, itemPath),
    sourcePlanRef: (field, itemPath) => assertHash(field, itemPath),
    evidenceRef: (field, itemPath) => assertHash(field, itemPath),
    rawLocatorHash: (field, itemPath) => assertHash(field, itemPath),
  }, path));
}

function sourceEvidenceRoot(input: Omit<SourcePlanEvidenceReceiptV1, "evidenceRoot">): Hash {
  const refKeys = input.refs.map(ref => hashDomain("aloha/source-plan-evidence-ref/v1", ref));
  if (new Set(refKeys).size !== refKeys.length || refKeys.some((key, index) => index > 0 && refKeys[index - 1]! >= key)) {
    throw new TypeError("source-plan evidence refs are not unique canonical order");
  }
  if (new Set(input.rawLocatorHashes).size !== input.rawLocatorHashes.length
    || input.rawLocatorHashes.some((hash, index) => index > 0 && input.rawLocatorHashes[index - 1]! >= hash)) {
    throw new TypeError("source-plan evidence locators are not unique canonical order");
  }
  for (const ref of input.refs) {
    if (ref.ownerRef !== input.plan.ownerRef || ref.sourcePlanRef !== input.plan.sourcePlanRef
      || !input.rawLocatorHashes.includes(ref.rawLocatorHash)) throw new TypeError("source-plan evidence ref lineage mismatch");
  }
  return hashDomain("aloha/source-plan-evidence/v1", input);
}

export function decodeFullFamilySourcePlanEvidenceReceipt(
  value: unknown,
  path = "sourcePlanEvidence",
): SourcePlanEvidenceReceiptV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, itemPath) => field === "source-plan-evidence" ? ("source-plan-evidence" as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: versionOne,
    plan: (field, itemPath) => decodeFullFamilySourcePlanRef(field, itemPath),
    cutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    refs: (field, itemPath) => fieldArray(field, (entry, entryPath) => decodeEvidenceRef(entry, entryPath), itemPath),
    rawLocatorHashes: (field, itemPath) => fieldArray(field, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    evidenceRoot: (field, itemPath) => assertHash(field, itemPath),
  }, path);
  const { evidenceRoot, ...withoutRoot } = decoded;
  if (evidenceRoot !== sourceEvidenceRoot(withoutRoot)) throw new TypeError(`${path}.evidenceRoot mismatch`);
  return deepFreeze(decoded);
}

function sourceExecutionRoot(input: Omit<SourcePlanExecutionV1, "executionRoot">): Hash {
  const expectedEvidenceRoot = sourceEvidenceRoot({
    kind: "source-plan-evidence",
    version: 1,
    plan: input.plan,
    cutoff: input.cutoff,
    refs: input.sourceEvidenceRefs,
    rawLocatorHashes: input.rawLocatorHashes,
  });
  if (input.sourceEvidenceRoot !== expectedEvidenceRoot) throw new TypeError("source-plan execution evidence root mismatch");
  return hashDomain("aloha/source-plan-execution/v1", input);
}

export function decodeFullFamilySourcePlanExecution(value: unknown, path = "sourcePlanExecution"): SourcePlanExecutionV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, itemPath) => field === "source-plan-execution" ? ("source-plan-execution" as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: versionOne,
    plan: (field, itemPath) => decodeFullFamilySourcePlanRef(field, itemPath),
    cutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    outcome: sourceOutcome,
    from: (field, itemPath) => assertDecimalString(field, itemPath),
    through: (field, itemPath) => assertDecimalString(field, itemPath),
    previousAppliedThrough: (field, itemPath) => field === null ? null : assertDecimalString(field, itemPath),
    resultPartitionRoot: (field, itemPath) => assertHash(field, itemPath),
    opaqueResult: field => decodeCanonicalJson(encodeCanonicalJson(field)),
    sourceEvidenceRefs: (field, itemPath) => fieldArray(field, (entry, entryPath) => decodeEvidenceRef(entry, entryPath), itemPath),
    rawLocatorHashes: (field, itemPath) => fieldArray(field, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    sourceEvidenceRoot: (field, itemPath) => assertHash(field, itemPath),
    executionRoot: (field, itemPath) => assertHash(field, itemPath),
  }, path);
  const { executionRoot, ...withoutRoot } = decoded;
  if (executionRoot !== sourceExecutionRoot(withoutRoot)) throw new TypeError(`${path}.executionRoot mismatch`);
  return deepFreeze(decoded);
}

function coverageEntry(execution: SourcePlanExecutionV1): SourceCoverageEntryV1 {
  const cutoffNumber = decimal(execution.cutoff.number, "coverage.cutoff.number");
  const from = decimal(execution.from, "coverage.from");
  const through = decimal(execution.through, "coverage.through");
  if (from > through || through > cutoffNumber || execution.outcome === "retryable" || execution.outcome === "invalid-program") {
    throw new TypeError("source execution cannot authorize coverage");
  }
  let contributesOmissionAuthority = false;
  switch (execution.plan.completeness) {
    case "complete-snapshot":
      if (execution.plan.historyStartBlock !== null || execution.previousAppliedThrough !== null
        || execution.outcome !== "complete" || from !== cutoffNumber || through !== cutoffNumber) {
        throw new TypeError("incomplete snapshot coverage");
      }
      contributesOmissionAuthority = true;
      break;
    case "contiguous-history": {
      if (execution.outcome !== "complete" || through !== cutoffNumber || execution.plan.historyStartBlock === null) {
        throw new TypeError("incomplete history coverage");
      }
      const historyStart = decimal(execution.plan.historyStartBlock, "coverage.historyStartBlock");
      const previous = execution.previousAppliedThrough === null ? null : decimal(execution.previousAppliedThrough, "coverage.previousAppliedThrough");
      if ((previous === null && from !== historyStart) || (previous !== null && (previous < historyStart || from !== previous + 1n))) {
        throw new TypeError("history coverage gap");
      }
      contributesOmissionAuthority = true;
      break;
    }
    case "point-lookup":
      if (execution.plan.historyStartBlock !== null || execution.previousAppliedThrough !== null
        || execution.outcome !== "complete" || from !== through) throw new TypeError("invalid point lookup coverage");
      break;
    case "nomination-only":
      if (execution.plan.historyStartBlock !== null || execution.previousAppliedThrough !== null
        || (execution.outcome !== "positive-only" && execution.outcome !== "complete")) {
        throw new TypeError("invalid nomination-only coverage");
      }
      break;
  }
  return deepFreeze({
    ownerRef: execution.plan.ownerRef,
    sourcePlanRef: execution.plan.sourcePlanRef,
    familyDefinitionHash: execution.plan.familyDefinitionHash,
    completeness: execution.plan.completeness,
    historyStartBlock: execution.plan.historyStartBlock,
    previousAppliedThrough: execution.previousAppliedThrough,
    cutoffHash: execution.cutoff.hash,
    from: execution.from,
    appliedThrough: execution.through,
    resultPartitionRoot: execution.resultPartitionRoot,
    executionRoot: execution.executionRoot,
    contributesOmissionAuthority,
  });
}

function decodeCoverageEntry(value: unknown, path: string): SourceCoverageEntryV1 {
  return deepFreeze(decodeExactObject(value, {
    ownerRef: (field, itemPath) => assertHash(field, itemPath),
    sourcePlanRef: (field, itemPath) => assertHash(field, itemPath),
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    completeness: sourceCompleteness,
    historyStartBlock: (field, itemPath) => field === null ? null : assertDecimalString(field, itemPath),
    previousAppliedThrough: (field, itemPath) => field === null ? null : assertDecimalString(field, itemPath),
    cutoffHash: (field, itemPath) => assertHash(field, itemPath),
    from: (field, itemPath) => assertDecimalString(field, itemPath),
    appliedThrough: (field, itemPath) => assertDecimalString(field, itemPath),
    resultPartitionRoot: (field, itemPath) => assertHash(field, itemPath),
    executionRoot: (field, itemPath) => assertHash(field, itemPath),
    contributesOmissionAuthority: (field, itemPath) => {
      if (typeof field !== "boolean") throw new TypeError(`${itemPath} must be boolean`);
      return field;
    },
  }, path));
}

export function sealFullFamilySourceCoverage(
  cutoffValue: CanonicalCutoffV1,
  planValues: readonly SourcePlanRefV1[],
  executionValues: readonly SourcePlanExecutionV1[],
): SourceCoverageCertificateV1 {
  const cutoff = decodeFullFamilyCanonicalCutoff(cutoffValue, "coverage.cutoff");
  const plans = planValues.map((value, index) => decodeFullFamilySourcePlanRef(value, `coverage.plans[${index}]`));
  const executions = executionValues.map((value, index) => decodeFullFamilySourcePlanExecution(value, `coverage.executions[${index}]`));
  const planById = new Map(plans.map(plan => [fullFamilySourcePlanIdentity(plan), plan]));
  if (planById.size !== plans.length) throw new TypeError("duplicate declared source plan");
  const seen = new Set<Hash>();
  const entries = executions.map(execution => {
    const identity = fullFamilySourcePlanIdentity(execution.plan);
    const plan = planById.get(identity);
    if (plan === undefined || seen.has(identity) || encodeCanonicalJson(plan) !== encodeCanonicalJson(execution.plan)
      || encodeCanonicalJson(execution.cutoff) !== encodeCanonicalJson(cutoff)) throw new TypeError("source coverage execution mismatch");
    seen.add(identity);
    return coverageEntry(execution);
  }).sort((left, right) => compareText(fullFamilySourcePlanIdentity(left), fullFamilySourcePlanIdentity(right)));
  if (seen.size !== plans.length) throw new TypeError("source coverage execution denominator mismatch");
  return deepFreeze({ cutoff, entries, sourceCoverageRoot: hashDomain("aloha/source-coverage/v1", { cutoff, entries }) });
}

export function validateFullFamilySourceCoverage(
  value: SourceCoverageCertificateV1,
  planValues: readonly SourcePlanRefV1[],
): SourceCoverageCertificateV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (field, path) => decodeFullFamilyCanonicalCutoff(field, path),
    entries: (field, path) => fieldArray(field, (entry, entryPath) => decodeCoverageEntry(entry, entryPath), path),
    sourceCoverageRoot: (field, path) => assertHash(field, path),
  }, "sourceCoverageCertificate");
  const plans = planValues.map((plan, index) => decodeFullFamilySourcePlanRef(plan, `declaredSourcePlans[${index}]`));
  const planById = new Map(plans.map(plan => [fullFamilySourcePlanIdentity(plan), plan]));
  if (planById.size !== plans.length || decoded.entries.length !== plans.length) throw new TypeError("source coverage denominator mismatch");
  const seen = new Set<Hash>();
  const cutoffNumber = decimal(decoded.cutoff.number, "sourceCoverage.cutoff.number");
  for (const entry of decoded.entries) {
    const identity = fullFamilySourcePlanIdentity(entry);
    const plan = planById.get(identity);
    if (plan === undefined || seen.has(identity)) throw new TypeError("source coverage plan mismatch");
    seen.add(identity);
    const from = decimal(entry.from, "sourceCoverage.from");
    const through = decimal(entry.appliedThrough, "sourceCoverage.appliedThrough");
    const previous = entry.previousAppliedThrough === null ? null : decimal(entry.previousAppliedThrough, "sourceCoverage.previousAppliedThrough");
    const authoritative = plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history";
    const rangeMatches = plan.completeness === "complete-snapshot"
      ? from === cutoffNumber && through === cutoffNumber
      : plan.completeness === "contiguous-history" ? through === cutoffNumber
        : plan.completeness === "point-lookup" ? from === through : true;
    if (from > through || through > cutoffNumber || entry.familyDefinitionHash !== plan.familyDefinitionHash
      || entry.completeness !== plan.completeness || entry.historyStartBlock !== plan.historyStartBlock
      || entry.cutoffHash !== decoded.cutoff.hash || !rangeMatches
      || entry.contributesOmissionAuthority !== authoritative) throw new TypeError("source coverage entry lineage mismatch");
    if (plan.completeness === "contiguous-history") {
      if (plan.historyStartBlock === null) throw new TypeError("source coverage history start missing");
      const start = decimal(plan.historyStartBlock, "sourceCoverage.historyStartBlock");
      if ((previous === null && from !== start) || (previous !== null && (previous < start || from !== previous + 1n))) {
        throw new TypeError("source coverage history gap");
      }
    } else if (plan.historyStartBlock !== null || previous !== null) throw new TypeError("source coverage history anchor invalid");
  }
  if (decoded.entries.some((entry, index) => index > 0
    && fullFamilySourcePlanIdentity(decoded.entries[index - 1]!) >= fullFamilySourcePlanIdentity(entry))) {
    throw new TypeError("source coverage order mismatch");
  }
  if (decoded.sourceCoverageRoot !== hashDomain("aloha/source-coverage/v1", { cutoff: decoded.cutoff, entries: decoded.entries })) {
    throw new TypeError("source coverage root mismatch");
  }
  return deepFreeze(decoded);
}
