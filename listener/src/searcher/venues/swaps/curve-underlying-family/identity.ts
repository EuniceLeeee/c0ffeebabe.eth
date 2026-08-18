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
  CURVE_BEHAVIOR_PROBE_AMOUNTS,
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE,
  decodeGetDy,
  decodeHandlers,
  decodeUnderlyingCoins,
  lowerAddress,
  requireSuccessfulResult,
} from "./codec.js";
import {
  CURVE_UNDERLYING_FAMILY_ID,
  CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
} from "./manifest.js";
import type {
  CurveUnderlyingCandidate,
  CurveUnderlyingIdentity,
  CurveUnderlyingIdentityEvidence,
  CurveUnderlyingVerifiedDirection,
} from "./types.js";

const REGISTRY_HANDLERS_ID = "registry-handlers";
const REGISTRY_COINS_ID = "registry-underlying-coins";
const POOL_CODE_ID = "pool-code";

export const curveUnderlyingIdentity = {
  variants: [{
    id: "metaregistry-member",
    kind: "registry-member" as const,
    lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
    applies: () => true,
    requirements(input: IdentityStepInput<CurveUnderlyingCandidate, unknown>) {
      return identityEvidence(input.evidence) === undefined
        ? {
            transports: ["eth-call" as const, "get-code" as const],
          }
        : { transports: ["eth-call" as const] };
    },
    buildRequests(input: IdentityStepInput<CurveUnderlyingCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return registryRequests(input.candidate);
      if (evidence.phase === "registry-surface") {
        return behaviorRequests(evidence);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<CurveUnderlyingCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }) {
      const prior = identityEvidence(input.step.evidence);
      return prior === undefined
        ? decodeRegistrySurface(input.step.candidate, input.results)
        : decodeBehaviorProof(prior, input.results);
    },
    decide(input: IdentityStepInput<CurveUnderlyingCandidate, unknown>) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<CurveUnderlyingCandidate, CurveUnderlyingIdentity>;

function registryRequests(
  candidate: CurveUnderlyingCandidate,
): readonly AdapterRequest[] {
  const pool = canonicalAddress(candidate.pool);
  return Object.freeze([
    Object.freeze({
      id: REGISTRY_HANDLERS_ID,
      kind: "eth-call" as const,
      to: CURVE_METAREGISTRY,
      data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData(
        "get_registry_handlers_from_pool",
        [pool],
      ),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: REGISTRY_COINS_ID,
      kind: "eth-call" as const,
      to: CURVE_METAREGISTRY,
      data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData(
        "get_underlying_coins",
        [pool],
      ),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: POOL_CODE_ID,
      kind: "get-code" as const,
      address: pool,
    }),
  ]);
}

function behaviorRequests(
  evidence: Extract<
    CurveUnderlyingIdentityEvidence,
    { readonly phase: "registry-surface" }
  >,
): readonly AdapterRequest[] {
  const requests: AdapterRequest[] = [];
  for (let i = 0; i < evidence.coins.length; i++) {
    for (let j = 0; j < evidence.coins.length; j++) {
      if (i === j) continue;
      for (let probe = 0; probe < CURVE_BEHAVIOR_PROBE_AMOUNTS.length; probe++) {
        requests.push(Object.freeze({
          id: behaviorRequestId(i, j, probe),
          kind: "eth-call" as const,
          to: evidence.pool,
          data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData(
            "get_dy_underlying",
            [
              BigInt(i),
              BigInt(j),
              CURVE_BEHAVIOR_PROBE_AMOUNTS[probe],
            ],
          ),
          // Individual directions/amounts may deterministically revert even
          // when a sibling direction proves the pool. Preserve that pinned
          // negative result without weakening genuine transport failures.
          completion: "return-or-revert-data" as const,
        }));
      }
    }
  }
  return Object.freeze(requests);
}

function decodeRegistrySurface(
  candidate: CurveUnderlyingCandidate,
  results: readonly AdapterRequestResult[],
): CurveUnderlyingIdentityEvidence {
  const handlersResult = requireSuccessfulResult(results, REGISTRY_HANDLERS_ID);
  const coinsResult = requireSuccessfulResult(results, REGISTRY_COINS_ID);
  const codeResult = requireSuccessfulResult(results, POOL_CODE_ID);
  return Object.freeze({
    phase: "registry-surface" as const,
    pool: canonicalAddress(candidate.pool),
    handlers: decodeHandlers(handlersResult.data),
    coins: decodeUnderlyingCoins(coinsResult.data),
    poolHasCode: codeResult.data !== "0x",
  });
}

function decodeBehaviorProof(
  prior: CurveUnderlyingIdentityEvidence,
  results: readonly AdapterRequestResult[],
): CurveUnderlyingIdentityEvidence {
  if (prior.phase !== "registry-surface") {
    throw new Error("curve-underlying behavior proof has already completed");
  }
  const verifiedDirections: CurveUnderlyingVerifiedDirection[] = [];
  for (let i = 0; i < prior.coins.length; i++) {
    for (let j = 0; j < prior.coins.length; j++) {
      if (i === j) continue;
      let witness: CurveUnderlyingVerifiedDirection | null = null;
      for (let probe = 0; probe < CURVE_BEHAVIOR_PROBE_AMOUNTS.length; probe++) {
        const result = behaviorAmountOut(
          results,
          behaviorRequestId(i, j, probe),
        );
        if (result !== null && result > 0n && witness === null) {
          witness = Object.freeze({
            i,
            j,
            tokenIn: prior.coins[i],
            tokenOut: prior.coins[j],
            behaviorProbeAmountIn: CURVE_BEHAVIOR_PROBE_AMOUNTS[probe],
            behaviorProbeAmountOut: result,
          });
        }
      }
      if (witness !== null) verifiedDirections.push(witness);
    }
  }
  return Object.freeze({
    phase: "behavior-proof" as const,
    pool: prior.pool,
    handlers: prior.handlers,
    coins: prior.coins,
    verifiedDirections: Object.freeze(verifiedDirections),
  });
}

function behaviorAmountOut(
  results: readonly AdapterRequestResult[],
  id: string,
): bigint | null {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`curve-underlying result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(`curve-underlying unresolved: ${result.failure}`);
  }
  if (result.completion === "reverted-as-declared") return null;
  return decodeGetDy(result.data);
}

function decideIdentity(
  input: IdentityStepInput<CurveUnderlyingCandidate, unknown>,
  evidence: CurveUnderlyingIdentityEvidence | undefined,
): IdentityDecision<CurveUnderlyingIdentity> {
  if (evidence === undefined) return { status: "continue" };
  if (evidence.phase === "registry-surface") {
    if (!evidence.poolHasCode) {
      return { status: "rejected", reason: "pool_has_no_code" };
    }
    if (evidence.handlers.length === 0) {
      return { status: "rejected", reason: "registry_reverse_binding_failed" };
    }
    if (evidence.coins.length < 2 || evidence.coins.length > 8) {
      return { status: "rejected", reason: "invalid_underlying_coin_domain" };
    }
    return { status: "continue" };
  }
  if (evidence.verifiedDirections.length === 0) {
    return { status: "rejected", reason: "no_behavior_proven_direction" };
  }
  if (
    input.candidate.hintedI !== null &&
    input.candidate.hintedJ !== null &&
    !evidence.verifiedDirections.some((direction) =>
      direction.i === input.candidate.hintedI &&
      direction.j === input.candidate.hintedJ
    )
  ) {
    return { status: "rejected", reason: "observed_direction_not_behavior_proven" };
  }
  const registryBinding = Object.freeze({
    registry: CURVE_METAREGISTRY,
    handlers: Object.freeze([...evidence.handlers]),
    lookupSemantics:
      "get_registry_handlers_from_pool+get_underlying_coins" as const,
  });
  const evidenceHash = hashCanonical({
    pool: evidence.pool,
    coins: evidence.coins,
    registryBinding: {
      registry: registryBinding.registry,
      handlers: registryBinding.handlers,
      lookupSemantics: registryBinding.lookupSemantics,
    },
    verifiedDirections: evidence.verifiedDirections.map((direction) => ({
      i: direction.i,
      j: direction.j,
      tokenIn: direction.tokenIn,
      tokenOut: direction.tokenOut,
      behaviorProbeAmountIn: direction.behaviorProbeAmountIn,
      behaviorProbeAmountOut: direction.behaviorProbeAmountOut,
    })),
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: CURVE_UNDERLYING_FAMILY_ID,
      lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
      subject: evidence.pool,
      provenance: Object.freeze([Object.freeze({
        kind: "curve-metaregistry-reverse-behavior-proof",
        subject: CURVE_METAREGISTRY,
        evidenceHash,
      })]),
      facts: Object.freeze({
        pool: evidence.pool,
        coins: Object.freeze([...evidence.coins]),
        registryBinding,
        verifiedDirections: Object.freeze([...evidence.verifiedDirections]),
      }),
    }),
  };
}

function behaviorRequestId(i: number, j: number, probe: number): string {
  return `behavior-get-dy:${i}:${j}:${probe}`;
}

function identityEvidence(
  value: unknown,
): CurveUnderlyingIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    ((value as { readonly phase?: unknown }).phase !== "registry-surface" &&
      (value as { readonly phase?: unknown }).phase !== "behavior-proof")
  ) {
    throw new Error("curve-underlying identity received malformed evidence");
  }
  return value as CurveUnderlyingIdentityEvidence;
}
