import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  fieldNumber,
  hashCanonicalPartition,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type CanonicalJson,
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

export const SOURCE_EVIDENCE_VERSION_V1 = 1 as const;

/**
 * Raw locator bytes are kept outside canonical JSON. Consumers must validate
 * the content hash before using them; only the hash enters canonical roots.
 */
export interface RawEvidenceLocatorContentV1 {
  readonly kind: "raw-evidence-locator";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly rawLocatorHash: Hash;
  readonly bytes: Uint8Array;
}

export interface RecentLogEvidenceRefV1 {
  readonly kind: "recent-log";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly sourcePlanRef: null;
  readonly ownerRef: null;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly address: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}

/** Opaque source-plan evidence; it is not a recent log and has no fake tx. */
export interface SourcePlanEvidenceRefV1 {
  readonly kind: "source-plan";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly evidenceRef: Hash;
  readonly rawLocatorHash: Hash;
}

export type CandidateEvidenceRefV1 = RecentLogEvidenceRefV1 | SourcePlanEvidenceRefV1;

export interface SourcePlanEvidenceReceiptV1 {
  readonly kind: "source-plan-evidence";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly refs: readonly SourcePlanEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
  readonly evidenceRoot: Hash;
}

/**
 * Static Family-owned source semantics imported by generated composition.
 * Execution ports are joined separately by the release owner; this value is
 * data only and therefore cannot mint coverage or candidate authority.
 */
export interface FamilySourcePlanDefinitionV1 {
  readonly sourcePlanId: string;
  readonly completeness: SourceCompleteness;
  readonly historyStartBlock: string | null;
  readonly schemaHash: Hash;
}

export interface SourcePlanExecutionV1 {
  readonly kind: "source-plan-execution";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly outcome: "complete" | "positive-only" | "retryable" | "invalid-program";
  readonly from: string;
  readonly through: string;
  readonly previousAppliedThrough: string | null;
  readonly resultPartitionRoot: Hash;
  /** Exact opaque result; central discovery never interprets its meaning. */
  readonly opaqueResult: CanonicalJson;
  readonly sourceEvidenceRefs: readonly SourcePlanEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
  readonly sourceEvidenceRoot: Hash;
  /** Binds every execution field, opaque result and source evidence refs. */
  readonly executionRoot: Hash;
}

/**
 * Checkpoint-owned durable binding for one Family-produced logical execution.
 *
 * The Family owns the opaque partition semantics above, but it cannot mint a
 * reusable cursor.  Only the release discovery owner can join that execution
 * to the exact generated plan leaf, physical source authority/release anchor,
 * and a root-reachable predecessor execution.
 */
export interface PersistedSourcePlanExecutionV1 {
  readonly kind: "persisted-source-plan-execution";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly execution: SourcePlanExecutionV1;
  readonly sourcePlanLeafDigest: Hash;
  readonly sourcePlanSchemaHash: Hash;
  readonly sourcePlanClosureRoot: Hash;
  readonly sourceAuthorityRoot: Hash;
  readonly releaseBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly sourceAnchorRoot: Hash;
  readonly previousExecutionRoot: Hash | null;
  readonly persistedExecutionRoot: Hash;
}

export interface PersistedSourcePlanExecutionSetV1 {
  readonly kind: "persisted-source-plan-execution-set";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly cutoff: CanonicalCutoffV1;
  readonly executions: readonly PersistedSourcePlanExecutionV1[];
  readonly executionSetRoot: Hash;
}

/**
 * Seal the mechanical execution record for a nomination-only source.
 *
 * Nomination-only plans do not own a caller-supplied physical result and do
 * not publish source-plan evidence.  The only observation window is the
 * shared, exact recent window; Family code owns the later topic/address
 * routing and candidate meaning.  Keeping this constructor here makes that
 * distinction structural instead of relying on every Family to reproduce
 * the same empty-evidence/root rules.
 */
export function sealNominationOnlySourceExecution(input: {
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly previousAppliedThrough: string | null;
}): {
  readonly execution: SourcePlanExecutionV1;
  readonly sourceEvidence: SourcePlanEvidenceReceiptV1;
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
} {
  const plan = decodeSourcePlanRef(input.plan, "nominationOnly.plan");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "nominationOnly.cutoff");
  if (plan.completeness !== "nomination-only" || plan.historyStartBlock !== null) {
    throw new TypeError("nomination-only execution requires a nomination-only plan");
  }
  if (input.previousAppliedThrough !== null) {
    throw new TypeError("nomination-only execution cannot advance a source cursor");
  }
  const range = recentObservationRange(cutoff.number);
  const sourceEvidence: SourcePlanEvidenceReceiptV1 = deepFreeze({
    kind: "source-plan-evidence",
    version: SOURCE_EVIDENCE_VERSION_V1,
    plan,
    cutoff,
    refs: Object.freeze([]),
    rawLocatorHashes: Object.freeze([]),
    evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff, refs: [], rawLocatorHashes: [] }),
  });
  const opaqueResult: CanonicalJson = deepFreeze({
    kind: "nomination-only-recent-observation",
    version: 1,
    cutoffHash: cutoff.hash,
    from: range.from,
    through: range.to,
  });
  const resultPartitionRoot = hashDomain("aloha/nomination-only-source-partition/v1", {
    plan,
    cutoff,
    range,
    opaqueResult,
  });
  const withoutRoot: Omit<SourcePlanExecutionV1, "executionRoot"> = {
    kind: "source-plan-execution",
    version: SOURCE_EVIDENCE_VERSION_V1,
    plan,
    cutoff,
    outcome: "complete",
    from: range.from,
    through: range.to,
    previousAppliedThrough: null,
    resultPartitionRoot,
    opaqueResult,
    sourceEvidenceRefs: Object.freeze([]),
    rawLocatorHashes: Object.freeze([]),
    sourceEvidenceRoot: sourceEvidence.evidenceRoot,
  };
  const execution = deepFreeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) });
  return deepFreeze({ execution, sourceEvidence, rawEvidenceLocators: Object.freeze([]) });
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
  readonly executionRoot: Hash;
  readonly contributesOmissionAuthority: boolean;
}

