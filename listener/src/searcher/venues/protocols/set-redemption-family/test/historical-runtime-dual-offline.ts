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
import { CORE } from "../legacy.js";
import { LEGACY_SAMPLES, legacyHistoricalReceipt, assertExecutionRevert, assertLegacyInvalidAmountEvidence } from "./historical-legacy-observations.js";
import { naturalLegacyIssuanceReference, options } from "./historical-runtime-dual.js";

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
test("legacy observation binds the whole basket and the actual Vault receipt after Core's redemption log", () => {
  for (const sample of Object.values(LEGACY_SAMPLES)) {
    const base = { transactionHash: sample.tx, blockHash: sample.hash, blockNumber: ethers.toQuantity(sample.number),
      transactionIndex: ethers.toQuantity(sample.index), status: "0x1" };
    const log = (address: string, n: number, event: { topics: string[]; data: string }) =>
      ({ ...base, address, logIndex: ethers.toQuantity(n), ...event });
    const r = { ...base, logs: [
      log(sample.set, 100, ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [recipient, ethers.ZeroAddress, sample.amountIn])),
      log(sample.module, 101, CORE.encodeEventLog(CORE.getEvent("SetRedeemed")!, [sample.set, sample.amountIn])),
      log(sample.components[0], 102, ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [sample.vault, recipient, sample.outputs[0]])),
      log(sample.components[0], 103, ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [recipient, next, sample.outputs[0] + 1n])),
    ] };
    assert.equal(legacyHistoricalReceipt(r, sample, sample.components).outputs[0].amountOut, sample.outputs[0]);
    for (const mutate of [
      (x: typeof r) => { x.status = "0x0"; },
      (x: typeof r) => { x.logs[2].data = word(sample.outputs[0] - 1n); },
      (x: typeof r) => { x.logs.push(x.logs[2]); },
      (x: typeof r) => { x.logs[2].topics[1] = word(BigInt(next)); },
      (x: typeof r) => { x.logs[2].transactionIndex = "0x0"; },
    ]) { const bad = structuredClone(r); mutate(bad); assert.throws(() => legacyHistoricalReceipt(bad, sample, sample.components)); }
    const amount = sample.amounts[0], initial = 2000n, delta = 400n;
    assertBasket({ before: amount + 101n, after: 101n, delta: -amount },
      [{ before: initial, after: initial + delta, delta }], amount, [delta], [initial], sample.components.length);
    assert.throws(() => assertBasket({ before: amount + 101n, after: 101n, delta: -amount },
      [{ before: initial, after: initial + delta - 1n, delta: delta - 1n }], amount, [delta], [initial], sample.components.length), /quote\/receipt/);
  }
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

test("invalid amount controls reject unrelated Exact errors, OOG and wrong burn instead of recording a pass", () => {
  const sample = LEGACY_SAMPLES["legacy-base"], executor = ethers.toBeHex(2, 20);
  const encode = (reason: string) => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);
  for (const label of ["non-natural-multiple", "original-amount-exceeds-N-capacity"]) {
    const quantization = label === "non-natural-multiple", amountIn = quantization ? sample.naturalUnit + 1n : sample.amountIn;
    const coreData = CORE.encodeFunctionData("redeemAndWithdrawTo", [sample.set, executor, amountIn, 0n]);
    const burn = { to: sample.set, from: sample.module, error: "execution reverted", gas: "0x100000", gasUsed: "0x1000",
      input: new ethers.Interface(["function burn(address,uint256)"]).encodeFunctionData("burn", [executor, amountIn]) };
    const native = { to: sample.module, from: executor, input: coreData, error: "execution reverted", gas: "0x700000", gasUsed: "0x20000",
      ...(quantization ? { output: encode("SetTokenLibrary.isMultipleOfSetNaturalUnit: Quantity is not a multiple of nat unit") } : { calls: [burn] }) };
    const runtime = { to: executor, from: recipient, error: "execution reverted", gas: "0x700000", gasUsed: "0x20000",
      output: encode(quantization ? "runtime amount mismatch" : "runtime external call"), ...(quantization ? {} : { calls: [native] }) };
    const data = { sample, executor, label, amountIn, naturalUnit: sample.naturalUnit, supply: sample.amounts[1],
      quote: { status: "failed", outcome: { reasonCode: quantization
        ? "exact-decode:set-legacy quantity must be an exact multiple of naturalUnit" : "exact-decode:set-redemption supply capacity exceeded" } },
      results: [{ mode: "protocol-native", trace: native }, { mode: "runtime-program", trace: runtime }] };
    assertLegacyInvalidAmountEvidence(data);
    assert.throws(() => assertLegacyInvalidAmountEvidence({ ...data, quote: { status: "failed", outcome: { reasonCode: "rpc-timeout" } } }), /unrelated Exact/);
    for (const error of ["out of gas", "timeout", "invalid opcode"]) {
      const changed = structuredClone(data); changed.results[0].trace.error = error;
      assert.throws(() => assertLegacyInvalidAmountEvidence(changed), /semantic revert/);
    }
    const exhausted = structuredClone(native); exhausted.gasUsed = exhausted.gas;
    assert.throws(() => assertExecutionRevert(exhausted), /remaining gas/);
    if (!quantization) {
      const wrongBurn = structuredClone(data);
      assert("calls" in wrongBurn.results[0].trace);
      wrongBurn.results[0].trace.calls![0].input = "0x";
      assert.throws(() => assertLegacyInvalidAmountEvidence(wrongBurn), /authenticated Set burn/);
    }
  }
});

