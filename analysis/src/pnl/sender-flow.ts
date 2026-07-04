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

export interface SenderFlowResult {
  submission_method: "bundle" | "public_mempool" | "unknown";
  source_visibility: "seen_by_us" | "not_seen_by_us" | "unknown";
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
  const sourceVisibility = sourceVisibilityFor(input.seenInOurPublicFeed);
  const submissionMethod = submissionMethodFor(input, sourceVisibility, destIsPublicRouter);
  const evidence = evidenceFor(input, sourceVisibility, destIsPublicRouter);
  const signals: SenderFlowResult["signals"] = {
    coinbase_transfer_wei: input.coinbaseTransferWei.toString(),
    priority_tip_wei: input.priorityTipWei.toString(),
    max_priority_fee_per_gas_wei: input.maxPriorityFeePerGasWei.toString(),
    seen_in_our_public_feed: input.seenInOurPublicFeed,
    dest_is_public_router: destIsPublicRouter,
    dest_has_code: input.toHasCode,
    builder: input.builder,
  };

  return result(
    submissionMethod,
    sourceVisibility,
    confidenceFor(submissionMethod, sourceVisibility, destIsPublicRouter),
    evidence,
    signals,
  );
}

function sourceVisibilityFor(seenInOurPublicFeed: boolean | null): SenderFlowResult["source_visibility"] {
  if (seenInOurPublicFeed === true) return "seen_by_us";
  if (seenInOurPublicFeed === false) return "not_seen_by_us";
  return "unknown";
}

function submissionMethodFor(
  input: SenderFlowInput,
  sourceVisibility: SenderFlowResult["source_visibility"],
  destIsPublicRouter: boolean,
): SenderFlowResult["submission_method"] {
  if (
    input.coinbaseTransferWei > 0n
    || input.maxPriorityFeePerGasWei === 0n
    || input.priorityTipWei === 0n
  ) {
    return "bundle";
  }
  if (sourceVisibility === "seen_by_us" || destIsPublicRouter) return "public_mempool";
  return "unknown";
}

function evidenceFor(
  input: SenderFlowInput,
  sourceVisibility: SenderFlowResult["source_visibility"],
  destIsPublicRouter: boolean,
): string[] {
  const evidence: string[] = [];
  if (sourceVisibility === "seen_by_us") evidence.push("seen_in_our_public_feed");
  if (sourceVisibility === "not_seen_by_us") evidence.push("not_seen_in_our_public_feed");
  if (input.coinbaseTransferWei > 0n) evidence.push("coinbase_transfer_bundle");
  if (input.maxPriorityFeePerGasWei === 0n || input.priorityTipWei === 0n) {
    evidence.push("zero_priority_tip_bundle");
  }
  if (destIsPublicRouter) evidence.push("dest_public_router");
  if (evidence.length === 0) evidence.push("no_discriminating_signal");
  return evidence;
}

function confidenceFor(
  submissionMethod: SenderFlowResult["submission_method"],
  sourceVisibility: SenderFlowResult["source_visibility"],
  destIsPublicRouter: boolean,
): SenderFlowResult["confidence"] {
  if (submissionMethod === "bundle") return "high";
  if (sourceVisibility === "seen_by_us") return "high";
  if (destIsPublicRouter) return "med";
  return "low";
}

function result(
  submissionMethod: SenderFlowResult["submission_method"],
  sourceVisibility: SenderFlowResult["source_visibility"],
  confidence: SenderFlowResult["confidence"],
  evidence: string[],
  signals: SenderFlowResult["signals"],
): SenderFlowResult {
  return {
    submission_method: submissionMethod,
    source_visibility: sourceVisibility,
    confidence,
    evidence,
    signals,
  };
}

function isKnownPublicRouter(addr: string | null | undefined): boolean {
  return isPublicRouter(addr) || Boolean(addr && PUBLIC_ROUTERS.has(lower(addr)));
}
