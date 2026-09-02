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
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
import type { CanonicalLeaseGuardPort } from "./lease-guard-port.ts";
export type { CanonicalLeaseGuardPort } from "./lease-guard-port.ts";

export type BlockNumber = string;
export type CanonicalSourceView = CanonicalCutoffV1;
/** Exact observed chain header; unlike a cutoff, it proves its parent edge. */
export interface CanonicalHeader extends CanonicalSourceView {
  readonly parentHash: Hash;
}
/** A producer head is an exact current-chain source anchor, never a ready cutoff. */
export type CanonicalHeadV1 = CanonicalHeader;
export type CanonicalHead = CanonicalHeadV1;

/** Process-local opaque proof of one stable, exact current-head observation. */
declare const canonicalHeadObservationCapabilityBrand: unique symbol;
export interface CanonicalHeadObservationCapabilityV1 {
  readonly [canonicalHeadObservationCapabilityBrand]: never;
}

export interface CanonicalHeadObservationV1 {
  readonly head: CanonicalHead;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly observedMonotonicNs: string;
}

/** Read-only verifier for capabilities issued by one CanonicalSource owner. */
export interface CanonicalHeadObservationReaderPortV1 {
  readonly assert: (
    capability: unknown,
  ) => asserts capability is CanonicalHeadObservationCapabilityV1;
  readonly read: (
    capability: CanonicalHeadObservationCapabilityV1,
  ) => CanonicalHeadObservationV1;
}

/** Process-local identity of the canonical source authority. */
declare const canonicalSourceAuthorityBrand: unique symbol;
export interface CanonicalSourceAuthorityV1 {
  readonly [canonicalSourceAuthorityBrand]: never;
}

/**
 * The portion of a GraphView lease that a producer is allowed to pin.
 *
 * This deliberately mirrors the graph package's binding structurally instead
 * of importing GraphView.  canonical-source owns source/session authority;
 * graph owns route handles and graph semantics.
 */
export interface ProducerGenerationBindingV1 {
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalSourceView;
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
}

/** Minimal GraphView lease contract needed by a producer session. */
export interface ProducerGraphViewV1 {
  readonly binding: ProducerGenerationBindingV1;
  readonly edges?: readonly unknown[];
  assertActive(): Promise<void> | void;
}

/**
 * Opaque process-local proof of one CanonicalSource-issued producer session.
 * Consumers receive this capability instead of the structurally wider
 * ProducerSession object; clones and lookalikes carry no authority.
 */
declare const producerCurrentSourceSessionCapabilityBrand: unique symbol;
export interface ProducerCurrentSourceSessionCapabilityV1 {
  readonly [producerCurrentSourceSessionCapabilityBrand]: never;
}

export interface ProducerCurrentSourceSessionViewV1 {
  readonly sessionId: Hash;
  readonly source: CanonicalHead;
  readonly generation: ProducerGenerationBindingV1;
  readonly generationId: string;
  readonly canonicalSourceAuthority: CanonicalSourceAuthorityV1;
  readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
}

const producerCurrentSourceSessions = new WeakMap<object, ProducerCurrentSourceSessionViewV1>();

export function readIssuedProducerCurrentSourceSessionCapabilityV1(
  value: unknown,
): ProducerCurrentSourceSessionViewV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("producer current-source session capability is required");
  }
  const session = producerCurrentSourceSessions.get(value);
  if (session === undefined) {
    throw new TypeError("producer current-source session capability is not canonical-source issued");
  }
  return session;
}

/**
 * Structural current-source contract consumed by the search pipeline.  The
 * source is the producer's current head, while the lease is one immutable
 * ready generation for the whole session.
 */
