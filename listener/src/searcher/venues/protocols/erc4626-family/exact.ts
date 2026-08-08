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
import { ERC4626_INTERFACE } from "./abi.js";
import { assertErc4626Invocation } from "./binding.js";
import type {
  Erc4626Descriptor,
  Erc4626ExactEvidence,
  Erc4626Route,
} from "./types.js";

const erc4626RequestProgram: ExactRequestProgram<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626ExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertErc4626Invocation(descriptor, route);
    return { transports: ["eth-call"] };
  },
  buildRequests(input) {
    assertErc4626Invocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("ERC4626 exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-preview",
      input.descriptor.vault,
      ERC4626_INTERFACE.encodeFunctionData(
        input.route.direction === "deposit"
          ? "previewDeposit"
          : "previewRedeem",
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
    const result = returnedResult(results, "exact-preview");
    assertSource(result.source, programInput.source);
    const amountOut = BigInt(ERC4626_INTERFACE.decodeFunctionResult(
      programInput.route.direction === "deposit"
        ? "previewDeposit"
        : "previewRedeem",
      result.data,
    )[0]);
    if (amountOut <= 0n) {
      throw new Error("ERC4626 exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const erc4626Exact: ExactQuoteSemantics<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626ExactEvidence
> = {
  methods: () => Object.freeze([
    localZeroExactMethod<Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n),
      }),
    ),
    Object.freeze({
      id: "erc4626-preview",
      kind: "request-program" as const,
      program: erc4626RequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    vault: lowerAddress(descriptor.vault),
    asset: lowerAddress(descriptor.asset),
    share: lowerAddress(descriptor.share),
    direction: route.direction,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
};

function exactEvidence(
  input: {
    readonly descriptor: Erc4626Descriptor;
    readonly route: Erc4626Route;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
  },
  amountOut: bigint,
): Erc4626ExactEvidence {
  return Object.freeze({
    kind: "erc4626-preview",
    source: input.source,
    vault: input.descriptor.vault,
    direction: input.route.direction,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
