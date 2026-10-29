import { keccak256 } from "ethers";
import type { IdentitySemantics, IdentityStepInput } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, callRequest, canonicalAddress, codeRequest, lowerAddress, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { ONDO_ERC20_INTERFACE, ONDO_FEES_INTERFACE, ONDO_MANAGER_INTERFACE, ONDO_ORACLE_INTERFACE } from "./abi.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { OndoCandidate, OndoEvidence, OndoIdentity } from "./types.js";

export const ondoIdentity = {
  variants: [{
    id: "ondo-usdy-instant-redeem",
    kind: "custom" as const,
    lineageId: LINEAGE,
    applies: () => true,
    requirements({ evidence }: IdentityStepInput<OndoCandidate, unknown>) {
      const e = evidence as OndoEvidence | undefined;
      return e === undefined
        ? { transports: ["get-code" as const, "eth-call" as const] }
        : { transports: ["eth-call" as const] };
    },
    buildRequests({ candidate, evidence }: IdentityStepInput<OndoCandidate, unknown>) {
      const e = evidence as OndoEvidence | undefined;
      if (e === undefined) return baseRequests(candidate);
      if (e.phase === "base") return completeRequests(e);
      return [];
    },
    decode(input: { readonly step: IdentityStepInput<OndoCandidate, unknown>; readonly results: readonly AdapterRequestResult[] }): OndoEvidence {
      const prior = input.step.evidence as OndoEvidence | undefined;
      if (prior === undefined) return decodeBase(input.step.candidate, input.results);
      if (prior.phase === "base") return decodeComplete(prior, input.results);
      throw new Error("ondo invalid identity phase");
    },
    decide(input: IdentityStepInput<OndoCandidate, unknown>) {
      const e = input.evidence as OndoEvidence | undefined;
      if (e === undefined || e.phase !== "complete") return { status: "continue" as const };
      if (!e.behaviorValid) return { status: "chain-proven-rejected" as const, reasonCode: "ondo_redeem_unavailable", evidenceRequestIds: ["ondo-complete"] };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: FAMILY, lineageId: LINEAGE, subject: canonicalAddress(e.manager),
          provenance: Object.freeze([Object.freeze({ kind: "ondo-usdy-instant-redeem", subject: canonicalAddress(e.manager), evidenceHash: e.behaviorHash })]),
          manager: e.manager, rwa: e.rwa, receive: e.receive, oracle: e.oracle, fees: e.fees, normalizer: e.normalizer,
          rwaDecimals: e.rwaDecimals, receiveDecimals: e.receiveDecimals, minimumRwaPrice: e.minimumRwaPrice,
          redeemPaused: false, priceRwa: e.priceRwa, priceReceive: e.priceReceive, feeFlat: e.feeFlat, feeBps: e.feeBps,
          feePrecision: e.feePrecision, managerCodeHash: e.managerCodeHash,
        }),
      };
    },
  }],
  identityKey: (i) => lowerAddress(i.subject),
} satisfies IdentitySemantics<OndoCandidate, OndoIdentity>;

function baseRequests(c: OndoCandidate): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("ondo-manager-code", c.manager),
    callRequest("ondo-rwa", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("rwaToken")),
    callRequest("ondo-oracle", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("ondoOracle")),
    callRequest("ondo-fees", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("ondoRedemptionFees")),
    callRequest("ondo-normalizer", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("RWA_NORMALIZER")),
    callRequest("ondo-paused", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("redeemPaused")),
    callRequest("ondo-min-price", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("minimumRwaPrice")),
    callRequest("ondo-accepted", c.manager, ONDO_MANAGER_INTERFACE.encodeFunctionData("acceptedRedemptionTokens", [c.receive])),
  ]);
}

