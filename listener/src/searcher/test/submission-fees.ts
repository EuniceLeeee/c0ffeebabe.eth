import assert from "node:assert/strict";
import type { ethers } from "ethers";
import { computeSubmissionFees, resolveBribeGasBasis, BRIBE_WALLET_RESERVE } from "../../shared/submission-fees.js";
import { computeBidEth } from "../ev-evaluator.js";
import { createBundleRouter } from "../execution/bundle-router.js";
import { buildSignedBackrunTx } from "../../submitter.js";
import type { BuilderEvidence } from "../../shared/builder-observations.js";

const gas = 100_000n, base = 1_000_000_000n, profit = 1_000_000_000_000_000n;
const bid = computeBidEth(profit, gas * base, { bribeAllAboveGas: false, bribeBps: 9900 });
const input = { measuredGasUsed: gas, targetBaseFee: base, bribeWei: bid,
  walletBalance: 1_000_000_000_000_000_000n, expectedProfitEth: profit };
assert.equal(resolveBribeGasBasis(undefined), "gas-limit");
assert.equal(resolveBribeGasBasis("measured-gas"), "measured-gas");
for (const value of ["", "measured", "garbage"]) assert.throws(() => resolveBribeGasBasis(value));
const prior = computeSubmissionFees({ ...input, basis: "gas-limit" });
const next = computeSubmissionFees({ ...input, basis: "measured-gas" });
assert.equal(prior.gasLimit, 130_000n); assert.equal(next.gasLimit, prior.gasLimit);
assert.equal(prior.priorityFee, bid / prior.gasLimit);
assert.equal(next.priorityFee, bid / gas);
assert.equal(next.estimatedBribeWei, bid); // 99% of post-base-fee surplus, not 99% / 1.3.
assert.equal(next.estimatedNetWei, (profit - gas * base) / 100n);
assert.ok(next.maxBribeWei > bid);
assert.ok(next.netAtGasLimitWei! < 0n); // Expected positive EV is NOT a worst-gas profit guarantee.
assert.equal(next.walletLimited, false);

let cases = 0;
for (const g of [1n, 100_001n, 1_000_003n, 20_000_000n]) {
  for (const baseFee of [1n, 1_000_000_000n]) {
    const expectedProfitEth = baseFee * g + 1_000_000_000_000_000n;
    const bribeWei = 990_000_000_000_000n;
    const limit = (13n * g + 9n) / 10n;
    for (const spare of [0n, 1n, limit - 1n, limit, bribeWei, bribeWei * 2n]) {
      const walletBalance = BRIBE_WALLET_RESERVE + baseFee * limit + spare;
      const fees = computeSubmissionFees({ measuredGasUsed: g, targetBaseFee: baseFee,
        bribeWei, walletBalance, expectedProfitEth, basis: "measured-gas" });
      assert.ok(fees.worstGasCostWei <= walletBalance - BRIBE_WALLET_RESERVE);
      assert.ok(fees.estimatedBribeWei <= bribeWei);
      assert.ok(fees.estimatedNetWei! > 0n);
      assert.equal(fees.priorityFee, bribeWei / g < spare / limit ? bribeWei / g : spare / limit);
      assert.equal(fees.gasLimit, limit);
      cases++;
    }
  }
}
for (const overrides of [
  { expectedProfitEth: undefined }, { expectedProfitEth: base * gas + bid },
  { measuredGasUsed: 0n }, { measuredGasUsed: -1n }, { targetBaseFee: 0n },
  { bribeWei: -1n }, { walletBalance: 0n },
]) assert.throws(() => computeSubmissionFees({ ...input, basis: "measured-gas", ...overrides }));

// Exercise the actual production router → submitter, with mock signing/provider/HTTP only.
const oldFetch = globalThis.fetch, oldSession = process.env.SEARCHER_LIVE_SESSION_PATH;
delete process.env.SEARCHER_LIVE_SESSION_PATH;
try {
  const rows: BuilderEvidence[] = [];
  let signs = 0, reads = 0, sends = 0, unsigned: ethers.TransactionLike | undefined;
  const wallet = { address: "0x" + "11".repeat(20), getNonce: async () => 7,
    signTransaction: async (tx: ethers.TransactionLike) => { signs++; unsigned = tx; return "0x01"; },
    signMessage: async () => "mock-auth",
  } as unknown as ethers.Wallet;
  const provider = { getBalance: async () => { reads++; return input.walletBalance; } } as unknown as ethers.JsonRpcProvider;
  globalThis.fetch = async () => { sends++; return new Response(JSON.stringify({ id: 1, result: { bundleHash: "0x" + "cd".repeat(32) } })); };
  const router = createBundleRouter({ dryRun: false, wallet, provider, botvmAddress: "0x" + "22".repeat(20),
    defaultGasUsed: 100_000, evidence: row => rows.push(row), bribeGasBasis: "measured-gas" });
  for (const mode of ["standalone", "victim-bundle", "hash-only"] as const) {
    await router.submit({ mode, victimTxHash: "0x" + "ab".repeat(32),
      ...(mode === "victim-bundle" ? { victimRawTx: "0x02" } : {}),
      backrunCalldata: "0x", targetBlock: 100, expectedProfit: profit, expectedProfitEth: profit,
      bribeWei: bid, maxBaseFeePerGas: base, gasUsed: gas });
    assert.equal(unsigned!.gasLimit, 130_000n);
    assert.equal(unsigned!.maxPriorityFeePerGas, next.priorityFee);
    assert.equal(unsigned!.maxFeePerGas, next.maxFeePerGas);
  }
  assert.equal(signs, 3); assert.equal(reads, 3); assert.equal(sends, 11);
  const feeRows = rows.filter(row => row.type === "submission_fee_parameters");
  assert.equal(feeRows.length, 3);
  for (const row of feeRows) {
    assert.equal(row.bribe_gas_basis, "measured-gas");
    assert.equal(row.estimated_bribe_payment_wei, String(bid));
    assert.equal(row.max_bribe_payment_at_gas_limit_wei, String(next.maxBribeWei));
    assert.equal(row.estimated_net_wei, String(next.estimatedNetWei));
    assert.equal(row.net_at_gas_limit_wei, String(next.netAtGasLimitWei));
  }
  const rejected = await router.submit({ mode: "standalone", victimTxHash: "0x", backrunCalldata: "0x",
    targetBlock: 100, expectedProfit: profit, expectedProfitEth: base * gas + bid,
    gasUsed: gas, bribeWei: bid, maxBaseFeePerGas: base });
  assert.equal(rejected[0].error, "non_positive_ev_budget"); assert.equal(signs, 3);
  await assert.rejects(buildSignedBackrunTx({ wallet, provider, botvmAddress: "0x" + "22".repeat(20),
    calldataHex: "0x", gasUsed: 100_000, bribeWei: bid, maxBaseFeePerGas: base,
    bribeGasBasis: "measured-gas" }), /positive EV-approved/);
  assert.equal(signs, 3);
} finally {
  globalThis.fetch = oldFetch;
  if (oldSession === undefined) delete process.env.SEARCHER_LIVE_SESSION_PATH;
  else process.env.SEARCHER_LIVE_SESSION_PATH = oldSession;
}
console.log(`submission-fees PASS (${cases} affordability/rounding cases; 99% undiluted, 30% gas buffer, router wiring, negative-EV rejection)`);
