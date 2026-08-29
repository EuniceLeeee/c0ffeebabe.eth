import type { BoundaryReceipt } from "../../../architecture-boundaries/src/index.ts";
import type {
  PreReleaseBReadyFactsV1,
  PreReleaseControllerDatabaseSnapshotPublicationV1,
} from "../../../pre-release-restart-controller/src/durable-owner.ts";
import type {
  PreReleaseControllerDirectorySnapshotV1,
  PreReleaseControllerFrozenStateProofV1,
  PreReleaseControllerPhysicalFileSnapshotV1,
  PreReleaseControllerProcessObservationV1,
  PreReleaseControllerSystemdObservationV1,
} from "../../../pre-release-restart-controller/src/spec.ts";
import type {
  DurablePreReleaseAuthorizationClaimV1,
  PreReleaseStagingArtifactIdentityV1,
  PreReleaseStagingArtifactNameV1,
} from "../pre-release-staging-contract.ts";
import type {
  PreReleaseLaunchAuthorizationV1,
  PreReleaseStagingManifestV1,
} from "./pre-release-staging-schema.ts";
import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";

export type FrozenPreReleaseBQualificationCapabilityV1 = object;

export interface FrozenPreReleaseBQualificationStateV1 {
  readonly boundaryReceipt: BoundaryReceipt;
  readonly authorization: PreReleaseLaunchAuthorizationV1;
  readonly authorizationClaim: DurablePreReleaseAuthorizationClaimV1;
  readonly manifest: PreReleaseStagingManifestV1;
  readonly stagingArtifacts: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly stagingArtifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;
  readonly ready: PreReleaseBReadyFactsV1;
  readonly systemd: PreReleaseControllerSystemdObservationV1;
  readonly process: PreReleaseControllerProcessObservationV1;
  readonly frozen: PreReleaseControllerFrozenStateProofV1;
  readonly snapshots: Readonly<{
    readonly processEvidence: PreReleaseControllerDatabaseSnapshotPublicationV1;
    readonly checkpoint: PreReleaseControllerDatabaseSnapshotPublicationV1;
    readonly observerContent: PreReleaseControllerDirectorySnapshotV1;
    readonly terminalLocators: PreReleaseControllerDirectorySnapshotV1;
    readonly sixStepEvidenceLog: PreReleaseControllerPhysicalFileSnapshotV1;
    readonly sixStepBoundaries: PreReleaseControllerDirectorySnapshotV1;
    readonly snapshotRoot: Hash;
  }>;
  readonly log: Readonly<{
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly startInclusive: string;
    readonly endExclusive: string;
    readonly contentSha256: Hash;
  }>;
}

const qualifications = new WeakMap<object, FrozenPreReleaseBQualificationStateV1>();

/** Final-runner-only registrar. Boundary fixes the sole importer; possession
 * of a structurally equal object never recovers the retained observations. */
export function issueFrozenPreReleaseBQualificationCapabilityV1(
  state: FrozenPreReleaseBQualificationStateV1,
): FrozenPreReleaseBQualificationCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as FrozenPreReleaseBQualificationCapabilityV1;
  qualifications.set(capability, Object.freeze({ ...state }));
  return capability;
}

/** Staging-owner-only reader. The state deliberately retains the genuine
 * in-process Boundary receipt and opaque root observation lineage. */
export function readFrozenPreReleaseBQualificationCapabilityV1(
  capability: FrozenPreReleaseBQualificationCapabilityV1,
): FrozenPreReleaseBQualificationStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("frozen pre-release B qualification capability is invalid");
  }
  const state = qualifications.get(capability);
  if (state === undefined) {
    throw new TypeError("frozen pre-release B qualification capability was not final-runner-issued");
  }
  return state;
}
