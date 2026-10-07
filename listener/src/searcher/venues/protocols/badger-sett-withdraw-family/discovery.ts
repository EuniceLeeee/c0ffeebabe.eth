import { explicitReverseBindingUnsupported, type DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { address, uint, VAULT } from "./codec.js";
import type { Candidate } from "./types.js";
export const SURFACE = "badger-sett:thevault-vlaura-withdraw";
export const discovery = {
  evidenceChannel: "nominate", sources: ["observed-call", "address-surface"],
  callPatterns: [{ id: "badger-sett-withdraw-call", selector: VAULT.getFunction("withdraw")!.selector as `0x${string}`,
    signature: "withdraw(uint256)", candidateAddress: { from: "call-target" } }],
  addressSurfaces: [{ id: "badger-sett-surface", kind: "interface", fingerprint: SURFACE }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "call" && id === "badger-sett-withdraw-call") {
        const args = VAULT.decodeFunctionData("withdraw", o.data);
        if (!uint(args[0]) || VAULT.encodeFunctionData("withdraw", args).toLowerCase() !== o.data.toLowerCase()) return null;
        return { candidateKind: "badger-sett-withdraw" as const, vault: address(o.target) };
      }
      if (o.kind === "address-surface" && id === "badger-sett-surface")
        return { candidateKind: "badger-sett-withdraw" as const, vault: address(o.address) };
      return null;
    } catch { return null; }
  },
  candidateKey: c => address(c.vault),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["badger-sett-withdraw"], interfaceFingerprints: [SURFACE] }),
  reverseBinding: explicitReverseBindingUnsupported("source code + EIP1967 + reciprocal vault/strategy/asset identity; no factory-creation claim"),
} satisfies DiscoverySemantics<Candidate>;
