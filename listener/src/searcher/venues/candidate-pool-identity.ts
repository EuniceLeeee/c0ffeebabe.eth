import { getAddress } from "ethers";
import type { DiscoverySemantics } from "./adapter-family-plugin.js";

/** Physical pool identity only. Capability scope is a separate Family-owned
 * declaration; this value never grants identity or publication authority. */
export type CandidatePoolIdentity =
  | Readonly<{ kind: "address-pool"; address: string }>
  | Readonly<{ kind: "singleton-pool"; namespace: string; poolId: string }>;

export function normalizeCandidatePoolIdentity(value: CandidatePoolIdentity): CandidatePoolIdentity | null {
  try {
    if (value.kind === "address-pool") {
      return Object.freeze({ kind: value.kind, address: getAddress(value.address).toLowerCase() });
    }
    if (value.kind === "singleton-pool" && typeof value.poolId === "string" && /^0x[\da-fA-F]{64}$/.test(value.poolId)) {
      return Object.freeze({ kind: value.kind, namespace: getAddress(value.namespace).toLowerCase(),
        poolId: value.poolId.toLowerCase() });
    }
  } catch { /* Incomplete nominations remain ordinary validation work. */ }
  return null;
}

/** Existing handwritten Families already own their stable instance key.
 * Only a canonical single address has an implicit pool interpretation; an
 * opaque composite key or an unnamespaced poolId must declare its projector. */
export function projectCandidatePoolIdentity(
  discovery: Pick<DiscoverySemantics<any>, "candidatePoolIdentity" | "instanceNominationKey" | "candidateKey">,
  candidate: unknown,
): CandidatePoolIdentity | null {
  try {
    if (discovery.candidatePoolIdentity !== undefined) {
      const projected = discovery.candidatePoolIdentity(candidate);
      return projected === null ? null : normalizeCandidatePoolIdentity(projected);
    }
    const key = discovery.instanceNominationKey !== undefined
      ? discovery.instanceNominationKey(candidate) : discovery.candidateKey(candidate);
    if (!/^0x[\da-fA-F]{40}$/.test(key)) return null;
    return normalizeCandidatePoolIdentity({ kind: "address-pool", address: key });
  } catch { return null; }
}
