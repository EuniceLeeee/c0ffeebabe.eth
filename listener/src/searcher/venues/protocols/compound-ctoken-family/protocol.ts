import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

/**
 * `activeBehaviorProof: "required"` is fulfilled inside `identity.ts`: the
 * registry proof is only accepted together with a live exchange-rate path
 * (`balanceOfUnderlying` at the pinned block), so an admitted market has both a
 * chain-proven registration AND a proven redemption surface.
 */
export const compoundCTokenProtocol: ProtocolDomainSemantics = {
  candidateKinds: Object.freeze([
    "observed-call",
    "address-surface",
    "standalone-contract",
  ]),
  activeBehaviorProof: "required",
};
