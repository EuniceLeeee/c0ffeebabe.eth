import {
  arraySchema,
  assertConcreteArray,
  assertExactKeys,
  CANONICAL_LIMITS,
  canonicalObjectSchema,
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  decimalStringSchema,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  enumSchema,
  fieldArray,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  semVerSchema,
  refineSchema,
  sha256Hex,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";

export type { Hash } from "../../../packages/canonical-codec/src/index.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const booleanSchema = defineSchema<boolean>({ kind: "boolean" }, (value, path = "$") => {
  if (typeof value !== "boolean") throw new TypeError(`expected boolean at ${path}`);
  return value;
});

export const PERFORMANCE_TARGET_COUNT = "100" as const;
export const PERFORMANCE_PERCENTILE_ALGORITHM = "nearest-rank-v1" as const;
export const PERFORMANCE_PERCENTILES = Object.freeze(["0.50", "0.95", "0.99"] as const);
export const PERFORMANCE_ELIGIBILITY_RULE_V1 = Object.freeze({
  schemaVersion: 1 as const,
  kind: "aloha.performance-eligibility-rule" as const,
  admission: "next-canonical-head-after-ready-serving" as const,
  replacement: "same-ordinal-canonical-replacement" as const,
  excludedHeads: "none" as const,
  targetCount: PERFORMANCE_TARGET_COUNT,
});
export const PERFORMANCE_ELIGIBILITY_RULE_HASH: Hash = hashDomain(
  "aloha/performance-eligibility-rule/v1",
  PERFORMANCE_ELIGIBILITY_RULE_V1,
);

const sourceAnchorSchema = objectSchema({
  chainId: decimalStringSchema,
  number: decimalStringSchema,
  hash: hashSchema,
  parentHash: hashSchema,
  stateRoot: hashSchema,
});

const processLogAnchorSchema = objectSchema({
  commitSha: gitSha40Schema,
  executableHash: hashSchema,
  pid: decimalStringSchema,
  processStartTicks: decimalStringSchema,
  bootIdHash: hashSchema,
  logSystemId: nonEmptyStringSchema,
  logBootIdHash: hashSchema,
  logDevice: decimalStringSchema,
  logInode: decimalStringSchema,
});

const performanceBudgetSchema = objectSchema({
  sourceCoarseP95Us: decimalStringSchema,
  sourceCoarseP99Us: decimalStringSchema,
  coarseP95Us: decimalStringSchema,
  coarseP99Us: decimalStringSchema,
  headCompletionP95Us: decimalStringSchema,
  headCompletionP99Us: decimalStringSchema,
  headHardDeadlineUs: decimalStringSchema,
  plannerExactProgramP95Us: decimalStringSchema,
  plannerExactProgramP99Us: decimalStringSchema,
  finalSimulationQueueP95Us: decimalStringSchema,
  finalSimulationQueueP99Us: decimalStringSchema,
  finalSimulationServiceP95Us: decimalStringSchema,
  finalSimulationServiceP99Us: decimalStringSchema,
  finalSimulationQueueServiceP99Us: decimalStringSchema,
  finalSimulationHardDeadlineUs: decimalStringSchema,
  cpuP95BasisPoints: decimalStringSchema,
  cpuP99BasisPoints: decimalStringSchema,
  eventLoopP95Us: decimalStringSchema,
  eventLoopP99Us: decimalStringSchema,
});

const queueProfileSchema = objectSchema({
  perFamilyRpcActive: decimalStringSchema,
  revmHeavyWorkers: decimalStringSchema,
  revmWaitingQueue: decimalStringSchema,
  finalSimulationWorkers: decimalStringSchema,
  finalSimulationQueue: decimalStringSchema,
  attestationLogicalWorkers: decimalStringSchema,
});

const productionPerformanceProfileStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.production-performance-profile"),
  profileHash: hashSchema,
  version: semVerSchema,
  targetCount: literalSchema(PERFORMANCE_TARGET_COUNT),
  percentileAlgorithm: literalSchema(PERFORMANCE_PERCENTILE_ALGORITHM),
  percentiles: arraySchema(enumSchema(PERFORMANCE_PERCENTILES)),
  budgets: performanceBudgetSchema,
  queueProfile: queueProfileSchema,
  requireSixStepDryRunCandidate: literalSchema(true),
});

export type SourceAnchorV1 = Infer<typeof sourceAnchorSchema>;
export type ProcessLogAnchorV1 = Infer<typeof processLogAnchorSchema>;
export type PerformanceBudgetV1 = Infer<typeof performanceBudgetSchema>;
export type PerformanceQueueProfileV1 = Infer<typeof queueProfileSchema>;
export type ProductionPerformanceProfileV1 = Infer<typeof productionPerformanceProfileStructuralSchema>;

function payloadWithout<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const result = { ...value } as Record<string, unknown>;
  for (const key of keys) delete result[key as string];
  return result as Omit<T, K>;
}

function strictSorted(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) throw new TypeError(`values must be strictly sorted at ${path}`);
  }
}

function positiveHash(value: Hash, path: string): void {
  if (value === ZERO_HASH) throw new TypeError(`zero hash is not allowed at ${path}`);
}

function decimal(value: string): bigint {
  return BigInt(value);
}

function nonNegativeDurationUs(startNs: string, endNs: string, supplied: string, path: string): string {
  const start = decimal(startNs);
  const end = decimal(endNs);
  if (end < start) throw new TypeError(`monotonic duration is negative at ${path}`);
  const expected = ((end - start) / 1000n).toString();
  if (expected !== supplied) throw new TypeError(`duration does not match monotonic anchors at ${path}`);
  return expected;
}

function profilePayload(value: ProductionPerformanceProfileV1): Omit<ProductionPerformanceProfileV1, "profileHash"> {
  return payloadWithout(value, ["profileHash"]);
}

function checkProfile(value: ProductionPerformanceProfileV1, path: string): ProductionPerformanceProfileV1 {
  if (value.percentiles.length !== PERFORMANCE_PERCENTILES.length || value.percentiles.join(",") !== PERFORMANCE_PERCENTILES.join(",")) {
    throw new TypeError(`percentile set is not frozen at ${path}.percentiles`);
  }
  const expected = hashDomain("aloha/production-performance-profile/v1", profilePayload(value));
  if (value.profileHash !== expected) throw new TypeError(`performance profile hash mismatch at ${path}.profileHash`);
  return Object.freeze(value);
}

const productionPerformanceProfileSchema = refineSchema(
  productionPerformanceProfileStructuralSchema,
  "aloha.production-performance-profile.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.production-performance-profile.refinement.v1",
    version: "1.0.0",
    rules: ["target-count-100", "nearest-rank", "fixed-percentiles", "profile-hash"],
  }),
  checkProfile,
);

export const PERFORMANCE_PROFILE_SCHEMA_MANIFEST = defineSchemaManifest("aloha.production-performance-profile", "1.0.0", productionPerformanceProfileSchema);

const PERFORMANCE_SCHEMA_MANIFESTS_PROFILE_ONLY = Object.freeze({
  profile: PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
});

export const DEFAULT_PRODUCTION_PERFORMANCE_PROFILE: ProductionPerformanceProfileV1 = createProductionPerformanceProfile({
  version: "1.0.0",
  targetCount: PERFORMANCE_TARGET_COUNT,
  percentileAlgorithm: PERFORMANCE_PERCENTILE_ALGORITHM,
  percentiles: [...PERFORMANCE_PERCENTILES],
  budgets: {
    sourceCoarseP95Us: "1500000",
    sourceCoarseP99Us: "2500000",
    coarseP95Us: "1000000",
    coarseP99Us: "2000000",
    headCompletionP95Us: "8000000",
    headCompletionP99Us: "11000000",
    headHardDeadlineUs: "12000000",
    plannerExactProgramP95Us: "2500000",
    plannerExactProgramP99Us: "3500000",
    finalSimulationQueueP95Us: "500000",
    finalSimulationQueueP99Us: "1000000",
    finalSimulationServiceP95Us: "2000000",
    finalSimulationServiceP99Us: "3000000",
    finalSimulationQueueServiceP99Us: "4000000",
    finalSimulationHardDeadlineUs: "5000000",
    cpuP95BasisPoints: "8000",
    cpuP99BasisPoints: "9500",
    eventLoopP95Us: "25000",
    eventLoopP99Us: "100000",
  },
  queueProfile: {
    perFamilyRpcActive: "2",
    revmHeavyWorkers: "4",
    revmWaitingQueue: "32",
    finalSimulationWorkers: "2",
    finalSimulationQueue: "2",
    attestationLogicalWorkers: "24",
  },
  requireSixStepDryRunCandidate: true,
});

const hardwareProfileObservationStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.hardware-profile-observation"),
  profileRoot: hashSchema,
  platform: nonEmptyStringSchema,
  architecture: nonEmptyStringSchema,
  nodeVersion: nonEmptyStringSchema,
  availableParallelism: decimalStringSchema,
  logicalCpuCount: decimalStringSchema,
  cpuModelSetRoot: hashSchema,
  totalMemoryBytes: decimalStringSchema,
});

export type HardwareProfileObservationV1 = Infer<typeof hardwareProfileObservationStructuralSchema>;

function hardwareProfilePayload(value: HardwareProfileObservationV1): Omit<HardwareProfileObservationV1, "profileRoot"> {
  return payloadWithout(value, ["profileRoot"]);
}

const hardwareProfileObservationSchema = refineSchema(
  hardwareProfileObservationStructuralSchema,
  "aloha.hardware-profile-observation.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.hardware-profile-observation.refinement.v1",
    version: "1.0.0",
    rules: ["positive-parallelism", "positive-logical-cpu-count", "positive-memory", "profile-root"],
  }),
  (value, path) => {
    if (decimal(value.availableParallelism) <= 0n) throw new TypeError(`available parallelism must be positive at ${path}`);
    if (decimal(value.logicalCpuCount) <= 0n) throw new TypeError(`logical CPU count must be positive at ${path}`);
    if (decimal(value.totalMemoryBytes) <= 0n) throw new TypeError(`total memory must be positive at ${path}`);
    positiveHash(value.cpuModelSetRoot, `${path}.cpuModelSetRoot`);
    if (value.profileRoot !== hashDomain("aloha/hardware-profile-observation/v1", hardwareProfilePayload(value))) {
      throw new TypeError(`hardware profile root mismatch at ${path}.profileRoot`);
    }
    return Object.freeze(value);
  },
);

export const HARDWARE_PROFILE_OBSERVATION_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.hardware-profile-observation",
  "1.0.0",
  hardwareProfileObservationSchema,
);

export function createHardwareProfileObservationV1(
  draft: Omit<HardwareProfileObservationV1, "profileRoot" | "schemaVersion" | "kind">,
): HardwareProfileObservationV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.hardware-profile-observation" as const,
    ...draft,
    profileRoot: ZERO_HASH,
  };
  return hardwareProfileObservationSchema.decode({
    ...intermediate,
    profileRoot: hashDomain("aloha/hardware-profile-observation/v1", hardwareProfilePayload(intermediate)),
  });
}

export function decodeHardwareProfileObservationV1(value: string | Uint8Array | object): HardwareProfileObservationV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return hardwareProfileObservationSchema.decode(input);
}

export function encodeHardwareProfileObservationV1(value: HardwareProfileObservationV1): Uint8Array {
  return encodeCanonicalBytes(hardwareProfileObservationSchema.decode(value));
}

export function decodeProductionPerformanceProfile(value: string | Uint8Array | object): ProductionPerformanceProfileV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return productionPerformanceProfileSchema.decode(input);
}

export type ProductionPerformanceProfileDraftV1 = Omit<ProductionPerformanceProfileV1, "profileHash" | "schemaVersion" | "kind"> & {
  readonly schemaVersion?: 1;
  readonly kind?: "aloha.production-performance-profile";
};

export function createProductionPerformanceProfile(draft: ProductionPerformanceProfileDraftV1): ProductionPerformanceProfileV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.production-performance-profile" as const,
    ...draft,
    profileHash: ZERO_HASH,
  };
  const profileHash = hashDomain("aloha/production-performance-profile/v1", profilePayload(intermediate));
  return productionPerformanceProfileSchema.decode({ ...intermediate, profileHash });
}

