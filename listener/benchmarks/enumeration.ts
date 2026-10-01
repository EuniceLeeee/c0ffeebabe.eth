// Manual, offline benchmark. Nothing in the live entry imports this module.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TokenEdge } from "../src/searcher/planner/token-graph.js";
import type { BlockScanScanTiming, ResolvedBlockScanQuote } from "../src/searcher/detector/blockscan-scanner-core.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? { $offlineBigInt: item.toString() } : item instanceof Map ? [...item] : item, 2);
const parse = (bytes: Buffer): any => JSON.parse(bytes.toString("utf8"), (_key, value) =>
  value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.$offlineBigInt === "string"
    ? BigInt(value.$offlineBigInt) : value);

/** Load the existing export format without fabricating live runtime/strict evidence. */
export function loadEnumerationInput(indexPath: string) {
  const indexBytes = readFileSync(indexPath);
  const index = JSON.parse(indexBytes.toString("utf8"));
  assert(Array.isArray(index.snapshotFiles) && index.snapshotFiles.length > 0, "missing snapshots");
  assert(Array.isArray(index.funding) && index.funding.length > 0, "missing recorded funding tokens");
  const bindings: Array<{ path: string; sha256: string }> = [{ path: indexPath, sha256: hash(indexBytes) }];
  const checked = (file: string, expectedHash: string): Buffer => {
    const path = resolve(dirname(indexPath), file), bytes = readFileSync(path);
    assert.equal(hash(bytes), expectedHash, `input hash mismatch: ${path}`);
    bindings.push({ path, sha256: expectedHash });
    return bytes;
  };
  const graph = parse(checked(index.graphFile, index.graphFileSha256));
  assert(Array.isArray(graph.edges) && graph.edges.length > 0, "missing graph edges");
  const seen = new Set<number>();
  const snapshots = index.snapshotFiles.map((entry: { block: number; path: string; sha256: string }) => {
    assert(Number.isSafeInteger(entry.block) && !seen.has(entry.block), "invalid or duplicate block");
    seen.add(entry.block);
    const snapshot = parse(checked(entry.path, entry.sha256));
    assert.equal(snapshot.format, "offline-recorded-effective-scanner-input-v1");
    assert.equal(snapshot.sourceBlock, entry.block);
    assert.equal(snapshot.graphFileSha256, index.graphFileSha256);
    assert.equal(snapshot.graphHash, graph.graphHash);
    assert(Array.isArray(snapshot.projectedMids) && snapshot.projectedMids.length > 0, "missing effective rows");
    const mids = new Map<string, ResolvedBlockScanQuote>(snapshot.projectedMids);
    assert.equal(mids.size, snapshot.projectedMids.length, "duplicate effective edge");
    for (const quote of mids.values()) {
      assert(typeof quote.quoteAmountIn === "bigint" && quote.quoteAmountIn > 0n, "invalid effective amountIn");
      assert(typeof quote.quoteAmountOut === "bigint" && quote.quoteAmountOut > 0n, "invalid effective amountOut");
    }
    return { block: entry.block, sourceBlockHash: snapshot.sourceBlockHash as string, mids };
  }) as Array<{ block: number; sourceBlockHash: string; mids: Map<string, ResolvedBlockScanQuote> }>;
  return { edges: graph.edges as TokenEdge[], snapshots, bindings,
    funding: index.funding.map((token: string) => token.toLowerCase()) as string[] };
}

/** Nearest-rank percentiles; never remove timed-out runs from the denominator. */
export function distribution(values: readonly number[]) {
  assert(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { count: sorted.length, min: sorted[0]!, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1)! };
}

export function publishCompletedSummary<T extends { byBlock: readonly { stableCompletedOutputs: boolean | null }[] }>(
  summary: T, save: (name: string, value: unknown) => void,
): void {
  assert(!summary.byBlock.some(row => row.stableCompletedOutputs === false), "completed runs produced different candidates");
  save("summary.json", summary);
}

