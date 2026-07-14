import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  matchOracleVictimEffect,
  oracleAffectedGraphEdges,
  oracleVictimWatchTargets,
} from "../detector/victim-effect.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const QUOTER = new ethers.Interface([
  "function quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) " +
    "view returns (uint256 amountOut, uint256 fee)",
]);
const FORWARDER = new ethers.Interface(["function forward(address target, bytes data)"]);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function edge(tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "metronome-synth-swap",
    target: ADDR.METRONOME_SYNTH_POOL,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction: "convert",
    ...deriveEdgeTaxonomy("protocol", "convert"),
  };
}

function key(tokenIn: string, tokenOut: string): string {
  return `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
}

function backend(
  quotes: Map<string, bigint>,
  expectedBlock?: number,
): TokenQueryBackend | Pick<StateBackend, "call"> {
  return {
    async call(req: { to: string; data: string; blockTag?: ethers.BlockTag }): Promise<string> {
      assert(req.to.toLowerCase() === ADDR.METRONOME_SYNTH_POOL.toLowerCase(), "probe target");
      if (expectedBlock !== undefined) {
        assert(req.blockTag === expectedBlock, `prestate blockTag ${String(req.blockTag)}`);
      }
      const [tokenIn, tokenOut, amountIn] = QUOTER.decodeFunctionData("quoteSwapOut", req.data);
      assert(BigInt(amountIn) === 10n ** 18n, `probe amount ${String(amountIn)}`);
      const amountOut = quotes.get(key(String(tokenIn), String(tokenOut)));
      if (amountOut === undefined) throw new Error("unexpected pair");
      return QUOTER.encodeFunctionResult("quoteSwapOut", [amountOut, 0n]);
    },
  };
}

async function testOnlyChangedPairsBecomeVictimEdges(): Promise<void> {
  const graph = [
    edge(ADDR.MSETH, ADDR.MSBTC),
    edge(ADDR.MSBTC, ADDR.MSETH),
  ];
  const pre = new Map([
    [key(ADDR.MSETH, ADDR.MSBTC), 100n],
    [key(ADDR.MSBTC, ADDR.MSETH), 200n],
  ]);
  const post = new Map([
    [key(ADDR.MSETH, ADDR.MSBTC), 101n],
    [key(ADDR.MSBTC, ADDR.MSETH), 200n],
  ]);
  const calldata = FORWARDER.encodeFunctionData("forward", [
    ADDR.METRONOME_ORACLE,
    "0xb1dc65a4",
  ]);

  const effect = await matchOracleVictimEffect(
    ADDR.METRONOME_ORACLE_FORWARDER,
    calldata,
    graph,
    backend(pre, 100) as TokenQueryBackend,
    100,
    backend(post) as Pick<StateBackend, "call">,
  );
  assert(effect !== null, "changed oracle quote should admit");
  assert(effect?.priceChanges.length === 1, `changed pairs ${effect?.priceChanges.length}`);
  assert(effect?.priceChanges[0].beforeAmountOut === 100n, "before quote preserved");
  assert(effect?.priceChanges[0].afterAmountOut === 101n, "after quote preserved");
  const affected = effect ? oracleAffectedGraphEdges(graph, effect) : [];
  assert(affected.length === 1, `affected graph edges ${affected.length}`);
  assert(affected[0].tokenIn.toLowerCase() === ADDR.MSETH.toLowerCase(), "exact changed direction");
}

async function testSelectorAloneDoesNotAdmit(): Promise<void> {
  const graph = [edge(ADDR.MSETH, ADDR.MSBTC)];
  const quotes = new Map([[key(ADDR.MSETH, ADDR.MSBTC), 100n]]);
  const calldata = FORWARDER.encodeFunctionData("forward", [
    ADDR.METRONOME_ORACLE,
    "0xb1dc65a4",
  ]);
  const effect = await matchOracleVictimEffect(
    ADDR.METRONOME_ORACLE_FORWARDER,
    calldata,
    graph,
    backend(quotes, 100) as TokenQueryBackend,
    100,
    backend(quotes) as Pick<StateBackend, "call">,
  );
  assert(effect === null, "unchanged quotes must not admit");
}

async function main(): Promise<void> {
  assert(
    oracleVictimWatchTargets().some((target) =>
      target.toLowerCase() === ADDR.METRONOME_ORACLE_FORWARDER.toLowerCase(),
    ),
    "descriptor watch target",
  );
  await testOnlyChangedPairsBecomeVictimEdges();
  await testSelectorAloneDoesNotAdmit();
  console.log("victim-effect PASS (3/3)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
