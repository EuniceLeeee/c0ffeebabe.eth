import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
import type { PoolEntry, TokenEdge } from "../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type {
  PlanBuildContext,
  PlanFragment,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
} from "../route-leg-adapter.js";

const erc20Iface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const MAX_UINT = (1n << 256n) - 1n;

/**
 * Shared invariants for one-way asset -> receipt deposits. This is a framework,
 * not a registered execution family: each ABI/call shape keeps its own adapter,
 * identity resolver, discovery matcher, quote and calldata encoder.
 */
export const RECEIPT_DEPOSIT_TAXONOMY = Object.freeze({
  slotKind: "protocol" as const,
  protocolAction: "wrap" as const,
});

export function buildReceiptDepositEdge(input: {
  readonly edgeAdapterId: string;
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly score?: number;
}): TokenEdge {
  const target = ethers.getAddress(input.target);
  const asset = ethers.getAddress(input.asset);
  const receipt = ethers.getAddress(input.receipt);
  if (asset === receipt) throw new Error("receipt deposit requires distinct asset and receipt tokens");
  return {
    adapterId: input.edgeAdapterId,
    target,
    tokenIn: asset,
    tokenOut: receipt,
    ...RECEIPT_DEPOSIT_TAXONOMY,
    score: input.score,
    ...deriveEdgeTaxonomy(
      RECEIPT_DEPOSIT_TAXONOMY.slotKind,
      RECEIPT_DEPOSIT_TAXONOMY.protocolAction,
    ),
  };
}

export function requireVerifiedReceiptDepositRoute(input: {
  readonly pool: PoolEntry;
  readonly edgeAdapterId: string;
  readonly logicalInstanceId?: string;
}): { readonly asset: string; readonly receipt: string } {
  const asset = ethers.getAddress(input.pool.fixedTokenIn ?? ethers.ZeroAddress);
  const receipt = ethers.getAddress(input.pool.fixedTokenOut ?? ethers.ZeroAddress);
  if (asset === ethers.ZeroAddress || receipt === ethers.ZeroAddress || asset === receipt) {
    throw new Error("receipt deposit pool is missing a distinct fixed pair");
  }
  if (
    input.logicalInstanceId !== undefined &&
    input.pool.logicalInstanceId !== input.logicalInstanceId
  ) {
    throw new Error("receipt deposit pool has a mismatched logical instance id");
  }
  if (input.pool.verifiedRoutes?.length !== 1) {
    throw new Error("receipt deposit pool requires exactly one probe-verified route");
  }
  const [route] = input.pool.verifiedRoutes;
  if (
    route.edgeAdapterId !== input.edgeAdapterId ||
    route.tokenIn.toLowerCase() !== asset.toLowerCase() ||
    route.tokenOut.toLowerCase() !== receipt.toLowerCase() ||
    route.slotKind !== RECEIPT_DEPOSIT_TAXONOMY.slotKind ||
    route.protocolAction !== RECEIPT_DEPOSIT_TAXONOMY.protocolAction
  ) {
    throw new Error("receipt deposit verified route differs from its attested pair");
  }
  return { asset, receipt };
}

export function assertReceiptDepositQuote(amountIn: bigint, amountOut: bigint): void {
  if (amountIn < 0n) throw new Error("receipt deposit quote received a negative input");
  if (amountOut < 0n) throw new Error("receipt deposit quote returned a negative amount");
  if (amountIn === 0n && amountOut !== 0n) {
    throw new Error("receipt deposit zero-input quote must return zero");
  }
  if (amountIn > 0n && amountOut <= 0n) {
    throw new Error("receipt deposit positive-input quote must return a positive amount");
  }
}

export function buildReceiptDepositPlanFragment(
  ctx: PlanBuildContext,
  options: {
    readonly params?: ResolvedPlanNode["params"];
    readonly allowance?: "exact" | "max";
  } = {},
): PlanFragment {
  if (
    ctx.edge.slotKind !== RECEIPT_DEPOSIT_TAXONOMY.slotKind ||
    ctx.edge.protocolAction !== RECEIPT_DEPOSIT_TAXONOMY.protocolAction ||
    ctx.edge.leavesStandingPosition
  ) {
    throw new Error("receipt deposit plan requires a standing-safe asset-to-receipt edge");
  }
  assertReceiptDepositQuote(ctx.amountIn, ctx.amountOut);
  return {
    requirements: [{
      kind: "approve",
      token: ctx.edge.tokenIn,
      spender: ctx.edge.target,
      amount: options.allowance === "max" ? MAX_UINT : ctx.amountIn,
    }],
    nodes: [{
      adapterId: ctx.edge.adapterId,
      target: ctx.edge.target,
      tokenIn: ctx.edge.tokenIn,
      tokenOut: ctx.edge.tokenOut,
      amount: ctx.amountIn,
      params: { ...(options.params ?? {}) },
      children: [],
    }],
  };
}

