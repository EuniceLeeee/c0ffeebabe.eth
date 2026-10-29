import { keccak256 } from "ethers";
import type { IdentitySemantics, IdentityStepInput } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  callRequest,
  canonicalAddress,
  codeRequest,
  lowerAddress,
  requireRuntimeCode,
  successfulResult,
} from "../standard-family/common.js";
import { ARCANA_DESTINATION_INTERFACE, ARCANA_SOURCE_INTERFACE } from "./abi.js";
import { ARCANA_SAMPLE_AMOUNT } from "./shared.js";
import { arcAmount } from "./math.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type {
  ArcanaCandidate,
  ArcanaIdentity,
  ArcanaIdentityEvidence,
} from "./types.js";

export const arcanaMigrationIdentity = {
  variants: [{
    id: "arcana-migration-source-config",
    kind: "custom" as const,
    lineageId: LINEAGE,
    applies: () => true,
    requirements(input: IdentityStepInput<ArcanaCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      if (evidence.arcToken === "") {
        return { transports: ["eth-call" as const] };
      }
      return { transports: ["eth-call" as const] };
    },
    buildRequests(input: IdentityStepInput<ArcanaCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (evidence.phase === "base" && evidence.arcToken === "") return surfaceRequests(evidence);
      if (evidence.phase !== "base") return [];
      return Object.freeze([callRequest(
        "identity-preview-arc",
        evidence.source,
        ARCANA_SOURCE_INTERFACE.encodeFunctionData("previewArcAmount", [
          evidence.tokenId,
          ARCANA_SAMPLE_AMOUNT,
        ]),
      )]);
    },
    decode(input: {
      readonly step: IdentityStepInput<ArcanaCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): ArcanaIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) return decodeBase(input.step.candidate, input.results);
      if (prior.phase === "base" && prior.arcToken === "") return decodeSurface(prior, input.results);
      return decodeActive(prior, input.results);
    },
    decide(input: IdentityStepInput<ArcanaCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined || proof.arcToken === "") return { status: "continue" as const };
      if (proof.phase !== "active") return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "arcana_migration_behavior_failed",
          evidenceRequestIds: ["identity-active-migration"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: FAMILY,
          lineageId: LINEAGE,
          subject: canonicalAddress(proof.source),
          provenance: Object.freeze([Object.freeze({
            kind: "arcana-migration-source-config",
            subject: canonicalAddress(proof.source),
            evidenceHash: proof.behaviorProofHash,
          })]),
          source: proof.source,
          destination: proof.destination,
          oldToken: proof.oldToken,
          arcToken: proof.arcToken,
          tokenId: proof.tokenId,
          tokenDecimals: proof.tokenDecimals,
          tokenTwapValue: proof.tokenTwapValue,
          tokenMultiplier: proof.tokenMultiplier,
          multiplierScale: proof.multiplierScale,
          proxyCodeHash: proof.proxyCodeHash,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.source),
} satisfies IdentitySemantics<ArcanaCandidate, ArcanaIdentity>;

function identityEvidence(value: unknown): ArcanaIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("arcana identity evidence is malformed");
  }
  return value as ArcanaIdentityEvidence;
}

function baseRequests(candidate: ArcanaCandidate): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-source-code", candidate.source),
    callRequest("identity-token-config", candidate.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("tokenConfigs", [candidate.tokenId])),
    callRequest("identity-multiplier-scale", candidate.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("MULTIPLIER_SCALE")),
    callRequest("identity-destination", candidate.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("destinationReceiver")),
    callRequest("identity-public-enabled", candidate.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("publicMigrationEnabled")),
    callRequest("identity-bridge-enabled", candidate.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("bridgeEnabled")),
  ]);
}

