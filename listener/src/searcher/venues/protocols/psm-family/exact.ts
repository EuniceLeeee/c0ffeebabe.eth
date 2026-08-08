import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import { assertPsmInvocation } from "./binding.js";
import { PSM_INTERFACE, psmSellQuote } from "./codec.js";
import type {
  PsmDescriptor,
  PsmExactEvidence,
  PsmRoute,
} from "./types.js";

const psmRequestProgram: ExactRequestProgram<
  PsmDescriptor,
  PsmRoute,
  PsmExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertPsmInvocation(descriptor, route);
    return { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertPsmInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("PSM exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-tin",
      input.descriptor.target,
      PSM_INTERFACE.encodeFunctionData("tin"),
    )]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    const result = returnedResult(results, "exact-tin");
    assertSource(result.source, programInput.source);
    const tin = BigInt(
      PSM_INTERFACE.decodeFunctionResult("tin", result.data)[0],
    );
    const amountOut = psmSellQuote(
      programInput.amountIn,
      tin,
      programInput.descriptor.decimalScale,
    );
    if (amountOut <= 0n) throw new Error("PSM exact quote returned no output");
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, tin),
    });
  },
};

export const psmExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<PsmDescriptor, PsmRoute, PsmExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "psm-quote",
      kind: "request-program" as const,
      program: psmRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    decimalScale: descriptor.decimalScale,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<PsmDescriptor, PsmRoute, PsmExactEvidence>;

function exactEvidence(
  input: {
    readonly descriptor: PsmDescriptor;
    readonly route: PsmRoute;
    readonly amountIn: bigint;
    readonly source: PsmExactEvidence["source"];
  },
  amountOut: bigint,
  tin: bigint,
): PsmExactEvidence {
  return Object.freeze({
    kind: "psm-sell-gem-fee",
    source: input.source,
    target: input.descriptor.target,
    amountIn: input.amountIn,
    amountOut,
    tin,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
