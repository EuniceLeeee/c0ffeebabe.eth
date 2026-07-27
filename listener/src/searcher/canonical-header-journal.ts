export interface CanonicalHeader {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
}

export interface CanonicalHeaderProof {
  /** Increments on every accepted canonical change. */
  readonly revision: number;
  readonly source: {
    readonly number: number;
    readonly hash: string;
  };
  readonly parentHash: string;
}

export interface CanonicalHeaderIngestResult {
  readonly status: "unchanged" | "anchored" | "extended" | "reorganized";
  readonly revision: number;
  readonly proof: CanonicalHeaderProof;
  /** Lowest previously canonical height invalidated by this observation. */
  readonly invalidatedFrom: number | null;
  /** Highest retained canonical header shared with the incoming branch. */
  readonly commonKnownAncestor: CanonicalHeader | null;
  /** The incoming parent differed from the retained header at number - 1. */
  readonly parentDiscontinuity: boolean;
  /** A different hash previously occupied the exact incoming height. */
  readonly sameHeightReplacement: boolean;
}

export class CanonicalHeaderOutsideRetentionError extends Error {
  readonly blockNumber: number;
  readonly retainedHeadNumber: number;

  constructor(blockNumber: number, retainedHeadNumber: number) {
    super(
      `canonical header ${blockNumber} fell outside retained journal`,
    );
    this.name = "CanonicalHeaderOutsideRetentionError";
    this.blockNumber = blockNumber;
    this.retainedHeadNumber = retainedHeadNumber;
  }
}

export interface CanonicalHeaderJournalOptions {
  /** Retained canonical window. Older ancestors become explicitly unknown. */
  readonly retentionDepth?: number;
}

/**
 * Synchronous canonical-chain evidence journal.
 *
 * The caller owns provider I/O and may ingest only headers returned as
 * canonical by that provider. The journal validates/normalizes those exact
 * number/hash/parentHash triples, tracks a monotonic revision, and fences stale
 * background work without performing network reads itself.
 */
export class CanonicalHeaderJournal {
  private readonly canonicalByNumber = new Map<number, CanonicalHeader>();
  private readonly observedByHash = new Map<string, CanonicalHeader>();
  private readonly retentionDepth: number;
  private currentRevision = 0;
  private currentHead: CanonicalHeader | null = null;

  constructor(options: CanonicalHeaderJournalOptions = {}) {
    const retentionDepth = options.retentionDepth ?? 512;
    if (!Number.isSafeInteger(retentionDepth) || retentionDepth < 2) {
      throw new Error(
        `canonical header retentionDepth must be an integer >= 2, received ${retentionDepth}`,
      );
    }
    this.retentionDepth = retentionDepth;
  }

  get revision(): number {
    return this.currentRevision;
  }

  get head(): CanonicalHeader | null {
    return this.currentHead;
  }

  /**
   * Ingest one exact canonical observation. Exact duplicates are idempotent;
   * every other accepted canonical observation advances the revision.
   */
  ingest(input: CanonicalHeader): CanonicalHeaderIngestResult {
    const header = normalizeHeader(input);
    const observed = this.observedByHash.get(header.hash);
    if (
      observed &&
      (
        observed.number !== header.number ||
        observed.parentHash !== header.parentHash
      )
    ) {
      throw new Error(
        `canonical header hash ${header.hash} was observed with conflicting fields`,
      );
    }

    const existing = this.canonicalByNumber.get(header.number);
    if (
      existing?.hash === header.hash &&
      existing.parentHash === header.parentHash
    ) {
      return freezeResult({
        status: "unchanged",
        revision: this.currentRevision,
        proof: proof(this.currentRevision, existing),
        invalidatedFrom: null,
        commonKnownAncestor: existing.number === 0
          ? null
          : this.canonicalByNumber.get(existing.number - 1) ?? null,
        parentDiscontinuity: false,
        sameHeightReplacement: false,
      });
    }

    const previousAtHeight = this.canonicalByNumber.get(header.number);
    const previousParent = header.number === 0
      ? null
      : this.canonicalByNumber.get(header.number - 1) ?? null;
    const existingChild = this.canonicalByNumber.get(
      header.number + 1,
    );
    const fillsCanonicalAncestor =
      previousAtHeight === undefined &&
      existingChild?.parentHash === header.hash;
    const sameHeightReplacement =
      previousAtHeight !== undefined && previousAtHeight.hash !== header.hash;
    const parentDiscontinuity =
      previousParent !== null && previousParent.hash !== header.parentHash;

    this.observedByHash.set(header.hash, header);
    if (fillsCanonicalAncestor) {
      this.canonicalByNumber.set(header.number, header);
      this.currentRevision++;
      this.prune();
      return freezeResult({
        status: "anchored",
        revision: this.currentRevision,
        proof: proof(this.currentRevision, header),
        invalidatedFrom: null,
        commonKnownAncestor: previousParent,
        parentDiscontinuity: false,
        sameHeightReplacement: false,
      });
    }
    const branch = this.branchToKnownCanonical(header);
    const commonKnownAncestor = branch.ancestor;
    const oldNumbers = [...this.canonicalByNumber.keys()];
    const oldHead = this.currentHead;
    let invalidatedFrom: number | null = null;

    if (commonKnownAncestor) {
      invalidatedFrom = minimumInvalidatedHeight(
        oldNumbers,
        commonKnownAncestor.number,
        branch.headers,
      );
      this.deleteCanonicalAbove(commonKnownAncestor.number);
      for (const item of branch.headers) {
        this.canonicalByNumber.set(item.number, item);
      }
    } else if (this.currentHead === null) {
      this.canonicalByNumber.set(header.number, header);
    } else {
      // The provider says this header is canonical, but its ancestry does not
      // intersect the retained window. Old proofs are unsafe; re-anchor and
      // report the absence of a common retained ancestor explicitly.
      invalidatedFrom = minimumNumber(oldNumbers);
      this.canonicalByNumber.clear();
      this.canonicalByNumber.set(header.number, header);
    }

    this.currentHead = highestHeader(this.canonicalByNumber);
    this.currentRevision++;
    this.prune();

    const status: CanonicalHeaderIngestResult["status"] =
      oldHead === null
        ? "anchored"
        : invalidatedFrom !== null
          ? "reorganized"
          : header.number > oldHead.number
            ? "extended"
            : "reorganized";
    return freezeResult({
      status,
      revision: this.currentRevision,
      proof: proof(this.currentRevision, header),
      invalidatedFrom,
      commonKnownAncestor,
      parentDiscontinuity,
      sameHeightReplacement,
    });
  }

