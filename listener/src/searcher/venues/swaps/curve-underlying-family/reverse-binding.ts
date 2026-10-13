import { lendingKind, LENDING_LP_CODE_HASH, LENDING_LP_SLOT, LENDING_MINTER_SLOT,
  LENDING_ABI, lendingAddress } from "./lending.js";
import { CURVE_LEGACY_FACTORY, CURVE_LEGACY_FACTORY_INTERFACE,
  decodeLegacyFactoryBasePool, decodeLegacyFactoryCoins } from "./legacy-factory.js";
import { ethers } from "ethers";
import { hasLegacyV1UnderlyingQuoteModel } from "./quote-model.js";
import { CURVE_V1_FACTORY, CURVE_V1_FACTORY_INTERFACE, assertV1FactoryCode,
  decodeV1FactoryRegistration } from "./v1-factory.js";
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
      let registered: string | undefined;
      if (lendingKind(code)) {
        const lp = lendingAddress(await input.provider.getStorage(pool, LENDING_LP_SLOT, input.source.number));
        const lpCode = await input.provider.getCode(lp, input.source.number);
        const minter = lendingAddress(await input.provider.getStorage(lp, LENDING_MINTER_SLOT, input.source.number));
        if (ethers.keccak256(lpCode) !== LENDING_LP_CODE_HASH || minter.toLowerCase() !== pool)
          throw new Error("lending LP reverse binding failed");
        const wrapped: string[] = [], underlying: string[] = [];
        for (let i = 0; i < 4; i++) {
          const read = async (to: string, name: string, args: readonly unknown[] = []) => lendingAddress(
            await input.provider.call({ to, data: LENDING_ABI.encodeFunctionData(name, args) }, input.source.number));
          const coin = await read(pool, "coins", [i]), token = await read(pool, "underlying_coins", [i]);
          if ((await read(coin, "token")).toLowerCase() !== token.toLowerCase())
            throw new Error("lending wrapper reverse binding failed");
          wrapped.push(coin); underlying.push(token);
        }
        if (new Set([...wrapped, ...underlying].map(c => c.toLowerCase())).size !== 8)
          throw new Error("lending ambiguous topology");
        registered = canonicalAddress(pool);
      }
      if (registered === undefined && hasLegacyV1UnderlyingQuoteModel(code)) {
        assertV1FactoryCode(await input.provider.getCode(CURVE_V1_FACTORY, input.source.number));
        const wrapped = await input.provider.call({ to: CURVE_V1_FACTORY,
          data: CURVE_V1_FACTORY_INTERFACE.encodeFunctionData("get_coins", [pool]) }, input.source.number);
        const underlying = await input.provider.call({ to: CURVE_V1_FACTORY,
          data: CURVE_V1_FACTORY_INTERFACE.encodeFunctionData("get_underlying_coins", [pool]) }, input.source.number);
        const registration = decodeV1FactoryRegistration(wrapped, underlying);
        if (registration.wrappedCoins[0] !== ethers.ZeroAddress) registered = canonicalAddress(pool);
      }
      // A quote implementation is not an exclusive factory identity. A canonical
      // V1 non-member can still have an existing MetaRegistry reverse binding.
      if (registered === undefined) {
        const registryData = METAREGISTRY_INTERFACE.encodeFunctionData(
          "get_pool_from_lp_token",
          [pool],
        );
        const registryRaw = await input.provider.call(
          { to: CURVE_METAREGISTRY, data: registryData },
          input.source.number,
        );
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
