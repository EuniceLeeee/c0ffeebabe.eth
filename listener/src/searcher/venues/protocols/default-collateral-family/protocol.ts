import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const defaultCollateralProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  // Fulfilled inside identity.ts round 3 (same-state withdraw effect proof).
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
