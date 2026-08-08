import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import {
  METRONOME_SYNTH_POOL_INTERFACE,
  assertMetronomeSynthInvocation,
} from "./shared.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthExactEvidence,
  MetronomeSynthRoute,
} from "./types.js";

const metronomeSynthRequestProgram: ExactRequestProgram<
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
  MetronomeSynthExactEvidence
> = {
  requirements(input) {
    assertMetronomeSynthInvocation(input.descriptor, input.route);
    return input.amountIn === 0n
      ? { transports: [] }
      : { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertMetronomeSynthInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("Metronome synth exact input cannot be negative");
    }
    return input.amountIn === 0n
      ? []
      : Object.freeze([callRequest(
          "exact-quote-swap-out",
          input.descriptor.pool,
          METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionData("quoteSwapOut", [
            input.route.tokenIn,
            input.route.tokenOut,
            input.amountIn,
          ]),
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
    const result = returnedResult(results, "exact-quote-swap-out");
    assertSource(result.source, programInput.source);
    const decoded = METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionResult(
      "quoteSwapOut",
      result.data,
    );
    const amountOut = BigInt(decoded[0]);
    const fee = BigInt(decoded[1]);
    if (amountOut <= 0n) {
      throw new Error("Metronome synth exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, fee),
    });
  },
};

export const metronomeSynthExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      MetronomeSynthDescriptor,
      MetronomeSynthRoute,
      MetronomeSynthExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "metronome-synth-quote",
      kind: "request-program" as const,
      program: metronomeSynthRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    pool: lowerAddress(descriptor.pool),
    tokenIn: lowerAddress(route.tokenIn),
    tokenOut: lowerAddress(route.tokenOut),
    oracleBinding: descriptor.oracleBinding,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
  MetronomeSynthExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: MetronomeSynthDescriptor;
    readonly route: MetronomeSynthRoute;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
  },
  amountOut: bigint,
  fee: bigint,
): MetronomeSynthExactEvidence {
  return Object.freeze({
    kind: "metronome-synth-quote",
    source: input.source,
    pool: input.descriptor.pool,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    fee,
    oracleBinding: input.descriptor.oracleBinding,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
