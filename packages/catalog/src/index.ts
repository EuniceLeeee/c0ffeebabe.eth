import { types as nodeTypes } from "node:util";
import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalBytes,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  hashCanonicalPartition,
  sha256Hex,
  type Hash,
  type CanonicalJson,
} from "../../canonical-codec/src/index.ts";
import { decodeCanonicalCutoff, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import {
  assertAssetReferenceMatchesV1,
  decodeAssetIdentityV1,
  type AssetIdentityV1,
} from "../../asset-ref/src/index.ts";

export interface AssetPortV1 {
  readonly assetIdentity: AssetIdentityV1;
  readonly assetRef: Hash;
  readonly portRef: Hash;
  readonly ordinal: string;
}

export interface StaticTransitionProjectionDraftV1 {
  readonly inputAssetPorts: readonly AssetPortV1[];
  readonly outputAssetPorts: readonly AssetPortV1[];
  readonly opaqueTransitionRef: Hash;
  readonly constraintRefs: readonly Hash[];
  readonly staticProjectionHash: Hash;
}

export interface StaticTransitionProjectionV1 extends StaticTransitionProjectionDraftV1 {
  readonly projectionHash: Hash;
}

export interface InstancePublicationDraftV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceKey: string;
  readonly cutoff: CanonicalCutoffV1;
  /** Family-owned canonical value. Central code persists and hashes it but never interprets it. */
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
  readonly validityDependencyRoot: Hash;
  readonly transitions: readonly StaticTransitionProjectionDraftV1[];
  readonly evidenceRoot: Hash;
}

export interface InstancePublicationV1 extends Omit<InstancePublicationDraftV1, "transitions"> {
  readonly transitions: readonly StaticTransitionProjectionV1[];
  readonly instancePublicationHash: Hash;
}

export interface InstanceCatalogV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly publications: readonly InstancePublicationV1[];
  readonly instanceCount: string;
  readonly instanceCatalogRoot: Hash;
}

export interface InstanceCatalogPublicationChunkRefV1 {
  readonly contentSha256: Hash;
}

export interface InstanceCatalogPublicationChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.instance-catalog-publication-chunk-v1";
  readonly publications: readonly InstancePublicationV1[];
  readonly nextPublicationChunkRef: InstanceCatalogPublicationChunkRefV1 | null;
}

export interface InstanceCatalogManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.instance-catalog-manifest-v1";
  readonly cutoff: CanonicalCutoffV1;
  readonly instanceCount: string;
  readonly publicationSequenceRoot: Hash;
  readonly publicationChunkCount: string;
  readonly firstPublicationChunkRef: InstanceCatalogPublicationChunkRefV1 | null;
  readonly instanceCatalogRoot: Hash;
}

export interface EncodedInstanceCatalogV1 {
  readonly manifest: InstanceCatalogManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly chunks: readonly Readonly<{
    readonly ref: InstanceCatalogPublicationChunkRefV1;
    readonly chunk: InstanceCatalogPublicationChunkV1;
    readonly bytes: Uint8Array;
  }>[];
}

const CATALOG_SEQUENCE_FANOUT = 128;
const CATALOG_CHUNK_MAX_ITEMS = 128;
const CATALOG_CHUNK_MAX_BYTES = 500_000;
const ownerSealedPublications = new WeakSet<object>();
const ownerSealedCatalogs = new WeakSet<object>();

/** Process-local materialized catalogs are intentionally larger than one wire value. */
function materializedArray<T>(
  value: unknown,
  item: (value: unknown, path: string) => T,
  path: string,
): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError(`expected array at ${path}`);
  if (nodeTypes.isProxy(value)) throw new TypeError(`Proxy arrays are not accepted at ${path}`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol"
      || (key !== "length" && (!/^\d+$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError(`array has extra property at ${path}.${String(key)}`);
    }
  }
  const output: T[] = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`sparse or accessor array item at ${itemPath}`);
    }
    output[index] = item(descriptor.value, itemPath);
  }
  return deepFreeze(output);
}

function publicationSequenceRoot(publications: readonly InstancePublicationV1[]): Hash {
  return hashCanonicalPartition(
    "aloha/instance-catalog-publication-sequence/v1",
    publications.map(value => value.instancePublicationHash),
    CATALOG_SEQUENCE_FANOUT,
  );
}

function catalogSemanticRoot(
  cutoff: CanonicalCutoffV1,
  instanceCount: string,
  sequenceRoot: Hash,
): Hash {
  return hashDomain("aloha/instance-catalog/v2", {
    cutoff,
    instanceCount,
    publicationSequenceRoot: sequenceRoot,
  });
}

