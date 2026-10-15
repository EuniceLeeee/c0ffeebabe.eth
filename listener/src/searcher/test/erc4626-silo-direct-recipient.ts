// Production Family-emitted program interpreted against synthetic call/balance
// models. This does not establish historical identity or EVM rollback.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { erc4626SiloRedeemExecution as execution } from "../venues/protocols/erc4626-silo-redeem-family/execution.js";
import { erc4626SiloRedeemInstance as instance } from "../venues/protocols/erc4626-silo-redeem-family/instance.js";
import { erc4626SiloRedeemRoutes as routes } from "../venues/protocols/erc4626-silo-redeem-family/routes.js";
import { ERC4626_SILO_INTERFACE as silo } from "../venues/protocols/erc4626-silo-redeem-family/shared.js";
import { RUNTIME_ERC20 } from "../venues/runtime-execution.js";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
const address = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const actor = address(101), receiver = address(102), vault = address(1), payoutToken = address(2), underlyingAsset = address(3);
const d = instance.compileDraft({ vault, payoutToken, underlyingAsset, provenance: [] } as any);
const r = routes.project({ descriptor: d })[0];
const key = (token: string, owner: string) => token.toLowerCase() + ':' + owner.toLowerCase();
const word = (n: bigint) => ethers.toBeHex(n, 32);
function build(recipient?: string, kind = "direct-output") {
  const input: any = { descriptor: d, route: r, executor: actor, runtimeEvidence: [],
    ...(recipient === undefined ? {} : { settlement: { kind, recipient } }) };
  for (const name of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
    Object.defineProperty(input, name, { get() { throw new Error("runtime read external " + name); } });
  return execution.buildRuntimeLeg(input);
}
for (const recipient of [actor, receiver]) test(`Silo direct receiver ${recipient === actor ? "self" : "external"} preserves inventories`, () => {
  for (const amount of [1n, 91n, 10n ** 18n]) {
    const leg = build(recipient)!;
    assert.equal(leg.settlement?.directOutput, true);
    assert.deepEqual(leg.settlementRequest, { kind: "direct-output", recipient });
    const balances = new Map([[key(vault, actor), amount + 101n], [key(payoutToken, actor), 103n],
      [key(vault, receiver), 107n], [key(payoutToken, receiver), 109n]]);
    const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
    const put = (token: string, owner: string, delta: bigint) => balances.set(key(token, owner), get(token, owner) + delta);
    let supply = amount + 1000n;
    const before = get(payoutToken, recipient), out = amount + 7n;
    inspectRuntime(leg.program, amount, { nativeBalance: () => 37n, call(call) {
      const q = RUNTIME_ERC20.parseTransaction({ data: call.data }) ?? silo.parseTransaction({ data: call.data })!;
      if (q.name === "balanceOf") { assert(call.static); return word(get(call.target, q.args[0])); }
      if (q.name === "totalSupply") { assert(call.static); return word(supply); }
      assert.equal(q.name, "redeem");assert.equal(call.target.toLowerCase(), vault.toLowerCase());
      assert.equal(q.args[0], payoutToken);assert.equal(q.args[1], amount);assert.equal(q.args[2], recipient);assert.equal(q.args[3], actor);
      put(vault, actor, -amount);put(payoutToken, recipient, out);supply -= amount;return word(out);
    }});
    assert.equal(get(vault, actor), 101n);assert.equal(get(payoutToken, recipient), before + out);
    assert.equal(get(vault, receiver), 107n);assert.equal(supply, 1000n);
    if (recipient !== actor) assert.equal(get(payoutToken, actor), 103n);
  }
});
test("Silo direct rejects zero/under/over debit, false receipt, supply change and inventory loss", () => {
  for (const fault of ["zero-input", "insufficient", "zero-debit", "under-debit", "over-debit", "zero-output", "short-output", "false-return", "wrong-recipient", "supply", "old-output", "receiver-input", "native"] as const) {
    const amount = fault === "zero-input" ? 0n : 91n, out = 71n;
    const balances = new Map([[key(vault, actor), fault === "insufficient" ? 90n : 192n], [key(payoutToken, actor), 103n],
      [key(vault, receiver), 107n], [key(payoutToken, receiver), 109n]]);
    const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
    const put = (token: string, owner: string, delta: bigint) => balances.set(key(token, owner), get(token, owner) + delta);
    let supply = 1000n, native = 37n;
    const leg = build(receiver)!;
    assert.throws(() => inspectRuntime(leg.program, amount, { nativeBalance: () => native, call(call) {
      const q = RUNTIME_ERC20.parseTransaction({ data: call.data }) ?? silo.parseTransaction({ data: call.data })!;
      if (q.name === "balanceOf") return word(get(call.target, q.args[0]));
      if (q.name === "totalSupply") return word(supply);
      assert.equal(q.name, "redeem");
      const spent = fault === "zero-debit" ? 0n : amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
      const received = fault === "zero-output" ? 0n : out - (fault === "short-output" ? 1n : 0n);
      put(vault, actor, -spent);put(payoutToken, fault === "wrong-recipient" ? actor : receiver, received);
      supply -= amount - (fault === "supply" ? 1n : 0n);
      if (fault === "old-output") put(payoutToken, actor, -1n);
      if (fault === "receiver-input") put(vault, receiver, -1n);
      if (fault === "native") native--;
      return word(fault === "zero-output" ? 0n : out + (fault === "false-return" ? 1n : 0n));
    }}), fault);
  }
});
test("Silo rejects unavailable settlement modes/reserved recipients and retains default bytes", () => {
  assert.equal(build(receiver, "quote-output"), null);assert.equal(build(receiver, "deferred-input"), null);
  for (const recipient of [ethers.ZeroAddress, vault, payoutToken, underlyingAsset]) assert.throws(() => build(recipient));
  const old = new RuntimeAmountProgram().call(vault,
    new ethers.Interface(["function redeem(address,uint256,address,address)"]).encodeFunctionData("redeem", [payoutToken, 0n, actor, actor]),
    { patches: [{ offset: 36, reg: 0 }] });
  assert.equal(build()!.program, ethers.hexlify(old.bytes()));
  assert.equal(build()!.settlement?.directOutput, true, "default probe advertises the implemented direct mode");
});
