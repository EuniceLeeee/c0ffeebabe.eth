import { ethers } from "ethers";
import type {
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  effectsProjection,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  ERC4626_SILO_DEFAULT_SAMPLE_SHARES,
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
  ERC4626_SILO_PROBE_ACTOR,
  ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID,
  erc4626SiloRedeemSimulation,
  validateErc4626SiloRedeemEffects,
} from "./shared.js";
import {
  ERC4626_SILO_REDEEM_FAMILY_ID,
  ERC4626_SILO_REDEEM_LINEAGE_ID,
} from "./manifest.js";
import type {
  Erc4626SiloRedeemCandidate,
  Erc4626SiloRedeemIdentity,
  Erc4626SiloRedeemIdentityEvidence,
} from "./types.js";

export const erc4626SiloRedeemIdentity = {
  variants: [{
    id: "observed-payout-active-proof",
    kind: "custom" as const,
    lineageId: ERC4626_SILO_REDEEM_LINEAGE_ID,
    applies: (candidate: Erc4626SiloRedeemCandidate) =>
      candidate.candidateKind === "erc4626-silo-payout",
    requirements(
      input: IdentityStepInput<Erc4626SiloRedeemCandidate, unknown>,
    ) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      if (evidence.phase === "base") {
        return { transports: ["eth-call" as const] };
      }
      return {
        transports: [
          "eth-call" as const,
          "effect-delta-simulation" as const,
        ],
        caller: "verified-actor" as const,
        effects: [
          "return-data" as const,
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ],
      };
    },
    buildRequests(
      input: IdentityStepInput<Erc4626SiloRedeemCandidate, unknown>,
    ) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (!evidence.behaviorValid) return [];
      if (evidence.phase === "base") {
        return Object.freeze([callRequest(
          "identity-preview-redeem",
          evidence.vault,
          ERC4626_SILO_INTERFACE.encodeFunctionData(
            "previewRedeem",
            [evidence.sampleShares],
          ),
        )]);
      }
      if (evidence.phase === "preview") {
        return activeRequests(evidence);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<Erc4626SiloRedeemCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): Erc4626SiloRedeemIdentityEvidence {
      const successful = input.results.map((result) => {
        if (!result.ok) {
          throw new Error(`ERC4626 Silo identity unresolved: ${result.failure}`);
        }
        return result;
      });
      if (successful.length > 0) assertSameSource(successful);
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) return decodeBase(input.step.candidate, input.results);
      if (prior.phase === "base") return decodePreview(prior, input.results);
      if (prior.phase === "preview") return decodeActive(prior, input.results);
      return prior;
    },
    decide(
      input: IdentityStepInput<Erc4626SiloRedeemCandidate, unknown>,
    ) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "rejected" as const,
          reason: "silo_static_behavior_failed",
        };
      }
      if (proof.phase !== "active") return { status: "continue" as const };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
          lineageId: ERC4626_SILO_REDEEM_LINEAGE_ID,
          subject: canonicalAddress(input.candidate.vault),
          provenance: Object.freeze([Object.freeze({
            kind: "silo-payout-active-proof",
            subject: canonicalAddress(input.candidate.vault),
            evidenceHash: proof.behaviorProofHash,
          })]),
          vault: proof.vault,
          payoutToken: proof.payoutToken,
          underlyingAsset: proof.underlyingAsset,
        }),
      };
    },
  }],
  identityKey: (identity) =>
    `${lowerAddress(identity.vault)}:${lowerAddress(identity.payoutToken)}`,
} satisfies IdentitySemantics<
  Erc4626SiloRedeemCandidate,
  Erc4626SiloRedeemIdentity
>;

function identityEvidence(
  value: unknown,
): Erc4626SiloRedeemIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("ERC4626 Silo identity evidence is malformed");
  }
  return value as Erc4626SiloRedeemIdentityEvidence;
}

function baseRequests(
  candidate: Erc4626SiloRedeemCandidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-vault-code", candidate.vault),
    codeRequest("identity-payout-code", candidate.payoutToken),
    callRequest(
      "identity-vault-asset",
      candidate.vault,
      ERC4626_SILO_INTERFACE.encodeFunctionData("asset"),
    ),
    callRequest(
      "identity-payout-asset",
      candidate.payoutToken,
      ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionData("asset"),
    ),
    callRequest(
      "identity-total-supply",
      candidate.vault,
      ERC4626_SILO_INTERFACE.encodeFunctionData("totalSupply"),
    ),
  ]);
}

