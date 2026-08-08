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
} from "./codec.js";
import {
  UNIV4_FAMILY_ID,
  UNIV4_MANAGER_LINEAGE_ID,
} from "./manifest.js";
import type {
  UniV4Candidate,
  UniV4Identity,
  UniV4IdentityEvidence,
} from "./types.js";

const MANAGER_CODE_REQUEST_ID = "manager-code";
const SLOT0_REQUEST_ID = "identity-slot0";
const LIQUIDITY_REQUEST_ID = "identity-liquidity";

export const univ4Identity = {
  variants: [{
    id: "singleton-poolkey-active-proof",
    kind: "singleton-subinstance",
    lineageId: UNIV4_MANAGER_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["get-code", "eth-call"] }),
    buildRequests(input) {
      if (identityEvidence(input.evidence) !== undefined) return [];
      return buildActiveProofRequests(input.candidate);
    },
    decode({ step, results }) {
      if (identityEvidence(step.evidence) !== undefined) {
        throw new Error("univ4 identity proof has already completed");
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
        phase: "manager-active-proof" as const,
        managerCodeHash: requireCodeHash(results, MANAGER_CODE_REQUEST_ID),
        sqrtPriceX96: BigInt(slot0[0]),
        liquidity: BigInt(liquidity[0]),
      });
    },
    decide(input) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => identity.subject,
} satisfies IdentitySemantics<UniV4Candidate, UniV4Identity>;

function buildActiveProofRequests(
  candidate: UniV4Candidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    Object.freeze({
      id: MANAGER_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: canonicalAddress(candidate.manager),
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
  input: IdentityStepInput<UniV4Candidate, unknown>,
  evidence: UniV4IdentityEvidence | undefined,
): IdentityDecision<UniV4Identity> {
  const candidate = input.candidate;
  if (!sameAddress(candidate.manager, ADDR.UNISWAP_V4_POOL_MANAGER)) {
    return { status: "rejected", reason: "foreign_pool_manager" };
  }
  const poolKey = canonicalPoolKey(candidate.poolKey);
  try {
    assertPoolKeyIdentity(candidate.poolId, poolKey);
  } catch {
    return { status: "rejected", reason: "poolkey_reverse_binding_failed" };
  }
  // The standard Family owns only the hook-free execution semantics. Any
  // nonzero hook is a separate behavior Family until explicitly proven.
  if (!sameAddress(poolKey.hooks, ethers.ZeroAddress)) {
    return { status: "rejected", reason: "unknown_hook_fail_closed" };
  }
  if (evidence === undefined) return { status: "continue" };
  if (evidence.sqrtPriceX96 === 0n) {
    return { status: "rejected", reason: "pool_not_initialized" };
  }
  const manager = canonicalAddress(candidate.manager);
  const poolId = canonicalPoolId(candidate.poolId);
  const evidenceHash = hashCanonical({
    manager,
    poolId,
    poolKey: poolKeyProjection(poolKey),
    managerCodeHash: evidence.managerCodeHash,
    sqrtPriceX96: evidence.sqrtPriceX96,
    liquidity: evidence.liquidity,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: UNIV4_FAMILY_ID,
      lineageId: UNIV4_MANAGER_LINEAGE_ID,
      subject: `${manager.toLowerCase()}\u001f${poolId}`,
      provenance: Object.freeze([Object.freeze({
        kind: "singleton-poolkey-active-proof",
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
      }),
    }),
  };
}

function identityEvidence(value: unknown): UniV4IdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly phase?: unknown }).phase !== "manager-active-proof"
  ) {
    throw new Error("univ4 identity received malformed prior evidence");
  }
  return value as UniV4IdentityEvidence;
}
