import { randomUUID } from "node:crypto";
import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export type BlockNumber = string;

export interface CanonicalHeader {
  readonly number: BlockNumber;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface CanonicalSourceView {
  readonly number: BlockNumber;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface CanonicalHeaderProvider {
  getLatestHeader(signal?: AbortSignal): Promise<CanonicalHeader>;
  getHeader(number: BlockNumber, signal?: AbortSignal): Promise<CanonicalHeader | null>;
}

export type CanonicalCheckFailure =
  | "reorg"
  | "number-mismatch"
  | "hash-mismatch"
  | "state-root-mismatch"
  | "missing-header"
  | "transport";

export interface CanonicalCheckOk {
  readonly ok: true;
  readonly view: CanonicalSourceView;
  readonly journalEpoch: string;
}

export interface CanonicalCheckFailed {
  readonly ok: false;
  readonly retryable: boolean;
  readonly reason: CanonicalCheckFailure;
  readonly expected: CanonicalSourceView;
  readonly observed: CanonicalHeader | null;
  readonly journalEpoch: string;
}

export type CanonicalCheck = CanonicalCheckOk | CanonicalCheckFailed;

export interface CanonicalFenceLease {
  readonly token: string;
  readonly journalEpoch: string;
  readonly view: CanonicalSourceView;
}

export interface CanonicalSourceOptions {
  readonly chainGenesis?: BlockNumber;
}

export class CanonicalSourceError extends Error {
  readonly code:
    | "invalid-header"
    | "reorg"
    | "number-mismatch"
    | "hash-mismatch"
    | "state-root-mismatch"
    | "missing-header"
    | "transport"
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

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

function assertBlockNumber(value: unknown, context: string): BlockNumber {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CanonicalSourceError("invalid-header", `invalid block number at ${context}`, false);
  }
  return value;
}

function assertHash(value: unknown, context: string): Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new CanonicalSourceError("invalid-header", `invalid hash at ${context}`, false);
  }
  return value as Hash;
}

function normalizeHeader(raw: CanonicalHeader, context: string): CanonicalHeader {
  if (raw === null || typeof raw !== "object") {
    throw new CanonicalSourceError("invalid-header", `${context} is not an object`, false);
  }
  const header = {
    number: assertBlockNumber(raw.number, `${context}.number`),
    hash: assertHash(raw.hash, `${context}.hash`),
    stateRoot: assertHash(raw.stateRoot, `${context}.stateRoot`),
  } satisfies CanonicalHeader;
  return Object.freeze(header);
}

function normalizeView(raw: CanonicalSourceView, context: string): CanonicalSourceView {
  return Object.freeze(normalizeHeader(raw, context));
}

function compareHeaders(
  expected: CanonicalSourceView,
  observed: CanonicalHeader | null,
): CanonicalCheckFailure | null {
  if (observed === null) return "missing-header";
  if (observed.number !== expected.number) return "number-mismatch";
  if (observed.hash !== expected.hash) return "hash-mismatch";
  if (observed.stateRoot !== expected.stateRoot) return "state-root-mismatch";
  return null;
}

function failureError(
  reason: Exclude<CanonicalCheckFailure, "transport">,
  view: CanonicalSourceView,
  observed: CanonicalHeader | null,
): CanonicalSourceError {
  const message = reason === "missing-header"
    ? `canonical header ${view.number} is no longer available`
    : `canonical fence ${reason} at block ${view.number}`;
  return new CanonicalSourceError(reason, message, false, view, observed);
}

function blockDistance(later: BlockNumber, earlier: BlockNumber): bigint {
  const result = BigInt(later) - BigInt(earlier);
  if (result < 0n) {
    throw new CanonicalSourceError(
      "number-mismatch",
      `latest block ${later} precedes frozen block ${earlier}`,
      false,
    );
  }
  return result;
}

/**
 * CanonicalSource is the only owner of a source fence.  A view is a frozen
 * number/hash/stateRoot triple; every validity check rereads the provider at
 * that exact number, so a same-height reorg or state-root mismatch is never
 * silently treated as a usable source.
 */
export class CanonicalSource {
  private readonly provider: CanonicalHeaderProvider;
  private journalEpochValue = 0n;
  private currentViewValue: CanonicalSourceView | null = null;
  private readonly chainGenesis: bigint;

  constructor(
    provider: CanonicalHeaderProvider,
    options: CanonicalSourceOptions = {},
  ) {
    this.provider = provider;
    const genesis = options.chainGenesis ?? "0";
    assertBlockNumber(genesis, "chainGenesis");
    this.chainGenesis = BigInt(genesis);
  }

  get journalEpoch(): string {
    return this.journalEpochValue.toString();
  }

  get currentView(): CanonicalSourceView | null {
    return this.currentViewValue;
  }