test("reference inputs require explicit paired selection and a legacy unary issuance direction", () => {
  const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const out = resolve(mkdtempSync(resolve(root, "logs/set-reference-options.")), "result.json");
  const base = ["--ready", "unused", "--prices", "unused", "--rpc-file", "unused", "--out", out, "--port", "8593"];
  const issue = [...base, "--sample", "legacy-base", "--direction", "issue"];
  const donor = ["--reference-prices", "donor.json", "--reference-edges", '["recorded-edge"]'];
  assert.deepEqual(options([...issue, ...donor]).referenceEdges, ["recorded-edge"]);
  assert.equal(options(issue).referencePrices, undefined);
  assert.throws(() => options([...issue, ...donor.slice(0, 2)]), /requires prices/);
  assert.throws(() => options([...issue, ...donor.slice(2)]), /requires prices/);
  assert.throws(() => options([...base, ...donor]), /unary issuance/);
  assert.throws(() => options([...issue, ...donor.slice(0, 2), "--reference-edges", '["a","b"]']), /unary issuance/);
});

test("natural legacy reference retains failed production P without rounding or inventing a missing input", () => {
  const edge = { edgeId: "set-issue", tokenIn: components[0], tokenOut: SAMPLE.set };
  const source = { number: SAMPLE.number, hash: SAMPLE.hash, generation: 1 };
  const failed = { ...edge, amountIn: 6312n, amountOut: null, status: "quote-failed" };
  const reference = naturalLegacyIssuanceReference(failed, edge, source)!;
  assert.equal(reference.amountIn, 6312n);
  assert.equal(reference.amountIn % 400n, 312n, "not silently changed to 6000");
  assert.equal(reference.row.status, "quote-failed");
  assert.equal(reference.kind, "natural-current-prices");
  assert.equal(naturalLegacyIssuanceReference({ ...failed, status: "missing-valuation", amountIn: null }, edge, source), undefined);
  assert.throws(() => naturalLegacyIssuanceReference({ ...failed, status: "missing-valuation" }, edge, source));
  for (const amountIn of [0n, -1n, (1n << 256n) - 1n])
    assert.throws(() => naturalLegacyIssuanceReference({ ...failed, amountIn }, edge, source), /invalid natural reference amount/);
  assert.throws(() => naturalLegacyIssuanceReference({ ...failed, amountOut: 1n }, edge, source));
  assert.throws(() => naturalLegacyIssuanceReference({ ...failed, quotedAt: source }, edge, source));
  assert.throws(() => naturalLegacyIssuanceReference({ ...failed, status: "carried" }, edge, source), /unsupported/);
});

test("natural legacy reference binds edge, tokens, quote status and current source", () => {
  const edge = { edgeId: "set-issue", tokenIn: components[0], tokenOut: SAMPLE.set };
  const source = { number: SAMPLE.number, hash: SAMPLE.hash, generation: 1 };
  const row = { ...edge, amountIn: 6400n, amountOut: 16_000_000_000_000n, status: "quoted", quotedAt: source };
  assert.equal(naturalLegacyIssuanceReference(row, edge, source)!.row.amountOut, row.amountOut);
  assert.throws(() => naturalLegacyIssuanceReference(undefined, edge, source), /edge mismatch/);
  assert.throws(() => naturalLegacyIssuanceReference({ ...row, edgeId: "other" }, edge, source), /edge mismatch/);
  for (const changed of [{ ...row, tokenIn: components[1] }, { ...row, tokenOut: components[1] }])
    assert.throws(() => naturalLegacyIssuanceReference(changed, edge, source), /token mismatch/);
  for (const quotedAt of [undefined, { ...source, number: source.number - 1 },
    { ...source, hash: ethers.ZeroHash }, { ...source, generation: 2 }])
    assert.throws(() => naturalLegacyIssuanceReference({ ...row, quotedAt }, edge, source), /quote source mismatch/);
  for (const amountOut of [null, 0n, -1n])
    assert.throws(() => naturalLegacyIssuanceReference({ ...row, amountOut }, edge, source));
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