export interface SourceCoverageCertificateV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly entries: readonly SourceCoverageEntryV1[];
  readonly sourceCoverageRoot: Hash;
}

export interface CandidateNominationV1 {
  readonly kind: "aloha.candidate-nomination";
  readonly version: "2";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly evidence: CandidateEvidenceRefV1;
}

export interface CandidateRecordV1 {
  readonly kind: "aloha.candidate-record";
  readonly version: "2";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
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

const evidenceVersion = (value: unknown, path: string): typeof SOURCE_EVIDENCE_VERSION_V1 => {
  if (fieldNumber(value, path) !== SOURCE_EVIDENCE_VERSION_V1) {
    throw new TypeError(`${path} has an unsupported source-evidence version`);
  }
  return SOURCE_EVIDENCE_VERSION_V1;
};

const exactRawBytes = (value: unknown, path: string): Uint8Array => {
  if (
    !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || value.byteLength === 0
  ) throw new TypeError(`${path} must be a non-empty concrete Uint8Array`);
  return new Uint8Array(value);
};

export function decodeRawEvidenceLocatorContent(
  value: unknown,
  name = "rawEvidenceLocator",
): RawEvidenceLocatorContentV1 {
  assertExactKeys(value, ["kind", "version", "rawLocatorHash", "bytes"], name);
  const kind = readOwnEnumerableDataProperty(value, "kind", name);
  if (kind !== "raw-evidence-locator") throw new TypeError(`${name}.kind is invalid`);
  const version = evidenceVersion(readOwnEnumerableDataProperty(value, "version", name), `${name}.version`);
  const rawLocatorHash = assertHash(readOwnEnumerableDataProperty(value, "rawLocatorHash", name), `${name}.rawLocatorHash`);
  const bytes = exactRawBytes(readOwnEnumerableDataProperty(value, "bytes", name), `${name}.bytes`);
  if (sha256Hex(bytes) !== rawLocatorHash) throw new TypeError(`${name}.bytes hash mismatch`);
  return Object.freeze({ kind: "raw-evidence-locator", version, rawLocatorHash, bytes });
}

export function validateRawEvidenceLocatorContents(
  values: readonly RawEvidenceLocatorContentV1[],
  expectedHashes: readonly Hash[],
  name = "rawEvidenceLocators",
): readonly RawEvidenceLocatorContentV1[] {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  if (!Array.isArray(expectedHashes)) throw new TypeError(`${name}.expectedHashes must be an array`);
  const expected = expectedHashes.map((value, index) => assertHash(value, `${name}.expectedHashes[${index}]`));
  if (new Set(expected).size !== expected.length) throw new TypeError(`${name}.expectedHashes contains duplicates`);
  const decoded = values.map((value, index) => decodeRawEvidenceLocatorContent(value, `${name}[${index}]`));
  if (new Set(decoded.map(value => value.rawLocatorHash)).size !== decoded.length) {
    throw new TypeError(`${name} contains duplicate locators`);
  }
  const actualInOrder = decoded.map(value => value.rawLocatorHash);
  const actual = [...actualInOrder].sort(compareText);
  if (actualInOrder.some((hash, index) => hash !== actual[index])) throw new TypeError(`${name} is not in canonical locator order`);
  const sortedExpected = [...expected].sort(compareText);
  if (expected.some((hash, index) => hash !== sortedExpected[index])) throw new TypeError(`${name}.expectedHashes is not in canonical locator order`);
  if (actual.length !== sortedExpected.length || actual.some((hash, index) => hash !== sortedExpected[index])) {
    throw new TypeError(`${name} does not exactly match the declared locator hashes`);
  }
  return Object.freeze(decoded.slice().sort((left, right) => compareText(left.rawLocatorHash, right.rawLocatorHash)));
}

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
  if (value === null || typeof value !== "object") throw new TypeError(`${name} must be an object`);
  const kind = readOwnEnumerableDataProperty(value, "kind", name);
  if (kind === "recent-log") {
    return decodeExactObject(value, {
      kind: (field, path) => field === "recent-log" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
      version: evidenceVersion,
      sourcePlanRef: (field, path) => field === null ? null : (() => { throw new TypeError(`${path} must be null for recent-log`); })(),
      ownerRef: (field, path) => field === null ? null : (() => { throw new TypeError(`${path} must be null for recent-log`); })(),
      blockNumber: (field, path) => assertDecimalString(field, path),
      blockHash: (field, path) => assertHash(field, path),
      txHash: (field, path) => assertHash(field, path),
      logIndex: (field, path) => assertDecimalString(field, path),
      address: (field, path) => assertNonEmptyString(field, path),
      topic: (field, path) => assertHash(field, path),
      rawLocatorHash: (field, path) => assertHash(field, path),
    }, name);
  }
  if (kind === "source-plan") return decodeSourcePlanEvidenceRef(value, name);
  throw new TypeError(`${name}.kind is invalid`);
}

