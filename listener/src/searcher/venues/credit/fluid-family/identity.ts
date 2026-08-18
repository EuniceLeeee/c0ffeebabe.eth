import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  canonicalAddress,
  decodeFactoryVault,
  decodeFluidVaultConstants,
  decodeOperateResult,
  FLUID_CREDIT_PROBE_ACTOR,
  FLUID_ERC20_INTERFACE,
  FLUID_VAULT_FACTORY_INTERFACE,
  FLUID_VAULT_INTERFACE,
  lowerAddress,
  requireSuccessfulResult,
  sameAddress,
  tokenDelta,
} from "./codec.js";
import {
  FLUID_CREDIT_FACTORY_LINEAGE_ID,
  FLUID_CREDIT_FAMILY_ID,
} from "./manifest.js";
import type {
  FluidCreditCandidate,
  FluidCreditIdentity,
  FluidCreditIdentityEvidence,
} from "./types.js";

export const FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID = "fluid-credit-probe-actor";

const CONSTANTS_ID = "vault-constants";
const VAULT_CODE_ID = "vault-code";
const FACTORY_REVERSE_ID = "factory-reverse-vault";
const SUPPLY_CODE_ID = "supply-token-code";
const BORROW_CODE_ID = "borrow-token-code";
const ACTIVE_OPERATE_ID = "active-operate-effect-proof";

export const fluidCreditIdentity = {
  variants: [{
    id: "factory-child-active-operate",
    kind: "factory-child" as const,
    lineageId: FLUID_CREDIT_FACTORY_LINEAGE_ID,
    applies: () => true,
    requirements(input: IdentityStepInput<FluidCreditCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      return evidence?.phase === "reverse-binding"
        ? {
            transports: ["effect-delta-simulation" as const],
            caller: "verified-actor" as const,
            effects: ["return-data" as const, "token-delta" as const],
          }
        : { transports: ["eth-call" as const, "get-code" as const] };
    },
    buildRequests(input: IdentityStepInput<FluidCreditCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return constantsRequests(input.candidate);
      if (evidence.phase === "constants") return reverseRequests(evidence);
      if (evidence.phase === "reverse-binding") {
        return activeOperateRequests(evidence);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<FluidCreditCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }) {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeConstants(input.step.candidate, input.results);
      }
      if (prior.phase === "constants") {
        return decodeReverseBinding(prior, input.results);
      }
      return decodeActiveBehavior(prior, input.results);
    },
    decide(input: IdentityStepInput<FluidCreditCandidate, unknown>) {
      return decideIdentity(identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<FluidCreditCandidate, FluidCreditIdentity>;

function constantsRequests(
  candidate: FluidCreditCandidate,
): readonly AdapterRequest[] {
  const vault = canonicalAddress(candidate.vault);
  return Object.freeze([
    Object.freeze({
      id: CONSTANTS_ID,
      kind: "eth-call" as const,
      to: vault,
      data: FLUID_VAULT_INTERFACE.encodeFunctionData("constantsView"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: VAULT_CODE_ID,
      kind: "get-code" as const,
      address: vault,
    }),
  ]);
}

function reverseRequests(
  evidence: Extract<FluidCreditIdentityEvidence, { readonly phase: "constants" }>,
): readonly AdapterRequest[] {
  return Object.freeze([
    Object.freeze({
      id: FACTORY_REVERSE_ID,
      kind: "eth-call" as const,
      to: evidence.factory,
      data: FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionData(
        "getVaultAddress",
        [evidence.vaultId],
      ),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: SUPPLY_CODE_ID,
      kind: "get-code" as const,
      address: evidence.supplyToken,
    }),
    Object.freeze({
      id: BORROW_CODE_ID,
      kind: "get-code" as const,
      address: evidence.borrowToken,
    }),
  ]);
}

function activeOperateRequests(
  evidence: Extract<
    FluidCreditIdentityEvidence,
    { readonly phase: "reverse-binding" }
  >,
): readonly AdapterRequest[] {
  const constants = evidence.constants;
  const collateralAmount = 1_000n * 10n ** BigInt(constants.supplyDecimals);
  const debtAmount = 10n ** BigInt(constants.borrowDecimals);
  return Object.freeze([Object.freeze({
    id: ACTIVE_OPERATE_ID,
    kind: "effect-delta-simulation" as const,
    preCalls: Object.freeze([Object.freeze({
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID,
      }),
      to: constants.supplyToken,
      data: FLUID_ERC20_INTERFACE.encodeFunctionData("approve", [
        constants.vault,
        collateralAmount,
      ]),
    })]),
    call: Object.freeze({
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID,
      }),
      to: constants.vault,
      data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [
        0n,
        collateralAmount,
        debtAmount,
        FLUID_CREDIT_PROBE_ACTOR,
      ]),
    }),
    overrideIntent: Object.freeze({
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID,
      }),
      tokenBalances: Object.freeze([Object.freeze({
        token: constants.supplyToken,
        amount: collateralAmount,
      })]),
    }),
    observe: Object.freeze(["return-data" as const, "token-delta" as const]),
  })]);
}

function decodeConstants(
  candidate: FluidCreditCandidate,
  results: readonly AdapterRequestResult[],
): FluidCreditIdentityEvidence {
  const constantsResult = requireSuccessfulResult(results, CONSTANTS_ID);
  const codeResult = requireSuccessfulResult(results, VAULT_CODE_ID);
  return Object.freeze({
    phase: "constants" as const,
    vault: canonicalAddress(candidate.vault),
    ...decodeFluidVaultConstants(constantsResult.data),
    vaultHasCode: codeResult.data !== "0x",
  });
}