export function hashProductionPerformanceProfile(value: ProductionPerformanceProfileV1): Hash {
  return hashDomain("aloha/production-performance-profile/v1", profilePayload(decodeProductionPerformanceProfile(value)));
}

export function encodeProductionPerformanceProfile(value: ProductionPerformanceProfileV1): Uint8Array {
  return encodeCanonicalBytes(productionPerformanceProfileSchema.decode(value));
}

const deploymentPerformanceWindowBasisStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.deployment-performance-window-basis"),
  basisId: hashSchema,
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  performanceProfileHash: hashSchema,
  eligibilityRuleHash: hashSchema,
  targetCount: literalSchema(PERFORMANCE_TARGET_COUNT),
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  commitContextBindingId: hashSchema,
  commitAppendRecordId: hashSchema,
});

export type DeploymentPerformanceWindowBasisV1 = Infer<typeof deploymentPerformanceWindowBasisStructuralSchema>;

function deploymentPerformanceWindowBasisPayload(
  value: DeploymentPerformanceWindowBasisV1,
): Omit<DeploymentPerformanceWindowBasisV1, "basisId"> {
  return payloadWithout(value, ["basisId"]);
}

function checkDeploymentPerformanceWindowBasis(
  value: DeploymentPerformanceWindowBasisV1,
  path: string,
): DeploymentPerformanceWindowBasisV1 {
  for (const [name, hash] of [
    ["bindingId", value.bindingId],
    ["releaseProvenanceHash", value.releaseProvenanceHash],
    ["performanceProfileHash", value.performanceProfileHash],
    ["eligibilityRuleHash", value.eligibilityRuleHash],
    ["providerRoot", value.providerRoot],
    ["hardwareProfileRoot", value.hardwareProfileRoot],
    ["commitContextBindingId", value.commitContextBindingId],
    ["commitAppendRecordId", value.commitAppendRecordId],
  ] as const) positiveHash(hash, `${path}.${name}`);
  const expected = hashDomain(
    "aloha/deployment-performance-window-basis/v1",
    deploymentPerformanceWindowBasisPayload(value),
  );
  if (value.basisId !== expected) throw new TypeError(`deployment performance window basis hash mismatch at ${path}.basisId`);
  return Object.freeze(value);
}

const deploymentPerformanceWindowBasisSchema = refineSchema(
  deploymentPerformanceWindowBasisStructuralSchema,
  "aloha.deployment-performance-window-basis.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.deployment-performance-window-basis.refinement.v1",
    version: "1.0.0",
    rules: ["release-binding", "profile-hardware-provider-binding", "commit-evidence-binding", "basis-id"],
  }),
  checkDeploymentPerformanceWindowBasis,
);

export const DEPLOYMENT_PERFORMANCE_WINDOW_BASIS_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.deployment-performance-window-basis",
  "1.0.0",
  deploymentPerformanceWindowBasisSchema,
);

export type DeploymentPerformanceWindowBasisDraftV1 = Omit<
  DeploymentPerformanceWindowBasisV1,
  "basisId" | "schemaVersion" | "kind"
> & {
  readonly schemaVersion?: 1;
  readonly kind?: "aloha.deployment-performance-window-basis";
};

export function createDeploymentPerformanceWindowBasisV1(
  draft: DeploymentPerformanceWindowBasisDraftV1,
): DeploymentPerformanceWindowBasisV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.deployment-performance-window-basis" as const,
    ...draft,
    basisId: ZERO_HASH,
  };
  const basisId = hashDomain(
    "aloha/deployment-performance-window-basis/v1",
    deploymentPerformanceWindowBasisPayload(intermediate),
  );
  return deploymentPerformanceWindowBasisSchema.decode({ ...intermediate, basisId });
}

export function decodeDeploymentPerformanceWindowBasisV1(
  value: string | Uint8Array | object,
): DeploymentPerformanceWindowBasisV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value)
    ? decodeCanonicalJson(value as string | Uint8Array)
    : value;
  return deploymentPerformanceWindowBasisSchema.decode(input);
}

export function encodeDeploymentPerformanceWindowBasisV1(
  value: DeploymentPerformanceWindowBasisV1,
): Uint8Array {
  return encodeCanonicalBytes(deploymentPerformanceWindowBasisSchema.decode(value));
}

export function hashDeploymentPerformanceWindowBasisV1(
  value: DeploymentPerformanceWindowBasisV1,
): Hash {
  return hashDomain(
    "aloha/deployment-performance-window-basis/v1",
    deploymentPerformanceWindowBasisPayload(decodeDeploymentPerformanceWindowBasisV1(value)),
  );
}

const windowCommitmentStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-window-commitment"),
  windowId: hashSchema,
  windowStartAnchor: sourceAnchorSchema,
  eligibilityRuleHash: hashSchema,
  performanceProfileHash: hashSchema,
  targetCount: literalSchema(PERFORMANCE_TARGET_COUNT),
  processLogAnchor: processLogAnchorSchema,
  releaseBindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  runtimeAnchorHash: hashSchema,
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  commitContextBindingId: hashSchema,
  commitAppendRecordId: hashSchema,
  committedMonotonicNs: decimalStringSchema,
});

export type PerformanceWindowCommitmentV1 = Infer<typeof windowCommitmentStructuralSchema>;

function windowCommitmentPayload(value: PerformanceWindowCommitmentV1): Omit<PerformanceWindowCommitmentV1, "windowId"> {
  return payloadWithout(value, ["windowId"]);
}

function checkWindowCommitment(value: PerformanceWindowCommitmentV1, path: string): PerformanceWindowCommitmentV1 {
  for (const [name, hash] of [["windowStartAnchor.hash", value.windowStartAnchor.hash], ["windowStartAnchor.parentHash", value.windowStartAnchor.parentHash], ["windowStartAnchor.stateRoot", value.windowStartAnchor.stateRoot]] as const) positiveHash(hash, `${path}.${name}`);
  for (const [name, hash] of [
    ["eligibilityRuleHash", value.eligibilityRuleHash],
    ["performanceProfileHash", value.performanceProfileHash],
    ["releaseBindingId", value.releaseBindingId],
    ["releaseProvenanceHash", value.releaseProvenanceHash],
    ["runtimeAnchorHash", value.runtimeAnchorHash],
    ["providerRoot", value.providerRoot],
    ["hardwareProfileRoot", value.hardwareProfileRoot],
    ["commitContextBindingId", value.commitContextBindingId],
    ["commitAppendRecordId", value.commitAppendRecordId],
  ] as const) positiveHash(hash, `${path}.${name}`);
  const expected = hashDomain("aloha/performance-window-commitment/v1", windowCommitmentPayload(value));
  if (value.windowId !== expected) throw new TypeError(`performance window commitment hash mismatch at ${path}.windowId`);
  return Object.freeze(value);
}

const windowCommitmentSchema = refineSchema(
  windowCommitmentStructuralSchema,
  "aloha.performance-window-commitment.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-window-commitment.refinement.v1",
    version: "1.0.0",
    rules: ["target-count-100", "pre-first-head-anchor", "release-runtime-process-profile-binding", "window-id"],
  }),
  checkWindowCommitment,
);

export const PERFORMANCE_WINDOW_COMMITMENT_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.performance-window-commitment",
  "1.0.0",
  windowCommitmentSchema,
);

export type PerformanceWindowCommitmentDraftV1 = Omit<PerformanceWindowCommitmentV1, "windowId" | "schemaVersion" | "kind"> & {
  readonly schemaVersion?: 1;
  readonly kind?: "aloha.performance-window-commitment";
};

export function createPerformanceWindowCommitment(draft: PerformanceWindowCommitmentDraftV1): PerformanceWindowCommitmentV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.performance-window-commitment" as const,
    ...draft,
    windowId: ZERO_HASH,
  };
  const windowId = hashDomain("aloha/performance-window-commitment/v1", windowCommitmentPayload(intermediate));
  return windowCommitmentSchema.decode({ ...intermediate, windowId });
}

export function decodePerformanceWindowCommitment(value: string | Uint8Array | object): PerformanceWindowCommitmentV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return windowCommitmentSchema.decode(input);
}

export function hashPerformanceWindowCommitment(value: PerformanceWindowCommitmentV1): Hash {
  return hashDomain("aloha/performance-window-commitment/v1", windowCommitmentPayload(decodePerformanceWindowCommitment(value)));
}

export function encodePerformanceWindowCommitment(value: PerformanceWindowCommitmentV1): Uint8Array {
  return encodeCanonicalBytes(windowCommitmentSchema.decode(value));
}

const eligibleHeadStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-eligible-head"),
  headRecordId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  canonicalHead: sourceAnchorSchema,
  acceptedMonotonicNs: decimalStringSchema,
  processLogAnchorHash: hashSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  generationSourceCoverageRoot: hashSchema,
  sourceCoverageRoot: hashSchema,
  candidateSetRoot: hashSchema,
  candidateCount: decimalStringSchema,
  candidateBearing: literalSchema(true),
});

const noCandidateHeadStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-eligible-head"),
  headRecordId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  canonicalHead: sourceAnchorSchema,
  acceptedMonotonicNs: decimalStringSchema,
  processLogAnchorHash: hashSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  generationSourceCoverageRoot: hashSchema,
  sourceCoverageRoot: hashSchema,
  candidateSetRoot: hashSchema,
  candidateCount: literalSchema("0"),
  candidateBearing: literalSchema(false),
});

const eligibleHeadStructuralUnionSchema = defineSchema<EligibleHeadRecordV1>(
  { kind: "union", variants: [eligibleHeadStructuralSchema.descriptor, noCandidateHeadStructuralSchema.descriptor] },
  (value, path = "$") => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`eligible head must be an object at ${path}`);
    const candidateBearing = (value as { readonly candidateBearing?: unknown }).candidateBearing;
    return candidateBearing === true
      ? eligibleHeadStructuralSchema.decode(value, path)
      : noCandidateHeadStructuralSchema.decode(value, path);
  },
);

export type EligibleHeadRecordV1 = Infer<typeof eligibleHeadStructuralSchema> | Infer<typeof noCandidateHeadStructuralSchema>;

export type PerformanceLaneV1 = "blockscan" | "backrun";

/**
 * Final performance facts identify an execution denominator, not only the
 * semantic route. The observer derives this ref from raw lane + candidate
 * facts; callers never supply or override it.
 */
export function performanceLaneCandidateRefV1(
  lane: PerformanceLaneV1,
  semanticCandidateId: Hash,
): Hash {
  if (lane !== "blockscan" && lane !== "backrun") throw new TypeError("performance lane candidate ref lane is invalid");
  const candidateId = hashSchema.decode(semanticCandidateId, "$.semanticCandidateId");
  positiveHash(candidateId, "$.semanticCandidateId");
  return hashDomain("aloha/performance-lane-candidate-ref/v1", { lane, candidateId });
}

function eligibleHeadPayload(value: EligibleHeadRecordV1): Omit<EligibleHeadRecordV1, "headRecordId"> {
  return payloadWithout(value, ["headRecordId"]);
}

function checkEligibleHead(value: EligibleHeadRecordV1, path: string): EligibleHeadRecordV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`head ordinal is outside 1..100 at ${path}.ordinal`);
  if (value.candidateBearing !== (decimal(value.candidateCount) > 0n)) throw new TypeError(`candidateBearing is not derived from candidateCount at ${path}`);
  for (const [name, hash] of [["canonicalHead.hash", value.canonicalHead.hash], ["canonicalHead.parentHash", value.canonicalHead.parentHash], ["canonicalHead.stateRoot", value.canonicalHead.stateRoot]] as const) positiveHash(hash, `${path}.${name}`);
  for (const [name, hash] of [
    ["windowId", value.windowId], ["processLogAnchorHash", value.processLogAnchorHash],
    ["graphRoot", value.graphRoot], ["readyRecordHash", value.readyRecordHash],
    ["providerRoot", value.providerRoot], ["hardwareProfileRoot", value.hardwareProfileRoot], ["generationSourceCoverageRoot", value.generationSourceCoverageRoot],
    ["sourceCoverageRoot", value.sourceCoverageRoot], ["candidateSetRoot", value.candidateSetRoot],
  ] as const) positiveHash(hash, `${path}.${name}`);
  const expected = hashDomain("aloha/performance-eligible-head/v1", eligibleHeadPayload(value));
  if (value.headRecordId !== expected) throw new TypeError(`eligible head identity mismatch at ${path}.headRecordId`);
  return Object.freeze(value);
}

