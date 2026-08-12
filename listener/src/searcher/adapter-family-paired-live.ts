import {
  blindProductionAuditHash,
  blindProductionDeepSeal,
} from "./blind-production-audit.js";

export const PAIRED_LIVE_SCHEMA_VERSION = 1 as const;
export const PAIRED_LIVE_SIDES = Object.freeze([
  "baseline",
  "challenger",
] as const);
export const PAIRED_LIVE_TERMINAL_DEADLINE_MS = 10_000 as const;
export const PAIRED_LIVE_COVERAGE_FLOOR = 0.95 as const;

const ZERO_SHA256 = "0".repeat(64);
const JOURNAL_AUTHORITY = Symbol("paired-live-journal-authority");
const trustedEligibilityRules =
  new WeakSet<FrozenPairedLiveEligibilityRule>();
const trustedRuleClocks =
  new WeakMap<FrozenPairedLiveEligibilityRule, PairedLiveTrustedClock>();
const trustedRuleNowMs =
  new WeakMap<FrozenPairedLiveEligibilityRule, () => number>();
const trustedJournalSeals = new WeakSet<EligibleHeadJournalSeal>();
const trustedBrokerSeals = new WeakSet<PairedLiveBrokerSeal>();
const trustedBrokerSealExtractors =
  new WeakMap<PairedLiveBrokerSeal, PairedLiveSemanticExtractor>();
const trustedReconciliations =
  new WeakSet<PairedLiveCanonicalReconciliation>();

export type PairedLiveSide = typeof PAIRED_LIVE_SIDES[number];

/**
 * Authority implementations are the primitive's trust boundary. A live
 * runner must construct and retain them outside both A/B producers; identity
 * hashes bind configured authorities but are not remote attestation.
 */
export interface PairedLiveTrustedClock {
  readonly identitySha256: string;
  nowMs(): number;
}

export interface PairedLiveSourceHeader {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly sourceGeneration: number;
}

export interface PairedLiveCanonicalHeaderSubscription {
  readonly identitySha256: string;
  subscribe(
    listener: (header: PairedLiveSourceHeader) => void,
  ): () => void;
}

export interface PairedLiveFinalCanonicalSource {
  readonly identitySha256: string;
  enumerateFinalCanonicalHeaders(
    range: PairedLiveBlockRange,
  ): readonly FinalCanonicalHeader[];
}

export interface PairedLiveBlockRange {
  readonly first: number;
  readonly last: number;
}

export interface PairedLiveObservationWindow {
  readonly opensAtMs: number;
  readonly closesAtMs: number;
}

export interface PairedLiveSharedInputs {
  readonly resolvedConfigSha256: string;
  readonly universeSha256: string;
  readonly backendIdentitySha256: string;
  readonly evPolicySha256: string;
  readonly submissionPolicySha256: string;
  readonly semanticExtractorSha256: string;
}

export interface PairedLiveEligibilityRuleInput {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly blockRange: PairedLiveBlockRange;
  readonly observationWindow: PairedLiveObservationWindow;
  readonly warmupThroughBlock: number;
  readonly catchUpThroughBlock: number;
  readonly sourceKind: "local-canonical";
  readonly reorgPolicy: "include-all-observed-generations";
  readonly terminalDeadlineMs: typeof PAIRED_LIVE_TERMINAL_DEADLINE_MS;
  readonly absoluteHeadCoverageFloor: typeof PAIRED_LIVE_COVERAGE_FLOOR;
  readonly relativeHeadCoverageFloor: typeof PAIRED_LIVE_COVERAGE_FLOOR;
  readonly systemicFailureRepeatThreshold: number;
  readonly trustedClockIdentitySha256: string;
  readonly headerAuditorSourceIdentitySha256: string;
  readonly reconciliationSourceIdentitySha256: string;
  readonly sharedInputs: PairedLiveSharedInputs;
  readonly approvedAdditionIds: readonly string[];
}

export interface FrozenPairedLiveEligibilityRule
  extends PairedLiveEligibilityRuleInput {
  readonly sealedAtMs: number;
  readonly eligibilityRuleSha256: string;
}

export interface PairedLiveHeaderObservation
  extends PairedLiveSourceHeader {
  readonly observedAtMs: number;
}

export interface EligibleHeadJournalEntry
  extends PairedLiveHeaderObservation {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly sequence: number;
  readonly previousEntrySha256: string;
  readonly entrySha256: string;
}

export interface EligibleHeadJournalSeal {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly entryCount: number;
  readonly chainHeadSha256: string;
  readonly journalSha256: string;
  readonly entries: readonly EligibleHeadJournalEntry[];
}

export interface TrustedEligibleHeadsJournal {
  readonly eligibilityRuleSha256: string;
  entry(entrySha256: string): EligibleHeadJournalEntry | undefined;
  entries(): readonly EligibleHeadJournalEntry[];
  seal(): EligibleHeadJournalSeal;
  isSealed(): boolean;
}

export type HeaderAuditResult =
  | {
      readonly eligible: true;
      readonly entry: EligibleHeadJournalEntry;
    }
  | {
      readonly eligible: false;
      readonly reason:
        | "before_block_range"
        | "after_block_range"
        | "before_observation_window"
        | "after_observation_window";
    };

export interface PairedLiveDeliveryEnvelope {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly journalEntrySha256: string;
  readonly sequence: number;
  readonly header: {
    readonly number: number;
    readonly hash: string;
    readonly parentHash: string;
    readonly sourceGeneration: number;
    readonly observedAtMs: number;
  };
  readonly deadlineAtMs: number;
  readonly sharedInputSha256: string;
  readonly envelopeSha256: string;
}

export interface PairedLiveDeliveryReceipt {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly side: PairedLiveSide;
  readonly journalEntrySha256: string;
  readonly envelopeSha256: string;
  readonly deliveredAtMs: number;
  readonly receiptSha256: string;
}

export interface PairedLiveAckReceipt {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly side: PairedLiveSide;
  readonly journalEntrySha256: string;
  readonly envelopeSha256: string;
  readonly deliveryReceiptSha256: string;
  readonly runtimeSharedInputSha256: string;
  readonly acknowledgedAtMs: number;
  readonly receiptSha256: string;
}

export interface PairedLiveTerminalTelemetry {
  readonly calls: number;
  readonly batches: number;
  readonly familyCounts: Readonly<Record<string, number>>;
}

export interface PairedLiveAdditionEvidence {
  readonly id: string;
  readonly semantics: unknown;
}

export type PairedLiveTerminalInput =
  | {
      readonly type: "scanner_done";
      readonly outcome: "no_candidate";
      readonly commonSemantics: unknown;
      readonly additions: readonly PairedLiveAdditionEvidence[];
      readonly telemetry: PairedLiveTerminalTelemetry;
    }
  | {
      readonly type: "ev_decision";
      readonly outcome: "candidate";
      readonly commonSemantics: unknown;
      readonly additions: readonly PairedLiveAdditionEvidence[];
      readonly telemetry: PairedLiveTerminalTelemetry;
    }
  | {
      readonly type: "skipped_busy" | "timeout" | "incomplete";
      readonly failureCategory: string;
      readonly telemetry: PairedLiveTerminalTelemetry;
    };

export interface PairedLiveSemanticExtractor {
  readonly identitySha256: string;
  extract(input: Readonly<{
    side: PairedLiveSide;
    envelope: PairedLiveDeliveryEnvelope;
    rawOutput: unknown;
  }>): PairedLiveTerminalInput;
}

export type PairedLiveTerminalStatus =
  | "scanner_done_no_candidate"
  | "ev_decision_candidate"
  | "skipped_busy"
  | "timeout"
  | "incomplete";

export interface PairedLiveTerminalReceipt {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly side: PairedLiveSide;
  readonly journalEntrySha256: string;
  readonly envelopeSha256: string;
  readonly ackReceiptSha256: string;
  readonly status: PairedLiveTerminalStatus;
  readonly completedAtMs: number;
  readonly rawOutput: unknown;
  readonly rawOutputSha256: string;
  readonly commonSemanticsSha256: string | null;
  readonly additions: readonly {
    readonly id: string;
    readonly semanticsSha256: string;
  }[];
  readonly failureCategory: string | null;
  readonly telemetry: PairedLiveTerminalTelemetry;
  readonly receiptSha256: string;
}

export interface PairedLiveBrokerSeal {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly deliveryReceipts: readonly PairedLiveDeliveryReceipt[];
  readonly ackReceipts: readonly PairedLiveAckReceipt[];
  readonly terminalReceipts: readonly PairedLiveTerminalReceipt[];
  readonly receiptSetSha256: string;
}

export interface FinalCanonicalHeader {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
}

export interface PairedLiveCanonicalReconciliation {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly journalSha256: string;
  readonly reconciliationSourceIdentitySha256: string;
  readonly capturedAtMs: number;
  readonly status: "valid" | "invalid";
  readonly errors: readonly string[];
  readonly finalCanonicalHeaders: readonly FinalCanonicalHeader[];
  readonly canonicalJournalEntries: readonly {
    readonly number: number;
    readonly hash: string;
    readonly journalEntrySha256: string | null;
  }[];
  readonly orphanOrReplacementEntrySha256s: readonly string[];
  readonly denominatorEntrySha256s: readonly string[];
  readonly finalCanonicalSha256: string;
  readonly reconciliationSha256: string;
}

export type PairedLiveHeadFailureCategory =
  | "missing_delivery_receipt"
  | "missing_ack_receipt"
  | "missing_terminal"
  | "late_terminal"
  | string;

export interface PairedLiveHeadResult {
  readonly journalEntrySha256: string;
  readonly number: number;
  readonly hash: string;
  readonly sourceGeneration: number;
  readonly status: "on_time_terminal" | "failed";
  readonly terminalStatus: PairedLiveTerminalStatus | null;
  readonly terminalLatencyMs: number | null;
  readonly accountedLatencyMs: number;
  readonly failureCategory: PairedLiveHeadFailureCategory | null;
}

export interface PairedLiveSideReport {
  readonly eligibleHeads: number;
  readonly onTimeTerminalHeads: number;
  readonly noCandidateHeads: number;
  readonly candidateHeads: number;
  readonly headCoverage: number;
  readonly throughputHeadsPerSecond: number;
  readonly terminalLatencyMs: {
    readonly sampleCount: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly timingPass: boolean;
  };
  readonly failureCategories: Readonly<Record<string, number>>;
  readonly calls: number;
  readonly batches: number;
  readonly familyDistribution: Readonly<Record<string, number>>;
  readonly headResults: readonly PairedLiveHeadResult[];
}

