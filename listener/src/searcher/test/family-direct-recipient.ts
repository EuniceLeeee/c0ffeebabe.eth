// Synthetic emitted-program call/balance models. Historical recipient
// acceptance and actual EVM rollback are separate checks.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";
import { depositProgram } from "../venues/protocols/yieldbasis-lt-family/deposit.js";
import { withdrawRecipientProgram } from "../venues/protocols/yieldbasis-lt-family/execution.js";
import { standardRecipientProgram } from "../venues/protocols/erc4626-family/execution.js";
import { custodianProgram } from "../venues/protocols/erc4626-family/custodian-execution.js";
import { legacyIssueRuntime } from "../venues/protocols/set-redemption-family/issuance.js";
import { execution as setExecution } from "../venues/protocols/set-redemption-family/execution.js";
import { routes as setRoutes } from "../venues/protocols/set-redemption-family/routes.js";
import { instance as setInstance } from "../venues/protocols/set-redemption-family/instance.js";
import { FAMILY, LINEAGE, LEGACY_LINEAGE } from "../venues/protocols/set-redemption-family/manifest.js";
import type { Descriptor as SetDescriptor } from "../venues/protocols/set-redemption-family/types.js";

const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const actor = addr(101), recipient = addr(102), other = addr(103);
const s = { lt: addr(1), asset: addr(2), stablecoin: addr(3), cryptopool: addr(4), amm: addr(5) };
const abi = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function totalSupply() view returns(uint256)",
  "function deposit(uint256,uint256,uint256,address) returns(uint256)", "function withdraw(uint256,uint256,address) returns(uint256)",
  "function deposit(uint256,address) returns(uint256)", "function redeem(uint256,address,address) returns(uint256)",
  "function balances(uint256) view returns(uint256)", "function frxUSD() view returns(address)",
  "function asset() view returns(address)", "function custodianTkn() view returns(address)",
  "function minters(address) view returns(bool)", "function isPaused() view returns(bool)",
  "function isFrozen(address) view returns(bool)", "function mdwrComboView() view returns(uint256,uint256,uint256,uint256)",
  "function previewDeposit(uint256) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function getComponents() view returns(address[])", "function getUnits() view returns(uint256[])",
  "function getDefaultPositionRealUnit(address) view returns(int256)", "function naturalUnit() view returns(uint256)",
  "function getOwnerBalance(address,address) view returns(uint256)", "function transferProxy() view returns(address)",
  "function entryFee() view returns(uint256)", "function feeRecipient() view returns(address)",
  "function issue(address,uint256)", "function issueTo(address,address,uint256)",
  "function redeemAndWithdrawTo(address,address,uint256,uint256)",
  "function redeem(address,uint256,address)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const key = (a: string, b: string) => `${a.toLowerCase()}:${b.toLowerCase()}`;
const word = (n: bigint) => ethers.toBeHex(n, 32);
function model(input: string, output: string, amount = 37n) {
  const balances = new Map<string, bigint>([
    [key(input, actor), amount + 101n], [key(output, actor), 103n], [key(output, recipient), 107n],
    [key(s.stablecoin, actor), 109n],
  ]);
  const allowances = new Map<string, bigint>();
  const state = { native: 17n, supply: 10_000n };
  const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const add = (token: string, owner: string, delta: bigint) => {
    const n = get(token, owner) + delta; assert(n >= 0n); balances.set(key(token, owner), n);
  };
  const read = (call: RuntimeCall): string | undefined => {
    const q = abi.parseTransaction({ data: call.data })!;
    if (q.name === "balanceOf") return word(get(call.target, q.args[0]));
    if (q.name === "approve") { allowances.set(key(call.target, q.args[0]), q.args[1]); return word(1n); }
    if (q.name === "allowance") { assert(same(q.args[0], actor)); return word(allowances.get(key(call.target, q.args[1])) ?? 0n); }
    if (q.name === "totalSupply") return word(state.supply);
    return undefined;
  };
  return { balances, allowances, state, get, add, read, amount, nativeBalance: () => state.native };
}

