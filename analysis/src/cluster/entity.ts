import type { EntityEdge, TxSummary } from "../types.js";
import { lower, short } from "../registry/protocols.js";

export interface EntityCluster {
  members: string[];
  confidence: "high" | "medium" | "low";
  edges: EntityEdge[];
  overmergeRisk: "high" | "medium" | "low";
}

export function buildEntityCluster(seed: string, txs: TxSummary[]): EntityCluster {
  const seedLower = lower(seed);
  const calls = new Map<string, number>();
  for (const tx of txs) {
    if (lower(tx.from) === seedLower && tx.to) {
      calls.set(lower(tx.to), (calls.get(lower(tx.to)) ?? 0) + 1);
    }
  }

  const edges: EntityEdge[] = [];
  const members = new Set<string>([seedLower]);
  for (const [to, count] of calls) {
    const strength = count >= 2 ? "strong" : "weak";
    edges.push({
      from: seedLower,
      to,
      edge: "SAME_EXECUTOR",
      strength,
      evidence: `${count} successful seed -> contract calls`,
    });
    if (strength === "strong") members.add(to);
  }

  const strong = edges.filter((e) => e.strength === "strong").length;
  return {
    members: [...members],
    confidence: strong > 0 ? "medium" : "low",
    edges,
    overmergeRisk: edges.some((e) => e.strength === "weak") ? "medium" : "low",
  };
}

export function actorForTx(seed: string, tx: TxSummary, cluster: EntityCluster): string {
  const seedLower = lower(seed);
  if (lower(tx.from) === seedLower && tx.to) return lower(tx.to);
  if (tx.to && cluster.members.includes(lower(tx.to))) return lower(tx.to);
  return seedLower;
}

export function describeEdges(edges: EntityEdge[]): string[] {
  return edges.map((e) => `${e.edge} ${e.strength}: ${short(e.from)} -> ${short(e.to)} (${e.evidence})`);
}
