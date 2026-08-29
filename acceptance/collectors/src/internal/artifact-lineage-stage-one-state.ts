import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ArtifactLineageFactBundleV1 } from "../../../artifact-lineage-facts/src/schema.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "./release-owned-observer-store.ts";

export type ArtifactLineageStageOneCapabilityV1 = object;

export interface ArtifactLineageStageOneObservationV1 {
  readonly candidateReleaseCommit: string;
  readonly denominatorRoot: Hash;
  readonly artifacts: readonly ObservedContentArtifactV1[];
  readonly predicateFacts: readonly ArtifactLineageFactBundleV1[];
}

export interface ProductionArtifactLineageStageOneObserverPortV1 {
  observe(): Promise<ArtifactLineageStageOneCapabilityV1>;
}

interface ArtifactLineageStageOneCapabilityStateV1 {
  readonly store: ReleaseOwnedObserverStoreCapabilityV1;
  readonly assertCurrent: () => void;
  readonly observation: ArtifactLineageStageOneObservationV1;
}

const observations = new WeakMap<object, ArtifactLineageStageOneCapabilityStateV1>();
const issuedPorts = new WeakMap<object, Readonly<{
  readonly store: ReleaseOwnedObserverStoreCapabilityV1;
  readonly repositoryRoot: string;
  readonly assertCurrent: () => void;
}>>();

function cloneArtifact(artifact: ObservedContentArtifactV1): ObservedContentArtifactV1 {
  return Object.freeze({ ...artifact, bytes: Uint8Array.from(artifact.bytes) });
}

export function registerArtifactLineageStageOneCapabilityV1(
  store: ReleaseOwnedObserverStoreCapabilityV1,
  assertCurrent: () => void,
  observation: ArtifactLineageStageOneObservationV1,
): ArtifactLineageStageOneCapabilityV1 {
  readReleaseOwnedObserverStoreV1(store);
  assertCurrent();
  const capability = Object.freeze(Object.create(null)) as object;
  observations.set(capability, Object.freeze({
    store,
    assertCurrent,
    observation: Object.freeze({
      candidateReleaseCommit: observation.candidateReleaseCommit,
      denominatorRoot: observation.denominatorRoot,
      artifacts: Object.freeze(observation.artifacts.map(cloneArtifact)),
      predicateFacts: Object.freeze([...observation.predicateFacts]),
    }),
  }));
  return capability;
}

export function registerArtifactLineageStageOneObserverPortV1(
  store: ReleaseOwnedObserverStoreCapabilityV1,
  repositoryRoot: string,
  assertCurrent: () => void,
  observe: () => Promise<ArtifactLineageStageOneCapabilityV1>,
): ProductionArtifactLineageStageOneObserverPortV1 {
  readReleaseOwnedObserverStoreV1(store);
  let result: Promise<ArtifactLineageStageOneCapabilityV1> | null = null;
  const port: ProductionArtifactLineageStageOneObserverPortV1 = Object.freeze({
    async observe() {
      assertCurrent();
      result ??= observe();
      const capability = await result;
      assertCurrent();
      return capability;
    },
  });
  issuedPorts.set(port, Object.freeze({ store, repositoryRoot, assertCurrent }));
  return port;
}

export function readArtifactLineageStageTwoAuthorityV1(
  port: ProductionArtifactLineageStageOneObserverPortV1,
  store: ReleaseOwnedObserverStoreCapabilityV1,
): Readonly<{
  readonly repositoryRoot: string;
  readonly candidateReleaseCommit: string;
  readonly releaseBindingId: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly predicateCompositionRootDigest: Hash;
}> {
  assertArtifactLineageStageOneObserverStoreV1(port, store);
  const state = issuedPorts.get(port)!;
  state.assertCurrent();
  const authority = readReleaseOwnedObserverStoreV1(store).authority;
  return Object.freeze({
    repositoryRoot: state.repositoryRoot,
    candidateReleaseCommit: authority.candidateReleaseCommit,
    releaseBindingId: authority.bindingId,
    releaseRoleManifestRoot: authority.releaseRoleManifestRoot,
    predicateCompositionRootDigest: authority.predicateCompositionRootDigest,
  });
}

export function assertIssuedProductionArtifactLineageStageOneObserverPortV1(
  value: unknown,
): asserts value is ProductionArtifactLineageStageOneObserverPortV1 {
  if (value === null || typeof value !== "object" || !issuedPorts.has(value)) {
    throw new TypeError("artifact-lineage stage-one observer port was not issued");
  }
}

export function assertArtifactLineageStageOneObserverStoreV1(
  port: ProductionArtifactLineageStageOneObserverPortV1,
  store: ReleaseOwnedObserverStoreCapabilityV1,
): void {
  assertIssuedProductionArtifactLineageStageOneObserverPortV1(port);
  const state = issuedPorts.get(port);
  state!.assertCurrent();
  if (state!.store !== store) {
    throw new TypeError("artifact-lineage stage-one observer belongs to a different release-owned store");
  }
}

export async function readArtifactLineageStageOneCapabilityV1(
  capability: ArtifactLineageStageOneCapabilityV1,
): Promise<ArtifactLineageStageOneObservationV1> {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("artifact-lineage stage-one capability is invalid");
  }
  const state = observations.get(capability);
  if (state === undefined) {
    throw new TypeError("artifact-lineage stage-one capability was not observer-issued");
  }
  state.assertCurrent();
  const sink = readReleaseOwnedObserverStoreV1(state.store).sink;
  const artifacts: ObservedContentArtifactV1[] = [];
  for (const artifact of state.observation.artifacts) {
    const bytes = await sink.readContent(artifact.contentSha256);
    if (bytes.byteLength !== artifact.bytes.byteLength
      || bytes.some((value, index) => value !== artifact.bytes[index])) {
      throw new TypeError("artifact-lineage durable content changed after Stage 1 issuance");
    }
    artifacts.push(Object.freeze({ ...artifact, bytes }));
  }
  state.assertCurrent();
  return Object.freeze({
    candidateReleaseCommit: state.observation.candidateReleaseCommit,
    denominatorRoot: state.observation.denominatorRoot,
    artifacts: Object.freeze(artifacts),
    predicateFacts: state.observation.predicateFacts,
  });
}
