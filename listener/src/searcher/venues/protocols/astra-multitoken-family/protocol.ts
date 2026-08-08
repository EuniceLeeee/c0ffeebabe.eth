import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const astraMultiTokenProtocol = {
  candidateKinds: ["observed-call"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
