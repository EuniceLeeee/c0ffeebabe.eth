import {
  arraySchema,
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  decimalStringSchema,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  enumSchema,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  refineSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  hashProcessAnchor,
  hashReadOnlyArtifactLocator,
  type ProcessAnchorV1,
  type ReadOnlyArtifactLocatorV1,
} from "../../core-envelope/src/index.ts";

export * from "./runtime-boundary-projection.ts";

export type RuntimeAcceptanceCodecInput = string | Uint8Array | object;
export type RuntimeAcceptanceVerdict = "pass" | "fail" | "invalid";
export type RuntimeAcceptanceFactKindV1 = "restart" | "legacy-closure";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

const nonZeroHashSchema = defineSchema<Hash>(
  { kind: "non-zero-hash" },
  (value, path = "$") => {
    const decoded = hashSchema.decode(value, path);
    if (decoded === ZERO_HASH) throw new TypeError(`zero hash is not allowed at ${path}`);
    return decoded;
  },
);

const booleanSchema = defineSchema<boolean>(
  { kind: "boolean" },
  (value, path = "$") => {
    if (typeof value !== "boolean") throw new TypeError(`expected boolean at ${path}`);
    return value;
  },
);

const uintSchema = refineSchema(
  decimalStringSchema,
  "aloha.runtime-acceptance.non-negative-decimal.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.non-negative-decimal.v1",
    version: "1.0.0",
  }),
  (value, path) => {
    if (BigInt(value) < 0n) throw new TypeError(`negative decimal at ${path}`);
    return value;
  },
);

function parse(value: RuntimeAcceptanceCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUnique(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) throw new TypeError(`values must be strictly sorted at ${path}`);
  }
}

function assertPositiveHash(value: Hash, path: string): void {
  if (value === ZERO_HASH) throw new TypeError(`zero hash is not allowed at ${path}`);
}

function assertPositiveHashes(values: readonly Hash[], path: string): void {
  values.forEach((value, index) => assertPositiveHash(value, `${path}[${index}]`));
}

const hashList = (domain: string, values: readonly unknown[]): Hash => hashDomain(domain, values);

const locatorSchema = CORE_SCHEMA_MANIFESTS.readOnlyArtifactLocator.schema;
const processAnchorSchema = CORE_SCHEMA_MANIFESTS.processAnchor.schema;
const sourceAnchorSchema = CORE_SCHEMA_MANIFESTS.sourceAnchor.schema;
const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;

const locatorId = (locator: ReadOnlyArtifactLocatorV1): Hash => hashReadOnlyArtifactLocator(locator);

const runtimeFactRefStructuralSchema = objectSchema({
  factId: nonZeroHashSchema,
  artifactRefId: nonZeroHashSchema,
  contentSha256: nonZeroHashSchema,
  byteLength: uintSchema,
  schema: schemaRefSchema,
  locatorId: nonZeroHashSchema,
  locator: locatorSchema,
});

export type RuntimeFactRefV1 = Infer<typeof runtimeFactRefStructuralSchema>;

const runtimeFactRefSchema = refineSchema(
  runtimeFactRefStructuralSchema,
  "aloha.runtime-acceptance.fact-ref.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.fact-ref.refinement.v1",
    version: "1.0.0",
    rules: ["locator-id", "fact-id", "content-addressed", "positive-hash"],
  }),
  (value, path) => {
    if (value.locatorId !== locatorId(value.locator)) throw new TypeError(`locator id mismatch at ${path}.locatorId`);
    const expected = hashDomain("aloha/runtime-acceptance/fact-ref/v1", {
      artifactRefId: value.artifactRefId,
      contentSha256: value.contentSha256,
      byteLength: value.byteLength,
      schema: value.schema,
      locatorId: value.locatorId,
    });
    if (value.factId !== expected) throw new TypeError(`fact id mismatch at ${path}.factId`);
    return value;
  },
);

const runtimeAcceptanceFactLocatorSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-acceptance-fact-locator"),
  factKind: enumSchema(["restart", "legacy-closure"] as const),
  artifactRefId: nonZeroHashSchema,
  contentSha256: nonZeroHashSchema,
});
export type RuntimeAcceptanceFactLocatorV1 = Infer<typeof runtimeAcceptanceFactLocatorSchema>;

const hashPartitionItemSchema = nonZeroHashSchema;
const hashPartitionStructuralSchema = objectSchema({
  count: uintSchema,
  root: nonZeroHashSchema,
  items: arraySchema(hashPartitionItemSchema),
});
export type RuntimeHashPartitionV1 = Infer<typeof hashPartitionStructuralSchema>;

const hashPartitionSchema = refineSchema(
  hashPartitionStructuralSchema,
  "aloha.runtime-acceptance.hash-partition.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.hash-partition.refinement.v1",
    version: "1.0.0",
    rules: ["sorted-unique", "count", "root"],
  }),
  (value, path) => {
    assertSortedUnique(value.items, `${path}.items`);
    if (value.count !== String(value.items.length)) throw new TypeError(`hash partition count mismatch at ${path}.count`);
    if (value.root !== hashList("aloha/runtime-acceptance/hash-partition/v1", value.items)) throw new TypeError(`hash partition root mismatch at ${path}.root`);
    return value;
  },
);

const logAnchorSchema = objectSchema({
  systemId: nonEmptyStringSchema,
  bootIdHash: nonZeroHashSchema,
  device: uintSchema,
  inode: uintSchema,
  startInclusive: uintSchema,
  endExclusive: uintSchema,
  contentSha256: nonZeroHashSchema,
});
export type RuntimeLogAnchorV1 = Infer<typeof logAnchorSchema>;

function checkLogAnchor(value: RuntimeLogAnchorV1, path: string): RuntimeLogAnchorV1 {
  if (BigInt(value.endExclusive) <= BigInt(value.startInclusive)) throw new TypeError(`log range is empty at ${path}`);
  return value;
}

const checkedLogAnchorSchema = refineSchema(
  logAnchorSchema,
  "aloha.runtime-acceptance.log-anchor.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.log-anchor.refinement.v1",
    version: "1.0.0",
    rules: ["positive-range"],
  }),
  checkLogAnchor,
);

const runtimeAnchorPayloadFields = {
  runtimeCommitSha: gitSha40Schema,
  processAnchorHash: nonZeroHashSchema,
  processAnchor: processAnchorSchema,
  systemdUnit: nonEmptyStringSchema,
  systemdExecStartHash: nonZeroHashSchema,
  executableHash: nonZeroHashSchema,
  logAnchor: checkedLogAnchorSchema,
  sourceAnchor: sourceAnchorSchema,
  releaseIntentRoot: nonZeroHashSchema,
  definitionCatalogRoot: nonZeroHashSchema,
  sourceCoverageRoot: nonZeroHashSchema,
  strategyCatalogRoot: nonZeroHashSchema,
  instanceCatalogRoot: nonZeroHashSchema,
  graphRoot: nonZeroHashSchema,
  readyRecordHash: nonZeroHashSchema,
  generationId: nonEmptyStringSchema,
} as const;

const runtimeAnchorPayloadSchema = objectSchema(runtimeAnchorPayloadFields);
export type RuntimeProcessAnchorFactPayloadV1 = Infer<typeof runtimeAnchorPayloadSchema>;

const runtimeAnchorStructuralSchema = objectSchema({
  ...runtimeAnchorPayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeProcessAnchorFactsV1 = Infer<typeof runtimeAnchorStructuralSchema>;

const runtimeAnchorSchema = refineSchema(
  runtimeAnchorStructuralSchema,
  "aloha.runtime-acceptance.process-anchor.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.process-anchor.refinement.v1",
    version: "1.0.0",
    rules: ["process-anchor-hash", "exact-runtime-sha", "executable-binding", "system-and-boot", "log-anchor"],
  }),
  (value, path) => {
    if (value.processAnchorHash !== hashProcessAnchor(value.processAnchor)) throw new TypeError(`process anchor hash mismatch at ${path}.processAnchorHash`);
    if (value.runtimeCommitSha !== value.processAnchor.commitSha) throw new TypeError(`runtime SHA does not match process anchor at ${path}.runtimeCommitSha`);
    if (value.executableHash !== value.processAnchor.executableHash) throw new TypeError(`executable hash mismatch at ${path}.executableHash`);
    if (value.logAnchor.systemId !== value.processAnchor.systemId || value.logAnchor.bootIdHash !== value.processAnchor.bootIdHash) throw new TypeError(`log anchor host mismatch at ${path}.logAnchor`);
    return value;
  },
);

const candidateOutcomePayloadFields = {
  candidateKey: nonZeroHashSchema,
  runCandidateKey: nonZeroHashSchema,
  dependencyClosureRoot: nonZeroHashSchema,
  outcomeHash: nonZeroHashSchema,
  outcome: enumSchema(["verified", "rejected", "retryable", "pending"] as const),
} as const;

const candidateOutcomePayloadSchema = objectSchema(candidateOutcomePayloadFields);
export type RuntimeCandidateOutcomeFactPayloadV1 = Infer<typeof candidateOutcomePayloadSchema>;

