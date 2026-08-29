import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeSignedReleaseAcceptanceApprovalV1,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeRuntimeReleasePackageApprovalV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  completeFrozenProductionArtifactBaseV1,
  materializeApprovedProductionReleasePackageV1,
  materializePreparedProductionReleasePackageV1,
  readProductionReleasePackageSigningRequestV1,
  reopenFrozenProductionArtifactBaseV1,
  reopenPreparedProductionReleasePackageV1,
} from "./external-release-owner.ts";
import { PRODUCTION_RELEASE_PACKAGE_REPOSITORY_V1 } from "./production-install-owner.ts";
import { PRODUCTION_RELEASE_REPOSITORY_ROOT_V1 } from "./deployment-package.ts";

export const EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1 = Object.freeze({
  acceptanceApprovalDirectory: "/var/lib/aloha/release-packaging/acceptance-approval",
  acceptanceApprovalPath: "/var/lib/aloha/release-packaging/acceptance-approval/release-acceptance-approval.json",
  packageApprovalDirectory: "/var/lib/aloha/release-packaging/package-approval",
  packageApprovalPath: "/var/lib/aloha/release-packaging/package-approval/runtime-release-package-approval.json",
  preparedPackageRepository: "/var/lib/aloha/release-packaging/prepared-packages",
  approvedPackageRepository: PRODUCTION_RELEASE_PACKAGE_REPOSITORY_V1,
} as const);

export interface PreparedExternalReleasePackageV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.prepared-external-release-package";
  readonly artifactBaseDirectory: string;
  readonly acceptanceApprovalPath: string;
  readonly acceptanceApprovalSha256: Hash;
  readonly packageRoot: Hash;
  readonly preparedPackageDirectory: string;
  readonly packageApprovalSigningRequestPath: string;
  readonly packageApprovalSigningRequestRoot: Hash;
  readonly packageApprovalSigningRequestSha256: Hash;
  readonly artifactCount: "26";
  readonly sign: false;
  readonly install: false;
  readonly start: false;
}

export interface MaterializedApprovedExternalReleasePackageV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.materialized-approved-external-release-package";
  readonly preparedPackageDirectory: string;
  readonly packageApprovalPath: string;
  readonly packageApprovalSha256: Hash;
  readonly packageRoot: Hash;
  readonly approvedPackageDirectory: string;
  readonly installerSourceDirectory: string;
  readonly sign: false;
  readonly install: false;
  readonly start: false;
}

function requireRoot(): void {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new TypeError("external release workflow requires a root Linux host");
  }
}

function requireRootDirectory(path: string, mode: number, create: boolean): void {
  if (!existsSync(path)) {
    if (!create) throw new TypeError(`fixed external release directory is missing: ${path}`);
    mkdirSync(path, { recursive: false, mode });
    chownSync(path, 0, 0);
    chmodSync(path, mode);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o777) !== mode) {
    throw new TypeError(`fixed external release directory is not exact root-owned storage: ${path}`);
  }
}

function stableFixedApprovalBytes(directory: string, path: string): Uint8Array {
  requireRootDirectory(directory, 0o700, false);
  const names = readdirSync(directory);
  if (names.length !== 1 || names[0] !== path.slice(directory.length + 1)) {
    throw new TypeError("fixed external approval input denominator mismatch");
  }
  if (!existsSync(path) || realpathSync(path) !== path) {
    throw new TypeError("fixed external approval input is missing or redirected");
  }
  const before = statSync(path, { bigint: true });
  if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || (before.mode & 0o777n) !== 0o400n) {
    throw new TypeError("fixed external approval input is not root-owned mode 0400");
  }
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength)) {
    throw new TypeError("fixed external approval input changed during read");
  }
  return bytes;
}

function canonicalApproval<T>(bytes: Uint8Array, decode: (value: unknown) => T, label: string): T {
  const value = decode(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(value)))) {
    throw new TypeError(`${label} is not canonical exact bytes`);
  }
  return value;
}

function requirePreparedRepository(): string {
  requireRootDirectory(dirname(EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.preparedPackageRepository), 0o700, true);
  requireRootDirectory(EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.preparedPackageRepository, 0o700, true);
  return EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.preparedPackageRepository;
}

