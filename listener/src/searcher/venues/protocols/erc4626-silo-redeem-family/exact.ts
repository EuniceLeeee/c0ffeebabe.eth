import {
  bindRequestResultRound,
  collectRequestProgramResults,
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  decodeUint,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import {
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
  assertErc4626SiloInvocation,
} from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemExactEvidence,
  Erc4626SiloRedeemRoute,
} from "./types.js";

const erc4626SiloRedeemRequestProgram: ExactRequestProgram<
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
  Erc4626SiloRedeemExactEvidence
> = {
  requirements(input) {
    assertErc4626SiloInvocation(input.descriptor, input.route);
    return input.amountIn === 0n
      ? { transports: [] }
      : { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertErc4626SiloInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("ERC4626 Silo exact input cannot be negative");
    }
    return input.amountIn === 0n
      ? []
      : Object.freeze([callRequest(
          "exact-preview-redeem",
          input.descriptor.vault,
          ERC4626_SILO_INTERFACE.encodeFunctionData(
            "previewRedeem",
            [input.amountIn],
          ),
        )]);
  },
  buildDependentProgram({ programInput, completedRound, initialResults, priorEvidence }) {
    if (programInput.amountIn === 0n || completedRound !== 0) return null;
    const results = collectRequestProgramResults(initialResults, priorEvidence);
    assertSource(returnedResult(results, "exact-preview-redeem").source, programInput.source);
    const previewAssets = decodeUint(
      ERC4626_SILO_INTERFACE, "previewRedeem", results, "exact-preview-redeem",
    );
    // previewRedeem returns underlying assets, not the payout token's shares.
    // The attested silo uses previewWithdraw (round up), not convertToShares.
    return bindRequestResultRound(
      { transports: ["eth-call"] },
      Object.freeze([callRequest(
        "exact-preview-withdraw",
        programInput.descriptor.payoutToken,
        ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionData("previewWithdraw", [previewAssets]),
      )]),
    );
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    assertErc4626SiloInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn < 0n) {
      throw new Error("ERC4626 Silo exact input cannot be negative");
    }
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    const preview = returnedResult(results, "exact-preview-redeem");
    const payout = returnedResult(results, "exact-preview-withdraw");
    assertSource(assertSameSource([preview, payout]), programInput.source);
    const previewAssets = decodeUint(
      ERC4626_SILO_INTERFACE, "previewRedeem", results, "exact-preview-redeem",
    );
    const amountOut = decodeUint(
      ERC4626_SILO_PAYOUT_INTERFACE, "previewWithdraw", results, "exact-preview-withdraw",
    );
    if (previewAssets <= 0n || amountOut <= 0n) {
      throw new Error("ERC4626 Silo exact preview chain returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, previewAssets, amountOut),
    });
  },
};

export const erc4626SiloRedeemExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      Erc4626SiloRedeemDescriptor,
      Erc4626SiloRedeemRoute,
      Erc4626SiloRedeemExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "preview-redeem-then-withdraw",
      kind: "request-program" as const,
      chainAmountQuote: true as const,
      program: erc4626SiloRedeemRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    vault: lowerAddress(descriptor.vault),
    payoutToken: lowerAddress(descriptor.payoutToken),
    bindingFingerprint: route.bindingRef.fingerprint,
    exactChain: "preview-redeem->preview-withdraw-v1",
  }),
} satisfies ExactQuoteSemantics<
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
  Erc4626SiloRedeemExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: Erc4626SiloRedeemDescriptor;
    readonly route: Erc4626SiloRedeemRoute;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
  },
  previewAssets: bigint,
  amountOut: bigint,
): Erc4626SiloRedeemExactEvidence {
  return Object.freeze({
    kind: "erc4626-silo-preview-chain",
    source: input.source,
    vault: input.descriptor.vault,
    payoutToken: input.descriptor.payoutToken,
    amountIn: input.amountIn,
    previewAssets,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
