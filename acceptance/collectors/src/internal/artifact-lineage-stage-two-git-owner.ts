import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { assertExactKeys, assertPlainObject, decodeCanonicalJson, hashDomain, sha256Hex, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ArtifactLineageStageOneObservationV1 } from "../production-artifact-lineage-observer.ts";

const PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  "acceptance/gate-core/src/generated/release-runtime.ts",
  "acceptance/gate-core/src/generated/release-authority.ts",
  "acceptance/gate-core/src/release-role-manifest.ledger.json",
] as const);

interface Authority {
  readonly repositoryRoot: string;
  readonly candidateReleaseCommit: string;
  readonly releaseBindingId: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly predicateCompositionRootDigest: Hash;
}

function gitBlobObjectId(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
  maxOutputBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("artifact-lineage Stage 2 Git output limit is invalid");
  }
  return new Uint8Array(execFileSync("/usr/bin/git", [
    "--no-replace-objects",
    "-c", "core.excludesFile=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "core.sshCommand=/bin/false",
    "-c", "protocol.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=never",
    "-c", `safe.directory=${repositoryRoot}`,
    "-C", repositoryRoot,
    ...args,
  ], {
    encoding: null,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_ASKPASS: "/bin/false",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      SSH_ASKPASS: "/bin/false",
    },
    maxBuffer: maxOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function outputLimit(value: string): number {
  const parsed = BigInt(value);
  if (parsed > 64n * 1024n * 1024n) {
    throw new TypeError("artifact-lineage resolver byte limit exceeds Stage 2 process policy");
  }
  return Number(parsed) + 4096;
}

export async function observeArtifactLineageStageTwoGitEvidenceV1(
  owner: Authority,
  observed: ArtifactLineageStageOneObservationV1,
  maxByteLength: string,
): Promise<Readonly<{ readonly candidateReleaseCommit: string; readonly denominatorRoot: Hash; readonly evidenceRoot: Hash }>> {
  if (observed.artifacts.length !== 6) throw new TypeError("artifact-lineage Stage 2 Git requires six artifacts");
  const decoded = decodeCanonicalJson(observed.artifacts[5]!.bytes);
  assertPlainObject(decoded, "artifactLineageStageTwoGitManifest");
  assertExactKeys(decoded, ["schemaVersion", "kind", "candidateReleaseCommit", "releaseBindingId", "releaseRoleManifestRoot", "predicateCompositionRootDigest", "entries", "denominatorRoot"], "artifactLineageStageTwoGitManifest");
  const manifest = decoded as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "aloha.artifact-lineage-exact-release-denominator"
    || manifest.candidateReleaseCommit !== owner.candidateReleaseCommit || manifest.denominatorRoot !== observed.denominatorRoot
    || !Array.isArray(manifest.entries) || manifest.entries.length !== 5) throw new TypeError("artifact-lineage Stage 2 Git manifest identity mismatch");
  const root = await realpath(owner.repositoryRoot);
  if (root !== owner.repositoryRoot) throw new TypeError("artifact-lineage Stage 2 repository root is not physical");
  if (!/^[0-9a-f]{40}$/.test(owner.candidateReleaseCommit)) throw new TypeError("artifact-lineage Stage 2 candidate commit is invalid");
  const maxOutputBytes = outputLimit(maxByteLength);
  let total = 0n;
  const entries = [];
  for (let index = 0; index < 5; index += 1) {
    const entry = manifest.entries[index];
    assertPlainObject(entry, `artifactLineageStageTwoGitManifest.entries[${index}]`);
    assertExactKeys(entry, ["path", "blobObjectId", "contentSha256", "byteLength", "mediaType", "schema"], `artifactLineageStageTwoGitManifest.entries[${index}]`);
    const item = entry as Record<string, unknown>; const path = PATHS[index]!;
    if (item.path !== path || typeof item.blobObjectId !== "string" || !/^[0-9a-f]{40}$/.test(item.blobObjectId)) throw new TypeError(`artifact-lineage Stage 2 Git manifest entry splice at ${index}`);
    const tree = await runGit(root, ["ls-tree", "-z", owner.candidateReleaseCommit, "--", path], 4096);
    const record = new TextDecoder("utf-8", { fatal: true }).decode(tree);
    const match = /^(100644) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(record);
    if (match === null || match[3] !== path || match[2] !== item.blobObjectId) throw new TypeError(`artifact-lineage Stage 2 exact-commit tree splice at ${index}`);
    const bytes = await runGit(root, ["cat-file", "blob", item.blobObjectId], maxOutputBytes);
    if (gitBlobObjectId(bytes) !== match[2]) throw new TypeError(`artifact-lineage Stage 2 exact-commit blob splice at ${index}`);
    total += BigInt(bytes.byteLength);
    const artifact = observed.artifacts[index]!;
    if (total > BigInt(maxByteLength) || bytes.byteLength !== artifact.bytes.byteLength || bytes.some((value, offset) => value !== artifact.bytes[offset])
      || sha256Hex(bytes) !== artifact.contentSha256 || item.contentSha256 !== artifact.contentSha256 || item.byteLength !== String(bytes.byteLength)) throw new TypeError(`artifact-lineage Stage 2 signed blob/bytes splice at ${index}`);
    entries.push({ path, blobObjectId: item.blobObjectId, contentSha256: artifact.contentSha256, byteLength: String(bytes.byteLength), artifactRefId: artifact.ref.artifactRefId });
  }
  return Object.freeze({
    candidateReleaseCommit: owner.candidateReleaseCommit,
    denominatorRoot: observed.denominatorRoot,
    evidenceRoot: hashDomain("aloha/artifact-lineage-stage-two-git-evidence/v1", { authority: owner, entries }),
  });
}
