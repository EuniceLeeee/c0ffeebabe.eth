import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createAcquisitionProcessObservation,
  createStoreEpochObservation,
  createTargetProcessObservation,
  createUnsignedSignedObserverInvocationSnapshot,
  sealSignedObserverInvocationSnapshot,
  type AcquisitionProcessObservationEnvelopeV1,
  type ObserverInvocationBindingV1,
  type SignedObserverInvocationSnapshotV1,
  type StoreEpochObservationEnvelopeV1,
  type TargetProcessObservationEnvelopeV1,
} from "../../../specs/qualified-facts/src/index.ts";
import {
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_MUTATION_IDS,
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_STORE_EPOCH_MUTATION_IDS,
  ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_TARGET_PROCESS_MUTATION_IDS,
  ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE,
} from "./spec.ts";
import {
  evaluateInvocationOracle,
  evaluateSidecarOracle,
  type InvocationBindingOracleFacts,
  type InvocationOracleContext,
  type RoleOracleResult,
  type SidecarOracleContext,
} from "./role-reference-model.ts";

export type ArtifactLineageRoleId =
  | "artifact-lineage-raw-observer"
  | "acquisition-observer-process"
  | "target-production-process"
  | "store-epoch-observation"
  | "aloha.artifact-lineage.facts.signed-invocation-seal";

export interface RoleQualificationCase {
  readonly roleId: ArtifactLineageRoleId;
  readonly caseId: string;
  readonly mutationId: string | null;
  readonly classification: "positive" | "negative" | "invalid";
  readonly input: unknown;
}

export interface RoleQualificationCaseResult {
  readonly roleId: ArtifactLineageRoleId;
  readonly caseId: string;
  readonly mutationId: string | null;
  readonly classification: RoleQualificationCase["classification"];
  readonly oracle: RoleOracleResult;
  readonly expectedVerdict: "pass" | "fail" | "invalid";
  readonly classificationMatchesOracle: boolean;
  readonly oracleCaseDigest: Hash;
  readonly caseDigest: Hash;
}

export interface RoleQualificationCaseRoots {
  readonly roleId: ArtifactLineageRoleId;
  readonly caseSetRoot: Hash;
  readonly positiveCaseRoot: Hash;
  readonly negativeCaseRoot: Hash;
  readonly invalidCaseRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: string;
}

export interface RoleQualificationMaterial {
  readonly roleId: ArtifactLineageRoleId;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly cases: readonly RoleQualificationCase[];
  readonly caseResults: readonly RoleQualificationCaseResult[];
  readonly roots: RoleQualificationCaseRoots;
  readonly actuallyExecutedRejectedOrInvalidMutationIds: readonly string[];
  readonly authority: false;
}

export interface InvocationQualificationFixture {
  readonly snapshot: SignedObserverInvocationSnapshotV1;
  readonly context: InvocationOracleContext;
}

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const ZERO_HASH = h("0");
const ROLE_CASE_DOMAIN = "aloha/artifact-lineage/role-independent-oracle-case/v1";
const ROLE_ROOT_DOMAIN = "aloha/artifact-lineage/role-independent-oracle-root/v1";
const ROLE_CASE_SET_DOMAIN = "aloha/artifact-lineage/role-case-set/v1";

function expectedVerdict(classification: RoleQualificationCase["classification"]): RoleQualificationCaseResult["expectedVerdict"] {
  return classification === "positive" ? "pass" : classification === "negative" ? "fail" : "invalid";
}

function caseFingerprint(input: unknown): unknown {
  try {
    return encodeCanonicalJson(input);
  } catch {
    return String(input);
  }
}

function resultDigest(caseMaterial: RoleQualificationCase, oracle: RoleOracleResult): Hash {
  return hashDomain(ROLE_CASE_DOMAIN, {
    roleId: caseMaterial.roleId,
    caseId: caseMaterial.caseId,
    mutationId: caseMaterial.mutationId,
    classification: caseMaterial.classification,
    input: caseFingerprint(caseMaterial.input),
    oracle: { verdict: oracle.verdict, reasons: oracle.reasons },
  });
}

