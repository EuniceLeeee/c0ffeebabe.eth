import { getAddress } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, callRequest, codeRequest, decodeAddress, decodeUint, requireRuntimeCode, sameAddress, successfulResult } from "../standard-family/common.js";
import { ABI, proveBearRuntime } from "./variants.js";
import { proveConversionAssetRuntime } from "./asset-runtime.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { conversionSimulation, decodeConversionReceipt, simulationRequirements } from "./simulation.js";
import type { ConversionCandidate, ConversionIdentity } from "./types.js";
import { xwinIdentity } from "./xwin-identity.js";

type Evidence =
  | { phase: "rejected" }
  | { phase: "asset-unproven" }
  | { phase: "code"; asset: string; codeHash: string }
  | { phase: "state"; asset: string; codeHash: string; assetCodeHash: string; sample: bigint }
  | { phase: "active"; asset: string; codeHash: string; assetCodeHash: string; proofHash: string };
export const identity = {
  memoReuse: "recheck-identity",
  variants: [{
    id: "btb-bear-code-and-effects", kind: "standalone-contract", lineageId: LINEAGE,
    applies: candidate => candidate.candidateKind === "token-conversion" && candidate.variantHint !== "xwin-allocations-v1",
    requirements({ evidence }) {
      const p = evidence as Evidence | undefined;
      return p?.phase === "state" ? simulationRequirements : { transports: p?.phase === "code" ? ["get-code", "eth-call"] : ["get-code"] };
    },
    buildRequests({ candidate, evidence }) {
      const p = evidence as Evidence | undefined;
      if (!p) return [codeRequest("identity-code", candidate.target)];
      if (p.phase === "code") return [
        codeRequest("identity-asset-code", p.asset),
        callRequest("identity-asset", candidate.target, ABI.encodeFunctionData("BTB_TOKEN")),
        callRequest("identity-supply", candidate.target, ABI.encodeFunctionData("totalSupply")),
        callRequest("identity-backing", p.asset, ABI.encodeFunctionData("balanceOf", [candidate.target])),
      ];
      if (p.phase === "state" && p.sample > 0n) return [
        conversionSimulation("identity-mint", candidate.target, p.asset, "mint", p.sample),
        conversionSimulation("identity-redeem", candidate.target, p.asset, "redeem", p.sample),
      ];
      return [];
    },
    decode({ step, results }): Evidence {
      assertSameSource(results.map(r => successfulResult(results, r.id)));
      const p = step.evidence as Evidence | undefined;
      if (!p) {
        const code = successfulResult(results, "identity-code").data;
        try {
          const asset = getAddress(`0x${code.slice(2 + 837 * 2 + 24, 2 + (837 + 32) * 2)}`);
          return { phase: "code", asset, codeHash: proveBearRuntime(code, step.candidate.target, asset) };
        } catch { return { phase: "rejected" }; }
      }
      if (p.phase === "code") {
        const assetCode = requireRuntimeCode(results, "identity-asset-code");
        let assetCodeHash: string;
        try { assetCodeHash = proveConversionAssetRuntime(assetCode, p.asset); }
        catch { return { phase: "asset-unproven" }; }
        if (!sameAddress(decodeAddress(ABI, "BTB_TOKEN", results, "identity-asset"), p.asset)) throw new Error("conversion asset getter/code mismatch");
        const supply = decodeUint(ABI, "totalSupply", results, "identity-supply");
        const backing = decodeUint(ABI, "balanceOf", results, "identity-backing");
        const sample = [10n ** 18n, supply, backing].reduce((a,b) => a < b ? a : b);
        return { ...p, phase: "state", assetCodeHash, sample };
      }
      if (p.phase !== "state") throw new Error("unexpected conversion identity phase");
      const mint = decodeConversionReceipt(results, "identity-mint", step.candidate.target, p.asset, "mint", p.sample);
      const redeem = decodeConversionReceipt(results, "identity-redeem", step.candidate.target, p.asset, "redeem", p.sample, mint.actor);
      return { phase: "active", asset: p.asset, codeHash: p.codeHash, assetCodeHash: p.assetCodeHash, proofHash: hashCanonical({ codeHash: p.codeHash, assetCodeHash: p.assetCodeHash, sample: p.sample,
        mint: { ...mint, source: { ...mint.source } }, redeem: { ...redeem, source: { ...redeem.source } } }) };
    },
    decide({ candidate, evidence }) {
      const p = evidence as Evidence | undefined;
      if (p?.phase === "rejected") return { status: "chain-proven-rejected", reasonCode: "unsupported_conversion_runtime", evidenceRequestIds: ["identity-code"] };
      if (p?.phase === "asset-unproven") return { status: "retryable", reasonCode: "conversion_asset_dependency_closure_unproven" };
      if (p?.phase === "state" && p.sample === 0n) return { status: "retryable", reasonCode: "conversion_no_backed_probe_capacity" };
      if (p?.phase !== "active") return { status: "continue" };
      return { status: "verified", identity: Object.freeze({
        familyId: FAMILY, lineageId: LINEAGE, subject: candidate.target,
        variant: "btb-bear-v1", asset: p.asset, codeHash: p.codeHash, assetCodeHash: p.assetCodeHash,
        provenance: [{ kind: "normalized-runtime-immutable-and-balance-proof", subject: candidate.target, evidenceHash: p.proofHash }],
      }) };
    },
  }, xwinIdentity] as const,
  identityKey: value => value.subject.toLowerCase(),
} satisfies IdentitySemantics<ConversionCandidate, ConversionIdentity>;
