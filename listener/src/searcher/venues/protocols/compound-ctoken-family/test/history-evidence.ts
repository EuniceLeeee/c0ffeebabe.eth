import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { CTOKEN_INTERFACE } from "../abi.js";

/** Evidence/encoding inspection only, never an EVM or an execution proof. */
export function assertAnchors(source: CanonicalSource, saved: any, provenance: any): void {
  assert.equal(saved.runtime?.sourceBlock, source.number, "prices.runtime.sourceBlock mismatch");
  assert.equal(String(saved.runtime?.sourceBlockHash).toLowerCase(), source.hash.toLowerCase(), "prices.runtime.sourceBlockHash mismatch");
  assert.equal(provenance.stateSource?.number, source.number, "provenance.stateSource.number mismatch");
  assert.equal(String(provenance.stateSource?.hash).toLowerCase(), source.hash.toLowerCase(), "provenance.stateSource.hash mismatch");
  assert.equal(Number(BigInt(provenance.sourceHeader.number)), source.number);
  assert.equal(String(provenance.sourceHeader.hash).toLowerCase(), source.hash.toLowerCase(), "sourceHeader.hash mismatch");
}

export type RedeemCall = { to: string; from: string; method: "redeem" | "redeemUnderlying"; argument: bigint };
export function successfulRedeemCalls(trace: any, markets: ReadonlySet<string>): RedeemCall[] {
  const calls: RedeemCall[] = [];
  const walk = (frame: any): void => {
    // Discard the entire subtree of a reverted/halted ancestor. DELEGATECALL
    // is implementation dispatch, not another external redemption evidence.
    if (!frame || typeof frame !== "object" || frame.error || frame.revertReason) return;
    const to = String(frame.to ?? "").toLowerCase();
    if (markets.has(to) && String(frame.type ?? "CALL").toUpperCase() === "CALL") {
      try {
        const p = CTOKEN_INTERFACE.parseTransaction({ data: String(frame.input ?? "") });
        if (p && (p.name === "redeem" || p.name === "redeemUnderlying") &&
          BigInt(CTOKEN_INTERFACE.decodeFunctionResult(p.name, frame.output)[0]) === 0n) {
          calls.push({ to, from: ethers.getAddress(frame.from).toLowerCase(), method: p.name, argument: BigInt(p.args[0]) });
        }
      } catch { /* Malformed/unknown return data is not successful evidence. */ }
    }
    for (const child of frame.calls ?? []) walk(child);
  };
  walk(trace); return calls;
}

export function classifyRedeemLog(row: { emitter: string; redeemer?: string; redeemTokens?: bigint; redeemAmount?: bigint },
  calls: readonly RedeemCall[], logCountForMarket: number): "share-input" | "underlying-output" | "unverified-or-ambiguous" {
  const matches = calls.filter(c => c.to === row.emitter.toLowerCase());
  // Without trace-local log ordering, mixed/multiple calls must not be joined
  // merely by tx hash or guessed from another market's call.
  if (logCountForMarket !== 1 || matches.length !== 1) return "unverified-or-ambiguous";
  const call = matches[0];
  if (call.from !== row.redeemer?.toLowerCase() || call.argument !==
    (call.method === "redeem" ? row.redeemTokens : row.redeemAmount)) return "unverified-or-ambiguous";
  return call.method === "redeem" ? "share-input" : "underlying-output";
}

export function runtimeScriptEnvelope(script: Uint8Array) {
  assert(script.length >= 38 && script[0] === 0x0e, "expected a single production runtime-program instruction");
  const amount = BigInt(ethers.hexlify(script.slice(1, 33)));
  const length = (script[33] << 16) | (script[34] << 8) | script[35];
  assert.equal(script.length, 36 + length, "truncated/trailing runtime-program encoding");
  assert.equal(script[36], 1, "runtime-program version");
  return { amount, program: ethers.hexlify(script.slice(36)), length };
}
