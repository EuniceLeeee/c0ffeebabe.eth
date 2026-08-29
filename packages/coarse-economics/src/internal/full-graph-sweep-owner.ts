import {
  decodeCoarseEdgeSweepBindingV1,
  type CoarseEdgeSweepBindingV1,
  type IssuedCoarseEdgeSweepBindingV1,
} from "../index.ts";

const states = new WeakMap<object, CoarseEdgeSweepBindingV1>();

/** Full-Graph sweep owner only.  The normal planner/search path has no import
 * edge to this issuer and cannot turn a directed edge into a route. */
export function issueCoarseEdgeSweepBindingV1(
  value: CoarseEdgeSweepBindingV1,
): IssuedCoarseEdgeSweepBindingV1 {
  const binding = decodeCoarseEdgeSweepBindingV1(value);
  const capability = Object.freeze(Object.create(null)) as IssuedCoarseEdgeSweepBindingV1;
  states.set(capability, binding);
  return capability;
}

export function readIssuedCoarseEdgeSweepBindingV1(
  value: unknown,
): CoarseEdgeSweepBindingV1 {
  if (value === null || typeof value !== "object" || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError("coarse edge sweep binding capability is invalid");
  }
  const binding = states.get(value);
  if (binding === undefined) throw new TypeError("coarse edge sweep binding was not issued by the full-Graph owner");
  return decodeCoarseEdgeSweepBindingV1(binding);
}
