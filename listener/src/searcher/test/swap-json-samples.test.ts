import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AbiCoder, id } from "ethers";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadProtocolJsonSamples } from "./protocol-json-samples.js";
import { loadSwapJsonSamples, swapJsonSamplesPath } from "./swap-json-samples.js";

function changed(change: (index: any, root: string) => void, pattern: RegExp) {
  const root = mkdtempSync(join(tmpdir(), "swap-json-samples-"));
  try {
    cpSync(dirname(swapJsonSamplesPath), root, { recursive: true });
    const path = join(root, "index.json"), index = JSON.parse(readFileSync(path, "utf8"));
    change(index, root); writeFileSync(path, JSON.stringify(index));
    assert.throws(() => loadSwapJsonSamples(path), pattern);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const complete = (index: any) => index.families.flatMap((f: any) => f.samples).find((s: any) => s.casePath !== null);

test("enabled Swap references use the shared data validator and retain honest missing inputs", () => {
  const result = loadSwapJsonSamples();
  assert.equal(result.summary.length, 15);
  assert.equal(result.summary.reduce((n, row) => n + row.references, 0), 27);
  assert(result.summary.every(row => row.withTransaction > 0 && row.execution === "not-run"));
  assert.equal(result.cases.length, 1); assert.equal(result.cases[0]!.familyId, "balancer-v1");
  assert.equal(result.cases[0]!.data.domain, "swap"); assert.equal(result.cases[0]!.data.trials.length, 4);
  assert(result.cases[0]!.data.trials.every(trial => trial.expectedAmountOut === undefined));
  assert.equal(result.summary.filter(row => row.pending.length > 0).length, 14);
  assert.equal(result.execution, "not-run");
  assert.throws(() => loadProtocolJsonSamples(swapJsonSamplesPath), /domain mismatch/);
});

test("Swap scope cannot silently include a disabled family or alter the frozen enabled set", () => {
  changed(index => { index.scopeReference.enabledFamilies[0].value = "0"; }, /disabled|flag/);
  changed(index => { index.scopeReference.enabledFamilies[0].familyId = "unlisted-family"; }, /scope changed/);
  changed(index => { index.scopeReference.enabledFamilies[0].flag = index.scopeReference.enabledFamilies[1].flag; }, /duplicate/);
  changed(index => { index.scopeReference.configSha256 = "unknown"; }, /scope pins/);
  changed(index => { index.domain = "protocol"; }, /domain mismatch/);
  changed(index => { index.families[0].familyId = "protocol:unrelated"; }, /domain/);
});

test("Swap samples cannot forge a pass, borrow old output, or replace route-key provenance", () => {
  changed((index, root) => {
    const file = join(root, complete(index).casePath), data = JSON.parse(readFileSync(file, "utf8"));
    data.trials[0].expectedAmountOut = "1"; writeFileSync(file, JSON.stringify(data));
  }, /borrows input only/);
  changed((index, root) => {
    const file = join(root, complete(index).casePath), data = JSON.parse(readFileSync(file, "utf8"));
    data.trials[0].routeKey = "forged-route"; writeFileSync(file, JSON.stringify(data));
  }, /recorded input source/);
  changed((index, root) => {
    const file = join(root, complete(index).casePath), data = JSON.parse(readFileSync(file, "utf8"));
    data.acceptance = "pass"; writeFileSync(file, JSON.stringify(data));
  }, /unknown field/);
  changed(index => { complete(index).source.hash = "0x" + "11".repeat(32); }, /equal|assertion/i);
  changed(index => { complete(index).amounts[0].provenance.sha256 = "11".repeat(32); }, /provenance/);
  changed(index => { complete(index).missing.push("current amounts"); }, /missing fields/);
});

test("Fluid fixed-state inputs keep discovery receipts separate from execution and deployment", () => {
  const root = join(dirname(swapJsonSamplesPath), "fixed-state");
  const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
  assert.equal(index.stateScope, "canonical-block-end");
  assert.equal(index.actorCodeAtExecutionBlock, "0x");
  assert.equal(index.actorOnlyCodeOverlay, true);
  assert.equal(index.protocolOverrides, false);
  assert.equal(index.cases.length, 2);
  for (const entry of index.cases) {
    const bytes = readFileSync(join(root, entry.case));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    const sample = parseProtocolJsonAcceptanceCase(JSON.parse(bytes.toString()));
    assert.equal(sample.transactionHash, undefined);
    assert.deepEqual(sample.source, entry.executionSource);
    assert.equal(sample.executor.toLowerCase(), index.deployment.executor.toLowerCase());
    assert.equal(sample.owner.toLowerCase(), index.deployment.owner.toLowerCase());
    assert(sample.source.number < index.deployment.blockNumber);
    const receipt = entry.discoveryReceipt;
    assert.equal(receipt.status, 1);
    assert(receipt.blockNumber < sample.source.number);
    assert.notEqual(receipt.blockHash, sample.source.hash);
    assert.equal(receipt.poolLog.address.toLowerCase(), sample.instanceKey);
    const [forward, input, output] = AbiCoder.defaultAbiCoder().decode(
      ["bool", "uint256", "uint256", "address"], receipt.poolLog.data);
    assert.equal(forward, true);
    assert.equal(output.toString(), entry.originalAmountOut);
    const original = sample.trials.find(trial => trial.id === entry.originalAmountTrial);
    assert(original);
    assert.equal(original.tokenIn.toLowerCase(), receipt.inputTransfer.address.toLowerCase());
    assert.equal(receipt.inputTransfer.topics[0], id("Transfer(address,address,uint256)"));
    assert.equal(input.toString(), original.amountIn);
    assert.equal(input, BigInt(receipt.inputTransfer.data));
    assert.equal(original.expectedAmountOut, undefined, "the earlier output cannot be reused at the cutoff");
    assert.equal(new Set(sample.trials.map(trial => trial.tokenIn)).size, 2);
    for (const trial of sample.trials) {
      assert.deepEqual(trial.requiredSettlement, ["quote-output", "direct-output"]);
      assert.deepEqual(trial.recipients, [sample.executor, sample.owner]);
    }
  }
});
