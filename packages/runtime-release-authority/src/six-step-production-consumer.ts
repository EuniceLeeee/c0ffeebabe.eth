import type { ProductionSixStepTailEmissionPortV1 } from "../../search-pipeline/src/index.ts";
import type { StartupSixStepRouteParentCapabilityV1 } from "../../startup-runtime/src/index.ts";
import {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  type RuntimeReleaseStrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";
import {
  readRuntimeReleaseSixStepTailEmissionPortV1,
} from "./internal/six-step-production-owner.ts";

/** Recover the owner-issued Stage 3-6 port bound to one exact Startup producer
 * lease. The opaque Startup capability retains the Stage 1/2 reader and exact
 * lease identity; structural readers and copied lease objects are rejected. */
export function readRuntimeReleaseSixStepProductionTailV1(
  strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1,
  routeParents: StartupSixStepRouteParentCapabilityV1,
): ProductionSixStepTailEmissionPortV1 {
  assertIssuedRuntimeReleaseStrategyRuntimeService(strategyRuntime);
  strategyRuntime.readMetadata();
  return readRuntimeReleaseSixStepTailEmissionPortV1(strategyRuntime, routeParents);
}