const eligibleHeadSchema = refineSchema(
  eligibleHeadStructuralUnionSchema,
  "aloha.performance-eligible-head.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-eligible-head.refinement.v1",
    version: "1.0.0",
    rules: ["ordinal-range", "candidate-bearing-derived", "head-id"],
  }),
  checkEligibleHead,
);

export const PERFORMANCE_ELIGIBLE_HEAD_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-eligible-head", "1.0.0", eligibleHeadSchema);

export type EligibleHeadRecordDraftV1 = Omit<EligibleHeadRecordV1, "headRecordId" | "schemaVersion" | "kind" | "ordinal" | "windowId" | "acceptedMonotonicNs"> & {
  readonly ordinal: string;
  readonly windowId: Hash;
  readonly acceptedMonotonicNs: string;
  readonly schemaVersion?: 1;
  readonly kind?: "aloha.performance-eligible-head";
};

export function createEligibleHeadRecord(draft: EligibleHeadRecordDraftV1): EligibleHeadRecordV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.performance-eligible-head" as const,
    ...draft,
    headRecordId: ZERO_HASH,
  } as EligibleHeadRecordV1;
  const headRecordId = hashDomain("aloha/performance-eligible-head/v1", eligibleHeadPayload(intermediate));
  return eligibleHeadSchema.decode({ ...intermediate, headRecordId });
}

export function decodeEligibleHeadRecord(value: string | Uint8Array | object): EligibleHeadRecordV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return eligibleHeadSchema.decode(input);
}

export function hashEligibleHeadRecord(value: EligibleHeadRecordV1): Hash {
  return hashDomain("aloha/performance-eligible-head/v1", eligibleHeadPayload(decodeEligibleHeadRecord(value)));
}

export function encodeEligibleHeadRecord(value: EligibleHeadRecordV1): Uint8Array {
  return encodeCanonicalBytes(eligibleHeadSchema.decode(value));
}

const orphanReplacementStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-orphan-replacement"),
  lineageId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  orphanHeadRecordId: hashSchema,
  orphanCanonicalHead: sourceAnchorSchema,
  orphanObservationRoot: hashSchema,
  replacementHeadRecordId: hashSchema,
  replacementCanonicalHead: sourceAnchorSchema,
  replacementObservationRoot: hashSchema,
});

export type HeadOrphanReplacementLineageV1 = Infer<typeof orphanReplacementStructuralSchema>;

function orphanReplacementPayload(value: HeadOrphanReplacementLineageV1): Omit<HeadOrphanReplacementLineageV1, "lineageId"> {
  return payloadWithout(value, ["lineageId"]);
}

function checkOrphanReplacement(value: HeadOrphanReplacementLineageV1, path: string): HeadOrphanReplacementLineageV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`lineage ordinal is outside 1..100 at ${path}.ordinal`);
  for (const [name, hash] of [
    ["windowId", value.windowId], ["orphanHeadRecordId", value.orphanHeadRecordId], ["orphanObservationRoot", value.orphanObservationRoot],
    ["replacementHeadRecordId", value.replacementHeadRecordId], ["replacementObservationRoot", value.replacementObservationRoot],
  ] as const) positiveHash(hash, `${path}.${name}`);
  if (value.orphanHeadRecordId === value.replacementHeadRecordId) throw new TypeError(`orphan and replacement identities must differ at ${path}`);
  const expected = hashDomain("aloha/performance-orphan-replacement/v1", orphanReplacementPayload(value));
  if (value.lineageId !== expected) throw new TypeError(`orphan replacement identity mismatch at ${path}.lineageId`);
  return Object.freeze(value);
}

const orphanReplacementSchema = refineSchema(
  orphanReplacementStructuralSchema,
  "aloha.performance-orphan-replacement.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-orphan-replacement.refinement.v1", version: "1.0.0", rules: ["same-ordinal", "explicit-lineage", "lineage-id"] }),
  checkOrphanReplacement,
);

export const PERFORMANCE_ORPHAN_REPLACEMENT_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-orphan-replacement", "1.0.0", orphanReplacementSchema);

export function createHeadOrphanReplacementLineage(draft: Omit<HeadOrphanReplacementLineageV1, "lineageId" | "schemaVersion" | "kind">): HeadOrphanReplacementLineageV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-orphan-replacement" as const, ...draft, lineageId: ZERO_HASH };
  const lineageId = hashDomain("aloha/performance-orphan-replacement/v1", orphanReplacementPayload(intermediate));
  return orphanReplacementSchema.decode({ ...intermediate, lineageId });
}

export function decodeHeadOrphanReplacementLineage(value: string | Uint8Array | object): HeadOrphanReplacementLineageV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return orphanReplacementSchema.decode(input);
}

export function hashHeadOrphanReplacementLineage(value: HeadOrphanReplacementLineageV1): Hash {
  return hashDomain("aloha/performance-orphan-replacement/v1", orphanReplacementPayload(decodeHeadOrphanReplacementLineage(value)));
}

export function encodeHeadOrphanReplacementLineage(value: HeadOrphanReplacementLineageV1): Uint8Array {
  return encodeCanonicalBytes(orphanReplacementSchema.decode(value));
}

const admissionOrphanReplacementStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-admission-orphan-replacement"),
  lineageId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  orphanAdmissionId: hashSchema,
  orphanEligibleEventId: hashSchema,
  orphanProducerTerminalId: hashSchema,
  orphanProducerTerminalEventId: hashSchema,
  orphanCanonicalHead: sourceAnchorSchema,
  orphanRevision: decimalStringSchema,
  orphanAcceptedMonotonicNs: decimalStringSchema,
  orphanTerminalMonotonicNs: decimalStringSchema,
  replacementAdmissionId: hashSchema,
  replacementCanonicalHead: sourceAnchorSchema,
  replacementRevision: decimalStringSchema,
  replacementAcceptedMonotonicNs: decimalStringSchema,
});

export type PerformanceAdmissionOrphanReplacementLineageV1 = Infer<typeof admissionOrphanReplacementStructuralSchema>;

function admissionOrphanReplacementPayload(
  value: PerformanceAdmissionOrphanReplacementLineageV1,
): Omit<PerformanceAdmissionOrphanReplacementLineageV1, "lineageId"> {
  return payloadWithout(value, ["lineageId"]);
}

function checkAdmissionOrphanReplacement(
  value: PerformanceAdmissionOrphanReplacementLineageV1,
  path: string,
): PerformanceAdmissionOrphanReplacementLineageV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`admission lineage ordinal is outside 1..100 at ${path}.ordinal`);
  for (const [name, hash] of [
    ["windowId", value.windowId],
    ["orphanAdmissionId", value.orphanAdmissionId],
    ["orphanEligibleEventId", value.orphanEligibleEventId],
    ["orphanProducerTerminalId", value.orphanProducerTerminalId],
    ["orphanProducerTerminalEventId", value.orphanProducerTerminalEventId],
    ["replacementAdmissionId", value.replacementAdmissionId],
  ] as const) positiveHash(hash, `${path}.${name}`);
  if (value.orphanAdmissionId === value.replacementAdmissionId) throw new TypeError(`replacement admission must differ from orphan at ${path}`);
  if (value.orphanCanonicalHead.chainId !== value.replacementCanonicalHead.chainId
    || value.orphanCanonicalHead.number !== value.replacementCanonicalHead.number
    || value.orphanCanonicalHead.hash === value.replacementCanonicalHead.hash) {
    throw new TypeError(`replacement must change the canonical hash at the same chain/height at ${path}`);
  }
  if (decimal(value.replacementRevision) !== decimal(value.orphanRevision) + 1n) {
    throw new TypeError(`replacement revision must advance exactly once at ${path}.replacementRevision`);
  }
  if (decimal(value.replacementAcceptedMonotonicNs) <= decimal(value.orphanAcceptedMonotonicNs)) {
    throw new TypeError(`replacement admission must follow the orphan admission at ${path}.replacementAcceptedMonotonicNs`);
  }
  if (decimal(value.orphanTerminalMonotonicNs) < decimal(value.orphanAcceptedMonotonicNs)
    || decimal(value.replacementAcceptedMonotonicNs) <= decimal(value.orphanTerminalMonotonicNs)) {
    throw new TypeError(`replacement admission must follow the durable orphan terminal at ${path}.orphanTerminalMonotonicNs`);
  }
  const expected = hashDomain("aloha/performance-admission-orphan-replacement/v1", admissionOrphanReplacementPayload(value));
  if (value.lineageId !== expected) throw new TypeError(`admission orphan replacement identity mismatch at ${path}.lineageId`);
  return Object.freeze(value);
}

const admissionOrphanReplacementSchema = refineSchema(
  admissionOrphanReplacementStructuralSchema,
  "aloha.performance-admission-orphan-replacement.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-admission-orphan-replacement.refinement.v1",
    version: "1.0.0",
    rules: ["same-ordinal", "same-height", "revision-plus-one", "terminal-before-replacement", "lineage-id"],
  }),
  checkAdmissionOrphanReplacement,
);

export const PERFORMANCE_ADMISSION_ORPHAN_REPLACEMENT_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.performance-admission-orphan-replacement",
  "1.0.0",
  admissionOrphanReplacementSchema,
);

export function createPerformanceAdmissionOrphanReplacementLineage(
  draft: Omit<PerformanceAdmissionOrphanReplacementLineageV1, "lineageId" | "schemaVersion" | "kind">,
): PerformanceAdmissionOrphanReplacementLineageV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.performance-admission-orphan-replacement" as const,
    ...draft,
    lineageId: ZERO_HASH,
  };
  const lineageId = hashDomain("aloha/performance-admission-orphan-replacement/v1", admissionOrphanReplacementPayload(intermediate));
  return admissionOrphanReplacementSchema.decode({ ...intermediate, lineageId });
}

export function decodePerformanceAdmissionOrphanReplacementLineage(
  value: string | Uint8Array | object,
): PerformanceAdmissionOrphanReplacementLineageV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return admissionOrphanReplacementSchema.decode(input);
}

export function hashPerformanceAdmissionOrphanReplacementLineage(
  value: PerformanceAdmissionOrphanReplacementLineageV1,
): Hash {
  return hashDomain(
    "aloha/performance-admission-orphan-replacement/v1",
    admissionOrphanReplacementPayload(decodePerformanceAdmissionOrphanReplacementLineage(value)),
  );
}

export function encodePerformanceAdmissionOrphanReplacementLineage(
  value: PerformanceAdmissionOrphanReplacementLineageV1,
): Uint8Array {
  return encodeCanonicalBytes(admissionOrphanReplacementSchema.decode(value));
}

const candidateTerminalOutcomeSchema = enumSchema(["verified", "chain-proven-rejected", "retryable", "invalid-program", "simulation-reverted", "policy-rejected"] as const);

export interface PerformanceSixStepCompletionLineageV1 {
  readonly windowId: Hash;
  readonly headRecordId: Hash;
  readonly candidateId: Hash;
  readonly correlationRoot: Hash;
  readonly mode: "unsigned-dry-run";
  readonly evidenceRoot: Hash;
}

export function hashPerformanceSixStepCompletionLineage(
  input: PerformanceSixStepCompletionLineageV1,
): Hash {
  for (const [name, value] of [["windowId", input.windowId], ["headRecordId", input.headRecordId], ["candidateId", input.candidateId], ["correlationRoot", input.correlationRoot], ["evidenceRoot", input.evidenceRoot]] as const) {
    positiveHash(value, `performanceSixStepCompletion.${name}`);
  }
  if (input.mode !== "unsigned-dry-run") throw new TypeError("performance six-step completion mode must be unsigned-dry-run");
  return hashDomain("aloha/performance-six-step-completion-lineage/v1", input);
}

const candidateTerminalStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-candidate-terminal"),
  receiptId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  headRecordId: hashSchema,
  candidateId: hashSchema,
  outcome: candidateTerminalOutcomeSchema,
  correlationRoot: hashSchema,
  sixStepCompleted: literalSchema(true),
  sixStepMode: literalSchema("unsigned-dry-run"),
  sixStepEvidenceRoot: hashSchema,
  sixStepCompletionRoot: hashSchema,
  timingUs: decimalStringSchema,
  evidenceRoot: hashSchema,
});

const candidateTerminalNoSixStepSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-candidate-terminal"),
  receiptId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  headRecordId: hashSchema,
  candidateId: hashSchema,
  outcome: candidateTerminalOutcomeSchema,
  correlationRoot: hashSchema,
  sixStepCompleted: literalSchema(false),
  sixStepMode: literalSchema(null),
  sixStepEvidenceRoot: literalSchema(null),
  sixStepCompletionRoot: literalSchema(null),
  timingUs: decimalStringSchema,
  evidenceRoot: hashSchema,
});

export type CandidateTerminalReceiptV1 = Infer<typeof candidateTerminalStructuralSchema> | Infer<typeof candidateTerminalNoSixStepSchema>;

function candidateTerminalPayload(value: CandidateTerminalReceiptV1): Omit<CandidateTerminalReceiptV1, "receiptId"> {
  return payloadWithout(value, ["receiptId"]);
}

function checkCandidateTerminal(value: CandidateTerminalReceiptV1, path: string): CandidateTerminalReceiptV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`candidate terminal ordinal is outside 1..100 at ${path}.ordinal`);
  for (const [name, hash] of [["windowId", value.windowId], ["headRecordId", value.headRecordId], ["candidateId", value.candidateId], ["correlationRoot", value.correlationRoot], ["evidenceRoot", value.evidenceRoot]] as const) positiveHash(hash, `${path}.${name}`);
  if (value.sixStepCompleted) {
    positiveHash(value.sixStepEvidenceRoot, `${path}.sixStepEvidenceRoot`);
    positiveHash(value.sixStepCompletionRoot, `${path}.sixStepCompletionRoot`);
    if (value.outcome !== "verified") throw new TypeError(`only verified candidates may complete an unsigned dry run at ${path}.outcome`);
    const expectedCompletionRoot = hashPerformanceSixStepCompletionLineage({
      windowId: value.windowId,
      headRecordId: value.headRecordId,
      candidateId: value.candidateId,
      correlationRoot: value.correlationRoot,
      mode: value.sixStepMode,
      evidenceRoot: value.sixStepEvidenceRoot,
    });
    if (value.sixStepCompletionRoot !== expectedCompletionRoot) throw new TypeError(`six-step completion lineage root mismatch at ${path}.sixStepCompletionRoot`);
  }
  const expected = hashDomain("aloha/performance-candidate-terminal/v1", candidateTerminalPayload(value));
  if (value.receiptId !== expected) throw new TypeError(`candidate terminal identity mismatch at ${path}.receiptId`);
  return Object.freeze(value);
}

const candidateTerminalSchema = refineSchema(
  defineSchema<CandidateTerminalReceiptV1>({ kind: "union", variants: [candidateTerminalStructuralSchema.descriptor, candidateTerminalNoSixStepSchema.descriptor] }, (value, path = "$") => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`candidate terminal must be an object at ${path}`);
    return (value as { readonly sixStepCompleted?: unknown }).sixStepCompleted === true
      ? candidateTerminalStructuralSchema.decode(value, path)
      : candidateTerminalNoSixStepSchema.decode(value, path);
  }),
  "aloha.performance-candidate-terminal.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-candidate-terminal.refinement.v1", version: "2.0.0", rules: ["terminal-id", "ordinal-range", "head-window-candidate-correlation-lineage-root", "verified-unsigned-dry-run-only"] }),
  checkCandidateTerminal,
);

export const PERFORMANCE_CANDIDATE_TERMINAL_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-candidate-terminal", "1.0.0", candidateTerminalSchema);

export function createCandidateTerminalReceipt(draft: Omit<CandidateTerminalReceiptV1, "receiptId" | "schemaVersion" | "kind">): CandidateTerminalReceiptV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-candidate-terminal" as const, ...draft, receiptId: ZERO_HASH } as CandidateTerminalReceiptV1;
  const receiptId = hashDomain("aloha/performance-candidate-terminal/v1", candidateTerminalPayload(intermediate));
  return candidateTerminalSchema.decode({ ...intermediate, receiptId });
}

export function decodeCandidateTerminalReceipt(value: string | Uint8Array | object): CandidateTerminalReceiptV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return candidateTerminalSchema.decode(input);
}

export function hashCandidateTerminalReceipt(value: CandidateTerminalReceiptV1): Hash {
  return hashDomain("aloha/performance-candidate-terminal/v1", candidateTerminalPayload(decodeCandidateTerminalReceipt(value)));
}

export function encodeCandidateTerminalReceipt(value: CandidateTerminalReceiptV1): Uint8Array {
  return encodeCanonicalBytes(candidateTerminalSchema.decode(value));
}

const candidateSetStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-candidate-set"),
  setId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  candidateIds: arraySchema(hashSchema),
  candidateSetRoot: hashSchema,
});

export type CandidateSetV1 = Infer<typeof candidateSetStructuralSchema>;

function candidateSetPayload(value: CandidateSetV1): Omit<CandidateSetV1, "setId"> {
  return payloadWithout(value, ["setId"]);
}

function candidateSetRoot(candidateIds: readonly Hash[]): Hash {
  const sorted = [...candidateIds].sort();
  strictSorted(sorted, "$.candidateIds");
  return hashDomain("aloha/performance-candidate-set-root/v1", sorted);
}

function checkCandidateSet(value: CandidateSetV1, path: string): CandidateSetV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`candidate set ordinal is outside 1..100 at ${path}.ordinal`);
  const ids = [...value.candidateIds];
  strictSorted(ids, `${path}.candidateIds`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`candidate ids must be unique at ${path}.candidateIds`);
  for (const [index, id] of ids.entries()) positiveHash(id, `${path}.candidateIds[${index}]`);
  positiveHash(value.windowId, `${path}.windowId`);
  positiveHash(value.candidateSetRoot, `${path}.candidateSetRoot`);
  if (value.candidateSetRoot !== candidateSetRoot(ids)) throw new TypeError(`candidate set root mismatch at ${path}.candidateSetRoot`);
  const expected = hashDomain("aloha/performance-candidate-set/v1", candidateSetPayload(value));
  if (value.setId !== expected) throw new TypeError(`candidate set identity mismatch at ${path}.setId`);
  return Object.freeze(value);
}

const candidateSetSchema = refineSchema(candidateSetStructuralSchema, "aloha.performance-candidate-set.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-candidate-set.refinement.v1", version: "1.0.0", rules: ["sorted-candidates", "candidate-root", "set-id"] }), checkCandidateSet);

export const PERFORMANCE_CANDIDATE_SET_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-candidate-set", "1.0.0", candidateSetSchema);

export function createCandidateSet(draft: Omit<CandidateSetV1, "setId" | "candidateSetRoot" | "schemaVersion" | "kind">): CandidateSetV1 {
  const candidateIds = [...draft.candidateIds].sort() as Hash[];
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-candidate-set" as const, ...draft, candidateIds, candidateSetRoot: candidateSetRoot(candidateIds), setId: ZERO_HASH };
  const setId = hashDomain("aloha/performance-candidate-set/v1", candidateSetPayload(intermediate));
  return candidateSetSchema.decode({ ...intermediate, setId });
}

export function decodeCandidateSet(value: string | Uint8Array | object): CandidateSetV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return candidateSetSchema.decode(input);
}

export function hashCandidateSet(value: CandidateSetV1): Hash {
  return hashDomain("aloha/performance-candidate-set/v1", candidateSetPayload(decodeCandidateSet(value)));
}

export function encodeCandidateSet(value: CandidateSetV1): Uint8Array {
  return encodeCanonicalBytes(candidateSetSchema.decode(value));
}

const queueTelemetrySchema = objectSchema({
  lane: enumSchema(["producer-critical", "producer-bulk", "startup-RPC-fast", "startup-REVM-heavy", "background-next-generation", "final-sim"] as const),
  resource: enumSchema(["rpc", "revm-heavy", "final-sim"] as const),
  current: decimalStringSchema,
  max: decimalStringSchema,
  oldestAgeUs: decimalStringSchema,
  accepted: decimalStringSchema,
  rejected: decimalStringSchema,
  cancelled: decimalStringSchema,
});

const permitAccountingSchema = objectSchema({
  ownerRef: nonEmptyStringSchema,
  lane: enumSchema(["producer-critical", "producer-bulk", "startup-RPC-fast", "startup-REVM-heavy", "background-next-generation", "final-sim"] as const),
  resource: enumSchema(["rpc", "revm-heavy", "final-sim"] as const),
  issued: decimalStringSchema,
  released: decimalStringSchema,
  active: decimalStringSchema,
});

const resourceSampleSchema = objectSchema({
  resource: enumSchema(["rpc", "revm-heavy", "final-sim"] as const),
  current: decimalStringSchema,
  capacity: decimalStringSchema,
  max: decimalStringSchema,
});

const cpuMemoryEventLoopSchema = objectSchema({
  cpuUtilizationBasisPoints: decimalStringSchema,
  rssBytes: decimalStringSchema,
  eventLoopLagUs: decimalStringSchema,
});

const workerRestartSchema = objectSchema({
  workerCount: decimalStringSchema,
  restarted: decimalStringSchema,
  orphanedWorkers: decimalStringSchema,
});

export type QueueTelemetryV1 = Infer<typeof queueTelemetrySchema>;
export type PermitAccountingV1 = Infer<typeof permitAccountingSchema>;
export type ResourceSampleV1 = Infer<typeof resourceSampleSchema>;
export type CpuMemoryEventLoopSampleV1 = Infer<typeof cpuMemoryEventLoopSchema>;
export type WorkerRestartSampleV1 = Infer<typeof workerRestartSchema>;

function sortAndCheck<T>(values: readonly T[], key: (value: T) => string, path: string): readonly T[] {
  const keys = values.map(key);
  strictSorted(keys, path);
  if (new Set(keys).size !== keys.length) throw new TypeError(`duplicate entry at ${path}`);
  return values;
}

const metricStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-metric-sample"),
  metricSampleId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  processLogAnchorHash: hashSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  generationSourceCoverageRoot: hashSchema,
  sourceCoverageRoot: hashSchema,
  headStartMonotonicNs: decimalStringSchema,
  headTerminalMonotonicNs: decimalStringSchema,
  headDurationUs: decimalStringSchema,
  candidatePathDurationUs: nullableSchema(decimalStringSchema),
  sourceCoarseDurationUs: decimalStringSchema,
  coarseDurationUs: decimalStringSchema,
  plannerExactProgramDurationUs: decimalStringSchema,
  finalSimulationQueueWaitUs: decimalStringSchema,
  finalSimulationServiceUs: decimalStringSchema,
  overheadDurationUs: decimalStringSchema,
  queueTelemetry: arraySchema(queueTelemetrySchema),
  permitAccounting: arraySchema(permitAccountingSchema),
  resourceSamples: arraySchema(resourceSampleSchema),
  cpuMemoryEventLoop: cpuMemoryEventLoopSchema,
  workerRestart: workerRestartSchema,
  rawReceiptSetRoot: hashSchema,
});

export type PerformanceMetricSampleV1 = Infer<typeof metricStructuralSchema>;

function metricPayload(value: PerformanceMetricSampleV1): Omit<PerformanceMetricSampleV1, "metricSampleId"> {
  return payloadWithout(value, ["metricSampleId"]);
}

function nonNegativeDecimal(value: string, path: string): void {
  if (decimal(value) < 0n) throw new TypeError(`negative decimal at ${path}`);
}

