import assert from "node:assert/strict";
import { ethers } from "ethers";
import example from "./fixtures/adapter-families/univ3-deferred-n26222895.json";

export type DeferredReceiptFixture = typeof example;
export type DeferredDirection = DeferredReceiptFixture["directions"][number];
export type DeferredTrial = DeferredDirection["trials"][number];

const probes = ["fixed", "debt", "unfunded", "short-debt", "wrong-receipt", "excess-draw", "zero-debt"];
const lower = (address: string) => ethers.getAddress(address).toLowerCase();

export function checkDeferredReceipt(fixture: DeferredReceiptFixture, direction: DeferredDirection, trial: DeferredTrial): void {
  const { receipt, name } = trial;
  assert.equal(receipt.id, trial.requestId);
  assert.deepEqual(receipt.source, fixture.source);
  assert.equal(receipt.provenance.kind, "strict-simulation-transport");
  assert.match(receipt.provenance.fingerprint, /^[a-f0-9]{64}$/);
  assert(ethers.isHexString(trial.scriptHash, 32));
  const amount = BigInt(direction.amountIn), out = BigInt(direction.out), paid = BigInt(trial.paymentAmount);
  assert(paid > 0n && paid < out);
  assert.equal(BigInt(trial.prefund), ["unfunded", "zero-debt"].includes(name) ? 0n : name === "short-debt" ? amount - 1n : amount);
  assert.equal(BigInt(trial.draw), name === "excess-draw" ? paid + 1n : paid);
  assert.equal(BigInt(trial.refund), name === "zero-debt" ? 0n : name === "wrong-receipt" ? amount - 1n : amount);
  if (name !== "fixed" && name !== "debt") {
    assert(probes.includes(name));
    assert.equal(receipt.completion, "reverted-as-declared");
    assert(ethers.isHexString(receipt.data) && receipt.data.startsWith("0x08c379a0"), "explicit EVM error required");
    assert.equal(receipt.logCount, 0);
    assert(receipt.tokenDeltas.every(row => BigInt(row.delta) === 0n));
    assert(receipt.nativeDeltas.every(row => BigInt(row.delta) === 0n));
    return;
  }
  assert.equal(receipt.completion, "returned");
  assert.equal(receipt.data, "0x");
  const expected = new Map<string, bigint>();
  const id = (token: string, account: string) => lower(token) + "/" + lower(account);
  for (const [account, input, output] of [
    [fixture.executor, -amount, out - paid], [fixture.candidate.pool, amount, -out],
    [fixture.paymentRecipient, 0n, paid], [fixture.pair, 0n, 0n],
  ] as const) {
    expected.set(id(direction.tokenIn, account), input);
    expected.set(id(direction.tokenOut, account), output);
  }
  for (const row of receipt.tokenDeltas) {
    const key = id(row.token, row.account);
    assert.equal(BigInt(row.delta), expected.get(key), "unexpected or duplicate transfer " + key);
    expected.delete(key);
  }
  assert.equal(expected.size, 0, "every input/output and protected inventory observation is required");
  assert.equal(receipt.nativeDeltas.length, 1);
  assert.equal(lower(receipt.nativeDeltas[0].account), lower(fixture.executor));
  assert.equal(BigInt(receipt.nativeDeltas[0].delta), 0n);
}

export function checkDeferredReceiptGroup(fixture: DeferredReceiptFixture): void {
  assert.equal(fixture.capability, "deferred-input");
  assert.deepEqual(fixture.directions.map(row => row.direction).sort(), ["one-for-zero", "zero-for-one"]);
  const [a,b] = fixture.directions;
  assert.equal(lower(a.tokenIn), lower(b.tokenOut));
  assert.equal(lower(a.tokenOut), lower(b.tokenIn));
  for (const row of fixture.directions) {
    assert.deepEqual(row.trials.map(t => t.name).sort(), [...probes].sort());
    for (const trial of row.trials) checkDeferredReceipt(fixture, row, trial);
  }
}
