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
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_VAULT_INTERFACE,
  assertMetronomeHgUsdcInvocation,
} from "./shared.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcExactEvidence,
  MetronomeHgUsdcRoute,
} from "./types.js";

const metronomeHgUsdcRequestProgram: ExactRequestProgram<
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
  MetronomeHgUsdcExactEvidence
> = {
  requirements(input) {
    assertMetronomeHgUsdcInvocation(input.descriptor, input.route);
    return input.amountIn === 0n
      ? { transports: [] }
      : { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertMetronomeHgUsdcInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("Metronome hgUSDC exact input cannot be negative");
    }
    return input.amountIn === 0n
      ? []
      : Object.freeze([callRequest(
          "exact-curve-quote",
          input.descriptor.curve,
          METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionData(
            "get_dy",
            [1n, 0n, input.amountIn],
          ),
        )]);
  },
  buildDependentProgram({
    programInput,
    completedRound,
    initialResults,
    priorEvidence,
  }) {
    if (programInput.amountIn === 0n || completedRound !== 0) return null;
    const priorResults = collectRequestProgramResults(
      initialResults,
      priorEvidence,
    );
    const curveOut = decodeUint(
      METRONOME_HGUSDC_CURVE_INTERFACE,
      "get_dy",
      priorResults,
      "exact-curve-quote",
    );
    return bindRequestResultRound(
      { transports: ["eth-call"] },
      Object.freeze([callRequest(
        "exact-vault-preview",
        programInput.descriptor.vault,
        METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionData(
          "previewRedeem",
          [curveOut],
        ),
      )]),
    );
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    const results = collectRequestProgramResults(
      initialResults,
      dependentEvidence,
    );
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    const curve = returnedResult(results, "exact-curve-quote");
    const vault = returnedResult(results, "exact-vault-preview");
    const source = assertSameSource([curve, vault]);
    assertSource(source, programInput.source);
    const curveOut = BigInt(
      METRONOME_HGUSDC_CURVE_INTERFACE.decodeFunctionResult(
        "get_dy",
        curve.data,
      )[0],
    );
    const amountOut = BigInt(
      METRONOME_HGUSDC_VAULT_INTERFACE.decodeFunctionResult(
        "previewRedeem",
        vault.data,
      )[0],
    );
    if (curveOut <= 0n || amountOut <= 0n) {
      throw new Error("Metronome hgUSDC exact quote chain returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, curveOut, amountOut),
    });
  },
};

export const metronomeHgUsdcExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      MetronomeHgUsdcDescriptor,
      MetronomeHgUsdcRoute,
      MetronomeHgUsdcExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "curve-then-vault",
      kind: "request-program" as const,
      program: metronomeHgUsdcRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    router: lowerAddress(descriptor.router),
    curve: lowerAddress(descriptor.curve),
    vault: lowerAddress(descriptor.vault),
    tokenIn: lowerAddress(descriptor.tokenIn),
    tokenOut: lowerAddress(descriptor.tokenOut),
    pathHash: descriptor.pathHash,
    bindingFingerprint: route.bindingRef.fingerprint,
    exactChain: "curve-get-dy->vault-preview-redeem-v1",
  }),
} satisfies ExactQuoteSemantics<
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
  MetronomeHgUsdcExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: MetronomeHgUsdcDescriptor;
    readonly route: MetronomeHgUsdcRoute;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
  },
  curveOut: bigint,
  amountOut: bigint,
): MetronomeHgUsdcExactEvidence {
  return Object.freeze({
    kind: "metronome-hgusdc-dependent-quote",
    source: input.source,
    router: input.descriptor.router,
    curve: input.descriptor.curve,
    vault: input.descriptor.vault,
    amountIn: input.amountIn,
    curveOut,
    amountOut,
    pathHash: input.descriptor.pathHash,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
