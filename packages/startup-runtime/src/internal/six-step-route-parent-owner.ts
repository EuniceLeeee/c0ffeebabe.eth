import { encodeCanonicalJson, type Hash } from "../../../canonical-codec/src/index.ts";
import type { GraphLeaseBindingV1 } from "../../../graph/src/index.ts";

export type StartupSixStepRouteParentCapabilityV1 = object;
export type StartupSixStepRouteParentInvocationCapabilityV1 = object;

interface StartupSixStepRouteParentStateV1 {
  readonly lease: object;
  readonly binding: GraphLeaseBindingV1;
  readonly readOwned: (orderedEdgeIds: readonly Hash[]) => Readonly<{
    readonly stage1: readonly object[];
    readonly stage2: readonly object[];
  }>;
}

export interface StartupSixStepRouteParentInvocationMaterialV1 {
  readonly lease: object;
  readonly binding: GraphLeaseBindingV1;
  readonly orderedEdgeIds: readonly Hash[];
  readonly stage1: readonly object[];
  readonly stage2: readonly object[];
}

const parents = new WeakMap<object, StartupSixStepRouteParentStateV1>();
const invocations = new WeakMap<object, StartupSixStepRouteParentInvocationMaterialV1>();

/** Startup-only issuer. The capability binds the exact producer lease identity
 * to the Ready Stage 1/2 reader retained for that lease. */
export function issueStartupSixStepRouteParentCapabilityV1(
  material: StartupSixStepRouteParentStateV1,
): StartupSixStepRouteParentCapabilityV1 {
  if (material === null || typeof material !== "object"
    || material.lease === null || typeof material.lease !== "object"
    || material.binding === null || typeof material.binding !== "object"
    || typeof material.readOwned !== "function") {
    throw new TypeError("startup Six-Step route parent material is incomplete");
  }
  const capability = Object.freeze(Object.create(null)) as StartupSixStepRouteParentCapabilityV1;
  parents.set(capability, Object.freeze({ lease: material.lease, binding: material.binding, readOwned: material.readOwned }));
  return capability;
}

function exactReadyPipelineBinding(ready: GraphLeaseBindingV1, pipeline: GraphLeaseBindingV1): boolean {
  return ready.readyRecordHash === pipeline.readyRecordHash
    && ready.generationId === pipeline.generationId
    && encodeCanonicalJson(ready.cutoff) === encodeCanonicalJson(pipeline.cutoff)
    && ready.definitionCatalogRoot === pipeline.definitionCatalogRoot
    && ready.instanceCatalogRoot === pipeline.instanceCatalogRoot
    && ready.graphRoot === pipeline.graphRoot;
}

/** One exact route invocation consumes the retained Checkpoint reader and
 * yields another opaque capability. Public callers never receive a structural
 * reader or raw Stage 1/2 arrays. */
export function issueStartupSixStepRouteParentInvocationV1(
  capability: StartupSixStepRouteParentCapabilityV1,
  input: Readonly<{
    readonly lease: object;
    readonly binding: GraphLeaseBindingV1;
    readonly orderedEdgeIds: readonly Hash[];
  }>,
): StartupSixStepRouteParentInvocationCapabilityV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("startup Six-Step route parent capability is invalid");
  }
  const state = parents.get(capability);
  if (state === undefined) throw new TypeError("startup Six-Step route parent capability was not owner-issued");
  if (input.lease !== state.lease || !exactReadyPipelineBinding(state.binding, input.binding)
    || !Array.isArray(input.orderedEdgeIds) || input.orderedEdgeIds.length === 0) {
    throw new TypeError("startup Six-Step route parent invocation changed lease or Ready binding");
  }
  const orderedEdgeIds = Object.freeze([...input.orderedEdgeIds]);
  const selected = state.readOwned(orderedEdgeIds);
  const invocation = Object.freeze(Object.create(null)) as StartupSixStepRouteParentInvocationCapabilityV1;
  invocations.set(invocation, Object.freeze({
    lease: state.lease,
    binding: state.binding,
    orderedEdgeIds,
    stage1: Object.freeze([...selected.stage1]),
    stage2: Object.freeze([...selected.stage2]),
  }));
  return invocation;
}

/** Runtime owner-only consumer for one exact invocation. */
export function readStartupSixStepRouteParentInvocationMaterialV1(
  capability: StartupSixStepRouteParentInvocationCapabilityV1,
): StartupSixStepRouteParentInvocationMaterialV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("startup Six-Step route parent invocation capability is invalid");
  }
  const material = invocations.get(capability);
  if (material === undefined) throw new TypeError("startup Six-Step route parent invocation was not owner-issued");
  return material;
}