export interface ReceiptDepositSimulationFacts {
  readonly amountIn: bigint;
  readonly holder: string;
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly holderAssetAfter: bigint;
  readonly recipientAssetBefore: bigint | null;
  readonly recipientAssetAfter: bigint | null;
  readonly holderReceiptBefore: bigint;
  readonly holderReceiptAfter: bigint;
  readonly receiptSupplyBefore: bigint;
  readonly receiptSupplyAfter: bigint;
  readonly receiptBalanceDelta: bigint;
  readonly receiptSupplyDelta: bigint;
  readonly depositReturnData: string;
  readonly depositLogs: readonly ProtocolDiscoveryLog[];
}

/**
 * Runs the common nonzero execution proof on one block-pinned simulation:
 * fund caller -> approve -> family deposit -> measure balances, supply, return
 * data and logs. It deliberately returns facts rather than deciding protocol
 * semantics: quote rounding, event shape, asset destination and calldata remain
 * owned by ERC4626/Eigenpie/RockSolid execution adapters.
 */
export async function simulateReceiptDeposit(input: {
  readonly context: ProtocolDiscoveryContext;
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly amountIn: bigint;
  readonly fallbackHolder: string;
  readonly encodeDeposit: (holder: string) => string;
  /** Defaults to target. Set null when a valid adapter may forward assets in-call. */
  readonly assetRecipient?: string | null;
}): Promise<ReceiptDepositSimulationFacts | null> {
  const simulate = input.context.backend.simulateCalls?.bind(input.context.backend);
  if (!simulate || input.amountIn <= 0n) return null;

  const target = ethers.getAddress(input.target);
  const asset = ethers.getAddress(input.asset);
  const receipt = ethers.getAddress(input.receipt);
  const holder = ethers.getAddress(input.context.probeExecutor ?? input.fallbackHolder);
  const assetRecipient = input.assetRecipient === undefined
    ? target
    : input.assetRecipient === null ? null : ethers.getAddress(input.assetRecipient);

  const assetCode = await input.context.backend.getCode(asset);
  if (assetCode === "0x") return null;
  const implementationWord = await input.context.backend.getStorageAt(asset, IMPLEMENTATION_SLOT);
  const stateFingerprint = ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.keccak256(assetCode)),
    ethers.getBytes(implementationWord),
  ]));
  const slotKey = await discoverErc20BalanceStorageSlot({
    context: input.context,
    token: asset,
    holder,
    codeHash: stateFingerprint,
    probeValue: input.amountIn,
  });
  if (!slotKey) return null;

  const [holderReceiptBefore, receiptSupplyBefore, recipientAssetBefore] = await Promise.all([
    readErc20Uint(input.context, receipt, "balanceOf", [holder]),
    readErc20Uint(input.context, receipt, "totalSupply", []),
    assetRecipient === null
      ? Promise.resolve(0n)
      : readErc20Uint(input.context, asset, "balanceOf", [assetRecipient]),
  ]);
  const calls = [
    {
      from: holder,
      to: asset,
      data: erc20Iface.encodeFunctionData("approve", [target, input.amountIn]),
    },
    { from: holder, to: target, data: input.encodeDeposit(holder) },
    {
      from: holder,
      to: asset,
      data: erc20Iface.encodeFunctionData("balanceOf", [holder]),
    },
    {
      from: holder,
      to: receipt,
      data: erc20Iface.encodeFunctionData("balanceOf", [holder]),
    },
    {
      from: holder,
      to: receipt,
      data: erc20Iface.encodeFunctionData("totalSupply"),
    },
    ...(assetRecipient === null ? [] : [{
      from: holder,
      to: asset,
      data: erc20Iface.encodeFunctionData("balanceOf", [assetRecipient]),
    }]),
  ] as const;
  const results = await simulate({
    calls,
    stateOverrides: {
      [asset]: { stateDiff: { [slotKey]: ethers.toBeHex(input.amountIn, 32) } },
    },
  });
  if (results.length !== calls.length || results.some((result) => result.status !== 1)) return null;

  let holderAssetAfter: bigint;
  let holderReceiptAfter: bigint;
  let receiptSupplyAfter: bigint;
  let recipientAssetAfter: bigint | null = null;
  try {
    holderAssetAfter = decodeErc20Uint("balanceOf", results[2].returnData);
    holderReceiptAfter = decodeErc20Uint("balanceOf", results[3].returnData);
    receiptSupplyAfter = decodeErc20Uint("totalSupply", results[4].returnData);
    if (assetRecipient !== null) {
      recipientAssetAfter = decodeErc20Uint("balanceOf", results[5].returnData);
    }
  } catch {
    return null;
  }
  const receiptBalanceDelta = holderReceiptAfter - holderReceiptBefore;
  const receiptSupplyDelta = receiptSupplyAfter - receiptSupplyBefore;
  return {
    amountIn: input.amountIn,
    holder,
    target,
    asset,
    receipt,
    holderAssetAfter,
    recipientAssetBefore: assetRecipient === null ? null : recipientAssetBefore,
    recipientAssetAfter,
    holderReceiptBefore,
    holderReceiptAfter,
    receiptSupplyBefore,
    receiptSupplyAfter,
    receiptBalanceDelta,
    receiptSupplyDelta,
    depositReturnData: results[1].returnData,
    depositLogs: results[1].logs,
  };
}

