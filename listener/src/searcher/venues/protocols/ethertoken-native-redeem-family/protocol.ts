import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const etherTokenNativeRedeemProtocol = Object.freeze({
  candidateKinds: ["observed-call" as const],
  activeBehaviorProof: "required" as const,
}) satisfies ProtocolDomainSemantics;
