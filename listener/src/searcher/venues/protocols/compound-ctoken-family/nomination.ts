import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { findRecentLogHit } from "../../recent-log-lookup.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import {
  CTOKEN_REDEEM_CALL_PATTERN_ID,
  CTOKEN_REDEEM_LOG_PATTERN_ID,
  CTOKEN_REDEEM_SELECTOR,
  CTOKEN_REDEEM_TOPIC,
  CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID,
  CTOKEN_REDEEM_UNDERLYING_SELECTOR,
} from "./abi.js";
import { lower } from "./codec.js";

const OPAQUE_LABELS = Object.freeze([
  "compound-ctoken",
  "protocol:compound-ctoken",
]);

const CALL_PATTERNS = Object.freeze([
  Object.freeze({
    id: CTOKEN_REDEEM_CALL_PATTERN_ID,
    selector: CTOKEN_REDEEM_SELECTOR as `0x${string}`,
    signature: "redeem(uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
  Object.freeze({
    id: CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID,
    selector: CTOKEN_REDEEM_UNDERLYING_SELECTOR as `0x${string}`,
    signature: "redeemUnderlying(uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
]);

const LOG_PATTERNS = Object.freeze([
  Object.freeze({
    id: CTOKEN_REDEEM_LOG_PATTERN_ID,
    topic: CTOKEN_REDEEM_TOPIC as `0x${string}`,
    signature: "Redeem(address,uint256,uint256)",
  }),
]);

/** Tx-seed path: the nomination carries a candidate transaction hash. */
const fromTxSeed = createTxEvidenceNomination({
  opaqueLabels: OPAQUE_LABELS,
  callPatterns: CALL_PATTERNS,
  logPatterns: LOG_PATTERNS,
  // Successful redemptions emit Redeem. A transaction-wide first matching
  // call may belong to another market (or a reverted subtree), not this seed.
  traceTransaction: false,
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
  // the only claim, and identity still has to prove it through the Comptroller.
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
 *      locates a REAL recent Redeem log emitted by the candidate address.
 *
 * Either way the observation is a real chain object. Admission still requires
 * the Comptroller registry reverse-proof in identity.ts; nothing here can admit
 * an instance, write an admitted flag or create a graph edge.
 */
export async function compoundCTokenNominate(input: {
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
          provider: {
            ...input.provider,
            async getTransactionReceipt(hash) {
              const receipt = await input.provider.getTransactionReceipt(hash);
              return receipt === null ? null : {
                ...receipt,
                logs: receipt.logs.filter(log => lower(log.address) === lower(nomination.address)),
              };
            },
          },
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
        topics: [CTOKEN_REDEEM_TOPIC],
      });
      if (hit === null || lower(hit.address) !== lower(nomination.address)) continue;
      results.push(observationFromHit(hit, input.source));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

export const compoundCTokenNomination = Object.freeze({
  nominate: compoundCTokenNominate,
});
