import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { assertSameSource, callRequest, codeRequest, decodeAddress, decodeUint, returnedResult, sameAddress } from "../standard-family/common.js";
import type { Binding } from "./types.js";
export const ABI = new ethers.Interface([
  "function factory() view returns(address)", "function token() view returns(address)",
  "function getWrappedToken(address) view returns(address)", "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
  "function wrap(uint256) returns(uint256)", "function unwrap(uint256) returns(uint256)",
  "function wrapTo(uint256,address) returns(uint256)", "function unwrapTo(uint256,address) returns(uint256)",
  "event Wrap(address indexed sender,uint256 amount,address indexed to)",
  "event Unwrap(address indexed sender,uint256 amount,address indexed to)",
]);
// Executable implementation profile, not a list of admitted wrapper addresses.
// Every instance additionally proves factory -> underlying -> wrapper membership.
export const WRAPPER_CODE_HASH = "0xbe63f68c8de6e3f7cf411d9b117b931128468c36e0753fc5878fd5359f16acf5";
export const MAX_UINT = (1n << 256n) - 1n;
export function address(value: string): string {
  const a = ethers.getAddress(value); if (a === ethers.ZeroAddress) throw new Error("few zero address"); return a;
}
export function amount(value: bigint, allowZero = false): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > MAX_UINT) throw new Error("few amount outside uint256");
  return value;
}
export function guardRequests(b: Pick<Binding,"target"|"asset"|"factory">): readonly AdapterRequest[] {
  return [codeRequest("few-code",b.target), codeRequest("few-asset-code",b.asset), codeRequest("few-factory-code",b.factory),
    callRequest("few-asset",b.target,ABI.encodeFunctionData("token")),
    callRequest("few-factory",b.target,ABI.encodeFunctionData("factory")),
    callRequest("few-member",b.factory,ABI.encodeFunctionData("getWrappedToken",[b.asset])),
  ];
}
export function currentRequests(b: Pick<Binding,"target"|"asset"|"factory">): readonly AdapterRequest[] {
  return [...guardRequests(b),
    callRequest("few-supply",b.target,ABI.encodeFunctionData("totalSupply")),
    callRequest("few-backing",b.asset,ABI.encodeFunctionData("balanceOf",[b.target])),
    callRequest("few-decimals",b.asset,ABI.encodeFunctionData("decimals"))];
}
export function decodeBinding(b: Pick<Binding,"target"|"asset"|"factory">, results: readonly AdapterRequestResult[]): Binding {
  assertSameSource(guardRequests(b).map(r=>returnedResult(results,r.id)));
  const code = (id: string) => {
    const bytes=returnedResult(results,id).data;
    if (!ethers.isHexString(bytes) || bytes === "0x") throw new Error("few missing dependency code");
    return ethers.keccak256(bytes);
  };
  const codeHash=code("few-code");
  if (codeHash !== WRAPPER_CODE_HASH || new Set([b.target,b.asset,b.factory].map(x=>address(x).toLowerCase())).size !== 3 ||
      !sameAddress(decodeAddress(ABI,"factory",results,"few-factory"),b.factory) ||
      !sameAddress(decodeAddress(ABI,"token",results,"few-asset"),b.asset) ||
      !sameAddress(decodeAddress(ABI,"getWrappedToken",results,"few-member"),b.target)) throw new Error("few reverse binding mismatch");
  return {...b,codeHash,assetCodeHash:code("few-asset-code"),factoryCodeHash:code("few-factory-code")};
}
export function assertCurrentBinding(b: Binding, results: readonly AdapterRequestResult[]) {
  const now=decodeBinding(b,results);
  if (now.assetCodeHash!==b.assetCodeHash || now.factoryCodeHash!==b.factoryCodeHash || now.codeHash!==b.codeHash)
    throw new Error("few dependency code changed");
  return assertSameSource(guardRequests(b).map(r=>returnedResult(results,r.id)));
}
export function probeAmount(results: readonly AdapterRequestResult[]): bigint {
  const decimals=decodeUint(ABI,"decimals",results,"few-decimals");
  if(decimals>77n) throw new Error("few unsupported asset decimals");
  return [10n**decimals,decodeUint(ABI,"totalSupply",results,"few-supply"),decodeUint(ABI,"balanceOf",results,"few-backing")]
    .reduce((a,b)=>a<b?a:b);
}