  async freezeView(signal?: AbortSignal): Promise<CanonicalSourceView> {
    let latest: CanonicalHeader;
    try {
      latest = normalizeHeader(await this.provider.getLatestHeader(signal), "latest header");
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "transport",
        `canonical latest-header read failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const view = Object.freeze({
      number: latest.number,
      hash: latest.hash,
      stateRoot: latest.stateRoot,
    });
    const check = await this.checkStillCanonical(view, signal);
    if (!check.ok) {
      if (check.reason === "transport") {
        throw new CanonicalSourceError("transport", "canonical fence read failed", true, view, check.observed);
      }
      throw failureError(check.reason, view, check.observed);
    }
    this.currentViewValue = view;
    this.journalEpochValue += 1n;
    return view;
  }

  async checkStillCanonical(
    rawView: CanonicalSourceView,
    signal?: AbortSignal,
  ): Promise<CanonicalCheck> {
    const view = normalizeView(rawView, "canonical view");
    let observed: CanonicalHeader | null;
    try {
      observed = await this.provider.getHeader(view.number, signal);
      if (observed !== null) observed = normalizeHeader(observed, "observed header");
    } catch (error) {
      if (error instanceof CanonicalSourceError && !error.retryable) throw error;
      return Object.freeze({
        ok: false,
        retryable: true,
        reason: "transport",
        expected: view,
        observed: null,
        journalEpoch: this.journalEpoch,
      });
    }
    const reason = compareHeaders(view, observed);
    if (reason === null) {
      return Object.freeze({
        ok: true,
        view,
        journalEpoch: this.journalEpoch,
      });
    }
    return Object.freeze({
      ok: false,
      retryable: false,
      reason,
      expected: view,
      observed,
      journalEpoch: this.journalEpoch,
    });
  }

  async assertStillCanonical(
    rawView: CanonicalSourceView,
    signal?: AbortSignal,
  ): Promise<CanonicalSourceView> {
    const view = normalizeView(rawView, "canonical view");
    const check = await this.checkStillCanonical(view, signal);
    if (check.ok) return view;
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

  async acquireFence(
    rawView: CanonicalSourceView,
    signal?: AbortSignal,
  ): Promise<CanonicalFenceLease> {
    const view = await this.assertStillCanonical(rawView, signal);
    const lease = Object.freeze({
      token: randomUUID(),
      journalEpoch: this.journalEpoch,
      view,
    });
    return lease;
  }

  async validateFenceLease(
    lease: CanonicalFenceLease,
    signal?: AbortSignal,
  ): Promise<CanonicalCheck> {
    if (
      lease === null ||
      typeof lease !== "object" ||
      typeof lease.token !== "string" ||
      typeof lease.journalEpoch !== "string"
    ) {
      throw new CanonicalSourceError("fence-invalid", "malformed canonical fence lease", false);
    }
  if (lease.journalEpoch !== this.journalEpoch) {
    return Object.freeze({
      ok: false,
      retryable: false,
      reason: "reorg",
        expected: normalizeView(lease.view, "fence lease view"),
        observed: null,
        journalEpoch: this.journalEpoch,
      });
    }
    return this.checkStillCanonical(lease.view, signal);
  }

  /** Notify the source fence journal that a reorg/head replacement was observed. */
  notifyReorg(): void {
    this.journalEpochValue += 1n;
    this.currentViewValue = null;
  }

  async ageInBlocks(
    rawView: CanonicalSourceView,
    signal?: AbortSignal,
  ): Promise<string> {
    const view = await this.assertStillCanonical(rawView, signal);
    let latest: CanonicalHeader;
    try {
      latest = normalizeHeader(await this.provider.getLatestHeader(signal), "latest header");
    } catch (error) {
      if (error instanceof CanonicalSourceError) throw error;
      throw new CanonicalSourceError(
        "transport",
        `canonical age read failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
        view,
      );
    }
    const age = blockDistance(latest.number, view.number);
    return age.toString();
  }

  /** Genesis-clamped recent observation range required by the architecture contract. */
  recentObservationRange(rawView: CanonicalSourceView): readonly [BlockNumber, BlockNumber] {
    const view = normalizeView(rawView, "canonical view");
    const start = BigInt(view.number) >= 49n
      ? BigInt(view.number) - 49n
      : this.chainGenesis;
    return Object.freeze([start.toString(), view.number]);
  }
}

export function canonicalSourceViewHash(view: CanonicalSourceView): Hash {
  const normalized = normalizeView(view, "canonical view");
  return hashDomain("aloha/canonical-source-view/v1", {
    number: normalized.number,
    hash: normalized.hash,
    stateRoot: normalized.stateRoot,
  });
}

export function createCanonicalSource(
  provider: CanonicalHeaderProvider,
  options: CanonicalSourceOptions = {},
): CanonicalSource {
  return new CanonicalSource(provider, options);
}

/** A small adapter for transports that expose two read functions. */
export function createCanonicalHeaderProvider(input: {
  readonly latest: (signal?: AbortSignal) => Promise<CanonicalHeader>;
  readonly at: (number: BlockNumber, signal?: AbortSignal) => Promise<CanonicalHeader | null>;
}): CanonicalHeaderProvider {
  return Object.freeze({
    getLatestHeader: input.latest,
    getHeader: input.at,
  });
}

/** Canonical bytes are useful for evidence and are intentionally independent of durable-store. */
export function encodeCanonicalSourceView(view: CanonicalSourceView): Uint8Array {
  const normalized = normalizeView(view, "canonical view");
  return new TextEncoder().encode(encodeCanonicalJson(normalized));
}
