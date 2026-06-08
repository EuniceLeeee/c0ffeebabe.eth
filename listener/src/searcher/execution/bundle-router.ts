import { ethers } from "ethers";
import { submitBundle, submitMevShareBundle } from "../../submitter.js";
import type { SubmitResult } from "../../types.js";

export interface BundleSubmission {
  victimTxHash: string;
  victimRawTx?: string;
  backrunCalldata: string;
  targetBlock: number;
  expectedProfit: bigint;
  gasUsed?: bigint | number;
}

export interface BundleRouter {
  submit(bundle: BundleSubmission): Promise<SubmitResult[]>;
}

export class DryRunBundleRouter implements BundleRouter {
  submissions: BundleSubmission[] = [];

  async submit(bundle: BundleSubmission): Promise<SubmitResult[]> {
    this.submissions.push(bundle);
    return [];
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
    let results: SubmitResult[];

    if (bundle.victimRawTx) {
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