function decodeBase(c: OndoCandidate, results: readonly AdapterRequestResult[]): OndoEvidence {
  const code = requireRuntimeCode(results, "ondo-manager-code");
  const rwa = canonicalAddress(String(ONDO_MANAGER_INTERFACE.decodeFunctionResult("rwaToken", successfulResult(results, "ondo-rwa").data)[0]));
  const oracle = canonicalAddress(String(ONDO_MANAGER_INTERFACE.decodeFunctionResult("ondoOracle", successfulResult(results, "ondo-oracle").data)[0]));
  const fees = canonicalAddress(String(ONDO_MANAGER_INTERFACE.decodeFunctionResult("ondoRedemptionFees", successfulResult(results, "ondo-fees").data)[0]));
  const normalizer = BigInt(ONDO_MANAGER_INTERFACE.decodeFunctionResult("RWA_NORMALIZER", successfulResult(results, "ondo-normalizer").data)[0]);
  const paused = Boolean(ONDO_MANAGER_INTERFACE.decodeFunctionResult("redeemPaused", successfulResult(results, "ondo-paused").data)[0]);
  const minPrice = BigInt(ONDO_MANAGER_INTERFACE.decodeFunctionResult("minimumRwaPrice", successfulResult(results, "ondo-min-price").data)[0]);
  if (paused) throw new Error("ondo redeem is paused");
  if (!Boolean(ONDO_MANAGER_INTERFACE.decodeFunctionResult("acceptedRedemptionTokens", successfulResult(results, "ondo-accepted").data)[0])) throw new Error("ondo receive token not accepted");
  return Object.freeze({ phase: "base" as const, source: assertSameSource([successfulResult(results, "ondo-manager-code")]), manager: canonicalAddress(c.manager), rwa, receive: canonicalAddress(c.receive), oracle, fees, normalizer, rwaDecimals: 18, receiveDecimals: 6, minimumRwaPrice: minPrice, redeemPaused: false, managerCodeHash: keccak256(code) });
}

function completeRequests(e: Extract<OndoEvidence, { phase: "base" }>): readonly AdapterRequest[] {
  return Object.freeze([
    callRequest("ondo-price-rwa", e.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [e.rwa])),
    callRequest("ondo-price-receive", e.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [e.receive])),
    callRequest("ondo-fee-config", e.fees, ONDO_FEES_INTERFACE.encodeFunctionData("getActiveFeeConfig", [e.rwa, e.receive, "0x" + "0".repeat(64)])),
    callRequest("ondo-fee-precision", e.fees, ONDO_FEES_INTERFACE.encodeFunctionData("FEE_PRECISION")),
  ]);
}

function decodeComplete(e: Extract<OndoEvidence, { phase: "base" }>, results: readonly AdapterRequestResult[]): OndoEvidence {
  const priceRwa = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(results, "ondo-price-rwa").data)[0]);
  const priceReceive = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(results, "ondo-price-receive").data)[0]);
  const cfg = ONDO_FEES_INTERFACE.decodeFunctionResult("getActiveFeeConfig", successfulResult(results, "ondo-fee-config").data);
  const active = cfg[0] as unknown as { active: boolean; flatFee: bigint; bpsFee: bigint };
  const feeFlat = BigInt(active.flatFee ?? 0n), feeBps = BigInt(active.bpsFee ?? 0n);
  const feePrecision = BigInt(ONDO_FEES_INTERFACE.decodeFunctionResult("FEE_PRECISION", successfulResult(results, "ondo-fee-precision").data)[0]);
  const behaviorValid = priceRwa >= e.minimumRwaPrice && priceReceive > 0n;
  return Object.freeze({ phase: "complete" as const, source: assertSameSource([successfulResult(results, "ondo-price-rwa")]), manager: e.manager, rwa: e.rwa, receive: e.receive, oracle: e.oracle, fees: e.fees, normalizer: e.normalizer, rwaDecimals: e.rwaDecimals, receiveDecimals: e.receiveDecimals, minimumRwaPrice: e.minimumRwaPrice, priceRwa, priceReceive, feeFlat, feeBps, feePrecision, managerCodeHash: e.managerCodeHash, behaviorValid, behaviorHash: hashCanonical({ manager: e.manager, priceRwa: priceRwa.toString(), priceReceive: priceReceive.toString(), feeFlat: feeFlat.toString(), feeBps: feeBps.toString() }) });
}
