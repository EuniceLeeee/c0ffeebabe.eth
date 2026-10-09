// Offline nomination regression. Synthetic receipts are not historical proof.
import assert from "node:assert/strict";
import test from "node:test";
import { compoundCTokenNominate } from "../../../venues/protocols/compound-ctoken-family/nomination.js";
import { yieldBasisLtNominate } from "../../../venues/protocols/yieldbasis-lt-family/nomination.js";
import { CTOKEN_INTERFACE } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { LT_INTERFACE } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import type { CaptureNominationProvider, UnifiedObservation } from "../../../venues/adapter-family-plugin.js";

const first = "0x1000000000000000000000000000000000000001";
const second = "0x1000000000000000000000000000000000000002";
const actor = "0x1000000000000000000000000000000000000003";
const tx = "0x" + "11".repeat(32);
const source = { number: 100, hash: "0x" + "22".repeat(32), generation: 1 };

const specs = [
  { name: "Compound", adapter: "compound-ctoken", nominate: compoundCTokenNominate,
    event: CTOKEN_INTERFACE.encodeEventLog(CTOKEN_INTERFACE.getEvent("Redeem")!, [actor, 19n, 17n]) },
  { name: "Yield Basis", adapter: "yieldbasis-lt", nominate: yieldBasisLtNominate,
    event: LT_INTERFACE.encodeEventLog(LT_INTERFACE.getEvent("Withdraw")!, [actor, actor, actor, 19n, 17n]) },
];

for (const spec of specs) {
  const log = (address: string) => ({ address, ...spec.event, transactionHash: tx });
  const candidate = (address: string, seeded = true) => ({ address,
    opaque: { adapter: spec.adapter, ...(seeded ? { transactionHash: tx } : {}) } });
  const addresses = (rows: readonly UnifiedObservation[]) => rows.map(row => {
    assert.equal(row.kind, "log"); assert(row.kind === "log"); return row.address.toLowerCase();
  });
  const provider = (logs: ReturnType<typeof log>[], fallback: ReturnType<typeof log>[] = []) => {
    let traces = 0;
    const filters: unknown[] = [];
    const p: CaptureNominationProvider = {
      async call() { throw new Error("unexpected call"); },
      async getCode() { throw new Error("unexpected code read"); },
      async getStorage() { throw new Error("unexpected storage read"); },
      async getTransactionReceipt(hash) { assert.equal(hash, tx); return { blockNumber: source.number, logs }; },
      async getLogs(filter) { filters.push(filter); return fallback; },
      async traceTransaction() { traces++; throw new Error("transaction-wide trace is not target evidence"); },
    };
    return { p, filters, traces: () => traces };
  };

  test(`${spec.name}: two targets in one TX retain their own emitting addresses`, async () => {
    const p = provider([log(first), log(second)]);
    const results = await Promise.all([first, second].map(address => spec.nominate({
      nominations: [candidate(address)], source, provider: p.p,
    })));
    assert.deepEqual(results.map(addresses), [[first], [second]]);
    assert.equal(p.traces(), 0); assert.equal(p.filters.length, 0);
  });

  test(`${spec.name}: another target's log cannot satisfy a missing nomination`, async () => {
    const p = provider([log(first)]);
    assert.deepEqual(await spec.nominate({ nominations: [candidate(second)], source, provider: p.p }), []);
    assert.equal(p.traces(), 0);
    assert(p.filters.length > 0);
    for (const filter of p.filters) assert.equal((filter as { address: string }).address.toLowerCase(), second);
  });

  test(`${spec.name}: retained no-TX nomination still uses its address-bound recent log`, async () => {
    const p = provider([], [log(second)]);
    const rows = await spec.nominate({ nominations: [candidate(second, false)], source, provider: p.p });
    assert.deepEqual(addresses(rows), [second]); assert.equal(p.traces(), 0);
  });

  test(`${spec.name}: an out-of-scope recent log is not accepted as the target`, async () => {
    const p = provider([], [log(first)]);
    assert.deepEqual(await spec.nominate({ nominations: [candidate(second, false)], source, provider: p.p }), []);
  });
}