export function parseOptions(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    assert(["--input-index", "--out", "--repetitions", "--warmups"].includes(name) && value && !options.has(name),
      `invalid benchmark argument: ${name}`);
    options.set(name, value);
  }
  assert(options.has("--input-index") && options.has("--out"), "--input-index and --out are required");
  const count = (key: string, fallback: number, minimum: number) => {
    const raw = options.get(key) ?? String(fallback), value = Number(raw);
    assert(/^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= minimum && value <= 100,
      `${key} must be an integer from ${minimum} to 100`);
    return value;
  };
  return { inputIndex: resolve(options.get("--input-index")!), out: resolve(options.get("--out")!),
    repetitions: count("--repetitions", 10, 1), warmups: count("--warmups", 1, 0) };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("npm run benchmark:enumeration -- --input-index <export-index.json> --out <new-directory> [--repetitions 10] [--warmups 1]");
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(resolve(options.out, name), `${json(value)}\n`, { flag: "wx", mode: 0o600 });
  assert(!existsSync(resolve(options.out, "declaration.json")), "output already contains a benchmark run");
  const started = performance.now();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  // Seal all production source files, including uncommitted additions. No env/secrets are recorded.
  const sourcePaths = git("ls-files", "--cached", "--others", "--exclude-standard", "listener/src").split("\n")
    .filter(path => path.endsWith(".ts") && existsSync(resolve(root, path))).sort();
  const sourceDigest = () => hash(json(sourcePaths.map(path => [path, hash(readFileSync(resolve(root, path)))])));
  const sourceHash = sourceDigest();
  let networkAttempts = 0;
  const noNetwork = (): never => { networkAttempts++; throw new Error("offline enumeration benchmark forbids network"); };
  net.Socket.prototype.connect = noNetwork;
  globalThis.fetch = noNetwork;
  process.env.SEARCHER_TEST_DISABLE_DOTENV = "1";
  process.env.SEARCHER_DRY_RUN = "1";
  const { resolveBlockScanCoreConfig, resolveBlockScanRefineCandidates } = await import("../src/searcher/main.js");
  const { buildBlockScanEthView } = await import("../src/searcher/blockscan-eth-view.js");
  const { scanBlockStateFromResolvedMids } = await import("../src/searcher/detector/blockscan-scanner-core.js");
  const { prepareBlockScanCandidatesWithoutExactRefinement } = await import("../src/searcher/detector/blockscan-candidate-refinement.js");
  const { blockScanEdgeKey } = await import("../src/searcher/venues/blockscan-state-capability.js");
  const loadStarted = performance.now();
  const input = loadEnumerationInput(options.inputIndex);
  const loadMs = performance.now() - loadStarted;
  const inputDigest = () => hash(json({ edges: input.edges, snapshots: input.snapshots }));
  const initialInputHash = inputDigest();
  // Empty env intentionally uses current checked-in defaults, not an unrelated shell/live override.
  const cfg = resolveBlockScanCoreConfig({});
  assert.equal(cfg.enumerationBackend, "typescript", "this offline benchmark requires TypeScript enumeration");
  // The export has token eligibility, not a verified live funding snapshot. Do not add new funding assets.
  cfg.pricedTokens = new Map([...cfg.pricedTokens].filter(([token]) => input.funding.includes(token)));
  assert.equal(cfg.pricedTokens.size, new Set(input.funding).size, "recorded funding asset missing from current config");
  const coarseCfg = { ...cfg, maxCandidates: resolveBlockScanRefineCandidates({}, cfg.maxCandidates) };
  const order = Array.from({ length: options.warmups + options.repetitions }, (_, round) => input.snapshots.map((snapshot, offset) => ({
    block: input.snapshots[(offset + round) % input.snapshots.length]!.block,
    kind: round < options.warmups ? "warmup" : "measured", round,
  }))).flat();
  save("declaration.json", { schema: 1, options, order, head: git("rev-parse", "HEAD"), node: process.version,
    sourceHash, sourceFileCount: sourcePaths.length, benchmarkHash: hash(readFileSync(fileURLToPath(import.meta.url))),
    sourceStatus: git("status", "--porcelain", "--", "listener/src"), inputBindings: input.bindings,
    graphEdges: input.edges.length, effectiveRows: input.snapshots.map(s => ({ block: s.block, rows: s.mids.size })),
    coarseCfg, downstreamCap: cfg.maxCandidates, inputHash: initialInputHash, loadMs, setupMs: performance.now() - started,
    scope: "Offline current production scanner core plus reference view and no-Exact candidate selection; NOT a full live run.",
    notes: ["P is unchanged from each saved effective amountIn; no re-quote or P rescaling.",
      "Current source defaults, with only funding-token eligibility restricted to the recorded export; not a live config dump.",
      "Reference view is rebuilt every run; no prior-run dynamic view/DFS cache is reused; no forced GC.",
      "Warmups are retained separately. Every measured run, including budget truncation, is included in summaries.",
      "File loading, imports, input/source hashing, serialization and report writing are outside stage timers.",
      "Scanner core includes preprocessing, DFS callbacks/candidate construction and ranking; it is not pure DFS time.",
      "No atomic runtime validation, strict, funding refresh, quote RPC, Solver, sim or EV is run."] });
  const records: any[] = [];
  try {
    for (const step of order) {
      const snapshot = input.snapshots.find(item => item.block === step.block)!;
      const referenceStart = performance.now();
      const view = buildBlockScanEthView(input.edges, snapshot.mids, cfg.ethSignalPairsPerToken, cfg.allowRepeatedPools);
      const coreStart = performance.now();
      let coreTiming: BlockScanScanTiming | undefined;
      const outcome = scanBlockStateFromResolvedMids({ edges: input.edges, mids: snapshot.mids, ethView: view,
        sourceBlock: snapshot.block, swapTouched: null, cfg: coarseCfg, onTiming(value) { coreTiming = value; } });
      const selectionStart = performance.now();
      const selection = prepareBlockScanCandidatesWithoutExactRefinement(outcome.opportunities, cfg.maxCandidates, {
        admissionSpreadBps: cfg.exactAdmissionSpreadBps, probeAmountsByOpportunity: new Map(outcome.opportunities.map(opportunity =>
          [opportunity, snapshot.mids.get(blockScanEdgeKey(opportunity.seedEdges[0]!))?.quoteAmountIn ?? 0n])),
      });
      const finished = performance.now();
      const routes = selection.opportunities.map(opportunity => ({ edges: opportunity.seedEdges.map(blockScanEdgeKey),
        searchSeed: opportunity.searchSeed, spreadBps: opportunity.coarseSpreadBps }));
      const record = { ...step, referenceMs: coreStart - referenceStart, coreMs: selectionStart - coreStart,
        selectionMs: finished - selectionStart, totalMs: finished - referenceStart, coreTiming,
        outcome: outcome.outcome, enumeration: outcome.enumeration, selection: outcome.selection, downstream: selection.disabled,
        outputHash: hash(json(routes)), routes, rssBytes: process.memoryUsage().rss };
      records.push(record);
      save(`run-${records.length}.json`, record);
      console.log(JSON.stringify({ ...step, referenceMs: record.referenceMs, coreMs: record.coreMs,
        selectionMs: record.selectionMs, totalMs: record.totalMs, outcome: record.outcome,
        candidates: record.selection.enumeratedCount, selected: record.downstream.selected }));
    }
    assert.equal(networkAttempts, 0);
    assert.equal(sourceDigest(), sourceHash, "production source changed during benchmark");
    assert.equal(inputDigest(), initialInputHash, "benchmark mutated its input");
    for (const binding of input.bindings) assert.equal(hash(readFileSync(binding.path)), binding.sha256, "input file changed");
    const measured = records.filter(record => record.kind === "measured");
    const summarize = (rows: typeof records) => ({ runs: rows.length,
      completed: rows.filter(row => row.outcome === "ran").length,
      truncated: rows.filter(row => row.outcome === "budget_exceeded").length,
      referenceMs: distribution(rows.map(row => row.referenceMs)), coreMs: distribution(rows.map(row => row.coreMs)),
      selectionMs: distribution(rows.map(row => row.selectionMs)), totalMs: distribution(rows.map(row => row.totalMs)),
    });
    const byBlock = input.snapshots.map(snapshot => {
      const rows = measured.filter(row => row.block === snapshot.block);
      const complete = rows.filter(row => row.outcome === "ran");
      const stableCompletedOutputs = complete.length < 2 ? null : new Set(complete.map(row => row.outputHash)).size === 1;
      return { block: snapshot.block, ...summarize(rows), stableCompletedOutputs,
        enumeratedCounts: [...new Set(rows.map(row => row.selection.enumeratedCount))],
        selectedCounts: [...new Set(rows.map(row => row.downstream.selected))] };
    });
    const summary = { status: "completed", measured: summarize(measured), byBlock,
      networkAttempts, sourceHash, sourceStable: true, inputsUnchanged: true, liveStarted: false,
      runFiles: records.map((_record, index) => `run-${index + 1}.json`) };
    publishCompletedSummary(summary, save);
    console.log(json(summary));
  } catch (error) {
    save("failure.json", { status: "failed", attempted: records.length, planned: order.length,
      message: error instanceof Error ? error.message : String(error), networkAttempts });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
