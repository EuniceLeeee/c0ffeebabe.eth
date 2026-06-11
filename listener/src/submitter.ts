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
}): Promise<SubmitResult[]> {
  const {
    victimRawTx,
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
    targetBlock,
  } = params;

  // 1. Build backrun tx
  const { signedBackrunTx, gasLimit, nonce } = await signBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
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
    if (r.status === "fulfilled") return r.value;
    return {
      builder: BUILDERS[i].name,
      accepted: false,
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
}): Promise<SubmitResult> {
  const { victimHash, calldataHex, gasUsed, wallet, botvmAddress, provider, targetBlock } = params;

  // Build + sign backrun tx (same logic as submitBundle)
  const { signedBackrunTx } = await signBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
  });

  const bundleParams = {
    version: "v0.1",
    inclusion: {
      block: `0x${targetBlock.toString(16)}`,
      maxBlock: `0x${(targetBlock + 5).toString(16)}`,
    },
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

  const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(body));
  const sig = await wallet.signMessage(ethers.getBytes(bodyHash));

  const res = await fetch("https://relay.flashbots.net", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": `${wallet.address}:${sig}`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const json = (await res.json()) as {
    result?: { bundleHash?: string };
    error?: { message?: string };
  };

  if (json.error) {
    return {
      builder: "flashbots-mev-share",
      accepted: false,
      error: json.error.message ?? JSON.stringify(json.error),
    };
  }
  return {
    builder: "flashbots-mev-share",
    accepted: true,
    bundleHash: json.result?.bundleHash,
  };
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
}): Promise<SubmitResult[]> {
  const { calldataHex, gasUsed, wallet, botvmAddress, provider, targetBlock } = params;

  const { signedBackrunTx, gasLimit, nonce } = await signBackrunTx({
    calldataHex,
    gasUsed,
    wallet,
    botvmAddress,
    provider,
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
    if (r.status === "fulfilled") return r.value;
    return {
      builder: BUILDERS[i].name,
      accepted: false,
      error: r.reason?.message ?? String(r.reason),
    };
  });
}

async function signBackrunTx(params: {
  calldataHex: string;
  gasUsed: number;
  wallet: ethers.Wallet;
  botvmAddress: string;
  provider: ethers.JsonRpcProvider;
}): Promise<{ signedBackrunTx: string; gasLimit: bigint; nonce: number }> {
  const { calldataHex, gasUsed, wallet, botvmAddress, provider } = params;
  const nonce = await wallet.getNonce("pending");
  const feeData = await provider.getFeeData();
  const gasLimit = BigInt(Math.ceil(gasUsed * 1.3)); // 30% buffer

  const backrunTx: ethers.TransactionLike = {
    to: botvmAddress,
    data: calldataHex,
    nonce,
    chainId: 1,
    type: 2,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas ?? ethers.parseUnits("30", "gwei"),
    maxPriorityFeePerGas:
      feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei"),
    value: 0,
  };

  return {
    signedBackrunTx: await wallet.signTransaction(backrunTx),
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

  // Flashbots relay requires X-Flashbots-Signature (EIP-191)
  if (builder.authSigner) {
    const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(body));
    const sig = await wallet.signMessage(ethers.getBytes(bodyHash));
    headers["X-Flashbots-Signature"] = `${wallet.address}:${sig}`;
  }

  const res = await fetch(builder.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const json = (await res.json()) as {
    result?: { bundleHash?: string };
    error?: { message?: string };
  };

  if (json.error) {
    return {
      builder: builder.name,
      accepted: false,
      error: json.error.message ?? JSON.stringify(json.error),
    };
  }

  return {
    builder: builder.name,
    accepted: true,
    bundleHash: json.result?.bundleHash,
  };
}
