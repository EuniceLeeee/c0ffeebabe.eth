import { ethers } from "ethers";
import { randomUUID } from "node:crypto";
import { classifyTitanSubmissionReceipt, observedBuilderRequest, type BuilderEvidenceSink } from "./shared/builder-observations.js";
import { computeSubmissionFees, BRIBE_WALLET_RESERVE, type BribeGasBasis } from "./shared/submission-fees.js";
import type { SubmitResult } from "./types.js";
import { captureBoundedLiveSession, type BoundedLiveSession } from "./shared/bounded-live-session.js";

// ─── Builder Endpoints ─────────────────────────────────────────

interface BuilderEndpoint {
  name: string;
  url: string;
  endpointId?: string;
  authSigner: boolean; // needs X-Flashbots-Signature
}

const BUILDERS: BuilderEndpoint[] = [
  { name: "flashbots", url: "https://relay.flashbots.net", authSigner: true },
  { name: "titan", url: "https://us.rpc.titanbuilder.xyz", endpointId: "titan-us", authSigner: false },
  { name: "beaverbuild", url: "https://rpc.beaverbuild.org", authSigner: false },
  { name: "bombora", url: "https://rpc.bombora.build", authSigner: false },
  { name: "bobthebuilder", url: "https://rpc.bobthebuilder.xyz", authSigner: false },
];

// ─── Bundle Submission ─────────────────────────────────────────

/**
 * Sign the backrun tx and submit [victim, backrun] bundle to all builders.
 *
 * Flow:
 *   1. Build EIP-1559 tx calling BotVM.execute(calldata)
 *   2. Sign with owner wallet
 *   3. POST eth_sendBundle to each builder in parallel
 *   4. Return per-builder results
 *
 * Bundle failure = not included in block = zero cost.
 */
export async function submitBundle(params: {
  bribeGasBasis?: BribeGasBasis;
  expectedProfitEth?: bigint;
  evidence?: BuilderEvidenceSink;
  victimRawTx: string;
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
  targetBlock: number;
  bribeWei: bigint;
  maxBaseFeePerGas: bigint;
}): Promise<SubmitResult[]> {
  const {
    victimRawTx,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    targetBlock,
    bribeWei,
    maxBaseFeePerGas,
  } = params;

  // 1. Build backrun tx
  const { signedBackrunTx, backrunTxHash, gasLimit, nonce, liveSession, submissionId } = await buildSignedBackrunTx({
    evidence: params.evidence, bribeGasBasis: params.bribeGasBasis, expectedProfitEth: params.expectedProfitEth,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
    targetBlock,
    submissionMode: "victim",
  });

  const ts = new Date().toISOString();
  console.log(`[${ts}] Bundle constructed:`);
  console.log(`  target block: ${targetBlock}`);
  console.log(`  backrun to:   ${botvmAddress}`);
  console.log(`  gasLimit:     ${gasLimit}`);
  console.log(`  nonce:        ${nonce}`);

  // 2. Bundle payload (Flashbots-compatible format)
  const bundleParams = {
    txs: [victimRawTx, signedBackrunTx],
    blockNumber: `0x${targetBlock.toString(16)}`,
  };

  // 3. Submit to all builders in parallel
  const results = await Promise.allSettled(
    BUILDERS.map((b) => sendToBuilder(b, bundleParams, wallet, liveSession,
      { evidence: params.evidence, txHash: backrunTxHash, submissionId, targetBlock }))
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return { ...r.value, backrunTxHash };
    return {
      builder: BUILDERS[i].name,
      accepted: false,
      ...(BUILDERS[i].name === "titan" ? { receiptStatus: "unconfirmed" as const } : {}),
      backrunTxHash,
      error: r.reason?.message ?? String(r.reason),
    };
  });
}

// ─── MEV-Share Bundle (hash-only victim) ─────────────────────────

