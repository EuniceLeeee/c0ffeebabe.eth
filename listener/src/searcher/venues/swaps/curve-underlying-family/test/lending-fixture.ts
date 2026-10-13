import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { curveUnderlyingInstance as instance } from "../instance.js";
import { curveUnderlyingLendingIdentity as variant } from "../lending-identity.js";
import { LENDING_ABI as ABI, LENDING_LP_SLOT, LENDING_MINTER_SLOT } from "../lending.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity, CurveUnderlyingDescriptor } from "../types.js";
export const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-lending.json", import.meta.url), "utf8"));
export const codes = Object.fromEntries(Object.entries(fixture.codes).map(([k, v]) => [k, gunzipSync(Buffer.from(v as string, "base64")).toString()]));
export const model = fixture.usdx;
export const LENDING_TEST_SOURCE: CanonicalSource = { ...model.source, generation: model.source.number };
export const LENDING_TEST_EXECUTOR = "0x1000000000000000000000000000000000000002";
export const source = LENDING_TEST_SOURCE; export const executor = LENDING_TEST_EXECUTOR;
const candidate: CurveUnderlyingCandidate = { candidateKind: "curve-underlying-pool", pool: model.pool,
  sourceKind: "underlying-swap-log", hintedI: 0, hintedJ: 1 };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (n: bigint) => ethers.toBeHex(n, 32);
export const result = (id: string, data: string, at = source): Extract<AdapterRequestResult, { ok: true }> => ({ id, data, source: at, ok: true,
  completion: "returned", provenance: { kind: "synthetic-lending-unit-transport", fingerprint: "lending-unit" } });
export function lendingTestReply(request: AdapterRequest, at = source, outputDelta?: bigint): AdapterRequestResult {
  if (request.kind === "get-code") return result(request.id,
    same(request.address, model.pool) ? codes.dtokenPool : same(request.address, model.lpToken) ? codes.lp : codes.dtokenProxy, at);
  if (request.kind === "get-storage") {
    assert(same(request.address, model.pool) ? request.slot === LENDING_LP_SLOT : request.slot === LENDING_MINTER_SLOT);
    return result(request.id, ethers.zeroPadValue(same(request.address, model.pool) ? model.lpToken : model.pool, 32), at);
  }
  if (request.kind === "eth-call") {
    const parsed = ABI.parseTransaction({ data: request.data }); assert(parsed);
    const i = Number(parsed.args.length ? parsed.args[0] : 0);
    const value = parsed.name === "coins" ? model.wrappedCoins[i] : parsed.name === "underlying_coins" ? model.coins[i]
      : parsed.name === "token" ? model.coins[model.wrappedCoins.findIndex((c: string) => same(c, request.to))]
      : parsed.name === "decimals" ? [18, 6, 6, 18][model.coins.findIndex((c: string) => same(c, request.to))] : undefined;
    assert(value !== undefined); return result(request.id, ABI.encodeFunctionResult(parsed.name, [value]), at);
  }
  const parsed = ABI.parseTransaction({ data: request.call.data }); assert(parsed);
  const [i, j, amount] = parsed.args as unknown as readonly bigint[];
  const units = [10n ** 18n, 10n ** 6n, 10n ** 6n, 10n ** 18n];
  const amountOut = outputDelta ?? amount * units[Number(j)] / units[Number(i)] * 999n / 1000n;
  return { ...result(request.id, "0x", at), effects: {
    tokenDeltas: [{ token: model.coins[Number(i)], account: executor, delta: -amount },
      { token: model.coins[Number(j)], account: executor, delta: amountOut }],
    nativeDeltas: [{ account: executor, delta: 0n }],
  } } as AdapterRequestResult;
}
export function lendingTestIdentity() {
  let evidence: unknown;
  for (let step = 0; step < 5; step++) {
    const input = { candidate, evidence, step };
    evidence = variant.decode({ step: input, results: variant.buildRequests(input).map(r => lendingTestReply(r)) });
    const decision = variant.decide({ ...input, evidence });
    if (decision.status === "verified") return decision.identity as CurveUnderlyingIdentity;
    assert.equal(decision.status, "continue");
  }
  throw new Error("lending fixture lifecycle did not finish");
}
export function lendingTestDescriptor(): CurveUnderlyingDescriptor {
  const draft = instance.compileDraft(lendingTestIdentity());
  return instance.finalizeDescriptor({ draft, sharedBindings: [] });
}