const decodeAssetPort = (value: unknown, name = "assetPort"): AssetPortV1 => decodeExactObject(value, {
  assetIdentity: (field, path) => decodeAssetIdentityV1(field, path),
  assetRef: (field, path) => assertHash(field, path),
  portRef: (field, path) => assertHash(field, path),
  ordinal: (field, path) => assertDecimalString(field, path),
}, name);

const decodeProjectionDraft = (
  value: unknown,
  name = "transitionProjection",
): StaticTransitionProjectionDraftV1 => decodeExactObject(value, {
  inputAssetPorts: (field, path) => fieldArray(field, (item, itemPath) => decodeAssetPort(item, itemPath), path),
  outputAssetPorts: (field, path) => fieldArray(field, (item, itemPath) => decodeAssetPort(item, itemPath), path),
  opaqueTransitionRef: (field, path) => assertHash(field, path),
  constraintRefs: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
  staticProjectionHash: (field, path) => assertHash(field, path),
}, name);

const decodeSealedProjection = (
  value: unknown,
  name = "sealedTransitionProjection",
): StaticTransitionProjectionV1 => decodeExactObject(value, {
  inputAssetPorts: (field, path) => fieldArray(field, (item, itemPath) => decodeAssetPort(item, itemPath), path),
  outputAssetPorts: (field, path) => fieldArray(field, (item, itemPath) => decodeAssetPort(item, itemPath), path),
  opaqueTransitionRef: (field, path) => assertHash(field, path),
  constraintRefs: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
  staticProjectionHash: (field, path) => assertHash(field, path),
  projectionHash: (field, path) => assertHash(field, path),
}, name);

const projection = (draft: unknown, name = "transitionProjection"): StaticTransitionProjectionV1 => {
  const decoded = decodeProjectionDraft(draft, name);
  if (decoded.inputAssetPorts.length === 0 || decoded.outputAssetPorts.length === 0) {
    throw new Error("transition-missing-asset-ports");
  }
  const inputAssetPorts = decoded.inputAssetPorts.map((assetPort, index) => {
    assertAssetReferenceMatchesV1(assetPort.assetIdentity, assetPort.assetRef, `${name}.inputAssetPorts[${index}]`);
    return deepFreeze({ ...assetPort, assetIdentity: assetPort.assetIdentity });
  });
  const outputAssetPorts = decoded.outputAssetPorts.map((assetPort, index) => {
    assertAssetReferenceMatchesV1(assetPort.assetIdentity, assetPort.assetRef, `${name}.outputAssetPorts[${index}]`);
    return deepFreeze({ ...assetPort, assetIdentity: assetPort.assetIdentity });
  });
  const constraintRefs = [...decoded.constraintRefs];
  if (new Set(constraintRefs).size !== constraintRefs.length) throw new Error("duplicate-constraint-ref");
  constraintRefs.sort();
  const payload = {
    inputAssetPorts,
    outputAssetPorts,
    opaqueTransitionRef: decoded.opaqueTransitionRef,
    constraintRefs,
    staticProjectionHash: decoded.staticProjectionHash,
  };
  return deepFreeze({ ...payload, projectionHash: hashDomain("aloha/static-transition-projection/v1", payload) });
};

const decodePublicationDraft = (
  value: unknown,
  name = "instancePublication",
): InstancePublicationDraftV1 => decodeExactObject(value, {
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  familyCandidateKey: (field, path) => assertHash(field, path),
  instanceKey: (field, path) => assertNonEmptyString(field, path),
  cutoff: (field, path) => decodeCanonicalCutoff(field, path),
  identityMemo: (field) => decodeCanonicalJson(encodeCanonicalJson(field)),
  identityMemoHash: (field, path) => assertHash(field, path),
  descriptorHash: (field, path) => assertHash(field, path),
  staticProjectionMemoHash: (field, path) => assertHash(field, path),
  requestedArtifactDependencyRoot: (field, path) => assertHash(field, path),
  validityDependencyRoot: (field, path) => assertHash(field, path),
  transitions: (field, path) => fieldArray(field, (item, itemPath) => decodeProjectionDraft(item, itemPath), path),
  evidenceRoot: (field, path) => assertHash(field, path),
}, name);

