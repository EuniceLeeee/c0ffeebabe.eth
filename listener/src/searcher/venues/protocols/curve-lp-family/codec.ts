import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { assertSource, callRequest as call, codeRequest as code };
// Registry is an identity source, not an instance admission allowlist.
export const META = "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc";
export const ABI = new ethers.Interface([
  "function lp_token() view returns(address)", "function coins(uint256) view returns(address)", "function balances(uint256) view returns(uint256)",
  "function A_precise() view returns(uint256)", "function initial_A() view returns(uint256)", "function future_A() view returns(uint256)",
  "function fee() view returns(uint256)", "function minter() view returns(address)", "function totalSupply() view returns(uint256)",
  "function decimals() view returns(uint256)", "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
  "function add_liquidity(uint256[2],uint256) returns(uint256)", "function remove_liquidity_one_coin(uint256,int128,uint256) returns(uint256)",
  "function calc_token_amount(uint256[2],bool) view returns(uint256)", "function calc_withdraw_one_coin(uint256,int128) view returns(uint256)",
  "function get_lp_token(address) view returns(address)", "function get_pool_from_lp_token(address) view returns(address)",
  "function get_registry_handlers_from_pool(address) view returns(address[10])", "function get_coins(address) view returns(address[8])",
  "event AddLiquidity(address indexed provider,uint256[2] token_amounts,uint256[2] fees,uint256 invariant,uint256 token_supply)",
  "event RemoveLiquidityOne(address indexed provider,uint256 token_amount,uint256 coin_amount,uint256 token_supply)",
  "event TokenExchange(address indexed buyer,int128 sold_id,uint256 tokens_sold,int128 bought_id,uint256 tokens_bought)",
  "event Transfer(address indexed from,address indexed to,uint256 value)", "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
export const FUNCTIONS = ["add_liquidity", "remove_liquidity_one_coin"] as const;
export const PRECISIONS = [1n, 10n ** 12n] as const;
export const DECIMALS = [18, 6] as const;
export function address(value: string): string { const a = ethers.getAddress(value).toLowerCase();
  if (a === ethers.ZeroAddress) throw new Error("curve-lp zero address"); return a; }
export function uint(value: bigint): bigint { if (typeof value !== "bigint" || value < 0n || value > ethers.MaxUint256) throw new Error("curve-lp uint256 bounds"); return value; }
export function decode(fn: string, data: string) { const r = ABI.decodeFunctionResult(fn, data);
  if (ABI.encodeFunctionResult(fn, r).toLowerCase() !== data.toLowerCase()) throw new Error("curve-lp noncanonical ABI"); return r; }
export function rows(results: readonly AdapterRequestResult[], requests: readonly AdapterRequest[], expected?: CanonicalSource) {
  const source = results[0]?.source, ids = requests.map(r => r.id), values = new Map<string, string>();
  if (!source || results.length !== ids.length || new Set(ids).size !== ids.length || !Number.isSafeInteger(source.number) ||
      source.number < 0 || !ethers.isHexString(source.hash, 32)) throw new Error("curve-lp source/results");
  if (expected) assertSource(source, expected);
  for (const r of results) { if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source);
    if (!ids.includes(r.id) || values.has(r.id) || r.completion !== "returned") throw new Error("curve-lp unavailable " + r.id); values.set(r.id, r.data); }
  return { source, get(id: string): string { const v = values.get(id); if (v === undefined) throw new Error("curve-lp missing " + id); return v; } };
}
