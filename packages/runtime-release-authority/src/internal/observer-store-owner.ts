import {
  issueReleaseOwnedObserverStoreV1,
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import { assertExactKeys, hashDomain, readOwnEnumerableDataProperty, type Hash } from "../../../canonical-codec/src/index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";

export interface RuntimeReleaseObserverStoreServiceV1 {
  readonly issueObserverStore: (input: RuntimeReleaseObserverStoreInputV1) => ReleaseOwnedObserverStoreCapabilityV1;
}

export interface RuntimeReleaseObserverStoreInputV1 {
  readonly directory: string;
}

export interface RuntimeReleaseObserverStoreBindingV1 {
  readonly bindingId: string;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: string;
}

const services = new WeakMap<object, Readonly<{
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly bindingId: string;
}>>();

const storeOwners = new WeakMap<object, Readonly<{
  readonly service: RuntimeReleaseObserverStoreServiceV1;
  readonly version: bigint;
  readonly bindingId: string;
}>>();

export function runtimeReleaseObserverStoreEpochV1(bindingId: Hash): string {
  return BigInt(bindingId).toString(10);
}

export function runtimeReleaseObserverStoreIdentityV1(
  bindingInput: RuntimeReleaseBindingV1,
  directory: string,
): Hash {
  const binding = decodeRuntimeReleaseBindingV1(bindingInput);
  const observedStoreEpoch = runtimeReleaseObserverStoreEpochV1(binding.bindingId);
  return hashDomain("aloha/release-owned-observer-store-authority/v1", {
    bindingId: binding.bindingId,
    releaseAuthorityApprovalId: binding.releaseAuthorityApprovalId,
    qualificationRegistryRoot: binding.qualificationRegistryRoot,
    predicateCompositionRootDigest: binding.predicateCompositionRootDigest,
    releaseRoleManifestRoot: binding.releaseRoleManifestRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    directory,
    observedStoreEpoch,
  });
}

function current(service: RuntimeReleaseObserverStoreServiceV1) {
  const issued = services.get(service);
  if (issued === undefined) throw new TypeError("runtime-release observer store service was not issued");
  const state = assertActiveRuntimeReleaseAuthorityState(issued.authority);
  if (state.version !== issued.version || state.binding.bindingId !== issued.bindingId) {
    throw new TypeError("runtime-release observer store service is stale");
  }
  return state;
}

/** Lightweight runtime-bundle seam. It issues only the release-owned content
 * store and intentionally imports no Git/repository predicate observers. */
export function issueRuntimeReleaseObserverStoreServiceV1(
  authority: RuntimeReleaseAuthorityV1,
): RuntimeReleaseObserverStoreServiceV1 {
  const initial = assertActiveRuntimeReleaseAuthorityState(authority);
  let service: RuntimeReleaseObserverStoreServiceV1;
  service = Object.freeze({
    issueObserverStore(input: RuntimeReleaseObserverStoreInputV1) {
      const before = current(service);
      assertExactKeys(input, ["directory"], "runtimeReleaseObserverStore");
      const directory = readOwnEnumerableDataProperty(
        input,
        "directory",
        "runtimeReleaseObserverStore",
      ) as string;
      const observedStoreEpoch = runtimeReleaseObserverStoreEpochV1(before.binding.bindingId);
      const store = issueReleaseOwnedObserverStoreV1({
        directory,
        observedStoreEpoch,
        authority: {
          bindingId: before.binding.bindingId,
          releaseAuthorityApprovalId: before.binding.releaseAuthorityApprovalId,
          qualificationRegistryRoot: before.binding.qualificationRegistryRoot,
          predicateCompositionRootDigest: before.binding.predicateCompositionRootDigest,
          releaseRoleManifestRoot: before.binding.releaseRoleManifestRoot,
          candidateReleaseCommit: before.binding.candidateReleaseCommit,
        },
      });
      const after = current(service);
      if (after.version !== before.version || after.binding.bindingId !== before.binding.bindingId) {
        throw new TypeError("runtime-release authority changed while issuing the observer store");
      }
      storeOwners.set(store, Object.freeze({
        service,
        version: after.version,
        bindingId: after.binding.bindingId,
      }));
      return store;
    },
  });
  services.set(service, Object.freeze({
    authority,
    version: initial.version,
    bindingId: initial.binding.bindingId,
  }));
  return service;
}

export function assertIssuedRuntimeReleaseObserverStoreServiceV1(
  service: RuntimeReleaseObserverStoreServiceV1,
): void {
  current(service);
}

export function assertRuntimeReleaseObserverStoreOwnedByServiceV1(
  service: RuntimeReleaseObserverStoreServiceV1,
  store: ReleaseOwnedObserverStoreCapabilityV1,
): void {
  const state = current(service);
  const owner = storeOwners.get(store);
  if (owner === undefined
    || owner.service !== service
    || owner.version !== state.version
    || owner.bindingId !== state.binding.bindingId) {
    throw new TypeError("runtime-release observer store belongs to another or stale release");
  }
  readReleaseOwnedObserverStoreV1(store);
}

export function readRuntimeReleaseObserverStoreBindingV1(
  service: RuntimeReleaseObserverStoreServiceV1,
): RuntimeReleaseObserverStoreBindingV1 {
  const state = current(service);
  return Object.freeze({
    bindingId: state.binding.bindingId,
    candidateReleaseCommit: state.binding.candidateReleaseCommit,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(state.binding),
  });
}
