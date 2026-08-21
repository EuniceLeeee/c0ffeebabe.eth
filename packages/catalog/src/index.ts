import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";

export interface AssetPortV1 {
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

function assertExactRecord(value: object, keys: readonly string[], name: string): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key !== "string")) throw new TypeError(`${name} has symbol fields`);
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unknown or missing fields`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${name}.${key} is not data`);
  }
}

function assetPort(port: AssetPortV1): AssetPortV1 {
  assertExactRecord(port, ["assetRef", "portRef", "ordinal"], "assetPort");
  if (!/^(0|[1-9][0-9]*)$/.test(port.ordinal)) throw new TypeError("asset port ordinal is invalid");
  return deepFreeze({ assetRef: port.assetRef, portRef: port.portRef, ordinal: port.ordinal });
}

function projection(draft: StaticTransitionProjectionDraftV1): StaticTransitionProjectionV1 {
  assertExactRecord(draft, [
    "inputAssetPorts",
    "outputAssetPorts",
    "opaqueTransitionRef",
    "constraintRefs",
    "staticProjectionHash",
  ], "transitionProjection");
  if (draft.inputAssetPorts.length === 0 || draft.outputAssetPorts.length === 0) {
    throw new Error("transition-missing-asset-ports");
  }
  const inputAssetPorts = draft.inputAssetPorts.map(assetPort);
  const outputAssetPorts = draft.outputAssetPorts.map(assetPort);
  const constraintRefs = [...draft.constraintRefs];
  if (new Set(constraintRefs).size !== constraintRefs.length) throw new Error("duplicate-constraint-ref");
  constraintRefs.sort();
  const payload = {
    inputAssetPorts,
    outputAssetPorts,
    opaqueTransitionRef: draft.opaqueTransitionRef,
    constraintRefs,
    staticProjectionHash: draft.staticProjectionHash,
  };
  return deepFreeze({ ...payload, projectionHash: hashDomain("aloha/static-transition-projection/v1", payload) });
}

export function sealInstancePublication(draft: InstancePublicationDraftV1): InstancePublicationV1 {
  assertExactRecord(draft, [
    "familyId",
    "familyDefinitionHash",
    "familyCandidateKey",
    "instanceKey",
    "cutoff",
    "identityMemoHash",
    "descriptorHash",
    "staticProjectionMemoHash",
    "requestedArtifactDependencyRoot",
    "validityDependencyRoot",
    "transitions",
    "evidenceRoot",
  ], "instancePublication");
  assertExactRecord(draft.cutoff, ["chainId", "number", "hash", "stateRoot"], "publicationCutoff");
  if (draft.familyId.length === 0 || draft.instanceKey.length === 0) throw new TypeError("publication identity is empty");
  const transitions = draft.transitions.map(projection)
    .sort((left, right) => left.projectionHash < right.projectionHash ? -1 : left.projectionHash > right.projectionHash ? 1 : 0);
  if (new Set(transitions.map(value => value.projectionHash)).size !== transitions.length) {
    throw new Error("duplicate-transition-projection");
  }
  const payload = {
    familyId: draft.familyId,
    familyDefinitionHash: draft.familyDefinitionHash,
    familyCandidateKey: draft.familyCandidateKey,
    instanceKey: draft.instanceKey,
    cutoff: deepFreeze({ ...draft.cutoff }),
    identityMemoHash: draft.identityMemoHash,
    descriptorHash: draft.descriptorHash,
    staticProjectionMemoHash: draft.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: draft.requestedArtifactDependencyRoot,
    validityDependencyRoot: draft.validityDependencyRoot,
    transitions,
    evidenceRoot: draft.evidenceRoot,
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
  const byIdentity = new Set<string>();
  const sorted = publications.map(publication => {
    validateInstancePublication(publication);
    if (
      publication.cutoff.chainId !== cutoff.chainId
      || publication.cutoff.number !== cutoff.number
      || publication.cutoff.hash !== cutoff.hash
      || publication.cutoff.stateRoot !== cutoff.stateRoot
    ) throw new Error("publication-cutoff-mismatch");
    const identity = `${publication.familyDefinitionHash}:${publication.instanceKey}`;
    if (byIdentity.has(identity)) throw new Error(`duplicate-instance-publication:${identity}`);
    byIdentity.add(identity);
    return publication;
  }).sort((left, right) => left.instancePublicationHash < right.instancePublicationHash ? -1 : 1);
  const instanceCatalogRoot = hashDomain("aloha/instance-catalog/v1", {
    cutoff,
    publicationHashes: sorted.map(value => value.instancePublicationHash),
  });
  return deepFreeze({
    cutoff: deepFreeze({ ...cutoff }),
    publications: sorted,
    instanceCount: String(sorted.length),
    instanceCatalogRoot,
  });
}

export function validateInstancePublication(publication: InstancePublicationV1): void {
  assertExactRecord(publication, [
    "familyId",
    "familyDefinitionHash",
    "familyCandidateKey",
    "instanceKey",
    "cutoff",
    "identityMemoHash",
    "descriptorHash",
    "staticProjectionMemoHash",
    "requestedArtifactDependencyRoot",
    "validityDependencyRoot",
    "transitions",
    "evidenceRoot",
    "instancePublicationHash",
  ], "sealedInstancePublication");
  for (const value of publication.transitions) {
    assertExactRecord(value, [
      "inputAssetPorts",
      "outputAssetPorts",
      "opaqueTransitionRef",
      "constraintRefs",
      "staticProjectionHash",
      "projectionHash",
    ], "sealedTransitionProjection");
  }
  const resealed = sealInstancePublication({
    familyId: publication.familyId,
    familyDefinitionHash: publication.familyDefinitionHash,
    familyCandidateKey: publication.familyCandidateKey,
    instanceKey: publication.instanceKey,
    cutoff: publication.cutoff,
    identityMemoHash: publication.identityMemoHash,
    descriptorHash: publication.descriptorHash,
    staticProjectionMemoHash: publication.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
    validityDependencyRoot: publication.validityDependencyRoot,
    transitions: publication.transitions.map(value => ({
      inputAssetPorts: value.inputAssetPorts,
      outputAssetPorts: value.outputAssetPorts,
      opaqueTransitionRef: value.opaqueTransitionRef,
      constraintRefs: value.constraintRefs,
      staticProjectionHash: value.staticProjectionHash,
    })),
    evidenceRoot: publication.evidenceRoot,
  });
  if (resealed.instancePublicationHash !== publication.instancePublicationHash) {
    throw new Error("instance-publication-hash-mismatch");
  }
  if (
    resealed.transitions.length !== publication.transitions.length
    || resealed.transitions.some((value, index) => value.projectionHash !== publication.transitions[index]?.projectionHash)
  ) throw new Error("transition-projection-hash-mismatch");
}

export function validateInstanceCatalog(catalog: InstanceCatalogV1): void {
  assertExactRecord(catalog, ["cutoff", "publications", "instanceCount", "instanceCatalogRoot"], "instanceCatalog");
  const resealed = sealInstanceCatalog(catalog.cutoff, catalog.publications);
  if (
    resealed.instanceCatalogRoot !== catalog.instanceCatalogRoot
    || resealed.instanceCount !== catalog.instanceCount
  ) throw new Error("instance-catalog-root-mismatch");
}
