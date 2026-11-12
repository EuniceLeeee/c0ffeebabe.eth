import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { familyTransactionDirectory, familyTransactionRoot, familyTransactionInputFingerprint, familyTransactionLegMissing,
  getInstalledTransactionFamilies, loadFamilyTransactionRegistry, parseFamilyTransaction, readFamilyTransaction } from "./family-transaction-registry.js";

const source = { number: 123, hash: `0x${"a".repeat(64)}` };
const seed = () => ({ version: 1, chainId: 1, transactionHash: `0x${"b".repeat(64)}`, legs: [{
  id: "swap-0", familyId: "fixture", domain: "swap", source, instanceKey: "instance", lineageId: "lineage",
  tokenIn: `0x${"1".repeat(40)}`, tokenOut: `0x${"2".repeat(40)}`, amountIn: "123456789012345678901", amountScope: "original-input",
}] });
test("simulation seeds need no historical output, original call state, or original recipient", () => {
  const tx = parseFamilyTransaction(seed());
  assert.deepEqual(familyTransactionLegMissing(tx.legs[0]!), []);
  assert.equal(tx.legs[0]!.amountIn, "123456789012345678901");
});
test("missing identity/source cannot become an executable case", () => {
  const raw: any = seed(); delete raw.legs[0].lineageId; delete raw.legs[0].source;
  assert.deepEqual(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!), ["source", "lineageId"]);
  raw.legs[0].amountIn = "0";
  assert(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!).includes("positive amountIn"));
});
test("Credit policy is explicit and Funding checks the borrowed asset identity", () => {
  const raw: any = seed(); raw.legs[0].domain = "credit";
  assert.deepEqual(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!), ["credit.debtBps"]);
  raw.legs[0].credit = { debtBps: 8500 };
  assert.deepEqual(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!), []);
  raw.legs[0].credit.debtBps = 10001; assert.throws(() => parseFamilyTransaction(raw), /Credit/);
  delete raw.legs[0].credit; raw.legs[0].domain = "funding";
  assert(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!).some(item => item.includes("same borrowed asset")));
  raw.legs[0].tokenOut = raw.legs[0].tokenIn;
  assert.deepEqual(familyTransactionLegMissing(parseFamilyTransaction(raw).legs[0]!), []);
});
test("bad supplied values and duplicate leg ids reject instead of hiding as missing", () => {
  for (const change of [(x: any) => x.chainId = 10, (x: any) => x.legs[0].amountIn = "1e18",
    (x: any) => x.legs[0].source.hash = "0x1234", (x: any) => x.legs.push(x.legs[0]),
    (x: any) => x.legs[0].tokenIn = "ETH"]) {
    const raw: any = structuredClone(seed()); change(raw); assert.throws(() => parseFamilyTransaction(raw));
  }
});
test("one TX can seed several families, each leg has its own immutable input fingerprint", () => {
  const raw: any = seed(); raw.legs.push({ ...raw.legs[0], id: "second", familyId: "fixture-2" });
  const tx = parseFamilyTransaction(raw);
  assert.notEqual(familyTransactionInputFingerprint(tx, tx.legs[0]!), familyTransactionInputFingerprint(tx, tx.legs[1]!));
  assert.throws(() => familyTransactionInputFingerprint(tx, { ...tx.legs[0]!, amountIn: "1" }), /not registered/);
});
test("registry binds filenames and rejects symlinked inputs", () => {
  const root = mkdtempSync(resolve(tmpdir(), "family-registry-")), directory = resolve(root, familyTransactionDirectory);
  mkdirSync(directory, { recursive: true });
  try {
    const raw = seed(), path = resolve(directory, `${raw.transactionHash}.json`); writeFileSync(path, JSON.stringify(raw));
    assert.equal(loadFamilyTransactionRegistry(root).legs.length, 1);
    const wrong = resolve(root, "wrong.json"); writeFileSync(wrong, JSON.stringify(raw));
    assert.throws(() => readFamilyTransaction(wrong), /filename/);
    symlinkSync(wrong, resolve(directory, `0x${"c".repeat(64)}.json`));
    assert.throws(() => loadFamilyTransactionRegistry(root), /symlinks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("installed coverage comes from the complete production catalog including disabled entries", async () => {
  const rows = await getInstalledTransactionFamilies();
  const { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD: load } = await import("../venues/production-family-composition.js");
  assert.deepEqual(rows.map(row => row.familyId).sort(), [...load.plugins, ...load.disabledPlugins].map(row => String(row.familyId)).sort());
  assert(rows.some(row => !row.enabled));
  for (const row of rows) assert(row.lineages.length > 0);
});
test("central TX registry preserves every existing priced trial with its own identity and raw input", () => {
  const registry = loadFamilyTransactionRegistry();
  for (const domain of ["protocol", "swap"]) {
    const directory = resolve(familyTransactionRoot, `src/searcher/test/fixtures/${domain}-json`);
    const index = JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8"));
    for (const family of index.families) for (const sample of family.samples) {
      if (!sample.casePath) continue;
      const prior = JSON.parse(readFileSync(resolve(directory, sample.casePath), "utf8"));
      for (const trial of prior.trials) {
        const matches = registry.legs.filter(row => row.transaction.transactionHash === prior.transactionHash.toLowerCase() &&
          row.leg.familyId === family.familyId && row.leg.instanceKey === prior.instanceKey && row.leg.lineageId === prior.lineageId &&
          row.leg.amountScope === trial.id && row.leg.tokenIn === trial.tokenIn && row.leg.tokenOut === trial.tokenOut && row.leg.amountIn === trial.amountIn);
        assert.equal(matches.length, 1, `lost/duplicated original trial ${family.familyId}/${trial.id}`);
        assert.deepEqual(matches[0]!.leg.source, prior.source);
      }
    }
  }
});
test("checked-in seeds retain installed identities and reproducible provenance", async () => {
  const registry = loadFamilyTransactionRegistry(), installed = await getInstalledTransactionFamilies();
  const checked = new Map<string, string>();
  for (const row of registry.legs) {
    const family = installed.find(family => family.familyId === row.leg.familyId);
    if (family) {
      assert.equal(row.leg.domain, family.domain);
      if (row.leg.lineageId) assert(family.lineages.includes(row.leg.lineageId as any));
      if (!row.missing.length && row.leg.domain === "funding") assert.equal(row.leg.instanceKey, `${row.leg.familyId}\u001f${row.leg.tokenIn!.toLowerCase()}`);
    }
    assert(row.leg.provenance && row.leg.provenance.length > 0, "seed requires a recorded source");
    for (const value of row.leg.provenance) {
      const pin = value as { file: string; sha256: string; jsonPointer: string }, path = resolve(familyTransactionRoot, "..", pin.file);
      let sha = checked.get(path);
      if (!sha) { sha = createHash("sha256").update(readFileSync(path)).digest("hex"); checked.set(path, sha); }
      assert.equal(sha, pin.sha256, `seed provenance changed: ${pin.file}`);
      if (pin.jsonPointer) {
        let node = JSON.parse(readFileSync(path, "utf8"));
        for (const part of pin.jsonPointer.slice(1).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
        assert.notEqual(node, undefined, `seed provenance pointer missing: ${pin.file}${pin.jsonPointer}`);
      }
    }
  }
  assert(registry.transactions.some(row => new Set(row.transaction.legs.map(leg => leg.familyId)).size > 1), "TX reuse must remain supported");
});
test("primary source snapshots retain matching transaction pins and distinguish observed amounts from controls", () => {
  const registry = loadFamilyTransactionRegistry();
  const directory = resolve(familyTransactionRoot, "src/searcher/test/fixtures/family-transaction-sources");
  for (const file of readdirSync(directory)) {
    const snapshot = JSON.parse(readFileSync(resolve(directory, file), "utf8"));
    const { observed, requests, details, caseExpectation } = snapshot;
    const receipt = requests.receipt.response.result, header = requests.header.response.result;
    assert.equal(snapshot.chainId, 1); assert.equal(receipt.status, "0x1");
    assert.equal(receipt.transactionHash, observed.transactionHash);
    assert.equal(receipt.blockHash, header.hash); assert.equal(receipt.blockNumber, header.number);
    assert.deepEqual(observed.source, { number: Number(BigInt(header.number)), hash: header.hash });
    assert(header.transactions.includes(observed.transactionHash));
    for (const log of receipt.logs) {
      assert.equal(log.transactionHash, observed.transactionHash); assert.equal(log.blockHash, header.hash);
      assert.equal(log.blockNumber, header.number); assert.equal(log.removed, false);
    }
    const row = registry.legs.find(row => row.transaction.transactionHash === observed.transactionHash &&
      row.leg.familyId === caseExpectation.familyId && row.leg.instanceKey === (observed.instanceKey ?? caseExpectation.instanceKey));
    assert(row, "primary observation must remain registered");
    assert.deepEqual(row.leg.source, observed.source);
    assert.equal(row.leg.lineageId, caseExpectation.lineageId);
    assert.equal(caseExpectation.requiresFreshDiscovery, true, "source snapshots cannot pre-approve Discovery");
    if (snapshot.kind === "primary-explorer-transaction-pin") {
      assert.equal(observed.amountIn, undefined, "component controls are not observed transaction amounts");
      assert.equal(observed.historicalAmountOut, undefined);
      assert(receipt.logs.some((log: any) => log.address === caseExpectation.instanceKey));
      assert.equal(row.leg.amountScope, details.amountScope);
      const control = JSON.parse(readFileSync(resolve(familyTransactionRoot, "..", details.controlSource.file), "utf8"));
      assert.equal(row.leg.amountIn, control.amountIn);
      assert.equal(observed.transactionHash, control.referenceTransaction);
      assert.equal(observed.source.number, control.referenceTransactionBlock);
      assert.equal(header.parentHash, control.source.hash);
      continue;
    }
    assert.equal(snapshot.kind, "primary-explorer-seed-observations");
    const at = (pointer: string) => pointer.slice(1).split("/").reduce((node: any, key: string) => node[key], snapshot);
    const input = at(details.inputTransferReceiptPointer), output = at(details.outputTransferReceiptPointer);
    const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    assert.equal(input.topics[0], transfer); assert.equal(output.topics[0], transfer);
    assert.equal(input.address, observed.tokenIn); assert.equal(output.address, observed.tokenOut);
    assert.equal(BigInt(input.data).toString(), observed.amountIn);
    assert.equal(BigInt(output.data).toString(), observed.historicalAmountOut);
    assert.equal("0x" + input.topics[2].slice(-40), observed.instanceKey);
    for (const key of ["tokenIn", "tokenOut", "amountIn", "historicalAmountOut"])
      assert.deepEqual((row.leg as any)[key], observed[key]);
  }
});
test("legacy installed scope enumerates the same production catalog and directs non-JSON families to the main facts", async () => {
  const { buildFamilyRegressionPlan } = await import("./family-json-regression.js");
  const plan = await buildFamilyRegressionPlan(familyTransactionRoot, "installed"), installed = await getInstalledTransactionFamilies();
  assert.deepEqual(plan.families.map(row => row.familyId).sort(), installed.map(row => row.familyId).sort());
  assert(plan.families.some(row => row.domain === "credit"));
  assert(plan.families.some(row => row.domain === "funding"));
});
