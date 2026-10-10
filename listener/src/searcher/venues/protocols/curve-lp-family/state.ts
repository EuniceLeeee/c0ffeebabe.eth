import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ABI, DECIMALS, META, address, call, code, decode, rows, uint } from "./codec.js";
import { KILLED_SLOT, LP_HASH, POOL_HASH, proveCode } from "./model.js";
import type { Binding, State } from "./types.js";
export const requirements = { transports: ["get-code", "get-storage", "eth-call"] as const };
export const surfaceRequests = (pool: string) => [code("pool-code", pool),
  ...[0, 1].map(i => call(`coin-${i}`, pool, ABI.encodeFunctionData("coins", [i]))),
  call("pool-lp", pool, ABI.encodeFunctionData("lp_token")),
  call("registry-lp", META, ABI.encodeFunctionData("get_lp_token", [pool])),
  call("registry-coins", META, ABI.encodeFunctionData("get_coins", [pool])),
  call("registry-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [pool]))];
export const dependencyRequests = (d: Pick<Binding, "pool" | "lp" | "coins">) => [code("lp-code", d.lp),
  call("lp-minter", d.lp, ABI.encodeFunctionData("minter")), call("lp-decimals", d.lp, ABI.encodeFunctionData("decimals")),
  call("registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [d.lp])),
  ...d.coins.flatMap((coin, i) => [code(`coin-code-${i}`, coin), call(`coin-decimals-${i}`, coin, ABI.encodeFunctionData("decimals"))])];
export const dynamicRequests = (d: Pick<Binding, "pool" | "lp">): AdapterRequest[] => [
  ...["A_precise", "future_A", "fee"].map(fn => call(fn, d.pool, ABI.encodeFunctionData(fn))),
  ...[0, 1].map(i => call(`balance-${i}`, d.pool, ABI.encodeFunctionData("balances", [i]))),
  call("supply", d.lp, ABI.encodeFunctionData("totalSupply")),
  { id: "killed", kind: "get-storage", address: d.pool, slot: ethers.toBeHex(KILLED_SLOT, 32) },
];
export const stateRequests = (d: Binding) => [...surfaceRequests(d.pool), ...dependencyRequests(d), ...dynamicRequests(d)];
export function surface(pool: string, get: (id: string) => string) {
  proveCode(get("pool-code"), POOL_HASH);
  const coins = [0, 1].map(i => address(decode("coins", get(`coin-${i}`))[0])) as [string, string];
  const lp = address(decode("lp_token", get("pool-lp"))[0]);
  if (new Set([pool, lp, ...coins, META]).size !== 5 || address(decode("get_lp_token", get("registry-lp"))[0]) !== lp) throw new Error("curve-lp pool/LP binding");
  const registered = [...decode("get_coins", get("registry-coins"))[0]].map(v => String(v).toLowerCase());
  if (registered.slice(0, 2).some((v, i) => v !== coins[i]) || registered.slice(2).some(v => v !== ethers.ZeroAddress) ||
      [...decode("get_registry_handlers_from_pool", get("registry-handlers"))[0]].every(v => String(v).toLowerCase() === ethers.ZeroAddress))
    throw new Error("curve-lp unregistered or incompatible coins");
  return { pool, lp, coins, poolCodeHash: POOL_HASH };
}
export function bind(d: ReturnType<typeof surface>, get: (id: string) => string): Binding {
  if (address(decode("minter", get("lp-minter"))[0]) !== d.pool || address(decode("get_pool_from_lp_token", get("registry-pool"))[0]) !== d.pool ||
      decode("decimals", get("lp-decimals"))[0] !== 18n) throw new Error("curve-lp reverse minter/LP binding");
  const coinCodeHashes = d.coins.map((_coin, i) => { const c = get(`coin-code-${i}`);
    if (c === "0x" || decode("decimals", get(`coin-decimals-${i}`))[0] !== BigInt(DECIMALS[i])) throw new Error("curve-lp coin decimals/code");
    return ethers.keccak256(c); }) as [string, string];
  return { ...d, lpCodeHash: proveCode(get("lp-code"), LP_HASH), coinCodeHashes };
}
export function dynamic(get: (id: string) => string, source: CanonicalSource): State {
  const u = (fn: string) => uint(decode(fn, get(fn))[0]), amp = u("A_precise"), future = u("future_A");
  // On-touch prices are valid only for this proven fixed-A branch. RampA is
  // observed and fails closed; time-dependent/ramping variants are not claimed.
  if (!amp || amp !== future) throw new Error("curve-lp active ramp unsupported");
  const fee = u("fee"), killed = get("killed");
  if (fee > 5n * 10n ** 9n || !ethers.isHexString(killed, 32) || BigInt(killed) > 1n) throw new Error("curve-lp invalid fee/kill state");
  return { source, amp, fee, killed: BigInt(killed) === 1n,
    totalSupply: uint(decode("totalSupply", get("supply"))[0]),
    balances: [0, 1].map(i => uint(decode("balances", get(`balance-${i}`))[0])) as [bigint, bigint] };
}
export function decodeState(d: Binding, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  const r = rows(results, stateRequests(d), source), now = bind(surface(d.pool, r.get), r.get);
  if (JSON.stringify(now) !== JSON.stringify({ pool: d.pool, lp: d.lp, coins: d.coins, poolCodeHash: d.poolCodeHash,
    lpCodeHash: d.lpCodeHash, coinCodeHashes: d.coinCodeHashes })) throw new Error("curve-lp binding changed");
  return dynamic(r.get, r.source);
}
