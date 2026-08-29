import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertExactKeys,
  encodeCanonicalBytes,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  createArtifactLineageClaim,
  createArtifactLineageObservationFromBytes,
  type ArtifactLineageFactBundleV1,
} from "../../../artifact-lineage-facts/src/schema.ts";
import { encodeArtifactHexBytes } from "../../../../specs/artifact-resolution/src/index.ts";
import type { SchemaRef } from "../../../../specs/core-envelope/src/index.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import {
  registerArtifactLineageStageOneCapabilityV1,
  registerArtifactLineageStageOneObserverPortV1,
  type ArtifactLineageStageOneCapabilityV1,
  type ProductionArtifactLineageStageOneObserverPortV1,
} from "./artifact-lineage-stage-one-state.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "./release-owned-observer-store.ts";

const RELEASE_DENOMINATOR_PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  "acceptance/gate-core/src/generated/release-runtime.ts",
  "acceptance/gate-core/src/generated/release-authority.ts",
  "acceptance/gate-core/src/release-role-manifest.ledger.json",
] as const);

const RELEASE_SOURCE_SCHEMA: SchemaRef = Object.freeze({
  id: "aloha.release-denominator.source",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/release-denominator-source-schema/v1", { version: 1 }),
});

const RELEASE_DENOMINATOR_MANIFEST_SCHEMA: SchemaRef = Object.freeze({
  id: "aloha.release-denominator.manifest",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/release-denominator-manifest-schema/v1", { version: 1 }),
});

interface ProductionArtifactLineageStageOneOwnerInputV1 {
  readonly repositoryRoot: string;
  readonly store: ReleaseOwnedObserverStoreCapabilityV1;
  readonly assertCurrent: () => void;
}

interface ExactCommitFileV1 {
  readonly path: string;
  readonly blobObjectId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !value.startsWith("/") || resolve(value) !== value) {
    throw new TypeError(`${label} must be canonical and absolute`);
  }
  return value;
}