function requireApprovedRepository(): string {
  requireRootDirectory(PRODUCTION_RELEASE_REPOSITORY_ROOT_V1, 0o755, true);
  requireRootDirectory(EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.approvedPackageRepository, 0o755, true);
  return EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.approvedPackageRepository;
}

/** Consume one externally signed acceptance approval and persist B=26 plus
 * package-approval signing bytes. No signer is present in this process. */
export function prepareExternalReleasePackageApprovalV1(
  artifactBaseDirectoryValue: string,
): PreparedExternalReleasePackageV1 {
  if (arguments.length !== 1) throw new TypeError("external release preparation accepts only an artifact-base directory");
  requireRoot();
  const artifactBaseDirectory = realpathSync(resolve(artifactBaseDirectoryValue));
  if (artifactBaseDirectory !== resolve(artifactBaseDirectoryValue)) {
    throw new TypeError("external release artifact-base directory is not canonical");
  }
  const acceptanceApprovalBytes = stableFixedApprovalBytes(
    EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.acceptanceApprovalDirectory,
    EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.acceptanceApprovalPath,
  );
  const acceptanceApproval = canonicalApproval(
    acceptanceApprovalBytes,
    value => decodeSignedReleaseAcceptanceApprovalV1(value as object),
    "external release acceptance approval",
  );
  const artifactBase = reopenFrozenProductionArtifactBaseV1(artifactBaseDirectory);
  const prepared = completeFrozenProductionArtifactBaseV1(artifactBase, acceptanceApproval);
  const publication = materializePreparedProductionReleasePackageV1(
    prepared,
    requirePreparedRepository(),
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.prepared-external-release-package",
    artifactBaseDirectory,
    acceptanceApprovalPath: EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.acceptanceApprovalPath,
    acceptanceApprovalSha256: sha256Hex(acceptanceApprovalBytes),
    packageRoot: publication.packageRoot,
    preparedPackageDirectory: publication.directory,
    packageApprovalSigningRequestPath: publication.signingRequestPath,
    packageApprovalSigningRequestRoot: publication.signingRequestRoot,
    packageApprovalSigningRequestSha256: publication.signingRequestSha256,
    artifactCount: publication.artifactCount,
    sign: false,
    install: false,
    start: false,
  });
}

/** Consume one externally signed package approval and publish the immutable
 * approved package that the separate fixed installer may later consume. This
 * function does not invoke that installer. */
export function materializeExternalApprovedReleasePackageV1(
  preparedPackageDirectoryValue: string,
): MaterializedApprovedExternalReleasePackageV1 {
  if (arguments.length !== 1) throw new TypeError("approved package materialization accepts only a prepared-package directory");
  requireRoot();
  const preparedRepository = requirePreparedRepository();
  const preparedPackageDirectory = realpathSync(resolve(preparedPackageDirectoryValue));
  if (preparedPackageDirectory !== resolve(preparedPackageDirectoryValue)) {
    throw new TypeError("external prepared-package directory is not canonical");
  }
  const packageApprovalBytes = stableFixedApprovalBytes(
    EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.packageApprovalDirectory,
    EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.packageApprovalPath,
  );
  const packageApproval = canonicalApproval(
    packageApprovalBytes,
    value => decodeRuntimeReleasePackageApprovalV1(value as object),
    "external runtime release package approval",
  );
  const prepared = reopenPreparedProductionReleasePackageV1(
    preparedPackageDirectory,
    preparedRepository,
  );
  const signingRequest = readProductionReleasePackageSigningRequestV1(prepared);
  const approvedPackageDirectory = materializeApprovedProductionReleasePackageV1(
    prepared,
    packageApproval,
    requireApprovedRepository(),
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.materialized-approved-external-release-package",
    preparedPackageDirectory,
    packageApprovalPath: EXTERNAL_RELEASE_WORKFLOW_LAYOUT_V1.packageApprovalPath,
    packageApprovalSha256: sha256Hex(packageApprovalBytes),
    packageRoot: signingRequest.packageRoot,
    approvedPackageDirectory,
    installerSourceDirectory: approvedPackageDirectory,
    sign: false,
    install: false,
    start: false,
  });
}
