/**
 * Victim-state handling is orthogonal to route execution. Swap families
 * declare optional replay callbacks; this registry validates and flattens
 * those declarations without translating them into protocol variants.
 */
import type { VictimRuntimeCapability } from "./victim-runtime-capability.js";

export type VictimModelKind = "pool-swap-overlay" | "oracle-rawtx";

export type SwapVictimModelDeclaration =
  | {
      readonly id: string;
      readonly mode: "detect-only";
    }
  | {
      readonly id: string;
      readonly mode: "replay";
      readonly runtime: VictimRuntimeCapability;
    };

export interface VictimModelDescriptor {
  readonly id: string;
  readonly kind: VictimModelKind;
  /** Empty for models, such as raw-tx oracle replay, that are not edge-bound. */
  readonly edgeAdapterIds: readonly string[];
  readonly runtime: VictimRuntimeCapability | null;
}

export interface SwapVictimFamilyRegistration {
  readonly id: string;
  readonly edgeAdapterIds: readonly string[];
  readonly victimModel: SwapVictimModelDeclaration;
}

export class VictimModelRegistry {
  private readonly byId = new Map<string, VictimModelDescriptor>();
  private readonly byEdgeAdapter = new Map<string, VictimModelDescriptor>();

  constructor(descriptors: readonly VictimModelDescriptor[]) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  static fromSwapFamilies(
    families: readonly SwapVictimFamilyRegistration[],
    nonEdgeModels: readonly VictimModelDescriptor[] = [],
  ): VictimModelRegistry {
    const descriptors = families.map((family) =>
      victimDescriptorForFamily(family)
    );
    return new VictimModelRegistry([...descriptors, ...nonEdgeModels]);
  }

  list(): readonly VictimModelDescriptor[] {
    return [...this.byId.values()];
  }

  forEdge(edgeAdapterId: string): VictimModelDescriptor | null {
    return this.byEdgeAdapter.get(edgeAdapterId) ?? null;
  }

  forId(id: string): VictimModelDescriptor | null {
    return this.byId.get(id) ?? null;
  }

  private register(descriptor: VictimModelDescriptor): void {
    validateDescriptor(descriptor);
    if (this.byId.has(descriptor.id)) {
      throw new Error(`victim-model registry: duplicate model ${descriptor.id}`);
    }
    this.byId.set(descriptor.id, Object.freeze({
      ...descriptor,
      edgeAdapterIds: Object.freeze([...descriptor.edgeAdapterIds]),
      runtime: descriptor.runtime === null
        ? null
        : freezeRuntime(descriptor.runtime),
    }));

    for (const edgeAdapterId of descriptor.edgeAdapterIds) {
      if (this.byEdgeAdapter.has(edgeAdapterId)) {
        throw new Error(`victim-model registry: duplicate edge adapter ${edgeAdapterId}`);
      }
      this.byEdgeAdapter.set(edgeAdapterId, this.byId.get(descriptor.id)!);
    }
  }
}

function victimDescriptorForFamily(
  family: SwapVictimFamilyRegistration,
): VictimModelDescriptor {
  if (!family.id.trim()) {
    throw new Error("victim-model registry: empty family id");
  }
  if (family.edgeAdapterIds.length === 0) {
    throw new Error(`victim-model registry: ${family.id} owns no edge adapter`);
  }
  const edgeAdapterIds = Object.freeze([...family.edgeAdapterIds]);
  if (new Set(edgeAdapterIds).size !== edgeAdapterIds.length) {
    throw new Error(`victim-model registry: ${family.id} duplicates an edge adapter`);
  }
  if (family.victimModel.mode === "detect-only") {
    return Object.freeze({
      id: family.victimModel.id,
      kind: "pool-swap-overlay",
      edgeAdapterIds,
      runtime: null,
    });
  }
  const runtime = family.victimModel.runtime;
  validateRuntime(family.id, runtime);
  return Object.freeze({
    id: family.victimModel.id,
    kind: "pool-swap-overlay",
    edgeAdapterIds,
    runtime: freezeRuntime(runtime),
  });
}

function validateDescriptor(descriptor: VictimModelDescriptor): void {
  if (!descriptor.id.trim()) {
    throw new Error("victim-model registry: empty model id");
  }
  if (descriptor.kind === "oracle-rawtx") {
    if (
      descriptor.edgeAdapterIds.length !== 0 ||
      descriptor.runtime !== null
    ) {
      throw new Error(
        `victim-model registry: oracle model ${descriptor.id} must be non-edge-only`,
      );
    }
    return;
  }
  if (descriptor.edgeAdapterIds.length === 0) {
    throw new Error(`victim-model registry: ${descriptor.id} has no edge adapter`);
  }
  if (descriptor.runtime !== null) {
    validateRuntime(descriptor.id, descriptor.runtime);
  }
  for (const edgeAdapterId of descriptor.edgeAdapterIds) {
    if (!edgeAdapterId.trim()) {
      throw new Error(`victim-model registry: ${descriptor.id} has empty edge adapter`);
    }
  }
}

function validateRuntime(
  owner: string,
  runtime: VictimRuntimeCapability,
): void {
  if (
    runtime.localApply === null &&
    runtime.exactPostImpact === null &&
    runtime.buildOverlay === null
  ) {
    throw new Error(
      `victim-model registry: ${owner} replay declaration has no callback`,
    );
  }
  if (
    runtime.localApply !== null &&
    runtime.localApply.needsMutablePoolRefresh &&
    !runtime.localApply.cacheBacked
  ) {
    throw new Error(
      `victim-model registry: ${owner} non-cache local apply requests pool refresh`,
    );
  }
}

function freezeRuntime(
  runtime: VictimRuntimeCapability,
): VictimRuntimeCapability {
  return Object.freeze({
    localApply: runtime.localApply === null
      ? null
      : Object.freeze({ ...runtime.localApply }),
    exactPostImpact: runtime.exactPostImpact,
    buildOverlay: runtime.buildOverlay,
  });
}
