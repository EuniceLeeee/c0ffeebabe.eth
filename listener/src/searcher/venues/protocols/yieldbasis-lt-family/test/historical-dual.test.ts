import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertObservedLeg, originalYbAmounts, referenceMintAmount, YB_SAMPLES } from "./historical-dual.js";
import { LT_INTERFACE } from "../abi.js";
import { readyReuseScope } from "./historical-ready.js";

const actor = "0x1000000000000000000000000000000000000002";
const asset = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const erc20 = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)", "function transfer(address,uint256) returns(bool)"]);

test("YB Ready reuse accepts only an authenticated completed single-family single-block anchor", () => {
  // The CLI's production Store.load authenticates hashes; this fixture tests
  // the additional scope checks, never supplies historical admission evidence.
  const prior: any = { checkpointFingerprint: "fixture-parent", inProgressRun: null,
    readyGeneration: { cutoff: { number: 17, hash: ethers.ZeroHash },
      universeRange: { fromBlock: 17, toBlock: 17 }, familyPartitions: { "protocol:yieldbasis-lt": {} } } };
  const before = structuredClone(prior);
  assert.deepEqual(readyReuseScope(prior, 17, ethers.ZeroHash),
    { parentCheckpointFingerprint: "fixture-parent", familyIds: ["protocol:yieldbasis-lt"] });
  assert.deepEqual(prior, before);
  assert.throws(() => readyReuseScope(null, 17, ethers.ZeroHash));
  const changes = [
    (p: any) => { p.inProgressRun = {}; },
    (p: any) => { p.readyGeneration = null; },
    (p: any) => { p.readyGeneration.cutoff.number = 18; },
    (p: any) => { p.readyGeneration.cutoff.hash = "0x" + "01".repeat(32); },
    (p: any) => { p.readyGeneration.universeRange.fromBlock = 16; },
    (p: any) => { p.readyGeneration.universeRange.toBlock = 18; },
    (p: any) => { delete p.readyGeneration.familyPartitions; },
    (p: any) => { p.readyGeneration.familyPartitions = { "protocol:compound-ctoken": {} }; },
    (p: any) => { p.readyGeneration.familyPartitions["protocol:compound-ctoken"] = {}; },
    (p: any) => { p.readyGeneration.observationScope = {}; },
  ];
  for (const change of changes) {
    const changed = structuredClone(prior); change(changed);
    assert.throws(() => readyReuseScope(changed, 17, ethers.ZeroHash));
  }
});

function originalFixture(withdraw = true) {
  const sample = withdraw ? YB_SAMPLES.cbbtc : YB_SAMPLES.wbtc;
  const receipt: any = { transactionHash: sample.tx, blockNumber: ethers.toQuantity(sample.number), blockHash: sample.hash, status: "0x1", logs: [] };
  const log = (address: string, abi: ethers.Interface, name: string, args: unknown[]) => receipt.logs.push({
    address, ...abi.encodeEventLog(abi.getEvent(name)!, args), removed: false, transactionHash: sample.tx,
    blockHash: sample.hash, blockNumber: receipt.blockNumber, logIndex: ethers.toQuantity(receipt.logs.length) });
  const method = withdraw ? "deposit(uint256,uint256,uint256)" : "deposit(uint256,uint256,uint256,address)";
  log(sample.lt, LT_INTERFACE, "Deposit", [actor, actor, 100n, 200n]);
  log(sample.lt, erc20, "Transfer", [ethers.ZeroAddress, actor, 200n]);
  const calls: any[] = [{ type: "CALL", to: sample.lt, from: actor,
    input: LT_INTERFACE.encodeFunctionData(method, withdraw ? [100n, 30n, 1n] : [100n, 30n, 1n, actor]),
    output: LT_INTERFACE.encodeFunctionResult(method, [200n]) }];
  if (withdraw) {
    const name = "withdraw(uint256,uint256)";
    log(sample.lt, LT_INTERFACE, "Withdraw", [actor, actor, actor, 90n, 190n]);
    log(asset, erc20, "Transfer", [sample.lt, actor, 90n]);
    calls.push({ type: "CALL", to: sample.lt, from: actor, input: LT_INTERFACE.encodeFunctionData(name, [190n, 1n]),
      output: LT_INTERFACE.encodeFunctionResult(name, [90n]), calls: [{ type: "CALL", to: asset, from: sample.lt,
        input: erc20.encodeFunctionData("transfer", [actor, 90n]), output: erc20.encodeFunctionResult("transfer", [true]) }] });
  }
  return { sample, receipt, trace: { type: "CALL", calls } };
}