const candidateOutcomeSchema = objectSchema({
  ...candidateOutcomePayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeCandidateOutcomeV1 = Infer<typeof candidateOutcomeSchema>;

const candidateOutcomePartitionStructuralSchema = objectSchema({
  count: uintSchema,
  root: nonZeroHashSchema,
  items: arraySchema(candidateOutcomeSchema),
});
export type RuntimeCandidateOutcomePartitionV1 = Infer<typeof candidateOutcomePartitionStructuralSchema>;

const candidateOutcomePartitionSchema = refineSchema(
  candidateOutcomePartitionStructuralSchema,
  "aloha.runtime-acceptance.candidate-outcome-partition.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.candidate-outcome-partition.refinement.v1",
    version: "1.0.0",
    rules: ["sorted-candidate-key", "unique-candidate-key", "count", "root"],
  }),
  (value, path) => {
    const keys = value.items.map((item) => item.runCandidateKey);
    assertSortedUnique(keys, `${path}.items`);
    if (value.count !== String(value.items.length)) throw new TypeError(`candidate partition count mismatch at ${path}.count`);
    if (value.root !== hashList("aloha/runtime-acceptance/candidate-outcome-partition/v1", value.items)) throw new TypeError(`candidate partition root mismatch at ${path}.root`);
    return value;
  },
);

const deltaItemPayloadFields = {
  candidateKey: nonZeroHashSchema,
  runCandidateKey: nonZeroHashSchema,
  previousDependencyClosureRoot: nullableSchema(nonZeroHashSchema),
  currentDependencyClosureRoot: nullableSchema(nonZeroHashSchema),
  previousOutcomeHash: nullableSchema(nonZeroHashSchema),
  currentOutcomeHash: nullableSchema(nonZeroHashSchema),
} as const;

const deltaItemPayloadSchema = objectSchema(deltaItemPayloadFields);
export type RuntimeCandidateDeltaFactPayloadV1 = Infer<typeof deltaItemPayloadSchema>;

const deltaItemSchema = objectSchema({
  ...deltaItemPayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeCandidateDeltaV1 = Infer<typeof deltaItemSchema>;

const deltaPartitionStructuralSchema = objectSchema({
  change: enumSchema(["memo-reused", "new", "invalidated-dependency", "retryable", "rejection-not-reused", "unchanged-old-instance-attestation"] as const),
  count: uintSchema,
  root: nonZeroHashSchema,
  items: arraySchema(deltaItemSchema),
});
export type RuntimeCandidateDeltaPartitionV1 = Infer<typeof deltaPartitionStructuralSchema>;

const deltaPartitionSchema = refineSchema(
  deltaPartitionStructuralSchema,
  "aloha.runtime-acceptance.candidate-delta-partition.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.candidate-delta-partition.refinement.v1",
    version: "1.0.0",
    rules: ["sorted-run-candidate-key", "count", "root"],
  }),
  (value, path) => {
    const keys = value.items.map((item) => item.runCandidateKey);
    assertSortedUnique(keys, `${path}.items`);
    if (value.count !== String(value.items.length)) throw new TypeError(`delta partition count mismatch at ${path}.count`);
    if (value.root !== hashDomain("aloha/runtime-acceptance/candidate-delta-partition/v1", { change: value.change, items: value.items })) throw new TypeError(`delta partition root mismatch at ${path}.root`);
    return value;
  },
);

const restartDifferencePayloadFields = {
  previousCandidates: candidateOutcomePartitionSchema,
  currentCandidates: candidateOutcomePartitionSchema,
  memoReused: deltaPartitionSchema,
  newCandidates: deltaPartitionSchema,
  invalidatedDependencyClosure: deltaPartitionSchema,
  retryable: deltaPartitionSchema,
  rejectionNotReused: deltaPartitionSchema,
  unchangedOldInstanceAttestations: deltaPartitionSchema,
} as const;

const restartDifferencePayloadSchema = objectSchema(restartDifferencePayloadFields);
export type RuntimeRestartDifferenceFactPayloadV1 = Infer<typeof restartDifferencePayloadSchema>;

const restartDifferenceStructuralSchema = objectSchema({
  ...restartDifferencePayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeRestartDifferenceV1 = Infer<typeof restartDifferenceStructuralSchema>;

const restartDifferenceSchema = refineSchema(
  restartDifferenceStructuralSchema,
  "aloha.runtime-acceptance.restart-difference.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.restart-difference.refinement.v1",
    version: "1.0.0",
    rules: ["fixed-delta-discriminators", "disjoint-accounting", "memo-dependency-equality", "invalidated-dependency-change", "retryable-is-current", "rejection-does-not-cross-cutoff", "unchanged-attestation-zero"],
  }),
  (value, path) => {
    const names = [
      ["memoReused", "memo-reused"],
      ["newCandidates", "new"],
      ["invalidatedDependencyClosure", "invalidated-dependency"],
      ["retryable", "retryable"],
      ["rejectionNotReused", "rejection-not-reused"],
      ["unchangedOldInstanceAttestations", "unchanged-old-instance-attestation"],
    ] as const;
    for (const [name, change] of names) if (value[name].change !== change) throw new TypeError(`delta discriminator mismatch at ${path}.${name}.change`);
    if (value.unchangedOldInstanceAttestations.items.length !== 0) throw new TypeError(`unchanged old instance attestations must be zero at ${path}.unchangedOldInstanceAttestations`);
    const previous = new Map(value.previousCandidates.items.map((item) => [item.runCandidateKey, item]));
    const current = new Map(value.currentCandidates.items.map((item) => [item.runCandidateKey, item]));
    const seen = new Set<Hash>();
    const partitions = [value.memoReused, value.newCandidates, value.invalidatedDependencyClosure, value.retryable];
    for (const partition of partitions) {
      for (const item of partition.items) {
        if (seen.has(item.runCandidateKey)) throw new TypeError(`delta candidate overlap at ${path}`);
        seen.add(item.runCandidateKey);
        const oldItem = previous.get(item.runCandidateKey);
        const newItem = current.get(item.runCandidateKey);
        if (partition.change === "memo-reused") {
          if (oldItem === undefined || newItem === undefined || item.previousDependencyClosureRoot !== oldItem.dependencyClosureRoot || item.currentDependencyClosureRoot !== newItem.dependencyClosureRoot || item.previousDependencyClosureRoot !== item.currentDependencyClosureRoot || item.previousOutcomeHash !== oldItem.outcomeHash || item.currentOutcomeHash !== newItem.outcomeHash) throw new TypeError(`memo accounting mismatch at ${path}.memoReused`);
        } else if (partition.change === "new") {
          if (oldItem !== undefined || newItem === undefined || item.previousDependencyClosureRoot !== null || item.currentDependencyClosureRoot !== newItem.dependencyClosureRoot || item.currentOutcomeHash !== newItem.outcomeHash) throw new TypeError(`new accounting mismatch at ${path}.newCandidates`);
        } else if (partition.change === "invalidated-dependency") {
          if (oldItem === undefined || newItem === undefined || item.previousDependencyClosureRoot !== oldItem.dependencyClosureRoot || item.currentDependencyClosureRoot !== newItem.dependencyClosureRoot || item.previousDependencyClosureRoot === item.currentDependencyClosureRoot) throw new TypeError(`invalidated accounting mismatch at ${path}.invalidatedDependencyClosure`);
        } else if (partition.change === "retryable") {
          if (newItem === undefined || newItem.outcome !== "retryable" || item.currentDependencyClosureRoot !== newItem.dependencyClosureRoot || item.currentOutcomeHash !== newItem.outcomeHash) throw new TypeError(`retryable accounting mismatch at ${path}.retryable`);
        }
      }
    }
    for (const item of value.rejectionNotReused.items) {
      if (seen.has(item.runCandidateKey)) throw new TypeError(`rejection delta overlaps current accounting at ${path}`);
      if (!previous.has(item.runCandidateKey) || current.has(item.runCandidateKey) || item.currentDependencyClosureRoot !== null || item.currentOutcomeHash !== null) throw new TypeError(`rejection-not-reused accounting mismatch at ${path}.rejectionNotReused`);
    }
    const expectedCurrent = new Set(current.keys());
    if (expectedCurrent.size !== seen.size || [...expectedCurrent].some((key) => !seen.has(key))) throw new TypeError(`current candidate delta accounting incomplete at ${path}`);
    return value;
  },
);

const singleTargetProbePayloadFields = {
  targetRunCandidateKey: nonZeroHashSchema,
  beforeOutcomes: candidateOutcomePartitionSchema,
  afterOutcomes: candidateOutcomePartitionSchema,
  changedRunCandidateKeys: hashPartitionSchema,
  targetBeforeOutcomeHash: nonZeroHashSchema,
  targetAfterOutcomeHash: nonZeroHashSchema,
} as const;

const singleTargetProbePayloadSchema = objectSchema(singleTargetProbePayloadFields);
export type RuntimeSingleTargetProbeFactPayloadV1 = Infer<typeof singleTargetProbePayloadSchema>;

const singleTargetProbeStructuralSchema = objectSchema({
  ...singleTargetProbePayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeSingleTargetProbeV1 = Infer<typeof singleTargetProbeStructuralSchema>;

const singleTargetProbeSchema = refineSchema(
  singleTargetProbeStructuralSchema,
  "aloha.runtime-acceptance.single-target-probe.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.single-target-probe.refinement.v1",
    version: "1.0.0",
    rules: ["same-target-universe", "exactly-one-changed-target", "no-array-index-resume"],
  }),
  (value, path) => {
    if (value.changedRunCandidateKeys.items.length !== 1 || value.changedRunCandidateKeys.items[0] !== value.targetRunCandidateKey) throw new TypeError(`single target probe changed set mismatch at ${path}.changedRunCandidateKeys`);
    if (value.targetBeforeOutcomeHash === value.targetAfterOutcomeHash) throw new TypeError(`single target probe did not change target outcome at ${path}`);
    const before = new Map(value.beforeOutcomes.items.map((item) => [item.runCandidateKey, item]));
    const after = new Map(value.afterOutcomes.items.map((item) => [item.runCandidateKey, item]));
    if (before.size !== after.size || [...before.keys()].some((key) => !after.has(key))) throw new TypeError(`single target probe changed candidate universe at ${path}`);
    for (const [key, oldItem] of before) {
      const newItem = after.get(key)!;
      const changed = oldItem.outcomeHash !== newItem.outcomeHash;
      if (changed !== (key === value.targetRunCandidateKey)) throw new TypeError(`single target probe changed non-target outcome at ${path}.afterOutcomes`);
      if (key === value.targetRunCandidateKey && (oldItem.outcomeHash !== value.targetBeforeOutcomeHash || newItem.outcomeHash !== value.targetAfterOutcomeHash)) throw new TypeError(`single target outcome hash mismatch at ${path}`);
    }
    return value;
  },
);

