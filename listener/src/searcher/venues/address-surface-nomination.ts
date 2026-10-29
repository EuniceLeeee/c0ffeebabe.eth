import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "./adapter-family-plugin.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import type { CanonicalValue } from "./canonical-value.js";

export interface NominationOpaqueInput {
  readonly nomination: CaptureNominationInput;
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Shared plugin-owned nomination for address-surface Families. The plugin
 * declares the opaque labels it recognizes (its own knowledge of node-artifact
 * naming) and its declared interface fingerprints; this helper reads the real
 * code hash + EIP-1967 word at the source block and returns one address-surface
 * observation per nominated address. The framework then admits it through
 * catalog.matches + decodeCandidate; identity re-verification stays in the
 * plugin lifecycle.
 */
export function createAddressSurfaceNomination(input: {
  readonly opaqueLabels: readonly string[];
  readonly interfaceFingerprints: readonly string[];
  /** Explicit opt-in. Opaque data nominates a candidate; it never admits one.
   * Null means insufficient evidence. Existing callers still omit opaque. */
  readonly resolveOpaque?: (input: NominationOpaqueInput) => Promise<CanonicalValue | null>;
}): {
  nominate(input: {
    readonly nominations: readonly CaptureNominationInput[];
    readonly source: CanonicalSource;
    readonly provider: CaptureNominationProvider;
  }): Promise<readonly UnifiedObservation[]>;
} {
  const labels = new Set(input.opaqueLabels.map((label) => label.toLowerCase()));
  const fingerprints = Object.freeze([...input.interfaceFingerprints]);
  return {
    async nominate({ nominations, source, provider }) {
      const results: UnifiedObservation[] = [];
      for (const nomination of nominations) {
        if (!matchesOpaqueLabel(nomination.opaque, labels)) continue;
        try {
          const address = canonicalAddress(nomination.address);
          const [code, implementationWord, opaque] = await Promise.all([
            provider.getCode(address, source.number),
            provider.getStorage(
              address,
              EIP1967_IMPLEMENTATION_SLOT,
              source.number,
            ),
            input.resolveOpaque?.({ nomination, source, provider }),
          ]);
          if (!ethers.isHexString(code) || code === "0x") continue;
          if (input.resolveOpaque && opaque === null) continue;
          results.push(Object.freeze({
            kind: "address-surface" as const,
            source,
            address,
            codeHash: ethers.keccak256(code).toLowerCase(),
            implementationWord: ethers.zeroPadValue(implementationWord, 32)
              .toLowerCase(),
            interfaceFingerprints: fingerprints,
            ...(input.resolveOpaque ? { opaque: opaque! } : {}),
          }));
        } catch {
          // One unreadable nomination must not block the next one.
        }
      }
      return Object.freeze(results);
    },
  };
}

function matchesOpaqueLabel(
  opaque: unknown,
  labels: ReadonlySet<string>,
): boolean {
  if (opaque === null || typeof opaque !== "object" || Array.isArray(opaque)) {
    return false;
  }
  const record = opaque as Readonly<Record<string, unknown>>;
  for (const key of ["adapter", "adapterId", "venueId", "familyId"]) {
    const value = record[key];
    if (typeof value === "string" && labels.has(value.toLowerCase())) return true;
  }
  return false;
}

function canonicalAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}
