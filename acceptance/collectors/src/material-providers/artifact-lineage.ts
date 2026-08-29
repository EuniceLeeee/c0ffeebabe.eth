import {
  assertExactKeys, assertGitSha40, assertHash, assertPlainObject, decodeCanonicalJson,
  encodeCanonicalBytes, hashDomain, readOwnEnumerableDataProperty, sha256Hex, type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeArtifactLineageFactBundle } from "../../../artifact-lineage-facts/src/schema.ts";
import { encodeArtifactHexBytes } from "../../../../specs/artifact-resolution/src/index.ts";
import type { SchemaRef } from "../../../../specs/core-envelope/src/index.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import type { ArtifactLineageStageOneObservationV1 } from "../production-artifact-lineage-observer.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

const PREDICATE_ID = "aloha.artifact-lineage.facts";
const PATHS = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  "acceptance/gate-core/src/generated/release-runtime.ts",
  "acceptance/gate-core/src/generated/release-authority.ts",
  "acceptance/gate-core/src/release-role-manifest.ledger.json",
] as const);
const SOURCE_SCHEMA: SchemaRef = Object.freeze({ id: "aloha.release-denominator.source", version: "1.0.0", schemaHash: hashDomain("aloha/release-denominator-source-schema/v1", { version: 1 }) });
const MANIFEST_SCHEMA: SchemaRef = Object.freeze({ id: "aloha.release-denominator.manifest", version: "1.0.0", schemaHash: hashDomain("aloha/release-denominator-manifest-schema/v1", { version: 1 }) });

