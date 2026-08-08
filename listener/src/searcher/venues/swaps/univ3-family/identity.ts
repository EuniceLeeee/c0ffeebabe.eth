import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  factoryBoundUniV3Quoter,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_POOL_INTERFACE,
  UNIV3_SWAP_ROUTER,
} from "../univ3-abi.js";
import {
  canonicalAddress,
  decodeAddressResult,
  decodePositiveInt24Result,
  decodeUint24Result,
  sameAddress,
} from "./codec.js";
import {
  UNIV3_FACTORY_LINEAGE_ID,
  UNIV3_FAMILY_ID,
} from "./manifest.js";
import type {
  UniV3Candidate,
  UniV3Identity,
  UniV3IdentityEvidence,
} from "./types.js";

const FACTORY_REQUEST_ID = "pool-factory";
const TOKEN0_REQUEST_ID = "pool-token0";
const TOKEN1_REQUEST_ID = "pool-token1";
const FEE_REQUEST_ID = "pool-fee";
const TICK_SPACING_REQUEST_ID = "pool-tick-spacing";
const REVERSE_REQUEST_ID = "factory-get-pool";

export const univ3Identity = {
  variants: [{
    id: "factory-child-reverse-binding",
    kind: "factory-child",
    lineageId: UNIV3_FACTORY_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests(input) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return buildPoolStaticRequests(input.candidate);
      if (evidence.phase === "pool-static") {
        const [tokenA, tokenB] = sortTokenPair(
          evidence.token0,
          evidence.token1,
        );
        return [Object.freeze({
          id: REVERSE_REQUEST_ID,
          kind: "eth-call" as const,
          to: evidence.factory,
          data: UNIV3_FACTORY_INTERFACE.encodeFunctionData("getPool", [
            tokenA,
            tokenB,
            evidence.fee,
          ]),
          completion: "return-data" as const,
        })];
      }
      return [];
    },
    decode({ step, results }) {
      const prior = identityEvidence(step.evidence);
      if (prior === undefined) {
        return Object.freeze({
          phase: "pool-static" as const,
          factory: decodeAddressResult(
            results,
            FACTORY_REQUEST_ID,
            UNIV3_POOL_INTERFACE,
            "factory",
          ),
          token0: decodeAddressResult(
            results,
            TOKEN0_REQUEST_ID,
            UNIV3_POOL_INTERFACE,
            "token0",
          ),
          token1: decodeAddressResult(
            results,
            TOKEN1_REQUEST_ID,
            UNIV3_POOL_INTERFACE,
            "token1",
          ),
          fee: decodeUint24Result(
            results,
            FEE_REQUEST_ID,
            UNIV3_POOL_INTERFACE,
            "fee",
          ),
          tickSpacing: decodePositiveInt24Result(
            results,
            TICK_SPACING_REQUEST_ID,
            UNIV3_POOL_INTERFACE,
            "tickSpacing",
          ),
        });
      }
      if (prior.phase !== "pool-static") {
        throw new Error("univ3 identity proof has already completed");
      }
      return Object.freeze({
        phase: "reverse-binding" as const,
        factory: prior.factory,
        token0: prior.token0,
        token1: prior.token1,
        fee: prior.fee,
        tickSpacing: prior.tickSpacing,
        reversePool: decodeAddressResult(
          results,
          REVERSE_REQUEST_ID,
          UNIV3_FACTORY_INTERFACE,
          "getPool",
        ),
      });
    },
    decide(input) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => canonicalAddress(identity.subject).toLowerCase(),
} satisfies IdentitySemantics<UniV3Candidate, UniV3Identity>;

function buildPoolStaticRequests(
  candidate: UniV3Candidate,
): readonly AdapterRequest[] {
  return [
    poolCall(FACTORY_REQUEST_ID, candidate.pool, "factory"),
    poolCall(TOKEN0_REQUEST_ID, candidate.pool, "token0"),
    poolCall(TOKEN1_REQUEST_ID, candidate.pool, "token1"),
    poolCall(FEE_REQUEST_ID, candidate.pool, "fee"),
    poolCall(TICK_SPACING_REQUEST_ID, candidate.pool, "tickSpacing"),
  ];
}

function poolCall(
  id: string,
  pool: string,
  functionName: "factory" | "token0" | "token1" | "fee" | "tickSpacing",
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: canonicalAddress(pool),
    data: UNIV3_POOL_INTERFACE.encodeFunctionData(functionName),
    completion: "return-data" as const,
  });
}

function decideIdentity(
  input: IdentityStepInput<UniV3Candidate, unknown>,
  evidence: UniV3IdentityEvidence | undefined,
): IdentityDecision<UniV3Identity> {
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
      !sameAddress(candidate.hintedToken1, evidence.token1)) ||
    (candidate.hintedFee !== null && candidate.hintedFee !== evidence.fee) ||
    (candidate.hintedTickSpacing !== null &&
      candidate.hintedTickSpacing !== evidence.tickSpacing)
  ) {
    return { status: "rejected", reason: "candidate_static_binding_mismatch" };
  }
  if (!sameAddress(evidence.reversePool, candidate.pool)) {
    return { status: "rejected", reason: "factory_reverse_binding_failed" };
  }

  const pool = canonicalAddress(candidate.pool);
  const factory = canonicalAddress(evidence.factory);
  const token0 = canonicalAddress(evidence.token0);
  const token1 = canonicalAddress(evidence.token1);
  const reversePool = canonicalAddress(evidence.reversePool);
  const quoter = factoryBoundUniV3Quoter(factory);
  const evidenceHash = hashCanonical({
    pool,
    factory,
    token0,
    token1,
    fee: evidence.fee,
    tickSpacing: evidence.tickSpacing,
    reversePool,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: UNIV3_FAMILY_ID,
      lineageId: UNIV3_FACTORY_LINEAGE_ID,
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
        fee: evidence.fee,
        tickSpacing: evidence.tickSpacing,
        factoryBinding: Object.freeze({ factory, reversePool }),
        quoterBinding: Object.freeze({
          quoter,
          router: quoter === null ? null : UNIV3_SWAP_ROUTER,
          provenance: quoter === null
            ? "unavailable" as const
            : "factory-bound-infrastructure" as const,
        }),
      }),
    }),
  };
}

function identityEvidence(value: unknown): UniV3IdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    ((value as { readonly phase?: unknown }).phase !== "pool-static" &&
      (value as { readonly phase?: unknown }).phase !== "reverse-binding")
  ) {
    throw new Error("univ3 identity received malformed prior evidence");
  }
  return value as UniV3IdentityEvidence;
}

function sortTokenPair(
  token0: string,
  token1: string,
): readonly [string, string] {
  return BigInt(token0) < BigInt(token1)
    ? [canonicalAddress(token0), canonicalAddress(token1)]
    : [canonicalAddress(token1), canonicalAddress(token0)];
}
