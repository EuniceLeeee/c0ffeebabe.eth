export type Hex = `0x${string}`;

export interface TxSummary {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: number;
  transactionIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  status: boolean;
}

export type ActionKind =
  | "fund.flashloan"
  | "fund.self"
  | "fund.flashmint"
  | "trade.swap"
  | "credit.deposit_collateral"
  | "credit.withdraw_collateral"
  | "credit.borrow"
  | "credit.repay"
  | "position.lp.mint"
  | "position.lp.burn"
  | "position.lp.rebalance"
  | "peg.redeem"
  | "peg.mint"
  | "wrap"
  | "unwrap"
  | "settlement.profit_transfer"
  | "settlement.coinbase_payment"
  | "unknown.action";

export interface Action {
  kind: ActionKind;
  protocol?: string;
  venue?: string;
  tokenIn?: string;
  tokenOut?: string;
  amount?: string;
  address?: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  order: number;
}

export interface TokenDelta {
  token: string;
  symbol: string;
  decimals: number;
  raw: bigint;
}

export interface TxAnalysis {
  tx: TxSummary;
  actor: string;
  candidateLabel: string;
  actionsFromLogs: Action[];
  actionsFromTrace?: Action[];
  canonicalSequence: string[];
  pathTemplate: string;
  strategyType: string;
  tokens: string[];
  venues: string[];
  protocols: string[];
  rawDeltas: TokenDelta[];
  roughPnlUsd: number | null;
  gasPaidEth: number;
  netExInternalBribeUsd: number | null;
  traceReason?: string;
}

export interface EntityEdge {
  from: string;
  to: string;
  edge: string;
  strength: "strong" | "medium" | "weak" | "ignored";
  evidence: string;
}

export interface StrategyCluster {
  id: string;
  pathTemplate: string;
  canonicalSequence: string[];
  txCount: number;
  representativeTx: string;
  tokens: string[];
  venues: string[];
  protocols: string[];
  funding: string;
  strategyType: string;
  roughPnlUsd: number | null;
  netFull: null;
  ourSupport: "supported" | "partial" | "unsupported" | "unknown";
  prodSupportGap: string[];
  ourGap: string[];
  nextAction: string[];
}