function decodeBase(
  candidate: Erc4626SiloRedeemCandidate,
  results: readonly AdapterRequestResult[],
): Erc4626SiloRedeemIdentityEvidence {
  requireRuntimeCode(results, "identity-vault-code");
  requireRuntimeCode(results, "identity-payout-code");
  const underlyingAsset = decodeAddress(
    ERC4626_SILO_INTERFACE,
    "asset",
    results,
    "identity-vault-asset",
  );
  const payoutAsset = decodeAddress(
    ERC4626_SILO_PAYOUT_INTERFACE,
    "asset",
    results,
    "identity-payout-asset",
  );
  const totalSupply = decodeUint(
    ERC4626_SILO_INTERFACE,
    "totalSupply",
    results,
    "identity-total-supply",
  );
  const sampleShares = totalSupply > 1n
    ? totalSupply / 2n < ERC4626_SILO_DEFAULT_SAMPLE_SHARES
      ? totalSupply / 2n
      : ERC4626_SILO_DEFAULT_SAMPLE_SHARES
    : 0n;
  return Object.freeze({
    phase: "base" as const,
    vault: canonicalAddress(candidate.vault),
    payoutToken: canonicalAddress(candidate.payoutToken),
    underlyingAsset,
    totalSupply,
    sampleShares,
    behaviorValid:
      underlyingAsset !== ethers.ZeroAddress &&
      sameAddress(underlyingAsset, payoutAsset) &&
      !sameAddress(candidate.vault, underlyingAsset) &&
      sampleShares > 0n,
  });
}

function decodePreview(
  base: Extract<
    Erc4626SiloRedeemIdentityEvidence,
    { readonly phase: "base" }
  >,
  results: readonly AdapterRequestResult[],
): Erc4626SiloRedeemIdentityEvidence {
  const sampleAssets = decodeUint(
    ERC4626_SILO_INTERFACE,
    "previewRedeem",
    results,
    "identity-preview-redeem",
  );
  return Object.freeze({
    ...base,
    phase: "preview" as const,
    sampleAssets,
    behaviorValid: base.behaviorValid && sampleAssets > 0n,
  });
}

function activeRequests(
  proof: Extract<
    Erc4626SiloRedeemIdentityEvidence,
    { readonly phase: "preview" }
  >,
): readonly AdapterRequest[] {
  return Object.freeze([
    callRequest(
      "identity-preview-withdraw",
      proof.payoutToken,
      ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionData(
        "previewWithdraw",
        [proof.sampleAssets],
      ),
    ),
    erc4626SiloRedeemSimulation({
      id: "identity-active-redeem",
      vault: proof.vault,
      payoutToken: proof.payoutToken,
      actor: ERC4626_SILO_PROBE_ACTOR,
      callerRef: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID,
      }),
      amountIn: proof.sampleShares,
    }),
  ]);
}

function decodeActive(
  preview: Extract<
    Erc4626SiloRedeemIdentityEvidence,
    { readonly phase: "preview" }
  >,
  results: readonly AdapterRequestResult[],
): Erc4626SiloRedeemIdentityEvidence {
  const expectedPayout = decodeUint(
    ERC4626_SILO_PAYOUT_INTERFACE,
    "previewWithdraw",
    results,
    "identity-preview-withdraw",
  );
  const active = successfulResult(results, "identity-active-redeem");
  let actualPayout = 0n;
  try {
    actualPayout = validateErc4626SiloRedeemEffects({
      result: active,
      vault: preview.vault,
      payoutToken: preview.payoutToken,
      actor: ERC4626_SILO_PROBE_ACTOR,
      amountIn: preview.sampleShares,
    });
  } catch {
    // Returned but causally incompatible effects are settled negative evidence.
  }
  const behaviorValid = preview.behaviorValid &&
    expectedPayout > 0n && actualPayout === expectedPayout;
  return Object.freeze({
    ...preview,
    phase: "active" as const,
    expectedPayout,
    behaviorValid,
    behaviorProofHash: hashCanonical({
      vault: lowerAddress(preview.vault),
      payoutToken: lowerAddress(preview.payoutToken),
      underlyingAsset: lowerAddress(preview.underlyingAsset),
      sampleShares: preview.sampleShares,
      sampleAssets: preview.sampleAssets,
      expectedPayout,
      actualPayout,
      effects: effectsProjection(active.effects),
    }),
  });
}
