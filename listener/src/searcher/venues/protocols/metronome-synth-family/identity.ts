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
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  lowerAddress,
  requireRuntimeCode,
  returnedResult,
} from "../standard-family/common.js";
import {
  METRONOME_SYNTH_POOL_INTERFACE,
  METRONOME_SYNTH_SAMPLE,
  METRONOME_SYNTH_SUPPORTED_TOKENS,
  metronomeSynthActiveQuoteId,
  metronomeSynthDirectedPairs,
  metronomeSynthDirectionsProjection,
  metronomeSynthUniqueAddresses,
} from "./shared.js";
import {
  METRONOME_SYNTH_FAMILY_ID,
  METRONOME_SYNTH_LINEAGE_ID,
} from "./manifest.js";
import type {
  MetronomeSynthCandidate,
  MetronomeSynthIdentity,
  MetronomeSynthIdentityEvidence,
} from "./types.js";

export const metronomeSynthIdentity = {
  variants: [{
    id: "active-synth-membership",
    kind: "standalone-contract" as const,
    lineageId: METRONOME_SYNTH_LINEAGE_ID,
    applies: () => true,
    requirements(
      input: IdentityStepInput<MetronomeSynthCandidate, unknown>,
    ) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return {
          transports: ["get-code" as const, "eth-call" as const],
        };
      }
      return { transports: ["eth-call" as const] };
    },
    buildRequests(input: IdentityStepInput<MetronomeSynthCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return membershipRequests(input.candidate);
      if (evidence.phase === "membership") return activeQuoteRequests(evidence);
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<MetronomeSynthCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): MetronomeSynthIdentityEvidence {
      const successful = input.results.map((result) => {
        if (!result.ok) {
          throw new Error(`Metronome synth identity unresolved: ${result.failure}`);
        }
        return result;
      });
      if (successful.length > 0) assertSameSource(successful);
      const prior = identityEvidence(input.step.evidence);
      return prior === undefined
        ? decodeMembership(input.step.candidate, input.results)
        : decodeActiveQuotes(prior, input.results);
    },
    decide(input: IdentityStepInput<MetronomeSynthCandidate, unknown>) {
      const proof = identityEvidence(input.evidence);
      if (proof === undefined) return { status: "continue" as const };
      if (proof.phase === "membership") {
        return proof.tokens.length >= 2
          ? { status: "continue" as const }
          : {
              status: "rejected" as const,
              reason: "metronome_synth_membership_failed",
            };
      }
      if (proof.directions.length === 0) {
        return {
          status: "rejected" as const,
          reason: "metronome_synth_quotes_failed",
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: METRONOME_SYNTH_FAMILY_ID,
          lineageId: METRONOME_SYNTH_LINEAGE_ID,
          subject: canonicalAddress(input.candidate.pool),
          provenance: Object.freeze([Object.freeze({
            kind: "metronome-active-membership-proof",
            subject: canonicalAddress(input.candidate.pool),
            evidenceHash: proof.behaviorProofHash,
          })]),
          pool: proof.pool,
          tokens: proof.tokens,
          directions: proof.directions,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.pool),
} satisfies IdentitySemantics<MetronomeSynthCandidate, MetronomeSynthIdentity>;

function identityEvidence(
  value: unknown,
): MetronomeSynthIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("phase" in value)) {
    throw new Error("Metronome synth identity evidence is malformed");
  }
  return value as MetronomeSynthIdentityEvidence;
}

function membershipRequests(
  candidate: MetronomeSynthCandidate,
): readonly AdapterRequest[] {
  const tokens = metronomeSynthUniqueAddresses([
    ...METRONOME_SYNTH_SUPPORTED_TOKENS,
    ...candidate.hintedTokens,
  ]);
  return Object.freeze([
    codeRequest("identity-pool-code", candidate.pool),
    ...tokens.map((token) => callRequest(
      `identity-member:${lowerAddress(token)}`,
      candidate.pool,
      METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionData(
        "doesSyntheticTokenExist",
        [token],
      ),
    )),
  ]);
}

function decodeMembership(
  candidate: MetronomeSynthCandidate,
  results: readonly AdapterRequestResult[],
): MetronomeSynthIdentityEvidence {
  requireRuntimeCode(results, "identity-pool-code");
  const tokens = metronomeSynthUniqueAddresses([
    ...METRONOME_SYNTH_SUPPORTED_TOKENS,
    ...candidate.hintedTokens,
  ]).filter((token) => Boolean(
    METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionResult(
      "doesSyntheticTokenExist",
      returnedResult(results, `identity-member:${lowerAddress(token)}`).data,
    )[0],
  ));
  return Object.freeze({
    phase: "membership" as const,
    pool: canonicalAddress(candidate.pool),
    tokens: Object.freeze(tokens),
  });
}

function activeQuoteRequests(
  evidence: Extract<
    MetronomeSynthIdentityEvidence,
    { readonly phase: "membership" }
  >,
): readonly AdapterRequest[] {
  return Object.freeze(
    metronomeSynthDirectedPairs(evidence.tokens).map((direction) =>
      callRequest(
        metronomeSynthActiveQuoteId(direction),
        evidence.pool,
        METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionData("quoteSwapOut", [
          direction.tokenIn,
          direction.tokenOut,
          METRONOME_SYNTH_SAMPLE,
        ]),
      )
    ),
  );
}

function decodeActiveQuotes(
  membership: MetronomeSynthIdentityEvidence,
  results: readonly AdapterRequestResult[],
): MetronomeSynthIdentityEvidence {
  if (membership.phase !== "membership") return membership;
  const directions = metronomeSynthDirectedPairs(membership.tokens).filter(
    (direction) => {
      const result = returnedResult(
        results,
        metronomeSynthActiveQuoteId(direction),
      );
      const decoded = METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionResult(
        "quoteSwapOut",
        result.data,
      );
      return BigInt(decoded[0]) > 0n;
    },
  );
  return Object.freeze({
    phase: "active" as const,
    pool: membership.pool,
    tokens: membership.tokens,
    directions: Object.freeze(
      directions.map((direction) => Object.freeze(direction)),
    ),
    behaviorProofHash: hashCanonical({
      pool: lowerAddress(membership.pool),
      tokens: membership.tokens.map(lowerAddress).sort(),
      directions: metronomeSynthDirectionsProjection(directions),
    }),
  });
}