function rootFor(roleId: ArtifactLineageRoleId, results: readonly RoleQualificationCaseResult[], field: "caseDigest" | "oracleCaseDigest"): Hash {
  return hashDomain(ROLE_ROOT_DOMAIN, {
    roleId,
    digests: results.map((result) => result[field]).sort(),
  });
}

function evaluateRoleCases(
  roleId: ArtifactLineageRoleId,
  cases: readonly RoleQualificationCase[],
  evaluate: (input: unknown) => RoleOracleResult,
  mutationIds: readonly string[],
): RoleQualificationMaterial {
  const seenCaseIds = new Set<string>();
  const seenMutationIds = new Set<string>();
  for (const entry of cases) {
    if (entry.roleId !== roleId || entry.caseId.length === 0 || seenCaseIds.has(entry.caseId)) throw new TypeError(`duplicate role qualification case ${entry.caseId}`);
    seenCaseIds.add(entry.caseId);
    if (entry.mutationId !== null) {
      if (!mutationIds.includes(entry.mutationId) || seenMutationIds.has(entry.mutationId)) throw new TypeError(`duplicate or unknown role mutation ${entry.mutationId}`);
      seenMutationIds.add(entry.mutationId);
    }
  }
  for (const mutationId of mutationIds) if (!seenMutationIds.has(mutationId)) throw new TypeError(`missing role mutation ${mutationId}`);
  const results = cases.map((entry) => {
    const oracle = evaluate(entry.input);
    const expected = expectedVerdict(entry.classification);
    const oracleCaseDigest = resultDigest(entry, oracle);
    return Object.freeze({
      roleId,
      caseId: entry.caseId,
      mutationId: entry.mutationId,
      classification: entry.classification,
      oracle,
      expectedVerdict: expected,
      classificationMatchesOracle: oracle.verdict === expected,
      oracleCaseDigest,
      caseDigest: hashDomain(ROLE_CASE_SET_DOMAIN, { oracleCaseDigest, expectedVerdict: expected, classificationMatchesOracle: oracle.verdict === expected }),
    });
  }).sort((left, right) => left.caseId.localeCompare(right.caseId));
  const actual = [...new Set(results.filter((result) => result.mutationId !== null && result.oracle.verdict !== "pass").map((result) => result.mutationId!))].sort();
  if (encodeCanonicalJson(actual) !== encodeCanonicalJson([...mutationIds].sort())) throw new TypeError(`role ${roleId} did not reject every declared mutation`);
  const roots: RoleQualificationCaseRoots = Object.freeze({
    roleId,
    caseSetRoot: rootFor(roleId, results, "caseDigest"),
    positiveCaseRoot: rootFor(roleId, results.filter((result) => result.oracle.verdict === "pass"), "oracleCaseDigest"),
    negativeCaseRoot: rootFor(roleId, results.filter((result) => result.oracle.verdict === "fail"), "oracleCaseDigest"),
    invalidCaseRoot: rootFor(roleId, results.filter((result) => result.oracle.verdict === "invalid"), "oracleCaseDigest"),
    independentOracleCaseRoot: rootFor(roleId, results, "oracleCaseDigest"),
    independentOracleCaseCount: String(results.length),
  });
  return Object.freeze({
    roleId,
    predicateProgramDescriptorDigest: hashDomain("aloha/artifact-lineage/role-predicate-program-descriptor/v1", { roleId, contract: "typed-sidecar-or-signed-invocation-join" }),
    oracleProgramDescriptorDigest: hashDomain("aloha/artifact-lineage/role-independent-oracle-program-descriptor/v1", { roleId, implementation: "clean-room-wire-recompute" }),
    cases: Object.freeze([...cases]),
    caseResults: Object.freeze(results),
    roots,
    actuallyExecutedRejectedOrInvalidMutationIds: Object.freeze(actual),
    authority: false,
  });
}