export function decodeRecentLogEvidenceRef(
  value: unknown,
  name = "recentLogEvidence",
): RecentLogEvidenceRefV1 {
  const decoded = decodeCandidateEvidenceRef(value, name);
  if (decoded.kind !== "recent-log") throw new TypeError(`${name} must be recent-log evidence`);
  return decoded;
}

export function validateCandidateEvidenceRef(value: CandidateEvidenceRefV1, name = "candidateEvidence"): void {
  decodeCandidateEvidenceRef(value, name);
}

export function decodeSourcePlanEvidenceRef(
  value: unknown,
  name = "sourcePlanEvidenceRef",
): SourcePlanEvidenceRefV1 {
  return decodeExactObject(value, {
    kind: (field, path) => field === "source-plan" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: evidenceVersion,
    ownerRef: (field, path) => assertHash(field, path),
    sourcePlanRef: (field, path) => assertHash(field, path),
    evidenceRef: (field, path) => assertHash(field, path),
    rawLocatorHash: (field, path) => assertHash(field, path),
  }, name);
}

const sourceEvidenceRefKey = (value: SourcePlanEvidenceRefV1): Hash => hashDomain(
  "aloha/source-plan-evidence-ref/v1",
  value,
);

const sourceEvidenceRootPayload = (
  plan: SourcePlanRefV1,
  cutoff: CanonicalCutoffV1,
  refs: readonly SourcePlanEvidenceRefV1[],
  rawLocatorHashes: readonly Hash[],
): Omit<SourcePlanEvidenceReceiptV1, "evidenceRoot"> => ({
  kind: "source-plan-evidence" as const,
  version: SOURCE_EVIDENCE_VERSION_V1,
  plan,
  cutoff,
  refs,
  rawLocatorHashes,
});

export function sourcePlanEvidenceRoot(input: {
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly refs: readonly SourcePlanEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
}): Hash {
  const plan = decodeSourcePlanRef(input.plan, "sourcePlanEvidence.plan");
  const cutoff = decodeCanonicalCutoff(input.cutoff, "sourcePlanEvidence.cutoff");
  const refs = fieldArray(input.refs, (value, path) => decodeSourcePlanEvidenceRef(value, path), "sourcePlanEvidence.refs");
  const rawLocatorHashes = fieldArray(input.rawLocatorHashes, (value, path) => assertHash(value, path), "sourcePlanEvidence.rawLocatorHashes");
  const refKeys = refs.map(sourceEvidenceRefKey);
  if (new Set(refKeys).size !== refKeys.length) throw new TypeError("source-plan evidence refs contain duplicates");
  if (refKeys.some((key, index, all) => index > 0 && all[index - 1]! >= key)) throw new TypeError("source-plan evidence refs are not canonical order");
  if (new Set(rawLocatorHashes).size !== rawLocatorHashes.length) throw new TypeError("source-plan evidence locators contain duplicates");
  const sortedLocators = [...rawLocatorHashes].sort(compareText);
  if (rawLocatorHashes.some((hash, index) => hash !== sortedLocators[index])) throw new TypeError("source-plan evidence locators are not canonical order");
  for (const ref of refs) {
    if (ref.ownerRef !== plan.ownerRef || ref.sourcePlanRef !== plan.sourcePlanRef) throw new TypeError("source-plan evidence ref plan mismatch");
    if (!rawLocatorHashes.includes(ref.rawLocatorHash)) throw new TypeError("source-plan evidence ref locator is not declared");
  }
  return hashDomain("aloha/source-plan-evidence/v1", sourceEvidenceRootPayload(plan, cutoff, refs, rawLocatorHashes));
}