const sigtermRecoveryPayloadFields = {
  observedSignal: literalSchema("SIGTERM"),
  signalProcessAnchorHash: nonZeroHashSchema,
  flushedOutcomes: candidateOutcomePartitionSchema,
  afterRestartOutcomes: candidateOutcomePartitionSchema,
  durableOutcomeRoot: nonZeroHashSchema,
} as const;

const sigtermRecoveryPayloadSchema = objectSchema(sigtermRecoveryPayloadFields);
export type RuntimeSigtermRecoveryFactPayloadV1 = Infer<typeof sigtermRecoveryPayloadSchema>;

const sigtermRecoveryStructuralSchema = objectSchema({
  ...sigtermRecoveryPayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeSigtermRecoveryV1 = Infer<typeof sigtermRecoveryStructuralSchema>;

const sigtermRecoverySchema = refineSchema(
  sigtermRecoveryStructuralSchema,
  "aloha.runtime-acceptance.sigterm-recovery.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.sigterm-recovery.refinement.v1",
    version: "1.0.0",
    rules: ["flushed-non-empty", "durable-root", "exact-outcome-reuse"],
  }),
  (value, path) => {
    if (value.flushedOutcomes.items.length === 0) throw new TypeError(`SIGTERM must flush at least one outcome at ${path}.flushedOutcomes`);
    if (value.durableOutcomeRoot !== value.afterRestartOutcomes.root) throw new TypeError(`durable outcome root mismatch at ${path}.durableOutcomeRoot`);
    if (value.flushedOutcomes.root !== value.afterRestartOutcomes.root || encodeCanonicalJson(value.flushedOutcomes.items) !== encodeCanonicalJson(value.afterRestartOutcomes.items)) throw new TypeError(`SIGTERM outcomes were not durable across restart at ${path}`);
    return value;
  },
);

const graphViewLeaseObservationSchema = objectSchema({
  eventType: literalSchema("head-coverage"),
  eventId: nonZeroHashSchema,
  processAnchorHash: nonZeroHashSchema,
  pid: uintSchema,
  processStartTicks: uintSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: nonZeroHashSchema,
  readyRecordHash: nonZeroHashSchema,
  sourceCoverageRoot: nonZeroHashSchema,
  headHash: nonZeroHashSchema,
});
export type RuntimeGraphViewLeaseObservationV1 = Infer<typeof graphViewLeaseObservationSchema>;

const graphViewLeaseObservationsSchema = refineSchema(
  arraySchema(graphViewLeaseObservationSchema),
  "aloha.runtime-acceptance.graph-view-lease-observations.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.graph-view-lease-observations.refinement.v1",
    version: "1.0.0",
    rules: ["non-empty", "at-most-fifty", "sorted-unique-event-id"],
  }),
  (value, path) => {
    if (value.length === 0) throw new TypeError(`graph view lease observations are empty at ${path}`);
    if (value.length > 50) throw new TypeError(`graph view lease observations exceed the fixed fifty-head window at ${path}`);
    assertSortedUnique(value.map((item) => item.eventId), path);
    return value;
  },
);

const graphReusePayloadFields = {
  mode: enumSchema(["direct-reuse", "fail-closed"] as const),
  beforeGraphRoot: nonZeroHashSchema,
  afterGraphRoot: nonZeroHashSchema,
  beforeReadyRecordHash: nonZeroHashSchema,
  afterReadyRecordHash: nonZeroHashSchema,
  graphViewLeaseObservations: graphViewLeaseObservationsSchema,
  graphViewLeaseRoot: nonZeroHashSchema,
} as const;

const graphReusePayloadSchema = objectSchema(graphReusePayloadFields);
export type RuntimeGraphReuseFactPayloadV1 = Infer<typeof graphReusePayloadSchema>;

const graphReuseStructuralSchema = objectSchema({
  ...graphReusePayloadFields,
  factRefId: nonZeroHashSchema,
});
export type RuntimeGraphReuseV1 = Infer<typeof graphReuseStructuralSchema>;

const graphReuseSchema = refineSchema(
  graphReuseStructuralSchema,
  "aloha.runtime-acceptance.graph-reuse.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.graph-reuse.refinement.v1",
    version: "1.0.0",
    rules: ["mode-root-relation", "lease-observation-root"],
  }),
  (value, path) => {
    if (value.mode === "direct-reuse" && (value.beforeGraphRoot !== value.afterGraphRoot || value.beforeReadyRecordHash !== value.afterReadyRecordHash)) throw new TypeError(`direct graph reuse has changed roots at ${path}`);
    if (value.mode === "fail-closed" && value.beforeGraphRoot === value.afterGraphRoot && value.beforeReadyRecordHash === value.afterReadyRecordHash) throw new TypeError(`fail-closed graph reuse has no source change at ${path}`);
    if (value.graphViewLeaseRoot !== hashDomain("aloha/runtime-acceptance/graph-view-lease-observation-root/v1", value.graphViewLeaseObservations)) throw new TypeError(`graph view lease observation root mismatch at ${path}.graphViewLeaseRoot`);
    return value;
  },
);

const runtimeRestartStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-restart-facts"),
  before: runtimeAnchorSchema,
  after: runtimeAnchorSchema,
  graphReuse: graphReuseSchema,
  difference: restartDifferenceSchema,
  singleTargetProbe: singleTargetProbeSchema,
  sigtermRecovery: sigtermRecoverySchema,
  factRefs: arraySchema(runtimeFactRefSchema),
  factRefsRoot: nonZeroHashSchema,
});
export type RuntimeRestartFactsV1 = Infer<typeof runtimeRestartStructuralSchema>;

const runtimeRestartSchema = refineSchema(
  runtimeRestartStructuralSchema,
  "aloha.runtime-acceptance.restart-facts.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.runtime-acceptance.restart-facts.refinement.v1",
    version: "1.0.0",
    rules: ["process-anchor-before-after", "same-exact-sha-and-release-roots", "new-process", "fact-ref-root", "source-change-fail-closed"],
  }),
  (value, path) => {
    if (value.before.runtimeCommitSha !== value.after.runtimeCommitSha) throw new TypeError(`restart reused a different runtime SHA at ${path}.after.runtimeCommitSha`);
    const releaseFields = ["releaseIntentRoot", "definitionCatalogRoot", "strategyCatalogRoot", "instanceCatalogRoot"] as const;
    for (const field of releaseFields) if (value.before[field] !== value.after[field]) throw new TypeError(`restart release root mismatch at ${path}.${field}`);
    if (value.before.processAnchorHash === value.after.processAnchorHash || (value.before.processAnchor.pid === value.after.processAnchor.pid && value.before.processAnchor.processStartTicks === value.after.processAnchor.processStartTicks)) throw new TypeError(`restart did not change process anchor at ${path}.after`);
    if (value.before.executableHash !== value.after.executableHash || value.before.systemdUnit !== value.after.systemdUnit || value.before.systemdExecStartHash !== value.after.systemdExecStartHash || value.before.processAnchor.bootIdHash !== value.after.processAnchor.bootIdHash || value.before.processAnchor.systemId !== value.after.processAnchor.systemId || value.before.processAnchor.deploymentManifestHash !== value.after.processAnchor.deploymentManifestHash || value.before.processAnchor.serviceIdentityHash !== value.after.processAnchor.serviceIdentityHash) throw new TypeError(`restart process/systemd/executable splice at ${path}.after`);
    if (value.graphReuse.beforeGraphRoot !== value.before.graphRoot || value.graphReuse.afterGraphRoot !== value.after.graphRoot || value.graphReuse.beforeReadyRecordHash !== value.before.readyRecordHash || value.graphReuse.afterReadyRecordHash !== value.after.readyRecordHash) throw new TypeError(`graph reuse anchor mismatch at ${path}.graphReuse`);
    for (const [index, observation] of value.graphReuse.graphViewLeaseObservations.entries()) {
      if (observation.processAnchorHash !== value.after.processAnchorHash
        || observation.pid !== value.after.processAnchor.pid
        || observation.processStartTicks !== value.after.processAnchor.processStartTicks) {
        throw new TypeError(`graph view lease process anchor mismatch at ${path}.graphReuse.graphViewLeaseObservations[${index}]`);
      }
      if (observation.generationId !== value.after.generationId
        || observation.graphRoot !== value.after.graphRoot
        || observation.readyRecordHash !== value.after.readyRecordHash
        || observation.sourceCoverageRoot !== value.after.sourceCoverageRoot) {
        throw new TypeError(`graph view lease serving anchor mismatch at ${path}.graphReuse.graphViewLeaseObservations[${index}]`);
      }
    }
    if (value.sigtermRecovery.signalProcessAnchorHash !== value.before.processAnchorHash) throw new TypeError(`SIGTERM process anchor mismatch at ${path}.sigtermRecovery.signalProcessAnchorHash`);
    if (value.before.sourceAnchor.hash === value.after.sourceAnchor.hash && value.before.sourceAnchor.stateRoot === value.after.sourceAnchor.stateRoot) {
      if (value.graphReuse.mode !== "direct-reuse") throw new TypeError(`unchanged source must reuse graph at ${path}.graphReuse.mode`);
      if (value.before.generationId !== value.after.generationId) throw new TypeError(`unchanged source changed generation at ${path}.after.generationId`);
    } else if (value.graphReuse.mode !== "fail-closed") {
      throw new TypeError(`changed source must fail closed at ${path}.graphReuse.mode`);
    }
    const refs = new Map<Hash, RuntimeFactRefV1>();
    for (const [index, ref] of value.factRefs.entries()) {
      if (refs.has(ref.factId)) throw new TypeError(`duplicate fact ref at ${path}.factRefs[${index}]`);
      refs.set(ref.factId, ref);
    }
    if (value.factRefsRoot !== hashList("aloha/runtime-acceptance/fact-ref-root/v1", value.factRefs.map((ref) => ref.factId).sort(compare))) throw new TypeError(`fact refs root mismatch at ${path}.factRefsRoot`);
    const required = [value.before.factRefId, value.after.factRefId, value.graphReuse.factRefId, value.difference.factRefId, value.singleTargetProbe.factRefId, value.sigtermRecovery.factRefId, ...value.difference.previousCandidates.items.map((item) => item.factRefId), ...value.difference.currentCandidates.items.map((item) => item.factRefId), ...value.difference.memoReused.items.map((item) => item.factRefId), ...value.difference.newCandidates.items.map((item) => item.factRefId), ...value.difference.invalidatedDependencyClosure.items.map((item) => item.factRefId), ...value.difference.retryable.items.map((item) => item.factRefId), ...value.difference.rejectionNotReused.items.map((item) => item.factRefId), ...value.singleTargetProbe.beforeOutcomes.items.map((item) => item.factRefId), ...value.singleTargetProbe.afterOutcomes.items.map((item) => item.factRefId), ...value.sigtermRecovery.flushedOutcomes.items.map((item) => item.factRefId), ...value.sigtermRecovery.afterRestartOutcomes.items.map((item) => item.factRefId)];
    for (const [index, factRefId] of required.entries()) if (!refs.has(factRefId)) throw new TypeError(`missing content-addressed fact ref at ${path}.factRefs[${index}]`);
    return value;
  },
);

