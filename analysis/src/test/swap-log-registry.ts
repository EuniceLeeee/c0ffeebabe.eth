import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { decodeAnySwapLog } from "../pnl/swap-log-registry.js";
import { TOPICS, lower } from "../registry/protocols.js";

const TX_HASH = `0x${"1".repeat(64)}`;
const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const BUYER = "0x3333333333333333333333333333333333333333";
const V2_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const V3_POOL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const V4_POOL_ID = `0x${"c".repeat(64)}`;
const CURVE_POOL = "0xdddddddddddddddddddddddddddddddddddddddd";
const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const BALANCER_POOL_ID = `0x${"e".repeat(64)}`;
const TOKEN_A = "0x0000000000000000000000000000000000000011";
const TOKEN_B = "0x0000000000000000000000000000000000000022";

const V2_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const V4_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const CURVE_SWAP_IFACE = new ethers.Interface([
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought, uint256 fee, uint256 packed_price_scale)",
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
]);
const BALANCER_V2_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
]);

test("decodeAnySwapLog decodes v2/v3/v4/curve/balancer swap logs (both directions)", () => {
  const cases = [
    {
      name: "v2 0for1",
      log: eventLog(V2_POOL, V2_SWAP_IFACE, "Swap", [SENDER, 100n, 0n, 0n, 50n, RECIPIENT]),
      poolId: V2_POOL,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "v2 1for0",
      log: eventLog(V2_POOL, V2_SWAP_IFACE, "Swap", [SENDER, 0n, 100n, 50n, 0n, RECIPIENT]),
      poolId: V2_POOL,
      direction: "1for0",
      sizeRaw: 150n,
    },
    {
      name: "v3 0for1",
      log: eventLog(V3_POOL, V3_SWAP_IFACE, "Swap", [SENDER, RECIPIENT, 100n, -50n, 1n, 1n, 0]),
      poolId: V3_POOL,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "v3 1for0",
      log: eventLog(V3_POOL, V3_SWAP_IFACE, "Swap", [SENDER, RECIPIENT, -50n, 100n, 1n, 1n, 0]),
      poolId: V3_POOL,
      direction: "1for0",
      sizeRaw: 150n,
    },
    {
      name: "v4 0for1",
      log: eventLog(
        "0x000000000004444c5dc75cB358380D2e3dE08A90",
        V4_SWAP_IFACE,
        "Swap",
        [V4_POOL_ID, SENDER, 100n, -50n, 1n, 1n, 0, 3000],
      ),
      poolId: V4_POOL_ID,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "v4 1for0",
      log: eventLog(
        "0x000000000004444c5dc75cB358380D2e3dE08A90",
        V4_SWAP_IFACE,
        "Swap",
        [V4_POOL_ID, SENDER, -50n, 100n, 1n, 1n, 0, 3000],
      ),
      poolId: V4_POOL_ID,
      direction: "1for0",
      sizeRaw: 150n,
    },
    {
      name: "curve 0for1 (sold_id < bought_id)",
      log: eventLog(
        CURVE_POOL,
        CURVE_SWAP_IFACE,
        "TokenExchange(address,int128,uint256,int128,uint256)",
        [BUYER, 0, 100n, 1, 50n],
      ),
      poolId: CURVE_POOL,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "curve 1for0 (sold_id > bought_id)",
      log: eventLog(
        CURVE_POOL,
        CURVE_SWAP_IFACE,
        "TokenExchange(address,int128,uint256,int128,uint256)",
        [BUYER, 1, 100n, 0, 50n],
      ),
      poolId: CURVE_POOL,
      direction: "1for0",
      sizeRaw: 150n,
    },
    {
      name: "curve underlying 0for1",
      log: eventLog(CURVE_POOL, CURVE_SWAP_IFACE, "TokenExchangeUnderlying", [BUYER, 0, 100n, 1, 50n]),
      poolId: CURVE_POOL,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "curve tricrypto 0for1",
      log: eventLog(
        CURVE_POOL,
        CURVE_SWAP_IFACE,
        "TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)",
        [BUYER, 0, 100n, 2, 50n, 1n, 2n],
      ),
      poolId: CURVE_POOL,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "balancer 0for1 (tokenIn < tokenOut)",
      log: eventLog(BALANCER_VAULT, BALANCER_V2_SWAP_IFACE, "Swap", [
        BALANCER_POOL_ID,
        TOKEN_A,
        TOKEN_B,
        100n,
        50n,
      ]),
      poolId: BALANCER_POOL_ID,
      direction: "0for1",
      sizeRaw: 150n,
    },
    {
      name: "balancer 1for0 (tokenIn > tokenOut)",
      log: eventLog(BALANCER_VAULT, BALANCER_V2_SWAP_IFACE, "Swap", [
        BALANCER_POOL_ID,
        TOKEN_B,
        TOKEN_A,
        100n,
        50n,
      ]),
      poolId: BALANCER_POOL_ID,
      direction: "1for0",
      sizeRaw: 150n,
    },
  ];

  for (const item of cases) {
    const decoded = decodeAnySwapLog(item.log);
    assert.ok(decoded, `${item.name} decoded`);
    assert.equal(decoded.poolId, lower(item.poolId), `${item.name} poolId`);
    assert.match(decoded.direction, /^(0for1|1for0)$/, `${item.name} direction shape`);
    assert.equal(decoded.direction, item.direction, `${item.name} direction`);
    assert.equal(decoded.sizeRaw, item.sizeRaw, `${item.name} sizeRaw`);
  }
});

