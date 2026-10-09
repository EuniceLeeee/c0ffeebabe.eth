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
import { algebraQuoterBinding, algebraQuoterIdentityRequests, assertAlgebraSource } from "./quoter-model.js";
import {
  ALGEBRA_FACTORY_INTERFACE,
  ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG,
  ALGEBRA_POOL_INTERFACE,
} from "./abi.js";
import {
  canonicalAddress,
  decodeAddressResult,
  decodeGlobalStateResult,
  decodeInt24Result,
  decodeUint16Result,
  decodeUint128Result,
  sameAddress,
  type AlgebraGlobalState,
} from "./codec.js";
import {
  ALGEBRA_INTEGRAL_FACTORY_LINEAGE_ID,
  ALGEBRA_INTEGRAL_FAMILY_ID,
} from "./manifest.js";
import type {
  AlgebraIntegralCandidate,
  AlgebraIntegralIdentity,
  AlgebraIntegralIdentityEvidence,
} from "./types.js";

const FACTORY_REQUEST_ID = "pool-factory";
const TOKEN0_REQUEST_ID = "pool-token0";
const TOKEN1_REQUEST_ID = "pool-token1";
const TICK_SPACING_REQUEST_ID = "pool-tick-spacing";
const PLUGIN_REQUEST_ID = "pool-plugin";
const GLOBAL_STATE_REQUEST_ID = "pool-global-state";
const FEE_REQUEST_ID = "pool-fee";
const LIQUIDITY_REQUEST_ID = "pool-liquidity";
const REVERSE_REQUEST_ID = "factory-pool-by-pair";

const STATIC_EVIDENCE_IDS = Object.freeze([
  FACTORY_REQUEST_ID,
  TOKEN0_REQUEST_ID,
  TOKEN1_REQUEST_ID,
  TICK_SPACING_REQUEST_ID,
  PLUGIN_REQUEST_ID,
  GLOBAL_STATE_REQUEST_ID,
  FEE_REQUEST_ID,
  LIQUIDITY_REQUEST_ID,
]);

/** Variant-scope outcomes; unsupported dynamic semantics are retryable. */
export const ALGEBRA_DYNAMIC_FEE_UNSUPPORTED =
  "algebra_plugin_dynamic_fee_unsupported";
export const ALGEBRA_STATIC_FEE_BINDING_FAILED =
  "algebra_static_fee_binding_failed";
export const ALGEBRA_REVERSE_BINDING_FAILED = "factory_reverse_binding_failed";
export const ALGEBRA_STATIC_BINDING_MISMATCH =
  "candidate_static_binding_mismatch";

/**
 * Static pools retain the bounded local model. Dynamic Cypher plugins use a
 * source/code-bound Quoter that runs beforeSwap, not fee() as an execution fee.
 * Unsupported plugin semantics remain retryable; missing support is not proof
 * that a reverse-registered pool is absent.
 */
