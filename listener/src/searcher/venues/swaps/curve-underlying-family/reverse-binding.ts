import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  ReverseBindingOutcome,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  canonicalAddress,
  CURVE_METAREGISTRY,
  lowerAddress,
} from "./codec.js";

const METAREGISTRY_INTERFACE = new ethers.Interface([
  "function get_pool_from_lp_token(address token) view returns (address)",
]);

/**
 * Plugin-owned retain-channel reverse binding: a Curve pool's lp token is
 * the pool itself, so chain truth is a MetaRegistry membership reverse
 * lookup (get_pool_from_lp_token(pool) == pool) at the source block — no
 * recent activity required. The address surface carries the pool's deployed
 * code hash; the family lifecycle still re-verifies the registry handlers
 * and underlying coins on chain before admission.
 */
export async function reverseBindCurveUnderlying(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
    if (typeof label !== "string" || label !== "curve-underlying") {
      outcomes.push(Object.freeze({
        status: "unsupported",
        reason: "not-curve-underlying-opaque",
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
      const registryData = METAREGISTRY_INTERFACE.encodeFunctionData(
        "get_pool_from_lp_token",
        [pool],
      );
      const registryRaw = await input.provider.call(
        { to: CURVE_METAREGISTRY, data: registryData },
        input.source.number,
      );
      let registered: string;
      try {
        if (!ethers.isHexString(registryRaw) ||
            ethers.dataLength(registryRaw) !== 32) {
          throw new Error("non-canonical registry shape");
        }
        registered = canonicalAddress(String(
          METAREGISTRY_INTERFACE.decodeFunctionResult(
            "get_pool_from_lp_token",
            registryRaw,
          )[0],
        ));
      } catch {
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "registry-read-failed",
        }));
        continue;
      }
      if (registered.toLowerCase() !== pool) {
        outcomes.push(Object.freeze({
          status: "failed",
          reason: "not-registry-member",
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
          interfaceFingerprints: Object.freeze([
            "curve-underlying-pool-surface-v1",
          ]),
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
