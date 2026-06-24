import { ethers } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  LiveStateBackend,
  PrepareInput,
  PreparedState,
  QuoteRequest,
  QuoteResult,
} from "../live-state-backend.js";
import { RevmSimClient, type OverlayPreCall, type TokenBalanceHint } from "../revm-sim-client.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { buildVictimOverlay, overlaySupportsAdapter } from "./victim-overlay.js";

const UNIV3_FEE_IFACE = new ethers.Interface(["function fee() view returns (uint24)"]);
const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WHALE = "0x000000000000000000000000000000000000dEaD";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const CURVE_INT_IFACE = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const CURVE_UINT_IFACE = new ethers.Interface([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);
const UNIV2_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
]);
const UNIV3_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const V4_V3_FALLBACK: Record<string, string> = {
  [`${ADDR.DAI.toLowerCase()}-${ADDR.USDT.toLowerCase()}`]: ADDR.UNISWAP_V3_USDC_USDT_100,
  [`${ADDR.USDC.toLowerCase()}-${ADDR.USDT.toLowerCase()}`]: ADDR.UNISWAP_V3_USDC_USDT_100,
};

/**
 * revm-backed live backend.
 *
 * `prepareVictimState` reconstructs the victim's pool impact as a revm overlay
 * (deal whale → approve → swap) on top of pre-victim chain state read at
 * `baseBlock`, then asks the daemon to hold that prepared state warm. `simulate`
 * runs the BotVM arb against the prepared (shifted) state — equivalent to the
 * Anvil impersonateSwap path, but in-process and with a persistent warm cache.
 *
 * Only the hash-only path is supported here (the dominant live case and the one
 * that was expiring). rawTx/mined fall back to RPC/Anvil via the caller.
 */
export class RevmLiveBackend implements LiveStateBackend {
  readonly kind = "revm" as const;
  private preparedBlock: number | null = null;
  private readonly feeCache = new Map<string, number>();

  constructor(
    private readonly client: RevmSimClient,
    readonly executor: string,
    private readonly owner: string,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly graph: TokenEdge[],
    private readonly rpcUrl: string,
  ) {}

  supportsPath(input: PrepareInput): boolean {
    return (
      input.path === "hash-only" &&
      input.impact !== null &&
      overlaySupportsAdapter(input.impact.matchedAdapterId)
    );
  }

  async prepareVictimState(input: PrepareInput): Promise<PreparedState> {
    if (input.path === "mined") {
      // The victim is already included in the mined block's post-state, so read
      // chain state directly at that block with no overlay.
      await this.client.prepare({
        blockNumber: input.baseBlock,
        rpcUrl: this.rpcUrl,
        funded: [ethers.getAddress(this.owner)],
        prewarm: [ethers.getAddress(this.executor)],
      });
      this.preparedBlock = input.baseBlock;
      return { blockNumber: input.baseBlock, mode: "mined" };
    }

    if (input.path !== "hash-only" || !input.impact) {
      throw new Error(`revm backend supports hash-only/mined only (path=${input.path})`);
    }
    if (!overlaySupportsAdapter(input.impact.matchedAdapterId)) {
      throw new Error(`revm overlay unsupported adapter ${input.impact.matchedAdapterId}`);
    }

    const overlay = await buildVictimOverlay(input.impact, {
      graph: this.graph,
      resolveUniv3Fee: (pool) => this.resolveUniv3Fee(pool),
    });
    const prewarmCalls = await this.buildPrewarmCalls(input);

    const resp = await this.client.prepare({
      blockNumber: input.baseBlock,
      rpcUrl: this.rpcUrl,
      funded: [ethers.getAddress(this.owner), overlay.whale],
      tokenDeals: overlay.tokenDeals,
      preCalls: overlay.preCalls,
      // Prewarm the pool + executor so the first quote/sim is already warm.
      prewarm: [ethers.getAddress(input.impact.pool), ethers.getAddress(this.executor)],
      prewarmCalls,
    });
    if (resp.seedStats) {
      const s = resp.seedStats;
      console.log(
        `[searcher/revm] prepare prefetch: roundTrips=${s.roundTrips} traced=${s.tracedCalls} ` +
          `errors=${s.traceErrors} seeded ${s.seededAccounts} accounts + ${s.seededSlots} slots ` +
          `(trace ${s.traceMs}ms, prepare total ${resp.latencyMs}ms)`,
      );
    }
    this.preparedBlock = input.baseBlock;
    return { blockNumber: input.baseBlock, mode: "hash-only" };
  }

