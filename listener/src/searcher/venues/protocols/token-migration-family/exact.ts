import type { ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertInvocation, bindingProjection } from "./binding.js";
import { decodeQuote, quoteRequests } from "./state.js";
import { nonzero } from "./codec.js";
import type { Descriptor, Route, ExactEvidence } from "./types.js";
const program: ExactRequestProgram<Descriptor, Route, ExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    nonzero(input.executor);
    if (input.amountIn <= 0n) throw new Error("migration requires positive input");
    return quoteRequests(input.descriptor, input.amountIn);
  },
  decode({ programInput: input, initialResults }) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn <= 0n) throw new Error("migration requires positive input");
    const s = decodeQuote(input.descriptor, input.amountIn, initialResults, input.source);
    if (s.halted) throw new Error("migration halted");
    if (s.amountOut <= 0n) throw new Error("migration zero output is not searchable");
    if (s.amountOut > s.inventory) throw new Error("migration insufficient output inventory");
    return { amountOut: s.amountOut, evidence: {
      kind: "mantle-migration-amount-quote", source: s.source, executor: nonzero(input.executor),
      bindingFingerprint: input.route.bindingRef.fingerprint, amountIn: input.amountIn, amountOut: s.amountOut,
    } };
  },
};
export const exact = {
  methods: () => [{ id: "mantle-chain-amount", kind: "request-program" as const, chainAmountQuote: true as const, program }],
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({ ...bindingProjection(descriptor),
    bindingFingerprint: route.bindingRef.fingerprint, executor: nonzero(executor).toLowerCase() }),
} satisfies ExactQuoteSemantics<Descriptor, Route, ExactEvidence>;
