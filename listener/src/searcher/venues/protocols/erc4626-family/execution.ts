// Compatibility export; behavior is compiled by the shared Family pipeline.
import { plugin } from "../../production-families/erc4626.production.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import type { Erc4626Candidate, Erc4626Identity, Erc4626Descriptor, Erc4626Route, Erc4626PricingDescriptor, Erc4626PricingDraft, Erc4626ExactEvidence } from "./types.js";
export const erc4626Execution = plugin.execution as unknown as ExecutionSemantics<Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence>;

import { buildDeclarativeExecutionProgram } from "../../declarative-execution.js";
import { compileDeclarativeValues } from "../../declarative-values.js";
import definition from "./erc4626.json";
const values = compileDeclarativeValues(definition.standard);
/** Legacy function signature delegates to the same declaration as production. */
export function standardRecipientProgram(d: Pick<Erc4626Descriptor, "vault" | "share" | "asset">,
  executor: string, direction: "deposit" | "redeem", recipient: string) {
  return buildDeclarativeExecutionProgram(definition.standard.execution as Parameters<typeof buildDeclarativeExecutionProgram>[0], {
    descriptor: d, direction, executor, recipient, minAmountOut: 1n, settlementRequested: true,
    route: { tokenIn: direction === "deposit" ? d.asset : d.share,
      tokenOut: direction === "deposit" ? d.share : d.asset },
  }, values);
}
