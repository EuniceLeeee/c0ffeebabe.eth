import {
  localZeroExactMethod,
  type ExactQuoteInput,
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
  CTOKEN_INTERFACE,
} from "./abi.js";
import {
  assertCompoundCTokenInvocation,
  assertShares,
  redemptionAmount,
} from "./codec.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenExactEvidence,
  CompoundCTokenRoute,
} from "./types.js";

type Input = ExactQuoteInput<CompoundCTokenDescriptor, CompoundCTokenRoute>;
function check(input: Input): void {
  assertCompoundCTokenInvocation(input.descriptor, input.route);
  assertShares(input.amountIn);
  if (input.prefix?.length) throw new Error("Compound cToken local model cannot consume a prefix; shared EVM prefix required");
}

/**
 * Specified-amount share→underlying quote.
 *
 * `exchangeRateCurrent()` is requested through `eth_call`, so the simulated
 * accrual inside the call yields the rate a real redemption would realise at
 * that block. Failed accrual never falls back to a stale stored rate. This is
 * source reading plus checked local amount math, not a chain amount quote.
 */
const program: ExactRequestProgram<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
  CompoundCTokenExactEvidence
> = {
  requirements: (input) => {
    check(input);
    return { transports: input.amountIn === 0n ? [] : ["eth-call"] };
  },
  buildRequests(input) {
    check(input);
    if (input.amountIn === 0n) return Object.freeze([]);
    return Object.freeze([
      callRequest(
        "quote-rate-current",
        input.descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("exchangeRateCurrent"),
      ),
      callRequest(
        "quote-cash",
        input.descriptor.market,
        CTOKEN_INTERFACE.encodeFunctionData("getCash"),
      ),
    ]);
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    check(programInput);
    if (dependentEvidence.length) throw new Error("Compound cToken unexpected dependent evidence");
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: evidence(programInput, 0n, 0n, "local-zero"),
      });
    }
    const results = initialResults;
    const current = returnedResult(results, "quote-rate-current");
    assertSource(current.source, programInput.source);
    const cashResult = returnedResult(results, "quote-cash");
    assertSource(cashResult.source, programInput.source);
    const rateSource = "exchange-rate-current" as const;
    const rate = decodeUintAtIndex(current, "exchangeRateCurrent");
    if (rate <= 0n) {
      throw new Error("Compound cToken exchange rate is not positive");
    }
    const cash = decodeUintAtIndex(cashResult, "getCash");
    const amountOut = redemptionAmount(programInput.amountIn, rate);
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
    >("local-zero", (input) => { check(input); return Object.freeze({
      amountOut: 0n,
      evidence: evidence(input, 0n, 0n, "local-zero"),
    }); }),
    Object.freeze({
      id: "compound-ctoken-exchange-rate",
      kind: "request-program" as const,
      // No stateOnlyReads/reusePolicy: accrual depends on the execution block,
      // even without market logs. Do not grant cross-source retained reads.
      trialState: { unsupportedReason: "cToken accrual, burns and underlying transfers require shared EVM prefix execution" },
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