interface Authority {
  readonly repositoryRoot: string;
  readonly candidateReleaseCommit: string;
  readonly releaseBindingId: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly predicateCompositionRootDigest: Hash;
}
interface Entry {
  readonly path: string;
  readonly blobObjectId: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: SchemaRef;
}
interface GitEvidence {
  readonly candidateReleaseCommit: string;
  readonly denominatorRoot: Hash;
  readonly evidenceRoot: Hash;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const same = (a: unknown, b: unknown) => sameBytes(encodeCanonicalBytes(a as never), encodeCanonicalBytes(b as never));

function authority(value: unknown): Authority {
  assertPlainObject(value, "artifactLineageStageTwoAuthority");
  assertExactKeys(value, ["repositoryRoot", "candidateReleaseCommit", "releaseBindingId", "releaseRoleManifestRoot", "predicateCompositionRootDigest"], "artifactLineageStageTwoAuthority");
  const repositoryRoot = readOwnEnumerableDataProperty(value, "repositoryRoot", "artifactLineageStageTwoAuthority");
  if (typeof repositoryRoot !== "string" || !repositoryRoot.startsWith("/") || repositoryRoot.includes("\0")) throw new TypeError("artifact-lineage Stage 2 repository root is invalid");
  return Object.freeze({
    repositoryRoot,
    candidateReleaseCommit: assertGitSha40(readOwnEnumerableDataProperty(value, "candidateReleaseCommit", "artifactLineageStageTwoAuthority"), "artifactLineageStageTwoAuthority.candidateReleaseCommit"),
    releaseBindingId: assertHash(readOwnEnumerableDataProperty(value, "releaseBindingId", "artifactLineageStageTwoAuthority"), "artifactLineageStageTwoAuthority.releaseBindingId"),
    releaseRoleManifestRoot: assertHash(readOwnEnumerableDataProperty(value, "releaseRoleManifestRoot", "artifactLineageStageTwoAuthority"), "artifactLineageStageTwoAuthority.releaseRoleManifestRoot"),
    predicateCompositionRootDigest: assertHash(readOwnEnumerableDataProperty(value, "predicateCompositionRootDigest", "artifactLineageStageTwoAuthority"), "artifactLineageStageTwoAuthority.predicateCompositionRootDigest"),
  });
}

function gitEvidence(value: unknown): GitEvidence {
  assertPlainObject(value, "artifactLineageStageTwoGitEvidence");
  assertExactKeys(value, ["candidateReleaseCommit", "denominatorRoot", "evidenceRoot"], "artifactLineageStageTwoGitEvidence");
  return Object.freeze({
    candidateReleaseCommit: assertGitSha40(readOwnEnumerableDataProperty(value, "candidateReleaseCommit", "artifactLineageStageTwoGitEvidence"), "artifactLineageStageTwoGitEvidence.candidateReleaseCommit"),
    denominatorRoot: assertHash(readOwnEnumerableDataProperty(value, "denominatorRoot", "artifactLineageStageTwoGitEvidence"), "artifactLineageStageTwoGitEvidence.denominatorRoot"),
    evidenceRoot: assertHash(readOwnEnumerableDataProperty(value, "evidenceRoot", "artifactLineageStageTwoGitEvidence"), "artifactLineageStageTwoGitEvidence.evidenceRoot"),
  });
}

function expectedGitEvidenceRoot(owner: Authority, entries: readonly Entry[], artifacts: readonly ObservedContentArtifactV1[]): Hash {
  return hashDomain("aloha/artifact-lineage-stage-two-git-evidence/v1", {
    authority: owner,
    entries: entries.map((entry, index) => Object.freeze({
      path: entry.path,
      blobObjectId: entry.blobObjectId,
      contentSha256: entry.contentSha256,
      byteLength: entry.byteLength,
      artifactRefId: artifacts[index]!.ref.artifactRefId,
    })),
  });
}


function factJoin(artifact: ObservedContentArtifactV1, input: unknown, index: number) {
  const fact = decodeArtifactLineageFactBundle(input as object);
  const raw = encodeArtifactHexBytes(artifact.bytes);
  if (sha256Hex(artifact.bytes) !== artifact.contentSha256 || artifact.ref.contentSha256 !== artifact.contentSha256
    || artifact.ref.byteLength !== String(artifact.bytes.byteLength) || !same(fact.claim.artifactRef, artifact.ref)
    || fact.observation.artifactRefId !== artifact.ref.artifactRefId || fact.observation.rawBytes !== raw
    || fact.observation.contentSha256 !== artifact.contentSha256 || fact.observation.byteLength !== String(artifact.bytes.byteLength)
    || fact.observation.mediaType !== artifact.ref.mediaType || !same(fact.observation.schema, artifact.ref.schema)
    || fact.rawFacts.rawBytes !== raw || fact.rawFacts.mediaType !== artifact.ref.mediaType
    || !same(fact.rawFacts.schema, artifact.ref.schema) || !same(fact.rawFacts.locator, artifact.ref.locator)
    || !same(fact.rawFacts.immutableMirrorLocator, artifact.ref.immutableMirrorLocator)) {
    throw new TypeError(`artifact-lineage Stage 2 artifact/fact positional splice at ${index}`);
  }
  return fact;
}

function manifest(observed: ArtifactLineageStageOneObservationV1, owner: Authority): readonly Entry[] {
  if (observed.artifacts.length !== 6 || observed.predicateFacts.length !== 6) throw new TypeError("artifact-lineage Stage 2 requires exactly six artifacts and six facts");
  const artifacts = new Set<string>(); const claims = new Set<string>(); const observations = new Set<string>();
  for (let i = 0; i < 6; i += 1) {
    const item = observed.artifacts[i]!; const fact = factJoin(item, observed.predicateFacts[i], i);
    if (artifacts.has(item.ref.artifactRefId) || claims.has(fact.claim.claimId) || observations.has(fact.observation.observationId)) throw new TypeError("artifact-lineage Stage 2 duplicate artifact or fact");
    artifacts.add(item.ref.artifactRefId); claims.add(fact.claim.claimId); observations.add(fact.observation.observationId);
  }
  const artifact = observed.artifacts[5]!;
  if (artifact.ref.mediaType !== "application/json" || !same(artifact.ref.schema, MANIFEST_SCHEMA)) throw new TypeError("artifact-lineage Stage 2 manifest media or schema mismatch");
  const decoded = decodeCanonicalJson(artifact.bytes);
  assertPlainObject(decoded, "artifactLineageStageTwoManifest");
  assertExactKeys(decoded, ["schemaVersion", "kind", "candidateReleaseCommit", "releaseBindingId", "releaseRoleManifestRoot", "predicateCompositionRootDigest", "entries", "denominatorRoot"], "artifactLineageStageTwoManifest");
  const value = decoded as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.kind !== "aloha.artifact-lineage-exact-release-denominator"
    || value.candidateReleaseCommit !== owner.candidateReleaseCommit || value.releaseBindingId !== owner.releaseBindingId
    || value.releaseRoleManifestRoot !== owner.releaseRoleManifestRoot || value.predicateCompositionRootDigest !== owner.predicateCompositionRootDigest
    || !sameBytes(artifact.bytes, encodeCanonicalBytes(decoded as never))) throw new TypeError("artifact-lineage Stage 2 manifest identity or canonical bytes mismatch");
  if (!Array.isArray(value.entries) || value.entries.length !== 5) throw new TypeError("artifact-lineage Stage 2 manifest requires exactly five entries");
  const entries = value.entries.map((raw, i): Entry => {
    assertPlainObject(raw, `artifactLineageStageTwoManifest.entries[${i}]`);
    assertExactKeys(raw, ["path", "blobObjectId", "contentSha256", "byteLength", "mediaType", "schema"], `artifactLineageStageTwoManifest.entries[${i}]`);
    const item = raw as Record<string, unknown>; const path = PATHS[i]!; const source = observed.artifacts[i]!;
    const mediaType = path.endsWith(".json") ? "application/json" : "application/typescript";
    if (item.path !== path || typeof item.blobObjectId !== "string" || !/^[0-9a-f]{40}$/.test(item.blobObjectId)
      || item.contentSha256 !== source.contentSha256 || item.byteLength !== String(source.bytes.byteLength)
      || item.mediaType !== mediaType || source.ref.mediaType !== mediaType || !same(item.schema, SOURCE_SCHEMA) || !same(source.ref.schema, SOURCE_SCHEMA)) throw new TypeError(`artifact-lineage Stage 2 manifest entry splice at ${i}`);
    return Object.freeze({ path, blobObjectId: item.blobObjectId, contentSha256: assertHash(item.contentSha256, `entries[${i}].contentSha256`), byteLength: item.byteLength as string, mediaType, schema: SOURCE_SCHEMA });
  });
  const root = hashDomain("aloha/artifact-lineage-exact-release-denominator/v1", { candidateReleaseCommit: owner.candidateReleaseCommit, releaseBindingId: owner.releaseBindingId, releaseRoleManifestRoot: owner.releaseRoleManifestRoot, predicateCompositionRootDigest: owner.predicateCompositionRootDigest, entries });
  if (value.denominatorRoot !== root || observed.denominatorRoot !== root || observed.candidateReleaseCommit !== owner.candidateReleaseCommit) throw new TypeError("artifact-lineage Stage 2 denominator root or candidate splice");
  return Object.freeze(entries);
}


