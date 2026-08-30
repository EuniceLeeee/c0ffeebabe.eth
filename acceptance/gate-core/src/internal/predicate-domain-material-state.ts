import type {
  PredicateDomainMaterialCapabilityV1,
  PredicateDomainMaterialStateV1,
} from "../material-provider.ts";
export type { PredicateDomainMaterialV1, PredicateDomainMaterialStateV1 } from "../material-provider.ts";

const domainMaterial = new WeakMap<object, PredicateDomainMaterialStateV1>();

export function registerPredicateDomainMaterialCapabilityV1(
  state: PredicateDomainMaterialStateV1,
): PredicateDomainMaterialCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  domainMaterial.set(capability, state);
  return capability;
}

export function readPredicateDomainMaterialCapabilityV1(
  capability: PredicateDomainMaterialCapabilityV1,
): PredicateDomainMaterialStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("predicate domain material capability is invalid");
  }
  const state = domainMaterial.get(capability);
  if (state === undefined) throw new TypeError("predicate domain material capability was not provider-issued");
  return state;
}
