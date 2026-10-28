import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { siloEvmDependencySource } from "./recipient-evm-source.js";
import { ethers } from "ethers";
import { assertSiloRecipientEffects, originalSiloWithdrawal } from "./historical-recipient.js";
const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const actor = addr(10), receiver = addr(11), vault = addr(12), payout = addr(13);
const abi = new ethers.Interface([
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
  "event OnMetaWithdraw(address indexed owner,address indexed token,uint256 tokenAssets,uint256 shares)",
]);
const event = (name: string, values: unknown[]) => ({ address: vault, ...abi.encodeEventLog(abi.getEvent(name)!, values) });
function fixture(recipient = receiver): any {
  const accounts = [...new Set([actor, recipient])];
  return { tokenDeltas: [vault, payout].flatMap(token => accounts.map(account => ({ token, account,
    delta: token === vault ? (account === actor ? -100n : 0n) : (account === recipient ? 200n : 0n) }))),
    nativeDeltas: [{ account: actor, delta: 0n }], totalSupplyDeltas: [{ token: vault, delta: -100n }],
    logs: [event("Withdraw", [actor, recipient, actor, 300n, 100n]), event("OnMetaWithdraw", [recipient, payout, 200n, 100n])] };
}
test("Silo observer distinguishes burned shares, underlying assets and payout units", () => {
  for (const recipient of [actor, receiver]) {
    const actual = fixture(recipient); assertSiloRecipientEffects(actual, actor, recipient, vault, payout, 100n, 200n);
    assert.deepEqual(originalSiloWithdrawal({ logs: actual.logs }, vault, payout), { shares: 100n, assets: 300n, payout: 200n, receiver: recipient });
  }
});
for (const fault of ["debit", "receipt", "actor-old-output", "receiver-old-input", "native", "supply", "extra-delta",
  "withdraw-owner", "withdraw-recipient", "withdraw-shares", "meta-token", "meta-amount", "meta-recipient", "missing-event"] as const)
  test(`Silo independent receipt observer rejects ${fault}`, () => {
    const x = fixture();
    if (fault === "debit") x.tokenDeltas[0].delta += 1n;
    if (fault === "receipt") x.tokenDeltas[3].delta -= 1n;
    if (fault === "actor-old-output") x.tokenDeltas[2].delta -= 1n;
    if (fault === "receiver-old-input") x.tokenDeltas[1].delta -= 1n;
    if (fault === "native") x.nativeDeltas[0].delta = 1n;
    if (fault === "supply") x.totalSupplyDeltas[0].delta += 1n;
    if (fault === "extra-delta") x.tokenDeltas.push({ ...x.tokenDeltas[0] });
    if (fault === "withdraw-owner") x.logs[0] = event("Withdraw", [actor, receiver, receiver, 300n, 100n]);
    if (fault === "withdraw-recipient") x.logs[0] = event("Withdraw", [actor, actor, actor, 300n, 100n]);
    if (fault === "withdraw-shares") x.logs[0] = event("Withdraw", [actor, receiver, actor, 300n, 101n]);
    if (fault === "meta-token") x.logs[1] = event("OnMetaWithdraw", [receiver, vault, 200n, 100n]);
    if (fault === "meta-amount") x.logs[1] = event("OnMetaWithdraw", [receiver, payout, 201n, 100n]);
    if (fault === "meta-recipient") x.logs[1] = event("OnMetaWithdraw", [actor, payout, 200n, 100n]);
    if (fault === "missing-event") x.logs.pop();
    assert.throws(() => assertSiloRecipientEffects(x, actor, receiver, vault, payout, 100n, 200n));
  });
test("Original event anchor rejects conflicting, duplicate or removed share observations", () => {
  for (const fault of ["shares", "payout", "duplicate", "removed"] as const) {
    const { logs } = fixture();
    if (fault === "shares") logs[1] = event("OnMetaWithdraw", [receiver, payout, 200n, 101n]);
    if (fault === "payout") logs[1] = event("OnMetaWithdraw", [receiver, vault, 200n, 100n]);
    if (fault === "duplicate") logs.push(logs[0]);
    if (fault === "removed") logs[0].removed = true;
    assert.throws(() => originalSiloWithdrawal({ logs }, vault, payout));
  }
});

const sharedFixture = "test/CurvePlainRecipient.t.sol";
const sharedSource = readFileSync(new URL("../../../../../../../test/CurvePlainRecipient.t.sol", import.meta.url), "utf8");
test("Silo EVM dependency pin retains token and compiler header changes", () => {
  const pin = (s: string) => siloEvmDependencySource(sharedFixture, s);
  assert.notEqual(pin(sharedSource), pin(sharedSource.replace("balanceOf[msg.sender] -= amount", "balanceOf[msg.sender] -= amount + 1")));
  assert.notEqual(pin(sharedSource), pin(sharedSource.replace("pragma solidity ^0.8.24", "pragma solidity ^0.8.25")));
});
test("Silo EVM dependency pin excludes unrelated Curve test assertions only", () => {
  const changed = sharedSource.replace("uint256(109) + (k == 1 ? 200 : 0)", "109 + (k == 1 ? 200 : 0)");
  assert.notEqual(changed, sharedSource);
  assert.equal(siloEvmDependencySource(sharedFixture, changed), siloEvmDependencySource(sharedFixture, sharedSource));
  assert.equal(siloEvmDependencySource("test/SiloRecipient.t.sol", changed), changed);
});
test("Silo EVM dependency pin fails closed on ambiguous or changed contract boundaries", () => {
  for (const text of [sharedSource.replace("contract CurveRecipientToken {", "contract CurveRecipientToken is Other {"),
    sharedSource + "\ncontract CurveRecipientToken {", sharedSource + "\ncontract CurveRecipientPool {"])
    assert.throws(() => siloEvmDependencySource(sharedFixture, text));
});
