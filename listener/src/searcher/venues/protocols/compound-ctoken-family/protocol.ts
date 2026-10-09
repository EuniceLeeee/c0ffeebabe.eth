import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

/**
 * `activeBehaviorProof: "required"` is fulfilled inside `identity.ts`: the
 * registry proof is accepted only with a positive, source-bound redeem that
 * returns zero and proves share/supply burn, underlying debit/receipt and event.
 */
export const compoundCTokenProtocol: ProtocolDomainSemantics = {
  candidateKinds: Object.freeze([
    "observed-call",
    "address-surface",
    "standalone-contract",
  ]),
  activeBehaviorProof: "required",
};
