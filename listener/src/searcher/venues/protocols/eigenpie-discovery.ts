import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { TokenEdge } from "../../planner/token-graph.js";
import type { OnchainIdentityResolver } from "../identity.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
} from "../route-leg-adapter.js";
import {
  exactReceiptDepositFactsMatch,
  erc20TransferMatches,
  simulateReceiptDeposit,
} from "./receipt-deposit-framework.js";

export const EIGENPIE_POOL_ADAPTER = "eigenpie-deposit-router" as const;
export const EIGENPIE_DEPOSIT_EDGE_ADAPTER = "eigenpie-deposit-asset" as const;

export const eigenpieIface = new ethers.Interface([
  "function depositAsset(address asset,uint256 depositAmount,uint256 minRec,address referral)",
  "function getMLRTAmountToMint(address asset,uint256 amount) view returns (uint256 amountOut,address receiptToken)",
  "event AssetDeposit(address indexed depositor,address indexed asset,uint256 depositAmount,address indexed referral,uint256 mintedAmount,bool isPreDeposit)",
]);
const eigenpieTraceIface = new ethers.Interface([
  "function transferFrom(address from,address to,uint256 amount) returns (bool)",
  "function mint(address to,uint256 amount)",
]);

export const EIGENPIE_DEPOSIT_SELECTOR = eigenpieIface
  .getFunction("depositAsset")!.selector.toLowerCase();
export const EIGENPIE_DEPOSIT_EVENT_TOPIC = eigenpieIface
  .getEvent("AssetDeposit")!.topicHash.toLowerCase();
const TRANSFER_FROM_SELECTOR = eigenpieTraceIface.getFunction("transferFrom")!.selector.toLowerCase();
const MINT_SELECTOR = eigenpieTraceIface.getFunction("mint")!.selector.toLowerCase();

/** Synthetic holder exists only inside state-override simulations. */
export const EIGENPIE_DEPOSIT_PROBE_HOLDER = ethers.getAddress(
  `0x${"00".repeat(18)}cafe`,
);

export interface EigenpieDepositEvidence {
  readonly kind: "eigenpie-deposit-observation";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly depositor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly referral: string;
}

