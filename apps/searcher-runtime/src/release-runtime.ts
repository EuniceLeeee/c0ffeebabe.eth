import {
  issueProductionStartupCapabilityV1,
  issuePreReleaseRuntimeStartupCapabilityV1,
  startReleaseRuntimeSessionOwnerV1,
  type ProductionStartupCapabilityV1,
} from "./release-runtime-owner.ts";
import type { DryRunServiceHandleV1 } from "./deployment.ts";

export function issueInstalledProductionStartupCapabilityV1(
  input: unknown,
): ProductionStartupCapabilityV1 {
  return issueProductionStartupCapabilityV1(input);
}

export function issuePreReleaseStartupCapabilityV1(input: unknown): ProductionStartupCapabilityV1 {
  return issuePreReleaseRuntimeStartupCapabilityV1(input);
}

export function startReleaseRuntimeSessionV1(
  capability: ProductionStartupCapabilityV1,
): Promise<DryRunServiceHandleV1> {
  return startReleaseRuntimeSessionOwnerV1(capability);
}
