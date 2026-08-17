import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  UniverseRebuildCheckpointStore,
} from "../universe-rebuild-checkpoint.js";

// Audit §12: a SIGTERM mid-run must persist the completed outcomes through
// the signal flush hook (the store never waits for the full run to finish).
async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-sigterm-"));
  const checkpoint = join(dir, "checkpoint.json");
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/searcher/test/universe-rebuild-sigterm-harness.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CKPT_PATH: checkpoint,
          OUTCOME_COUNT: "60",
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let ready = false;
    const output = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("harness never became ready"));
      }, 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("READY") && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(out);
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error("harness exited before READY: " + code));
        }
      });
    });
    assert(ready, output);
    // The child recorded 60 outcomes with no explicit flush and a long
    // interval; SIGTERM must trigger the flush.
    child.kill("SIGTERM");
    const exit = await new Promise<{
      readonly observed: boolean;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("exit", (code, signal) => resolve({
        observed: true,
        code,
        signal,
      }));
      setTimeout(() => resolve({ observed: false, code: null, signal: null }), 15_000);
    });
    assert(exit.observed, "harness must exit after SIGTERM");
    assert(
      exit.signal === "SIGTERM" || exit.code === 0,
      "harness must terminate after its durable flush",
    );
    // Give the flush a moment, then verify the durable envelope.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    const envelope = await store.load();
    assert(envelope !== null);
    assert.equal(envelope.inProgressRun?.runId, "run-sig");
    assert.equal(
      Object.keys(envelope.inProgressRun?.outcomesByCandidateKey ?? {}).length,
      60,
      "SIGTERM flush must persist every completed outcome",
    );
    assert.equal(
      envelope.inProgressRun?.outcomesByCandidateKey["sig:59"]?.status,
      "verified",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild SIGTERM flush PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
