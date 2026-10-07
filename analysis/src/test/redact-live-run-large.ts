import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/redact-live-run.ts", import.meta.url));

async function redactFixture(events: string) {
  const directory = await mkdtemp(join(tmpdir(), "mev-redaction-large-"));
  try {
    const log = join(directory, "live.log");
    const input = join(directory, "events.jsonl");
    await writeFile(log, "[searcher/live] counters solverEntered=0\n");
    await writeFile(input, events);
    const result = spawnSync(process.execPath, [
      "--import", "tsx", cli,
      "--log", log,
      "--events", input,
      "--out-dir", directory,
      "--label", "large-events",
    ], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return {
      summary: await readFile(join(directory, "large-events-summary.md"), "utf8"),
      events: await readFile(join(directory, "large-events-events.redacted.jsonl"), "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("live redaction summarizes 276199 events without exceeding argument limits", async () => {
  const firstBlock = 26_138_356;
  const blocks = 548;
  const drops = 275_651;
  const rows = [];
  for (let i = 0; i < blocks; i++) {
    rows.push(JSON.stringify({ type: "block_scan_result", target_block: firstBlock + i }));
  }
  for (let i = 0; i < drops; i++) {
    rows.push(JSON.stringify({
      type: "pipeline_dropped",
      target_block: firstBlock + i % blocks,
      stage: "planner_solver",
      reason: "sim_revert_seen_this_live",
    }));
  }
  const input = `${rows.join("\n")}\n`;
  const result = await redactFixture(input);
  assert.match(result.summary, /event rows: `276199`/);
  assert.match(result.summary, /invalid rows: `0`/);
  assert.match(result.summary, /event block range: `26138356-26138903`/);
  assert.match(result.summary, /"block_scan_result": 548/);
  assert.match(result.summary, /"pipeline_dropped": 275651/);
  assert.match(result.summary, /`planner_solver\/sim_revert_seen_this_live`: `275651`/);
  assert.equal(result.events, input, "all public event rows must be preserved");
});

test("live redaction retains n/a for empty or blockless events", async () => {
  for (const input of ["", '{"type":"startup"}\n']) {
    const result = await redactFixture(input);
    assert.match(result.summary, /event block range: `n\/a`/);
    assert.match(result.summary, /invalid rows: `0`/);
    assert.equal(result.events, input);
  }
});
