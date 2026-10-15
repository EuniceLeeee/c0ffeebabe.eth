import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/dodo-v2.production.js";
import { DODO_V2_EVENT_INTERFACE } from "../../dodo-v2-abi.js";
import { fixture, ACTOR, RECEIVER, SOURCE, addr } from "./recipient-fixture.js";
import { assertRecipientEffects } from "./recipient-observations.js";
import { readyReuseScope } from "./historical-ready.js";
import { verifyExecutorSources } from "./historical-dual.js";
const token = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const d = fixture();
for (const route of plugin.routes.project({ descriptor: d })) test(`${route.direction} direct uses full runtime input and rejects invalid receivers/modes/routes`, () => {
  const input = { descriptor: d, route, executor: ACTOR, transactionOrigin: addr(106), source: SOURCE, runtimeEvidence: [] };
  for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"])
    Object.defineProperty(input, key, { get() { throw Error("runtime read " + key); }, enumerable: false });
  assert.equal(plugin.execution.buildRuntimeLeg!(input)!.settlement?.directOutput, true);
  for (const recipient of [ACTOR, RECEIVER]) {
    const request = { kind: "direct-output" as const, recipient }, v = Object.assign(Object.create(input), { settlement: request });
    const leg = plugin.execution.buildRuntimeLeg!(v); assert(leg); assert.deepEqual(leg.settlementRequest, request);
  }
  for (const recipient of [ethers.ZeroAddress, d.pool, d.baseToken, d.quoteToken])
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "direct-output", recipient } }));
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, route: { ...route, tokenIn: addr(400) } }));
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, transactionOrigin: undefined }));
  assert.equal(plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "quote-output" } }), null);
  assert.equal(plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x" } }), null);
});
test("default runtime bytes match all eight independently saved historical successful programs", () => {
  const rows = JSON.parse(readFileSync(new URL("./recipient-default-hashes.json", import.meta.url), "utf8")); assert.equal(rows.length, 8);
  for (const row of rows) {
    const descriptor = fixture(row.pool, row.base, row.quote), route = plugin.routes.project({ descriptor }).find(r => r.direction === row.direction)!;
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor, route, executor: "0x1000000000000000000000000000000000000002",
      transactionOrigin: "0x1000000000000000000000000000000000000001", source: SOURCE, runtimeEvidence: [] })!;
    assert.equal(ethers.keccak256(runtimeProgramScript(ethers.getBytes(leg.program), BigInt(row.amountIn))), row.runtimeScriptHash);
  }
});
function effects(external: boolean) {
  const to = external ? RECEIVER : ACTOR, log = (address: string, abi: ethers.Interface, name: string, args: any[]) => ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args) });
  return { tokenDeltas: [
    { token: d.baseToken, account: ACTOR, delta: -100n }, { token: d.quoteToken, account: ACTOR, delta: external ? 0n : 200n },
    ...(external ? [{ token: d.baseToken, account: RECEIVER, delta: 0n }, { token: d.quoteToken, account: RECEIVER, delta: 200n }] : [])],
    nativeDeltas: [{ account: ACTOR, delta: 0n }], logs: [
      log(d.pool, DODO_V2_EVENT_INTERFACE, "DODOSwap", [d.baseToken, d.quoteToken, 103n, 200n, ACTOR, to]),
      log(d.baseToken, token, "Transfer", [ACTOR, d.pool, 100n]), log(d.quoteToken, token, "Transfer", [d.pool, to, 200n])] };
}
for (const external of [false, true]) test(`independent ${external ? "external" : "self"} balance/event/Transfer receipts allow GSP input offset without falsifying full actor debit`, () => {
  assert.doesNotThrow(() => assertRecipientEffects(effects(external), d.pool, ACTOR, external ? RECEIVER : ACTOR, d.baseToken, d.quoteToken, 100n, 200n));
});
for (const fault of ["input", "output", "actor-output", "receiver-input", "native", "duplicate", "event-recipient", "event-output", "input-transfer", "output-transfer"])
  test(`independent observer rejects ${fault}`, () => {
    const e = effects(true);
    if (fault === "input") e.tokenDeltas[0]!.delta++;
    if (fault === "output") e.tokenDeltas[3]!.delta--;
    if (fault === "actor-output") e.tokenDeltas[1]!.delta--;
    if (fault === "receiver-input") e.tokenDeltas[2]!.delta--;
    if (fault === "native") e.nativeDeltas[0]!.delta--;
    if (fault === "duplicate") e.tokenDeltas.push(e.tokenDeltas[0]!);
    if (fault === "event-recipient" || fault === "event-output") e.logs[0] = { address: d.pool,
      ...DODO_V2_EVENT_INTERFACE.encodeEventLog(DODO_V2_EVENT_INTERFACE.getEvent("DODOSwap")!, [d.baseToken, d.quoteToken, 103n, fault === "event-output" ? 201n : 200n, ACTOR, fault === "event-recipient" ? ACTOR : RECEIVER]) };
    if (fault === "input-transfer") e.logs.splice(1, 1);
    if (fault === "output-transfer") e.logs.splice(2, 1);
    assert.throws(() => assertRecipientEffects(e, d.pool, ACTOR, RECEIVER, d.baseToken, d.quoteToken, 100n, 200n));
  });
test("saved Ready reuse is same-N and exact original family scope", () => {
  const families = ["custom-swap:dodo-v2", "univ2-standard"], p: any = { checkpointFingerprint: "f", inProgressRun: null,
    readyGeneration: { cutoff: { number: 10, hash: SOURCE.hash }, universeRange: { fromBlock: 10, toBlock: 10 }, familyPartitions: Object.fromEntries(families.map(f => [f, {}])) } };
  assert.deepEqual(readyReuseScope(p, 10, SOURCE.hash, families), { parentCheckpointFingerprint: "f", familyIds: families });
  for (const q of [{ ...p, inProgressRun: {} }, { ...p, readyGeneration: { ...p.readyGeneration, observationScope: {} } },
    { ...p, readyGeneration: { ...p.readyGeneration, familyPartitions: {} } }, { ...p, readyGeneration: { ...p.readyGeneration, universeRange: { fromBlock: 9, toBlock: 10 } } }])
    assert.throws(() => readyReuseScope(q, 10, SOURCE.hash, families));
  assert.throws(() => readyReuseScope(p, 11, SOURCE.hash, families));
  assert.throws(() => readyReuseScope(p, 10, ethers.ZeroHash, families));
});
test("historical executor artifact rejects missing or stale Solidity source bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "dodo-executor-proof-")), source = join(root, "src/BotVM.sol"), artifact = join(root, "BotVM.json");
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