test("YB original observations bind ordinary call, output transfer and canonical sample; deposit-only has no fake withdrawal", () => {
  for (const withdraw of [true, false]) {
    const f = originalFixture(withdraw), out = originalYbAmounts(f.receipt, f.trace, f.sample, asset);
    assert.equal(out.deposit!.amountIn, 100n); assert.equal(out.deposit!.amountOut, 200n);
    assert.equal(out.withdraw?.amountIn, withdraw ? 190n : undefined);
    assert.equal(out.deposit!.interface, withdraw ? "deposit(uint256,uint256,uint256)" : "deposit(uint256,uint256,uint256,address)");
  }
});

test("YB observation rejects stale source, duplicate events, wrong return/recipient and unrelated or reverted payments", () => {
  const changes = [
    (f: any) => { f.receipt.blockHash = ethers.ZeroHash; },
    (f: any) => { f.receipt.logs.push({ ...f.receipt.logs[0], logIndex: "0x9" }); },
    (f: any) => { f.trace.calls[0].output = LT_INTERFACE.encodeFunctionResult("deposit(uint256,uint256,uint256)", [201n]); },
    (f: any) => { f.trace.calls[0].from = ethers.ZeroAddress; },
    (f: any) => { f.trace.calls[1].calls[0].error = "revert"; },
    (f: any) => { f.trace.calls.push(f.trace.calls[1].calls[0]); f.trace.calls[1].calls = []; },
    (f: any) => { f.trace.calls[1].input = LT_INTERFACE.encodeFunctionData("emergency_withdraw(uint256)", [190n]); },
    (f: any) => { f.trace.error = "revert"; },
    (f: any) => { f.receipt.logs[1].logIndex = f.receipt.logs[0].logIndex; },
  ];
  for (const change of changes) {
    const f = originalFixture(); change(f); assert.throws(() => originalYbAmounts(f.receipt, f.trace, f.sample, asset));
  }
});

test("reverse input uses independently observed mint receipts, not quote or donor output", () => {
  const share = YB_SAMPLES.cbbtc.lt;
  const sample = { status: "pass", tokenIn: asset, tokenOut: share, label: "spliced-production-input-at-N", quote: { amountOut: 999n },
    executions: ["quoted", "runtime"].flatMap(encoding => ["input-only", "old-inventory"].map(mode => ({
      encoding, mode, status: "pass", effects: { tokenDeltas: [{ token: share, account: actor, delta: 200n }] } }))) };
  assert.equal(referenceMintAmount(sample, asset, share), 200n);
  for (const mutate of [
    (s: any) => { s.status = "failed"; },
    (s: any) => { s.label = "original-amount-at-N"; },
    (s: any) => { s.executions.pop(); },
    (s: any) => { s.executions[0].encoding = "runtime"; },
    (s: any) => { s.executions[0].effects.tokenDeltas[0].delta = 199n; },
    (s: any) => { s.executions[0].effects.tokenDeltas[0].account = ethers.ZeroAddress; },
  ]) { const s = structuredClone(sample); mutate(s); assert.throws(() => referenceMintAmount(s, asset, share)); }
});

test("historical dual observer rejects quote substitution, partial debit and inventory use", () => {
  const actor = "0x1000000000000000000000000000000000000002";
  const tokens = ["0x2000000000000000000000000000000000000001", "0x2000000000000000000000000000000000000002", "0x2000000000000000000000000000000000000003"];
  const good = { tokenDeltas: tokens.map((token, i) => ({ token, account: actor, delta: [-100n, 201n, 0n][i]! })), nativeDeltas: [{ account: actor, delta: 0n }] };
  const check = (v: typeof good) => assertObservedLeg(v, tokens[0]!, tokens[1]!, tokens[2]!, 100n, 201n);
  check(good);
  for (const [i, delta] of [[0, -99n], [0, -101n], [1, 200n], [2, -1n]] as const) {
    const changed = structuredClone(good); changed.tokenDeltas[i]!.delta = delta; assert.throws(() => check(changed));
  }
  assert.throws(() => check({ ...good, nativeDeltas: [{ account: actor, delta: -1n }] }));
  assert.throws(() => check({ ...good, tokenDeltas: [...good.tokenDeltas, good.tokenDeltas[0]!] }));
});
