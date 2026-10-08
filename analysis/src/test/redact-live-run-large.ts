import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/redact-live-run.ts", import.meta.url));

async function redactFixture(events: string, rawLog = "[searcher/live] counters solverEntered=0\n") {
  const directory = await mkdtemp(join(tmpdir(), "mev-redaction-large-"));
  try {
    const log = join(directory, "live.log");
    const input = join(directory, "events.jsonl");
    await writeFile(log, rawLog);
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
      log: await readFile(join(directory, "large-events-redacted.log"), "utf8"),
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

test("streaming preserves late aliases, multiline secrets, UTF-8/CRLF and summary ordering", async () => {
  const wallet = "0x" + "1".repeat(40), botvm = "0x" + "2".repeat(40);
  const timing = (n: number) => `match=${n}ms fork=0ms prep=0ms detect=0ms total=${n}ms`;
  const publicPrefix = "界".repeat(21_843) + "🙂";
  const rawLog = [
    `previous mention=${wallet} other=${botvm}`,
    `${publicPrefix} PRIVATE_KEY="first`,
    "continuation-secret",
    "[searcher/live] mempool=HIDDEN liveBackend=rpc",
    "[searcher/live] counters hidden=1",
    timing(999),
    'last" suffix',
    "SECRET='first",
    "second-secret",
    "last' end",
    "[searcher/live] mempool=off",
    ...Array.from({ length: 14 }, (_, i) => timing(i + 1)),
    timing(1),
    "[searcher/live] counters solverEntered=0 cuProxyRpcCalls=0",
    `wallet=${wallet} botvm=${botvm}`,
  ].join("\r\n");
  const events = JSON.stringify({ type: "startup", references: [wallet, botvm], private_key: "secret" }) +
    "\r\nbad API_KEY=malformed-secret\r\n";
  const result = await redactFixture(events, rawLog);
  assert(!result.log.includes(wallet) && !result.log.includes(botvm));
  assert(!result.events.includes(wallet) && !result.events.includes(botvm));
  assert(result.log.startsWith("previous mention=<REDACTED_WALLET> other=<REDACTED_BOTVM>\r\n"));
  assert(result.log.includes(publicPrefix + " PRIVATE_KEY=<REDACTED> suffix\r\n"));
  assert(result.log.includes("SECRET=<REDACTED> end\r\n"));
  assert(!result.log.includes("continuation-secret") && !result.log.includes("second-secret"));
  assert(!result.summary.includes("HIDDEN") && !result.summary.includes("hidden=1") && !result.summary.includes(timing(999)));
  assert(!result.summary.includes("slower remote-fork path"));
  assert(result.summary.includes("solverEntered=0 cuProxyRpcCalls=0"));
  assert(!result.summary.includes("`" + timing(1) + "`") && !result.summary.includes("`" + timing(2) + "`"));
  for (let n = 3; n <= 14; n++) assert(result.summary.includes("`" + timing(n) + "`"));
  assert.match(result.summary, /event rows: `2`/);
  assert.match(result.summary, /invalid rows: `1`/);
  assert(!result.events.includes("malformed-secret"));
});

test("unterminated quoted secrets fail without publishing a report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mev-redaction-invalid-"));
  try {
    const log = join(directory, "live.log"), input = join(directory, "events.jsonl");
    await writeFile(log, 'public\nSECRET="never-closed\nhidden');
    await writeFile(input, "");
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--log", log, "--events", input,
      "--out-dir", directory, "--label", "invalid"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unterminated quoted sensitive assignment/);
    await assert.rejects(stat(join(directory, "invalid-redacted.log")), { code: "ENOENT" });
    await assert.rejects(stat(join(directory, "invalid-summary.md")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report output cannot overwrite a source alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mev-redaction-alias-"));
  try {
    const log = join(directory, "live.log");
    await writeFile(log, "original-source\n");
    await link(log, join(directory, "alias-redacted.log"));
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--log", log,
      "--out-dir", directory, "--label", "alias"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not overwrite an input/);
    assert.equal(await readFile(log, "utf8"), "original-source\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("changing inputs between streaming passes cannot publish a report", async () => {
  for (const mutation of ["append", "rewrite", "replace", "events"]) {
    const directory = await mkdtemp(join(tmpdir(), "mev-redaction-changing-"));
    try {
      const log = join(directory, "live.log"), input = join(directory, "events.jsonl");
      const wallet = "0x" + "3".repeat(40);
      await writeFile(log, `previous mention=${wallet}\n`);
      await writeFile(input, '{"type":"startup"}\n');
      const preload = join(directory, "mutate.mjs");
      // Intercept the actual CLI stream at EOF, deterministically mutating its
      // source after alias discovery or after the final event read. No sleeps.
      await writeFile(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.createReadStream;
const target = ${JSON.stringify(mutation === "events" ? input : log)};
fs.createReadStream = function(path, ...args) {
  const stream = original.call(this, path, ...args);
  if (path === target) stream.once("end", () => {
    const mutation = ${JSON.stringify(mutation)};
    if (mutation === "append") fs.appendFileSync(target, ${JSON.stringify(`wallet=${wallet}\n`)});
    else if (mutation === "rewrite") {
      const before = fs.statSync(target);
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("previous", "modified"));
      fs.utimesSync(target, before.atime, new Date(before.mtimeMs + 2000));
    } else if (mutation === "replace") {
      fs.writeFileSync(target + ".new", fs.readFileSync(target));
      fs.renameSync(target + ".new", target);
    } else fs.appendFileSync(target, '{"type":"late"}\\n');
  });
  return stream;
};
syncBuiltinESMExports();
`);
      const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, cli,
        "--log", log, "--events", input, "--out-dir", directory, "--label", "changing"],
      { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, mutation + ": " + result.stderr);
      assert.match(result.stderr, /Live inputs changed during redaction/);
      for (const name of ["changing-redacted.log", "changing-events.redacted.jsonl", "changing-summary.md"])
        await assert.rejects(stat(join(directory, name)), { code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a real log larger than V8's string limit streams without loss", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mev-redaction-volume-"));
  try {
    const log = join(directory, "live.log"), input = join(directory, "events.jsonl");
    const line = "x".repeat(64 * 1024) + "\n";
    const rows = Math.ceil((constants.MAX_STRING_LENGTH + 1) / line.length);
    const expected = createHash("sha256"), handle = await open(log, "wx");
    try {
      for (let i = 0; i < rows; i++) { await handle.writeFile(line); expected.update(line); }
    } finally { await handle.close(); }
    await writeFile(input, '{"type":"startup"}\n');
    assert((await stat(log)).size > constants.MAX_STRING_LENGTH);
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", "tsx", cli,
      "--log", log, "--events", input, "--out-dir", directory, "--label", "volume"],
    { encoding: "utf8", timeout: 100_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const output = join(directory, "volume-redacted.log"), actual = createHash("sha256");
    for await (const chunk of createReadStream(output)) actual.update(chunk);
    assert.equal((await stat(output)).size, rows * line.length);
    assert.equal(actual.digest("hex"), expected.digest("hex"));
    assert.match(await readFile(join(directory, "volume-summary.md"), "utf8"), /event rows: `1`/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