const decodeSourcePlanEvidenceReceiptValue = (
  value: unknown,
  name = "sourcePlanEvidence",
): SourcePlanEvidenceReceiptV1 => {
  const decoded = decodeExactObject(value, {
    kind: (field, path) => field === "source-plan-evidence" ? ("source-plan-evidence" as const) : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: evidenceVersion,
    plan: (field, path) => decodeSourcePlanRef(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    refs: (field, path) => fieldArray(field, (item, itemPath) => decodeSourcePlanEvidenceRef(item, itemPath), path),
    rawLocatorHashes: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
    evidenceRoot: (field, path) => assertHash(field, path),
  }, name);
  const expectedRoot = sourcePlanEvidenceRoot(decoded);
  if (expectedRoot !== decoded.evidenceRoot) throw new TypeError(`${name}.evidenceRoot mismatch`);
  return decoded;
};

export function decodeSourcePlanEvidenceReceipt(
  value: unknown,
  name = "sourcePlanEvidence",
): SourcePlanEvidenceReceiptV1 {
  return decodeSourcePlanEvidenceReceiptValue(value, name);
}

function executionRootPayload(value: Omit<SourcePlanExecutionV1, "executionRoot">) {
  return {
    kind: "source-plan-execution" as const,
    version: value.version,
    plan: value.plan,
    cutoff: value.cutoff,
    outcome: value.outcome,
    from: value.from,
    through: value.through,
    previousAppliedThrough: value.previousAppliedThrough,
    resultPartitionRoot: value.resultPartitionRoot,
    opaqueResult: value.opaqueResult,
    sourceEvidenceRefs: value.sourceEvidenceRefs,
    rawLocatorHashes: value.rawLocatorHashes,
    sourceEvidenceRoot: value.sourceEvidenceRoot,
  };
}

export function sourcePlanExecutionRoot(value: Omit<SourcePlanExecutionV1, "executionRoot">): Hash {
  const plan = decodeSourcePlanRef(value.plan, "sourcePlanExecution.plan");
  const cutoff = decodeCanonicalCutoff(value.cutoff, "sourcePlanExecution.cutoff");
  const sourceEvidenceRefs = fieldArray(value.sourceEvidenceRefs, (item, path) => decodeSourcePlanEvidenceRef(item, path), "sourcePlanExecution.sourceEvidenceRefs");
  const rawLocatorHashes = fieldArray(value.rawLocatorHashes, (item, path) => assertHash(item, path), "sourcePlanExecution.rawLocatorHashes");
  const opaqueResult = decodeCanonicalJson(encodeCanonicalJson(value.opaqueResult));
  const expectedEvidenceRoot = sourcePlanEvidenceRoot({ plan, cutoff, refs: sourceEvidenceRefs, rawLocatorHashes });
  if (expectedEvidenceRoot !== value.sourceEvidenceRoot) throw new TypeError("source-plan execution evidence root mismatch");
  const normalized: Omit<SourcePlanExecutionV1, "executionRoot"> = {
    ...value,
    plan,
    cutoff,
    opaqueResult,
    sourceEvidenceRefs,
    rawLocatorHashes,
  };
  return hashDomain("aloha/source-plan-execution/v1", executionRootPayload(normalized));
}

export interface SourcePlanDiscoveryResultV1 {
  readonly kind: "source-plan-discovery";
  readonly version: typeof SOURCE_EVIDENCE_VERSION_V1;
  readonly executions: readonly SourcePlanExecutionV1[];
  readonly evidence: readonly SourcePlanEvidenceReceiptV1[];
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
  readonly discoveryRoot: Hash;
}

export function sourcePlanIdentity(plan: SourcePlanRefV1): Hash {
  return hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
  });
}

function sourcePlanDiscoveryRootPayload(
  executions: readonly SourcePlanExecutionV1[],
  evidence: readonly SourcePlanEvidenceReceiptV1[],
  rawLocatorHashes: readonly Hash[],
) {
  return {
    kind: "source-plan-discovery" as const,
    version: SOURCE_EVIDENCE_VERSION_V1,
    executionRoots: executions.map(value => value.executionRoot),
    evidenceRoots: evidence.map(value => value.evidenceRoot),
    rawLocatorHashes,
  };
}

export function sourcePlanDiscoveryRoot(input: {
  readonly executions: readonly SourcePlanExecutionV1[];
  readonly evidence: readonly SourcePlanEvidenceReceiptV1[];
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}): Hash {
  const executions = fieldArray(input.executions, (value, path) => decodeSourcePlanExecution(value, path), "sourcePlanDiscovery.executions");
  const evidence = fieldArray(input.evidence, (value, path) => decodeSourcePlanEvidenceReceiptValue(value, path), "sourcePlanDiscovery.evidence");
  const identities = executions.map(value => sourcePlanIdentity(value.plan));
  if (new Set(identities).size !== identities.length) throw new TypeError("source-plan discovery has duplicate executions");
  if (evidence.length !== executions.length) throw new TypeError("source-plan discovery evidence set is incomplete");
  const evidenceByIdentity = new Map(evidence.map(value => [sourcePlanIdentity(value.plan), value]));
  if (evidenceByIdentity.size !== evidence.length) throw new TypeError("source-plan discovery has duplicate evidence receipts");
  for (const execution of executions) {
    const receipt = evidenceByIdentity.get(sourcePlanIdentity(execution.plan));
    if (receipt === undefined) throw new TypeError("source-plan discovery evidence is missing");
    if (
      receipt.evidenceRoot !== execution.sourceEvidenceRoot
      || receipt.plan.familyDefinitionHash !== execution.plan.familyDefinitionHash
      || encodeCanonicalJson(receipt.cutoff) !== encodeCanonicalJson(execution.cutoff)
      || encodeCanonicalJson(receipt.refs) !== encodeCanonicalJson(execution.sourceEvidenceRefs)
      || encodeCanonicalJson(receipt.rawLocatorHashes) !== encodeCanonicalJson(execution.rawLocatorHashes)
    ) throw new TypeError("source-plan discovery evidence/execution mismatch");
  }
  const rawHashes = [...new Set(executions.flatMap(value => value.rawLocatorHashes))].sort(compareText);
  validateRawEvidenceLocatorContents(input.rawEvidenceLocators, rawHashes, "sourcePlanDiscovery.rawEvidenceLocators");
  const sortedExecutions = [...executions].sort((left, right) => compareText(sourcePlanIdentity(left.plan), sourcePlanIdentity(right.plan)));
  const sortedEvidence = [...evidence].sort((left, right) => compareText(sourcePlanIdentity(left.plan), sourcePlanIdentity(right.plan)));
  if (executions.some((value, index) => value !== sortedExecutions[index]) || evidence.some((value, index) => value !== sortedEvidence[index])) {
    throw new TypeError("source-plan discovery is not in canonical order");
  }
  return hashDomain("aloha/source-plan-discovery/v1", sourcePlanDiscoveryRootPayload(executions, evidence, rawHashes));
}

