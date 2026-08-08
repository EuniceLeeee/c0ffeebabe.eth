import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { assertAstraRouteBinding } from "./binding.js";
import {
  ASTRA_MULTITOKEN_INTERFACE,
  assertSameSource,
  assertSource,
  decodeUint,
  sameAddress,
} from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenExactEvidence,
  AstraMultiTokenRoute,
} from "./types.js";

const EXACT_RETURN_ID = "exact-get-return";

const astraMultiTokenRequestProgram: ExactRequestProgram<
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
  AstraMultiTokenExactEvidence
> = {
  requirements(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("astra-multitoken exact amountIn cannot be negative");
    }
    return { transports: ["eth-call"] };
  },
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("astra-multitoken exact amountIn cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([Object.freeze({
      id: EXACT_RETURN_ID,
      kind: "eth-call" as const,
      to: input.descriptor.target,
      data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("getReturn", [
        input.route.tokenIn,
        input.route.tokenOut,
        input.amountIn,
      ]),
      completion: "return-data" as const,
    })]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    if (programInput.amountIn < 0n) {
      throw new Error("astra-multitoken exact amountIn cannot be negative");
    }
    const successful = results.map((result) => {
      if (!result.ok) {
        throw new Error(`astra-multitoken exact unresolved: ${result.failure}`);
      }
      return result;
    });
    assertSameSource(successful);
    assertSource(successful[0].source, programInput.source);
    const amountOut = decodeUint(results, EXACT_RETURN_ID, "getReturn");
    if (amountOut <= 0n) {
      throw new Error("astra-multitoken exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const astraMultiTokenExact = {
  methods: () => Object.freeze([Object.freeze({
    ...localZeroExactMethod<
      AstraMultiTokenDescriptor,
      AstraMultiTokenRoute,
      AstraMultiTokenExactEvidence
    >("local-zero", (input) => {
      assertInvocation(input.descriptor, input.route);
      return zeroQuote(input);
    }),
  }), Object.freeze({
    id: "get-return",
    kind: "request-program" as const,
    program: astraMultiTokenRequestProgram,
  })]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: descriptor.target,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
  AstraMultiTokenExactEvidence
>;

function zeroQuote(input: {
  readonly descriptor: AstraMultiTokenDescriptor;
  readonly route: AstraMultiTokenRoute;
  readonly amountIn: bigint;
  readonly source: AstraMultiTokenExactEvidence["source"];
}) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, 0n),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: AstraMultiTokenDescriptor;
    readonly route: AstraMultiTokenRoute;
    readonly amountIn: bigint;
    readonly source: AstraMultiTokenExactEvidence["source"];
  },
  amountOut: bigint,
): AstraMultiTokenExactEvidence {
  return Object.freeze({
    kind: "astra-multitoken-get-return" as const,
    source: input.source,
    target: input.descriptor.target,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}

function assertInvocation(
  descriptor: AstraMultiTokenDescriptor,
  route: AstraMultiTokenRoute,
): void {
  assertAstraRouteBinding(descriptor, route);
}
