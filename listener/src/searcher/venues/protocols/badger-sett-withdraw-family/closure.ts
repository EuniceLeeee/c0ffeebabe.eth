import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { address, call, code, decode, prove, rows, storage, storageAddress, ADMIN_SLOT, IMPLEMENTATION_SLOT, VAULT, STRATEGY, TOKEN, LOCKER } from "./codec.js";
import type { Binding, RootBinding } from "./types.js";
export const requirements = { transports: ["get-code", "get-storage", "eth-call"] as const };
export const rootRequests = (vault: string) => [
  code("vault-code", vault), storage("vault-impl", vault, IMPLEMENTATION_SLOT), storage("vault-admin", vault, ADMIN_SLOT),
  call("vault-token", vault, VAULT.encodeFunctionData("token")), call("vault-strategy", vault, VAULT.encodeFunctionData("strategy")),
];
export function rootBinding(vault: string, results: readonly AdapterRequestResult[], expected?: CanonicalSource) {
  const r = rows(results, rootRequests(vault), expected); prove(r.get("vault-code"), "proxy");
  return { source: r.source, binding: { vault: address(vault), vaultImplementation: storageAddress(r.get("vault-impl")),
    vaultAdmin: storageAddress(r.get("vault-admin")), asset: address(decode(VAULT, "token", r.get("vault-token"))[0]),
    strategy: address(decode(VAULT, "strategy", r.get("vault-strategy"))[0]) } };
}
export const strategyRequests = (b: RootBinding) => [
  code("vault-implementation-code", b.vaultImplementation), code("strategy-code", b.strategy),
  storage("strategy-impl", b.strategy, IMPLEMENTATION_SLOT), storage("strategy-admin", b.strategy, ADMIN_SLOT),
  ...["vault", "want", "LOCKER"].map(name => call("strategy-" + name, b.strategy, STRATEGY.encodeFunctionData(name))),
];
export function strategyBinding(b: RootBinding, results: readonly AdapterRequestResult[], source: CanonicalSource): Binding {
  const r = rows(results, strategyRequests(b), source);
  prove(r.get("vault-implementation-code"), "vault"); prove(r.get("strategy-code"), "proxy");
  if (address(decode(STRATEGY, "vault", r.get("strategy-vault"))[0]) !== b.vault ||
      address(decode(STRATEGY, "want", r.get("strategy-want"))[0]) !== b.asset) throw new Error("badger-sett reciprocal strategy binding");
  const result = { ...b, strategyImplementation: storageAddress(r.get("strategy-impl")), strategyAdmin: storageAddress(r.get("strategy-admin")),
    locker: address(decode(STRATEGY, "LOCKER", r.get("strategy-LOCKER"))[0]) };
  const contracts = [result.vault, result.vaultImplementation, result.strategy, result.strategyImplementation, result.asset, result.locker];
  if (new Set(contracts).size !== contracts.length || result.strategyAdmin === result.vault) throw new Error("badger-sett dependency/admin alias");
  return result;
}
export const dependencyRequests = (b: Binding) => [
  code("strategy-implementation-code", b.strategyImplementation), code("asset-code", b.asset), code("locker-code", b.locker),
  call("locker-token", b.locker, LOCKER.encodeFunctionData("stakingToken")),
  call("asset-decimals", b.asset, TOKEN.encodeFunctionData("decimals")), call("vault-decimals", b.vault, VAULT.encodeFunctionData("decimals")),
];
export function proveDependencies(b: Binding, results: readonly AdapterRequestResult[], source: CanonicalSource): void {
  const r = rows(results, dependencyRequests(b), source);
  prove(r.get("strategy-implementation-code"), "strategy"); prove(r.get("asset-code"), "asset"); prove(r.get("locker-code"), "locker");
  if (address(decode(LOCKER, "stakingToken", r.get("locker-token"))[0]) !== b.asset ||
      decode(TOKEN, "decimals", r.get("asset-decimals"))[0] !== 18n || decode(VAULT, "decimals", r.get("vault-decimals"))[0] !== 18n)
    throw new Error("badger-sett asset/locker/decimals binding");
}
