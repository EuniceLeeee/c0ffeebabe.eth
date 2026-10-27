import type { ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { standardFamily } from "./standard-base.js";
import type { erc4626Exact as OriginalShared } from "../erc4626-family/exact.js";
const erc4626Exact = standardFamily.exact as unknown as typeof OriginalShared;
import type { Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence } from "../erc4626-family/types.js";
import { checkStakedUsdatGuard, stakedUsdatGuardRequests } from "./identity-proof.js";

export const stakedUsdatExact = {
  ...erc4626Exact,
  methods: () => Object.freeze(erc4626Exact.methods().map(method => {
    if (method.kind !== "request-program") return method;
    const base = method.program;
    const program: ExactRequestProgram<Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence> = {
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
} satisfies ExactQuoteSemantics<Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence>;
