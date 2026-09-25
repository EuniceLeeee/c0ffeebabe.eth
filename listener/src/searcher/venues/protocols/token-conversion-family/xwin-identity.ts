import type { IdentityVariant } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSource, codeRequest, requireRuntimeCode, returnedResult } from "../standard-family/common.js";
import { FAMILY, XWIN_LINEAGE } from "./manifest.js";
import { xwinSimulationRequirements as simulationRequirements } from "./xwin.js";
import { checkXwinDependencies, decodeXwinReceipt, decodeXwinSurface, proveXwinProxy, xwinDependencyRequests, xwinSimulation, xwinStateRequests, type XwinSurface } from "./xwin.js";
import type { ConversionCandidate, ConversionIdentity } from "./types.js";

type Evidence =
  | { phase: "rejected" }
  | { phase: "surface"; surface: XwinSurface }
  | { phase: "probe"; surface: XwinSurface; unit: bigint; redeemAmount: bigint }
  | { phase: "actor"; surface: XwinSurface; actor: string; proofHash: string }
  | { phase: "verified"; surface: XwinSurface; proofHash: string };
export const xwinIdentity = {
  id: "xwin-proxy-implementation-and-executor-effects", kind: "standalone-contract", lineageId: XWIN_LINEAGE,
  applies: candidate => candidate.candidateKind === "token-conversion" && candidate.variantHint !== "btb-bear-v1",
  requirements({ evidence: p }) {
    return p?.phase === "probe" ? simulationRequirements : p?.phase === "actor" ? { transports: ["get-code"] } :
      p?.phase === "surface" ? { transports: ["get-code", "eth-call"], caller: "executor" } : { transports: ["get-code", "get-storage", "eth-call"], caller: "executor" };
  },
  buildRequests({ candidate, evidence: p }) {
    if (!p) return xwinStateRequests("identity-xwin", candidate.target).map((r, i) => i === 0 ? r : { ...r, required: false });
    if (p.phase === "surface") return xwinDependencyRequests("identity-xwin", p.surface);
    if (p.phase === "probe") return [xwinSimulation("identity-xwin-mint", p.surface, "mint", p.unit),
      xwinSimulation("identity-xwin-redeem", p.surface, "redeem", p.redeemAmount)];
    if (p.phase === "actor") return [codeRequest("identity-xwin-actor-code", p.actor)];
    return [];
  },
  decode({ step, results }): Evidence {
    const p = step.evidence;
    if (!p) {
      const code = returnedResult(results, "identity-xwin-proxy").data;
      try { proveXwinProxy(code); } catch { return { phase: "rejected" }; }
      return { phase: "surface", surface: decodeXwinSurface(results, "identity-xwin", step.candidate.target) };
    }
    if (p.phase === "surface") {
      const unit = checkXwinDependencies(results, "identity-xwin", p.surface);
      return { ...p, phase: "probe", unit, redeemAmount: p.surface.supply < 10n ** 18n ? p.surface.supply : 10n ** 18n };
    }
    if (p.phase === "probe") {
      const mint = decodeXwinReceipt(results, "identity-xwin-mint", p.surface, "mint", p.unit);
      const redeem = decodeXwinReceipt(results, "identity-xwin-redeem", p.surface, "redeem", p.redeemAmount, mint.actor);
      return { phase: "actor", surface: p.surface, actor: mint.actor, proofHash: hashCanonical({
        surface: { ...p.surface, source: { ...p.surface.source } }, unit: p.unit, redeemAmount: p.redeemAmount,
        mint: { ...mint, source: { ...mint.source } }, redeem: { ...redeem, source: { ...redeem.source } },
      }) };
    }
    if (p.phase !== "actor") throw new Error("unexpected xWin identity phase");
    requireRuntimeCode(results, "identity-xwin-actor-code");
    assertSource(returnedResult(results, "identity-xwin-actor-code").source, p.surface.source);
    return { phase: "verified", surface: p.surface, proofHash: p.proofHash };
  },
  decide({ candidate, evidence: p }) {
    if (p?.phase === "rejected") return { status: "chain-proven-rejected", reasonCode: "unsupported_xwin_proxy", evidenceRequestIds: ["identity-xwin-proxy"] };
    if (p?.phase === "probe" && p.redeemAmount === 0n) return { status: "retryable", reasonCode: "xwin_no_backed_redeem_probe" };
    if (p?.phase !== "verified") return { status: "continue" };
    return { status: "verified", identity: {
      familyId: FAMILY, lineageId: XWIN_LINEAGE, subject: candidate.target, variant: "xwin-allocations-v1",
      asset: p.surface.asset, codeHash: p.surface.codeHash, proxyAdmin: p.surface.proxyAdmin,
      provenance: [{ kind: "proxy-current-implementation-executor-balance-proof", subject: candidate.target, evidenceHash: p.proofHash }],
    } };
  },
} satisfies IdentityVariant<ConversionCandidate, ConversionIdentity, Evidence>;
