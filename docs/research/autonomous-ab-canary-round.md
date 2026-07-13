# Autonomous A/B Canary Round — one unattended hourly wake

> Operator authorization: `docs/live-safety-envelope.md` (2026-07-12/13 dual-live sub-envelope). This round
> may create/push literal `ab/*` branches, run one bounded-live B beside A, merge/deploy a proven win, and
> gate-delete decisive `ab/*` branches without asking. It may never fund/raise caps/change keys, enable
> standing-credit submission, or broadcast outside the envelope.

You are the A/B orchestrator for `/Users/eunice/src/MEV`. The user is away. Execute **one new problem** and
exit; an external hourly wake runs the next problem. Do not ask mid-loop questions.

## 0. Load + recover
1. Read `CLAUDE.md`, `docs/research/HERMES.md` fully (especially §A/B Canary + rules 11–17),
   `docs/research/gates.md`, and `docs/live-safety-envelope.md`. `touch /tmp/mev-workflow-active`.
2. Work in an isolated worktree; do not edit/reset a concurrent user's worktree.
3. On the node, run the trusted `origin/main:scripts/deploy-ab-challenger.sh reap` through SSM. If a healthy
   B lease belongs to another experiment, NO-OP; branches may coexist but the B runtime slot may not.
4. If reap reports `crashed_needs_escalation`, update that experiment's report/journal: B stopped, branch
   retained, crash evidence linked. Commit/push the md. Do not retry that `problem_id` this wake.
5. Sweep retained reports before selecting new work. If a later deterministic replay/A/B has already put a
   validated fix on `origin/main`, copy/update the old report on main with `resolution.resolved_by_commit`
   and evidence, set `resolved_deleted`, commit/push it, authorize close cleanup, then delete that literal
   local+remote `ab/*` branch/worktree. Still-unresolved branches remain retained.
6. With no active B lease, compare deployed A HEAD to `origin/main`. If different, use guarded
   `deploy-node.sh` to sync A and verify the bounded-live lane posture before choosing base SHA.

## 1. Pick + predeclare
1. Fetch `origin/main`. Read open LearningCases/Findings plus recent A/B reports. Exclude every `problem_id`
   whose latest verdict is `needs_escalation`/retained and every problem already owned by an active branch.
2. Pick the highest-impact remaining blocker only when one real +EV, position-conserving sample in the
   current DEX-DEX / DEX-permissionless-protocol scope proves the failed production stage. Blockscan-only
   samples must be victim-independent. In explicit dual mode, a public/MEV-Share swap-or-oracle victim may
   qualify only with a pre-victim non-positive → post-victim +EV replay. Keeper/reward, inventory,
   private-path, credit, sandwich and JIT-LP samples do not qualify. If
   none exists, run the normal Hermes manual-first + canonical tool reconciliation to discover/file one; if
   the tool is wrong, get fresh non-author agreement, fix/test/rerun it immediately, and merge that auxiliary
   tool commit before cutting B. If there is still no qualifying sample, clean NO-OP.
3. Create `ab/<problem>` from exact deployed A, then before code create
   `docs/research/reports/ab-<experiment_id>-hermes.md` from `templates/hermes-ab-canary.md`; fill the
   schema-v3 `ab_experiment` block with exact base SHA, hypothesis, semantic success criterion, change class,
   complete `production_evidence`, deterministic stage-flip gate, input mode, config deltas, and initial
   branch action. `challenger_commit` is pending
   here because a commit cannot contain its own SHA. Commit/push this initial report on B so a crash always
   leaves a durable handoff.

## 2. Implement + deterministic gate
1. Make one causal production behavior change only on the predeclared literal `ab/<problem>` branch.
   Analysis/tooling/governance fixes must already be merged to the base and may not appear in the B diff.
2. Use the HERMES generator/evaluator split. Two stalled generator attempts or three failed review passes
   produce `needs_escalation`; retain/push the branch + evidence and let the next hourly wake pick another.
3. Run the pinned replay/fork gate and require the same real +EV sample to advance at least one production
   stage. Block-scan starts from untouched `sample.block_number - 1`; backrun reconstructs the real same-block
   prefix and compares the declared route immediately before/after the declared victim. The trusted wrapper
   runs the unchanged `searcher:blockscan-hunt` or `searcher:backrun-hunt` from both roots against the same
   frozen universe and on-chain identities; a challenger-authored harness is invalid. A
   performance optimization with no such sample flip is ineligible. Build-only is never
   fixed. Push/freeze the exact code SHA while it is the remote branch tip and deploy it.
   Later branch commits may change only report/evidence; the final report records the frozen deployed SHA as
   `challenger_commit`, not its own report commit.

