import type { ProtocolDomainSemantics } from
  "../../adapter-family-plugin.js";

export const eigenpieProtocol = Object.freeze({
  candidateKinds: Object.freeze(["observed-call" as const]),
  activeBehaviorProof: "required" as const,
}) satisfies ProtocolDomainSemantics;