export interface PairedLiveReport {
  readonly schemaVersion: typeof PAIRED_LIVE_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly eligibilityRuleSha256: string;
  readonly journalSha256: string;
  readonly reconciliationSha256: string;
  readonly receiptSetSha256: string;
  readonly denominator: {
    readonly eligibleHeads: number;
    readonly entrySha256s: readonly string[];
  };
  readonly canonicalReconciliationStatus: "valid" | "invalid";
  readonly baseline: PairedLiveSideReport;
  readonly challenger: PairedLiveSideReport;
  readonly exactSemantics: {
    readonly status: "pass" | "fail";
    readonly comparedHeads: number;
    readonly mismatchEntrySha256s: readonly string[];
    readonly additionViolations: readonly string[];
    readonly challengerAdditions: Readonly<Record<string, number>>;
  };
  readonly floors: {
    readonly absoluteFloor: number;
    readonly baselineAbsolutePass: boolean;
    readonly challengerAbsolutePass: boolean;
    readonly baselineTimingPass: boolean;
    readonly challengerTimingPass: boolean;
    readonly relativeFloor: number;
    readonly requiredChallengerHeadCoverage: number;
    readonly challengerRelativeHeadCoveragePass: boolean;
    readonly completedHeads95Pass: boolean;
    readonly baselineCandidateHeads: number;
    readonly reproducedBaselineCandidateHeads: number;
    readonly candidateCoverage: number;
    readonly candidateCoverage95Pass: boolean;
    readonly throughput95Pass: boolean;
  };
  readonly challengerOnlyRepeatedFailureCategories: readonly string[];
  readonly verdict:
    | "pass"
    | "fail"
    | "relative_diagnostic_only"
    | "invalid";
  readonly pairedLivePass: boolean;
  readonly mergeReady: false;
  readonly mergeReadinessReason:
    "requires_independent_six_stage_evidence";
  readonly reportSha256: string;
}

export function freezePairedLiveEligibilityRule(
  input: PairedLiveEligibilityRuleInput,
  clock: PairedLiveTrustedClock,
): FrozenPairedLiveEligibilityRule {
  assertExactKeys(input, [
    "absoluteHeadCoverageFloor",
    "approvedAdditionIds",
    "blockRange",
    "catchUpThroughBlock",
    "experimentId",
    "headerAuditorSourceIdentitySha256",
    "observationWindow",
    "reconciliationSourceIdentitySha256",
    "relativeHeadCoverageFloor",
    "reorgPolicy",
    "schemaVersion",
    "sharedInputs",
    "sourceKind",
    "systemicFailureRepeatThreshold",
    "terminalDeadlineMs",
    "trustedClockIdentitySha256",
    "warmupThroughBlock",
  ], "paired-live eligibility rule");
  assertExactKeys(input.blockRange, ["first", "last"], "paired-live block range");
  assertExactKeys(
    input.observationWindow,
    ["closesAtMs", "opensAtMs"],
    "paired-live observation window",
  );
  assertExactKeys(input.sharedInputs, [
    "backendIdentitySha256",
    "evPolicySha256",
    "resolvedConfigSha256",
    "semanticExtractorSha256",
    "submissionPolicySha256",
    "universeSha256",
  ], "paired-live shared inputs");
  assert(
    input.schemaVersion === PAIRED_LIVE_SCHEMA_VERSION,
    "paired-live eligibility schema",
  );
  assert(nonempty(input.experimentId), "paired-live experiment id");
  assertSafeInteger(input.blockRange.first, "paired-live first block");
  assertSafeInteger(input.blockRange.last, "paired-live last block");
  assert(
    input.blockRange.first <= input.blockRange.last,
    "paired-live block range order",
  );
  assertSafeInteger(input.warmupThroughBlock, "paired-live warmup block");
  assertSafeInteger(input.catchUpThroughBlock, "paired-live catch-up block");
  assert(
    input.warmupThroughBlock < input.blockRange.first &&
      input.catchUpThroughBlock < input.blockRange.first,
    "paired-live warmup/catch-up must end before the measured range",
  );
  assert(
    input.catchUpThroughBlock >= input.warmupThroughBlock,
    "paired-live catch-up precedes warmup",
  );
  assertTimestamp(
    input.observationWindow.opensAtMs,
    "paired-live observation opens",
  );
  assertTimestamp(
    input.observationWindow.closesAtMs,
    "paired-live observation closes",
  );
  assert(
    input.observationWindow.opensAtMs < input.observationWindow.closesAtMs,
    "paired-live observation window order",
  );
  assert(
    input.sourceKind === "local-canonical",
    "paired-live source kind",
  );
  assert(
    input.reorgPolicy === "include-all-observed-generations",
    "paired-live reorg policy",
  );
  assert(
    input.terminalDeadlineMs === PAIRED_LIVE_TERMINAL_DEADLINE_MS,
    "paired-live terminal deadline must equal 10000ms",
  );
  assert(
    input.absoluteHeadCoverageFloor === PAIRED_LIVE_COVERAGE_FLOOR,
    "paired-live absolute coverage floor must equal 0.95",
  );
  assert(
    input.relativeHeadCoverageFloor === PAIRED_LIVE_COVERAGE_FLOOR,
    "paired-live relative coverage floor must equal 0.95",
  );
  assert(
    input.systemicFailureRepeatThreshold === 2,
    "paired-live systemic failure threshold must equal 2",
  );
  assertSha256(
    input.trustedClockIdentitySha256,
    "paired-live trusted clock identity",
  );
  assertSha256(
    input.headerAuditorSourceIdentitySha256,
    "paired-live header auditor source identity",
  );
  assertSha256(
    input.reconciliationSourceIdentitySha256,
    "paired-live reconciliation source identity",
  );
  assert(
    input.headerAuditorSourceIdentitySha256 !==
      input.reconciliationSourceIdentitySha256,
    "paired-live final canonical source must be independent",
  );
  assertSha256(clock.identitySha256, "paired-live clock authority");
  assert(
    clock.identitySha256 === input.trustedClockIdentitySha256,
    "paired-live trusted clock identity mismatch",
  );
  for (const [name, value] of Object.entries(input.sharedInputs)) {
    assertSha256(value, `paired-live shared input ${name}`);
  }
  const approvedAdditionIds = [...input.approvedAdditionIds].sort();
  assertUnique(approvedAdditionIds, "paired-live approved addition");
  for (const id of approvedAdditionIds) {
    assert(nonempty(id), "paired-live approved addition id");
  }
  const normalized = {
    ...input,
    blockRange: { ...input.blockRange },
    observationWindow: { ...input.observationWindow },
    sharedInputs: normalizeSharedInputs(input.sharedInputs),
    approvedAdditionIds,
  };
  const authorityNowMs = clock.nowMs.bind(clock);
  const sealedAtMs = authorityNowMs();
  assertTimestamp(sealedAtMs, "paired-live rule sealed_at");
  assert(
    sealedAtMs < input.observationWindow.opensAtMs,
    "paired-live rule must be sealed before the observation window",
  );
  const sealed = {
    ...normalized,
    sealedAtMs,
  };
  const rule = deepFreeze({
    ...sealed,
    eligibilityRuleSha256: blindProductionAuditHash(sealed),
  });
  let lastTrustedNowMs = sealedAtMs;
  const trustedNowMs = (): number => {
    const current = authorityNowMs();
    assertTimestamp(current, "paired-live trusted clock");
    if (current < lastTrustedNowMs) return lastTrustedNowMs;
    lastTrustedNowMs = current;
    return current;
  };
  trustedEligibilityRules.add(rule);
  trustedRuleClocks.set(rule, clock);
  trustedRuleNowMs.set(rule, trustedNowMs);
  return rule;
}

const trustedJournalClocks =
  new WeakMap<TrustedEligibleHeadsJournal, PairedLiveTrustedClock>();
const trustedJournalNowMs =
  new WeakMap<TrustedEligibleHeadsJournal, () => number>();

class EligibleHeadsJournal implements TrustedEligibleHeadsJournal {
  readonly eligibilityRuleSha256: string;
  private readonly mutableEntries: EligibleHeadJournalEntry[] = [];
  private readonly bySha256 = new Map<string, EligibleHeadJournalEntry>();
  private sealed: EligibleHeadJournalSeal | null = null;

  constructor(
    readonly rule: FrozenPairedLiveEligibilityRule,
    clock: PairedLiveTrustedClock,
    authority: typeof JOURNAL_AUTHORITY,
  ) {
    assert(
      authority === JOURNAL_AUTHORITY,
      "eligible-heads journal requires trusted auditor authority",
    );
    validateFrozenEligibilityRule(rule);
    assert(
      clock.identitySha256 === rule.trustedClockIdentitySha256,
      "eligible-heads journal clock identity mismatch",
    );
    this.eligibilityRuleSha256 = rule.eligibilityRuleSha256;
  }

