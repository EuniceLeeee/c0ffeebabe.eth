import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const psmProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
