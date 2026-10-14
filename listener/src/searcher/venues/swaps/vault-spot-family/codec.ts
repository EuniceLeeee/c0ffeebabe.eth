import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { callRequest, codeRequest, returnedResult, assertSameSource, assertSource } from "../../protocols/standard-family/common.js";
import type { Binding, RootState } from "./types.js";
export const ABI = new ethers.Interface([
  "function swap(address tokenIn,address tokenOut,address receiver) returns(uint256)",
  "event Swap(address account,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 amountOutAfterFees,uint256 feeBasisPoints)",
  "function isInitialized() view returns(bool)", "function isSwapEnabled() view returns(bool)",
  "function router() view returns(address)", "function usdg() view returns(address)",
  "function vaultUtils() view returns(address)", "function priceFeed() view returns(address)",
  "function includeAmmPrice() view returns(bool)", "function whitelistedTokens(address) view returns(bool)",
  "function tokenDecimals(address) view returns(uint256)", "function tokenBalances(address) view returns(uint256)",
  "function poolAmounts(address) view returns(uint256)", "function reservedAmounts(address) view returns(uint256)",
  "function bufferAmounts(address) view returns(uint256)", "function vault() view returns(address)",
  "function vaults(address) view returns(bool)", "function getPrice(address,bool,bool,bool) view returns(uint256)",
  "function getSwapFeeBasisPoints(address,address,uint256) view returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
  "function transfer(address,uint256) returns(bool)", "function execSubscript(bytes)",
]);
// Bound to saved verified source and deployed runtime, not an instance/brand allowlist.
export const CODE_HASH = "0xf5f6dbf69a182d5921afa3cf1afa500c028f3551ad414d63116acb5ad74f8c44";
export const UINT_MAX = ethers.MaxUint256;
export function address(value: string): string {
  const out = ethers.getAddress(value).toLowerCase();
  if (out === ethers.ZeroAddress) throw new Error("vault-spot zero address");
  return out;
}
export function amount(value: bigint, zero = false): bigint {
  if (typeof value !== "bigint" || value < (zero ? 0n : 1n) || value > UINT_MAX) throw new Error("vault-spot uint256 amount");
  return value;
}
export function pair(vault: string, tokens: readonly string[]): Binding {
  const v = address(vault), t = tokens.map(address).sort();
  if (t.length !== 2 || new Set([v, ...t]).size !== 3) throw new Error("vault-spot distinct pair required");
  return { vault: v, tokens: [t[0], t[1]], codeHash: CODE_HASH };
}
export const key = (b: Pick<Binding, "vault" | "tokens">) => `${b.vault}:${b.tokens.join(":")}`;
export const call = (id: string, to: string, fn: string, args: readonly unknown[] = []) => callRequest(id, to, ABI.encodeFunctionData(fn, args));
export function read(results: readonly AdapterRequestResult[], id: string, fn: string): unknown {
  const data = returnedResult(results, id).data;
  const decoded = ABI.decodeFunctionResult(fn, data);
  if (ABI.encodeFunctionResult(fn, decoded).toLowerCase() !== data.toLowerCase()) throw new Error("vault-spot noncanonical return");
  return decoded[0];
}
export const uint = (rs: readonly AdapterRequestResult[], id: string, fn: string) => amount(read(rs, id, fn) as bigint, true);
export function sourceOf(rs: readonly AdapterRequestResult[], expected?: CanonicalSource) {
  const source = assertSameSource(rs.map(r => returnedResult(rs, r.id)));
  if (new Set(rs.map(r => r.id)).size !== rs.length) throw new Error("vault-spot duplicate result");
  if (expected) assertSource(source, expected);
  return source;
}
export function rootRequests(b: Binding): readonly AdapterRequest[] {
  return [codeRequest("vault-code", b.vault),
    ...["isInitialized", "isSwapEnabled", "router", "usdg", "vaultUtils", "priceFeed", "includeAmmPrice"].map(fn => call(fn, b.vault, fn)),
    ...b.tokens.flatMap((token, i) => [call(`listed:${i}`, b.vault, "whitelistedTokens", [token]),
      call(`decimals:${i}`, b.vault, "tokenDecimals", [token]), call(`erc20-decimals:${i}`, token, "decimals"), codeRequest(`token-code:${i}`, token)])];
}
export function decodeRoot(b: Binding, rs: readonly AdapterRequestResult[], expected?: CanonicalSource): RootState {
  const source = sourceOf(rs, expected);
  if (ethers.keccak256(returnedResult(rs, "vault-code").data) !== CODE_HASH) throw new Error("vault-spot unsupported runtime");
  const addr = (fn: string) => address(read(rs, fn, fn) as string);
  const router = addr("router"), usdg = addr("usdg"), utils = addr("vaultUtils"), priceFeed = addr("priceFeed");
  if (new Set([b.vault, ...b.tokens, router, usdg, utils, priceFeed]).size !== 7) throw new Error("vault-spot dependency aliases");
  const decimals = b.tokens.map((_, i) => {
    const d = uint(rs, `decimals:${i}`, "tokenDecimals");
    if (d > 77n || uint(rs, `erc20-decimals:${i}`, "decimals") !== d || returnedResult(rs, `token-code:${i}`).data === "0x")
      throw new Error("vault-spot token decimals or code mismatch");
    return d;
  });
  return { source, router, usdg, utils, priceFeed, decimals,
    includeAmmPrice: read(rs, "includeAmmPrice", "includeAmmPrice") === true,
    active: read(rs, "isInitialized", "isInitialized") === true && read(rs, "isSwapEnabled", "isSwapEnabled") === true &&
      b.tokens.every((_, i) => read(rs, `listed:${i}`, "whitelistedTokens") === true) };
}
export function reverseRequests(b: Binding, s: RootState): readonly AdapterRequest[] {
  return [call("router-vault", s.router, "vault"), call("router-usdg", s.router, "usdg"),
    call("usdg-member", s.usdg, "vaults", [b.vault]), call("utils-vault", s.utils, "vault"),
    ...[s.router, s.usdg, s.utils, s.priceFeed].map((a, i) => codeRequest(`dependency-code:${i}`, a))];
}
export function assertReverse(b: Binding, s: RootState, rs: readonly AdapterRequestResult[]): void {
  sourceOf(rs, s.source);
  if (address(read(rs, "router-vault", "vault") as string) !== b.vault ||
      address(read(rs, "router-usdg", "usdg") as string) !== s.usdg ||
      address(read(rs, "utils-vault", "vault") as string) !== b.vault || read(rs, "usdg-member", "vaults") !== true ||
      [0, 1, 2, 3].some(i => returnedResult(rs, `dependency-code:${i}`).data === "0x"))
    throw new Error("vault-spot reverse registration mismatch");
}