export function decodeSourcePlanDiscoveryResult(
  value: unknown,
  name = "sourcePlanDiscovery",
): SourcePlanDiscoveryResultV1 {
  assertExactKeys(value, ["kind", "version", "executions", "evidence", "rawEvidenceLocators", "discoveryRoot"], name);
  const kind = readOwnEnumerableDataProperty(value, "kind", name);
  const version = readOwnEnumerableDataProperty(value, "version", name);
  if (kind !== "source-plan-discovery" || version !== SOURCE_EVIDENCE_VERSION_V1) throw new TypeError(`${name} kind/version is invalid`);
  const executions = fieldArray(readOwnEnumerableDataProperty(value, "executions", name), (item, path) => decodeSourcePlanExecution(item, path), `${name}.executions`);
  const evidence = fieldArray(readOwnEnumerableDataProperty(value, "evidence", name), (item, path) => decodeSourcePlanEvidenceReceiptValue(item, path), `${name}.evidence`);
  const rawValue = readOwnEnumerableDataProperty(value, "rawEvidenceLocators", name);
  if (!Array.isArray(rawValue)) throw new TypeError(`${name}.rawEvidenceLocators must be an array`);
  const rawEvidenceLocators = rawValue.map((item, index) => decodeRawEvidenceLocatorContent(item, `${name}.rawEvidenceLocators[${index}]`));
  const discoveryRoot = assertHash(readOwnEnumerableDataProperty(value, "discoveryRoot", name), `${name}.discoveryRoot`);
  const normalized = { executions, evidence, rawEvidenceLocators };
  if (sourcePlanDiscoveryRoot(normalized) !== discoveryRoot) throw new TypeError(`${name}.discoveryRoot mismatch`);
  return Object.freeze({ kind: "source-plan-discovery", version: SOURCE_EVIDENCE_VERSION_V1, executions, evidence, rawEvidenceLocators, discoveryRoot });
}

export function validateSourcePlanEvidenceReceipts(
  receipts: readonly SourcePlanEvidenceReceiptV1[],
  cutoff: CanonicalCutoffV1,
  declaredPlans: readonly SourcePlanRefV1[],
): void {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "sourceEvidenceCutoff");
  const decodedPlans = fieldArray(declaredPlans, (value, path) => decodeSourcePlanRef(value, path), "declaredSourcePlans");
  const expected = new Map(decodedPlans.map(plan => [sourcePlanIdentity(plan), plan]));
  if (expected.size !== decodedPlans.length) throw new TypeError("duplicate declared source plan");
  const decoded = fieldArray(receipts, (value, path) => decodeSourcePlanEvidenceReceiptValue(value, path), "sourcePlanEvidence");
  const seen = new Set<string>();
  for (const receipt of decoded) {
    const identity = sourcePlanIdentity(receipt.plan);
    const plan = expected.get(identity);
    if (plan === undefined || seen.has(identity)) throw new TypeError("source-plan evidence receipt set mismatch");
    if (encodeCanonicalJson(receipt.cutoff) !== encodeCanonicalJson(decodedCutoff)) throw new TypeError("source-plan evidence cutoff mismatch");
    if (encodeCanonicalJson(receipt.plan) !== encodeCanonicalJson(plan)) throw new TypeError("source-plan evidence plan mismatch");
    seen.add(identity);
  }
  if (seen.size !== expected.size) throw new TypeError("source-plan evidence receipt set incomplete");
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

export function defineFamilySourcePlan(
  value: FamilySourcePlanDefinitionV1,
  name = "familySourcePlan",
): FamilySourcePlanDefinitionV1 {
  const decoded = decodeExactObject(value, {
    sourcePlanId: (field, path) => assertNonEmptyString(field, path),
    completeness: sourceCompleteness,
    historyStartBlock: (field, path) => field === null ? null : assertDecimalString(field, path),
    schemaHash: (field, path) => assertHash(field, path),
  }, name);
  if ((decoded.completeness === "contiguous-history") !== (decoded.historyStartBlock !== null)) {
    throw new TypeError(`${name}.historyStartBlock must exist only for contiguous-history`);
  }
  return deepFreeze(decoded);
}

export function decodeSourcePlanExecution(
  value: unknown,
  name = "sourcePlanExecution",
): SourcePlanExecutionV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, path) => field === "source-plan-execution" ? ("source-plan-execution" as const) : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: evidenceVersion,
    plan: (field, path) => decodeSourcePlanRef(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    outcome: sourceOutcome,
    from: (field, path) => assertDecimalString(field, path),
    through: (field, path) => assertDecimalString(field, path),
    previousAppliedThrough: (field, path) => field === null ? null : assertDecimalString(field, path),
    resultPartitionRoot: (field, path) => assertHash(field, path),
    opaqueResult: (field, path) => decodeCanonicalJson(encodeCanonicalJson(field)),
    sourceEvidenceRefs: (field, path) => fieldArray(field, (item, itemPath) => decodeSourcePlanEvidenceRef(item, itemPath), path),
    rawLocatorHashes: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
    sourceEvidenceRoot: (field, path) => assertHash(field, path),
    executionRoot: (field, path) => assertHash(field, path),
  }, name);
  const expectedRoot = sourcePlanExecutionRoot(decoded);
  if (expectedRoot !== decoded.executionRoot) throw new TypeError(`${name}.executionRoot mismatch`);
  return decoded;
}

function nullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : assertHash(value, path);
}