function decodeBase(
  candidate: ArcanaCandidate,
  results: readonly AdapterRequestResult[],
): ArcanaIdentityEvidence {
  const code = requireRuntimeCode(results, "identity-source-code");
  const config = ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
    "tokenConfigs",
    successfulResult(results, "identity-token-config").data,
  );
  const enabled = Boolean(config[7]);
  const publicEnabled = Boolean(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
    "publicMigrationEnabled",
    successfulResult(results, "identity-public-enabled").data,
  )[0]);
  const bridgeEnabled = Boolean(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
    "bridgeEnabled",
    successfulResult(results, "identity-bridge-enabled").data,
  )[0]);
  if (!enabled || !publicEnabled || !bridgeEnabled) {
    throw new Error("arcana migration is not enabled");
  }
  const source = canonicalAddress(candidate.source);
  const destination = canonicalAddress(String(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
    "destinationReceiver",
    successfulResult(results, "identity-destination").data,
  )[0]));
  const multiplierScale = BigInt(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
    "MULTIPLIER_SCALE",
    successfulResult(results, "identity-multiplier-scale").data,
  )[0]);
  return Object.freeze({
    phase: "base" as const,
    source,
    destination,
    oldToken: canonicalAddress(String(config[0])),
    arcToken: "",
    tokenId: candidate.tokenId.toLowerCase(),
    tokenDecimals: Number(BigInt(config[1])),
    tokenTwapValue: BigInt(config[2]),
    tokenMultiplier: BigInt(config[3]),
    multiplierScale,
    proxyCodeHash: keccak256(code),
  });
}

function surfaceRequests(
  evidence: Extract<ArcanaIdentityEvidence, { phase: "base" }>,
): readonly AdapterRequest[] {
  return Object.freeze([
    callRequest("identity-arc-token", evidence.destination,
      ARCANA_DESTINATION_INTERFACE.encodeFunctionData("arc")),
  ]);
}

function decodeSurface(
  base: Extract<ArcanaIdentityEvidence, { phase: "base" }>,
  results: readonly AdapterRequestResult[],
): ArcanaIdentityEvidence {
  const arcToken = canonicalAddress(String(ARCANA_DESTINATION_INTERFACE.decodeFunctionResult(
    "arc",
    successfulResult(results, "identity-arc-token").data,
  )[0]));
  if (arcToken.toLowerCase() === base.oldToken.toLowerCase()) {
    throw new Error("arcana old and new token are identical");
  }
  return Object.freeze({ ...base, arcToken });
}

function decodeActive(
  evidence: ArcanaIdentityEvidence,
  results: readonly AdapterRequestResult[],
): ArcanaIdentityEvidence {
  if (evidence.phase !== "base") return evidence;
  let behaviorValid = false;
  let proofHash = hashCanonical({ source: lowerAddress(evidence.source), tokenId: evidence.tokenId });
  try {
    const result = successfulResult(results, "identity-preview-arc");
    const amountOut = BigInt(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
      "previewArcAmount",
      result.data,
    )[0]);
    const expected = arcAmount({
      amount: ARCANA_SAMPLE_AMOUNT,
      tokenDecimals: evidence.tokenDecimals,
      tokenTwapValue: evidence.tokenTwapValue,
      tokenMultiplier: evidence.tokenMultiplier,
      multiplierScale: evidence.multiplierScale,
    });
    behaviorValid = amountOut > 0n && amountOut === expected;
    proofHash = hashCanonical({
      source: lowerAddress(evidence.source),
      tokenId: evidence.tokenId,
      amountOut: amountOut.toString(),
    });
  } catch {
    behaviorValid = false;
  }
  return Object.freeze({ ...evidence, phase: "active" as const, behaviorValid, behaviorProofHash: proofHash });
}

function descriptorFromEvidence(evidence: ArcanaIdentityEvidence) {
  return Object.freeze({
    familyId: FAMILY,
    lineageId: LINEAGE,
    instanceKey: evidence.source as never,
    provenance: [],
    runtimeRequirements: [],
    source: evidence.source,
    destination: evidence.destination,
    oldToken: evidence.oldToken,
    arcToken: evidence.arcToken,
    tokenId: evidence.tokenId,
    tokenDecimals: evidence.tokenDecimals,
    tokenTwapValue: evidence.tokenTwapValue,
    tokenMultiplier: evidence.tokenMultiplier,
    multiplierScale: evidence.multiplierScale,
    proxyCodeHash: evidence.proxyCodeHash,
  }) as never;
}
