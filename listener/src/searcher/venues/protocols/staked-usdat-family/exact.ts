import type { ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { standardFamily } from "./standard-base.js";
import type { StakedUsdatDescriptor, StakedUsdatRoute, StakedUsdatExactEvidence } from "./types.js";
import { checkStakedUsdatGuard, stakedUsdatGuardRequests } from "./identity-proof.js";
const conversionExact = standardFamily.exact as unknown as ExactQuoteSemantics<StakedUsdatDescriptor, StakedUsdatRoute, StakedUsdatExactEvidence>;

export const stakedUsdatExact = {
  ...conversionExact,
  methods: input => Object.freeze(conversionExact.methods(input).map(method => {
    if (method.kind !== "request-program") return method;
    const base = method.program;
    const program: ExactRequestProgram<StakedUsdatDescriptor, StakedUsdatRoute, StakedUsdatExactEvidence> = {
      ...base,
      requirements: () => ({ transports: ["get-code" as const, "get-storage" as const, "eth-call" as const] }),
      buildRequests(input) {
        if (!input.descriptor.stakedUsdat) throw new Error("StakedUSDat exact binding missing");
        return input.amountIn === 0n ? base.buildRequests(input) : Object.freeze([
          ...stakedUsdatGuardRequests("exact-staked", input.descriptor.vault, input.descriptor.stakedUsdat, input.executor),
          ...base.buildRequests(input),
        ]);
      },
      decode(input) {
        const { programInput: p } = input;
        if (!p.descriptor.stakedUsdat) throw new Error("StakedUSDat exact binding missing");
        if (p.amountIn !== 0n) checkStakedUsdatGuard(input.initialResults, "exact-staked", p.descriptor.vault,
          p.descriptor.stakedUsdat, p.source);
        return base.decode(input);
      },
    };
    return Object.freeze({ ...method, program });
  })),
} satisfies ExactQuoteSemantics<StakedUsdatDescriptor, StakedUsdatRoute, StakedUsdatExactEvidence>;