const decodePublication = (
  value: unknown,
  name = "sealedInstancePublication",
): InstancePublicationV1 => decodeExactObject(value, {
  familyId: (field, path) => assertNonEmptyString(field, path),
  familyDefinitionHash: (field, path) => assertHash(field, path),
  familyCandidateKey: (field, path) => assertHash(field, path),
  instanceKey: (field, path) => assertNonEmptyString(field, path),
  cutoff: (field, path) => decodeCanonicalCutoff(field, path),
  identityMemo: (field) => decodeCanonicalJson(encodeCanonicalJson(field)),
  identityMemoHash: (field, path) => assertHash(field, path),
  descriptorHash: (field, path) => assertHash(field, path),
  staticProjectionMemoHash: (field, path) => assertHash(field, path),
  requestedArtifactDependencyRoot: (field, path) => assertHash(field, path),
  validityDependencyRoot: (field, path) => assertHash(field, path),
  transitions: (field, path) => fieldArray(field, (item, itemPath) => decodeSealedProjection(item, itemPath), path),
  evidenceRoot: (field, path) => assertHash(field, path),
  instancePublicationHash: (field, path) => assertHash(field, path),
}, name);

export function sealInstancePublication(draft: InstancePublicationDraftV1): InstancePublicationV1 {
  const decoded = decodePublicationDraft(draft);
  if (hashDomain("aloha/identity-memo/v1", decoded.identityMemo) !== decoded.identityMemoHash) {
    throw new Error("identity-memo-hash-mismatch");
  }
  const transitions = decoded.transitions.map((value, index) => projection(value, `instancePublication.transitions[${index}]`))
    .sort((left, right) => left.projectionHash < right.projectionHash ? -1 : left.projectionHash > right.projectionHash ? 1 : 0);
  if (new Set(transitions.map(value => value.projectionHash)).size !== transitions.length) {
    throw new Error("duplicate-transition-projection");
  }
  for (const [transitionIndex, transition] of transitions.entries()) {
    for (const [portIndex, port] of [...transition.inputAssetPorts, ...transition.outputAssetPorts].entries()) {
      if (port.assetIdentity.chainId !== decoded.cutoff.chainId) {
        throw new Error(`asset-port-chain-mismatch:${transitionIndex}:${portIndex}`);
      }
    }
  }
  const payload = {
    familyId: decoded.familyId,
    familyDefinitionHash: decoded.familyDefinitionHash,
    familyCandidateKey: decoded.familyCandidateKey,
    instanceKey: decoded.instanceKey,
    cutoff: decoded.cutoff,
    identityMemo: decoded.identityMemo,
    identityMemoHash: decoded.identityMemoHash,
    descriptorHash: decoded.descriptorHash,
    staticProjectionMemoHash: decoded.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: decoded.requestedArtifactDependencyRoot,
    validityDependencyRoot: decoded.validityDependencyRoot,
    transitions,
    evidenceRoot: decoded.evidenceRoot,
  };
  const publication = deepFreeze({
    ...payload,
    instancePublicationHash: hashDomain("aloha/instance-publication/v1", payload),
  });
  ownerSealedPublications.add(publication);
  return publication;
}

export function sealInstanceCatalog(
  cutoff: CanonicalCutoffV1,
  publications: readonly InstancePublicationV1[],
): InstanceCatalogV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "instanceCatalogCutoff");
  const decodedPublications = materializedArray(
    publications,
    (value, path) => decodePublication(value, path),
    "instanceCatalog.publications",
  );
  const byIdentity = new Set<string>();
  const sorted = decodedPublications.map(publication => {
    validateInstancePublication(publication);
    if (
      publication.cutoff.chainId !== decodedCutoff.chainId
      || publication.cutoff.number !== decodedCutoff.number
      || publication.cutoff.hash !== decodedCutoff.hash
      || publication.cutoff.stateRoot !== decodedCutoff.stateRoot
    ) throw new Error("publication-cutoff-mismatch");
    const identity = `${publication.familyDefinitionHash}:${publication.instanceKey}`;
    if (byIdentity.has(identity)) throw new Error(`duplicate-instance-publication:${identity}`);
    byIdentity.add(identity);
    return publication;
  }).sort((left, right) => left.instancePublicationHash < right.instancePublicationHash ? -1 : 1);
  const instanceCount = String(sorted.length);
  const instanceCatalogRoot = catalogSemanticRoot(
    decodedCutoff,
    instanceCount,
    publicationSequenceRoot(sorted),
  );
  const catalog = deepFreeze({
    cutoff: decodedCutoff,
    publications: sorted,
    instanceCount,
    instanceCatalogRoot,
  });
  ownerSealedCatalogs.add(catalog);
  return catalog;
}