function persistedExecutionRootPayload(
  value: Omit<PersistedSourcePlanExecutionV1, "persistedExecutionRoot">,
) {
  return {
    kind: value.kind,
    version: value.version,
    executionRoot: value.execution.executionRoot,
    sourcePlanLeafDigest: value.sourcePlanLeafDigest,
    sourcePlanSchemaHash: value.sourcePlanSchemaHash,
    sourcePlanClosureRoot: value.sourcePlanClosureRoot,
    sourceAuthorityRoot: value.sourceAuthorityRoot,
    releaseBindingId: value.releaseBindingId,
    releaseProvenanceHash: value.releaseProvenanceHash,
    sourceAnchorRoot: value.sourceAnchorRoot,
    previousExecutionRoot: value.previousExecutionRoot,
  };
}

export function persistedSourcePlanExecutionRoot(
  value: Omit<PersistedSourcePlanExecutionV1, "persistedExecutionRoot">,
): Hash {
  return hashDomain("aloha/persisted-source-plan-execution/v1", persistedExecutionRootPayload(value));
}

export function sealPersistedSourcePlanExecution(
  input: Omit<PersistedSourcePlanExecutionV1, "kind" | "version" | "persistedExecutionRoot">,
): PersistedSourcePlanExecutionV1 {
  const execution = decodeSourcePlanExecution(input.execution, "persistedSourcePlanExecution.execution");
  const previousExecutionRoot = nullableHash(input.previousExecutionRoot, "persistedSourcePlanExecution.previousExecutionRoot");
  if (execution.plan.completeness === "contiguous-history") {
    if ((execution.previousAppliedThrough === null) !== (previousExecutionRoot === null)) {
      throw new TypeError("persisted history predecessor binding mismatch");
    }
  } else if (previousExecutionRoot !== null) {
    throw new TypeError("non-history execution cannot bind a predecessor execution");
  }
  const withoutRoot: Omit<PersistedSourcePlanExecutionV1, "persistedExecutionRoot"> = deepFreeze({
    kind: "persisted-source-plan-execution" as const,
    version: SOURCE_EVIDENCE_VERSION_V1,
    execution,
    sourcePlanLeafDigest: assertHash(input.sourcePlanLeafDigest, "persistedSourcePlanExecution.sourcePlanLeafDigest"),
    sourcePlanSchemaHash: assertHash(input.sourcePlanSchemaHash, "persistedSourcePlanExecution.sourcePlanSchemaHash"),
    sourcePlanClosureRoot: assertHash(input.sourcePlanClosureRoot, "persistedSourcePlanExecution.sourcePlanClosureRoot"),
    sourceAuthorityRoot: assertHash(input.sourceAuthorityRoot, "persistedSourcePlanExecution.sourceAuthorityRoot"),
    releaseBindingId: assertHash(input.releaseBindingId, "persistedSourcePlanExecution.releaseBindingId"),
    releaseProvenanceHash: assertHash(input.releaseProvenanceHash, "persistedSourcePlanExecution.releaseProvenanceHash"),
    sourceAnchorRoot: assertHash(input.sourceAnchorRoot, "persistedSourcePlanExecution.sourceAnchorRoot"),
    previousExecutionRoot,
  });
  return deepFreeze({
    ...withoutRoot,
    persistedExecutionRoot: persistedSourcePlanExecutionRoot(withoutRoot),
  });
}

export function decodePersistedSourcePlanExecution(
  value: unknown,
  name = "persistedSourcePlanExecution",
): PersistedSourcePlanExecutionV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, path) => field === "persisted-source-plan-execution" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: evidenceVersion,
    execution: (field, path) => decodeSourcePlanExecution(field, path),
    sourcePlanLeafDigest: (field, path) => assertHash(field, path),
    sourcePlanSchemaHash: (field, path) => assertHash(field, path),
    sourcePlanClosureRoot: (field, path) => assertHash(field, path),
    sourceAuthorityRoot: (field, path) => assertHash(field, path),
    releaseBindingId: (field, path) => assertHash(field, path),
    releaseProvenanceHash: (field, path) => assertHash(field, path),
    sourceAnchorRoot: (field, path) => assertHash(field, path),
    previousExecutionRoot: nullableHash,
    persistedExecutionRoot: (field, path) => assertHash(field, path),
  }, name);
  if (decoded.execution.plan.completeness === "contiguous-history") {
    if ((decoded.execution.previousAppliedThrough === null) !== (decoded.previousExecutionRoot === null)) {
      throw new TypeError(`${name}.history predecessor binding mismatch`);
    }
  } else if (decoded.previousExecutionRoot !== null) {
    throw new TypeError(`${name}.non-history predecessor is invalid`);
  }
  const { persistedExecutionRoot, ...rawWithoutRoot } = decoded;
  const withoutRoot = rawWithoutRoot as Omit<PersistedSourcePlanExecutionV1, "persistedExecutionRoot">;
  if (persistedSourcePlanExecutionRoot(withoutRoot) !== persistedExecutionRoot) {
    throw new TypeError(`${name}.persistedExecutionRoot mismatch`);
  }
  return deepFreeze(decoded as PersistedSourcePlanExecutionV1);
}

function persistedExecutionSetRootPayload(
  cutoff: CanonicalCutoffV1,
  executions: readonly PersistedSourcePlanExecutionV1[],
) {
  return {
    kind: "persisted-source-plan-execution-set" as const,
    version: SOURCE_EVIDENCE_VERSION_V1,
    cutoff,
    executionRoots: executions.map(execution => execution.persistedExecutionRoot),
  };
}

