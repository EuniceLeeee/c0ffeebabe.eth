import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

/**
 * `activeBehaviorProof: "required"` is fulfilled inside `identity.ts`: an LT is
 * admitted only when the reverse binding (`amm().LT_CONTRACT() == lt`, pool
 * coins) holds AND the redemption surface is live on the same pinned state —
 * `is_killed()` returns false and `preview_withdraw` returns a positive
 * single-asset amount. The active round therefore always carries a successful
 * required read (`active-is-killed`), and a dead redemption surface still
 * surfaces as a chain-proven rejection instead of an admitted route.
 */
export const yieldBasisLtProtocol: ProtocolDomainSemantics = {
  candidateKinds: Object.freeze([
    "observed-call",
    "address-surface",
    "standalone-contract",
  ]),
  activeBehaviorProof: "required",
};