  /**
   * One representative quote view-call per deduped route hop, traced during
   * prepare so the solver's first quotes hit warm state. Best-effort: hops we
   * cannot encode (psm/fluid local math, missing graph edge) are skipped.
   */
  private async buildPrewarmCalls(
    input: PrepareInput,
  ): Promise<OverlayPreCall[]> {
    const hops = input.routeHops ?? [];
    if (hops.length === 0 || !input.impact) return [];
    const amountIn = input.impact.amountIn;
    const calls: OverlayPreCall[] = [];
    // The impact pool's slots are already seeded by the victim swap trace.
    const seenTargets = new Set<string>([input.impact.pool.toLowerCase()]);
    for (const hop of hops) {
      if (calls.length >= 10) break;
      const targetKey = hop.target.toLowerCase();
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      calls.push(...(await this.encodeHopQuoteCalls(hop, amountIn)));
    }
    return calls;
  }

  /**
   * Proactive between-block warm: trace a representative quote per recurring hot
   * pool so a later hint's solve on the same block hits warm state instead of a
   * cold route-hop trace inside the TTL. Pure reads, no overlay.
   */
  async warmHotPools(blockNumber: number, hops: QuoteRequest[]): Promise<void> {
    const calls: OverlayPreCall[] = [];
    const seenTargets = new Set<string>();
    const hotTokens = new Map<string, string>();
    for (const hop of hops) {
      const targetKey = hop.target.toLowerCase();
      hotTokens.set(hop.tokenIn.toLowerCase(), hop.tokenIn);
      hotTokens.set(hop.tokenOut.toLowerCase(), hop.tokenOut);
      if (!seenTargets.has(targetKey) && calls.length < 16) {
        seenTargets.add(targetKey);
        calls.push(...(await this.encodeHopQuoteCalls(hop, hop.amountIn)));
      }
    }
    if (calls.length === 0 && hotTokens.size === 0) return;

    const tokenBalanceHints: TokenBalanceHint[] = [...hotTokens.values()]
      .slice(0, 24)
      .map((token) => ({
        token,
        account: ethers.getAddress(WHALE),
      }));
    const prewarm = [
      ethers.ZeroAddress,
      ethers.getAddress(this.owner),
      ethers.getAddress(this.executor),
      ethers.getAddress(WHALE),
      UNIV2_ROUTER,
      UNIV3_SWAP_ROUTER,
      UNIV3_QUOTER_V2,
    ];
    await this.client.warm({
      blockNumber,
      rpcUrl: this.rpcUrl,
      prewarm,
      tokenBalanceHints,
      prewarmCalls: calls,
    });
  }

