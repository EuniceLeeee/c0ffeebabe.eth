import { ethers } from "ethers";
import type { CaptureNominationInput, CaptureNominationProvider, ReverseBindingOutcome } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { CURVE_METAREGISTRY, META, addressArray, lower } from "./codec.js";

export async function reverseBindCurvePlain(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
    if (!["curve", "curve-nr", "curve-plain"].includes(String(label))) {
      outcomes.push({ status: "unsupported", reason: "not-curve-plain-nomination" }); continue;
    }
    try {
      const pool = lower(nomination.address);
      const [code, raw] = await Promise.all([
        input.provider.getCode(pool, input.source.number),
        input.provider.call({ to: CURVE_METAREGISTRY,
          data: META.encodeFunctionData("get_registry_handlers_from_pool", [pool]) }, input.source.number),
      ]);
      if (!ethers.isHexString(code) || code === "0x" || addressArray(raw, 10).length === 0) {
        outcomes.push({ status: "failed", reason: "no-registry-bound-pool" }); continue;
      }
      // Nomination only: the lifecycle independently checks direct coins and behavior.
      outcomes.push({ status: "verified", observation: {
        kind: "address-surface", source: input.source, address: pool,
        codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash,
        interfaceFingerprints: ["curve-plain-direct-coins-v1"], opaque: { adapter: String(label) },
      } });
    } catch {
      outcomes.push({ status: "failed", reason: "curve-plain-reverse-read-failed" });
    }
  }
  return Object.freeze(outcomes);
}