for (const direction of ["deposit", "withdraw"] as const) {
  test(`YB ${direction} directs only fresh output to receiver and preserves caller inventories`, () => {
    for (const fault of ["none", "wrong-recipient", "short-output", "under-debit", "over-debit", "stable", "native"] as const) {
      if (direction === "withdraw" && fault === "stable") continue;
      const input = direction === "deposit" ? s.asset : s.lt, output = direction === "deposit" ? s.lt : s.asset;
      const m = model(input, output), shares = 71n;
      const program = direction === "deposit" ? depositProgram(s, actor, { recipient }) : withdrawRecipientProgram(s, actor, recipient);
      const run = () => inspectRuntime(ethers.hexlify(program.bytes()), m.amount, {
        nativeBalance: m.nativeBalance,
        call(call) {
          const read = m.read(call); if (read !== undefined) return read;
          const q = abi.parseTransaction({ data: call.data })!;
          if (q.name === "balances") return word(q.args[0] === 0n ? 100n : 10n);
          assert.equal(q.name, direction); assert(same(call.target, s.lt));
          const to = String(q.args[direction === "deposit" ? 3 : 2]); assert(same(to, recipient));
          assert.equal(q.args[0], m.amount);
          if (direction === "deposit") assert.equal(q.args[1], 370n);
          m.add(input, actor, -(m.amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n)));
          m.add(output, fault === "wrong-recipient" ? actor : to, shares - (fault === "short-output" ? 1n : 0n));
          if (fault === "stable") m.add(s.stablecoin, actor, -1n);
          if (fault === "native") m.state.native--;
          return word(shares);
        },
      });
      if (fault !== "none") assert.throws(run);
      else {
        run(); assert.equal(m.get(input, actor), 101n); assert.equal(m.get(output, actor), 103n);
        assert.equal(m.get(output, recipient), 107n + shares); assert.equal(m.state.native, 17n);
      }
    }
  });
}

for (const variant of ["standard", "custodian"] as const) for (const direction of ["deposit", "redeem"] as const) {
  test(`${variant} ${direction} keeps owner/spender at executor and measures chosen recipient`, () => {
    const d = { vault: addr(20), share: variant === "standard" ? addr(20) : addr(21), asset: addr(22) };
    for (const fault of ["none", "wrong-recipient", "short-output", "under-debit", "over-debit", "frozen"] as const) {
      const input = direction === "deposit" ? d.asset : d.share, output = direction === "deposit" ? d.share : d.asset;
      const m = model(input, output), amountOut = 71n, frozenReads: string[] = [];
      const p = variant === "standard" ? standardRecipientProgram(d, actor, direction, recipient) : custodianProgram(d, actor, direction, 1n, recipient);
      const run = () => inspectRuntime(ethers.hexlify(p.bytes()), m.amount, {
        nativeBalance: m.nativeBalance,
        allowance(grant) { assert(same(grant.token, d.asset)); assert(same(grant.spender, d.vault)); assert.equal(grant.minimum, m.amount); },
        call(call) {
          const read = m.read(call); if (read !== undefined) return read;
          const q = abi.parseTransaction({ data: call.data })!;
          if (q.name === "frxUSD") return word(BigInt(d.share));
          if (q.name === "asset" || q.name === "custodianTkn") return word(BigInt(d.asset));
          if (q.name === "minters") { assert(same(q.args[0], d.vault)); return word(1n); }
          if (q.name === "isPaused") return word(0n);
          if (q.name === "isFrozen") { frozenReads.push(String(q.args[0])); return word(fault === "frozen" && same(q.args[0], recipient) ? 1n : 0n); }
          if (q.name === "mdwrComboView") return abi.encodeFunctionResult(q.fragment, [1000n, 1000n, 1000n, 1000n]);
          if (q.name === "previewDeposit" || q.name === "previewRedeem") { assert.equal(q.args[0], m.amount); return word(amountOut); }
          assert.equal(q.name, direction); assert(same(call.target, d.vault));
          assert.equal(q.args[0], m.amount); assert(same(q.args[1], recipient));
          if (direction === "redeem") assert(same(q.args[2], actor), "owner stays payer, not receiver");
          m.add(input, actor, -(m.amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n)));
          m.add(output, fault === "wrong-recipient" ? actor : recipient, amountOut - (fault === "short-output" ? 1n : 0n));
          m.state.supply += direction === "deposit" ? amountOut : -m.amount;
          return word(amountOut);
        },
      });
      if (fault !== "none" && !(variant === "standard" && fault === "frozen")) assert.throws(run);
      else {
        run(); assert.equal(m.get(input, actor), 101n); assert.equal(m.get(output, actor), 103n);
        assert.equal(m.get(output, recipient), 107n + amountOut);
        if (variant === "custodian") {
          assert(frozenReads.some(a => same(a, recipient))); assert.equal(m.allowances.get(key(input, d.vault)), 0n);
        }
      }
    }
  });
}

