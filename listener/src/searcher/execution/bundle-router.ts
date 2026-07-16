import { ethers } from "ethers";
import { submitBundle, submitMevShareBundle, submitStandaloneBundle } from "../../submitter.js";
import type { SubmitResult } from "../../types.js";

export interface BundleSubmission {
  victimTxHash: string;
  victimRawTx?: string;
  mode?: "victim-bundle" | "hash-only" | "standalone";
  backrunCalldata: string;
  targetBlock: number;
  expectedProfit: bigint;
  /** Expected profit valued in ETH wei (for sizing the proposer bribe). */
  expectedProfitEth?: bigint;
  /** Fraction of expectedProfitEth to pay as priority-fee bribe, in bps. */
  bribeBps?: number;
  /** Absolute priority-fee bribe in wei, computed by the searcher economics gate. */
  bribeWei?: bigint;
  gasUsed?: bigint | number;
  /** Standing-position safety state, carried from the searcher's S2 guard. The router refuses to
   *  broadcast a standing-position bundle that is not authorized (defense-in-depth behind the
   *  pre-submit guard). Absent => no standing position => never blocked. */
  safety?: { leavesStandingPosition: boolean; authorized: boolean };
}

export interface BundleRouter {
  submit(bundle: BundleSubmission): Promise<SubmitResult[]>;
}

export function standingPositionSafetyReject(bundle: BundleSubmission): SubmitResult | null {
  if (bundle.safety && bundle.safety.leavesStandingPosition && !bundle.safety.authorized) {
    return { builder: "safety-reject", accepted: false, error: "standing_position_unauthorized" };
  }
  return null;
}

export class DryRunBundleRouter implements BundleRouter {
  submissions: BundleSubmission[] = [];

  constructor(
    private readonly botvmAddress?: string,
    private readonly defaultGasUsed = 12_000_000,
  ) {}

  async submit(bundle: BundleSubmission): Promise<SubmitResult[]> {
    const safetyReject = standingPositionSafetyReject(bundle);
    if (safetyReject) return [safetyReject];
    this.submissions.push(bundle);
    return [{
      builder: "dry-run",
      accepted: false,
      backrunTxHash: dryRunSubmissionId(bundle, this.botvmAddress, this.defaultGasUsed),
      error: "dry-run-unsigned",
    }];
  }
}

export function dryRunSubmissionId(
  bundle: BundleSubmission,
  botvmAddress?: string,
  defaultGasUsed = 12_000_000,
): string {
  const gasUsed = typeof bundle.gasUsed === "bigint"
    ? bundle.gasUsed
    : BigInt(Math.ceil(bundle.gasUsed ?? defaultGasUsed));
  const unsigned = JSON.stringify({
    schema: "dry-run-unsigned-v1",
    to: botvmAddress?.toLowerCase() ?? null,
    data: bundle.backrunCalldata,
    gasLimit: ((gasUsed * 13n + 9n) / 10n).toString(),
    targetBlock: bundle.targetBlock,
    mode: bundle.mode ?? null,
    victimTxHash: bundle.victimTxHash,
    victimRawTx: bundle.victimRawTx ?? null,
    expectedProfit: bundle.expectedProfit.toString(),
    expectedProfitEth: bundle.expectedProfitEth?.toString() ?? null,
    bribeBps: bundle.bribeBps ?? null,
    bribeWei: bundle.bribeWei?.toString() ?? null,
    safety: bundle.safety ?? null,
  });
  return ethers.id(unsigned);
}

export class ProductionBundleRouter implements BundleRouter {
  constructor(
    private readonly wallet: ethers.Wallet,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly botvmAddress: string,
    private readonly defaultGasUsed = 12_000_000,
  ) {}

  async submit(bundle: BundleSubmission): Promise<SubmitResult[]> {
    const safetyReject = standingPositionSafetyReject(bundle);
    if (safetyReject) return [safetyReject];
    const gasUsed = Number(bundle.gasUsed ?? this.defaultGasUsed);
    const bribe = {
      expectedProfitEth: bundle.expectedProfitEth,
      bribeBps: bundle.bribeBps,
      bribeWei: bundle.bribeWei,
    };
    let results: SubmitResult[];

    if (bundle.mode === "standalone") {
      // Mined-victim path: the victim is already included, so submit only the
      // backrun tx for the next block. Do not reference the mined tx hash in
      // mev_sendBundle.
      results = await submitStandaloneBundle({
        calldataHex: bundle.backrunCalldata,
        gasUsed,
        wallet: this.wallet,
        botvmAddress: this.botvmAddress,
        provider: this.provider,
        targetBlock: bundle.targetBlock,
        ...bribe,
      });
    } else if (bundle.victimRawTx) {
      // Primary path: have rawTx → eth_sendBundle to all builders
      // submitBundle() handles tx signing internally
      results = await submitBundle({
        victimRawTx: bundle.victimRawTx,
        calldataHex: bundle.backrunCalldata,
        gasUsed,
        wallet: this.wallet,
        botvmAddress: this.botvmAddress,
        provider: this.provider,
        targetBlock: bundle.targetBlock,
        ...bribe,
      });
    } else {
      // Secondary path: hash-only → mev_sendBundle to Flashbots relay only
      // submitMevShareBundle() handles tx signing internally
      const mevResult = await submitMevShareBundle({
        victimHash: bundle.victimTxHash,
        calldataHex: bundle.backrunCalldata,
        gasUsed,
        wallet: this.wallet,
        botvmAddress: this.botvmAddress,
        provider: this.provider,
        targetBlock: bundle.targetBlock,
        ...bribe,
      });
      results = [mevResult];
    }

    for (const result of results) {
      const status = result.accepted ? "ACCEPTED" : "REJECTED";
      console.log(
        `[searcher/live] ${result.builder}: ${status}` +
          `${result.bundleHash ? ` bundleHash=${result.bundleHash}` : ""}` +
          `${result.error ? ` error=${result.error}` : ""}`,
      );
    }

    return results;
  }
}

export function createBundleRouter(input: {
  dryRun: boolean;
  wallet: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  botvmAddress: string;
  defaultGasUsed: number;
}): BundleRouter {
  return input.dryRun
    ? new DryRunBundleRouter(input.botvmAddress, input.defaultGasUsed)
    : new ProductionBundleRouter(
      input.wallet,
      input.provider,
      input.botvmAddress,
      input.defaultGasUsed,
    );
}
