import type {
  AdapterFamilyDiscoveryCheckpointCandidateIssuer,
  AdapterFamilyDiscoveryCheckpointCandidateWatermark,
  AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
  AdapterFamilyDiscoveryCheckpointStore,
} from "./adapter-family-discovery-checkpoint.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

/**
 * Production-side durable checkpoint inventory writer. The discovery
 * producer hands a complete per-Family incumbent inventory at one canonical
 * source; the writer advances the durable checkpoint CAS with it and fails
 * closed (explicit unresolved, store unchanged) on any gap, race or
 * non-canonical input. A partial snapshot can never impersonate a complete
 * one.
 */
export interface DiscoveryCheckpointInventoryWriter {
  write(input: {
    readonly source: CanonicalSource;
    readonly watermarks:
      readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[];
    readonly inventoryFamilies:
      readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[];
  }): Promise<
    | { readonly status: "committed"; readonly revision: number }
    | { readonly status: "unresolved"; readonly reason: string }
  >;
}

export class CheckpointDiscoveryInventoryWriter
  implements DiscoveryCheckpointInventoryWriter {
  readonly #checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
  readonly #checkpointIssuer: AdapterFamilyDiscoveryCheckpointCandidateIssuer;

  constructor(input: {
    readonly checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
    readonly checkpointIssuer:
      AdapterFamilyDiscoveryCheckpointCandidateIssuer;
  }) {
    this.#checkpointStore = input.checkpointStore;
    this.#checkpointIssuer = input.checkpointIssuer;
  }

  async write(input: {
    readonly source: CanonicalSource;
    readonly watermarks:
      readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[];
    readonly inventoryFamilies:
      readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[];
  }): Promise<
    | { readonly status: "committed"; readonly revision: number }
    | { readonly status: "unresolved"; readonly reason: string }
  > {
    const current = this.#checkpointStore.capture();
    if (current === null) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: "no trusted checkpoint receipt",
      });
    }
    let staged;
    try {
      staged = this.#checkpointIssuer.prepare({
        source: input.source,
        watermarks: input.watermarks,
        inventoryFamilies: input.inventoryFamilies,
      });
    } catch (error) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    let committed = false;
    try {
      committed = await this.#checkpointStore.compareAndCommit({
        expected: current,
        staged,
      });
    } catch (error) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (!committed) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: "checkpoint CAS rejected the inventory revision",
      });
    }
    const receipt = this.#checkpointStore.capture();
    if (receipt === null) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: "checkpoint committed without a trusted receipt",
      });
    }
    const snapshot = this.#checkpointStore.checkpointSnapshot(receipt);
    if (snapshot === null) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: "committed checkpoint lost its trusted snapshot",
      });
    }
    return Object.freeze({
      status: "committed" as const,
      revision: snapshot.revision,
    });
  }
}
