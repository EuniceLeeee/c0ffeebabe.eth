import {
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactQuoteResult,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import {
  canonicalAddress,
  lowerAddress,
  MAX_UINT256,
} from "../standard-family/common.js";
import { assertOriginOusdInvocation } from "./binding.js";
import { originOusdMintQuote } from "./codec.js";
import type {
  OriginOusdDescriptor,
  OriginOusdExactEvidence,
  OriginOusdRoute,
} from "./types.js";

type Input = ExactQuoteInput<OriginOusdDescriptor, OriginOusdRoute>;

/**
 * The vault mint has no preview function and no fee: given an input amount the
 * output is the deterministic 1:1 scaling (USDC 6 -> OUSD 18, 1e12). The method
 * therefore declares no chain reads and no `chainAmountQuote`; the quoted
 * output is the protocol's own integer formula, and the real mint behavior is
 * proven separately by identity (round 3) and checked again by final sim.
 */
const originOusdRequestProgram: ExactRequestProgram<
  OriginOusdDescriptor,
  OriginOusdRoute,
  OriginOusdExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertOriginOusdInvocation(descriptor, route);
    return { transports: [] };
  },
  buildRequests(input) {
    assertOriginOusdInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("Origin OUSD exact input cannot be negative");
    }
    if (input.amountIn > MAX_UINT256) {
      throw new Error("Origin OUSD exact input exceeds uint256");
    }
    // No chain state is read: the ratio is protocol-constant. Sequential
    // trial state is served by the local model below, never by an off-chain
    // hop quote fallback.
    return Object.freeze([]);
  },
  decode({ programInput, initialResults }) {
    assertOriginOusdInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn < 0n || programInput.amountIn > MAX_UINT256) {
      throw new Error("Origin OUSD exact input is outside uint256 range");
    }
    if (initialResults.length !== 0) {
      throw new Error("Origin OUSD exact quote has unexpected independent state");
    }
    const amountOut = originOusdMintQuote(programInput.amountIn);
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const originOusdExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<OriginOusdDescriptor, OriginOusdRoute, OriginOusdExactEvidence>(
      "local-zero",
      input => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n),
      }),
    ),
    Object.freeze({
      id: "origin-ousd-1to1-mint",
      kind: "request-program" as const,
      program: originOusdRequestProgram,
      trialState: { quote(input: Input) {
        assertOriginOusdInvocation(input.descriptor, input.route);
        if (input.amountIn < 0n || input.amountIn > MAX_UINT256) {
          throw new Error("Origin OUSD exact input is outside uint256 range");
        }
        const amountOut = originOusdMintQuote(input.amountIn);
        const result: ExactQuoteResult<OriginOusdExactEvidence> = Object.freeze({
          amountOut,
          evidence: exactEvidence(input, amountOut),
          // The mint debits the caller's USDC, credits the vault, mints to the
          // caller and increases OUSD supply; the exact approval is consumed.
          // These resources are declared so a later dependent read cannot use
          // the stale block baseline. No cell is updated: the formula has no
          // amount-dependent inventory.
          stateEffects: Object.freeze([
            tokenBalanceState(input.descriptor.asset, input.executor),
            tokenBalanceState(input.descriptor.asset, input.descriptor.target),
            tokenBalanceState(input.descriptor.token, input.executor),
            tokenSupplyState(input.descriptor.token),
            allowanceState(input.descriptor.asset, input.executor, input.descriptor.target),
          ]),
        });
        return { status: "quoted" as const, result };
      } },
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    quoteSemantics: "origin-ousd-vault-mint-1to1-no-fee-v1",
    decimalScale: descriptor.decimalScale,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  OriginOusdDescriptor,
  OriginOusdRoute,
  OriginOusdExactEvidence
>;

function allowanceState(token: string, owner: string, spender: string): string {
  return `token-allowance:${lowerAddress(token)}:${lowerAddress(owner)}:${lowerAddress(spender)}`;
}

function exactEvidence(
  input: Input,
  amountOut: bigint,
): OriginOusdExactEvidence {
  return Object.freeze({
    kind: "origin-ousd-1to1-mint" as const,
    source: Object.freeze({ ...input.source }),
    target: canonicalAddress(input.descriptor.target),
    asset: canonicalAddress(input.descriptor.asset),
    token: canonicalAddress(input.descriptor.token),
    amountIn: input.amountIn,
    amountOut,
    decimalScale: input.descriptor.decimalScale,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
