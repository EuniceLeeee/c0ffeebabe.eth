import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { lowerAddress } from "./codec.js";

/**
 * Plugin-owned retain-channel reverse binding: re-materialize the pool's
 * address surface from deployed code at the source block. The family
 * lifecycle still re-verifies the pool's behavior (_BASE_TOKEN_ /
 * _QUOTE_TOKEN_ / getPMMStateForCall) and the registry membership
 * (getDODOPool reverse binding) on chain before admission. No recent
 * activity required.
 */
export async function reverseBindDodoV2(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
    if (typeof label !== "string" || label !== "dodo-v2") {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "not-dodo-v2-opaque",
      }));
      continue;
    }
    const pool = lowerAddress(nomination.address);
    try {
      const code = await input.provider.getCode(pool, input.source.number);
      if (!ethers.isHexString(code) || code === "0x") {
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "no-deployed-code",
        }));
        continue;
      }
      outcomes.push(Object.freeze({
        status: "verified",
        observation: Object.freeze({
          kind: "address-surface",
          source: input.source,
          address: pool,
          codeHash: ethers.keccak256(code).toLowerCase(),
          implementationWord: ethers.zeroPadValue("0x", 32).toLowerCase(),
          interfaceFingerprints: Object.freeze(["dodo-pool-surface-v1"]),
          opaque: Object.freeze({
            adapter: label,
          }),
        }),
      }));
    } catch (error) {
      outcomes.push(Object.freeze({
        status: "failed",
        reason: error instanceof Error
          ? error.message.slice(0, 120)
          : "reverse-binding-error",
      }));
    }
  }
  return Object.freeze(outcomes);
}
