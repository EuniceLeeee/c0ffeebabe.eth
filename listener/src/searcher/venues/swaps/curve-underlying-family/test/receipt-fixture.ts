import { ethers } from "ethers";
import type { TokenEdge } from "../../../../planner/token-graph.js";
import type { ReceiptSwapObservationContext, SwapEventLog } from "../../../swap-observation.js";
import { CURVE_UNDERLYING_META_INTERFACE } from "../codec.js";

// Two verbatim Graph edges, not hand-built successful admission objects.
// Source: logs/curve-underlying-ready-25921060.yYm55R/checkpoint.json
// SHA256: 71bfc3126ec2575578ede7849f68db2aad76d1ab27da79b7bd32ff78dd877183
// Tx: 0xd89e6c07b1bbef7c180cf0200042c2611295077dcfce85ed779dd3aa98fef71f
// Events and query responses below are synthetic regression inputs, NOT replay.
export const ARCHIVED_EDGES: readonly TokenEdge[] = JSON.parse(String.raw`[
  {
    "instanceKey": "0xd632f22692fac7611d2aa1c0d552930d43caed3b",
    "executionVariantKey": "efd61cbf9b4f6eccd0bd980693b8b5458a51ea9ebe8d4d1d79e3ef6317dca826",
    "adapterId": "curve-exchange-underlying",
    "target": "0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B",
    "tokenIn": "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    "tokenOut": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "slotKind": "swap",
    "edgeKind": "swap",
    "leavesStandingPosition": false,
    "score": 0,
    "canonicalEdgeId": "curve-underlying\u001f0xd632f22692fac7611d2aa1c0d552930d43caed3b\u001f0xd632f22692fac7611d2aa1c0d552930d43caed3b\u001f0x853d955acef822db058eb8505911ed77f175b99e>0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\u001fefd61cbf9b4f6eccd0bd980693b8b5458a51ea9ebe8d4d1d79e3ef6317dca826"
  },
  {
    "instanceKey": "0xd632f22692fac7611d2aa1c0d552930d43caed3b",
    "executionVariantKey": "7814447d3e56fd1757366022dc573a5b91ea137164e268c0b22f3115a16e9289",
    "adapterId": "curve-exchange-underlying",
    "target": "0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B",
    "tokenIn": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "tokenOut": "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    "slotKind": "swap",
    "edgeKind": "swap",
    "leavesStandingPosition": false,
    "score": 0,
    "canonicalEdgeId": "curve-underlying\u001f0xd632f22692fac7611d2aa1c0d552930d43caed3b\u001f0xd632f22692fac7611d2aa1c0d552930d43caed3b\u001f0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48>0x853d955acef822db058eb8505911ed77f175b99e\u001f7814447d3e56fd1757366022dc573a5b91ea137164e268c0b22f3115a16e9289"
  }
]`);
export const POOL = ARCHIVED_EDGES[0].target;
export const SOURCE = { number: 25921060, generation: 25921060,
  hash: "0x1d2923997f4052772f2921259ccf8a71fe90421d917339eb2d988ba0f6db5c62" };
export const COINS = [ARCHIVED_EDGES[0].tokenIn, "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  ARCHIVED_EDGES[0].tokenOut, "0xdAC17F958D2ee523a2206206994597C13D831ec7"];
export function coinData(coins: readonly string[] = COINS): string {
  return CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult("get_underlying_coins",
    [[...coins, ...Array<string>(8 - coins.length).fill(ethers.ZeroAddress)]]);
}
export function swapLog(indexType: "int128" | "uint256" = "int128", i = 2n, j = 0n,
  amountIn = 123n, amountOut = 120n): SwapEventLog {
  const iface = new ethers.Interface([
    `event TokenExchangeUnderlying(address indexed buyer, ${indexType} sold_id, uint256 tokens_sold, ${indexType} bought_id, uint256 tokens_bought)`,
  ]);
  return { address: POOL, ...iface.encodeEventLog(iface.getEvent("TokenExchangeUnderlying")!,
    [ethers.ZeroAddress, i, amountIn, j, amountOut]) };
}
export function context(logs: readonly SwapEventLog[] = [swapLog()]): ReceiptSwapObservationContext {
  return { logs, graph: ARCHIVED_EDGES, edgesByTarget: new Map(),
    sourceGeneration: { id: "synthetic-regression", sourceBlock: SOURCE.number, sourceBlockHash: SOURCE.hash,
      receiptId: "synthetic-regression", receiptBlockNumber: null, receiptBlockHash: null,
      receiptParentBlockHash: null, receiptTransactionHash: null, logsCompleteness: "fragment" },
    matchedOwnedTriggers: logs.map((log, logIndex) => ({ triggerId: `trigger:${logIndex}`, logIndex,
      emitter: log.address, topic0: log.topics[0] })),
    tokenQuery: { call: async () => coinData() },
    control: { deadlineAtMs: Date.now() + 10_000, signal: new AbortController().signal },
  };
}
