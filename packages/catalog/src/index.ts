import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
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
  return deepFreeze({
    ...payload,
    instancePublicationHash: hashDomain("aloha/instance-publication/v1", payload),
  });
}

export function sealInstanceCatalog(
  cutoff: CanonicalCutoffV1,
  publications: readonly InstancePublicationV1[],
): InstanceCatalogV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "instanceCatalogCutoff");
  const decodedPublications = fieldArray(
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
  const instanceCatalogRoot = hashDomain("aloha/instance-catalog/v1", {
    cutoff: decodedCutoff,
    publicationHashes: sorted.map(value => value.instancePublicationHash),
  });
  return deepFreeze({
    cutoff: decodedCutoff,
    publications: sorted,
    instanceCount: String(sorted.length),
    instanceCatalogRoot,
  });
}

export function validateInstancePublication(publication: InstancePublicationV1): void {
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
}

export function validateInstanceCatalog(catalog: InstanceCatalogV1): void {
  const decoded = decodeExactObject(catalog, {
    cutoff: (value, path) => decodeCanonicalCutoff(value, path),
    publications: (value, path) => fieldArray(value, (item, itemPath) => decodePublication(item, itemPath), path),
    instanceCount: (value, path) => assertDecimalString(value, path),
    instanceCatalogRoot: (value, path) => assertHash(value, path),
  }, "instanceCatalog");
  const resealed = sealInstanceCatalog(decoded.cutoff, decoded.publications);
  if (
    resealed.instanceCatalogRoot !== decoded.instanceCatalogRoot
    || resealed.instanceCount !== decoded.instanceCount
  ) throw new Error("instance-catalog-root-mismatch");
}
