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
  decodeDodoPmmState,
  decodeFeeRates,
  lowerAddress,
  requireSuccessfulResult,
  sameAddress,
  DODO_V2_POOL_INTERFACE,
  DODO_V2_REGISTRIES,
  DODO_V2_REGISTRY_INTERFACE,
} from "./codec.js";
import {
  DODO_V2_FAMILY_ID,
  DODO_V2_REGISTRY_LINEAGE_ID,
} from "./manifest.js";
import type {
  DodoV2Candidate,
  DodoV2Identity,
  DodoV2IdentityEvidence,
} from "./types.js";

const BASE_TOKEN_REQUEST_ID = "pool-base-token";
const QUOTE_TOKEN_REQUEST_ID = "pool-quote-token";
const PMM_REQUEST_ID = "pool-pmm-behavior";
const FEE_REQUEST_ID = "pool-actor-fee-behavior";
const REGISTRY_REQUEST_ID = "registry-get-dodo-pool";

/** Production BotVM owner; the strict descriptor binds this quote identity. */
export const DODO_V2_QUOTE_ACTOR = canonicalAddress(
  "0x1000000000000000000000000000000000000001",
);
export const DODO_V2_QUOTE_ACTOR_EVIDENCE_ID = "dodo-v2-quote-actor";

export const dodoV2Identity = {
  variants: DODO_V2_REGISTRIES.map((registry, index) => ({
    id: `registry-member-${index}`,
    kind: "registry-member" as const,
    lineageId: DODO_V2_REGISTRY_LINEAGE_ID,
    applies: () => true,
    requirements(input: IdentityStepInput<DodoV2Candidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      return evidence === undefined
        ? {
            transports: ["eth-call" as const],
            caller: "verified-actor" as const,
          }
        : { transports: ["eth-call" as const] };
    },
    buildRequests(input: IdentityStepInput<DodoV2Candidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return behaviorRequests(input.candidate);
      if (evidence.phase === "pool-behavior") {
        return [Object.freeze({
          id: REGISTRY_REQUEST_ID,
          kind: "eth-call" as const,
          to: evidence.registry,
          data: DODO_V2_REGISTRY_INTERFACE.encodeFunctionData("getDODOPool", [
            evidence.baseToken,
            evidence.quoteToken,
          ]),
          completion: "return-data" as const,
        })];
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<DodoV2Candidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }) {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeBehaviorEvidence(
          input.step.candidate,
          registry,
          input.results,
        );
      }
      if (prior.phase !== "pool-behavior") {
        throw new Error("dodo-v2 registry identity proof has already completed");
      }
      return decodeRegistryEvidence(prior, input.results);
    },
    decide(input: IdentityStepInput<DodoV2Candidate, unknown>) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  })),
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<DodoV2Candidate, DodoV2Identity>;

function behaviorRequests(
  candidate: DodoV2Candidate,
): readonly AdapterRequest[] {
  const pool = canonicalAddress(candidate.pool);
  return Object.freeze([
    poolCall(BASE_TOKEN_REQUEST_ID, pool, "_BASE_TOKEN_"),
    poolCall(QUOTE_TOKEN_REQUEST_ID, pool, "_QUOTE_TOKEN_"),
    poolCall(PMM_REQUEST_ID, pool, "getPMMStateForCall"),
    Object.freeze({
      id: FEE_REQUEST_ID,
      kind: "eth-call" as const,
      to: pool,
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
      }),
      data: DODO_V2_POOL_INTERFACE.encodeFunctionData("getUserFeeRate", [
        DODO_V2_QUOTE_ACTOR,
      ]),
      completion: "return-data" as const,
    }),
  ]);
}

function poolCall(
  id: string,
  pool: string,
  functionName: "_BASE_TOKEN_" | "_QUOTE_TOKEN_" | "getPMMStateForCall",
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: pool,
    data: DODO_V2_POOL_INTERFACE.encodeFunctionData(functionName),
    completion: "return-data" as const,
  });
}