function decodeReverseBinding(
  prior: Extract<FluidCreditIdentityEvidence, { readonly phase: "constants" }>,
  results: readonly AdapterRequestResult[],
): FluidCreditIdentityEvidence {
  const reverse = requireSuccessfulResult(results, FACTORY_REVERSE_ID);
  const supplyCode = requireSuccessfulResult(results, SUPPLY_CODE_ID);
  const borrowCode = requireSuccessfulResult(results, BORROW_CODE_ID);
  return Object.freeze({
    phase: "reverse-binding" as const,
    constants: prior,
    reverseVault: decodeFactoryVault(reverse.data),
    supplyTokenHasCode: supplyCode.data !== "0x",
    borrowTokenHasCode: borrowCode.data !== "0x",
  });
}

function decodeActiveBehavior(
  prior: FluidCreditIdentityEvidence,
  results: readonly AdapterRequestResult[],
): FluidCreditIdentityEvidence {
  if (prior.phase !== "reverse-binding") {
    throw new Error("fluid-credit active behavior proof already completed");
  }
  const result = requireSuccessfulResult(results, ACTIVE_OPERATE_ID);
  const constants = prior.constants;
  const collateralAmount = 1_000n * 10n ** BigInt(constants.supplyDecimals);
  const debtAmount = 10n ** BigInt(constants.borrowDecimals);
  const operate = decodeOperateResult(result.data);
  const collateralDelta = tokenDelta(
    result,
    constants.supplyToken,
    FLUID_CREDIT_PROBE_ACTOR,
  );
  const debtDelta = tokenDelta(
    result,
    constants.borrowToken,
    FLUID_CREDIT_PROBE_ACTOR,
  );
  return Object.freeze({
    phase: "active-behavior" as const,
    binding: prior,
    actor: FLUID_CREDIT_PROBE_ACTOR,
    collateralAmount,
    debtAmount,
    active: operate.nftId > 0n &&
      operate.finalSupply > 0n &&
      operate.finalBorrow > 0n &&
      collateralDelta === -collateralAmount &&
      debtDelta === debtAmount,
  });
}

function decideIdentity(
  evidence: FluidCreditIdentityEvidence | undefined,
): IdentityDecision<FluidCreditIdentity> {
  if (evidence === undefined) return { status: "continue" };
  if (evidence.phase === "constants") {
    return evidence.vaultHasCode
      ? { status: "continue" }
      : {
          status: "chain-proven-rejected",
          reasonCode: "vault_has_no_code",
          evidenceRequestIds: [VAULT_CODE_ID],
        };
  }
  if (evidence.phase === "reverse-binding") {
    if (!sameAddress(evidence.reverseVault, evidence.constants.vault)) {
      return {
        status: "chain-proven-rejected",
        reasonCode: "factory_reverse_binding_failed",
        evidenceRequestIds: [FACTORY_REVERSE_ID],
      };
    }
    if (!evidence.supplyTokenHasCode || !evidence.borrowTokenHasCode) {
      return {
        status: "chain-proven-rejected",
        reasonCode: "credit_token_code_binding_failed",
        evidenceRequestIds: [SUPPLY_CODE_ID, BORROW_CODE_ID],
      };
    }
    return { status: "continue" };
  }
  if (!evidence.active) {
    return {
      status: "chain-proven-rejected",
      reasonCode: "nonzero_operate_effect_proof_failed",
      evidenceRequestIds: [ACTIVE_OPERATE_ID],
    };
  }
  const constants = evidence.binding.constants;
  const factoryBinding = Object.freeze({
    factory: constants.factory,
    vaultId: constants.vaultId,
    reverseVault: evidence.binding.reverseVault,
  });
  const evidenceHash = hashCanonical({
    vault: constants.vault,
    supplyToken: constants.supplyToken,
    borrowToken: constants.borrowToken,
    supplyDecimals: constants.supplyDecimals,
    borrowDecimals: constants.borrowDecimals,
    factoryBinding,
    activeProbe: {
      actor: evidence.actor,
      collateralAmount: evidence.collateralAmount,
      debtAmount: evidence.debtAmount,
    },
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: FLUID_CREDIT_FAMILY_ID,
      lineageId: FLUID_CREDIT_FACTORY_LINEAGE_ID,
      subject: constants.vault,
      provenance: Object.freeze([Object.freeze({
        kind: "fluid-vault-factory-reverse-active-operate",
        subject: constants.factory,
        evidenceHash,
      })]),
      facts: Object.freeze({
        vault: constants.vault,
        supplyToken: constants.supplyToken,
        borrowToken: constants.borrowToken,
        supplyDecimals: constants.supplyDecimals,
        borrowDecimals: constants.borrowDecimals,
        factoryBinding,
        activeProbeActor: evidence.actor,
      }),
    }),
  };
}

function identityEvidence(value: unknown): FluidCreditIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    !new Set(["constants", "reverse-binding", "active-behavior"]).has(
      String((value as { readonly phase?: unknown }).phase),
    )
  ) {
    throw new Error("fluid-credit identity received malformed evidence");
  }
  return value as FluidCreditIdentityEvidence;
}