  /** Encode the quote view-call(s) for one hop. Empty when the adapter quotes
   *  via local math (psm/fluid) or the graph edge is missing. */
  private async encodeHopQuoteCalls(
    hop: { adapterId: string; target: string; tokenIn: string; tokenOut: string },
    amountIn: bigint,
  ): Promise<OverlayPreCall[]> {
    const calls: OverlayPreCall[] = [];
    try {
      switch (hop.adapterId) {
        case "curve-exchange":
        case "curve-exchange-nr":
        case "curve-exchange-plain":
        case "curve-exchange-received-uint": {
          const edge = this.findEdge({
            adapterId: hop.adapterId,
            target: hop.target,
            tokenIn: hop.tokenIn,
            tokenOut: hop.tokenOut,
            amountIn,
          });
          if (edge?.curveI === undefined || edge.curveJ === undefined) break;
          const args = [BigInt(edge.curveI), BigInt(edge.curveJ), amountIn] as const;
          calls.push({
            from: ethers.ZeroAddress,
            to: hop.target,
            calldata: CURVE_INT_IFACE.encodeFunctionData("get_dy", args),
            gasLimit: 3_000_000,
          });
          calls.push({
            from: ethers.ZeroAddress,
            to: hop.target,
            calldata: CURVE_UINT_IFACE.encodeFunctionData("get_dy", args),
            gasLimit: 3_000_000,
          });
          break;
        }
        case "univ2-swap":
          calls.push({
            from: ethers.ZeroAddress,
            to: hop.target,
            calldata: UNIV2_IFACE.encodeFunctionData("getReserves", []),
            gasLimit: 300_000,
          });
          break;
        case "univ3-swap": {
          const fee = await this.resolveUniv3Fee(hop.target);
          calls.push({
            from: ethers.ZeroAddress,
            to: UNIV3_QUOTER_V2,
            calldata: UNIV3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
              { tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
            ]),
            gasLimit: 3_000_000,
          });
          break;
        }
        case "univ4-unlock": {
          const [lo, hi] = [hop.tokenIn.toLowerCase(), hop.tokenOut.toLowerCase()].sort() as [string, string];
          const fallbackPool = V4_V3_FALLBACK[`${lo}-${hi}`];
          if (!fallbackPool) break;
          const fee = await this.resolveUniv3Fee(fallbackPool);
          calls.push({
            from: ethers.ZeroAddress,
            to: UNIV3_QUOTER_V2,
            calldata: UNIV3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
              { tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
            ]),
            gasLimit: 3_000_000,
          });
          break;
        }
        default:
          break;
      }
    } catch {
      // best-effort prewarm; the hop just stays cold
    }
    return calls;
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    if (this.preparedBlock === null) {
      throw new Error("revm quote called before prepareVictimState");
    }
    if (req.amountIn <= 0n) return { amountOut: 0n, latencyMs: 0 };
    const res = await this.quoteByAdapter(req);
    if (res.cacheStats) {
      console.log(
        `[searcher/revm] quote ${req.adapterId} ${req.target.slice(0, 10)} ` +
          `warm=${res.cacheStats.warmHits} cold=${res.cacheStats.coldMisses} ${res.latencyMs}ms`,
      );
    }
    return res;
  }

  private async quoteByAdapter(req: QuoteRequest): Promise<QuoteResult> {
    switch (req.adapterId) {
      case "curve-exchange":
      case "curve-exchange-nr":
      case "curve-exchange-plain":
      case "curve-exchange-received-uint":
        return this.quoteCurve(req);
      case "univ2-swap":
        return this.quoteUniV2(req);
      case "univ3-swap":
        return this.quoteUniV3(req.target, req.tokenIn, req.tokenOut, req.amountIn);
      case "univ4-unlock":
        return this.quoteUniV4(req);
      case "psm":
        return {
          amountOut: quotePSM(req.tokenIn, req.tokenOut, req.amountIn),
          latencyMs: 0,
        };
      case "fluid-vault":
        throw new Error("unsupported exact quote: fluid-vault requires solver debt search");
      default:
        throw new Error(`no revm quoter for adapter ${req.adapterId}`);
    }
  }

  /**
   * Raw eth_call against the prepared (post-victim) overlay. Lets the solver's
   * PoolStateCache warm pool state (slot0/balances/reserves) from the same warm
   * daemon state it will quote/simulate against — so path-B local math runs on
   * the shifted state without re-faulting slots inside the TTL.
   */
  async call(req: { to: string; data: string; from?: string }): Promise<string> {
    if (this.preparedBlock === null) {
      throw new Error("revm call before prepareVictimState");
    }
    const { output } = await this.callPrepared(req.to, req.data, { from: req.from });
    return output;
  }

  async simulate(plan: ResolvedPlan): Promise<SimulationResult> {
    if (this.preparedBlock === null) {
      throw new Error("revm simulate called before prepareVictimState");
    }
    const script = compilePlan(plan.root, this.executor);
    const calldata = buildExecuteCalldata(script);
    const result = await this.client.simulatePrepared({
      owner: this.owner,
      executor: this.executor,
      calldata,
      profitToken: plan.profitToken,
      gasLimit: 0x1000000,
    });
    if (result.missingStateKeys && result.missingStateKeys.length > 0) {
      // Surface missing state explicitly — never let it read as a clean zero.
      throw new Error(`revm missingState: ${result.missingStateKeys.slice(0, 6).join(",")}`);
    }
    const profit = BigInt(result.profit ?? "0");
    return {
      success: result.success ?? false,
      profitToken: plan.profitToken,
      grossProfit: profit,
      gasUsed: BigInt(result.gasUsed ?? "0"),
      netProfit: profit,
      calldata,
      revertReason: result.revertReason ?? undefined,
    };
  }

  private async resolveUniv3Fee(pool: string): Promise<number> {
    const key = pool.toLowerCase();
    const cached = this.feeCache.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.provider.call({
      to: pool,
      data: UNIV3_FEE_IFACE.encodeFunctionData("fee", []),
    });
    const fee = Number(BigInt(raw));
    this.feeCache.set(key, fee);
    return fee;
  }

  private findEdge(req: QuoteRequest): TokenEdge | undefined {
    const target = req.target.toLowerCase();
    const tokenIn = req.tokenIn.toLowerCase();
    const tokenOut = req.tokenOut.toLowerCase();
    return this.graph.find((edge) =>
      edge.target.toLowerCase() === target &&
      edge.tokenIn.toLowerCase() === tokenIn &&
      edge.tokenOut.toLowerCase() === tokenOut
    );
  }

  private async callPrepared(
    to: string,
    data: string,
    options: { from?: string; gasLimit?: number } = {},
  ): Promise<{
    output: string;
    latencyMs: number;
    cacheStats?: { warmHits: number; coldMisses: number };
  }> {
    const resp = await this.client.quote({
      to,
      data,
      from: options.from,
      gasLimit: options.gasLimit,
    });
    if (resp.missingStateKeys && resp.missingStateKeys.length > 0) {
      throw new Error(`revm quote missingState: ${resp.missingStateKeys.slice(0, 6).join(",")}`);
    }
    if (!resp.success) {
      throw new Error(resp.revertReason ?? `revm quote reverted at ${to}`);
    }
    if (!resp.output || resp.output === "0x") {
      throw new Error(`revm quote returned empty output at ${to}`);
    }
    return { output: resp.output, latencyMs: resp.latencyMs, cacheStats: resp.cacheStats };
  }

  private async quoteCurve(req: QuoteRequest): Promise<QuoteResult> {
    const edge = this.findEdge(req);
    if (edge?.curveI === undefined || edge.curveJ === undefined) {
      throw new Error(`revm curve quote missing graph indices for ${req.target}`);
    }

    const args = [BigInt(edge.curveI), BigInt(edge.curveJ), req.amountIn] as const;
    try {
      const quoted = await this.callPrepared(
        req.target,
        CURVE_INT_IFACE.encodeFunctionData("get_dy", args),
      );
      const decoded = CURVE_INT_IFACE.decodeFunctionResult("get_dy", quoted.output);
      return { amountOut: BigInt(decoded[0]), latencyMs: quoted.latencyMs, cacheStats: quoted.cacheStats };
    } catch (err) {
      const quoted = await this.callPrepared(
        req.target,
        CURVE_UINT_IFACE.encodeFunctionData("get_dy", args),
      );
      const decoded = CURVE_UINT_IFACE.decodeFunctionResult("get_dy", quoted.output);
      return { amountOut: BigInt(decoded[0]), latencyMs: quoted.latencyMs, cacheStats: quoted.cacheStats };
    }
  }

  private async quoteUniV2(req: QuoteRequest): Promise<QuoteResult> {
    const edge = this.findEdge(req);
    let token0 = edge?.poolToken0;
    let latencyMs = 0;
    if (!token0) {
      const token0Call = await this.callPrepared(
        req.target,
        UNIV2_IFACE.encodeFunctionData("token0", []),
      );
      token0 = ethers.getAddress("0x" + token0Call.output.slice(-40));
      latencyMs += token0Call.latencyMs;
    }

    const reservesCall = await this.callPrepared(
      req.target,
      UNIV2_IFACE.encodeFunctionData("getReserves", []),
    );
    latencyMs += reservesCall.latencyMs;
    const decoded = UNIV2_IFACE.decodeFunctionResult("getReserves", reservesCall.output);
    const [r0, r1] = [BigInt(decoded[0]), BigInt(decoded[1])];
    const zeroForOne = req.tokenIn.toLowerCase() === token0.toLowerCase();
    const [reserveIn, reserveOut] = zeroForOne ? [r0, r1] : [r1, r0];

    const amountInWithFee = req.amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    return { amountOut: numerator / denominator, latencyMs, cacheStats: reservesCall.cacheStats };
  }

  private async quoteUniV3(
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<QuoteResult> {
    const fee = await this.resolveUniv3Fee(pool);
    const data = UNIV3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
      {
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    const quoted = await this.callPrepared(UNIV3_QUOTER_V2, data, {
      gasLimit: 3_000_000,
    });
    const decoded = UNIV3_QUOTER_IFACE.decodeFunctionResult(
      "quoteExactInputSingle",
      quoted.output,
    );
    return { amountOut: BigInt(decoded[0]), latencyMs: quoted.latencyMs, cacheStats: quoted.cacheStats };
  }

  private quoteUniV4(req: QuoteRequest): Promise<QuoteResult> {
    const [lo, hi] = [req.tokenIn.toLowerCase(), req.tokenOut.toLowerCase()].sort() as [string, string];
    const fallbackPool = V4_V3_FALLBACK[`${lo}-${hi}`];
    if (!fallbackPool) {
      throw new Error(`V4 quoter: no V3 fallback for ${req.tokenIn} → ${req.tokenOut}`);
    }
    return this.quoteUniV3(fallbackPool, req.tokenIn, req.tokenOut, req.amountIn);
  }
}

function quotePSM(tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  if (tIn === usdc && tOut === dai) return amountIn * 10n ** 12n;
  if (tIn === dai && tOut === usdc) return amountIn / 10n ** 12n;
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}
