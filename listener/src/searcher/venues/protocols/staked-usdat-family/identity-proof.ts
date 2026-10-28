import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSameSource, assertSource, callRequest, codeRequest, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";

// Source-bound ERC1967Proxy and StakedUSDat implementation, verified from the
// deployed bytecode and Sourcify exact match. These identify behavior; no vault
// address or token address is an admission gate.
export const STAKED_USDAT_PROXY_CODE = "0x6080604052600a600c565b005b60186014601a565b6050565b565b5f604b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546001600160a01b031690565b905090565b365f5f375f5f365f845af43d5f5f3e8080156069573d5ff35b3d5ffdfea264697066735822122062ba703e4a09017c3a3f8e56bd964d252d36fcc1692ec264f7c15b6c0b89424064736f6c634300081e0033";
export const STAKED_USDAT_PROXY_HASH = ethers.keccak256(STAKED_USDAT_PROXY_CODE);
export const STAKED_USDAT_IMPLEMENTATION_HASH = "0x555fcdfcc7e072b39cb27f6a0f4619c376a0d6b1f6d2b8d60216d5beaca8d2a2";
export const STAKED_USDAT_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const STAKED_USDAT_INTERFACE = new ethers.Interface([
  "function asset() view returns(address)",
  "function getStrcOracle() view returns(address)",
  "function getWithdrawalQueue() view returns(address)",
  "function paused() view returns(bool)",
  "function isBlacklisted(address) view returns(bool)",
  "function depositFeeBps() view returns(uint256)",
  "function feeRecipient() view returns(address)",
]);

export interface StakedUsdatBinding {
  readonly proofSource: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly implementationCodeHash: string;
  readonly asset: string;
  readonly oracle: string;
  readonly withdrawalQueue: string;
}
export interface StakedUsdatExclusionCheck {
  readonly source: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation?: string;
  readonly implementationMatched?: true;
}
/** Mutable fee evidence belongs only to this source's active identity probe. */
export interface StakedUsdatFeeWitness {
  readonly source: CanonicalSource;
  readonly depositFeeBps: bigint;
  readonly feeRecipient: string;
}

export function stakedUsdatFeeRequests(prefix: string, vault: string): AdapterRequest[] {
  return ["depositFeeBps", "feeRecipient"].map(name => callRequest(`${prefix}-${name}`, vault,
    STAKED_USDAT_INTERFACE.encodeFunctionData(name)));
}
export function decodeStakedUsdatFeeWitness(results: readonly AdapterRequestResult[], prefix: string,
  expectedSource: CanonicalSource): StakedUsdatFeeWitness {
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  assertSource(source, expectedSource);
  const feeData = returnedResult(results, `${prefix}-depositFeeBps`).data;
  const recipientData = returnedResult(results, `${prefix}-feeRecipient`).data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(feeData) || !/^0x0{24}[0-9a-fA-F]{40}$/.test(recipientData))
    throw new Error("StakedUSDat malformed fee witness");
  const depositFeeBps = BigInt(feeData);
  if (depositFeeBps > 500n) throw new Error("StakedUSDat deposit fee exceeds verified implementation bound");
  return Object.freeze({ source: { ...source }, depositFeeBps,
    feeRecipient: ethers.getAddress(`0x${recipientData.slice(-40)}`) });
}
export function stakedUsdatDepositEventAssets(witness: StakedUsdatFeeWitness, grossAssets: bigint): bigint {
  if (grossAssets < 0n) throw new Error("StakedUSDat negative gross assets");
  const fee = witness.feeRecipient === ethers.ZeroAddress || witness.depositFeeBps === 0n ? 0n :
    (grossAssets * witness.depositFeeBps + 9_999n) / 10_000n;
  return grossAssets - fee;
}

