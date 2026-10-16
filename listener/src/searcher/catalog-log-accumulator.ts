import { createHash } from "node:crypto";

export interface CatalogActivityDigestState {
  readonly observationHash: ReturnType<typeof createHash>;
  readonly chunks: readonly {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly hash: ReturnType<typeof createHash>;
    resultCount: number;
  }[];
}

/** Preserve the full ordered source digest, retaining only admission representatives.
 * A log identity includes its block. Duplicate detection can therefore expire at
 * an ordered, non-overlapping canonical chunk boundary, never within a chunk.
 */
export function createCatalogLogAccumulator<Log, Candidate>(input: {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly chunkBlocks: number;
  readonly blockNumber: (log: Log) => number | undefined;
  readonly identity: (log: Log) => string;
  readonly updateDigest: (hash: ReturnType<typeof createHash>, log: Log) => void;
  readonly candidates: (log: Log) => readonly Candidate[];
  readonly candidateKey: (candidate: Candidate) => string;
  readonly prefer: (incumbent: Candidate, candidate: Candidate) => boolean;
  readonly opaqueKeys: (log: Log) => readonly string[];
}) {
  const observationHash = createHash("sha256").update("catalog-activity-observations-v1:");
  const chunks: CatalogActivityDigestState["chunks"][number][] = [];
  for (let fromBlock = input.fromBlock; fromBlock <= input.toBlock; fromBlock += input.chunkBlocks) {
    chunks.push({ fromBlock, toBlock: Math.min(input.toBlock, fromBlock + input.chunkBlocks - 1),
      hash: createHash("sha256").update("catalog-activity-chunk-v1:"), resultCount: 0 });
  }
  const digestState: CatalogActivityDigestState = { observationHash, chunks };
  const candidates = new Map<string, Candidate>();
  const opaque = new Map<string, Log>();
  let seen = new Set<string>();
  let lastChunk = -1;
  let logCount = 0;
  return {
    digestState,
    append(log: Log): void {
      const block = input.blockNumber(log);
      if (!Number.isSafeInteger(block) || block! < input.fromBlock || block! > input.toBlock) {
        throw new Error("catalog activity logs are outside ordered scan range");
      }
      const chunkIndex = Math.floor((block! - input.fromBlock) / input.chunkBlocks);
      if (chunkIndex < lastChunk) throw new Error("catalog activity logs are outside ordered scan range");
      if (chunkIndex !== lastChunk) { seen = new Set(); lastChunk = chunkIndex; }
      const chunk = chunks[chunkIndex]!;
      input.updateDigest(observationHash, log);
      input.updateDigest(chunk.hash, log);
      chunk.resultCount++;
      logCount++;
      // Reverse binding observes every raw log, independently of candidate
      // identity dedupe, and keeps the first evidence for each nomination.
      for (const key of input.opaqueKeys(log)) if (!opaque.has(key)) opaque.set(key, log);
      const identity = input.identity(log);
      if (seen.has(identity)) return;
      seen.add(identity);
      for (const candidate of input.candidates(log)) {
        const key = input.candidateKey(candidate);
        const incumbent = candidates.get(key);
        if (incumbent === undefined || input.prefer(incumbent, candidate)) candidates.set(key, candidate);
      }
    },
    representatives(): { readonly candidates: readonly Candidate[]; readonly opaqueLogs: readonly Log[] } {
      return { candidates: Object.freeze([...candidates.values()]),
        opaqueLogs: Object.freeze([...new Set(opaque.values())]) };
    },
    count(): number { return logCount; },
  };
}
