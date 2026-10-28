import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSameSource, assertSource, callRequest, codeRequest, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";

// Infrastructure registry, not a vault allowlist: the candidate must be the
// registry's current stakedToken and reverse-bind all token/Core/YieldSharing links.
export const INFINIFI_GATEWAY = "0x3f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5";
export const INFINIFI_MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const INFINIFI_VARIANT = "infinifi-gateway-staking";
export const INFINIFI_ROLE = ethers.id("ENTRY_POINT");
export const INFINIFI_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const INFINIFI_ABI = new ethers.Interface([
  "function getAddress(string) view returns(address)", "function core() view returns(address)",
  "function asset() view returns(address)", "function yieldSharing() view returns(address)",
  "function stakedToken() view returns(address)", "function receiptToken() view returns(address)",
  "function paused() view returns(bool)", "function hasRole(bytes32,address) view returns(bool)",
  "function unaccruedYield() view returns(int256)", "function canEnterOrExitStakedToken() view returns(bool)",
  "function distributeInterpolationRewards()", "function vested() view returns(uint256)",
  "function previewDeposit(uint256) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function stake(address,uint256) returns(uint256)", "function unstake(address,uint256) returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function decimals() view returns(uint8)", "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[])",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export interface InfiniFiSurface {
  readonly proofSource: CanonicalSource;
  readonly vault: string;
  readonly asset: string;
  readonly gateway: string;
  readonly core: string;
  readonly yieldSharing: string;
  readonly gatewayImplementation: string;
  readonly shareDecimals: number;
  readonly vaultCodeHash: string;
  readonly gatewayCodeHash: string;
}
export interface InfiniFiBinding extends InfiniFiSurface {
  readonly yieldSharingImplementation: string;
  readonly assetDecimals: number;
  readonly codeHashes: Readonly<Record<"asset" | "core" | "yieldSharing" | "gatewayImplementation" | "yieldSharingImplementation" | "multicall", string>>;
}
export function infinifiProjection(b: InfiniFiBinding) {
  return { ...b, proofSource: { ...b.proofSource }, codeHashes: { ...b.codeHashes } };
}
export function infinifiAddress(value: string): string {
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error("InfiniFi zero address");
  return address;
}
export function infinifiWord(results: readonly AdapterRequestResult[], id: string): bigint {
  const data = returnedResult(results, id).data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("InfiniFi malformed word: " + id);
  return BigInt(data);
}
function addressWord(results: readonly AdapterRequestResult[], id: string): string {
  const value = infinifiWord(results, id);
  if (value >= 1n << 160n) throw new Error("InfiniFi malformed address: " + id);
  return infinifiAddress(ethers.toBeHex(value, 20));
}
export function infinifiSlot(id: string, address: string): AdapterRequest {
  return { id, kind: "get-storage", address, slot: INFINIFI_SLOT };
}
function read(id: string, address: string, name: string, args: readonly unknown[] = []): AdapterRequest {
  return callRequest(id, address, INFINIFI_ABI.encodeFunctionData(name, args));
}
export function infinifiSurfaceRequests(p: string, vault: string): AdapterRequest[] {
  return [
    codeRequest(p + "-vault-code", vault), codeRequest(p + "-gateway-code", INFINIFI_GATEWAY),
    infinifiSlot(p + "-gateway-implementation", INFINIFI_GATEWAY),
    ...["stakedToken", "receiptToken", "yieldSharing"].map(name => read(p + "-registry-" + name, INFINIFI_GATEWAY, "getAddress", [name])),
    ...["asset", "yieldSharing", "core", "decimals"].map(name => read(p + "-vault-" + name, vault, name)),
    read(p + "-gateway-core", INFINIFI_GATEWAY, "core"),
  ];
}
export function decodeInfiniFiSurface(results: readonly AdapterRequestResult[], p: string, vault: string): InfiniFiSurface {
  const proofSource = assertSameSource(results.map(r => successfulResult(results, r.id)));
  const address = (name: string) => addressWord(results, p + "-" + name);
  const asset = address("vault-asset"), yieldSharing = address("vault-yieldSharing"), core = address("vault-core");
  if (!sameAddress(address("registry-stakedToken"), vault) ||
      !sameAddress(address("registry-receiptToken"), asset) ||
      !sameAddress(address("registry-yieldSharing"), yieldSharing) ||
      !sameAddress(address("gateway-core"), core) ||
      new Set([vault, asset, yieldSharing, core, INFINIFI_GATEWAY].map(a => a.toLowerCase())).size !== 5)
    throw new Error("InfiniFi registry/reverse binding mismatch");
  const shareDecimals = Number(infinifiWord(results, p + "-vault-decimals"));
  if (shareDecimals > 36) throw new Error("InfiniFi share decimals");
  return { proofSource: { ...proofSource }, vault: infinifiAddress(vault), asset, gateway: infinifiAddress(INFINIFI_GATEWAY),
    yieldSharing, core, shareDecimals, gatewayImplementation: address("gateway-implementation"),
    vaultCodeHash: ethers.keccak256(requireRuntimeCode(results, p + "-vault-code")),
    gatewayCodeHash: ethers.keccak256(requireRuntimeCode(results, p + "-gateway-code")) };
}
export function infinifiDependencyRequests(p: string, b: InfiniFiSurface): AdapterRequest[] {
  return [
    ...(["asset", "core", "yieldSharing", "gatewayImplementation"] as const).map(key => codeRequest(p + "-code-" + key, b[key])),
    codeRequest(p + "-code-multicall", INFINIFI_MULTICALL),
    infinifiSlot(p + "-yieldSharing-implementation", b.yieldSharing),
    ...["core", "stakedToken", "receiptToken"].map(name => read(p + "-ys-" + name, b.yieldSharing, name)),
    read(p + "-asset-decimals", b.asset, "decimals"),
    read(p + "-entry-point", b.core, "hasRole", [INFINIFI_ROLE, b.gateway]),
    read(p + "-gateway-paused", b.gateway, "paused"),
    read(p + "-vault-paused", b.vault, "paused"),
    read(p + "-loss", b.yieldSharing, "unaccruedYield"),
  ];
}
export function decodeInfiniFiDependencies(results: readonly AdapterRequestResult[], p: string, b: InfiniFiSurface):
  Omit<InfiniFiBinding, "codeHashes"> & { codeHashes: Omit<InfiniFiBinding["codeHashes"], "yieldSharingImplementation"> } {
  assertSource(assertSameSource(results.map(r => successfulResult(results, r.id))), b.proofSource);
  for (const [name, expected] of [["core", b.core], ["stakedToken", b.vault], ["receiptToken", b.asset]] as const)
    if (!sameAddress(addressWord(results, p + "-ys-" + name), expected)) throw new Error("InfiniFi YieldSharing reverse binding");
  const assetDecimals = Number(infinifiWord(results, p + "-asset-decimals"));
  if (assetDecimals > 36) throw new Error("InfiniFi asset decimals");
  const hash = (name: string) => ethers.keccak256(requireRuntimeCode(results, p + "-code-" + name));
  return { ...b, assetDecimals, yieldSharingImplementation: addressWord(results, p + "-yieldSharing-implementation"),
    codeHashes: { asset: hash("asset"), core: hash("core"), yieldSharing: hash("yieldSharing"),
      gatewayImplementation: hash("gatewayImplementation"), multicall: hash("multicall") } };
}
export function infinifiPermissionReason(results: readonly AdapterRequestResult[], p: string, redeem: boolean): string | null {
  const flag = (name: string) => { const value = infinifiWord(results, p + "-" + name); if (value > 1n) throw new Error("InfiniFi malformed bool"); return value === 1n; };
  const role = flag("entry-point"), gatewayPaused = flag("gateway-paused"), vaultPaused = flag("vault-paused");
  const lossWord = infinifiWord(results, p + "-loss");
  const negative = lossWord >= 1n << 255n;
  return !role ? "infinifi_gateway_permission_disabled" : gatewayPaused || vaultPaused ? "infinifi_paused" :
    redeem && negative ? "infinifi_pending_losses" : null;
}
export function infinifiGuardRequests(p: string, b: InfiniFiBinding): AdapterRequest[] {
  return [...infinifiSurfaceRequests(p, b.vault), ...infinifiDependencyRequests(p, b),
    codeRequest(p + "-code-yieldSharingImplementation", b.yieldSharingImplementation)];
}
export function checkInfiniFiGuard(results: readonly AdapterRequestResult[], p: string, b: InfiniFiBinding, redeem: boolean, source?: CanonicalSource): void {
  const surface = decodeInfiniFiSurface(results, p, b.vault);
  if (source) assertSource(surface.proofSource, source);
  const deps = decodeInfiniFiDependencies(results, p, surface);
  for (const key of ["vault", "asset", "gateway", "core", "yieldSharing", "gatewayImplementation", "yieldSharingImplementation"] as const)
    if (!sameAddress(deps[key], b[key])) throw new Error("InfiniFi dependency changed: " + key);
  for (const key of ["shareDecimals", "assetDecimals", "vaultCodeHash", "gatewayCodeHash"] as const)
    if (deps[key] !== b[key]) throw new Error("InfiniFi surface changed: " + key);
  for (const key of Object.keys(deps.codeHashes) as (keyof typeof deps.codeHashes)[])
    if (deps.codeHashes[key] !== b.codeHashes[key]) throw new Error("InfiniFi dependency code changed: " + key);
  if (ethers.keccak256(requireRuntimeCode(results, p + "-code-yieldSharingImplementation")) !== b.codeHashes.yieldSharingImplementation)
    throw new Error("InfiniFi YieldSharing implementation changed");
  const reason = infinifiPermissionReason(results, p, redeem); if (reason) throw new Error(reason);
}
export function infinifiQuoteRequest(id: string, b: Pick<InfiniFiBinding, "vault" | "yieldSharing">, direction: "deposit" | "redeem", amount: bigint): AdapterRequest {
  if (amount <= 0n || amount > ethers.MaxUint256) throw new Error("InfiniFi quote amount");
  // A single discarded eth_call performs exactly the public distribution used
  // by Gateway before the vault preview. It neither opens the transient gate
  // nor impersonates Gateway, and is NOT an execution trial or linear point price.
  const calls = [
    { target: b.yieldSharing, allowFailure: false, callData: INFINIFI_ABI.encodeFunctionData("distributeInterpolationRewards") },
    { target: b.vault, allowFailure: false, callData: INFINIFI_ABI.encodeFunctionData(direction === "deposit" ? "previewDeposit" : "previewRedeem", [amount]) },
  ];
  return callRequest(id, INFINIFI_MULTICALL, INFINIFI_ABI.encodeFunctionData("aggregate3", [calls]));
}
export function decodeInfiniFiQuote(data: string): bigint {
  const [rows] = INFINIFI_ABI.decodeFunctionResult("aggregate3", data);
  if (rows.length !== 2 || rows.some((r: { success: boolean }) => !r.success) || rows[0].returnData !== "0x" ||
      !/^0x[0-9a-fA-F]{64}$/.test(rows[1].returnData)) throw new Error("InfiniFi distribution/preview response");
  const amount = BigInt(rows[1].returnData);
  if (amount <= 0n) throw new Error("InfiniFi quote returned no output");
  return amount;
}
