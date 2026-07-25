import { ethers } from "ethers";
import {
  computeBidEth,
  evaluateEv,
  nextBlockBaseFee,
} from "../ev-evaluator.js";

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SOURCE_BLOCK = 25_599_789;
const SOURCE_BASE_FEE = 71_958_520n;
const LANDED_BASE_FEE = 74_190_952n;
const SOURCE_GAS_USED = 37_445_730n;
const SOURCE_GAS_LIMIT = 60_000_000n;
const HISTORICAL_ETH_USD_8 = 186_911_261_000n;
const HISTORICAL_ROUND_ID = 0x70000000000007c68n;
const HISTORICAL_UPDATED_AT = 0x6a62d5e3n;
const SOURCE_HASH =
  "0xbdaf5f6640f784373f4e6d644e27dd447f0914db43affbe2f9bc16f7e5bb062a";
const SOURCE_TIMESTAMP = 0x6a62d643;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function chainlinkAnswer(
  answer: bigint,
  updatedAt = HISTORICAL_UPDATED_AT,
  roundId = HISTORICAL_ROUND_ID,
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint80", "int256", "uint256", "uint256", "uint80"],
    [roundId, answer, 0x6a62d5cen, updatedAt, roundId],
  );
}

async function verifyCanonicalRpc(
  policy: {
    profitHaircutBps: number;
    evGate: boolean;
    bribeAllAboveGas: boolean;
    bribeBps: number;
  },
): Promise<void> {
  const rpcUrl = process.env.SEARCHER_EV_EVIDENCE_RPC_URL;
  if (!rpcUrl) return;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const evaluation = await evaluateEv(
      provider,
      USDT,
      499_624n,
      1_664_930n,
      policy,
      undefined,
      SOURCE_BLOCK,
    );
    const target = await provider.getBlock(SOURCE_BLOCK + 1);
    assert(evaluation.sourceBlockHash === SOURCE_HASH, "canonical RPC source hash");
    assert(evaluation.ethUsd === 1869.11261, `canonical RPC mark ${evaluation.ethUsd}`);
    assert(
      evaluation.ethUsdRoundId === HISTORICAL_ROUND_ID,
      `canonical RPC round ${evaluation.ethUsdRoundId}`,
    );
    assert(
      evaluation.ethUsdUpdatedAt === HISTORICAL_UPDATED_AT,
      `canonical RPC updatedAt ${evaluation.ethUsdUpdatedAt}`,
    );
    assert(
      target?.baseFeePerGas === evaluation.maxBaseFeePerGas,
      `canonical RPC target fee ${target?.baseFeePerGas}`,
    );
    assert(evaluation.netEvWei > 0n, `canonical RPC retained EV ${evaluation.netEvWei}`);
    console.log("ev-evaluator canonical RPC evidence: PASS");
  } finally {
    await provider.destroy();
  }
}

