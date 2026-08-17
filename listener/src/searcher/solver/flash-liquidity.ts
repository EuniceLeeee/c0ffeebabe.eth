import { ethers } from "ethers";

/**
 * Dynamic flash-loan borrowability, read from chain — NOT a hardcoded allowlist.
 *
 * A token is flash-borrowable iff a flash provider actually holds it:
 *   - Morpho Blue can flashLoan any token it custodies → balanceOf(token, MORPHO)
 *   - Balancer V2 Vault flash-loans its own balance     → balanceOf(token, VAULT)
 *
 * The borrowable amount is the max over providers; the winning provider's adapter
 * id is returned so the solver flashes from the source that actually has the depth.
 *
 * One Multicall3 batch refreshes every tracked token at once (cheap on RPC — it
 * was per-slot RPC faulting, not this, that exhausted the quota). Refresh on a
 * block cadence; borrowability changes slowly relative to a block.
 */

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_IFACE = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

export interface FlashProvider {
  adapterId: string;
  /** Holder address whose token balance bounds the flashable amount. */
  holder: string;
}

export interface FlashSource {
  /** Largest single-provider borrowable amount for the token. */
  amount: bigint;
  /** Flash adapter id of the deepest provider. */
  adapterId: string;
  /** Present on registry-derived current-N snapshots. */
  fundingId?: string;
}

export interface FlashLiquidityView {
  borrowable(token: string): bigint;
  source(token: string): FlashSource | null;
}

export class FlashLiquidityCache {
  private byToken = new Map<string, FlashSource>();
  private lastRefreshBlock = 0;

  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly providers: readonly FlashProvider[],
  ) {
    if (providers.length === 0) {
      throw new Error("FlashLiquidityCache requires strict-issued providers");
    }
  }

  /** Borrowable depth for a token (0 if unknown/none). */
  borrowable(token: string): bigint {
    return this.byToken.get(token.toLowerCase())?.amount ?? 0n;
  }

  /** Deepest flash source for a token, or null if no provider holds it. */
  source(token: string): FlashSource | null {
    return this.byToken.get(token.toLowerCase()) ?? null;
  }

  /** Whether the token can flash at least `amount` from some single provider. */
  canBorrow(token: string, amount: bigint): boolean {
    return this.borrowable(token) >= amount;
  }

  get refreshedAtBlock(): number {
    return this.lastRefreshBlock;
  }

  /**
   * Batch-refresh borrowable depth for `tokens` via one Multicall3 call.
   * Best-effort: a failed sub-call leaves that (token, provider) at 0.
   */
  async refresh(tokens: string[], blockNumber?: number): Promise<void> {
    const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))];
    if (uniq.length === 0) return;

    // Chunk so one multicall stays well under node call-size/gas limits.
    const TOKENS_PER_BATCH = 400;
    const next = new Map<string, FlashSource>();
    for (let start = 0; start < uniq.length; start += TOKENS_PER_BATCH) {
      const batch = uniq.slice(start, start + TOKENS_PER_BATCH);
      const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
      for (const token of batch) {
        for (const p of this.providers) {
          calls.push({
            target: ethers.getAddress(token),
            allowFailure: true,
            callData: ERC20_IFACE.encodeFunctionData("balanceOf", [p.holder]),
          });
        }
      }
      const ret = await this.provider.call({
        to: MULTICALL3,
        data: MULTICALL3_IFACE.encodeFunctionData("aggregate3", [calls]),
        ...(blockNumber === undefined ? {} : { blockTag: blockNumber }),
      });
      const [results] = MULTICALL3_IFACE.decodeFunctionResult("aggregate3", ret) as unknown as [
        Array<{ success: boolean; returnData: string }>,
      ];

      let i = 0;
      for (const token of batch) {
        let best: FlashSource = {
          amount: 0n,
          adapterId: this.providers[0]!.adapterId,
        };
        for (const p of this.providers) {
          const r = results[i++];
          if (r?.success && r.returnData && r.returnData !== "0x") {
            const bal = BigInt(r.returnData);
            if (bal > best.amount) best = { amount: bal, adapterId: p.adapterId };
          }
        }
        if (best.amount > 0n) next.set(token, best);
      }
    }
    this.byToken = next;
    if (blockNumber) this.lastRefreshBlock = blockNumber;
  }
}
