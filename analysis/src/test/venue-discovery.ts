import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractVenueCandidates, type VenueScanInput } from "../discovery/venue-evidence.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";

interface CoffeeFixture {
  txHash: string;
  tx: { from: string; to: string };
  receiptLogs: VenueScanInput["receiptLogs"];
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COFFEE_DIR = join(TEST_DIR, "fixtures", "coffee-20260704");
const LIQUITY_VENUE = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";

test("coffee tx-2 surfaces the Liquity protocol venue and excludes known emitters", () => {
  const tx2 = loadCoffeeFixture("2");
  const candidates = extractVenueCandidates(inputFromFixture(tx2));
  const byAddress = new Map(candidates.map((candidate) => [candidate.address, candidate]));

  const liquity = byAddress.get(LIQUITY_VENUE);
  assert.ok(liquity, "Liquity venue is a discovery candidate");
  assert.ok(liquity.edgeKinds.includes("protocol"), "Liquity candidate carries protocol evidence");

  for (const excluded of [
    ADDR.WETH,
    ADDR.UNISWAP_V4_POOL_MANAGER,
    ADDR.BALANCER_VAULT,
    tx2.tx.from,
    tx2.tx.to,
  ]) {
    assert.equal(byAddress.has(excluded.toLowerCase()), false, `${excluded} is excluded`);
  }
});

test("coffee tx-3 pure-swap control yields no protocol or credit candidate", () => {
  const tx3 = loadCoffeeFixture("3");
  const candidates = extractVenueCandidates(inputFromFixture(tx3));
  const protocolOrCredit = candidates.filter((candidate) =>
    candidate.edgeKinds.includes("protocol") || candidate.edgeKinds.includes("credit")
  );

  assert.deepEqual(protocolOrCredit, []);
});

function inputFromFixture(fixture: CoffeeFixture): VenueScanInput {
  return {
    txHash: fixture.txHash,
    from: fixture.tx.from,
    to: fixture.tx.to,
    receiptLogs: fixture.receiptLogs,
  };
}

function loadCoffeeFixture(label: string): CoffeeFixture {
  return JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${label}.json`), "utf8")) as CoffeeFixture;
}
