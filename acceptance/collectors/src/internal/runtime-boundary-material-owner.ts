import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";

export type ProductionRuntimeRestartMaterialObserverPortV1 = object;
export type ProductionSourceClosureMaterialObserverPortV1 = object;
export type ProductionLegacyAuthorityMaterialObserverPortV1 = object;

export type ProductionRuntimeBoundaryMaterialObservationV1 =
  | Readonly<{
      readonly status: "available";
      readonly candidateReleaseCommit: string;
      readonly artifacts: readonly ObservedContentArtifactV1[];
      readonly predicateFacts: readonly unknown[];
      readonly evidenceRoot: Hash;
    }>
  | Readonly<{
      readonly status: "missing" | "invalid";
      readonly reasons: readonly string[];
      readonly evidenceRoot: Hash;
    }>;

/**
 * Bind the exact material that crosses from a production observer into a
 * predicate provider.  Artifact bytes are committed by contentSha256; the
 * provider independently checks that digest against its concrete byte copy
 * before accepting this root.
 */
export function productionRuntimeBoundaryMaterialEvidenceRootV1(input: Readonly<{
  readonly predicateId: string;
  readonly candidateReleaseCommit: string;
  readonly artifacts: readonly ObservedContentArtifactV1[];
  readonly predicateFacts: readonly unknown[];
}>): Hash {
  return hashDomain("aloha/production-runtime-boundary-material-available/v1", {
    predicateId: input.predicateId,
    candidateReleaseCommit: input.candidateReleaseCommit,
    artifacts: input.artifacts.map(artifact => ({
      contentSha256: artifact.contentSha256,
      byteLength: String(artifact.bytes.byteLength),
      artifactRefId: artifact.ref.artifactRefId,
      claimId: artifact.claim.claimId,
      retentionLeaseReceiptId: artifact.lease.receiptId,
    })),
    predicateFacts: input.predicateFacts,
  } as never);
}

type Observer = () => Promise<ProductionRuntimeBoundaryMaterialObservationV1>;

interface ObserverStateV1 {
  readonly releaseBinding: Readonly<{
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
  }>;
  readonly observer: Observer;
}

const restartObservers = new WeakMap<object, ObserverStateV1>();
const sourceClosureObservers = new WeakMap<object, ObserverStateV1>();
const legacyAuthorityObservers = new WeakMap<object, ObserverStateV1>();

function issue(
  map: WeakMap<object, ObserverStateV1>,
  releaseBinding: ObserverStateV1["releaseBinding"],
  observer: Observer,
): object {
  if (typeof releaseBinding.candidateReleaseCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(releaseBinding.candidateReleaseCommit)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.runtimeBindingId)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.releaseProvenanceHash)) {
    throw new TypeError("runtime boundary material observer release binding is invalid");
  }
  if (typeof observer !== "function") throw new TypeError("runtime boundary material observer is required");
  const port = Object.freeze(Object.create(null));
  map.set(port, Object.freeze({ releaseBinding: Object.freeze({ ...releaseBinding }), observer }));
  return port;
}

function read(map: WeakMap<object, ObserverStateV1>, port: object, label: string): Promise<ProductionRuntimeBoundaryMaterialObservationV1> {
  const state = map.get(port);
  if (state === undefined) throw new TypeError(`${label} observer port was not owner-issued`);
  return state.observer();
}

export function issueProductionRuntimeRestartMaterialObserverOwnerPortV1(
  releaseBinding: ObserverStateV1["releaseBinding"],
  observer: Observer,
): ProductionRuntimeRestartMaterialObserverPortV1 {
  return issue(restartObservers, releaseBinding, observer);
}

export function issueProductionSourceClosureMaterialObserverOwnerPortV1(
  releaseBinding: ObserverStateV1["releaseBinding"],
  observer: Observer,
): ProductionSourceClosureMaterialObserverPortV1 {
  return issue(sourceClosureObservers, releaseBinding, observer);
}

export function issueProductionLegacyAuthorityMaterialObserverOwnerPortV1(
  releaseBinding: ObserverStateV1["releaseBinding"],
  observer: Observer,
): ProductionLegacyAuthorityMaterialObserverPortV1 {
  return issue(legacyAuthorityObservers, releaseBinding, observer);
}

export function assertProductionRuntimeRestartMaterialObserverPortV1(
  value: unknown,
): asserts value is ProductionRuntimeRestartMaterialObserverPortV1 {
  if (value === null || typeof value !== "object" || !restartObservers.has(value)) {
    throw new TypeError("runtime restart material observer port was not owner-issued");
  }
}

/** Exact owner state only; this never invokes the observation callback. */
export function readProductionRuntimeRestartMaterialObserverReleaseBindingV1(
  port: ProductionRuntimeRestartMaterialObserverPortV1,
): ObserverStateV1["releaseBinding"] {
  assertProductionRuntimeRestartMaterialObserverPortV1(port);
  return restartObservers.get(port)!.releaseBinding;
}

export function assertProductionSourceClosureMaterialObserverPortV1(
  value: unknown,
): asserts value is ProductionSourceClosureMaterialObserverPortV1 {
  if (value === null || typeof value !== "object" || !sourceClosureObservers.has(value)) {
    throw new TypeError("source closure material observer port was not owner-issued");
  }
}

export function assertProductionLegacyAuthorityMaterialObserverPortV1(
  value: unknown,
): asserts value is ProductionLegacyAuthorityMaterialObserverPortV1 {
  if (value === null || typeof value !== "object" || !legacyAuthorityObservers.has(value)) {
    throw new TypeError("legacy authority material observer port was not owner-issued");
  }
}

export function observeProductionRuntimeRestartMaterialV1(
  port: ProductionRuntimeRestartMaterialObserverPortV1,
): Promise<ProductionRuntimeBoundaryMaterialObservationV1> {
  assertProductionRuntimeRestartMaterialObserverPortV1(port);
  return read(restartObservers, port, "runtime restart material");
}

export function observeProductionSourceClosureMaterialV1(
  port: ProductionSourceClosureMaterialObserverPortV1,
): Promise<ProductionRuntimeBoundaryMaterialObservationV1> {
  assertProductionSourceClosureMaterialObserverPortV1(port);
  return read(sourceClosureObservers, port, "source closure material");
}

export function observeProductionLegacyAuthorityMaterialV1(
  port: ProductionLegacyAuthorityMaterialObserverPortV1,
): Promise<ProductionRuntimeBoundaryMaterialObservationV1> {
  assertProductionLegacyAuthorityMaterialObserverPortV1(port);
  return read(legacyAuthorityObservers, port, "legacy authority material");
}