test("decodeAnySwapLog returns null for non-swap logs", () => {
  const decoded = decodeAnySwapLog({
    address: V2_POOL,
    topics: [`0x${"f".repeat(64)}`],
    data: "0x",
    transactionHash: TX_HASH,
    transactionIndex: "0x1",
    logIndex: "0x0",
  });
  assert.equal(decoded, null);
});

test("decodeAnySwapLog returns null for malformed logs without throwing", () => {
  // Missing/empty log shapes.
  assert.equal(decodeAnySwapLog({}), null, "empty object");
  assert.equal(decodeAnySwapLog(null), null, "null log");
  assert.equal(decodeAnySwapLog({ topics: [] }), null, "empty topics");

  // Valid swap topic but truncated/empty data -> parse failure -> null (per venue).
  const truncated = (topic: string, extraTopics: string[] = []) => ({
    address: V2_POOL,
    topics: [topic, ...extraTopics],
    data: "0x",
    transactionHash: TX_HASH,
    transactionIndex: "0x1",
    logIndex: "0x0",
  });
  const pad = (addr: string) => ethers.zeroPadValue(addr, 32);
  assert.equal(decodeAnySwapLog(truncated(TOPICS.univ2Swap, [pad(SENDER), pad(RECIPIENT)])), null, "v2 truncated data");
  assert.equal(decodeAnySwapLog(truncated(TOPICS.univ3Swap, [pad(SENDER), pad(RECIPIENT)])), null, "v3 truncated data");
  assert.equal(decodeAnySwapLog(truncated(TOPICS.univ4Swap, [V4_POOL_ID, pad(SENDER)])), null, "v4 truncated data");
  assert.equal(decodeAnySwapLog(truncated(TOPICS.curveTokenExchange, [pad(BUYER)])), null, "curve truncated data");
  assert.equal(decodeAnySwapLog(truncated(TOPICS.curveCryptoTokenExchange, [pad(BUYER)])), null, "curve crypto truncated data");
  assert.equal(
    decodeAnySwapLog(truncated(TOPICS.balancerV2Swap, [BALANCER_POOL_ID, pad(TOKEN_A), pad(TOKEN_B)])),
    null,
    "balancer truncated data",
  );

  // Valid event encoding but missing tx metadata -> baseSwapFields rejects -> null.
  const encoded = V3_SWAP_IFACE.encodeEventLog(V3_SWAP_IFACE.getEvent("Swap")!, [
    SENDER,
    RECIPIENT,
    100n,
    -50n,
    1n,
    1n,
    0,
  ]);
  assert.equal(
    decodeAnySwapLog({ address: V3_POOL, topics: encoded.topics, data: encoded.data }),
    null,
    "missing transactionHash/transactionIndex",
  );
});

function eventLog(address: string, iface: ethers.Interface, eventName: string, args: unknown[]): any {
  const event = iface.getEvent(eventName)!;
  const encoded = iface.encodeEventLog(event, args);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: TX_HASH,
    transactionIndex: "0x1",
    logIndex: "0x0",
  };
}
