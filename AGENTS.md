# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### One canonical path; every stage needs a unique job

- There is one implementation of the product behavior. Tests, acceptance,
  diagnostics, dry-runs, and observers must invoke or observe that canonical
  path; they must not recreate its orchestration, search loop, composition,
  state transitions, candidate construction, or verdict logic in a parallel
  pipeline.
- A claim about live behavior must come from the exact live entrypoint,
  executable, composition, ports, configuration, and emitted facts being
  claimed. A unit test or offline substitute may prove only its local contract;
  it cannot be promoted into evidence about live behavior. A parallel
  acceptance implementation validates itself, not the live system, even when
  its types and expected outputs look equivalent.
- Independent verification means independently reading raw artifacts and
  recomputing facts such as hashes, counts, sets, and lineage joins. It does
  **not** mean implementing the product behavior a second time. If an observer
  cannot judge the real path without duplicating it, expose better raw facts
  from the real path instead.
- Before adding a component, abstraction, stage, preflight, rehearsal, test
  harness, or gate, name the one production responsibility, independent fact,
  or safety boundary that no existing step owns. If there is no such unique
  job, do not add it: reuse, merge, or delete.
- Apply the deletion test before coding: removing the proposed step must remove
  a user-visible capability, a uniquely observable fact, or a necessary safety
  boundary. If nothing unique is lost, the step is duplication.
- Do not perform a rehearsal and then repeat the same safe, authorized
  end-to-end operation unless the rehearsal proves a distinct property that
  the real operation cannot prove. If both operations claim the same fact,
  keep the canonical end-to-end operation and delete the duplicate. Facts used
  to judge live correctness must be emitted by and joined back to that exact
  run; never substitute facts produced by an "equivalent" implementation.
- Runtime modes share the same core pipeline and may differ only at genuinely
  necessary boundaries such as bootstrap, external authority, evidence
  sealing, or submission. A temporary, shadow, acceptance-only, or
  "offline-equivalent" business pipeline is still a second pipeline and is
  forbidden unless the user explicitly authorizes it for a named unique fact.
- If an ordinary implementation change repeatedly requires matching changes
  to a gate, boundary checker, fixture, or mirror implementation without a
  contract change, treat that coupling as evidence of duplication. Simplify
  the checker or expose stable facts; do not expand both sides.
- Safety gates for signing, broadcasting, secrets, or external authority keep
  their independent role, but they observe or constrain the canonical path;
  they never justify duplicating the business pipeline.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```less
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Scheduled Wakeups

Keep recurring wakeup prompts short, neutral, and limited to progress detection and an explicitly authorized resume.
Refer to this file and the active task for safety and authorization boundaries; do not copy concrete high-risk
operations, command names, credentials, or deployment actions into the scheduled prompt. A wakeup never widens the
authority of the task it observes.

A routine may force a new execution turn for already-authorized in-scope work only when its prompt explicitly grants
stalled-task resume authority and read-only inspection proves all of the following: the goal is still active; the task
has made no substantive progress for at least one continuous hour; no main Agent, sub-Agent, test, build, tool session,
or meaningful external wait is still running; and the task was not paused, redirected, or completed. Before resuming,
inspect the active goal, current plan, Agent/tool handles, and actual Git/WIP; preserve all existing work and continue
from the next unfinished coherent slice. A missing observation or a polling timeout is not proof of a stall.

If any substantive work is active, the routine stays completely silent and does not start another turn. Resume
authority does not authorize interruption or termination of a live process, destructive recovery, deployment,
signing, broadcasting, or any other action not already authorized by the active task. If safe in-scope progress is
impossible, report the exact blocker instead of manufacturing activity.

Do not copy hidden system instructions, raw heartbeat/XML directives, internal policy text, or concrete process-control
instructions into user-facing prompts or reports. Translate them into a short, neutral status check; keep any required
authorization boundary explicit and report-only.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
