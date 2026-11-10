import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { ABI, META } from "../codec.js";
import { instance } from "../instance.js";
import { routes } from "../routes.js";
import { exact } from "../exact.js";
import { execution } from "../execution.js";
import { identity } from "../identity.js";
import { TRICRYPTO_NG, TRICRYPTO_NG_FACTORY, TRICRYPTO_NG_MODEL, tricryptoNgIdentityVariant } from "../tricrypto-ng.js";
import { addr, actor, source } from "./fixtures.js";

// Synthetic chain responses only. Every amount below is fixture arithmetic; the
// production quote is the pool's own calc_token_amount / add_liquidity return.
const saved = JSON.parse(readFileSync(new URL("tricrypto-ng-runtime.json", import.meta.url), "utf8"));
type Fixture = { pool: string; factory: string; feeReceiver: string; coins: string[]; decimals: number[]; handler: string;
  supply: bigint; fee: bigint; A: bigint; gamma: bigint; midFee: bigint; outFee: bigint; scales: bigint[]; balances: bigint[];
  registryCoins?: string[];
  poolRuntime: string; factoryRuntime: string; coinRuntime: string; adminFee: bigint; change: (r: any) => void };
function fixture(): Fixture {
  return { pool: addr(301), factory: TRICRYPTO_NG_FACTORY, feeReceiver: addr(302), coins: [addr(311), addr(312), addr(313)],
    decimals: [18, 18, 6], handler: addr(320), supply: 2_000_000n * 10n ** 18n, fee: 6_638_859n, A: 2_700_000n, gamma: 1_300_000_000_000n,
    midFee: 2_999_999n, outFee: 80_000_000n, scales: [363_330_882_899_152n, 734_888_385_755n],
    balances: [177_728n * 10n ** 18n, 488_969n * 10n ** 18n, 243_544n * 10n ** 18n], poolRuntime: saved.pool.runtime,
    factoryRuntime: saved.factory.runtime, coinRuntime: "0x60006000", adminFee: 6_636_565_157_966_320n, change: () => {} };
}
const row = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "curve-lp-tricrypto-ng-contract" } });
const reverted = (id: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, completion: "reverted-as-declared", data: "0x",
  provenance: { kind: "synthetic", fingerprint: "curve-lp-tricrypto-ng-contract" } });
const quote = (f: Fixture, index: number, amount: bigint) => amount * (10n ** BigInt(18 - f.decimals[index]!)) * 99n / 100n;
const META_ABI = new ethers.Interface(["function get_lp_token(address) view returns(address)", "function get_pool_from_lp_token(address) view returns(address)",
  "function get_coins(address) view returns(address[8])", "function get_registry_handlers_from_pool(address) view returns(address[10])",
  "function get_base_pool(address) view returns(address)"]);
