import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import type { SwapAdapter } from "./venues/route-leg-adapter.js";

export interface MempoolIntakeOptions {
  readonly hotPoolTopN: number;
  readonly filteredMaxAddresses: number;
}

export interface MempoolIntakePlan {
  /** Complete local-firehose admission set. Never load-shed by score or provider cap. */
  readonly fullTargets: readonly string[];
  /** Provider-safe server-side filter. May be a documented subset of fullTargets. */
  readonly filteredTargets: readonly string[];
  readonly canonicalTargetCount: number;
  readonly dynamicTargetCount: number;
  readonly graphTargetCount: number;
  readonly filteredTruncated: boolean;
}

export function buildMempoolIntakePlan(input: {
  pools: readonly PoolEntry[];
  swaps: readonly SwapAdapter[];
  dynamicRouterTargets?: readonly string[];
  additionalCanonicalTargets?: readonly string[];
  options: MempoolIntakeOptions;
}): MempoolIntakePlan {
  const canonical = uniqueAddresses([
    ...input.swaps.flatMap((adapter) => adapter.observation.canonicalIntakeTargets),
    ...(input.additionalCanonicalTargets ?? []),
  ]);
  const dynamic = uniqueAddresses(input.dynamicRouterTargets ?? []);
  const graph = uniqueAddresses(input.pools.map((pool) => pool.address));
  const fullTargets = uniqueAddresses([...canonical, ...dynamic, ...graph]);

  const pinned = input.pools
    .filter((pool) => pool.score === undefined)
    .map((pool) => pool.address);
  const hot = [...input.pools]
    .filter((pool) => pool.score !== undefined)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, Math.max(0, input.options.hotPoolTopN))
    .map((pool) => pool.address);
  const filteredCandidates = uniqueAddresses([...canonical, ...dynamic, ...pinned, ...hot]);
  const filteredTargets = filteredCandidates.slice(
    0,
    Math.max(0, input.options.filteredMaxAddresses),
  );

  return Object.freeze({
    fullTargets: Object.freeze(fullTargets),
    filteredTargets: Object.freeze(filteredTargets),
    canonicalTargetCount: canonical.length,
    dynamicTargetCount: dynamic.length,
    graphTargetCount: graph.length,
    filteredTruncated: filteredTargets.length < fullTargets.length,
  });
}

function uniqueAddresses(values: readonly string[]): string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let normalized: string;
    try {
      normalized = ethers.getAddress(value);
    } catch {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(normalized);
  }
  return addresses;
}