/**
 * Submit a backrun bundle via Flashbots `mev_sendBundle`.
 * The victim tx is referenced by hash only — no rawTx needed.
 *
 * Format: body = [{ hash: victimHash }, { tx: signedBackrunTx, canRevert: false }]
 * Only sent to Flashbots relay (mev_sendBundle is Flashbots-specific).
 */
export async function submitMevShareBundle(params: {
  bribeGasBasis?: BribeGasBasis;
  expectedProfitEth?: bigint;
  evidence?: BuilderEvidenceSink;
  victimHash: string;
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
  targetBlock: number;
  bribeWei: bigint;
  maxBaseFeePerGas: bigint;
}): Promise<SubmitResult> {
  const {
    victimHash,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    targetBlock,
    bribeWei,
    maxBaseFeePerGas,
  } = params;

  // Build + sign backrun tx (same logic as submitBundle)
  const { signedBackrunTx, backrunTxHash, liveSession, submissionId } = await buildSignedBackrunTx({
    evidence: params.evidence, bribeGasBasis: params.bribeGasBasis, expectedProfitEth: params.expectedProfitEth,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
    targetBlock,
    submissionMode: "hash-only",
  });

  const bundleParams = {
    version: "v0.1",
    inclusion: mevShareInclusion(targetBlock),
    body: [
      { hash: victimHash },
      { tx: signedBackrunTx, canRevert: false },
    ],
  };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "mev_sendBundle",
    params: [bundleParams],
  });

  // Flashbots auth: sign the keccak256 hash of the body as a hex STRING
  // (ethers.id returns the hex string; signMessage signs its UTF-8 bytes).
  // Signing getBytes(hash) instead produces an "invalid flashbots signature".
  const res = await observedBuilderRequest({
    builder: "flashbots-mev-share", purpose: "submission", method: "mev_sendBundle",
    url: "https://relay.flashbots.net", body, txHash: backrunTxHash,
    submissionId, targetBlock, evidence: params.evidence, secrets: [signedBackrunTx],
    beforeSend: () => liveSession?.assertActive(),
    headers: async () => {
      liveSession?.assertActive();
      const sig = await wallet.signMessage(ethers.id(body));
      return { "Content-Type": "application/json", "X-Flashbots-Signature": `${wallet.address}:${sig}` };
    },
  });

  const rawBody = res.redactedBody;
  let json: { result?: { bundleHash?: string }; error?: { message?: string } };
  try { json = JSON.parse(rawBody); } catch { json = {}; }

  if (!res.ok || json.error) {
    console.log(`[submitter] flashbots-mev-share http=${res.status} body=${rawBody.slice(0, 300)}`);
    return {
      builder: "flashbots-mev-share",
      accepted: false,
      backrunTxHash,
      error: (json.error as any)?.message ?? JSON.stringify(json.error) ?? rawBody.slice(0, 100),
    };
  }
  return {
    builder: "flashbots-mev-share",
    accepted: true,
    backrunTxHash,
    bundleHash: json.result?.bundleHash,
  };
}

export function mevShareInclusion(targetBlock: number): {
  block: string;
  maxBlock: string;
} {
  if (!Number.isSafeInteger(targetBlock) || targetBlock <= 0) {
    throw new Error("MEV-Share target block must be a positive safe integer");
  }
  const block = `0x${targetBlock.toString(16)}`;
  // The source hash, Chainlink mark and exact base fee are valid only for
  // parent+1. Never let a bundle drift into a later block under stale EV.
  return { block, maxBlock: block };
}

// ─── Standalone Backrun Bundle (mined victim / next block) ─────

/**
 * Submit only the backrun tx as an eth_sendBundle to builders.
 *
 * Used when the victim tx is already mined: the target state is known, and
 * the mined victim hash cannot be referenced in mev_sendBundle.
 */
