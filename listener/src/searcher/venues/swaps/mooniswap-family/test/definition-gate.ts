import assert from "node:assert/strict";
import { defineMooniswapFamily } from "../definition.js";
import { MOONISWAP_ID } from "../codec.js";

// Explicit prerequisite gate, not part of the passing off-catalog unit suite.
// On the original baseline this MUST exit nonzero at the shared validator.
// Acceptance here alone does not prove coordinator refresh/carry wiring.
const plugin = defineMooniswapFamily();
assert.equal(plugin.manifest.familyId, MOONISWAP_ID);
assert.equal(Reflect.get(plugin.pricing, "refreshPolicy"), "each-block");
console.log("Mooniswap complete definition accepted; production refresh integration still required");