  append(
    header: PairedLiveHeaderObservation,
    authority: typeof JOURNAL_AUTHORITY,
  ): EligibleHeadJournalEntry {
    assert(
      authority === JOURNAL_AUTHORITY,
      "eligible-heads journal append requires trusted auditor authority",
    );
    if (this.sealed) throw new Error("eligible-heads journal is sealed");
    validateHeaderObservation(header);
    assert(
      header.number >= this.rule.blockRange.first &&
        header.number <= this.rule.blockRange.last,
      "eligible-heads journal rejects an out-of-range header",
    );
    assert(
      header.observedAtMs >= this.rule.observationWindow.opensAtMs &&
        header.observedAtMs < this.rule.observationWindow.closesAtMs,
      "eligible-heads journal rejects an out-of-window header",
    );
    const previous = this.mutableEntries.at(-1);
    if (previous) {
      assert(
        header.observedAtMs >= previous.observedAtMs,
        "eligible-heads journal observation time moved backwards",
      );
      assert(
        header.sourceGeneration >= previous.sourceGeneration,
        "eligible-heads journal source generation moved backwards",
      );
    }
    const normalizedHeader = normalizeHeaderObservation(header);
    const sameNumber = this.mutableEntries.filter(
      (entry) => entry.number === normalizedHeader.number,
    );
    assert(
      !sameNumber.some(
        (entry) =>
          entry.hash === normalizedHeader.hash &&
          entry.sourceGeneration === normalizedHeader.sourceGeneration,
      ),
      "eligible-heads journal duplicate header generation",
    );
    if (sameNumber.length > 0) {
      const maxGeneration = Math.max(
        ...sameNumber.map((entry) => entry.sourceGeneration),
      );
      assert(
        normalizedHeader.sourceGeneration > maxGeneration,
        "eligible-heads journal replacement must advance source generation",
      );
    }
    const predecessor = [...this.mutableEntries].reverse().find(
      (entry) =>
        entry.sourceGeneration === normalizedHeader.sourceGeneration &&
        entry.number === normalizedHeader.number - 1,
    );
    if (predecessor) {
      assert(
        predecessor.hash === normalizedHeader.parentHash,
        "eligible-heads journal same-generation parent mismatch",
      );
    }
    const entryWithoutHash = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.rule.experimentId,
      eligibilityRuleSha256: this.rule.eligibilityRuleSha256,
      sequence: this.mutableEntries.length,
      previousEntrySha256:
        previous?.entrySha256 ?? ZERO_SHA256,
      ...normalizedHeader,
    };
    const entry = deepFreeze({
      ...entryWithoutHash,
      entrySha256: blindProductionAuditHash(entryWithoutHash),
    });
    this.mutableEntries.push(entry);
    this.bySha256.set(entry.entrySha256, entry);
    return entry;
  }

  entry(entrySha256: string): EligibleHeadJournalEntry | undefined {
    return this.bySha256.get(entrySha256);
  }

  entries(): readonly EligibleHeadJournalEntry[] {
    return Object.freeze([...this.mutableEntries]);
  }

  seal(): EligibleHeadJournalSeal {
    if (this.sealed) return this.sealed;
    const entries = Object.freeze([...this.mutableEntries]);
    const common = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.rule.experimentId,
      eligibilityRuleSha256: this.rule.eligibilityRuleSha256,
      entryCount: entries.length,
      chainHeadSha256: entries.at(-1)?.entrySha256 ?? ZERO_SHA256,
      entries,
    };
    this.sealed = deepFreeze({
      ...common,
      journalSha256: blindProductionAuditHash(common),
    });
    trustedJournalSeals.add(this.sealed);
    return this.sealed;
  }

  isSealed(): boolean {
    return this.sealed !== null;
  }
}

function createTrustedJournalFacade(
  writer: EligibleHeadsJournal,
  clock: PairedLiveTrustedClock,
  nowMs: () => number,
): TrustedEligibleHeadsJournal {
  const facade: TrustedEligibleHeadsJournal = Object.freeze({
    eligibilityRuleSha256: writer.eligibilityRuleSha256,
    entry: (entrySha256: string) => writer.entry(entrySha256),
    entries: () => writer.entries(),
    seal: () => writer.seal(),
    isSealed: () => writer.isSealed(),
  });
  trustedJournalClocks.set(facade, clock);
  trustedJournalNowMs.set(facade, nowMs);
  return facade;
}

export class TrustedPairedLiveHeaderAuditor {
  readonly #mutableResults: HeaderAuditResult[] = [];
  readonly #unsubscribe: () => void;
  readonly #writableJournal: EligibleHeadsJournal;
  readonly #journal: TrustedEligibleHeadsJournal;
  readonly #rule: FrozenPairedLiveEligibilityRule;
  readonly #nowMs: () => number;

  constructor(
    rule: FrozenPairedLiveEligibilityRule,
    source: PairedLiveCanonicalHeaderSubscription,
    clock: PairedLiveTrustedClock,
  ) {
    validateFrozenEligibilityRule(rule);
    assert(
      source.identitySha256 === rule.headerAuditorSourceIdentitySha256,
      "paired-live header auditor source identity mismatch",
    );
    assert(
      clock.identitySha256 === rule.trustedClockIdentitySha256,
      "paired-live header auditor clock identity mismatch",
    );
    assert(
      trustedRuleClocks.get(rule) === clock,
      "paired-live header auditor did not reuse the rule-sealing clock",
    );
    this.#rule = rule;
    const trustedNowMs = trustedRuleNowMs.get(rule);
    assert(trustedNowMs, "paired-live rule has no trusted clock capability");
    this.#nowMs = trustedNowMs;
    this.#writableJournal = new EligibleHeadsJournal(
      rule,
      clock,
      JOURNAL_AUTHORITY,
    );
    this.#journal = createTrustedJournalFacade(
      this.#writableJournal,
      clock,
      trustedNowMs,
    );
    const unsubscribe = source.subscribe((header) => {
      this.#mutableResults.push(this.#captureCanonicalHeader(header));
    });
    assert(
      typeof unsubscribe === "function",
      "paired-live header source did not return an unsubscribe function",
    );
    this.#unsubscribe = unsubscribe;
    Object.freeze(this);
  }

  get rule(): FrozenPairedLiveEligibilityRule {
    return this.#rule;
  }

  get journal(): TrustedEligibleHeadsJournal {
    return this.#journal;
  }

  auditResults(): readonly HeaderAuditResult[] {
    return Object.freeze([...this.#mutableResults]);
  }

  close(): void {
    this.#unsubscribe();
  }

  #captureCanonicalHeader(
    sourceHeader: PairedLiveSourceHeader,
  ): HeaderAuditResult {
    validateSourceHeader(sourceHeader);
    const header: PairedLiveHeaderObservation = {
      ...sourceHeader,
      observedAtMs: this.#nowMs(),
    };
    validateHeaderObservation(header);
    if (header.number < this.#rule.blockRange.first) {
      return Object.freeze({
        eligible: false,
        reason: "before_block_range",
      });
    }
    if (header.number > this.#rule.blockRange.last) {
      return Object.freeze({
        eligible: false,
        reason: "after_block_range",
      });
    }
    if (header.observedAtMs < this.#rule.observationWindow.opensAtMs) {
      return Object.freeze({
        eligible: false,
        reason: "before_observation_window",
      });
    }
    if (header.observedAtMs >= this.#rule.observationWindow.closesAtMs) {
      return Object.freeze({
        eligible: false,
        reason: "after_observation_window",
      });
    }
    return Object.freeze({
      eligible: true,
      entry: this.#writableJournal.append(header, JOURNAL_AUTHORITY),
    });
  }
}

export class ImmutablePairedLiveDeliveryBroker {
  readonly #envelopes =
    new Map<string, PairedLiveDeliveryEnvelope>();
  readonly #deliveryReceipts =
    new Map<string, PairedLiveDeliveryReceipt>();
  readonly #ackReceipts =
    new Map<string, PairedLiveAckReceipt>();
  readonly #terminalReceipts =
    new Map<string, PairedLiveTerminalReceipt>();
  #sealed: PairedLiveBrokerSeal | null = null;
  readonly #rule: FrozenPairedLiveEligibilityRule;
  readonly #journal: TrustedEligibleHeadsJournal;
  readonly #nowMs: () => number;
  readonly #semanticExtractor: PairedLiveSemanticExtractor;

