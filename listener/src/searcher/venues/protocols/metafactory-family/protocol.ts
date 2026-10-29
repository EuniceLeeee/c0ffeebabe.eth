import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const metafactoryProtocol = {
  candidateKinds: ["observed-call", "standalone-contract"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
