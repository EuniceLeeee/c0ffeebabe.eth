import { lower } from "../registry/protocols.js";
import { PUBLIC_ROUTERS, isPublicRouter } from "../registry/routers.js";

export interface SenderFlowInput {
  txHash: string;
  to: string | null;
  toHasCode: boolean;
  maxPriorityFeePerGasWei: bigint;
  priorityTipWei: bigint;
  coinbaseTransferWei: bigint;
  builder: string;
  seenInOurPublicFeed: boolean | null;
}

export type SenderFlow = "public" | "private" | "unknown";

export interface SenderFlowResult {
  flow: SenderFlow;
  confidence: "high" | "med" | "low";
  evidence: string[];
  signals: {
    coinbase_transfer_wei: string;
    priority_tip_wei: string;
    max_priority_fee_per_gas_wei: string;
    seen_in_our_public_feed: boolean | null;
    dest_is_public_router: boolean;
    dest_has_code: boolean;
    builder: string;
  };
}

export function classifySenderFlow(input: SenderFlowInput): SenderFlowResult {
  const destIsPublicRouter = isKnownPublicRouter(input.to);
  const signals: SenderFlowResult["signals"] = {
    coinbase_transfer_wei: input.coinbaseTransferWei.toString(),
    priority_tip_wei: input.priorityTipWei.toString(),
    max_priority_fee_per_gas_wei: input.maxPriorityFeePerGasWei.toString(),
    seen_in_our_public_feed: input.seenInOurPublicFeed,
    dest_is_public_router: destIsPublicRouter,
    dest_has_code: input.toHasCode,
    builder: input.builder,
  };

  if (input.coinbaseTransferWei > 0n) {
    return result("private", "high", ["coinbase_transfer"], signals);
  }
  if (input.maxPriorityFeePerGasWei === 0n || input.priorityTipWei === 0n) {
    return result("private", "high", ["zero_priority_tip"], signals);
  }
  if (input.seenInOurPublicFeed === true) {
    return result("public", "high", ["seen_in_our_public_feed"], signals);
  }
  if (destIsPublicRouter) {
    return result("public", "med", ["dest_public_router"], signals);
  }
  if (input.toHasCode && !destIsPublicRouter) {
    return result("private", "low", ["dest_searcher_contract"], signals);
  }
  return result("unknown", "low", ["no_discriminating_signal"], signals);
}

function result(
  flow: SenderFlow,
  confidence: SenderFlowResult["confidence"],
  evidence: string[],
  signals: SenderFlowResult["signals"],
): SenderFlowResult {
  return { flow, confidence, evidence, signals };
}

function isKnownPublicRouter(addr: string | null | undefined): boolean {
  return isPublicRouter(addr) || Boolean(addr && PUBLIC_ROUTERS.has(lower(addr)));
}