  constructor(
    rule: FrozenPairedLiveEligibilityRule,
    journal: TrustedEligibleHeadsJournal,
    semanticExtractor: PairedLiveSemanticExtractor,
  ) {
    validateFrozenEligibilityRule(rule);
    const clock = trustedJournalClocks.get(journal);
    assert(
      clock,
      "paired-live broker requires a trusted auditor journal",
    );
    assert(
      trustedRuleClocks.get(rule) === clock,
      "paired-live broker did not reuse the rule-sealing clock",
    );
    const nowMs = trustedJournalNowMs.get(journal);
    assert(nowMs, "paired-live broker journal has no trusted clock capability");
    assertSha256(
      semanticExtractor.identitySha256,
      "paired-live semantic extractor identity",
    );
    assert(
      semanticExtractor.identitySha256 ===
      rule.sharedInputs.semanticExtractorSha256,
      "paired-live semantic extractor identity mismatch",
    );
    assert(
      journal.eligibilityRuleSha256 === rule.eligibilityRuleSha256,
      "paired-live broker journal/rule mismatch",
    );
    this.#rule = rule;
    this.#journal = journal;
    this.#nowMs = nowMs;
    this.#semanticExtractor = Object.freeze({
      identitySha256: semanticExtractor.identitySha256,
      extract: semanticExtractor.extract.bind(semanticExtractor),
    });
    Object.freeze(this);
  }

  get rule(): FrozenPairedLiveEligibilityRule {
    return this.#rule;
  }

  get journal(): TrustedEligibleHeadsJournal {
    return this.#journal;
  }

  deliver(
    side: PairedLiveSide,
    journalEntrySha256: string,
  ): Readonly<{
    envelope: PairedLiveDeliveryEnvelope;
    receipt: PairedLiveDeliveryReceipt;
  }> {
    this.#assertOpen();
    assertSide(side);
    const deliveredAtMs = this.#nowMs();
    assertTimestamp(deliveredAtMs, "paired-live delivery time");
    const entry = this.#requiredEntry(journalEntrySha256);
    assert(
      deliveredAtMs >= entry.observedAtMs,
      "paired-live delivery precedes header observation",
    );
    const key = receiptKey(side, journalEntrySha256);
    assert(
      !this.#deliveryReceipts.has(key),
      "paired-live duplicate delivery receipt",
    );
    const envelope = this.#envelope(entry);
    const receiptWithoutHash = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.#rule.experimentId,
      side,
      journalEntrySha256,
      envelopeSha256: envelope.envelopeSha256,
      deliveredAtMs,
    };
    const receipt = deepFreeze({
      ...receiptWithoutHash,
      receiptSha256: blindProductionAuditHash(receiptWithoutHash),
    });
    this.#deliveryReceipts.set(key, receipt);
    return Object.freeze({ envelope, receipt });
  }

  acknowledge(input: {
    readonly side: PairedLiveSide;
    readonly journalEntrySha256: string;
    readonly envelopeSha256: string;
    readonly runtimeSharedInputs: PairedLiveSharedInputs;
  }): PairedLiveAckReceipt {
    this.#assertOpen();
    assertExactKeys(input, [
      "envelopeSha256",
      "journalEntrySha256",
      "runtimeSharedInputs",
      "side",
    ], "paired-live acknowledgement");
    assertSide(input.side);
    const acknowledgedAtMs = this.#nowMs();
    assertTimestamp(acknowledgedAtMs, "paired-live acknowledgement time");
    const key = receiptKey(input.side, input.journalEntrySha256);
    const delivery = this.#deliveryReceipts.get(key);
    assert(delivery, "paired-live acknowledgement has no delivery receipt");
    assert(
      delivery.envelopeSha256 === input.envelopeSha256,
      "paired-live acknowledgement envelope mismatch",
    );
    assert(
      acknowledgedAtMs >= delivery.deliveredAtMs,
      "paired-live acknowledgement precedes delivery",
    );
    const runtimeSharedInputSha256 =
      blindProductionAuditHash(normalizeSharedInputs(
        input.runtimeSharedInputs,
      ));
    assert(
      runtimeSharedInputSha256 ===
        blindProductionAuditHash(this.#rule.sharedInputs),
      "paired-live acknowledgement runtime inputs differ from the frozen shared inputs",
    );
    assert(
      !this.#ackReceipts.has(key),
      "paired-live duplicate acknowledgement",
    );
    const receiptWithoutHash = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.#rule.experimentId,
      side: input.side,
      journalEntrySha256: input.journalEntrySha256,
      envelopeSha256: input.envelopeSha256,
      deliveryReceiptSha256: delivery.receiptSha256,
      runtimeSharedInputSha256,
      acknowledgedAtMs,
    };
    const receipt = deepFreeze({
      ...receiptWithoutHash,
      receiptSha256: blindProductionAuditHash(receiptWithoutHash),
    });
    this.#ackReceipts.set(key, receipt);
    return receipt;
  }

  recordTerminal(
    side: PairedLiveSide,
    journalEntrySha256: string,
    rawOutput: unknown,
  ): PairedLiveTerminalReceipt {
    this.#assertOpen();
    assertSide(side);
    const key = receiptKey(side, journalEntrySha256);
    const delivery = this.#deliveryReceipts.get(key);
    const ack = this.#ackReceipts.get(key);
    const envelope = this.#envelopes.get(journalEntrySha256);
    assert(delivery, "paired-live terminal has no delivery receipt");
    assert(ack, "paired-live terminal has no acknowledgement receipt");
    assert(envelope, "paired-live terminal has no immutable envelope");
    assert(
      !this.#terminalReceipts.has(key),
      "paired-live duplicate terminal",
    );
    const sealedRawOutput = blindProductionDeepSeal(rawOutput);
    const input = this.#semanticExtractor.extract(deepFreeze({
      side,
      envelope,
      rawOutput: sealedRawOutput,
    }));
    const projection = terminalProjection(input);
    const completedAtMs = this.#nowMs();
    assertTimestamp(completedAtMs, "paired-live terminal receipt time");
    assert(
      completedAtMs >= ack.acknowledgedAtMs,
      "paired-live terminal precedes acknowledgement",
    );
    const receiptWithoutHash = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.#rule.experimentId,
      side,
      journalEntrySha256,
      envelopeSha256: delivery.envelopeSha256,
      ackReceiptSha256: ack.receiptSha256,
      status: projection.status,
      completedAtMs,
      rawOutput: sealedRawOutput,
      rawOutputSha256: blindProductionAuditHash(sealedRawOutput),
      commonSemanticsSha256: projection.commonSemanticsSha256,
      additions: projection.additions,
      failureCategory: projection.failureCategory,
      telemetry: projection.telemetry,
    };
    const receipt = deepFreeze({
      ...receiptWithoutHash,
      receiptSha256: blindProductionAuditHash(receiptWithoutHash),
    });
    this.#terminalReceipts.set(key, receipt);
    return receipt;
  }

  seal(): PairedLiveBrokerSeal {
    if (this.#sealed) return this.#sealed;
    assert(
      this.#journal.isSealed(),
      "paired-live broker cannot seal before eligible-heads journal",
    );
    const deliveryReceipts = this.#sortedReceipts(this.#deliveryReceipts);
    const ackReceipts = this.#sortedReceipts(this.#ackReceipts);
    const terminalReceipts = this.#sortedReceipts(this.#terminalReceipts);
    const common = {
      schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
      experimentId: this.#rule.experimentId,
      eligibilityRuleSha256: this.#rule.eligibilityRuleSha256,
      deliveryReceipts,
      ackReceipts,
      terminalReceipts,
    };
    this.#sealed = deepFreeze({
      ...common,
      receiptSetSha256: blindProductionAuditHash(common),
    });
    trustedBrokerSeals.add(this.#sealed);
    trustedBrokerSealExtractors.set(
      this.#sealed,
      this.#semanticExtractor,
    );
    return this.#sealed;
  }

  #envelope(
    entry: EligibleHeadJournalEntry,
  ): PairedLiveDeliveryEnvelope {
    const existing = this.#envelopes.get(entry.entrySha256);
    if (existing) return existing;
    const envelope = buildDeliveryEnvelope(this.#rule, entry);
    this.#envelopes.set(entry.entrySha256, envelope);
    return envelope;
  }

  #requiredEntry(entrySha256: string): EligibleHeadJournalEntry {
    assertSha256(entrySha256, "paired-live journal entry");
    const entry = this.#journal.entry(entrySha256);
    assert(
      entry,
      "paired-live delivery requires a previously journaled eligible head",
    );
    return entry;
  }

  #sortedReceipts<T extends {
    readonly side: PairedLiveSide;
    readonly journalEntrySha256: string;
  }>(
    source: ReadonlyMap<string, T>,
  ): readonly T[] {
    return Object.freeze(
      [...source.values()].sort((a, b) => {
        const aEntry = this.#requiredEntry(a.journalEntrySha256);
        const bEntry = this.#requiredEntry(b.journalEntrySha256);
        return aEntry.sequence - bEntry.sequence ||
          sideIndex(a.side) - sideIndex(b.side);
      }),
    );
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("paired-live broker is sealed");
  }
}

Object.freeze(TrustedPairedLiveHeaderAuditor.prototype);
Object.freeze(ImmutablePairedLiveDeliveryBroker.prototype);

export function reconcilePairedLiveCanonicalHeaders(input: {
  readonly rule: FrozenPairedLiveEligibilityRule;
  readonly journal: EligibleHeadJournalSeal;
  readonly source: PairedLiveFinalCanonicalSource;
  readonly clock: PairedLiveTrustedClock;
}): PairedLiveCanonicalReconciliation {
  assertExactKeys(input, [
    "clock",
    "journal",
    "rule",
    "source",
  ], "paired-live canonical reconciliation input");
  validateFrozenEligibilityRule(input.rule);
  validateEligibleHeadJournalSeal(input.rule, input.journal);
  assert(
    input.journal.eligibilityRuleSha256 ===
      input.rule.eligibilityRuleSha256,
    "paired-live reconciliation journal/rule mismatch",
  );
  assert(
    input.source.identitySha256 ===
      input.rule.reconciliationSourceIdentitySha256,
    "paired-live reconciliation source identity mismatch",
  );
  assert(
    input.clock.identitySha256 === input.rule.trustedClockIdentitySha256,
    "paired-live reconciliation clock identity mismatch",
  );
  assert(
    trustedRuleClocks.get(input.rule) === input.clock,
    "paired-live reconciliation did not reuse the rule-sealing clock",
  );
  const trustedNowMs = trustedRuleNowMs.get(input.rule);
  assert(
    trustedNowMs,
    "paired-live reconciliation has no trusted clock capability",
  );
  const capturedAtMs = trustedNowMs();
  assertTimestamp(capturedAtMs, "paired-live reconciliation captured_at");
  assert(
    capturedAtMs >= input.rule.observationWindow.closesAtMs,
    "paired-live final canonical reconciliation must run after the window",
  );
  const finalCanonicalHeaders =
    input.source.enumerateFinalCanonicalHeaders(input.rule.blockRange).map(
      normalizeFinalCanonicalHeader,
    );
  const reconciliation = buildCanonicalReconciliation(
    input.rule,
    input.journal,
    input.source.identitySha256,
    capturedAtMs,
    finalCanonicalHeaders,
  );
  trustedReconciliations.add(reconciliation);
  return reconciliation;
}

function buildCanonicalReconciliation(
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
  sourceIdentitySha256: string,
  capturedAtMs: number,
  finalCanonicalHeaders: readonly FinalCanonicalHeader[],
): PairedLiveCanonicalReconciliation {
  const errors: string[] = [];
  const expectedCount =
    rule.blockRange.last - rule.blockRange.first + 1;
  if (finalCanonicalHeaders.length !== expectedCount) {
    errors.push(
      `final canonical header count ${finalCanonicalHeaders.length} != ${expectedCount}`,
    );
  }
  for (let index = 0; index < finalCanonicalHeaders.length; index++) {
    const header = finalCanonicalHeaders[index]!;
    const expectedNumber = rule.blockRange.first + index;
    if (header.number !== expectedNumber) {
      errors.push(
        `final canonical number ${header.number} != ${expectedNumber}`,
      );
    }
    const previous = finalCanonicalHeaders[index - 1];
    if (previous && header.parentHash !== previous.hash) {
      errors.push(`final canonical parent mismatch at ${header.number}`);
    }
  }
  const canonicalJournalEntries = finalCanonicalHeaders.map((header) => {
    const matches = journal.entries.filter(
      (entry) =>
        entry.number === header.number &&
        entry.hash === header.hash,
    );
    const match = [...matches].sort(
      (a, b) => b.sourceGeneration - a.sourceGeneration,
    )[0] ?? null;
    if (!match) {
      errors.push(
        `final canonical head missing eligible journal entry ${header.number}:${header.hash}`,
      );
    }
    return Object.freeze({
      number: header.number,
      hash: header.hash,
      journalEntrySha256: match?.entrySha256 ?? null,
    });
  });
  const canonicalEntrySet = new Set(
    canonicalJournalEntries.flatMap((entry) =>
      entry.journalEntrySha256 ? [entry.journalEntrySha256] : []
    ),
  );
  const orphanOrReplacementEntrySha256s = journal.entries
    .filter((entry) => !canonicalEntrySet.has(entry.entrySha256))
    .map((entry) => entry.entrySha256);
  const denominatorEntrySha256s =
    journal.entries.map((entry) => entry.entrySha256);
  const finalCanonicalSha256 =
    blindProductionAuditHash(finalCanonicalHeaders);
  const common = {
    schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
    experimentId: rule.experimentId,
    eligibilityRuleSha256: rule.eligibilityRuleSha256,
    journalSha256: journal.journalSha256,
    reconciliationSourceIdentitySha256: sourceIdentitySha256,
    capturedAtMs,
    status: errors.length === 0 ? "valid" as const : "invalid" as const,
    errors: Object.freeze(errors),
    finalCanonicalHeaders: Object.freeze(finalCanonicalHeaders),
    canonicalJournalEntries: Object.freeze(canonicalJournalEntries),
    orphanOrReplacementEntrySha256s:
      Object.freeze(orphanOrReplacementEntrySha256s),
    denominatorEntrySha256s: Object.freeze(denominatorEntrySha256s),
    finalCanonicalSha256,
  };
  return deepFreeze({
    ...common,
    reconciliationSha256: blindProductionAuditHash(common),
  });
}

