import type { Action } from "../types.js";
import { ADDR, CALL_SELECTORS, lower, short } from "../registry/protocols.js";

export function actionsFromTrace(trace: any, coinbase?: string, actorAddresses: string[] = []): Action[] {
  const actions: Action[] = [];
  const actors = new Set(actorAddresses.map(lower));
  let order = 0;

  function walk(call: any) {
    const to = lower(call.to);
    const from = lower(call.from);
    const input = String(call.input ?? "0x");
    const value = BigInt(call.value ?? "0x0");

    if (to === lower(ADDR.MORPHO) && input.slice(0, 10).toLowerCase() === CALL_SELECTORS.morphoFlashLoan) {
      actions.push(action("fund.flashloan", "callTracer Morpho flashLoan selector", order++, {
        protocol: "Morpho",
        confidence: "high",
      }));
    }

    if (value > 0n && coinbase && to === lower(coinbase)) {
      actions.push(action("settlement.coinbase_payment", "internal ETH transfer to block coinbase", order++, {
        amount: value.toString(),
        confidence: "high",
      }));
    } else if (value > 0n && from !== to && actors.has(to)) {
      actions.push(action("settlement.profit_transfer", `internal ETH transfer to ${short(to)}`, order++, {
        amount: value.toString(),
        confidence: "low",
      }));
    }

    for (const child of call.calls ?? []) walk(child);
  }

  if (trace) walk(trace);
  return actions;
}

function action(
  kind: Action["kind"],
  evidence: string,
  order: number,
  extra: Partial<Action>,
): Action {
  return {
    kind,
    evidence,
    order,
    confidence: extra.confidence ?? "medium",
    protocol: extra.protocol,
    venue: extra.venue,
    tokenIn: extra.tokenIn,
    tokenOut: extra.tokenOut,
    amount: extra.amount,
    address: extra.address,
  };
}
