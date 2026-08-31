import {
  assertConcreteArray,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  encodeCanonicalBytes,
  hashDomain,
  readOwnEnumerableDataProperty,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";

const NON_OBSERVED_KEYS = Object.freeze([
  "kind",
  "status",
  "reason",
  "finalDurableWindowId",
  "windowSelectionRoot",
  "selectionPolicyDigest",
  "eligibleSuccessCount",
  "eligibleSuccessRoot",
  "selectedIndex",
  "selectedProducerTerminalId",
  "observedArtifacts",
] as const);

const MISSING_REASONS = new Set([
  "no-successful-dry-run",
  "terminal-binding-missing",
  "joined-process-evidence-missing",
]);

const INVALID_REASONS = new Set([
  "window-selection-capability-invalid",
  "terminal-capability-invalid",
  "terminal-artifact-capability-invalid",
  "process-capability-invalid",
  "terminal-process-binding-mismatch",
]);

export interface ProductionSixStepNonObservedPayloadV1 {
  readonly kind: "aloha.production-six-step-observation-missing-v1" | "aloha.production-six-step-observation-invalid-v1";
  readonly status: "missing" | "invalid";
  readonly reason: string;
  readonly finalDurableWindowId: Hash | null;
  readonly windowSelectionRoot: Hash | null;
  readonly selectionPolicyDigest: Hash | null;
  readonly eligibleSuccessCount: string | null;
  readonly eligibleSuccessRoot: Hash | null;
  readonly selectedIndex: "0" | null;
  readonly selectedProducerTerminalId: Hash | null;
  readonly observedArtifacts: readonly unknown[];
}

/** Hashes the exact missing/invalid observation payload.  `observationRoot`
 * is intentionally not an accepted field, so the identity cannot consume or
 * recursively authenticate a caller-supplied root. */
export function productionSixStepNonObservedRootV1(payload: ProductionSixStepNonObservedPayloadV1): Hash {
  assertExactKeys(payload, NON_OBSERVED_KEYS, "sixStepNonObserved");
  const read = (key: typeof NON_OBSERVED_KEYS[number]): unknown =>
    readOwnEnumerableDataProperty(payload, key, "sixStepNonObserved");
  const kind = read("kind");
  const status = read("status");
  const reason = assertNonEmptyString(read("reason"), "sixStepNonObserved.reason");
  if ((kind === "aloha.production-six-step-observation-missing-v1" && status === "missing" && MISSING_REASONS.has(reason))
    || (kind === "aloha.production-six-step-observation-invalid-v1" && status === "invalid" && INVALID_REASONS.has(reason))) {
    // Coherent non-observed variant.
  } else {
    throw new TypeError("Six-Step non-observed kind/status/reason mismatch");
  }
  const nullableHash = (key: "finalDurableWindowId" | "windowSelectionRoot" | "selectionPolicyDigest" | "eligibleSuccessRoot" | "selectedProducerTerminalId"): Hash | null => {
    const value = read(key);
    return value === null ? null : assertHash(value, `sixStepNonObserved.${key}`);
  };
  const count = read("eligibleSuccessCount");
  if (count !== null) assertDecimalString(count, "sixStepNonObserved.eligibleSuccessCount");
  const selectedIndex = read("selectedIndex");
  if (selectedIndex !== null && selectedIndex !== "0") throw new TypeError("Six-Step non-observed selectedIndex is invalid");
  const observedArtifacts = read("observedArtifacts");
  assertConcreteArray(observedArtifacts, "sixStepNonObserved.observedArtifacts");
  encodeCanonicalBytes(observedArtifacts);
  if (observedArtifacts.length !== 0) throw new TypeError("Six-Step non-observed result cannot contain observed artifacts");
  return hashDomain("aloha/production-six-step-observation/v1", {
    kind,
    status,
    reason,
    finalDurableWindowId: nullableHash("finalDurableWindowId"),
    windowSelectionRoot: nullableHash("windowSelectionRoot"),
    selectionPolicyDigest: nullableHash("selectionPolicyDigest"),
    eligibleSuccessCount: count,
    eligibleSuccessRoot: nullableHash("eligibleSuccessRoot"),
    selectedIndex,
    selectedProducerTerminalId: nullableHash("selectedProducerTerminalId"),
    observedArtifacts: [],
  } as CanonicalJson);
}

export function productionSixStepObservedRootV1<Payload extends Readonly<{
  readonly stageArtifacts: readonly Readonly<{ readonly artifactSetRoot: Hash }>[];
  readonly observedArtifacts: readonly Readonly<{
    readonly role: string;
    readonly artifact: Readonly<{
      readonly ref: Readonly<{ readonly artifactRefId: Hash }>;
      readonly contentSha256: Hash;
      readonly claim: Readonly<{ readonly claimId: Hash }>;
      readonly lease: Readonly<{ readonly receiptId: Hash }>;
    }>;
  }>[];
}>>(payload: Payload): Hash {
  const { stageArtifacts, observedArtifacts, ...identity } = payload;
  return hashDomain("aloha/production-six-step-observation/v1", {
    ...identity,
    observedArtifacts: observedArtifacts.map(value => ({
      role: value.role,
      artifactRefId: assertHash(value.artifact.ref.artifactRefId, "sixStepObserved.artifactRefId"),
      contentSha256: assertHash(value.artifact.contentSha256, "sixStepObserved.contentSha256"),
      claimId: assertHash(value.artifact.claim.claimId, "sixStepObserved.claimId"),
      leaseReceiptId: assertHash(value.artifact.lease.receiptId, "sixStepObserved.leaseReceiptId"),
    })),
    stageArtifactSetRoots: stageArtifacts.map((value, index) =>
      assertHash(value.artifactSetRoot, `sixStepObserved.stageArtifacts[${index}].artifactSetRoot`)),
  } as CanonicalJson);
}