export function buildPairedLiveReport(input: {
  readonly rule: FrozenPairedLiveEligibilityRule;
  readonly journal: EligibleHeadJournalSeal;
  readonly reconciliation: PairedLiveCanonicalReconciliation;
  readonly broker: PairedLiveBrokerSeal;
}): PairedLiveReport {
  assertExactKeys(input, [
    "broker",
    "journal",
    "reconciliation",
    "rule",
  ], "paired-live report input");
  const { rule, journal, reconciliation, broker } = input;
  validateFrozenEligibilityRule(rule);
  validateEligibleHeadJournalSeal(rule, journal);
  validateCanonicalReconciliation(rule, journal, reconciliation);
  validatePairedLiveBrokerSeal(rule, journal, broker);
  assert(
    journal.eligibilityRuleSha256 === rule.eligibilityRuleSha256 &&
      reconciliation.eligibilityRuleSha256 ===
        rule.eligibilityRuleSha256 &&
      broker.eligibilityRuleSha256 === rule.eligibilityRuleSha256,
    "paired-live report rule binding mismatch",
  );
  assert(
    reconciliation.journalSha256 === journal.journalSha256,
    "paired-live report journal binding mismatch",
  );
  assert(journal.entryCount > 0, "paired-live report has an empty denominator");
  const baseline = sideReport("baseline", rule, journal, broker);
  const challenger = sideReport("challenger", rule, journal, broker);
  const exactSemantics = compareExactSemantics(
    rule,
    journal,
    broker,
    baseline,
    challenger,
  );
  const completedHeads95Pass =
    challenger.onTimeTerminalHeads >=
      rule.relativeHeadCoverageFloor * baseline.onTimeTerminalHeads;
  const candidateOverlap = baselineCandidateOverlap(
    journal,
    broker,
    baseline,
    challenger,
  );
  const candidateCoverage95Pass =
    candidateOverlap.coverage >= rule.relativeHeadCoverageFloor;
  const throughput95Pass =
    challenger.throughputHeadsPerSecond >=
      rule.relativeHeadCoverageFloor * baseline.throughputHeadsPerSecond;
  const baselineAbsolutePass =
    baseline.headCoverage >= rule.absoluteHeadCoverageFloor;
  const challengerAbsolutePass =
    challenger.headCoverage >= rule.absoluteHeadCoverageFloor;
  const baselineTimingPass = baseline.terminalLatencyMs.timingPass;
  const challengerTimingPass = challenger.terminalLatencyMs.timingPass;
  const requiredChallengerHeadCoverage =
    rule.relativeHeadCoverageFloor * baseline.headCoverage;
  const challengerRelativeHeadCoveragePass =
    challenger.headCoverage >= requiredChallengerHeadCoverage;
  const challengerOnlyRepeatedFailureCategories = Object.keys(
    challenger.failureCategories,
  ).filter((category) =>
    (challenger.failureCategories[category] ?? 0) >=
      rule.systemicFailureRepeatThreshold &&
    (baseline.failureCategories[category] ?? 0) === 0
  ).sort();
  const hardFailure =
    exactSemantics.status === "fail" ||
    challengerOnlyRepeatedFailureCategories.length > 0;
  let verdict: PairedLiveReport["verdict"];
  if (reconciliation.status === "invalid") {
    verdict = "invalid";
  } else if (hardFailure) {
    verdict = "fail";
  } else if (!baselineAbsolutePass || !baselineTimingPass) {
    verdict = "relative_diagnostic_only";
  } else if (
    !challengerAbsolutePass ||
    !challengerTimingPass ||
    !challengerRelativeHeadCoveragePass ||
    !completedHeads95Pass ||
    !candidateCoverage95Pass ||
    !throughput95Pass
  ) {
    verdict = "fail";
  } else {
    verdict = "pass";
  }
  const reportWithoutHash = {
    schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
    experimentId: rule.experimentId,
    eligibilityRuleSha256: rule.eligibilityRuleSha256,
    journalSha256: journal.journalSha256,
    reconciliationSha256: reconciliation.reconciliationSha256,
    receiptSetSha256: broker.receiptSetSha256,
    denominator: {
      eligibleHeads: journal.entryCount,
      entrySha256s: Object.freeze(
        journal.entries.map((entry) => entry.entrySha256),
      ),
    },
    canonicalReconciliationStatus: reconciliation.status,
    baseline,
    challenger,
    exactSemantics,
    floors: {
      absoluteFloor: rule.absoluteHeadCoverageFloor,
      baselineAbsolutePass,
      challengerAbsolutePass,
      baselineTimingPass,
      challengerTimingPass,
      relativeFloor: rule.relativeHeadCoverageFloor,
      requiredChallengerHeadCoverage,
      challengerRelativeHeadCoveragePass,
      completedHeads95Pass,
      baselineCandidateHeads: candidateOverlap.baselineCandidateHeads,
      reproducedBaselineCandidateHeads:
        candidateOverlap.reproducedBaselineCandidateHeads,
      candidateCoverage: candidateOverlap.coverage,
      candidateCoverage95Pass,
      throughput95Pass,
    },
    challengerOnlyRepeatedFailureCategories:
      Object.freeze(challengerOnlyRepeatedFailureCategories),
    verdict,
    pairedLivePass: verdict === "pass",
    mergeReady: false as const,
    mergeReadinessReason:
      "requires_independent_six_stage_evidence" as const,
  };
  return deepFreeze({
    ...reportWithoutHash,
    reportSha256: blindProductionAuditHash(reportWithoutHash),
  });
}

function baselineCandidateOverlap(
  journal: EligibleHeadJournalSeal,
  broker: PairedLiveBrokerSeal,
  baseline: PairedLiveSideReport,
  challenger: PairedLiveSideReport,
): Readonly<{
  baselineCandidateHeads: number;
  reproducedBaselineCandidateHeads: number;
  coverage: number;
}> {
  const baselineTerminals = receiptMap(
    broker.terminalReceipts,
    "baseline",
  );
  const challengerTerminals = receiptMap(
    broker.terminalReceipts,
    "challenger",
  );
  const baselineResults = new Map(
    baseline.headResults.map((result) => [
      result.journalEntrySha256,
      result,
    ]),
  );
  const challengerResults = new Map(
    challenger.headResults.map((result) => [
      result.journalEntrySha256,
      result,
    ]),
  );
  let baselineCandidateHeads = 0;
  let reproducedBaselineCandidateHeads = 0;
  for (const entry of journal.entries) {
    const baselineIsCandidate =
      baselineResults.get(entry.entrySha256)?.status ===
        "on_time_terminal" &&
      baselineTerminals.get(entry.entrySha256)?.status ===
        "ev_decision_candidate";
    if (!baselineIsCandidate) continue;
    baselineCandidateHeads++;
    const challengerReproduced =
      challengerResults.get(entry.entrySha256)?.status ===
        "on_time_terminal" &&
      challengerTerminals.get(entry.entrySha256)?.status ===
        "ev_decision_candidate";
    if (challengerReproduced) reproducedBaselineCandidateHeads++;
  }
  return Object.freeze({
    baselineCandidateHeads,
    reproducedBaselineCandidateHeads,
    coverage: baselineCandidateHeads === 0
      ? 1
      : reproducedBaselineCandidateHeads / baselineCandidateHeads,
  });
}

function sideReport(
  side: PairedLiveSide,
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
  broker: PairedLiveBrokerSeal,
): PairedLiveSideReport {
  const deliveries = receiptMap(broker.deliveryReceipts, side);
  const acknowledgements = receiptMap(broker.ackReceipts, side);
  const terminals = receiptMap(broker.terminalReceipts, side);
  const failureCategories: Record<string, number> = {};
  const terminalLatencies: number[] = [];
  const familyDistribution: Record<string, number> = {};
  let onTimeTerminalHeads = 0;
  let noCandidateHeads = 0;
  let candidateHeads = 0;
  let calls = 0;
  let batches = 0;
  const headResults = journal.entries.map((entry): PairedLiveHeadResult => {
    const delivery = deliveries.get(entry.entrySha256);
    const ack = acknowledgements.get(entry.entrySha256);
    const terminal = terminals.get(entry.entrySha256);
    let failureCategory: string | null = null;
    if (!delivery) {
      failureCategory = "missing_delivery_receipt";
    } else if (!ack) {
      failureCategory = "missing_ack_receipt";
    } else if (!terminal) {
      failureCategory = "missing_terminal";
    } else {
      const latency = terminal.completedAtMs - entry.observedAtMs;
      calls += terminal.telemetry.calls;
      batches += terminal.telemetry.batches;
      for (const [family, count] of Object.entries(
        terminal.telemetry.familyCounts,
      )) {
        familyDistribution[family] =
          (familyDistribution[family] ?? 0) + count;
      }
      if (
        terminal.status === "skipped_busy" ||
        terminal.status === "timeout" ||
        terminal.status === "incomplete"
      ) {
        failureCategory = terminal.status;
      } else if (terminal.completedAtMs > entry.observedAtMs + rule.terminalDeadlineMs) {
        failureCategory = "late_terminal";
      } else {
        onTimeTerminalHeads++;
        if (terminal.status === "scanner_done_no_candidate") {
          noCandidateHeads++;
        } else {
          candidateHeads++;
        }
      }
    }
    if (failureCategory) {
      failureCategories[failureCategory] =
        (failureCategories[failureCategory] ?? 0) + 1;
    }
    const terminalLatencyMs =
      terminal ? terminal.completedAtMs - entry.observedAtMs : null;
    const accountedLatencyMs = failureCategory
      ? Math.max(rule.terminalDeadlineMs, terminalLatencyMs ?? 0)
      : terminalLatencyMs!;
    terminalLatencies.push(accountedLatencyMs);
    return deepFreeze({
      journalEntrySha256: entry.entrySha256,
      number: entry.number,
      hash: entry.hash,
      sourceGeneration: entry.sourceGeneration,
      status: failureCategory ? "failed" as const : "on_time_terminal" as const,
      terminalStatus: terminal?.status ?? null,
      terminalLatencyMs,
      accountedLatencyMs,
      failureCategory,
    });
  });
  const eligibleHeads = journal.entryCount;
  const windowSeconds = Math.max(
    0.001,
    (rule.observationWindow.closesAtMs -
      rule.observationWindow.opensAtMs) / 1_000,
  );
  const p50 = nearestRank(terminalLatencies, 0.5);
  const p95 = nearestRank(terminalLatencies, 0.95);
  return deepFreeze({
    eligibleHeads,
    onTimeTerminalHeads,
    noCandidateHeads,
    candidateHeads,
    headCoverage: onTimeTerminalHeads / eligibleHeads,
    throughputHeadsPerSecond: onTimeTerminalHeads / windowSeconds,
    terminalLatencyMs: {
      sampleCount: terminalLatencies.length,
      p50,
      p95,
      timingPass: p95 !== null && p95 < rule.terminalDeadlineMs,
    },
    failureCategories: sortedRecord(failureCategories),
    calls,
    batches,
    familyDistribution: sortedRecord(familyDistribution),
    headResults: Object.freeze(headResults),
  });
}

