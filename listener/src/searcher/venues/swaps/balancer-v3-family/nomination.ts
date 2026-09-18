import { ethers } from "ethers";
import type { CaptureNominationSemantics, CaptureReverseBindingSemantics, ReverseBindingOutcome, UnifiedObservation } from "../../adapter-family-plugin.js";
import { VAULT, VAULT_ABI, POOL_ABI, addressWord, bool, lower, nonzero, same } from "./codec.js";
import { SURFACE, decodeSwapLog } from "./discovery.js";

function label(opaque: unknown): boolean {
  if (!opaque || typeof opaque !== "object") return false;
  const record = opaque as Record<string, unknown>;
  return [record.adapter, record.adapterId, record.venueId, record.familyId].some(value => value === "balancer-v3");
}
export const reverseBindBalancerV3: CaptureReverseBindingSemantics["reverseBinding"] = async input => {
  const outcomes: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    if (!label(nomination.opaque)) { outcomes.push({ status: "unsupported", reason: "not-balancer-v3-nomination" }); continue; }
    try {
      const pool = nonzero(nomination.address);
      const [code, vault, registered] = await Promise.all([
        input.provider.getCode(pool, input.source.number),
        input.provider.call({ to: pool, data: POOL_ABI.encodeFunctionData("getVault") }, input.source.number),
        input.provider.call({ to: VAULT, data: VAULT_ABI.encodeFunctionData("isPoolRegistered", [pool]) }, input.source.number),
      ]);
      if (!ethers.isHexString(code) || code === "0x" || !same(addressWord(vault), VAULT) || !bool(registered)) {
        outcomes.push({ status: "failed", reason: "no-vault-membership" }); continue;
      }
      // A nomination is not admission. Strict lifecycle repeats these reads with
      // central number/hash/generation fencing and seals the full identity proof.
      outcomes.push({ status: "verified", observation: { kind: "address-surface", source: input.source,
        address: pool, codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash,
        interfaceFingerprints: [SURFACE] } });
    } catch { outcomes.push({ status: "failed", reason: "balancer-v3-reverse-read-failed" }); }
  }
  return Object.freeze(outcomes);
};
export const nominateBalancerV3: CaptureNominationSemantics["nominate"] = async input => {
  const observations: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    if (!label(nomination.opaque)) continue;
    const opaque = nomination.opaque as Record<string, unknown>;
    const hash = opaque.txHash ?? opaque.transactionHash;
    if (typeof hash !== "string" || !ethers.isHexString(hash, 32)) continue;
    try {
      const receipt = await input.provider.getTransactionReceipt(hash);
      if (!receipt || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber! > input.source.number) continue;
      for (const log of receipt.logs) {
        const decoded = decodeSwapLog(log);
        if (!decoded || !same(decoded.pool, nomination.address)) continue;
        observations.push({ kind: "log", source: input.source, address: VAULT,
          topics: [...log.topics], data: log.data, transactionHash: hash.toLowerCase() });
      }
    } catch { /* Unreadable evidence cannot nominate an instance. */ }
  }
  return Object.freeze(observations);
};