function setDescriptor(legacy: boolean, count = 1): SetDescriptor {
  const binding = { set: addr(30), module: addr(31), controller: addr(32), controllerCodeHash: ethers.ZeroHash,
    components: Array.from({ length: count }, (_, i) => addr(40 + i)),
    ...(legacy ? { legacy: { kind: "set-token" as const, setCodeHash: ethers.ZeroHash, factory: addr(33), factoryCodeHash: ethers.ZeroHash,
      vault: addr(34), issuance: { transferProxy: addr(35), codeHash: ethers.ZeroHash } } } : {}) };
  return setInstance.compileDraft({ familyId: FAMILY, lineageId: legacy ? LEGACY_LINEAGE : LINEAGE,
    subject: binding.set, provenance: [], binding });
}
for (const legacy of [true, false]) test(`Set ${legacy ? "Core" : "Basic"} unary redemption sends component to recipient and burns caller`, () => {
  const d = setDescriptor(legacy), route = setRoutes.project({ descriptor: d })[0];
  const request = { kind: "direct-output" as const, recipient };
  const leg = setExecution.buildRuntimeLeg!({ descriptor: d, route, executor: actor, runtimeEvidence: [], settlement: request } as any)!;
  assert.equal(leg.settlement?.directOutput, true); assert.deepEqual(leg.settlementRequest, request);
  for (const fault of ["none", "wrong-recipient", "short-output", "under-debit"] as const) {
    const amount = 100n, out = 200n, m = model(d.set, d.components[0], amount);
    const run = () => inspectRuntime(leg.program, amount, { call(call) {
      const read = m.read(call); if (read !== undefined) return read;
      const q = abi.parseTransaction({ data: call.data })!;
      if (q.name === "getComponents") return abi.encodeFunctionResult(q.fragment, [[d.components[0]]]);
      if (q.name === "getUnits") return abi.encodeFunctionResult(q.fragment, [[2n]]);
      if (q.name === "naturalUnit") return word(1n);
      if (q.name === "getDefaultPositionRealUnit") return word(2n * 10n ** 18n);
      assert.equal(q.name, legacy ? "redeemAndWithdrawTo" : "redeem"); assert(same(q.args[0], d.set));
      const to = q.args[legacy ? 1 : 2]; assert(same(to, recipient)); assert.equal(q.args[legacy ? 2 : 1], amount);
      m.add(d.set, actor, -(amount - (fault === "under-debit" ? 1n : 0n)));
      m.add(d.components[0], fault === "wrong-recipient" ? actor : to, out - (fault === "short-output" ? 1n : 0n));
      return "0x";
    } });
    if (fault !== "none") assert.throws(run);
    else { run(); assert.equal(m.get(d.set, actor), 101n); assert.equal(m.get(d.components[0], actor), 103n); assert.equal(m.get(d.components[0], recipient), 307n); }
  }
  const basket = setDescriptor(legacy, 2), basketRoute = setRoutes.project({ descriptor: basket })[0];
  assert.equal(setExecution.buildRuntimeLeg!({ descriptor: basket, route: basketRoute, executor: actor, runtimeEvidence: [], settlement: request } as any), null);
  const defaultLeg = setExecution.buildRuntimeLeg!({ descriptor: basket, route: basketRoute, executor: actor, runtimeEvidence: [] } as any)!;
  assert.equal(defaultLeg.settlement?.directOutput, undefined, "multi-asset default stays available without a direct-output declaration");
});

test("Set unary issueTo uses caller component/Vault credit; recipient fee identity controls its net minimum", () => {
  for (const feeRecipient of [actor, recipient, other]) for (const short of [false, true]) {
    const base = setDescriptor(true), d = { ...base, legacy: { ...base.legacy!, kind: "rebalancing-v3" as const } };
    const amount = 100n, fee = 10n, received = same(feeRecipient, recipient) ? amount : amount - fee;
    const m = model(d.components[0], d.set, amount), p = legacyIssueRuntime(d, actor, undefined, recipient);
    const run = () => inspectRuntime(ethers.hexlify(p.bytes()), amount, { call(call) {
      const read = m.read(call); if (read !== undefined) return read;
      const q = abi.parseTransaction({ data: call.data })!;
      if (q.name === "getComponents") return abi.encodeFunctionResult(q.fragment, [d.components]);
      if (q.name === "getUnits") return abi.encodeFunctionResult(q.fragment, [[1n]]);
      if (q.name === "naturalUnit") return word(1n);
      if (q.name === "transferProxy") return word(BigInt(d.legacy.issuance!.transferProxy));
      if (q.name === "getOwnerBalance") { assert(same(q.args[0], d.components[0]) && same(q.args[1], actor)); return word(0n); }
      if (q.name === "entryFee") return word(10n ** 17n);
      if (q.name === "feeRecipient") return word(BigInt(feeRecipient));
      assert.equal(q.name, "issueTo"); assert(same(q.args[0], recipient) && same(q.args[1], d.set)); assert.equal(q.args[2], amount);
      m.add(d.components[0], actor, -amount); m.add(d.set, recipient, received - (short ? 1n : 0n));
      if (same(feeRecipient, actor)) m.add(d.set, actor, fee);
      return "0x";
    } });
    if (short) assert.throws(run); else {
      run(); assert.equal(m.get(d.components[0], actor), 101n); assert.equal(m.get(d.set, recipient), 107n + received);
      assert.equal(m.allowances.get(key(d.components[0], d.legacy.issuance!.transferProxy)), 0n);
    }
  }
});

// Ordinary swap recipient controls are kept separate from protocol models.
import "./family-direct-recipient-swaps.js";
