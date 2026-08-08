import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

export const selfBurnNativeProtocol = Object.freeze({
  candidateKinds: ["observed-call" as const, "address-surface" as const],
  activeBehaviorProof: "required" as const,
}) satisfies ProtocolDomainSemantics;
