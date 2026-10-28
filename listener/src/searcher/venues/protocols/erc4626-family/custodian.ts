import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CallerRef, CanonicalSource } from "../../adapter-request-program.js";
import { assertSameSource, assertSource, callRequest, codeRequest, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";

// Source-bound synchronous FrxUSDCustodianUsdc 0.2.8 semantics, NOT an instance
// allowlist. Cached deployed bytecode matches the pinned-N implementation.
// logs/frax-custodian-diagnosis-20261009.Not1FW/{rpc-evidence,implementation-blockscout}.json
// FrxUSDCustodian.sol UTF8 SHA256: 1cc4032897759b09a457ace524567aa509b9a503e1435050b6cc4910241387b3
// FrxUSDCustodianUsdc.sol UTF8 SHA256: 928a4f0fcdfcb0e067112f5be8c4ead65c8568094d53cba5ed364ac926fe1d92
export const CUSTODIAN_IMPLEMENTATION_HASH = "0x51c008b264124ad667f58a8595b86745a657419baac327c1d1f335bc95b953a7";
// The verified transparent proxy has one PUSH32 admin immutable at byte 16.
// Authenticate its complete template, then derive the admin, rather than
// allowlisting one deployment's admin/bytecode.
const CUSTODIAN_PROXY_TEMPLATE_HASH = "0x834029e91a0eb94f478b72d8f8d0924a57de0dc6046e828a543fc421bd6270d7";
export const CUSTODIAN_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const CUSTODIAN_VARIANT = "frax-custodian-sync-conversion";
export const CUSTODIAN_ABI = new ethers.Interface([
  "function frxUSD() view returns(address)", "function asset() view returns(address)",
  "function custodianTkn() view returns(address)",
  "function frxUSDDecimals() view returns(uint8)", "function custodianTknDecimals() view returns(uint8)",
  "function mdwrComboView() view returns(uint256,uint256,uint256,uint256)",
  "function previewRedeem(uint256) view returns(uint256)",
  "function previewDeposit(uint256) view returns(uint256)",
  "function deposit(uint256,address) returns(uint256)",
  "function redeem(uint256,address,address) returns(uint256)",
]);
export const CUSTODIAN_TOKEN = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function decimals() view returns(uint8)", "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
  "function minters(address) view returns(bool)", "function isPaused() view returns(bool)",
  "function isFrozen(address) view returns(bool)",
]);
export interface CustodianBinding {
  /** Historical identity provenance, not an execution expiry at the next head. */
  readonly proofSource: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly shareCodeHash: string;
  readonly assetCodeHash: string;
}
export interface CustodianSurface {
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly inventory: bigint;
  readonly capacity: bigint;
  readonly depositCapacity: bigint;
  readonly mintCapacity: bigint;
}
export function custodianAddress(value: string): string {
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error("Custodian zero binding");
  return address;
}
export function custodianImplementationWord(data: string): string {
  if (!/^0x0{24}[a-fA-F0-9]{40}$/.test(data)) throw new Error("Custodian malformed implementation slot");
  return custodianAddress(`0x${data.slice(-40)}`);
}
export function proveCustodianProxy(code: string): { proxyCodeHash: string; proxyAdmin: string } {
  if (!/^0x[0-9a-fA-F]{2976}$/.test(code)) throw new Error("Custodian proxy template length");
  const start = 2 + 16 * 2, operand = code.slice(start, start + 64);
  const proxyAdmin = custodianImplementationWord(`0x${operand}`);
  if (code.slice(start - 2, start).toLowerCase() !== "7f" ||
      ethers.keccak256(code.slice(0, start) + "0".repeat(64) + code.slice(start + 64)) !== CUSTODIAN_PROXY_TEMPLATE_HASH)
    throw new Error("Custodian proxy template mismatch");
  return { proxyCodeHash: ethers.keccak256(code), proxyAdmin };
}
export function custodianSlot(id: string, vault: string): AdapterRequest {
  return { id, kind: "get-storage", address: vault, slot: CUSTODIAN_IMPLEMENTATION_SLOT };
}
export function custodianSurfaceRequests(prefix: string, vault: string, caller: CallerRef): AdapterRequest[] {
  return [codeRequest(`${prefix}-proxy`, vault), custodianSlot(`${prefix}-implementation`, vault),
    ...["frxUSD", "asset", "custodianTkn", "frxUSDDecimals", "custodianTknDecimals", "mdwrComboView"].map(name =>
      callRequest(`${prefix}-${name}`, vault, CUSTODIAN_ABI.encodeFunctionData(name), caller))];
}
export function custodianWord(results: readonly AdapterRequestResult[], id: string): bigint {
  const data = returnedResult(results, id).data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error(`Custodian malformed word: ${id}`);
  return BigInt(data);
}
export function custodianBool(results: readonly AdapterRequestResult[], id: string): boolean {
  const value = custodianWord(results, id);
  if (value > 1n) throw new Error(`Custodian malformed bool: ${id}`);
  return value === 1n;
}
export function decodeCustodianSurface(results: readonly AdapterRequestResult[], prefix: string, vault: string): CustodianSurface {
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  const proxy = proveCustodianProxy(requireRuntimeCode(results, `${prefix}-proxy`));
  const address = (name: string) => custodianImplementationWord(returnedResult(results, `${prefix}-${name}`).data);
  const share = address("frxUSD"), asset = address("asset");
  if (!sameAddress(asset, address("custodianTkn")) || sameAddress(share, asset) ||
      sameAddress(vault, share) || sameAddress(vault, asset)) throw new Error("Custodian external share binding");
  const shareDecimals = Number(custodianWord(results, `${prefix}-frxUSDDecimals`));
  const assetDecimals = Number(custodianWord(results, `${prefix}-custodianTknDecimals`));
  if (shareDecimals > 36 || assetDecimals > 36) throw new Error("Custodian decimals unsupported");
  const combo = returnedResult(results, `${prefix}-mdwrComboView`).data;
  if (!/^0x[0-9a-fA-F]{256}$/.test(combo)) throw new Error("Custodian malformed inventory");
  const values = CUSTODIAN_ABI.decodeFunctionResult("mdwrComboView", combo);
  return { source, vault: custodianAddress(vault), ...proxy, implementation: address("implementation"), share, asset,
    shareDecimals, assetDecimals, inventory: BigInt(values[2]), capacity: BigInt(values[3]),
    depositCapacity: BigInt(values[0]), mintCapacity: BigInt(values[1]) };
}
export function custodianDependencyRequests(prefix: string, s: CustodianSurface | CustodianBinding, vault: string, actor?: string): AdapterRequest[] {
  return [codeRequest(`${prefix}-code`, s.implementation), codeRequest(`${prefix}-share-code`, s.share),
    codeRequest(`${prefix}-asset-code`, s.asset),
    callRequest(`${prefix}-share-decimals`, s.share, CUSTODIAN_TOKEN.encodeFunctionData("decimals")),
    callRequest(`${prefix}-asset-decimals`, s.asset, CUSTODIAN_TOKEN.encodeFunctionData("decimals")),
    callRequest(`${prefix}-minter`, s.share, CUSTODIAN_TOKEN.encodeFunctionData("minters", [vault])),
    callRequest(`${prefix}-paused`, s.share, CUSTODIAN_TOKEN.encodeFunctionData("isPaused")),
    callRequest(`${prefix}-vault-frozen`, s.share, CUSTODIAN_TOKEN.encodeFunctionData("isFrozen", [vault])),
    ...(actor === undefined ? [] : [callRequest(`${prefix}-actor-frozen`, s.share, CUSTODIAN_TOKEN.encodeFunctionData("isFrozen", [actor]))])];
}
export function decodeCustodianDependencies(results: readonly AdapterRequestResult[], prefix: string, s: CustodianSurface): CustodianBinding {
  assertSource(assertSameSource(results.map(r => successfulResult(results, r.id))), s.source);
  if (ethers.keccak256(requireRuntimeCode(results, `${prefix}-code`)) !== CUSTODIAN_IMPLEMENTATION_HASH)
    throw new Error("Custodian implementation unsupported or upgraded");
  if (custodianWord(results, `${prefix}-share-decimals`) !== BigInt(s.shareDecimals) ||
      custodianWord(results, `${prefix}-asset-decimals`) !== BigInt(s.assetDecimals)) throw new Error("Custodian token decimals changed");
  return { proofSource: { ...s.source }, proxyCodeHash: s.proxyCodeHash, proxyAdmin: s.proxyAdmin,
    implementation: s.implementation, share: s.share, asset: s.asset,
    shareDecimals: s.shareDecimals, assetDecimals: s.assetDecimals,
    shareCodeHash: ethers.keccak256(requireRuntimeCode(results, `${prefix}-share-code`)),
    assetCodeHash: ethers.keccak256(requireRuntimeCode(results, `${prefix}-asset-code`)) };
}
export function custodianPermissionReason(results: readonly AdapterRequestResult[], prefix: string, actor = false): string | null {
  // Decode every supplied bool before assigning a stateful reason. Missing,
  // malformed and transport failures are never interpreted as paused/allowed.
  const minter = custodianBool(results, `${prefix}-minter`);
  const paused = custodianBool(results, `${prefix}-paused`);
  const frozen = custodianBool(results, `${prefix}-vault-frozen`);
  const actorFrozen = actor && custodianBool(results, `${prefix}-actor-frozen`);
  return !minter ? "custodian_minter_disabled" : paused ? "custodian_frxusd_paused" :
    frozen || actorFrozen ? "custodian_account_frozen" : null;
}
export function assertCustodianBinding(actual: CustodianBinding, expected: CustodianBinding): void {
  for (const key of ["implementation", "share", "asset", "proxyAdmin"] as const)
    if (!sameAddress(actual[key], expected[key])) throw new Error(`Custodian ${key} binding changed`);
  for (const key of ["shareDecimals", "assetDecimals", "shareCodeHash", "assetCodeHash", "proxyCodeHash"] as const)
    if (actual[key] !== expected[key]) throw new Error(`Custodian ${key} binding changed`);
}
export function custodianGuardRequests(prefix: string, vault: string, binding: CustodianBinding, actor?: string): AdapterRequest[] {
  return [...custodianSurfaceRequests(prefix, vault, { kind: "executor" }),
    ...custodianDependencyRequests(prefix, binding, vault, actor)];
}
export function checkCustodianGuard(results: readonly AdapterRequestResult[], prefix: string, vault: string,
  binding: CustodianBinding, actor = false, source?: CanonicalSource): CustodianSurface {
  const s = decodeCustodianSurface(results, prefix, vault);
  if (source !== undefined) assertSource(s.source, source);
  assertCustodianBinding(decodeCustodianDependencies(results, prefix, s), binding);
  const reason = custodianPermissionReason(results, prefix, actor);
  if (reason !== null) throw new Error(reason);
  return s;
}
