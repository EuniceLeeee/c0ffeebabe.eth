import { ethers } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  LiveStateBackend,
  PrepareInput,
  PreparedState,
  QuoteHop,
  QuoteRequest,
  QuoteResult,
} from "../live-state-backend.js";
import { findPreparedQuoteEdge } from "../live-state-backend.js";
import {
  RevmSimClient,
  type OverlayPreCall,
  type OverlayStateOverride,
  type TokenAllowanceHint,
  type TokenBalanceHint,
} from "../revm-sim-client.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import { resolveErc20BalanceSlot, tokenAllowanceHint, tokenBalanceHint } from "../solver/balance-slots.js";
import {
  postImpactStateOverrides,
  postImpactSupportsStateOverrides,
} from "../solver/post-impact-overrides.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  resolveFundingPrewarmAddresses,
  strictRoutePrewarmAddresses,
} from "../strict-execution-projection.js";
import type {
  StrictShadowCatalogViews,
} from "../adapter-family-shadow-catalog-publication.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import type {
  PreparedRouteContext,
  PreparedRouteRequest,
} from "../venues/route-leg-adapter.js";
import { buildVictimOverlay, overlaySupportsAdapter } from "./victim-overlay.js";

const WHALE = "0x000000000000000000000000000000000000dEaD";
const BALANCE_OF_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

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
  private victimOverlayReadBlock: number | null = null;
  private readonly victimOverlayReadCache = new Map<string, string>();
  private warmBlockAnchor: { number: number; hash: string } | null = null;

  constructor(
    private readonly client: RevmSimClient,
    readonly executor: string,
    private readonly owner: string,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly graph: TokenEdge[],
    private readonly rpcUrl: string,
    private readonly strictExecution?: {
      readonly views: () => StrictShadowCatalogViews | null;
      readonly catalog: FamilyCapabilityCatalog;
    },
  ) {}

  private async canonicalBlockHash(blockNumber: number): Promise<string> {
    const block = await this.provider.send(
      "eth_getBlockByNumber",
      [ethers.toQuantity(blockNumber), false],
    ) as { hash?: unknown } | null;
    if (typeof block?.hash !== "string" || !ethers.isHexString(block.hash, 32)) {
      throw new Error(`missing canonical hash for revm block ${blockNumber}`);
    }
    return block.hash.toLowerCase();
  }

  private async resetCanonicalState(): Promise<void> {
    await this.client.reset();
    this.warmBlockAnchor = null;
    this.preparedBlock = null;
    this.victimOverlayReadBlock = null;
    this.victimOverlayReadCache.clear();
  }

  private async beginCanonicalBlock(
    blockNumber: number,
    expectedHash?: string,
  ): Promise<string> {
    const canonicalHash = await this.canonicalBlockHash(blockNumber);
    if (
      expectedHash !== undefined &&
      canonicalHash !== expectedHash.toLowerCase()
    ) {
      await this.resetCanonicalState();
      throw new Error(
        `revm source block reorged before prepare block=${blockNumber} ` +
        `expected=${expectedHash} canonical=${canonicalHash}`,
      );
    }
    if (
      this.warmBlockAnchor?.number === blockNumber &&
      this.warmBlockAnchor.hash !== canonicalHash
    ) {
      await this.resetCanonicalState();
    }
    return canonicalHash;
  }

  private async commitCanonicalBlock(
    blockNumber: number,
    expectedHash: string,
  ): Promise<string> {
    const canonicalHash = await this.canonicalBlockHash(blockNumber);
    if (canonicalHash !== expectedHash) {
      await this.resetCanonicalState();
      throw new Error(
        `revm source block reorged during prepare block=${blockNumber} ` +
        `before=${expectedHash} after=${canonicalHash}`,
      );
    }
    this.warmBlockAnchor = { number: blockNumber, hash: canonicalHash };
    return canonicalHash;
  }

  supportsPath(input: PrepareInput): boolean {
    return (
      input.path === "hash-only" &&
      input.impact !== null &&
      overlaySupportsAdapter(input.impact.matchedAdapterId)
    );
  }

  async prepareVictimState(input: PrepareInput): Promise<PreparedState> {
    const blockHash = await this.beginCanonicalBlock(
      input.baseBlock,
      input.baseBlockHash,
    );
    if (input.path === "mined") {
      // The victim is already included in the mined block's post-state, so read
      // chain state directly at that block with no overlay.
      await this.client.prepare({
        blockNumber: input.baseBlock,
        rpcUrl: this.rpcUrl,
        funded: [ethers.getAddress(this.owner)],
        prewarm: [ethers.getAddress(this.executor)],
      });
      await this.commitCanonicalBlock(input.baseBlock, blockHash);
      this.preparedBlock = input.baseBlock;
      return { blockNumber: input.baseBlock, blockHash, mode: "mined" };
    }

    if (input.path !== "hash-only" || !input.impact) {
      throw new Error(`revm backend supports hash-only/mined only (path=${input.path})`);
    }
    if (!overlaySupportsAdapter(input.impact.matchedAdapterId)) {
      throw new Error(`revm overlay unsupported adapter ${input.impact.matchedAdapterId}`);
    }

    const impactPool = input.impact.pool;
    const baseBlock = input.baseBlock;
    const stateOverrides: OverlayStateOverride[] =
      input.postImpact && postImpactSupportsStateOverrides(input.postImpact)
        ? await postImpactStateOverrides(input.postImpact, (token) =>
            this.resolveBalanceSlot(token, impactPool, baseBlock))
        : [];
    const usePostImpactOverrides = stateOverrides.length > 0;
    const overlay = usePostImpactOverrides
      ? null
      : await buildVictimOverlay(input.impact, {
          graph: this.graph,
          read: (req) => this.readVictimOverlayState(req, baseBlock),
        }, remainingPrepareMs(input));
    const prewarmCalls = await this.buildPrewarmCalls(input, !usePostImpactOverrides);
    if (usePostImpactOverrides) {
      console.log(
        `[searcher/revm] prepare state_override ${input.postImpact!.kind} ` +
          `overrides=${stateOverrides.length} prewarmCalls=${prewarmCalls.length}`,
      );
    }

    const resp = await this.client.prepare({
      blockNumber: input.baseBlock,
      rpcUrl: this.rpcUrl,
      funded: usePostImpactOverrides
        ? [ethers.getAddress(this.owner)]
        : [ethers.getAddress(this.owner), overlay!.whale],
      stateOverrides,
      tokenDeals: overlay?.tokenDeals ?? [],
      preCalls: overlay?.preCalls ?? [],
      // Prewarm the pool + executor so the first quote/sim is already warm.
      prewarm: this.buildPreparePrewarm(input, usePostImpactOverrides),
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
    await this.commitCanonicalBlock(input.baseBlock, blockHash);
    this.preparedBlock = input.baseBlock;
    return { blockNumber: input.baseBlock, blockHash, mode: "hash-only" };
  }

  private buildPreparePrewarm(input: PrepareInput, stateOverrideOnly: boolean): string[] {
    const prewarm = new Map<string, string>();
    const push = (addr: string) => prewarm.set(addr.toLowerCase(), ethers.getAddress(addr));
    if (input.impact) push(input.impact.pool);
    push(this.executor);
    push(this.owner);
    for (const address of resolveFundingPrewarmAddresses({
      strictViews: this.strictExecution === undefined
        ? null
        : this.strictExecution.views(),
      catalog: this.strictExecution?.catalog ??
        PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      legacyAddresses: PRODUCTION_ADAPTER_FAMILIES.funding().flatMap(
        (family) => [family.funding.target, family.funding.liquidityHolder],
      ),
    })) {
      push(address);
    }
    for (const hop of input.routeHops ?? []) {
      push(hop.target);
      if (this.strictExecution !== undefined &&
          this.strictExecution.views() !== null) {
        for (const address of strictRoutePrewarmAddresses({
          catalog: this.strictExecution.catalog,
          hops: [hop],
        })) {
          push(address);
        }
      } else {
        const adapter = PRODUCTION_ADAPTER_FAMILIES.routes()
          .findForEdge(hop.adapterId);
        const request = this.preparedRequest(hop, input.impact?.amountIn ?? 0n);
        for (const address of adapter?.prepared?.prewarmAddresses?.(request) ??
          []) push(address);
      }
    }

    if (stateOverrideOnly) {
      return [...prewarm.values()];
    }

    push(WHALE);
    return [...prewarm.values()];
  }

  /** Resolve a token's balanceOf mapping slot for state_override, probing the
   *  chain at `baseBlock` (registry hit → cache → candidate-slot probe). null →
   *  caller drops the override and falls back to the (correct) cold overlay. */
  private resolveBalanceSlot(token: string, holder: string, blockTag: number): Promise<number | null> {
    return resolveErc20BalanceSlot(token, holder, {
      balanceOf: async (t, h) => {
        const ret = await this.provider.call({
          to: t,
          data: BALANCE_OF_IFACE.encodeFunctionData("balanceOf", [h]),
          blockTag,
        });
        return ret && ret !== "0x" ? BigInt(ret) : 0n;
      },
      getStorage: async (t, key) => {
        const ret = await this.provider.getStorage(t, key, blockTag);
        return ret && ret !== "0x" ? BigInt(ret) : 0n;
      },
    });
  }

  /**
   * One representative quote view-call per deduped route hop, traced during
   * prepare so the solver's first quotes hit warm state. Best-effort: hops we
   * cannot encode (family has no prepared prewarm, missing graph edge) are skipped.
   */
  private async buildPrewarmCalls(
    input: PrepareInput,
    skipImpactPool: boolean,
  ): Promise<OverlayPreCall[]> {
    const hops = input.routeHops ?? [];
    if (hops.length === 0 || !input.impact) return [];
    const amountIn = input.impact.amountIn;
    const calls: OverlayPreCall[] = [];
    const seenTargets = new Set<string>(
      skipImpactPool ? [input.impact.pool.toLowerCase()] : [],
    );
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
    const blockHash = await this.beginCanonicalBlock(blockNumber);
    const calls: OverlayPreCall[] = [];
    const seenTargets = new Set<string>();
    const hotTokens = new Map<string, string>();
    const allowanceHints = new Map<string, TokenAllowanceHint>();
    for (const hop of hops) {
      const targetKey = hop.target.toLowerCase();
      hotTokens.set(hop.tokenIn.toLowerCase(), hop.tokenIn);
      hotTokens.set(hop.tokenOut.toLowerCase(), hop.tokenOut);
      const spender = overlayApproveSpender(hop);
      if (spender) {
        for (const token of [hop.tokenIn, hop.tokenOut]) {
          allowanceHints.set(
            `${token.toLowerCase()}|${spender.toLowerCase()}`,
            tokenAllowanceHint(token, WHALE, spender),
          );
        }
      }
      if (!seenTargets.has(targetKey) && calls.length < 16) {
        seenTargets.add(targetKey);
        calls.push(...(await this.encodeHopQuoteCalls(hop, hop.amountIn)));
      }
    }
    if (calls.length === 0 && hotTokens.size === 0) return;

    const storageHintsEnabled = process.env.SEARCHER_WARM_STORAGE_HINTS !== "0";
    const warmUnknownStorage = process.env.SEARCHER_WARM_UNKNOWN_STORAGE_HINTS === "1";
    const tokenBalanceHints: TokenBalanceHint[] = storageHintsEnabled
      ? [...hotTokens.values()]
          .slice(0, 24)
          .map((token) => tokenBalanceHint(token, WHALE))
          .filter((hint) => warmUnknownStorage || hint.balanceSlot !== undefined)
      : [];
    const prewarmByAddress = new Map<string, string>();
    const pushPrewarm = (address: string): void => {
      const normalized = ethers.getAddress(address);
      prewarmByAddress.set(normalized.toLowerCase(), normalized);
    };
    for (const address of [
      ethers.ZeroAddress,
      this.owner,
      this.executor,
      WHALE,
      ...calls.map((call) => call.to),
    ]) pushPrewarm(address);
    for (const address of resolveFundingPrewarmAddresses({
      strictViews: this.strictExecution === undefined
        ? null
        : this.strictExecution.views(),
      catalog: this.strictExecution?.catalog ??
        PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      legacyAddresses: PRODUCTION_ADAPTER_FAMILIES.funding().flatMap(
        (family) => [family.funding.target, family.funding.liquidityHolder],
      ),
    })) {
      pushPrewarm(address);
    }
    for (const hop of hops) {
      pushPrewarm(hop.target);
      if (this.strictExecution !== undefined &&
          this.strictExecution.views() !== null) {
        for (const address of strictRoutePrewarmAddresses({
          catalog: this.strictExecution.catalog,
          hops: [hop],
        })) {
          pushPrewarm(address);
        }
      } else {
        const adapter = PRODUCTION_ADAPTER_FAMILIES.routes()
          .findForEdge(hop.adapterId);
        const request = this.preparedRequest(hop, hop.amountIn);
        for (const address of adapter?.prepared?.prewarmAddresses?.(request) ??
          []) {
          pushPrewarm(address);
        }
      }
    }
    const prewarm = [...prewarmByAddress.values()];
    await this.client.warm({
      blockNumber,
      rpcUrl: this.rpcUrl,
      prewarm,
      tokenBalanceHints,
      tokenAllowanceHints: storageHintsEnabled
        ? [...allowanceHints.values()]
            .slice(0, 24)
            .filter((hint) => warmUnknownStorage || hint.allowanceSlot !== undefined)
        : [],
      prewarmCalls: calls,
    });
    await this.commitCanonicalBlock(blockNumber, blockHash);
  }

  async warmPrepareState(input: PrepareInput): Promise<void> {
    if (!input.impact || input.path !== "hash-only") return;
    const hops: QuoteRequest[] = [{
      adapterId: input.impact.matchedAdapterId,
      target: input.impact.pool,
      tokenIn: input.impact.tokenIn,
      tokenOut: input.impact.tokenOut,
      amountIn: input.impact.amountIn,
    }];
    for (const hop of input.routeHops ?? []) {
      hops.push({
        ...hop,
        amountIn: input.impact.amountIn,
      });
    }
    await this.warmHotPools(input.baseBlock, hops);
  }

  /** Encode the quote view-call(s) declared by the route adapter. */
  private async encodeHopQuoteCalls(
    hop: QuoteHop,
    amountIn: bigint,
  ): Promise<OverlayPreCall[]> {
    try {
      const adapter = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(hop.adapterId);
      const encode = adapter?.prepared?.encodeQuotePrewarm;
      if (!encode) return [];
      return [...await encode(this.preparedContext(hop, amountIn))];
    } catch {
      // best-effort prewarm; the hop just stays cold
      return [];
    }
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
    const adapter = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(req.adapterId);
    if (adapter?.prepared?.quote) {
      return adapter.prepared.quote(this.preparedContext(req, req.amountIn));
    }
    if (adapter?.prepared?.quoteUnsupportedReason) {
      throw new Error(adapter.prepared.quoteUnsupportedReason);
    }
    throw new Error(`no revm quoter for adapter ${req.adapterId}`);
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
    const success = result.success ?? false;
    return {
      success,
      profitToken: plan.profitToken,
      grossProfit: profit,
      gasUsed: success ? BigInt(result.gasUsed ?? "0") : 0n,
      netProfit: profit,
      calldata,
      revertReason: result.revertReason ?? undefined,
    };
  }

  private async readVictimOverlayState(
    req: { readonly to: string; readonly data: string },
    blockNumber: number,
  ): Promise<string> {
    if (this.victimOverlayReadBlock !== blockNumber) {
      this.victimOverlayReadCache.clear();
      this.victimOverlayReadBlock = blockNumber;
    }
    const key =
      `${blockNumber}:${req.to.toLowerCase()}:${req.data.toLowerCase()}`;
    const cached = this.victimOverlayReadCache.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.provider.call({
      to: req.to,
      data: req.data,
      blockTag: blockNumber,
    });
    this.victimOverlayReadCache.set(key, raw);
    return raw;
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

  private preparedRequest(hop: QuoteHop, amountIn: bigint): PreparedRouteRequest {
    return { ...hop, amountIn };
  }

  private preparedContext(hop: QuoteHop, amountIn: bigint): PreparedRouteContext {
    const request = this.preparedRequest(hop, amountIn);
    return {
      request,
      edge: findPreparedQuoteEdge(this.graph, request),
      callPrepared: (to, data, options) => this.callPrepared(to, data, options),
      readChain: ({ to, data }) => this.provider.call({ to, data }),
    };
  }
}

function remainingPrepareMs(input: PrepareInput): number | undefined {
  return input.deadlineAtMs === undefined
    ? undefined
    : Math.max(1, input.deadlineAtMs - Date.now());
}

function overlayApproveSpender(hop: QuoteHop | QuoteRequest): string | null {
  const adapter = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(hop.adapterId);
  const request: PreparedRouteRequest = {
    ...hop,
    amountIn: "amountIn" in hop ? hop.amountIn : 0n,
  };
  return adapter?.prepared?.allowanceSpender?.(request) ?? null;
}
