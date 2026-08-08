import type { ProtocolDomainSemantics } from "../../adapter-family-plugin.js";
import { metronomeSynthOracleVictim } from "./victim.js";

export const metronomeSynthProtocol = Object.freeze({
  candidateKinds: ["observed-call" as const, "address-surface" as const],
  activeBehaviorProof: "required" as const,
  oracleVictim: metronomeSynthOracleVictim,
}) satisfies ProtocolDomainSemantics;
