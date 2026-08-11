import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
} from "../angstrom-attestation.js";
import {
  ANGSTROM_CONTROLLER_INTERFACE,
  ANGSTROM_HOOK_STATE_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
} from "../univ4-abi.js";
import {
  assertPoolKeyIdentity,
  assertSameSource,
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
  decodeStorageAddress,
  poolKeyProjection,
  requireCodeHash,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import {
  ANGSTROM_V4_FAMILY_ID,
  ANGSTROM_V4_LINEAGE_ID,
} from "./manifest.js";
import type {
  AngstromV4Candidate,
  AngstromV4Identity,
  AngstromV4IdentityEvidence,
} from "./types.js";

const MANAGER_CODE_REQUEST_ID = "manager-code";
const ADAPTER_CODE_REQUEST_ID = "adapter-code";
const HOOK_CODE_REQUEST_ID = "hook-code";
const SLOT0_REQUEST_ID = "identity-slot0";
const LIQUIDITY_REQUEST_ID = "identity-liquidity";
const CONTROLLER_SLOT_REQUEST_ID = "hook-controller-slot";
const CONTROLLER_REVERSE_REQUEST_ID = "controller-canonical-hook";

export const angstromV4Identity = {
  variants: [{
    id: "official-hook-poolkey-active-proof",
    kind: "singleton-subinstance",
    lineageId: ANGSTROM_V4_LINEAGE_ID,
    applies: () => true,
    requirements(input) {
      return identityEvidence(input.evidence) === undefined
        ? { transports: ["get-code", "eth-call"] }
        : { transports: ["eth-call"] };
    },
    buildRequests(input) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return buildStaticProofRequests(input.candidate);
      if (evidence.phase === "pool-hook-static") {
        return [Object.freeze({
          id: CONTROLLER_REVERSE_REQUEST_ID,
          kind: "eth-call" as const,
          to: evidence.controller,
          data: ANGSTROM_CONTROLLER_INTERFACE.encodeFunctionData("ANGSTROM"),
          completion: "return-data" as const,
        })];
      }
      return [];
    },
    decode({ step, results }) {
      const prior = identityEvidence(step.evidence);
      if (prior === undefined) return decodeStaticProof(results);
      if (prior.phase !== "pool-hook-static") {
        throw new Error("angstrom-v4 identity proof has already completed");
      }
      const reverse = requireSuccessfulResult(
        results,
        CONTROLLER_REVERSE_REQUEST_ID,
      );
      const canonicalHook = canonicalAddress(String(
        ANGSTROM_CONTROLLER_INTERFACE.decodeFunctionResult(
          "ANGSTROM",
          reverse.data,
        )[0],
      ));
      return Object.freeze({
        ...prior,
        phase: "controller-reverse" as const,
        canonicalHook,
      });
    },
    decide(input) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => identity.subject,
} satisfies IdentitySemantics<AngstromV4Candidate, AngstromV4Identity>;

function buildStaticProofRequests(
  candidate: AngstromV4Candidate,
): readonly AdapterRequest[] {
  return Object.freeze([
    Object.freeze({
      id: MANAGER_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: candidate.manager,
    }),
    Object.freeze({
      id: ADAPTER_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: candidate.adapter,
    }),
    Object.freeze({
      id: HOOK_CODE_REQUEST_ID,
      kind: "get-code" as const,
      address: candidate.poolKey.hooks,
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
    Object.freeze({
      id: CONTROLLER_SLOT_REQUEST_ID,
      kind: "eth-call" as const,
      to: candidate.poolKey.hooks,
      data: ANGSTROM_HOOK_STATE_INTERFACE.encodeFunctionData(
        "extsload",
        [0n],
      ),
      completion: "return-data" as const,
    }),
  ]);
}

function decodeStaticProof(
  results: readonly import("../../adapter-request-program.js").AdapterRequestResult[],
): AngstromV4IdentityEvidence {
  const slot0Result = requireSuccessfulResult(results, SLOT0_REQUEST_ID);
  const liquidityResult = requireSuccessfulResult(results, LIQUIDITY_REQUEST_ID);
  const controllerResult = requireSuccessfulResult(
    results,
    CONTROLLER_SLOT_REQUEST_ID,
  );
  assertSameSource(slot0Result.source, liquidityResult.source);
  assertSameSource(slot0Result.source, controllerResult.source);
  const slot0 = UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
    "getSlot0",
    slot0Result.data,
  );
  const liquidity = UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult(
    "getLiquidity",
    liquidityResult.data,
  );
  const controllerWord = BigInt(
    ANGSTROM_HOOK_STATE_INTERFACE.decodeFunctionResult(
      "extsload",
      controllerResult.data,
    )[0],
  );
  return Object.freeze({
    phase: "pool-hook-static" as const,
    managerCodeHash: requireCodeHash(results, MANAGER_CODE_REQUEST_ID),
    adapterCodeHash: requireCodeHash(results, ADAPTER_CODE_REQUEST_ID),
    hookCodeHash: requireCodeHash(results, HOOK_CODE_REQUEST_ID),
    sqrtPriceX96: BigInt(slot0[0]),
    liquidity: BigInt(liquidity[0]),
    controller: decodeStorageAddress(controllerWord, "controller slot"),
  });
}

function decideIdentity(
  input: IdentityStepInput<AngstromV4Candidate, unknown>,
  evidence: AngstromV4IdentityEvidence | undefined,
): IdentityDecision<AngstromV4Identity> {
  const candidate = input.candidate;
  if (!sameAddress(candidate.manager, ADDR.UNISWAP_V4_POOL_MANAGER)) {
    return { status: "rejected", reason: "foreign_pool_manager" };
  }
  if (!sameAddress(candidate.adapter, ANGSTROM_MAINNET_ADAPTER)) {
    return { status: "rejected", reason: "foreign_angstrom_adapter" };
  }
  const poolKey = canonicalPoolKey(candidate.poolKey);
  if (!sameAddress(poolKey.hooks, ANGSTROM_MAINNET_HOOK)) {
    return { status: "rejected", reason: "foreign_hook_fail_closed" };
  }
  try {
    assertPoolKeyIdentity(candidate.poolId, poolKey);
  } catch {
    return { status: "rejected", reason: "poolkey_reverse_binding_failed" };
  }
  if (evidence === undefined || evidence.phase === "pool-hook-static") {
    if (
      evidence?.phase === "pool-hook-static" &&
      sameAddress(evidence.controller, ethers.ZeroAddress)
    ) {
      return { status: "rejected", reason: "hook_controller_missing" };
    }
    return { status: "continue" };
  }
  if (!sameAddress(evidence.canonicalHook, ANGSTROM_MAINNET_HOOK)) {
    return { status: "rejected", reason: "controller_reverse_binding_failed" };
  }
  if (evidence.sqrtPriceX96 === 0n) {
    return { status: "rejected", reason: "pool_not_initialized" };
  }
  const manager = canonicalAddress(candidate.manager);
  const adapter = canonicalAddress(candidate.adapter);
  const hook = canonicalAddress(poolKey.hooks);
  const poolId = canonicalPoolId(candidate.poolId);
  const evidenceHash = hashCanonical({
    manager,
    adapter,
    hook,
    poolId,
    poolKey: poolKeyProjection(poolKey),
    controller: evidence.controller,
    managerCodeHash: evidence.managerCodeHash,
    adapterCodeHash: evidence.adapterCodeHash,
    hookCodeHash: evidence.hookCodeHash,
    canonicalHook: evidence.canonicalHook,
    sqrtPriceX96: evidence.sqrtPriceX96,
    liquidity: evidence.liquidity,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: ANGSTROM_V4_FAMILY_ID,
      lineageId: ANGSTROM_V4_LINEAGE_ID,
      subject: `${manager.toLowerCase()}\u001f${poolId}`,
      provenance: Object.freeze([Object.freeze({
        kind: "official-hook-controller-reverse-proof",
        subject: hook,
        evidenceHash,
      })]),
      facts: Object.freeze({
        poolId,
        poolKey,
        immutableBinding: Object.freeze({
          manager,
          stateView: canonicalAddress(ADDR.UNISWAP_V4_STATE_VIEW),
          quoter: canonicalAddress(ADDR.UNISWAP_V4_QUOTER),
          hook,
          adapter,
          controller: evidence.controller,
          managerCodeHash: evidence.managerCodeHash,
          hookCodeHash: evidence.hookCodeHash,
          adapterCodeHash: evidence.adapterCodeHash,
        }),
      }),
    }),
  };
}

function identityEvidence(
  value: unknown,
): AngstromV4IdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    ((value as { readonly phase?: unknown }).phase !== "pool-hook-static" &&
      (value as { readonly phase?: unknown }).phase !== "controller-reverse")
  ) {
    throw new Error("angstrom-v4 identity received malformed prior evidence");
  }
  return value as AngstromV4IdentityEvidence;
}