function compareExactSemantics(
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
  broker: PairedLiveBrokerSeal,
  baseline: PairedLiveSideReport,
  challenger: PairedLiveSideReport,
): PairedLiveReport["exactSemantics"] {
  const terminals = {
    baseline: receiptMap(broker.terminalReceipts, "baseline"),
    challenger: receiptMap(broker.terminalReceipts, "challenger"),
  };
  const baselineResult = new Map(
    baseline.headResults.map((result) => [
      result.journalEntrySha256,
      result,
    ]),
  );
  const challengerResult = new Map(
    challenger.headResults.map((result) => [
      result.journalEntrySha256,
      result,
    ]),
  );
  const mismatchEntrySha256s: string[] = [];
  const additionViolations: string[] = [];
  const challengerAdditions: Record<string, number> = {};
  const approved = new Set(rule.approvedAdditionIds);
  let comparedHeads = 0;
  for (const entry of journal.entries) {
    const baselineTerminal = terminals.baseline.get(entry.entrySha256);
    const challengerTerminal = terminals.challenger.get(entry.entrySha256);
    for (const addition of baselineTerminal?.additions ?? []) {
      additionViolations.push(
        `baseline addition ${addition.id} at ${entry.entrySha256}`,
      );
    }
    for (const addition of challengerTerminal?.additions ?? []) {
      if (!approved.has(addition.id)) {
        additionViolations.push(
          `unapproved challenger addition ${addition.id} at ${entry.entrySha256}`,
        );
      } else {
        challengerAdditions[addition.id] =
          (challengerAdditions[addition.id] ?? 0) + 1;
      }
    }
    if (
      baselineResult.get(entry.entrySha256)?.status !== "on_time_terminal" ||
      challengerResult.get(entry.entrySha256)?.status !== "on_time_terminal" ||
      !baselineTerminal ||
      !challengerTerminal
    ) continue;
    comparedHeads++;
    const baselineSemantic = blindProductionAuditHash({
      status: baselineTerminal.status,
      commonSemanticsSha256: baselineTerminal.commonSemanticsSha256,
    });
    const challengerSemantic = blindProductionAuditHash({
      status: challengerTerminal.status,
      commonSemanticsSha256: challengerTerminal.commonSemanticsSha256,
    });
    if (baselineSemantic !== challengerSemantic) {
      mismatchEntrySha256s.push(entry.entrySha256);
    }
  }
  return deepFreeze({
    status:
      mismatchEntrySha256s.length === 0 && additionViolations.length === 0
        ? "pass" as const
        : "fail" as const,
    comparedHeads,
    mismatchEntrySha256s: Object.freeze(mismatchEntrySha256s),
    additionViolations: Object.freeze(additionViolations),
    challengerAdditions: sortedRecord(challengerAdditions),
  });
}

function validateFrozenEligibilityRule(
  rule: FrozenPairedLiveEligibilityRule,
): void {
  assertExactKeys(rule, [
    "absoluteHeadCoverageFloor",
    "approvedAdditionIds",
    "blockRange",
    "catchUpThroughBlock",
    "eligibilityRuleSha256",
    "experimentId",
    "headerAuditorSourceIdentitySha256",
    "observationWindow",
    "reconciliationSourceIdentitySha256",
    "relativeHeadCoverageFloor",
    "reorgPolicy",
    "schemaVersion",
    "sealedAtMs",
    "sharedInputs",
    "sourceKind",
    "systemicFailureRepeatThreshold",
    "terminalDeadlineMs",
    "trustedClockIdentitySha256",
    "warmupThroughBlock",
  ], "paired-live sealed eligibility rule");
  const {
    eligibilityRuleSha256,
    sealedAtMs,
    ...input
  } = rule;
  assertSha256(eligibilityRuleSha256, "paired-live eligibility rule hash");
  const rebuilt = freezePairedLiveEligibilityRule(input, {
    identitySha256: input.trustedClockIdentitySha256,
    nowMs: () => sealedAtMs,
  });
  assert(
    rebuilt.eligibilityRuleSha256 === eligibilityRuleSha256,
    "paired-live eligibility rule hash mismatch",
  );
  assert(
    trustedEligibilityRules.has(rule),
    "paired-live eligibility rule lacks trusted in-process provenance",
  );
  assert(
    trustedRuleClocks.has(rule) && trustedRuleNowMs.has(rule),
    "paired-live eligibility rule lacks its trusted clock capability",
  );
}

function validateEligibleHeadJournalSeal(
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
): void {
  assertExactKeys(journal, [
    "chainHeadSha256",
    "eligibilityRuleSha256",
    "entries",
    "entryCount",
    "experimentId",
    "journalSha256",
    "schemaVersion",
  ], "paired-live eligible-heads journal seal");
  assert(
    journal.schemaVersion === PAIRED_LIVE_SCHEMA_VERSION &&
      journal.experimentId === rule.experimentId &&
      journal.eligibilityRuleSha256 === rule.eligibilityRuleSha256,
    "paired-live eligible-heads journal identity mismatch",
  );
  assertNonnegativeInteger(
    journal.entryCount,
    "paired-live eligible-heads journal entry count",
  );
  assert(
    journal.entryCount === journal.entries.length,
    "paired-live eligible-heads journal entry count mismatch",
  );
  assertSha256(
    journal.chainHeadSha256,
    "paired-live eligible-heads journal chain head",
  );
  assertSha256(
    journal.journalSha256,
    "paired-live eligible-heads journal hash",
  );

  const replay = new EligibleHeadsJournal(
    rule,
    {
      identitySha256: rule.trustedClockIdentitySha256,
      nowMs: () => rule.sealedAtMs,
    },
    JOURNAL_AUTHORITY,
  );
  for (const entry of journal.entries) {
    assertExactKeys(entry, [
      "eligibilityRuleSha256",
      "entrySha256",
      "experimentId",
      "hash",
      "number",
      "observedAtMs",
      "parentHash",
      "previousEntrySha256",
      "schemaVersion",
      "sequence",
      "sourceGeneration",
    ], "paired-live eligible-heads journal entry");
    const expected = replay.append(
      {
        number: entry.number,
        hash: entry.hash,
        parentHash: entry.parentHash,
        sourceGeneration: entry.sourceGeneration,
        observedAtMs: entry.observedAtMs,
      },
      JOURNAL_AUTHORITY,
    );
    assert(
      blindProductionAuditHash(entry) ===
        blindProductionAuditHash(expected),
      `paired-live eligible-heads journal entry mismatch at ${entry.sequence}`,
    );
  }
  const expectedSeal = replay.seal();
  assert(
    blindProductionAuditHash(journal) ===
      blindProductionAuditHash(expectedSeal),
    "paired-live eligible-heads journal seal hash mismatch",
  );
  assert(
    trustedJournalSeals.has(journal),
    "paired-live journal seal lacks trusted auditor provenance",
  );
}

function validateCanonicalReconciliation(
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
  reconciliation: PairedLiveCanonicalReconciliation,
): void {
  assertExactKeys(reconciliation, [
    "canonicalJournalEntries",
    "capturedAtMs",
    "denominatorEntrySha256s",
    "eligibilityRuleSha256",
    "errors",
    "experimentId",
    "finalCanonicalHeaders",
    "finalCanonicalSha256",
    "journalSha256",
    "orphanOrReplacementEntrySha256s",
    "reconciliationSha256",
    "reconciliationSourceIdentitySha256",
    "schemaVersion",
    "status",
  ], "paired-live canonical reconciliation");
  assert(
    reconciliation.schemaVersion === PAIRED_LIVE_SCHEMA_VERSION &&
      reconciliation.experimentId === rule.experimentId &&
      reconciliation.eligibilityRuleSha256 ===
        rule.eligibilityRuleSha256 &&
      reconciliation.journalSha256 === journal.journalSha256,
    "paired-live canonical reconciliation identity mismatch",
  );
  assert(
    reconciliation.reconciliationSourceIdentitySha256 ===
      rule.reconciliationSourceIdentitySha256,
    "paired-live canonical reconciliation source mismatch",
  );
  assertTimestamp(
    reconciliation.capturedAtMs,
    "paired-live canonical reconciliation captured_at",
  );
  assert(
    reconciliation.capturedAtMs >= rule.observationWindow.closesAtMs,
    "paired-live canonical reconciliation predates window close",
  );
  assertSha256(
    reconciliation.finalCanonicalSha256,
    "paired-live final canonical hash",
  );
  assertSha256(
    reconciliation.reconciliationSha256,
    "paired-live canonical reconciliation hash",
  );
  const finalCanonicalHeaders =
    reconciliation.finalCanonicalHeaders.map(normalizeFinalCanonicalHeader);
  const expected = buildCanonicalReconciliation(
    rule,
    journal,
    reconciliation.reconciliationSourceIdentitySha256,
    reconciliation.capturedAtMs,
    finalCanonicalHeaders,
  );
  assert(
    blindProductionAuditHash(reconciliation) ===
      blindProductionAuditHash(expected),
    "paired-live canonical reconciliation hash mismatch",
  );
  assert(
    trustedReconciliations.has(reconciliation),
    "paired-live reconciliation lacks trusted source provenance",
  );
}

