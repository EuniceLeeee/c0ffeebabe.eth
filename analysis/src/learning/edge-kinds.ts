import type { EdgeKind } from "../../../listener/src/searcher/strategy-taxonomy.js";
import { lower, TOPICS } from "../registry/protocols.js";

const SWAP_TOPICS = topicSet([
  TOPICS.univ2Swap,
  TOPICS.univ3Swap,
  TOPICS.univ4Swap,
  TOPICS.curveTokenExchange,
  TOPICS.curveTokenExchangeUnderlying,
  TOPICS.balancerV2Swap,
]);

const FLASH_TOPICS = topicSet([
  TOPICS.balancerV2FlashLoan,
  TOPICS.morphoFlashLoan,
  TOPICS.univ3Flash,
  TOPICS.aaveV3FlashLoan,
]);

const LP_TOPICS = topicSet([
  TOPICS.univ2Mint,
  TOPICS.univ2Burn,
  TOPICS.univ3Mint,
  TOPICS.univ3Burn,
  TOPICS.univ4ModifyLiquidity,
]);

const CREDIT_TOPICS = topicSet([
  TOPICS.morphoBorrow,
  TOPICS.morphoRepay,
  TOPICS.morphoSupply,
  TOPICS.morphoWithdraw,
  TOPICS.morphoSupplyCollateral,
  TOPICS.morphoWithdrawCollateral,
  TOPICS.aaveV3Borrow,
  TOPICS.aaveV3Repay,
]);

const STABLE_ORDER: EdgeKind[] = ["flash", "swap", "credit", "lp"];

export function deriveEdgeKindsFromLogs(logs: Array<{ topics?: unknown }> | undefined | null): EdgeKind[] {
  const seen = new Set<EdgeKind>();
  for (const log of logs ?? []) {
    const topic0 = topic0Of(log);
    if (!topic0) continue;
    if (FLASH_TOPICS.has(topic0)) seen.add("flash");
    if (SWAP_TOPICS.has(topic0)) seen.add("swap");
    if (CREDIT_TOPICS.has(topic0)) seen.add("credit");
    if (LP_TOPICS.has(topic0)) seen.add("lp");
  }
  // Protocol-leg detection (e.g. Liquity BOLD mint) is future work.
  return STABLE_ORDER.filter((kind) => seen.has(kind));
}

function topic0Of(log: { topics?: unknown }): string | null {
  if (!Array.isArray(log.topics) || typeof log.topics[0] !== "string") return null;
  return lower(log.topics[0]);
}

function topicSet(topics: string[]): Set<string> {
  return new Set(topics.map(lower));
}
