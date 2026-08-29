import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type {
  CallerAuthority,
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
  QualifiedExecutorAuthorityProvenanceV1,
} from "../../../../packages/scheduler/src/index.ts";
import { WorkScheduler } from "../../../../packages/scheduler/src/index.ts";
import type { CapabilityWorkIntentV1, WorkPlaneCallerCapabilityV1 } from "../index.ts";

export interface WorkPlaneCallerCapabilityStateV1 {
  readonly scheduler: WorkScheduler;
  readonly intentBindingHash: Hash;
  readonly caller: Readonly<CallerAuthority>;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly executorCapability: QualifiedExecutorAuthorityCapability;
  readonly provenance: QualifiedExecutorAuthorityProvenanceV1;
}

const issued = new WeakMap<object, WorkPlaneCallerCapabilityStateV1>();

export function workPlaneCallerIntentBindingHash(intent: CapabilityWorkIntentV1): Hash {
  return hashDomain("aloha/work-plane-caller-intent-binding/v1", intent);
}

export function registerWorkPlaneCallerCapability(
  capability: WorkPlaneCallerCapabilityV1,
  state: WorkPlaneCallerCapabilityStateV1,
): void {
  if (issued.has(capability)) throw new TypeError("work-plane caller capability is already issued");
  issued.set(capability, Object.freeze({
    scheduler: state.scheduler,
    intentBindingHash: state.intentBindingHash,
    caller: Object.freeze({ ...state.caller }),
    issuer: state.issuer,
    executorCapability: state.executorCapability,
    provenance: Object.freeze({ ...state.provenance }),
  }));
}

export function readWorkPlaneCallerCapability(
  capability: unknown,
): WorkPlaneCallerCapabilityStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("work-plane caller capability is not owner-issued");
  }
  const state = issued.get(capability);
  if (state === undefined) throw new TypeError("work-plane caller capability is not owner-issued");
  const current = state.issuer.provenance(state.executorCapability);
  if (
    current.authorityRoot !== state.provenance.authorityRoot
    || current.workerEpoch !== state.provenance.workerEpoch
    || current.executorSession !== state.provenance.executorSession
    || current.version !== state.provenance.version
  ) throw new TypeError("work-plane caller capability is stale");
  return state;
}
