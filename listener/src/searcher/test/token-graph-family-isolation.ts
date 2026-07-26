import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildTokenGraphWithResults,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { quoteCurvePlain } from "../venues/swaps/curve-shared.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const currency0 = ethers.getAddress(
  "0x0000000000000000000000000000000000001010",
);
const currency1 = ethers.getAddress(
  "0x0000000000000000000000000000000000002020",
);
const hooks = ethers.ZeroAddress;
const fee = 500;
const tickSpacing = 10;
const healthy: PoolEntry = {
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  adapter: "univ4",
  poolId: v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }),
  currency0,
  currency1,
  fixedTokenIn: currency0,
  fixedTokenOut: currency1,
  fee,
  tickSpacing,
  hooks,
};

async function crossFamilyTimeoutIsIsolated(): Promise<void> {
  const neverSettling: PoolEntry = {
    address: ethers.getAddress(
      "0x0000000000000000000000000000000000003030",
    ),
    adapter: "balancer-v3",
  };
  let instanceSignal: AbortSignal | undefined;
  const backend: TokenQueryBackend = {
    call(_req, control) {
      instanceSignal = control?.signal;
      return new Promise<string>(() => {});
    },
  };

  const startedAt = Date.now();
  const result = await buildTokenGraphWithResults(
    backend,
    [neverSettling, healthy],
    { quiet: true, familyTimeoutMs: 20 },
  );
  const elapsedMs = Date.now() - startedAt;

  assert(elapsedMs < 500, `never-settling family blocked graph for ${elapsedMs}ms`);
  assert(
    result.successful.some((item) => item.pool === healthy),
    "healthy family must publish in the same batch",
  );
  assert(
    result.failed.some((item) => item.pool === neverSettling),
    "timed-out instance must fail locally",
  );
  assert(
    instanceSignal?.aborted === true,
    `instance transport signal must be aborted; failures=${result.failed
      .map((item) => `${item.pool.adapter}:${item.reason}`)
      .join("|")}`,
  );
}

async function sameFamilyTimeoutDoesNotPoisonSibling(): Promise<void> {
  const slow: PoolEntry = {
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    adapter: "univ4",
    poolId: `0x${"ab".repeat(32)}`,
    fixedTokenIn: currency0,
    fixedTokenOut: currency1,
  };
  // Batch size is 50. Put one healthy sibling in the next batch to prove an
  // earlier instance timeout is not remembered as a family-wide failure.
  const siblings = Array.from(
    { length: 50 },
    (_, index): PoolEntry => {
      const siblingFee = fee + index + 1;
      return {
        ...healthy,
        fee: siblingFee,
        poolId: v4PoolId({
          currency0,
          currency1,
          fee: siblingFee,
          tickSpacing,
          hooks,
        }),
      };
    },
  );
  const lastSibling = siblings.at(-1)!;
  let slowSignal: AbortSignal | undefined;
  const backend: TokenQueryBackend = {
    call() {
      throw new Error("inline V4 siblings must not issue eth_call");
    },
    getLogs(_req, control) {
      slowSignal = control?.signal;
      return new Promise(() => {});
    },
  };

  const result = await buildTokenGraphWithResults(
    backend,
    [slow, ...siblings],
    { quiet: true, familyTimeoutMs: 20 },
  );
  assert(
    result.failed.length === 1 && result.failed[0]?.pool === slow,
    `only the slow instance may fail: ${result.failed
      .map((item) => `${item.pool.adapter}:${item.reason}`)
      .join("|")}`,
  );
  assert(
    result.successful.length === siblings.length,
    `expected ${siblings.length} healthy same-family instances, got ${result.successful.length}`,
  );
  assert(
    result.successful.some((item) => item.pool === lastSibling),
    "same-family sibling in the next batch must remain eligible",
  );
  assert(
    slowSignal?.aborted === true,
    "timed-out instance transport must receive its own abort",
  );
}

