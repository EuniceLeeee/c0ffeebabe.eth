import { randomUUID } from "node:crypto";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { SQLiteDurableStore } from "../../durable-store/src/index.ts";
import type {
  CanonicalFenceV1,
  CanonicalFencePort,
} from "../../ready-generation/src/index.ts";
import type { BlockRangeV1, CanonicalCutoffV1 } from "../../discovery/src/index.ts";

export type BlockNumber = string;
export type CanonicalHeader = CanonicalCutoffV1;
export type CanonicalSourceView = CanonicalCutoffV1;

export interface CanonicalHeaderAbsenceEvidenceV1 {
  readonly chainId: string;
  readonly number: BlockNumber;
  readonly expectedHash: Hash;
  readonly expectedStateRoot: Hash;
  readonly replacementHash: Hash;
  readonly replacementStateRoot: Hash;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
}

export type CanonicalHeaderReadResult =
  | {
    readonly kind: "found";
    readonly header: CanonicalHeader;
  }
  | {
    readonly kind: "chainProvenAbsent";
    readonly evidence: CanonicalHeaderAbsenceEvidenceV1;
  }
  | {
    readonly kind: "unavailable";
    readonly failureCode: string;
  };

export interface CanonicalHeaderProvider {
  getLatestHeader(signal?: AbortSignal): Promise<CanonicalHeader>;
  getHeader(number: BlockNumber, signal?: AbortSignal): Promise<CanonicalHeaderReadResult>;
}

export type CanonicalCheckFailure =
  | "chain-id-mismatch"
  | "number-mismatch"
  | "hash-mismatch"
  | "state-root-mismatch"
  | "missing-header"
  | "transport";

export type CanonicalCheck =
  | {
    readonly ok: true;
    readonly view: CanonicalSourceView;
    readonly journalEpoch: string;
  }
  | {
    readonly ok: false;
    readonly retryable: boolean;
    readonly reason: CanonicalCheckFailure;
    readonly expected: CanonicalSourceView;
    readonly observed: CanonicalHeader | null;
    readonly absenceEvidence: CanonicalHeaderAbsenceEvidenceV1 | null;
    readonly journalEpoch: string;
  };

export interface CanonicalSourceOptions {
  readonly journalStore: CanonicalJournalStorePort;
  readonly chainGenesis?: BlockNumber;
}

export interface PromotionFreshnessReceiptV1 {
  readonly cutoff: CanonicalSourceView;
  readonly observedHead: CanonicalHeader;
  readonly observedAgeBlocks: string;
  readonly maxPromotionAgeBlocks: string;
  readonly generationRefreshPolicyHash: Hash;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly freshnessReceiptHash: Hash;
}

export interface PromotionFreshnessAuthorityV1 {
  readonly token: string;
  readonly receipt: PromotionFreshnessReceiptV1;
}

export interface PromotionFreshnessRequestV1 {
  readonly cutoff: CanonicalSourceView;
  readonly maxPromotionAgeBlocks: string;
  readonly generationRefreshPolicyHash: Hash;
}

export interface CanonicalJournalStoreSnapshotV1 {
  readonly token: string;
  readonly bytes: Uint8Array;
}

export interface CanonicalJournalStorePort {
  load(): CanonicalJournalStoreSnapshotV1 | null;
  compareAndSwap(expectedToken: string | null, bytes: Uint8Array): string;
}

export interface CanonicalLeaseGuardPort {
  assertViewAuthorityActive(cutoff: CanonicalSourceView): void;
}

export class CanonicalSourceError extends Error {
  readonly code:
    | "invalid-header"
    | CanonicalCheckFailure
    | "promotion-stale"
    | "canonical-view-superseded"
    | "fence-invalid";
  readonly retryable: boolean;
  readonly expected?: CanonicalSourceView;
  readonly observed?: CanonicalHeader | null;

  constructor(
    code: CanonicalSourceError["code"],
    message: string,
    retryable: boolean,
    expected?: CanonicalSourceView,
    observed?: CanonicalHeader | null,
  ) {
    super(message);
    this.name = "CanonicalSourceError";
    this.code = code;
    this.retryable = retryable;
    this.expected = expected;
    this.observed = observed;
  }
}

export class SQLiteCanonicalJournalStore implements CanonicalJournalStorePort {
  readonly #durable: SQLiteDurableStore;

  constructor(filename: string) {
    this.#durable = new SQLiteDurableStore(filename);
    this.#durable.bindStoreRole("canonical-journal");
  }

  load(): CanonicalJournalStoreSnapshotV1 | null {
    const root = this.#durable.readRoot();
    return root === null
      ? null
      : Object.freeze({ token: root.revision, bytes: new Uint8Array(root.envelopeBytes) });
  }

  compareAndSwap(expectedToken: string | null, bytes: Uint8Array): string {
    const next = this.#durable.compareAndSwapRoot(expectedToken ?? "0", bytes, []);
    return next.revision;
  }

  close(): void {
    this.#durable.close();
  }
}