export const eigenpieDiscovery: ProtocolDiscoveryCapability = Object.freeze({
  candidateSources: Object.freeze(["observed-interaction"] as const),
  eventTopics: Object.freeze([EIGENPIE_DEPOSIT_EVENT_TOPIC]),
  callSelectors: Object.freeze([EIGENPIE_DEPOSIT_SELECTOR]),
  observedMatcherVersion: "eigenpie-deposit-observed-v1",

  async candidateFromObservedCall(call) {
    return candidateFromEigenpieDeposit(call);
  },

  async probeCandidate(instance, context) {
    return probeEigenpieDepositCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const eigenpieIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  candidate,
}) => {
  if (poolAdapter !== EIGENPIE_POOL_ADAPTER) {
    throw new Error(`Eigenpie deposit identity: unsupported pool adapter ${poolAdapter}`);
  }
  const tokenIn = candidate.fixedTokenIn;
  const tokenOut = candidate.fixedTokenOut;
  if (!tokenIn || !tokenOut || !backend.getCode) {
    return { ok: false, reason: "behavior_mismatch" };
  }
  try {
    const [targetCode, tokenInCode, tokenOutCode] = await Promise.all([
      backend.getCode(pool),
      backend.getCode(tokenIn),
      backend.getCode(tokenOut),
    ]);
    if ([targetCode, tokenInCode, tokenOutCode].some((code) => code === "0x")) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const quote = await quoteEigenpieDeposit(
      backend,
      pool,
      tokenIn,
      tokenOut,
      0n,
    );
    if (quote !== 0n) return { ok: false, reason: "behavior_mismatch" };
    if (candidate.logicalInstanceId !== pairInstanceId(tokenIn, tokenOut)) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    return {
      ok: true,
      adapter: EIGENPIE_POOL_ADAPTER,
      venueId: "unknown",
      identitySource: "eigenpie-compatible-call-surface",
    };
  } catch (error) {
    return {
      ok: false,
      reason: isPermanentBehaviorFailure(error) ? "behavior_mismatch" : "identity_call_failed",
    };
  }
};

export async function quoteEigenpieDeposit(
  backend: { call(req: { to: string; data: string; from?: string }): Promise<string> },
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const raw = await backend.call({
    to: target,
    data: eigenpieIface.encodeFunctionData("getMLRTAmountToMint", [
      tokenIn,
      amountIn,
    ]),
  });
  const decoded = eigenpieIface.decodeFunctionResult(
    "getMLRTAmountToMint",
    raw,
  );
  const amountOut = BigInt(decoded[0]);
  const reportedTokenOut = ethers.getAddress(String(decoded[1]));
  if (reportedTokenOut.toLowerCase() !== ethers.getAddress(tokenOut).toLowerCase()) {
    throw new Error(
      `Eigenpie deposit output token drift: expected ${tokenOut}, got ${reportedTokenOut}`,
    );
  }
  return amountOut;
}

export async function probeEigenpieDepositCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  const tokenIn = ethers.getAddress(instance.pool.fixedTokenIn ?? ethers.ZeroAddress);
  const tokenOut = ethers.getAddress(instance.pool.fixedTokenOut ?? ethers.ZeroAddress);
  if (tokenIn === ethers.ZeroAddress || tokenOut === ethers.ZeroAddress || tokenIn === tokenOut) {
    throw new Error("Eigenpie deposit candidate missing a distinct token pair");
  }
  if (instance.pool.logicalInstanceId !== pairInstanceId(tokenIn, tokenOut)) {
    throw new Error("Eigenpie deposit logical instance does not match its token pair");
  }
  const graphTokens = new Set(context.graphTokens.map((token) => token.toLowerCase()));
  if (!graphTokens.has(tokenIn.toLowerCase()) || !graphTokens.has(tokenOut.toLowerCase())) {
    throw new Error("Eigenpie deposit route is not loop-closable in the DEX token domain");
  }

  const samples = [...new Set(
    instance.evidence
      .filter(isEigenpieDepositEvidence)
      .filter((item) =>
        item.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        item.tokenOut.toLowerCase() === tokenOut.toLowerCase() &&
        item.amountIn > 0n && item.amountOut > 0n)
      .map((item) => item.amountIn.toString()),
  )].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).slice(0, 3);
  if (samples.length === 0) {
    throw new Error("Eigenpie deposit route lacks receipt-bound nonzero evidence");
  }
  if (!context.backend.simulateCalls) {
    throw new Error("Eigenpie deposit requires state-override execution simulation");
  }

  let verified = false;
  for (const amountIn of samples) {
    if (await activelyProbeDeposit(context, target, tokenIn, tokenOut, amountIn)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error("Eigenpie deposit nonzero execution probe failed");

  return [{
    adapterId: EIGENPIE_DEPOSIT_EDGE_ADAPTER,
    target,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction: "wrap",
    score: instance.pool.score,
    ...deriveEdgeTaxonomy("protocol", "wrap"),
  }];
}

async function candidateFromEigenpieDeposit(call: {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
  readonly from?: string;
  readonly txHash: string;
  readonly receipt: { readonly status: number | null; readonly logs: readonly ProtocolDiscoveryLog[] };
  readonly trace: unknown;
}): Promise<ProtocolCandidate | null> {
  if (call.receipt.status !== 1 || !call.from) return null;
  let target: string;
  let depositor: string;
  let tokenIn: string;
  let referral: string;
  let amountIn: bigint;
  let minAmountOut: bigint;
  try {
    target = ethers.getAddress(call.target);
    depositor = ethers.getAddress(call.from);
    const decoded = eigenpieIface.decodeFunctionData("depositAsset", call.input);
    tokenIn = ethers.getAddress(String(decoded[0]));
    amountIn = BigInt(decoded[1]);
    minAmountOut = BigInt(decoded[2]);
    referral = ethers.getAddress(String(decoded[3]));
  } catch {
    return null;
  }
  if (amountIn <= 0n || tokenIn === ethers.ZeroAddress) return null;

  const inputPaid = call.receipt.logs.some((log) => erc20TransferMatches(
    log,
    tokenIn,
    depositor,
    target,
    amountIn,
  ));
  if (!inputPaid) return null;

  const matches: EigenpieDepositEvidence[] = [];
  for (const log of call.receipt.logs) {
    if (
      log.address.toLowerCase() !== target.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== EIGENPIE_DEPOSIT_EVENT_TOPIC
    ) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = eigenpieIface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const eventDepositor = ethers.getAddress(String(parsed.args.depositor));
    const eventAsset = ethers.getAddress(String(parsed.args.asset));
    const eventReferral = ethers.getAddress(String(parsed.args.referral));
    const depositAmount = BigInt(parsed.args.depositAmount);
    const mintedAmount = BigInt(parsed.args.mintedAmount);
    const isPreDeposit = Boolean(parsed.args.isPreDeposit);
    if (
      eventDepositor.toLowerCase() !== depositor.toLowerCase() ||
      eventAsset.toLowerCase() !== tokenIn.toLowerCase() ||
      eventReferral.toLowerCase() !== referral.toLowerCase() ||
      depositAmount !== amountIn ||
      mintedAmount <= 0n ||
      mintedAmount < minAmountOut ||
      isPreDeposit
    ) continue;
    const outputTokens = new Set(
      call.receipt.logs
        .filter((item) => erc20TransferMatches(
          item,
          item.address,
          ethers.ZeroAddress,
          depositor,
          mintedAmount,
        ))
        .map((item) => ethers.getAddress(item.address)),
    );
    if (outputTokens.size !== 1) continue;
    const tokenOut = [...outputTokens][0];
    if (tokenOut.toLowerCase() === tokenIn.toLowerCase()) continue;
    if (!traceHasCausalDeposit(
      call.trace,
      target,
      depositor,
      call.input,
      tokenIn,
      tokenOut,
      amountIn,
      mintedAmount,
    )) continue;
    const blockNumber = log.blockNumber;
    if (blockNumber === undefined || !Number.isSafeInteger(blockNumber) || blockNumber < 0) continue;
    matches.push({
      kind: "eigenpie-deposit-observation",
      txHash: call.txHash,
      blockNumber,
      depositor,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: mintedAmount,
      referral,
    });
  }
  const unique = new Map(matches.map((item) => [
    `${item.tokenIn.toLowerCase()}>${item.tokenOut.toLowerCase()}|${item.amountOut}`,
    item,
  ]));
  if (unique.size !== 1) return null;
  const evidence = [...unique.values()][0];
  return {
    pool: {
      address: target,
      adapter: EIGENPIE_POOL_ADAPTER,
      fixedTokenIn: evidence.tokenIn,
      fixedTokenOut: evidence.tokenOut,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "wrap",
      logicalInstanceId: pairInstanceId(evidence.tokenIn, evidence.tokenOut),
    },
    source: "observed-calltrace",
    selector: call.selector,
    evidence: [evidence],
  };
}

async function activelyProbeDeposit(
  context: ProtocolDiscoveryContext,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<boolean> {
  const amountOut = await quoteEigenpieDeposit(
    context.backend,
    target,
    tokenIn,
    tokenOut,
    amountIn,
  );
  if (amountOut <= 0n) return false;
  const facts = await simulateReceiptDeposit({
    context,
    target,
    asset: tokenIn,
    receipt: tokenOut,
    amountIn,
    fallbackHolder: EIGENPIE_DEPOSIT_PROBE_HOLDER,
    encodeDeposit: () => eigenpieIface.encodeFunctionData("depositAsset", [
        tokenIn,
        amountIn,
        amountOut,
        ethers.ZeroAddress,
      ]),
    assetRecipient: target,
  });
  return facts !== null && exactReceiptDepositFactsMatch({
    facts,
    expectedAmountOut: amountOut,
    assetRecipient: target,
  }) && eigenpieDepositLogsMatch(
    facts.depositLogs,
    target,
    facts.holder,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
  );
}

function eigenpieDepositLogsMatch(
  logs: readonly ProtocolDiscoveryLog[],
  target: string,
  depositor: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
): boolean {
  const inputPaid = logs.some((log) => erc20TransferMatches(log, tokenIn, depositor, target, amountIn));
  const outputMinted = logs.some((log) =>
    erc20TransferMatches(log, tokenOut, ethers.ZeroAddress, depositor, amountOut));
  const deposited = logs.some((log) => {
    if (
      log.address.toLowerCase() !== target.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== EIGENPIE_DEPOSIT_EVENT_TOPIC
    ) return false;
    try {
      const parsed = eigenpieIface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed !== null &&
        ethers.getAddress(String(parsed.args.depositor)).toLowerCase() === depositor.toLowerCase() &&
        ethers.getAddress(String(parsed.args.asset)).toLowerCase() === tokenIn.toLowerCase() &&
        ethers.getAddress(String(parsed.args.referral)) === ethers.ZeroAddress &&
        BigInt(parsed.args.depositAmount) === amountIn &&
        BigInt(parsed.args.mintedAmount) === amountOut &&
        Boolean(parsed.args.isPreDeposit) === false;
    } catch {
      return false;
    }
  });
  return inputPaid && outputMinted && deposited;
}

function traceHasCausalDeposit(
  trace: unknown,
  target: string,
  depositor: string,
  input: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
): boolean {
  const inspectSubtree = (node: unknown, ancestorFailed: boolean): {
    transferFrom: boolean;
    mint: boolean;
  } => {
    if (!node || typeof node !== "object") return { transferFrom: false, mint: false };
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    let transferFrom = false;
    let mint = false;
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      try {
        const to = ethers.getAddress(call.to);
        const calldata = call.input.toLowerCase();
        if (to.toLowerCase() === tokenIn.toLowerCase() && calldata.startsWith(TRANSFER_FROM_SELECTOR)) {
          const decoded = eigenpieTraceIface.decodeFunctionData("transferFrom", call.input);
          transferFrom =
            ethers.getAddress(String(decoded[0])).toLowerCase() === depositor.toLowerCase() &&
            ethers.getAddress(String(decoded[1])).toLowerCase() === target.toLowerCase() &&
            BigInt(decoded[2]) === amountIn;
        }
        if (to.toLowerCase() === tokenOut.toLowerCase() && calldata.startsWith(MINT_SELECTOR)) {
          const decoded = eigenpieTraceIface.decodeFunctionData("mint", call.input);
          mint = ethers.getAddress(String(decoded[0])).toLowerCase() === depositor.toLowerCase() &&
            BigInt(decoded[1]) === amountOut;
        }
      } catch {
        // Malformed child calldata does not establish behavior.
      }
    }
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) {
        const childResult = inspectSubtree(child, failed);
        transferFrom ||= childResult.transferFrom;
        mint ||= childResult.mint;
      }
    }
    return { transferFrom, mint };
  };

  const visit = (node: unknown, ancestorFailed: boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const call = node as {
      to?: unknown;
      from?: unknown;
      input?: unknown;
      error?: unknown;
      calls?: unknown;
    };
    const failed = ancestorFailed || Boolean(call.error);
    if (
      !failed &&
      typeof call.to === "string" &&
      typeof call.from === "string" &&
      typeof call.input === "string"
    ) {
      try {
        if (
          ethers.getAddress(call.to).toLowerCase() === target.toLowerCase() &&
          ethers.getAddress(call.from).toLowerCase() === depositor.toLowerCase() &&
          call.input.toLowerCase() === input.toLowerCase()
        ) {
          const result = inspectSubtree(node, ancestorFailed);
          if (result.transferFrom && result.mint) return true;
        }
      } catch {
        // Keep scanning sibling calls.
      }
    }
    return Array.isArray(call.calls) && call.calls.some((child) => visit(child, failed));
  };
  return visit(trace, false);
}

export function pairInstanceId(tokenIn: string, tokenOut: string): string {
  return `${ethers.getAddress(tokenIn).toLowerCase()}>${ethers.getAddress(tokenOut).toLowerCase()}`;
}

function isEigenpieDepositEvidence(value: unknown): value is EigenpieDepositEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EigenpieDepositEvidence>;
  return item.kind === "eigenpie-deposit-observation" &&
    typeof item.txHash === "string" &&
    typeof item.blockNumber === "number" &&
    typeof item.tokenIn === "string" &&
    typeof item.tokenOut === "string" &&
    typeof item.amountIn === "bigint" &&
    typeof item.amountOut === "bigint";
}

function isPermanentBehaviorFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set(["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT", "NUMERIC_FAULT"]).has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|could not decode|invalid (?:result|data|address)|output token drift/i
    .test(message);
}
