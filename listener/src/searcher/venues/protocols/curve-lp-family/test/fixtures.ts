import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ABI, DECIMALS, META } from "../codec.js";
import { instance } from "../instance.js";
import { identity, samples } from "../identity.js";
import { mintQuote } from "../model.js";
import { routes } from "../routes.js";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
export const addr = (n: number) => ethers.toBeHex(n, 20), actor = addr(71);
export const source = { number: 26152335, hash: ethers.id("curve-lp-fixture"), generation: 1 };
const runtime = JSON.parse(readFileSync(new URL("source-runtime.json", import.meta.url), "utf8"));
export function fixture() { return { pool: addr(81), lp: addr(82), coins: [addr(83), addr(84)] as [string, string],
  poolCode: runtime.pool as string, lpCode: runtime.lp as string, coinCode: "0x6000", minter: addr(81), registeredPool: addr(81),
  decimals: [18, 6], lpDecimals: 18, balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 6n] as [bigint, bigint],
  amp: 150000n, future: 150000n, fee: 1000000n, totalSupply: 2000000n * 10n ** 18n, killed: false, mutate: (_r: any) => {} }; }
export type Fixture = ReturnType<typeof fixture>;
export const returned = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "curve-lp-contract" } });
// A mock chain response only; not a second production withdraw formula.
export const mockWithdraw = (amount: bigint, index: number) => amount * 99n / 100n / (10n ** BigInt(18 - DECIMALS[index]));
export function reads(f: Fixture, requests: readonly AdapterRequest[]): AdapterRequestResult[] { return requests.map(r => {
  if (r.kind === "get-code") return returned(r.id, r.address.toLowerCase() === f.pool ? f.poolCode : r.address.toLowerCase() === f.lp ? f.lpCode : f.coinCode);
  if (r.kind === "get-storage") return returned(r.id, ethers.toBeHex(f.killed ? 1 : 0, 32));
  if (r.kind !== "eth-call") throw new Error("unexpected fixture request"); const c = ABI.parseTransaction({ data: r.data })!; let v: unknown[];
  switch (c.name) {
    case "lp_token": case "get_lp_token": v = [f.lp]; break;
    case "coins": v = [f.coins[Number(c.args[0])]]; break;
    case "get_coins": v = [[...f.coins, ...Array(6).fill(ethers.ZeroAddress)]]; break;
    case "get_registry_handlers_from_pool": v = [[addr(99), ...Array(9).fill(ethers.ZeroAddress)]]; break;
    case "get_pool_from_lp_token": v = [f.registeredPool]; break;
    case "minter": v = [f.minter]; break;
    case "decimals": v = [r.to.toLowerCase() === f.lp ? f.lpDecimals : f.decimals[f.coins.indexOf(r.to.toLowerCase())]]; break;
    case "A_precise": case "initial_A": v = [f.amp]; break;
    case "future_A": v = [f.future]; break;
    case "fee": v = [f.fee]; break;
    case "balances": v = [f.balances[Number(c.args[0])]]; break;
    case "totalSupply": v = [f.totalSupply]; break;
    case "calc_withdraw_one_coin": v = [mockWithdraw(c.args[0], Number(c.args[1]))]; break;
    default: throw new Error("unexpected fixture call " + c.name);
  }
  return returned(r.id, ABI.encodeFunctionResult(c.signature, v));
}); }
export function behavior(f: Fixture, p: any, r: AdapterRequest): AdapterRequestResult { const q = samples(p)[Number(r.id.slice(9))], mint = q.direction === "mint";
  const out = mint ? mintQuote(p.state, q.index, q.amount) : mockWithdraw(q.amount, q.index);
  const result: any = { ...returned(r.id, ABI.encodeFunctionResult(mint ? "add_liquidity" : "remove_liquidity_one_coin", [out])), effects: {
    tokenDeltas: [{ token: q.tokenIn, account: actor, delta: -q.amount }, { token: q.tokenIn, account: f.pool, delta: mint ? q.amount : 0n },
      { token: q.tokenOut, account: actor, delta: out }, { token: q.tokenOut, account: f.pool, delta: mint ? 0n : -out }],
    totalSupplyDeltas: [{ token: f.lp, delta: mint ? out : -q.amount }], nativeDeltas: [{ account: actor, delta: 0n }], logs: [] } };
  f.mutate(result); return result;
}
export function attest(f = fixture()) { let step: any = { candidate: { candidateKind: "curve-lp", pool: f.pool }, step: 0 }; const v = identity.variants[0];
  for (let n = 0; n < 5; n++) { const declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => r.kind === "effect-delta-simulation" ? behavior(f, step.evidence, r) : reads(f, [r])[0]);
    step = { ...step, step: n + 1, evidence: v.decode({ step, results }) }; const decision = v.decide(step);
    if (decision.status !== "continue") return { decision, step };
  } throw new Error("curve-lp identity did not finish");
}
export function setup(f = fixture()) { const { decision } = attest(f); if (decision.status !== "verified") throw new Error("fixture not verified: " + JSON.stringify(decision));
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d });
  return { d, rs, input: (r: typeof rs[number], amountIn: bigint): any => ({ descriptor: d, route: r, amountIn, executor: actor, source, runtimeEvidence: [] }) };
}
