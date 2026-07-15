import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildLoopCoverageOutput } from "../cli/venue-discovery-bq.js";
import { classifyTxLoopCoverage, type TxLoopCoverage } from "../discovery/loop-coverage.js";
import { TOPICS } from "../registry/protocols.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";
import { POOL_REGISTRY } from "../../../listener/src/searcher/planner/token-graph.js";

interface ExactFixture {
  source: string;
  sourceSha256: string;
  selection: string;
  cases: ExactCase[];
  fullCorpusEvidence: {
    sourceSha256: string;
    canonicalOutputSha256: string;
    corpus: { transactionCount: number; receiptLogRowCount: number };
    summary: {
      transactionCount: number;
      swapRouteGapTxs: number;
      swapRouteGapCount: number;
      unassessedSwapTxs: number;
      unassessedSwapVenueCount: number;
      unclassifiedEmitterTxs: number;
    };
    eventTxs: {
      balancerFlashLoan: string[];
      balancerSwap: string[];
      balancerPoolBalanceChanged: string[];
      dodoObserved: string[];
    };
  };
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
  readFileSync(join(TEST_DIR, "fixtures", "loop-coverage-v4.json"), "utf8"),
) as ExactFixture;
const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const DODO_POOL = "0x3058ef90929cb8180174d74c507176cca6835d73";
const PRIMARY_UNIV3_POOL = "0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b";
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const LIQUIDITY_ONLY_UNIV2 = "0xae461ca67b15dc8dc81ce7615e0320da1a9ab8d5";
const UNRELATED_UNKNOWN = "0x0000000000000000000000000000000000000bad";
const ARBITRARY_FLASH_EMITTER = "0x000000000000000000000000000000000000f1a5";
const UNKNOWN_TOPIC = `0x${"11".repeat(32)}`;
const SECOND_UNKNOWN_TOPIC = `0x${"22".repeat(32)}`;
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const POOL_BALANCE_CHANGED_TOPIC = "0xe5ce249087ce04f05a957192435400fd97868dba0e6a4b4c049abf8af80dae78";
const ARBITRARY_SWAP_EMITTER = "0x0000000000000000000000000000000000005a7a";

test("full-corpus evidence binds exact event buckets to the canonical output", () => {
  const evidence = FIXTURE.fullCorpusEvidence;
  assert.equal(evidence.sourceSha256, FIXTURE.sourceSha256);
  assert.match(evidence.canonicalOutputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.corpus, { transactionCount: 857, receiptLogRowCount: 18_541 });
  assert.equal(evidence.summary.transactionCount, 857);
  assert.equal(evidence.summary.swapRouteGapTxs, 19);
  assert.equal(evidence.summary.swapRouteGapCount, 19);
  assert.equal(evidence.summary.unassessedSwapTxs, 740);
  assert.equal(evidence.summary.unassessedSwapVenueCount, 1_940);
  assert.equal(evidence.summary.unclassifiedEmitterTxs, 702);
  assertEvidenceTxs(evidence.eventTxs.balancerFlashLoan, 489);
  assertEvidenceTxs(evidence.eventTxs.balancerSwap, 19);
  assertEvidenceTxs(evidence.eventTxs.balancerPoolBalanceChanged, 2);
  assertEvidenceTxs(evidence.eventTxs.dodoObserved, 39);
});