function sidecarContext(
  role: typeof ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  kind: SidecarOracleContext["metadata"]["kind"],
  canonicalFacts: Readonly<Record<string, unknown>>,
): SidecarOracleContext {
  const metadata = {
    kind,
    roleId: role.roleId,
    observationSchema: role.observationSchema,
    observerImplementationDigest: h("1"),
    observerQualificationId: h("2"),
    qualificationRegistryRoot: h("3"),
    anchorPolicyDigest: role.anchorPolicyDigest,
  } as const;
  return { metadata, expectedCanonicalFacts: canonicalFacts, expectedObservationIds: [], sidecars: [] };
}

function makeSidecar(
  role: typeof ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  kind: SidecarOracleContext["metadata"]["kind"],
  canonicalFacts: Readonly<Record<string, unknown>>,
): AcquisitionProcessObservationEnvelopeV1 | TargetProcessObservationEnvelopeV1 | StoreEpochObservationEnvelopeV1 {
  const common = {
    schemaVersion: 1 as const,
    kind,
    observationSchema: role.observationSchema,
    observerImplementationDigest: h("1"),
    observerQualificationId: h("2"),
    qualificationRegistryRoot: h("3"),
    anchorPolicyDigest: role.anchorPolicyDigest,
    roleId: role.roleId,
    canonicalFacts,
  };
  if (kind === "aloha.acquisition-process-observation") return createAcquisitionProcessObservation(common as never);
  if (kind === "aloha.target-process-observation") return createTargetProcessObservation(common as never);
  return createStoreEpochObservation(common as never);
}

function rebuildSidecarUnchecked(
  base: AcquisitionProcessObservationEnvelopeV1 | TargetProcessObservationEnvelopeV1 | StoreEpochObservationEnvelopeV1,
  patch: Record<string, unknown>,
  recompute = true,
): Record<string, unknown> {
  const value = { ...base, ...patch } as Record<string, unknown>;
  if (!recompute) return value;
  const facts = value.canonicalFacts as Record<string, unknown>;
  value.canonicalFactsHash = hashDomain("aloha/qualified-observation/canonical-facts/v1", facts);
  delete value.observationId;
  delete value.payloadHash;
  const payloadHash = hashDomain(`${value.kind as string}/payload/v1`, value);
  value.payloadHash = payloadHash;
  value.observationId = hashDomain(`${value.kind as string}/id/v1`, payloadHash);
  return value;
}

