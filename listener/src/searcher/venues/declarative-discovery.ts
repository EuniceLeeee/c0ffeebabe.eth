import { id, getAddress } from "ethers";
import type { DiscoverySemantics, FamilyCandidate } from "./adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "./adapter-family-plugin.js";
import { compileAddressDiscovery } from "./address-discovery.js";
import { createAddressSurfaceNomination } from "./address-surface-nomination.js";

export function compileDeclarativeDiscovery<C extends FamilyCandidate>(definition: {
  readonly sources: readonly string[];
  readonly candidateSources: readonly string[];
  readonly candidate: { readonly kind: string; readonly addressField: string };
  readonly calls: readonly { readonly id: string; readonly signature: string }[];
  readonly events: readonly { readonly id: string; readonly signature: string }[];
  readonly surface: { readonly id: string; readonly fingerprint: string };
  readonly labels: readonly string[];
}): DiscoverySemantics<C> {
  const d = JSON.parse(JSON.stringify(definition)) as typeof definition;
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(d.candidate.addressField) || ["constructor", "prototype", "__proto__"].includes(d.candidate.addressField))
    throw new Error("invalid candidate address field");
  const patterns = [...d.calls, ...d.events, d.surface];
  if (new Set(patterns.map(p => p.id)).size !== patterns.length) throw new Error("duplicate discovery pattern");
  return compileAddressDiscovery<C>({
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"],
    callPatterns: d.calls.map(c => ({ ...c, selector: id(c.signature).slice(0, 10) as `0x${string}`,
      candidateAddress: { from: "call-target" as const } })),
    logPatterns: d.events.map(e => ({ ...e, topic: id(e.signature) as `0x${string}` })),
    addressSurfaces: [{ ...d.surface, kind: "interface" }],
    candidate: address => ({ candidateKind: d.candidate.kind, [d.candidate.addressField]: address } as unknown as C),
    candidateKey: candidate => getAddress((candidate as unknown as Record<string, string>)[d.candidate.addressField]).toLowerCase(),
    nominate: createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface.fingerprint] }),
    reverseBinding: explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
  });
}