test("Coffee 0x89cb exposes the attested Balancer gap and keeps DODO identity unassessed", () => {
  const fixture = exactCase("primary-balancer-dodo-univ3");
  const result = classifyExact(fixture);
  const reversed = classifyExact({ ...fixture, receiptLogs: [...fixture.receiptLogs].reverse() });

  assert.deepEqual(reversed, result, "receipt log order must not change schema-v4 output");
  assert.equal(result.observedSwapVenues.length, 3);
  assert.equal(result.observedSwapEmitterCount, 3);
  assert.deepEqual(swapAssessments(result), [
    [DODO_POOL, "dodo", "unassessed", "factory_or_routing_graph_not_attested", null],
    [BALANCER_VAULT, "balancer-v2", "not_routable", "no_swap_adapter", false],
    [PRIMARY_UNIV3_POOL, "univ3", "unassessed", "factory_or_routing_graph_not_attested", null],
  ]);
  assert.deepEqual(result.swapRouteGaps.map((venue) => [venue.addr, venue.reason]), [
    [BALANCER_VAULT, "no_swap_adapter"],
  ]);
  assert.deepEqual(result.unclassifiedEmitters, []);
  assert.deepEqual(venue(result, MORPHO).observedRoles, ["flashloan"]);
  assert.deepEqual(result.observedFundingVenues, [
    {
      addr: MORPHO,
      family: "morpho",
      topic0s: [TOPICS.morphoFlashLoan.toLowerCase()],
      fundingIdentity: "attested",
      identityReason: "canonical_address",
      productionRoutability: "routable",
      reason: "flash_adapter_attested",
    },
  ]);
  assert.deepEqual(result.fundingIdentityGaps, []);
  assert.deepEqual(result.fundingRouteGaps, []);

  const balancer = venue(result, BALANCER_VAULT);
  assert.deepEqual(balancer.observedRoles, ["swap"]);
  assert.deepEqual(balancer.observedFundingFamilies, []);
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
  assert.deepEqual(venue(forward, BALANCER_VAULT).observedFundingFamilies, ["balancer-v2"]);
  assert.deepEqual(forward.swapRouteGaps.map((gap) => [gap.family, gap.reason]), [
    ["balancer-v2", "no_swap_adapter"],
  ]);
  assert.equal(forward.swapRouteGaps[0]?.in_graph, false);
  assert.deepEqual(forward.observedFundingVenues.map((funding) => [
    funding.family,
    funding.fundingIdentity,
    funding.productionRoutability,
  ]), [["balancer-v2", "attested", "routable"]]);
  assert.deepEqual(forward.unclassifiedEmitters, []);
});

test("both exact Coffee PoolBalanceChanged rows are liquidity, never swap or funding gaps", () => {
  assert.equal(TOPICS.balancerV2PoolBalanceChanged.toLowerCase(), POOL_BALANCE_CHANGED_TOPIC);

  for (const label of ["pool-balance-changed-12b2", "pool-balance-changed-c909"]) {
    const result = classifyExact(exactCase(label));
    const balancer = venue(result, BALANCER_VAULT);

    assert.deepEqual(balancer.observedRoles, ["liquidity"]);
    assert.deepEqual(balancer.observedSwapFamilies, []);
    assert.deepEqual(balancer.observedFundingFamilies, []);
    assert.deepEqual(balancer.unrecognizedTopic0s, []);
    assert.deepEqual(result.observedSwapVenues, []);
    assert.deepEqual(result.swapRouteGaps, []);
    assert.deepEqual(result.observedFundingVenues, []);
    assert.deepEqual(result.fundingIdentityGaps, []);
    assert.deepEqual(result.fundingRouteGaps, []);
    assert.deepEqual(result.unclassifiedEmitters, []);
  }
});