function validatePairedLiveBrokerSeal(
  rule: FrozenPairedLiveEligibilityRule,
  journal: EligibleHeadJournalSeal,
  broker: PairedLiveBrokerSeal,
): void {
  assertExactKeys(broker, [
    "ackReceipts",
    "deliveryReceipts",
    "eligibilityRuleSha256",
    "experimentId",
    "receiptSetSha256",
    "schemaVersion",
    "terminalReceipts",
  ], "paired-live broker seal");
  assert(
    broker.schemaVersion === PAIRED_LIVE_SCHEMA_VERSION &&
      broker.experimentId === rule.experimentId &&
      broker.eligibilityRuleSha256 === rule.eligibilityRuleSha256,
    "paired-live broker seal identity mismatch",
  );
  assertSha256(broker.receiptSetSha256, "paired-live receipt set hash");
  const semanticExtractor = trustedBrokerSealExtractors.get(broker);
  assert(
    semanticExtractor,
    "paired-live broker seal has no bound semantic extractor",
  );
  assertSha256(
    semanticExtractor.identitySha256,
    "paired-live report semantic extractor identity",
  );
  assert(
    semanticExtractor.identitySha256 ===
      rule.sharedInputs.semanticExtractorSha256,
    "paired-live report semantic extractor identity mismatch",
  );

  const journalEntries = new Map(
    journal.entries.map((entry) => [entry.entrySha256, entry]),
  );
  const deliveries = new Map<string, PairedLiveDeliveryReceipt>();
  assertReceiptOrder(
    broker.deliveryReceipts,
    journalEntries,
    "paired-live delivery receipts",
  );
  for (const receipt of broker.deliveryReceipts) {
    assertExactKeys(receipt, [
      "deliveredAtMs",
      "envelopeSha256",
      "experimentId",
      "journalEntrySha256",
      "receiptSha256",
      "schemaVersion",
      "side",
    ], "paired-live delivery receipt");
    assertReceiptIdentity(rule, receipt);
    const entry = journalEntries.get(receipt.journalEntrySha256);
    assert(entry, "paired-live delivery receipt has no eligible head");
    const key = receiptKey(receipt.side, receipt.journalEntrySha256);
    assert(!deliveries.has(key), "paired-live duplicate delivery receipt");
    assertTimestamp(receipt.deliveredAtMs, "paired-live delivered_at");
    assert(
      receipt.deliveredAtMs >= entry.observedAtMs,
      "paired-live delivery receipt predates observation",
    );
    const envelope = buildDeliveryEnvelope(rule, entry);
    assert(
      receipt.envelopeSha256 === envelope.envelopeSha256,
      "paired-live delivery envelope hash mismatch",
    );
    validateReceiptHash(receipt, "paired-live delivery receipt");
    deliveries.set(key, receipt);
  }

  const acknowledgements = new Map<string, PairedLiveAckReceipt>();
  assertReceiptOrder(
    broker.ackReceipts,
    journalEntries,
    "paired-live acknowledgement receipts",
  );
  for (const receipt of broker.ackReceipts) {
    assertExactKeys(receipt, [
      "acknowledgedAtMs",
      "deliveryReceiptSha256",
      "envelopeSha256",
      "experimentId",
      "journalEntrySha256",
      "receiptSha256",
      "runtimeSharedInputSha256",
      "schemaVersion",
      "side",
    ], "paired-live acknowledgement receipt");
    assertReceiptIdentity(rule, receipt);
    const key = receiptKey(receipt.side, receipt.journalEntrySha256);
    const delivery = deliveries.get(key);
    assert(delivery, "paired-live acknowledgement has no delivery receipt");
    assert(
      receipt.deliveryReceiptSha256 === delivery.receiptSha256 &&
        receipt.envelopeSha256 === delivery.envelopeSha256,
      "paired-live acknowledgement delivery binding mismatch",
    );
    assertTimestamp(receipt.acknowledgedAtMs, "paired-live acknowledged_at");
    assert(
      receipt.acknowledgedAtMs >= delivery.deliveredAtMs,
      "paired-live acknowledgement predates delivery",
    );
    assert(
      receipt.runtimeSharedInputSha256 ===
        blindProductionAuditHash(rule.sharedInputs),
      "paired-live acknowledgement shared inputs mismatch",
    );
    assert(
      !acknowledgements.has(key),
      "paired-live duplicate acknowledgement receipt",
    );
    validateReceiptHash(receipt, "paired-live acknowledgement receipt");
    acknowledgements.set(key, receipt);
  }

  const terminals = new Set<string>();
  assertReceiptOrder(
    broker.terminalReceipts,
    journalEntries,
    "paired-live terminal receipts",
  );
  for (const receipt of broker.terminalReceipts) {
    assertExactKeys(receipt, [
      "ackReceiptSha256",
      "additions",
      "commonSemanticsSha256",
      "completedAtMs",
      "envelopeSha256",
      "experimentId",
      "failureCategory",
      "journalEntrySha256",
      "rawOutput",
      "rawOutputSha256",
      "receiptSha256",
      "schemaVersion",
      "side",
      "status",
      "telemetry",
    ], "paired-live terminal receipt");
    assertReceiptIdentity(rule, receipt);
    const key = receiptKey(receipt.side, receipt.journalEntrySha256);
    const entry = journalEntries.get(receipt.journalEntrySha256);
    const delivery = deliveries.get(key);
    const acknowledgement = acknowledgements.get(key);
    assert(entry, "paired-live terminal has no eligible head");
    assert(delivery, "paired-live terminal has no delivery receipt");
    assert(acknowledgement, "paired-live terminal has no acknowledgement");
    assert(!terminals.has(key), "paired-live duplicate terminal receipt");
    assert(
      receipt.envelopeSha256 === delivery.envelopeSha256 &&
        receipt.ackReceiptSha256 === acknowledgement.receiptSha256,
      "paired-live terminal receipt binding mismatch",
    );
    assertSha256(
      receipt.rawOutputSha256,
      "paired-live terminal raw output hash",
    );
    assert(
      receipt.rawOutputSha256 ===
        blindProductionAuditHash(receipt.rawOutput),
      "paired-live terminal raw output hash mismatch",
    );
    const envelope = buildDeliveryEnvelope(rule, entry);
    const projection = terminalProjection(semanticExtractor.extract(
      deepFreeze({
        side: receipt.side,
        envelope,
        rawOutput: receipt.rawOutput,
      }),
    ));
    assert(
      receipt.status === projection.status &&
        receipt.commonSemanticsSha256 ===
          projection.commonSemanticsSha256 &&
        receipt.failureCategory === projection.failureCategory &&
        blindProductionAuditHash(receipt.additions) ===
          blindProductionAuditHash(projection.additions) &&
        blindProductionAuditHash(receipt.telemetry) ===
          blindProductionAuditHash(projection.telemetry),
      "paired-live terminal trusted semantic extraction mismatch",
    );
    assertTimestamp(receipt.completedAtMs, "paired-live terminal completed_at");
    assert(
      receipt.completedAtMs >= acknowledgement.acknowledgedAtMs,
      "paired-live terminal predates acknowledgement",
    );
    const successful =
      receipt.status === "scanner_done_no_candidate" ||
      receipt.status === "ev_decision_candidate";
    assert(
      successful ||
        receipt.status === "skipped_busy" ||
        receipt.status === "timeout" ||
        receipt.status === "incomplete",
      "paired-live terminal status",
    );
    if (successful) {
      assert(
        receipt.commonSemanticsSha256 !== null,
        "paired-live successful terminal has no semantic hash",
      );
      assertSha256(
        receipt.commonSemanticsSha256,
        "paired-live terminal semantic hash",
      );
      assert(
        receipt.failureCategory === null,
        "paired-live successful terminal has a failure category",
      );
    } else {
      assert(
        receipt.commonSemanticsSha256 === null &&
          receipt.additions.length === 0 &&
          receipt.failureCategory !== null &&
          nonempty(receipt.failureCategory),
        "paired-live failed terminal shape mismatch",
      );
    }
    const additionIds: string[] = [];
    for (const addition of receipt.additions) {
      assertExactKeys(
        addition,
        ["id", "semanticsSha256"],
        "paired-live terminal addition receipt",
      );
      assert(nonempty(addition.id), "paired-live terminal addition id");
      assertSha256(
        addition.semanticsSha256,
        "paired-live terminal addition semantic hash",
      );
      additionIds.push(addition.id);
    }
    assertUnique(additionIds, "paired-live terminal additions");
    assert(
      additionIds.every((id, index) =>
        index === 0 || additionIds[index - 1]!.localeCompare(id) < 0
      ),
      "paired-live terminal additions are not sorted",
    );
    const normalizedTelemetry = normalizeTelemetry(receipt.telemetry);
    assert(
      blindProductionAuditHash(receipt.telemetry) ===
        blindProductionAuditHash(normalizedTelemetry),
      "paired-live terminal telemetry is not normalized",
    );
    validateReceiptHash(receipt, "paired-live terminal receipt");
    terminals.add(key);
  }

  const receiptSetWithoutHash = {
    schemaVersion: broker.schemaVersion,
    experimentId: broker.experimentId,
    eligibilityRuleSha256: broker.eligibilityRuleSha256,
    deliveryReceipts: broker.deliveryReceipts,
    ackReceipts: broker.ackReceipts,
    terminalReceipts: broker.terminalReceipts,
  };
  assert(
    broker.receiptSetSha256 ===
      blindProductionAuditHash(receiptSetWithoutHash),
    "paired-live receipt set hash mismatch",
  );
  assert(
    trustedBrokerSeals.has(broker),
    "paired-live broker seal lacks trusted broker provenance",
  );
}

