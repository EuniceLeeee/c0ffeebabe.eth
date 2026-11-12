import assert from "node:assert/strict";
import {
  prepareCreditFamilyRoutes, executeCreditRiskQuote,
  issueCreditExecutionHandle, buildCreditExecutionFragment,
  type CreditRouteRuntimeHandle, type SealedCreditRiskQuoteHandle,
} from "../adapter-credit-runtime.js";
import type { ProtocolJsonAcceptanceContext } from "./protocol-json-acceptance-context.js";

type CreditContext = Pick<ProtocolJsonAcceptanceContext,
  "family" | "instance" | "source" | "executor" | "runtime" | "control" | "catalog">;

/** Uses the production Credit issuer; no ordinary Exact surrogate or reconstructed seal. */
export async function quoteAcceptanceCredit(input: {
  context: CreditContext; routeKey: string; amountIn: bigint; debtBps: number;
}) {
  const { family, instance, source, executor, runtime, control } = input.context;
  assert("credit" in family.plugin, "Credit case requires the installed Credit capability");
  const debtBps = BigInt(input.debtBps);
  assert(family.plugin.credit.risk.debtBpsCandidates.includes(debtBps), "Credit policy must be declared by the Family");
  const routes = prepareCreditFamilyRoutes({ family, instance, source, generation: source.generation });
  const selected = routes.routes.filter(route => route.routeKey === input.routeKey);
  assert.equal(selected.length, 1, "Credit case must select one issued route");
  const route = selected[0]!;
  const risk = await executeCreditRiskQuote({ family, route, collateralAmount: input.amountIn,
    debtBps, executor, runtimeEvidence: [], source, generation: source.generation, runtime, control });
  if (risk.status === "resolved") assert.equal(risk.collateralAmount, input.amountIn, "Credit quote changed requested input");
  return { route, risk };
}

export function buildAcceptanceCreditFragment(input: {
  context: CreditContext; route: CreditRouteRuntimeHandle;
  risk: SealedCreditRiskQuoteHandle; minAmountOut: bigint;
}) {
  const { family, source, executor, catalog } = input.context;
  const handle = issueCreditExecutionHandle({ family, route: input.route, risk: input.risk,
    minAmountOut: input.minAmountOut, executor, runtimeEvidence: [], source, generation: source.generation });
  return buildCreditExecutionFragment({ family, actionOwnership: catalog, handle });
}
