import type {
  InstancePublicationV1,
  StaticTransitionProjectionV1,
} from "../../../catalog/src/index.ts";
import {
  assertGeneratedFamilyRuntimeComposition,
  type FamilyRehydrationSessionV1,
} from "../../../family-composition/src/index.ts";
import type {
  RehydrationRefV1,
  RouteHandleIssuerPort,
} from "../../../graph/src/index.ts";
import type { Hash } from "../../../canonical-codec/src/index.ts";

/**
 * Build the Graph port from the same generated Family composition that owns
 * runtime rehydration.  The central startup package only sees generic route
 * fields; it never selects a Family or imports a Family definition.
 */
export function createGeneratedRouteHandleIssuer(value: unknown): RouteHandleIssuerPort {
  assertGeneratedFamilyRuntimeComposition(value);
  const composition = value;
  const sessions = new Map<Hash, FamilyRehydrationSessionV1>();
  return Object.freeze({
    issueRouteHandle(
      publication: InstancePublicationV1,
      projection: StaticTransitionProjectionV1,
      ref: RehydrationRefV1,
    ) {
      let session = sessions.get(publication.familyDefinitionHash);
      if (session === undefined) {
        session = composition.openRehydrationSession(publication.familyDefinitionHash);
        sessions.set(publication.familyDefinitionHash, session);
      }
      return composition.rehydrateRouteHandle(
        session,
        {
          familyId: publication.familyId,
          familyDefinitionHash: publication.familyDefinitionHash,
          instanceKey: publication.instanceKey,
          identityMemo: publication.identityMemo,
          identityMemoHash: publication.identityMemoHash,
          instancePublicationHash: publication.instancePublicationHash,
          staticProjectionMemoHash: publication.staticProjectionMemoHash,
          requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
        },
        {
          staticProjectionHash: projection.staticProjectionHash,
          projectionHash: projection.projectionHash,
        },
        {
          familyDefinitionHash: ref.familyDefinitionHash,
          instanceKey: ref.instanceKey,
          instancePublicationHash: ref.instancePublicationHash,
          staticProjectionMemoHash: ref.staticProjectionMemoHash,
          requestedArtifactDependencyRoot: ref.requestedArtifactDependencyRoot,
        },
      );
    },
  });
}