function buildDeliveryEnvelope(
  rule: FrozenPairedLiveEligibilityRule,
  entry: EligibleHeadJournalEntry,
): PairedLiveDeliveryEnvelope {
  const envelopeWithoutHash = {
    schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
    experimentId: rule.experimentId,
    eligibilityRuleSha256: rule.eligibilityRuleSha256,
    journalEntrySha256: entry.entrySha256,
    sequence: entry.sequence,
    header: {
      number: entry.number,
      hash: entry.hash,
      parentHash: entry.parentHash,
      sourceGeneration: entry.sourceGeneration,
      observedAtMs: entry.observedAtMs,
    },
    deadlineAtMs: entry.observedAtMs + rule.terminalDeadlineMs,
    sharedInputSha256: blindProductionAuditHash(rule.sharedInputs),
  };
  return deepFreeze({
    ...envelopeWithoutHash,
    envelopeSha256: blindProductionAuditHash(envelopeWithoutHash),
  });
}

function assertReceiptIdentity(
  rule: FrozenPairedLiveEligibilityRule,
  receipt: {
    readonly schemaVersion: number;
    readonly experimentId: string;
    readonly side: string;
    readonly journalEntrySha256: string;
  },
): void {
  assert(
    receipt.schemaVersion === PAIRED_LIVE_SCHEMA_VERSION &&
      receipt.experimentId === rule.experimentId,
    "paired-live receipt identity mismatch",
  );
  assertSide(receipt.side);
  assertSha256(
    receipt.journalEntrySha256,
    "paired-live receipt journal entry hash",
  );
}

function validateReceiptHash(
  receipt: { readonly receiptSha256: string },
  label: string,
): void {
  assertSha256(receipt.receiptSha256, `${label} hash`);
  const { receiptSha256, ...withoutHash } = receipt;
  assert(
    receiptSha256 === blindProductionAuditHash(withoutHash),
    `${label} hash mismatch`,
  );
}

function assertReceiptOrder<T extends {
  readonly side: PairedLiveSide;
  readonly journalEntrySha256: string;
}>(
  receipts: readonly T[],
  journalEntries: ReadonlyMap<string, EligibleHeadJournalEntry>,
  label: string,
): void {
  let previousOrder = -1;
  for (const receipt of receipts) {
    const entry = journalEntries.get(receipt.journalEntrySha256);
    assert(entry, `${label} references a missing eligible head`);
    assertSide(receipt.side);
    const order = entry.sequence * PAIRED_LIVE_SIDES.length +
      sideIndex(receipt.side);
    assert(order > previousOrder, `${label} are not uniquely sorted`);
    previousOrder = order;
  }
}

function validateHeaderObservation(
  header: PairedLiveHeaderObservation,
): void {
  assertExactKeys(header, [
    "hash",
    "number",
    "observedAtMs",
    "parentHash",
    "sourceGeneration",
  ], "paired-live header observation");
  validateSourceHeader({
    number: header.number,
    hash: header.hash,
    parentHash: header.parentHash,
    sourceGeneration: header.sourceGeneration,
  });
  assertTimestamp(header.observedAtMs, "paired-live observed_at");
}

function validateSourceHeader(
  header: PairedLiveSourceHeader,
): void {
  assertExactKeys(header, [
    "hash",
    "number",
    "parentHash",
    "sourceGeneration",
  ], "paired-live source header");
  assertSafeInteger(header.number, "paired-live header number");
  assertBlockHash(header.hash, "paired-live header hash");
  assertBlockHash(header.parentHash, "paired-live parent hash");
  assert(
    Number.isSafeInteger(header.sourceGeneration) &&
      header.sourceGeneration >= 0,
    "paired-live source generation",
  );
}

function normalizeHeaderObservation(
  header: PairedLiveHeaderObservation,
): PairedLiveHeaderObservation {
  return Object.freeze({
    number: header.number,
    hash: header.hash.toLowerCase(),
    parentHash: header.parentHash.toLowerCase(),
    sourceGeneration: header.sourceGeneration,
    observedAtMs: header.observedAtMs,
  });
}

function normalizeFinalCanonicalHeader(
  header: FinalCanonicalHeader,
): FinalCanonicalHeader {
  assertExactKeys(
    header,
    ["hash", "number", "parentHash"],
    "paired-live final canonical header",
  );
  assertSafeInteger(header.number, "paired-live final canonical number");
  assertBlockHash(header.hash, "paired-live final canonical hash");
  assertBlockHash(
    header.parentHash,
    "paired-live final canonical parent hash",
  );
  return Object.freeze({
    number: header.number,
    hash: header.hash.toLowerCase(),
    parentHash: header.parentHash.toLowerCase(),
  });
}

function validateTerminalInput(input: PairedLiveTerminalInput): void {
  if (input.type === "scanner_done" || input.type === "ev_decision") {
    assertExactKeys(input, [
      "additions",
      "commonSemantics",
      "outcome",
      "telemetry",
      "type",
    ], "paired-live successful terminal");
    assert(
      (input.type === "scanner_done" && input.outcome === "no_candidate") ||
        (input.type === "ev_decision" && input.outcome === "candidate"),
      "paired-live terminal outcome",
    );
    blindProductionAuditHash(input.commonSemantics);
    for (const addition of input.additions) {
      assertExactKeys(
        addition,
        ["id", "semantics"],
        "paired-live addition evidence",
      );
      assert(nonempty(addition.id), "paired-live addition id");
      blindProductionAuditHash(addition.semantics);
    }
  } else {
    assertExactKeys(input, [
      "failureCategory",
      "telemetry",
      "type",
    ], "paired-live failed terminal");
    assert(nonempty(input.failureCategory), "paired-live failure category");
  }
  normalizeTelemetry(input.telemetry);
}

function terminalProjection(
  input: PairedLiveTerminalInput,
): Readonly<{
  status: PairedLiveTerminalStatus;
  commonSemanticsSha256: string | null;
  additions: readonly {
    readonly id: string;
    readonly semanticsSha256: string;
  }[];
  failureCategory: string | null;
  telemetry: PairedLiveTerminalTelemetry;
}> {
  validateTerminalInput(input);
  const successful =
    input.type === "scanner_done" || input.type === "ev_decision";
  return deepFreeze({
    status:
      input.type === "scanner_done"
        ? "scanner_done_no_candidate" as const
        : input.type === "ev_decision"
          ? "ev_decision_candidate" as const
          : input.type,
    commonSemanticsSha256: successful
      ? blindProductionAuditHash(input.commonSemantics)
      : null,
    additions: successful
      ? normalizeAdditions(input.additions)
      : Object.freeze([]),
    failureCategory: successful ? null : input.failureCategory,
    telemetry: normalizeTelemetry(input.telemetry),
  });
}

function normalizeTelemetry(
  telemetry: PairedLiveTerminalTelemetry,
): PairedLiveTerminalTelemetry {
  assertExactKeys(
    telemetry,
    ["batches", "calls", "familyCounts"],
    "paired-live terminal telemetry",
  );
  assertNonnegativeInteger(telemetry.calls, "paired-live calls");
  assertNonnegativeInteger(telemetry.batches, "paired-live batches");
  const familyCounts: Record<string, number> = {};
  for (const [family, count] of Object.entries(telemetry.familyCounts)) {
    assert(nonempty(family), "paired-live family id");
    assertNonnegativeInteger(count, `paired-live family count ${family}`);
    familyCounts[family] = count;
  }
  return deepFreeze({
    calls: telemetry.calls,
    batches: telemetry.batches,
    familyCounts: sortedRecord(familyCounts),
  });
}

function normalizeSharedInputs(
  sharedInputs: PairedLiveSharedInputs,
): PairedLiveSharedInputs {
  assertExactKeys(sharedInputs, [
    "backendIdentitySha256",
    "evPolicySha256",
    "resolvedConfigSha256",
    "semanticExtractorSha256",
    "submissionPolicySha256",
    "universeSha256",
  ], "paired-live runtime shared inputs");
  for (const [name, value] of Object.entries(sharedInputs)) {
    assertSha256(value, `paired-live runtime shared input ${name}`);
  }
  return deepFreeze({ ...sharedInputs });
}

function normalizeAdditions(
  additions: readonly PairedLiveAdditionEvidence[],
): readonly {
  readonly id: string;
  readonly semanticsSha256: string;
}[] {
  const normalized = additions.map((addition) => ({
    id: addition.id,
    semanticsSha256: blindProductionAuditHash(addition.semantics),
  })).sort((a, b) => a.id.localeCompare(b.id));
  assertUnique(
    normalized.map((addition) => addition.id),
    "paired-live terminal addition",
  );
  return deepFreeze(normalized);
}

function receiptMap<T extends {
  readonly side: PairedLiveSide;
  readonly journalEntrySha256: string;
}>(
  receipts: readonly T[],
  side: PairedLiveSide,
): ReadonlyMap<string, T> {
  return new Map(
    receipts
      .filter((receipt) => receipt.side === side)
      .map((receipt) => [receipt.journalEntrySha256, receipt]),
  );
}

function nearestRank(
  samples: readonly number[],
  percentile: number,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function sortedRecord(
  value: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

function receiptKey(
  side: PairedLiveSide,
  entrySha256: string,
): string {
  return `${entrySha256}:${side}`;
}

function sideIndex(side: PairedLiveSide): number {
  return side === "baseline" ? 0 : 1;
}

function assertSide(side: string): asserts side is PairedLiveSide {
  assert(
    side === "baseline" || side === "challenger",
    "paired-live side",
  );
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} contains unexpected or missing fields`,
  );
}

function assertUnique(values: readonly string[], label: string): void {
  assert(
    new Set(values).size === values.length,
    `${label} contains duplicates`,
  );
}

function assertBlockHash(value: string, label: string): void {
  assert(/^0x[0-9a-f]{64}$/i.test(value), label);
}

function assertSha256(value: string, label: string): void {
  assert(/^[0-9a-f]{64}$/.test(value), label);
}

function assertSafeInteger(value: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= 0, label);
}

function assertNonnegativeInteger(value: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= 0, label);
}

function assertTimestamp(value: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= 0, label);
}

function nonempty(value: string): boolean {
  return value.trim().length > 0;
}

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
