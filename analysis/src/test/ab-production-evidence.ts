import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  selectProductionSwapWindow,
  validateOnchainExecutionRoute,
  validateOnchainSwapRoute,
  type ProductionRouteStep,
  type UniversePoolFact,
} from "../ab-production-evidence.js";
import type { DecodedSwap } from "../pnl/swap-log-registry.js";
import type { RpcClient } from "../rpc/client.js";

const POOL = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const TOKEN_A = "0x3333333333333333333333333333333333333333";
const TOKEN_B = "0x4444444444444444444444444444444444444444";
const VAULT = "0x5555555555555555555555555555555555555555";
const EXECUTOR = "0x6666666666666666666666666666666666666666";
const CALLER = "0x7777777777777777777777777777777777777777";

test("landed swap route requires factory-backed identity and exact token direction", async () => {
  const route: ProductionRouteStep = {
    adapterId: "univ2-swap",
    slotKind: "swap",
    target: POOL,
    poolId: POOL,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
  };
  const swap: DecodedSwap = {
    txHash: `0x${"1".repeat(64)}`,
    index: 1,
    logIndex: 2,
    direction: "0for1",
    poolId: POOL,
    sizeRaw: 2n,
  };
  const pool: UniversePoolFact = {
    address: POOL,
    adapter: "univ2",
    venueId: "univ2",
    factory: FACTORY,
    identitySource: "factory-call",
    token0: TOKEN_A,
    token1: TOKEN_B,
  };
  const errors: string[] = [];
  await validateOnchainSwapRoute([route], [swap], [pool], {} as RpcClient, "0x1", errors);
  assert.deepEqual(errors, []);

  const missingFactory: string[] = [];
  await validateOnchainSwapRoute(
    [route], [swap], [{ ...pool, factory: undefined }], {} as RpcClient, "0x1", missingFactory,
  );
  assert.match(missingFactory.join("\n"), /factory-backed venue identity/);

  const wrongDirection: string[] = [];
  await validateOnchainSwapRoute(
    [{ ...route, tokenIn: TOKEN_B, tokenOut: TOKEN_A }],
    [swap], [pool], {} as RpcClient, "0x1", wrongDirection,
  );
  assert.match(wrongDirection.join("\n"), /token direction/);
});

test("production swap window excludes a trailing builder-payment swap", () => {
  const poolB = "0x8888888888888888888888888888888888888888";
  const paymentPool = "0x9999999999999999999999999999999999999999";
  const route: ProductionRouteStep[] = [
    {
      adapterId: "univ2-swap", slotKind: "swap", target: POOL, poolId: POOL,
      tokenIn: TOKEN_A, tokenOut: TOKEN_B,
    },
    {
      adapterId: "univ3-swap", slotKind: "swap", target: poolB, poolId: poolB,
      tokenIn: TOKEN_B, tokenOut: TOKEN_A,
    },
  ];
  const swap = (poolId: string, logIndex: number): DecodedSwap => ({
    txHash: `0x${"3".repeat(64)}`,
    index: 1,
    logIndex,
    direction: "0for1",
    poolId,
    sizeRaw: 1n,
  });
  const core = [swap(POOL, 1), swap(poolB, 2)];
  const selected = selectProductionSwapWindow(route, [...core, swap(paymentPool, 3)]);
  assert.deepEqual(selected.errors, []);
  assert.deepEqual(selected.matched, core);

  const ambiguous = selectProductionSwapWindow(route, [...core, ...core]);
  assert.match(ambiguous.errors.join("\n"), /ambiguous/);
  assert.deepEqual(ambiguous.matched, []);

  const interleaved = selectProductionSwapWindow(
    route,
    [core[0], swap(paymentPool, 2), core[1]],
  );
  assert.match(interleaved.errors.join("\n"), /not a contiguous/);
});

test("Curve underlying route is grounded by historical underlying_coins metadata", async () => {
  const route: ProductionRouteStep = {
    adapterId: "curve-exchange-underlying",
    slotKind: "swap",
    target: POOL,
    poolId: POOL,
    tokenIn: TOKEN_B,
    tokenOut: TOKEN_A,
  };
  const swap: DecodedSwap = {
    txHash: `0x${"2".repeat(64)}`,
    index: 1,
    logIndex: 2,
    direction: "1for0",
    poolId: POOL,
    sizeRaw: 2n,
    tokenInIndex: 1,
    tokenOutIndex: 0,
  };
  const pool: UniversePoolFact = {
    address: POOL,
    adapter: "curve-underlying",
    venueId: "curve",
    identitySource: "curve-metaregistry-underlying",
    underlyingCoins: [TOKEN_A, TOKEN_B],
  };
  const iface = new ethers.Interface(["function underlying_coins(int128) view returns (address)"]);
  const rpc = {
    call: async (_method: string, params: Array<{ data: string } | string>) => {
      assert.equal(params[1], "0x123");
      const index = Number(iface.decodeFunctionData("underlying_coins", (params[0] as { data: string }).data)[0]);
      return iface.encodeFunctionResult("underlying_coins", [index === 0 ? TOKEN_A : TOKEN_B]);
    },
  } as RpcClient;
  const errors: string[] = [];
  await validateOnchainSwapRoute([route], [swap], [pool], rpc, "0x123", errors);
  assert.deepEqual(errors, []);

  const staleMetadata: string[] = [];
  await validateOnchainSwapRoute(
    [route],
    [swap],
    [{ ...pool, underlyingCoins: [TOKEN_B, TOKEN_A] }],
    rpc,
    "0x123",
    staleMetadata,
  );
  assert.match(staleMetadata.join("\n"), /token direction/);
});

