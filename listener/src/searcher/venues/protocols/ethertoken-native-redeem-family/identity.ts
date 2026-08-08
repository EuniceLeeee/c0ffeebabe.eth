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
  decodeDecimals,
  decodeUint,
  effectsProjection,
  lowerAddress,
  requireRuntimeCode,
  successfulResult,
} from "../standard-family/common.js";
import {
  ETHERTOKEN_NATIVE_INTERFACE,
  ETHERTOKEN_NATIVE_PROBE_ACTOR,
  ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
  etherTokenWithdrawalSimulation,
  validateEtherTokenWithdrawal,
} from "./shared.js";
import {
  ETHERTOKEN_NATIVE_FAMILY_ID,
  ETHERTOKEN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import type {
  EtherTokenNativeRedeemCandidate,
  EtherTokenNativeRedeemIdentity,
  EtherTokenNativeRedeemIdentityEvidence,
} from "./types.js";

export const etherTokenNativeRedeemIdentity = {
  variants: [{
    id: "active-ethertoken-native-effect-proof",
    kind: "custom" as const,
    lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
    applies: () => true,
    requirements(
      input: IdentityStepInput<EtherTokenNativeRedeemCandidate, unknown>,
    ) {
      return input.evidence === undefined
        ? { transports: ["get-code" as const, "eth-call" as const] }
        : {
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
    buildRequests(
      input: IdentityStepInput<EtherTokenNativeRedeemCandidate, unknown>,
    ) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (evidence.phase !== "base" || !evidence.behaviorValid) return [];
      return Object.freeze([etherTokenWithdrawalSimulation({
        id: "identity-active-withdraw",
        token: evidence.token,
        actor: ETHERTOKEN_NATIVE_PROBE_ACTOR,
        callerRef: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
        }),
        amountIn: evidence.sampleAmount,
      })]);
    },
    decode(input: {
      readonly step: IdentityStepInput<
        EtherTokenNativeRedeemCandidate,
        unknown
      >;
      readonly results: readonly AdapterRequestResult[];
    }): EtherTokenNativeRedeemIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      return prior === undefined
        ? decodeBase(input.step.candidate, input.results)
        : decodeActive(prior, input.results);
    },
    decide(
      input: IdentityStepInput<EtherTokenNativeRedeemCandidate, unknown>,
    ) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "rejected" as const,
          reason: "ethertoken_native_behavior_failed",
        };
      }
      if (proof.phase !== "active") return { status: "continue" as const };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
          lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
          subject: canonicalAddress(input.candidate.token),
          provenance: Object.freeze([Object.freeze({
            kind: "active-ethertoken-native-effect-proof",
            subject: canonicalAddress(input.candidate.token),
            evidenceHash: proof.behaviorProofHash,
          })]),
          token: proof.token,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.token),
} satisfies IdentitySemantics<
  EtherTokenNativeRedeemCandidate,
  EtherTokenNativeRedeemIdentity
>;

function identityEvidence(
  value: unknown,
): EtherTokenNativeRedeemIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("EtherToken native identity evidence is malformed");
  }
  return value as EtherTokenNativeRedeemIdentityEvidence;
}

function baseRequests(
  candidate: EtherTokenNativeRedeemCandidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-token-code", candidate.token),
    callRequest(
      "identity-token-balance-surface",
      candidate.token,
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData(
        "balanceOf",
        [candidate.token],
      ),
    ),
    callRequest(
      "identity-token-decimals",
      candidate.token,
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData("decimals"),
    ),
    callRequest(
      "identity-token-supply",
      candidate.token,
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData("totalSupply"),
    ),
  ]);
}

function decodeBase(
  candidate: EtherTokenNativeRedeemCandidate,
  results: readonly AdapterRequestResult[],
): EtherTokenNativeRedeemIdentityEvidence {
  requireRuntimeCode(results, "identity-token-code");
  decodeUint(
    ETHERTOKEN_NATIVE_INTERFACE,
    "balanceOf",
    results,
    "identity-token-balance-surface",
  );
  const one = decodeDecimals(
    ETHERTOKEN_NATIVE_INTERFACE,
    results,
    "identity-token-decimals",
  );
  const supply = decodeUint(
    ETHERTOKEN_NATIVE_INTERFACE,
    "totalSupply",
    results,
    "identity-token-supply",
  );
  const preferred = candidate.observedAmount < one
    ? candidate.observedAmount
    : one;
  const sampleAmount = supply === 0n
    ? 0n
    : preferred < supply ? preferred : supply;
  return Object.freeze({
    phase: "base" as const,
    token: canonicalAddress(candidate.token),
    sampleAmount,
    behaviorValid: sampleAmount > 0n,
  });
}

function decodeActive(
  base: EtherTokenNativeRedeemIdentityEvidence,
  results: readonly AdapterRequestResult[],
): EtherTokenNativeRedeemIdentityEvidence {
  if (base.phase !== "base") return base;
  const result = successfulResult(results, "identity-active-withdraw");
  let behaviorValid = false;
  try {
    behaviorValid = validateEtherTokenWithdrawal({
      result,
      token: base.token,
      actor: ETHERTOKEN_NATIVE_PROBE_ACTOR,
      amountIn: base.sampleAmount,
    }) === base.sampleAmount;
  } catch {
    // Returned but causally incompatible effects are settled negative evidence.
  }
  return Object.freeze({
    ...base,
    phase: "active" as const,
    behaviorValid: base.behaviorValid && behaviorValid,
    behaviorProofHash: hashCanonical({
      token: lowerAddress(base.token),
      sampleAmount: base.sampleAmount,
      effects: effectsProjection(result.effects),
    }),
  });
}