function checkMetric(value: PerformanceMetricSampleV1, path: string): PerformanceMetricSampleV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`metric ordinal is outside 1..100 at ${path}.ordinal`);
  for (const [name, hash] of [["windowId", value.windowId], ["processLogAnchorHash", value.processLogAnchorHash], ["graphRoot", value.graphRoot], ["readyRecordHash", value.readyRecordHash], ["providerRoot", value.providerRoot], ["hardwareProfileRoot", value.hardwareProfileRoot], ["generationSourceCoverageRoot", value.generationSourceCoverageRoot], ["sourceCoverageRoot", value.sourceCoverageRoot], ["rawReceiptSetRoot", value.rawReceiptSetRoot]] as const) positiveHash(hash, `${path}.${name}`);
  nonNegativeDurationUs(value.headStartMonotonicNs, value.headTerminalMonotonicNs, value.headDurationUs, `${path}.headDurationUs`);
  if (value.candidatePathDurationUs !== null) nonNegativeDecimal(value.candidatePathDurationUs, `${path}.candidatePathDurationUs`);
  for (const [name, raw] of [["sourceCoarseDurationUs", value.sourceCoarseDurationUs], ["coarseDurationUs", value.coarseDurationUs], ["plannerExactProgramDurationUs", value.plannerExactProgramDurationUs], ["finalSimulationQueueWaitUs", value.finalSimulationQueueWaitUs], ["finalSimulationServiceUs", value.finalSimulationServiceUs], ["overheadDurationUs", value.overheadDurationUs], ["cpuUtilizationBasisPoints", value.cpuMemoryEventLoop.cpuUtilizationBasisPoints], ["rssBytes", value.cpuMemoryEventLoop.rssBytes], ["eventLoopLagUs", value.cpuMemoryEventLoop.eventLoopLagUs], ["workerCount", value.workerRestart.workerCount], ["restarted", value.workerRestart.restarted], ["orphanedWorkers", value.workerRestart.orphanedWorkers]] as const) nonNegativeDecimal(raw, `${path}.${name}`);
  if (decimal(value.cpuMemoryEventLoop.cpuUtilizationBasisPoints) > 10000n) throw new TypeError(`CPU utilization exceeds 10000 basis points at ${path}`);
  if (decimal(value.workerRestart.orphanedWorkers) !== 0n) throw new TypeError(`orphaned workers are not permitted at ${path}.workerRestart`);
  sortAndCheck(value.queueTelemetry, (entry) => `${entry.lane}\u0000${entry.resource}`, `${path}.queueTelemetry`);
  sortAndCheck(value.permitAccounting, (entry) => `${entry.ownerRef}\u0000${entry.lane}\u0000${entry.resource}`, `${path}.permitAccounting`);
  sortAndCheck(value.resourceSamples, (entry) => entry.resource, `${path}.resourceSamples`);
  for (const [index, entry] of value.permitAccounting.entries()) {
    if (decimal(entry.released) > decimal(entry.issued) || decimal(entry.active) !== decimal(entry.issued) - decimal(entry.released)) throw new TypeError(`permit accounting is not conserved at ${path}.permitAccounting[${index}]`);
  }
  for (const [index, entry] of value.queueTelemetry.entries()) {
    if (decimal(entry.current) > decimal(entry.max)) throw new TypeError(`queue current exceeds max at ${path}.queueTelemetry[${index}]`);
  }
  const expected = hashDomain("aloha/performance-metric-sample/v1", metricPayload(value));
  if (value.metricSampleId !== expected) throw new TypeError(`metric sample identity mismatch at ${path}.metricSampleId`);
  return Object.freeze(value);
}

const metricSchema = refineSchema(metricStructuralSchema, "aloha.performance-metric-sample.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-metric-sample.refinement.v1", version: "2.0.0", rules: ["duration-from-monotonic-anchors", "source-and-edge-coarse-timing", "queue-permit-conservation", "known-lane-resource", "metric-id"] }), checkMetric);

export const PERFORMANCE_METRIC_SAMPLE_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-metric-sample", "1.0.0", metricSchema);

export function createPerformanceMetricSample(draft: Omit<PerformanceMetricSampleV1, "metricSampleId" | "schemaVersion" | "kind">): PerformanceMetricSampleV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-metric-sample" as const, ...draft, metricSampleId: ZERO_HASH };
  const metricSampleId = hashDomain("aloha/performance-metric-sample/v1", metricPayload(intermediate));
  return metricSchema.decode({ ...intermediate, metricSampleId });
}

export function decodePerformanceMetricSample(value: string | Uint8Array | object): PerformanceMetricSampleV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return metricSchema.decode(input);
}

export function hashPerformanceMetricSample(value: PerformanceMetricSampleV1): Hash {
  return hashDomain("aloha/performance-metric-sample/v1", metricPayload(decodePerformanceMetricSample(value)));
}

export function encodePerformanceMetricSample(value: PerformanceMetricSampleV1): Uint8Array {
  return encodeCanonicalBytes(metricSchema.decode(value));
}

export const PERFORMANCE_OUTCOMES = Object.freeze([
  "complete-no-candidate",
  "complete-candidates-terminal",
  "timeout",
  "queue-full",
  "resource-failure",
  "stale",
  "unknown",
  "evidence-invalid",
  "incomplete",
] as const);
export type PerformanceHeadOutcomeV1 = (typeof PERFORMANCE_OUTCOMES)[number];
export type HealthyPerformanceHeadOutcomeV1 = "complete-no-candidate" | "complete-candidates-terminal";
export type UnhealthyPerformanceHeadOutcomeV1 = Exclude<PerformanceHeadOutcomeV1, HealthyPerformanceHeadOutcomeV1>;

export function isHealthyPerformanceOutcome(value: PerformanceHeadOutcomeV1): value is HealthyPerformanceHeadOutcomeV1 {
  return value === "complete-no-candidate" || value === "complete-candidates-terminal";
}

const terminalStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-head-terminal"),
  receiptId: hashSchema,
  windowId: hashSchema,
  ordinal: decimalStringSchema,
  canonicalHead: sourceAnchorSchema,
  supersededOrphanObservationRoot: nullableSchema(hashSchema),
  processLogAnchorHash: hashSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  performanceProfileHash: hashSchema,
  providerRoot: hashSchema,
  hardwareProfileRoot: hashSchema,
  generationSourceCoverageRoot: hashSchema,
  sourceCoverageRoot: hashSchema,
  candidateSetRoot: hashSchema,
  orderedCandidateTerminalReceiptRoot: hashSchema,
  outcome: enumSchema(PERFORMANCE_OUTCOMES),
  healthy: booleanSchema,
  acceptedMonotonicNs: decimalStringSchema,
  terminalMonotonicNs: decimalStringSchema,
  logRangeStartOffset: decimalStringSchema,
  logRangeEndOffset: decimalStringSchema,
  headDurationUs: decimalStringSchema,
  metricSampleId: hashSchema,
  timingSampleRoot: hashSchema,
  workReceiptRoot: hashSchema,
  queueTelemetryRoot: hashSchema,
  resourceSampleRoot: hashSchema,
  cpuMemoryEventLoopRoot: hashSchema,
  workerRestartRoot: hashSchema,
  rawReceiptSetRoot: hashSchema,
});

export type HeadTerminalReceiptV1 = Infer<typeof terminalStructuralSchema>;

function terminalPayload(value: HeadTerminalReceiptV1): Omit<HeadTerminalReceiptV1, "receiptId"> {
  return payloadWithout(value, ["receiptId"]);
}

export function hashQueueTelemetryRoot(entries: readonly QueueTelemetryV1[]): Hash {
  return hashDomain("aloha/performance-queue-telemetry-root/v1", entries);
}
export function hashPermitAccountingRoot(entries: readonly PermitAccountingV1[]): Hash {
  return hashDomain("aloha/performance-permit-accounting-root/v1", entries);
}
export function hashResourceSampleRoot(entries: readonly ResourceSampleV1[]): Hash {
  return hashDomain("aloha/performance-resource-sample-root/v1", entries);
}
export function hashCpuMemoryEventLoopRoot(value: CpuMemoryEventLoopSampleV1): Hash {
  return hashDomain("aloha/performance-cpu-memory-event-loop-root/v1", value);
}
export function hashWorkerRestartRoot(value: WorkerRestartSampleV1): Hash {
  return hashDomain("aloha/performance-worker-restart-root/v1", value);
}
export function hashTimingSampleRoot(value: Pick<PerformanceMetricSampleV1, "headDurationUs" | "candidatePathDurationUs">): Hash {
  return hashDomain("aloha/performance-timing-sample-root/v1", value);
}

function checkTerminal(value: HeadTerminalReceiptV1, path: string): HeadTerminalReceiptV1 {
  if (decimal(value.ordinal) < 1n || decimal(value.ordinal) > 100n) throw new TypeError(`terminal ordinal is outside 1..100 at ${path}.ordinal`);
  for (const [name, hash] of [["windowId", value.windowId], ["processLogAnchorHash", value.processLogAnchorHash], ["graphRoot", value.graphRoot], ["readyRecordHash", value.readyRecordHash], ["performanceProfileHash", value.performanceProfileHash], ["providerRoot", value.providerRoot], ["hardwareProfileRoot", value.hardwareProfileRoot], ["generationSourceCoverageRoot", value.generationSourceCoverageRoot], ["sourceCoverageRoot", value.sourceCoverageRoot], ["candidateSetRoot", value.candidateSetRoot], ["orderedCandidateTerminalReceiptRoot", value.orderedCandidateTerminalReceiptRoot], ["metricSampleId", value.metricSampleId], ["timingSampleRoot", value.timingSampleRoot], ["workReceiptRoot", value.workReceiptRoot], ["queueTelemetryRoot", value.queueTelemetryRoot], ["resourceSampleRoot", value.resourceSampleRoot], ["cpuMemoryEventLoopRoot", value.cpuMemoryEventLoopRoot], ["workerRestartRoot", value.workerRestartRoot], ["rawReceiptSetRoot", value.rawReceiptSetRoot]] as const) positiveHash(hash, `${path}.${name}`);
  if (value.healthy !== isHealthyPerformanceOutcome(value.outcome)) throw new TypeError(`healthy must be derived from outcome at ${path}.healthy`);
  nonNegativeDurationUs(value.acceptedMonotonicNs, value.terminalMonotonicNs, value.headDurationUs, `${path}.headDurationUs`);
  if (decimal(value.logRangeEndOffset) < decimal(value.logRangeStartOffset)) throw new TypeError(`log range offset is inverted at ${path}`);
  const expected = hashDomain("aloha/performance-head-terminal/v1", terminalPayload(value));
  if (value.receiptId !== expected) throw new TypeError(`head terminal identity mismatch at ${path}.receiptId`);
  return Object.freeze(value);
}

const terminalSchema = refineSchema(terminalStructuralSchema, "aloha.performance-head-terminal.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-head-terminal.refinement.v1", version: "1.0.0", rules: ["one-terminal-per-ordinal", "derived-health", "duration-from-anchors", "terminal-id"] }), checkTerminal);

export const PERFORMANCE_HEAD_TERMINAL_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-head-terminal", "1.0.0", terminalSchema);

export function createHeadTerminalReceipt(draft: Omit<HeadTerminalReceiptV1, "receiptId" | "schemaVersion" | "kind" | "healthy"> & { readonly outcome: PerformanceHeadOutcomeV1 }): HeadTerminalReceiptV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-head-terminal" as const, ...draft, healthy: isHealthyPerformanceOutcome(draft.outcome), receiptId: ZERO_HASH };
  const receiptId = hashDomain("aloha/performance-head-terminal/v1", terminalPayload(intermediate));
  return terminalSchema.decode({ ...intermediate, receiptId });
}

export function decodeHeadTerminalReceipt(value: string | Uint8Array | object): HeadTerminalReceiptV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return terminalSchema.decode(input);
}

export function encodeHeadTerminalReceipt(value: HeadTerminalReceiptV1): Uint8Array {
  return encodeCanonicalBytes(terminalSchema.decode(value));
}

export function hashHeadTerminalReceipt(value: HeadTerminalReceiptV1): Hash {
  return hashDomain("aloha/performance-head-terminal/v1", terminalPayload(decodeHeadTerminalReceipt(value)));
}

export const PERFORMANCE_HEAD_TERMINAL_SCHEMA = terminalSchema;

const generationSegmentStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-generation-segment"),
  segmentId: hashSchema,
  windowId: hashSchema,
  segmentOrdinal: decimalStringSchema,
  firstHeadOrdinal: decimalStringSchema,
  lastHeadOrdinal: decimalStringSchema,
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  readyRecordHash: hashSchema,
  generationSourceCoverageRoot: hashSchema,
  orderedHeadRecordRoot: hashSchema,
  orderedTerminalReceiptRoot: hashSchema,
  orderedMetricSampleRoot: hashSchema,
});

export type PerformanceGenerationSegmentV1 = Infer<typeof generationSegmentStructuralSchema>;