function sidecarCases(
  role: typeof ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE | typeof ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  kind: SidecarOracleContext["metadata"]["kind"],
  mutationIds: readonly string[],
  facts: Readonly<Record<string, unknown>>,
): RoleQualificationMaterial {
  const base = makeSidecar(role, kind, facts);
  const baseContext = sidecarContext(role, kind, facts);
  const contextFor = (sidecars: readonly unknown[], overrides: Partial<SidecarOracleContext> = {}): SidecarOracleContext => ({
    ...baseContext,
    expectedObservationIds: sidecars.length === 1 && typeof sidecars[0] === "object" && sidecars[0] !== null && "observationId" in sidecars[0]
      ? [(sidecars[0] as { readonly observationId: Hash }).observationId]
      : [base.observationId],
    sidecars,
    ...overrides,
  });
  const cases: RoleQualificationCase[] = [
    { roleId: role.roleId as ArtifactLineageRoleId, caseId: `${role.roleId}-positive`, mutationId: null, classification: "positive", input: contextFor([base]) },
  ];
  const add = (mutationId: string, classification: RoleQualificationCase["classification"], input: SidecarOracleContext) => cases.push({ roleId: role.roleId as ArtifactLineageRoleId, caseId: `${role.roleId}-${mutationId}`, mutationId, classification, input });
  const semanticFacts = (patch: Record<string, unknown>) => ({ ...facts, ...patch });
  const anchorMutation = () => contextFor([rebuildSidecarUnchecked(base, { canonicalFacts: semanticFacts({ processAnchorHash: h("f") }) })]);
  const rangeMutation = () => contextFor([rebuildSidecarUnchecked(base, { canonicalFacts: semanticFacts({ logRangeArtifactRefId: h("e") }) })]);
  const hashMutation = () => contextFor([rebuildSidecarUnchecked(base, { canonicalFactsHash: h("f") }, false)]);
  const idMutation = () => contextFor([rebuildSidecarUnchecked(base, { observationId: h("f") }, false)]);
  const implementationMutation = () => contextFor([rebuildSidecarUnchecked(base, { observerImplementationDigest: h("f") })]);
  const roleMutation = () => contextFor([rebuildSidecarUnchecked(base, { roleId: role.roleId === "acquisition-observer-process" ? "target-production-process" : "acquisition-observer-process" })]);
  const certificateMutation = () => contextFor([rebuildSidecarUnchecked(base, { observerQualificationId: h("f") })]);
  if (role.roleId === "acquisition-observer-process") {
    add(mutationIds[0]!, "negative", anchorMutation());
    add(mutationIds[1]!, "negative", rangeMutation());
    add(mutationIds[2]!, "invalid", contextFor([base, base]));
    add(mutationIds[3]!, "invalid", hashMutation());
    add(mutationIds[4]!, "invalid", idMutation());
    add(mutationIds[5]!, "invalid", implementationMutation());
    add(mutationIds[6]!, "invalid", roleMutation());
    add(mutationIds[7]!, "invalid", certificateMutation());
  } else if (role.roleId === "target-production-process") {
    add(mutationIds[0]!, "invalid", contextFor([base, base]));
    add(mutationIds[1]!, "invalid", hashMutation());
    add(mutationIds[2]!, "invalid", idMutation());
    add(mutationIds[3]!, "invalid", implementationMutation());
    add(mutationIds[4]!, "invalid", roleMutation());
    add(mutationIds[5]!, "invalid", certificateMutation());
    add(mutationIds[6]!, "negative", anchorMutation());
    add(mutationIds[7]!, "negative", rangeMutation());
  } else {
    add(mutationIds[0]!, "invalid", contextFor([base, base]));
    add(mutationIds[1]!, "invalid", hashMutation());
    add(mutationIds[2]!, "invalid", idMutation());
    add(mutationIds[3]!, "invalid", implementationMutation());
    add(mutationIds[4]!, "invalid", roleMutation());
    add(mutationIds[5]!, "invalid", certificateMutation());
    add(mutationIds[6]!, "negative", contextFor([rebuildSidecarUnchecked(base, { canonicalFacts: semanticFacts({ currentStoreEpoch: "12" }) })]));
    add(mutationIds[7]!, "negative", contextFor([rebuildSidecarUnchecked(base, { canonicalFacts: semanticFacts({ storeIdentityHash: h("f") }) })]));
    add(mutationIds[8]!, "negative", contextFor([rebuildSidecarUnchecked(base, { canonicalFacts: semanticFacts({ rawArtifactRefId: h("e") }) })]));
  }
  return evaluateRoleCases(role.roleId as ArtifactLineageRoleId, cases, (input) => evaluateSidecarOracle(input as SidecarOracleContext), mutationIds);
}

