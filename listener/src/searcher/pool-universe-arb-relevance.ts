export interface RankablePool {
  key: string;
  token0?: string;
  token1?: string;
  tokens?: string[];
  count: number;
  lastSwapBlock: number;
}

export interface ArbRelevanceConfig {
  enabled: boolean;
  maxPools: number;
}

// Returns the selected pools (<= maxPools), loop-completers first.
export function selectArbRelevantPools<T extends RankablePool>(
  candidates: T[],
  externalTokenPools: Iterable<{ token0?: string; token1?: string; tokens?: string[] }>,
  cfg: ArbRelevanceConfig,
): T[] {
  if (!cfg.enabled) {
    return [...candidates]
      .sort((a, b) => b.count - a.count || b.lastSwapBlock - a.lastSwapBlock)
      .slice(0, cfg.maxPools);
  }

  const tokenDegree = buildTokenDegree(candidates, externalTokenPools);
  return [...candidates]
    .sort((a, b) =>
      Number(isLoopCompleter(b, tokenDegree)) - Number(isLoopCompleter(a, tokenDegree)) ||
      b.count - a.count ||
      b.lastSwapBlock - a.lastSwapBlock
    )
    .slice(0, cfg.maxPools);
}

function buildTokenDegree(
  candidates: RankablePool[],
  externalTokenPools: Iterable<{ token0?: string; token1?: string; tokens?: string[] }>,
): Map<string, number> {
  const degree = new Map<string, number>();
  const seenCandidates = new Set<string>();

  for (const pool of candidates) {
    const key = pool.key.toLowerCase();
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    addPoolTokens(degree, pool);
  }
  for (const pool of externalTokenPools) {
    addPoolTokens(degree, pool);
  }

  return degree;
}

function addPoolTokens(
  degree: Map<string, number>,
  pool: { token0?: string; token1?: string; tokens?: string[] },
): void {
  const tokens = new Set<string>();
  if (pool.token0) tokens.add(pool.token0.toLowerCase());
  if (pool.token1) tokens.add(pool.token1.toLowerCase());
  for (const token of pool.tokens ?? []) tokens.add(token.toLowerCase());
  for (const token of tokens) {
    degree.set(token, (degree.get(token) ?? 0) + 1);
  }
}

function isLoopCompleter(pool: RankablePool, tokenDegree: Map<string, number>): boolean {
  const tokens = new Set<string>();
  if (pool.token0) tokens.add(pool.token0.toLowerCase());
  if (pool.token1) tokens.add(pool.token1.toLowerCase());
  for (const token of pool.tokens ?? []) tokens.add(token.toLowerCase());
  return [...tokens].filter((token) => (tokenDegree.get(token) ?? 0) >= 2).length >= 2;
}
