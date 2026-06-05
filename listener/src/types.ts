export interface PendingTx {
  hash: string;
  from: string;
  to: string | null;
  data: string;
  value: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface SimResult {
  opportunity: boolean;
  wstUsrProfit: string;
  wethProfit: string;
  wstUsrProfitWethValue: string;
  netTotalWethProfit: string;
  gasUsed: number;
  gasCostWei: string;
  calldataHex: string;
  victimRawTx: string;
  scriptLength: number;
  calldataLength: number;
  bundleValid: boolean;
}

export interface SubmitResult {
  builder: string;
  accepted: boolean;
  bundleHash?: string;
  error?: string;
}

export interface FilterMatch {
  txHash: string;
  pool: string;
  direction: "wstUSR_to_DOLA" | "DOLA_to_wstUSR";
  amount: bigint;
}

export interface ListenerConfig {
  rpcUrl: string;
  wsUrl: string;
  dryRun: boolean;
  duration: number; // seconds, 0 = indefinite
  minSwapSize: bigint; // minimum wstUSR amount to trigger
  projectRoot: string; // path to MEV project root for forge
}

// ─── V3 Plan Types ─────────────────────────────────────────────

export enum ActionKind {
  FlashLoan = "flash-loan",
  Lend = "lend",
  Swap = "swap",
  Repay = "repay",
  Guard = "guard",
  Approve = "approve",
  Transfer = "transfer",
  Wrap = "wrap",
}

/** Dynamic amount reference — resolved to literal by solver before compilation. */
export type AmountRef =
  | { kind: "literal"; value: bigint }
  | { kind: "balance"; token: string; account: "executor" }
  | { kind: "balance-bps"; token: string; account: "executor"; bps: number }
  | { kind: "delta-since-snapshot"; token: string; snapshotId: string }
  | { kind: "callback-amount0" }
  | { kind: "callback-amount1" };

/** Plan node with potentially unresolved amounts (solver stage). */
export interface PlanNode {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  amount: AmountRef;
  params: Record<string, any>;
  children: PlanNode[];
}

/** Resolved param type — supports primitives, arrays, bytes. */
export type ResolvedParam =
  | bigint
  | string
  | boolean
  | bigint[]
  | string[]
  | Uint8Array;

/** Plan node with all amounts resolved to concrete values. compilePlan() input. */
export interface ResolvedPlanNode {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  params: Record<string, ResolvedParam>;
  children: ResolvedPlanNode[];
}

/** Trace classifier output — tree structure from callTracer. */
export interface NormalizedCallNode {
  kind: ActionKind;
  protocol: string;
  target: string;
  selector: string;
  tokenIn?: string;
  tokenOut?: string;
  depth: number;
  callIndex: number;
  calldata: string;
  children: NormalizedCallNode[];
}

/** Adapter interface — one per protocol interaction type. */
export interface ActionAdapter {
  id: string;
  isWrapper: boolean;
  field2Offset: number | ((node: ResolvedPlanNode) => number) | null;

  /** Encode action as BotVM opcodes. Only accepts ResolvedPlanNode. */
  encode(
    node: ResolvedPlanNode,
    executor: string,
    innerScript: Uint8Array,
  ): Uint8Array;

  /** Match a trace call to this adapter (by target + selector). */
  matchTrace(target: string, selector: string): boolean;
}
