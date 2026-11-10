import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";

// Identity is proven from the pinned staking/token runtime code, the staking
// `OHM()`/`gOHM()` surface and the token decimal scales at the fixed cutoff.
// `index()` is mutable per-block pricing state and is read by pricing/exact.
export const olympusProtocol = {
  candidateKinds: ["observed-call", "address-surface"],
  activeBehaviorProof: "required",
} satisfies ProtocolDomainSemantics;