const locatorListSchema = defineSchema<readonly ReadOnlyArtifactLocatorV1[]>(
  { kind: "sorted-read-only-artifact-locators", item: locatorSchema.descriptor },
  (value, path = "$") => {
    if (!Array.isArray(value)) throw new TypeError(`expected locator array at ${path}`);
    const decoded = value.map((item, index) => locatorSchema.decode(item, `${path}[${index}]`));
    const ids = decoded.map((item) => locatorId(item));
    assertSortedUnique(ids, path);
    return Object.freeze(decoded);
  },
);

const logicalKeySchema = refineSchema(
  nonEmptyStringSchema,
  "aloha.legacy-authority-closure.logical-key.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.logical-key.refinement.v1",
    version: "1.0.0",
    rules: ["logical-not-host-path", "forward-slash", "no-dot-segments"],
  }),
  (value, path) => {
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) throw new TypeError(`absolute path is forbidden at ${path}`);
    if (value.includes("\\")) throw new TypeError(`backslash is forbidden in logical key at ${path}`);
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError(`logical key is not normalized at ${path}`);
    return value;
  },
);

const artifactLogicalKeySchema = refineSchema(
  logicalKeySchema,
  "aloha.legacy-authority-closure.artifact-logical-key.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.artifact-logical-key.refinement.v1",
    version: "1.0.0",
    rules: ["qualified-origin-namespace", "qualified-authority-shape-namespace", "non-empty-subject"],
  }),
  (value, path) => {
    const [origin, authorityShape, ...subject] = value.split("/");
    if (!(["candidate", "external", "reference"] as const).includes(origin as never)) throw new TypeError(`unknown repository origin namespace at ${path}`);
    if (!(["neutral", "strict-authority", "legacy-shaped-authority", "compatibility-facade-or-fallback"] as const).includes(authorityShape as never)) throw new TypeError(`unknown authority shape namespace at ${path}`);
    if (subject.length === 0) throw new TypeError(`artifact logical subject is missing at ${path}`);
    return value;
  },
);
const closureRelationSchema = enumSchema(["binds", "consumes", "deploys", "emits", "executes", "imports", "loads", "owns", "resolves-to", "spawns"] as const);
const entrypointKindSchema = enumSchema(["consumer", "executable", "release-intent", "runtime-log-window", "rust-binary", "solidity-deployment", "systemd-exec", "ts-js", "worker-child"] as const);

const legacyRawArtifactPayloadFields = {
  logicalKey: artifactLogicalKeySchema,
  contentSha256: nonZeroHashSchema,
  byteLength: uintSchema,
  factRefId: nonZeroHashSchema,
  locatorId: nonZeroHashSchema,
  locator: locatorSchema,
} as const;
const legacyRawArtifactPayloadSchema = objectSchema(legacyRawArtifactPayloadFields);
export type LegacyClosureRawArtifactPayloadV1 = Infer<typeof legacyRawArtifactPayloadSchema>;
const legacyRawArtifactStructuralSchema = objectSchema({ artifactId: nonZeroHashSchema, ...legacyRawArtifactPayloadFields });
export type LegacyClosureRawArtifactV1 = Infer<typeof legacyRawArtifactStructuralSchema>;

function legacyRawArtifactPayload(value: LegacyClosureRawArtifactV1): LegacyClosureRawArtifactPayloadV1 {
  const { artifactId: _artifactId, ...payload } = value;
  return payload;
}

const legacyRawArtifactSchema = refineSchema(
  legacyRawArtifactStructuralSchema,
  "aloha.legacy-authority-closure.raw-artifact.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.raw-artifact.refinement.v1",
    version: "1.0.0",
    rules: ["artifact-id", "locator-id", "content-addressed", "logical-not-host-path"],
  }),
  (value, path) => {
    if (value.locatorId !== locatorId(value.locator)) throw new TypeError(`raw artifact locator id mismatch at ${path}.locatorId`);
    if (value.artifactId !== hashDomain("aloha/legacy-authority-closure/raw-artifact/v1", legacyRawArtifactPayload(value))) throw new TypeError(`raw artifact id mismatch at ${path}.artifactId`);
    return value;
  },
);

const legacyRawEdgePayloadFields = {
  relation: closureRelationSchema,
  sourceArtifactId: nonZeroHashSchema,
  targetArtifactId: nullableSchema(nonZeroHashSchema),
  targetLogicalKey: logicalKeySchema,
  locatorId: nonZeroHashSchema,
  locator: locatorSchema,
} as const;
const legacyRawEdgeStructuralSchema = objectSchema({ edgeId: nonZeroHashSchema, ...legacyRawEdgePayloadFields });
export type LegacyClosureRawEdgeV1 = Infer<typeof legacyRawEdgeStructuralSchema>;
function legacyRawEdgePayload(value: LegacyClosureRawEdgeV1): Omit<LegacyClosureRawEdgeV1, "edgeId"> {
  const { edgeId: _edgeId, ...payload } = value;
  return payload;
}
const legacyRawEdgeSchema = refineSchema(
  legacyRawEdgeStructuralSchema,
  "aloha.legacy-authority-closure.raw-edge.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.raw-edge.refinement.v1",
    version: "1.0.0",
    rules: ["edge-id", "locator-id", "explicit-unresolved-target"],
  }),
  (value, path) => {
    if (value.locatorId !== locatorId(value.locator)) throw new TypeError(`raw edge locator id mismatch at ${path}.locatorId`);
    if (value.edgeId !== hashDomain("aloha/legacy-authority-closure/raw-edge/v1", legacyRawEdgePayload(value))) throw new TypeError(`raw edge id mismatch at ${path}.edgeId`);
    return value;
  },
);

const legacyRawEntrypointPayloadFields = {
  entrypointKind: entrypointKindSchema,
  logicalKey: logicalKeySchema,
  artifactId: nullableSchema(nonZeroHashSchema),
  locatorId: nonZeroHashSchema,
  locator: locatorSchema,
} as const;
const legacyRawEntrypointStructuralSchema = objectSchema({ entrypointId: nonZeroHashSchema, ...legacyRawEntrypointPayloadFields });
export type LegacyClosureRawEntrypointV1 = Infer<typeof legacyRawEntrypointStructuralSchema>;
function legacyRawEntrypointPayload(value: LegacyClosureRawEntrypointV1): Omit<LegacyClosureRawEntrypointV1, "entrypointId"> {
  const { entrypointId: _entrypointId, ...payload } = value;
  return payload;
}
const legacyRawEntrypointSchema = refineSchema(
  legacyRawEntrypointStructuralSchema,
  "aloha.legacy-authority-closure.raw-entrypoint.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.raw-entrypoint.refinement.v1",
    version: "1.0.0",
    rules: ["entrypoint-id", "locator-id", "explicit-unresolved-artifact"],
  }),
  (value, path) => {
    if (value.locatorId !== locatorId(value.locator)) throw new TypeError(`raw entrypoint locator id mismatch at ${path}.locatorId`);
    if (value.entrypointId !== hashDomain("aloha/legacy-authority-closure/raw-entrypoint/v1", legacyRawEntrypointPayload(value))) throw new TypeError(`raw entrypoint id mismatch at ${path}.entrypointId`);
    return value;
  },
);

