import assert from "node:assert/strict";
import { ethers } from "ethers";
import sample from "./public-sample.json";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { CONTROLLER, MODULE, SET, TOKEN, address } from "../codec.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
export const set = sample.set, module = sample.module, controller = sample.controller;
export const actor = "0x1000000000000000000000000000000000000099";
export const components = [1, 2, 3, 4].map(n => ethers.toBeHex(n, 20));
export const source = (n = 100): CanonicalSource => ({ number: n, hash: ethers.toBeHex(n, 32), generation: n });
export interface Fixture {
  components: string[]; units: bigint[]; balances: bigint[]; supply: bigint; multiplier: bigint;
  setController: string; moduleController: string; enabled: boolean; registered: boolean; initialized: boolean;
  locked: boolean; external: boolean; failure?: boolean; setAddress: string; moduleAddress: string;
}
export function state(): Fixture { return { components: [...components], units: [1624n, 38706n, 52n, 1698n].map(n => n * 10n ** 16n),
  balances: [10n ** 25n, 10n ** 25n, 10n ** 25n, 10n ** 25n], supply: 585655694651706800n, multiplier: 10n ** 18n,
  setController: controller, moduleController: controller, enabled: true, registered: true, initialized: true, locked: false, external: false,
  setAddress: set, moduleAddress: module }; }
export function fixtureProvider(s: Fixture, at: CanonicalSource, reads: string[] = []) {
  return {
    async getStorage(_a: string, _slot: string, _block?: number): Promise<string> { throw new Error("unexpected fixture storage read"); },
    async getCode(a: string, block?: number) { assert.equal(block, at.number); reads.push("code:" + address(a));
      return address(a) === s.setAddress ? sample.setRuntime : address(a) === s.moduleAddress ? sample.moduleRuntime : "0x6000"; },
    async call(req: { to: string; data: string }, block?: number) {
      assert.equal(block, at.number); const a = address(req.to); reads.push(a);
      if (s.failure) throw new Error("fixture state unavailable");
      const abi = a === s.setAddress ? SET : a === s.moduleAddress ? MODULE : a === controller ? CONTROLLER : TOKEN;
      const p = abi.parseTransaction({ data: req.data }); assert(p, "unexpected fixture request");
      let value: unknown;
      switch (p.name) {
        case "controller": value = a === s.setAddress ? s.setController : s.moduleController; break;
        case "getModules": value = s.initialized ? [s.moduleAddress] : []; break;
        case "moduleStates": value = s.initialized ? 2n : 0n; break;
        case "getComponents": value = s.components; break;
        case "isLocked": value = s.locked; break;
        case "totalSupply": value = s.supply; break;
        case "positionMultiplier": value = s.multiplier; break;
        case "getExternalPositionModules": value = s.external ? [s.moduleAddress] : []; break;
        case "getDefaultPositionRealUnit": value = s.units[s.components.indexOf(address(p.args[0]))] * s.multiplier / 10n ** 18n; break;
        case "isSet": value = s.registered && address(p.args[0]) === s.setAddress; break;
        case "isModule": value = s.enabled && address(p.args[0]) === s.moduleAddress; break;
        case "decimals": value = 18n; break;
        case "balanceOf": assert.equal(address(p.args[0]), s.setAddress); value = s.balances[s.components.indexOf(a)]; break;
        default: throw new Error("unexpected fixture getter " + p.name);
      }
      return abi.encodeFunctionResult(p.name, [value]);
    },
  };
}
export function runtime(s: Fixture, at: CanonicalSource, reads: string[] = []) {
  return createStrictCentralAdapterRuntime({ executor: actor, generationFence: { assertCurrent(g, current) { assert.equal(g, at.generation); assert.deepEqual(current, at); } },
    provider: fixtureProvider(s, at, reads) });
}
