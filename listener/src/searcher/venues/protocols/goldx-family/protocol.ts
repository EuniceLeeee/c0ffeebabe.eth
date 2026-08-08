import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const goldxProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
