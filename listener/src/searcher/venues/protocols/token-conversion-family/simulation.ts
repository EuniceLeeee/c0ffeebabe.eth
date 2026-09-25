import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "../../adapter-request-program.js";
import { returnedResult, sameAddress } from "../standard-family/common.js";
import { ABI, nonzero, positiveAmount } from "./variants.js";
import type { Direction } from "./types.js";

export const simulationRequirements: RequestRequirements = Object.freeze({
  transports: ["effect-delta-simulation"] as const, caller: "executor",
  effects: ["return-data", "token-delta", "total-supply-delta", "logs"] as const,
});
export function conversionSimulation(id: string, target: string, asset: string, direction: Direction, amount: bigint): AdapterRequest {
  nonzero(target); nonzero(asset); positiveAmount(amount);
  if (sameAddress(target, asset) || !["mint", "redeem"].includes(direction)) throw new Error("invalid conversion simulation");
  const caller = { kind: "executor" as const };
  return {
    id, kind: "effect-delta-simulation",
    preCalls: direction === "mint" ? [0n, amount].map(value => ({
      caller, to: asset, data: ABI.encodeFunctionData("approve", [target, value]),
    })) : [],
    call: { caller, executionMode: "impersonated-call-frame", to: target, data: ABI.encodeFunctionData(direction, [amount]) },
    overrideIntent: { caller, tokenBalances: [{ token: direction === "mint" ? asset : target, amount }] },
    observeTokenBalances: [
      { token: asset, account: caller }, { token: target, account: caller },
      { token: asset, account: target },
    ],
    observe: ["return-data", "token-delta", "total-supply-delta", "logs"],
  };
}

// Read balance observations independently of calldata and return data. Do not
// accept an event/return value alone as proof of actual receipt. An unknown
// underlying token's transfer tax or extra debit must fail these invariants.
export function decodeConversionReceipt(results: readonly AdapterRequestResult[], id: string,
  target: string, asset: string, direction: Direction, amount: bigint, executor?: string) {
  positiveAmount(amount);
  const result = returnedResult(results, id);
  const deltas = result.effects?.tokenDeltas ?? [];
  const shareRows = deltas.filter(row => sameAddress(row.token, target));
  if (shareRows.length !== 1) throw new Error("missing or duplicate conversion share balance");
  const actor = nonzero(shareRows[0]!.account);
  if (sameAddress(actor, target) || sameAddress(actor, asset) || (executor !== undefined && !sameAddress(actor, executor))) {
    throw new Error("conversion receipt actor mismatch");
  }
  const sign = direction === "mint" ? 1n : -1n;
  const delta = (token: string, account: string): bigint => {
    const rows = deltas.filter(row => sameAddress(row.token, token) && sameAddress(row.account, account));
    if (rows.length !== 1) throw new Error("missing or duplicate conversion token balance");
    return rows[0]!.delta;
  };
  const supplyRows = (result.effects?.totalSupplyDeltas ?? []).filter(row => sameAddress(row.token, target));
  const returned = BigInt(ABI.decodeFunctionResult(direction, result.data)[0]);
  if (returned !== amount || delta(target, actor) !== sign * amount ||
      delta(asset, actor) !== -sign * amount || delta(asset, target) !== sign * amount ||
      supplyRows.length !== 1 || supplyRows[0]!.delta !== sign * amount) {
    throw new Error("conversion receipt/supply/backing mismatch");
  }
  const eventName = direction === "mint" ? "Minted" : "Redeemed";
  const events = (result.effects?.logs ?? []).filter(log => sameAddress(log.address, target))
    .flatMap(log => { try { const event = ABI.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === eventName ? [event] : []; } catch { return []; } });
  if (events.length !== 1 || !sameAddress(events[0]!.args.user, actor) ||
      BigInt(events[0]!.args.btbAmount) !== amount || BigInt(events[0]!.args.btbbAmount) !== amount) {
    throw new Error("conversion lifecycle event mismatch");
  }
  return { source: result.source, actor, amountOut: direction === "mint" ? delta(target, actor) : delta(asset, actor) };
}