export interface ProducerSessionV1<GraphView extends ProducerGraphViewV1 = ProducerGraphViewV1> {
  readonly sessionId: Hash;
  readonly currentSourceCapability: ProducerCurrentSourceSessionCapabilityV1;
  readonly source: CanonicalHead;
  readonly head: CanonicalHead;
  readonly lease: GraphView;
  readonly graphView: GraphView;
  readonly generation: ProducerGenerationBindingV1;
  readonly generationId: string;
  readonly closed: boolean;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface ProducerHeadObservationV1 {
  readonly sourceHeadSeenAtMs: number;
  readonly sourceHeadSeenMonotonicMs: number;
}

export interface ProducerHeadRunContextV1 extends ProducerHeadObservationV1 {
  readonly revision: string;
}

export type ProducerHeadDropReasonV1 =
  | "scheduler_coalesced"
  | "shutdown_pending_dropped";

export interface ProducerHeadDropV1 extends ProducerHeadRunContextV1 {
  readonly head: CanonicalHead;
  readonly reason: ProducerHeadDropReasonV1;
}

export interface ProducerHeadSchedulerTelemetryV1 {
  readonly submitted: number;
  readonly started: number;
  readonly completed: number;
  readonly coalesced: number;
  readonly latestSubmitted: CanonicalHead | null;
  readonly active: CanonicalHead | null;
  readonly pending: CanonicalHead | null;
}

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

export class CanonicalSourceError extends Error {
  readonly code:
    | "invalid-header"
    | CanonicalCheckFailure
    | "promotion-stale"
    | "canonical-view-superseded"
    | "fence-invalid"
    | "producer-session-closed"
    | "producer-session-invalidated"
    | "generation-mismatch"
    | "topology-mismatch"
    | "recent-observation-window-unavailable";
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

function exactHeader(raw: unknown, context: string): CanonicalHeader {
  try {
    assertPlainObject(raw, context);
    assertExactKeys(raw, ["chainId", "number", "hash", "parentHash", "stateRoot"], context);
    return deepFreeze({
      chainId: assertNonEmptyString(readOwnEnumerableDataProperty(raw, "chainId", context), `${context}.chainId`),
      number: assertDecimalString(readOwnEnumerableDataProperty(raw, "number", context), `${context}.number`),
      hash: assertHash(readOwnEnumerableDataProperty(raw, "hash", context), `${context}.hash`),
      parentHash: assertHash(readOwnEnumerableDataProperty(raw, "parentHash", context), `${context}.parentHash`),
      stateRoot: assertHash(readOwnEnumerableDataProperty(raw, "stateRoot", context), `${context}.stateRoot`),
    });
  } catch (error) {
    if (error instanceof CanonicalSourceError) throw error;
    throw new CanonicalSourceError(
      "invalid-header",
      `${context} is not an exact observed canonical header: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function viewFromHeader(header: CanonicalHeader): CanonicalSourceView {
  return deepFreeze({
    chainId: header.chainId,
    number: header.number,
    hash: header.hash,
    stateRoot: header.stateRoot,
  });
}

function sameView(left: CanonicalSourceView, right: CanonicalSourceView): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function sameHeader(left: CanonicalHeader, right: CanonicalHeader): boolean {
  return sameView(left, right) && left.parentHash === right.parentHash;
}

function exactProducerGenerationBinding(
  raw: unknown,
  context: string,
): ProducerGenerationBindingV1 {
  try {
    assertPlainObject(raw, context);
    assertExactKeys(raw, [
      "generationId",
      "readyRecordHash",
      "generationRefreshPolicyHash",
      "cutoff",
      "definitionCatalogRoot",
      "instanceCatalogRoot",
      "graphRoot",
      "runtimeAuthority",
      "candidatePartitionCommitmentStorageHash",
      "nominationClosureRoot",
      "nominationClosureStorageHash",
    ], context);
    const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(
      readOwnEnumerableDataProperty(raw, "runtimeAuthority", context),
    );
    return deepFreeze({
      generationId: assertNonEmptyString(
        readOwnEnumerableDataProperty(raw, "generationId", context),
        `${context}.generationId`,
      ),
      readyRecordHash: assertHash(
        readOwnEnumerableDataProperty(raw, "readyRecordHash", context),
        `${context}.readyRecordHash`,
      ),
      generationRefreshPolicyHash: assertHash(
        readOwnEnumerableDataProperty(raw, "generationRefreshPolicyHash", context),
        `${context}.generationRefreshPolicyHash`,
      ),
      cutoff: exactView(
        readOwnEnumerableDataProperty(raw, "cutoff", context),
        `${context}.cutoff`,
      ),
      definitionCatalogRoot: assertHash(
        readOwnEnumerableDataProperty(raw, "definitionCatalogRoot", context),
        `${context}.definitionCatalogRoot`,
      ),
      instanceCatalogRoot: assertHash(
        readOwnEnumerableDataProperty(raw, "instanceCatalogRoot", context),
        `${context}.instanceCatalogRoot`,
      ),
      graphRoot: assertHash(
        readOwnEnumerableDataProperty(raw, "graphRoot", context),
        `${context}.graphRoot`,
      ),
      runtimeAuthority,
      candidatePartitionCommitmentStorageHash: assertHash(
        readOwnEnumerableDataProperty(raw, "candidatePartitionCommitmentStorageHash", context),
        `${context}.candidatePartitionCommitmentStorageHash`,
      ),
      nominationClosureRoot: assertHash(
        readOwnEnumerableDataProperty(raw, "nominationClosureRoot", context),
        `${context}.nominationClosureRoot`,
      ),
      nominationClosureStorageHash: assertHash(
        readOwnEnumerableDataProperty(raw, "nominationClosureStorageHash", context),
        `${context}.nominationClosureStorageHash`,
      ),
    });
  } catch (error) {
    if (error instanceof CanonicalSourceError) throw error;
    throw new CanonicalSourceError(
      "generation-mismatch",
      `${context} is not an exact producer generation binding: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function sameProducerGenerationBinding(
  left: ProducerGenerationBindingV1,
  right: ProducerGenerationBindingV1,
): boolean {
  return left.generationId === right.generationId
    && left.readyRecordHash === right.readyRecordHash
    && left.generationRefreshPolicyHash === right.generationRefreshPolicyHash
    && sameView(left.cutoff, right.cutoff)
    && left.definitionCatalogRoot === right.definitionCatalogRoot
    && left.instanceCatalogRoot === right.instanceCatalogRoot
    && left.graphRoot === right.graphRoot
    && left.runtimeAuthority.authorityBindingHash === right.runtimeAuthority.authorityBindingHash
    && left.runtimeAuthority.implementationCommit === right.runtimeAuthority.implementationCommit
    && left.candidatePartitionCommitmentStorageHash === right.candidatePartitionCommitmentStorageHash
    && left.nominationClosureRoot === right.nominationClosureRoot
    && left.nominationClosureStorageHash === right.nominationClosureStorageHash;
}

function assertProducerGraphView(
  raw: unknown,
  context: string,
): ProducerGraphViewV1 {
  if (raw === null || typeof raw !== "object") {
    throw new CanonicalSourceError("generation-mismatch", `${context} is required`, false);
  }
  const graph = raw as Record<string, unknown>;
  const binding = exactProducerGenerationBinding(
    readOwnEnumerableDataProperty(graph, "binding", context),
    `${context}.binding`,
  );
  if (typeof graph.assertActive !== "function") {
    throw new CanonicalSourceError("generation-mismatch", `${context}.assertActive is required`, false);
  }
  const edges = Object.prototype.hasOwnProperty.call(graph, "edges")
    ? readOwnEnumerableDataProperty(graph, "edges", context)
    : undefined;
  if (edges !== undefined) {
    if (!Array.isArray(edges) || !Object.isFrozen(edges)) {
      throw new CanonicalSourceError("topology-mismatch", `${context}.edges must be an immutable array`, false);
    }
    for (const edge of edges) {
      if (edge !== null && typeof edge === "object" && !Object.isFrozen(edge)) {
        throw new CanonicalSourceError("topology-mismatch", `${context}.edges contains mutable topology`, false);
      }
    }
  }
  // Keep validation strict while returning the caller's lease object so route
  // capability identity remains owned by the graph package.
  void binding;
  return raw as ProducerGraphViewV1;
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
          header: exactHeader(
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

interface CanonicalHeadObservationStateV1 {
  readonly observation: CanonicalHeadObservationV1;
  readonly journalToken: string | null;
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
    observedHead: exactHeader(readOwnEnumerableDataProperty(raw, "observedHead", context), `${context}.observedHead`),
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
  readonly #headObservations = new WeakMap<object, CanonicalHeadObservationStateV1>();
  readonly #headObservationReader: CanonicalHeadObservationReaderPortV1;
  readonly #issuedViews = new Map<string, CanonicalSourceView>();
  readonly #provenAbsences = new Map<string, CanonicalHeaderAbsenceEvidenceV1>();
  #journalEpoch = 0n;
  #currentView: CanonicalSourceView | null = null;
  readonly #authority: CanonicalSourceAuthorityV1;
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
    this.#authority = Object.freeze(Object.create(null)) as CanonicalSourceAuthorityV1;
    this.#headObservationReader = Object.freeze({
      assert: (capability: unknown): asserts capability is CanonicalHeadObservationCapabilityV1 => {
        this.#assertHeadObservation(capability);
      },
      read: (capability: CanonicalHeadObservationCapabilityV1): CanonicalHeadObservationV1 => {
        return this.#headObservationState(capability).observation;
      },
    });
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

  /** Opaque identity used to bind startup and application to one source. */
  get authority(): CanonicalSourceAuthorityV1 {
    return this.#authority;
  }

  /** Read-only port for this owner's process-local head observations. */
  get headObservationReader(): CanonicalHeadObservationReaderPortV1 {
    return this.#headObservationReader;
  }

  /**
   * Observe latest and its exact numbered header under one stable journal
   * anchor, then issue an opaque process-local capability for that result.
   */
  async observeCurrentHead(
    signal?: AbortSignal,
  ): Promise<CanonicalHeadObservationCapabilityV1> {
    this.#synchronizeJournal();
    const journalTokenBeforeRead = this.#journalToken;
    const journalRootBeforeRead = this.#journalRoot;
    const journalEpochBeforeRead = this.#journalEpoch;
    const latest = await this.#readLatest(signal);
    this.#assertJournalAnchor(
      journalTokenBeforeRead,
      journalRootBeforeRead,
      journalEpochBeforeRead,
    );
    const readResult = await this.#readHeader(latest.number, signal);
    this.#assertJournalAnchor(
      journalTokenBeforeRead,
      journalRootBeforeRead,
      journalEpochBeforeRead,
    );
    if (readResult.kind === "unavailable") {
      throw new CanonicalSourceError("transport", "canonical current head is unavailable", true, latest, null);
    }
    if (readResult.kind !== "found") {
      throw new CanonicalSourceError("missing-header", "canonical current head is absent", false, latest, null);
    }
    const reason = compareHeaders(latest, readResult.header);
    if (reason !== null) throw failureError(reason, latest, readResult.header);
    if (!sameHeader(latest, readResult.header)) {
      throw new CanonicalSourceError(
        "invalid-header",
        "canonical current head parentHash does not match its exact numbered read",
        false,
        latest,
        readResult.header,
      );
    }
    const observation = deepFreeze({
      head: latest,
      journalEpoch: journalEpochBeforeRead.toString(),
      canonicalJournalRoot: journalRootBeforeRead,
      observedMonotonicNs: process.hrtime.bigint().toString(),
    });
    const capability = Object.freeze(Object.create(null)) as CanonicalHeadObservationCapabilityV1;
    this.#headObservations.set(capability, {
      observation,
      journalToken: journalTokenBeforeRead,
    });
    return capability;
  }

