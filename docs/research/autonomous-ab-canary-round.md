# Autonomous A/B Canary Round — one unattended hourly wake

> Operator authorization: `docs/live-safety-envelope.md` (2026-07-12 dual-live sub-envelope). This round
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
5. Run `cd analysis && npm run ab-resolution-sweep -- --apply` before selecting new work. A branch closes
   only when a main-committed claim pins its exact old tip and a later main SHA, then the replay frozen in the
   original report flips. The runner archives, gates, and exact-deletes crash-idempotently. Still-unresolved,
   moved, dirty, replay-failing, or unclaimed branches remain retained.
6. With no active B lease, compare deployed A HEAD to `origin/main`. If different, use guarded
   `deploy-node.sh` to sync A and verify the bounded-live block-scan-only posture before choosing base SHA.

## 1. Pick + predeclare
1. Fetch `origin/main`. Read open LearningCases/Findings plus recent A/B reports. Exclude every `problem_id`
   whose latest verdict is `needs_escalation`/retained and every problem already owned by an active branch.
2. Pick the highest-impact remaining blocker only when one real +EV, victim-independent `block-scan` sample
   in the current DEX-DEX / DEX-permissionless-protocol scope proves the failed production stage. Atomic
   backruns, keeper/reward, inventory, private-path, credit, sandwich and JIT-LP samples do not qualify. If
   none exists, make the independent manual judgment, run `tool-index --check`, select current tools by the
   required semantic capabilities into an execution manifest, execute the chosen indexed IDs through
   `tool-run`, and reconcile their machine receipts to discover/file one; if
   the tool is wrong, get fresh non-author agreement, fix/test/rerun it immediately, and merge that auxiliary
   tool commit before cutting B. If there is still no qualifying sample, clean NO-OP.
3. Create `ab/<problem>` from exact deployed A, then before code create
   `docs/research/reports/ab-<experiment_id>-hermes.md` from `templates/hermes-ab-canary.md`; fill the
   schema-v3 `ab_experiment` block with exact base SHA, hypothesis, semantic success criterion, change class,
   complete `production_evidence`, deterministic stage-flip gate, immutable `resolution_replay`, input mode,
   config deltas, and initial
   branch action. `challenger_commit` is pending
   here because a commit cannot contain its own SHA. Commit/push this initial report on B so a crash always
   leaves a durable handoff.

## 2. Implement + deterministic gate
1. Make one causal production behavior change only on the predeclared literal `ab/<problem>` branch.
   Analysis/tooling/governance fixes must already be merged to the base and may not appear in the B diff.
2. Use the HERMES generator/evaluator split. Two stalled generator attempts or three failed review passes
   produce `needs_escalation`; retain/push the branch + evidence and let the next hourly wake pick another.
3. Run the pinned replay/fork gate and require the same real +EV block-scan sample to advance at least one
   production stage from the untouched `sample.block_number - 1` state. The trusted wrapper runs the
   unchanged `searcher:blockscan-hunt` from both base and challenger against the same frozen universe and
   on-chain sample pool IDs; a challenger-authored harness or pre-applied trigger is invalid. A
   performance optimization with no such sample flip is ineligible. Build-only is never
   fixed. Push/freeze the exact code SHA while it is the remote branch tip and deploy it.
   Later branch commits may change only `docs/research/reports/*.md|*.json`; the final report records the
   frozen deployed code SHA as `challenger_commit`, not its own evidence-tip commit. The wrapper reads that
   descendant evidence tip while checking out and deploying the frozen code SHA.

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
1. **External production calibration:** after the independent manual trace, run `tool-index --check`, query
   `classification,calibration` and `competitor-window,classification,block-scan` into execution manifests,
   then run the selected IDs through `tool-run` with the exact measured window and
   recommended coverage set and any justified related cross-check on the same window for coffeebabe
   `0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671` and the standing watchlist. Keep only conserving,
   replicable, victim-independent `block-scan atomic_loop` takes. Exclude backrun, inventory, sandwich,
   keeper, JIT-LP, and standing-credit before gap
   classification. Compare B with those takes, classify the remaining pool/path/adapter/quote/sim/execution/
   economics gap, and file the next blocker. If zero same-window comparable samples, record that honestly
   and use a separate recent historical artifact only for backlog; never put out-of-window txs in Step-1 or
   substitute a non-comparable strategy.
   Record the selected calibration tool's real JSON result. If it fails,
   classify this round `needs_escalation`, retain B/evidence, and file the classifier defect; an uncalibrated
   winner-style tool may not authorize a merge.
   Preserve the selected per-take bridge's verdict table plus deep-transaction JSON as the external axis.
2. **Agent-manual first:** inspect local A→B causality plus B→mature-searcher production gap against the
    predeclared semantic criterion; write author, `win|lose|inconclusive`, evidence, and `written_at` to a
    standalone tracked manual-verdict JSON artifact through `ab-manual-verdict` before viewing any comparison
    assessment. Its write-once seal binds the exact A/B log bytes.
3. Query the generated index for the full evidence-capability union (including `ab,comparison`) into a
   manifest, inspect all related alternatives, and use `tool-run` for enough selected tools to cover the
   query. Pass the sealed manual artifact to the selected comparator; it records the artifact SHA-256, seal
   nonce, exact A/B log hashes, and a later `comparator_started_at`. Capture the real
   paired A/B blocks, and capture its real exit
   status and JSON artifact.
   Its result is only `supports|contradicts|inconclusive`, never a merge decision.
4. Reconcile. A capability win always gets one fresh non-author adversarial reviewer. Also invoke one on any
   disagreement/inconclusive result or suspected honeypot/phantom/inventory artifact. A metric may worsen
   while the change correctly removes a false-positive; the reviewer judges causality, not threshold votes.
5. If review remains inconclusive/unavailable, verdict=`needs_escalation`, branch=`retained`; proceed to close.
6. Run `npm run ab-canary-gate -- <report> --phase decision`. A failed hard gate vetoes win and becomes
   `needs_escalation`; it never asks the user.

## 5. Close without stalling
1. Commit/push the completed report and tracked manual/comparison/Step-1 artifacts on B, with `b_stopped=true`,
   final verdict, and the matching pending action. Then run node
   `deploy-ab-challenger.sh close <id> <win|lose|needs_escalation>`; it rejects report/outcome drift.
2. **win|lose:** run `cd analysis && npm run ab-promotion-close -- <repo-relative-report-path>` from a clean main-based
   checkout. It consumes, but cannot invent, the agent/tool/reviewer verdict. A win exact-merges the frozen
   challenger SHA, archives all decision evidence, gates and deletes the old B branch; a lose archives without merging
   challenger code, then gates and deletes. After a win, guarded-deploy the new `origin/main` as A and run
   `ab-resolution-sweep -- --apply`. The next B deploy is refused until this decisive close is complete.
3. **needs_escalation/crash/unfinished:** mark `retained` while unresolved; never merge/delete yet. Record
   exactly what a stronger model must decide and freeze a self-contained `resolution_replay`. Future hourly
   wakes skip this problem. Once a later validated main commit resolves it, the opening sweep archives its
   report and gate-deletes the old branch.
4. Confirm `ab-promotion-close` ran both A/B and Hermes close gates and that the decisive B ref is gone (or an
   escalation ref remains). Commit/push any Method Trace. Remove `/tmp/mev-workflow-active`. Exit; the next wake
   starts a fresh branch from the promoted champion.

Transient mechanical failures get one retry. A second failure stops B, retains the branch/evidence as
`needs_escalation`, and closes this wake. The loop advances by the next external hourly invocation.
