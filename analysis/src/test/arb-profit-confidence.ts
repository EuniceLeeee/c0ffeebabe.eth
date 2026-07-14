import assert from "node:assert/strict";
import test from "node:test";
import { priceArb } from "../pnl/arb-profit.js";
import { ADDR, TOPICS, lower } from "../registry/protocols.js";
import type { RpcClient } from "../rpc/client.js";

const EOA = "0x1000000000000000000000000000000000000001";
const BOT = "0x2000000000000000000000000000000000000002";
const AUX = "0x3000000000000000000000000000000000000003";
const EXTERNAL = "0x4000000000000000000000000000000000000004";
const COINBASE = "0x5000000000000000000000000000000000000005";
const ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
const UNKNOWN = "0x6000000000000000000000000000000000000006";
const TX_HASH = `0x${"ab".repeat(32)}`;
const GAS_USED = 100n;
const GAS_PRICE = 2n;
const BASE_FEE = 1n;
const GAS_WEI = GAS_USED * GAS_PRICE;

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function topicAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function transfer(token: string, from: string, to: string, amount: bigint, logIndex: number) {
  return {
    address: token,
    logIndex,
    topics: [TOPICS.transfer, topicAddress(from), topicAddress(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}

function withdrawal(actor: string, amount: bigint, logIndex: number) {
  return {
    address: ADDR.WETH,
    logIndex,
    topics: [TOPICS.wethWithdrawal, topicAddress(actor)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}

type Balances = Record<string, bigint>;

function prestate(preBalances: Balances, deltas: Balances) {
  const pre: Record<string, { balance: string }> = {};
  const post: Record<string, { balance: string }> = {};
  for (const address of new Set([...Object.keys(preBalances), ...Object.keys(deltas)])) {
    const key = lower(address);
    const before = preBalances[key] ?? 0n;
    pre[key] = { balance: hex(before) };
    post[key] = { balance: hex(before + (deltas[key] ?? 0n)) };
  }
  return { pre, post };
}

async function price(input: {
  beneficiary?: string;
  actors?: string[];
  logs?: unknown[];
  trace?: { pre: Record<string, unknown>; post: Record<string, unknown> } | Error;
  callTrace?: unknown | Error;
}) {
  const rpc = {
    tracePrestate: async () => {
      if (input.trace instanceof Error) throw input.trace;
      return input.trace ?? { pre: {}, post: {} };
    },
    traceTransaction: async () => {
      if (input.callTrace instanceof Error) throw input.callTrace;
      if (input.callTrace === undefined) throw new Error("callTracer unavailable");
      return input.callTrace;
    },
  } as unknown as RpcClient;
  const beneficiary = input.beneficiary ?? BOT;
  return priceArb(
    rpc,
    TX_HASH,
    { from: EOA, to: beneficiary },
    {
      from: EOA,
      to: beneficiary,
      gasUsed: hex(GAS_USED),
      effectiveGasPrice: hex(GAS_PRICE),
      logs: input.logs ?? [],
    },
    1e18,
    {
      entityActors: input.actors ?? [EOA, BOT],
      allowTrace: true,
      coinbase: COINBASE,
      baseFeePerGas: BASE_FEE,
    },
  );
}

test("fully unwrapped native-only profit has high confidence", async () => {
  const amount = 1_000n;
  const trace = prestate(
    { [lower(EOA)]: 10_000n, [lower(BOT)]: 10_000n },
    { [lower(EOA)]: -GAS_WEI, [lower(BOT)]: amount },
  );
  const result = await price({
    trace,
    logs: [
      transfer(ADDR.WETH, EXTERNAL, BOT, amount, 0),
      withdrawal(BOT, amount, 1),
    ],
  });
  assert.equal(result.erc20Usd, null);
  assert.deepEqual(result.unpricedDeltas, []);
  assert.equal(result.ethDeltaEth, Number(amount) / 1e18);
  assert.equal(result.profitConfidence, "high");
});

test("public router remains unsafe even with an exact native trace", async () => {
  const trace = prestate(
    { [lower(EOA)]: 10_000n, [lower(ROUTER)]: 10_000n },
    { [lower(EOA)]: -GAS_WEI, [lower(ROUTER)]: 1_000n },
  );
  const result = await price({ beneficiary: ROUTER, actors: [EOA, ROUTER], trace });
  assert.equal(result.profitConfidence, "unsafe");
});

test("unknown ERC20 residue is not upgraded by native profit", async () => {
  const trace = prestate(
    { [lower(EOA)]: 10_000n, [lower(BOT)]: 10_000n },
    { [lower(EOA)]: -GAS_WEI, [lower(BOT)]: 1_000n },
  );
  const result = await price({ trace, logs: [transfer(UNKNOWN, EXTERNAL, BOT, 1n, 0)] });
  assert.equal(result.unpricedDeltas.length, 1);
  assert.equal(result.profitConfidence, "requires_decode");
});

test("failed and zero native traces remain decode-gated", async () => {
  const failed = await price({ trace: new Error("trace unavailable") });
  assert.equal(failed.profitConfidence, "requires_decode");

  const zero = await price({
    trace: prestate({ [lower(EOA)]: 10_000n }, { [lower(EOA)]: -GAS_WEI }),
  });
  assert.equal(zero.nativeTraceUsed, true);
  assert.equal(zero.ethDeltaEth, 0);
  assert.equal(zero.profitConfidence, "requires_decode");
});

test("native transfers within the entity cancel instead of creating profit", async () => {
  const trace = prestate(
    { [lower(EOA)]: 10_000n, [lower(BOT)]: 10_000n, [lower(AUX)]: 10_000n },
    { [lower(EOA)]: -GAS_WEI, [lower(BOT)]: 1_000n, [lower(AUX)]: -1_000n },
  );
  const result = await price({ actors: [EOA, BOT, AUX, BOT], trace });
  assert.equal(result.ethDeltaEth, 0);
  assert.equal(result.profitConfidence, "requires_decode");
});

test("gas and direct coinbase payment are each accounted once", async () => {
  const gross = 5_000n;
  const direct = 300n;
  const trace = prestate(
    {
      [lower(EOA)]: 10_000n,
      [lower(BOT)]: 10_000n,
      [lower(COINBASE)]: 10_000n,
    },
    {
      [lower(EOA)]: -GAS_WEI,
      [lower(BOT)]: gross - direct,
      [lower(COINBASE)]: direct,
    },
  );
  const result = await price({
    trace,
    callTrace: {
      to: BOT,
      value: "0x0",
      calls: [{ from: BOT, to: COINBASE, value: hex(direct), calls: [] }],
    },
  });
  const expectedRealized = Number(gross - direct) / 1e18 * 1e18;
  const expectedGas = Number(GAS_WEI) / 1e18 * 1e18;
  const expectedBuilder = Number(GAS_USED * (GAS_PRICE - BASE_FEE) + direct) / 1e18 * 1e18;
  assert.equal(result.realizedProfitUsd, expectedRealized);
  assert.equal(result.gasCostUsd, expectedGas);
  assert.equal(result.netProfitUsd, expectedRealized - expectedGas);
  assert.equal(result.builderPaymentUsd, expectedBuilder);
  assert.equal(result.profitConfidence, "high");
});

test("callTracer separates a direct builder payment from a prestate delta that includes the tip", async () => {
  const gross = 5_000n;
  const direct = 300n;
  const priorityTip = GAS_USED * (GAS_PRICE - BASE_FEE);
  const trace = prestate(
    {
      [lower(EOA)]: 10_000n,
      [lower(BOT)]: 10_000n,
      [lower(COINBASE)]: 10_000n,
    },
    {
      [lower(EOA)]: -GAS_WEI,
      [lower(BOT)]: gross - direct,
      // Current reth prestateTracer includes both the explicit transfer and the priority tip.
      [lower(COINBASE)]: direct + priorityTip,
    },
  );
  const result = await price({
    trace,
    callTrace: {
      to: BOT,
      value: "0x0",
      calls: [{ from: BOT, to: COINBASE, value: hex(direct), calls: [] }],
    },
  });

  assert.equal(result.coinbaseTransferWei, direct);
  assert.equal(result.builderPaymentUsd, Number(direct + priorityTip));
  assert.equal(result.positionEthDeltaEth, Number(gross) / 1e18);
  assert.equal(result.ethDeltaEth, Number(gross - direct) / 1e18);
});

test("callTracer failure does not reinterpret an ambiguous coinbase prestate delta", async () => {
  const gross = 5_000n;
  const direct = 300n;
  const priorityTip = GAS_USED * (GAS_PRICE - BASE_FEE);
  const trace = prestate(
    {
      [lower(EOA)]: 10_000n,
      [lower(BOT)]: 10_000n,
      [lower(COINBASE)]: 10_000n,
    },
    {
      [lower(EOA)]: -GAS_WEI,
      [lower(BOT)]: gross - direct,
      [lower(COINBASE)]: direct + priorityTip,
    },
  );
  const result = await price({ trace, callTrace: new Error("callTracer unavailable") });

  assert.equal(result.coinbaseTransferWei, null);
  assert.equal(result.builderPaymentUsd, Number(priorityTip));
  assert.equal(result.positionEthDeltaEth, result.ethDeltaEth);
});
