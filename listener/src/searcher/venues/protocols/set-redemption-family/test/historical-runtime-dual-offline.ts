// Offline regression tests for the observer, NOT historical execution evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { MODULE } from "../codec.js";
import { SAMPLE, ERC20, word, observeBalance, assertBasket, historicalReceipt } from "./historical-runtime-observations.js";

const components = [11, 12, 13, 14].map(n => ethers.toBeHex(n, 20));
const recipient = ethers.toBeHex(91, 20), next = ethers.toBeHex(92, 20);
function receipt() {
  const base = { transactionHash: SAMPLE.tx, blockHash: String(SAMPLE.hash), blockNumber: ethers.toQuantity(SAMPLE.number),
    transactionIndex: ethers.toQuantity(SAMPLE.index), status: "0x1" };
  const log = (address: string, logIndex: number, event: { topics: string[]; data: string }) =>
    ({ ...base, address, logIndex: ethers.toQuantity(logIndex), ...event });
  const transfer = (token: string, from: string, to: string, amount: bigint, index: number) =>
    log(token, index, ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [from, to, amount]));
  return { ...base, logs: [
    transfer(SAMPLE.set, recipient, ethers.ZeroAddress, SAMPLE.amountIn, 100),
    ...components.map((token, n) => transfer(token, SAMPLE.set, recipient, SAMPLE.outputs[n], 101 + n)),
    log(SAMPLE.module, 105, MODULE.encodeEventLog(MODULE.getEvent("SetTokenRedeemed")!,
      [SAMPLE.set, recipient, recipient, SAMPLE.amountIn])),
    // A later outgoing leg is deliberately one wei above actual receipt.
    transfer(components[1], recipient, next, SAMPLE.outputs[1] + 1n, 106),
  ] };
}
test("historical interval checks all four outputs without borrowing the next leg's inventory", () => {
  const evidence = historicalReceipt(receipt(), components);
  assert.deepEqual(evidence.outputs.map(o => o.amountOut), SAMPLE.outputs);
  assert.match(evidence.originalPreCallReplay, /unverified/);
});
test("receipt rejects wrong N/hash/index/status and every nonselected component mismatch", () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => { r.blockNumber = ethers.toQuantity(SAMPLE.number - 1); },
    (r: ReturnType<typeof receipt>) => { r.blockHash = ethers.ZeroHash; },
    (r: ReturnType<typeof receipt>) => { r.transactionIndex = "0x63"; },
    (r: ReturnType<typeof receipt>) => { r.status = "0x0"; },
    (r: ReturnType<typeof receipt>) => { r.logs[1].blockHash = ethers.ZeroHash; },
  ]) { const r = receipt(); mutate(r); assert.throws(() => historicalReceipt(r, components)); }
  for (let n = 0; n < 4; n++) {
    const r = receipt(); r.logs[n + 1].data = word(SAMPLE.outputs[n] + 1n);
    assert.throws(() => historicalReceipt(r, components), /amount mismatch/);
  }
  const duplicate = receipt(); duplicate.logs.push(duplicate.logs[1]);
  assert.throws(() => historicalReceipt(duplicate, components), /one component/);
  assert.throws(() => historicalReceipt(receipt(), [...components].reverse()), /amount mismatch/);
});
test("prestate diff distinguishes unchanged, created and deleted balances", () => {
  const token = components[0], slot = word(7n);
  assert.deepEqual(observeBalance({ pre: {}, post: {} }, token, slot, 103n),
    { before: 103n, after: 103n, delta: 0n });
  assert.equal(observeBalance({ pre: {}, post: { [token]: { storage: { [slot]: word(9n) } } } }, token, slot, 0n).delta, 9n);
  assert.equal(observeBalance({ pre: { [token]: { storage: { [slot]: word(9n) } } }, post: {} }, token, slot, 9n).delta, -9n);
  assert.throws(() => observeBalance({ pre: {}, post: { [token]: { storage: { [slot]: word(9n) } } } }, token, slot, 103n),
    /prestate disagrees/);
});
test("independent basket comparison rejects one wei shortfall despite enough old absolute inventory", () => {
  const amount = SAMPLE.amountIn, inventory = SAMPLE.outputs.map(v => v * 2n);
  const input = { before: amount + 101n, after: 101n, delta: -amount };
  const outputs = SAMPLE.outputs.map((v, n) => ({ before: inventory[n], after: inventory[n] + v, delta: v }));
  assertBasket(input, outputs, amount, SAMPLE.outputs, inventory);
  for (let n = 0; n < 4; n++) {
    const bad = structuredClone(outputs); bad[n].after--; bad[n].delta--;
    assert(bad[n].after >= SAMPLE.outputs[n], "absolute assertion would miss the shortfall");
    assert.throws(() => assertBasket(input, bad, amount, SAMPLE.outputs, inventory), /quote\/receipt/);
  }
  for (const shift of [-1n, 1n])
    assert.throws(() => assertBasket({ ...input, after: input.after + shift, delta: input.delta + shift },
      outputs, amount, SAMPLE.outputs, inventory), /Set debit/);
  assert.throws(() => assertBasket(input, outputs.slice(0, 1), amount, SAMPLE.outputs, inventory), /four-component/);
  const absent = structuredClone(outputs); absent[3] = { before: inventory[3], after: inventory[3], delta: 0n };
  assert.throws(() => assertBasket(input, absent, amount, SAMPLE.outputs, inventory), /component 3/);
});

test("offline input failure retains a private receipt; an existing receipt is never overwritten", () => {
  const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const out = resolve(mkdtempSync(resolve(root, "logs/set-historical-offline.")), "failed.json");
  const run = () => spawnSync(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("./historical-runtime-dual.ts", import.meta.url)),
    "--ready", out + ".missing-ready", "--prices", out + ".missing-prices",
    "--rpc-file", out + ".missing-private-config", "--out", out, "--port", "8593"],
    { cwd: resolve(root, "listener"), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, SEARCHER_FAMILY_SET_REDEMPTION_ENABLED: "1" } });
  const first = run(); assert.equal(first.status, 1, first.stderr);
  const bytes = readFileSync(out), receipt = JSON.parse(bytes.toString());
  assert.equal(receipt.result, "failed"); assert.equal(receipt.rpcCalls, 0); assert.equal(receipt.exactCalls, 0);
  assert.equal(receipt.forkStopped, false); assert.equal(receipt.errors[0].stage, "offline-inputs");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const second = run(); assert.equal(second.status, 1, second.stderr);
  assert.deepEqual(readFileSync(out), bytes, "failed attempt was overwritten");
});
