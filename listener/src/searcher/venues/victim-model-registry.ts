/**
 * Victim-state handling is orthogonal to route execution.
 *
 * Receipt observation belongs to SwapAdapter. This registry only describes how
 * an already-decoded victim transition may be reproduced locally or in an
 * overlay; replay capability remains orthogonal to route execution.
 */

export type VictimModelKind = "pool-swap-overlay" | "oracle-rawtx";
export type PoolSwapVictimVariant = "univ2" | "univ3" | "univ4" | "curve";

export interface VictimModelDescriptor {
  readonly id: string;
  readonly kind: VictimModelKind;
  /** Empty for models, such as raw-tx oracle replay, that are not edge-bound. */
  readonly edgeAdapterIds: readonly string[];
  readonly localApplyVariant: PoolSwapVictimVariant | null;
  readonly overlayReplayVariant: Exclude<PoolSwapVictimVariant, "univ4"> | null;
}

export class VictimModelRegistry {
  private readonly byId = new Map<string, VictimModelDescriptor>();
  private readonly byEdgeAdapter = new Map<string, VictimModelDescriptor>();

  constructor(descriptors: readonly VictimModelDescriptor[]) {
    for (const descriptor of descriptors) this.register(descriptor);
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
    if (this.byId.has(descriptor.id)) {
      throw new Error(`victim-model registry: duplicate model ${descriptor.id}`);
    }
    this.byId.set(descriptor.id, descriptor);

    for (const edgeAdapterId of descriptor.edgeAdapterIds) {
      if (this.byEdgeAdapter.has(edgeAdapterId)) {
        throw new Error(`victim-model registry: duplicate edge adapter ${edgeAdapterId}`);
      }
      this.byEdgeAdapter.set(edgeAdapterId, descriptor);
    }
  }
}

const POOL_SWAP_MODELS: readonly VictimModelDescriptor[] = [
  {
    id: "pool-swap:univ2",
    kind: "pool-swap-overlay",
    edgeAdapterIds: ["univ2-swap"],
    localApplyVariant: "univ2",
    overlayReplayVariant: "univ2",
  },
  {
    id: "pool-swap:univ3",
    kind: "pool-swap-overlay",
    edgeAdapterIds: ["univ3-swap"],
    localApplyVariant: "univ3",
    overlayReplayVariant: "univ3",
  },
  {
    id: "pool-swap:univ4",
    kind: "pool-swap-overlay",
    edgeAdapterIds: ["univ4-unlock"],
    localApplyVariant: "univ4",
    // V4 uses the exact event post-state override; it is not replayed as a router call.
    overlayReplayVariant: null,
  },
  {
    id: "pool-swap:curve",
    kind: "pool-swap-overlay",
    edgeAdapterIds: [
      "curve-exchange",
      "curve-exchange-nr",
      "curve-exchange-plain",
      "curve-exchange-received-uint",
    ],
    localApplyVariant: "curve",
    overlayReplayVariant: "curve",
  },
  {
    id: "pool-swap:curve-underlying-detect-only",
    kind: "pool-swap-overlay",
    edgeAdapterIds: ["curve-exchange-underlying"],
    // Preserve the existing fail-closed behavior until underlying replay has a fork fixture.
    localApplyVariant: null,
    overlayReplayVariant: null,
  },
];

export const PRODUCTION_VICTIM_MODELS = new VictimModelRegistry([
  ...POOL_SWAP_MODELS,
  {
    id: "oracle-rawtx:metronome",
    kind: "oracle-rawtx",
    edgeAdapterIds: [],
    localApplyVariant: null,
    overlayReplayVariant: null,
  },
]);