/** Common exact-in/mint invariant. Families opt into this after decoding their own quote. */
export function exactReceiptDepositFactsMatch(input: {
  readonly facts: ReceiptDepositSimulationFacts;
  readonly expectedAmountOut: bigint;
  readonly assetRecipient?: string | null;
  readonly requireSupplyDelta?: boolean;
}): boolean {
  const { facts } = input;
  assertReceiptDepositQuote(facts.amountIn, input.expectedAmountOut);
  const recipient = input.assetRecipient === undefined
    ? facts.target
    : input.assetRecipient === null ? null : ethers.getAddress(input.assetRecipient);
  const recipientDeltaMatches = recipient === null || (
    facts.recipientAssetBefore !== null &&
    facts.recipientAssetAfter === facts.recipientAssetBefore + facts.amountIn
  );
  return facts.holderAssetAfter === 0n &&
    facts.receiptBalanceDelta === input.expectedAmountOut &&
    (input.requireSupplyDelta === false || facts.receiptSupplyDelta === input.expectedAmountOut) &&
    recipientDeltaMatches &&
    facts.depositLogs.some((log) => erc20TransferMatches(
      log,
      facts.asset,
      facts.holder,
      recipient ?? facts.target,
      facts.amountIn,
    )) &&
    facts.depositLogs.some((log) => erc20TransferMatches(
      log,
      facts.receipt,
      ethers.ZeroAddress,
      facts.holder,
      input.expectedAmountOut,
    ));
}

export function erc20TransferMatches(
  log: ProtocolDiscoveryLog,
  token: string,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  if (
    log.address.toLowerCase() !== ethers.getAddress(token).toLowerCase() ||
    log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    log.topics.length < 3
  ) return false;
  try {
    return topicAddress(log.topics[1]).toLowerCase() === ethers.getAddress(from).toLowerCase() &&
      topicAddress(log.topics[2]).toLowerCase() === ethers.getAddress(to).toLowerCase() &&
      BigInt(log.data) === amount;
  } catch {
    return false;
  }
}

async function readErc20Uint(
  context: ProtocolDiscoveryContext,
  token: string,
  fn: "balanceOf" | "totalSupply",
  args: readonly string[],
): Promise<bigint> {
  const raw = await context.backend.call({
    to: token,
    data: erc20Iface.encodeFunctionData(fn, args),
  });
  return decodeErc20Uint(fn, raw);
}

function decodeErc20Uint(fn: "balanceOf" | "totalSupply", raw: string): bigint {
  return BigInt(erc20Iface.decodeFunctionResult(fn, raw)[0]);
}

function topicAddress(topic: string): string {
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}
