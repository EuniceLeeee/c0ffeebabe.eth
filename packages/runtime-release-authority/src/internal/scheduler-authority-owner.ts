import {
  assertQualifiedExecutorRegistry,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
  type QualifiedExecutorAuthorityOpenInput,
  type QualifiedExecutorAuthorityProvenanceV1,
  type QualifiedExecutorWorkerBindingV1,
} from "../../../../packages/scheduler/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-owner.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-consumer.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";

interface SchedulerAuthorityStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly implementation: QualifiedExecutorAuthorityIssuer;
  readonly version: bigint;
  revoked: boolean;
}

const states = new WeakMap<object, SchedulerAuthorityStateV1>();

function sameWorker(left: QualifiedExecutorWorkerBindingV1, right: QualifiedExecutorWorkerBindingV1): boolean {
  // The release selects the executor implementation; the process owner may
  // issue a fresh worker epoch for a replacement without re-signing the
  // entire release binding.  Epoch/session freshness is checked by the
  // implementation issuer provenance below.
  return left.executorKind === right.executorKind
    && left.engineBuildFingerprint === right.engineBuildFingerprint
    && left.executableFingerprint === right.executableFingerprint
    && left.closureFingerprint === right.closureFingerprint
    && left.protocolFingerprint === right.protocolFingerprint
    && left.schemaFingerprint === right.schemaFingerprint
    && left.releaseRoleManifestRoot === right.releaseRoleManifestRoot
    && left.candidateCommit === right.candidateCommit;
}

function selectedWorker(authority: RuntimeReleaseAuthorityV1): QualifiedExecutorWorkerBindingV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authority);
  return Object.freeze({ workerEpoch: state.binding.workerEpoch, ...state.binding.selectedExecutor });
}

function assertCurrent(state: SchedulerAuthorityStateV1): void {
  if (state.revoked) throw new TypeError("qualified executor authority revoked");
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version) throw new TypeError("qualified executor authority stale after runtime release rotation");
  if (state.implementation.registryRoot !== current.binding.qualifiedExecutorRegistryRoot
    || state.implementation.authorityRoot !== current.binding.executorAuthorityRoot) {
    throw new TypeError("qualified executor implementation is not bound to the current runtime release");
  }
}

function assertProvenance(state: SchedulerAuthorityStateV1, capability: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 {
  assertCurrent(state);
  const provenance = state.implementation.assert(capability);
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (provenance.authorityRoot !== current.binding.executorAuthorityRoot
    || provenance.workerEpoch.length === 0
    || provenance.executorSession.length === 0) {
    throw new TypeError("qualified executor provenance is not release-bound");
  }
  return provenance;
}

/**
 * The capability handed to bootstrap is the deployment-created initial
 * capability for the signed release.  Matching roots are not enough here:
 * an implementation may legitimately have several live capabilities under
 * the same authority (for example a replacement worker or a different
 * epoch).  Accepting any of those at bootstrap would let the caller splice a
 * different worker/session into the release lineage before Family execution
 * starts.
 *
 * Keep this check on the release owner side of the boundary.  The public
 * scheduler contract intentionally has no knowledge of RuntimeReleaseBinding;
 * only this owner may join the two contracts.
 */
export function assertRuntimeReleaseQualifiedExecutorAuthorityInitialCapability(
  authorityValue: unknown,
  schedulerIssuerValue: unknown,
  capability: QualifiedExecutorAuthorityCapability,
): QualifiedExecutorAuthorityProvenanceV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const issuer = assertRuntimeReleaseQualifiedExecutorAuthorityIssuerBoundTo(schedulerIssuerValue, authority);
  const provenance = issuer.provenance(capability);
  if (
    provenance.authorityRoot !== authorityState.binding.executorAuthorityRoot
    || provenance.workerEpoch !== authorityState.binding.workerEpoch
    || provenance.executorSession !== authorityState.binding.executorSessionHash
  ) {
    throw new TypeError("scheduler initial capability does not exactly match signed runtime release worker/session");
  }
  return provenance;
}

/**
 * Release composition wrapper for Scheduler. The implementation issuer is
 * supplied by deployment packaging; this owner only proves it is bound to
 * the verified runtime release and fences every call against rotation.
 */
export function issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(
  authorityValue: unknown,
  implementationValue: unknown,
): QualifiedExecutorAuthorityIssuer {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const implementation = assertIssuedQualifiedExecutorAuthorityIssuer(implementationValue);
  if (implementation.registryRoot !== authorityState.binding.qualifiedExecutorRegistryRoot
    || implementation.authorityRoot !== authorityState.binding.executorAuthorityRoot) {
    throw new TypeError("qualified executor issuer does not match runtime release registry/authority");
  }
  const state: SchedulerAuthorityStateV1 = { authority, implementation, version: authorityState.version, revoked: false };
  const issuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: implementation.registryRoot,
    authorityRoot: implementation.authorityRoot,
    open(input: QualifiedExecutorAuthorityOpenInput): QualifiedExecutorAuthorityCapability {
      assertCurrent(state);
      if (!input || typeof input !== "object" || !sameWorker(input.worker, selectedWorker(authority))) {
        throw new TypeError("qualified worker is not the selected runtime executor");
      }
      const capability = implementation.open(input);
      assertProvenance(state, capability);
      return capability;
    },
    rotate(input: QualifiedExecutorAuthorityOpenInput | QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityCapability {
      assertCurrent(state);
      if (typeof input === "object" && input !== null && "worker" in input) {
        const worker = (input as QualifiedExecutorAuthorityOpenInput).worker;
        if (!sameWorker(worker, selectedWorker(authority))) throw new TypeError("qualified worker rotation is not release-bound");
      }
      const capability = implementation.rotate(input);
      assertProvenance(state, capability);
      return capability;
    },
    revoke(capability?: QualifiedExecutorAuthorityCapability): void {
      assertCurrent(state);
      if (capability !== undefined) assertProvenance(state, capability);
      state.revoked = true;
      implementation.revoke(capability);
    },
    assert(capability: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 {
      return assertProvenance(state, capability);
    },
    provenance(capability: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 {
      return assertProvenance(state, capability);
    },
  }));
  states.set(issuer as object, state);
  return issuer;
}

export function isRuntimeReleaseQualifiedExecutorAuthorityIssuer(value: unknown): boolean {
  return value !== null && typeof value === "object" && states.has(value);
}

/** Exact owner join for downstream worker authorities; roots alone are not enough. */
export function assertRuntimeReleaseQualifiedExecutorAuthorityIssuerBoundTo(
  value: unknown,
  authorityValue: unknown,
): QualifiedExecutorAuthorityIssuer {
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(value);
  const state = states.get(issuer as object);
  if (!state || state.authority !== authorityValue) {
    throw new TypeError("qualified executor issuer belongs to a different runtime release");
  }
  assertCurrent(state);
  return issuer;
}
