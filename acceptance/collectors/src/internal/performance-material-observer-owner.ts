import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";

export type ProductionPerformanceMaterialObserverPortV1 = object;

export interface ProductionPerformanceDeploymentMaterialV1 {
  readonly performanceProfileBytes: Uint8Array;
  readonly hardwareProfileBytes: Uint8Array;
  readonly performanceCommitmentBytes: Uint8Array;
}

interface PerformanceMaterialObserverStateV1 {
  readonly releaseBinding: Readonly<{
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
  }>;
  observed: boolean;
}

const observers = new WeakMap<object, PerformanceMaterialObserverStateV1>();

/** Advisory pre-release has no externally qualified performance observation.
 * This owner issues only a typed unqualified port and intentionally owns no
 * SQLite callback or provisional observation id. */
export function issueProductionPerformanceMaterialObserverOwnerPortV1(
  releaseBinding: PerformanceMaterialObserverStateV1["releaseBinding"],
): ProductionPerformanceMaterialObserverPortV1 {
  if (typeof releaseBinding.candidateReleaseCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(releaseBinding.candidateReleaseCommit)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.runtimeBindingId)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.releaseProvenanceHash)) {
    throw new TypeError("performance material observer release binding is invalid");
  }
  const port = Object.freeze(Object.create(null)) as object;
  observers.set(port, {
    releaseBinding: Object.freeze({ ...releaseBinding }),
    observed: false,
  });
  return port;
}

export function readProductionPerformanceMaterialObserverReleaseBindingV1(
  port: ProductionPerformanceMaterialObserverPortV1,
): PerformanceMaterialObserverStateV1["releaseBinding"] {
  assertProductionPerformanceMaterialObserverPortV1(port);
  return observers.get(port)!.releaseBinding;
}

export function assertProductionPerformanceMaterialObserverPortV1(
  port: unknown,
): asserts port is ProductionPerformanceMaterialObserverPortV1 {
  if (port === null || typeof port !== "object" || !observers.has(port)) {
    throw new TypeError("performance material observer port was not owner-issued");
  }
}

export function observeProductionPerformanceMaterialV1(
  port: ProductionPerformanceMaterialObserverPortV1,
): unknown {
  assertProductionPerformanceMaterialObserverPortV1(port);
  const state = observers.get(port)!;
  if (state.observed) throw new TypeError("performance material observer is single-read");
  state.observed = true;
  return Object.freeze({
    status: "missing" as const,
    qualification: "unqualified" as const,
    reasons: Object.freeze(["post-freeze-qualified-performance-observation-missing"]),
  });
}

export function readObservedProductionPerformanceDeploymentMaterialV1(
  port: ProductionPerformanceMaterialObserverPortV1,
): ProductionPerformanceDeploymentMaterialV1 {
  assertProductionPerformanceMaterialObserverPortV1(port);
  throw new TypeError("pre-release performance observation is unqualified; complete deployment material is unavailable");
}
