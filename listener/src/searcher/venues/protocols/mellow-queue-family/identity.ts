import { keccak256 } from "ethers";
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
  lowerAddress,
  requireRuntimeCode,
  successfulResult,
} from "../standard-family/common.js";
import { MELLOW_QUEUE_INTERFACE, MELLOW_VAULT_INTERFACE } from "./abi.js";
import {
  MELLOW_QUEUE_PROBE_ACTOR,
  mellowDepositSimulation,
  mellowRedeemSimulation,
  validateMellowDeposit,
  validateMellowRedeem,
} from "./shared.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type {
  MellowQueueCandidate,
  MellowQueueIdentity,
  MellowQueueIdentityEvidence,
  MellowQueueKind,
} from "./types.js";

const DEPOSIT_SAMPLE = 1_000_000n;
const REDEEM_SAMPLE = 1_000_000_000_000_000_000n;

export const mellowQueueIdentity = {
  variants: [{
    id: "mellow-queue-oracle-binding",
    kind: "custom" as const,
    lineageId: LINEAGE,
    applies: () => true,
    requirements(input: IdentityStepInput<MellowQueueCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      if (evidence.share === "") {
        return { transports: ["eth-call" as const] };
      }
      return {
        transports: ["effect-delta-simulation" as const],
        caller: "verified-actor" as const,
        effects: [
          "return-data" as const,
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ],
      };
    },
    buildRequests(input: IdentityStepInput<MellowQueueCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return baseRequests(input.candidate);
      if (evidence.phase !== "base") return [];
      if (evidence.share === "") return surfaceRequests(evidence);
      return simulationRequests(evidence);
    },
    decode(input: {
      readonly step: IdentityStepInput<MellowQueueCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): MellowQueueIdentityEvidence {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) return decodeBase(input.step.candidate, input.results);
      if (prior.phase === "base" && prior.share === "") return decodeSurface(prior, input.results);
      return decodeActive(prior, input.results);
    },
    decide(input: IdentityStepInput<MellowQueueCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined || proof.share === "") return { status: "continue" as const };
      if (proof.phase !== "active") return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "mellow_queue_behavior_failed",
          evidenceRequestIds: ["identity-active-deposit", "identity-active-redeem"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: FAMILY,
          lineageId: LINEAGE,
          subject: canonicalAddress(proof.queue),
          provenance: Object.freeze([Object.freeze({
            kind: "mellow-queue-oracle-binding",
            subject: canonicalAddress(proof.queue),
            evidenceHash: proof.behaviorProofHash,
          })]),
          queue: proof.queue,
          vault: proof.vault,
          asset: proof.asset,
          share: proof.share,
          oracle: proof.oracle,
          feeManager: proof.feeManager,
          kind: proof.kind,
          penaltyD6: proof.penaltyD6,
          maxAge: proof.maxAge,
          proxyCodeHash: proof.proxyCodeHash,
          implementation: proof.implementation,
          implementationCodeHash: proof.implementationCodeHash,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.queue),
} satisfies IdentitySemantics<MellowQueueCandidate, MellowQueueIdentity>;

function identityEvidence(value: unknown): MellowQueueIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("mellow queue identity evidence is malformed");
  }
  return value as MellowQueueIdentityEvidence;
}

function baseRequests(candidate: MellowQueueCandidate): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("identity-queue-code", candidate.queue),
    callRequest("identity-queue-name", candidate.queue,
      MELLOW_QUEUE_INTERFACE.encodeFunctionData("name")),
    callRequest("identity-queue-vault", candidate.queue,
      MELLOW_QUEUE_INTERFACE.encodeFunctionData("vault")),
    callRequest("identity-queue-asset", candidate.queue,
      MELLOW_QUEUE_INTERFACE.encodeFunctionData("asset")),
  ]);
}

function surfaceRequests(
  evidence: Extract<MellowQueueIdentityEvidence, { phase: "base" }>,
): readonly AdapterRequest[] {
  const params = evidence.kind === "deposit"
    ? MELLOW_QUEUE_INTERFACE.encodeFunctionData("syncDepositParams")
    : MELLOW_QUEUE_INTERFACE.encodeFunctionData("syncRedeemParams");
  return Object.freeze([
    callRequest("identity-vault-has-queue", evidence.vault,
      MELLOW_VAULT_INTERFACE.encodeFunctionData("hasQueue", [evidence.queue])),
    callRequest("identity-vault-share", evidence.vault,
      MELLOW_VAULT_INTERFACE.encodeFunctionData("shareManager")),
    callRequest("identity-vault-oracle", evidence.vault,
      MELLOW_VAULT_INTERFACE.encodeFunctionData("oracle")),
    callRequest("identity-vault-fee", evidence.vault,
      MELLOW_VAULT_INTERFACE.encodeFunctionData("feeManager")),
    callRequest(
      evidence.kind === "deposit" ? "identity-deposit-params" : "identity-redeem-params",
      evidence.queue,
      params,
    ),
  ]);
}

function simulationRequests(
  evidence: Extract<MellowQueueIdentityEvidence, { phase: "base" }>,
): readonly AdapterRequest[] {
  const descriptor = descriptorFromEvidence(evidence);
  return Object.freeze([
    evidence.kind === "deposit"
      ? mellowDepositSimulation({
          id: "identity-active-deposit",
          descriptor,
          amountIn: DEPOSIT_SAMPLE,
          receiver: MELLOW_QUEUE_PROBE_ACTOR,
        })
      : mellowRedeemSimulation({
          id: "identity-active-redeem",
          descriptor,
          sharesIn: REDEEM_SAMPLE,
          receiver: MELLOW_QUEUE_PROBE_ACTOR,
        }),
  ]);
}