function outputLimit(value: string): number {
  const parsed = BigInt(value);
  if (parsed > 64n * 1024n * 1024n) {
    throw new TypeError("artifact-lineage resolver byte limit exceeds Stage 1 process policy");
  }
  return Number(parsed) + 4096;
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
    throw new TypeError("artifact-lineage Git output limit is invalid");
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

async function readExactCommitFile(
  repositoryRoot: string,
  candidateReleaseCommit: string,
  path: string,
  maxOutputBytes: number,
): Promise<ExactCommitFileV1> {
  if (!/^[0-9a-f]{40}$/.test(candidateReleaseCommit)) {
    throw new TypeError("artifact-lineage candidate commit is not a canonical Git object id");
  }
  const tree = await runGit(repositoryRoot, ["ls-tree", "-z", candidateReleaseCommit, "--", path], 4096);
  const record = new TextDecoder("utf-8", { fatal: true }).decode(tree);
  const match = /^(100644) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(record);
  if (match === null || match[3] !== path) {
    throw new TypeError(`artifact-lineage exact commit is missing a regular blob at ${path}`);
  }
  const bytes = await runGit(repositoryRoot, ["cat-file", "blob", match[2]!], maxOutputBytes);
  if (gitBlobObjectId(bytes) !== match[2]) {
    throw new TypeError(`artifact-lineage exact commit blob identity changed at ${path}`);
  }
  return Object.freeze({
    path,
    blobObjectId: match[2],
    bytes,
    mediaType: path.endsWith(".json") ? "application/json" : "application/typescript",
  });
}

async function appendObservedArtifact(
  store: ReleaseOwnedObserverStoreCapabilityV1,
  bytes: Uint8Array,
  mediaType: string,
  schema: SchemaRef,
  artifacts: ObservedContentArtifactV1[],
  predicateFacts: ArtifactLineageFactBundleV1[],
  artifactRefIds: Set<Hash>,
): Promise<void> {
  const storeState = readReleaseOwnedObserverStoreV1(store);
  const artifact = await storeState.sink.write({ bytes, mediaType, schema });
  if (artifactRefIds.has(artifact.ref.artifactRefId)) return;
  artifactRefIds.add(artifact.ref.artifactRefId);
  const rawBytes = encodeArtifactHexBytes(artifact.bytes);
  const claim = createArtifactLineageClaim({
    schemaVersion: 1,
    kind: "aloha.artifact-lineage-claim",
    artifactRef: artifact.ref,
    resolverPolicy: storeState.sink.resolverPolicy,
    resolutionClaim: artifact.claim,
    retentionLease: artifact.lease,
    observedStoreEpoch: storeState.observedStoreEpoch,
  });
  const observation = createArtifactLineageObservationFromBytes({
    schemaVersion: 1,
    kind: "aloha.artifact-lineage-observation",
    artifactRefId: artifact.ref.artifactRefId,
    locator: artifact.ref.locator,
    immutableMirrorLocator: artifact.ref.immutableMirrorLocator,
    rawBytes,
    mediaType: artifact.ref.mediaType,
    schema: artifact.ref.schema,
    observedStoreEpoch: storeState.observedStoreEpoch,
  });
  artifacts.push(artifact);
  predicateFacts.push(Object.freeze({
    claim,
    observation,
    rawFacts: Object.freeze({
      rawBytes,
      locator: artifact.ref.locator,
      immutableMirrorLocator: artifact.ref.immutableMirrorLocator,
      mediaType: artifact.ref.mediaType,
      schema: artifact.ref.schema,
      observedStoreEpoch: storeState.observedStoreEpoch,
    }),
  }));
}

async function observeExactReleaseDenominator(
  repositoryRootValue: string,
  store: ReleaseOwnedObserverStoreCapabilityV1,
  assertCurrent: () => void,
): Promise<ArtifactLineageStageOneCapabilityV1> {
  const storeState = readReleaseOwnedObserverStoreV1(store);
  const repositoryRoot = await realpath(repositoryRootValue);
  if (repositoryRoot !== repositoryRootValue) {
    throw new TypeError("artifact-lineage repository root must be its physical canonical path");
  }
  const candidateReleaseCommit = storeState.authority.candidateReleaseCommit;
  const maxOutputBytes = outputLimit(storeState.sink.resolverPolicy.maxByteLength);
  const files: ExactCommitFileV1[] = [];
  let totalSourceBytes = 0;
  for (const path of RELEASE_DENOMINATOR_PATHS) {
    const file = await readExactCommitFile(repositoryRoot, candidateReleaseCommit, path, maxOutputBytes);
    totalSourceBytes += file.bytes.byteLength;
    if (totalSourceBytes > Number(BigInt(storeState.sink.resolverPolicy.maxByteLength))) {
      throw new TypeError("artifact-lineage exact commit denominator exceeds its cumulative byte bound");
    }
    files.push(file);
  }
  const denominatorEntries = Object.freeze(files.map(file => Object.freeze({
    path: file.path,
    blobObjectId: file.blobObjectId,
    contentSha256: sha256Hex(file.bytes),
    byteLength: String(file.bytes.byteLength),
    mediaType: file.mediaType,
    schema: RELEASE_SOURCE_SCHEMA,
  })));
  const denominatorRoot = hashDomain("aloha/artifact-lineage-exact-release-denominator/v1", {
    candidateReleaseCommit,
    releaseBindingId: storeState.authority.bindingId,
    releaseRoleManifestRoot: storeState.authority.releaseRoleManifestRoot,
    predicateCompositionRootDigest: storeState.authority.predicateCompositionRootDigest,
    entries: denominatorEntries,
  });
  const denominatorManifest = encodeCanonicalBytes({
    schemaVersion: 1,
    kind: "aloha.artifact-lineage-exact-release-denominator",
    candidateReleaseCommit,
    releaseBindingId: storeState.authority.bindingId,
    releaseRoleManifestRoot: storeState.authority.releaseRoleManifestRoot,
    predicateCompositionRootDigest: storeState.authority.predicateCompositionRootDigest,
    entries: denominatorEntries,
    denominatorRoot,
  });
  const artifacts: ObservedContentArtifactV1[] = [];
  const predicateFacts: ArtifactLineageFactBundleV1[] = [];
  const artifactRefIds = new Set<Hash>();
  for (const file of files) {
    await appendObservedArtifact(
      store, file.bytes, file.mediaType, RELEASE_SOURCE_SCHEMA,
      artifacts, predicateFacts, artifactRefIds,
    );
  }
  await appendObservedArtifact(
    store, denominatorManifest, "application/json", RELEASE_DENOMINATOR_MANIFEST_SCHEMA,
    artifacts, predicateFacts, artifactRefIds,
  );
  return registerArtifactLineageStageOneCapabilityV1(store, assertCurrent, Object.freeze({
    candidateReleaseCommit,
    denominatorRoot,
    artifacts: Object.freeze(artifacts),
    predicateFacts: Object.freeze(predicateFacts),
  }));
}

/** Sole production Stage 1 issuer. It takes only an owner-issued store and a
 * physical repository location; release identity, store identity, lease and
 * the fixed denominator are not caller-selectable. */
export function issueProductionArtifactLineageStageOneObserverPortV1(
  input: ProductionArtifactLineageStageOneOwnerInputV1,
): ProductionArtifactLineageStageOneObserverPortV1 {
  assertExactKeys(input, ["repositoryRoot", "store", "assertCurrent"], "artifactLineageStageOneOwner");
  const repositoryRoot = canonicalAbsolutePath(
    readOwnEnumerableDataProperty(input, "repositoryRoot", "artifactLineageStageOneOwner"),
    "artifact-lineage repository root",
  );
  const store = readOwnEnumerableDataProperty(
    input, "store", "artifactLineageStageOneOwner",
  ) as ReleaseOwnedObserverStoreCapabilityV1;
  const assertCurrentValue = readOwnEnumerableDataProperty(
    input, "assertCurrent", "artifactLineageStageOneOwner",
  );
  if (typeof assertCurrentValue !== "function") {
    throw new TypeError("artifact-lineage Stage 1 current-authority guard is invalid");
  }
  const assertCurrent = assertCurrentValue as () => void;
  readReleaseOwnedObserverStoreV1(store);
  return registerArtifactLineageStageOneObserverPortV1(
    store,
    repositoryRoot,
    assertCurrent,
    async () => {
      assertCurrent();
      const capability = await observeExactReleaseDenominator(repositoryRoot, store, assertCurrent);
      assertCurrent();
      return capability;
    },
  );
}
