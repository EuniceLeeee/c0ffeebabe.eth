import { assertHash, hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { validateInstancePublication, type InstancePublicationV1, type StaticTransitionProjectionV1 } from "../../../../packages/catalog/src/index.ts";
import { UNIV2_STANDARD_FAMILY_DEFINITION_HASH, UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT } from "../family-definition.ts";

export interface UniV2RouteHandleV1 {
  readonly opaque: object;
}

export interface UniV2RehydrationRefV1 {
  readonly familyDefinitionHash: Hash;
  readonly instanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
}

/**
 * Runtime release composition owns this port.  The Family never constructs
 * an authority from serialized publication fields; it can only ask the
 * current authority to issue or rehydrate a process-local handle.
 */
export interface UniV2RouteHandleAuthorityPort {
  readonly authorityRoot: Hash;
  issueRouteHandle(input: {
    readonly publication: InstancePublicationV1;
    readonly transition: StaticTransitionProjectionV1;
    readonly rehydrationRef: UniV2RehydrationRefV1;
  }): UniV2RouteHandleV1;
  rehydrateRouteHandle(input: {
    readonly publication: InstancePublicationV1;
    readonly transition: StaticTransitionProjectionV1;
    readonly rehydrationRef: UniV2RehydrationRefV1;
  }): UniV2RouteHandleV1;
  assertOwnedRouteHandle(input: {
    readonly handle: UniV2RouteHandleV1;
    readonly publication: InstancePublicationV1;
    readonly transition: StaticTransitionProjectionV1;
    readonly rehydrationRef: UniV2RehydrationRefV1;
  }): void;
}

export function makeUniV2RehydrationRef(publication: InstancePublicationV1): UniV2RehydrationRefV1 {
  if (publication.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new Error("univ2-publication-family-mismatch");
  if (publication.requestedArtifactDependencyRoot !== UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT) throw new Error("univ2-publication-dependency-root-mismatch");
  return Object.freeze({
    familyDefinitionHash: publication.familyDefinitionHash,
    instanceKey: publication.instanceKey,
    instancePublicationHash: publication.instancePublicationHash,
    staticProjectionMemoHash: publication.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
  });
}

function sameRef(left: UniV2RehydrationRefV1, right: UniV2RehydrationRefV1): boolean {
  return left.familyDefinitionHash === right.familyDefinitionHash
    && left.instanceKey === right.instanceKey
    && left.instancePublicationHash === right.instancePublicationHash
    && left.staticProjectionMemoHash === right.staticProjectionMemoHash
    && left.requestedArtifactDependencyRoot === right.requestedArtifactDependencyRoot;
}

export function routeHandleBindingHash(
  publication: InstancePublicationV1,
  transition: StaticTransitionProjectionV1,
  rehydrationRef: UniV2RehydrationRefV1,
  authorityRoot: Hash,
): Hash {
  return hashDomain("aloha/univ2-standard/route-handle-binding/v1", {
    authorityRoot: assertHash(authorityRoot, "authorityRoot"),
    publicationHash: publication.instancePublicationHash,
    transitionHash: transition.projectionHash,
    rehydrationRef,
  });
}

function findTransition(
  publication: InstancePublicationV1,
  transition: StaticTransitionProjectionV1,
): StaticTransitionProjectionV1 {
  const found = publication.transitions.find(value => value.projectionHash === transition.projectionHash);
  if (!found) throw new Error("univ2-transition-not-in-publication");
  return found;
}

function assertRehydrationInputs(
  publication: InstancePublicationV1,
  transition: StaticTransitionProjectionV1,
  rehydrationRef: UniV2RehydrationRefV1,
): StaticTransitionProjectionV1 {
  validateInstancePublication(publication);
  const expected = makeUniV2RehydrationRef(publication);
  if (!sameRef(expected, rehydrationRef)) throw new Error("univ2-rehydration-ref-mismatch");
  const found = findTransition(publication, transition);
  if (found.projectionHash !== transition.projectionHash) throw new Error("univ2-transition-hash-mismatch");
  return found;
}

export function issueUniV2RouteHandle(input: {
  readonly authority: UniV2RouteHandleAuthorityPort;
  readonly publication: InstancePublicationV1;
  readonly transition: StaticTransitionProjectionV1;
}): UniV2RouteHandleV1 {
  const rehydrationRef = makeUniV2RehydrationRef(input.publication);
  const transition = assertRehydrationInputs(input.publication, input.transition, rehydrationRef);
  const handle = input.authority.issueRouteHandle({ publication: input.publication, transition, rehydrationRef });
  input.authority.assertOwnedRouteHandle({ handle, publication: input.publication, transition, rehydrationRef });
  return handle;
}

export function rehydrateUniV2RouteHandle(input: {
  readonly authority: UniV2RouteHandleAuthorityPort;
  readonly publication: InstancePublicationV1;
  readonly transition: StaticTransitionProjectionV1;
  readonly rehydrationRef: UniV2RehydrationRefV1;
}): UniV2RouteHandleV1 {
  const transition = assertRehydrationInputs(input.publication, input.transition, input.rehydrationRef);
  // The returned handle is opaque and process-local.  No handle is derived
  // from the durable publication/ref fields in this function.
  const handle = input.authority.rehydrateRouteHandle({
    publication: input.publication,
    transition,
    rehydrationRef: input.rehydrationRef,
  });
  input.authority.assertOwnedRouteHandle({
    handle,
    publication: input.publication,
    transition,
    rehydrationRef: input.rehydrationRef,
  });
  return handle;
}
