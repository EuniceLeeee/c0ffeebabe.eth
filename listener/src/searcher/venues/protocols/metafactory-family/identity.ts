import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
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
  assertSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeDecimals,
  decodeUint,
  returnedResult,
  requireRuntimeCode,
  sameAddress,
} from "../standard-family/common.js";
import {
  METAFACTORY_ERC20_INTERFACE,
  METAFACTORY_DEAD_ADDRESS,
  METAFACTORY_INTERFACE,
  METAFACTORY_NATIVE_ANCHOR_CODE_HASH,
  METAFACTORY_ROBOT_CODE_HASH,
  METAFACTORY_RUNTIME_CODE_HASH,
} from "./codec.js";
import { METAFACTORY_FAMILY_ID, METAFACTORY_LINEAGE_ID } from "./manifest.js";
import type {
  MetafactoryCandidate,
  MetafactoryComposterEvidence,
  MetafactoryIdentity,
  MetafactoryIdentityEvidence,
  MetafactoryTokenEvidence,
} from "./types.js";

const COMPOSTER_REQUESTS = Object.freeze([
  "identity-code",
  "identity-robot",
  "identity-dead",
  "identity-paused",
  "identity-activated",
  "identity-total-allocated",
  "identity-circulating-supply",
  "identity-redemption-end",
] as const);

const TOKEN_REQUESTS = Object.freeze([
  "identity-robot-code",
  "identity-native-anchor-code",
  "identity-robot-decimals",
] as const);

export const metafactoryIdentity = {
  variants: [{
    id: "composter-runtime-and-token-binding",
    kind: "standalone-contract" as const,
    lineageId: METAFACTORY_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({
      transports: ["get-code" as const, "eth-call" as const],
    }),
    buildRequests(
      input: IdentityStepInput<MetafactoryCandidate, unknown>,
    ): readonly AdapterRequest[] {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return composterRequests(input.candidate);
      if (evidence.phase !== "composter" || !evidence.valid) return [];
      return Object.freeze([
        codeRequest("identity-robot-code", evidence.robotToken),
        codeRequest("identity-native-anchor-code", canonicalAddress(ADDR.WETH)),
        callRequest(
          "identity-robot-decimals",
          evidence.robotToken,
          METAFACTORY_ERC20_INTERFACE.encodeFunctionData("decimals"),
        ),
      ]);
    },
    decode(input: {
      readonly step: IdentityStepInput<MetafactoryCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): MetafactoryIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeComposter(input.step.candidate, input.results);
      }
      return prior.phase === "tokens"
        ? prior
        : decodeTokens(prior, input.results);
    },
    decide(input: IdentityStepInput<MetafactoryCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (!proof.valid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: proof.phase === "composter"
            ? "metafactory-runtime-binding-mismatch"
            : "metafactory-token-binding-mismatch",
          evidenceRequestIds: proof.phase === "composter"
            ? [...COMPOSTER_REQUESTS]
            : [...TOKEN_REQUESTS],
        };
      }
      // paused/redemptionActivated/capacity are mutable protocol state, never a
      // permanent instance verdict.
      if (
        proof.phase === "composter" &&
        (!proof.activated || proof.paused ||
          proof.totalEthAllocated === 0n || proof.circulatingSupply === 0n)
      ) {
        return {
          status: "retryable" as const,
          reasonCode: "metafactory-redemption-inactive",
        };
      }
      if (proof.phase !== "tokens") return { status: "continue" as const };
      if (proof.oneToken <= 0n) {
        return {
          status: "retryable" as const,
          reasonCode: "metafactory-robot-decimals-unusable",
        };
      }
      const subject = canonicalAddress(input.candidate.target);
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: METAFACTORY_FAMILY_ID,
          lineageId: METAFACTORY_LINEAGE_ID,
          subject,
          provenance: Object.freeze([Object.freeze({
            kind: "metafactory-composter-runtime-proof",
            subject,
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              robotToken: proof.robotToken.toLowerCase(),
              nativeAnchor: canonicalAddress(ADDR.WETH).toLowerCase(),
              deadAddress: proof.deadAddress.toLowerCase(),
              oneToken: proof.oneToken,
              robotCodeHash: proof.robotCodeHash.toLowerCase(),
              nativeAnchorCodeHash: proof.nativeAnchorCodeHash.toLowerCase(),
              payoutSemantics: "compost-pro-rata-native-eth-to-caller-v1",
            }),
          })]),
          tokenIn: proof.robotToken,
          nativeAnchor: canonicalAddress(ADDR.WETH),
          deadAddress: proof.deadAddress,
          oneToken: proof.oneToken,
          codeHash: proof.codeHash,
        }) satisfies MetafactoryIdentity,
      };
    },
  }],
  identityKey: (identity: MetafactoryIdentity) => identity.subject.toLowerCase(),
} satisfies IdentitySemantics<MetafactoryCandidate, MetafactoryIdentity>;