const pairHashSchema = defineSchema<readonly [Hash, Hash]>(
  { kind: "hash-pair" },
  (value, path = "$") => {
    if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`expected a two-element hash pair at ${path}`);
    const first = nonZeroHashSchema.decode(value[0], `${path}[0]`);
    const second = nonZeroHashSchema.decode(value[1], `${path}[1]`);
    if (first === second) throw new TypeError(`hash pair entries must be distinct at ${path}`);
    return Object.freeze([first, second]);
  },
);

const legacyClosureStructuralSchema = objectSchema({
  receiptId: nonZeroHashSchema,
  predicateSpecDigests: pairHashSchema,
  qualificationCertificateIds: pairHashSchema,
  rawDenominatorRoot: nonZeroHashSchema,
  releaseIntentRoot: nonZeroHashSchema,
  productionEntrypointDenominatorRoot: nonZeroHashSchema,
  tsJsAstModuleClosureRoot: nonZeroHashSchema,
  generatedAndPackageAliasClosureRoot: nonZeroHashSchema,
  workerChildDynamicEntrypointRoot: nonZeroHashSchema,
  rustBinaryClosureRoot: nonZeroHashSchema,
  solidityDeploymentAndAbiOwnershipRoot: nonZeroHashSchema,
  deployManifestAndSystemdExecRoot: nonZeroHashSchema,
  executableLoadedObjectRoot: nonZeroHashSchema,
  consumerObjectLineageRoot: nonZeroHashSchema,
  runtimeLogWindowRoot: nonZeroHashSchema,
  unresolvedEntrypointRefs: locatorListSchema,
  oldRepositoryLoadBearingRefs: locatorListSchema,
  forbiddenAuthorityRefs: locatorListSchema,
  compatibilityFacadeOrFallbackRefs: locatorListSchema,
});
export type LegacyAuthorityClosureReceiptV1 = Infer<typeof legacyClosureStructuralSchema>;

function legacyPayload(value: LegacyAuthorityClosureReceiptV1): Omit<LegacyAuthorityClosureReceiptV1, "receiptId"> {
  const { receiptId: _receiptId, ...payload } = value;
  return payload;
}

const legacyClosureSchema = refineSchema(
  legacyClosureStructuralSchema,
  "aloha.legacy-authority-closure.receipt.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.receipt.refinement.v1",
    version: "1.0.0",
    rules: ["receipt-id", "fixed-predicate-order", "content-addressed-locators", "unresolved-invalid", "observed-refs-fail"],
  }),
  (value, path) => {
    if (value.receiptId !== hashDomain("aloha/legacy-authority-closure/receipt/v1", legacyPayload(value))) throw new TypeError(`legacy closure receipt id mismatch at ${path}.receiptId`);
    const allRoots = [value.releaseIntentRoot, value.productionEntrypointDenominatorRoot, value.tsJsAstModuleClosureRoot, value.generatedAndPackageAliasClosureRoot, value.workerChildDynamicEntrypointRoot, value.rustBinaryClosureRoot, value.solidityDeploymentAndAbiOwnershipRoot, value.deployManifestAndSystemdExecRoot, value.executableLoadedObjectRoot, value.consumerObjectLineageRoot, value.runtimeLogWindowRoot];
    assertPositiveHashes(allRoots, `${path}.roots`);
    return value;
  },
);

export const LEGACY_CLOSURE_ROOT_ROLES = Object.freeze([
  "consumer-object-lineage",
  "deploy-manifest-systemd-exec",
  "executable-loaded-object",
  "generated-package-alias-closure",
  "production-entrypoint-denominator",
  "release-intent",
  "runtime-log-window",
  "rust-binary-closure",
  "solidity-deployment-abi-ownership",
  "ts-js-ast-module-closure",
  "worker-child-dynamic-entrypoint",
] as const);
export type LegacyClosureRootRoleV1 = (typeof LEGACY_CLOSURE_ROOT_ROLES)[number];

const legacyClosureRootRoleSchema = enumSchema(LEGACY_CLOSURE_ROOT_ROLES);
const legacyClosureFactPayloadFields = {
  role: legacyClosureRootRoleSchema,
  entrypointIds: arraySchema(nonZeroHashSchema),
  artifactIds: arraySchema(nonZeroHashSchema),
  edgeIds: arraySchema(nonZeroHashSchema),
  observedRoot: nonZeroHashSchema,
} as const;

const legacyClosureFactPayloadSchema = objectSchema(legacyClosureFactPayloadFields);
export type LegacyClosureRootFactPayloadV1 = Infer<typeof legacyClosureFactPayloadSchema>;

const legacyClosureFactStructuralSchema = objectSchema({
  ...legacyClosureFactPayloadFields,
  factRefId: nonZeroHashSchema,
});
export type LegacyClosureFactV1 = Infer<typeof legacyClosureFactStructuralSchema>;

const legacyClosureFactSchema = refineSchema(
  legacyClosureFactStructuralSchema,
  "aloha.legacy-authority-closure.fact.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.fact.refinement.v1",
    version: "1.0.0",
    rules: ["role", "raw-membership", "observed-root", "fact-ref"],
  }),
  (value, path) => {
    assertSortedUnique(value.entrypointIds, `${path}.entrypointIds`);
    assertSortedUnique(value.artifactIds, `${path}.artifactIds`);
    assertSortedUnique(value.edgeIds, `${path}.edgeIds`);
    const expected = hashDomain("aloha/legacy-authority-closure/role-root/v2", {
      role: value.role,
      entrypointIds: value.entrypointIds,
      artifactIds: value.artifactIds,
      edgeIds: value.edgeIds,
    });
    if (value.observedRoot !== expected) throw new TypeError(`legacy closure observed root mismatch at ${path}.observedRoot`);
    return value;
  },
);

const legacyRawDenominatorStructuralSchema = objectSchema({
  denominatorId: nonZeroHashSchema,
  artifacts: arraySchema(legacyRawArtifactSchema),
  edges: arraySchema(legacyRawEdgeSchema),
  entrypoints: arraySchema(legacyRawEntrypointSchema),
  closures: arraySchema(legacyClosureFactSchema),
});
export type LegacyClosureRawDenominatorV1 = Infer<typeof legacyRawDenominatorStructuralSchema>;

function closurePayload(value: LegacyClosureFactV1): Omit<LegacyClosureFactV1, "factRefId"> {
  const { factRefId: _factRefId, ...payload } = value;
  return payload;
}

function rawDenominatorPayload(value: LegacyClosureRawDenominatorV1) {
  return {
    artifacts: value.artifacts,
    edges: value.edges,
    entrypoints: value.entrypoints,
    closures: value.closures.map(closurePayload),
  };
}

const legacyRawDenominatorSchema = refineSchema(
  legacyRawDenominatorStructuralSchema,
  "aloha.legacy-authority-closure.raw-denominator.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.raw-denominator.refinement.v1",
    version: "1.0.0",
    rules: ["content-addressed-records", "all-roles", "exact-denominator", "resolved-membership", "no-orphans"],
  }),
  (value, path) => {
    const artifactIds = value.artifacts.map((item) => item.artifactId);
    const edgeIds = value.edges.map((item) => item.edgeId);
    const entrypointIds = value.entrypoints.map((item) => item.entrypointId);
    const roles = value.closures.map((item) => item.role);
    assertSortedUnique(artifactIds, `${path}.artifacts`);
    assertSortedUnique(edgeIds, `${path}.edges`);
    assertSortedUnique(entrypointIds, `${path}.entrypoints`);
    assertSortedUnique(roles, `${path}.closures`);
    if (roles.length !== LEGACY_CLOSURE_ROOT_ROLES.length || roles.some((role, index) => role !== LEGACY_CLOSURE_ROOT_ROLES[index])) throw new TypeError(`legacy closure role denominator mismatch at ${path}.closures`);
    const artifacts = new Set(artifactIds);
    const edges = new Set(edgeIds);
    const entrypoints = new Set(entrypointIds);
    for (const [index, edge] of value.edges.entries()) {
      if (!artifacts.has(edge.sourceArtifactId)) throw new TypeError(`raw edge source is missing at ${path}.edges[${index}].sourceArtifactId`);
      if (edge.targetArtifactId !== null && !artifacts.has(edge.targetArtifactId)) throw new TypeError(`raw edge target is missing at ${path}.edges[${index}].targetArtifactId`);
    }
    for (const [index, entrypoint] of value.entrypoints.entries()) {
      if (entrypoint.artifactId !== null && !artifacts.has(entrypoint.artifactId)) throw new TypeError(`raw entrypoint artifact is missing at ${path}.entrypoints[${index}].artifactId`);
    }
    const usedArtifacts = new Set<Hash>();
    const usedEdges = new Set<Hash>();
    const usedEntrypoints = new Set<Hash>();
    for (const [index, closure] of value.closures.entries()) {
      for (const id of closure.artifactIds) {
        if (!artifacts.has(id)) throw new TypeError(`closure artifact is missing at ${path}.closures[${index}].artifactIds`);
        usedArtifacts.add(id);
      }
      for (const id of closure.edgeIds) {
        if (!edges.has(id)) throw new TypeError(`closure edge is missing at ${path}.closures[${index}].edgeIds`);
        usedEdges.add(id);
      }
      for (const id of closure.entrypointIds) {
        if (!entrypoints.has(id)) throw new TypeError(`closure entrypoint is missing at ${path}.closures[${index}].entrypointIds`);
        usedEntrypoints.add(id);
      }
    }
    if (usedArtifacts.size !== artifacts.size || usedEdges.size !== edges.size || usedEntrypoints.size !== entrypoints.size) throw new TypeError(`raw denominator contains orphan records at ${path}`);
    const denominator = value.closures.find((closure) => closure.role === "production-entrypoint-denominator")!;
    if (encodeCanonicalJson(denominator.entrypointIds) !== encodeCanonicalJson(entrypointIds) || encodeCanonicalJson(denominator.artifactIds) !== encodeCanonicalJson(artifactIds) || encodeCanonicalJson(denominator.edgeIds) !== encodeCanonicalJson(edgeIds)) throw new TypeError(`production entrypoint denominator is not exact at ${path}.closures`);
    if (value.denominatorId !== hashDomain("aloha/legacy-authority-closure/raw-denominator/v1", rawDenominatorPayload(value))) throw new TypeError(`raw denominator id mismatch at ${path}.denominatorId`);
    return value;
  },
);

const legacyClosureFactsStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.legacy-authority-closure-facts"),
  receipt: legacyClosureSchema,
  factRefs: arraySchema(runtimeFactRefSchema),
  denominator: legacyRawDenominatorSchema,
  factRefsRoot: nonZeroHashSchema,
  closureFactsRoot: nonZeroHashSchema,
  evidenceId: nonZeroHashSchema,
});
export type LegacyAuthorityClosureFactsV1 = Infer<typeof legacyClosureFactsStructuralSchema>;

const legacyRootFieldByRole: Readonly<Record<LegacyClosureRootRoleV1, keyof Omit<LegacyAuthorityClosureReceiptV1, "receiptId" | "predicateSpecDigests" | "qualificationCertificateIds" | "rawDenominatorRoot" | "unresolvedEntrypointRefs" | "oldRepositoryLoadBearingRefs" | "forbiddenAuthorityRefs" | "compatibilityFacadeOrFallbackRefs">>> = Object.freeze({
  "release-intent": "releaseIntentRoot",
  "production-entrypoint-denominator": "productionEntrypointDenominatorRoot",
  "ts-js-ast-module-closure": "tsJsAstModuleClosureRoot",
  "generated-package-alias-closure": "generatedAndPackageAliasClosureRoot",
  "worker-child-dynamic-entrypoint": "workerChildDynamicEntrypointRoot",
  "rust-binary-closure": "rustBinaryClosureRoot",
  "solidity-deployment-abi-ownership": "solidityDeploymentAndAbiOwnershipRoot",
  "deploy-manifest-systemd-exec": "deployManifestAndSystemdExecRoot",
  "executable-loaded-object": "executableLoadedObjectRoot",
  "consumer-object-lineage": "consumerObjectLineageRoot",
  "runtime-log-window": "runtimeLogWindowRoot",
});

const legacyClosureFactsSchema = refineSchema(
  legacyClosureFactsStructuralSchema,
  "aloha.legacy-authority-closure.facts.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-closure.facts.refinement.v1",
    version: "1.0.0",
    rules: ["all-roles", "fact-ref-root", "closure-root", "receipt-root-cross-check", "unresolved-invalid"],
  }),
  (value, path) => {
    const refs = new Map<Hash, RuntimeFactRefV1>();
    for (const [index, ref] of value.factRefs.entries()) {
      if (refs.has(ref.factId)) throw new TypeError(`duplicate legacy closure fact ref at ${path}.factRefs[${index}]`);
      refs.set(ref.factId, ref);
    }
    if (value.factRefsRoot !== hashList("aloha/runtime-acceptance/fact-ref-root/v1", value.factRefs.map((ref) => ref.factId).sort(compare))) throw new TypeError(`legacy closure fact ref root mismatch at ${path}.factRefsRoot`);
    const usedRefs = new Set<Hash>();
    for (const [index, artifact] of value.denominator.artifacts.entries()) {
      const ref = refs.get(artifact.factRefId);
      if (ref === undefined || ref.contentSha256 !== artifact.contentSha256 || ref.byteLength !== artifact.byteLength || ref.locatorId !== artifact.locatorId || encodeCanonicalJson(ref.locator) !== encodeCanonicalJson(artifact.locator)) throw new TypeError(`raw artifact fact ref mismatch at ${path}.denominator.artifacts[${index}].factRefId`);
      usedRefs.add(artifact.factRefId);
    }
    for (const [index, fact] of value.denominator.closures.entries()) {
      if (!refs.has(fact.factRefId)) throw new TypeError(`legacy closure fact ref missing at ${path}.closureFacts[${index}].factRefId`);
      usedRefs.add(fact.factRefId);
      const field = legacyRootFieldByRole[fact.role];
      if (fact.observedRoot !== value.receipt[field]) throw new TypeError(`legacy closure root mismatch at ${path}.closureFacts[${index}].observedRoot`);
    }
    if (usedRefs.size !== refs.size) throw new TypeError(`legacy closure contains unbound fact refs at ${path}.factRefs`);
    if (value.receipt.rawDenominatorRoot !== value.denominator.denominatorId) throw new TypeError(`legacy raw denominator root mismatch at ${path}.receipt.rawDenominatorRoot`);
    if (value.closureFactsRoot !== hashDomain("aloha/legacy-authority-closure/facts-root/v2", value.denominator.closures)) throw new TypeError(`legacy closure facts root mismatch at ${path}.closureFactsRoot`);
    const unresolved = [...value.denominator.entrypoints.filter((entrypoint) => entrypoint.artifactId === null).map((entrypoint) => entrypoint.locator), ...value.denominator.edges.filter((edge) => edge.targetArtifactId === null).map((edge) => edge.locator)].sort((left, right) => compare(locatorId(left), locatorId(right)));
    const oldRepository = value.denominator.artifacts.filter((artifact) => artifact.logicalKey.split("/")[0] === "reference").map((artifact) => artifact.locator).sort((left, right) => compare(locatorId(left), locatorId(right)));
    const forbiddenAuthority = value.denominator.artifacts.filter((artifact) => artifact.logicalKey.split("/")[1] === "legacy-shaped-authority").map((artifact) => artifact.locator).sort((left, right) => compare(locatorId(left), locatorId(right)));
    const compatibility = value.denominator.artifacts.filter((artifact) => artifact.logicalKey.split("/")[1] === "compatibility-facade-or-fallback").map((artifact) => artifact.locator).sort((left, right) => compare(locatorId(left), locatorId(right)));
    const derivedLocatorLists = [[value.receipt.unresolvedEntrypointRefs, unresolved, "unresolvedEntrypointRefs"], [value.receipt.oldRepositoryLoadBearingRefs, oldRepository, "oldRepositoryLoadBearingRefs"], [value.receipt.forbiddenAuthorityRefs, forbiddenAuthority, "forbiddenAuthorityRefs"], [value.receipt.compatibilityFacadeOrFallbackRefs, compatibility, "compatibilityFacadeOrFallbackRefs"]] as const;
    for (const [observed, derived, field] of derivedLocatorLists) if (encodeCanonicalJson(observed) !== encodeCanonicalJson(derived)) throw new TypeError(`legacy closure derived locator mismatch at ${path}.receipt.${field}`);
    const { evidenceId: _evidenceId, ...withoutId } = value;
    if (value.evidenceId !== hashDomain("aloha/legacy-authority-closure/facts/v1", withoutId)) throw new TypeError(`legacy closure evidence id mismatch at ${path}.evidenceId`);
    return value;
  },
);

const legacyAggregateStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.legacy-authority-zero-aggregate-facts"),
  facts: legacyClosureFactsSchema,
  aggregateId: nonZeroHashSchema,
});
export type LegacyAuthorityZeroAggregateFactsV1 = Infer<typeof legacyAggregateStructuralSchema>;

const legacyAggregateSchema = refineSchema(
  legacyAggregateStructuralSchema,
  "aloha.legacy-authority-zero.aggregate.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.legacy-authority-zero.aggregate.refinement.v1",
    version: "1.0.0",
    rules: ["aggregate-id", "and-only"],
  }),
  (value, path) => {
    const expected = hashDomain("aloha/legacy-authority-zero/aggregate/v2", value.facts.evidenceId);
    if (value.aggregateId !== expected) throw new TypeError(`legacy aggregate id mismatch at ${path}.aggregateId`);
    return value;
  },
);

