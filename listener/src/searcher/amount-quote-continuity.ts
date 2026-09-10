import type { CanonicalSource } from "./venues/adapter-request-program.js";

/** Family declares complete transitive dependencies for this method/output. */
export interface AmountQuoteReusePolicy {
  readonly kind: "state-only";
  readonly dependencies: readonly string[];
  readonly blockEnvironment: "independent";
}

/** Validate and detach Family metadata before it participates in fingerprints. */
export function snapshotAmountQuoteReusePolicy(value: unknown): AmountQuoteReusePolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid amount-quote reuse policy");
  }
  const keys = Reflect.ownKeys(value);
  const policy = value as Partial<AmountQuoteReusePolicy>;
  if (keys.length !== 3 || keys.some(key =>
    key !== "kind" && key !== "dependencies" && key !== "blockEnvironment") ||
      policy.kind !== "state-only" || policy.blockEnvironment !== "independent" ||
      !Array.isArray(policy.dependencies) || policy.dependencies.length === 0) {
    throw new TypeError("invalid amount-quote reuse policy shape");
  }
  const dependencies = new Set<string>();
  for (const address of policy.dependencies) {
    if (!validAddress(address)) throw new TypeError("invalid amount-quote dependency address");
    dependencies.add(address.toLowerCase());
  }
  return Object.freeze({ kind: "state-only", blockEnvironment: "independent",
    dependencies: Object.freeze([...dependencies].sort()) });
}

/** Data only: this record does not issue an Exact handle or execution authority. */
export interface CompletedAmountQuote {
  readonly complete: boolean;
  readonly chainAmountQuote: boolean;
  readonly validAt: CanonicalSource;
  readonly quotedAt: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Caller binds immutable graph, Family, method, executor and evidence context. */
  readonly contextFingerprint: string;
  readonly reusePolicy?: AmountQuoteReusePolicy;
}

export interface CanonicalAmountQuoteActivity {
  readonly source: CanonicalSource;
  readonly parentHash: string;
  readonly touchedAddresses: ReadonlySet<string>;
  readonly complete: boolean;
}

declare const preparedActivityBrand: unique symbol;
/** Opaque snapshot: only tokens issued by prepareAmountQuoteActivity are accepted. */
export interface PreparedAmountQuoteActivity {
  readonly [preparedActivityBrand]: true;
}

const preparedActivities = new WeakMap<PreparedAmountQuoteActivity, {
  readonly source: CanonicalSource;
  readonly parentHash: string;
  readonly touchedAddresses: ReadonlySet<string>;
}>();

/**
 * Validate/copy once per caller-authenticated activity snapshot, before visiting
 * quote rows. The normalized Set stays private and is never mutated or exposed.
 * Raw input identity is not cached; malformed or incomplete activity returns null.
 */
export function prepareAmountQuoteActivity(value: unknown): PreparedAmountQuoteActivity | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { source: rawSource, parentHash, touchedAddresses, complete } = value as Partial<CanonicalAmountQuoteActivity>;
    if (complete !== true || rawSource === undefined || rawSource === null ||
        !validHash(parentHash) || touchedAddresses === null || typeof touchedAddresses !== "object" ||
        typeof touchedAddresses.has !== "function" || typeof touchedAddresses[Symbol.iterator] !== "function") return null;
    const source = Object.freeze({ number: rawSource.number, hash: rawSource.hash, generation: rawSource.generation });
    if (!validSource(source)) return null;
    const touched = new Set<string>();
    for (const address of touchedAddresses) {
      if (!validAddress(address)) return null;
      touched.add(address.toLowerCase());
    }
    const token = Object.freeze({}) as PreparedAmountQuoteActivity;
    preparedActivities.set(token, Object.freeze({ source, parentHash: parentHash.toLowerCase(), touchedAddresses: touched }));
    return token;
  } catch {
    // Includes malformed getters/iterators; partial validation cannot issue a token.
    return null;
  }
}

/**
 * Pure continuity check over caller-authenticated quote data, Family declarations
 * and canonical activity. Null means a fresh chain quote is required. A successful
 * step advances validAt only; quotedAt remains the original chain observation.
 */
export function carryAmountQuote(input: {
  readonly previous: CompletedAmountQuote | null | undefined;
  readonly current: CanonicalSource;
  readonly amountIn: bigint;
  readonly contextFingerprint: string;
  readonly policy?: AmountQuoteReusePolicy;
  readonly activity?: PreparedAmountQuoteActivity | null;
}): CompletedAmountQuote | null {
  const { previous, current, activity } = input;
  if (!previous || previous.complete !== true || previous.chainAmountQuote !== true ||
      typeof previous.amountIn !== "bigint" || previous.amountIn <= 0n ||
      typeof previous.amountOut !== "bigint" || previous.amountOut <= 0n ||
      previous.amountIn !== input.amountIn ||
      typeof input.contextFingerprint !== "string" || !input.contextFingerprint.trim() ||
      previous.contextFingerprint !== input.contextFingerprint ||
      !validSource(previous.validAt) || !validSource(previous.quotedAt) || !validSource(current)) return null;

  const previousPolicy = previous.reusePolicy === undefined ? undefined : policySnapshot(previous.reusePolicy);
  if (previousPolicy === null) return null;
  const validAt = previous.validAt;
  const quotedAt = previous.quotedAt;
  if (quotedAt.number > validAt.number || quotedAt.generation > validAt.generation ||
      (quotedAt.number === validAt.number && !sameHash(quotedAt.hash, validAt.hash)) ||
      (quotedAt.number < validAt.number &&
        (quotedAt.generation >= validAt.generation || sameHash(quotedAt.hash, validAt.hash)))) return null;

  const sameBlock = current.number === validAt.number && sameHash(current.hash, validAt.hash);
  if (sameBlock) {
    if (current.generation < validAt.generation) return null;
  } else {
    const proof = activity == null ? undefined : preparedActivities.get(activity);
    if (current.number !== validAt.number + 1 || current.generation <= validAt.generation ||
        sameHash(current.hash, validAt.hash) || proof === undefined ||
        proof.source.number !== current.number || proof.source.generation !== current.generation ||
        !sameHash(proof.source.hash, current.hash) || !sameHash(proof.parentHash, validAt.hash)) return null;

    const currentPolicy = policySnapshot(input.policy);
    if (previousPolicy === undefined || currentPolicy === null ||
        previousPolicy.dependencies.length !== currentPolicy.dependencies.length ||
        previousPolicy.dependencies.some((address, index) => address !== currentPolicy.dependencies[index])) return null;
    if (currentPolicy.dependencies.some(address => proof.touchedAddresses.has(address))) return null;
  }

  // Copy mutable inputs; never attach a newly supplied policy to an old quote.
  return Object.freeze({
    complete: true,
    chainAmountQuote: true,
    validAt: Object.freeze({ ...current }),
    quotedAt: Object.freeze({ ...quotedAt }),
    amountIn: previous.amountIn,
    amountOut: previous.amountOut,
    contextFingerprint: previous.contextFingerprint,
    ...(previousPolicy === undefined ? {} : { reusePolicy: previousPolicy }),
  });
}

function validSource(source: CanonicalSource | undefined): source is CanonicalSource {
  return source !== undefined && source !== null &&
    Number.isSafeInteger(source.number) && source.number >= 0 &&
    Number.isSafeInteger(source.generation) && source.generation >= 0 &&
    validHash(source.hash);
}

function validHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validAddress(address: unknown): address is string {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

function policySnapshot(value: unknown): AmountQuoteReusePolicy | null {
  try { return snapshotAmountQuoteReusePolicy(value); }
  catch { return null; }
}
