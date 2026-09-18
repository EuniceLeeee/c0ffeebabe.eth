// Offline byte/effect assertions over preserved real strict identity probes.
// Does not issue a lifecycle handle or replace a current-source execution run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/curve-plain.production.js";
import { EXECUTION, MODES, hasReceiver, selector, uint } from "../codec.js";
import { actionId } from "../routes.js";
import type { CurvePlainMode } from "../types.js";

const paths = process.argv.slice(2);
assert(paths.length > 0, "Explicit historical probe artifacts required; no fixture fallback");
const counts = new Map<CurvePlainMode, number>();
for (const path of paths) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(artifact.broadcast, false);
  assert.equal(artifact.complete, true);
  assert(ethers.isHexString(artifact.source.hash, 32));
  for (const row of artifact.identitySimulations) {
    const request = row.request, result = row.result;
    if (!result || request.kind !== "effect-delta-simulation") continue;
    assert.deepEqual(row.source, artifact.source);
    const mode = MODES.find(mode => selector(mode) === request.call.data.slice(0, 10));
    assert(mode, "Unrecognized execution selector in Curve identity proof");
    const fn = mode === "exchange" ? "exchange" : "exchange_received";
    const args = EXECUTION[mode].decodeFunctionData(fn, request.call.data);
    const amountIn = BigInt(args[2]), amountOut = BigInt(args[3]);
    assert(amountIn > 0n && amountOut > 0n);
    if (result.data !== "0x") assert.equal(uint(result.data), amountOut);
    const deltas = result.effects?.tokenDeltas;
    assert.equal(deltas?.length, 4, "Return bytes alone cannot establish actual transfer effects");
    const input = deltas.filter((d: { delta: string }) => BigInt(d.delta) === -amountIn &&
      String((d as { account?: string }).account).toLowerCase() !== request.call.to.toLowerCase());
    assert.equal(input.length, 1);
    const tokenIn = input[0].token;
    const poolInput = deltas.find((d: { account: string; token: string }) =>
      d.account.toLowerCase() === request.call.to.toLowerCase() && d.token.toLowerCase() === tokenIn.toLowerCase());
    assert.equal(BigInt(poolInput.delta), amountIn);
    const poolOutput = deltas.find((d: { account: string; token: string }) =>
      d.account.toLowerCase() === request.call.to.toLowerCase() && d.token.toLowerCase() !== tokenIn.toLowerCase());
    assert.equal(BigInt(poolOutput.delta), -amountOut);
    const tokenOut = poolOutput.token;
    const receiver = hasReceiver(mode) ? String(args[4]) : input[0].account;
    const output = deltas.find((d: { account: string; token: string }) =>
      d.account.toLowerCase() === receiver.toLowerCase() && d.token.toLowerCase() === tokenOut.toLowerCase());
    assert.equal(BigInt(output.delta), amountOut);
    const adapterId = actionId(mode), action = plugin.actionAdapters.find(a => a.id === adapterId);
    assert(action);
    // Identity probes may use a distinct probe receiver. This checks encoded
    // calldata parity, not whether that probe was an executor-issued route.
    const bytes = action.encode({ adapterId, target: request.call.to, tokenIn, tokenOut, amount: amountIn,
      params: { i: BigInt(args[0]), j: BigInt(args[1]), minDy: amountOut, receiver }, children: [] },
    receiver, new Uint8Array());
    assert.equal(bytes[0], 0);
    assert.equal(ethers.hexlify(bytes.slice(1, 21)).toLowerCase(), request.call.to.toLowerCase());
    assert.equal(((bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) + 24, bytes.length);
    assert.equal(ethers.hexlify(bytes.slice(24)), request.call.data.toLowerCase());
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
}
for (const mode of MODES) assert((counts.get(mode) ?? 0) > 0, `Missing real execution effect evidence for ${mode}`);
console.log("Curve cached real execution effects + current action calldata parity PASS", Object.fromEntries(counts));
