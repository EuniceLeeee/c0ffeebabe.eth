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
  decodeAddressResult,
  sameAddress,
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_INTERFACE,
} from "./codec.js";
import { uniV2FeeRuleForFactory } from "./fee-rule.js";
import {
  UNIV2_FACTORY_LINEAGE_ID,
  UNIV2_FAMILY_ID,
} from "./manifest.js";
import type {
  UniV2Candidate,
  UniV2Identity,
  UniV2IdentityEvidence,
} from "./types.js";

const FACTORY_REQUEST_ID = "pair-factory";
const TOKEN0_REQUEST_ID = "pair-token0";
const TOKEN1_REQUEST_ID = "pair-token1";
const REVERSE_REQUEST_ID = "factory-get-pair";

export const univ2Identity = {
  variants: [{
    id: "factory-child-reverse-binding",
    kind: "factory-child",
    lineageId: UNIV2_FACTORY_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests(input) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return buildPoolStaticRequests(input.candidate);
      if (evidence.phase === "pool-static") {
        return [Object.freeze({
          id: REVERSE_REQUEST_ID,
          kind: "eth-call" as const,
          to: evidence.factory,
          data: UNIV2_FACTORY_INTERFACE.encodeFunctionData("getPair", [
            evidence.token0,
            evidence.token1,
          ]),
          // A factory-shaped contract may deterministically revert for an
          // unsupported pair domain. That pinned revert is negative Family
          // evidence, not a transient RPC failure.
          completion: "return-or-revert-data" as const,
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
            UNIV2_PAIR_INTERFACE,
            "factory",
          ),
          token0: decodeAddressResult(
            results,
            TOKEN0_REQUEST_ID,
            UNIV2_PAIR_INTERFACE,
            "token0",
          ),
          token1: decodeAddressResult(
            results,
            TOKEN1_REQUEST_ID,
            UNIV2_PAIR_INTERFACE,
            "token1",
          ),
        });
      }
      if (prior.phase !== "pool-static") {
        throw new Error("univ2 identity proof has already completed");
      }
      return Object.freeze({
        phase: "reverse-binding" as const,
        factory: prior.factory,
        token0: prior.token0,
        token1: prior.token1,
        reversePool: decodeReversePool(
          results,
          REVERSE_REQUEST_ID,
        ),
      });
    },
    decide(input) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => canonicalAddress(identity.subject).toLowerCase(),
} satisfies IdentitySemantics<UniV2Candidate, UniV2Identity>;

function buildPoolStaticRequests(
  candidate: UniV2Candidate,
): readonly AdapterRequest[] {
  return [
    call(FACTORY_REQUEST_ID, candidate.pool, "factory"),
    call(TOKEN0_REQUEST_ID, candidate.pool, "token0"),
    call(TOKEN1_REQUEST_ID, candidate.pool, "token1"),
  ];
}

function decodeReversePool(
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`univ2 request result ${id} is missing`);
  if (!result.ok) {
    throw new Error(`univ2 request result ${id} is unresolved: ${result.failure}`);
  }
  if (result.completion === "reverted-as-declared") {
    return "0x0000000000000000000000000000000000000000";
  }
  return decodeAddressResult(
    results,
    id,
    UNIV2_FACTORY_INTERFACE,
    "getPair",
  );
}

function call(
  id: string,
  pool: string,
  functionName: "factory" | "token0" | "token1",
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: canonicalAddress(pool),
    data: UNIV2_PAIR_INTERFACE.encodeFunctionData(functionName),
    completion: "return-data" as const,
  });
}

function decideIdentity(
  input: IdentityStepInput<UniV2Candidate, unknown>,
  evidence: UniV2IdentityEvidence | undefined,
): IdentityDecision<UniV2Identity> {
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
    // fields contradict the candidate's hinted identity.
    return {
      status: "chain-proven-rejected",
      reasonCode: "candidate_static_binding_mismatch",
      evidenceRequestIds: [FACTORY_REQUEST_ID, TOKEN0_REQUEST_ID, TOKEN1_REQUEST_ID],
    };
  }
  if (!sameAddress(evidence.reversePool, candidate.pool)) {
    // getPair at the fixed cutoff returns a different pool (or the zero
    // address / a pinned revert): chain-proven negative evidence that this
    // pair does not exist under this factory.
    return {
      status: "chain-proven-rejected",
      reasonCode: "factory_reverse_binding_failed",
      evidenceRequestIds: [REVERSE_REQUEST_ID],
    };
  }
  const pool = canonicalAddress(candidate.pool);
  const factory = canonicalAddress(evidence.factory);
  const token0 = canonicalAddress(evidence.token0);
  const token1 = canonicalAddress(evidence.token1);
  const reversePool = canonicalAddress(evidence.reversePool);
  const feeRule = uniV2FeeRuleForFactory(factory);
  const evidenceHash = hashCanonical({
    pool,
    factory,
    token0,
    token1,
    reversePool,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: UNIV2_FAMILY_ID,
      lineageId: UNIV2_FACTORY_LINEAGE_ID,
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
        feeRule,
        factoryBinding: Object.freeze({ factory, reversePool }),
      }),
    }),
  };
}

function identityEvidence(value: unknown): UniV2IdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !("phase" in value) ||
    ((value as { readonly phase?: unknown }).phase !== "pool-static" &&
      (value as { readonly phase?: unknown }).phase !== "reverse-binding")
  ) {
    throw new Error("univ2 identity received malformed prior evidence");
  }
  return value as UniV2IdentityEvidence;
}
