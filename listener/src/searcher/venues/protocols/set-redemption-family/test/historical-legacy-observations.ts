// Historical observations only. Amount trials are explicitly NOT production P.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { CORE } from "../legacy.js";
import { ERC20, json, lower, same, sha } from "./historical-runtime-observations.js";

const common = {
  tx: "0x00f865180dc1ffacd181f69a99db506d08766a5086a4f57a886f9611669f4375",
  number: 26132613, hash: "0x13f05316470a96a0c2028435e4064bce29b3f39033a3a43041f6e66f5309b146", index: 8,
  module: "0xf55186cc537e7067ea616f2aae007b4427a120c8", controller: "0xf55186cc537e7067ea616f2aae007b4427a120c8",
  vault: "0x5b67871c3a857de81a1ca0f9f7945e5670d986dc",
};
export const LEGACY_SAMPLES = {
  "legacy-base": { ...common, set: "0x6011242b6dc2c67ed3d484db09327e933054c90a", kind: "set-token",
    components: ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"], naturalUnit: 1000000000000n,
    amounts: [1000000000000n, 1000000000000000n], amountIn: 1461022291000000000000n, outputs: [584408916400n] },
  "legacy-rebalancing": { ...common, set: "0xac8ea871e2d5f4be618905f36f73c760f8cfdc8e", kind: "rebalancing-v3",
    components: ["0x6011242b6dc2c67ed3d484db09327e933054c90a"], naturalUnit: 100000000n,
    amounts: [100000000n, 1000000000000000000n], amountIn: 525045205447785400000000n, outputs: [1250158886431449426670n] },
} as const;
export type LegacySample = typeof LEGACY_SAMPLES[keyof typeof LEGACY_SAMPLES];

export function assertExecutionRevert(trace: any): any[] {
  assert.equal(trace.error, "execution reverted", "expected semantic revert, not infrastructure/OOG failure");
  const all: any[] = [];
  const visit = (node: any) => {
    all.push(node);
    if (node.error) {
      assert.equal(node.error, "execution reverted", "nested non-semantic failure");
      assert(BigInt(node.gasUsed) > 0n && BigInt(node.gasUsed) < BigInt(node.gas), "revert lacks remaining gas");
    }
    for (const child of node.calls ?? []) visit(child);
  };
  visit(trace); return all;
}

export function assertLegacyInvalidAmountEvidence(input: { sample: LegacySample; executor: string; label: string;
  amountIn: bigint; naturalUnit: bigint; supply: bigint; quote: any; results: readonly { mode: string; trace: any }[] }) {
  const { sample, executor, label, amountIn, naturalUnit, supply, quote, results } = input;
  const quantization = label === "non-natural-multiple";
  assert(quantization || label === "original-amount-exceeds-N-capacity");
  assert.equal(naturalUnit, sample.naturalUnit);
  assert.equal(quote.status, "failed");
  assert.equal(quote.outcome?.reasonCode, quantization
    ? "exact-decode:set-legacy quantity must be an exact multiple of naturalUnit"
    : "exact-decode:set-redemption supply capacity exceeded", "unrelated Exact failure is not amount rejection");
  assert(quantization ? amountIn % naturalUnit !== 0n && amountIn <= supply : amountIn > supply && amountIn % naturalUnit === 0n);
  assert.deepEqual(results.map(r => r.mode).sort(), ["protocol-native", "runtime-program"]);
  const reason = (trace: any) => {
    assert.equal(trace.output?.slice(0, 10), "0x08c379a0", "expected Error(string) revert");
    return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + trace.output.slice(10))[0];
  };
  const burnData = new ethers.Interface(["function burn(address,uint256)"]).encodeFunctionData("burn", [executor, amountIn]);
  const coreData = CORE.encodeFunctionData("redeemAndWithdrawTo", [sample.set, executor, amountIn, 0n]);
  for (const { mode, trace } of results) {
    const calls = assertExecutionRevert(trace);
    if (quantization) {
      assert.equal(reason(trace), mode === "protocol-native"
        ? "SetTokenLibrary.isMultipleOfSetNaturalUnit: Quantity is not a multiple of nat unit" : "runtime amount mismatch");
    } else {
      const core = calls.filter(c => same(c.to, sample.module) && same(c.from, executor) && c.input === coreData);
      assert.equal(core.length, 1, "expected exact native Core call");
      const burns = calls.filter(c => same(c.to, sample.set) && same(c.from, sample.module) && c.input === burnData);
      assert.equal(burns.length, 1, "capacity refusal must reach authenticated Set burn");
      assert.equal(burns[0].error, "execution reverted");
      assert([undefined, "0x"].includes(burns[0].output), "unexpected named burn refusal");
      if (mode === "runtime-program") assert.equal(reason(trace), "runtime external call");
    }
    if (mode === "protocol-native") { assert(same(trace.to, sample.module)); assert.equal(trace.input, coreData); }
  }
}

