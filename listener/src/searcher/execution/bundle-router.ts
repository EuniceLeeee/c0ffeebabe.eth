export interface BundleSubmission {
  victimTxHash: string;
  backrunCalldata: string;
  targetBlock: number;
  expectedProfit: bigint;
}

export interface BundleRouter {
  submit(bundle: BundleSubmission): Promise<void>;
}

export class DryRunBundleRouter implements BundleRouter {
  submissions: BundleSubmission[] = [];

  async submit(bundle: BundleSubmission): Promise<void> {
    this.submissions.push(bundle);
  }
}

