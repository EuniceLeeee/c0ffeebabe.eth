// Receipt observation only. Quote requests, runtime inputs and payer debits keep
// the full gross amount; verified StakedUSDat emits Deposit.assets after its fee.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { CanonicalSource } from "../../../adapter-request-program.js";
const ABI = new ethers.Interface(["function depositFeeBps() view returns(uint256)",
  "function feeRecipient() view returns(address)"]);

export function stakedUsdatEventAssets(gross: bigint, feeBps: bigint, feeRecipient: string): bigint {
  assert(gross >= 0n && feeBps >= 0n && feeBps <= 10_000n);
  const receiver = ethers.getAddress(feeRecipient);
  if (feeBps === 0n || receiver === ethers.ZeroAddress) return gross;
  return gross - (gross * feeBps + 9_999n) / 10_000n;
}

export async function observeStakedUsdatDepositAssets(input: { readonly source: CanonicalSource;
  readonly vault: string; readonly executor: string; readonly owner: string;
  readonly call: (data: string) => Promise<string> }) {
  const feeBps = BigInt(ABI.decodeFunctionResult("depositFeeBps", await input.call(ABI.encodeFunctionData("depositFeeBps")))[0]);
  const feeRecipient = ethers.getAddress(ABI.decodeFunctionResult("feeRecipient", await input.call(ABI.encodeFunctionData("feeRecipient")))[0]);
  stakedUsdatEventAssets(0n, feeBps, feeRecipient);
  if (feeBps > 0n) assert(![input.executor, input.owner].some(actor => actor.toLowerCase() === feeRecipient.toLowerCase()),
    "historical receiver fixture must be distinct from active fee recipient");
  return {
    evidence: { source: input.source, vault: input.vault, feeBps, feeRecipient,
      eventAssets: "gross minus ceil(gross * depositFeeBps / 10000), unless fee disabled or zero fee recipient",
      scope: "Same-source getter evidence; receipt observation only. Gross quote/request/debit and output inventory checks stay unchanged; tested recipients are distinct from fee recipient." },
    expectedAssets: (gross: bigint) => stakedUsdatEventAssets(gross, feeBps, feeRecipient),
  };
}
