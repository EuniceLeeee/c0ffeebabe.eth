import { ethers } from "ethers";
import type { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { type TokenEdge, type V4PoolKey, v4PoolId } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { postImpactSupportsStateOverrides } from "../solver/post-impact-overrides.js";
import type { PostImpactSeed } from "../solver/pool-state-cache.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  buildVictimOverlay,
  buildVictimOverlaySettled,
  type VictimOverlay,
} from "../live-backends/victim-overlay.js";
import { replayVictimSwapOnAnvil } from "../live-backends/rpc-victim-replay.js";
import type { PoolImpact } from "../detector/pool-impact.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const TOKEN2 = "0x00000000000000000000000000000000000000c2";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";

const V2_IFACE = new ethers.Interface([
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);
const V3_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const V4_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
]);
const V3_POOL_IFACE = new ethers.Interface([
  "function fee() view returns (uint24)",
]);
const V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const V3_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
]);
const V3_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);
const CURVE_EXCHANGE_IFACE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const CURVE_EXCHANGE_RECEIVED_IFACE = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
]);
const CURVE_EXCHANGE_RECEIVED_UINT_IFACE = new ethers.Interface([
  "function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)",
]);
const CURVE_EXCHANGE_RECEIVED_NR_IFACE = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const ERC20_TRANSFER_IFACE = new ethers.Interface([
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);

const V4_KEY: V4PoolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
};
const V4_POOL_ID = v4PoolId(V4_KEY);

const CURVE_DEFERRED = new Set([
  "curve-exchange",
  "curve-exchange-nr",
  "curve-exchange-plain",
  "curve-exchange-received-uint",
]);

function routedSwapVenues(): string[] {
  return [...new Set(
    PRODUCTION_ADAPTER_FAMILIES.swaps().flatMap((family) =>
      family.edgeAdapterIds
    ),
  )].sort();
}

async function hasCaptureBranch(adapterId: string): Promise<boolean> {
  if (adapterId === "univ2-swap") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]), eventLog(
      V2_IFACE,
      "Swap",
      POOL,
      [SENDER, 10n, 0n, 0n, 9n, RECIPIENT],
    )], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v2PostState !== undefined);
  }

  if (adapterId === "univ3-swap") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      10n,
      -9n,
      1n << 96n,
      123n,
      1,
    ])], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v3PostState !== undefined);
  }

  if (adapterId === "univ4-unlock") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL_MANAGER,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      v4PoolKey: V4_KEY,
      poolId: V4_POOL_ID,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V4_IFACE, "Swap", POOL_MANAGER, [
      V4_POOL_ID,
      SENDER,
      -10n,
      9n,
      1n << 96n,
      123n,
      1,
      3_000,
    ])], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v4PostState !== undefined);
  }

  return false;
}

function seedForAdapter(adapterId: string): PostImpactSeed | null {
  if (adapterId === "univ2-swap") {
    return {
      kind: "v2",
      pool: POOL,
      token0: TOKEN0,
      token1: TOKEN1,
      reserve0: 1n,
      reserve1: 2n,
      feeBps: 30n,
      blockNumber: 1,
    };
  }
  if (adapterId === "univ3-swap") {
    return {
      kind: "v3",
      pool: POOL,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      liquidity: 1n,
      blockNumber: 1,
    };
  }
  if (adapterId === "univ4-unlock") {
    return {
      kind: "v4",
      poolManager: POOL_MANAGER,
      poolId: V4_POOL_ID,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      liquidity: 1n,
      lpFee: 3_000,
      blockNumber: 1,
    };
  }
  return null;
}

