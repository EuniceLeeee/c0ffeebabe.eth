import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AggregatedVenue } from "../discovery/venue-aggregate.js";
import { aggregateVenueCandidates } from "../discovery/venue-aggregate.js";
import { extractVenueCandidates, type VenueScanInput } from "../discovery/venue-evidence.js";
import {
  ingestAggregates,
  listVenues,
  seedRegistry,
  setClassification,
  setStatus,
} from "../discovery/venue-registry.js";
import { PUBLIC_ROUTERS } from "../registry/routers.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";

interface CoffeeFixture {
  txHash: string;
  tx: { from: string; to: string };
  receiptLogs: VenueScanInput["receiptLogs"];
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COFFEE_DIR = join(TEST_DIR, "fixtures", "coffee-20260704");
const LIQUITY_VENUE = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";
const TX2_SWAP_VENUE = "0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf";

test("seedRegistry marks handled venues known and excluded infra excluded", () => {
  const reg = seedRegistry();
  for (const known of [
    ADDR.SKY_PSM_LITE,
    ADDR.FLUID_VAULT_WSTUSR_USDC,
    ADDR.WSTETH,
    ADDR.SUSDS,
    ADDR.WSTUSR,
  ]) {
    assert.equal(reg.venues[known.toLowerCase()]?.status, "known", `${known} is known`);
  }

  assert.equal(reg.venues[ADDR.WETH.toLowerCase()]?.status, "excluded", "WETH is excluded");
  const router = [...PUBLIC_ROUTERS][0];
  assert.equal(reg.venues[router]?.status, "excluded", "public router is excluded");
});

test("coffee tx-2 aggregate creates Liquity candidate with auto protocol classification", () => {
  const reg = ingestAggregates(seedRegistry(), coffeeTx2Aggregate());
  const liquity = reg.venues[LIQUITY_VENUE];

  assert.ok(liquity, "Liquity venue is registered");
  assert.equal(liquity.status, "candidate");
  assert.deepEqual(liquity.classification, { edgeKind: "protocol", source: "auto" });
  assert.ok(liquity.edgeKinds.includes("protocol"));
});

test("manual classification persists across repeated ingest", () => {
  const aggregate = coffeeTx2Aggregate();
  const first = ingestAggregates(seedRegistry(), aggregate);
  const fixed = setClassification(first, LIQUITY_VENUE, "credit");
  const reingested = ingestAggregates(fixed, aggregate);

  assert.deepEqual(reingested.venues[LIQUITY_VENUE]?.classification, {
    edgeKind: "credit",
    source: "manual",
  });
});

test("known and excluded status survive repeated ingest", () => {
  const aggregate = coffeeTx2Aggregate();
  const first = ingestAggregates(seedRegistry(), aggregate);
  const manuallyKnown = setStatus(first, LIQUITY_VENUE, "known");
  const manuallyExcluded = setStatus(manuallyKnown, TX2_SWAP_VENUE, "excluded");
  const reingested = ingestAggregates(manuallyExcluded, aggregate);

  assert.equal(reingested.venues[LIQUITY_VENUE]?.status, "known");
  assert.equal(reingested.venues[TX2_SWAP_VENUE]?.status, "excluded");
});

test("auto classification chooses credit over lp when both are observed", () => {
  const reg = ingestAggregates(seedRegistry(), [{
    address: "0x1111111111111111111111111111111111111111",
    edgeKinds: ["lp", "credit"],
    protocolActions: [],
    txCount: 1,
    totalLogCount: 2,
  }]);

  assert.deepEqual(reg.venues["0x1111111111111111111111111111111111111111"]?.classification, {
    edgeKind: "credit",
    source: "auto",
  });
});

test("listVenues filters by actionable classification and sorts deterministically", () => {
  const reg = ingestAggregates(seedRegistry(), coffeeTx2Aggregate());
  const protocol = listVenues(reg, { status: "candidate", kind: "protocol" });

  assert.deepEqual(protocol.map((venue) => venue.address), [LIQUITY_VENUE]);
});

function coffeeTx2Aggregate(): AggregatedVenue[] {
  const fixture = loadCoffeeFixture("2");
  return aggregateVenueCandidates([extractVenueCandidates(inputFromFixture(fixture))]);
}

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