function generationSegmentPayload(value: PerformanceGenerationSegmentV1): Omit<PerformanceGenerationSegmentV1, "segmentId"> {
  return payloadWithout(value, ["segmentId"]);
}

function checkGenerationSegment(value: PerformanceGenerationSegmentV1, path: string): PerformanceGenerationSegmentV1 {
  const segmentOrdinal = decimal(value.segmentOrdinal);
  const first = decimal(value.firstHeadOrdinal);
  const last = decimal(value.lastHeadOrdinal);
  if (segmentOrdinal < 1n || segmentOrdinal > 100n) throw new TypeError(`segment ordinal is outside 1..100 at ${path}.segmentOrdinal`);
  if (first < 1n || last > 100n || first > last) throw new TypeError(`generation segment range is invalid at ${path}`);
  for (const [name, hash] of [
    ["windowId", value.windowId], ["graphRoot", value.graphRoot], ["readyRecordHash", value.readyRecordHash],
    ["generationSourceCoverageRoot", value.generationSourceCoverageRoot], ["orderedHeadRecordRoot", value.orderedHeadRecordRoot],
    ["orderedTerminalReceiptRoot", value.orderedTerminalReceiptRoot], ["orderedMetricSampleRoot", value.orderedMetricSampleRoot],
  ] as const) positiveHash(hash, `${path}.${name}`);
  const expected = hashDomain("aloha/performance-generation-segment/v1", generationSegmentPayload(value));
  if (value.segmentId !== expected) throw new TypeError(`generation segment identity mismatch at ${path}.segmentId`);
  return Object.freeze(value);
}

const generationSegmentSchema = refineSchema(
  generationSegmentStructuralSchema,
  "aloha.performance-generation-segment.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-generation-segment.refinement.v1",
    version: "1.0.0",
    rules: ["bounded-contiguous-range", "exact-serving-identity", "ordered-fact-roots", "segment-id"],
  }),
  checkGenerationSegment,
);

export const PERFORMANCE_GENERATION_SEGMENT_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.performance-generation-segment",
  "1.0.0",
  generationSegmentSchema,
);

export function createPerformanceGenerationSegment(
  draft: Omit<PerformanceGenerationSegmentV1, "segmentId" | "schemaVersion" | "kind">,
): PerformanceGenerationSegmentV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-generation-segment" as const, ...draft, segmentId: ZERO_HASH };
  const segmentId = hashDomain("aloha/performance-generation-segment/v1", generationSegmentPayload(intermediate));
  return generationSegmentSchema.decode({ ...intermediate, segmentId });
}

export function decodePerformanceGenerationSegment(value: string | Uint8Array | object): PerformanceGenerationSegmentV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return generationSegmentSchema.decode(input);
}

export function hashPerformanceGenerationSegment(value: PerformanceGenerationSegmentV1): Hash {
  return hashDomain("aloha/performance-generation-segment/v1", generationSegmentPayload(decodePerformanceGenerationSegment(value)));
}

export function encodePerformanceGenerationSegment(value: PerformanceGenerationSegmentV1): Uint8Array {
  return encodeCanonicalBytes(generationSegmentSchema.decode(value));
}

const windowReceiptStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-window-receipt"),
  receiptId: hashSchema,
  windowId: hashSchema,
  windowCommitmentHash: hashSchema,
  orderedEligibleHeadRecordRoot: hashSchema,
  orderedHeadTerminalReceiptRoot: hashSchema,
  orphanReplacementLineageRoot: hashSchema,
  candidateBearingHeadSetRoot: hashSchema,
  fullHeadTimingSampleRoot: hashSchema,
  candidatePathTimingSampleRoot: hashSchema,
  metricRecomputationRoot: hashSchema,
  generationSegmentRoot: hashSchema,
  rawReceiptSetRoot: hashSchema,
  headCount: literalSchema(PERFORMANCE_TARGET_COUNT),
  healthyHeadCount: decimalStringSchema,
  excludedHeads: arraySchema(hashSchema),
  windowStartMonotonicNs: decimalStringSchema,
  windowEndMonotonicNs: decimalStringSchema,
  windowDurationUs: decimalStringSchema,
});

export type PerformanceWindowReceiptV1 = Infer<typeof windowReceiptStructuralSchema>;

function windowReceiptPayload(value: PerformanceWindowReceiptV1): Omit<PerformanceWindowReceiptV1, "receiptId"> {
  return payloadWithout(value, ["receiptId"]);
}

function checkWindowReceipt(value: PerformanceWindowReceiptV1, path: string): PerformanceWindowReceiptV1 {
  for (const [name, hash] of [["windowId", value.windowId], ["windowCommitmentHash", value.windowCommitmentHash], ["orderedEligibleHeadRecordRoot", value.orderedEligibleHeadRecordRoot], ["orderedHeadTerminalReceiptRoot", value.orderedHeadTerminalReceiptRoot], ["orphanReplacementLineageRoot", value.orphanReplacementLineageRoot], ["candidateBearingHeadSetRoot", value.candidateBearingHeadSetRoot], ["fullHeadTimingSampleRoot", value.fullHeadTimingSampleRoot], ["candidatePathTimingSampleRoot", value.candidatePathTimingSampleRoot], ["metricRecomputationRoot", value.metricRecomputationRoot], ["generationSegmentRoot", value.generationSegmentRoot], ["rawReceiptSetRoot", value.rawReceiptSetRoot]] as const) positiveHash(hash, `${path}.${name}`);
  if (value.excludedHeads.length !== 0) throw new TypeError(`excludedHeads must be empty at ${path}.excludedHeads`);
  if (decimal(value.healthyHeadCount) > 100n) throw new TypeError(`healthyHeadCount exceeds target at ${path}`);
  nonNegativeDurationUs(value.windowStartMonotonicNs, value.windowEndMonotonicNs, value.windowDurationUs, `${path}.windowDurationUs`);
  const expected = hashDomain("aloha/performance-window-receipt/v1", windowReceiptPayload(value));
  if (value.receiptId !== expected) throw new TypeError(`window receipt identity mismatch at ${path}.receiptId`);
  return Object.freeze(value);
}

const windowReceiptSchema = refineSchema(windowReceiptStructuralSchema, "aloha.performance-window-receipt.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-window-receipt.refinement.v1", version: "1.0.0", rules: ["exact-100", "excluded-heads-empty", "window-duration-from-anchors", "receipt-id"] }), checkWindowReceipt);

export const PERFORMANCE_WINDOW_RECEIPT_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-window-receipt", "1.0.0", windowReceiptSchema);

export function createPerformanceWindowReceipt(draft: Omit<PerformanceWindowReceiptV1, "receiptId" | "schemaVersion" | "kind">): PerformanceWindowReceiptV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-window-receipt" as const, ...draft, receiptId: ZERO_HASH };
  const receiptId = hashDomain("aloha/performance-window-receipt/v1", windowReceiptPayload(intermediate));
  return windowReceiptSchema.decode({ ...intermediate, receiptId });
}

export function decodePerformanceWindowReceipt(value: string | Uint8Array | object): PerformanceWindowReceiptV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return windowReceiptSchema.decode(input);
}

export function hashPerformanceWindowReceipt(value: PerformanceWindowReceiptV1): Hash {
  return hashDomain("aloha/performance-window-receipt/v1", windowReceiptPayload(decodePerformanceWindowReceipt(value)));
}

export function encodePerformanceWindowReceipt(value: PerformanceWindowReceiptV1): Uint8Array {
  return encodeCanonicalBytes(windowReceiptSchema.decode(value));
}

const acceptanceReceiptStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-acceptance-receipt"),
  receiptId: hashSchema,
  predicateSpecDigest: hashSchema,
  windowCommitmentHash: hashSchema,
  windowReceiptHash: hashSchema,
  orderedHeadTerminalReceiptRoot: hashSchema,
  headCount: literalSchema(PERFORMANCE_TARGET_COUNT),
  healthyHeadCount: decimalStringSchema,
  candidateBearingHeadSetRoot: hashSchema,
  fullHeadTimingSampleRoot: hashSchema,
  candidatePathTimingSampleRoot: hashSchema,
  metricRecomputationRoot: hashSchema,
  generationSegmentRoot: hashSchema,
  rawReceiptSetRoot: hashSchema,
  verdict: enumSchema(["pass", "fail", "invalid"] as const),
});

export type PerformanceAcceptanceReceiptV1 = Infer<typeof acceptanceReceiptStructuralSchema>;

function acceptanceReceiptPayload(value: PerformanceAcceptanceReceiptV1): Omit<PerformanceAcceptanceReceiptV1, "receiptId"> {
  return payloadWithout(value, ["receiptId"]);
}

function checkAcceptanceReceipt(value: PerformanceAcceptanceReceiptV1, path: string): PerformanceAcceptanceReceiptV1 {
  for (const [name, hash] of [["predicateSpecDigest", value.predicateSpecDigest], ["windowCommitmentHash", value.windowCommitmentHash], ["windowReceiptHash", value.windowReceiptHash], ["orderedHeadTerminalReceiptRoot", value.orderedHeadTerminalReceiptRoot], ["candidateBearingHeadSetRoot", value.candidateBearingHeadSetRoot], ["fullHeadTimingSampleRoot", value.fullHeadTimingSampleRoot], ["candidatePathTimingSampleRoot", value.candidatePathTimingSampleRoot], ["metricRecomputationRoot", value.metricRecomputationRoot], ["generationSegmentRoot", value.generationSegmentRoot], ["rawReceiptSetRoot", value.rawReceiptSetRoot]] as const) positiveHash(hash, `${path}.${name}`);
  if (decimal(value.healthyHeadCount) > 100n) throw new TypeError(`healthyHeadCount exceeds target at ${path}`);
  const expected = hashDomain("aloha/performance-acceptance-receipt/v1", acceptanceReceiptPayload(value));
  if (value.receiptId !== expected) throw new TypeError(`performance acceptance receipt identity mismatch at ${path}.receiptId`);
  return Object.freeze(value);
}

const acceptanceReceiptSchema = refineSchema(acceptanceReceiptStructuralSchema, "aloha.performance-acceptance-receipt.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-acceptance-receipt.refinement.v1", version: "1.0.0", rules: ["receipt-id", "roots-bound"] }), checkAcceptanceReceipt);

export const PERFORMANCE_ACCEPTANCE_RECEIPT_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-acceptance-receipt", "1.0.0", acceptanceReceiptSchema);

export function createPerformanceAcceptanceReceipt(draft: Omit<PerformanceAcceptanceReceiptV1, "receiptId" | "schemaVersion" | "kind">): PerformanceAcceptanceReceiptV1 {
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-acceptance-receipt" as const, ...draft, receiptId: ZERO_HASH };
  const receiptId = hashDomain("aloha/performance-acceptance-receipt/v1", acceptanceReceiptPayload(intermediate));
  return acceptanceReceiptSchema.decode({ ...intermediate, receiptId });
}

export function decodePerformanceAcceptanceReceipt(value: string | Uint8Array | object): PerformanceAcceptanceReceiptV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return acceptanceReceiptSchema.decode(input);
}

export function hashPerformanceAcceptanceReceipt(value: PerformanceAcceptanceReceiptV1): Hash {
  return hashDomain("aloha/performance-acceptance-receipt/v1", acceptanceReceiptPayload(decodePerformanceAcceptanceReceipt(value)));
}

export function encodePerformanceAcceptanceReceipt(value: PerformanceAcceptanceReceiptV1): Uint8Array {
  return encodeCanonicalBytes(acceptanceReceiptSchema.decode(value));
}

export interface PerformanceFactBundleV1 {
  readonly profile: ProductionPerformanceProfileV1;
  readonly commitment: PerformanceWindowCommitmentV1;
  readonly heads: readonly EligibleHeadRecordV1[];
  readonly lineages: readonly HeadOrphanReplacementLineageV1[];
  readonly candidateSets: readonly CandidateSetV1[];
  readonly candidateTerminals: readonly CandidateTerminalReceiptV1[];
  readonly metrics: readonly PerformanceMetricSampleV1[];
  readonly terminals: readonly HeadTerminalReceiptV1[];
  readonly generationSegments: readonly PerformanceGenerationSegmentV1[];
  readonly windowReceipt: PerformanceWindowReceiptV1;
}

