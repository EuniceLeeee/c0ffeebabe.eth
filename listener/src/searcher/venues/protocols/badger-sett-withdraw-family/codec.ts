import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { callRequest as call, codeRequest as code, assertSource };
export const MAX = ethers.MaxUint256, WAD = 10n ** 18n, BPS = 10000n;
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// Exact verified N runtimes. These recognize code, never instance addresses.
// Public-source and independent compiler bindings are recorded in README.md.
export const CODE = {
  proxy: "0x1dd89e38c5a11df51ecacb234a347e6043127ba58d42beb784889bf64ab4abaf",
  vault: "0x55f87e0d3930098a9a23ad78acb3a69df6009334f7194ddc64cfed0c620abe1b",
  strategy: "0x7c9ad0b11aaf2698dc34b392b0fefa07bc2b554991677eafcc70ea6b47ad3df4",
  asset: "0x29fa14ed566cfc96628bfb573316782856bc583b0b3079fa524d13a38dd0d58b",
  locker: "0xfc0191c25a095f6fdcf4601aac3baa7dc878c0f20e1b9532e18ec99871e34817",
} as const;
export const VAULT = new ethers.Interface([
  "function token() view returns(address)", "function strategy() view returns(address)",
  "function totalSupply() view returns(uint256)", "function balance() view returns(uint256)",
  "function withdrawalFee() view returns(uint256)", "function treasury() view returns(address)",
  "function paused() view returns(bool)", "function decimals() view returns(uint8)",
  "function withdraw(uint256)", "function balanceOf(address) view returns(uint256)",
]);
export const STRATEGY = new ethers.Interface([
  "function vault() view returns(address)", "function want() view returns(address)",
  "function LOCKER() view returns(address)", "function paused() view returns(bool)",
  "function balanceOf() view returns(uint256)", "function withdrawalSafetyCheck() view returns(bool)",
  "function withdrawalMaxDeviationThreshold() view returns(uint256)",
]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
export const LOCKER = new ethers.Interface(["function stakingToken() view returns(address)", "function balances(address) view returns(uint112 locked,uint32 nextUnlockIndex)"]);
export function address(value: string): string {
  const a = ethers.getAddress(value).toLowerCase();
  if (a === ethers.ZeroAddress) throw new Error("badger-sett zero address");
  return a;
}
export function uint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX) throw new Error("badger-sett uint256 overflow");
  return value;
}
export function sourceValid(s: CanonicalSource): void {
  if (!Number.isSafeInteger(s.number) || s.number < 0 || !/^0x[0-9a-f]{64}$/i.test(s.hash) ||
      !Number.isSafeInteger(s.generation) || s.generation < 0) throw new Error("badger-sett invalid source");
}
export const storage = (id: string, a: string, slot: string): AdapterRequest => ({ id, kind: "get-storage", address: address(a), slot });
export function storageAddress(word: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(word)) throw new Error("badger-sett noncanonical storage address");
  return address("0x" + word.slice(-40));
}
export function decode(abi: ethers.Interface, name: string, data: string) {
  const v = abi.decodeFunctionResult(name, data);
  if (abi.encodeFunctionResult(name, v).toLowerCase() !== data.toLowerCase()) throw new Error("badger-sett noncanonical ABI");
  return v;
}
export function rows(results: readonly AdapterRequestResult[], requests: readonly AdapterRequest[], expected?: CanonicalSource) {
  const ids = requests.map(r => r.id), source = results[0]?.source;
  if (!source || results.length !== ids.length || new Set(ids).size !== ids.length) throw new Error("badger-sett missing/duplicate result");
  sourceValid(source); if (expected) assertSource(source, expected);
  const values = new Map<string, string>();
  for (const r of results) {
    if (!ids.includes(r.id) || values.has(r.id) || !r.ok || r.completion !== "returned") throw new Error("badger-sett unresolved result " + r.id);
    assertSource(r.source, source); values.set(r.id, r.data);
  }
  return { source, get(id: string): string { const v = values.get(id); if (v === undefined) throw new Error("badger-sett missing " + id); return v; } };
}
export function prove(data: string, kind: keyof typeof CODE) {
  if (ethers.keccak256(data) !== CODE[kind]) throw new Error("badger-sett unsupported " + kind + " runtime");
}
