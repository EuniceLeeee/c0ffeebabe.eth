import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/few-wrapped.production.js";
import { ABI, WRAPPER_CODE_HASH } from "../codec.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { Direction, Identity, Descriptor } from "../types.js";
export const SOURCE: CanonicalSource = { number: 26182689, hash: "0xeb0d092ce871b19f4071115a4816a282864c7adf6e6d9c1971e30c61596aa09c", generation: 1 };
export const TARGET = ethers.getAddress("0xa250cc729bb3323e7933022a67b52200fe354767");
export const ASSET = ethers.getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
export const FACTORY = ethers.getAddress("0x7d86394139bf1122e82fdf45bb4e3b038a4464dd");
export const EXECUTOR = "0x1000000000000000000000000000000000000002";
export const OTHER = "0x1000000000000000000000000000000000000003";
export const CODE: string = JSON.parse(readFileSync(new URL("./wrapper-runtime.json", import.meta.url), "utf8")).code;
assert.equal(ethers.keccak256(CODE), WRAPPER_CODE_HASH);
// Only the wrapper runtime is historical. All state/effect replies below are
// explicit offline fixtures; admission and actual EVM receipts are separate.
export function returned(id: string, data: string, source = SOURCE): Extract<AdapterRequestResult, {ok:true}> {
  return { id, data, source, ok: true, completion: "returned", provenance: { kind: "offline-fixture", fingerprint: "few-fixture" } };
}
export function receipt(id: string, direction: Direction, amount: bigint, source = SOURCE, actor = EXECUTOR, target = TARGET, asset = ASSET): AdapterRequestResult {
  const sign = direction === "wrap" ? 1n : -1n;
  const event = ABI.encodeEventLog(ABI.getEvent(direction === "wrap" ? "Wrap" : "Unwrap")!, [actor, amount, actor]);
  return { ...returned(id, ABI.encodeFunctionResult(direction, [amount]), source), effects: {
    tokenDeltas: [{ token: target, account: actor, delta: sign * amount }, { token: asset, account: actor, delta: -sign * amount },
      { token: asset, account: target, delta: sign * amount }],
    totalSupplyDeltas: [{ token: target, delta: sign * amount }, { token: asset, delta: 0n }],
    nativeDeltas: [{ account: actor, delta: 0n }], logs: [{ address: target, ...event }],
  } };
}
export function answer(request: AdapterRequest, source = SOURCE, target = TARGET, asset = ASSET): AdapterRequestResult {
  if (request.kind === "get-code") return returned(request.id, request.id === "few-code" ? CODE : "0x60006000", source);
  if (request.kind === "effect-delta-simulation") {
    const call = ABI.parseTransaction({ data: request.call.data })!;
    return receipt(request.id, call.name as Direction, BigInt(call.args[0]), source, EXECUTOR, target, asset);
  }
  assert(request.kind === "eth-call");
  const call = ABI.parseTransaction({ data: request.data })!;
  const value = ({ factory: FACTORY, token: asset, getWrappedToken: target, decimals: 18n,
    totalSupply: 10n ** 24n, balanceOf: 10n ** 24n } as Record<string, string | bigint>)[call.name];
  assert(value !== undefined, `unexpected fixture call ${call.name}`);
  return returned(request.id, ABI.encodeFunctionResult(call.name, [value]), source);
}
export function identityWith(reply = answer, target = TARGET): Identity {
  const candidate = { candidateKind: "few-wrapper" as const, target };
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 5; step++) {
    const input = { candidate, step, evidence };
    evidence = variant.decode({ step: input, results: variant.buildRequests(input).map(r => reply(r)) });
    const decision = variant.decide({ ...input, evidence });
    if (decision.status === "continue") continue;
    assert.equal(decision.status, "verified");
    assert(decision.status === "verified"); return decision.identity as Identity;
  }
  throw new Error("identity did not terminate");
}
export function descriptor(reply = answer, target = TARGET): Descriptor {
  const identity = identityWith(reply, target);
  return plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
}
export function inputFor(d = descriptor(), route = plugin.routes.project({ descriptor: d })[0]!, amountIn = 4387060682263585n) {
  return { descriptor: d, route, amountIn, source: SOURCE, executor: EXECUTOR, transactionOrigin: OTHER, runtimeEvidence: [] };
}