export function stakedUsdatAddressWord(data: string): string {
  if (!/^0x0{24}[a-fA-F0-9]{40}$/.test(data)) throw new Error("StakedUSDat malformed address word");
  const address = ethers.getAddress(`0x${data.slice(-40)}`);
  if (address === ethers.ZeroAddress) throw new Error("StakedUSDat zero binding");
  return address;
}
export function isStakedUsdatProxy(code: string): boolean {
  return ethers.keccak256(code) === STAKED_USDAT_PROXY_HASH;
}
export function stakedUsdatSlot(id: string, vault: string): AdapterRequest {
  return { id, kind: "get-storage", address: vault, slot: STAKED_USDAT_IMPLEMENTATION_SLOT };
}
export function stakedUsdatBindingRequests(prefix: string, vault: string, implementation: string): AdapterRequest[] {
  return [codeRequest(`${prefix}-code`, implementation),
    ...["asset", "getStrcOracle", "getWithdrawalQueue"].map(name => callRequest(`${prefix}-${name}`, vault,
      STAKED_USDAT_INTERFACE.encodeFunctionData(name)))];
}
export function decodeStakedUsdatBinding(results: readonly AdapterRequestResult[], prefix: string,
  vault: string, proof: StakedUsdatExclusionCheck): StakedUsdatBinding {
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  assertSource(source, proof.source);
  if (!proof.implementation || proof.proxyCodeHash !== STAKED_USDAT_PROXY_HASH)
    throw new Error("StakedUSDat missing reverse proxy proof");
  const code = requireRuntimeCode(results, `${prefix}-code`);
  if (ethers.keccak256(code) !== STAKED_USDAT_IMPLEMENTATION_HASH)
    throw new Error("StakedUSDat implementation unsupported or upgraded");
  // Sourcify immutableReferences: UUPS __self (3747), STRC_ORACLE (12028),
  // WITHDRAWAL_QUEUE (12032). All repeated sites must agree before getters bind.
  const immutable = (offsets: number[]) => {
    const words = offsets.map(offset => stakedUsdatAddressWord(`0x${code.slice(2 + offset * 2, 2 + (offset + 32) * 2)}`));
    if (!words.every(word => sameAddress(word, words[0]!))) throw new Error("StakedUSDat immutable disagreement");
    return words[0]!;
  };
  if (!sameAddress(immutable([11189, 11230, 11551]), proof.implementation))
    throw new Error("StakedUSDat UUPS implementation self mismatch");
  const oracle = immutable([3508, 8461, 9878, 11665]);
  const withdrawalQueue = immutable([1439, 6190, 6667, 7579, 7646, 7723, 7813, 12524, 12584]);
  const getter = (name: string) => stakedUsdatAddressWord(returnedResult(results, `${prefix}-${name}`).data);
  const asset = getter("asset");
  if (sameAddress(asset, vault) || !sameAddress(getter("getStrcOracle"), oracle) ||
      !sameAddress(getter("getWithdrawalQueue"), withdrawalQueue)) throw new Error("StakedUSDat getter binding mismatch");
  return Object.freeze({ proofSource: { ...source }, proxyCodeHash: proof.proxyCodeHash,
    implementation: proof.implementation, implementationCodeHash: STAKED_USDAT_IMPLEMENTATION_HASH,
    asset, oracle, withdrawalQueue });
}
export function stakedUsdatGuardRequests(prefix: string, vault: string, binding: StakedUsdatBinding, actor?: string): AdapterRequest[] {
  return [codeRequest(`${prefix}-proxy`, vault), stakedUsdatSlot(`${prefix}-implementation`, vault),
    ...stakedUsdatBindingRequests(prefix, vault, binding.implementation),
    callRequest(`${prefix}-paused`, vault, STAKED_USDAT_INTERFACE.encodeFunctionData("paused")),
    ...(actor === undefined ? [] : [callRequest(`${prefix}-actor-blacklisted`, vault,
      STAKED_USDAT_INTERFACE.encodeFunctionData("isBlacklisted", [actor]))])];
}
export function checkStakedUsdatGuard(results: readonly AdapterRequestResult[], prefix: string, vault: string,
  binding: StakedUsdatBinding, source?: CanonicalSource): void {
  const currentSource = assertSameSource(results.map(r => successfulResult(results, r.id)));
  if (source !== undefined) assertSource(currentSource, source);
  const code = requireRuntimeCode(results, `${prefix}-proxy`);
  if (!isStakedUsdatProxy(code)) throw new Error("StakedUSDat proxy changed");
  const implementation = stakedUsdatAddressWord(returnedResult(results, `${prefix}-implementation`).data);
  if (!sameAddress(implementation, binding.implementation)) throw new Error("StakedUSDat implementation changed");
  const actual = decodeStakedUsdatBinding(results, prefix, vault, {
    source: currentSource, proxyCodeHash: ethers.keccak256(code), implementation,
  });
  for (const name of ["proxyCodeHash", "implementationCodeHash", "asset", "oracle", "withdrawalQueue"] as const)
    if (actual[name].toLowerCase() !== binding[name].toLowerCase()) throw new Error(`StakedUSDat ${name} changed`);
  const bool = (id: string) => {
    const data = returnedResult(results, id).data;
    if (!/^0x0{63}[01]$/.test(data)) throw new Error("StakedUSDat malformed permission bool");
    return BigInt(data) === 1n;
  };
  if (bool(`${prefix}-paused`)) throw new Error("staked_usdat_paused");
  if (results.some(r => r.id === `${prefix}-actor-blacklisted`) && bool(`${prefix}-actor-blacklisted`))
    throw new Error("staked_usdat_actor_blacklisted");
}
