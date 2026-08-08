import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSource,
  effectsProjection,
  lowerAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  assertErc4626SiloInvocation,
  erc4626SiloRedeemSimulation,
  validateErc4626SiloRedeemEffects,
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
      : {
          transports: ["effect-delta-simulation" as const],
          caller: "executor" as const,
          effects: [
            "return-data" as const,
            "token-delta" as const,
            "total-supply-delta" as const,
            "logs" as const,
          ],
        };
  },
  buildRequests(input) {
    assertErc4626SiloInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("ERC4626 Silo exact input cannot be negative");
    }
    return input.amountIn === 0n
      ? []
      : Object.freeze([erc4626SiloRedeemSimulation({
          id: "exact-active-redeem",
          vault: input.descriptor.vault,
          payoutToken: input.descriptor.payoutToken,
          actor: input.executor,
          callerRef: Object.freeze({ kind: "executor" as const }),
          amountIn: input.amountIn,
        })]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, null),
      });
    }
    const result = successfulResult(results, "exact-active-redeem");
    assertSource(result.source, programInput.source);
    const amountOut = validateErc4626SiloRedeemEffects({
      result,
      vault: programInput.descriptor.vault,
      payoutToken: programInput.descriptor.payoutToken,
      actor: programInput.executor,
      amountIn: programInput.amountIn,
    });
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, result),
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
        evidence: exactEvidence(input, 0n, null),
      }),
    ),
    Object.freeze({
      id: "active-redeem-simulation",
      kind: "request-program" as const,
      program: erc4626SiloRedeemRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    vault: lowerAddress(descriptor.vault),
    payoutToken: lowerAddress(descriptor.payoutToken),
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
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
  amountOut: bigint,
  result: Extract<AdapterRequestResult, { readonly ok: true }> | null,
): Erc4626SiloRedeemExactEvidence {
  return Object.freeze({
    kind: "erc4626-silo-active-redeem",
    source: input.source,
    vault: input.descriptor.vault,
    payoutToken: input.descriptor.payoutToken,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
    effectsHash: result === null
      ? hashCanonical([])
      : hashCanonical(effectsProjection(result.effects)),
  });
}
