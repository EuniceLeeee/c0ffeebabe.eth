import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { findRecentLogHit } from "../../recent-log-lookup.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import {
  LT_WITHDRAW_CALL_PATTERN_ID,
  LT_WITHDRAW_LOG_PATTERN_ID,
  LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID,
  LT_WITHDRAW_RECEIVER_SELECTOR,
  LT_WITHDRAW_SELECTOR,
  LT_WITHDRAW_TOPIC,
} from "./abi.js";
import { lower } from "./codec.js";

const OPAQUE_LABELS = Object.freeze([
  "yieldbasis-lt",
  "yield-basis-lt",
  "protocol:yieldbasis-lt",
]);

const CALL_PATTERNS = Object.freeze([
  Object.freeze({
    id: LT_WITHDRAW_CALL_PATTERN_ID,
    selector: LT_WITHDRAW_SELECTOR as `0x${string}`,
    signature: "withdraw(uint256,uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
  Object.freeze({
    id: LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID,
    selector: LT_WITHDRAW_RECEIVER_SELECTOR as `0x${string}`,
    signature: "withdraw(uint256,uint256,address)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
]);

const LOG_PATTERNS = Object.freeze([
  Object.freeze({
    id: LT_WITHDRAW_LOG_PATTERN_ID,
    topic: LT_WITHDRAW_TOPIC as `0x${string}`,
    signature: "Withdraw(address,address,address,uint256,uint256)",
  }),
]);

/** Tx-seed path: the nomination carries a candidate transaction hash. */
const fromTxSeed = createTxEvidenceNomination({
  opaqueLabels: OPAQUE_LABELS,
  callPatterns: CALL_PATTERNS,
  logPatterns: LOG_PATTERNS,
});

function matchesLabel(opaque: unknown): boolean {
  if (opaque === null || typeof opaque !== "object" || Array.isArray(opaque)) {
    return false;
  }
  const record = opaque as Readonly<Record<string, unknown>>;
  for (const key of ["adapter", "adapterId", "venueId", "familyId"]) {
    const value = record[key];
    if (typeof value === "string" &&
        OPAQUE_LABELS.includes(value.toLowerCase())) {
      return true;
    }
  }
  // A retained candidate may legitimately carry no label: the address is then
  // the only claim, and identity still has to reverse-prove the LevAMM binding.
  return Object.keys(record).length === 0;
}

function observationFromHit(
  hit: {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  },
  source: CanonicalSource,
): UnifiedObservation {
  return Object.freeze({
    kind: "log" as const,
    source,
    address: lower(hit.address),
    topics: Object.freeze(hit.topics.map((topic) => topic.toLowerCase())),
    data: hit.data.toLowerCase(),
    ...(hit.transactionHash === undefined
      ? {}
      : { transactionHash: hit.transactionHash.toLowerCase() }),
  });
}

/**
 * Plugin-owned nomination.
 *
 * Two shapes are accepted, because the framework hands this capability both:
 *   1. a transaction seed (`opaque.txHash` or a nested evidence txHash), which
 *      the shared helper re-reads into a real receipt/trace observation;
 *   2. a bare retained candidate with no tx hash (the documented "retained
 *      candidates legitimately omit evidence" case), for which this family
 *      locates a REAL recent Withdraw log emitted by the candidate address.
 *
 * Either way the observation is a real chain object. Admission still requires
 * the LevAMM/cryptopool mutual-reference proof in identity.ts; nothing here can
 * admit an instance, write an admitted flag or create a graph edge.
 */
export async function yieldBasisLtNominate(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    try {
      if (matchesLabel(nomination.opaque)) {
        const seeded = await fromTxSeed.nominate({
          nominations: Object.freeze([nomination]),
          source: input.source,
          provider: input.provider,
        });
        if (seeded.length > 0) {
          results.push(seeded[0]!);
          continue;
        }
      }
    } catch {
      // Fall through to the retained-log lookup below.
    }
    try {
      const hit = await findRecentLogHit({
        provider: input.provider,
        source: input.source,
        address: lower(nomination.address),
        topics: [LT_WITHDRAW_TOPIC],
      });
      if (hit === null) continue;
      results.push(observationFromHit(hit, input.source));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

export const yieldBasisLtNomination = Object.freeze({
  nominate: yieldBasisLtNominate,
});