/** Stage 1 supplies bytes, never a verdict; Stage 2 independently verifies them. */
export const ARTIFACT_LINEAGE_MATERIAL_PROVIDER = defineProvider(PREDICATE_ID, async source => {
  const state = readProductionPredicateMaterialSourceStateV1(source);
  if (state.readArtifactLineageStageOne === null || state.readArtifactLineageStageTwoAuthority === null || state.readArtifactLineageStageTwoGit === null) return unavailable(PREDICATE_ID, "missing", "owner-port-missing", "artifact-lineage-stage-one-or-stage-two-owner-port");
  try {
    const before = authority(state.readArtifactLineageStageTwoAuthority());
    const observed = await state.readArtifactLineageStageOne() as ArtifactLineageStageOneObservationV1;
    const entries = manifest(observed, before);
    const evidence = gitEvidence(await state.readArtifactLineageStageTwoGit());
    if (evidence.candidateReleaseCommit !== before.candidateReleaseCommit
      || evidence.denominatorRoot !== observed.denominatorRoot
      || evidence.evidenceRoot !== expectedGitEvidenceRoot(before, entries, observed.artifacts)) {
      throw new TypeError("artifact-lineage Stage 2 Git evidence splice");
    }
    const after = authority(state.readArtifactLineageStageTwoAuthority());
    if (!same(before, after)) throw new TypeError("artifact-lineage Stage 2 current release rotated during verification");
    return available(PREDICATE_ID, before.candidateReleaseCommit, observed.artifacts, [state.sink.resolverPolicy], observed.predicateFacts);
  } catch (error) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "artifact-lineage-stage-two");
  }
});