const performanceFactBundleSchema = objectSchema({
  profile: productionPerformanceProfileSchema,
  commitment: windowCommitmentSchema,
  heads: arraySchema(eligibleHeadSchema),
  lineages: arraySchema(orphanReplacementSchema),
  candidateSets: arraySchema(candidateSetSchema),
  candidateTerminals: arraySchema(candidateTerminalSchema),
  metrics: arraySchema(metricSchema),
  terminals: arraySchema(terminalSchema),
  generationSegments: arraySchema(generationSegmentSchema),
  windowReceipt: windowReceiptSchema,
});

function ordinal(value: { readonly ordinal: string }): bigint {
  return BigInt(value.ordinal);
}

function assertCanonicalBundleOrder(value: PerformanceFactBundleV1, path: string): PerformanceFactBundleV1 {
  const ordered = (values: readonly { readonly ordinal: string }[], valuePath: string): void => {
    for (let index = 1; index < values.length; index += 1) {
      if (ordinal(values[index - 1]!) >= ordinal(values[index]!)) {
        throw new TypeError(`bundle records must be strictly ordinal-ordered at ${valuePath}`);
      }
    }
  };
  ordered(value.heads, `${path}.heads`);
  ordered(value.lineages, `${path}.lineages`);
  ordered(value.candidateSets, `${path}.candidateSets`);
  ordered(value.metrics, `${path}.metrics`);
  ordered(value.terminals, `${path}.terminals`);
  for (const [index, segment] of value.generationSegments.entries()) {
    if (segment.segmentOrdinal !== (index + 1).toString()) {
      throw new TypeError(`bundle generation segments must be segment-ordinal ordered at ${path}.generationSegments[${index}]`);
    }
  }
  let previousOrdinal = -1n;
  let previousId = "";
  for (const [index, candidate] of value.candidateTerminals.entries()) {
    const currentOrdinal = ordinal(candidate);
    if (currentOrdinal < previousOrdinal || (currentOrdinal === previousOrdinal && candidate.receiptId <= previousId)) {
      throw new TypeError(`bundle candidate terminals must be ordinal/receipt ordered at ${path}.candidateTerminals[${index}]`);
    }
    previousOrdinal = currentOrdinal;
    previousId = candidate.receiptId;
  }
  return Object.freeze(value);
}

const refinedPerformanceFactBundleSchema = refineSchema(
  performanceFactBundleSchema,
  "aloha.performance-fact-bundle.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-fact-bundle.refinement.v1",
    version: "1.0.0",
    rules: ["content-addressed-nested-facts", "strict-ordinal-order", "candidate-terminal-order"],
  }),
  (value, path) => assertCanonicalBundleOrder(value, path),
);

export const PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.performance-fact-bundle",
  "1.0.0",
  refinedPerformanceFactBundleSchema,
);

export function decodePerformanceFactBundle(value: string | Uint8Array | object): PerformanceFactBundleV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return refinedPerformanceFactBundleSchema.decode(input);
}

export const PERFORMANCE_PARTITIONED_FACT_BUNDLE_MAX_BYTES = 16 * CANONICAL_LIMITS.maxBytes;

const PERFORMANCE_FACT_BUNDLE_KEYS = Object.freeze([
  "profile",
  "commitment",
  "heads",
  "lineages",
  "candidateSets",
  "candidateTerminals",
  "metrics",
  "terminals",
  "generationSegments",
  "windowReceipt",
] as const);

/**
 * Exact decoder for an in-memory aggregate assembled from independently
 * bounded performance artifacts.  The wire codec above deliberately remains
 * a single canonical JSON artifact and therefore retains the global 1 MiB
 * limit.  This decoder instead validates the aggregate shell and each array
 * container structurally, then applies the existing exact schema to every
 * nested fact independently.
 */
export function decodePartitionedPerformanceFactBundle(value: object): PerformanceFactBundleV1 {
  assertExactKeys(value, PERFORMANCE_FACT_BUNDLE_KEYS);
  let aggregateBytes = 2;
  let fieldIndex = 0;
  const charge = (bytes: number, path: string): void => {
    aggregateBytes += bytes;
    if (aggregateBytes > PERFORMANCE_PARTITIONED_FACT_BUNDLE_MAX_BYTES) {
      throw new TypeError(`partitioned performance fact bundle exceeds byte policy at ${path}`);
    }
  };
  const field = (key: typeof PERFORMANCE_FACT_BUNDLE_KEYS[number]): unknown => {
    charge(new TextEncoder().encode(JSON.stringify(key)).length + 1 + (fieldIndex > 0 ? 1 : 0), `$.${key}`);
    fieldIndex += 1;
    return readOwnEnumerableDataProperty(value, key);
  };
  const scalar = <T>(
    key: typeof PERFORMANCE_FACT_BUNDLE_KEYS[number],
    decode: (entry: unknown, path: string) => T,
  ): T => {
    const path = `$.${key}`;
    const raw = field(key);
    charge(encodeCanonicalBytes(raw).length, path);
    return decode(raw, path);
  };
  const array = <T>(
    key: typeof PERFORMANCE_FACT_BUNDLE_KEYS[number],
    maxItems: number,
    decode: (entry: unknown, path: string) => T,
  ): readonly T[] => {
    const path = `$.${key}`;
    const raw = field(key);
    assertConcreteArray(raw, path);
    if (raw.length > maxItems) throw new TypeError(`partitioned performance fact array exceeds item policy at ${path}`);
    charge(2 + Math.max(0, raw.length - 1), path);
    return fieldArray(raw, (entry, entryPath) => {
      charge(encodeCanonicalBytes(entry).length, entryPath);
      return decode(entry, entryPath);
    }, path);
  };
  return assertCanonicalBundleOrder(Object.freeze({
    profile: scalar("profile", (entry, path) => productionPerformanceProfileSchema.decode(entry, path)),
    commitment: scalar("commitment", (entry, path) => windowCommitmentSchema.decode(entry, path)),
    heads: array("heads", 100, (entry, path) => eligibleHeadSchema.decode(entry, path)),
    lineages: array("lineages", 100, (entry, path) => orphanReplacementSchema.decode(entry, path)),
    candidateSets: array("candidateSets", 100, (entry, path) => candidateSetSchema.decode(entry, path)),
    candidateTerminals: array("candidateTerminals", CANONICAL_LIMITS.maxArrayItems, (entry, path) => candidateTerminalSchema.decode(entry, path)),
    metrics: array("metrics", 100, (entry, path) => metricSchema.decode(entry, path)),
    terminals: array("terminals", 100, (entry, path) => terminalSchema.decode(entry, path)),
    generationSegments: array("generationSegments", 100, (entry, path) => generationSegmentSchema.decode(entry, path)),
    windowReceipt: scalar("windowReceipt", (entry, path) => windowReceiptSchema.decode(entry, path)),
  }), "$");
}

export function encodePerformanceFactBundle(value: PerformanceFactBundleV1): Uint8Array {
  return encodeCanonicalBytes(refinedPerformanceFactBundleSchema.decode(value));
}

export function hashPerformanceFactBundleBytes(value: PerformanceFactBundleV1): Hash {
  return sha256Hex(encodePerformanceFactBundle(value));
}

const performanceFactEnvelopeStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-fact-envelope"),
  envelopeId: hashSchema,
  factType: enumSchema(["profile", "event"] as const),
  sequence: nullableSchema(decimalStringSchema),
  artifactRefId: hashSchema,
  claimId: hashSchema,
  observationId: hashSchema,
  contentSha256: hashSchema,
  byteLength: decimalStringSchema,
});

export type PerformanceFactEnvelopeV1 = Infer<typeof performanceFactEnvelopeStructuralSchema>;

function performanceFactEnvelopePayload(value: PerformanceFactEnvelopeV1): Omit<PerformanceFactEnvelopeV1, "envelopeId"> {
  return payloadWithout(value, ["envelopeId"]);
}

function checkPerformanceFactEnvelope(value: PerformanceFactEnvelopeV1, path: string): PerformanceFactEnvelopeV1 {
  for (const [name, hash] of [["artifactRefId", value.artifactRefId], ["claimId", value.claimId], ["observationId", value.observationId], ["contentSha256", value.contentSha256]] as const) {
    positiveHash(hash, `${path}.${name}`);
  }
  if ((value.factType === "profile" && value.sequence !== null) || (value.factType === "event" && value.sequence === null)) {
    throw new TypeError(`fact envelope sequence does not match factType at ${path}`);
  }
  if (decimal(value.byteLength) <= 0n) throw new TypeError(`fact envelope byteLength must be positive at ${path}.byteLength`);
  const expected = hashDomain("aloha/performance-fact-envelope/v1", performanceFactEnvelopePayload(value));
  if (value.envelopeId !== expected) throw new TypeError(`fact envelope identity mismatch at ${path}.envelopeId`);
  return Object.freeze(value);
}

const performanceFactEnvelopeSchema = refineSchema(
  performanceFactEnvelopeStructuralSchema,
  "aloha.performance-fact-envelope.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.performance-fact-envelope.refinement.v1",
    version: "1.0.0",
    rules: ["content-addressed-identities", "positive-content-length", "envelope-id"],
  }),
  checkPerformanceFactEnvelope,
);

export const PERFORMANCE_FACT_ENVELOPE_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.performance-fact-envelope",
  "1.0.0",
  performanceFactEnvelopeSchema,
);

export type PerformanceFactEnvelopeDraftV1 = Omit<PerformanceFactEnvelopeV1, "envelopeId" | "schemaVersion" | "kind"> & {
  readonly schemaVersion?: 1;
  readonly kind?: "aloha.performance-fact-envelope";
};

export function createPerformanceFactEnvelope(draft: PerformanceFactEnvelopeDraftV1): PerformanceFactEnvelopeV1 {
  const intermediate = {
    schemaVersion: 1 as const,
    kind: "aloha.performance-fact-envelope" as const,
    ...draft,
    envelopeId: ZERO_HASH,
  };
  const envelopeId = hashDomain("aloha/performance-fact-envelope/v1", performanceFactEnvelopePayload(intermediate));
  return performanceFactEnvelopeSchema.decode({ ...intermediate, envelopeId });
}

export function decodePerformanceFactEnvelope(value: string | Uint8Array | object): PerformanceFactEnvelopeV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return performanceFactEnvelopeSchema.decode(input);
}

export function encodePerformanceFactEnvelope(value: PerformanceFactEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(performanceFactEnvelopeSchema.decode(value));
}

export function hashPerformanceFactEnvelope(value: PerformanceFactEnvelopeV1): Hash {
  return hashDomain("aloha/performance-fact-envelope/v1", performanceFactEnvelopePayload(decodePerformanceFactEnvelope(value)));
}

export function hashOrderedEligibleHeadRecordsRoot(heads: readonly EligibleHeadRecordV1[]): Hash {
  return hashDomain("aloha/performance-ordered-eligible-head-root/v1", heads.map(hashEligibleHeadRecord));
}
export function hashOrderedHeadTerminalReceiptRoot(terminals: readonly HeadTerminalReceiptV1[]): Hash {
  return hashDomain("aloha/performance-ordered-head-terminal-root/v1", terminals.map(hashHeadTerminalReceipt));
}
export function hashOrphanReplacementLineageRoot(lineages: readonly HeadOrphanReplacementLineageV1[]): Hash {
  return hashDomain("aloha/performance-orphan-replacement-root/v1", lineages.map(hashHeadOrphanReplacementLineage));
}
export function hashOrderedCandidateTerminalReceiptRoot(receipts: readonly CandidateTerminalReceiptV1[]): Hash {
  return hashDomain("aloha/performance-ordered-candidate-terminal-root/v1", receipts.map(hashCandidateTerminalReceipt));
}
export function hashCandidateBearingHeadSetRoot(heads: readonly EligibleHeadRecordV1[]): Hash {
  return hashDomain("aloha/performance-candidate-bearing-head-set/v1", heads.filter((head) => head.candidateBearing).map((head) => ({ ordinal: head.ordinal, headRecordId: head.headRecordId, candidateSetRoot: head.candidateSetRoot })));
}
export function hashFullHeadTimingSampleRoot(metrics: readonly PerformanceMetricSampleV1[]): Hash {
  return hashDomain("aloha/performance-full-head-timing-sample-set/v1", metrics.map((metric) => ({ ordinal: metric.ordinal, metricSampleId: metric.metricSampleId, durationUs: metric.headDurationUs })));
}
export function hashCandidatePathTimingSampleRoot(metrics: readonly PerformanceMetricSampleV1[]): Hash {
  return hashDomain("aloha/performance-candidate-path-timing-sample-set/v1", metrics.filter((metric) => metric.candidatePathDurationUs !== null).map((metric) => ({ ordinal: metric.ordinal, metricSampleId: metric.metricSampleId, durationUs: metric.candidatePathDurationUs })));
}
export function hashMetricRecomputationRoot(metrics: readonly PerformanceMetricSampleV1[]): Hash {
  return hashDomain("aloha/performance-metric-recomputation-root/v1", metrics.map((metric) => hashPerformanceMetricSample(metric)));
}
export function hashPerformanceGenerationSegmentRoot(segments: readonly PerformanceGenerationSegmentV1[]): Hash {
  return hashDomain("aloha/performance-generation-segment-root/v1", segments.map(hashPerformanceGenerationSegment));
}