function exactView(raw: unknown, context: string): CanonicalSourceView {
  try {
    assertPlainObject(raw, context);
    assertExactKeys(raw, ["chainId", "number", "hash", "stateRoot"], context);
    const object = raw;
    return deepFreeze({
      chainId: assertNonEmptyString(readOwnEnumerableDataProperty(object, "chainId", context), `${context}.chainId`),
      number: assertDecimalString(readOwnEnumerableDataProperty(object, "number", context), `${context}.number`),
      hash: assertHash(readOwnEnumerableDataProperty(object, "hash", context), `${context}.hash`),
      stateRoot: assertHash(readOwnEnumerableDataProperty(object, "stateRoot", context), `${context}.stateRoot`),
    });
  } catch (error) {
    if (error instanceof CanonicalSourceError) throw error;
    throw new CanonicalSourceError(
      "invalid-header",
      `${context} is not an exact canonical header: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function sameView(left: CanonicalSourceView, right: CanonicalSourceView): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function canonicalViewKey(view: CanonicalSourceView): string {
  return `${view.chainId}:${view.number}:${view.hash}:${view.stateRoot}`;
}

function exactAbsenceEvidence(raw: unknown, context: string): CanonicalHeaderAbsenceEvidenceV1 {
  assertPlainObject(raw, context);
  assertExactKeys(raw, [
    "chainId",
    "number",
    "expectedHash",
    "expectedStateRoot",
    "replacementHash",
    "replacementStateRoot",
    "journalEpoch",
    "canonicalJournalRoot",
  ], context);
  return deepFreeze({
    chainId: assertNonEmptyString(readOwnEnumerableDataProperty(raw, "chainId", context), `${context}.chainId`),
    number: assertDecimalString(readOwnEnumerableDataProperty(raw, "number", context), `${context}.number`),
    expectedHash: assertHash(readOwnEnumerableDataProperty(raw, "expectedHash", context), `${context}.expectedHash`),
    expectedStateRoot: assertHash(readOwnEnumerableDataProperty(raw, "expectedStateRoot", context), `${context}.expectedStateRoot`),
    replacementHash: assertHash(readOwnEnumerableDataProperty(raw, "replacementHash", context), `${context}.replacementHash`),
    replacementStateRoot: assertHash(readOwnEnumerableDataProperty(raw, "replacementStateRoot", context), `${context}.replacementStateRoot`),
    journalEpoch: assertDecimalString(readOwnEnumerableDataProperty(raw, "journalEpoch", context), `${context}.journalEpoch`),
    canonicalJournalRoot: assertHash(readOwnEnumerableDataProperty(raw, "canonicalJournalRoot", context), `${context}.canonicalJournalRoot`),
  });
}

interface CanonicalJournalStateV1 {
  readonly version: "1";
  readonly epoch: string;
  readonly currentView: CanonicalSourceView | null;
  readonly issuedViews: readonly CanonicalSourceView[];
  readonly provenAbsences: readonly CanonicalHeaderAbsenceEvidenceV1[];
  readonly journalRoot: Hash;
}

function sealCanonicalJournalState(input: Omit<CanonicalJournalStateV1, "version" | "journalRoot">): CanonicalJournalStateV1 {
  const issuedViews = [...input.issuedViews]
    .map((view, index) => exactView(view, `canonicalJournal.issuedViews[${index}]`))
    .sort((left, right) => {
      const leftKey = canonicalViewKey(left);
      const rightKey = canonicalViewKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  if (new Set(issuedViews.map(canonicalViewKey)).size !== issuedViews.length) {
    throw new CanonicalSourceError("invalid-header", "canonical journal has duplicate issued views", false);
  }
  const provenAbsences = [...input.provenAbsences]
    .map((evidence, index) => exactAbsenceEvidence(evidence, `canonicalJournal.provenAbsences[${index}]`))
    .sort((left, right) => {
      const leftKey = `${left.chainId}:${left.number}:${left.expectedHash}:${left.expectedStateRoot}`;
      const rightKey = `${right.chainId}:${right.number}:${right.expectedHash}:${right.expectedStateRoot}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const absenceKeys = provenAbsences.map(value =>
    `${value.chainId}:${value.number}:${value.expectedHash}:${value.expectedStateRoot}`);
  if (new Set(absenceKeys).size !== absenceKeys.length) {
    throw new CanonicalSourceError("invalid-header", "canonical journal has duplicate revocations", false);
  }
  const payload = deepFreeze({
    version: "1" as const,
    epoch: assertDecimalString(input.epoch, "canonicalJournal.epoch"),
    currentView: input.currentView === null ? null : exactView(input.currentView, "canonicalJournal.currentView"),
    issuedViews: deepFreeze(issuedViews),
    provenAbsences: deepFreeze(provenAbsences),
  });
  return deepFreeze({
    ...payload,
    journalRoot: hashDomain("aloha/canonical-journal-state/v1", payload),
  });
}

function decodeCanonicalJournalState(bytes: Uint8Array): CanonicalJournalStateV1 {
  const raw = decodeCanonicalJson(bytes);
  assertPlainObject(raw, "canonicalJournal");
  assertExactKeys(raw, ["version", "epoch", "currentView", "issuedViews", "provenAbsences", "journalRoot"], "canonicalJournal");
  if (readOwnEnumerableDataProperty(raw, "version", "canonicalJournal") !== "1") {
    throw new CanonicalSourceError("invalid-header", "unsupported canonical journal version", false);
  }
  const issuedViews = readOwnEnumerableDataProperty(raw, "issuedViews", "canonicalJournal");
  const provenAbsences = readOwnEnumerableDataProperty(raw, "provenAbsences", "canonicalJournal");
  if (!Array.isArray(issuedViews) || !Array.isArray(provenAbsences)) {
    throw new CanonicalSourceError("invalid-header", "canonical journal partitions are not arrays", false);
  }
  const currentRaw = readOwnEnumerableDataProperty(raw, "currentView", "canonicalJournal");
  const sealed = sealCanonicalJournalState({
    epoch: assertDecimalString(readOwnEnumerableDataProperty(raw, "epoch", "canonicalJournal"), "canonicalJournal.epoch"),
    currentView: currentRaw === null ? null : exactView(currentRaw, "canonicalJournal.currentView"),
    issuedViews: issuedViews.map((view, index) => exactView(view, `canonicalJournal.issuedViews[${index}]`)),
    provenAbsences: provenAbsences.map((evidence, index) => exactAbsenceEvidence(evidence, `canonicalJournal.provenAbsences[${index}]`)),
  });
  if (sealed.journalRoot !== assertHash(readOwnEnumerableDataProperty(raw, "journalRoot", "canonicalJournal"), "canonicalJournal.journalRoot")) {
    throw new CanonicalSourceError("invalid-header", "canonical journal root mismatch", false);
  }
  if (encodeCanonicalJson(sealed) !== encodeCanonicalJson(raw)) {
    throw new CanonicalSourceError("invalid-header", "canonical journal order is not canonical", false);
  }
  return sealed;
}

function compareHeaders(
  expected: CanonicalSourceView,
  observed: CanonicalHeader,
): Exclude<CanonicalCheckFailure, "transport" | "missing-header"> | null {
  if (observed.chainId !== expected.chainId) return "chain-id-mismatch";
  if (observed.number !== expected.number) return "number-mismatch";
  if (observed.hash !== expected.hash) return "hash-mismatch";
  if (observed.stateRoot !== expected.stateRoot) return "state-root-mismatch";
  return null;
}

function exactHeaderReadResult(raw: unknown, requestedNumber: BlockNumber): CanonicalHeaderReadResult {
  try {
    assertPlainObject(raw, "canonicalHeaderReadResult");
    const kind = assertNonEmptyString(
      readOwnEnumerableDataProperty(raw, "kind", "canonicalHeaderReadResult"),
      "canonicalHeaderReadResult.kind",
    );
    switch (kind) {
      case "found":
        assertExactKeys(raw, ["kind", "header"], "canonicalHeaderReadResult");
        return deepFreeze({
          kind,
          header: exactView(
            readOwnEnumerableDataProperty(raw, "header", "canonicalHeaderReadResult"),
            "canonicalHeaderReadResult.header",
          ),
        });
      case "chainProvenAbsent": {
        assertExactKeys(raw, ["kind", "evidence"], "canonicalHeaderReadResult");
        const evidence = exactAbsenceEvidence(
          readOwnEnumerableDataProperty(raw, "evidence", "canonicalHeaderReadResult"),
          "canonicalHeaderReadResult.evidence",
        );
        if (evidence.number !== requestedNumber) {
          throw new CanonicalSourceError("invalid-header", "canonical absence evidence number mismatch", false);
        }
        return deepFreeze({ kind, evidence });
      }
      case "unavailable":
        assertExactKeys(raw, ["kind", "failureCode"], "canonicalHeaderReadResult");
        return deepFreeze({
          kind,
          failureCode: assertNonEmptyString(
            readOwnEnumerableDataProperty(raw, "failureCode", "canonicalHeaderReadResult"),
            "canonicalHeaderReadResult.failureCode",
          ),
        });
      default:
        throw new CanonicalSourceError("invalid-header", `unknown canonical header read result ${kind}`, false);
    }
  } catch (error) {
    if (error instanceof CanonicalSourceError) throw error;
    throw new CanonicalSourceError(
      "invalid-header",
      `canonical header read result is invalid: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function failureError(
  reason: Exclude<CanonicalCheckFailure, "transport">,
  view: CanonicalSourceView,
  observed: CanonicalHeader | null,
): CanonicalSourceError {
  return new CanonicalSourceError(
    reason,
    reason === "missing-header"
      ? `canonical header ${view.number} is no longer available`
      : `canonical fence ${reason} at block ${view.number}`,
    false,
    view,
    observed,
  );
}

interface ActiveFence {
  readonly epoch: string;
  readonly cutoff: CanonicalSourceView;
}

interface ActivePromotionFreshness {
  readonly fenceToken: string;
  readonly receiptHash: Hash;
}

function exactCanonicalFence(rawFence: CanonicalFenceV1): CanonicalFenceV1 {
  try {
    assertPlainObject(rawFence, "canonicalFence");
    assertExactKeys(rawFence, ["token", "journalEpoch", "canonicalJournalRoot", "cutoff"], "canonicalFence");
    return deepFreeze({
      token: assertNonEmptyString(
        readOwnEnumerableDataProperty(rawFence, "token", "canonicalFence"),
        "canonicalFence.token",
      ),
      journalEpoch: assertDecimalString(
        readOwnEnumerableDataProperty(rawFence, "journalEpoch", "canonicalFence"),
        "canonicalFence.journalEpoch",
      ),
      canonicalJournalRoot: assertHash(
        readOwnEnumerableDataProperty(rawFence, "canonicalJournalRoot", "canonicalFence"),
        "canonicalFence.canonicalJournalRoot",
      ),
      cutoff: exactView(
        readOwnEnumerableDataProperty(rawFence, "cutoff", "canonicalFence"),
        "canonicalFence.cutoff",
      ),
    });
  } catch (error) {
    if (error instanceof CanonicalSourceError) throw error;
    throw new CanonicalSourceError(
      "fence-invalid",
      `malformed canonical fence: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function exactPromotionFreshnessReceipt(
  raw: unknown,
  context: string,
): PromotionFreshnessReceiptV1 {
  assertPlainObject(raw, context);
  assertExactKeys(raw, [
    "cutoff",
    "observedHead",
    "observedAgeBlocks",
    "maxPromotionAgeBlocks",
    "generationRefreshPolicyHash",
    "journalEpoch",
    "canonicalJournalRoot",
    "freshnessReceiptHash",
  ], context);
  const receipt = deepFreeze({
    cutoff: exactView(readOwnEnumerableDataProperty(raw, "cutoff", context), `${context}.cutoff`),
    observedHead: exactView(readOwnEnumerableDataProperty(raw, "observedHead", context), `${context}.observedHead`),
    observedAgeBlocks: assertDecimalString(
      readOwnEnumerableDataProperty(raw, "observedAgeBlocks", context),
      `${context}.observedAgeBlocks`,
    ),
    maxPromotionAgeBlocks: assertDecimalString(
      readOwnEnumerableDataProperty(raw, "maxPromotionAgeBlocks", context),
      `${context}.maxPromotionAgeBlocks`,
    ),
    generationRefreshPolicyHash: assertHash(
      readOwnEnumerableDataProperty(raw, "generationRefreshPolicyHash", context),
      `${context}.generationRefreshPolicyHash`,
    ),
    journalEpoch: assertDecimalString(
      readOwnEnumerableDataProperty(raw, "journalEpoch", context),
      `${context}.journalEpoch`,
    ),
    canonicalJournalRoot: assertHash(
      readOwnEnumerableDataProperty(raw, "canonicalJournalRoot", context),
      `${context}.canonicalJournalRoot`,
    ),
    freshnessReceiptHash: assertHash(
      readOwnEnumerableDataProperty(raw, "freshnessReceiptHash", context),
      `${context}.freshnessReceiptHash`,
    ),
  });
  if (receipt.cutoff.chainId !== receipt.observedHead.chainId) {
    throw new CanonicalSourceError("chain-id-mismatch", "freshness head chain does not match cutoff", false);
  }
  const observedAge = BigInt(receipt.observedHead.number) - BigInt(receipt.cutoff.number);
  if (observedAge < 0n || observedAge.toString() !== receipt.observedAgeBlocks) {
    throw new CanonicalSourceError("number-mismatch", "freshness observed age does not match head", false);
  }
  if (observedAge > BigInt(receipt.maxPromotionAgeBlocks)) {
    throw new CanonicalSourceError("promotion-stale", "freshness observation exceeds promotion age", false);
  }
  const payload = {
    cutoff: receipt.cutoff,
    observedHead: receipt.observedHead,
    observedAgeBlocks: receipt.observedAgeBlocks,
    maxPromotionAgeBlocks: receipt.maxPromotionAgeBlocks,
    generationRefreshPolicyHash: receipt.generationRefreshPolicyHash,
    journalEpoch: receipt.journalEpoch,
    canonicalJournalRoot: receipt.canonicalJournalRoot,
  };
  if (hashDomain("aloha/promotion-freshness-receipt/v1", payload) !== receipt.freshnessReceiptHash) {
    throw new CanonicalSourceError("fence-invalid", "freshness receipt hash mismatch", false);
  }
  return receipt;
}

export function validatePromotionFreshnessReceipt(
  raw: unknown,
): PromotionFreshnessReceiptV1 {
  return exactPromotionFreshnessReceipt(raw, "promotionFreshnessReceipt");
}

/** Owns the only canonical cutoff journal and canonical-fence issuer. */
export class CanonicalSource implements CanonicalFencePort {
  readonly #provider: CanonicalHeaderProvider;
  readonly #chainGenesis: bigint;
  readonly #journalStore: CanonicalJournalStorePort;
  readonly #activeFences = new Map<string, ActiveFence>();
  readonly #activePromotionFreshness = new Map<string, ActivePromotionFreshness>();
  readonly #issuedViews = new Map<string, CanonicalSourceView>();
  readonly #provenAbsences = new Map<string, CanonicalHeaderAbsenceEvidenceV1>();
  #journalEpoch = 0n;
  #currentView: CanonicalSourceView | null = null;
  #journalToken: string | null = null;
  #journalRoot = sealCanonicalJournalState({
    epoch: "0",
    currentView: null,
    issuedViews: [],
    provenAbsences: [],
  }).journalRoot;

  constructor(provider: CanonicalHeaderProvider, options: CanonicalSourceOptions) {
    this.#provider = provider;
    if (
      !options.journalStore
      || typeof options.journalStore.load !== "function"
      || typeof options.journalStore.compareAndSwap !== "function"
    ) {
      throw new CanonicalSourceError("invalid-header", "durable canonical journal store is required", false);
    }
    this.#journalStore = options.journalStore;
    const genesis = options.chainGenesis ?? "0";
    try {
      this.#chainGenesis = BigInt(assertDecimalString(genesis, "chainGenesis"));
    } catch (error) {
      throw new CanonicalSourceError(
        "invalid-header",
        `invalid chain genesis: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const persisted = this.#journalStore.load();
    if (persisted !== null) this.#applyJournalSnapshot(persisted);
  }

  get journalEpoch(): string {
    return this.#journalEpoch.toString();
  }

  get currentView(): CanonicalSourceView | null {
    return this.#currentView;
  }

  async freezeView(signal?: AbortSignal): Promise<CanonicalSourceView> {
    this.#synchronizeJournal();
    const latest = await this.#readLatest(signal);
    if (BigInt(latest.number) < this.#chainGenesis) {
      throw new CanonicalSourceError("invalid-header", "canonical head precedes configured genesis", false);
    }
    if (this.#provenAbsences.has(canonicalViewKey(latest))) {
      throw new CanonicalSourceError("missing-header", "revoked canonical cutoff cannot be reissued", false, latest, null);
    }
    const readResult = await this.#readHeader(latest.number, signal);
    if (readResult.kind === "unavailable") {
      throw new CanonicalSourceError("transport", "canonical freeze read is unavailable", true, latest, null);
    }
    if (readResult.kind !== "found") {
      throw new CanonicalSourceError("invalid-header", "canonical freeze cannot consume provider absence authority", false, latest, null);
    }
    const reason = compareHeaders(latest, readResult.header);
    if (reason !== null) throw failureError(reason, latest, readResult.header);
    const issuedViews = new Map(this.#issuedViews);
    issuedViews.set(canonicalViewKey(latest), latest);
    this.#persistJournalState({
      epoch: (this.#journalEpoch + 1n).toString(),
      currentView: latest,
      issuedViews: [...issuedViews.values()],
      provenAbsences: [...this.#provenAbsences.values()],
    });
    this.#revokeAllFences();
    return latest;
  }

  async checkStillCanonical(
    rawView: CanonicalSourceView,
    signal?: AbortSignal,
  ): Promise<CanonicalCheck> {
    this.#synchronizeJournal();
    const journalTokenBeforeRead = this.#journalToken;
    const journalRootBeforeRead = this.#journalRoot;
    const journalEpochBeforeRead = this.#journalEpoch;
    const view = exactView(rawView, "canonicalView");
    const viewKey = canonicalViewKey(view);
    if (!this.#issuedViews.has(viewKey)) {
      throw new CanonicalSourceError("fence-invalid", "canonical view was not issued by this durable journal", false, view, null);
    }
    const revoked = this.#provenAbsences.get(viewKey);
    if (revoked) {
      return deepFreeze({
        ok: false,
        retryable: false,
        reason: "missing-header",
        expected: view,
        observed: null,
        absenceEvidence: revoked,
        journalEpoch: this.journalEpoch,
      });
    }
    let readResult: CanonicalHeaderReadResult;
    try {
      readResult = await this.#readHeader(view.number, signal);
    } catch (error) {
      if (error instanceof CanonicalSourceError && !error.retryable) throw error;
      this.#assertJournalAnchor(
        journalTokenBeforeRead,
        journalRootBeforeRead,
        journalEpochBeforeRead,
      );
      return deepFreeze({
        ok: false,
        retryable: true,
        reason: "transport",
        expected: view,
        observed: null,
        absenceEvidence: null,
        journalEpoch: this.journalEpoch,
      });
    }
    this.#assertJournalAnchor(
      journalTokenBeforeRead,
      journalRootBeforeRead,
      journalEpochBeforeRead,
    );
    if (readResult.kind === "unavailable") {
      return deepFreeze({
        ok: false,
        retryable: true,
        reason: "transport",
        expected: view,
        observed: null,
        absenceEvidence: null,
        journalEpoch: this.journalEpoch,
      });
    }
    if (readResult.kind === "chainProvenAbsent") {
      const recorded = this.#provenAbsences.get(canonicalViewKey(view));
      if (!recorded || encodeCanonicalJson(recorded) !== encodeCanonicalJson(readResult.evidence)) {
        throw new CanonicalSourceError(
          "invalid-header",
          "provider supplied absence evidence that was not issued by the canonical journal",
          false,
          view,
          null,
        );
      }
      return deepFreeze({
        ok: false,
        retryable: false,
        reason: "missing-header",
        expected: view,
        observed: null,
        absenceEvidence: readResult.evidence,
        journalEpoch: this.journalEpoch,
      });
    }
    const observed = readResult.header;
    const reason = compareHeaders(view, observed);
    let absenceEvidence: CanonicalHeaderAbsenceEvidenceV1 | null = null;
    if (
      (reason === "hash-mismatch" || reason === "state-root-mismatch")
      && observed.chainId === view.chainId
      && observed.number === view.number
    ) {
      absenceEvidence = this.#revokeView(view, observed);
    }
    return reason === null
      ? deepFreeze({ ok: true, view, journalEpoch: this.journalEpoch })
      : deepFreeze({
        ok: false,
        retryable: false,
        reason,
        expected: view,
        observed,
        absenceEvidence,
        journalEpoch: this.journalEpoch,
      });
  }

  async assertStillCanonical(rawView: CanonicalSourceView): Promise<void> {
    const view = exactView(rawView, "canonicalView");
    const check = await this.checkStillCanonical(view);
    if (check.ok) return;
    if (check.retryable || check.reason === "transport") {
      throw new CanonicalSourceError(
        "transport",
        "canonical fence transport check is unresolved",
        true,
        view,
        check.observed,
      );
    }
    throw failureError(check.reason, view, check.observed);
  }

  async ageInBlocks(rawView: CanonicalSourceView): Promise<string> {
    const view = exactView(rawView, "canonicalView");
    await this.assertStillCanonical(view);
    const latest = await this.#readLatest();
    if (latest.chainId !== view.chainId) throw failureError("chain-id-mismatch", view, latest);
    const distance = BigInt(latest.number) - BigInt(view.number);
    if (distance < 0n) throw failureError("number-mismatch", view, latest);
    return distance.toString();
  }

  async observePromotionFreshness(
    rawFence: CanonicalFenceV1,
    rawRequest: PromotionFreshnessRequestV1,
  ): Promise<PromotionFreshnessAuthorityV1> {
    const fence = exactCanonicalFence(rawFence);
    this.assertActiveFence(fence);
    assertPlainObject(rawRequest, "promotionFreshnessRequest");
    assertExactKeys(
      rawRequest,
      ["cutoff", "maxPromotionAgeBlocks", "generationRefreshPolicyHash"],
      "promotionFreshnessRequest",
    );
    const request = deepFreeze({
      cutoff: exactView(
        readOwnEnumerableDataProperty(rawRequest, "cutoff", "promotionFreshnessRequest"),
        "promotionFreshnessRequest.cutoff",
      ),
      maxPromotionAgeBlocks: assertDecimalString(
        readOwnEnumerableDataProperty(rawRequest, "maxPromotionAgeBlocks", "promotionFreshnessRequest"),
        "promotionFreshnessRequest.maxPromotionAgeBlocks",
      ),
      generationRefreshPolicyHash: assertHash(
        readOwnEnumerableDataProperty(rawRequest, "generationRefreshPolicyHash", "promotionFreshnessRequest"),
        "promotionFreshnessRequest.generationRefreshPolicyHash",
      ),
    });
    if (!sameView(request.cutoff, fence.cutoff)) {
      throw new CanonicalSourceError("fence-invalid", "freshness request cutoff does not match fence", false);
    }
    const journalTokenBeforeRead = this.#journalToken;
    const journalRootBeforeRead = this.#journalRoot;
    const journalEpochBeforeRead = this.#journalEpoch;
    const observedHead = await this.#readLatest();
    this.#assertJournalAnchor(journalTokenBeforeRead, journalRootBeforeRead, journalEpochBeforeRead);
    this.assertActiveFence(fence);
    if (observedHead.chainId !== request.cutoff.chainId) {
      throw failureError("chain-id-mismatch", request.cutoff, observedHead);
    }
    const observedAge = BigInt(observedHead.number) - BigInt(request.cutoff.number);
    if (observedAge < 0n) throw failureError("number-mismatch", request.cutoff, observedHead);
    if (observedAge > BigInt(request.maxPromotionAgeBlocks)) {
      throw new CanonicalSourceError(
        "promotion-stale",
        "promotion cutoff is too old at the independently observed head",
        false,
        request.cutoff,
        observedHead,
      );
    }
    const payload = deepFreeze({
      cutoff: request.cutoff,
      observedHead,
      observedAgeBlocks: observedAge.toString(),
      maxPromotionAgeBlocks: request.maxPromotionAgeBlocks,
      generationRefreshPolicyHash: request.generationRefreshPolicyHash,
      journalEpoch: fence.journalEpoch,
      canonicalJournalRoot: fence.canonicalJournalRoot,
    });
    const receipt = deepFreeze({
      ...payload,
      freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", payload),
    });
    const token = randomUUID();
    this.#activePromotionFreshness.set(token, {
      fenceToken: fence.token,
      receiptHash: receipt.freshnessReceiptHash,
    });
    return deepFreeze({ token, receipt });
  }

  /** Synchronous issuer check used by the checkpoint before-commit guard. */
  assertPromotionFreshness(
    rawFence: CanonicalFenceV1,
    rawAuthority: PromotionFreshnessAuthorityV1,
  ): void {
    const fence = exactCanonicalFence(rawFence);
    this.assertActiveFence(fence);
    assertPlainObject(rawAuthority, "promotionFreshnessAuthority");
    assertExactKeys(rawAuthority, ["token", "receipt"], "promotionFreshnessAuthority");
    const token = assertNonEmptyString(
      readOwnEnumerableDataProperty(rawAuthority, "token", "promotionFreshnessAuthority"),
      "promotionFreshnessAuthority.token",
    );
    const receipt = exactPromotionFreshnessReceipt(
      readOwnEnumerableDataProperty(rawAuthority, "receipt", "promotionFreshnessAuthority"),
      "promotionFreshnessAuthority.receipt",
    );
    const active = this.#activePromotionFreshness.get(token);
    if (
      !active
      || active.fenceToken !== fence.token
      || active.receiptHash !== receipt.freshnessReceiptHash
      || receipt.journalEpoch !== fence.journalEpoch
      || receipt.canonicalJournalRoot !== fence.canonicalJournalRoot
      || !sameView(receipt.cutoff, fence.cutoff)
    ) {
      throw new CanonicalSourceError("fence-invalid", "promotion freshness was not issued for this fence", false);
    }
  }

  async withCanonicalFence<T>(
    rawCutoff: CanonicalSourceView,
    work: (fence: CanonicalFenceV1) => Promise<T>,
  ): Promise<T> {
    const cutoff = exactView(rawCutoff, "canonicalCutoff");
    await this.assertStillCanonical(cutoff);
    if (!this.#currentView || !sameView(this.#currentView, cutoff)) {
      throw new CanonicalSourceError(
        "canonical-view-superseded",
        "canonical cutoff is not the current issued view",
        false,
        cutoff,
        this.#currentView,
      );
    }
    const token = randomUUID();
    const fence = deepFreeze({
      token,
      journalEpoch: this.journalEpoch,
      canonicalJournalRoot: this.#journalRoot,
      cutoff,
    });
    this.#activeFences.set(token, { epoch: fence.journalEpoch, cutoff });
    try {
      this.assertActiveFence(fence);
      const result = await work(fence);
      this.assertActiveFence(fence);
      await this.assertStillCanonical(cutoff);
      return result;
    } finally {
      for (const [freshnessToken, freshness] of this.#activePromotionFreshness) {
        if (freshness.fenceToken === token) this.#activePromotionFreshness.delete(freshnessToken);
      }
      this.#activeFences.delete(token);
    }
  }

  /** Synchronous issuer check used inside the SQLite fenced transaction. */
  assertActiveFence(rawFence: CanonicalFenceV1): void {
    const fence = exactCanonicalFence(rawFence);
    this.#assertJournalSnapshotCurrent();
    const active = this.#activeFences.get(fence.token);
    if (
      !active
      || active.epoch !== fence.journalEpoch
      || fence.journalEpoch !== this.journalEpoch
      || fence.canonicalJournalRoot !== this.#journalRoot
      || !sameView(active.cutoff, fence.cutoff)
      || !this.#currentView
      || !sameView(this.#currentView, fence.cutoff)
      || !this.#issuedViews.has(canonicalViewKey(fence.cutoff))
      || this.#provenAbsences.has(canonicalViewKey(fence.cutoff))
    ) {
      throw new CanonicalSourceError("fence-invalid", "canonical fence was not issued or is no longer active", false);
    }
  }

  #revokeView(
    expected: CanonicalSourceView,
    replacement: CanonicalHeader,
  ): CanonicalHeaderAbsenceEvidenceV1 {
    const key = canonicalViewKey(expected);
    const existing = this.#provenAbsences.get(key);
    if (existing) return existing;
    if (!this.#issuedViews.has(key)) {
      throw new CanonicalSourceError("fence-invalid", "canonical view was not issued and cannot be revoked", false);
    }
    const nextEpoch = this.#journalEpoch + 1n;
    const payload = {
      chainId: expected.chainId,
      number: expected.number,
      expectedHash: expected.hash,
      expectedStateRoot: expected.stateRoot,
      replacementHash: replacement.hash,
      replacementStateRoot: replacement.stateRoot,
      journalEpoch: nextEpoch.toString(),
    };
    const evidence = deepFreeze({
      ...payload,
      canonicalJournalRoot: hashDomain("aloha/canonical-journal-transition/v1", {
        priorJournalRoot: this.#journalRoot,
        revocation: payload,
      }),
    });
    const absences = new Map(this.#provenAbsences);
    absences.set(key, evidence);
    this.#persistJournalState({
      epoch: nextEpoch.toString(),
      currentView: this.#currentView && sameView(this.#currentView, expected) ? null : this.#currentView,
      issuedViews: [...this.#issuedViews.values()],
      provenAbsences: [...absences.values()],
    });
    this.#revokeAllFences();
    return evidence;
  }

  recentObservationRange(rawView: CanonicalSourceView): BlockRangeV1 {
    const view = exactView(rawView, "canonicalView");
    const cutoff = BigInt(view.number);
    if (cutoff < this.#chainGenesis) {
      throw new CanonicalSourceError("invalid-header", "canonical cutoff precedes configured genesis", false);
    }
    const unclamped = cutoff > 49n ? cutoff - 49n : 0n;
    const from = unclamped < this.#chainGenesis ? this.#chainGenesis : unclamped;
    return deepFreeze({ from: from.toString(), to: view.number });
  }

  assertViewAuthorityActive(rawView: CanonicalSourceView): void {
    this.#synchronizeJournal();
    const view = exactView(rawView, "canonicalLeaseCutoff");
    const key = canonicalViewKey(view);
    if (!this.#issuedViews.has(key) || this.#provenAbsences.has(key)) {
      throw new CanonicalSourceError("fence-invalid", "canonical view authority is not active", false, view, null);
    }
  }

  async #readHeader(number: BlockNumber, signal?: AbortSignal): Promise<CanonicalHeaderReadResult> {
    try {
      return exactHeaderReadResult(await this.#provider.getHeader(number, signal), number);
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "transport",
        `canonical header read failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  #persistJournalState(input: Omit<CanonicalJournalStateV1, "version" | "journalRoot">): void {
    const state = sealCanonicalJournalState(input);
    let nextToken: string;
    try {
      nextToken = this.#journalStore.compareAndSwap(this.#journalToken, encodeCanonicalBytes(state));
    } catch (error) {
      this.#revokeAllFences();
      this.#synchronizeJournal();
      throw new CanonicalSourceError(
        "fence-invalid",
        `canonical journal CAS failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    this.#applyJournalState(assertDecimalString(nextToken, "canonicalJournal.storageToken"), state);
  }

  #applyJournalSnapshot(snapshot: CanonicalJournalStoreSnapshotV1): void {
    const token = assertDecimalString(snapshot.token, "canonicalJournal.storageToken");
    this.#applyJournalState(token, decodeCanonicalJournalState(snapshot.bytes));
  }

  #applyJournalState(token: string, state: CanonicalJournalStateV1): void {
    this.#journalToken = token;
    this.#journalEpoch = BigInt(state.epoch);
    this.#currentView = state.currentView;
    this.#journalRoot = state.journalRoot;
    this.#issuedViews.clear();
    for (const view of state.issuedViews) this.#issuedViews.set(canonicalViewKey(view), view);
    this.#provenAbsences.clear();
    for (const evidence of state.provenAbsences) {
      const key = canonicalViewKey({
        chainId: evidence.chainId,
        number: evidence.number,
        hash: evidence.expectedHash,
        stateRoot: evidence.expectedStateRoot,
      });
      if (!this.#issuedViews.has(key)) {
        throw new CanonicalSourceError("invalid-header", "canonical revocation lacks an issued view", false);
      }
      this.#provenAbsences.set(key, evidence);
    }
    if (
      this.#currentView !== null
      && (!this.#issuedViews.has(canonicalViewKey(this.#currentView))
        || this.#provenAbsences.has(canonicalViewKey(this.#currentView)))
    ) {
      throw new CanonicalSourceError("invalid-header", "canonical journal current view is not active", false);
    }
  }

  #synchronizeJournal(): void {
    const snapshot = this.#journalStore.load();
    if (snapshot === null) {
      if (this.#journalToken !== null) {
        this.#revokeAllFences();
        throw new CanonicalSourceError("fence-invalid", "canonical journal disappeared", false);
      }
      return;
    }
    const token = assertDecimalString(snapshot.token, "canonicalJournal.storageToken");
    const state = decodeCanonicalJournalState(snapshot.bytes);
    if (
      token === this.#journalToken
      && state.epoch === this.journalEpoch
      && state.journalRoot === this.#journalRoot
    ) return;
    this.#revokeAllFences();
    this.#applyJournalState(token, state);
  }

  #assertJournalSnapshotCurrent(): void {
    const expectedToken = this.#journalToken;
    const expectedRoot = this.#journalRoot;
    const expectedEpoch = this.#journalEpoch;
    this.#synchronizeJournal();
    if (
      this.#journalToken !== expectedToken
      || this.#journalRoot !== expectedRoot
      || this.#journalEpoch !== expectedEpoch
    ) {
      this.#revokeAllFences();
      throw new CanonicalSourceError("fence-invalid", "canonical journal changed while the fence was active", false);
    }
  }

  #assertJournalAnchor(token: string | null, root: Hash, epoch: bigint): void {
    this.#synchronizeJournal();
    if (
      this.#journalToken !== token
      || this.#journalRoot !== root
      || this.#journalEpoch !== epoch
    ) {
      this.#revokeAllFences();
      throw new CanonicalSourceError(
        "fence-invalid",
        "canonical journal changed during the provider observation",
        false,
      );
    }
  }

  async #readLatest(signal?: AbortSignal): Promise<CanonicalHeader> {
    try {
      return exactView(await this.#provider.getLatestHeader(signal), "latestHeader");
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "transport",
        `canonical latest-header read failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  #revokeAllFences(): void {
    this.#activeFences.clear();
    this.#activePromotionFreshness.clear();
  }
}

export function canonicalSourceViewHash(view: CanonicalSourceView): Hash {
  return hashDomain("aloha/canonical-source-view/v1", exactView(view, "canonicalView"));
}

export function createCanonicalSource(
  provider: CanonicalHeaderProvider,
  options: CanonicalSourceOptions,
): CanonicalSource {
  return new CanonicalSource(provider, options);
}

export function createCanonicalHeaderProvider(input: {
  readonly latest: (signal?: AbortSignal) => Promise<CanonicalHeader>;
  readonly at: (number: BlockNumber, signal?: AbortSignal) => Promise<CanonicalHeaderReadResult>;
}): CanonicalHeaderProvider {
  return deepFreeze({ getLatestHeader: input.latest, getHeader: input.at });
}

export function encodeCanonicalSourceView(view: CanonicalSourceView): Uint8Array {
  return encodeCanonicalBytes(exactView(view, "canonicalView"));
}