function resolve(f: Fixture, req: AdapterRequest): AdapterRequestResult {
  if (req.kind === "get-code") return row(req.id, req.address.toLowerCase() === f.pool ? f.poolRuntime
    : req.address.toLowerCase() === f.factory ? f.factoryRuntime : req.address.toLowerCase() === META ? "0x60006000" : f.coinRuntime);
  if (req.kind === "effect-delta-simulation") {
    if (req.id === "ng3-actor") return { ...row(req.id, TRICRYPTO_NG.encodeFunctionResult("balanceOf", [0n])),
      effects: { tokenDeltas: [{ token: f.coins[0]!, account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: 0n }] } };
    const p = TRICRYPTO_NG.parseTransaction({ data: req.call.data })!;
    if (p.name !== "add_liquidity") throw new Error("unexpected synthetic operation");
    const amounts = [...p.args[0]] as bigint[], index = amounts.findIndex(v => v > 0n), amount = amounts[index]!, out = quote(f, index, amount), coin = f.coins[index]!;
    const effects = req.observeTokenBalances!.map(({ token, account }: any) => { const t = String(token).toLowerCase();
      const a = typeof account === "string" ? account.toLowerCase() : actor;
      const delta = t === coin && a === actor ? -amount : t === coin && a === f.pool ? amount :
        t === f.pool && a === actor ? out : t === f.pool && a === f.feeReceiver ? f.adminFee : 0n;
      return { token: t, account: a, delta }; });
    const log = (event: string, args: unknown[]) => TRICRYPTO_NG.encodeEventLog(TRICRYPTO_NG.getEvent(event)!, args);
    const logs = [
      { address: coin, ...log("Transfer", [actor, f.pool, amount]) },
      ...(f.adminFee === 0n ? [] : [{ address: f.pool, ...log("Transfer", [ethers.ZeroAddress, f.feeReceiver, f.adminFee]) }]),
      { address: f.pool, ...log("Transfer", [ethers.ZeroAddress, actor, out]) },
      ...(f.adminFee === 0n ? [] : [{ address: f.pool, ...log("ClaimAdminFee", [f.feeReceiver, f.adminFee]) }]),
      { address: f.pool, ...log("AddLiquidity", [actor, amounts, f.fee, f.supply + out + f.adminFee, f.scales[0]!]) },
    ];
    const result: any = { ...row(req.id, TRICRYPTO_NG.encodeFunctionResult("add_liquidity", [out])),
      effects: { tokenDeltas: effects, totalSupplyDeltas: [{ token: f.pool, delta: out + f.adminFee }], nativeDeltas: [{ account: actor, delta: 0n }], logs } };
    f.change(result); return result;
  }
  if (req.kind !== "eth-call") throw new Error("unexpected synthetic request");
  if (req.to.toLowerCase() === META) { const p = META_ABI.parseTransaction({ data: req.data })!; const values: unknown[] =
      p.name === "get_lp_token" || p.name === "get_pool_from_lp_token" ? [f.pool]
        : p.name === "get_coins" ? [[...(f.registryCoins ?? f.coins), ...Array(5).fill(ethers.ZeroAddress)]]
        : p.name === "get_registry_handlers_from_pool" ? [[f.handler, ...Array(9).fill(ethers.ZeroAddress)]]
        : [ethers.ZeroAddress];
    return row(req.id, META_ABI.encodeFunctionResult(p.name, values)); }
  const p = TRICRYPTO_NG.parseTransaction({ data: req.data })!;
  switch (p.name) {
    case "coins": { const i = Number(p.args[0]); return i < 3 ? row(req.id, TRICRYPTO_NG.encodeFunctionResult("coins", [f.coins[i]])) : reverted(req.id); }
    case "decimals": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("decimals", [req.to.toLowerCase() === f.pool ? 18n : BigInt(f.decimals[f.coins.indexOf(req.to.toLowerCase())]!)]));
    case "factory": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("factory", [f.factory]));
    case "fee": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("fee", [f.fee]));
    case "A": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("A", [f.A]));
    case "gamma": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("gamma", [f.gamma]));
    case "mid_fee": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("mid_fee", [f.midFee]));
    case "out_fee": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("out_fee", [f.outFee]));
    case "price_scale": { const i = Number(p.args[0]); return i < 2 ? row(req.id, TRICRYPTO_NG.encodeFunctionResult("price_scale", [f.scales[i]!])) : reverted(req.id); }
    case "totalSupply": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("totalSupply", [f.supply]));
    case "fee_receiver": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("fee_receiver", [f.feeReceiver]));
    case "balanceOf": return row(req.id, TRICRYPTO_NG.encodeFunctionResult("balanceOf", [0n]));
    case "calc_token_amount": { const amounts = [...p.args[0]] as bigint[], index = amounts.findIndex(v => v > 0n);
      return row(req.id, TRICRYPTO_NG.encodeFunctionResult("calc_token_amount", [quote(f, index, amounts[index]!)])); }
    default: throw new Error("unexpected synthetic ABI " + p.name);
  }
}
function attest(f: Fixture) { let step: any = { candidate: { candidateKind: "curve-lp", pool: f.pool }, step: 0 };
  for (let k = 0; k < 8; k++) { const declared = declareRequestProgram({ requirements: tricryptoNgIdentityVariant.requirements,
    buildRequests: tricryptoNgIdentityVariant.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => resolve(f, r));
    step = { ...step, step: k + 1, evidence: tricryptoNgIdentityVariant.decode({ step, results }) };
    const decision = tricryptoNgIdentityVariant.decide(step); if (decision.status !== "continue") return decision; }
  throw new Error("tricrypto-ng fixture did not finish"); }
function setup(f: Fixture) { const decision = attest(f); assert.equal(decision.status, "verified", JSON.stringify(decision));
  assert(decision.status === "verified"); const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d }); return { decision, d, rs }; }

