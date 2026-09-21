import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import type { CaptureNominationInput, CaptureNominationProvider, ReverseBindingOutcome } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ethers } from "ethers";
import { EXCHANGE_CODE_HASH } from "./codec.js";

export const ELLA_SURFACE = "ella-exchange-native-base-v1";
export const createEllaNomination = createTxEvidenceNomination;
export async function reverseBindElla(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly ReverseBindingOutcome[]> {
  return Promise.all(input.nominations.map(async nomination => {
    try {
      const code = await input.provider.getCode(nomination.address, input.source.number);
      if (ethers.keccak256(code) !== EXCHANGE_CODE_HASH) return { status: "unsupported" as const, reason: "not-ella-runtime" };
      return { status: "verified" as const, observation: {
        kind: "address-surface" as const, source: input.source, address: nomination.address,
        codeHash: EXCHANGE_CODE_HASH, implementationWord: ethers.ZeroHash, interfaceFingerprints: [ELLA_SURFACE],
      } };
    } catch { return { status: "failed" as const, reason: "ella-runtime-read-unavailable" }; }
  }));
}
