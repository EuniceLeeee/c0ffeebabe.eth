import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const wstethProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
