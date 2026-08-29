import {
  WorkScheduler,
  createQualifiedExecutorRegistry,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
} from "../../../scheduler/src/index.ts";
import {
  issueQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../scheduler/src/internal/shared-runtime-owner.ts";
import {
  createTestQualifiedExecutorAuthorityIssuer,
  testReleaseApprovalPort,
} from "../../../scheduler/test/fixtures/qualified-release.ts";
import type {
  CapabilityWorkIntentV1,
  WorkPlaneCallerCapabilityV1,
} from "../../src/index.ts";
import { issueWorkPlaneCallerCapability } from "../../src/internal/caller-authority-owner.ts";

interface TestCallerAuthorityStateV1 {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly executorCapability: QualifiedExecutorAuthorityCapability;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
}

const schedulerAuthorities = new WeakMap<WorkScheduler, TestCallerAuthorityStateV1>();

function authorityFor(scheduler: WorkScheduler): TestCallerAuthorityStateV1 {
  const current = schedulerAuthorities.get(scheduler);
  if (current !== undefined) return current;
  const registry = createQualifiedExecutorRegistry({
    executorKind: "revm",
    engineBuildFingerprint: "0x1111111111111111111111111111111111111111111111111111111111111111",
    executableFingerprint: "0x2222222222222222222222222222222222222222222222222222222222222222",
    closureFingerprint: "0x3333333333333333333333333333333333333333333333333333333333333333",
    protocolFingerprint: "0x4444444444444444444444444444444444444444444444444444444444444444",
    schemaFingerprint: "0x5555555555555555555555555555555555555555555555555555555555555555",
    releaseRoleManifestRoot: "0x6666666666666666666666666666666666666666666666666666666666666666",
    candidateCommit: "0123456789abcdef0123456789abcdef01234567",
  });
  const entry = registry.entries[0]!;
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, entry.releaseRoleManifestRoot, entry.candidateCommit),
  );
  const executorCapability = issuer.open({ worker: { ...entry, workerEpoch: "work-plane-test" } });
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler,
    issuer,
    capability: executorCapability,
  });
  const state = Object.freeze({ issuer, executorCapability, schedulerRuntime });
  schedulerAuthorities.set(scheduler, state);
  return state;
}

/** Test-closure-only access to the production owner edge. */
export function issueTestWorkPlaneCallerCapability(input: {
  readonly scheduler: WorkScheduler;
  readonly intent: CapabilityWorkIntentV1;
}): WorkPlaneCallerCapabilityV1 {
  const authority = authorityFor(input.scheduler);
  return issueWorkPlaneCallerCapability({
    schedulerRuntime: authority.schedulerRuntime,
    issuer: authority.issuer,
    executorCapability: authority.executorCapability,
    intent: input.intent,
  });
}
