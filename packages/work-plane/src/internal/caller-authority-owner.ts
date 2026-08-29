import { randomUUID } from "node:crypto";
import { hashDomain } from "../../../../packages/canonical-codec/src/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import {
  readQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  assertCapabilityWorkIntent,
  type CapabilityWorkIntentV1,
  type WorkPlaneCallerCapabilityV1,
} from "../index.ts";
import {
  registerWorkPlaneCallerCapability,
  workPlaneCallerIntentBindingHash,
} from "./caller-authority-state.ts";

/**
 * Owner-only issuer. Production consumers receive only the returned opaque
 * process-local capability; no caller token crosses this edge.
 */
export function issueWorkPlaneCallerCapability(input: {
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly executorCapability: QualifiedExecutorAuthorityCapability;
  readonly intent: CapabilityWorkIntentV1;
}): WorkPlaneCallerCapabilityV1 {
  const scheduler = readQualifiedSharedSchedulerRuntimePort(
    input.schedulerRuntime,
    input.issuer,
    input.executorCapability,
  );
  const provenance = input.issuer.provenance(input.executorCapability);
  assertCapabilityWorkIntent(input.intent);
  const intentBindingHash = workPlaneCallerIntentBindingHash(input.intent);
  const caller = Object.freeze({
    callerId: hashDomain("aloha/work-plane-caller-id/v1", {
      registryRoot: input.issuer.registryRoot,
      provenance,
      intentBindingHash,
    }),
    authorityToken: hashDomain("aloha/work-plane-caller-token/v1", {
      registryRoot: input.issuer.registryRoot,
      provenance,
      intentBindingHash,
      nonce: randomUUID(),
    }),
  });
  const capability = Object.freeze(Object.create(null)) as WorkPlaneCallerCapabilityV1;
  registerWorkPlaneCallerCapability(capability, {
    scheduler,
    intentBindingHash,
    caller,
    issuer: input.issuer,
    executorCapability: input.executorCapability,
    provenance,
  });
  return capability;
}
