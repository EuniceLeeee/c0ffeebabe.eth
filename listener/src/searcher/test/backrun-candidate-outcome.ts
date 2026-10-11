import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { backrunCandidateFailure, backrunConsumerFailureIsTerminal, settleBackrunFinalOverlay,
  type BackrunCandidateStage } from "../backrun-candidate-outcome.js";
import { RevmFatalError } from "../revm-sim-client.js";
import { runBackrunCandidatePipeline } from "../backrun-candidate-pipeline.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { StateBackend } from "../../shared/state/state-backend.js";

test("only a solver timeout is counted as a quote timeout", () => {
  for (const stage of ["solver", "final_verify", "ev", "submit_gate"] as BackrunCandidateStage[]) {
    const failure = backrunCandidateFailure(stage, new Error("deadline elapsed"), true);
    assert.equal(failure.stage, stage);
    assert.equal(failure.quoteTimeout, stage === "solver");
    assert.equal(failure.state, stage === "solver" ? "quote-timeout" : "final-verify-failed");
    assert.equal(failure.fatal, false);
  }
});

test("typed final source fault remains an infrastructure failure, not a quote loss or EVM revert", () => {
  assert.deepEqual(backrunCandidateFailure("final_verify", new RevmFatalError({ kind: "source-fault" }), false), {
    stage: "final_verify", reason: "source-fault", state: "final-verify-failed", quoteTimeout: false, fatal: true,
  });
  assert.equal(backrunCandidateFailure("final_verify", new Error("source-fault"), false).fatal, false,
    "text alone cannot latch the source");
  assert.equal(backrunCandidateFailure("solver", new Error("no profitable quote"), false).state, "no-profitable-quote");
});

function pipelineInput() {
  return {
    plans: [{}, {}] as CandidatePlan[], maxCandidates: 0, concurrency: 2,
    state: {} as StateBackend, executor: `0x${"12".repeat(20)}`,
    options: {}, solverDeadlineMs: 1000, deadlineAtMs: Date.now() + 5000,
    signal: new AbortController().signal, onQuoteStart() {},
  };
}

test("fatal consumer source failure cancels and drains quotes without trying another final simulation", async () => {
  const input = pipelineInput(), fatal = new RevmFatalError({ kind: "source-fault" });
  let drained = false, finalAttempts = 0;
  await assert.rejects(runBackrunCandidatePipeline({ ...input,
    solver: { async solve(plan, _state, _probe, options) {
      if (plan === input.plans[0]) {
        await new Promise<void>(resolve => setImmediate(resolve));
        return { flashAmount: 1n } as ResolvedPlan;
      }
      try {
        await new Promise<void>((_resolve, reject) => {
          const signal = options!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      } finally { drained = true; }
    } },
    consume: async () => { finalAttempts++; throw fatal; },
  }), error => error === fatal);
  assert.equal(finalAttempts, 1);
  assert.equal(drained, true);
});

test("historical accepted consumer has the same stop/drain semantics as live submission", async () => {
  const recorded: string[] = [];
  const completed = await runBackrunCandidatePipeline({ ...pipelineInput(),
    solver: { async solve() { return { flashAmount: 1n } as ResolvedPlan; } },
    consume: async () => { recorded.push("would-submit"); return false; },
  });
  if (completed) recorded.push("no-profitable-quote");
  assert.deepEqual(recorded, ["would-submit"]);
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("async function processOpportunities("), main.indexOf("async function readUncachedLatestBlock("));
  assert.match(body, /failureStage = "final_verify"[\s\S]*await ctx\.liveBackend\.finalVerify/);
  assert.match(body, /failureStage = "ev";\s*const ev = await evaluateEv/);
  assert.match(body, /if \(ctx\.historicalExecutionMode\) \{\s*deps\.recordFinalState[\s\S]*?if \(netEvWei > ctx\.config\.minNetEth\) return false;\s*continue;/);
  assert.match(body, /emitPipelineDropped\(failure\.stage, failure\.reason/);
  assert.match(body, /if \(failure\.fatal\) throw err/);
  assert.match(body, /if \(error instanceof RevmFatalError\) throw error/);
  assert.match(body, /if \(!terminalConsumerFailure\) \{[\s\S]*?ctx\.counters\.quoteTimeouts\+\+/);
  assert.match(body, /terminalConsumerFailure = backrunConsumerFailureIsTerminal\(failureStage, signal, oppDeadlineAtMs\)/);
  assert.match(body, /await settleBackrunFinalOverlay\(async \(\) => \{[\s\S]*?await ctx\.liveBackend\.prepareVictimState/);
  assert.match(body, /if \(!pipelineCompleted\) return;/);
});

for (const stage of ["final_verify", "ev"] as const) {
  test(`${stage} deadline remains a consumer failure after scheduler cancellation/drain`, async () => {
    const input = { ...pipelineInput(), deadlineAtMs: Date.now() + 100 };
    let terminalConsumerFailure = false, last = "", quoteTimeouts = 0, attempts = 0;
    try {
      await runBackrunCandidatePipeline({ ...input,
        solver: { async solve() { return { flashAmount: 1n } as ResolvedPlan; } },
        consume: async (_plan, _result, _index, signal) => {
          attempts++;
          try {
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          } catch (error) {
            last = backrunCandidateFailure(stage, error, true).stage;
            terminalConsumerFailure = backrunConsumerFailureIsTerminal(stage, signal, input.deadlineAtMs);
          }
          return true;
        },
      });
    } catch {
      if (!terminalConsumerFailure) { last = "solver"; quoteTimeouts++; }
    }
    assert.equal(attempts, 1);
    assert.equal(last, stage);
    assert.equal(quoteTimeouts, 0);
    assert.equal(backrunConsumerFailureIsTerminal(stage, new AbortController().signal, Date.now() + 10000), false,
      "an earlier non-terminal consumer failure must not mask a later quote deadline");
    assert.equal(backrunConsumerFailureIsTerminal("solver", AbortSignal.abort(), 0), false);
  });
}

test("final overlay catch propagates typed backend faults through scheduler cancellation/drain", async () => {
  const input = pipelineInput(), fatal = new RevmFatalError({ kind: "source-fault" });
  let prepared = 0, finalCalls = 0, normalRejects = 0, drained = false;
  await assert.rejects(runBackrunCandidatePipeline({ ...input,
    solver: { async solve(plan, _state, _probe, options) {
      if (plan === input.plans[0]) { await new Promise<void>(r => setImmediate(r)); return {} as ResolvedPlan; }
      try {
        await new Promise<void>((_resolve, reject) => {
          if (options!.signal!.aborted) reject(options!.signal!.reason);
          else options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        });
        throw new Error("unreachable");
      } finally { drained = true; }
    } },
    consume: async () => {
      const overlay = await settleBackrunFinalOverlay(async () => { prepared++; throw fatal; });
      if (!overlay.ok) { normalRejects++; return true; }
      finalCalls++;
      return true;
    },
  }), error => error === fatal);
  assert.equal(prepared, 1); assert.equal(finalCalls, 0); assert.equal(normalRejects, 0); assert(drained);
  const error = new Error("ordinary overlay failure");
  assert.deepEqual(await settleBackrunFinalOverlay(async () => { throw error; }), { ok: false, error });
  assert.deepEqual(await settleBackrunFinalOverlay(async () => "prepared"), { ok: true, value: "prepared" });
});