async function main(): Promise<void> {
  const parent = {
    number: SOURCE_BLOCK,
    hash: SOURCE_HASH,
    timestamp: SOURCE_TIMESTAMP,
    baseFeePerGas: SOURCE_BASE_FEE,
    gasUsed: SOURCE_GAS_USED,
    gasLimit: SOURCE_GAS_LIMIT,
  };
  assert(
    nextBlockBaseFee(parent) === LANDED_BASE_FEE,
    `next base fee ${nextBlockBaseFee(parent)}`,
  );

  let blockReads = 0;
  let oracleReads = 0;
  const provider = {
    async getBlock(tag: "latest" | number) {
      blockReads++;
      assert(tag === SOURCE_BLOCK, `fee block tag ${tag}`);
      return parent;
    },
    async call(transaction: { to: string; data: string; blockTag?: number }) {
      oracleReads++;
      assert(transaction.blockTag === SOURCE_BLOCK, `oracle block tag ${transaction.blockTag}`);
      return chainlinkAnswer(HISTORICAL_ETH_USD_8);
    },
  };
  const policy = {
    profitHaircutBps: 2_000,
    evGate: true,
    bribeAllAboveGas: false,
    bribeBps: 5_000,
  };
  const tx02 = await evaluateEv(
    provider,
    USDT,
    499_624n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  const rawProfitEth = (499_624n * 10n ** 18n) / (10n ** 6n * 1_870n);
  const expectedProfitEth = rawProfitEth * 8_000n / 10_000n;
  const gasCostEth = 1_664_930n * LANDED_BASE_FEE;
  const surplus = expectedProfitEth - gasCostEth;
  const oldRawProfitEth =
    (499_624n * 10n ** 18n) / (10n ** 6n * 3_500n);
  const oldExpectedProfitEth = oldRawProfitEth * 8_000n / 10_000n;
  const oldGasCostEth = 1_664_930n * SOURCE_BASE_FEE * 2n;
  const oldBidEth = oldExpectedProfitEth * 5_000n / 10_000n;
  assert(
    oldExpectedProfitEth - oldGasCostEth - oldBidEth < 0n,
    "old static-price/2x-gas policy must reproduce the tx02 false rejection",
  );
  assert(tx02.ethUsd === 1869.11261, `oracle mark ${tx02.ethUsd}`);
  assert(tx02.ethUsdRoundId === HISTORICAL_ROUND_ID, `oracle round ${tx02.ethUsdRoundId}`);
  assert(tx02.ethUsdUpdatedAt === HISTORICAL_UPDATED_AT, `oracle updatedAt ${tx02.ethUsdUpdatedAt}`);
  assert(tx02.rawProfitEth === rawProfitEth, `raw profit ${tx02.rawProfitEth}`);
  assert(tx02.expectedProfitEth === expectedProfitEth, `haircut ${tx02.expectedProfitEth}`);
  assert(tx02.maxBaseFeePerGas === LANDED_BASE_FEE, `target fee ${tx02.maxBaseFeePerGas}`);
  assert(tx02.sourceBlockHash === SOURCE_HASH, `source hash ${tx02.sourceBlockHash}`);
  assert(tx02.gasCostEth === gasCostEth, `gas ${tx02.gasCostEth}`);
  assert(tx02.bidEth === surplus / 2n, `residual bid ${tx02.bidEth}`);
  assert(tx02.netEvWei === surplus - tx02.bidEth, `retained ${tx02.netEvWei}`);
  assert(tx02.netEvWei > 0n, "real positive tx02 must pass EV");
  assert(blockReads === 2 && oracleReads === 1, "pinned market inputs bracketed by hash reads");

  const negative = await evaluateEv(
    provider,
    USDT,
    250_000n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(negative.netEvWei < 0n, `negative control ${negative.netEvWei}`);

  const missingGas = await evaluateEv(
    provider,
    USDT,
    499_624n,
    0n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(!missingGas.gasMeasurementAvailable, "zero measured gas must fail closed");
  assert(missingGas.gasUnits === 0n, `zero gas units ${missingGas.gasUnits}`);

  const staleOracleProvider = {
    async getBlock(_tag: "latest" | number) {
      return parent;
    },
    async call() {
      throw new Error("oracle unavailable");
    },
  };
  const unpriceable = await evaluateEv(
    staleOracleProvider,
    USDT,
    499_624n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(!unpriceable.valuationAvailable, "missing current oracle must fail closed");
  const noOracleCapability = await evaluateEv(
    { async getBlock() { return parent; } },
    USDT,
    499_624n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(
    !noOracleCapability.valuationAvailable,
    "provider without pinned eth_call must not use a static USD fallback",
  );

  const staleAnswer = await evaluateEv(
    {
      async getBlock() { return parent; },
      async call() {
        return chainlinkAnswer(
          HISTORICAL_ETH_USD_8,
          BigInt(SOURCE_TIMESTAMP - 3_601),
        );
      },
    },
    USDT,
    499_624n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(!staleAnswer.valuationAvailable, "stale Chainlink round must fail closed");

  const weth = await evaluateEv(
    staleOracleProvider,
    WETH,
    10_000n,
    100n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(weth.valuationAvailable, "WETH valuation must not require ETH/USD");

  let reorgRead = 0;
  const reorgProvider = {
    async getBlock(_tag: "latest" | number) {
      reorgRead++;
      return {
        ...parent,
        hash: reorgRead === 1 ? SOURCE_HASH : `0x${"22".repeat(32)}`,
      };
    },
    async call() {
      return chainlinkAnswer(HISTORICAL_ETH_USD_8);
    },
  };
  const reorged = await evaluateEv(
    reorgProvider,
    USDT,
    499_624n,
    1_664_930n,
    policy,
    undefined,
    SOURCE_BLOCK,
  );
  assert(!reorged.feeStateAvailable, "same-height hash change must fail closed");
  assert(reorged.sourceBlockHash === null, "reorged source hash must be cleared");

  assert(
    computeBidEth(100n, 30n, { bribeAllAboveGas: false, bribeBps: 5_000 }) === 35n,
    "percentage bribe must use post-gas surplus",
  );
  assert(
    computeBidEth(100n, 30n, { bribeAllAboveGas: true, bribeBps: 5_000 }) === 70n,
    "all-above mode consumes the full surplus",
  );

  await verifyCanonicalRpc(policy);
  console.log("expected_transition: tx02 old static policy reject -> pinned policy allow");
  console.log("ev-evaluator PASS (10/10)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
