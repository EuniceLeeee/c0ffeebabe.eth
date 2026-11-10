import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const originStethArmProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  // Fulfilled inside identity.ts round 3 (real two-direction swap effects).
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
