import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from
  "../../adapter-request-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { depositExactMethods } from "./deposit-exact.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import {
  CRYPTOPOOL_INTERFACE,
  LT_INTERFACE,
  LT_MIN_SHARE_REMAINDER,
} from "./abi.js";
import {
  assertShares,
  assertYieldBasisLtInvocation,
} from "./codec.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtExactEvidence,
  YieldBasisLtRoute,
} from "./types.js";

type Input = {
  readonly descriptor: YieldBasisLtDescriptor;
  readonly route: YieldBasisLtRoute;
  readonly amountIn: bigint;
  readonly source: import("../../adapter-request-program.js").CanonicalSource;
};

/**
 * Specified-share quote for `withdraw(shares, min_assets)`.
 *
 * The caller's share amount is passed straight into the LT's own
 * `preview_withdraw(uint256)` view, which computes the single-asset crypto
 * amount from the live AMM state and the cryptopool's
 * `calc_withdraw_fixed_out`. No off-chain share->asset math is invented here and
 * the amount is never replaced by a point-price sample.
 *
 * Capacity is enforced, never assumed: `liquidity()` and `updated_balances()`
 * are read on the same pinned state, the LT's own remainder rule
 * (`supply >= MIN_SHARE_REMAINDER + shares or supply == shares`) and live supply
 * bound are checked, and the cryptopool balance of the crypto leg — the hard
 * ceiling on what the pool can pay out instantly — must cover the preview.
 * Every one of those checks THROWS; a quote that cannot honour the caller's
 * amount is refused outright and is never silently shrunk or extrapolated.
 */
