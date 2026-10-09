import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ALGEBRA_POOL_INTERFACE } from "./abi.js";
import { canonicalAddress, lowerAddress } from "./codec.js";

/**
 * Plugin-owned retain-channel reverse binding: re-materialize the pool's
 * address surface from chain truth at the source block. The pool declares its
 * deployment factory via `factory()`, and the address surface carries that
 * factory plus any pool-entry token hints; the family lifecycle still
 * re-verifies factory/token0/token1/fee and the `factory.poolByPair` reverse
 * binding on chain before admission. No recent activity is required.
 */
export async function reverseBindAlgebraIntegral(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isAlgebraOpaqueLabel(opaque)) {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "not-algebra-integral-opaque",
      }));
      continue;
    }
    const pool = lowerAddress(nomination.address);
    try {
      const code = await input.provider.getCode(pool, input.source.number);
      if (!ethers.isHexString(code) || code === "0x") {
        outcomes.push(Object.freeze({ status: "failed", reason: "no-deployed-code" }));
        continue;
      }
      const factoryRaw = await input.provider.call(
        { to: pool, data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("factory") },
        input.source.number,
      );
      let factory: string;
      try {
        if (!ethers.isHexString(factoryRaw) || ethers.dataLength(factoryRaw) !== 32) {
          throw new Error("non-canonical factory shape");
        }
        factory = canonicalAddress(String(
          ALGEBRA_POOL_INTERFACE.decodeFunctionResult("factory", factoryRaw)[0],
        ));
      } catch {
        outcomes.push(Object.freeze({ status: "failed", reason: "factory-read-failed" }));
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
          interfaceFingerprints: Object.freeze(["algebra-integral-pool-surface-v1"]),
          opaque: Object.freeze({
            adapter: "algebra-integral",
            factory,
            token0: typeof opaque.token0 === "string" && ethers.isAddress(opaque.token0)
              ? canonicalAddress(opaque.token0)
              : null,
            token1: typeof opaque.token1 === "string" && ethers.isAddress(opaque.token1)
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

export function isAlgebraOpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" && label === "algebra-integral";
}