export function sealPersistedSourcePlanExecutionSet(
  cutoff: CanonicalCutoffV1,
  values: readonly PersistedSourcePlanExecutionV1[],
): PersistedSourcePlanExecutionSetV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "persistedExecutionSet.cutoff");
  const executions = [...fieldArray(values, (value, path) => decodePersistedSourcePlanExecution(value, path), "persistedExecutionSet.executions")]
    .sort((left, right) => compareText(sourcePlanIdentity(left.execution.plan), sourcePlanIdentity(right.execution.plan)));
  if (new Set(executions.map(value => sourcePlanIdentity(value.execution.plan))).size !== executions.length) {
    throw new TypeError("persisted execution set contains duplicate source plans");
  }
  for (const execution of executions) {
    if (encodeCanonicalJson(execution.execution.cutoff) !== encodeCanonicalJson(decodedCutoff)) {
      throw new TypeError("persisted execution set cutoff mismatch");
    }
  }
  const frozenExecutions = deepFreeze(executions);
  return deepFreeze({
    kind: "persisted-source-plan-execution-set",
    version: SOURCE_EVIDENCE_VERSION_V1,
    cutoff: decodedCutoff,
    executions: frozenExecutions,
    executionSetRoot: hashDomain("aloha/persisted-source-plan-execution-set/v1", persistedExecutionSetRootPayload(decodedCutoff, frozenExecutions)),
  });
}

export function decodePersistedSourcePlanExecutionSet(
  value: unknown,
  name = "persistedSourcePlanExecutionSet",
): PersistedSourcePlanExecutionSetV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, path) => field === "persisted-source-plan-execution-set" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: evidenceVersion,
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    executions: (field, path) => fieldArray(field, (item, itemPath) => decodePersistedSourcePlanExecution(item, itemPath), path),
    executionSetRoot: (field, path) => assertHash(field, path),
  }, name);
  const expected = sealPersistedSourcePlanExecutionSet(decoded.cutoff, decoded.executions);
  if (
    decoded.executionSetRoot !== expected.executionSetRoot
    || encodeCanonicalJson(decoded.executions) !== encodeCanonicalJson(expected.executions)
  ) throw new TypeError(`${name} root/order mismatch`);
  return deepFreeze(decoded as PersistedSourcePlanExecutionSetV1);
}

export function validatePersistedExecutionCoverage(
  executionSet: PersistedSourcePlanExecutionSetV1,
  coverage: SourceCoverageCertificateV1,
): void {
  const decoded = decodePersistedSourcePlanExecutionSet(executionSet);
  validateSourceCoverageCertificate(coverage, coverage.entries.map(entry => ({
    ownerRef: entry.ownerRef,
    sourcePlanRef: entry.sourcePlanRef,
    familyDefinitionHash: entry.familyDefinitionHash,
    completeness: entry.completeness,
    historyStartBlock: entry.historyStartBlock,
  })));
  if (encodeCanonicalJson(decoded.cutoff) !== encodeCanonicalJson(coverage.cutoff)) {
    throw new TypeError("persisted execution/coverage cutoff mismatch");
  }
  const entries = new Map(coverage.entries.map(entry => [sourcePlanIdentity(entry), entry]));
  if (entries.size !== decoded.executions.length) throw new TypeError("persisted execution/coverage partition mismatch");
  for (const persisted of decoded.executions) {
    const entry = entries.get(sourcePlanIdentity(persisted.execution.plan));
    if (
      entry === undefined
      || entry.executionRoot !== persisted.execution.executionRoot
      || entry.resultPartitionRoot !== persisted.execution.resultPartitionRoot
      || entry.previousAppliedThrough !== persisted.execution.previousAppliedThrough
      || entry.appliedThrough !== persisted.execution.through
    ) throw new TypeError("persisted execution/coverage lineage mismatch");
  }
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
  executionRoot: (field, path) => assertHash(field, path),
  contributesOmissionAuthority: (field, path) => {
    if (typeof field !== "boolean") throw new TypeError(`${path} must be boolean`);
    return field;
  },
}, name);

export function recentObservationRange(cutoffNumber: string): BlockRangeV1 {
  const cutoff = decimal(cutoffNumber, "cutoffNumber");
  if (cutoff < 49n) {
    throw new Error("recent-observation-window-unavailable");
  }
  const from = cutoff - 49n;
  return deepFreeze({ from: from.toString(), to: cutoff.toString() });
}

export function familyCandidateKey(
  familyDefinitionHash: Hash,
  instanceNominationKey: string,
): Hash {
  if (instanceNominationKey.length === 0) throw new TypeError("instanceNominationKey is empty");
  return hashDomain("aloha/family-candidate/v2", {
    familyDefinitionHash,
    instanceNominationKey,
  });
}

export function candidateSubjectHash(
  familyDefinitionHash: Hash,
  instanceNominationKey: string,
): Hash {
  if (instanceNominationKey.length === 0) throw new TypeError("instanceNominationKey is empty");
  return hashDomain("aloha/candidate-subject/v2", { familyDefinitionHash, instanceNominationKey });
}

export function runCandidateKey(runId: string, candidateKey: Hash): Hash {
  if (runId.length === 0) throw new TypeError("runId is empty");
  return hashDomain("aloha/run-candidate/v1", { runId, familyCandidateKey: candidateKey });
}