export const algebraIntegralIdentity = {
  variants: [{
    id: "algebra-factory-child-reverse-binding",
    kind: "factory-child",
    lineageId: ALGEBRA_INTEGRAL_FACTORY_LINEAGE_ID,
    applies: () => true,
    requirements: ({ evidence }) => ({ transports: identityEvidence(evidence)?.phase === "pool-static" &&
      (identityEvidence(evidence)!.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0
      ? ["eth-call", "get-code"] : ["eth-call"] }),
    buildRequests(input) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return staticRequests(input.candidate);
      if (evidence.phase === "pool-static") {
        const [tokenA, tokenB] = sortTokenPair(evidence.token0, evidence.token1);
        return [Object.freeze({
          id: REVERSE_REQUEST_ID,
          kind: "eth-call" as const,
          to: canonicalAddress(evidence.factory),
          data: ALGEBRA_FACTORY_INTERFACE.encodeFunctionData("poolByPair", [tokenA, tokenB]),
          // A pinned poolByPair revert is a chain-proven failed reverse binding,
          // while a genuine transport error stays an unresolved result.
          completion: "return-or-revert-data" as const,
        }), ...((evidence.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0
          ? algebraQuoterIdentityRequests(evidence.factory, evidence.plugin) : [])];
      }
      return [];
    },
    decode({ step, results }) {
      const prior = identityEvidence(step.evidence);
      if (prior === undefined) return decodeStatic(results);
      if (prior.phase !== "pool-static") {
        throw new Error("algebra-integral identity proof has already completed");
      }
      assertAlgebraSource(results, prior.source);
      const bound = (prior.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0
        ? algebraQuoterBinding({ ...prior, pool: step.candidate.pool }, results) : null;
      return Object.freeze({
        phase: "reverse-binding" as const,
        source: prior.source,
        factory: prior.factory,
        token0: prior.token0,
        token1: prior.token1,
        tickSpacing: prior.tickSpacing,
        plugin: prior.plugin,
        pluginConfig: prior.pluginConfig,
        lastFee: prior.lastFee,
        feeView: prior.feeView,
        sqrtPriceX96: prior.sqrtPriceX96,
        liquidity: prior.liquidity,
        unlocked: prior.unlocked,
        reversePool: decodeReversePool(results),
        ...(bound === null ? {} : { quoterBinding: bound }),
      });
    },
    decide(input) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => canonicalAddress(identity.subject).toLowerCase(),
} satisfies IdentitySemantics<AlgebraIntegralCandidate, AlgebraIntegralIdentity>;

function staticRequests(candidate: AlgebraIntegralCandidate): readonly AdapterRequest[] {
  const pool = canonicalAddress(candidate.pool);
  return Object.freeze([
    Object.freeze({
      id: FACTORY_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("factory"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: TOKEN0_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("token0"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: TOKEN1_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("token1"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: TICK_SPACING_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("tickSpacing"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: PLUGIN_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("plugin"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: GLOBAL_STATE_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("globalState"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: FEE_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("fee"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: LIQUIDITY_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("liquidity"),
      completion: "return-data" as const,
    }),
  ]);
}

function decodeStatic(
  results: readonly AdapterRequestResult[],
): AlgebraIntegralIdentityEvidence {
  const first = results[0];
  if (!first?.ok) throw new Error("algebra identity source missing");
  assertAlgebraSource(results, first.source);
  const globalState: AlgebraGlobalState = decodeGlobalStateResult(
    results,
    GLOBAL_STATE_REQUEST_ID,
  );
  return Object.freeze({
    phase: "pool-static" as const,
    source: first.source,
    factory: decodeAddressResult(results, FACTORY_REQUEST_ID, ALGEBRA_POOL_INTERFACE, "factory"),
    token0: decodeAddressResult(results, TOKEN0_REQUEST_ID, ALGEBRA_POOL_INTERFACE, "token0"),
    token1: decodeAddressResult(results, TOKEN1_REQUEST_ID, ALGEBRA_POOL_INTERFACE, "token1"),
    tickSpacing: decodeInt24Result(results, TICK_SPACING_REQUEST_ID, "tickSpacing", 1),
    plugin: decodeAddressResult(results, PLUGIN_REQUEST_ID, ALGEBRA_POOL_INTERFACE, "plugin"),
    pluginConfig: globalState.pluginConfig,
    lastFee: globalState.lastFee,
    feeView: decodeUint16Result(results, FEE_REQUEST_ID, "fee"),
    sqrtPriceX96: globalState.sqrtPriceX96,
    liquidity: decodeUint128Result(results, LIQUIDITY_REQUEST_ID, "liquidity"),
    unlocked: globalState.unlocked,
  });
}

function decodeReversePool(
  results: readonly AdapterRequestResult[],
): string {
  const result = results.find((candidate) => candidate.id === REVERSE_REQUEST_ID);
  if (result === undefined) {
    throw new Error(`algebra-integral request result ${REVERSE_REQUEST_ID} is missing`);
  }
  if (!result.ok) {
    throw new Error(
      `algebra-integral request result ${REVERSE_REQUEST_ID} is unresolved: ${result.failure}`,
    );
  }
  if (result.completion === "reverted-as-declared") {
    return "0x0000000000000000000000000000000000000000";
  }
  return decodeAddressResult(results, REVERSE_REQUEST_ID, ALGEBRA_FACTORY_INTERFACE, "poolByPair");
}

function decideIdentity(
  input: IdentityStepInput<AlgebraIntegralCandidate, unknown>,
  evidence: AlgebraIntegralIdentityEvidence | undefined,
): IdentityDecision<AlgebraIntegralIdentity> {
  if (evidence === undefined || evidence.phase === "pool-static") {
    return { status: "continue" };
  }
  const candidate = input.candidate;
  if (
    sameAddress(evidence.token0, evidence.token1) ||
    (candidate.hintedFactory !== null &&
      !sameAddress(candidate.hintedFactory, evidence.factory)) ||
    (candidate.hintedToken0 !== null &&
      !sameAddress(candidate.hintedToken0, evidence.token0)) ||
    (candidate.hintedToken1 !== null &&
      !sameAddress(candidate.hintedToken1, evidence.token1))
  ) {
    // Chain-proven at the fixed cutoff: the pool's declared token/factory
    // surface contradicts the candidate's hinted identity.
    return {
      status: "chain-proven-rejected",
      reasonCode: ALGEBRA_STATIC_BINDING_MISMATCH,
      evidenceRequestIds: [
        FACTORY_REQUEST_ID,
        TOKEN0_REQUEST_ID,
        TOKEN1_REQUEST_ID,
        TICK_SPACING_REQUEST_ID,
      ],
    };
  }
  if (!sameAddress(evidence.reversePool, candidate.pool)) {
    // poolByPair at the fixed cutoff returns a different pool (or the zero
    // address / a pinned revert): chain-proven negative evidence.
    return {
      status: "chain-proven-rejected",
      reasonCode: ALGEBRA_REVERSE_BINDING_FAILED,
      evidenceRequestIds: [REVERSE_REQUEST_ID],
    };
  }
  if ((evidence.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0) {
    if (evidence.quoterBinding === undefined) return { status: "retryable", reasonCode: ALGEBRA_DYNAMIC_FEE_UNSUPPORTED };
  }
  else if (evidence.feeView !== evidence.lastFee) {
    // Without the DYNAMIC_FEE bit `fee()` must return `globalState.lastFee`
    // verbatim; a disagreement means the read surface is not the modelled one.
    return {
      status: "chain-proven-rejected",
      reasonCode: ALGEBRA_STATIC_FEE_BINDING_FAILED,
      evidenceRequestIds: [FEE_REQUEST_ID, GLOBAL_STATE_REQUEST_ID],
    };
  }

  const pool = canonicalAddress(candidate.pool);
  const factory = canonicalAddress(evidence.factory);
  const token0 = canonicalAddress(evidence.token0);
  const token1 = canonicalAddress(evidence.token1);
  const reversePool = canonicalAddress(evidence.reversePool);
  const plugin = canonicalAddress(evidence.plugin);
  const evidenceHash = hashCanonical({
    source: { ...evidence.source },
    pool,
    factory,
    token0,
    token1,
    tickSpacing: evidence.tickSpacing,
    plugin,
    pluginConfig: evidence.pluginConfig,
    lastFee: evidence.lastFee,
    reversePool,
    ...(evidence.quoterBinding ? { quoterBinding: { ...evidence.quoterBinding } } : {}),
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: ALGEBRA_INTEGRAL_FAMILY_ID,
      lineageId: ALGEBRA_INTEGRAL_FACTORY_LINEAGE_ID,
      subject: pool,
      provenance: Object.freeze([Object.freeze({
        kind: "factory-reverse-binding",
        subject: factory,
        evidenceHash,
      })]),
      facts: Object.freeze({
        pool,
        token0,
        token1,
        tickSpacing: evidence.tickSpacing,
        factoryBinding: Object.freeze({ factory, reversePool }),
        executedFee: Object.freeze({
          ...(evidence.quoterBinding === undefined ? { kind: "global-state-last-fee" as const }
            : { kind: "cypher-bound-quoter" as const, quoterBinding: evidence.quoterBinding }),
          fee: evidence.lastFee,
          pluginConfig: evidence.pluginConfig,
          plugin,
        }),
      }),
    }),
  };
}

function identityEvidence(
  value: unknown,
): AlgebraIntegralIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    ((value as { readonly phase?: unknown }).phase !== "pool-static" &&
      (value as { readonly phase?: unknown }).phase !== "reverse-binding")
  ) {
    throw new Error("algebra-integral identity received malformed prior evidence");
  }
  return value as AlgebraIntegralIdentityEvidence;
}

function sortTokenPair(
  token0: string,
  token1: string,
): readonly [string, string] {
  return BigInt(token0) < BigInt(token1)
    ? [canonicalAddress(token0), canonicalAddress(token1)]
    : [canonicalAddress(token1), canonicalAddress(token0)];
}
