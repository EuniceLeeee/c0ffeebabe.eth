import { ethers } from "ethers";
import type { CaptureNominationSemantics, CaptureReverseBindingSemantics, ReverseBindingOutcome, UnifiedObservation } from "../../adapter-family-plugin.js";
import { VAULT, VAULT_ABI, POOL_ABI, poolIdentity, decodeReturn, same } from "./codec.js";
import { SURFACE, decodeSwapLog } from "./discovery.js";
function label(opaque: unknown): opaque is Record<string, unknown> {
  if (!opaque || typeof opaque !== "object") return false;
  const value = opaque as Record<string, unknown>;
  return [value.adapter, value.adapterId, value.familyId, value.venueId].some(x => x === "balancer-v2");
}
export const reverseBinding: CaptureReverseBindingSemantics["reverseBinding"] = async input => {
  const out: ReverseBindingOutcome[] = [];
  for (const nomination of input.nominations) {
    if (!label(nomination.opaque)) { out.push({ status: "unsupported", reason: "not-balancer-v2-nomination" }); continue; }
    try {
      const id = poolIdentity(String(nomination.opaque.poolId ?? ""));
      if (!same(nomination.address, VAULT) && !same(nomination.address, id.pool)) throw new Error("foreign nomination");
      const [code, vault, registered, selfId] = await Promise.all([
        input.provider.getCode(id.pool, input.source.number),
        input.provider.call({ to: id.pool, data: POOL_ABI.encodeFunctionData("getVault") }, input.source.number),
        input.provider.call({ to: VAULT, data: VAULT_ABI.encodeFunctionData("getPool", [id.poolId]) }, input.source.number),
        input.provider.call({ to: id.pool, data: POOL_ABI.encodeFunctionData("getPoolId") }, input.source.number),
      ]);
      const membership = decodeReturn("getPool", registered);
      if (!ethers.isHexString(code, true) || code === "0x" ||
          !same(String(decodeReturn("getVault", vault, POOL_ABI)[0]), VAULT) ||
          !same(String(membership[0]), id.pool) || Number(membership[1]) !== id.specialization ||
          String(decodeReturn("getPoolId", selfId, POOL_ABI)[0]).toLowerCase() !== id.poolId) throw new Error("no vault membership");
      out.push({ status: "verified", observation: { kind: "address-surface", source: input.source, address: id.pool,
        codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash, interfaceFingerprints: [SURFACE],
        opaque: { poolId: id.poolId } } });
    } catch { out.push({ status: "failed", reason: "balancer-v2 reverse evidence unavailable" }); }
  }
  return out;
};
export const nominate: CaptureNominationSemantics["nominate"] = async input => {
  const out: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    if (!label(nomination.opaque)) continue;
    const hash = nomination.opaque.txHash ?? nomination.opaque.transactionHash;
    if (typeof hash !== "string" || !ethers.isHexString(hash, 32)) continue;
    try {
      const receipt = await input.provider.getTransactionReceipt(hash);
      if (!receipt || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber! > input.source.number) continue;
      for (const log of receipt.logs) {
        const swap = decodeSwapLog(log); if (!swap) continue;
        if (typeof nomination.opaque.poolId === "string" && swap.poolId !== poolIdentity(nomination.opaque.poolId).poolId) continue;
        if (!same(nomination.address, VAULT) && !same(nomination.address, swap.pool)) continue;
        out.push({ kind: "log", source: input.source, address: VAULT, topics: [...log.topics], data: log.data, transactionHash: hash });
      }
    } catch { /* Missing historical evidence cannot nominate. */ }
  }
  return out;
};