function eventLog(iface: ethers.Interface, eventName: string, address: string, args: unknown[]) {
  const fragment = iface.getEvent(eventName);
  assert(fragment !== null, `${eventName} event fragment missing`);
  const encoded = iface.encodeEventLog(fragment, args);
  return {
    address,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

function render(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item}n` : item
  );
}

async function assertOverlayCallbackParity(
  impact: PoolImpact,
  graph: readonly TokenEdge[],
  read: (req: { readonly to: string; readonly data: string }) => Promise<string>,
): Promise<VictimOverlay> {
  const callback = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(impact.matchedAdapterId)
    ?.runtime
    ?.buildOverlay;
  assert(callback !== null && callback !== undefined, `${impact.matchedAdapterId} overlay callback missing`);
  const direct = await callback({
    impact,
    graph,
    read,
    control: {
      deadlineAtMs: Date.now() + 30_000,
      signal: new AbortController().signal,
    },
  });
  const delegated = await buildVictimOverlay(impact, { graph, read });
  assert(
    render(direct) === render(delegated),
    `${impact.matchedAdapterId} central/direct overlay parity`,
  );
  assert(delegated.preCalls.length === 2, `${impact.matchedAdapterId} approve+swap calls`);
  return delegated;
}

async function testOverlayCallbackParity(): Promise<void> {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const noRead = async (): Promise<string> => {
      throw new Error("unexpected overlay read");
    };
    const whale = ethers.getAddress(
      "0x000000000000000000000000000000000000dEaD",
    );
    const v2 = await assertOverlayCallbackParity({
      pool: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: 123n,
      matchedAdapterId: "univ2-swap",
    }, [], noRead);
    assert(v2.preCalls[1].to === V2_ROUTER, "univ2 overlay router parity");
    assert(
      v2.preCalls[1].calldata === V2_ROUTER_IFACE.encodeFunctionData(
        "swapExactTokensForTokens",
        [123n, 0, [TOKEN0, TOKEN1], whale, 1_700_003_600],
      ),
      "univ2 overlay calldata byte parity",
    );

    const v3 = await assertOverlayCallbackParity({
      pool: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: 456n,
      matchedAdapterId: "univ3-swap",
    }, [], async () => V3_POOL_IFACE.encodeFunctionResult("fee", [500]));
    assert(v3.preCalls[1].to === V3_ROUTER, "univ3 overlay router parity");
    assert(
      v3.preCalls[1].calldata === V3_ROUTER_IFACE.encodeFunctionData(
        "exactInputSingle",
        [{
          tokenIn: TOKEN0,
          tokenOut: TOKEN1,
          fee: 500,
          recipient: whale,
          amountIn: 456n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }],
      ),
      "univ3 overlay calldata byte parity",
    );

    const curve = await assertOverlayCallbackParity({
      pool: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN2,
      amountIn: 789n,
      matchedAdapterId: "curve-exchange-plain",
    }, [
      {
        adapterId: "curve-exchange-nr",
        target: POOL,
        tokenIn: TOKEN0,
        tokenOut: TOKEN2,
        curveI: 0,
        curveJ: 9,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      },
      {
        adapterId: "curve-exchange-plain",
        target: POOL,
        tokenIn: TOKEN0,
        tokenOut: TOKEN1,
        curveI: 0,
        curveJ: 1,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      },
      {
        adapterId: "curve-exchange-plain",
        target: POOL,
        tokenIn: TOKEN0,
        tokenOut: TOKEN2,
        curveI: 0,
        curveJ: 2,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      },
    ], noRead);
    assert(
      curve.preCalls[1].to.toLowerCase() === POOL.toLowerCase(),
      "curve overlay target parity",
    );
    assert(
      curve.preCalls[1].calldata === CURVE_EXCHANGE_IFACE.encodeFunctionData(
        "exchange",
        [0, 2, 789n, 0],
      ),
      "curve overlay calldata byte parity for a non-first output coin",
    );

    const receivedCases = [
      {
        adapterId: "curve-exchange",
        calldata: CURVE_EXCHANGE_RECEIVED_IFACE.encodeFunctionData(
          "exchange_received",
          [0, 2, 789n, 0, whale],
        ),
      },
      {
        adapterId: "curve-exchange-received-uint",
        calldata: CURVE_EXCHANGE_RECEIVED_UINT_IFACE.encodeFunctionData(
          "exchange_received",
          [0, 2, 789n, 0, whale],
        ),
      },
      {
        adapterId: "curve-exchange-nr",
        calldata: CURVE_EXCHANGE_RECEIVED_NR_IFACE.encodeFunctionData(
          "exchange_received",
          [0, 2, 789n, 0],
        ),
      },
    ] as const;
    for (const receivedCase of receivedCases) {
      const received = await assertOverlayCallbackParity({
        pool: POOL,
        tokenIn: TOKEN0,
        tokenOut: TOKEN2,
        amountIn: 789n,
        matchedAdapterId: receivedCase.adapterId,
      }, [{
        adapterId: receivedCase.adapterId,
        target: POOL,
        tokenIn: TOKEN0,
        tokenOut: TOKEN2,
        curveI: 0,
        curveJ: 2,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      }], noRead);
      assert(
        received.preCalls[0].to.toLowerCase() === TOKEN0.toLowerCase() &&
          received.preCalls[0].calldata ===
            ERC20_TRANSFER_IFACE.encodeFunctionData("transfer", [POOL, 789n]),
        `${receivedCase.adapterId} must transfer exact input before exchange_received`,
      );
      assert(
        received.preCalls[1].calldata === receivedCase.calldata,
        `${receivedCase.adapterId} exchange_received calldata parity`,
      );
    }
  } finally {
    Date.now = originalNow;
  }
  console.log("[overlay-coverage] registry callback calldata parity: PASS");
}

async function testOverlayFailureIsFamilyLocal(): Promise<void> {
  const badImpact: PoolImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: 1n,
    matchedAdapterId: "univ3-swap",
  };
  const healthyImpact: PoolImpact = {
    ...badImpact,
    matchedAdapterId: "univ2-swap",
  };
  const [bad, healthy] = await Promise.all([
    buildVictimOverlaySettled(badImpact, {
      graph: [],
      read: async () => {
        throw new Error("injected V3 overlay read failure");
      },
    }, 100),
    buildVictimOverlaySettled(healthyImpact, {
      graph: [],
      read: async () => {
        throw new Error("V2 overlay must not read state");
      },
    }, 100),
  ]);
  assert(
    !bad.ok &&
      bad.familyId === "univ3-standard" &&
      bad.stage === "overlay",
    "bad overlay callback must settle against only its owner family",
  );
  assert(
    healthy.ok &&
      healthy.familyId === "univ2-standard" &&
      healthy.value.preCalls.length === 2,
    "healthy sibling overlay must publish despite a bad family callback",
  );
  console.log("[overlay-coverage] family-local callback failure isolation: PASS");
}

async function testRpcReplayRollsBackFamilyFailure(): Promise<void> {
  const reverted: Array<string | number> = [];
  let snapshot = 0;
  let preCall = 0;
  const state = {
    provider: {
      async send(): Promise<null> {
        return null;
      },
    },
    async call(): Promise<string> {
      throw new Error("V2 overlay must not read state");
    },
    async snapshot(): Promise<number> {
      return ++snapshot;
    },
    async revert(id: string | number): Promise<void> {
      reverted.push(id);
    },
    async getTokenBalance(): Promise<bigint> {
      return 1_000_000n;
    },
    async send(): Promise<void> {
      preCall++;
      if (preCall === 2) throw new Error("injected victim swap failure");
    },
  } as unknown as AnvilStateBackend;
  let failed = false;
  try {
    await replayVictimSwapOnAnvil(state, {
      pool: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: 1n,
      matchedAdapterId: "univ2-swap",
    }, []);
  } catch (error) {
    failed =
      error instanceof Error &&
      error.message === "injected victim swap failure";
  }
  assert(failed, "injected victim swap failure must propagate");
  assert(
    reverted.includes(1),
    "failed family replay must restore the outer pre-replay snapshot",
  );
  console.log("[overlay-coverage] RPC family failure rollback: PASS");
}

async function main(): Promise<void> {
  const venues = routedSwapVenues();
  assert(venues.length > 0, "no routed swap venues found in path templates");

  // F8: every production swap family projects an explicit detect-only victim
  // model; victim replay/overlay reproduction is owned by the strict
  // pipeline. The legacy replay callback parity/rollback sections are
  // therefore not exercised against production venues.
  const detectOnly: string[] = [];
  for (const adapterId of venues) {
    const victimModel = PRODUCTION_ADAPTER_FAMILIES.victimModels().forEdge(adapterId);
    assert(victimModel !== null, `victim model missing for active swap edge ${adapterId}`);
    assert(
      victimModel.runtime === null,
      `${adapterId} must be explicit detect-only at F8 (strict replay ownership)`,
    );
    detectOnly.push(adapterId);
  }

  for (const adapterId of detectOnly) {
    console.log(`[overlay-coverage] ${adapterId}: explicit detect-only/fail-closed PASS`);
  }
  console.log(
    `overlay-venue-coverage PASS (` +
      `${detectOnly.length} detect-only, 0 deferred, 0 legacy replay venues)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
