import type { FamilySearchSourceReadPortV1, FamilySearchSourceV1 } from "../../../family-sdk/search-runtime/index.ts";
import type { Hash } from "../../../canonical-codec/src/index.ts";
import type { FullGraphCoarseSweepSourceReadCapabilityV1 } from "../index.ts";

export interface FullGraphCoarseSweepSourceReadBindingV1 {
  readonly sessionId: Hash;
  readonly source: FamilySearchSourceV1;
}

interface StateV1 {
  readonly binding: FullGraphCoarseSweepSourceReadBindingV1;
  readonly port: FamilySearchSourceReadPortV1;
}

const states = new WeakMap<object, StateV1>();

/** Candidate-owned Reth source is the sole production issuer. */
export function issueFullGraphCoarseSweepSourceReadCapabilityV1(
  binding: FullGraphCoarseSweepSourceReadBindingV1,
  port: FamilySearchSourceReadPortV1,
): FullGraphCoarseSweepSourceReadCapabilityV1 {
  if (port === null || typeof port !== "object" || typeof port.read !== "function") {
    throw new TypeError("full-Graph sweep source read port is invalid");
  }
  const capability = Object.freeze(Object.create(null)) as FullGraphCoarseSweepSourceReadCapabilityV1;
  states.set(capability, Object.freeze({ binding, port }));
  return capability;
}

export function consumeFullGraphCoarseSweepSourceReadCapabilityV1(
  capability: FullGraphCoarseSweepSourceReadCapabilityV1,
): StateV1 {
  const state = readFullGraphCoarseSweepSourceReadCapabilityV1(capability);
  states.delete(capability);
  return state;
}

export function readFullGraphCoarseSweepSourceReadCapabilityV1(
  capability: FullGraphCoarseSweepSourceReadCapabilityV1,
): StateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("full-Graph sweep source read capability is invalid");
  }
  const state = states.get(capability);
  if (state === undefined) throw new TypeError("full-Graph sweep source read capability was not issued");
  return state;
}
