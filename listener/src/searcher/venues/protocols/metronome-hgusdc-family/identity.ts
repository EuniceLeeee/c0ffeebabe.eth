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
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeDecimals,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
} from "../standard-family/common.js";
import {
  METRONOME_HGUSDC_BINDINGS,
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_ERC20_INTERFACE,
  METRONOME_HGUSDC_PATH_HASH,
  METRONOME_HGUSDC_VAULT_INTERFACE,
} from "./shared.js";
import {
  METRONOME_HGUSDC_FAMILY_ID,
  METRONOME_HGUSDC_LINEAGE_ID,
} from "./manifest.js";
import type {
  MetronomeHgUsdcCandidate,
  MetronomeHgUsdcIdentity,
  MetronomeHgUsdcIdentityEvidence,
} from "./types.js";

export const metronomeHgUsdcIdentity = {
  variants: [{
    id: "observed-path-active-quote-proof",
    kind: "custom" as const,
    lineageId: METRONOME_HGUSDC_LINEAGE_ID,
    applies: () => true,
    requirements(
      input: IdentityStepInput<MetronomeHgUsdcCandidate, unknown>,
    ) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return {
          transports: ["get-code" as const, "eth-call" as const],
        };
      }
      if (evidence.phase === "base" || evidence.phase === "curve") {
        // The observed-path proof reads the Curve get_dy and vault
        // previewRedeem over eth-call before the final active step.
        return { transports: ["eth-call" as const] };
      }
      return {
        transports: ["effect-delta-simulation" as const],
        caller: "verified-actor" as const,
        effects: [
          "return-data" as const,
          "token-delta" as const,
          "native-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ],
      };
    },
    buildRequests(input: IdentityStepInput<MetronomeHgUsdcCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (!evidence.behaviorValid) return [];
      if (evidence.phase === "base") {
        return Object.freeze([callRequest(
          "identity-curve-quote",
          METRONOME_HGUSDC_BINDINGS.curve,
          METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionData(
            "get_dy",
            [1n, 0n, evidence.sampleAmount],
          ),
        )]);
      }
      if (evidence.phase === "curve") {
        return Object.freeze([callRequest(
          "identity-vault-preview",
          METRONOME_HGUSDC_BINDINGS.vault,
          METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionData(
            "previewRedeem",
            [evidence.curveOut],
          ),
        )]);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<MetronomeHgUsdcCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): MetronomeHgUsdcIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeBase(input.step.candidate, input.results);
      }
      if (prior.phase === "base") return decodeCurve(prior, input.results);
      if (prior.phase === "curve") return decodeActive(prior, input.results);
      return prior;
    },
    decide(input: IdentityStepInput<MetronomeHgUsdcCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "metronome_hgusdc_binding_failed",
              evidenceRequestIds: ["observed-path-active-quote-proof"],
        };
      }
      if (proof.phase !== "active") return { status: "continue" as const };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: METRONOME_HGUSDC_FAMILY_ID,
          lineageId: METRONOME_HGUSDC_LINEAGE_ID,
          subject: canonicalAddress(input.candidate.router),
          provenance: Object.freeze([Object.freeze({
            kind: "observed-path-active-dependent-quote-proof",
            subject: canonicalAddress(input.candidate.router),
            evidenceHash: proof.behaviorProofHash,
          })]),
          router: proof.router,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.router),
} satisfies IdentitySemantics<
  MetronomeHgUsdcCandidate,
  MetronomeHgUsdcIdentity
>;

function identityEvidence(
  value: unknown,
): MetronomeHgUsdcIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("Metronome hgUSDC identity evidence is malformed");
  }
  return value as MetronomeHgUsdcIdentityEvidence;
}

