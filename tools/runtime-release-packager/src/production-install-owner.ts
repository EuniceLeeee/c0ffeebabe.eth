import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeCanonicalJson, encodeCanonicalBytes } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleasePackageApprovalV1,
  decodeRuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  PRODUCTION_RELEASE_LAYOUT_V1,
  PRODUCTION_RELEASE_REPOSITORY_ROOT_V1,
  verifyInstalledReleaseV1,
  verifyReleasePackageDirectoryV1,
  type ReleasePackageManifestV1,
} from "./deployment-package.ts";

export const PRODUCTION_RELEASE_PACKAGE_REPOSITORY_V1 = `${PRODUCTION_RELEASE_REPOSITORY_ROOT_V1}/releases` as const;
const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMCTL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

function requireRootProtectedDirectory(path: string, create: boolean): void {
  if (!existsSync(path)) {
    if (!create) throw new TypeError(`required production directory is missing: ${path}`);
    mkdirSync(path, { recursive: false, mode: 0o755 });
    chownSync(path, 0, 0);
    chmodSync(path, 0o755);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new TypeError(`production directory is not root-owned and protected: ${path}`);
  }
}

function requireRootProtectedFile(path: string, mode?: number): Uint8Array {
  if (realpathSync(path) !== path) throw new TypeError(`production file must not be a symlink: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
    || (mode !== undefined && (stat.mode & 0o777) !== mode)) {
    throw new TypeError(`production file is not root-owned and protected: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertServiceUninstalledAndInactive(): void {
  if (existsSync(PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath)) {
    throw new TypeError("production systemd unit already exists; immutable fresh-host install only");
  }
  const output = execFileSync(SYSTEMCTL, [
    "show",
    PRODUCTION_RELEASE_LAYOUT_V1.systemdUnit,
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
  ], {
    encoding: "utf8",
    env: SYSTEMCTL_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });
  const facts = new Map(output.trim().split("\n").map(line => {
    const separator = line.indexOf("=");
    return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (facts.get("LoadState") !== "not-found"
    || facts.get("ActiveState") !== "inactive"
    || facts.get("SubState") !== "dead") {
    throw new TypeError("production systemd unit is loaded or active");
  }
}

interface StagedInstallFileV1 {
  readonly target: string;
  readonly temporary: string;
  readonly bytes: Uint8Array;
}

function stageFile(target: string, bytes: Uint8Array, discriminator: string): StagedInstallFileV1 {
  const directory = dirname(target);
  requireRootProtectedDirectory(directory, false);
  if (existsSync(target)) throw new TypeError(`production target already exists: ${target}`);
  const temporary = join(directory, `.aloha-install-${discriminator}-${target.split("/").at(-1)}`);
  if (existsSync(temporary)) throw new TypeError(`production staging file already exists: ${temporary}`);
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o400 });
  chownSync(temporary, 0, 0);
  chmodSync(temporary, target === PRODUCTION_RELEASE_LAYOUT_V1.revmWorkerExecutablePath
    || target === PRODUCTION_RELEASE_LAYOUT_V1.proofSignerExecutablePath ? 0o555 : 0o444);
  fsyncPath(temporary);
  return Object.freeze({ target, temporary, bytes });
}

/** Fresh-host, fixed-path production installer. It never accepts target paths,
 * never starts/enables a service, and publishes the systemd unit last as the
 * ready marker. Any failure removes that marker first and rolls back only
 * files created by this invocation. */
export function installApprovedProductionReleaseV1(packageDirectoryValue: string): ReleasePackageManifestV1 {
  if (arguments.length !== 1) throw new TypeError("production installer accepts only one package directory");
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new TypeError("production installer requires a root Linux host");
  }
  const packageDirectory = realpathSync(resolve(packageDirectoryValue));
  const repository = realpathSync(PRODUCTION_RELEASE_PACKAGE_REPOSITORY_V1);
  if (packageDirectory !== resolve(packageDirectoryValue)
    || dirname(packageDirectory) !== repository) {
    throw new TypeError("approved package must be one immutable member of the fixed production repository");
  }
  requireRootProtectedDirectory(PRODUCTION_RELEASE_REPOSITORY_ROOT_V1, false);
  requireRootProtectedDirectory(repository, false);
  requireRootProtectedDirectory(packageDirectory, false);
  const signerPinBytes = requireRootProtectedFile(PRODUCTION_RELEASE_LAYOUT_V1.runtimeSignerPinPath, 0o444);
  const signerPin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(signerPinBytes) as object);
  const approvalPath = join(packageDirectory, "runtime-release-package-approval.json");
  const approvalBytes = requireRootProtectedFile(approvalPath, 0o444);
  const approval = decodeRuntimeReleasePackageApprovalV1(approvalBytes);
  const manifest = verifyReleasePackageDirectoryV1(packageDirectory, signerPin, approval);
  assertServiceUninstalledAndInactive();

  const directoryPaths = new Set<string>([
    dirname(PRODUCTION_RELEASE_LAYOUT_V1.packageManifestPath),
    dirname(PRODUCTION_RELEASE_LAYOUT_V1.packageApprovalPath),
    ...manifest.artifacts.map(artifact => dirname(artifact.installPath)),
  ]);
  for (const directory of [...directoryPaths].sort((left, right) => left.length - right.length)) {
    if (!existsSync(directory)) requireRootProtectedDirectory(dirname(directory), false);
    requireRootProtectedDirectory(directory, true);
  }
  const sourceManifestBytes = requireRootProtectedFile(join(packageDirectory, "release-package.json"), 0o444);
  const installFiles = [
    ...manifest.artifacts.map(artifact => Object.freeze({
      target: artifact.installPath,
      bytes: requireRootProtectedFile(join(packageDirectory, artifact.name), 0o444),
    })),
    Object.freeze({ target: PRODUCTION_RELEASE_LAYOUT_V1.packageManifestPath, bytes: sourceManifestBytes }),
    Object.freeze({ target: PRODUCTION_RELEASE_LAYOUT_V1.packageApprovalPath, bytes: approvalBytes }),
  ];
  const unitIndex = installFiles.findIndex(file => file.target === PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath);
  if (unitIndex < 0) throw new TypeError("approved package lacks the production systemd ready marker");
  const [unit] = installFiles.splice(unitIndex, 1);
  installFiles.push(unit!);
  const discriminator = `${manifest.packageRoot.slice(2)}-${process.pid}`;
  const staged: StagedInstallFileV1[] = [];
  const published: string[] = [];
  try {
    for (const file of installFiles) staged.push(stageFile(file.target, file.bytes, discriminator));
    for (const file of staged) {
      linkSync(file.temporary, file.target);
      unlinkSync(file.temporary);
      published.push(file.target);
      fsyncPath(dirname(file.target));
    }
    return verifyInstalledReleaseV1({
      packageManifestPath: PRODUCTION_RELEASE_LAYOUT_V1.packageManifestPath,
      nodeExecutablePath: PRODUCTION_RELEASE_LAYOUT_V1.nodeExecutablePath,
      entrypointPath: PRODUCTION_RELEASE_LAYOUT_V1.entrypointPath,
      signerPinPath: PRODUCTION_RELEASE_LAYOUT_V1.runtimeSignerPinPath,
      packageApprovalPath: PRODUCTION_RELEASE_LAYOUT_V1.packageApprovalPath,
    });
  } catch (error) {
    if (published.includes(PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath)) {
      unlinkSync(PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath);
    }
    for (const path of published.reverse()) {
      if (path !== PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath && existsSync(path)) unlinkSync(path);
    }
    for (const file of staged) {
      if (existsSync(file.temporary)) unlinkSync(file.temporary);
    }
    for (const directory of directoryPaths) {
      if (existsSync(directory)) fsyncPath(directory);
    }
    throw error;
  }
}
