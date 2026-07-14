# A/B Resolution Claims

Retained `ab/*` branches are deleted only after a later commit on `origin/main` re-runs the old pinned
replay successfully. Add one `<problem_id>.json` claim after the later fix is merged:

```json
{
  "schema_version": 1,
  "problem_id": "<same stable problem_id as the retained report>",
  "branch": "ab/<retained-branch>",
  "report_path": "docs/research/reports/ab-<id>-hermes.md",
  "retained_branch_tip": "<exact 40-char remote branch tip recorded when retained>",
  "resolved_by_commit": "<40-char origin/main ancestor>",
  "evidence": "<what changed and why the old report replay should now flip>"
}
```

The replay command is deliberately **not** claim-controlled. The original retained report must already
contain `resolution_replay {cwd, argv, timeout_seconds, expected_transition}`; the runner executes that old
pinned command directly without a shell in a detached worktree at `resolved_by_commit`. It never accepts a
claim-authored no-op.

`--apply` pins `origin/main` and the exact retained branch tip, requires the unchanged replay to fail at the
old base and exit 0 at `resolved_by_commit`, archives the report, invokes the A/B cleanup gate, then deletes
the remote branch with an exact force-with-lease. It
is crash-idempotent after report archival or branch deletion. A missing claim/report, failed replay,
branch-tip drift, dirty worktree, moved `origin/main`, or gate failure retains the branch.