function composterRequests(
  candidate: MetafactoryCandidate,
): readonly AdapterRequest[] {
  const target = canonicalAddress(candidate.target);
  return Object.freeze([
    codeRequest("identity-code", target),
    callRequest("identity-robot", target,
      METAFACTORY_INTERFACE.encodeFunctionData("robotToken")),
    callRequest("identity-dead", target,
      METAFACTORY_INTERFACE.encodeFunctionData("DEAD_ADDRESS")),
    callRequest("identity-paused", target,
      METAFACTORY_INTERFACE.encodeFunctionData("paused")),
    callRequest("identity-activated", target,
      METAFACTORY_INTERFACE.encodeFunctionData("redemptionActivated")),
    callRequest("identity-total-allocated", target,
      METAFACTORY_INTERFACE.encodeFunctionData("totalEthAllocated")),
    callRequest("identity-circulating-supply", target,
      METAFACTORY_INTERFACE.encodeFunctionData("circulatingSupply")),
    callRequest("identity-redemption-end", target,
      METAFACTORY_INTERFACE.encodeFunctionData("redemptionEndTime")),
  ]);
}

function decodeComposter(
  candidate: MetafactoryCandidate,
  results: readonly AdapterRequestResult[],
): MetafactoryComposterEvidence {
  const successful = COMPOSTER_REQUESTS.map((id) => returnedResult(results, id));
  const source = assertSameSource(successful);
  const code = requireRuntimeCode(results, "identity-code");
  const codeHash = ethers.keccak256(code).toLowerCase();
  const robotToken = decodeAddress(
    METAFACTORY_INTERFACE, "robotToken", results, "identity-robot");
  const deadAddress = decodeAddress(
    METAFACTORY_INTERFACE, "DEAD_ADDRESS", results, "identity-dead");
  const paused = booleanResult(results, "identity-paused", "paused");
  const activated = booleanResult(
    results, "identity-activated", "redemptionActivated");
  const totalEthAllocated = decodeUint(
    METAFACTORY_INTERFACE, "totalEthAllocated", results,
    "identity-total-allocated");
  const circulatingSupply = decodeUint(
    METAFACTORY_INTERFACE, "circulatingSupply", results,
    "identity-circulating-supply");
  const redemptionEndTime = decodeUint(
    METAFACTORY_INTERFACE, "redemptionEndTime", results,
    "identity-redemption-end");
  return Object.freeze({
    phase: "composter",
    target: canonicalAddress(candidate.target),
    robotToken,
    deadAddress,
    paused,
    activated,
    totalEthAllocated,
    circulatingSupply,
    redemptionEndTime,
    codeHash,
    // Structural identity only. Live activation/pause/capacity are decided
    // separately so a paused composter stays retryable.
    valid: codeHash === METAFACTORY_RUNTIME_CODE_HASH &&
      sameAddress(deadAddress, METAFACTORY_DEAD_ADDRESS) &&
      !sameAddress(robotToken, candidate.target) &&
      !sameAddress(robotToken, ethers.ZeroAddress) &&
      !sameAddress(robotToken, ADDR.WETH),
    source,
  });
}

function decodeTokens(
  prior: MetafactoryComposterEvidence,
  results: readonly AdapterRequestResult[],
): MetafactoryTokenEvidence {
  const successful = TOKEN_REQUESTS.map((id) => returnedResult(results, id));
  const source = assertSameSource(successful);
  assertSource(source, prior.source);
  const robotCode = requireRuntimeCode(results, "identity-robot-code");
  const nativeAnchorCode = requireRuntimeCode(
    results, "identity-native-anchor-code");
  const robotCodeHash = ethers.keccak256(robotCode).toLowerCase();
  const nativeAnchorCodeHash = ethers.keccak256(nativeAnchorCode).toLowerCase();
  const oneToken = decodeDecimals(
    METAFACTORY_ERC20_INTERFACE, results, "identity-robot-decimals");
  return Object.freeze({
    ...prior,
    phase: "tokens" as const,
    oneToken,
    robotCodeHash,
    nativeAnchorCodeHash,
    valid: prior.valid &&
      robotCodeHash === METAFACTORY_ROBOT_CODE_HASH &&
      nativeAnchorCodeHash === METAFACTORY_NATIVE_ANCHOR_CODE_HASH,
  });
}

function booleanResult(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: "paused" | "redemptionActivated",
): boolean {
  const value = METAFACTORY_INTERFACE.decodeFunctionResult(
    functionName,
    returnedResult(results, id).data,
  )[0];
  if (typeof value !== "boolean") {
    throw new Error(`metafactory ${id} did not return a boolean`);
  }
  return value;
}

function identityEvidence(
  value: unknown,
): MetafactoryIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("metafactory identity evidence is malformed");
  }
  return value as MetafactoryIdentityEvidence;
}