function decodeBehaviorEvidence(
  candidate: DodoV2Candidate,
  registry: string,
  results: readonly AdapterRequestResult[],
): DodoV2IdentityEvidence {
  const pool = canonicalAddress(candidate.pool);
  const baseToken = decodeAddressResult(
    results,
    BASE_TOKEN_REQUEST_ID,
    "_BASE_TOKEN_",
  );
  const quoteToken = decodeAddressResult(
    results,
    QUOTE_TOKEN_REQUEST_ID,
    "_QUOTE_TOKEN_",
  );
  if (
    baseToken === ethersZeroAddress() ||
    quoteToken === ethersZeroAddress() ||
    sameAddress(baseToken, quoteToken)
  ) {
    throw new Error(`dodo-v2 pool ${pool} returned an invalid base/quote pair`);
  }
  assertCandidateHints(candidate, baseToken, quoteToken);
  const pmmResult = requireSuccessfulResult(results, PMM_REQUEST_ID);
  const feeResult = requireSuccessfulResult(results, FEE_REQUEST_ID);
  const pmm = decodeDodoPmmState(pmmResult.data);
  const fees = decodeFeeRates(feeResult.data);
  return Object.freeze({
    phase: "pool-behavior" as const,
    registry: canonicalAddress(registry),
    pool,
    baseToken,
    quoteToken,
    behaviorProofHash: hashCanonical({
      pool,
      baseToken,
      quoteToken,
      quoteActor: DODO_V2_QUOTE_ACTOR,
      pmm: {
        i: pmm.i,
        K: pmm.K,
        B: pmm.B,
        Q: pmm.Q,
        B0: pmm.B0,
        Q0: pmm.Q0,
        R: pmm.R,
      },
      fees: {
        lpFeeRate: fees.lpFeeRate,
        mtFeeRate: fees.mtFeeRate,
      },
    }),
  });
}

function decodeRegistryEvidence(
  prior: Extract<DodoV2IdentityEvidence, { readonly phase: "pool-behavior" }>,
  results: readonly AdapterRequestResult[],
): DodoV2IdentityEvidence {
  const registryResult = requireSuccessfulResult(results, REGISTRY_REQUEST_ID);
  const listedPools = Object.freeze(Array.from(
    DODO_V2_REGISTRY_INTERFACE.decodeFunctionResult(
      "getDODOPool",
      registryResult.data,
    )[0] as readonly string[],
    (listed) => canonicalAddress(String(listed)),
  ));
  return Object.freeze({
    ...prior,
    phase: "registry-binding" as const,
    listedPools,
  });
}

function decideIdentity(
  input: IdentityStepInput<DodoV2Candidate, unknown>,
  evidence: DodoV2IdentityEvidence | undefined,
): IdentityDecision<DodoV2Identity> {
  if (evidence === undefined || evidence.phase === "pool-behavior") {
    return { status: "continue" };
  }
  if (!evidence.listedPools.some((listed) => sameAddress(listed, evidence.pool))) {
    // The DODO V2 registry at the fixed cutoff does not list this pool:
    // chain-proven negative reverse binding.
    return {
      status: "chain-proven-rejected",
      reasonCode: "registry_reverse_binding_failed",
      evidenceRequestIds: [REGISTRY_REQUEST_ID],
    };
  }
  const registryBinding = Object.freeze({
    registry: evidence.registry,
    listedPool: evidence.pool,
  });
  const quoteActorBinding = Object.freeze({
    actor: DODO_V2_QUOTE_ACTOR,
    role: "verified-actor" as const,
    feeSemantics: "getUserFeeRate(actor)" as const,
    querySemantics: "querySellBase/querySellQuote(actor,effectiveInput)" as const,
    inputSemantics: "balance-reserve-mt-fee-v1" as const,
  });
  const evidenceHash = hashCanonical({
    registryBinding,
    pool: evidence.pool,
    baseToken: evidence.baseToken,
    quoteToken: evidence.quoteToken,
    quoteActorBinding,
    behaviorProofHash: evidence.behaviorProofHash,
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: DODO_V2_FAMILY_ID,
      lineageId: DODO_V2_REGISTRY_LINEAGE_ID,
      subject: evidence.pool,
      provenance: Object.freeze([Object.freeze({
        kind: "registry-reverse-behavior-proof",
        subject: evidence.registry,
        evidenceHash,
      })]),
      facts: Object.freeze({
        pool: evidence.pool,
        baseToken: evidence.baseToken,
        quoteToken: evidence.quoteToken,
        registryBinding,
        quoteActorBinding,
      }),
    }),
  };
}

function assertCandidateHints(
  candidate: DodoV2Candidate,
  baseToken: string,
  quoteToken: string,
): void {
  if (candidate.hintedTokenIn === null || candidate.hintedTokenOut === null) {
    return;
  }
  const forward = sameAddress(candidate.hintedTokenIn, baseToken) &&
    sameAddress(candidate.hintedTokenOut, quoteToken);
  const reverse = sameAddress(candidate.hintedTokenIn, quoteToken) &&
    sameAddress(candidate.hintedTokenOut, baseToken);
  if (!forward && !reverse) {
    throw new Error("dodo-v2 candidate token hints do not match pool behavior");
  }
}

function identityEvidence(value: unknown): DodoV2IdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "registry") ||
    !Object.hasOwn(value, "phase") ||
    ((value as { readonly phase?: unknown }).phase !== "pool-behavior" &&
      (value as { readonly phase?: unknown }).phase !== "registry-binding")
  ) {
    throw new Error("dodo-v2 identity received malformed evidence");
  }
  return value as DodoV2IdentityEvidence;
}

function ethersZeroAddress(): string {
  return "0x0000000000000000000000000000000000000000";
}