export function validateInstancePublication(publication: InstancePublicationV1): void {
  if (publication !== null && typeof publication === "object" && ownerSealedPublications.has(publication)) return;
  const decoded = decodePublication(publication);
  const resealed = sealInstancePublication({
    familyId: decoded.familyId,
    familyDefinitionHash: decoded.familyDefinitionHash,
    familyCandidateKey: decoded.familyCandidateKey,
    instanceKey: decoded.instanceKey,
    cutoff: decoded.cutoff,
    identityMemo: decoded.identityMemo,
    identityMemoHash: decoded.identityMemoHash,
    descriptorHash: decoded.descriptorHash,
    staticProjectionMemoHash: decoded.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: decoded.requestedArtifactDependencyRoot,
    validityDependencyRoot: decoded.validityDependencyRoot,
    transitions: decoded.transitions.map(value => ({
      inputAssetPorts: value.inputAssetPorts,
      outputAssetPorts: value.outputAssetPorts,
      opaqueTransitionRef: value.opaqueTransitionRef,
      constraintRefs: value.constraintRefs,
      staticProjectionHash: value.staticProjectionHash,
    })),
    evidenceRoot: decoded.evidenceRoot,
  });
  if (resealed.instancePublicationHash !== decoded.instancePublicationHash) {
    throw new Error("instance-publication-hash-mismatch");
  }
  if (
    resealed.transitions.length !== decoded.transitions.length
    || resealed.transitions.some((value, index) => value.projectionHash !== decoded.transitions[index]?.projectionHash)
  ) throw new Error("transition-projection-hash-mismatch");
  ownerSealedPublications.add(publication);
}

export function validateInstanceCatalog(catalog: InstanceCatalogV1): void {
  if (catalog !== null && typeof catalog === "object" && ownerSealedCatalogs.has(catalog)) return;
  const decoded = decodeExactObject(catalog, {
    cutoff: (value, path) => decodeCanonicalCutoff(value, path),
    publications: (value, path) => materializedArray(value, (item, itemPath) => decodePublication(item, itemPath), path),
    instanceCount: (value, path) => assertDecimalString(value, path),
    instanceCatalogRoot: (value, path) => assertHash(value, path),
  }, "instanceCatalog");
  const resealed = sealInstanceCatalog(decoded.cutoff, decoded.publications);
  if (
    resealed.instanceCatalogRoot !== decoded.instanceCatalogRoot
    || resealed.instanceCount !== decoded.instanceCount
  ) throw new Error("instance-catalog-root-mismatch");
}

function exactCatalogChunkRef(value: unknown, path: string): InstanceCatalogPublicationChunkRefV1 {
  return decodeExactObject(value, {
    contentSha256: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
}

function buildCatalogChunk(
  publications: readonly InstancePublicationV1[],
  nextPublicationChunkRef: InstanceCatalogPublicationChunkRefV1 | null,
): EncodedInstanceCatalogV1["chunks"][number] {
  const chunk = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.instance-catalog-publication-chunk-v1" as const,
    publications: deepFreeze([...publications]),
    nextPublicationChunkRef,
  });
  const bytes = encodeCanonicalBytes(chunk);
  if (bytes.byteLength > CATALOG_CHUNK_MAX_BYTES) {
    throw new TypeError("instance catalog publication chunk exceeds durable byte cap");
  }
  return Object.freeze({
    chunk,
    bytes: bytes.slice(),
    ref: deepFreeze({
      contentSha256: sha256Hex(bytes),
    }),
  });
}

function encodeCatalogChunks(catalog: InstanceCatalogV1): EncodedInstanceCatalogV1["chunks"] {
  const groups: Array<readonly InstancePublicationV1[]> = Array.from(
    { length: Math.ceil(catalog.publications.length / CATALOG_CHUNK_MAX_ITEMS) },
    (_, index) => catalog.publications.slice(
      index * CATALOG_CHUNK_MAX_ITEMS,
      (index + 1) * CATALOG_CHUNK_MAX_ITEMS,
    ),
  );
  for (;;) {
    const output: Array<EncodedInstanceCatalogV1["chunks"][number]> = new Array(groups.length);
    let next: InstanceCatalogPublicationChunkRefV1 | null = null;
    let failed = -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      try {
        const encoded = buildCatalogChunk(group, next);
        output[index] = encoded;
        next = encoded.ref;
      } catch {
        failed = index;
        break;
      }
    }
    if (failed === -1) return Object.freeze(output.slice());
    const group = groups[failed]!;
    if (group.length <= 1) {
      buildCatalogChunk(group, null);
      throw new TypeError("unreachable instance catalog chunk encoding failure");
    }
    const middle = Math.ceil(group.length / 2);
    groups.splice(failed, 1, group.slice(0, middle), group.slice(middle));
  }
}