export const RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS = Object.freeze({
  factLocator: defineSchemaManifest("aloha.runtime-acceptance-fact-locator", "1.0.0", runtimeAcceptanceFactLocatorSchema),
  factRef: defineSchemaManifest("aloha.runtime-acceptance-fact-ref", "1.0.0", runtimeFactRefSchema),
  hashPartition: defineSchemaManifest("aloha.runtime-acceptance-hash-partition", "1.0.0", hashPartitionSchema),
  processAnchorFactPayload: defineSchemaManifest("aloha.runtime-acceptance-process-anchor-fact-payload", "1.0.0", runtimeAnchorPayloadSchema),
  candidateOutcomeFactPayload: defineSchemaManifest("aloha.runtime-acceptance-candidate-outcome-fact-payload", "1.0.0", candidateOutcomePayloadSchema),
  candidateDeltaFactPayload: defineSchemaManifest("aloha.runtime-acceptance-candidate-delta-fact-payload", "1.0.0", deltaItemPayloadSchema),
  restartDifferenceFactPayload: defineSchemaManifest("aloha.runtime-acceptance-restart-difference-fact-payload", "1.0.0", restartDifferencePayloadSchema),
  singleTargetProbeFactPayload: defineSchemaManifest("aloha.runtime-acceptance-single-target-probe-fact-payload", "1.0.0", singleTargetProbePayloadSchema),
  sigtermRecoveryFactPayload: defineSchemaManifest("aloha.runtime-acceptance-sigterm-recovery-fact-payload", "1.0.0", sigtermRecoveryPayloadSchema),
  graphReuseFactPayload: defineSchemaManifest("aloha.runtime-acceptance-graph-reuse-fact-payload", "1.0.0", graphReusePayloadSchema),
  legacyClosureRawArtifactPayload: defineSchemaManifest("aloha.legacy-authority-closure-raw-artifact-payload", "1.0.0", legacyRawArtifactPayloadSchema),
  legacyClosureRootFactPayload: defineSchemaManifest("aloha.legacy-authority-closure-root-fact-payload", "2.0.0", legacyClosureFactPayloadSchema),
  legacyClosureRawDenominator: defineSchemaManifest("aloha.legacy-authority-closure-raw-denominator", "1.0.0", legacyRawDenominatorSchema),
  processAnchorFacts: defineSchemaManifest("aloha.runtime-acceptance-process-anchor-facts", "1.0.0", runtimeAnchorSchema),
  candidateOutcomePartition: defineSchemaManifest("aloha.runtime-acceptance-candidate-outcome-partition", "1.0.0", candidateOutcomePartitionSchema),
  candidateDeltaPartition: defineSchemaManifest("aloha.runtime-acceptance-candidate-delta-partition", "1.0.0", deltaPartitionSchema),
  restartDifference: defineSchemaManifest("aloha.runtime-acceptance-restart-difference", "1.0.0", restartDifferenceSchema),
  singleTargetProbe: defineSchemaManifest("aloha.runtime-acceptance-single-target-probe", "1.0.0", singleTargetProbeSchema),
  sigtermRecovery: defineSchemaManifest("aloha.runtime-acceptance-sigterm-recovery", "1.0.0", sigtermRecoverySchema),
  graphReuse: defineSchemaManifest("aloha.runtime-acceptance-graph-reuse", "1.0.0", graphReuseSchema),
  restartFacts: defineSchemaManifest("aloha.runtime-restart-facts", "1.0.0", runtimeRestartSchema),
  legacyClosureReceipt: defineSchemaManifest("aloha.legacy-authority-closure-receipt", "2.0.0", legacyClosureSchema),
  legacyClosureFacts: defineSchemaManifest("aloha.legacy-authority-closure-facts", "2.0.0", legacyClosureFactsSchema),
  legacyAggregate: defineSchemaManifest("aloha.legacy-authority-zero-aggregate-facts", "2.0.0", legacyAggregateSchema),
});

export function decodeRuntimeAcceptanceFactLocator(
  value: RuntimeAcceptanceCodecInput,
): RuntimeAcceptanceFactLocatorV1 {
  return runtimeAcceptanceFactLocatorSchema.decode(parse(value));
}

export function createRuntimeAcceptanceFactLocator(
  payload: Omit<RuntimeAcceptanceFactLocatorV1, "schemaVersion" | "kind">,
): RuntimeAcceptanceFactLocatorV1 {
  return decodeRuntimeAcceptanceFactLocator({
    schemaVersion: 1,
    kind: "aloha.runtime-acceptance-fact-locator",
    ...payload,
  });
}

export function encodeRuntimeAcceptanceFactLocator(
  value: RuntimeAcceptanceFactLocatorV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeRuntimeAcceptanceFactLocator(value));
}

export function decodeRuntimeFactRef(value: RuntimeAcceptanceCodecInput): RuntimeFactRefV1 {
  return runtimeFactRefSchema.decode(parse(value));
}

export function sealRuntimeFactRef(
  payload: Omit<RuntimeFactRefV1, "factId" | "locatorId">,
): RuntimeFactRefV1 {
  const nextLocatorId = locatorId(payload.locator);
  const factId = hashDomain("aloha/runtime-acceptance/fact-ref/v1", {
    artifactRefId: payload.artifactRefId,
    contentSha256: payload.contentSha256,
    byteLength: payload.byteLength,
    schema: payload.schema,
    locatorId: nextLocatorId,
  });
  return decodeRuntimeFactRef({ ...payload, locatorId: nextLocatorId, factId });
}

export function decodeRuntimeRestartFacts(value: RuntimeAcceptanceCodecInput): RuntimeRestartFactsV1 {
  return runtimeRestartSchema.decode(parse(value));
}

export function encodeRuntimeRestartFacts(value: RuntimeRestartFactsV1): Uint8Array {
  return encodeCanonicalBytes(decodeRuntimeRestartFacts(value));
}

export function decodeLegacyAuthorityClosureReceipt(value: RuntimeAcceptanceCodecInput): LegacyAuthorityClosureReceiptV1 {
  return legacyClosureSchema.decode(parse(value));
}

export function decodeLegacyAuthorityClosureFacts(value: RuntimeAcceptanceCodecInput): LegacyAuthorityClosureFactsV1 {
  return legacyClosureFactsSchema.decode(parse(value));
}

export function encodeLegacyAuthorityClosureReceipt(value: LegacyAuthorityClosureReceiptV1): Uint8Array {
  return encodeCanonicalBytes(decodeLegacyAuthorityClosureReceipt(value));
}

export function encodeLegacyAuthorityClosureFacts(value: LegacyAuthorityClosureFactsV1): Uint8Array {
  return encodeCanonicalBytes(decodeLegacyAuthorityClosureFacts(value));
}

export function decodeLegacyClosureRawArtifact(value: RuntimeAcceptanceCodecInput): LegacyClosureRawArtifactV1 {
  return legacyRawArtifactSchema.decode(parse(value));
}

export function sealLegacyClosureRawArtifact(
  payload: LegacyClosureRawArtifactPayloadV1,
): LegacyClosureRawArtifactV1 {
  const decoded = legacyRawArtifactPayloadSchema.decode(payload);
  return decodeLegacyClosureRawArtifact({
    ...decoded,
    artifactId: hashDomain("aloha/legacy-authority-closure/raw-artifact/v1", decoded),
  });
}

export function decodeLegacyClosureRawEdge(value: RuntimeAcceptanceCodecInput): LegacyClosureRawEdgeV1 {
  return legacyRawEdgeSchema.decode(parse(value));
}

export function sealLegacyClosureRawEdge(
  payload: Omit<LegacyClosureRawEdgeV1, "edgeId">,
): LegacyClosureRawEdgeV1 {
  const withPlaceholder = legacyRawEdgeStructuralSchema.decode({ ...payload, edgeId: hashDomain("aloha/legacy-authority-closure/raw-edge/placeholder/v1", payload) });
  const decodedPayload = legacyRawEdgePayload(withPlaceholder);
  return decodeLegacyClosureRawEdge({ ...decodedPayload, edgeId: hashDomain("aloha/legacy-authority-closure/raw-edge/v1", decodedPayload) });
}

export function decodeLegacyClosureRawEntrypoint(value: RuntimeAcceptanceCodecInput): LegacyClosureRawEntrypointV1 {
  return legacyRawEntrypointSchema.decode(parse(value));
}

export function sealLegacyClosureRawEntrypoint(
  payload: Omit<LegacyClosureRawEntrypointV1, "entrypointId">,
): LegacyClosureRawEntrypointV1 {
  const withPlaceholder = legacyRawEntrypointStructuralSchema.decode({ ...payload, entrypointId: hashDomain("aloha/legacy-authority-closure/raw-entrypoint/placeholder/v1", payload) });
  const decodedPayload = legacyRawEntrypointPayload(withPlaceholder);
  return decodeLegacyClosureRawEntrypoint({ ...decodedPayload, entrypointId: hashDomain("aloha/legacy-authority-closure/raw-entrypoint/v1", decodedPayload) });
}

export function sealLegacyClosureFact(
  payload: Omit<LegacyClosureFactV1, "observedRoot">,
): LegacyClosureFactV1 {
  const normalized = {
    ...payload,
    entrypointIds: [...payload.entrypointIds].sort(compare),
    artifactIds: [...payload.artifactIds].sort(compare),
    edgeIds: [...payload.edgeIds].sort(compare),
  };
  return legacyClosureFactSchema.decode({
    ...normalized,
    observedRoot: hashDomain("aloha/legacy-authority-closure/role-root/v2", {
      role: normalized.role,
      entrypointIds: normalized.entrypointIds,
      artifactIds: normalized.artifactIds,
      edgeIds: normalized.edgeIds,
    }),
  });
}

export function decodeLegacyClosureRawDenominator(value: RuntimeAcceptanceCodecInput): LegacyClosureRawDenominatorV1 {
  return legacyRawDenominatorSchema.decode(parse(value));
}

export function sealLegacyClosureRawDenominator(
  payload: Omit<LegacyClosureRawDenominatorV1, "denominatorId">,
): LegacyClosureRawDenominatorV1 {
  const normalized = {
    artifacts: [...payload.artifacts].sort((left, right) => compare(left.artifactId, right.artifactId)),
    edges: [...payload.edges].sort((left, right) => compare(left.edgeId, right.edgeId)),
    entrypoints: [...payload.entrypoints].sort((left, right) => compare(left.entrypointId, right.entrypointId)),
    closures: [...payload.closures].sort((left, right) => compare(left.role, right.role)),
  };
  const provisional = { ...normalized, denominatorId: hashDomain("aloha/legacy-authority-closure/raw-denominator/placeholder/v1", normalized) } as LegacyClosureRawDenominatorV1;
  return decodeLegacyClosureRawDenominator({
    ...normalized,
    denominatorId: hashDomain("aloha/legacy-authority-closure/raw-denominator/v1", rawDenominatorPayload(provisional)),
  });
}