export function legacyHistoricalReceipt(receipt: any, sample: LegacySample, components: readonly string[]) {
  assert(receipt && same(receipt.transactionHash, sample.tx) && same(receipt.blockHash, sample.hash));
  assert.equal(Number(BigInt(receipt.blockNumber)), sample.number);
  assert.equal(Number(BigInt(receipt.transactionIndex)), sample.index); assert.equal(BigInt(receipt.status), 1n);
  assert.deepEqual(components.map(lower), [...sample.components]);
  const logs = receipt.logs as any[]; assert(Array.isArray(logs));
  const indexes = logs.map(l => BigInt(l.logIndex));
  assert.equal(new Set(indexes).size, indexes.length, "duplicate log index");
  for (const l of logs) {
    assert(!l.removed && same(l.transactionHash, sample.tx) && same(l.blockHash, sample.hash));
    assert.equal(Number(BigInt(l.blockNumber)), sample.number);
    assert.equal(Number(BigInt(l.transactionIndex)), sample.index);
  }
  const coreEvents = logs.filter(l => same(l.address, sample.module))
    .map(l => ({ log: l, event: CORE.parseLog(l) })).filter(x => x.event !== null);
  const redemptions = coreEvents.filter(x => x.event!.name === "SetRedeemed" && same(x.event!.args[0], sample.set));
  assert.equal(redemptions.length, 1, "one legacy Set redemption required");
  const redemption = redemptions[0]; assert.equal(redemption.event!.args[1], sample.amountIn);
  const transfers = logs.filter(l => l.topics[0]?.toLowerCase() === ERC20.getEvent("Transfer")!.topicHash)
    .map(l => ({ log: l, event: ERC20.parseLog(l)! }));
  const burns = transfers.filter(x => same(x.log.address, sample.set) && same(x.event.args.to, ethers.ZeroAddress) &&
    x.event.args.value === sample.amountIn && BigInt(x.log.logIndex) < BigInt(redemption.log.logIndex));
  assert.equal(burns.length, 1, "one actual legacy Set burn required");
  const redeemer = lower(burns[0].event.args.from);
  const later = coreEvents.map(x => BigInt(x.log.logIndex)).filter(n => n > BigInt(redemption.log.logIndex));
  const end = later.length ? later.reduce((a, b) => a < b ? a : b) : (indexes.reduce((a, b) => a > b ? a : b) + 1n);
  const outputs = components.map((token, n) => {
    const matches = transfers.filter(x => same(x.log.address, token) && same(x.event.args.from, sample.vault) &&
      same(x.event.args.to, redeemer) && BigInt(x.log.logIndex) > BigInt(redemption.log.logIndex) && BigInt(x.log.logIndex) < end);
    assert.equal(matches.length, 1, "one actual Vault withdrawal in redemption interval required");
    assert.equal(matches[0].event.args.value, sample.outputs[n], "historical output amount mismatch");
    return { token, amountOut: matches[0].event.args.value as bigint, logIndex: matches[0].log.logIndex };
  });
  return { tx: sample.tx, blockNumber: sample.number, blockHash: sample.hash, transactionIndex: sample.index, status: 1,
    amountIn: sample.amountIn, redeemer, recipient: redeemer, burnLogIndex: burns[0].log.logIndex,
    redemptionLogIndex: redemption.log.logIndex, outputs, receiptSha256: sha(json(receipt)),
    originalPreCallReplay: "unverified; original TX includes issuance/donation/fee updates, unlike N end-state redemption" };
}
