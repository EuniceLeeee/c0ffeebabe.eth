import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { UNIV4_STATE_VIEW_INTERFACE } from "../univ4-abi.js";
import {
  assertPoolKeyIdentity,
  assertSameSource,
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
  poolKeyProjection,
  requireCodeHash,
  requireSuccessfulResult,
  sameAddress,
} from "../univ4-family/codec.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
  UNIV4_FEE_HOOK_CODE_HASH,
  UNIV4_FEE_HOOK_FAMILY_ID,
  UNIV4_FEE_HOOK_LINEAGE_ID,
} from "./manifest.js";
import type {
  FeeHookCandidate,
  FeeHookIdentity,
  FeeHookIdentityEvidence,
} from "./types.js";

const MANAGER_CODE_REQUEST_ID = "manager-code";
const HOOK_CODE_REQUEST_ID = "hook-code";
const SLOT0_REQUEST_ID = "identity-slot0";
const LIQUIDITY_REQUEST_ID = "identity-liquidity";

export const univ4FeeHookIdentity = {
  variants: [{
    id: "fee-hook-poolkey-active-proof",
    kind: "singleton-subinstance",
    lineageId: UNIV4_FEE_HOOK_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["get-code", "eth-call"] }),
    buildRequests(input) {
      if (feeHookEvidence(input.evidence) !== undefined) return [];
      return buildActiveProofRequests(input.candidate);
    },
    decode({ step, results }) {
      if (feeHookEvidence(step.evidence) !== undefined) {
        throw new Error("univ4 fee-hook identity proof has already completed");
      }
      const slot0Result = requireSuccessfulResult(results, SLOT0_REQUEST_ID);
      const liquidityResult = requireSuccessfulResult(
        results,
        LIQUIDITY_REQUEST_ID,
      );
      assertSameSource(slot0Result.source, liquidityResult.source);
      const slot0 = UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
        "getSlot0",
        slot0Result.data,
      );
      const liquidity = UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
        "getLiquidity",
        liquidityResult.data,
      );
      return Object.freeze({
        phase: "fee-hook-active-proof" as const,
        managerCodeHash: requireCodeHash(results, MANAGER_CODE_REQUEST_ID),
        hookCodeHash: requireCodeHash(results, HOOK_CODE_REQUEST_ID),
        sqrtPriceX96: BigInt(slot0[0]),
        liquidity: BigInt(liquidity[0]),
      });
    },
    decide(input) {
      return decideIdentity(
        input as IdentityStepInput<FeeHookCandidate, FeeHookIdentity>,
        feeHookEvidence(input.evidence),
      );
    },
  }],
  identityKey: (identity) => identity.subject,
} satisfies IdentitySemantics<FeeHookCandidate, FeeHookIdentity>;

function buildActiveProofRequests(
  candidate: FeeHookCandidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    Object.freeze({
      id: MANAGER_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: canonicalAddress(candidate.manager),
    }),
    Object.freeze({
      id: HOOK_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: canonicalAddress(UNIV4_FEE_HOOK_ADDRESS),
    }),
    Object.freeze({
      id: SLOT0_REQUEST_ID,
      kind: "eth-call" as const,
      to: canonicalAddress(ADDR.UNISWAP_V4_STATE_VIEW),
      data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
        "getSlot0",
        [candidate.poolId],
      ),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: LIQUIDITY_REQUEST_ID,
      kind: "eth-call" as const,
      to: canonicalAddress(ADDR.UNISWAP_V4_STATE_VIEW),
      data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData(
        "getLiquidity",
        [candidate.poolId],
      ),
      completion: "return-data" as const,
    }),
  ]);
}

function decideIdentity(
  input: IdentityStepInput<FeeHookCandidate, FeeHookIdentity>,
  evidence: FeeHookIdentityEvidence | undefined,
): IdentityDecision<FeeHookIdentity> {
  const candidate = input.candidate;
  if (!sameAddress(candidate.manager, ADDR.UNISWAP_V4_POOL_MANAGER)) {
    return {
      status: "chain-proven-rejected",
      reasonCode: "foreign_pool_manager",
      evidenceRequestIds: [],
    };
  }
  const poolKey = canonicalPoolKey(candidate.poolKey);
  try {
    assertPoolKeyIdentity(candidate.poolId, poolKey);
  } catch {
    return {
      status: "chain-proven-rejected",
      reasonCode: "poolkey_reverse_binding_failed",
      evidenceRequestIds: [],
    };
  }
  // The fee-hook Family owns only the audited tiered dynamic-fee hook. The
  // pool must name exactly that hook and the chain must prove the hook code
  // hash still equals the audited implementation; anything else fails closed
  // (the standard univ4 Family keeps rejecting every nonzero hook).
  if (!sameAddress(poolKey.hooks, UNIV4_FEE_HOOK_ADDRESS)) {
    return {
      status: "chain-proven-rejected",
      reasonCode: "unknown_hook_fail_closed",
      evidenceRequestIds: [],
    };
  }
  if (evidence === undefined) return { status: "continue" };
  if (
    evidence.hookCodeHash.toLowerCase() !==
    UNIV4_FEE_HOOK_CODE_HASH.toLowerCase()
  ) {
    return {
      status: "chain-proven-rejected",
      reasonCode: "hook_code_hash_changed",
      evidenceRequestIds: [HOOK_CODE_REQUEST_ID],
    };
  }
  if (evidence.sqrtPriceX96 === 0n) {
    return {
      status: "chain-proven-rejected",
      reasonCode: "pool_not_initialized",
      evidenceRequestIds: [SLOT0_REQUEST_ID],
    };
  }
  const manager = canonicalAddress(candidate.manager);
  const poolId = canonicalPoolId(candidate.poolId);
  const evidenceHash = hashCanonical({
    manager,
    poolId,
    poolKey: poolKeyProjection(poolKey),
    managerCodeHash: evidence.managerCodeHash,
    hookCodeHash: evidence.hookCodeHash.toLowerCase(),
    sqrtPriceX96: evidence.sqrtPriceX96,
    liquidity: evidence.liquidity,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      subject: manager.toLowerCase() + "\u001f" + poolId,
      familyId: UNIV4_FEE_HOOK_FAMILY_ID,
      lineageId: UNIV4_FEE_HOOK_LINEAGE_ID,
      provenance: Object.freeze([Object.freeze({
        kind: "fee-hook-poolkey-active-proof",
        subject: manager,
        evidenceHash,
      })]),
      facts: Object.freeze({
        poolId,
        poolKey,
        managerBinding: Object.freeze({
          manager,
          stateView: canonicalAddress(ADDR.UNISWAP_V4_STATE_VIEW),
          quoter: canonicalAddress(ADDR.UNISWAP_V4_QUOTER),
          managerCodeHash: evidence.managerCodeHash,
        }),
        hookCodeHash: evidence.hookCodeHash.toLowerCase(),
      }),
    }),
  };
}

function feeHookEvidence(
  evidence: unknown,
): FeeHookIdentityEvidence | undefined {
  return evidence !== null &&
    typeof evidence === "object" &&
    (evidence as { phase?: unknown }).phase === "fee-hook-active-proof"
    ? evidence as FeeHookIdentityEvidence
    : undefined;
}
