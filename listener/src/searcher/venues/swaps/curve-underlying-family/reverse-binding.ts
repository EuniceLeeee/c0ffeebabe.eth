import { CURVE_LEGACY_FACTORY, CURVE_LEGACY_FACTORY_INTERFACE,
  decodeLegacyFactoryBasePool, decodeLegacyFactoryCoins } from "./legacy-factory.js";
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
 * Retained pools require source-bound reverse registration. Modern pools use
 * MetaRegistry; before its deployment, factory metapools use factory pool_data.
 * This only nominates an address surface. The lifecycle repeats identity and
 * behavior verification before admission.
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
        if (registryRaw === "0x") {
          const registryCode = await input.provider.getCode(CURVE_METAREGISTRY, input.source.number);
          if (registryCode !== "0x") throw new Error("deployed registry returned no identity");
          const baseRaw = await input.provider.call({ to: CURVE_LEGACY_FACTORY,
            data: CURVE_LEGACY_FACTORY_INTERFACE.encodeFunctionData("get_base_pool", [pool]) }, input.source.number);
          if (decodeLegacyFactoryBasePool(baseRaw) === ethers.ZeroAddress) throw new Error("not factory metapool");
          const coinsRaw = await input.provider.call({ to: CURVE_LEGACY_FACTORY,
            data: CURVE_LEGACY_FACTORY_INTERFACE.encodeFunctionData("get_underlying_coins", [pool]) }, input.source.number);
          if (decodeLegacyFactoryCoins(coinsRaw).length < 2) throw new Error("invalid factory coins");
          registered = canonicalAddress(pool);
        } else {
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
        }
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
