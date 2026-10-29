import {
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import {
  assertSource,
  returnedResult,
} from "../standard-family/common.js";
import { assertDefaultCollateralInvocation } from "./binding.js";
import {
  DEFAULT_COLLATERAL_ERC20_INTERFACE,
  DEFAULT_COLLATERAL_FEE_BPS,
  DEFAULT_COLLATERAL_INTERFACE,
  declaredCallRequest,
  defaultCollateralQuote,
  defaultCollateralSourceValid,
  defaultCollateralUint,
} from "./codec.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralExactEvidence,
  DefaultCollateralRoute,
} from "./types.js";

type Input = ExactQuoteInput<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute
>;

const SUPPLY_ID = "exact-total-supply";
const BACKING_ID = "exact-backing";
const ASSET_ID = "exact-asset";

function evidence(
  input: Input,
  amountOut: bigint,
  totalSupply: bigint,
  backing: bigint,
): DefaultCollateralExactEvidence {
  return Object.freeze({
    kind: "default-collateral-one-to-one" as const,
    source: Object.freeze({ ...input.source }),
    vault: input.descriptor.vault,
    share: input.descriptor.share,
    asset: input.descriptor.asset,
    amountIn: input.amountIn,
    amountOut,
    totalSupply,
    backing,
    feeBps: DEFAULT_COLLATERAL_FEE_BPS,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}

/**
 * Same-state quote. The only reads are the vault's totalSupply, the vault's
 * own asset balance and its asset() view at the exact quote source; the
 * verified implementation redeems 1:1 only while backing === totalSupply, so
 * any other state fails instead of returning an invented amount.
 */
const exactProgram: ExactRequestProgram<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
  DefaultCollateralExactEvidence
> = {
  requirements: ({ descriptor, route, amountIn }) => {
    assertDefaultCollateralInvocation(descriptor, route);
    return { transports: amountIn === 0n ? [] : ["eth-call" as const] };
  },
  buildRequests(input) {
    assertDefaultCollateralInvocation(input.descriptor, input.route);
    defaultCollateralUint(input.amountIn);
    defaultCollateralSourceValid(input.source);
    if (input.amountIn === 0n) return Object.freeze([]);
    return Object.freeze([
      declaredCallRequest(
        ASSET_ID,
        input.descriptor.vault,
        DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("asset"),
      ),
      declaredCallRequest(
        SUPPLY_ID,
        input.descriptor.vault,
        DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("totalSupply"),
      ),
      declaredCallRequest(
        BACKING_ID,
        input.descriptor.asset,
        DEFAULT_COLLATERAL_ERC20_INTERFACE.encodeFunctionData("balanceOf", [
          input.descriptor.vault,
        ]),
      ),
    ]);
  },
  decode({ programInput, initialResults }) {
    assertDefaultCollateralInvocation(
      programInput.descriptor,
      programInput.route,
    );
    if (programInput.amountIn === 0n) {
      if (initialResults.length !== 0) {
        throw new Error("default-collateral zero exact has unexpected state");
      }
      return Object.freeze({
        amountOut: 0n,
        evidence: evidence(programInput, 0n, 0n, 0n),
      });
    }
    for (const id of [ASSET_ID, SUPPLY_ID, BACKING_ID]) {
      const result = initialResults.find((candidate) => candidate.id === id);
      if (result === undefined) {
        throw new Error(`default-collateral exact result ${id} is missing`);
      }
      if (!result.ok) throw new RequiredAdapterRequestError(result);
      assertSource(result.source, programInput.source);
      if (result.completion !== "returned") {
        throw new Error(
          `default-collateral exact read ${id} did not return at the quote source`,
        );
      }
    }
    const asset = String(DEFAULT_COLLATERAL_INTERFACE.decodeFunctionResult(
      "asset",
      returnedResult(initialResults, ASSET_ID).data,
    )[0]).toLowerCase();
    if (asset !== programInput.descriptor.asset.toLowerCase()) {
      throw new Error(
        "default-collateral exact asset() does not match the verified descriptor",
      );
    }
    const totalSupply = BigInt(DEFAULT_COLLATERAL_INTERFACE.decodeFunctionResult(
      "totalSupply",
      returnedResult(initialResults, SUPPLY_ID).data,
    )[0]);
    const backing = BigInt(
      DEFAULT_COLLATERAL_ERC20_INTERFACE.decodeFunctionResult(
        "balanceOf",
        returnedResult(initialResults, BACKING_ID).data,
      )[0],
    );
    const amountOut = defaultCollateralQuote({
      amountIn: programInput.amountIn,
      totalSupply,
      backing,
    });
    if (amountOut <= 0n) {
      throw new Error("default-collateral exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, amountOut, totalSupply, backing),
    });
  },
};

export const defaultCollateralExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      DefaultCollateralDescriptor,
      DefaultCollateralRoute,
      DefaultCollateralExactEvidence
    >("local-zero", (input) => Object.freeze({
      amountOut: 0n,
      evidence: evidence(input, 0n, 0n, 0n),
    })),
    Object.freeze({
      id: "default-collateral-backing-quote",
      kind: "request-program" as const,
      trialState: {
        unsupportedReason:
          "default-collateral quotes read the vault supply/backing pair per " +
          "quote; no sequential trial overlay is modeled",
      },
      program: exactProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    vault: route.target.toLowerCase(),
    share: descriptor.share.toLowerCase(),
    asset: descriptor.asset.toLowerCase(),
    quoteSemantics: "default-collateral-one-to-one-v1",
    feeBps: DEFAULT_COLLATERAL_FEE_BPS,
    bindingFingerprint: route.bindingRef.fingerprint,
    implementationCodeHash: descriptor.implementationCodeHash,
  }),
} satisfies ExactQuoteSemantics<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
  DefaultCollateralExactEvidence
>;