export async function submitStandaloneBundle(params: {
  bribeGasBasis?: BribeGasBasis;
  expectedProfitEth?: bigint;
  evidence?: BuilderEvidenceSink;
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
  targetBlock: number;
  bribeWei: bigint;
  maxBaseFeePerGas: bigint;
}): Promise<SubmitResult[]> {
  const {
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    targetBlock,
    bribeWei,
    maxBaseFeePerGas,
  } = params;

  const { signedBackrunTx, backrunTxHash, gasLimit, nonce, liveSession, submissionId } = await buildSignedBackrunTx({
    evidence: params.evidence, bribeGasBasis: params.bribeGasBasis, expectedProfitEth: params.expectedProfitEth,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
    targetBlock,
    submissionMode: "standalone",
  });

  const ts = new Date().toISOString();
  console.log(`[${ts}] Standalone backrun bundle constructed:`);
  console.log(`  target block: ${targetBlock}`);
  console.log(`  backrun to:   ${botvmAddress}`);
  console.log(`  gasLimit:     ${gasLimit}`);
  console.log(`  nonce:        ${nonce}`);

  const bundleParams = {
    txs: [signedBackrunTx],
    blockNumber: `0x${targetBlock.toString(16)}`,
  };

  const results = await Promise.allSettled(
    BUILDERS.map((b) => sendToBuilder(b, bundleParams, wallet, liveSession,
      { evidence: params.evidence, txHash: backrunTxHash, submissionId, targetBlock }))
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return { ...r.value, backrunTxHash };
    return {
      builder: BUILDERS[i].name,
      accepted: false,
      ...(BUILDERS[i].name === "titan" ? { receiptStatus: "unconfirmed" as const } : {}),
      backrunTxHash,
      error: r.reason?.message ?? String(r.reason),
    };
  });
}

export async function buildSignedBackrunTx(params: {
  bribeGasBasis?: BribeGasBasis;
  expectedProfitEth?: bigint;
  evidence?: BuilderEvidenceSink;
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
  /** EV-approved bid: expected payment in measured-gas mode; cap in gas-limit mode. */
  bribeWei: bigint;
  /** Exact EIP-1559 base fee for the target child block, computed by the EV gate. */
  maxBaseFeePerGas: bigint;
  targetBlock?: number;
  submissionMode?: "standalone" | "victim" | "hash-only";
}): Promise<{
  signedBackrunTx: string; backrunTxHash: string; gasLimit: bigint; nonce: number;
  liveSession: BoundedLiveSession | null;
  submissionId: string;
}> {
  const {
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
  } = params;
  if (!Number.isSafeInteger(gasUsed) || gasUsed <= 0) {
    throw new Error("measured gas used must be a positive safe integer");
  }
  if (bribeWei < 0n) {
    throw new Error("absolute bribe budget must be non-negative");
  }
  if (maxBaseFeePerGas <= 0n) {
    throw new Error("target block base fee unavailable");
  }
  const liveSession = captureBoundedLiveSession({
    wallet: wallet.address,
    executor: botvmAddress,
    chainId: 1,
    targetBlock: params.targetBlock,
    mode: params.submissionMode,
  });
  const nonce = await wallet.getNonce("pending");

  // The EV gate and signer share this exact target-block base fee. Production
  // callers may not substitute a latest-block read or a static multiplier here.
  const targetBaseFee = maxBaseFeePerGas;

  const walletBal = await provider.getBalance(wallet.address);
  const fees = computeSubmissionFees({ measuredGasUsed: BigInt(gasUsed), targetBaseFee,
    bribeWei, walletBalance: walletBal, basis: params.bribeGasBasis ?? "gas-limit",
    expectedProfitEth: params.expectedProfitEth });
  const { gasLimit, bribeBudget, priorityFee } = fees;

  const backrunTx: ethers.TransactionLike = {
    to: botvmAddress,
    data: calldataHex,
    nonce,
    chainId: 1,
    type: 2,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
    value: 0,
  };

  liveSession?.assertActive({
    walletBalanceWei: walletBal,
    worstGasCostWei: fees.worstGasCostWei,
  });
  const submissionId = randomUUID();
  params.evidence?.({
    type: "submission_fee_parameters", submission_id: submissionId,
    captured_at_ms: Date.now(), target_block: params.targetBlock ?? null,
    sender: wallet.address, executor: botvmAddress,
    calldata_hash: ethers.keccak256(calldataHex), nonce, gas_limit: gasLimit.toString(),
    requested_bribe_budget_wei: bribeWei.toString(),
    applied_bribe_budget_wei: bribeBudget.toString(),
    wallet_limited: fees.walletLimited, wallet_balance_wei: walletBal.toString(),
    wallet_reserve_wei: BRIBE_WALLET_RESERVE.toString(),
    max_priority_fee_per_gas: priorityFee.toString(),
    max_fee_per_gas: fees.maxFeePerGas.toString(),
    target_base_fee_per_gas: targetBaseFee.toString(),
    bribe_gas_basis: fees.basis, bribe_gas_denominator: fees.denominator.toString(),
    measured_gas_used: String(gasUsed), estimated_bribe_payment_wei: fees.estimatedBribeWei.toString(),
    max_bribe_payment_at_gas_limit_wei: fees.maxBribeWei.toString(),
    worst_transaction_fee_wei: fees.worstGasCostWei.toString(),
    estimated_net_wei: fees.estimatedNetWei?.toString() ?? null,
    net_at_gas_limit_wei: fees.netAtGasLimitWei?.toString() ?? null,
  });
  liveSession?.assertActive();
  const signedBackrunTx = await wallet.signTransaction(backrunTx);
  liveSession?.assertActive();
  const backrunTxHash = ethers.keccak256(signedBackrunTx);
  params.evidence?.({ type: "submission_transaction", submission_id: submissionId,
    tx_hash: backrunTxHash, captured_at_ms: Date.now(), target_block: params.targetBlock ?? null });
  return {
    signedBackrunTx,
    backrunTxHash,
    gasLimit,
    nonce,
    liveSession,
    submissionId,
  };
}

