import assert from "node:assert/strict";
import { builderPaymentWeiFromPrestate, priceArb } from "../pnl/arb-profit.js";
import type { RpcClient } from "../rpc/client.js";

const COINBASE = "0x1111111111111111111111111111111111111111";
const BOT = "0x2222222222222222222222222222222222222222";
const TX_HASH = "0xf0da00aced3c262990fe30271729c1e7e74164b4bf23bf3494f48bbb036fdbd2";
const PINNED_BUILDER_PAYMENT_WEI = 1_252_000_000_000_000n;

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

async function main(): Promise<void> {
  const syntheticDelta = 42_000_000_000_000n;
  const synthetic = prestateWithCoinbaseDelta(syntheticDelta);
  assert.equal(
    builderPaymentWeiFromPrestate(synthetic.pre, synthetic.post, COINBASE),
    syntheticDelta,
  );

  const pinned = prestateWithCoinbaseDelta(PINNED_BUILDER_PAYMENT_WEI);
  assert.equal(
    builderPaymentWeiFromPrestate(pinned.pre, pinned.post, COINBASE),
    PINNED_BUILDER_PAYMENT_WEI,
  );
  const pinnedEth = Number(PINNED_BUILDER_PAYMENT_WEI) / 1e18;
  assert.ok(Math.abs(pinnedEth - 0.001252) < 1e-12);

  const ethUsd = 1700;
  const rpc = {
    tracePrestate: async (hash: string) => {
      assert.equal(hash, TX_HASH);
      return pinned;
    },
  } as unknown as RpcClient;
  const profit = await priceArb(
    rpc,
    TX_HASH,
    { from: BOT, to: BOT },
    { from: BOT, to: BOT, gasUsed: "0x0", effectiveGasPrice: "0x0", logs: [] },
    ethUsd,
    { entityActors: [BOT], allowTrace: true, coinbase: COINBASE },
  );

  assert.equal(profit.builderPaymentEth, pinnedEth);
  assert.equal(profit.builderPaymentUsd, pinnedEth * ethUsd);

  console.log(`builder_payment_synthetic_delta_wei=${syntheticDelta}`);
  console.log(`builder_payment_pin_tx=${TX_HASH} delta_wei=${PINNED_BUILDER_PAYMENT_WEI} eth=${pinnedEth.toFixed(6)}`);
  console.log("expected_transition: artifact-prone realized_profit_usd -> robust builder_payment floor per tx + aggregate");
  console.log("BUILDER PAYMENT: PASS");
}

await main();
