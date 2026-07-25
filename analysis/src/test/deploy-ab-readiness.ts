import assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const analysisRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(analysisRoot, "..");
const wrapper = readFileSync(
  join(repoRoot, "scripts", "deploy-ab-challenger.sh"),
  "utf8",
);
const parser = wrapper.match(
  /current_generation_blockscan_ready\(\) \{[\s\S]*?python3 - "\$log" "\$offset" <<'PY'\n([\s\S]*?)\nPY\n\}/,
)?.[1];

assert.ok(parser, "deploy wrapper readiness parser must be extractable");

const START = "[searcher/live] starting V5 searcher\n";
const LEGACY =
  "[searcher/blockscan] block=25600000 scannedPairs=10 candidates=0\n";

function timing(input: {
  readonly startupWarm?: boolean;
  readonly outcome?: string;
  readonly enumeration?: "ran" | "failed" | "not-run";
} = {}): string {
  return `[searcher/blockscan-family] ${JSON.stringify({
    type: "block_scan_timing",
    source_block: 25_600_000,
    outcome: input.outcome ?? "ran",
    startup_warm: input.startupWarm ?? false,
    stages: {
      enumeration: { status: input.enumeration ?? "ran" },
    },
  })}\n`;
}

test("challenger readiness accepts only a current non-startup scan generation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mev-deploy-readiness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cases: readonly {
    readonly name: string;
    readonly before?: string;
    readonly after: string;
    readonly offset?: number;
    readonly ready: boolean;
  }[] = [
    {
      name: "old valid records before byte offset",
      before: START + LEGACY + timing(),
      after: START,
      ready: false,
    },
    {
      name: "record without current generation banner",
      after: timing(),
      ready: false,
    },
    {
      name: "state telemetry is not terminal readiness",
      after: START +
        `[searcher/blockscan-family-telemetry] ${JSON.stringify({
          block: 25_600_000,
          status: "complete",
        })}\n`,
      ready: false,
    },
    {
      name: "startup warm timing",
      after: START + timing({
        startupWarm: true,
        outcome: "startup_warm",
        enumeration: "not-run",
      }),
      ready: false,
    },
    {
      name: "failed enumeration",
      after: START + timing({ enumeration: "failed" }),
      ready: false,
    },
    {
      name: "malformed family JSON",
      after: START +
        '[searcher/blockscan-family] {"type":"block_scan_timing",\n',
      ready: false,
    },
    {
      name: "new terminal timing after enumeration",
      after: START + timing(),
      ready: true,
    },
    {
      name: "legacy marker after current generation",
      after: START + LEGACY,
      ready: true,
    },
    {
      name: "later generation resets earlier readiness",
      after: START + timing() + START,
      ready: false,
    },
    {
      name: "truncated below captured byte offset",
      after: START,
      offset: Buffer.byteLength(START) + 1,
      ready: false,
    },
  ];

  for (const entry of cases) {
    const path = join(root, `${entry.name.replaceAll(/\W+/g, "-")}.log`);
    const before = entry.before ?? "";
    writeFileSync(path, before + entry.after);
    const offset = entry.offset ?? Buffer.byteLength(before);
    const result: SpawnSyncReturns<string> = spawnSync(
      "python3",
      ["-", path, String(offset)],
      {
        input: parser,
        encoding: "utf8",
      },
    );
    assert.equal(
      result.status,
      entry.ready ? 0 : 1,
      `${entry.name}: stderr=${result.stderr}`,
    );
  }
});

test("challenger readiness wait is bound to the started MainPID", () => {
  const deployBody = wrapper.slice(
    wrapper.indexOf("deploy() {"),
    wrapper.indexOf("\npause_experiment()"),
  );
  assert.match(
    deployBody,
    /b_log_offset=\$\(wc -c < "\$LOG"/,
    "readiness must use this deployment's log byte offset",
  );
  assert.match(
    deployBody,
    /b_started_pid=\$\(systemctl show -p MainPID --value "\$UNIT"/,
    "readiness must bind the PID created by this deployment",
  );
  assert.match(
    deployBody,
    /challenger_exited_during_first_blockscan/,
    "an exited challenger must fail immediately",
  );
  assert.match(
    deployBody,
    /challenger_pid_changed_during_first_blockscan/,
    "a replacement process must not satisfy readiness",
  );
  assert.match(
    deployBody,
    /current_generation_blockscan_ready "\$LOG" "\$b_log_offset"/,
    "the wait must use the generation-aware parser",
  );
  assert.doesNotMatch(
    deployBody,
    /if grep -q '\\\[searcher\/blockscan\\\] block=\.\*scannedPairs='/,
    "the wait must not grep the whole log for an old marker",
  );
});
