import {
  decodeCanonicalJson,
  decodeExactObject,
  defineSchema,
  defineSchemaManifest,
  deepFreeze,
  encodeCanonicalBytes,
  arraySchema,
  fieldArray,
  hashDomain,
  hashSchema,
  gitSha40Schema,
  literalSchema,
  nonEmptyStringSchema,
  objectSchema,
  type CodecSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeReleaseQualifiedCapabilityRefV1,
  hashReleaseQualifiedCapabilityRefsRoot,
  type ReleaseQualifiedCapabilityRefV1,
} from "../../capability-index/src/index.ts";
import {
  decodeEconomicValuationOwnerQualificationCertificateV1,
  sealEconomicValuationOwnerQualificationCertificateSetV1,
  type EconomicValuationOwnerQualificationCertificateV1,
} from "../../economic-valuation-owner/src/index.ts";
import {
  assertSafetyProfileQualificationMembershipV1,
  decodeEconomicSafetyActionOwnerQualificationCertificateV1,
  decodeSafetyProfileV1,
  sealEconomicSafetyActionOwnerQualificationSetV1,
  type EconomicSafetyActionOwnerQualificationCertificateV1,
  type SafetyProfileV1,
} from "../../economic-safety-profile/src/index.ts";

export type { ReleaseQualifiedCapabilityRefV1 } from "../../capability-index/src/index.ts";
export type { EconomicValuationOwnerQualificationCertificateV1 } from "../../economic-valuation-owner/src/index.ts";
export type {
  EconomicSafetyActionOwnerQualificationCertificateV1,
  SafetyProfileV1,
} from "../../economic-safety-profile/src/index.ts";

/**
 * This package is a wire contract only.  It does not load GateCore,
 * acceptance code, a scheduler, a registry, or a signer.  The deployment
 * resolver verifies the external signature and returns an opaque capability
 * to the candidate runtime.
 */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_COMMIT = "0".repeat(40);