  async freezeView(signal?: AbortSignal): Promise<CanonicalSourceView> {
    this.#synchronizeJournal();
    const latest = await this.#readLatest(signal);
    const cutoff = viewFromHeader(latest);
    if (BigInt(latest.number) < this.#chainGenesis) {
      throw new CanonicalSourceError("invalid-header", "canonical head precedes configured genesis", false);
    }
    if (this.#provenAbsences.has(canonicalViewKey(cutoff))) {
      throw new CanonicalSourceError("missing-header", "revoked canonical cutoff cannot be reissued", false, cutoff, null);
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
    if (!sameHeader(latest, readResult.header)) {
      throw new CanonicalSourceError(
        "invalid-header",
        "canonical freeze parentHash does not match its exact numbered read",
        false,
        latest,
        readResult.header,
      );
    }
    const issuedViews = new Map(this.#issuedViews);
    issuedViews.set(canonicalViewKey(cutoff), cutoff);
    this.#persistJournalState({
      epoch: (this.#journalEpoch + 1n).toString(),
      currentView: cutoff,
      issuedViews: [...issuedViews.values()],
      provenAbsences: [...this.#provenAbsences.values()],
    });
    this.#revokeAllFences();
    return cutoff;
  }

  /**
   * Open one producer session for one observed canonical head and one already
   * admitted GraphView lease.  The head is checked independently from the
   * ready cutoff; a ready cutoff or predecessor state can never substitute for
   * this source.
   */
  async openHeadSession<GraphView extends ProducerGraphViewV1>(
    observationCapability: CanonicalHeadObservationCapabilityV1,
    rawLease: GraphView,
    signal?: AbortSignal,
  ): Promise<ProducerSessionV1<GraphView>> {
    this.#synchronizeJournal();
    const observationState = this.#headObservationState(observationCapability);
    const observation = observationState.observation;
    if (
      observationState.journalToken !== this.#journalToken
      || observation.journalEpoch !== this.journalEpoch
      || observation.canonicalJournalRoot !== this.#journalRoot
    ) {
      throw new CanonicalSourceError(
        "fence-invalid",
        "canonical head observation journal anchor is no longer current",
        false,
      );
    }
    const head = observation.head;
    const lease = assertProducerGraphView(rawLease, "producerGraphView") as GraphView;
    try {
      await lease.assertActive();
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "generation-mismatch",
        `producer GraphView is not active: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    await this.#assertHeadCurrent(head, signal);
    const session = createProducerSession(
      head,
      lease,
      (checkSignal?: AbortSignal) => this.#assertHeadCurrent(head, checkSignal),
      this.#authority,
    );
    await session.assertCurrent(signal);
    return session;
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
        null,
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
    if (cutoff < 49n || cutoff - 49n < this.#chainGenesis) {
      throw new CanonicalSourceError(
        "recent-observation-window-unavailable",
        "canonical recent observation window is not a complete 50 blocks",
        false,
        view,
        null,
      );
    }
    const from = cutoff - 49n;
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

  #assertHeadObservation(
    capability: unknown,
  ): asserts capability is CanonicalHeadObservationCapabilityV1 {
    if (
      capability === null
      || typeof capability !== "object"
      || !this.#headObservations.has(capability)
    ) {
      throw new CanonicalSourceError(
        "fence-invalid",
        "canonical head observation capability was not issued by this source",
        false,
      );
    }
  }

  #headObservationState(
    capability: CanonicalHeadObservationCapabilityV1,
  ): CanonicalHeadObservationStateV1 {
    this.#assertHeadObservation(capability);
    return this.#headObservations.get(capability)!;
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

  async #assertHeadCurrent(head: CanonicalHead, signal?: AbortSignal): Promise<void> {
    const latest = await this.#readLatest(signal);
    const reason = compareHeaders(head, latest);
    if (reason !== null) throw failureError(reason, head, latest);
    if (!sameHeader(head, latest)) {
      throw new CanonicalSourceError(
        "invalid-header",
        "producer head parentHash no longer matches the canonical latest header",
        false,
        head,
        latest,
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
        true,
      );
    }
  }

  async #readLatest(signal?: AbortSignal): Promise<CanonicalHeader> {
    try {
      return exactHeader(await this.#provider.getLatestHeader(signal), "latestHeader");
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

const producerSessionConstructorToken = Symbol("producer-session-constructor");

type ProducerHeadSchedule = {
  readonly head: CanonicalHead;
  readonly revision: string;
  readonly sourceHeadSeenAtMs: number;
  readonly sourceHeadSeenMonotonicMs: number;
};

function producerSessionError(
  code: "producer-session-closed" | "producer-session-invalidated",
  message: string,
): CanonicalSourceError {
  return new CanonicalSourceError(code, message, false);
}

function graphEdges(raw: ProducerGraphViewV1): readonly unknown[] | null {
  if (!Object.prototype.hasOwnProperty.call(raw, "edges")) return null;
  const edges = (raw as { readonly edges?: unknown }).edges;
  return edges === undefined ? null : edges as readonly unknown[];
}

/** A current-head session with an immutable graph-generation binding. */
export class ProducerSession<GraphView extends ProducerGraphViewV1 = ProducerGraphViewV1>
  implements ProducerSessionV1<GraphView> {
  readonly sessionId: Hash;
  readonly currentSourceCapability: ProducerCurrentSourceSessionCapabilityV1;
  readonly source: CanonicalHead;
  readonly head: CanonicalHead;
  readonly lease: GraphView;
  readonly graphView: GraphView;
  readonly generation: ProducerGenerationBindingV1;
  readonly generationId: string;
  #closed = false;
  #invalidated: CanonicalSourceError | null = null;
  readonly #checkHead: (signal?: AbortSignal) => Promise<void>;
  readonly #edgesPresent: boolean;
  readonly #edges: readonly unknown[] | null;
  readonly #edgeRefs: readonly unknown[] | null;

  constructor(
    token: typeof producerSessionConstructorToken,
    head: CanonicalHead,
    lease: GraphView,
    checkHead: (signal?: AbortSignal) => Promise<void>,
    canonicalSourceAuthority: CanonicalSourceAuthorityV1,
  ) {
    if (token !== producerSessionConstructorToken) {
      throw new CanonicalSourceError("generation-mismatch", "producer session constructor is private", false);
    }
    const exactHead = exactHeader(head, "producerSession.head");
    assertProducerGraphView(lease, "producerSession.lease");
    const generation = exactProducerGenerationBinding(lease.binding, "producerSession.lease.binding");
    const currentEdges = graphEdges(lease);
    this.sessionId = hashDomain("aloha/producer-session/v1", {
      nonce: randomUUID(),
      head: exactHead,
      generation,
    });
    this.source = exactHead;
    this.head = exactHead;
    this.lease = lease;
    this.graphView = lease;
    this.generation = generation;
    this.generationId = generation.generationId;
    this.#checkHead = checkHead;
    this.#edgesPresent = currentEdges !== null;
    this.#edges = currentEdges;
    this.#edgeRefs = currentEdges === null ? null : Object.freeze([...currentEdges]);
    const capability = Object.freeze(Object.create(null)) as ProducerCurrentSourceSessionCapabilityV1;
    producerCurrentSourceSessions.set(capability, Object.freeze({
      sessionId: this.sessionId,
      source: this.source,
      generation: this.generation,
      generationId: this.generationId,
      canonicalSourceAuthority,
      assertCurrent: (signal?: AbortSignal) => this.assertCurrent(signal),
    }));
    this.currentSourceCapability = capability;
    Object.freeze(this);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw producerSessionError("producer-session-closed", "producer session is closed");
    }
    if (this.#invalidated) throw this.#invalidated;
    try {
      await this.#assertGraphPinned();
      await this.#checkHead(signal);
      await this.#assertGraphPinned();
    } catch (error) {
      if (error instanceof CanonicalSourceError && error.retryable) throw error;
      const invalidated = error instanceof CanonicalSourceError
        ? error
        : new CanonicalSourceError(
          "producer-session-invalidated",
          `producer session check failed: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
      this.#invalidated = invalidated;
      throw invalidated;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async #assertGraphPinned(): Promise<void> {
    const observedBefore = exactProducerGenerationBinding(
      this.lease.binding,
      "producerSession.lease.binding",
    );
    if (!sameProducerGenerationBinding(this.generation, observedBefore)) {
      throw new CanonicalSourceError(
        "generation-mismatch",
        "producer session GraphView generation changed",
        false,
      );
    }
    const observedEdgesBefore = graphEdges(this.lease);
    if (
      (observedEdgesBefore === null) !== !this.#edgesPresent
      || (observedEdgesBefore !== null && observedEdgesBefore !== this.#edges)
      || (observedEdgesBefore !== null
        && this.#edgeRefs !== null
        && (observedEdgesBefore.length !== this.#edgeRefs.length
          || observedEdgesBefore.some((edge, index) => edge !== this.#edgeRefs![index])))
    ) {
      throw new CanonicalSourceError(
        "topology-mismatch",
        "producer session GraphView topology changed",
        false,
      );
    }
    try {
      await this.lease.assertActive();
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "generation-mismatch",
        `producer session GraphView is not active: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const observedAfter = exactProducerGenerationBinding(
      this.lease.binding,
      "producerSession.lease.binding",
    );
    if (!sameProducerGenerationBinding(this.generation, observedAfter)) {
      throw new CanonicalSourceError(
        "generation-mismatch",
        "producer session GraphView generation changed during assertion",
        false,
      );
    }
    const observedEdgesAfter = graphEdges(this.lease);
    if (observedEdgesAfter !== observedEdgesBefore) {
      throw new CanonicalSourceError(
        "topology-mismatch",
        "producer session GraphView topology changed during assertion",
        false,
      );
    }
  }
}

function createProducerSession<GraphView extends ProducerGraphViewV1>(
  head: CanonicalHead,
  lease: GraphView,
  checkHead: (signal?: AbortSignal) => Promise<void>,
  canonicalSourceAuthority: CanonicalSourceAuthorityV1,
): ProducerSession<GraphView> {
  return new ProducerSession(producerSessionConstructorToken, head, lease, checkHead, canonicalSourceAuthority);
}

/**
 * One active producer head and at most one pending newer head.  Revisions are
 * immutable trigger/evidence contexts for the same head; they never refresh
 * or replace the pinned GraphView.
 */
export class ProducerHeadScheduler {
  readonly #runHead: (
    head: CanonicalHead,
    context: ProducerHeadRunContextV1,
  ) => Promise<void>;
  readonly #onError: (
    head: CanonicalHead,
    error: unknown,
  ) => void;
  readonly #onDrop: (drop: ProducerHeadDropV1) => void;
  #active: ProducerHeadSchedule | null = null;
  #pending: ProducerHeadSchedule | null = null;
  #accepting = true;
  #drainTask: Promise<void> | null = null;
  #latestSubmitted: ProducerHeadSchedule | null = null;
  #submitted = 0;
  #started = 0;
  #completed = 0;
  #coalesced = 0;

  constructor(
    runHead: (
      head: CanonicalHead,
      context: ProducerHeadRunContextV1,
    ) => Promise<void>,
    onError: (
      head: CanonicalHead,
      error: unknown,
    ) => void = () => {},
    onDrop: (drop: ProducerHeadDropV1) => void = () => {},
  ) {
    this.#runHead = runHead;
    this.#onError = onError;
    this.#onDrop = onDrop;
  }

  /** Submit the initial immutable execution context for a canonical head. */
  schedule(
    rawHead: CanonicalHead,
    observation: ProducerHeadObservationV1 = {
      sourceHeadSeenAtMs: Date.now(),
      sourceHeadSeenMonotonicMs: performance.now(),
    },
  ): boolean {
    return this.#submit(rawHead, "0", observation, false);
  }

  /** Submit a newer immutable context for the same head. */
  scheduleRevision(
    rawHead: CanonicalHead,
    revision: string,
    observation: ProducerHeadObservationV1,
  ): boolean {
    const exactRevision = assertDecimalString(revision, "producerHead.revision");
    if (BigInt(exactRevision) <= 0n) {
      throw new CanonicalSourceError("invalid-header", "producer head revision must be positive", false);
    }
    return this.#submit(rawHead, exactRevision, observation, true);
  }

  async shutdown(): Promise<void> {
    this.#accepting = false;
    if (this.#pending !== null) {
      this.#reportDrop(this.#pending, "shutdown_pending_dropped");
      this.#pending = null;
    }
    await this.#drainTask;
  }

  telemetry(): ProducerHeadSchedulerTelemetryV1 {
    return Object.freeze({
      submitted: this.#submitted,
      started: this.#started,
      completed: this.#completed,
      coalesced: this.#coalesced,
      latestSubmitted: this.#latestSubmitted?.head ?? null,
      active: this.#active?.head ?? null,
      pending: this.#pending?.head ?? null,
    });
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  #submit(
    rawHead: CanonicalHead,
    revision: string,
    observation: ProducerHeadObservationV1,
    isRevision: boolean,
  ): boolean {
    const head = exactHeader(rawHead, "producerHead");
    if (!Number.isFinite(observation.sourceHeadSeenAtMs) || !Number.isFinite(observation.sourceHeadSeenMonotonicMs)) {
      throw new CanonicalSourceError("invalid-header", "producer head observation is not finite", false);
    }
    const candidate = Object.freeze({
      head,
      revision,
      sourceHeadSeenAtMs: observation.sourceHeadSeenAtMs,
      sourceHeadSeenMonotonicMs: observation.sourceHeadSeenMonotonicMs,
    });
    if (!this.#accepting) return false;
    this.#submitted += 1;
    if (!isRevision && this.#latestSubmitted !== null && candidate.head.number === this.#latestSubmitted.head.number) {
      this.#coalesced += 1;
      this.#reportDrop(candidate, "scheduler_coalesced");
      return false;
    }
    if (this.#latestSubmitted !== null && this.#compare(candidate, this.#latestSubmitted) <= 0) {
      this.#coalesced += 1;
      this.#reportDrop(candidate, "scheduler_coalesced");
      return false;
    }
    const previousLatest = this.#latestSubmitted;
    this.#latestSubmitted = candidate;
    if (!this.#admit(candidate)) {
      if (this.#latestSubmitted === candidate) this.#latestSubmitted = previousLatest;
      return false;
    }
    return true;
  }

  #admit(candidate: ProducerHeadSchedule): boolean {
    if (this.#active !== null) {
      if (this.#pending !== null) {
        if (this.#compare(candidate, this.#pending) <= 0) {
          this.#coalesced += 1;
          this.#reportDrop(candidate, "scheduler_coalesced");
          return false;
        }
        this.#coalesced += 1;
        this.#reportDrop(this.#pending, "scheduler_coalesced");
      }
      this.#pending = candidate;
      return true;
    }
    this.#active = candidate;
    this.#drainTask = this.#drain();
    void this.#drainTask;
    return true;
  }

  async #drain(): Promise<void> {
    while (this.#active !== null) {
      const current = this.#active;
      this.#started += 1;
      try {
        await this.#runHead(current.head, {
          revision: current.revision,
          sourceHeadSeenAtMs: current.sourceHeadSeenAtMs,
          sourceHeadSeenMonotonicMs: current.sourceHeadSeenMonotonicMs,
        });
      } catch (error) {
        try {
          this.#onError(current.head, error);
        } catch {
          // Observability cannot change scheduler sequencing.
        }
      } finally {
        this.#completed += 1;
      }
      this.#active = this.#pending;
      this.#pending = null;
    }
  }

  #compare(left: ProducerHeadSchedule, right: ProducerHeadSchedule): number {
    const leftNumber = BigInt(left.head.number);
    const rightNumber = BigInt(right.head.number);
    if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
    const leftRevision = BigInt(left.revision);
    const rightRevision = BigInt(right.revision);
    if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
    if (sameHeader(left.head, right.head)) return 0;
    // A same-height reorg is only valid as an explicitly newer revision.  The
    // key makes the ordering deterministic for duplicate revision inputs.
    const leftKey = `${canonicalViewKey(left.head)}:${left.head.parentHash}`;
    const rightKey = `${canonicalViewKey(right.head)}:${right.head.parentHash}`;
    return leftKey < rightKey ? -1 : 1;
  }

  #reportDrop(schedule: ProducerHeadSchedule, reason: ProducerHeadDropReasonV1): void {
    try {
      this.#onDrop(Object.freeze({
        head: schedule.head,
        revision: schedule.revision,
        sourceHeadSeenAtMs: schedule.sourceHeadSeenAtMs,
        sourceHeadSeenMonotonicMs: schedule.sourceHeadSeenMonotonicMs,
        reason,
      }));
    } catch {
      // Drop accounting is best effort and must not disrupt admission.
    }
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

export {
  RethCanonicalHeaderProviderV1,
  createRethCanonicalHeaderProviderV1,
  type RethCanonicalHeaderProviderConfigV1,
} from "./reth-rpc.ts";