test("only the registered Fluid singleton is routing-attested from its exact swap event", () => {
  const fluidAddress = ADDR.FLUID_DEX_USDC_USDT.toLowerCase();
  const fluidEntry = POOL_REGISTRY.find((entry) => entry.address.toLowerCase() === fluidAddress);
  assert.equal(fluidEntry?.adapter, "fluid-dex");

  const registered = classifyTxLoopCoverage({
    txHash: "0xregistered-fluid",
    receiptLogs: [{ address: fluidAddress, topics: [TOPICS.fluidDexSwap] }],
  });
  assert.deepEqual(swapAssessments(registered), [
    [fluidAddress, "fluid", "routable", "routing_attested", true],
  ]);

  const arbitraryFluid = classifyTxLoopCoverage({
    txHash: "0xarbitrary-fluid",
    receiptLogs: [{ address: ARBITRARY_SWAP_EMITTER, topics: [TOPICS.fluidDexSwap] }],
  });
  assert.deepEqual(swapAssessments(arbitraryFluid), [
    [
      ARBITRARY_SWAP_EMITTER,
      "fluid",
      "unassessed",
      "emitter_or_routing_graph_not_attested",
      null,
    ],
  ]);

  const factoryTopicOnly = classifyTxLoopCoverage({
    txHash: "0xfactory-topic-only",
    receiptLogs: [
      { address: ARBITRARY_SWAP_EMITTER, topics: [TOPICS.curveTokenExchange] },
      { address: ARBITRARY_SWAP_EMITTER, topics: [TOPICS.univ2Swap] },
      { address: ARBITRARY_SWAP_EMITTER, topics: [TOPICS.univ3Swap] },
    ],
  });
  assert.deepEqual(
    factoryTopicOnly.observedSwapVenues.map((swap) => [
      swap.family,
      swap.productionRoutability,
      swap.reason,
      swap.in_graph,
    ]),
    ["curve", "univ2", "univ3"].map((family) => [
      family,
      "unassessed",
      "factory_or_routing_graph_not_attested",
      null,
    ]),
  );

  const arbitraryBalancer = classifyTxLoopCoverage({
    txHash: "0xarbitrary-balancer",
    receiptLogs: [{ address: ARBITRARY_SWAP_EMITTER, topics: [TOPICS.balancerV2Swap] }],
  });
  assert.deepEqual(swapAssessments(arbitraryBalancer), [
    [
      ARBITRARY_SWAP_EMITTER,
      "balancer-v2",
      "unassessed",
      "emitter_or_routing_graph_not_attested",
      null,
    ],
  ]);
});

test("mixed known and unknown topics preserve every unrecognized topic on the emitter", () => {
  const mixedEmitter = ADDR.SKY_PSM_LITE.toLowerCase();
  const result = classifyTxLoopCoverage({
    txHash: "0xmixed-known-unknown",
    receiptLogs: [
      { address: mixedEmitter, topics: [TOPICS.dodoSwap] },
      { address: mixedEmitter, topics: [TOPICS.morphoFlashLoan] },
      { address: mixedEmitter, topics: [TOPICS.psmSellGem] },
      { address: mixedEmitter, topics: [TOPICS.transfer] },
      { address: mixedEmitter, topics: [APPROVAL_TOPIC] },
      { address: mixedEmitter, topics: [UNKNOWN_TOPIC] },
      { address: mixedEmitter, topics: [SECOND_UNKNOWN_TOPIC] },
    ],
  });

  assert.deepEqual(venue(result, mixedEmitter).observedRoles, [
    "flashloan", "protocol", "swap", "token", "unclassified",
  ]);
  assert.deepEqual(venue(result, mixedEmitter).unrecognizedTopic0s, [
    UNKNOWN_TOPIC,
    SECOND_UNKNOWN_TOPIC,
  ]);
  assert.deepEqual(result.unclassifiedEmitters, [
    { addr: mixedEmitter, topic0: UNKNOWN_TOPIC },
    { addr: mixedEmitter, topic0: SECOND_UNKNOWN_TOPIC },
  ]);
  assert.equal(venue(result, mixedEmitter).unrecognizedTopic0s.includes(TOPICS.transfer.toLowerCase()), false);
  assert.equal(venue(result, mixedEmitter).unrecognizedTopic0s.includes(APPROVAL_TOPIC), false);
  assert.deepEqual(result.protocolVenueGaps, []);
  assert.deepEqual(result.fundingIdentityGaps.map((funding) => funding.addr), [mixedEmitter]);
  assert.deepEqual(result.swapRouteGaps, []);
  assert.deepEqual(
    result.observedSwapVenues.map((swap) => [swap.family, swap.productionRoutability, swap.reason]),
    [["dodo", "unassessed", "factory_or_routing_graph_not_attested"]],
  );
});

