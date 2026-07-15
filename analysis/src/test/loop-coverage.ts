import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildLoopCoverageOutput } from "../cli/venue-discovery-bq.js";
import { classifyTxLoopCoverage, type TxLoopCoverage } from "../discovery/loop-coverage.js";
import { TOPICS } from "../registry/protocols.js";

interface ExactFixture {
  source: string;
  sourceSha256: string;
  selection: string;
  cases: ExactCase[];
}

interface ExactCase {
  label: string;
  txHash: string;
  blockNumber: number;
  transactionIndex: number;
  receiptLogs: Array<{ logIndex: number; address: string; topics: string[] }>;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(TEST_DIR, "fixtures", "loop-coverage-v3.json"), "utf8"),
) as ExactFixture;
const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const DODO_POOL = "0x3058ef90929cb8180174d74c507176cca6835d73";
const PRIMARY_UNIV3_POOL = "0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b";
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const UNRELATED_UNKNOWN = "0x0000000000000000000000000000000000000bad";
const UNKNOWN_TOPIC = `0x${"11".repeat(32)}`;

test("Coffee 0x89cb observes three swaps and exposes DODO/Balancer route gaps", () => {
  const fixture = exactCase("primary-balancer-dodo-univ3");
  const result = classifyExact(fixture);
  const reversed = classifyExact({ ...fixture, receiptLogs: [...fixture.receiptLogs].reverse() });

  assert.deepEqual(reversed, result, "receipt log order must not change schema-v3 output");
  assert.equal(result.observedSwapVenues.length, 3);
  assert.equal(result.swapVenues, 3, "deprecated count alias follows observedSwapVenues");
  assert.deepEqual(swapAssessments(result), [
    [DODO_POOL, "dodo", "not_routable", "no_adapter", false],
    [BALANCER_VAULT, "balancer-v2", "not_routable", "no_swap_adapter", false],
    [PRIMARY_UNIV3_POOL, "univ3", "unassessed", "factory_or_routing_graph_not_attested", null],
  ]);
  assert.deepEqual(result.swapRouteGaps.map((venue) => [venue.addr, venue.reason]), [
    [DODO_POOL, "no_adapter"],
    [BALANCER_VAULT, "no_swap_adapter"],
  ]);
  assert.deepEqual(result.unclassifiedEmitters, []);
  assert.deepEqual(venue(result, MORPHO).observedRoles, ["flashloan"]);

  const balancer = venue(result, BALANCER_VAULT);
  assert.deepEqual(balancer.observedRoles, ["swap"]);
  assert.equal("klass" in balancer, false, "a scalar class must not hide emitter roles");

  const withUnknown = classifyTxLoopCoverage({
    txHash: fixture.txHash,
    receiptLogs: [
      ...fixture.receiptLogs,
      { address: UNRELATED_UNKNOWN, topics: [UNKNOWN_TOPIC] },
    ],
  });
  assert.deepEqual(
    withUnknown.swapRouteGaps.map((venue) => [venue.addr, venue.reason]),
    result.swapRouteGaps.map((venue) => [venue.addr, venue.reason]),
  );
  assert.deepEqual(withUnknown.unclassifiedEmitters, [
    { addr: UNRELATED_UNKNOWN, topic0: UNKNOWN_TOPIC },
  ]);
});

test("same-address Balancer Swap and FlashLoan expose both roles independent of log order", () => {
  const receiptLogs = [
    { address: BALANCER_VAULT, topics: [TOPICS.balancerV2FlashLoan] },
    { address: BALANCER_VAULT, topics: [TOPICS.balancerV2Swap] },
  ];
  const forward = classifyTxLoopCoverage({ txHash: "0xbalancer-both", receiptLogs });
  const reverse = classifyTxLoopCoverage({ txHash: "0xbalancer-both", receiptLogs: [...receiptLogs].reverse() });

  assert.deepEqual(reverse, forward);
  assert.deepEqual(venue(forward, BALANCER_VAULT).observedRoles, ["flashloan", "swap"]);
  assert.deepEqual(forward.swapRouteGaps.map((gap) => [gap.family, gap.reason]), [
    ["balancer-v2", "no_swap_adapter"],
  ]);
  assert.equal(forward.swapRouteGaps[0]?.in_graph, false);
  assert.deepEqual(forward.unclassifiedEmitters, []);
});

test("Coffee 0x52c2 flips legacy clean coverage on its DODO route gap", () => {
  const result = classifyExact(exactCase("secondary-dodo-with-balancer-flashloan"));

  assert.equal(result.observedSwapVenues.length, 7);
  assert.deepEqual(result.swapRouteGaps.map((gap) => [gap.family, gap.reason]), [
    ["dodo", "no_adapter"],
  ]);
  assert.equal(
    result.observedSwapVenues.filter((swap) => swap.productionRoutability === "unassessed").length,
    6,
  );
  assert.deepEqual(venue(result, BALANCER_VAULT).observedRoles, ["flashloan"]);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(result.fullyCovered, false);
});

test("Coffee 0xf7a6 flips legacy clean coverage on Balancer Swap without inventing flashloan", () => {
  const result = classifyExact(exactCase("secondary-balancer-swap-not-flashloan"));
  const swaps = new Map(result.observedSwapVenues.map((swap) => [swap.family, swap]));

  assert.deepEqual(venue(result, BALANCER_VAULT).observedRoles, ["swap"]);
  assert.equal(swaps.get("balancer-v2")?.productionRoutability, "not_routable");
  assert.equal(swaps.get("balancer-v2")?.reason, "no_swap_adapter");
  assert.equal(swaps.get("balancer-v2")?.in_graph, false);
  assert.equal(swaps.get("univ3")?.productionRoutability, "unassessed");
  assert.equal(swaps.get("univ3")?.in_graph, null);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(result.fullyCovered, false);
});

test("loop-coverage output summarizes observed evidence and routability as schema v3", () => {
  const perTx = FIXTURE.cases.map(classifyExact);
  const { summary } = buildLoopCoverageOutput(perTx);

  assert.equal(summary.schema_version, 3);
  assert.equal(summary.observedSwapVenues, 12);
  assert.equal(summary.swapRouteGapTxs, 3);
  assert.equal(summary.swapRouteGaps, 4);
  assert.equal(summary.unassessedSwapTxs, 3);
  assert.equal(summary.unassessedSwapVenues, 8);
  assert.deepEqual(summary.deprecated_aliases, [
    "perTx[].swapVenues",
    "perTx[].fullyCovered",
    "summary.fullyCovered",
  ]);
});

function exactCase(label: string): ExactCase {
  const fixture = FIXTURE.cases.find((item) => item.label === label);
  assert.ok(fixture, `missing exact fixture ${label}`);
  return fixture;
}

function classifyExact(fixture: ExactCase): TxLoopCoverage {
  return classifyTxLoopCoverage({ txHash: fixture.txHash, receiptLogs: fixture.receiptLogs });
}

function swapAssessments(result: TxLoopCoverage): Array<Array<string | boolean | null>> {
  return result.observedSwapVenues.map((venue) => [
    venue.addr,
    venue.family,
    venue.productionRoutability,
    venue.reason,
    venue.in_graph,
  ]);
}

function venue(result: TxLoopCoverage, addr: string): TxLoopCoverage["venues"][number] {
  const observed = result.venues.find((item) => item.addr === addr);
  assert.ok(observed, `missing observed venue ${addr}`);
  return observed;
}