const INVOCATION_PUBLIC_KEY_HEX = "0x35ad603563afcc844093909898ad33dc87e207780947b25811bd648dd6c3e75e";
const INVOCATION_CORPUS_SIGNATURES = Object.freeze({
  base: "0x351e24b8983edb9fe67f8f175078b3db8bae518b9336052cb57a8dd6612a3f78c7c9ea68d86f1ada9573d0f354da97af83c571298dcd598d37679b6fc2e6c40f",
  audience: "0x3c5cc3c66c018bcc14092e8e882877481d7fa0f0a2b3156b489f13ec6728fc54d247e979ff9b068e1803c22155985c4309f99711826795720b169802206b8701",
  ordinaryRole: "0x8c37968361c740a468853a3401455851a8f610d8f6b780979ed756648a8e3f5595ddc0f638fcc61aa2686aa4356c7e93fafcdb2bab06b596f840cdf701b61306",
  query: "0x115ff9462acac24dbb102e4267a8ed69980ee8900fac9bfd6c8ea527f4542c6fe219510ef2999426e0232556ca9d44ae62b669ebc997cfc5f684da367ac96d02",
  snapshot: "0xd4e92c9b582d49e581b11952ecd52a2934e140850fb3e0210a36207c2d32d267f24cb612d8f7798c3f06f08f3b1062547426a17168e61105e71347e756f8060a",
});

function invocationBinding(
  kind: "semantic-artifact" | "production-receipt",
  objectId: Hash,
  rawArtifactRefId: Hash,
  byte: string,
  mediaType: string,
  schema: { readonly id: string; readonly version: string; readonly schemaHash: Hash },
  receiptRawArtifactRefIds?: readonly Hash[],
): InvocationBindingOracleFacts {
  const bytes = new TextEncoder().encode(byte);
  return {
    kind,
    objectId,
    rawArtifactRefId,
    canonicalBytesSha256: sha256Hex(bytes),
    byteLength: String(bytes.byteLength),
    mediaType,
    schema,
    receiptRawArtifactRefIds,
  };
}

function bindingWire(binding: InvocationBindingOracleFacts): ObserverInvocationBindingV1 {
  return {
    kind: binding.kind,
    objectId: binding.objectId,
    rawArtifactRefId: binding.rawArtifactRefId,
    canonicalBytesSha256: binding.canonicalBytesSha256,
    byteLength: binding.byteLength,
  };
}

function makeInvocationFixture(): InvocationQualificationFixture {
  const semanticSchema = { id: "aloha.semantic-artifact", version: "1.0.0", schemaHash: h("a") };
  const receiptSchema = { id: "aloha.production-receipt", version: "1.0.0", schemaHash: h("b") };
  const semanticBindings = [
    invocationBinding("semantic-artifact", h("1"), h("5"), "semantic-a", "application/json", semanticSchema),
    invocationBinding("semantic-artifact", h("2"), h("6"), "semantic-b", "application/json", semanticSchema),
  ];
  const productionBindings = [
    invocationBinding("production-receipt", h("3"), h("7"), "receipt-a", "application/json", receiptSchema, [h("9"), h("a")]),
    invocationBinding("production-receipt", h("4"), h("8"), "receipt-b", "application/json", receiptSchema, [h("b"), h("c")]),
  ];
  const roleId = ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId;
  const context: InvocationOracleContext = {
    roleId,
    observationSchema: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.observationSchema,
    observerQualificationId: h("1"),
    observerImplementationDigest: h("2"),
    registryRoot: h("3"),
    registryEpoch: "7",
    keyId: h("4"),
    publicKeyHex: INVOCATION_PUBLIC_KEY_HEX,
    audienceHash: h("5"),
    acceptanceQueryId: h("6"),
    qualifiedFactSnapshotId: h("7"),
    nowUnixNs: "500",
    maxInvocationTtlUnixNs: "1000",
    expectedIssuedAtUnixNs: "100",
    expectedExpiresAtUnixNs: "900",
    expectedSemanticArtifactBindings: semanticBindings,
    expectedProductionReceiptBindings: productionBindings,
    subjectInputArtifactRefIds: [h("d")],
    keyEpochValid: true,
    observerLocatorCapable: true,
  };
  const unsigned = createUnsignedSignedObserverInvocationSnapshot({
    schemaVersion: 1,
    kind: "aloha.signed-observer-invocation-snapshot",
    registryRoot: context.registryRoot,
    registryEpoch: context.registryEpoch,
    observerQualificationId: context.observerQualificationId,
    roleId,
    keyId: context.keyId,
    audienceHash: context.audienceHash,
    invocationNonce: h("8"),
    issuedAtUnixNs: context.expectedIssuedAtUnixNs,
    expiresAtUnixNs: context.expectedExpiresAtUnixNs,
    acceptanceQueryId: context.acceptanceQueryId,
    qualifiedFactSnapshotId: context.qualifiedFactSnapshotId,
    semanticArtifactBindings: semanticBindings.map(bindingWire),
    productionReceiptBindings: productionBindings.map(bindingWire),
    signatureAlgorithm: "ed25519",
  });
  return {
    snapshot: sealSignedObserverInvocationSnapshot(unsigned, INVOCATION_CORPUS_SIGNATURES.base),
    context,
  };
}

