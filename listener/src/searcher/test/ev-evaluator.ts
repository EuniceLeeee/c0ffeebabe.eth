import { evaluateEv } from "../ev-evaluator.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main(): Promise<void> {
  let reads = 0;
  const provider = {
    async getBlock(_tag: "latest") {
      reads++;
      return { baseFeePerGas: 20n };
    },
  };
  const policy = {
    ethUsd: 3_500,
    profitHaircutBps: 2_000,
    defaultGasUsed: 100,
    gasBufferMultX10: 20,
    evGate: true,
    bribeAllAboveGas: false,
    bribeBps: 5_000,
  };
  const result = await evaluateEv(
    provider,
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    10_000n,
    0n,
    policy,
  );
  assert(result.rawProfitEth === 10_000n, `raw profit ${result.rawProfitEth}`);
  assert(result.expectedProfitEth === 8_000n, `haircut profit ${result.expectedProfitEth}`);
  assert(result.gasUnits === 100n, `fallback gas ${result.gasUnits}`);
  assert(result.gasCostEth === 4_000n, `buffered gas ${result.gasCostEth}`);
  assert(result.bidEth === 4_000n, `bid ${result.bidEth}`);
  assert(result.netEvWei === 0n, `net EV ${result.netEvWei}`);
  assert(reads === 1, `base fee reads ${reads}`);

  const noCost = await evaluateEv(provider, "0x1", 10_000n, 25n, {
    ...policy,
    evGate: false,
    bribeAllAboveGas: false,
  });
  assert(noCost.gasUnits === 25n, "measured gas should win");
  assert(noCost.gasCostEth === 0n, "disabled policy should skip gas cost");
  assert(reads === 1, "disabled policy should not read base fee");
  console.log("ev-evaluator PASS (2/2)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
