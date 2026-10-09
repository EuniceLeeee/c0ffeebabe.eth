import { ethers } from "ethers";
import type { CaptureNominationSemantics, CaptureNominationInput, CaptureNominationProvider, UnifiedObservation } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { MODULE, MODULE_CODE_HASH, SET, SET_CODE_HASH, address, decode } from "./codec.js";
import { decodeLegacyCandidate, legacyLogPatterns } from "./legacy.js";
import { LEGACY_ACTION, LEGACY_ISSUE_ACTION } from "./manifest.js";
export const SURFACE = "set-basic-redemption-binding-v1";
export async function bindingObservation(n: CaptureNominationInput, provider: CaptureNominationProvider, source: CanonicalSource): Promise<UnifiedObservation | null> {
  const o = n.opaque as Record<string, unknown> | null;
  if (!o || typeof o.set !== "string" || typeof o.module !== "string") return null;
  const set = address(o.set), module = address(o.module);
  if (module !== address(n.address) || set === module) return null;
  const [setCode, moduleCode] = await Promise.all([provider.getCode(set, source.number), provider.getCode(module, source.number)]);
  if (ethers.keccak256(setCode) !== SET_CODE_HASH || ethers.keccak256(moduleCode) !== MODULE_CODE_HASH) return null;
  const modules = await provider.call({ to: set, data: SET.encodeFunctionData("getModules") }, source.number);
  if (!decode(SET, "getModules", modules)[0].map(address).includes(module)) return null;
  return { kind: "address-surface", source, address: module, codeHash: MODULE_CODE_HASH, implementationWord: ethers.ZeroHash,
    interfaceFingerprints: [SURFACE], opaque: { set, module } };
}
// Receipt evidence preserves both Set and module. Never invent a calldata frame
// from an address-only nomination or fetch a protocol-wide history window.
export const nomination: CaptureNominationSemantics = {
  async nominate({ nominations, provider, source }) {
    const out: UnifiedObservation[] = [];
    for (const n of nominations) {
      const opaque = n.opaque as Record<string, unknown> | null;
      if (!opaque || ![opaque.familyId, opaque.adapter, opaque.adapterId].some(v => ["protocol:set-redemption", "set-redemption", "set-basic-redeem", LEGACY_ACTION, LEGACY_ISSUE_ACTION].includes(String(v)))) continue;
      // A legacy Core has no BasicIssuance getModules binding. Its receipt
      // events retain Set+Core and are materialized by the same discovery path.
      const binding = opaque.legacyCore === true ? null : await bindingObservation(n, provider, source);
      if (binding) { out.push(binding); continue; }
      const tx = n.evidence?.transactionHash ?? opaque.transactionHash;
      if (typeof tx !== "string" || !/^0x[0-9a-f]{64}$/i.test(tx)) continue;
      const receipt = await provider.getTransactionReceipt(tx);
      if (!receipt || receipt.blockNumber === undefined || receipt.blockNumber > source.number) continue;
      for (const log of receipt.logs) {
        if (address(log.address) !== address(n.address)) continue;
        const observation: UnifiedObservation = { kind: "log", source, address: address(log.address), topics: [...log.topics], data: log.data, transactionHash: tx };
        const pattern = legacyLogPatterns.find(p => p.topic === log.topics[0]?.toLowerCase());
        if (pattern) {
          const candidate = decodeLegacyCandidate(observation, pattern.id);
          // A shared Core can issue/redeem several baskets in the SAME receipt.
          // Preserve the nominated composite key; never publish another basket.
          if (candidate && (typeof opaque.set !== "string" || candidate.set === address(opaque.set))) out.push(observation);
        } else if (log.topics[0]?.toLowerCase() === MODULE.getEvent("SetTokenRedeemed")!.topicHash) out.push(observation);
      }
    }
    return out;
  },
};
