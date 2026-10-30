import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { scanRecentCallSeeds } from "../recent-call-seed-scan.js";
import type { CaptureNominationProvider } from "../venues/adapter-family-plugin.js";
import type { FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from "../venues/declarative-discovery.js";

const address = toBeHex(1, 20), actor = toBeHex(2, 20), tx = toBeHex(3, 32);
const source = { number: 101, hash: toBeHex(101, 32), generation: 1 };
const abi = new Interface(["function convert(uint256 amount)"]);
const data = abi.encodeFunctionData("convert", [7n]);
const labels = ["fixture-seeding"];
const nominations = [{ address, opaque: { adapter: labels[0]! } }];

function mapped(nomination: DeclarativeMappedDiscovery["nomination"], txSeedNominations?: boolean): DeclarativeMappedDiscovery {
  return {
    version: 2, sources: ["observed-call", "address-surface"], candidateSources: [],
    candidate: { kind: "fixture-seeding", addressField: "target", fields: { target: "address" }, key: ["target"] },
    calls: [{ id: "convert", signature: "convert(uint256)", fields: { target: { from: "target" } } }],
    events: [], surface: { id: "surface", fingerprint: "fixture-interface", fields: { target: { from: "emitter" } } },
    labels, nomination, ...(txSeedNominations === undefined ? {} : { txSeedNominations }),
  };
}
function legacy(txSeedNominations?: boolean) {
  return {
    sources: ["observed-call", "address-surface"], candidateSources: [],
    candidate: { kind: "fixture-seeding", addressField: "target" },
    calls: [{ id: "convert", signature: "convert(uint256)" }], events: [],
    surface: { id: "surface", fingerprint: "fixture-interface" }, labels,
    ...(txSeedNominations === undefined ? {} : { txSeedNominations }),
  };
}
function provider() {
  const counts = { logs: 0, trace: 0, receipt: 0, code: 0, storage: 0 };
  const p: CaptureNominationProvider = {
    async getLogs(input) {
      counts.logs++; assert.equal(input.address, address); assert.equal(input.toBlock, source.number);
      return [{ address, data: "0x", topics: [], transactionHash: tx, blockNumber: source.number }];
    },
    async traceTransaction(hash) { counts.trace++; assert.equal(hash, tx); return { to: address, from: actor, input: data }; },
    async getTransactionReceipt(hash) { counts.receipt++; assert.equal(hash, tx); return { blockNumber: source.number, logs: [] }; },
    async getCode(target, block) { counts.code++; assert.equal(target, address); assert.equal(block, source.number); return "0x6000"; },
    async getStorage(target, _slot, block) { counts.storage++; assert.equal(target, address); assert.equal(block, source.number); return toBeHex(0, 32); },
    async call() { throw new Error("discovery must not execute identity"); },
  };
  return { p, counts };
}

test("address-surface declaration independently opts into or out of transaction seeds", () => {
  for (const enabled of [undefined, true, false]) {
    const discovery = compileDeclarativeDiscovery(mapped("address-surface", enabled));
    assert.equal(discovery.txSeedNominations, enabled);
    assert.equal(discovery.addressSurfaces?.[0]?.fingerprint, "fixture-interface");
    assert.equal(discovery.reverseBinding?.kind, "explicitly-unsupported");
  }
});

test("transaction evidence keeps its existing default and accepts explicit seed override", () => {
  assert.equal(compileDeclarativeDiscovery(mapped("tx-evidence")).txSeedNominations, true);
  assert.equal(compileDeclarativeDiscovery(mapped("tx-evidence", true)).txSeedNominations, true);
  assert.equal(compileDeclarativeDiscovery(mapped("tx-evidence", false)).txSeedNominations, false);
});

test("legacy address definitions retain the omitted default and project explicit booleans", () => {
  for (const enabled of [undefined, true, false]) {
    const discovery = compileDeclarativeDiscovery(legacy(enabled));
    assert.equal(discovery.txSeedNominations, enabled);
    assert.equal(discovery.candidateKey(discovery.decodeCandidate({
      observation: { kind: "call", source, target: address, data }, matchedPatternId: "convert",
    })!), address);
  }
});

test("seed declaration rejects non-booleans without truthiness coercion", () => {
  for (const definition of [legacy(), mapped("address-surface"), mapped("tx-evidence")]) {
    for (const invalid of [null, 0, 1, "true", "false", {}, [], () => true]) {
      assert.throws(() => compileDeclarativeDiscovery({ ...definition, txSeedNominations: invalid } as never), /txSeedNominations/);
    }
  }
});

test("existing recent-call consumer respects the projected capability without changing nomination mode", async () => {
  for (const mode of ["address-surface", "tx-evidence"] as const) {
    for (const enabled of [undefined, true, false]) {
      const discovery = compileDeclarativeDiscovery(mapped(mode, enabled));
      const catalog = {
        ownerOfAction: () => "protocol:fixture-seeding",
        forStrictFamily: () => ({ plugin: { discovery } }),
      } as unknown as FamilyCapabilityCatalog;
      const { p, counts } = provider();
      const seeds = await scanRecentCallSeeds({ catalog, source, provider: p, nominations, maxSeedsPerAddress: 1 });
      const expected = enabled ?? mode === "tx-evidence";
      assert.equal(seeds.length, expected ? 1 : 0);
      assert.equal(counts.logs, expected ? 1 : 0);
      assert.equal(counts.trace, expected ? 1 : 0);
      assert.equal(counts.receipt, 0);
      const rows = await discovery.nominate!.nominate({
        nominations: [{ address, opaque: { adapter: labels[0]!, txHash: tx } }], source, provider: p,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, mode === "address-surface" ? "address-surface" : "call");
      assert.equal(counts.receipt, mode === "address-surface" ? 0 : 1);
      assert.equal(counts.code, mode === "address-surface" ? 1 : 0);
      assert.equal(counts.storage, mode === "address-surface" ? 1 : 0);
    }
  }
});