test("Coffee 0x52c2 observes DODO without attesting identity while Balancer FlashLoan stays funding", () => {
  const fixture = exactCase("secondary-dodo-with-balancer-flashloan");
  const result = classifyExact(fixture);
  const reversed = classifyExact({ ...fixture, receiptLogs: [...fixture.receiptLogs].reverse() });

  assert.deepEqual(reversed, result);
  assert.equal(result.observedSwapVenues.length, 6);
  assert.equal(result.observedSwapEmitterCount, 6);
  assert.deepEqual(result.swapRouteGaps, []);
  assert.equal(
    result.observedSwapVenues.filter((swap) => swap.productionRoutability === "unassessed").length,
    6,
  );
  assert.deepEqual(venue(result, LIQUIDITY_ONLY_UNIV2).observedRoles, ["liquidity", "token"]);
  assert.deepEqual(venue(result, LIQUIDITY_ONLY_UNIV2).observedSwapFamilies, []);
  assert.deepEqual(venue(result, LIQUIDITY_ONLY_UNIV2).unrecognizedTopic0s, []);
  assert.deepEqual(venue(result, BALANCER_VAULT).observedRoles, ["flashloan"]);
  assert.deepEqual(result.observedFundingVenues.map((funding) => [
    funding.addr,
    funding.family,
    funding.fundingIdentity,
    funding.productionRoutability,
  ]), [[BALANCER_VAULT, "balancer-v2", "attested", "routable"]]);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(result.receiptRouteCoverageComplete, false);
});

test("Coffee 0xf7a6 exposes a Balancer swap gap without inventing flashloan", () => {
  const result = classifyExact(exactCase("secondary-balancer-swap-not-flashloan"));
  const swaps = new Map(result.observedSwapVenues.map((swap) => [swap.family, swap]));

  assert.deepEqual(venue(result, BALANCER_VAULT).observedRoles, ["swap"]);
  assert.equal(swaps.get("balancer-v2")?.productionRoutability, "not_routable");
  assert.equal(swaps.get("balancer-v2")?.reason, "no_swap_adapter");
  assert.equal(swaps.get("balancer-v2")?.in_graph, false);
  assert.equal(swaps.get("univ3")?.productionRoutability, "unassessed");
  assert.equal(swaps.get("univ3")?.in_graph, null);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(result.receiptRouteCoverageComplete, false);
});

test("PSM support is event-specific and preserves multiple Liquity gaps on the same emitter", () => {
  const psm = ADDR.SKY_PSM_LITE.toLowerCase();
  const receiptLogs = [
    { address: psm, topics: [TOPICS.psmSellGem] },
    { address: psm, topics: [TOPICS.liquityTroveOperation] },
    { address: psm, topics: [TOPICS.liquityBatchUpdated] },
  ];
  const forward = classifyTxLoopCoverage({ txHash: "0xpsm-liquity", receiptLogs });
  const reverse = classifyTxLoopCoverage({
    txHash: "0xpsm-liquity",
    receiptLogs: [...receiptLogs].reverse(),
  });

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.protocolVenues, [psm]);
  assert.deepEqual(forward.protocolVenueGaps, [
    TOPICS.liquityTroveOperation,
    TOPICS.liquityBatchUpdated,
  ].map((topic0) => ({ addr: psm, topic0: topic0.toLowerCase() })).sort(compareGap));
  assert.deepEqual(forward.unclassifiedEmitters, []);
  assert.equal(forward.protocolAdapterCandidate, false);
  assert.equal(forward.receiptRouteCoverageComplete, false);
});

test("ERC4626 support matches only Deposit/Withdraw and exposes another named topic as a gap", () => {
  const vaultAddress = ADDR.SUSDS.toLowerCase();
  const result = classifyTxLoopCoverage({
    txHash: "0xerc4626-mixed",
    receiptLogs: [
      { address: vaultAddress, topics: [TOPICS.erc4626Deposit] },
      { address: vaultAddress, topics: [TOPICS.psmBuyGem] },
    ],
  });

  assert.deepEqual(result.vaults, [vaultAddress]);
  assert.deepEqual(result.protocolVenues, [vaultAddress]);
  assert.deepEqual(result.protocolVenueGaps, [
    { addr: vaultAddress, topic0: TOPICS.psmBuyGem.toLowerCase() },
  ]);
  assert.deepEqual(result.unclassifiedEmitters, []);
  assert.equal(result.protocolAdapterCandidate, false);
  assert.equal(result.receiptRouteCoverageComplete, false);
});

