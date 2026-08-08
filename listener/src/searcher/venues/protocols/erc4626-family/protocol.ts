import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const erc4626Protocol: ProtocolDomainSemantics = {
  candidateKinds: Object.freeze([
    "observed-call",
    "address-surface",
    "standalone-contract",
  ]),
  activeBehaviorProof: "required",
};