async function sameFamilyThrowDoesNotPoisonSibling(): Promise<void> {
  const throwing: PoolEntry = {
    ...healthy,
    poolId: `0x${"cd".repeat(32)}`,
    fixedTokenIn: undefined,
  };
  const sibling: PoolEntry = { ...healthy };
  const backend: TokenQueryBackend = {
    call() {
      throw new Error("inline V4 graph construction must not issue eth_call");
    },
  };
  const result = await buildTokenGraphWithResults(
    backend,
    [throwing, sibling],
    { quiet: true, familyTimeoutMs: 20 },
  );
  assert(
    result.failed.length === 1 && result.failed[0]?.pool === throwing,
    "one malformed instance must remain an instance-local failure",
  );
  assert(
    result.successful.length === 1 && result.successful[0]?.pool === sibling,
    "a healthy sibling in the same family must still publish",
  );
}

async function curveOversizedReturndataUsesFirstAbiWord(): Promise<void> {
  const pool = ethers.getAddress(
    "0x0000000000000000000000000000000000004040",
  );
  const token0 = ethers.getAddress(
    "0x0000000000000000000000000000000000004041",
  );
  const token1 = ethers.getAddress(
    "0x0000000000000000000000000000000000004042",
  );
  const quotedOut = 123456789n;
  const curve = new ethers.Interface([
    "function coins(uint256 i) view returns (address)",
    "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  ]);
  const zeroTail = "00".repeat(4_096 - 32);
  const backend: TokenQueryBackend = {
    async call(req) {
      const selector = req.data.slice(0, 10);
      if (selector === curve.getFunction("coins")!.selector) {
        const index = Number(
          curve.decodeFunctionData("coins", req.data)[0],
        );
        const coin = index === 0
          ? token0
          : index === 1
            ? token1
            : ethers.ZeroAddress;
        return `${curve.encodeFunctionResult("coins", [coin])}${zeroTail}`;
      }
      if (selector === curve.getFunction("get_dy")!.selector) {
        return `${curve.encodeFunctionResult("get_dy", [quotedOut])}${zeroTail}`;
      }
      throw new Error(`unexpected Curve selector ${selector}`);
    },
  };

  const result = await buildTokenGraphWithResults(
    backend,
    [{ address: pool, adapter: "curve" }],
    { quiet: true },
  );
  assert(result.failed.length === 0, `Curve build failed: ${result.failed[0]?.reason}`);
  assert(result.edges.length === 2, `expected two Curve edges, got ${result.edges.length}`);
  const amountOut = await quoteCurvePlain(
    backend,
    pool,
    token0,
    token1,
    1_000_000n,
  );
  assert(
    amountOut === quotedOut,
    `oversized Curve quote decoded ${amountOut}, expected ${quotedOut}`,
  );
}

async function abortDuringPromiseConstructionIsHandled(): Promise<void> {
  const parent = new AbortController();
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const backend: TokenQueryBackend = {
      call() {
        parent.abort(new Error("abort during Curve read construction"));
        return Promise.reject(new Error("underlying Curve read rejection"));
      },
    };
    const result = await buildTokenGraphWithResults(
      backend,
      [{
        address: ethers.getAddress(
          "0x0000000000000000000000000000000000005050",
        ),
        adapter: "curve",
      }],
      {
        quiet: true,
        signal: parent.signal,
        familyTimeoutMs: 5_000,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(result.successful.length === 0, "aborted Curve build must not publish");
    assert(result.failed.length === 1, "aborted Curve build must fail locally");
    assert(
      unhandled === undefined,
      `controlled abort leaked unhandled rejection: ${String(unhandled)}`,
    );
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

await crossFamilyTimeoutIsIsolated();
await sameFamilyTimeoutDoesNotPoisonSibling();
await sameFamilyThrowDoesNotPoisonSibling();
await curveOversizedReturndataUsesFirstAbiWord();
await abortDuringPromiseConstructionIsHandled();

console.log("token-graph-family-isolation PASS (5/5)");