const program: ExactRequestProgram<
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
  YieldBasisLtExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertYieldBasisLtInvocation(descriptor, route);
    return { transports: ["eth-call"] };
  },
  buildRequests(input) {
    assertYieldBasisLtInvocation(input.descriptor, input.route);
    assertShares(input.amountIn);
    if (input.amountIn === 0n) return Object.freeze([]);
    return Object.freeze([
      callRequest(
        "quote-preview-withdraw",
        input.descriptor.lt,
        LT_INTERFACE.encodeFunctionData("preview_withdraw", [input.amountIn]),
      ),
      callRequest(
        "quote-is-killed",
        input.descriptor.lt,
        LT_INTERFACE.encodeFunctionData("is_killed"),
      ),
      callRequest(
        "quote-staker",
        input.descriptor.lt,
        LT_INTERFACE.encodeFunctionData("staker"),
      ),
      callRequest(
        "quote-live-supply",
        input.descriptor.lt,
        LT_INTERFACE.encodeFunctionData("updated_balances"),
      ),
      callRequest(
        "quote-liquidity",
        input.descriptor.lt,
        LT_INTERFACE.encodeFunctionData("liquidity"),
      ),
      callRequest(
        "quote-pool-asset-balance",
        input.descriptor.cryptopool,
        CRYPTOPOOL_INTERFACE.encodeFunctionData("balances", [
          input.descriptor.assetCoinIndex,
        ]),
      ),
    ]);
  },
  decode({ programInput, initialResults }) {
    assertYieldBasisLtInvocation(programInput.descriptor, programInput.route);
    assertShares(programInput.amountIn);
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: evidence(programInput, 0n, 0n, 0n, 0n),
      });
    }
    const results = initialResults;
    const preview = returnedResult(results, "quote-preview-withdraw");
    assertSource(preview.source, programInput.source);
    const killed = returnedResult(results, "quote-is-killed");
    assertSource(killed.source, programInput.source);
    const staker = returnedResult(results, "quote-staker");
    assertSource(staker.source, programInput.source);
    const liveSupply = returnedResult(results, "quote-live-supply");
    assertSource(liveSupply.source, programInput.source);
    const liquidity = returnedResult(results, "quote-liquidity");
    assertSource(liquidity.source, programInput.source);
    const poolBalance = returnedResult(results, "quote-pool-asset-balance");
    assertSource(poolBalance.source, programInput.source);

    const executor = runtimeExecutor(
      programInput.executor,
      programInput.descriptor.lt,
      programInput.descriptor.asset,
    );
    const currentStaker = String(LT_INTERFACE.decodeFunctionResult(
      "staker",
      staker.data,
    )[0]);
    // The routed two-argument withdraw defaults receiver to msg.sender: both
    // are the executor, not tx.origin. staker is mutable, not Ready authority.
    if (lowerAddress(currentStaker) === lowerAddress(executor)) {
      throw new Error("Yield Basis LT withdraw to/from staker would revert");
    }
    if (Boolean(LT_INTERFACE.decodeFunctionResult("is_killed", killed.data)[0])) {
      // `withdraw` asserts `not amm.is_killed()`: a killed LT is unquotable.
      throw new Error(
        "Yield Basis LT is killed; withdraw would revert (use emergency_withdraw, which this family does not route)",
      );
    }
    const supplyTokens = BigInt(LT_INTERFACE.decodeFunctionResult(
      "updated_balances",
      liveSupply.data,
    )[0]);
    const liquidityValues = LT_INTERFACE.decodeFunctionResult(
      "liquidity",
      liquidity.data,
    );
    const liquidityTotal = BigInt(liquidityValues[1] as bigint | number | string);
    const poolAssetBalance = BigInt(CRYPTOPOOL_INTERFACE.decodeFunctionResult(
      "balances",
      poolBalance.data,
    )[0]);
    const amountOut = BigInt(LT_INTERFACE.decodeFunctionResult(
      "preview_withdraw",
      preview.data,
    )[0]);
    if (amountOut <= 0n) {
      // Below one asset base unit: no representable redemption output.
      throw new Error("Yield Basis LT quote produced no crypto output");
    }
    if (supplyTokens === 0n) {
      throw new Error(
        "Yield Basis LT reports no live share supply; withdraw would revert",
      );
    }
    if (programInput.amountIn > supplyTokens) {
      throw new Error(
        `Yield Basis LT live supply ${supplyTokens} cannot cover ${programInput.amountIn} shares`,
      );
    }
    if (
      supplyTokens !== programInput.amountIn &&
      supplyTokens < LT_MIN_SHARE_REMAINDER + programInput.amountIn
    ) {
      // Mirrors LT.vy `assert supply >= MIN_SHARE_REMAINDER + shares or
      // supply == shares, "Remainder too small"`.
      throw new Error(
        `Yield Basis LT live supply ${supplyTokens} leaves less than the minimum share remainder for ${programInput.amountIn} shares`,
      );
    }
    if (liquidityTotal === 0n) {
      throw new Error(
        "Yield Basis LT reports zero withdrawable liquidity; not quotable",
      );
    }
    if (amountOut > poolAssetBalance) {
      // Correctly unquotable at this state: the cryptopool cannot pay out more
      // crypto than it holds. Callers must use a smaller amount or a different
      // block; the quote is never silently shrunk.
      throw new Error(
        `Yield Basis cryptopool balance ${poolAssetBalance} cannot cover ${amountOut} crypto out`,
      );
    }
    return Object.freeze({
      amountOut,
      evidence: evidence(
        programInput,
        amountOut,
        supplyTokens,
        liquidityTotal,
        poolAssetBalance,
      ),
    });
  },
};

export const yieldBasisLtExact = {
  methods: (input) => input.route.direction === "deposit" ? depositExactMethods() : Object.freeze([
    localZeroExactMethod<
      YieldBasisLtDescriptor,
      YieldBasisLtRoute,
      YieldBasisLtExactEvidence
    >("local-zero", (input) => Object.freeze({
      amountOut: 0n,
      evidence: evidence(input, 0n, 0n, 0n, 0n),
    })),
    Object.freeze({
      id: "yieldbasis-lt-withdraw-preview",
      kind: "request-program" as const,
      chainAmountQuote: true as const,
      program,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    lt: lowerAddress(descriptor.lt),
    asset: lowerAddress(descriptor.asset),
    share: lowerAddress(descriptor.share),
    assetCoinIndex: descriptor.assetCoinIndex,
    direction: route.direction,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
  YieldBasisLtExactEvidence
>;

function evidence(
  input: Input,
  amountOut: bigint,
  liveSupplyTokens: bigint,
  liquidityTotal: bigint,
  poolAssetBalance: bigint,
): YieldBasisLtExactEvidence {
  return Object.freeze({
    kind: "yieldbasis-lt-withdraw-preview",
    source: Object.freeze({ ...input.source }),
    lt: input.descriptor.lt,
    asset: input.descriptor.asset,
    direction: "withdraw",
    amountIn: input.amountIn,
    amountOut,
    liveSupplyTokens,
    liquidityTotal,
    poolAssetBalance,
    assetCoinIndex: input.descriptor.assetCoinIndex,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
