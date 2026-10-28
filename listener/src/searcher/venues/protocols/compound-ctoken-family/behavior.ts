import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { MaxUint256 } from "ethers";
import { assertSource, sameAddress } from "../standard-family/common.js";
import { CTOKEN_INTERFACE, CTOKEN_EXCHANGE_RATE_SCALE } from "./abi.js";
import { redemptionAmount } from "./codec.js";
import type { CompoundCTokenRegistryEvidence } from "./types.js";

const caller = Object.freeze({ kind: "executor" as const });
export const REDEEM_PROBE_ID = "active-redeem";

/** A bounded behavior sample, NOT the production effective input amount. */
export function probeShares(rate: bigint, cash: bigint, supply: bigint, decimals: number): bigint {
  if (rate <= 0n || cash <= 0n || supply <= 0n) return 0n;
  const firstNonzero = (CTOKEN_EXCHANGE_RATE_SCALE + rate - 1n) / rate;
  const unit = 10n ** BigInt(decimals);
  const desired = unit > firstNonzero ? unit : firstNonzero;
  // floor(shares * rate / scale) <= cash, with the contract's checked uint256
  // intermediate multiplication. Rounding must not reject a legal 1-unit out.
  const liquid = ((cash + 1n) * CTOKEN_EXCHANGE_RATE_SCALE - 1n) / rate;
  const productLimit = MaxUint256 / rate;
  const available = [supply, liquid, productLimit].reduce((a, b) => a < b ? a : b);
  const sample = desired < available ? desired : available;
  return sample >= firstNonzero ? sample : 0n;
}

export function redeemProbe(proof: CompoundCTokenRegistryEvidence): AdapterRequest {
  if (proof.sampleShares <= 0n) throw new Error("compound positive redemption sample required");
  return {
    id: REDEEM_PROBE_ID, kind: "effect-delta-simulation",
    call: { caller, executionMode: "impersonated-call-frame", to: proof.market,
      data: CTOKEN_INTERFACE.encodeFunctionData("redeem", [proof.sampleShares]) },
    // Only the caller's input is funded; no pool cash or supply is fabricated.
    overrideIntent: { caller, tokenBalances: [{ token: proof.market, amount: proof.sampleShares }] },
    observeTokenBalances: [
      { token: proof.market, account: caller },
      { token: proof.underlying, account: caller },
      { token: proof.underlying, account: proof.market },
    ],
    observe: ["return-data", "revert-data", "token-delta", "total-supply-delta", "logs"],
  };
}

export function redemptionProof(proof: CompoundCTokenRegistryEvidence,
  result: Extract<AdapterRequestResult, { ok: true }>): { amountOut: bigint; actor: string } | null {
  assertSource(result.source, proof.source);
  if (result.completion !== "returned" || proof.sampleShares <= 0n) return null;
  try {
    if (BigInt(CTOKEN_INTERFACE.decodeFunctionResult("redeem", result.data)[0]) !== 0n) return null;
    const q = redemptionAmount(proof.sampleShares, proof.exchangeRateCurrent);
    if (q <= 0n || q > proof.cash) return null;
    const deltas = result.effects?.tokenDeltas;
    if (!deltas || deltas.length !== 3) return null;
    const input = deltas.filter(d => sameAddress(d.token, proof.market));
    if (input.length !== 1 || input[0].delta !== -proof.sampleShares) return null;
    // The production transport binds this scope to caller=executor. Recheck
    // cross-effect actor/event consistency here, not arbitrary positive deltas.
    const actor = input[0].account;
    if (sameAddress(actor, proof.market) || sameAddress(actor, proof.underlying)) return null;
    for (const [account, delta] of [[actor, q], [proof.market, -q]] as const) {
      const found = deltas.filter(d => sameAddress(d.token, proof.underlying) && sameAddress(d.account, account));
      if (found.length !== 1 || found[0].delta !== delta) return null;
    }
    const supply = result.effects?.totalSupplyDeltas;
    if (!supply || supply.length !== 1 || !sameAddress(supply[0].token, proof.market) ||
      supply[0].delta !== -proof.sampleShares) return null;
    const events = (result.effects?.logs ?? []).filter(log => sameAddress(log.address, proof.market) &&
      log.topics[0]?.toLowerCase() === CTOKEN_INTERFACE.getEvent("Redeem")!.topicHash.toLowerCase());
    if (events.length !== 1) return null;
    const event = CTOKEN_INTERFACE.decodeEventLog("Redeem", events[0].data, [...events[0].topics]);
    if (!sameAddress(event.redeemer, actor) || event.redeemTokens !== proof.sampleShares || event.redeemAmount !== q) return null;
    return { amountOut: q, actor };
  } catch { return null; }
}
