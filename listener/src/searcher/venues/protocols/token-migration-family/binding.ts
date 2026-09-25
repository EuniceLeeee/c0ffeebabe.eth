import { hashCanonical } from "../../canonical-value.js";
import { assertRouteBound, sameAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
export const bindingProjection = (d: Descriptor) => ({
  target: d.target.toLowerCase(), tokenIn: d.tokenIn.toLowerCase(), tokenOut: d.tokenOut.toLowerCase(),
  numerator: d.numerator, denominator: d.denominator, codeHash: d.codeHash,
  semantics: "mantle-migrate-exact-amount-v1",
});
export function assertInvocation(d: Descriptor, r: Route): void {
  assertRouteBound({ descriptorInstanceKey: d.instanceKey, descriptorTarget: d.target, route: r, bindingFingerprint: hashCanonical(bindingProjection(d)) });
  if (d.familyId !== FAMILY || d.lineageId !== LINEAGE || r.familyId !== FAMILY || r.lineageId !== LINEAGE ||
      r.direction !== "migrate" || r.adapterId !== "token-migration" || r.taxonomy.slotKind !== "protocol" ||
      r.taxonomy.protocolAction !== "convert" || !sameAddress(r.tokenIn, d.tokenIn) || !sameAddress(r.tokenOut, d.tokenOut)) {
    throw new Error("migration route binding mismatch");
  }
}