function invocationUncheckedPatch(
  base: SignedObserverInvocationSnapshotV1,
  patch: Record<string, unknown>,
): SignedObserverInvocationSnapshotV1 {
  const value = { ...base, ...patch } as Record<string, unknown>;
  return value as SignedObserverInvocationSnapshotV1;
}

function invocationReseal(
  base: SignedObserverInvocationSnapshotV1,
  patch: Record<string, unknown>,
  signature: string,
): SignedObserverInvocationSnapshotV1 {
  const value = { ...base, ...patch } as SignedObserverInvocationSnapshotV1;
  const unsigned = createUnsignedSignedObserverInvocationSnapshot({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    registryRoot: value.registryRoot,
    registryEpoch: value.registryEpoch,
    observerQualificationId: value.observerQualificationId,
    roleId: value.roleId,
    keyId: value.keyId,
    audienceHash: value.audienceHash,
    invocationNonce: value.invocationNonce,
    issuedAtUnixNs: value.issuedAtUnixNs,
    expiresAtUnixNs: value.expiresAtUnixNs,
    acceptanceQueryId: value.acceptanceQueryId,
    qualifiedFactSnapshotId: value.qualifiedFactSnapshotId,
    semanticArtifactBindings: value.semanticArtifactBindings,
    productionReceiptBindings: value.productionReceiptBindings,
    signatureAlgorithm: value.signatureAlgorithm,
  });
  return sealSignedObserverInvocationSnapshot(unsigned, signature);
}

