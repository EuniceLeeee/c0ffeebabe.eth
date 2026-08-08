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
  SELF_BURN_NATIVE_PROBE_ACTOR,
  SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
  SELF_BURN_NATIVE_TOKEN_INTERFACE,
  selfBurnNativeSimulation,
  validateSelfBurnNativeEffects,
} from "./shared.js";
import {
  SELF_BURN_NATIVE_FAMILY_ID,
  SELF_BURN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import type {
  SelfBurnNativeCandidate,
  SelfBurnNativeIdentity,
  SelfBurnNativeIdentityEvidence,
} from "./types.js";

export const selfBurnNativeIdentity = {
  variants: [{
    id: "active-self-burn-effect-proof",
    kind: "custom" as const,
    lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
    applies: () => true,
    requirements(input: IdentityStepInput<SelfBurnNativeCandidate, unknown>) {
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
    buildRequests(input: IdentityStepInput<SelfBurnNativeCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (evidence.phase !== "base" || !evidence.behaviorValid) return [];
      return Object.freeze([selfBurnNativeSimulation({
        id: "identity-active-self-burn",
        token: evidence.token,
        actor: SELF_BURN_NATIVE_PROBE_ACTOR,
        callerRef: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
        }),
        amountIn: evidence.sampleAmount,
      })]);
    },
    decode(input: {
      readonly step: IdentityStepInput<SelfBurnNativeCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): SelfBurnNativeIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      return prior === undefined
        ? decodeBase(input.step.candidate, input.results)
        : decodeActive(prior, input.results);
    },
    decide(input: IdentityStepInput<SelfBurnNativeCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "rejected" as const,
          reason: "self_burn_behavior_failed",
        };
      }
      if (proof.phase !== "active") return { status: "continue" as const };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: SELF_BURN_NATIVE_FAMILY_ID,
          lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
          subject: canonicalAddress(input.candidate.token),
          provenance: Object.freeze([Object.freeze({
            kind: "active-self-burn-effect-proof",
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
  SelfBurnNativeCandidate,
  SelfBurnNativeIdentity
>;

function identityEvidence(
  value: unknown,
): SelfBurnNativeIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("self-burn native identity evidence is malformed");
  }
  return value as SelfBurnNativeIdentityEvidence;
}

function baseRequests(
  candidate: SelfBurnNativeCandidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-token-code", candidate.token),
    callRequest(
      "identity-token-balance-surface",
      candidate.token,
      SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData(
        "balanceOf",
        [candidate.token],
      ),
    ),
    callRequest(
      "identity-token-decimals",
      candidate.token,
      SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData("decimals"),
    ),
    callRequest(
      "identity-token-supply",
      candidate.token,
      SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData("totalSupply"),
    ),
  ]);
}

function decodeBase(
  candidate: SelfBurnNativeCandidate,
  results: readonly AdapterRequestResult[],
): SelfBurnNativeIdentityEvidence {
  requireRuntimeCode(results, "identity-token-code");
  decodeUint(
    SELF_BURN_NATIVE_TOKEN_INTERFACE,
    "balanceOf",
    results,
    "identity-token-balance-surface",
  );
  const one = decodeDecimals(
    SELF_BURN_NATIVE_TOKEN_INTERFACE,
    results,
    "identity-token-decimals",
  );
  const supply = decodeUint(
    SELF_BURN_NATIVE_TOKEN_INTERFACE,
    "totalSupply",
    results,
    "identity-token-supply",
  );
  const defaultSample = one >= 100n ? one / 100n : 1n;
  const observed = candidate.observedAmount ?? defaultSample;
  const sampleAmount = supply === 0n ? 0n : observed < supply ? observed : supply;
  return Object.freeze({
    phase: "base" as const,
    token: canonicalAddress(candidate.token),
    sampleAmount,
    behaviorValid: sampleAmount > 0n,
  });
}

function decodeActive(
  base: SelfBurnNativeIdentityEvidence,
  results: readonly AdapterRequestResult[],
): SelfBurnNativeIdentityEvidence {
  if (base.phase !== "base") return base;
  const result = successfulResult(results, "identity-active-self-burn");
  let sampleNativeOut = 0n;
  try {
    sampleNativeOut = validateSelfBurnNativeEffects({
      result,
      token: base.token,
      actor: SELF_BURN_NATIVE_PROBE_ACTOR,
      amountIn: base.sampleAmount,
    });
  } catch {
    // Returned but causally incompatible effects are settled negative evidence.
  }
  return Object.freeze({
    ...base,
    phase: "active" as const,
    sampleNativeOut,
    behaviorValid: base.behaviorValid && sampleNativeOut > 0n,
    behaviorProofHash: hashCanonical({
      token: lowerAddress(base.token),
      sampleAmount: base.sampleAmount,
      sampleNativeOut,
      effects: effectsProjection(result.effects),
    }),
  });
}
