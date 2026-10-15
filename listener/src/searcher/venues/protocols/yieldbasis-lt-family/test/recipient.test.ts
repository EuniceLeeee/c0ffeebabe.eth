import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/yieldbasis-lt.production.js";
import { descriptor, answerFor, SOURCE, EXECUTOR, FOREIGN } from "./fixtures.js";
import { assertRecipientEffects } from "./recipient-observations.js";
import { referenceMintAmount, verifyExecutorSources } from "./historical-dual.js";
import { LT_INTERFACE } from "../abi.js";
const d = descriptor(answerFor({ deposit: true }));
const routes = plugin.routes.project({ descriptor: d });
const baseline = JSON.parse(readFileSync(new URL("./recipient-default-bytes.json", import.meta.url), "utf8"));
const event = (name: string, values: unknown[]) => ({ address: d.lt, ...LT_INTERFACE.encodeEventLog(LT_INTERFACE.getEvent(name)!, values) });
const erc = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const transfer = (address: string, from: string, to: string, amount: bigint) => ({ address, ...erc.encodeEventLog(erc.getEvent("Transfer")!, [from, to, amount]) });
function effects(direction: "deposit" | "withdraw", recipient = FOREIGN): any {
  const input = direction === "deposit" ? d.asset : d.share, output = direction === "deposit" ? d.share : d.asset;
  const accounts = [...new Set([EXECUTOR, recipient])];
  return { tokenDeltas: [d.asset, d.share, d.stablecoin].flatMap(token => accounts.map(account => ({ token, account,
    delta: token === input && account === EXECUTOR ? -100n : token === output && account === recipient ? 200n : 0n }))),
    nativeDeltas: [{ account: EXECUTOR, delta: 0n }], logs: direction === "deposit" ? [event("Deposit", [EXECUTOR, recipient, 100n, 200n]),
      transfer(d.asset, EXECUTOR, d.lt, 100n), transfer(d.share, ethers.ZeroAddress, recipient, 200n)] : [
      event("Withdraw", [EXECUTOR, recipient, EXECUTOR, 200n, 100n]), transfer(d.share, EXECUTOR, ethers.ZeroAddress, 100n), transfer(d.asset, d.lt, recipient, 200n)] };
}
for (const route of routes) test(`${route.direction} keeps default and quoted bytes; direct construction is amount/quote free`, () => {
  const input = { descriptor: d, route, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] };
  const leg = plugin.execution.buildRuntimeLeg!(input)!; assert.equal(leg.program, baseline[route.direction].runtime);
  const action = plugin.actionAdapters.find(a => a.id === route.adapterId)!;
  assert.equal(ethers.hexlify(action.encode({ adapterId: route.adapterId, target: d.lt, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
    amount: 100n, params: route.direction === "deposit" ? { stablecoin: d.stablecoin, cryptopool: d.cryptopool, amm: d.amm, minSharesOut: 1n } : { minAssetsOut: 1n }, children: [] }, EXECUTOR, new Uint8Array())), baseline[route.direction].quoted100);
  for (const recipient of [EXECUTOR, FOREIGN]) {
    const buildInput = { ...input, settlement: { kind: "direct-output" as const, recipient } };
    for (const k of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
      Object.defineProperty(buildInput, k, { get() { throw Error("runtime read " + k); } });
    const direct = plugin.execution.buildRuntimeLeg!(buildInput)!; assert(direct); assert.equal(direct.settlement?.directOutput, true);
    assert.deepEqual(direct.settlementRequest, buildInput.settlement);
  }
  for (const recipient of [ethers.ZeroAddress, d.lt, d.asset, d.stablecoin, d.cryptopool, d.amm, d.staker])
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "direct-output", recipient } }));
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, executor: d.staker, settlement: { kind: "direct-output", recipient: FOREIGN } }));
  for (const kind of ["quote-output", "deferred-input"]) assert.equal(plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind } as never }), null);
});
for (const direction of ["deposit", "withdraw"] as const) {
  test(`${direction} receipt observer handles self and external aliases`, () => {
    for (const recipient of [EXECUTOR, FOREIGN]) assertRecipientEffects(effects(direction, recipient), direction, EXECUTOR, recipient, d.asset, d.share, d.stablecoin, 100n, 200n);
  });
  for (const fault of ["input", "output", "actor-old-output", "receiver-old-input", "actor-stable", "receiver-stable", "native", "event", "transfer", "extra"])
    test(`${direction} independent observer rejects ${fault}`, () => {
      const x = effects(direction), input = direction === "deposit" ? d.asset : d.share, output = direction === "deposit" ? d.share : d.asset;
      const change = (token: string, account: string) => { x.tokenDeltas.find((r: any) => r.token === token && r.account === account).delta += 1n; };
      if (fault === "input") change(input, EXECUTOR); if (fault === "output") change(output, FOREIGN);
      if (fault === "actor-old-output") change(output, EXECUTOR); if (fault === "receiver-old-input") change(input, FOREIGN);
      if (fault === "actor-stable") change(d.stablecoin, EXECUTOR); if (fault === "receiver-stable") change(d.stablecoin, FOREIGN);
      if (fault === "native") x.nativeDeltas[0].delta = 1n;
      if (fault === "event") x.logs.shift(); if (fault === "transfer") x.logs.pop(); if (fault === "extra") x.tokenDeltas.push(x.tokenDeltas[0]);
      assert.throws(() => assertRecipientEffects(x, direction, EXECUTOR, FOREIGN, d.asset, d.share, d.stablecoin, 100n, 200n));
    });
}
test("direct-only reverse reference derives equal actual chosen mint receipts", () => {
  const sample = { status: "pass", tokenIn: d.asset, tokenOut: d.share, label: "spliced-production-input-at-N", executions:
    ["direct-self", "direct-external"].flatMap(encoding => ["input-only", "old-inventory"].map(mode => ({ encoding, mode, status: "pass",
      effects: effects("deposit", encoding === "direct-self" ? EXECUTOR : FOREIGN) }))) };
  // This historical helper binds the actual CLI executor, not fixtures.EXECUTOR.
  assert.throws(() => referenceMintAmount(sample, d.asset, d.share, FOREIGN));
  for (const execution of sample.executions) for (const row of execution.effects.tokenDeltas)
    if (row.account === EXECUTOR) row.account = "0x1000000000000000000000000000000000000002";
  assert.equal(referenceMintAmount(sample, d.asset, d.share, FOREIGN), 200n);
  sample.executions[3]!.effects.tokenDeltas.find((r: any) => r.token === d.share && r.account === FOREIGN).delta++;
  assert.throws(() => referenceMintAmount(sample, d.asset, d.share, FOREIGN));
});
test("historical executor artifact rejects missing or stale Solidity source bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "yb-executor-proof-")), source = join(root, "src/BotVM.sol"), artifact = join(root, "BotVM.json");
  try {
    mkdirSync(join(root, "src")); const contents = "pragma solidity ^0.8.0; contract BotVM {}";
    writeFileSync(source, contents);
    const metadata = { settings: { compilationTarget: { "src/BotVM.sol": "BotVM" } }, sources: { "src/BotVM.sol": { keccak256: ethers.keccak256(ethers.toUtf8Bytes(contents)) } } };
    const save = () => writeFileSync(artifact, JSON.stringify({ metadata: JSON.stringify(metadata) })); save();
    const bound = verifyExecutorSources(root, artifact); assert.equal(bound.sources.length, 1);
    writeFileSync(source, contents + "\n"); assert.throws(() => verifyExecutorSources(root, artifact)); writeFileSync(source, contents);
    metadata.settings.compilationTarget["src/BotVM.sol"] = "Other"; save(); assert.throws(() => verifyExecutorSources(root, artifact));
    metadata.settings.compilationTarget["src/BotVM.sol"] = "BotVM"; metadata.sources = {} as typeof metadata.sources; save();
    assert.throws(() => verifyExecutorSources(root, artifact));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
