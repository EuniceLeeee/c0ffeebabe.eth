import assert from "node:assert/strict";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/ekubo.production.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { UnifiedObservation } from "../../../adapter-family-plugin.js";
import { EKUBO_CORE, EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_ROUTER, ekuboRouterIface, encodeEkuboSwap } from "../../ekubo/abi.js";
import type { EkuboPoolKey } from "../../ekubo/pool-key.js";
import { candidate, ERC20, lower } from "../codec.js";
import type { EkuboCandidate, EkuboIdentity } from "../types.js";

// Public chain anchor, but all fixture responses are SYNTHETIC, not replay or
// on-chain identity proof. Cached chain quotes are labelled separately in tests.
export const KEY = { token0: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", token1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  config: "0x0000000000000000000000000000000000000000004189374bc6a7f08000137c" };
export const ID = "0xe29d7ac1555e569de7a2234d234758e0e8768d50fa7c54c963d31df96876279f";
export const EXECUTOR = "0x1000000000000000000000000000000000000002";
export const SOURCE: CanonicalSource = { number: 25988745, hash: "0x8782444e0ea9d3aae19dd83f4087a04ec0fc0f61e8fc28c5dbdc8b6560a0f295", generation: 25988745 };
export const word = (value: bigint) => ethers.toBeHex(value, 32);
export const update = (delta0: bigint, delta1: bigint) => word((BigInt.asUintN(128, delta0) << 128n) | BigInt.asUintN(128, delta1));
export function result(id: string, data: string, source = SOURCE): Extract<AdapterRequestResult, { ok: true }> {
  return { id, ok: true, source, provenance: { kind: "synthetic-ekubo-contract", fingerprint: "fixture" }, data, completion: "returned" };
}
export function quoteData(isToken1: boolean, amountIn: bigint, amountOut: bigint, state = word(1n)) {
  return ekuboRouterIface.encodeFunctionResult("quote", [isToken1 ? update(-amountOut, amountIn) : update(amountIn, -amountOut), state]);
}
export function fixture(key: EkuboPoolKey = KEY, source = SOURCE) {
  const reserves = [1_000n * 10n ** 8n, 75_000_000n * 10n ** 6n];
  const dy = (isToken1: boolean, amountIn: bigint) => {
    const i = Number(isToken1), j = Number(!isToken1);
    return amountIn * 9995n * reserves[j] / (reserves[i] * 10000n + amountIn * 9995n);
  };
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    if (request.kind === "get-code") return result(request.id, "0x600060005260206000f3", source);
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("unexpected fixture transport");
    if (request.data === ERC20.encodeFunctionData("decimals")) {
      assert([lower(key.token0), lower(key.token1)].includes(lower(request.to)));
      return result(request.id, word(lower(request.to) === lower(key.token0) ? 8n : 6n), source);
    }
    assert.equal(lower(request.to), lower(EKUBO_ROUTER));
    const decoded = ekuboRouterIface.decodeFunctionData("quote", request.data);
    assert.equal(lower(String(decoded[0][0])), lower(key.token0));
    assert.equal(lower(String(decoded[0][1])), lower(key.token1));
    assert.equal(String(decoded[0][2]), key.config);
    assert.equal(decoded[3], 0n); assert.equal(decoded[4], 0n);
    return result(request.id, quoteData(Boolean(decoded[1]), BigInt(decoded[2]), dy(Boolean(decoded[1]), BigInt(decoded[2]))), source);
  };
  return { answer, dy };
}
export function identity(found: EkuboCandidate = candidate(KEY), answer = fixture(found.poolKey).answer): EkuboIdentity {
  const variant = plugin.identity.variants[0];
  let evidence: unknown;
  for (let step = 0; step <= 3; step++) {
    const input = { candidate: found, step, ...(evidence === undefined ? {} : { evidence }) };
    const decision = variant.decide(input);
    if (decision.status === "verified") return decision.identity;
    assert.equal(decision.status, "continue", JSON.stringify(decision));
    assert(step < 3);
    evidence = variant.decode({ step: input, results: variant.buildRequests(input).map(answer) });
  }
  throw new Error("identity did not finish");
}
export function descriptor(verified = identity()) {
  return plugin.instance.finalizeDescriptor({ identity: verified, draft: plugin.instance.compileDraft(verified), sharedBindings: [] });
}
export function initialized(key: EkuboPoolKey = KEY): Extract<UnifiedObservation, { kind: "log" }> {
  return { kind: "log", source: SOURCE, address: EKUBO_CORE, topics: [EKUBO_POOL_INITIALIZED_TOPIC],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "tuple(address token0,address token1,bytes32 config)", "int32", "uint96"],
      [candidate(key).poolId, key, 0, 1n]) };
}
export function swapCall(key: EkuboPoolKey = KEY): Extract<UnifiedObservation, { kind: "call" }> {
  return { kind: "call", source: SOURCE, target: EKUBO_ROUTER, data: encodeEkuboSwap(key, false, 15809n, 1n, EXECUTOR) };
}
