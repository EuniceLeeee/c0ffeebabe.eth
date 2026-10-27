import { getAddress } from "ethers";
import type { DiscoverySemantics, FamilyCandidate } from "./adapter-family-plugin.js";

/** For declarations whose observed target/emitter is the candidate address.
 * Matching, nomination and identity proofs still use the existing lifecycle. */
export function compileAddressDiscovery<C extends FamilyCandidate>(input:
  Omit<DiscoverySemantics<C>, "decodeCandidate"> & {
    readonly candidate: (address: string) => C;
  },
): DiscoverySemantics<C> {
  const { candidate, ...declaration } = input;
  for (const pattern of declaration.callPatterns ?? []) {
    if (pattern.candidateAddress.from !== "call-target")
      throw new Error("address discovery requires call-target projection");
  }
  for (const pattern of declaration.logPatterns ?? []) {
    if (pattern.emitter && pattern.emitter.mode !== "address")
      throw new Error("address discovery requires emitter-address projection");
  }
  const patternIds = {
    call: new Set(declaration.callPatterns?.map(p => p.id)),
    log: new Set(declaration.logPatterns?.map(p => p.id)),
    "address-surface": new Set(declaration.addressSurfaces?.map(p => p.id)),
  };
  return {
    ...declaration,
    decodeCandidate({ observation, matchedPatternId }) {
      if (observation.kind !== "call" && observation.kind !== "log" && observation.kind !== "address-surface") return null;
      if (!patternIds[observation.kind].has(matchedPatternId)) return null;
      try {
        return candidate(getAddress(observation.kind === "call" ? observation.target : observation.address));
      } catch {
        return null;
      }
    },
  };
}