function baseRequests(
  candidate: MetronomeHgUsdcCandidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-router-code", candidate.router),
    codeRequest("identity-curve-code", METRONOME_HGUSDC_BINDINGS.curve),
    codeRequest("identity-vault-code", METRONOME_HGUSDC_BINDINGS.vault),
    codeRequest("identity-token-in-code", METRONOME_HGUSDC_BINDINGS.tokenIn),
    codeRequest("identity-token-out-code", METRONOME_HGUSDC_BINDINGS.tokenOut),
    callRequest(
      "identity-curve-coin-0",
      METRONOME_HGUSDC_BINDINGS.curve,
      METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionData("coins", [0n]),
    ),
    callRequest(
      "identity-curve-coin-1",
      METRONOME_HGUSDC_BINDINGS.curve,
      METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionData("coins", [1n]),
    ),
    callRequest(
      "identity-vault-asset",
      METRONOME_HGUSDC_BINDINGS.vault,
      METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionData("asset"),
    ),
    callRequest(
      "identity-token-in-decimals",
      METRONOME_HGUSDC_BINDINGS.tokenIn,
      METRONOME_HGUSDC_ERC20_INTERFACE.encodeFunctionData("decimals"),
    ),
  ]);
}

function decodeBase(
  candidate: MetronomeHgUsdcCandidate,
  results: readonly AdapterRequestResult[],
): MetronomeHgUsdcIdentityEvidence {
  for (const id of [
    "identity-router-code",
    "identity-curve-code",
    "identity-vault-code",
    "identity-token-in-code",
    "identity-token-out-code",
  ]) requireRuntimeCode(results, id);
  const coin0 = decodeAddress(
    METRONOME_HGUSDC_CURVE_INTERFACE,
    "coins",
    results,
    "identity-curve-coin-0",
  );
  const coin1 = decodeAddress(
    METRONOME_HGUSDC_CURVE_INTERFACE,
    "coins",
    results,
    "identity-curve-coin-1",
  );
  const vaultAsset = decodeAddress(
    METRONOME_HGUSDC_VAULT_INTERFACE,
    "asset",
    results,
    "identity-vault-asset",
  );
  const one = decodeDecimals(
    METRONOME_HGUSDC_ERC20_INTERFACE,
    results,
    "identity-token-in-decimals",
  );
  const sampleAmount = candidate.observedAmount < one
    ? candidate.observedAmount
    : one;
  return Object.freeze({
    phase: "base" as const,
    router: canonicalAddress(candidate.router),
    sampleAmount,
    behaviorValid:
      sampleAmount > 0n &&
      sameAddress(coin0, METRONOME_HGUSDC_BINDINGS.curveIntermediate) &&
      sameAddress(coin1, METRONOME_HGUSDC_BINDINGS.tokenIn) &&
      sameAddress(vaultAsset, METRONOME_HGUSDC_BINDINGS.tokenOut),
  });
}

function decodeCurve(
  base: Extract<MetronomeHgUsdcIdentityEvidence, { readonly phase: "base" }>,
  results: readonly AdapterRequestResult[],
): MetronomeHgUsdcIdentityEvidence {
  const curveOut = decodeUint(
    METRONOME_HGUSDC_CURVE_INTERFACE,
    "get_dy",
    results,
    "identity-curve-quote",
  );
  return Object.freeze({
    ...base,
    phase: "curve" as const,
    curveOut,
    behaviorValid: base.behaviorValid && curveOut > 0n,
  });
}

function decodeActive(
  curve: Extract<MetronomeHgUsdcIdentityEvidence, { readonly phase: "curve" }>,
  results: readonly AdapterRequestResult[],
): MetronomeHgUsdcIdentityEvidence {
  const amountOut = decodeUint(
    METRONOME_HGUSDC_VAULT_INTERFACE,
    "previewRedeem",
    results,
    "identity-vault-preview",
  );
  const behaviorValid = curve.behaviorValid && amountOut > 0n;
  return Object.freeze({
    ...curve,
    phase: "active" as const,
    amountOut,
    behaviorValid,
    behaviorProofHash: hashCanonical({
      router: lowerAddress(curve.router),
      curve: lowerAddress(METRONOME_HGUSDC_BINDINGS.curve),
      vault: lowerAddress(METRONOME_HGUSDC_BINDINGS.vault),
      tokenIn: lowerAddress(METRONOME_HGUSDC_BINDINGS.tokenIn),
      curveIntermediate: lowerAddress(
        METRONOME_HGUSDC_BINDINGS.curveIntermediate,
      ),
      tokenOut: lowerAddress(METRONOME_HGUSDC_BINDINGS.tokenOut),
      sampleAmount: curve.sampleAmount,
      curveOut: curve.curveOut,
      amountOut,
      pathHash: METRONOME_HGUSDC_PATH_HASH,
    }),
  });
}