export function encodeInstanceCatalogV1(catalog: InstanceCatalogV1): EncodedInstanceCatalogV1 {
  validateInstanceCatalog(catalog);
  const chunks = encodeCatalogChunks(catalog);
  const manifest = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.instance-catalog-manifest-v1" as const,
    cutoff: catalog.cutoff,
    instanceCount: catalog.instanceCount,
    publicationSequenceRoot: publicationSequenceRoot(catalog.publications),
    publicationChunkCount: String(chunks.length),
    firstPublicationChunkRef: chunks[0]?.ref ?? null,
    instanceCatalogRoot: catalog.instanceCatalogRoot,
  });
  const manifestBytes = encodeCanonicalBytes(manifest);
  if (manifestBytes.byteLength > CATALOG_CHUNK_MAX_BYTES) {
    throw new TypeError("instance catalog manifest exceeds durable byte cap");
  }
  return Object.freeze({ manifest, manifestBytes: manifestBytes.slice(), chunks });
}

export function decodeInstanceCatalogV1(
  manifestBytes: Uint8Array,
  readChunk: (ref: InstanceCatalogPublicationChunkRefV1) => Uint8Array,
): InstanceCatalogV1 {
  if (manifestBytes.byteLength > CATALOG_CHUNK_MAX_BYTES) {
    throw new TypeError("instance catalog manifest exceeds durable byte cap");
  }
  const manifest = decodeExactObject(decodeCanonicalBytes(manifestBytes), {
    schemaVersion: field => {
      if (field !== 1) throw new TypeError("instance catalog manifest schema version mismatch");
      return 1 as const;
    },
    kind: field => {
      if (field !== "aloha.instance-catalog-manifest-v1") throw new TypeError("instance catalog manifest kind mismatch");
      return "aloha.instance-catalog-manifest-v1" as const;
    },
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    instanceCount: (field, path) => assertDecimalString(field, path),
    publicationSequenceRoot: (field, path) => assertHash(field, path),
    publicationChunkCount: (field, path) => assertDecimalString(field, path),
    firstPublicationChunkRef: (field, path) => field === null ? null : exactCatalogChunkRef(field, path),
    instanceCatalogRoot: (field, path) => assertHash(field, path),
  }, "instanceCatalogManifest");
  const publications: InstancePublicationV1[] = [];
  const refs: InstanceCatalogPublicationChunkRefV1[] = [];
  let ref = manifest.firstPublicationChunkRef;
  while (ref !== null) {
    if (BigInt(refs.length) >= BigInt(manifest.publicationChunkCount)) {
      throw new TypeError("instance catalog publication chunk range mismatch");
    }
    const bytes = readChunk(ref);
    if (bytes.byteLength > CATALOG_CHUNK_MAX_BYTES || sha256Hex(bytes) !== ref.contentSha256) {
      throw new TypeError("instance catalog publication chunk content mismatch");
    }
    const chunk = decodeExactObject(decodeCanonicalBytes(bytes), {
      schemaVersion: field => {
        if (field !== 1) throw new TypeError("instance catalog chunk schema version mismatch");
        return 1 as const;
      },
      kind: field => {
        if (field !== "aloha.instance-catalog-publication-chunk-v1") throw new TypeError("instance catalog chunk kind mismatch");
        return "aloha.instance-catalog-publication-chunk-v1" as const;
      },
      publications: (field, path) => fieldArray(field, (item, itemPath) => decodePublication(item, itemPath), path),
      nextPublicationChunkRef: (field, path) => field === null ? null : exactCatalogChunkRef(field, path),
    }, `instanceCatalogChunk[${refs.length}]`);
    if (chunk.publications.length === 0
      || chunk.publications.length > CATALOG_CHUNK_MAX_ITEMS) {
      throw new TypeError("instance catalog publication chunk binding mismatch");
    }
    refs.push(ref);
    publications.push(...chunk.publications);
    ref = chunk.nextPublicationChunkRef;
  }
  if (manifest.publicationChunkCount !== String(refs.length)
    || manifest.instanceCount !== String(publications.length)
    || (manifest.instanceCount === "0") !== (manifest.firstPublicationChunkRef === null)) {
    throw new TypeError("instance catalog publication chunk denominator incomplete");
  }
  const catalog = sealInstanceCatalog(manifest.cutoff, publications);
  if (publicationSequenceRoot(catalog.publications) !== manifest.publicationSequenceRoot
    || catalog.instanceCatalogRoot !== manifest.instanceCatalogRoot) {
    throw new TypeError("instance catalog manifest semantic root mismatch");
  }
  return catalog;
}
