import { ethers } from "ethers";
import { buildSignedBackrunTx, submitBundle, submitMevShareBundle, submitStandaloneBundle } from "../../submitter.js";
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
  gasUsed?: bigint | number;
}

export interface BundleRouter {
  submit(bundle: BundleSubmission): Promise<SubmitResult[]>;
}

export class DryRunBundleRouter implements BundleRouter {
  submissions: BundleSubmission[] = [];

  constructor(
    private readonly wallet?: ethers.Wallet,
    private readonly provider?: ethers.JsonRpcProvider,
    private readonly botvmAddress?: string,
    private readonly defaultGasUsed = 12_000_000,
  ) {}

  async submit(bundle: BundleSubmission): Promise<SubmitResult[]> {
    this.submissions.push(bundle);
    if (!this.wallet || !this.provider || !this.botvmAddress) return [];
    try {
      const signed = await buildSignedBackrunTx({
        calldataHex: bundle.backrunCalldata,
        gasUsed: Number(bundle.gasUsed ?? this.defaultGasUsed),
        wallet: this.wallet,
        botvmAddress: this.botvmAddress,
        provider: this.provider,
        expectedProfitEth: bundle.expectedProfitEth,
        bribeBps: bundle.bribeBps,
      });
      return [{
        builder: "dry-run",
        accepted: false,
        backrunTxHash: signed.backrunTxHash,
      }];
    } catch (err) {
      return [{
        builder: "dry-run",
        accepted: false,
        error: `dry-run-sign-failed: ${err instanceof Error ? err.message : String(err)}`,
      }];
    }
  }
}

export class ProductionBundleRouter implements BundleRouter {
  constructor(
    private readonly wallet: ethers.Wallet,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly botvmAddress: string,
    private readonly defaultGasUsed = 12_000_000,
  ) {}

  async submit(bundle: BundleSubmission): Promise<SubmitResult[]> {
    const gasUsed = Number(bundle.gasUsed ?? this.defaultGasUsed);
    const bribe = {
      expectedProfitEth: bundle.expectedProfitEth,
      bribeBps: bundle.bribeBps,
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
