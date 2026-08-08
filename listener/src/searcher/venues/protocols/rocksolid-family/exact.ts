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
import { assertRocksolidInvocation } from "./binding.js";
import { ROCKSOLID_INTERFACE } from "./codec.js";
import type {
  RocksolidDescriptor,
  RocksolidExactEvidence,
  RocksolidRoute,
} from "./types.js";

const rocksolidRequestProgram: ExactRequestProgram<
  RocksolidDescriptor,
  RocksolidRoute,
  RocksolidExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertRocksolidInvocation(descriptor, route);
    return { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertRocksolidInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("RockSolid exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-convert",
      input.descriptor.target,
      ROCKSOLID_INTERFACE.encodeFunctionData(
        "convertToShares",
        [input.amountIn],
      ),
    )]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n),
      });
    }
    const result = returnedResult(results, "exact-convert");
    assertSource(result.source, programInput.source);
    const amountOut = BigInt(
      ROCKSOLID_INTERFACE.decodeFunctionResult(
        "convertToShares",
        result.data,
      )[0],
    );
    if (amountOut <= 0n) {
      throw new Error("RockSolid exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const rocksolidExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      RocksolidDescriptor,
      RocksolidRoute,
      RocksolidExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n),
      }),
    ),
    Object.freeze({
      id: "rocksolid-quote",
      kind: "request-program" as const,
      program: rocksolidRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  RocksolidDescriptor,
  RocksolidRoute,
  RocksolidExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: RocksolidDescriptor;
    readonly route: RocksolidRoute;
    readonly amountIn: bigint;
    readonly source: RocksolidExactEvidence["source"];
  },
  amountOut: bigint,
): RocksolidExactEvidence {
  return Object.freeze({
    kind: "rocksolid-convert-to-shares",
    source: input.source,
    target: input.descriptor.target,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
