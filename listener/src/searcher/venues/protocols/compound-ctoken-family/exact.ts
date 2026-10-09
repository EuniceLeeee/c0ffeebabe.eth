import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from
  "../../adapter-request-program.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import {
  CTOKEN_EXCHANGE_RATE_SCALE,
  CTOKEN_INTERFACE,
} from "./abi.js";
import {
  assertCompoundCTokenInvocation,
  assertShares,
} from "./codec.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenExactEvidence,
  CompoundCTokenRoute,
} from "./types.js";

type Input = {
  readonly descriptor: CompoundCTokenDescriptor;
  readonly route: CompoundCTokenRoute;
  readonly amountIn: bigint;
  readonly source: import("../../adapter-request-program.js").CanonicalSource;
};

/**
 * Specified-amount share→underlying quote.
 *
 * `exchangeRateCurrent()` is requested through `eth_call`, so the simulated
 * accrual inside the call yields the rate a real redemption would realise at
 * that block; `exchangeRateStored()` is the documented fallback when the
 * accrual call is unavailable on the transport. The share amount requested by
 * the caller is never replaced by a point-price sample.
 */
const program: ExactRequestProgram<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
  CompoundCTokenExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertCompoundCTokenInvocation(descriptor, route);
    return { transports: ["eth-call"] };
  },
  buildRequests(input) {
    assertCompoundCTokenInvocation(input.descriptor, input.route);
    assertShares(input.amountIn);
    if (input.amountIn === 0n) return Object.freeze([]);
    return Object.freeze([
      callRequest(
        "quote-rate-current",
        input.descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("exchangeRateCurrent"),
      ),
      callRequest(
        "quote-rate-stored",
        input.descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("exchangeRateStored"),
      ),
      callRequest(
        "quote-cash",
        input.descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("getCash"),
      ),
    ]);
  },
  decode({ programInput, initialResults }) {
    assertCompoundCTokenInvocation(programInput.descriptor, programInput.route);
    assertShares(programInput.amountIn);
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: evidence(programInput, 0n, 0n, "exchange-rate-stored"),
      });
    }
    const results = initialResults;
    const currentResult = results.find((result) =>
      result.id === "quote-rate-current");
    const current = currentResult !== undefined && currentResult.ok
      ? currentResult
      : undefined;
    const stored = returnedResult(results, "quote-rate-stored");
    assertSource(stored.source, programInput.source);
    const cashResult = returnedResult(results, "quote-cash");
    assertSource(cashResult.source, programInput.source);
    const rateSource = current === undefined
      ? "exchange-rate-stored" as const
      : "exchange-rate-current" as const;
    const rateResult: Extract<AdapterRequestResult, { readonly ok: true }> =
      current ?? stored;
    const rate = decodeRate(rateResult, rateSource);
    if (rate <= 0n) {
      throw new Error("Compound cToken exchange rate is not positive");
    }
    const cash = decodeUintAtIndex(cashResult, "getCash");
    const amountOut = (programInput.amountIn * rate) / CTOKEN_EXCHANGE_RATE_SCALE;
    if (amountOut <= 0n) {
      // Below one underlying base unit: no representable redemption output.
      throw new Error("Compound cToken quote produced no underlying output");
    }
    if (amountOut > cash) {
      // Correctly unquotable at this state: the market lacks the liquidity.
      // Callers must use a smaller amount or a different block; the quote is
      // never silently shrunk.
      throw new Error(
        `Compound cToken market cash ${cash} cannot cover ${amountOut} underlying out`,
      );
    }
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, rate, amountOut, rateSource),
    });
  },
};

export const compoundCTokenExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      CompoundCTokenDescriptor,
      CompoundCTokenRoute,
      CompoundCTokenExactEvidence
    >("local-zero", (input) => Object.freeze({
      amountOut: 0n,
      evidence: evidence(input, 0n, 0n, "exchange-rate-stored"),
    })),
    Object.freeze({
      id: "compound-ctoken-exchange-rate",
      kind: "request-program" as const,
      chainAmountQuote: true as const,
      program,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    market: lowerAddress(descriptor.market),
    underlying: lowerAddress(descriptor.underlying),
    share: lowerAddress(descriptor.share),
    direction: route.direction,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
  CompoundCTokenExactEvidence
>;

function decodeRate(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  rateSource: CompoundCTokenExactEvidence["rateSource"],
): bigint {
  const method = rateSource === "exchange-rate-current"
    ? "exchangeRateCurrent"
    : "exchangeRateStored";
  return BigInt(CTOKEN_INTERFACE.decodeFunctionResult(method, result.data)[0]);
}

function decodeUintAtIndex(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  method: string,
): bigint {
  return BigInt(CTOKEN_INTERFACE.decodeFunctionResult(method, result.data)[0]);
}

function evidence(
  input: Input,
  exchangeRate: bigint,
  amountOut: bigint,
  rateSource: CompoundCTokenExactEvidence["rateSource"],
): CompoundCTokenExactEvidence {
  return Object.freeze({
    kind: "compound-ctoken-exchange-rate",
    source: Object.freeze({ ...input.source }),
    market: input.descriptor.market,
    direction: "redeem",
    amountIn: input.amountIn,
    amountOut,
    exchangeRate,
    rateSource,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
