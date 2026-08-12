import type {
  AdapterFamilyDiscoveryCheckpointStore,
} from "./adapter-family-discovery-checkpoint.js";
import type {
  AdapterFamilySnapshotInventoryEnumerationInput,
} from "./adapter-family-snapshot-inventory-closure.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

/**
 * Production point-in-time inventory enumerator contract (§2 design). The
 * implementation restores the durable discovery checkpoint's incumbent
 * inventory and fails closed whenever the inventory cannot be restored as a
 * complete per-Family matrix; a partial snapshot can never impersonate a
 * complete one.
 */
export interface DiscoveryInventoryEnumerator {
  enumerate(
    source: CanonicalSource,
  ): Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
}

export class CheckpointDiscoveryInventoryEnumerator
  implements DiscoveryInventoryEnumerator {
  readonly #checkpointStore: AdapterFamilyDiscoveryCheckpointStore;

  constructor(input: {
    readonly checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
  }) {
    this.#checkpointStore = input.checkpointStore;
  }

  async enumerate(
    source: CanonicalSource,
  ): Promise<AdapterFamilySnapshotInventoryEnumerationInput> {
    const receipt = this.#checkpointStore.capture();
    if (receipt === null) {
      throw new Error(
        "discovery checkpoint inventory is unavailable: no trusted receipt",
      );
    }
    const snapshot = this.#checkpointStore.checkpointSnapshot(receipt);
    if (snapshot === null) {
      throw new Error(
        "discovery checkpoint inventory is unavailable: append-only restart",
      );
    }
    if (
      snapshot.source.number !== source.number ||
      snapshot.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      snapshot.source.generation !== source.generation
    ) {
      throw new Error(
        "discovery checkpoint inventory source mismatch",
      );
    }
    return Object.freeze({
      source: snapshot.source,
      families: Object.freeze(snapshot.inventoryFamilies.map((family) =>
        Object.freeze({
          familyId: family.familyId,
          inventoryKeys: family.inventoryKeys,
          inventoryCount: family.inventoryCount,
          inventoryHash: family.inventoryHash,
          incumbents: Object.freeze(family.incumbents.map((incumbent) =>
            Object.freeze({
              inventoryKey: incumbent.inventoryKey,
              address: incumbent.address,
              currentSurface: incumbent.currentSurface,
            })
          )),
        })
      )),
    });
  }
}
