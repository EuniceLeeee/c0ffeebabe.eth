export * from "./manifest.ts";
export * from "./types.ts";
export * from "./discovery.ts";
export * from "./nomination.ts";
export * from "./identity.ts";
export * from "./instance.ts";
export * from "./routes.ts";
export * from "./pricing.ts";
export * from "./exact.ts";
export * from "./execution.ts";
export * from "./action.ts";
export * from "./capture.ts";
export * from "./source-plan.ts";
export * from "./source-plan-runtime.ts";
export * from "./history-source-plan.ts";
export * from "./runtime.ts";
export * from "./search-adapter.ts";
export * from "./family-definition.ts";
export { ASTRA_DEFINITION } from "./family-definition.ts";

export const ASTRA_PUBLIC_ENTRY = Object.freeze({
  familyId: "astra-multitoken",
  stages: ["nomination", "identity", "materialization", "projection", "rehydration"],
  currentSourceExact: "ASTRA_CURRENT_SOURCE_EXACT",
  actionOwner: "ASTRA_ACTION_OWNER",
  runtimeAdapter: "ASTRA_SEARCH_RUNTIME_ADAPTER_FACTORY",
});
export {
  ASTRA_SOURCE_NOMINATION_PROGRAM,
  ASTRA_SOURCE_PLAN_RUNTIME,
} from "./source-plan-runtime.ts";
export {
  ASTRA_HISTORY_NOMINATION_PROGRAM,
  ASTRA_HISTORY_SOURCE_PLAN_RUNTIME,
} from "./history-source-plan.ts";