test("the tricrypto-ng variant is installed and reuses the generic fixed-array quote/execution surface", () => {
  assert(identity.variants.some(v => v.id === "registry-tricrypto-ng-fixed3-and-mint-burn-effects"));
  const { d, rs } = setup(fixture());
  assert.equal(d.lp, d.pool); assert.equal(d.generic!.kind, "crypto"); assert.equal(d.generic!.coinIndex, "uint256");
  assert.equal(d.generic!.mintQuote, "crypto-bool"); assert.equal(d.generic!.tricryptoNg!.model, TRICRYPTO_NG_MODEL);
  assert.deepEqual(d.generic!.directions.map(v => [v.direction, v.index, v.receiverMode]), [["mint", 0, "none"], ["mint", 1, "none"], ["mint", 2, "none"]]);
  assert.deepEqual(rs.map(r => [r.direction, r.index]), [["mint", 0], ["mint", 1], ["mint", 2]]);
  for (const r of rs) {
    assert.equal(exact.methods({ descriptor: d, route: r }).some(m => m.id === "fixed-array-fee-aware-chain-amount"), true);
    const leg = execution.buildRuntimeLeg({ descriptor: d, route: r, executor: actor, transactionOrigin: addr(72), runtimeEvidence: [], source });
    assert(leg && leg.program.length > 2);
    // No third-party recipient path is claimed for this class.
    assert.equal(execution.buildRuntimeLeg({ descriptor: d, route: r, executor: actor, transactionOrigin: addr(72), runtimeEvidence: [], source,
      settlement: { kind: "direct-output", recipient: addr(73) } }), null);
  }
});
test("admin LP fee mint is matched exactly, never folded into the user's output", () => {
  for (const change of [
    (r: any) => { r.effects.totalSupplyDeltas[0].delta -= 1n; },                                  // unexplained supply
    (r: any) => { r.effects.tokenDeltas.find((v: any) => v.token === r.effects.totalSupplyDeltas[0].token && v.account !== actor && v.delta > 0n).delta -= 1n; }, // short fee mint
    (r: any) => { r.effects.logs = r.effects.logs.filter((l: any) => l.topics[0] !== ethers.id("ClaimAdminFee(address,uint256)")); }, // missing claim log
    (r: any) => { r.effects.logs.find((l: any) => l.topics[0] === ethers.id("ClaimAdminFee(address,uint256)")).data = ethers.toBeHex(1n, 32); }, // wrong claim amount
    (r: any) => { r.effects.tokenDeltas.find((v: any) => v.delta < 0n).delta = 0n; },              // no input debit
    (r: any) => { r.effects.nativeDeltas[0].delta = 1n; },                                         // native subsidy
    (r: any) => { r.data = TRICRYPTO_NG.encodeFunctionResult("add_liquidity", [BigInt(r.data) - 1n]); }, // quote/return mismatch
  ]) { const f = fixture(); f.change = change; assert.notEqual(attest(f).status, "verified"); }
  const verified = setup(fixture()); assert.equal(verified.d.generic!.directions.length, 3);
});
test("a zero admin fee requires the absence of both a fee mint and a claim log", () => {
  const zero = fixture(); zero.adminFee = 0n; assert.equal(attest(zero).status, "verified");
  const spurious = fixture(); spurious.adminFee = 0n;
  spurious.change = (r: any) => { r.effects.logs.push({ address: r.pool ?? r.effects.totalSupplyDeltas[0].token,
    ...TRICRYPTO_NG.encodeEventLog(TRICRYPTO_NG.getEvent("ClaimAdminFee")!, [spurious.feeReceiver, 1n]) }); };
  assert.notEqual(attest(spurious).status, "verified");
});
test("a single unproved sample removes only its own direction", () => {
  const f = fixture(); let n = 0;
  f.change = (r: any) => { if (++n === 3) r.effects.totalSupplyDeltas[0].delta = 0n; };  // third sample = index 1, first unit
  const decision = attest(f); assert.equal(decision.status, "verified");
  assert(decision.status === "verified");
  assert.deepEqual((decision.identity.binding as any).generic.directions.map((v: any) => v.index), [0, 2]);
});
test("unpinned runtime classes and factories are retryable, not silently admitted", () => {
  const unknown = fixture(); unknown.poolRuntime = "0x60006000";
  const decision: any = attest(unknown); assert.equal(decision.status, "retryable");
  assert.match(decision.reasonCode, /unsupported tricrypto-ng runtime class/);
  const factory = fixture(); factory.factory = addr(399);
  assert.match(String((attest(factory) as any).reasonCode), /factory mismatch/);
  const registry = fixture(); registry.registryCoins = [registry.coins[0]!, registry.coins[1]!, addr(397)];
  assert.notEqual(attest(registry).status, "verified");
  const receiver = fixture(); receiver.feeReceiver = receiver.coins[0]!; assert.notEqual(attest(receiver).status, "verified");
  const scale = fixture(); scale.scales[0] = 0n; assert.notEqual(attest(scale).status, "verified");
  const fee = fixture(); fee.fee = 10n ** 10n + 1n; assert.notEqual(attest(fee).status, "verified");
});
