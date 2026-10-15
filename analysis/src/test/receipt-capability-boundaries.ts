import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TOPICS } from "../registry/protocols.js";

const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const fake = "0x0000000000000000000000000000000000005a7a";
function classify(enabled: boolean, txs: unknown[]) {
  const script = `
    import { classifyTxLoopCoverage } from ${JSON.stringify(new URL("../discovery/loop-coverage.ts", import.meta.url).href)};
    import { buildLoopCoverageOutput } from ${JSON.stringify(new URL("../cli/venue-discovery-bq.ts", import.meta.url).href)};
    import { readFileSync } from "node:fs";
    console.log(JSON.stringify(buildLoopCoverageOutput(JSON.parse(readFileSync(0,"utf8")).map(classifyTxLoopCoverage))));
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    input: JSON.stringify(txs), encoding: "utf8",
    env: { ...process.env, SEARCHER_FAMILY_BALANCER_V2_ENABLED: enabled ? "1" : "0", SEARCHER_FAMILY_ERC4626_ENABLED: "1" },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("enabled namespaced Balancer swap capability is not missing, and does not attest a pool", () => {
  const txs = [vault, fake].map(address => ({ txHash: address, receiptLogs: [{ address, topics: [TOPICS.balancerV2Swap] }] }));
  const enabled = classify(true, txs);
  assert.equal(enabled.summary.swapRouteGapTxs, 0);
  for (const tx of enabled.perTx) {
    assert.equal(tx.observedSwapVenues[0].productionRoutability, "unassessed");
    assert.equal(tx.observedSwapVenues[0].in_graph, null);
    assert.equal(tx.receiptRouteCoverageComplete, false);
  }
  const disabled = classify(false, txs);
  assert.equal(disabled.summary.swapRouteGapTxs, 1);
  assert.equal(disabled.perTx.find((tx: any) => tx.tx === vault).swapRouteGaps[0].reason, "no_swap_adapter");
  assert.equal(disabled.perTx.find((tx: any) => tx.tx === fake).observedSwapVenues[0].productionRoutability, "unassessed");
});

test("ERC4626 topics cannot distinguish a verified instance from a rejected instance without identity evidence", () => {
  const txs = [
    { txHash: "verified-in-separate-ready", receiptLogs: [{ address: "0x395da89bdb9431621a75df4e2e3b993acc2cab3d", topics: [TOPICS.erc4626Deposit] }] },
    { txHash: "rejected-in-separate-ready", receiptLogs: [{ address: "0x5fbaa3a3b489199338fbd85f7e3d444dc0504f33", topics: [TOPICS.erc4626Withdraw] }] },
  ];
  const result = classify(true, txs);
  assert.equal(result.summary.knownProtocolGapTxs, 0);
  assert.equal(result.summary.txsWithNamedProtocolEvidence, 2);
  assert.equal(result.summary.unassessedProtocolTxs, 2);
  for (const tx of result.perTx) {
    assert.deepEqual(tx.protocolVenueGaps, []);
    assert.equal(tx.unassessedProtocolVenues[0].reason, "protocol_identity_or_instance_not_attested");
    assert.equal(tx.unassessedProtocolVenues[0].productionRoutability, "unassessed");
    assert.equal(tx.unassessedProtocolVenues[0].in_graph, null);
    assert.equal(tx.protocolAdapterCandidate, false);
    assert.equal(tx.receiptRouteCoverageComplete, false);
  }
});
