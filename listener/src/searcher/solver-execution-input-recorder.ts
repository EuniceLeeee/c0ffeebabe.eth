import { appendFileSync, closeSync, constants, openSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { BlockScanRouteLocator } from "./blockscan-route-identity.js";

/** Private, opt-in execution evidence, separate from the redacted events stream.
 * Captures already-compiled inputs; no RPC, signing, compiler or quote work.
 * Writes are synchronous and bounded so acknowledgement means the complete line
 * reached the OS before a candidate can enter the final-sim queue. No per-row
 * fsync or crash-durability guarantee. A write/limit failure is never a dropped
 * sample: the enabled caller must stop its observation run.
 */
export interface SolverExecutionInputRecord {
  readonly source: CanonicalSource;
  readonly opportunityId: string;
  readonly route: BlockScanRouteLocator;
  readonly solverIndex: number;
  readonly candidateIndex: number;
  readonly flashAmount: bigint;
  readonly quoteProfit: bigint;
  readonly profitToken: string;
  readonly templateName: string;
  readonly executionInput: object;
}

function canonicalParentPath(path: string): string {
  const absolute = resolve(path.trim());
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); }
  catch (error) {
    // An absent protected directory cannot alias the recorder's existing parent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
    throw error;
  }
}

export function createSolverExecutionInputRecorder(options: {
  readonly path: string;
  readonly runId: string;
  readonly chainId: number;
  readonly runtimeCommit: string;
  readonly protectedPaths?: readonly string[];
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
}) {
  const maxFileBytes = options.maxFileBytes ?? 128 * 1024 * 1024;
  const maxRecordBytes = options.maxRecordBytes ?? 4 * 1024 * 1024;
  const path = options.path.trim();
  if (!isAbsolute(path) || !options.runId ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      !/^[0-9a-f]{40}$/i.test(options.runtimeCommit) ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0 ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 ||
      (options.protectedPaths ?? []).map(value => value.trim()).filter(Boolean)
        .some(value => canonicalParentPath(value) === canonicalParentPath(path))) {
    throw new Error("invalid private solver input recorder configuration");
  }
  // Exclusive creation also refuses existing files/hardlinks/symlinks; no append
  // to an earlier run and no truncation of another telemetry or Ready file.
  const fd = openSync(canonicalParentPath(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let closed = false, failed = false, records = 0, bytes = 0, writeMs = 0;
  return Object.freeze({
    record(input: SolverExecutionInputRecord) {
      const started = performance.now();
      try {
        if (closed || failed) throw new Error("solver input recorder unavailable");
        if (input.quoteProfit <= 0n || input.flashAmount <= 0n ||
            !Number.isSafeInteger(input.source.number) || input.source.number < 0 ||
            !/^0x[0-9a-f]{64}$/i.test(input.source.hash) ||
            !Number.isSafeInteger(input.source.generation) || input.source.generation < 0 ||
            !Number.isSafeInteger(input.solverIndex) || input.solverIndex < 0 ||
            !Number.isSafeInteger(input.candidateIndex) || input.candidateIndex < 0) {
          throw new Error("invalid positive solver execution input");
        }
        const payload = {
          type: "block_scan_solver_execution_input", schema_version: 1,
          run_id: options.runId, chain_id: options.chainId, runtime_commit: options.runtimeCommit,
          sequence: records + 1, captured_at_ms: Date.now(),
          source_block: input.source.number, source_block_hash: input.source.hash,
          generation: input.source.generation, opportunity_id: input.opportunityId,
          route_id: input.route.routeId, route: input.route,
          solver_index: input.solverIndex, candidate_index: input.candidateIndex,
          flash_amount: input.flashAmount.toString(), quote_profit: input.quoteProfit.toString(),
          profit_token: input.profitToken, template_id: input.templateName,
          // This is the simulation backend's complete serializable input, not
          // a dump of the opaque ResolvedPlan or a pointer to a mutable cache.
          execution_input: input.executionInput,
        };
        const body = JSON.stringify(payload);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const line = JSON.stringify({ ...payload, record_sha256: sha256 }) + "\n";
        const size = Buffer.byteLength(line);
        if (size > maxRecordBytes || bytes + size > maxFileBytes) throw new Error("solver input recorder size limit");
        appendFileSync(fd, line, "utf8");
        records++; bytes += size;
        return Object.freeze({ sequence: records, recordSha256: sha256, bytes: size });
      } catch {
        failed = true;
        // Do not leak the record, filesystem message or caller-provided data.
        throw new Error("private solver execution input recording failed");
      } finally { writeMs += performance.now() - started; }
    },
    snapshot: () => Object.freeze({ records, bytes, writeMs, failed, closed }),
    close() {
      if (!closed) { closed = true; closeSync(fd); }
    },
  });
}