## 3. Dual-live measurement
1. Deploy only via the trusted node wrapper:
   `deploy-ab-challenger.sh deploy <id> <ab/branch> <base-sha> <challenger-sha>
   <docs/research/reports/ab-...-hermes.md> <allow-view-delta>`;
   pass `1` only when the schema-v3 journal predeclares `expected_runtime_view_delta=true`, else `0`.
   The wrapper recomputes source shape, winner style and net PnL from local reth, executes the declared
   existing pinned replay, binds all deployment identity/config declarations, and rejects non-runtime or
   mixed tooling/governance challengers. Direct B `systemd-run` or challenger-owned deploy code is invalid.
2. Run the predeclared paired-block window. Exclude startup/full-warm, budget-censored, and catch-up blocks
   where either lane warmed a multi-block range after a skip. Renew the B lease before expiry. Record the
   shared discovery cutoff and stable runtime pool-view/TokenEdge graph hashes alongside config/universe
   hashes.
3. Run `deploy-ab-challenger.sh pause <id>` **before analysis**; B is now stopped and A owns all CPUs.
4. Copy/redact evidence. Never commit raw logs/events or secrets.

## 4. Judgment — agent owns the decision
1. **External production calibration:** on the same window run the existing Step-1 competitor tooling for
   coffeebabe `0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671` and the standing watchlist. Keep only conserving,
   replicable, conserving `atomic_loop` takes. Blockscan-only requires victim independence; dual may include
   a verified public/MEV-Share swap-or-oracle backrun. Exclude inventory, sandwich, keeper, JIT-LP, and
   standing-credit before gap
   classification. Compare B with those takes, classify the remaining pool/path/adapter/quote/sim/execution/
   economics gap, and file the next blocker. If zero same-window comparable samples, record that honestly
   and use a separate recent historical artifact only for backlog; never put out-of-window txs in Step-1 or
   substitute a non-comparable strategy.
   First run `cd analysis && npm run competitor-calibration` and record its real JSON result. If it fails,
   classify this round `needs_escalation`, retain B/evidence, and file the classifier defect; an uncalibrated
   winner-style tool may not authorize a merge.
   The per-take bridge is `/opt/MEV/scripts/census-gap.sh <from> <to> <watchlist> <out-dir>
   --blockscan-log <log>` on the node; preserve its `verdicts.tsv` plus postmortem JSON as the external axis.
2. **Agent-manual first:** inspect local A→B causality plus B→mature-searcher production gap against the
   predeclared semantic criterion; record author, `win|lose|inconclusive`, and evidence before viewing the
   canonical A/B script assessment.
3. Run `npm run ab-canary-compare` on paired A/B blocks; capture its real exit status and JSON artifact.
   Its result is only `supports|contradicts|inconclusive`, never a merge decision.
4. Reconcile. A capability win always gets one fresh non-author adversarial reviewer. Also invoke one on any
   disagreement/inconclusive result or suspected honeypot/phantom/inventory artifact. A metric may worsen
   while the change correctly removes a false-positive; the reviewer judges causality, not threshold votes.
5. If review remains inconclusive/unavailable, verdict=`needs_escalation`, branch=`retained`; proceed to close.
6. Run `npm run ab-canary-gate -- <report> --phase decision`. A failed hard gate vetoes win and becomes
   `needs_escalation`; it never asks the user.

## 5. Close without stalling
1. Run node `deploy-ab-challenger.sh close <id> <win|lose|needs_escalation>`.
2. **win:** verify `origin/main` still equals tested base; otherwise retain/retest in a later new experiment.
   Merge the exact frozen `challenger_commit` with `--no-ff` (not the branch's later report tip), add the
   final redacted report in a separate main-side docs commit, push main, deploy A through guarded
   `deploy-node.sh`, update `merge_commit`, then run `ab-canary-gate --phase decision --authorize-cleanup`;
   delete local+remote `ab/*`; mark `merged_deleted`.
3. **lose:** copy and commit the final redacted report alone to `main`, run decision gate with
   `--authorize-cleanup`, archive evidence, delete local+remote `ab/*`, mark `deleted_unmerged`, and run the
   close gate against the main copy.
4. **needs_escalation/crash/unfinished:** mark `retained` while unresolved; never merge/delete yet. Record
   exactly what a stronger model must decide. Future hourly wakes skip this problem. Once a later validated
   main commit resolves it, the opening sweep archives its report on main and gate-deletes the old branch.
5. Run `npm run ab-canary-gate -- <report> --phase close`, then `npm run hermes-gate -- <report>`. Commit/push
   report and any Method Trace. Remove `/tmp/mev-workflow-active`. Exit; do not start a second problem.

Transient mechanical failures get one retry. A second failure stops B, retains the branch/evidence as
`needs_escalation`, and closes this wake. The loop advances by the next external hourly invocation.
