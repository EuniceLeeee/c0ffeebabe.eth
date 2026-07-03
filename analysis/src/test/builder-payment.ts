import assert from "node:assert/strict";
import { builderPaymentWeiFromPrestate, priceArb } from "../pnl/arb-profit.js";
import type { RpcClient } from "../rpc/client.js";

const COINBASE = "0x1111111111111111111111111111111111111111";
const BOT = "0x2222222222222222222222222222222222222222";
// Real on-chain numbers for coffeebabe tx 0xf0da00…d4b606 (block 25449187), hand-verified this
// session: builder payment ≈ priority-fee tip = 0.001252 ETH ($2.13), coinbase direct-transfer ≈ 0.
const TX_HASH = "0xf0da00aced3c262990fe30271729c1e7e74164b4bf23bf3494f48bbb036fdbd2";
const GAS_USED = 397915n;
const EFF_GAS_PRICE = 3218617227n;
const BASE_FEE = 71849181n;
const PRIORITY_TIP_WEI = GAS_USED * (EFF_GAS_PRICE - BASE_FEE); // = 1_252_000_000_000_000-ish

function hex(n: bigint): string {
  return `0x${n.toString(16)}`;
}

function prestateWithCoinbaseDelta(deltaWei: bigint): {
  pre: Record<string, any>;
  post: Record<string, any>;
} {
  const preBalance = 100n;
  return {
    pre: { [COINBASE]: { balance: hex(preBalance) } },
    post: { [COINBASE]: { balance: hex(preBalance + deltaWei) } },
  };
}

async function priceWith(prestate: { pre: any; post: any }, baseFeePerGas: bigint | undefined) {
  const rpc = {
    tracePrestate: async (hash: string) => {
      assert.equal(hash, TX_HASH);
      return prestate;
    },
  } as unknown as RpcClient;
  return priceArb(
    rpc,
    TX_HASH,
    { from: BOT, to: BOT },
    { from: BOT, to: BOT, gasUsed: hex(GAS_USED), effectiveGasPrice: hex(EFF_GAS_PRICE), logs: [] },
    1700,
    { entityActors: [BOT], allowTrace: true, coinbase: COINBASE, baseFeePerGas },
  );
}

async function main(): Promise<void> {
  // 1. Direct-coinbase-transfer helper (prestate delta) is unchanged.
  const syntheticDelta = 42_000_000_000_000n;
  const synthetic = prestateWithCoinbaseDelta(syntheticDelta);
  assert.equal(builderPaymentWeiFromPrestate(synthetic.pre, synthetic.post, COINBASE), syntheticDelta);

  // 2. PIN: real 0xf0da00 gas + baseFee, coinbase direct-transfer = 0 → builder_payment == priority tip.
  //    This is the corrected semantics: the prestate coinbase delta on our reth EXCLUDES the priority
  //    fee, so builder_payment MUST add the gas-derived tip (else it undercounts ~100x, the bug the
  //    node re-measure caught: $0.15 total across 11 txs vs this one tx's $2.13 tip).
  const tipOnly = await priceWith(prestateWithCoinbaseDelta(0n), BASE_FEE);
  const tipEth = Number(PRIORITY_TIP_WEI) / 1e18;
  assert.equal(tipOnly.builderPaymentEth, tipEth);
  assert.ok(Math.abs(tipEth - 0.001252) < 1e-6, `priority tip ${tipEth} ≈ 0.001252 ETH`);

  // 3. COMBINED: priority tip + a direct coinbase transfer sum.
  const directTransfer = 5_000_000_000_000n;
  const combined = await priceWith(prestateWithCoinbaseDelta(directTransfer), BASE_FEE);
  assert.equal(combined.builderPaymentEth, Number(PRIORITY_TIP_WEI + directTransfer) / 1e18);

  // 4. No baseFee available → builder_payment falls back to direct-transfer component only.
  const noBaseFee = await priceWith(prestateWithCoinbaseDelta(directTransfer), undefined);
  assert.equal(noBaseFee.builderPaymentEth, Number(directTransfer) / 1e18);

  console.log(`builder_payment_priority_tip_eth=${tipEth.toFixed(6)} (pin 0xf0da00 = $2.13)`);
  console.log(`builder_payment_combined_wei=${PRIORITY_TIP_WEI + directTransfer}`);
  console.log("expected_transition: coinbase-delta-only (undercounts ~100x) -> priority-tip + direct coinbase transfer");
  console.log("BUILDER PAYMENT: PASS");
}

await main();
