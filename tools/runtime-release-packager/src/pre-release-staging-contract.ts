import { hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { ProcessAnchorV1 } from "../../../specs/core-envelope/src/index.ts";
import type { PreReleaseLaunchAuthorizationV1 } from "./internal/pre-release-staging-schema.ts";

export interface DurablePreReleaseAuthorizationClaimV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-authorization-claim";
  readonly claimId: Hash;
  readonly authorizationId: Hash;
  readonly signerKeyId: Hash;
  readonly nonce: Hash;
  readonly phase: "pre-release";
  readonly roundRole: "restart-probe" | "qualification-final";
  readonly predecessor: null | Readonly<{
    readonly authorizationId: Hash;
    readonly authorizationClaimId: Hash;
    readonly controllerReceiptId: Hash;
    readonly controllerImplementationIdentityHash: Hash;
    readonly targetProcessAnchorHash: Hash;
    readonly processReadyEventId: Hash;
    readonly sigtermDrainedEventId: Hash;
    readonly restartTerminalId: Hash;
  }>;
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly observerStoreDirectory: string;
  readonly issuedAtUnixNs: string;
  readonly expiresAtUnixNs: string;
  readonly payloadHash: Hash;
  readonly signatureHash: Hash;
  readonly ledgerPath: string;
  readonly ledgerDevice: string;
  readonly ledgerInode: string;
}

export function preReleaseAuthorizationClaimPayloadV1(
  authorization: PreReleaseLaunchAuthorizationV1,
): Readonly<{
  readonly authorizationId: Hash;
  readonly signerKeyId: Hash;
  readonly nonce: Hash;
  readonly phase: "pre-release";
  readonly roundRole: "restart-probe" | "qualification-final";
  readonly predecessor: PreReleaseLaunchAuthorizationV1["predecessor"];
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly observerStoreDirectory: string;
  readonly issuedAtUnixNs: string;
  readonly expiresAtUnixNs: string;
  readonly payloadHash: Hash;
  readonly signatureHash: Hash;
}> {
  return Object.freeze({
    authorizationId: authorization.authorizationId,
    signerKeyId: authorization.signerKeyId,
    nonce: authorization.nonce,
    phase: authorization.phase,
    roundRole: authorization.roundRole,
    predecessor: authorization.predecessor,
    candidateReleaseCommit: authorization.candidateReleaseCommit,
    runtimeBindingId: authorization.runtimeBindingId,
    releaseProvenanceHash: authorization.releaseProvenanceHash,
    controllerBoundaryEvidenceRoot: authorization.controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot: authorization.stagingArtifactSetRoot,
    stagingManifestRoot: authorization.stagingManifestRoot,
    observerStoreDirectory: authorization.observerStoreDirectory,
    issuedAtUnixNs: authorization.issuedAtUnixNs,
    expiresAtUnixNs: authorization.expiresAtUnixNs,
    payloadHash: authorization.payloadHash,
    signatureHash: sha256Hex(Buffer.from(authorization.signatureHex.slice(2), "hex")),
  });
}

export function preReleaseAuthorizationClaimIdV1(authorization: PreReleaseLaunchAuthorizationV1): Hash {
  return hashDomain(
    "aloha/pre-release-authorization-claim/id/v1",
    preReleaseAuthorizationClaimPayloadV1(authorization),
  );
}

/** Process-local proof that the fixed owner ledger issued the exact durable
 * projection. Structural DTO copies never recover this authority. */
export type PreReleaseAuthorizationClaimCapabilityV1 = object;

export type PreReleaseStagingArtifactNameV1 =
  | "aloha-searcher-pre-release.service"
  | "candidate-proof-verifier-binding.json"
  | "catalog-generation.inputs.json"
  | "deployment-bundle.mjs"
  | "deployment-composition.mjs"
  | "deployment-source.json"
  | "executor-state.json"
  | "family-catalog.ts"
  | "nomination-qualification-deployment-fact.json"
  | "performance-profile.json"
  | "qualified-release-runner-input.json"
  | "release-authority-approval.json"
  | "release-intent.json"
  | "runtime-policy.json"
  | "runtime-boundary-projection.json"
  | "runtime-composition.ts"
  | "runtime-release-binding.json"
  | "runtime-release-signer-pin.json"
  | "searcher-pre-release.env"
  | "staging-manifest.json"
  | "strategy-catalog.ts"
  | "pre-release-owner.mjs"
  | "production-launcher.mjs";

export interface PreReleaseStagingArtifactIdentityV1 {
  readonly name: PreReleaseStagingArtifactNameV1;
  readonly installPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
}

/** Opaque, process-local access to frozen-B facts for advisory evaluation.
 * It is not a release/runtime/submission capability and has no authority
 * consumer. */
export type PreReleaseAdvisoryMaterialCapabilityV1 = object;

export interface PreReleaseProcessImportReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-process-import-receipt";
  readonly phase: "pre-release";
  readonly receiptId: Hash;
  readonly authorizationId: Hash;
  readonly authorizationClaimId: Hash;
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly stagingArtifacts: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly processAnchor: ProcessAnchorV1;
  readonly processAnchorHash: Hash;
  readonly entrypointPath: string;
  readonly entrypointSha256: Hash;
  readonly bundlePath: string;
  readonly bundleSha256: Hash;
  readonly runtimeExportSurfaceRoot: Hash;
  readonly manifestPath: string;
  readonly processEvidenceDatabasePath: string;
  readonly checkpointDatabasePath: string;
  readonly observerStoreDirectory: string;
  readonly databaseDevice: string;
  readonly databaseInode: string;
  readonly databaseContentSha256: Hash;
  readonly databaseStoreIdentityHash: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly systemdInvocationId: string;
  readonly logPath: string;
  readonly logDevice: string;
  readonly logInode: string;
  readonly logStartInclusive: string;
  readonly logEndExclusive: string;
  readonly logContentSha256: Hash;
  readonly importedAtUnixNs: string;
  readonly dryRun: true;
}

export interface PreReleaseAdvisoryMaterialProjectionV1 {
  readonly phase: "pre-release";
  readonly locators: Readonly<{
    readonly repositoryRoot: string;
    readonly artifactRoot: string;
    readonly manifestPath: string;
    readonly processEvidenceDatabasePath: string;
    readonly checkpointDatabasePath: string;
    readonly observerStoreDirectory: string;
    readonly logPath: string;
    readonly authorizationPath: string;
    readonly restartProbeAuthorizationPath: string;
    readonly qualificationFinalAuthorizationPath: string;
    readonly authorizationLedgerPath: string;
    readonly advisoryJudgmentPath: string;
  }>;
  readonly signedAuthorization: PreReleaseLaunchAuthorizationV1;
  readonly authorizationClaim: DurablePreReleaseAuthorizationClaimV1;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly stagingArtifacts: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly processImportReceipt: PreReleaseProcessImportReceiptV1;
}
