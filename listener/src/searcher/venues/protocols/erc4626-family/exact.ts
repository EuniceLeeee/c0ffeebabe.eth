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
import { checkCustodianGuard, custodianGuardRequests } from "./custodian.js";
import { custodianProgram } from "./custodian-execution.js";
import { runtimeExecutor } from "../../runtime-execution.js";
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
    return descriptor.custodian === undefined ? { transports: ["eth-call"] } :
      { transports: ["eth-call", "get-code", "get-storage"], caller: "executor" };
  },
  buildRequests(input) {
    assertErc4626Invocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("ERC4626 exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    if (input.descriptor.custodian !== undefined) {
      // No chain baseline may masquerade as an updated inventory after a
      // preceding state-changing trial leg. Sequential quoting is not claimed.
      if (input.prefix?.length || input.runtimeEvidence.length) throw new Error("Custodian sequential/pending quote unsupported");
      runtimeExecutor(input.executor, input.descriptor.custodian.proxyAdmin);
      custodianProgram(input.descriptor, input.executor, input.route.direction);
    }
    return Object.freeze([
      ...(input.descriptor.custodian === undefined ? [] : custodianGuardRequests("exact-custodian", input.descriptor.vault,
        input.descriptor.custodian, input.executor)),
      callRequest(
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
    if (programInput.descriptor.custodian !== undefined) {
      const s = checkCustodianGuard(results, "exact-custodian", programInput.descriptor.vault,
        programInput.descriptor.custodian, true, programInput.source);
      // maxRedeem(executor) also includes its pre-trade frxUSD balance, which is
      // NOT this trial's input. The contract's inventory bound is combo[3].
      const deposit = programInput.route.direction === "deposit";
      if (programInput.amountIn > (deposit ? s.depositCapacity : s.capacity) || amountOut > (deposit ? s.mintCapacity : s.inventory))
        throw new Error("custodian_conversion_capacity_exceeded");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const erc4626Exact = {
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
      chainAmountQuote: true as const,
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
} satisfies ExactQuoteSemantics<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626ExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: Erc4626Descriptor;
    readonly route: Erc4626Route;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
    readonly executor?: string;
  },
  amountOut: bigint,
): Erc4626ExactEvidence {
  return Object.freeze({
    kind: input.descriptor.custodian === undefined ? "erc4626-preview" : "frax-custodian-preview",
    ...(input.descriptor.custodian === undefined ? {} : { executor: input.executor }),
    source: input.source,
    vault: input.descriptor.vault,
    direction: input.route.direction,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