function servingIdentityKey(value: Pick<EligibleHeadRecordV1, "generationId" | "graphRoot" | "readyRecordHash" | "generationSourceCoverageRoot">): string {
  return encodeCanonicalJson({
    generationId: value.generationId,
    graphRoot: value.graphRoot,
    readyRecordHash: value.readyRecordHash,
    generationSourceCoverageRoot: value.generationSourceCoverageRoot,
  });
}

/** Recomputes the unique maximal ordinal-contiguous serving partition. */
export function derivePerformanceGenerationSegments(input: {
  readonly windowId: Hash;
  readonly heads: readonly EligibleHeadRecordV1[];
  readonly terminals: readonly HeadTerminalReceiptV1[];
  readonly metrics: readonly PerformanceMetricSampleV1[];
}): readonly PerformanceGenerationSegmentV1[] {
  if (input.heads.length !== 100 || input.terminals.length !== 100 || input.metrics.length !== 100) {
    throw new TypeError("generation segments require the exact 100-head denominator");
  }
  const segments: PerformanceGenerationSegmentV1[] = [];
  const seenGenerationIds = new Map<string, string>();
  let start = 0;
  for (let index = 0; index < 100; index += 1) {
    const head = input.heads[index]!;
    const terminal = input.terminals[index]!;
    const metric = input.metrics[index]!;
    const expectedOrdinal = (index + 1).toString();
    if (head.ordinal !== expectedOrdinal || terminal.ordinal !== expectedOrdinal || metric.ordinal !== expectedOrdinal) {
      throw new TypeError(`generation segment facts have an ordinal gap at ${expectedOrdinal}`);
    }
    if (head.windowId !== input.windowId || terminal.windowId !== input.windowId || metric.windowId !== input.windowId
      || terminal.generationId !== head.generationId || metric.generationId !== head.generationId
      || terminal.graphRoot !== head.graphRoot || metric.graphRoot !== head.graphRoot
      || terminal.readyRecordHash !== head.readyRecordHash || metric.readyRecordHash !== head.readyRecordHash
      || terminal.generationSourceCoverageRoot !== head.generationSourceCoverageRoot || metric.generationSourceCoverageRoot !== head.generationSourceCoverageRoot
      || terminal.sourceCoverageRoot !== head.sourceCoverageRoot || metric.sourceCoverageRoot !== head.sourceCoverageRoot) {
      throw new TypeError(`generation segment serving identity splice at ordinal ${expectedOrdinal}`);
    }
    const key = servingIdentityKey(head);
    const known = seenGenerationIds.get(head.generationId);
    if (known !== undefined && known !== key) throw new TypeError(`generation identity metadata splice at ordinal ${expectedOrdinal}`);
    seenGenerationIds.set(head.generationId, key);
    const nextKey = index + 1 < 100 ? servingIdentityKey(input.heads[index + 1]!) : null;
    if (nextKey === key) continue;
    if (segments.some(segment => segment.generationId === head.generationId)) {
      throw new TypeError(`generation ${head.generationId} is rejoined after a serving switch`);
    }
    const segmentHeads = input.heads.slice(start, index + 1);
    const segmentTerminals = input.terminals.slice(start, index + 1);
    const segmentMetrics = input.metrics.slice(start, index + 1);
    segments.push(createPerformanceGenerationSegment({
      windowId: input.windowId,
      segmentOrdinal: (segments.length + 1).toString(),
      firstHeadOrdinal: (start + 1).toString(),
      lastHeadOrdinal: (index + 1).toString(),
      generationId: head.generationId,
      graphRoot: head.graphRoot,
      readyRecordHash: head.readyRecordHash,
      generationSourceCoverageRoot: head.generationSourceCoverageRoot,
      orderedHeadRecordRoot: hashDomain("aloha/performance-generation-segment-head-root/v1", segmentHeads.map(hashEligibleHeadRecord)),
      orderedTerminalReceiptRoot: hashDomain("aloha/performance-generation-segment-terminal-root/v1", segmentTerminals.map(hashHeadTerminalReceipt)),
      orderedMetricSampleRoot: hashDomain("aloha/performance-generation-segment-metric-root/v1", segmentMetrics.map(hashPerformanceMetricSample)),
    }));
    start = index + 1;
  }
  return Object.freeze(segments);
}
export function hashRawReceiptSetRoot(ids: readonly Hash[]): Hash {
  return hashDomain("aloha/performance-raw-receipt-set-root/v1", ids);
}

export function hashProcessLogAnchor(anchor: ProcessLogAnchorV1): Hash {
  return hashDomain("aloha/performance-process-log-anchor/v1", anchor);
}

export function hashPerformanceSemanticReceiptSetRoot(input: {
  readonly profile: ProductionPerformanceProfileV1;
  readonly commitment: PerformanceWindowCommitmentV1;
  readonly heads: readonly EligibleHeadRecordV1[];
  readonly lineages: readonly HeadOrphanReplacementLineageV1[];
  readonly candidateSets: readonly CandidateSetV1[];
  readonly candidateTerminals: readonly CandidateTerminalReceiptV1[];
  readonly metrics: readonly PerformanceMetricSampleV1[];
  readonly terminals: readonly HeadTerminalReceiptV1[];
  readonly generationSegments: readonly PerformanceGenerationSegmentV1[];
}): Hash {
  const byOrdinal = <T extends { readonly ordinal: string }>(values: readonly T[]): readonly T[] => [...values].sort((left, right) => {
    const ordinal = decimal(left.ordinal) - decimal(right.ordinal);
    return ordinal === 0n ? encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right)) : ordinal < 0n ? -1 : 1;
  });
  return hashRawReceiptSetRoot([
    hashProductionPerformanceProfile(input.profile),
    hashPerformanceWindowCommitment(input.commitment),
    ...byOrdinal(input.heads).map(hashEligibleHeadRecord),
    ...byOrdinal(input.lineages).map(hashHeadOrphanReplacementLineage),
    ...byOrdinal(input.candidateSets).map(hashCandidateSet),
    ...byOrdinal(input.candidateTerminals).map(hashCandidateTerminalReceipt),
    ...byOrdinal(input.metrics).map(hashPerformanceMetricSample),
    ...byOrdinal(input.terminals).map(hashHeadTerminalReceipt),
    ...input.generationSegments.map(hashPerformanceGenerationSegment),
  ]);
}

const performanceEventStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.performance-event"),
  eventId: hashSchema,
  eventType: enumSchema(["window-commitment", "eligible-head", "orphan-replacement", "candidate-set", "candidate-terminal", "metric-sample", "head-terminal", "generation-segment", "window-receipt"] as const),
  sequence: decimalStringSchema,
  windowId: hashSchema,
  payloadHash: hashSchema,
  payload: canonicalObjectSchema,
});

export type PerformanceEventV1 = Infer<typeof performanceEventStructuralSchema>;

function performanceEventPayload(value: PerformanceEventV1): Omit<PerformanceEventV1, "eventId"> {
  return payloadWithout(value, ["eventId"]);
}

function checkPerformanceEvent(value: PerformanceEventV1, path: string): PerformanceEventV1 {
  positiveHash(value.windowId, `${path}.windowId`);
  positiveHash(value.payloadHash, `${path}.payloadHash`);
  if (value.payloadHash !== hashDomain("aloha/performance-event-payload/v1", value.payload)) throw new TypeError(`performance event payload hash mismatch at ${path}.payloadHash`);
  const expected = hashDomain("aloha/performance-event/v1", performanceEventPayload(value));
  if (value.eventId !== expected) throw new TypeError(`performance event identity mismatch at ${path}.eventId`);
  return Object.freeze(value);
}

const performanceEventSchema = refineSchema(performanceEventStructuralSchema, "aloha.performance-event.refinement.v1", hashDomain("aloha/schema-refinement-spec/v1", { id: "aloha.performance-event.refinement.v1", version: "1.0.0", rules: ["payload-hash", "event-id"] }), checkPerformanceEvent);

export function createPerformanceEvent(input: Omit<PerformanceEventV1, "eventId" | "payloadHash" | "schemaVersion" | "kind">): PerformanceEventV1 {
  const payloadHash = hashDomain("aloha/performance-event-payload/v1", input.payload);
  const intermediate = { schemaVersion: 1 as const, kind: "aloha.performance-event" as const, ...input, payloadHash, eventId: ZERO_HASH } as PerformanceEventV1;
  const eventId = hashDomain("aloha/performance-event/v1", performanceEventPayload(intermediate));
  return performanceEventSchema.decode({ ...intermediate, eventId });
}

export function decodePerformanceEvent(value: string | Uint8Array | object): PerformanceEventV1 {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? decodeCanonicalJson(value as string | Uint8Array) : value;
  return performanceEventSchema.decode(input);
}

export function hashPerformanceEvent(value: PerformanceEventV1): Hash {
  return hashDomain("aloha/performance-event/v1", performanceEventPayload(decodePerformanceEvent(value)));
}

export function encodePerformanceEvent(value: PerformanceEventV1): Uint8Array {
  return encodeCanonicalBytes(performanceEventSchema.decode(value));
}

export const PERFORMANCE_EVENT_SCHEMA_MANIFEST = defineSchemaManifest("aloha.performance-event", "1.0.0", performanceEventSchema);

export const PERFORMANCE_SCHEMA_MANIFESTS = Object.freeze({
  profile: PERFORMANCE_SCHEMA_MANIFESTS_PROFILE_ONLY.profile,
  deploymentWindowBasis: DEPLOYMENT_PERFORMANCE_WINDOW_BASIS_SCHEMA_MANIFEST,
  windowCommitment: PERFORMANCE_WINDOW_COMMITMENT_SCHEMA_MANIFEST,
  eligibleHead: PERFORMANCE_ELIGIBLE_HEAD_SCHEMA_MANIFEST,
  orphanReplacement: PERFORMANCE_ORPHAN_REPLACEMENT_SCHEMA_MANIFEST,
  admissionOrphanReplacement: PERFORMANCE_ADMISSION_ORPHAN_REPLACEMENT_SCHEMA_MANIFEST,
  candidateSet: PERFORMANCE_CANDIDATE_SET_SCHEMA_MANIFEST,
  candidateTerminal: PERFORMANCE_CANDIDATE_TERMINAL_SCHEMA_MANIFEST,
  headTerminal: PERFORMANCE_HEAD_TERMINAL_SCHEMA_MANIFEST,
  metricSample: PERFORMANCE_METRIC_SAMPLE_SCHEMA_MANIFEST,
  generationSegment: PERFORMANCE_GENERATION_SEGMENT_SCHEMA_MANIFEST,
  windowReceipt: PERFORMANCE_WINDOW_RECEIPT_SCHEMA_MANIFEST,
  acceptanceReceipt: PERFORMANCE_ACCEPTANCE_RECEIPT_SCHEMA_MANIFEST,
  factBundle: PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST,
  factEnvelope: PERFORMANCE_FACT_ENVELOPE_SCHEMA_MANIFEST,
  event: PERFORMANCE_EVENT_SCHEMA_MANIFEST,
});

export const PERFORMANCE_SCHEMA_MANIFESTS_ALL = PERFORMANCE_SCHEMA_MANIFESTS;
