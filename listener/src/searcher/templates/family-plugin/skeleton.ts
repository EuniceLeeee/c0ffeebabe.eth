/**
 * Minimal Family skeleton derived from the unified FamilyPlugin contract.
 * Copy this directory per Family; fill only the slices your domain needs.
 * The contract (evidenceChannel + nominate, domain slot enforcement) is
 * validated at definition time by the shared defineFamily.
 */
import { defineSwapFamily } from "../../venues/adapter-family-plugin.js";
import { familyId } from "../../venues/adapter-family-identifiers.js";

// 1. manifest: familyId + domain + owned/required actions + taxonomy
const manifest = Object.freeze({
  familyId: familyId("swap:example"),
  domain: "swap" as const,
  ownedActionAdapterIds: Object.freeze(["example-swap"]),
  requiredInfraActionAdapterIds: Object.freeze([]),
  supportedLineages: Object.freeze(["example:lineage"]),
  allowedTaxonomy: Object.freeze([
    { slotKind: "swap" as const, protocolAction: undefined },
  ]),
});

// 2. discovery: evidenceChannel "nominate" + patterns + decodeCandidate
//    (nomination.ts holds the reverse materialization the nominate field
//    points to; address-surface families reuse createAddressSurfaceNomination)
const discovery = Object.freeze({
  evidenceChannel: "nominate" as const,
  sources: Object.freeze(["address-surface" as const]),
  addressSurfaces: Object.freeze([Object.freeze({
    id: "example-surface",
    kind: "interface" as const,
    fingerprint: "example:v1",
  })]),
  decodeCandidate: () => null,
  candidateKey: () => "",
  // nominate: createAddressSurfaceNomination({
  //   opaqueLabels: Object.freeze(["example"]),
  //   interfaceFingerprints: Object.freeze(["example:v1"]),
  // }),
});

// 3. identity/instance/routes/pricing/exact/execution/swap/action/capture
//    follow the domain slot table in README.md. The skeleton below only
//    proves the contract shape compiles; real slices are per-Family.
void discovery;
void manifest;
void defineSwapFamily;
