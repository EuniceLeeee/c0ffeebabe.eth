import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ArtifactResolutionClaimV1, ResolverPolicyV1, RetentionLeaseReceiptV1 } from "../../../../specs/artifact-resolution/src/index.ts";
import type { ReadOnlyArtifactRefV1 } from "../../../../specs/core-envelope/src/index.ts";
import type { RawTerminalSelectionObservationV1, TerminalSelectionFactV1 } from "../../../terminal-selection-facts/src/schema.ts";

export type ProductionTerminalSelectionMaterialCapabilityV1 = object;

export interface ProductionTerminalSelectionArtifactV1 {
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly lease: RetentionLeaseReceiptV1;
}

export interface ProductionTerminalSelectionMaterialV1 {
  readonly predicateId: "aloha.terminal-selection-lineage.facts";
  readonly finalDurableWindowId: Hash;
  readonly processAnchorHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly rawObservation: RawTerminalSelectionObservationV1;
  readonly fact: TerminalSelectionFactV1;
  readonly artifacts: readonly ProductionTerminalSelectionArtifactV1[];
  readonly resolverPolicy: ResolverPolicyV1;
}

export interface ProductionTerminalSelectionObserverPortV1 {
  observe(): Promise<ProductionTerminalSelectionMaterialCapabilityV1>;
}

const materialStates = new WeakMap<object, ProductionTerminalSelectionMaterialV1>();
const issuedPorts = new WeakMap<object, Readonly<{
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
}>>();

export function issueProductionTerminalSelectionMaterialCapabilityV1(
  material: ProductionTerminalSelectionMaterialV1,
): ProductionTerminalSelectionMaterialCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  materialStates.set(capability, material);
  return capability;
}

export function registerProductionTerminalSelectionObserverPortV1(
  port: ProductionTerminalSelectionObserverPortV1,
  releaseBinding: Readonly<{
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
  }>,
): void {
  if (typeof releaseBinding.candidateReleaseCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(releaseBinding.candidateReleaseCommit)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.runtimeBindingId)
    || !/^0x[0-9a-f]{64}$/.test(releaseBinding.releaseProvenanceHash)) {
    throw new TypeError("terminal-selection observer release binding is invalid");
  }
  issuedPorts.set(port, Object.freeze({ ...releaseBinding }));
}

/** Exact owner state only; this never invokes the observation callback. */
export function readProductionTerminalSelectionObserverReleaseBindingV1(
  port: ProductionTerminalSelectionObserverPortV1,
): Readonly<{
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
}> {
  assertIssuedProductionTerminalSelectionObserverPortV1(port);
  return issuedPorts.get(port)!;
}

export function readProductionTerminalSelectionMaterialV1(
  capability: ProductionTerminalSelectionMaterialCapabilityV1,
): ProductionTerminalSelectionMaterialV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("production terminal-selection material capability is invalid");
  const material = materialStates.get(capability);
  if (material === undefined) throw new TypeError("production terminal-selection material capability was not observer-issued");
  return material;
}

export function assertIssuedProductionTerminalSelectionObserverPortV1(
  value: unknown,
): asserts value is ProductionTerminalSelectionObserverPortV1 {
  if (value === null || typeof value !== "object" || !issuedPorts.has(value)) {
    throw new TypeError("production terminal-selection observer port was not issued");
  }
}