function uniqueSortedLocators(values: readonly ReadOnlyArtifactLocatorV1[]): readonly ReadOnlyArtifactLocatorV1[] {
  const byId = new Map<Hash, ReadOnlyArtifactLocatorV1>();
  for (const value of values) byId.set(locatorId(value), value);
  return [...byId.entries()].sort(([left], [right]) => compare(left, right)).map(([, value]) => value);
}

export function deriveLegacyAuthorityClosureReceipt(
  predicateSpecDigests: readonly [Hash, Hash],
  qualificationCertificateIds: readonly [Hash, Hash],
  denominator: LegacyClosureRawDenominatorV1,
): LegacyAuthorityClosureReceiptV1 {
  const decoded = decodeLegacyClosureRawDenominator(denominator);
  const closures = new Map(decoded.closures.map((closure) => [closure.role, closure.observedRoot]));
  const unresolvedEntrypointRefs = uniqueSortedLocators([
    ...decoded.entrypoints.filter((entrypoint) => entrypoint.artifactId === null).map((entrypoint) => entrypoint.locator),
    ...decoded.edges.filter((edge) => edge.targetArtifactId === null).map((edge) => edge.locator),
  ]);
  return sealLegacyAuthorityClosureReceipt({
    predicateSpecDigests,
    qualificationCertificateIds,
    rawDenominatorRoot: decoded.denominatorId,
    releaseIntentRoot: closures.get("release-intent")!,
    productionEntrypointDenominatorRoot: closures.get("production-entrypoint-denominator")!,
    tsJsAstModuleClosureRoot: closures.get("ts-js-ast-module-closure")!,
    generatedAndPackageAliasClosureRoot: closures.get("generated-package-alias-closure")!,
    workerChildDynamicEntrypointRoot: closures.get("worker-child-dynamic-entrypoint")!,
    rustBinaryClosureRoot: closures.get("rust-binary-closure")!,
    solidityDeploymentAndAbiOwnershipRoot: closures.get("solidity-deployment-abi-ownership")!,
    deployManifestAndSystemdExecRoot: closures.get("deploy-manifest-systemd-exec")!,
    executableLoadedObjectRoot: closures.get("executable-loaded-object")!,
    consumerObjectLineageRoot: closures.get("consumer-object-lineage")!,
    runtimeLogWindowRoot: closures.get("runtime-log-window")!,
    unresolvedEntrypointRefs,
    oldRepositoryLoadBearingRefs: uniqueSortedLocators(decoded.artifacts.filter((artifact) => artifact.logicalKey.split("/")[0] === "reference").map((artifact) => artifact.locator)),
    forbiddenAuthorityRefs: uniqueSortedLocators(decoded.artifacts.filter((artifact) => artifact.logicalKey.split("/")[1] === "legacy-shaped-authority").map((artifact) => artifact.locator)),
    compatibilityFacadeOrFallbackRefs: uniqueSortedLocators(decoded.artifacts.filter((artifact) => artifact.logicalKey.split("/")[1] === "compatibility-facade-or-fallback").map((artifact) => artifact.locator)),
  });
}

export function sealLegacyAuthorityClosureFacts(
  receipt: LegacyAuthorityClosureReceiptV1,
  factRefs: readonly RuntimeFactRefV1[],
  denominator: LegacyClosureRawDenominatorV1,
): LegacyAuthorityClosureFactsV1 {
  const decodedReceipt = decodeLegacyAuthorityClosureReceipt(receipt);
  const decodedRefs = factRefs.map((ref) => runtimeFactRefSchema.decode(ref));
  const decodedDenominator = decodeLegacyClosureRawDenominator(denominator);
  const payload = {
    schemaVersion: 1 as const,
    kind: "aloha.legacy-authority-closure-facts" as const,
    receipt: decodedReceipt,
    factRefs: decodedRefs,
    denominator: decodedDenominator,
    factRefsRoot: hashList("aloha/runtime-acceptance/fact-ref-root/v1", decodedRefs.map((ref) => ref.factId).sort(compare)),
    closureFactsRoot: hashDomain("aloha/legacy-authority-closure/facts-root/v2", decodedDenominator.closures),
  };
  return decodeLegacyAuthorityClosureFacts({ ...payload, evidenceId: hashDomain("aloha/legacy-authority-closure/facts/v1", payload) });
}

export function decodeLegacyAuthorityZeroAggregateFacts(value: RuntimeAcceptanceCodecInput): LegacyAuthorityZeroAggregateFactsV1 {
  return legacyAggregateSchema.decode(parse(value));
}

export function encodeLegacyAuthorityZeroAggregateFacts(value: LegacyAuthorityZeroAggregateFactsV1): Uint8Array {
  return encodeCanonicalBytes(decodeLegacyAuthorityZeroAggregateFacts(value));
}

export function hashRuntimeFactRefRoot(refs: readonly RuntimeFactRefV1[]): Hash {
  const ids = refs.map((ref) => decodeRuntimeFactRef(ref).factId).sort(compare);
  return hashList("aloha/runtime-acceptance/fact-ref-root/v1", ids);
}

export function hashRuntimeHashPartition(items: readonly Hash[]): Hash {
  const ids = items.map((item) => nonZeroHashSchema.decode(item)).slice().sort(compare);
  assertSortedUnique(ids, "hash-partition");
  return hashList("aloha/runtime-acceptance/hash-partition/v1", ids);
}

export function hashRuntimeGraphViewLeaseObservations(items: readonly RuntimeGraphViewLeaseObservationV1[]): Hash {
  const decoded = graphViewLeaseObservationsSchema.decode(items, "graph-view-lease-observations");
  return hashDomain("aloha/runtime-acceptance/graph-view-lease-observation-root/v1", decoded);
}

export function hashRuntimeCandidateOutcomePartition(items: readonly RuntimeCandidateOutcomeV1[]): Hash {
  return hashList("aloha/runtime-acceptance/candidate-outcome-partition/v1", items.map((item) => candidateOutcomeSchema.decode(item)).slice().sort((a, b) => compare(a.runCandidateKey, b.runCandidateKey)));
}

export function hashRuntimeCandidateDeltaPartition(change: RuntimeCandidateDeltaPartitionV1["change"], items: readonly RuntimeCandidateDeltaV1[]): Hash {
  return hashDomain("aloha/runtime-acceptance/candidate-delta-partition/v1", { change, items: items.map((item) => deltaItemSchema.decode(item)).slice().sort((a, b) => compare(a.runCandidateKey, b.runCandidateKey)) });
}

export function hashLegacyAuthorityClosureReceipt(value: LegacyAuthorityClosureReceiptV1): Hash {
  return hashDomain("aloha/legacy-authority-closure/receipt/v1", legacyPayload(decodeLegacyAuthorityClosureReceipt(value)));
}

export function sealLegacyAuthorityClosureReceipt(
  payload: Omit<LegacyAuthorityClosureReceiptV1, "receiptId">,
): LegacyAuthorityClosureReceiptV1 {
  const receiptId = hashDomain("aloha/legacy-authority-closure/receipt/v1", payload);
  return decodeLegacyAuthorityClosureReceipt({ ...payload, receiptId });
}

export function hashLegacyAuthorityZeroAggregate(evidenceId: Hash): Hash {
  return hashDomain("aloha/legacy-authority-zero/aggregate/v2", nonZeroHashSchema.decode(evidenceId));
}

export function sealLegacyAuthorityZeroAggregateFacts(
  facts: LegacyAuthorityClosureFactsV1,
): LegacyAuthorityZeroAggregateFactsV1 {
  const decoded = decodeLegacyAuthorityClosureFacts(facts);
  return decodeLegacyAuthorityZeroAggregateFacts({
    schemaVersion: 1,
    kind: "aloha.legacy-authority-zero-aggregate-facts",
    facts: decoded,
    aggregateId: hashLegacyAuthorityZeroAggregate(decoded.evidenceId),
  });
}

export function decodeRuntimeProcessAnchorFacts(value: RuntimeAcceptanceCodecInput): RuntimeProcessAnchorFactsV1 {
  return runtimeAnchorSchema.decode(parse(value));
}

export function decodeRuntimeCandidateOutcomePartition(value: RuntimeAcceptanceCodecInput): RuntimeCandidateOutcomePartitionV1 {
  return candidateOutcomePartitionSchema.decode(parse(value));
}

export function decodeRuntimeRestartDifference(value: RuntimeAcceptanceCodecInput): RuntimeRestartDifferenceV1 {
  return restartDifferenceSchema.decode(parse(value));
}

export function decodeRuntimeSingleTargetProbe(value: RuntimeAcceptanceCodecInput): RuntimeSingleTargetProbeV1 {
  return singleTargetProbeSchema.decode(parse(value));
}

export function decodeRuntimeSigtermRecovery(value: RuntimeAcceptanceCodecInput): RuntimeSigtermRecoveryV1 {
  return sigtermRecoverySchema.decode(parse(value));
}

export function decodeRuntimeGraphReuse(value: RuntimeAcceptanceCodecInput): RuntimeGraphReuseV1 {
  return graphReuseSchema.decode(parse(value));
}

export type {
  Hash,
  ProcessAnchorV1,
  ReadOnlyArtifactLocatorV1,
};