function evidenceKey(value: CandidateEvidenceRefV1): Hash {
  return hashDomain("aloha/candidate-evidence-ref/v1", value);
}

export function candidateEvidenceRoot(evidence: readonly CandidateEvidenceRefV1[]): Hash {
  if (evidence.length === 0) throw new TypeError("candidate evidence is empty");
  const refs = evidence.map((value, index) => {
    const decoded = decodeCandidateEvidenceRef(value, `candidateEvidence[${index}]`);
    return { key: evidenceKey(decoded), value: decoded };
  });
  if (new Set(refs.map(ref => ref.key)).size !== refs.length) throw new TypeError("duplicate candidate evidence");
  refs.sort((left, right) => compareText(left.key, right.key));
  return hashDomain("aloha/candidate-evidence-set/v2", refs.map(ref => ref.value));
}

export const decodeCandidateNomination = (
  value: unknown,
  name = "candidateNomination",
): CandidateNominationV1 => decodeExactObject(value, {
  kind: (field, path) => field === "aloha.candidate-nomination" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  version: (field, path) => field === "2" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  instanceNominationKey: (field, path) => assertNonEmptyString(field, path),
  evidence: (field, path) => decodeCandidateEvidenceRef(field, path),
}, name);

const decodeCandidateRecord = (
  value: unknown,
  name = "candidateRecord",
): CandidateRecordV1 => decodeExactObject(value, {
  kind: (field, path) => field === "aloha.candidate-record" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  version: (field, path) => field === "2" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  instanceNominationKey: (field, path) => assertNonEmptyString(field, path),
  familyCandidateKey: (field, path) => assertHash(field, path),
  candidateSubjectHash: (field, path) => assertHash(field, path),
  candidateEvidenceRoot: (field, path) => assertHash(field, path),
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

  const records = [...groups.entries()].map(([key, group]) => {
    const evidence = [...group.evidence.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, value]) => deepFreeze({ ...value }));
    return deepFreeze({
    kind: "aloha.candidate-record" as const,
    version: "2" as const,
    familyId: group.nomination.familyId,
    familyDefinitionHash: group.nomination.familyDefinitionHash,
    instanceNominationKey: group.nomination.instanceNominationKey,
    familyCandidateKey: key,
    candidateSubjectHash: candidateSubjectHash(group.nomination.familyDefinitionHash, group.nomination.instanceNominationKey),
    candidateEvidenceRoot: candidateEvidenceRoot(evidence),
    evidence,
  });
  });
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
    executionRoot: decoded.executionRoot,
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
  const declared = new Map<Hash, SourcePlanRefV1>();
  for (const plan of decodedPlans) {
    const identity = sourcePlanIdentity(plan);
    if (declared.has(identity)) throw new Error(`duplicate-declared-source-plan:${identity}`);
    declared.set(identity, plan);
  }
  const seen = new Set<Hash>();
  const entries = decodedExecutions.map(execution => {
    if (
      execution.cutoff.chainId !== decodedCutoff.chainId
      || execution.cutoff.number !== decodedCutoff.number
      || execution.cutoff.hash !== decodedCutoff.hash
      || execution.cutoff.stateRoot !== decodedCutoff.stateRoot
    ) throw new Error("coverage-cutoff-mismatch");
    const identity = sourcePlanIdentity(execution.plan);
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
    sourcePlanIdentity(left),
    sourcePlanIdentity(right),
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
      || record.candidateSubjectHash !== candidateSubjectHash(record.familyDefinitionHash, record.instanceNominationKey)
      || record.candidateEvidenceRoot !== candidateEvidenceRoot(record.evidence)
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
  return hashCanonicalPartition("aloha/candidate-partition/v2", sorted);
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
  const identities = new Set<Hash>();
  const decoded = fieldArray(plans, (value, path) => decodeSourcePlanRef(value, path), "sourcePlanRefs");
  const sorted = decoded.map(plan => {
    const identity = sourcePlanIdentity(plan);
    if (identities.has(identity)) throw new Error("duplicate-source-plan");
    identities.add(identity);
    return plan;
  }).sort((left, right) => compareText(sourcePlanIdentity(left), sourcePlanIdentity(right)));
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
  const plans = new Map(decodedPlans.map(plan => [sourcePlanIdentity(plan), plan]));
  if (plans.size !== decodedPlans.length) throw new Error("duplicate-declared-source-plan");
  const seen = new Set<Hash>();
  const cutoffNumber = decimal(decodedCertificate.cutoff.number, "coverageCutoff.number");
  for (const entry of decodedCertificate.entries) {
    const identity = hashDomain("aloha/source-plan-identity/v1", {
      ownerRef: entry.ownerRef,
      sourcePlanRef: entry.sourcePlanRef,
    });
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
    hashDomain("aloha/source-plan-identity/v1", { ownerRef: left.ownerRef, sourcePlanRef: left.sourcePlanRef }),
    hashDomain("aloha/source-plan-identity/v1", { ownerRef: right.ownerRef, sourcePlanRef: right.sourcePlanRef }),
  ));
  if (decodedCertificate.entries.some((entry, index) => entry !== sorted[index])) {
    throw new Error("coverage-entry-order-mismatch");
  }
  const expectedRoot = hashDomain("aloha/source-coverage/v1", { cutoff: decodedCertificate.cutoff, entries: sorted });
  if (expectedRoot !== decodedCertificate.sourceCoverageRoot) throw new Error("source-coverage-root-mismatch");
}
