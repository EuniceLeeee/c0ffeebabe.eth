import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertInfiniFiRecipientEffects } from "./infinifi-historical-dual.js";
import { ERC4626_INTERFACE } from "../abi.js";
import { INFINIFI_GATEWAY } from "../infinifi.js";
import type { ObservedEffects } from "../../../adapter-request-program.js";
const actor = "0x1000000000000000000000000000000000000002";
const receiver = "0x1000000000000000000000000000000000000001";
const vault = "0xdbdc1ef57537e34680b898e1febd3d68c7389bcb", asset = "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c";
const amount = 97n, output = 89n;
function sample(deposit: boolean, external: boolean) {
  const recipient = external ? receiver : actor, input = deposit ? asset : vault, out = deposit ? vault : asset;
  const accounts = external ? [actor, recipient, INFINIFI_GATEWAY] : [actor, INFINIFI_GATEWAY];
  const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!,
    deposit ? [INFINIFI_GATEWAY, recipient, amount, output] : [INFINIFI_GATEWAY, recipient, INFINIFI_GATEWAY, output, amount]);
  const effects: any = { tokenDeltas: [input, out].flatMap(token => accounts.map(account => ({ token, account,
    delta: token === input ? account === actor ? -amount : 0n : account === recipient ? output : 0n }))),
    nativeDeltas: [{ account: actor, delta: 0n }], totalSupplyDeltas: [{ token: vault, delta: deposit ? output : -amount }],
    logs: [{ address: vault, ...event }] };
  return { effects, check: (e: ObservedEffects) => assertInfiniFiRecipientEffects(e, actor, recipient, input, out, amount, output) };
}
for (const deposit of [true, false]) for (const external of [true, false])
  test(`recipient observations ${deposit ? "stake" : "unstake"} ${external ? "external" : "self"}`, () => {
    const { effects, check } = sample(deposit, external); check(effects);
  });
const mutations: [string, (e: any) => void][] = [
  ["short receipt", e => { e.tokenDeltas[4].delta--; }],
  ["zero debit", e => { e.tokenDeltas[0].delta = 0n; }],
  ["excess debit", e => { e.tokenDeltas[0].delta--; }],
  ["receiver input changed", e => { e.tokenDeltas[1].delta = -1n; }],
  ["executor old output changed", e => { e.tokenDeltas[3].delta = -1n; }],
  ["Gateway residual", e => { e.tokenDeltas[2].delta = 1n; }],
  ["missing effect", e => { e.tokenDeltas.pop(); }],
  ["duplicate effect", e => { e.tokenDeltas.push(e.tokenDeltas[0]); }],
  ["native changed", e => { e.nativeDeltas[0].delta = -1n; }],
  ["supply changed", e => { e.totalSupplyDeltas[0].delta++; }],
  ["wrong supply target", e => { e.totalSupplyDeltas[0].token = asset; }],
  ["missing vault event", e => { e.logs = []; }],
  ["wrong event receiver", e => { e.logs[0] = { address: vault, ...ERC4626_INTERFACE.encodeEventLog(
    ERC4626_INTERFACE.getEvent("Deposit")!, [INFINIFI_GATEWAY, actor, amount, output]) }; }],
];
for (const [name, mutate] of mutations) test(`recipient observations reject ${name}`, () => {
  const { effects, check } = sample(true, true); mutate(effects); assert.throws(() => check(effects));
});
