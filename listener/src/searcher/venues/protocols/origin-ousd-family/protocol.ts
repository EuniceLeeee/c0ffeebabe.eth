import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const originOusdProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  // Fulfilled inside identity.ts round 3 (real mint effect simulation).
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
