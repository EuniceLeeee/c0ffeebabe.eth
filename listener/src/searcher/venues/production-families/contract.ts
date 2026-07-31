import type {
  ActionAdapter,
} from "../../../types.js";
import type {
  AdapterDescriptor,
} from "../../../adapters/adapter-descriptors.js";
import type {
  AdapterFamily,
} from "../route-leg-adapter.js";

export type FamilyOwnedActionAdapter = ActionAdapter & {
  readonly descriptor: AdapterDescriptor;
};

/**
 * The only activation surface for a newly added production family. A module
 * placed beside this contract with the suffix `.production.ts` is discovered
 * automatically; the family and every action it owns must travel together.
 */
export interface ProductionFamilyModule {
  readonly family: AdapterFamily;
  readonly actionAdapters: readonly FamilyOwnedActionAdapter[];
}

export function defineProductionFamilyModule(
  input: ProductionFamilyModule,
): ProductionFamilyModule {
  return Object.freeze({
    family: input.family,
    actionAdapters: Object.freeze([...input.actionAdapters]),
  });
}
