import { ethers } from "ethers";
import type { SubmitResult } from "./types.js";

// ─── Builder Endpoints ─────────────────────────────────────────

interface BuilderEndpoint {
  name: string;
  url: string;
  authSigner: boolean; // needs X-Flashbots-Signature
}

const BUILDERS: BuilderEndpoint[] = [
  { name: "flashbots", url: "https://relay.flashbots.net", authSigner: true },
  { name: "titan", url: "https://rpc.titanbuilder.xyz", authSigner: false },
  { name: "rsync", url: "https://rsync-builder.xyz", authSigner: false },
  { name: "beaverbuild", url: "https://rpc.beaverbuild.org", authSigner: false },
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
  const { signedBackrunTx, backrunTxHash, gasLimit, nonce } = await buildSignedBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
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
    BUILDERS.map((b) => sendToBuilder(b, bundleParams, wallet))
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return { ...r.value, backrunTxHash };
    return {
      builder: BUILDERS[i].name,
      accepted: false,
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
  const { signedBackrunTx, backrunTxHash } = await buildSignedBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
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
  const sig = await wallet.signMessage(ethers.id(body));

  const res = await fetch("https://relay.flashbots.net", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": `${wallet.address}:${sig}`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const rawBody = await res.text();
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

  const { signedBackrunTx, backrunTxHash, gasLimit, nonce } = await buildSignedBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    bribeWei,
    maxBaseFeePerGas,
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
    BUILDERS.map((b) => sendToBuilder(b, bundleParams, wallet))
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return { ...r.value, backrunTxHash };
    return {
      builder: BUILDERS[i].name,
      accepted: false,
      backrunTxHash,
      error: r.reason?.message ?? String(r.reason),
    };
  });
}

/** Gas-cost ETH kept in reserve so the bribe never starves the base fee. */
const BRIBE_WALLET_RESERVE = ethers.parseUnits("0.0005", "ether");

export async function buildSignedBackrunTx(params: {
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
  /** Maximum total priority-fee budget in wei, computed by the EV gate. */
  bribeWei: bigint;
  /** Exact EIP-1559 base fee for the target child block, computed by the EV gate. */
  maxBaseFeePerGas: bigint;
}): Promise<{ signedBackrunTx: string; backrunTxHash: string; gasLimit: bigint; nonce: number }> {
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
  const nonce = await wallet.getNonce("pending");
  const gasLimit = BigInt(Math.ceil(gasUsed * 1.3)); // 30% buffer

  // The EV gate and signer share this exact target-block base fee. Production
  // callers may not substitute a latest-block read or a static multiplier here.
  const targetBaseFee = maxBaseFeePerGas;

  // bribeWei is a maximum budget, not a promise to spend every wei. Divide by
  // gasLimit (not measured gas) and round down, so priorityFee*actualGasUsed can
  // never exceed the EV-approved budget for any successful execution.
  const walletBal = await provider.getBalance(wallet.address);
  const worstGasCost = targetBaseFee * gasLimit;
  const headroom =
    walletBal > worstGasCost + BRIBE_WALLET_RESERVE
      ? walletBal - worstGasCost - BRIBE_WALLET_RESERVE
      : 0n;
  const bribeBudget = bribeWei < headroom ? bribeWei : headroom;
  const priorityFee = bribeBudget / gasLimit;

  const backrunTx: ethers.TransactionLike = {
    to: botvmAddress,
    data: calldataHex,
    nonce,
    chainId: 1,
    type: 2,
    gasLimit,
    maxFeePerGas: targetBaseFee + priorityFee,
    maxPriorityFeePerGas: priorityFee,
    value: 0,
  };

  const signedBackrunTx = await wallet.signTransaction(backrunTx);
  return {
    signedBackrunTx,
    backrunTxHash: ethers.keccak256(signedBackrunTx),
    gasLimit,
    nonce,
  };
}

// ─── Per-Builder Send ──────────────────────────────────────────

async function sendToBuilder(
  builder: BuilderEndpoint,
  bundle: { txs: string[]; blockNumber: string },
  wallet: ethers.Wallet
): Promise<SubmitResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [bundle],
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Flashbots relay requires X-Flashbots-Signature: sign keccak256(body) as a
  // hex STRING (ethers.id), not its raw bytes — see submitMevShareBundle.
  if (builder.authSigner) {
    const sig = await wallet.signMessage(ethers.id(body));
    headers["X-Flashbots-Signature"] = `${wallet.address}:${sig}`;
  }

  const res = await fetch(builder.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const rawBody = await res.text();
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
