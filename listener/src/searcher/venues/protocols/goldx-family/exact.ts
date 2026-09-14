import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  MAX_UINT256,
  returnedResult,
} from "../standard-family/common.js";
import { assertGoldxInvocation } from "./binding.js";
import { GOLDX_INTERFACE, goldxQuote } from "./codec.js";
import type {
  GoldxDescriptor,
  GoldxExactEvidence,
  GoldxRoute,
} from "./types.js";

const goldxRequestProgram: ExactRequestProgram<
  GoldxDescriptor,
  GoldxRoute,
  GoldxExactEvidence
> = {
  requirements: ({ descriptor, route, amountIn }) => {
    assertGoldxInvocation(descriptor, route);
    return { transports: amountIn === 0n ? [] : ["eth-call" as const] };
  },
  buildRequests(input) {
    assertGoldxInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("GOLDx exact input cannot be negative");
    }
    if (input.amountIn > MAX_UINT256) throw new Error("GOLDx exact input exceeds uint256");
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-unit",
      input.descriptor.target,
      GOLDX_INTERFACE.encodeFunctionData("unit"),
    )]);
  },
  decode({ programInput, initialResults }) {
    assertGoldxInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn < 0n || programInput.amountIn > MAX_UINT256) {
      throw new Error("GOLDx exact input is outside uint256 range");
    }
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    if (results.length !== 1 || results[0]?.id !== "exact-unit") {
      throw new Error("GOLDx exact results are missing or ambiguous");
    }
    const result = returnedResult(results, "exact-unit");
    if (!/^0x[0-9a-fA-F]{64}$/.test(result.data)) throw new Error("GOLDx invalid uint256 result");
    assertSource(result.source, programInput.source);
    const unit = BigInt(
      GOLDX_INTERFACE.decodeFunctionResult("unit", result.data)[0],
    );
    const amountOut = goldxQuote(programInput.amountIn, unit);
    if (amountOut <= 0n) {
      throw new Error("GOLDx exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, unit),
    });
  },
};

export const goldxExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<GoldxDescriptor, GoldxRoute, GoldxExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "goldx-unit",
      kind: "request-program" as const,
      program: goldxRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    quoteSemantics: "source-unit-checked-formula-v1",
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  GoldxDescriptor,
  GoldxRoute,
  GoldxExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: GoldxDescriptor;
    readonly route: GoldxRoute;
    readonly amountIn: bigint;
    readonly source: GoldxExactEvidence["source"];
  },
  amountOut: bigint,
  unit: bigint,
): GoldxExactEvidence {
  return Object.freeze({
    kind: "goldx-unit-quote",
    source: input.source,
    target: input.descriptor.target,
    unit,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