test("funding identity and flash-adapter support are independent conservative assessments", () => {
  const psm = ADDR.SKY_PSM_LITE.toLowerCase();
  const clean = classifyTxLoopCoverage({
    txHash: "0xclean-protocol-receipt",
    receiptLogs: [{ address: psm, topics: [TOPICS.psmSellGem] }],
  });
  assert.equal(clean.receiptRouteCoverageComplete, true);

  const result = classifyTxLoopCoverage({
    txHash: "0xfunding-identities",
    receiptLogs: [
      { address: psm, topics: [TOPICS.psmSellGem] },
      { address: MORPHO, topics: [TOPICS.morphoFlashLoan] },
      { address: BALANCER_VAULT, topics: [TOPICS.balancerV2FlashLoan] },
      { address: AAVE_V3_POOL, topics: [TOPICS.aaveV3FlashLoan] },
      { address: PRIMARY_UNIV3_POOL, topics: [TOPICS.univ3Flash] },
      { address: ARBITRARY_FLASH_EMITTER, topics: [TOPICS.morphoFlashLoan] },
    ],
  });
  const funding = new Map(
    result.observedFundingVenues.map((item) => [`${item.addr}:${item.family}`, item]),
  );

  assert.deepEqual(fundingAssessment(funding.get(`${MORPHO}:morpho`)), [
    "attested", "canonical_address", "routable", "flash_adapter_attested",
  ]);
  assert.deepEqual(fundingAssessment(funding.get(`${BALANCER_VAULT}:balancer-v2`)), [
    "attested", "known_singleton_address", "routable", "flash_adapter_attested",
  ]);
  assert.deepEqual(fundingAssessment(funding.get(`${AAVE_V3_POOL}:aave-v3`)), [
    "attested", "known_singleton_address", "not_routable", "no_flash_adapter",
  ]);
  assert.deepEqual(fundingAssessment(funding.get(`${PRIMARY_UNIV3_POOL}:univ3`)), [
    "unassessed", "factory_identity_not_attested", "unassessed", "funding_identity_not_attested",
  ]);
  assert.deepEqual(fundingAssessment(funding.get(`${ARBITRARY_FLASH_EMITTER}:morpho`)), [
    "unassessed", "emitter_identity_not_attested", "unassessed", "funding_identity_not_attested",
  ]);
  assert.deepEqual(result.fundingIdentityGaps.map((item) => [item.addr, item.identityReason]), [
    [ARBITRARY_FLASH_EMITTER, "emitter_identity_not_attested"],
    [PRIMARY_UNIV3_POOL, "factory_identity_not_attested"],
  ]);
  assert.deepEqual(result.fundingRouteGaps.map((item) => [item.addr, item.reason]), [
    [AAVE_V3_POOL, "no_flash_adapter"],
  ]);
  assert.deepEqual(venue(result, ARBITRARY_FLASH_EMITTER).observedRoles, ["flashloan"]);
  assert.deepEqual(venue(result, ARBITRARY_FLASH_EMITTER).unrecognizedTopic0s, []);
  assert.deepEqual(result.unclassifiedEmitters, []);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(
    result.receiptRouteCoverageComplete,
    false,
    "unattested funding identity must defeat receipt route coverage",
  );
});

test("anonymous and known credit auxiliary events remain visible as trace-required evidence", () => {
  const anonymousEmitter = "0x000000000000000000000000000000000000a110";
  const result = classifyTxLoopCoverage({
    txHash: "0xtrace-required-evidence",
    receiptLogs: [
      { address: anonymousEmitter, topics: [] },
      { address: MORPHO, topics: [TOPICS.morphoSupply] },
      { address: MORPHO, topics: [TOPICS.morphoWithdraw] },
    ],
  });

  assert.deepEqual(venue(result, anonymousEmitter).topic0s, [""]);
  assert.deepEqual(venue(result, anonymousEmitter).unrecognizedTopic0s, [""]);
  assert.deepEqual(venue(result, MORPHO).observedRoles, ["unclassified"]);
  assert.deepEqual(result.unclassifiedEmitters, [
    { addr: anonymousEmitter, topic0: "" },
    { addr: MORPHO, topic0: TOPICS.morphoSupply.toLowerCase() },
    { addr: MORPHO, topic0: TOPICS.morphoWithdraw.toLowerCase() },
  ].sort(compareGap));
  assert.equal(result.receiptRouteCoverageComplete, false);
});