function invocationCases(): RoleQualificationMaterial {
  const fixture = makeInvocationFixture();
  const roleId = ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId as ArtifactLineageRoleId;
  const base = fixture.snapshot;
  const context = fixture.context;
  const cases: RoleQualificationCase[] = [
    { roleId, caseId: "invocation-seal-positive", mutationId: null, classification: "positive", input: { snapshot: base, context } },
  ];
  const add = (mutationId: string, classification: RoleQualificationCase["classification"], snapshot: SignedObserverInvocationSnapshotV1 = base, contextPatch: Partial<InvocationOracleContext> = {}) => cases.push({ roleId, caseId: `invocation-seal-${mutationId}`, mutationId, classification, input: { snapshot, context: { ...context, ...contextPatch } } });
  add("invocation-binding-duplicate", invocationCasesInvalidClassification(), invocationUncheckedPatch(base, { semanticArtifactBindings: [base.semanticArtifactBindings[0]!, base.semanticArtifactBindings[0]!] }));
  add("invocation-binding-extra", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [...base.semanticArtifactBindings, base.semanticArtifactBindings[0]!] }));
  const forgedObserved = context.expectedSemanticArtifactBindings.map((binding, index) => index === 0 ? { ...binding, canonicalBytesSha256: h("f") } : binding);
  add("invocation-binding-forged-object", "negative", base, { observedSemanticArtifactBindings: forgedObserved });
  add("invocation-binding-hash", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [{ ...base.semanticArtifactBindings[0]!, canonicalBytesSha256: h("f") }, base.semanticArtifactBindings[1]!] }));
  add("invocation-binding-length", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [{ ...base.semanticArtifactBindings[0]!, byteLength: "99" }, base.semanticArtifactBindings[1]!] }));
  add("invocation-binding-mirror-hash", "negative", base, { observedSemanticArtifactBindings: context.expectedSemanticArtifactBindings.map((binding, index) => index === 0 ? { ...binding, canonicalBytesSha256: h("e") } : binding) });
  add("invocation-binding-mirror-media", "negative", base, { observedSemanticArtifactBindings: context.expectedSemanticArtifactBindings.map((binding, index) => index === 0 ? { ...binding, mediaType: "text/plain" } : binding) });
  add("invocation-binding-mirror-schema", "negative", base, { observedSemanticArtifactBindings: context.expectedSemanticArtifactBindings.map((binding, index) => index === 0 ? { ...binding, schema: { ...binding.schema, schemaHash: h("f") } } : binding) });
  add("invocation-binding-object-id", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [{ ...base.semanticArtifactBindings[0]!, objectId: h("f") }, base.semanticArtifactBindings[1]!] }));
  add("invocation-binding-raw-ref", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [{ ...base.semanticArtifactBindings[0]!, rawArtifactRefId: h("f") }, base.semanticArtifactBindings[1]!] }));
  add("invocation-binding-raw-partition-overlap", "invalid", base, { observedProductionReceiptBindings: context.expectedProductionReceiptBindings.map((binding, index) => index === 0 ? { ...binding, receiptRawArtifactRefIds: [base.semanticArtifactBindings[0]!.rawArtifactRefId, h("a")] } : binding) });
  add("invocation-binding-receipt-boundary-overlap", "invalid", base, { observedProductionReceiptBindings: context.expectedProductionReceiptBindings.map((binding, index) => index === 0 ? { ...binding, receiptRawArtifactRefIds: [base.productionReceiptBindings[0]!.rawArtifactRefId, h("a")] } : binding) });
  add("invocation-binding-reorder", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [...base.semanticArtifactBindings].reverse() }));
  // Deliberately reference the later binding: a one-pass accumulator that
  // only knows earlier bindings would miss this overlap.
  add("invocation-binding-subject-input-overlap", "invalid", base, { subjectInputArtifactRefIds: [base.semanticArtifactBindings[1]!.rawArtifactRefId] });
  add("invocation-binding-subset", "invalid", invocationUncheckedPatch(base, { semanticArtifactBindings: [base.semanticArtifactBindings[0]!] }));
  add("invocation-binding-unsigned-derived-object", "negative", base, { observedSemanticArtifactBindings: context.expectedSemanticArtifactBindings.map((binding, index) => index === 0 ? { ...binding, objectId: h("f") } : binding) });
  add("invocation-expiry-boundary", "invalid", base, { nowUnixNs: context.expectedExpiresAtUnixNs });
  add("invocation-key-audience", "invalid", invocationReseal(base, { audienceHash: h("f") }, INVOCATION_CORPUS_SIGNATURES.audience));
  add("invocation-key-expired", "invalid", base, { keyEpochValid: false });
  add("invocation-key-locator-capability", "invalid", base, { observerLocatorCapable: false });
  add("invocation-key-revoked", "invalid", base, { revoked: true });
  add("invocation-key-role", "invalid", invocationReseal(base, { roleId: "artifact-lineage-raw-observer" }, INVOCATION_CORPUS_SIGNATURES.ordinaryRole));
  add("invocation-key-unregistered", "invalid", invocationUncheckedPatch(base, { keyId: h("f") }));
  add("invocation-ordinary-observer-role", "invalid", invocationReseal(base, { roleId: "artifact-lineage-raw-observer" }, INVOCATION_CORPUS_SIGNATURES.ordinaryRole));
  add("invocation-query", "invalid", invocationReseal(base, { acceptanceQueryId: h("f") }, INVOCATION_CORPUS_SIGNATURES.query));
  add("invocation-signature-byte", "invalid", invocationUncheckedPatch(base, { signatureHex: "0x22" }));
  add("invocation-signature-missing", "invalid", invocationReseal(base, {}, `0x${"00".repeat(64)}`));
  add("invocation-signature-payload", "invalid", invocationUncheckedPatch(base, { audienceHash: h("f") }));
  add("invocation-signature-random", "invalid", invocationReseal(base, {}, `0x${"11".repeat(64)}`));
  add("invocation-snapshot", "invalid", invocationReseal(base, { qualifiedFactSnapshotId: h("f") }, INVOCATION_CORPUS_SIGNATURES.snapshot));
  return evaluateRoleCases(roleId, cases, (input) => {
    const value = input as { readonly snapshot: unknown; readonly context: InvocationOracleContext };
    return evaluateInvocationOracle(value.snapshot, value.context);
  }, ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS);
}

