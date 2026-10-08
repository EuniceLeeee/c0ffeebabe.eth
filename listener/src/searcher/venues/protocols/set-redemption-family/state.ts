import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { address, call, code, CONTROLLER, decode, MAX, members, MODULE, MODULE_CODE_HASH, rows, SET, SET_CODE_HASH, TOKEN, uint, WAD } from "./codec.js";
import type { Descriptor, State } from "./types.js";
export function stateRequests(d: Descriptor) {
  return [code("set-code", d.set), code("module-code", d.module), code("controller-code", d.controller),
    ...["controller", "getComponents", "getModules", "isLocked", "totalSupply", "positionMultiplier"].map(k => call(k, d.set, SET.encodeFunctionData(k))),
    call("module-controller", d.module, MODULE.encodeFunctionData("controller")), call("module-state", d.set, SET.encodeFunctionData("moduleStates", [d.module])),
    call("registered-set", d.controller, CONTROLLER.encodeFunctionData("isSet", [d.set])), call("registered-module", d.controller, CONTROLLER.encodeFunctionData("isModule", [d.module])),
    ...d.components.flatMap((t, i) => [call(`unit-${i}`, d.set, SET.encodeFunctionData("getDefaultPositionRealUnit", [t])),
      call(`external-${i}`, d.set, SET.encodeFunctionData("getExternalPositionModules", [t])), call(`balance-${i}`, t, TOKEN.encodeFunctionData("balanceOf", [d.set]))])];
}
export function decodeState(d: Descriptor, results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const r = rows(results, stateRequests(d).map(v => v.id), expected);
  if (ethers.keccak256(r.get("set-code")) !== SET_CODE_HASH || ethers.keccak256(r.get("module-code")) !== MODULE_CODE_HASH || ethers.keccak256(r.get("controller-code")) !== d.controllerCodeHash)
    throw new Error("set-redemption code binding changed; new Ready required");
  if (address(decode(SET, "controller", r.get("controller"))[0]) !== d.controller || address(decode(MODULE, "controller", r.get("module-controller"))[0]) !== d.controller)
    throw new Error("set-redemption controller binding changed; new Ready required");
  const components = members(decode(SET, "getComponents", r.get("getComponents"))[0]);
  if (components.length !== d.components.length || components.some((v, i) => v !== d.components[i])) throw new Error("set-redemption component membership changed; new Ready required");
  if (decode(SET, "isLocked", r.get("isLocked"))[0] || decode(SET, "moduleStates", r.get("module-state"))[0] !== 2n ||
    !decode(SET, "getModules", r.get("getModules"))[0].map(address).includes(d.module) ||
    !decode(CONTROLLER, "isSet", r.get("registered-set"))[0] || !decode(CONTROLLER, "isModule", r.get("registered-module"))[0] ||
    components.some((_, i) => decode(SET, "getExternalPositionModules", r.get(`external-${i}`))[0].length !== 0)) throw new Error("set-redemption currently ineligible");
  const multiplier = decode(SET, "positionMultiplier", r.get("positionMultiplier"))[0] as bigint;
  if (multiplier <= 0n) throw new Error("set-redemption nonpositive multiplier");
  return { source: r.source, multiplier, supply: uint(decode(SET, "totalSupply", r.get("totalSupply"))[0]),
    units: components.map((_, i) => uint(decode(SET, "getDefaultPositionRealUnit", r.get(`unit-${i}`))[0])),
    balances: components.map((_, i) => uint(decode(TOKEN, "balanceOf", r.get(`balance-${i}`))[0])) };
}
export function redemptionOutputs(s: State, amount: bigint): readonly bigint[] {
  uint(amount);
  if (amount > s.supply || s.units.length !== s.balances.length) throw new Error("set-redemption supply capacity exceeded");
  return s.units.map((unit, i) => {
    uint(unit); uint(s.balances[i]);
    const product = amount * unit;
    if (product > MAX) throw new Error("set-redemption preciseMul overflow");
    const out = product / WAD;
    if (out > s.balances[i]) throw new Error("set-redemption component balance capacity exceeded");
    return out;
  });
}
export function capacity(s: State): bigint {
  return s.units.reduce((q, unit, i) => {
    if (!unit) return q;
    // floor(q*u/WAD) <= balance, preserving the last valid raw unit.
    const balanceCap = ((s.balances[i] + 1n) * WAD - 1n) / unit, overflowCap = MAX / unit;
    return [q, balanceCap, overflowCap].reduce((a, b) => a < b ? a : b);
  }, s.supply);
}
