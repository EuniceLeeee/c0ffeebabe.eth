import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildTokenGraphWithResults,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
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
    (_, index): PoolEntry => ({
      ...healthy,
      poolId: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    }),
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

await crossFamilyTimeoutIsIsolated();
await sameFamilyTimeoutDoesNotPoisonSibling();
await sameFamilyThrowDoesNotPoisonSibling();

console.log("token-graph-family-isolation PASS (3/3)");