function invocationCasesInvalidClassification(): "invalid" {
  return "invalid";
}

const ACQUISITION_FACTS = Object.freeze({
  receiptId: h("4"),
  processAnchorHash: h("5"),
  logRangeArtifactRefId: h("6"),
  rawBoundaryArtifactRefId: h("7"),
});
const TARGET_FACTS = Object.freeze({
  receiptId: h("8"),
  processAnchorHash: h("9"),
  logRangeArtifactRefId: h("a"),
  rawBoundaryArtifactRefId: h("b"),
});
const STORE_FACTS = Object.freeze({
  storeIdentityHash: h("c"),
  currentStoreEpoch: "11",
  rawArtifactRefId: h("d"),
});

export const ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION = sidecarCases(
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE,
  "aloha.acquisition-process-observation",
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_MUTATION_IDS,
  ACQUISITION_FACTS,
);
export const ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION = sidecarCases(
  ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE,
  "aloha.target-process-observation",
  ARTIFACT_LINEAGE_TARGET_PROCESS_MUTATION_IDS,
  TARGET_FACTS,
);
export const ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION = sidecarCases(
  ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  "aloha.store-epoch-observation",
  ARTIFACT_LINEAGE_STORE_EPOCH_MUTATION_IDS,
  STORE_FACTS,
);
export const ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION = invocationCases();

export const ARTIFACT_LINEAGE_ROLE_QUALIFICATION_MATERIALS = Object.freeze({
  [ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION.roleId]: ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  [ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION.roleId]: ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
  [ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION.roleId]: ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  [ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.roleId]: ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
} as const);

export const ARTIFACT_LINEAGE_ROLE_CASE_ROOTS = Object.freeze({
  acquisitionProcess: ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION.roots,
  targetProcess: ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION.roots,
  storeEpoch: ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION.roots,
  invocationSeal: ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.roots,
});

export const ARTIFACT_LINEAGE_ROLE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS = Object.freeze([...new Set([
  ...ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION.actuallyExecutedRejectedOrInvalidMutationIds,
  ...ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION.actuallyExecutedRejectedOrInvalidMutationIds,
  ...ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION.actuallyExecutedRejectedOrInvalidMutationIds,
  ...ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.actuallyExecutedRejectedOrInvalidMutationIds,
])].sort());

export const ARTIFACT_LINEAGE_SIDE_ROLE_INDEPENDENT_ORACLE_CASE_ROOT = hashDomain(
  "aloha/artifact-lineage/side-role-independent-oracle-root/v1",
  Object.values(ARTIFACT_LINEAGE_ROLE_CASE_ROOTS).map((roots) => roots.independentOracleCaseRoot),
);
