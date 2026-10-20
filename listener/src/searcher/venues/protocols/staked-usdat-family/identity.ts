import { ethers } from "ethers";
import type { IdentitySemantics, IdentityVariant } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, assertSource, codeRequest, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";
import { createErc4626StandardIdentityVariant } from "../erc4626-family/identity.js";
import type { Erc4626Candidate, Erc4626Identity } from "../erc4626-family/types.js";
import { STAKED_USDAT_FAMILY_ID, STAKED_USDAT_LINEAGE_ID } from "./manifest.js";
import { decodeStakedUsdatBinding, isStakedUsdatProxy, stakedUsdatAddressWord, stakedUsdatBindingRequests,
  stakedUsdatSlot, STAKED_USDAT_IMPLEMENTATION_HASH, type StakedUsdatBinding,
  stakedUsdatFeeRequests, decodeStakedUsdatFeeWitness, stakedUsdatDepositEventAssets, type StakedUsdatFeeWitness } from "./identity-proof.js";

type Proof = { readonly phase: "proxy" | "binding"; readonly source: CanonicalSource; readonly proxyCodeHash: string; readonly implementation: string } |
  { readonly phase: "behavior"; readonly binding: StakedUsdatBinding; readonly feeWitness: StakedUsdatFeeWitness; readonly behavior?: unknown } |
  { readonly phase: "rejected"; readonly reason: string; readonly ids: readonly string[] };
function standard(feeWitness: StakedUsdatFeeWitness) {
  return createErc4626StandardIdentityVariant({ familyId: STAKED_USDAT_FAMILY_ID,
    lineageId: STAKED_USDAT_LINEAGE_ID, id: "staked-usdat-standard-active-proof", excludeSpecialized: false,
    depositEventAssets: grossAssets => stakedUsdatDepositEventAssets(feeWitness, grossAssets) });
}

const variant: IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> = {
  id: "source-bound-staked-usdat-deposit", kind: "standalone-contract", lineageId: STAKED_USDAT_LINEAGE_ID,
  applies: () => true,
  requirements(input) {
    const proof = input.evidence as Proof | undefined;
    if (proof?.phase === "behavior") return standard(proof.feeWitness).requirements({ ...input, evidence: proof.behavior });
    if (proof === undefined) return { transports: ["get-code", "get-storage"] };
    return { transports: proof.phase === "proxy" ? ["get-code"] : ["get-code", "eth-call"] };
  },
  buildRequests(input) {
    const proof = input.evidence as Proof | undefined;
    if (proof === undefined) return [codeRequest("staked-proxy", input.candidate.vault),
      stakedUsdatSlot("staked-implementation", input.candidate.vault)];
    if (proof.phase === "proxy") return [codeRequest("staked-code", proof.implementation)];
    if (proof.phase === "binding") return [...stakedUsdatBindingRequests("staked", input.candidate.vault, proof.implementation),
      ...stakedUsdatFeeRequests("staked", input.candidate.vault)];
    return proof.phase === "behavior" ? standard(proof.feeWitness).buildRequests({ ...input, evidence: proof.behavior }) : [];
  },
  decode({ step, results }): Proof {
    const proof = step.evidence as Proof | undefined;
    if (proof?.phase === "behavior") {
      assertSource(assertSameSource(results.filter(r => r.ok)), proof.binding.proofSource);
      assertSource(proof.feeWitness.source, proof.binding.proofSource);
      return { ...proof, behavior: standard(proof.feeWitness).decode({ step: { ...step, evidence: proof.behavior }, results }) };
    }
    for (const result of results) if (!result.ok) throw new RequiredAdapterRequestError(result);
    const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
    if (proof === undefined) {
      const code = requireRuntimeCode(results, "staked-proxy");
      if (!isStakedUsdatProxy(code)) return { phase: "rejected", reason: "staked_usdat_proxy_not_matched", ids: ["staked-proxy"] };
      return { phase: "proxy", source, proxyCodeHash: ethers.keccak256(code),
        implementation: stakedUsdatAddressWord(returnedResult(results, "staked-implementation").data) };
    }
    if (proof.phase !== "proxy" && proof.phase !== "binding") throw new Error("StakedUSDat unexpected identity phase");
    assertSource(source, proof.source);
    if (ethers.keccak256(requireRuntimeCode(results, "staked-code")) !== STAKED_USDAT_IMPLEMENTATION_HASH)
      return { phase: "rejected", reason: "staked_usdat_implementation_not_matched", ids: ["staked-code"] };
    if (proof.phase === "proxy") return { ...proof, phase: "binding" };
    return { phase: "behavior", binding: decodeStakedUsdatBinding(results, "staked", step.candidate.vault, proof),
      feeWitness: decodeStakedUsdatFeeWitness(results, "staked", proof.source) };
  },
  decide(input) {
    const proof = input.evidence as Proof | undefined;
    if (proof?.phase === "rejected") return { status: "chain-proven-rejected", reasonCode: proof.reason, evidenceRequestIds: proof.ids };
    if (proof?.phase !== "behavior") return { status: "continue" };
    const decision = standard(proof.feeWitness).decide({ ...input, evidence: proof.behavior });
    if (decision.status !== "verified") return decision;
    const identity = decision.identity;
    if (!identity.verifiedDirections.deposit || !sameAddress(identity.asset, proof.binding.asset))
      return { status: "retryable", reasonCode: "staked_usdat_deposit_unavailable" };
    // The source-bound implementation's standard redeem/withdraw always revert.
    // requestRedeem creates a queued position and is deliberately not a route.
    return { status: "verified", identity: Object.freeze({ ...identity,
      stakedUsdat: proof.binding, verifiedDirections: Object.freeze({ deposit: true, redeem: false }),
      provenance: Object.freeze([...identity.provenance, Object.freeze({ kind: "staked-usdat-proxy-implementation-getter-proof",
        subject: identity.subject, evidenceHash: hashCanonical({ ...proof.binding, proofSource: { ...proof.binding.proofSource } }) }),
        Object.freeze({ kind: "staked-usdat-source-fee-event-proof", subject: identity.subject,
          evidenceHash: hashCanonical({ ...proof.feeWitness, source: { ...proof.feeWitness.source } }) })]),
    }) };
  },
};

export const stakedUsdatIdentity: IdentitySemantics<Erc4626Candidate, Erc4626Identity> = {
  memoReuse: "recheck-identity", variants: [variant], identityKey: identity => identity.subject.toLowerCase(),
};