// ─── Per-Builder Send ──────────────────────────────────────────

async function sendToBuilder(
  builder: BuilderEndpoint,
  bundle: { txs: string[]; blockNumber: string },
  wallet: ethers.Wallet,
  liveSession: BoundedLiveSession | null,
  observation: { evidence?: BuilderEvidenceSink; txHash: string; submissionId: string; targetBlock: number },
): Promise<SubmitResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [bundle],
  });

  const res = await observedBuilderRequest({
    ...observation, builder: builder.name, purpose: "submission", method: "eth_sendBundle",
    endpointId: builder.endpointId,
    url: builder.url, body, secrets: bundle.txs,
    beforeSend: () => liveSession?.assertActive(),
    headers: async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Preserve the existing auth scheme and recheck every asynchronous boundary.
      if (builder.authSigner) {
        liveSession?.assertActive();
        const sig = await wallet.signMessage(ethers.id(body));
        headers["X-Flashbots-Signature"] = `${wallet.address}:${sig}`;
      }
      return headers;
    },
  });

  if (builder.name === "titan") {
    return { builder: builder.name, ...classifyTitanSubmissionReceipt(res, 1) };
  }

  const rawBody = res.redactedBody;
  let json: { result?: { bundleHash?: string }; error?: { message?: string } };
  try { json = JSON.parse(rawBody); } catch { json = {}; }

  if (!res.ok || json.error) {
    console.log(`[submitter] ${builder.name} http=${res.status} body=${rawBody.slice(0, 200)}`);
    return {
      builder: builder.name,
      accepted: false,
      error: (json.error as { message?: string } | undefined)?.message ?? JSON.stringify(json.error) ?? rawBody.slice(0, 100),
    };
  }

  return {
    builder: builder.name,
    accepted: true,
    bundleHash: json.result?.bundleHash,
  };
}