  lookup(number: number): CanonicalHeader | null {
    assertBlockNumber(number);
    return this.canonicalByNumber.get(number) ?? null;
  }

  lookupHash(hash: string): {
    readonly header: CanonicalHeader;
    readonly canonical: boolean;
  } | null {
    const normalized = normalizeHash(hash, "hash");
    const header = this.observedByHash.get(normalized);
    if (!header) return null;
    return Object.freeze({
      header,
      canonical:
        this.canonicalByNumber.get(header.number)?.hash === header.hash,
    });
  }

  proof(number = this.currentHead?.number): CanonicalHeaderProof | null {
    if (number === undefined) return null;
    const header = this.lookup(number);
    return header ? proof(this.currentRevision, header) : null;
  }

  private branchToKnownCanonical(header: CanonicalHeader): {
    readonly ancestor: CanonicalHeader | null;
    readonly headers: readonly CanonicalHeader[];
  } {
    const reverse: CanonicalHeader[] = [header];
    let cursor = header;
    const seen = new Set([header.hash]);
    while (cursor.number > 0) {
      const canonicalParent = this.canonicalByNumber.get(cursor.number - 1);
      if (canonicalParent?.hash === cursor.parentHash) {
        return {
          ancestor: canonicalParent,
          headers: Object.freeze(reverse.reverse()),
        };
      }
      const observedParent = this.observedByHash.get(cursor.parentHash);
      if (
        !observedParent ||
        observedParent.number !== cursor.number - 1 ||
        seen.has(observedParent.hash)
      ) {
        break;
      }
      seen.add(observedParent.hash);
      reverse.push(observedParent);
      cursor = observedParent;
    }
    return {
      ancestor: null,
      headers: Object.freeze([header]),
    };
  }

  private deleteCanonicalAbove(number: number): void {
    for (const height of this.canonicalByNumber.keys()) {
      if (height > number) this.canonicalByNumber.delete(height);
    }
  }

  private prune(): void {
    if (!this.currentHead) return;
    const floor = Math.max(0, this.currentHead.number - this.retentionDepth + 1);
    for (const [number] of this.canonicalByNumber) {
      if (number < floor) this.canonicalByNumber.delete(number);
    }
    for (const [hash, header] of this.observedByHash) {
      if (header.number < floor) this.observedByHash.delete(hash);
    }
    this.currentHead = highestHeader(this.canonicalByNumber);
  }
}

function normalizeHeader(input: CanonicalHeader): CanonicalHeader {
  assertBlockNumber(input.number);
  const hash = normalizeHash(input.hash, "hash");
  const parentHash = normalizeHash(input.parentHash, "parentHash");
  if (hash === parentHash) {
    throw new Error(`canonical header ${input.number} cannot parent itself`);
  }
  return Object.freeze({ number: input.number, hash, parentHash });
}

function normalizeHash(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`canonical header ${label} must be a 32-byte hex hash`);
  }
  return value.toLowerCase();
}

function assertBlockNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`canonical header number must be a non-negative integer`);
  }
}

function proof(
  revision: number,
  header: CanonicalHeader,
): CanonicalHeaderProof {
  return Object.freeze({
    revision,
    source: Object.freeze({
      number: header.number,
      hash: header.hash,
    }),
    parentHash: header.parentHash,
  });
}

function highestHeader(
  headers: ReadonlyMap<number, CanonicalHeader>,
): CanonicalHeader | null {
  let result: CanonicalHeader | null = null;
  for (const header of headers.values()) {
    if (!result || header.number > result.number) result = header;
  }
  return result;
}

function minimumNumber(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function minimumInvalidatedHeight(
  oldNumbers: readonly number[],
  ancestorNumber: number,
  branch: readonly CanonicalHeader[],
): number | null {
  const branchByNumber = new Map(branch.map((header) => [
    header.number,
    header.hash,
  ]));
  const invalidated = oldNumbers.filter((number) =>
    number > ancestorNumber &&
    branchByNumber.get(number) !== undefined);
  const oldAboveBranch = oldNumbers.filter(
    (number) => number > (branch.at(-1)?.number ?? ancestorNumber),
  );
  return minimumNumber([...invalidated, ...oldAboveBranch]);
}

function freezeResult(
  result: CanonicalHeaderIngestResult,
): CanonicalHeaderIngestResult {
  return Object.freeze(result);
}
