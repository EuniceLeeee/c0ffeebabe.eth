import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  canonicalAddress,
  lowerAddress,
  UNIV2_PAIR_INTERFACE,
} from "./codec.js";

/**
 * Plugin-owned retain-channel reverse binding: re-materialize the pool's
 * address surface from chain truth at the source block. The pool declares
 * its deployment factory via factory(); the address surface carries that
 * factory plus the pool-entry token hints, and the family lifecycle still
 * re-verifies factory()/token0()/token1() and the factory.getPair reverse
 * binding on chain before admission. No recent activity required.
 */
export async function reverseBindUniv2(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
    if (typeof label !== "string" ||
      (label !== "univ2" && label !== "univ2-standard")) {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "not-univ2-opaque",
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
      const factoryData = UNIV2_PAIR_INTERFACE.encodeFunctionData("factory");
      const factoryRaw = await input.provider.call(
        { to: pool, data: factoryData },
        input.source.number,
      );
      let factory: string;
      try {
        if (!ethers.isHexString(factoryRaw) ||
            ethers.dataLength(factoryRaw) !== 32) {
          throw new Error("non-canonical factory shape");
        }
        factory = canonicalAddress(String(
          UNIV2_PAIR_INTERFACE.decodeFunctionResult("factory", factoryRaw)[0],
        ));
      } catch {
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "factory-read-failed",
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
          interfaceFingerprints: Object.freeze(["univ2-pair-surface-v1"]),
          opaque: Object.freeze({
            adapter: label,
            factory,
            token0: typeof opaque.token0 === "string" &&
                ethers.isAddress(opaque.token0)
              ? canonicalAddress(opaque.token0)
              : null,
            token1: typeof opaque.token1 === "string" &&
                ethers.isAddress(opaque.token1)
              ? canonicalAddress(opaque.token1)
              : null,
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
