import type { RuntimeMathModel } from "../../declarative-runtime-math.js";

/** The Vault swap amount is an unsigned exact-input budget. The handwritten
 * runtime rejects every amount whose high bit is set before the call; this
 * arithmetic-only model reproduces that check inside the shared runtime
 * compiler. No protocol branch or handler is added to central code. */
export const balancerV2SwapAmountGuard: RuntimeMathModel = {
  id: "balancer-v2-swap-amount-guard",
  version: 1,
  inputs: ["amount"],
  outputs: ["high"],
  operations: [
    { name: "high", op: "shr", left: { input: "amount" }, right: { constant: "255" } },
  ],
};
