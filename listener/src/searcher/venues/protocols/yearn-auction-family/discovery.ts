import { ethers } from "ethers";
import { explicitReverseBindingUnsupported, type CaptureNominationSemantics, type DiscoverySemantics, type UnifiedObservation } from "../../adapter-family-plugin.js";
import { ABI, TAKES, address, decode, uint } from "./codec.js";
import { ACTION, FAMILY } from "./manifest.js";
import { cloneImplementation } from "./runtime-shape.js";
import type { Candidate } from "./types.js";
const SURFACE = "yearn-auction:registered-sold-v1";
const EVENTS = ["AuctionEnabled", "AuctionKicked", "AuctionSettled"] as const;
const nominate: CaptureNominationSemantics = { async nominate({ nominations, provider, source }) {
  const out: UnifiedObservation[] = [];
  for (const n of nominations) {
    const opaque = n.opaque as Record<string, unknown> | undefined;
    if (!opaque || ![opaque.familyId, opaque.adapter, opaque.adapterId].some(v => [FAMILY, ACTION].includes(String(v)))) continue;
    const target = address(n.address), code = await provider.getCode(target, source.number); cloneImplementation(code);
    const enabled = decode("getAllEnabledAuctions", await provider.call({ to: target, data: ABI.encodeFunctionData("getAllEnabledAuctions") }, source.number))[0] as string[];
    const selected = typeof opaque.sold === "string" ? [address(opaque.sold)] : enabled.map(address);
    for (const sold of selected) if (enabled.map(address).includes(sold)) out.push({ kind: "address-surface", source, address: target,
      codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash, interfaceFingerprints: [SURFACE], opaque: { sold } });
  }
  return out;
} };
export const discovery = { evidenceChannel: "nominate", txSeedNominations: true,
  sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: TAKES.map((signature, index) => ({ id: `yearn-take-${index}`, selector: ABI.getFunction(signature)!.selector as `0x${string}`,
    signature, candidateAddress: { from: "call-target" as const } })),
  logPatterns: EVENTS.map(signature => ({ id: `yearn-${signature}`, topic: ABI.getEvent(signature)!.topicHash as `0x${string}`,
    signature: ABI.getEvent(signature)!.format("sighash") })),
  addressSurfaces: [{ id: "yearn-registered", kind: "interface", fingerprint: SURFACE }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      let target: string, sold: string;
      if (o.kind === "call" && id.startsWith("yearn-take-")) {
        const signature = TAKES[Number(id.slice("yearn-take-".length))]; if (!signature) return null;
        const args = ABI.decodeFunctionData(signature, o.data);
        if (ABI.encodeFunctionData(signature, args).toLowerCase() !== o.data.toLowerCase() || (args.length > 1 && !uint(args[1]))) return null;
        target = address(o.target); sold = address(args[0]);
      } else if (o.kind === "log" && EVENTS.some(e => id === `yearn-${e}`)) {
        const fn = id.slice(6), args = ABI.decodeEventLog(fn, o.data, [...o.topics]);
        const encoded = ABI.encodeEventLog(ABI.getEvent(fn)!, args);
        if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.length !== o.topics.length || encoded.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase())) return null;
        target = address(o.address); sold = address(args[0]);
      } else if (o.kind === "address-surface" && id === "yearn-registered") {
        const opaque = o.opaque as { sold?: string } | undefined; if (!opaque?.sold) return null;
        target = address(o.address); sold = address(opaque.sold);
      } else return null;
      return target === sold ? null : { candidateKind: "yearn-auction" as const, target, sold };
    } catch { return null; }
  },
  candidateKey: c => `${address(c.target)}:${address(c.sold)}`,
  instanceNominationKey: c => { const v = c as Candidate; return `${address(v.target)}:${address(v.sold)}`; },
  nominate, reverseBinding: explicitReverseBindingUnsupported("source-bound clone and auction token registration; no factory-creation claim"),
} satisfies DiscoverySemantics<Candidate>;
