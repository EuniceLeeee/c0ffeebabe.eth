const WETH_ADDR = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export type ProfitTokenValuationRule =
  | {
      token: string;
      decimals: number;
      kind: "usd-peg";
    }
  | {
      token: string;
      decimals: number;
      kind: "eth-fixed";
      /** ETH wei represented by one whole token. Supplied by a trusted/prewarmed source. */
      weiPerToken: bigint;
    };

/**
 * Synchronous valuation view shared by planner admission and the final EV gate.
 * Dynamic price sources must prewarm their result and publish an immutable view;
 * neither the planner hot path nor EV arithmetic performs network I/O.
 */
export interface ProfitTokenValuation {
  canValue(token: string): boolean;
  valueInEth(token: string, amount: bigint, ethUsd: number): bigint | null;
}

const DEFAULT_RULES: readonly ProfitTokenValuationRule[] = Object.freeze([
  { token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, kind: "usd-peg" },
  { token: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, kind: "usd-peg" },
  { token: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, kind: "usd-peg" },
  { token: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18, kind: "usd-peg" },
]);

class RuleBackedProfitTokenValuation implements ProfitTokenValuation {
  private readonly rules: ReadonlyMap<string, ProfitTokenValuationRule>;

  constructor(rules: readonly ProfitTokenValuationRule[]) {
    this.rules = new Map(rules.map((rule) => [rule.token.toLowerCase(), rule]));
  }

  canValue(token: string): boolean {
    const key = token.toLowerCase();
    return key === WETH_ADDR || this.rules.has(key);
  }

  valueInEth(token: string, amount: bigint, ethUsd: number): bigint | null {
    const key = token.toLowerCase();
    if (key === WETH_ADDR) return amount;
    const rule = this.rules.get(key);
    if (!rule) return null;
    const tokenUnit = 10n ** BigInt(rule.decimals);
    if (rule.kind === "eth-fixed") {
      return (amount * rule.weiPerToken) / tokenUnit;
    }
    if (!Number.isFinite(ethUsd) || ethUsd <= 0) return null;
    return (amount * 10n ** 18n) /
      (tokenUnit * BigInt(Math.round(ethUsd)));
  }
}

/** Build the production default view, optionally extended by trusted prewarmed prices. */
export function createProfitTokenValuation(
  additionalRules: readonly ProfitTokenValuationRule[] = [],
): ProfitTokenValuation {
  return new RuleBackedProfitTokenValuation([...DEFAULT_RULES, ...additionalRules]);
}

export const DEFAULT_PROFIT_TOKEN_VALUATION = createProfitTokenValuation();
