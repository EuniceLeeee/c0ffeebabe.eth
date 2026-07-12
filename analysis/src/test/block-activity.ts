import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const analysisRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(analysisRoot, "src", "cli", "block-activity.ts");
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test("block-activity preserves the JSONL funnel and joins target N to blockscan source N-1", async () => {
  await withFixture(async ({ eventsPath, logPath }) => {
    const stdout = await runBlockActivity(eventsPath, logPath);

    assert.match(stdout, /opportunity_seen: 1/);
    assert.match(stdout, /pipeline_dropped: 1/);
    assert.match(stdout, /stage=quote reason=no_quote: 1/);
    assert.match(stdout, /bundle_submitted: 1 abcdef01234567/);
    assert.match(stdout, new RegExp(`blockscan: target_block=100 source_block=99 status=complete`));
    assert.match(stdout, /solve_rings: 1/);
    assert.match(stdout, new RegExp(`ring=${WETH}->${USDC}->${WETH} net=42`));
    assert.match(stdout, new RegExp(`solve_ring_tokens: 2 ${USDC},${WETH}`));
  });
});

test("block-activity reports unavailable blockscan logs as unknown without losing the funnel", async () => {
  await withFixture(async ({ root, eventsPath }) => {
    const missingLog = join(root, "missing-live.log");
    const stdout = await runBlockActivity(eventsPath, missingLog);

    assert.match(stdout, /opportunity_seen: 1/);
    assert.match(stdout, /bundle_submitted: 1/);
    assert.match(stdout, /blockscan: target_block=100 source_block=99 status=unknown_log_unavailable/);
    assert.match(stdout, /solve_rings: unknown/);
    assert.match(stdout, /solve_ring_tokens: unknown/);
  });
});

async function runBlockActivity(eventsPath: string, logPath: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    cliPath,
    "--block",
    "100",
    "--events",
    eventsPath,
    "--blockscan-log",
    logPath,
  ], { cwd: analysisRoot });
  return result.stdout;
}

async function withFixture(
  run: (fixture: { root: string; eventsPath: string; logPath: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mev-block-activity-"));
  const eventsPath = join(root, "events.jsonl");
  const logPath = join(root, "mev-live.log");
  await writeFile(eventsPath, [
    JSON.stringify({ type: "opportunity_seen", target_block: 100 }),
    JSON.stringify({ type: "pipeline_dropped", target_block: 100, stage: "quote", reason: "no_quote" }),
    JSON.stringify({ type: "bundle_submitted", target_block: 100, opportunity_id: "abcdef0123456789" }),
  ].join("\n"));
  await writeFile(logPath, [
    "[searcher/blockscan] block=99 warm=full reason=startup",
    `[searcher/blockscan] block=99 solve ring=${WETH}->${USDC}->${WETH} net=42 standing=false protoRing=false`,
    "[searcher/blockscan] block=99 scannedPairs=1 candidates=1 quotePositive=1 bestNet=42 warmedV2V3=1 protocolMids=0 skippedVenues=0 ms=2",
    "[searcher/blockscan] block=99 stage warm_plan=1ms solve=1ms total=2ms",
  ].join("\n"));
  try {
    await run({ root, eventsPath, logPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
