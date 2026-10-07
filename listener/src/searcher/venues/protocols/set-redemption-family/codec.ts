import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { callRequest as call, codeRequest as code };
export const WAD = 10n ** 18n, MAX = (1n << 256n) - 1n;
// Exact Sourcify runtimes, solc 0.7.6, no immutable ranges, direct non-proxy
// implementations. These authenticate behavior, not an instance address or creation.
export const SET_CODE_HASH = "0x096df383c453967864ea5f66d0a6e454e4ca4696578f47981d2480d8d4a80b5f";
export const MODULE_CODE_HASH = "0xf4498b92792be6f31f103a61ef5449d8934aa50b27688a62d723cbbeea3eae9c";
export const SET = new ethers.Interface([
  "function controller() view returns(address)", "function getModules() view returns(address[])",
  "function moduleStates(address) view returns(uint8)", "function getComponents() view returns(address[])",
  "function isLocked() view returns(bool)", "function positionMultiplier() view returns(int256)",
  "function totalSupply() view returns(uint256)", "function getExternalPositionModules(address) view returns(address[])",
  "function getDefaultPositionRealUnit(address) view returns(int256)",
]);
export const MODULE = new ethers.Interface([
  "function controller() view returns(address)", "function redeem(address,uint256,address)",
  "event SetTokenRedeemed(address indexed setToken,address indexed redeemer,address indexed to,uint256 quantity)",
]);
export const CONTROLLER = new ethers.Interface(["function isSet(address) view returns(bool)", "function isModule(address) view returns(bool)"]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
export function address(v: string): string { const a = ethers.getAddress(v).toLowerCase(); if (a === ethers.ZeroAddress) throw new Error("set-redemption zero address"); return a; }
export function uint(v: bigint): bigint { if (typeof v !== "bigint" || v < 0n || v > MAX) throw new Error("set-redemption uint256 overflow"); return v; }
export function decode(abi: ethers.Interface, name: string, data: string) {
  const v = abi.decodeFunctionResult(name, data);
  if (abi.encodeFunctionResult(name, v).toLowerCase() !== data.toLowerCase()) throw new Error("set-redemption noncanonical ABI");
  return v;
}
export function rows(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource) {
  if (results.length !== ids.length || new Set(ids).size !== ids.length) throw new Error("set-redemption missing/duplicate result");
  const source = results[0]?.source;
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 || !/^0x[0-9a-f]{64}$/i.test(source.hash)) throw new Error("set-redemption invalid source");
  if (expected) assertSource(source, expected);
  const byId = new Map<string, string>();
  for (const r of results) {
    if (!ids.includes(r.id) || byId.has(r.id) || !r.ok || r.completion !== "returned")
      throw new Error(`set-redemption unresolved/ambiguous result id=${r.id} known=${ids.includes(r.id)} duplicate=${byId.has(r.id)} outcome=${r.ok ? r.completion : r.failure}`);
    assertSource(r.source, source); byId.set(r.id, r.data);
  }
  return { source, get: (id: string) => { const v = byId.get(id); if (v === undefined) throw new Error("set-redemption missing result " + id); return v; } };
}
export function members(values: readonly string[], forbidden: readonly string[] = []): readonly string[] {
  const a = values.map(address);
  if (!a.length || new Set(a).size !== a.length || a.some(v => forbidden.includes(v))) throw new Error("set-redemption unsupported component membership");
  return a;
}