test("schema v4 exposes an exact swap-emitter count without legacy aliases", () => {
  const result = classifyTxLoopCoverage({
    txHash: "0xcompat-emitter-count",
    receiptLogs: [
      { address: DODO_POOL, topics: [TOPICS.dodoSwap] },
      { address: DODO_POOL, topics: [TOPICS.univ2Swap] },
    ],
  });

  assert.equal(result.observedSwapVenues.length, 2);
  assert.equal(result.observedSwapEmitterCount, 1);
  assert.equal("swapVenues" in result, false);
  assert.equal("fullyCovered" in result, false);
  assert.equal("gapVenues" in result, false);
});

test("loop-coverage output summarizes observed evidence and routability as schema v4", () => {
  const perTx = FIXTURE.cases.map(classifyExact);
  const { summary } = buildLoopCoverageOutput(perTx);

  assert.equal(summary.schema_version, 4);
  assert.equal(summary.transactionCount, 5);
  assert.equal(summary.observedSwapVenueCount, 11);
  assert.equal(summary.observedSwapEmitterCount, 11);
  assert.equal(summary.swapRouteGapTxs, 2);
  assert.equal(summary.swapRouteGapCount, 2);
  assert.equal(summary.unassessedSwapTxs, 3);
  assert.equal(summary.unassessedSwapVenueCount, 9);
  assert.equal(summary.observedFundingVenueCount, 2);
  assert.equal(summary.fundingIdentityGapTxs, 0);
  assert.equal(summary.fundingIdentityGapCount, 0);
  assert.equal(summary.fundingRouteGapTxs, 0);
  assert.equal(summary.fundingRouteGapCount, 0);
  assert.equal(summary.protocolAdapterCandidateTxCount, 2);
  assert.equal(summary.requiresTraceTxCount, 5);
  assert.equal(summary.receiptRouteCoverageCompleteTxCount, 0);
  assert.deepEqual(summary.removed_v4_fields, [
    "perTx[].swapVenues",
    "perTx[].fullyCovered",
    "perTx[].gapVenues",
    "summary.txs",
    "summary.observedSwapVenues",
    "summary.observedSwapEmitters",
    "summary.swapRouteGaps",
    "summary.unassessedSwapVenues",
    "summary.observedFundingVenues",
    "summary.fundingIdentityGaps",
    "summary.fundingRouteGaps",
    "summary.deprecated_aliases",
    "summary.fullyCovered",
    "summary.oneGapWithVault",
    "summary.protocolAdapterCandidates",
    "summary.requiresTrace",
  ]);
  assert.equal("fullyCovered" in summary, false);
  assert.equal(summary.singleProtocolVenueGapWithProtocolLegTxCount, 0);
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

function fundingAssessment(
  funding: TxLoopCoverage["observedFundingVenues"][number] | undefined,
): string[] {
  assert.ok(funding, "missing observed funding venue");
  return [
    funding.fundingIdentity,
    funding.identityReason,
    funding.productionRoutability,
    funding.reason,
  ];
}

function compareGap(a: { addr: string; topic0: string }, b: { addr: string; topic0: string }): number {
  return a.addr.localeCompare(b.addr) || a.topic0.localeCompare(b.topic0);
}

function assertEvidenceTxs(txs: string[], expected: number): void {
  assert.equal(txs.length, expected);
  assert.equal(new Set(txs).size, expected);
  assert.deepEqual(txs, [...txs].sort());
  for (const tx of txs) assert.match(tx, /^0x[a-f0-9]{64}$/);
}