test("landed protocol route binds adapter selector order and receipt token flow", () => {
  const route: ProductionRouteStep = {
    adapterId: "erc4626-deposit",
    slotKind: "protocol",
    target: VAULT,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
  };
  const trace = call(VAULT, "deposit(uint256,address)");
  const logs = [transfer(TOKEN_A), transfer(TOKEN_B)];
  const errors: string[] = [];
  const matched = validateOnchainExecutionRoute(
    [route], trace, logs, { from: CALLER, to: EXECUTOR }, errors,
  );
  assert.deepEqual(errors, []);
  assert.equal(matched[0]?.target, VAULT);
  assert.equal(matched[0]?.selector, ethers.id("deposit(uint256,address)").slice(0, 10));

  const wrongSelector: string[] = [];
  validateOnchainExecutionRoute(
    [route], call(VAULT, "redeem(uint256,address,address)"), logs,
    { from: CALLER, to: EXECUTOR }, wrongSelector,
  );
  assert.match(wrongSelector.join("\n"), /adapter selector/);

  const privateTarget: string[] = [];
  validateOnchainExecutionRoute(
    [{ ...route, target: EXECUTOR }], call(EXECUTOR, "deposit(uint256,address)"), logs,
    { from: CALLER, to: EXECUTOR }, privateTarget,
  );
  assert.match(privateTarget.join("\n"), /private actor/);

  const missingFlow: string[] = [];
  validateOnchainExecutionRoute(
    [route], trace, [transfer(TOKEN_A)], { from: CALLER, to: EXECUTOR }, missingFlow,
  );
  assert.match(missingFlow.join("\n"), /token flow/);
});

test("landed DEX and protocol calls must match one interleaved execution order", () => {
  const poolB = "0x8888888888888888888888888888888888888888";
  const route: ProductionRouteStep[] = [
    {
      adapterId: "univ2-swap", slotKind: "swap", target: POOL,
      poolId: POOL, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
    },
    {
      adapterId: "erc4626-deposit", slotKind: "protocol", target: VAULT,
      tokenIn: TOKEN_B, tokenOut: TOKEN_A,
    },
    {
      adapterId: "univ3-swap", slotKind: "swap", target: poolB,
      poolId: poolB, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
    },
  ];
  const logs = [transfer(TOKEN_A), transfer(TOKEN_B)];
  const ordered = traceCalls([
    call(POOL, "swap(uint256,uint256,address,bytes)"),
    call(VAULT, "deposit(uint256,address)"),
    call(poolB, "swap(address,bool,int256,uint160,bytes)"),
  ]);
  const errors: string[] = [];
  validateOnchainExecutionRoute(route, ordered, logs, { from: CALLER, to: EXECUTOR }, errors);
  assert.deepEqual(errors, []);

  const splitSubsequenceOnly = traceCalls([
    call(VAULT, "deposit(uint256,address)"),
    call(POOL, "swap(uint256,uint256,address,bytes)"),
    call(poolB, "swap(address,bool,int256,uint160,bytes)"),
  ]);
  const outOfOrder: string[] = [];
  validateOnchainExecutionRoute(
    route, splitSubsequenceOnly, logs, { from: CALLER, to: EXECUTOR }, outOfOrder,
  );
  assert.match(outOfOrder.join("\n"), /absent or out of order/);
});

function call(target: string, signature: string): Record<string, unknown> {
  return {
    type: "CALL",
    to: target,
    input: ethers.id(signature).slice(0, 10),
    calls: [],
  };
}

function traceCalls(calls: Record<string, unknown>[]): Record<string, unknown> {
  return { type: "CALL", to: EXECUTOR, input: "0x12345678", calls };
}

function transfer(token: string): Record<string, unknown> {
  return {
    address: token,
    topics: [
      ethers.id("Transfer(address,address,uint256)"),
      ethers.zeroPadValue(CALLER, 32),
      ethers.zeroPadValue(EXECUTOR, 32),
    ],
    data: ethers.zeroPadValue("0x01", 32),
  };
}
