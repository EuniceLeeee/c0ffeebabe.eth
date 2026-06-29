import type { StrategyCluster, TxAnalysis } from "../types.js";
import { revenueSource } from "../actions/canonicalize.js";
import { tokenMeta } from "../registry/protocols.js";
import { uniq } from "../util.js";

// Coarse token family for clustering — NOT exact addresses. Using exact token
// sets in the key fragmented one bot's 80 tx into ~49 "clusters" (≈1/tx), which
// defeats the "3-5 main paths" goal. Family = {WETH, stable, longtail}; exact
// tokens are still listed as a cluster attribute, so no info is lost.
function tokenFamily(addr: string): string {
  const m = tokenMeta(addr);
  if (m.symbol === "WETH") return "WETH";
  if (m.stable) return "stable";
  return "longtail";
}
function tokenFamilies(tokens: string[]): string {
  return uniq(tokens.map(tokenFamily)).sort().join("+");
}

export function clusterStrategies(txs: TxAnalysis[]): StrategyCluster[] {
  const groups = new Map<string, TxAnalysis[]>();
  for (const tx of txs) {
    const key = [
      tx.pathTemplate,
      tx.strategyType,
      tokenFamilies(tx.tokens),
      fundingOf(tx.canonicalSequence),
      revenueSource(tx.canonicalSequence),
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push(tx);
    groups.set(key, arr);
  }

  return [...groups.entries()].map(([key, items], i) => {
    const rep = [...items].sort((a, b) => scoreTx(b) - scoreTx(a))[0];
    const seq = rep.canonicalSequence;
    const support = supportFor(rep.pathTemplate);
    // PnL is only a trustworthy estimate for self-contained closed loops
    // (flash-arb must repay in-tx; swap-loop returns to start token). For LP
    // mint/burn legs, directional single swaps, and other open legs, per-tx delta
    // is NOT profit (a lone mint shows huge negative, the matching burn huge
    // positive, and they live in different clusters). Report n/a for those —
    // raw_deltas are still kept per representative tx, so no info is lost.
    const closedLoop =
      seq.includes("fund.flashloan") || rep.pathTemplate === "swap-loop";
    return {
      id: `strategy-${i + 1}`,
      pathTemplate: rep.pathTemplate,
      canonicalSequence: seq,
      txCount: items.length,
      representativeTx: rep.tx.hash,
      tokens: uniq(items.flatMap((x) => x.tokens)).slice(0, 12),
      venues: uniq(items.flatMap((x) => x.venues)).slice(0, 12),
      protocols: uniq(items.flatMap((x) => x.protocols)).slice(0, 12),
      funding: fundingOf(seq),
      strategyType: rep.strategyType,
      roughPnlUsd: closedLoop ? sumNullable(items.map((x) => x.netExInternalBribeUsd)) : null,
      netFull: null,
      ourSupport: support.ourSupport,
      prodSupportGap: support.gaps,
      ourGap: support.gaps,
      nextAction: nextActions(rep.pathTemplate, support.gaps),
    };
  });
}

function scoreTx(tx: TxAnalysis): number {
  return (tx.netExInternalBribeUsd ?? 0) + tx.actionsFromLogs.length + (tx.actionsFromTrace?.length ?? 0);
}

function sumNullable(xs: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const x of xs) {
    if (x == null) continue;
    sum += x;
    any = true;
  }
  return any ? sum : null;
}

function fundingOf(seq: string[]): string {
  if (seq.includes("fund.flashloan")) return "flashloan";
  if (seq.includes("fund.flashmint")) return "flashmint";
  return "self-funded/unknown";
}

function supportFor(path: string): { ourSupport: StrategyCluster["ourSupport"]; gaps: string[] } {
  if (path === "flash→borrow→swap→repay") {
    return { ourSupport: "partial", gaps: ["generalize borrow-leg template", "verify borrow source/liquidity"] };
  }
  if (path === "flash→swap→repay" || path === "swap-loop" || path === "peg/redeem/wrap") {
    return { ourSupport: "partial", gaps: ["confirm pool indexed", "fork replay representative tx"] };
  }
  if (path.startsWith("LP")) {
    return { ourSupport: "unsupported", gaps: ["missing LP-positioned template", "missing LP mint/burn action support in searcher"] };
  }
  return { ourSupport: "unknown", gaps: ["review unknown action sequence", "trace representative tx"] };
}

function nextActions(path: string, gaps: string[]): string[] {
  const out = ["replay representative tx"];
  if (gaps.some((g) => g.includes("template"))) out.push(`add ${path} template draft`);
  if (gaps.some((g) => g.includes("indexed"))) out.push("check pool universe coverage");
  return out;
}
