import type { Action } from "../types.js";

export function canonicalSequence(actions: Action[]): string[] {
  const sorted = [...actions].sort((a, b) => a.order - b.order);
  const seq: string[] = [];
  for (const a of sorted) {
    const simplified = simplify(a.kind);
    if (seq[seq.length - 1] !== simplified) seq.push(simplified);
  }
  return seq;
}

export function pathTemplate(seq: string[]): string {
  const joined = seq.join(" -> ");
  if (seq.length === 0) return "unknown_opaque";
  const hasLpMint = seq.includes("position.lp.mint");
  const hasLpBurn = seq.includes("position.lp.burn");
  const hasLp = hasLpMint || hasLpBurn;
  if (hasLp) {
    if (seq[0] === "fund.flashloan") return "LP Flash-Position Arb";
    if (hasLpMint && hasLpBurn) return "LP-positioned(mint→arb→burn)";
    if (seq.includes("trade.swap")) return "LP-positioned(partial→arb)";
    return "LP-position-only";
  }
  if (seq.includes("fund.flashloan") && seq.includes("credit.borrow")) return "flash→borrow→swap→repay";
  if (seq.includes("fund.flashloan") && seq.includes("trade.swap") && seq.includes("credit.repay")) {
    return "flash→swap→repay";
  }
  if (seq.filter((x) => x === "trade.swap").length >= 2) return "swap-loop";
  if (seq.some((x) => x.startsWith("peg.")) || (seq.includes("wrap") && seq.includes("unwrap"))) {
    return "peg/redeem/wrap";
  }
  if (seq.includes("trade.swap")) return "unknown_replayable";
  if (joined.includes("unknown.action")) return "unknown_opaque";
  return "unknown_replayable";
}

export function strategyType(seq: string[], hasBackrunEvidence: boolean): string {
  const hasLp = seq.includes("position.lp.mint") || seq.includes("position.lp.burn");
  if (hasBackrunEvidence && hasLp) return "backrun+LP";
  if (hasBackrunEvidence) return "pure-backrun";
  if (hasLp) return "LP-position/unknown";
  if (seq.includes("trade.swap") || seq.includes("fund.flashloan")) return "atomic/standing";
  return "unknown";
}

export function revenueSource(seq: string[]): string {
  if (seq.includes("position.lp.mint") || seq.includes("position.lp.burn")) return "inventory_delta|fee_capture";
  if (seq.some((x) => x.startsWith("peg."))) return "peg/redeem";
  if (seq.includes("trade.swap")) return "price_repair_arb";
  return "unknown";
}

function simplify(kind: Action["kind"]): string {
  if (kind === "peg.mint" || kind === "peg.redeem") return kind;
  return kind;
}
