import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INPUT_LOCATIONS,
  resolveInputPaths,
  type InputLocations,
} from "../cli/redact-live-run.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("live-run defaults name the current node artifacts", () => {
  assert.equal(DEFAULT_INPUT_LOCATIONS.currentLog, "/var/log/mev-live.log");
  assert.equal(
    DEFAULT_INPUT_LOCATIONS.currentEvents,
    "/var/log/mev/events/searcher-live.jsonl",
  );
});

test("current node artifacts take priority over newer legacy files", async () => {
  await withLocations(async (locations) => {
    await write(locations.currentLog);
    await write(locations.currentEvents);
    const legacyLog = join(locations.legacyLogDir, "mev-live-legacy.log");
    const legacyEvents = join(locations.legacyEventsDir, "searcher-legacy.jsonl");
    await write(legacyLog);
    await write(legacyEvents);
    const newer = new Date(Date.now() + 60_000);
    await utimes(legacyLog, newer, newer);
    await utimes(legacyEvents, newer, newer);

    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: locations.currentLog,
      eventsPath: locations.currentEvents,
    });
  });
});

test("missing node artifacts safely fall back to the newest legacy files", async () => {
  await withLocations(async (locations) => {
    const oldLog = join(locations.legacyLogDir, "mev-live-old.log");
    const newLog = join(locations.legacyLogDir, "mev-live-new.log");
    const events = join(locations.legacyEventsDir, "searcher-local.jsonl");
    await write(oldLog);
    await write(newLog);
    await write(events);
    const old = new Date(1_000);
    const newer = new Date(2_000);
    await utimes(oldLog, old, old);
    await utimes(newLog, newer, newer);

    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: newLog,
      eventsPath: events,
    });
  });
});

test("explicit paths override defaults and events remain optional", async () => {
  await withLocations(async (locations) => {
    assert.deepEqual(
      await resolveInputPaths({ log: "/chosen/run.log", events: "/chosen/events.jsonl" }, locations),
      { logPath: "/chosen/run.log", eventsPath: "/chosen/events.jsonl" },
    );

    const fallbackLog = join(locations.legacyLogDir, "mev-live-only.log");
    await write(fallbackLog);
    await mkdir(join(locations.legacyEventsDir, "searcher-directory.jsonl"));
    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: fallbackLog,
      eventsPath: undefined,
    });
  });
});

test("census-gap defaults to the runtime routing graph", async () => {
  const script = await readFile(join(repoRoot, "scripts", "census-gap.sh"), "utf8");
  assert.match(
    script,
    /^GRAPH=\$\{GRAPH:-\/opt\/MEV\/listener\/searcher\/pools\/runtime-graph-pools\.json\}$/m,
  );
  assert.match(script, /^BLOCKSCAN_LOG=\$\{BLOCKSCAN_LOG:-\/var\/log\/mev-live\.log\}$/m);
  assert.match(script, /--blockscan-log "\$BLOCKSCAN_INPUT"/);
});

async function withLocations(run: (locations: InputLocations) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mev-tool-defaults-"));
  const locations: InputLocations = {
    currentLog: join(root, "var", "log", "mev-live.log"),
    currentEvents: join(root, "var", "log", "mev", "events", "searcher-live.jsonl"),
    legacyLogDir: join(root, "tmp"),
    legacyEventsDir: join(root, "analysis", "events"),
  };
  await mkdir(locations.legacyLogDir, { recursive: true });
  await mkdir(locations.legacyEventsDir, { recursive: true });
  try {
    await run(locations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "fixture\n");
}