function fixedHexSchema(byteLength: number, kind: string): CodecSchema<string> {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`);
  return defineSchema({ kind, byteLength }, (value, path = "$") => {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new TypeError(`expected lowercase ${byteLength}-byte 0x hex at ${path}`);
    }
    return value;
  });
}

const signatureHexSchema = fixedHexSchema(64, "runtime-release-binding-ed25519-signature");
const packageApprovalSignatureHexSchema = fixedHexSchema(
  64,
  "runtime-release-package-approval-ed25519-signature",
);
const publicKeyHexSchema = fixedHexSchema(32, "runtime-release-binding-ed25519-public-key");

const canonicalAbsolutePathSchema = defineSchema({ kind: "canonical-absolute-path" }, (value, path = "$") => {
  if (typeof value !== "string" || value.length <= 1 || !value.startsWith("/") || value.includes("\0")) {
    throw new TypeError(`expected canonical absolute path at ${path}`);
  }
  const segments = value.slice(1).split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`expected canonical absolute path at ${path}`);
  }
  return value;
});

const runtimeReleaseSignerPinSchema = objectSchema({
  signerKeyId: hashSchema,
  publicKeyHex: publicKeyHexSchema,
});

/** Exact scheduler registry leaf material.  Keep this wire shape and domain
 * shared; runtime release binding must never invent a second executor leaf
 * identity that merely looks like the qualified registry. */
const qualifiedExecutorRegistryEntrySchema = objectSchema({
  executorKind: nonEmptyStringSchema,
  engineBuildFingerprint: hashSchema,
  executableFingerprint: hashSchema,
  closureFingerprint: hashSchema,
  protocolFingerprint: hashSchema,
  schemaFingerprint: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateCommit: gitSha40Schema,
});

const selectedExecutorSchema = qualifiedExecutorRegistryEntrySchema;
const economicValuationOwnerQualificationCertificateSchema = defineSchema(
  { kind: "economic-valuation-owner-qualification-certificate" },
  (value, _path = "$") => decodeEconomicValuationOwnerQualificationCertificateV1(value),
);
const economicSafetyActionOwnerQualificationCertificateSchema = defineSchema(
  { kind: "economic-safety-action-owner-qualification-certificate" },
  (value, _path = "$") => decodeEconomicSafetyActionOwnerQualificationCertificateV1(value),
);
const economicSafetyProfileSchema = defineSchema(
  { kind: "economic-safety-profile" },
  (value, _path = "$") => decodeSafetyProfileV1(value),
);

/** Exact release facts for the searcher process itself.  The selected
 * executor fingerprint above belongs to the REVM worker and must never be
 * reused as the searcher entrypoint or Node executable identity. */
const searcherRuntimeSchema = objectSchema({
  runtimeArtifactRoot: hashSchema,
  implementationClosureDigest: hashSchema,
  nodeExecutableSha256: hashSchema,
  entrypointSha256: hashSchema,
  bundleModulePath: canonicalAbsolutePathSchema,
  bundleModuleSha256: hashSchema,
});

const canonicalDecimalSchema = defineSchema({ kind: "canonical-decimal-string" }, (value, path = "$") => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`expected canonical decimal string at ${path}`);
  }
  return value;
});

/**
 * Externally qualified physical discovery source selected for this runtime
 * release.  `backendEpoch` is an operator-observed backend identity, not a
 * hash of the URL.  This distinction is load-bearing: replacing the Reth
 * process behind an unchanged endpoint must invalidate source continuity.
 *
 * The raw endpoint is deliberately absent from signed/public material.  Its
 * locator hash remains signed so the deployment bundle can be joined exactly,
 * but it is not part of durable source continuity: moving the same qualified
 * backend to another endpoint must not invalidate an otherwise reusable
 * cursor.
 */
const runtimeReleaseDiscoverySourceQualificationFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-release-discovery-source-qualification"),
  providerIdentity: nonEmptyStringSchema,
  backendEpoch: nonEmptyStringSchema,
  profile: literalSchema("reth-json-rpc-v1"),
  chainId: canonicalDecimalSchema,
  endpointLocatorHash: hashSchema,
  sourceConfigRoot: hashSchema,
  qualificationRoot: hashSchema,
} as const;

const runtimeReleaseDiscoverySourceQualificationSchema = objectSchema(
  runtimeReleaseDiscoverySourceQualificationFields,
);

const runtimeReleaseNominationQualificationEntrySchema = objectSchema({
  proposalLeafDigest: hashSchema,
  criticalMutationCorpusRoot: hashSchema,
  independentOracleCaseRoot: hashSchema,
  qualificationSpecDigest: hashSchema,
  verifierQualificationCertificateRoot: hashSchema,
  qualificationLeafDigest: hashSchema,
});

const runtimeReleaseNominationQualificationSetSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-release-nomination-qualification-set"),
  entries: arraySchema(runtimeReleaseNominationQualificationEntrySchema),
  programSetRoot: hashSchema,
  root: hashSchema,
});

/** Narrow worker lease projection.  Runtime workers never receive the full
 * signed release binding or its certificate; the release owner derives this
 * exact projection from a verified binding and stamps a fresh worker epoch. */
const runtimeReleaseExecutorLeaseSchema = objectSchema({
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  executorAuthorityRoot: hashSchema,
  qualifiedExecutorRegistryRoot: hashSchema,
  selectedExecutorLeafHash: hashSchema,
  executorKind: nonEmptyStringSchema,
  engineBuildFingerprint: hashSchema,
  executableFingerprint: hashSchema,
  closureFingerprint: hashSchema,
  protocolFingerprint: hashSchema,
  schemaFingerprint: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  qualificationEpoch: nonEmptyStringSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  frameworkAuthorityRoot: hashSchema,
  releaseAuthorityRoot: hashSchema,
  workerEpoch: nonEmptyStringSchema,
  executorSessionHash: hashSchema,
});

const runtimeReleaseBindingPayloadFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-release-binding"),
  releaseAuthorityApprovalId: hashSchema,
  releaseAuthorityApprovalPayloadHash: hashSchema,
  releaseAcceptanceRequirementSetRoot: hashSchema,
  externalTrustAnchorRoot: hashSchema,
  externalIssuerKeySetRoot: hashSchema,
  qualificationRegistryApprovalId: hashSchema,
  qualificationRegistryRoot: hashSchema,
  qualificationEpoch: nonEmptyStringSchema,
  qualificationAudienceHash: hashSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  searcherRuntime: searcherRuntimeSchema,
  discoverySourceQualification: runtimeReleaseDiscoverySourceQualificationSchema,
  /** Complete externally qualified denominator. Entries are strictly sorted
   * and unique by their neutral leaf hash; the selected executor must be an
   * exact member. */
  qualifiedExecutorRegistry: arraySchema(qualifiedExecutorRegistryEntrySchema),
  qualifiedExecutorRegistryRoot: hashSchema,
  /** Generated valuation-owner runtime composition and independently
   * qualified owner-set roots. Both are release-authority signed facts. */
  valuationOwnerRegistryRoot: hashSchema,
  /** Complete acceptance-issued qualification denominator. Candidate catalog
   * generation cannot mint these certificates; the external release issuer
   * signs the exact ordered set and its root. */
  valuationOwnerQualificationCertificates: arraySchema(economicValuationOwnerQualificationCertificateSchema),
  qualifiedValuationOwnerSetRoot: hashSchema,
  actionOwnerRegistryRoot: hashSchema,
  actionOwnerQualificationCertificates: arraySchema(economicSafetyActionOwnerQualificationCertificateSchema),
  qualifiedActionOwnerSetRoot: hashSchema,
  safetyProfile: economicSafetyProfileSchema,
  safetyProfileRoot: hashSchema,
  /** Exact externally qualified capability set root; never derived in candidate code. */
  qualifiedCapabilityRefsRoot: hashSchema,
  /** Exact generated proposal set; candidate code cannot turn this into a qualification. */
  nominationProgramSetRoot: hashSchema,
  /** Full externally qualified set is signed, not reconstructed by candidate code. */
  nominationQualificationSet: runtimeReleaseNominationQualificationSetSchema,
  nominationQualificationSetRoot: hashSchema,
  selectedExecutorLeafHash: hashSchema,
  selectedExecutor: selectedExecutorSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  workerEpoch: nonEmptyStringSchema,
  executorSessionHash: hashSchema,
  frameworkAuthorityRoot: hashSchema,
  executorAuthorityRoot: hashSchema,
  releaseAuthorityRoot: hashSchema,
  attestationProofIssuerKeyId: hashSchema,
  /** Current key authorized to issue checkpoint candidate-partition proofs. */
  candidatePartitionProofIssuerKeyId: hashSchema,
} as const;

const runtimeReleaseBindingPayloadSchema = objectSchema(runtimeReleaseBindingPayloadFields);

const runtimeReleaseBindingSchema = objectSchema({
  ...runtimeReleaseBindingPayloadFields,
  bindingId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signerKeyId: hashSchema,
  signatureHex: signatureHexSchema,
});

const nominationQualificationDeploymentFactPayloadFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.nomination-qualification-deployment-fact"),
  runtimeBindingId: hashSchema,
  runtimeBindingPayloadHash: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  catalogImpactSnapshotRoot: hashSchema,
  catalogFamilyProposalOwnershipRoot: hashSchema,
  catalogSemanticLedgerHash: hashSchema,
  catalogSemanticOutputRoot: hashSchema,
  catalogBoundaryVerificationReceiptRoot: hashSchema,
  catalogProposedCapabilitySetRoot: hashSchema,
  nominationProgramSetRoot: hashSchema,
  nominationQualificationSetRoot: hashSchema,
} as const;

const nominationQualificationDeploymentFactPayloadSchema = objectSchema(
  nominationQualificationDeploymentFactPayloadFields,
);

const nominationQualificationDeploymentFactSchema = objectSchema({
  ...nominationQualificationDeploymentFactPayloadFields,
  deploymentFactId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signerKeyId: hashSchema,
  signatureHex: signatureHexSchema,
});

const runtimeReleasePackageApprovalPayloadFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-release-package-approval"),
  packageRoot: hashSchema,
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  releaseAcceptanceApprovalId: hashSchema,
  releaseAcceptanceApprovalPayloadHash: hashSchema,
  releaseAcceptanceRequirementSetRoot: hashSchema,
  releaseAcceptanceSetRoot: hashSchema,
  controllerBoundaryEvidenceRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  performanceBasisId: hashSchema,
  performanceProfileHash: hashSchema,
  hardwareProfileRoot: hashSchema,
  providerRoot: hashSchema,
} as const;

const runtimeReleasePackageApprovalPayloadSchema = objectSchema(
  runtimeReleasePackageApprovalPayloadFields,
);

const runtimeReleasePackageApprovalSchema = objectSchema({
  ...runtimeReleasePackageApprovalPayloadFields,
  approvalId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signerKeyId: hashSchema,
  signatureHex: packageApprovalSignatureHexSchema,
});

export type QualifiedExecutorRegistryEntryV1 = Infer<typeof qualifiedExecutorRegistryEntrySchema>;
export type QualifiedExecutorSelectionV1 = QualifiedExecutorRegistryEntryV1;
export type SearcherRuntimeReleaseIdentityV1 = Infer<typeof searcherRuntimeSchema>;
export type RuntimeReleaseDiscoverySourceQualificationV1 = Infer<
  typeof runtimeReleaseDiscoverySourceQualificationSchema
>;
export type RuntimeReleaseNominationQualificationSetV1 = Infer<
  typeof runtimeReleaseNominationQualificationSetSchema
>;
export type RuntimeReleaseNominationQualificationEntryV1 = Infer<
  typeof runtimeReleaseNominationQualificationEntrySchema
>;
export type RuntimeReleaseBindingPayloadV1 = Infer<typeof runtimeReleaseBindingPayloadSchema>;
export type RuntimeReleaseBindingV1 = Infer<typeof runtimeReleaseBindingSchema>;
export type NominationQualificationDeploymentFactPayloadV1 = Infer<
  typeof nominationQualificationDeploymentFactPayloadSchema
>;
export type NominationQualificationDeploymentFactV1 = Infer<
  typeof nominationQualificationDeploymentFactSchema
>;
export type RuntimeReleasePackageApprovalPayloadV1 = Infer<typeof runtimeReleasePackageApprovalPayloadSchema>;
export type RuntimeReleasePackageApprovalV1 = Infer<typeof runtimeReleasePackageApprovalSchema>;
export type RuntimeReleaseSignerPinV1 = Infer<typeof runtimeReleaseSignerPinSchema>;
export type RuntimeReleaseExecutorLeaseV1 = Infer<typeof runtimeReleaseExecutorLeaseSchema>;

export type RuntimeReleaseBindingCodecInput = string | Uint8Array | object;
export type RuntimeReleasePackageApprovalCodecInput = string | Uint8Array | object;

export interface RuntimeReleaseQualifiedCapabilityProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-release-qualified-capability-projection";
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly qualifiedCapabilityRefsRoot: Hash;
  readonly refs: readonly ReleaseQualifiedCapabilityRefV1[];
}

export const RELEASE_AUTHORITY_SCHEMA_MANIFESTS = Object.freeze({
  runtimeReleaseBinding: defineSchemaManifest(
    "aloha.runtime-release-binding",
    "1.0.0",
    defineSchema(
      { kind: "aloha.runtime-release-binding-v1", fields: runtimeReleaseBindingSchema.descriptor },
      (value, path = "$") => checkRuntimeReleaseBinding(runtimeReleaseBindingSchema.decode(value, path), path),
    ),
  ),
  runtimeReleasePackageApproval: defineSchemaManifest(
    "aloha.runtime-release-package-approval",
    "1.0.0",
    defineSchema(
      { kind: "aloha.runtime-release-package-approval-v1", fields: runtimeReleasePackageApprovalSchema.descriptor },
      (value, path = "$") => checkRuntimeReleasePackageApproval(
        runtimeReleasePackageApprovalSchema.decode(value, path),
        path,
      ),
    ),
  ),
  nominationQualificationDeploymentFact: defineSchemaManifest(
    "aloha.nomination-qualification-deployment-fact",
    "1.0.0",
    defineSchema(
      { kind: "aloha.nomination-qualification-deployment-fact-v1", fields: nominationQualificationDeploymentFactSchema.descriptor },
      (value, path = "$") => checkNominationQualificationDeploymentFactV1(
        nominationQualificationDeploymentFactSchema.decode(value, path),
        path,
      ),
    ),
  ),
});

export const RELEASE_AUTHORITY_DOMAINS = Object.freeze({
  payload: "aloha/runtime-release-binding/payload/v1",
  id: "aloha/runtime-release-binding/id/v1",
  signing: "aloha/runtime-release-binding/signing/v1",
  provenance: "aloha/runtime-release-provenance/v1",
  discoverySourceConfig: "aloha/runtime-release-discovery-source-config/v1",
  discoverySourceAuthority: "aloha/runtime-release-discovery-source-authority/v1",
  discoveryEndpointLocator: "aloha/runtime-release-discovery-endpoint-locator/v1",
  nominationProgram: "aloha/family-source-plan-nomination-program/v1",
  nominationProgramSet: "aloha/source-plan-nomination-program-set/v1",
  nominationQualificationLeaf: "aloha/source-plan-nomination-qualification-leaf/v1",
  nominationQualificationSet: "aloha/source-plan-nomination-qualification-set/v1",
  nominationQualificationDeploymentFactPayload: "aloha/nomination-qualification-deployment-fact/payload/v1",
  nominationQualificationDeploymentFactId: "aloha/nomination-qualification-deployment-fact/id/v1",
  nominationQualificationDeploymentFactSigning: "aloha/nomination-qualification-deployment-fact/signing/v1",
  packageApprovalPayload: "aloha/runtime-release-package-approval/payload/v1",
  packageApprovalId: "aloha/runtime-release-package-approval/id/v1",
  packageApprovalSigning: "aloha/runtime-release-package-approval/signing/v1",
});

export function decodeRuntimeReleaseSignerPinV1(value: object): RuntimeReleaseSignerPinV1 {
  const decoded = runtimeReleaseSignerPinSchema.decode(value);
  requireNonZeroHash(decoded.signerKeyId, "runtimeReleaseSignerPin.signerKeyId");
  return deepFreeze(decoded);
}

export function decodeSearcherRuntimeReleaseIdentityV1(value: unknown): SearcherRuntimeReleaseIdentityV1 {
  return searcherRuntimeSchema.decode(value);
}

function normalizedDiscoveryEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("runtime release discovery endpoint must be a URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("runtime release discovery endpoint must use HTTP(S)");
  }
  return endpoint.href;
}

/** Public locator identity for a deployment-private endpoint. */
export function hashRuntimeReleaseDiscoveryEndpointLocatorV1(endpoint: string): Hash {
  return hashDomain(RELEASE_AUTHORITY_DOMAINS.discoveryEndpointLocator, {
    endpoint: normalizedDiscoveryEndpoint(endpoint),
  });
}

function expectedDiscoverySourceConfigRoot(
  value: Pick<RuntimeReleaseDiscoverySourceQualificationV1, "profile" | "chainId">,
): Hash {
  return hashDomain(RELEASE_AUTHORITY_DOMAINS.discoverySourceConfig, {
    profile: value.profile,
    chainId: canonicalDecimalSchema.decode(value.chainId),
  });
}

/**
 * Construct the exact wire qualification before external release signing.
 * `qualificationRoot` is external evidence selected by the packager; this
 * helper only derives the deterministic config root and grants no authority.
 */
export function createRuntimeReleaseDiscoverySourceQualificationV1(input: {
  readonly providerIdentity: string;
  readonly backendEpoch: string;
  readonly profile: "reth-json-rpc-v1";
  readonly chainId: string;
  readonly endpointLocatorHash: Hash;
  readonly qualificationRoot: Hash;
}): RuntimeReleaseDiscoverySourceQualificationV1 {
  const core = {
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-discovery-source-qualification" as const,
    providerIdentity: nonEmptyStringSchema.decode(input.providerIdentity),
    backendEpoch: nonEmptyStringSchema.decode(input.backendEpoch),
    profile: input.profile,
    chainId: canonicalDecimalSchema.decode(input.chainId),
    endpointLocatorHash: hashSchema.decode(input.endpointLocatorHash),
    qualificationRoot: hashSchema.decode(input.qualificationRoot),
  };
  return decodeRuntimeReleaseDiscoverySourceQualificationV1({
    ...core,
    sourceConfigRoot: expectedDiscoverySourceConfigRoot(core),
  });
}

export function decodeRuntimeReleaseDiscoverySourceQualificationV1(
  value: unknown,
): RuntimeReleaseDiscoverySourceQualificationV1 {
  const decoded = runtimeReleaseDiscoverySourceQualificationSchema.decode(value);
  const nonZero: readonly [string, Hash][] = [
    ["endpointLocatorHash", decoded.endpointLocatorHash],
    ["sourceConfigRoot", decoded.sourceConfigRoot],
    ["qualificationRoot", decoded.qualificationRoot],
  ];
  for (const [field, hash] of nonZero) requireNonZeroHash(hash, `runtimeReleaseDiscoverySourceQualification.${field}`);
  if (decoded.sourceConfigRoot !== expectedDiscoverySourceConfigRoot(decoded)) {
    throw new TypeError("runtime release discovery source config root mismatch");
  }
  return deepFreeze(decoded);
}

/** Stable across process/release changes while the qualified backend is unchanged. */
export function runtimeReleaseDiscoverySourceAuthorityRootV1(
  value: RuntimeReleaseDiscoverySourceQualificationV1,
): Hash {
  const decoded = decodeRuntimeReleaseDiscoverySourceQualificationV1(value);
  return hashDomain(RELEASE_AUTHORITY_DOMAINS.discoverySourceAuthority, {
    providerIdentity: decoded.providerIdentity,
    backendEpoch: decoded.backendEpoch,
    profile: decoded.profile,
    chainId: decoded.chainId,
    sourceConfigRoot: decoded.sourceConfigRoot,
    qualificationRoot: decoded.qualificationRoot,
  });
}

export function sealRuntimeReleaseNominationQualificationSetV1(
  entriesValue: readonly Omit<RuntimeReleaseNominationQualificationEntryV1, "qualificationLeafDigest">[],
): RuntimeReleaseNominationQualificationSetV1 {
  const entries = entriesValue.map((entry, index) => {
    const decoded = runtimeReleaseNominationQualificationEntrySchema.decode({
      ...entry,
      qualificationLeafDigest: hashDomain(RELEASE_AUTHORITY_DOMAINS.nominationQualificationLeaf, entry),
    }, `nominationQualificationSet.entries[${index}]`);
    for (const [field, hash] of Object.entries(decoded)) requireNonZeroHash(hash as Hash, `nominationQualificationSet.entries[${index}].${field}`);
    return decoded;
  }).sort((left, right) => left.proposalLeafDigest.localeCompare(right.proposalLeafDigest));
  if (entries.length === 0) throw new TypeError("nomination qualification set is empty");
  if (new Set(entries.map(entry => entry.proposalLeafDigest)).size !== entries.length) throw new TypeError("nomination qualification set contains duplicate proposals");
  const programSetRoot = hashDomain(RELEASE_AUTHORITY_DOMAINS.nominationProgramSet, entries.map(entry => entry.proposalLeafDigest));
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-nomination-qualification-set" as const,
    entries,
    programSetRoot,
    root: hashDomain(RELEASE_AUTHORITY_DOMAINS.nominationQualificationSet, { programSetRoot, entries }),
  });
}

export function decodeRuntimeReleaseNominationQualificationSetV1(
  value: unknown,
): RuntimeReleaseNominationQualificationSetV1 {
  const decoded = runtimeReleaseNominationQualificationSetSchema.decode(value);
  const sealed = sealRuntimeReleaseNominationQualificationSetV1(decoded.entries.map(({ qualificationLeafDigest: _leaf, ...entry }) => entry));
  if (
    decoded.root !== sealed.root
    || decoded.programSetRoot !== sealed.programSetRoot
    || decoded.entries.some((entry, index) => entry.qualificationLeafDigest !== sealed.entries[index]?.qualificationLeafDigest || entry.proposalLeafDigest !== sealed.entries[index]?.proposalLeafDigest)
  ) throw new TypeError("nomination qualification set root/order mismatch");
  return sealed;
}

export function decodeQualifiedExecutorRegistryEntryV1(
  value: RuntimeReleaseBindingCodecInput,
): QualifiedExecutorRegistryEntryV1 {
  return qualifiedExecutorRegistryEntrySchema.decode(parseInput(value));
}

export function decodeRuntimeReleaseExecutorLeaseV1(value: RuntimeReleaseBindingCodecInput): RuntimeReleaseExecutorLeaseV1 {
  return runtimeReleaseExecutorLeaseSchema.decode(parseInput(value));
}

export function hashRuntimeReleaseExecutorLeaseV1(value: RuntimeReleaseExecutorLeaseV1): Hash {
  return hashDomain("aloha/runtime-release-executor-lease/v1", decodeRuntimeReleaseExecutorLeaseV1(value));
}

export function normalizeQualifiedExecutorRegistryEntryV1(
  value: QualifiedExecutorRegistryEntryV1,
): QualifiedExecutorRegistryEntryV1 {
  return qualifiedExecutorRegistryEntrySchema.normalize(value);
}

export function hashQualifiedExecutorRegistryEntry(entry: QualifiedExecutorRegistryEntryV1): Hash {
  return hashDomain("aloha/qualified-executor-registry/v1", decodeQualifiedExecutorRegistryEntryV1(entry));
}

export function hashQualifiedExecutorRegistryRoot(entries: readonly QualifiedExecutorRegistryEntryV1[]): Hash {
  const normalized = entries.map(decodeQualifiedExecutorRegistryEntryV1);
  const leaves = normalized.map(hashQualifiedExecutorRegistryEntry);
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index - 1]! >= leaves[index]!) throw new TypeError("qualified executor registry entries must be strictly sorted and unique by leaf root");
  }
  return hashDomain("aloha/qualified-executor-registry-root/v1", { entries: normalized, leafRoots: leaves });
}

function payloadWithoutIdentity(value: RuntimeReleaseBindingV1): RuntimeReleaseBindingPayloadV1 {
  const {
    bindingId: _bindingId,
    payloadHash: _payloadHash,
    signatureAlgorithm: _signatureAlgorithm,
    signerKeyId: _signerKeyId,
    signatureHex: _signatureHex,
    ...payload
  } = value;
  return runtimeReleaseBindingPayloadSchema.decode(payload);
}

function requireNonZeroHash(value: Hash, path: string): void {
  if (value === ZERO_HASH) throw new TypeError(`hash must be non-zero at ${path}`);
}

function checkRuntimeReleaseBinding(value: RuntimeReleaseBindingV1, path: string): RuntimeReleaseBindingV1 {
  const nominationSet = decodeRuntimeReleaseNominationQualificationSetV1(value.nominationQualificationSet);
  if (
    value.nominationProgramSetRoot !== nominationSet.programSetRoot
    || value.nominationQualificationSetRoot !== nominationSet.root
  ) throw new TypeError(`nomination qualification binding mismatch at ${path}`);
  const selected = value.selectedExecutor;
  const selectedLeaf = hashQualifiedExecutorRegistryEntry(selected);
  const registryLeaves = value.qualifiedExecutorRegistry.map(hashQualifiedExecutorRegistryEntry);
  const registryRoot = hashQualifiedExecutorRegistryRoot(value.qualifiedExecutorRegistry);
  if (value.qualifiedExecutorRegistryRoot !== registryRoot) {
    throw new TypeError(`qualified executor registry root mismatch at ${path}.qualifiedExecutorRegistryRoot`);
  }
  if (value.selectedExecutorLeafHash !== selectedLeaf) {
    throw new TypeError(`selected executor leaf mismatch at ${path}.selectedExecutorLeafHash`);
  }
  if (registryLeaves.filter(leaf => leaf === selectedLeaf).length !== 1) {
    throw new TypeError(`selected executor is not an exact qualified registry member at ${path}.selectedExecutor`);
  }
  const valuationQualificationSet = sealEconomicValuationOwnerQualificationCertificateSetV1(
    value.valuationOwnerQualificationCertificates as readonly EconomicValuationOwnerQualificationCertificateV1[],
  );
  if (value.qualifiedValuationOwnerSetRoot !== valuationQualificationSet.root) {
    throw new TypeError(`qualified valuation-owner set root mismatch at ${path}.qualifiedValuationOwnerSetRoot`);
  }
  const actionOwnerQualificationSet = sealEconomicSafetyActionOwnerQualificationSetV1(
    value.actionOwnerQualificationCertificates as readonly EconomicSafetyActionOwnerQualificationCertificateV1[],
  );
  if (value.qualifiedActionOwnerSetRoot !== actionOwnerQualificationSet.root) {
    throw new TypeError(`qualified action-owner set root mismatch at ${path}.qualifiedActionOwnerSetRoot`);
  }
  const safetyProfile = decodeSafetyProfileV1(value.safetyProfile as SafetyProfileV1);
  if (value.safetyProfileRoot !== safetyProfile.profileCompositionRoot
    || safetyProfile.qualifiedOwnerSetRoot !== value.qualifiedActionOwnerSetRoot) {
    throw new TypeError(`economic safety profile release binding mismatch at ${path}.safetyProfile`);
  }
  assertSafetyProfileQualificationMembershipV1(safetyProfile, actionOwnerQualificationSet.certificates);
  if (
    selected.releaseRoleManifestRoot !== value.releaseRoleManifestRoot
    || selected.candidateCommit !== value.candidateReleaseCommit
  ) throw new TypeError(`selected executor release binding mismatch at ${path}`);
  if (value.candidateReleaseCommit === ZERO_COMMIT) {
    throw new TypeError(`candidate release commit must be non-zero at ${path}.candidateReleaseCommit`);
  }
  const hashFields: readonly [string, Hash][] = [
    ["releaseAuthorityApprovalId", value.releaseAuthorityApprovalId],
    ["releaseAuthorityApprovalPayloadHash", value.releaseAuthorityApprovalPayloadHash],
    ["releaseAcceptanceRequirementSetRoot", value.releaseAcceptanceRequirementSetRoot],
    ["externalTrustAnchorRoot", value.externalTrustAnchorRoot],
    ["externalIssuerKeySetRoot", value.externalIssuerKeySetRoot],
    ["qualificationRegistryApprovalId", value.qualificationRegistryApprovalId],
    ["qualificationRegistryRoot", value.qualificationRegistryRoot],
    ["qualificationAudienceHash", value.qualificationAudienceHash],
    ["predicateCompositionRootDigest", value.predicateCompositionRootDigest],
    ["gateCoreRuntimeClosureDigest", value.gateCoreRuntimeClosureDigest],
    ["gateCoreImplementationClosureDigest", value.gateCoreImplementationClosureDigest],
    ["searcherRuntime.runtimeArtifactRoot", value.searcherRuntime.runtimeArtifactRoot],
    ["searcherRuntime.implementationClosureDigest", value.searcherRuntime.implementationClosureDigest],
    ["searcherRuntime.nodeExecutableSha256", value.searcherRuntime.nodeExecutableSha256],
    ["searcherRuntime.entrypointSha256", value.searcherRuntime.entrypointSha256],
    ["searcherRuntime.bundleModuleSha256", value.searcherRuntime.bundleModuleSha256],
    ["discoverySourceQualification.endpointLocatorHash", value.discoverySourceQualification.endpointLocatorHash],
    ["discoverySourceQualification.sourceConfigRoot", value.discoverySourceQualification.sourceConfigRoot],
    ["discoverySourceQualification.qualificationRoot", value.discoverySourceQualification.qualificationRoot],
    ["qualifiedExecutorRegistryRoot", value.qualifiedExecutorRegistryRoot],
    ["valuationOwnerRegistryRoot", value.valuationOwnerRegistryRoot],
    ["qualifiedValuationOwnerSetRoot", value.qualifiedValuationOwnerSetRoot],
    ["actionOwnerRegistryRoot", value.actionOwnerRegistryRoot],
    ["qualifiedActionOwnerSetRoot", value.qualifiedActionOwnerSetRoot],
    ["safetyProfileRoot", value.safetyProfileRoot],
    ["qualifiedCapabilityRefsRoot", value.qualifiedCapabilityRefsRoot],
    ["nominationProgramSetRoot", value.nominationProgramSetRoot],
    ["nominationQualificationSetRoot", value.nominationQualificationSetRoot],
    ["selectedExecutorLeafHash", value.selectedExecutorLeafHash],
    ["releaseRoleManifestRoot", value.releaseRoleManifestRoot],
    ["executorSessionHash", value.executorSessionHash],
    ["frameworkAuthorityRoot", value.frameworkAuthorityRoot],
    ["executorAuthorityRoot", value.executorAuthorityRoot],
    ["releaseAuthorityRoot", value.releaseAuthorityRoot],
    ["attestationProofIssuerKeyId", value.attestationProofIssuerKeyId],
    ["candidatePartitionProofIssuerKeyId", value.candidatePartitionProofIssuerKeyId],
    ["signerKeyId", value.signerKeyId],
    ["bindingId", value.bindingId],
    ["payloadHash", value.payloadHash],
  ];
  for (const [field, hash] of hashFields) requireNonZeroHash(hash, `${path}.${field}`);
  decodeRuntimeReleaseDiscoverySourceQualificationV1(value.discoverySourceQualification);
  const expectedPayload = hashDomain(RELEASE_AUTHORITY_DOMAINS.payload, payloadWithoutIdentity(value));
  if (value.payloadHash !== expectedPayload) throw new TypeError(`runtime release binding payloadHash mismatch at ${path}`);
  const expectedId = hashDomain(RELEASE_AUTHORITY_DOMAINS.id, { payloadHash: expectedPayload });
  if (value.bindingId !== expectedId) throw new TypeError(`runtime release binding bindingId mismatch at ${path}`);
  if (value.signatureHex === `0x${"00".repeat(64)}`) throw new TypeError(`runtime release binding signature must not be zero at ${path}`);
  return deepFreeze(value);
}

function packageApprovalPayloadWithoutIdentity(
  value: RuntimeReleasePackageApprovalV1,
): RuntimeReleasePackageApprovalPayloadV1 {
  const {
    approvalId: _approvalId,
    payloadHash: _payloadHash,
    signatureAlgorithm: _signatureAlgorithm,
    signerKeyId: _signerKeyId,
    signatureHex: _signatureHex,
    ...payload
  } = value;
  return runtimeReleasePackageApprovalPayloadSchema.decode(payload);
}

function packageApprovalHashes(
  payload: RuntimeReleasePackageApprovalPayloadV1,
  signerKeyId: Hash,
): { readonly payloadHash: Hash; readonly approvalId: Hash } {
  const payloadHash = hashDomain(RELEASE_AUTHORITY_DOMAINS.packageApprovalPayload, payload);
  return Object.freeze({
    payloadHash,
    approvalId: hashDomain(RELEASE_AUTHORITY_DOMAINS.packageApprovalId, {
      payloadHash,
      signerKeyId,
    }),
  });
}

function checkRuntimeReleasePackageApproval(
  value: RuntimeReleasePackageApprovalV1,
  path: string,
): RuntimeReleasePackageApprovalV1 {
  if (value.candidateReleaseCommit === ZERO_COMMIT) {
    throw new TypeError(`candidate release commit must be non-zero at ${path}.candidateReleaseCommit`);
  }
  for (const [field, hash] of [
    ["packageRoot", value.packageRoot],
    ["bindingId", value.bindingId],
    ["releaseProvenanceHash", value.releaseProvenanceHash],
    ["releaseAcceptanceApprovalId", value.releaseAcceptanceApprovalId],
    ["releaseAcceptanceApprovalPayloadHash", value.releaseAcceptanceApprovalPayloadHash],
    ["releaseAcceptanceRequirementSetRoot", value.releaseAcceptanceRequirementSetRoot],
    ["releaseAcceptanceSetRoot", value.releaseAcceptanceSetRoot],
    ["controllerBoundaryEvidenceRoot", value.controllerBoundaryEvidenceRoot],
    ["performanceBasisId", value.performanceBasisId],
    ["performanceProfileHash", value.performanceProfileHash],
    ["hardwareProfileRoot", value.hardwareProfileRoot],
    ["providerRoot", value.providerRoot],
    ["signerKeyId", value.signerKeyId],
    ["approvalId", value.approvalId],
    ["payloadHash", value.payloadHash],
  ] as const) requireNonZeroHash(hash, `${path}.${field}`);
  const payload = packageApprovalPayloadWithoutIdentity(value);
  const expected = packageApprovalHashes(payload, value.signerKeyId);
  if (value.payloadHash !== expected.payloadHash) {
    throw new TypeError(`runtime release package approval payloadHash mismatch at ${path}.payloadHash`);
  }
  if (value.approvalId !== expected.approvalId) {
    throw new TypeError(`runtime release package approval approvalId mismatch at ${path}.approvalId`);
  }
  if (value.signatureHex === `0x${"00".repeat(64)}`) {
    throw new TypeError(`runtime release package approval signature must not be zero at ${path}`);
  }
  return deepFreeze(value);
}

const runtimeReleaseBindingCheckedSchema = RELEASE_AUTHORITY_SCHEMA_MANIFESTS.runtimeReleaseBinding.schema;
const runtimeReleasePackageApprovalCheckedSchema = RELEASE_AUTHORITY_SCHEMA_MANIFESTS.runtimeReleasePackageApproval.schema;

function parseInput(value: RuntimeReleaseBindingCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function bindingCore(value: RuntimeReleaseBindingV1 | RuntimeReleaseBindingPayloadV1): RuntimeReleaseBindingPayloadV1 {
  if ("bindingId" in value) return payloadWithoutIdentity(runtimeReleaseBindingSchema.decode(value));
  return runtimeReleaseBindingPayloadSchema.decode(value);
}

function bindingHashes(core: RuntimeReleaseBindingPayloadV1): { readonly payloadHash: Hash; readonly bindingId: Hash } {
  const payloadHash = hashDomain(RELEASE_AUTHORITY_DOMAINS.payload, core);
  return {
    payloadHash,
    bindingId: hashDomain(RELEASE_AUTHORITY_DOMAINS.id, { payloadHash }),
  };
}

export function decodeRuntimeReleaseBindingV1(value: RuntimeReleaseBindingCodecInput): RuntimeReleaseBindingV1 {
  return runtimeReleaseBindingCheckedSchema.decode(parseInput(value));
}

export function encodeRuntimeReleaseBindingV1(value: RuntimeReleaseBindingV1): Uint8Array {
  return encodeCanonicalBytes(runtimeReleaseBindingCheckedSchema.decode(value));
}

export function createRuntimeReleaseBindingV1(
  input: RuntimeReleaseBindingPayloadV1,
  signerKeyId: Hash,
  signatureHex: string,
): RuntimeReleaseBindingV1 {
  const core = runtimeReleaseBindingPayloadSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  const normalizedSignerKeyId = hashSchema.decode(signerKeyId);
  const { payloadHash, bindingId } = bindingHashes(core);
  return runtimeReleaseBindingCheckedSchema.decode({
    ...core,
    bindingId,
    payloadHash,
    signatureAlgorithm: "ed25519",
    signerKeyId: normalizedSignerKeyId,
    signatureHex: signature,
  });
}

export function recomputeRuntimeReleaseBindingPayloadHash(value: RuntimeReleaseBindingV1): Hash {
  return bindingHashes(bindingCore(decodeRuntimeReleaseBindingV1(value))).payloadHash;
}

export function recomputeRuntimeReleaseBindingId(value: RuntimeReleaseBindingV1): Hash {
  return bindingHashes(bindingCore(decodeRuntimeReleaseBindingV1(value))).bindingId;
}

/** Exact bytes signed by the external runtime-release authority. */
export function runtimeReleaseBindingSigningBytes(
  value: RuntimeReleaseBindingV1 | RuntimeReleaseBindingPayloadV1,
  signerKeyId?: Hash,
): Uint8Array {
  const core = bindingCore(value);
  const { payloadHash, bindingId } = bindingHashes(core);
  const keyId = signerKeyId ?? ("signerKeyId" in value ? value.signerKeyId : null);
  if (keyId === null) throw new TypeError("runtime release binding signerKeyId is required for signing bytes");
  return encodeCanonicalBytes({
    domain: RELEASE_AUTHORITY_DOMAINS.signing,
    version: 1,
    bindingId,
    payloadHash,
    signerKeyId: hashSchema.decode(keyId),
    ...core,
    kind: "aloha.runtime-release-binding",
  });
}

function nominationQualificationDeploymentFactCore(
  value: NominationQualificationDeploymentFactV1 | NominationQualificationDeploymentFactPayloadV1,
): NominationQualificationDeploymentFactPayloadV1 {
  if ("deploymentFactId" in value) {
    const {
      deploymentFactId: _deploymentFactId,
      payloadHash: _payloadHash,
      signatureAlgorithm: _signatureAlgorithm,
      signerKeyId: _signerKeyId,
      signatureHex: _signatureHex,
      ...payload
    } = nominationQualificationDeploymentFactSchema.decode(value);
    return nominationQualificationDeploymentFactPayloadSchema.decode(payload);
  }
  return nominationQualificationDeploymentFactPayloadSchema.decode(value);
}

function nominationQualificationDeploymentFactHashes(
  payload: NominationQualificationDeploymentFactPayloadV1,
): { readonly payloadHash: Hash; readonly deploymentFactId: Hash } {
  const payloadHash = hashDomain(RELEASE_AUTHORITY_DOMAINS.nominationQualificationDeploymentFactPayload, payload);
  return {
    payloadHash,
    deploymentFactId: hashDomain(RELEASE_AUTHORITY_DOMAINS.nominationQualificationDeploymentFactId, { payloadHash }),
  };
}

export function createNominationQualificationDeploymentFactV1(
  payloadValue: NominationQualificationDeploymentFactPayloadV1,
  signerKeyId: Hash,
  signatureHex: string,
): NominationQualificationDeploymentFactV1 {
  const payload = nominationQualificationDeploymentFactCore(payloadValue);
  const identity = nominationQualificationDeploymentFactHashes(payload);
  return decodeNominationQualificationDeploymentFactV1({
    ...payload,
    ...identity,
    signatureAlgorithm: "ed25519",
    signerKeyId,
    signatureHex,
  });
}

export function decodeNominationQualificationDeploymentFactV1(
  value: RuntimeReleaseBindingCodecInput,
): NominationQualificationDeploymentFactV1 {
  return RELEASE_AUTHORITY_SCHEMA_MANIFESTS.nominationQualificationDeploymentFact.schema.decode(parseInput(value));
}

function checkNominationQualificationDeploymentFactV1(
  fact: NominationQualificationDeploymentFactV1,
  path = "nominationQualificationDeploymentFact",
): NominationQualificationDeploymentFactV1 {
  const payload = nominationQualificationDeploymentFactCore(fact);
  const identity = nominationQualificationDeploymentFactHashes(payload);
  if (fact.payloadHash !== identity.payloadHash || fact.deploymentFactId !== identity.deploymentFactId) {
    throw new TypeError(`nomination qualification deployment fact identity mismatch at ${path}`);
  }
  for (const [field, hash] of Object.entries(payload)) {
    if (typeof hash === "string" && hash.startsWith("0x") && hash.length === 66) requireNonZeroHash(hash as Hash, `${path}.${field}`);
  }
  requireNonZeroHash(fact.signerKeyId, `${path}.signerKeyId`);
  return deepFreeze(fact);
}

/** Exact bytes signed by the external deployment-fact issuer; never signs. */
export function nominationQualificationDeploymentFactSigningBytes(
  value: NominationQualificationDeploymentFactV1 | NominationQualificationDeploymentFactPayloadV1,
  signerKeyId?: Hash,
): Uint8Array {
  const payload = nominationQualificationDeploymentFactCore(value);
  const identity = nominationQualificationDeploymentFactHashes(payload);
  const keyId = signerKeyId ?? ("signerKeyId" in value ? value.signerKeyId : null);
  if (keyId === null) throw new TypeError("nomination qualification deployment fact signerKeyId is required");
  return encodeCanonicalBytes({
    domain: RELEASE_AUTHORITY_DOMAINS.nominationQualificationDeploymentFactSigning,
    version: 1,
    ...identity,
    signerKeyId: hashSchema.decode(keyId),
    ...payload,
    kind: "aloha.nomination-qualification-deployment-fact",
  });
}

export function runtimeReleaseBindingProvenanceHash(value: RuntimeReleaseBindingV1): Hash {
  const decoded = decodeRuntimeReleaseBindingV1(value);
  return hashDomain(RELEASE_AUTHORITY_DOMAINS.provenance, decoded);
}

function packageApprovalCore(
  value: RuntimeReleasePackageApprovalV1 | RuntimeReleasePackageApprovalPayloadV1,
): RuntimeReleasePackageApprovalPayloadV1 {
  if ("approvalId" in value) {
    return packageApprovalPayloadWithoutIdentity(runtimeReleasePackageApprovalSchema.decode(value));
  }
  return runtimeReleasePackageApprovalPayloadSchema.decode(value);
}

export function decodeRuntimeReleasePackageApprovalV1(
  value: RuntimeReleasePackageApprovalCodecInput,
): RuntimeReleasePackageApprovalV1 {
  return runtimeReleasePackageApprovalCheckedSchema.decode(parseInput(value));
}

export function encodeRuntimeReleasePackageApprovalV1(
  value: RuntimeReleasePackageApprovalV1,
): Uint8Array {
  return encodeCanonicalBytes(runtimeReleasePackageApprovalCheckedSchema.decode(value));
}

export function createRuntimeReleasePackageApprovalV1(
  input: RuntimeReleasePackageApprovalPayloadV1,
  signerKeyId: Hash,
  signatureHex: string,
): RuntimeReleasePackageApprovalV1 {
  const payload = runtimeReleasePackageApprovalPayloadSchema.decode(input);
  const keyId = hashSchema.decode(signerKeyId);
  requireNonZeroHash(keyId, "runtimeReleasePackageApproval.signerKeyId");
  const signature = packageApprovalSignatureHexSchema.decode(signatureHex);
  const identity = packageApprovalHashes(payload, keyId);
  return runtimeReleasePackageApprovalCheckedSchema.decode({
    ...payload,
    ...identity,
    signatureAlgorithm: "ed25519",
    signerKeyId: keyId,
    signatureHex: signature,
  });
}

export function recomputeRuntimeReleasePackageApprovalPayloadHash(
  value: RuntimeReleasePackageApprovalV1,
): Hash {
  const decoded = decodeRuntimeReleasePackageApprovalV1(value);
  return packageApprovalHashes(packageApprovalCore(decoded), decoded.signerKeyId).payloadHash;
}

export function recomputeRuntimeReleasePackageApprovalId(
  value: RuntimeReleasePackageApprovalV1,
): Hash {
  const decoded = decodeRuntimeReleasePackageApprovalV1(value);
  return packageApprovalHashes(packageApprovalCore(decoded), decoded.signerKeyId).approvalId;
}

/** Exact bytes signed by the external package-release authority. */
export function runtimeReleasePackageApprovalSigningBytes(
  value: RuntimeReleasePackageApprovalV1 | RuntimeReleasePackageApprovalPayloadV1,
  signerKeyId?: Hash,
): Uint8Array {
  const payload = packageApprovalCore(value);
  const keyId = signerKeyId ?? ("signerKeyId" in value ? value.signerKeyId : null);
  if (keyId === null) {
    throw new TypeError("runtime release package approval signerKeyId is required for signing bytes");
  }
  const normalizedKeyId = hashSchema.decode(keyId);
  requireNonZeroHash(normalizedKeyId, "runtimeReleasePackageApproval.signerKeyId");
  const identity = packageApprovalHashes(payload, normalizedKeyId);
  return encodeCanonicalBytes({
    domain: RELEASE_AUTHORITY_DOMAINS.packageApprovalSigning,
    version: 1,
    ...identity,
    signerKeyId: normalizedKeyId,
    ...payload,
    kind: "aloha.runtime-release-package-approval",
  });
}

/**
 * Decode the catalog-facing projection emitted by the external release
 * packager.  This is deliberately only a fact contract: it does not issue an
 * authority and it does not accept an owner ref derived from a Family.  The
 * caller must exact-join bindingId/provenance/root to its already verified
 * runtime release capability before using the refs.
 */
export function decodeRuntimeReleaseQualifiedCapabilityProjectionV1(
  value: unknown,
): RuntimeReleaseQualifiedCapabilityProjectionV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, path) => {
      if (item !== 1) throw new TypeError(`unsupported capability projection schema at ${path}`);
      return 1 as const;
    },
    kind: (item, path) => {
      if (item !== "aloha.runtime-release-qualified-capability-projection") throw new TypeError(`invalid capability projection kind at ${path}`);
      return "aloha.runtime-release-qualified-capability-projection" as const;
    },
    bindingId: (item, path) => hashSchema.decode(item, path),
    releaseProvenanceHash: (item, path) => hashSchema.decode(item, path),
    qualifiedCapabilityRefsRoot: (item, path) => hashSchema.decode(item, path),
    refs: (item, path) => fieldArray(item, (entry, entryPath) => decodeReleaseQualifiedCapabilityRefV1(entry, entryPath), path),
  });
  const expectedRoot = hashReleaseQualifiedCapabilityRefsRoot(decoded.refs);
  if (decoded.qualifiedCapabilityRefsRoot !== expectedRoot) throw new TypeError("qualified capability projection root mismatch");
  return deepFreeze(decoded);
}

/** Derive the exact worker-facing projection from an already verified release.
 * This is the only schema owner allowed to choose projection fields. */
export function createRuntimeReleaseExecutorLeaseV1(
  value: RuntimeReleaseBindingV1,
  workerEpoch: string,
  executorSessionHash: Hash,
): RuntimeReleaseExecutorLeaseV1 {
  const binding = decodeRuntimeReleaseBindingV1(value);
  const epoch = nonEmptyStringSchema.decode(workerEpoch);
  const session = hashSchema.decode(executorSessionHash);
  return decodeRuntimeReleaseExecutorLeaseV1({
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    executorAuthorityRoot: binding.executorAuthorityRoot,
    qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
    executorKind: binding.selectedExecutor.executorKind,
    engineBuildFingerprint: binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: binding.selectedExecutor.executableFingerprint,
    closureFingerprint: binding.selectedExecutor.closureFingerprint,
    protocolFingerprint: binding.selectedExecutor.protocolFingerprint,
    schemaFingerprint: binding.selectedExecutor.schemaFingerprint,
    releaseRoleManifestRoot: binding.releaseRoleManifestRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    qualificationEpoch: binding.qualificationEpoch,
    predicateCompositionRootDigest: binding.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: binding.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: binding.gateCoreImplementationClosureDigest,
    frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    workerEpoch: epoch,
    executorSessionHash: session,
  });
}

/** Neutral resolver contract; it never mints or derives release authority. */
export type RuntimeReleaseResolutionCapabilityV1 = object;

export interface RuntimeReleaseResolutionPortV1 {
  resolve(capability: RuntimeReleaseResolutionCapabilityV1): RuntimeReleaseBindingV1;
}

/**
 * Narrow current-release consumer for ReadyGeneration.  It exposes no raw
 * resolver, signer, rotation, or generic authority capability; the runtime
 * release owner supplies the process-local implementation.
 */
export interface RuntimeReleaseReadyBindingPortV1 {
  currentProvenanceHash(): Hash;
}

/**
 * The runtime release authority owns every usable downstream composition.
 * These contracts intentionally carry only opaque objects: Attestation must
 * consume the exact process-local binding issued by the runtime authority,
 * never a raw RuntimeReleaseBinding or a structural resolver supplied by a
 * caller.
 */
export type RuntimeReleaseAttestationCompositionCapabilityV1 = object;

export interface RuntimeReleaseAttestationCompositionResolvedV1 {
  readonly provenance: {
    readonly runtimeBinding: RuntimeReleaseBindingV1;
  };
}

export interface RuntimeReleaseAttestationCompositionResolutionPortV1 {
  resolve(
    capability: RuntimeReleaseAttestationCompositionCapabilityV1,
  ): RuntimeReleaseAttestationCompositionResolvedV1;
}

export interface RuntimeReleaseAttestationCompositionBindingV1 {
  readonly capability: RuntimeReleaseAttestationCompositionCapabilityV1;
  readonly resolver: RuntimeReleaseAttestationCompositionResolutionPortV1;
}
