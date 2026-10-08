import { ethers } from "ethers";
import { bindRequestResultRound, collectRequestProgramResults } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertBinding } from "./instance.js";
import { rootRequests, rootBinding, strategyRequests, strategyBinding, dependencyRequests, proveDependencies, requirements } from "./closure.js";
import { address, call, decode, rows, uint, assertSource, MAX, BPS, VAULT, STRATEGY, TOKEN, LOCKER } from "./codec.js";
import type { Binding, Descriptor, State } from "./types.js";
export const stateRequests = (b: Binding) => [
  ...["totalSupply", "balance", "withdrawalFee", "treasury", "paused"].map(n => call("state-vault-" + n, b.vault, VAULT.encodeFunctionData(n))),
  ...["balanceOf", "paused", "withdrawalSafetyCheck", "withdrawalMaxDeviationThreshold"].map(n => call("state-strategy-" + n, b.strategy, STRATEGY.encodeFunctionData(n))),
  call("state-vault-idle", b.asset, TOKEN.encodeFunctionData("balanceOf", [b.vault])),
  call("state-strategy-idle", b.asset, TOKEN.encodeFunctionData("balanceOf", [b.strategy])),
  call("state-locked", b.locker, LOCKER.encodeFunctionData("balances", [b.strategy])),
];
// Only production request-program rounds; no provider, private cache or scheduler.
export function dependentRound(d: Descriptor, initial: readonly AdapterRequestResult[], evidence: readonly unknown[], round: number, expected?: CanonicalSource) {
  const root = rootBinding(d.vault, initial, expected);
  if (round === 0) return bindRequestResultRound(requirements, strategyRequests(root.binding));
  const all = collectRequestProgramResults(initial, evidence), r1 = all.slice(initial.length, initial.length + strategyRequests(root.binding).length);
  const b = strategyBinding(root.binding, r1, root.source); assertBinding(d, b);
  if (round === 1) return bindRequestResultRound({ transports: ["get-code", "eth-call"] }, [...dependencyRequests(b), ...stateRequests(b)]);
  if (round !== 2) throw new Error("badger-sett unexpected state round");
  return null;
}
export function decodeState(d: Descriptor, initial: readonly AdapterRequestResult[], evidence: readonly unknown[], expected?: CanonicalSource): State {
  if (evidence.length !== 2) throw new Error("badger-sett incomplete state rounds");
  const root = rootBinding(d.vault, initial, expected), all = collectRequestProgramResults(initial, evidence);
  const end = initial.length + strategyRequests(root.binding).length;
  const b = strategyBinding(root.binding, all.slice(initial.length, end), root.source); assertBinding(d, b);
  const deps = dependencyRequests(b), tail = all.slice(end);
  proveDependencies(b, tail.slice(0, deps.length), root.source);
  const r = rows(tail.slice(deps.length), stateRequests(b), root.source);
  const vault = (n: string) => decode(VAULT, n, r.get("state-vault-" + n))[0];
  const strategy = (n: string) => decode(STRATEGY, n, r.get("state-strategy-" + n))[0];
  const supply = uint(vault("totalSupply")), vaultIdle = uint(decode(TOKEN, "balanceOf", r.get("state-vault-idle"))[0]);
  const strategyIdle = uint(decode(TOKEN, "balanceOf", r.get("state-strategy-idle"))[0]), locked = uint(decode(LOCKER, "balances", r.get("state-locked"))[0]);
  if (uint(strategyIdle + locked) !== strategy("balanceOf") || uint(vaultIdle + strategyIdle + locked) !== vault("balance"))
    throw new Error("badger-sett inconsistent backing");
  const feeBps = uint(vault("withdrawalFee")), deviationBps = uint(strategy("withdrawalMaxDeviationThreshold"));
  if (feeBps > 200n) throw new Error("badger-sett withdrawal fee exceeds verified source cap");
  return { source: r.source, binding: b, supply, vaultIdle, strategyIdle, locked, feeBps, deviationBps,
    treasury: ethers.getAddress(vault("treasury")).toLowerCase(), vaultPaused: vault("paused"),
    strategyPaused: strategy("paused"), safetyCheck: strategy("withdrawalSafetyCheck") };
}
export function assertActor(d: Binding, executor: string): string {
  const actor = address(executor);
  if ([d.vault, d.vaultImplementation, d.strategy, d.strategyImplementation, d.asset, d.locker, d.vaultAdmin, d.strategyAdmin].includes(actor))
    throw new Error("badger-sett executor aliases dependency or proxy admin");
  return actor;
}
export function withdraw(s: State, shares: bigint, executor?: string) {
  uint(shares);
  if (!shares || !s.supply || shares > s.supply) throw new Error("badger-sett shares exceed supply or zero input");
  if (s.vaultPaused) throw new Error("badger-sett vault paused");
  const backing = uint(uint(s.vaultIdle + s.strategyIdle) + s.locked);
  const gross = uint(backing * shares) / s.supply;
  const deficit = gross > s.vaultIdle ? gross - s.vaultIdle : 0n;
  if (deficit > 0n) {
    if (s.strategyPaused) throw new Error("badger-sett strategy paused for deficit");
    if (deficit > s.strategyIdle) throw new Error("badger-sett unsupported locker-unlock branch");
    // SafeMath multiplication happens even when the fully liquid check passes.
    if (s.safetyCheck && s.strategyIdle < uint(deficit * 9980n) / BPS) throw new Error("badger-sett safety check");
    // W>=deficit: deviation and balance-shortfall branches cannot execute.
  }
  const fee = s.feeBps === 0n ? 0n : uint(gross * s.feeBps) / BPS;
  const amountOut = uint(gross - fee), remainingSupply = s.supply - shares;
  let feeShares = 0n;
  if (fee > 0n) {
    const pool = uint(backing - gross);
    if (remainingSupply > 0n && pool === 0n) throw new Error("badger-sett fee share denominator zero");
    feeShares = remainingSupply === 0n ? fee : uint(fee * remainingSupply) / pool;
    if (feeShares > 0n && s.treasury === ethers.ZeroAddress) throw new Error("badger-sett fee mint to zero");
    if (feeShares > 0n && executor && s.treasury === address(executor)) throw new Error("badger-sett unsupported treasury executor alias");
  }
  const state: State = { ...s, supply: uint(remainingSupply + feeShares), vaultIdle: uint(s.vaultIdle + deficit - amountOut), strategyIdle: s.strategyIdle - deficit };
  return { amountOut, gross, fee, feeShares, state };
}
export function capacity(s: State): bigint {
  if (!s.supply || s.vaultPaused) return 0n;
  const backing = uint(s.vaultIdle + s.strategyIdle + s.locked);
  if (!backing) return 0n;
  const available = s.vaultIdle + (s.strategyPaused ? 0n : s.strategyIdle);
  // Largest q whose *floored* gross fits liquid backing, also SafeMath-safe.
  const liquidCap = ((available + 1n) * s.supply - 1n) / backing;
  return [s.supply, liquidCap, MAX / backing].reduce((a, b) => a < b ? a : b);
}
export { rootRequests, requirements, assertSource };