function decodeBase(
  candidate: MellowQueueCandidate,
  results: readonly AdapterRequestResult[],
): MellowQueueIdentityEvidence {
  const code = requireRuntimeCode(results, "identity-queue-code");
  const queue = canonicalAddress(candidate.queue);
  const name = String(MELLOW_QUEUE_INTERFACE.decodeFunctionResult(
    "name",
    successfulResult(results, "identity-queue-name").data,
  )[0]);
  const kind: MellowQueueKind =
    name === "SyncDepositQueue" ? "deposit"
      : name === "SyncRedeemQueue" ? "redeem"
        : candidate.kind;
  const vault = canonicalAddress(String(MELLOW_QUEUE_INTERFACE.decodeFunctionResult(
    "vault",
    successfulResult(results, "identity-queue-vault").data,
  )[0]));
  const asset = canonicalAddress(String(MELLOW_QUEUE_INTERFACE.decodeFunctionResult(
    "asset",
    successfulResult(results, "identity-queue-asset").data,
  )[0]));
  const proxyCodeHash = keccak256(code);
  return Object.freeze({
    phase: "base" as const,
    queue,
    vault,
    asset,
    share: "",
    oracle: "",
    feeManager: "",
    kind,
    penaltyD6: 0n,
    maxAge: 0,
    proxyCodeHash,
    implementation: queue,
    implementationCodeHash: proxyCodeHash,
  });
}

function decodeSurface(
  base: Extract<MellowQueueIdentityEvidence, { phase: "base" }>,
  results: readonly AdapterRequestResult[],
): MellowQueueIdentityEvidence {
  if (base.queue === "" || base.vault === "" || base.asset === "") return base;
  const hasQueue = Boolean(MELLOW_VAULT_INTERFACE.decodeFunctionResult(
    "hasQueue",
    successfulResult(results, "identity-vault-has-queue").data,
  )[0]);
  const share = canonicalAddress(String(MELLOW_VAULT_INTERFACE.decodeFunctionResult(
    "shareManager",
    successfulResult(results, "identity-vault-share").data,
  )[0]));
  const oracle = canonicalAddress(String(MELLOW_VAULT_INTERFACE.decodeFunctionResult(
    "oracle",
    successfulResult(results, "identity-vault-oracle").data,
  )[0]));
  const feeManager = canonicalAddress(String(MELLOW_VAULT_INTERFACE.decodeFunctionResult(
    "feeManager",
    successfulResult(results, "identity-vault-fee").data,
  )[0]));
  if (!hasQueue) throw new Error("mellow queue is not admitted by its vault");
  const paramsId = base.kind === "deposit" ? "identity-deposit-params" : "identity-redeem-params";
  const params = successfulResult(results, paramsId);
  const decoded = base.kind === "deposit"
    ? MELLOW_QUEUE_INTERFACE.decodeFunctionResult("syncDepositParams", params.data)
    : MELLOW_QUEUE_INTERFACE.decodeFunctionResult("syncRedeemParams", params.data);
  const penaltyD6 = BigInt(decoded[0]);
  const maxAge = Number(BigInt(decoded[1]));
  return Object.freeze({
    ...base,
    share,
    oracle,
    feeManager,
    penaltyD6,
    maxAge,
  });
}

function decodeActive(
  base: MellowQueueIdentityEvidence,
  results: readonly AdapterRequestResult[],
): MellowQueueIdentityEvidence {
  if (base.phase !== "base") return base;
  let behaviorValid = false;
  let proofHash = hashCanonical({ queue: lowerAddress(base.queue), kind: base.kind });
  try {
    const id = base.kind === "deposit" ? "identity-active-deposit" : "identity-active-redeem";
    const result = successfulResult(results, id);
    const checked = base.kind === "deposit"
      ? validateMellowDeposit({ result, descriptor: descriptorFromEvidence(base), amountIn: DEPOSIT_SAMPLE })
      : validateMellowRedeem({ result, descriptor: descriptorFromEvidence(base), sharesIn: REDEEM_SAMPLE });
    behaviorValid = Object.values(checked)[0] !== 0n;
    proofHash = hashCanonical({
      queue: lowerAddress(base.queue),
      kind: base.kind,
      result: Object.values(checked)[0].toString(),
    });
  } catch (error) {
    behaviorValid = false;
  }
  return Object.freeze({ ...base, phase: "active" as const, behaviorValid, behaviorProofHash: proofHash });
}

function descriptorFromEvidence(evidence: MellowQueueIdentityEvidence) {
  return Object.freeze({
    familyId: FAMILY,
    lineageId: LINEAGE,
    instanceKey: evidence.queue as never,
    provenance: [],
    runtimeRequirements: [],
    queue: evidence.queue,
    vault: evidence.vault,
    asset: evidence.asset,
    share: evidence.share,
    oracle: evidence.oracle,
    feeManager: evidence.feeManager,
    kind: evidence.kind,
    penaltyD6: evidence.penaltyD6,
    maxAge: evidence.maxAge,
    proxyCodeHash: evidence.proxyCodeHash,
    implementation: evidence.implementation,
    implementationCodeHash: evidence.implementationCodeHash,
  }) as never;
}
