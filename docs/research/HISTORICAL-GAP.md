# Historical Gap Repair — pinned transactions without a live research window

Use this runbook when a bounded set of landed historical transactions already identifies a plausible
searcher gap. It is the non-live companion to `HERMES.md`: history proves deterministic capability;
Hermes A/B proves changes whose value depends on live opportunity distribution.

## Scope

Only the current production target is admissible:

- scanner source: victim-independent, position-conserving `DEX↔DEX` or
  `DEX↔permissionless protocol` closed atomic loops at standing state;
- backrun source: position-conserving closed atomic loops caused by one real earlier landed swap or
  oracle-update transaction, with boundary / trigger-only / full-prefix causal replay;
- canonical net PnL must be positive.

Exclude inventory, keeper/reward, credit, sandwich, JIT-LP, private paths/vaults and any route that leaves
a standing position. A transaction may execute atomically and still be a backrun; its source is decided by
the causal replay, not by the word `atomic` or by its bundle container.

## Promotion Matrix

| Change | Required evidence | Destination |
|---|---|---|
| analysis tool, classifier, gate | build + regression tests + fresh non-author review | merge directly to `main`; never deploy as B |
| adapter, venue identity, graph, scanner, detector, planner, quote, execution | every pinned +EV sample advances through the trusted replay; then the trusted gate itself runs a >=10 minute dual-lane dry-run smoke | merge exact frozen SHA after smoke |
| flow admission, latency, candidate ranking | pinned replay where applicable, then full Hermes A/B | route to `HERMES.md`; history alone cannot promote |
| build/test only | `implemented_not_validated` | retain; never claim fixed or merge as the repair |

The smoke is not a report-authored receipt. During `promote`, the trusted gate starts the frozen challenger
itself with dry-run forced on, scanner and public-mempool backrun configured on, and MEV-Share off. It measures
wall clock and rejects an early process exit or fatal process output. Challenger-authored log markers do not
prove lane activity and are not promotion predicates; unchanged scanner/backrun replay gates own that
capability proof. It runs from a temporary working directory with no project `.env`; only the
explicitly supplied public BotVM address is admitted. The gate generates a one-run disposable signer and
never reads or passes a production private key; every behavioral setting is fixed by the gate. This runbook
grants no broadcast authority.

A landed backrun transaction is a deterministic causal fixture; the chain cannot prove whether its trigger
was propagated through the public mempool. Historical promotion therefore makes no claim about that past
transaction's propagation. `private_path=false` means the execution route itself is permissionless, not that
the trigger's network provenance was reconstructed. Any change to feed visibility, intake, or source
admission is `flow-admission` and must go to Hermes A/B rather than using this historical gate.

## Workflow

1. **Classify manually first.** Trace every selected transaction and decide scanner vs backrun, DEX-only vs
   DEX+permissionless-protocol, conservation, trigger, and positive net PnL before reading a script verdict.
2. **Reconcile through the generated tool index.** Query capabilities, inspect recommended and related
   tools, execute the selected current tools through `tool-run`, then reconcile. Do not choose diagnostic
   CLIs from memory. Trusted replay/gate runners remain fixed because they validate evidence rather than
   supply the diagnosis.
3. **Repair agreed tooling defects immediately.** If manual analysis and a fresh non-author reviewer agree
   a canonical analyzer is wrong or incomplete, fix it, add a regression, merge it directly to main, and
   rerun the analysis. It is auxiliary work, not the production challenger variable. The same direct-main
   rule applies to the two exact trusted replay gates (`blockscan-hunt.ts`, `backrun-hunt.ts`); it does not
   admit arbitrary listener tests or fixtures.
4. **Audit all old work before branching.** Fetch/prune origin; inventory main, every local ref (heads,
   tags, stash and custom refs), every configured remote's complete ref set, every worktree snapshot, the
   origin-main report/resolution sets, and modified/untracked worktree evidence. Remote-only objects are
   fetched into a temporary audit ref when needed so same-gap reports are inspected rather than skipped.
   Every inventory entry needs an exact fingerprint and an explicit disposition. Inspect actual diffs, SHAs
   and replays. Reuse an existing unmerged fix when it covers the same `gap_id`; do not open a duplicate
   because its branch name differs or because it lacks a report. A reportless ref/worktree whose diff touches
   any candidate runtime path may not be labelled `unrelated`; classify it as reused, superseded or still
   blocking. The trusted inventory command must run
   before branch creation. If that exact branch already exists locally, remotely, or in a worktree, it
   fails closed: inspect that ref, choose a fresh branch name, and keep the old ref visible in the audit.
   The command writes a trusted prepare receipt under the shared Git directory. Its authentication tag is
   computed by root on the node through SSM from `/root/.mev-historical-gap-hmac-v1`; the signing key never
   enters the repository, local user environment or candidate process. Copy its SHA-256 into the report;
   classify/promote reject an inventory printed after the branch appeared or for another gap/base. Candidate
   commands run with an isolated temporary `HOME`, no inherited AWS credential variables and no SSH agent.
   They are also wrapped in a macOS sandbox: only loopback outbound network is allowed, writes are confined to
   the gate-owned temporary directory, and file contents are readable only from the gate-created detached
   worktrees, content-hashed dependency inputs, required system runtimes and the gate-owned universe copy.
   The original repository, other worktrees, logs, shell history, credentials and keychains are therefore not
   candidate-readable even if challenger code prints arbitrary stdout.
   A source marked `reusable` must name a concrete prior commit that is reachable from that inventoried ref,
   absent from the tested base, and present in challenger history. A prose claim of reuse is insufficient.
   This branch-reuse audit applies to searcher behavior gaps. An auxiliary analysis-tool correction goes
   directly through tests/review to main and does not occupy a searcher-gap branch or audit.
5. **Group by root cause.** One gap class gets one branch and may carry multiple transactions. Do not create
   one branch per transaction. Searcher behavior branches are literal `ab/*` so existing lifecycle cleanup
   applies; analysis-only work must not occupy B.
6. **Build one schema-v3 candidate report per sample.** The report's `production_evidence` owns the on-chain
   classification and trusted replay declaration. Both scanner and backrun samples must declare one complete,
   ordered, closed `expected_route`; every edge binds `adapterId`, `slotKind`, `target`, `tokenIn`, `tokenOut`
   and optional `poolId`. The gate checks the ordered swap pool/direction sequence against canonical receipt
   logs and matches the entire interleaved DEX/protocol route against one successful state-changing call trace.
   Every swap must also match the attested production-universe adapter, target, token direction and,
   for factory-backed V2/V3 venues, factory-established identity. Every protocol leg must appear in order in
   the successful state-changing call trace with the selector owned by its declared adapter; its target cannot
   be the winner's private caller/executor, and its input/output tokens must be present in the landed receipt
   flow. The entire route must then match the trusted replay byte-for-byte. Pool membership or a two-pool
   signature alone cannot identify a route. The
   historical report only groups those sample reports and declares the promotion track.
7. **Run the historical gate.** It recomputes scope, checks base/branch/ref inventory and actual diff class,
   reruns repository gates, then invokes the existing `ab-canary-gate --phase candidate` for every sample.
   The old gate executes unchanged `blockscan-hunt` or `backrun-hunt`; a challenger-authored success string
   cannot satisfy it. Runtime-path and added/removed diff signals mechanically route intake, ranking,
   threshold, deadline, budget, concurrency and latency behavior to Hermes even if the report labels it
   `detector` or `planner`.
   Historical promotion uses a conservative deterministic-file allowlist, not semantic keyword guessing.
   Mixed orchestration files that own live discovery, detector admission, scanner ranking, planner/solver
   ordering, or strategy views are always Hermes-routed; a deterministic helper must be isolated from that
   live-distribution layer.
   Per-edge protocol validity and quote/amount-domain guards remain deterministic replay work; cross-opportunity
   intake, ordering, cardinality caps, timing and resource budgets are live-distribution work. The fresh
   non-author review must explicitly attest `live_distribution_verdict=none` before historical promotion.
   That attestation is bound to the exact base SHA, challenger SHA and SHA-256 of the Git patch; prose about
   an earlier diff cannot authorize a later commit. The reviewer must also commit a separate structured,
   hash-bound artifact covering that exact identity and branch-audit digest. Report-authored reviewer prose
   alone cannot promote.
   The production pool-universe snapshot, its top-N, source path, capture time and runtime commit are bound by
   a separate provenance artifact and content hash. The gate independently reads the active champion's
   process environment and hashes that exact content-addressed file through SSM before and after replay/smoke;
   caller-selected paths, top-N values and stale runtime commits are rejected. The gate rejects caller-supplied
   replay RPC/WS URLs: through SSM it reads the active champion's own local-reth HTTP/WS ports and opens
   gate-owned loopback tunnels to those exact ports. Readiness requires the gate-owned Session Manager child to
   report that it opened the exact selected local port, not merely that some local process accepts TCP. It
   records chain ID plus exact winner/trigger receipt and parent-block identities, and requires both tunnels to
   match before and after replay/smoke.
8. **Close by exact SHA.** Freeze executable code at `challenger_commit`; later candidate reports live only
   in a report-only descendant supplied externally as `--artifact-ref`. The report cannot contain its own
   commit SHA (that would be a self-referential Git object). The gate resolves the external ref, requires the
   branch tip to equal it, and compares the local report byte-for-byte with the committed artifact.
   `promote` authorizes an exact no-ff merge of the still-current tested base and frozen challenger, never the
   report descendant. Only after trusted replay and smoke subprocesses finish does the gate create and
   authenticate a durable receipt under the shared Git directory using the same node-root SSM signer. It binds
   the artifact ref, review, diff,
   toolchain, lockfiles, replay reports/manifests, production-universe and trusted-reth attestations, and smoke
   posture/log. Close obtains a second node-root authentication tag that covers `closed_at` and `merge_commit`;
   editing an open receipt into a closed one is invalid. Close rejects unsigned, edited, wrong-track, incomplete or stale receipts and revalidates the
   track-specific evidence instead of trusting report prose.
   The merge commit tree must exactly equal the frozen challenger tree; an `ours` strategy or manual conflict
   resolution cannot close the gap. Commit the final report plus every candidate report, tool manifest, review
   and universe-provenance artifact byte-identically
   on main; then delete the local/remote branch and remove every
   challenger/evidence worktree,
   then run close phase. A promoted gap is not closed and the next gap must not start until close phase passes.
   The inventory command mechanically refuses a new gap while any promotion receipt remains open. A change
   routed to Hermes emits no historical promotion receipt and closes only through the Hermes A/B lifecycle. If any
   condition fails, keep `implemented_not_validated` or route the branch to Hermes. A later fix may close it
   through the existing resolution sweep.

## Commands

For a searcher repair, execute the gate from a clean checkout of current `origin/main`. The report argument
may point into the candidate evidence worktree; `--report-repo-path` binds where those bytes live at the
external artifact ref. `--base-root` and `--challenger-root` are clean detached worktrees at the exact code
SHAs, not the report-tip checkout.

```bash
cd analysis

# Before branch creation; paste refs_sha256 and adjudicated matches into the report.
node --import tsx src/cli/historical-gap-gate.ts --print-ref-inventory \
  --gap-id <gap-id> --branch ab/<gap-id>

# Scope, branch reuse and diff-class check.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase classify \
  --artifact-ref origin/ab/<gap-id> \
  --report-repo-path docs/research/reports/<report>.md

# Promotion. Analysis-only work still supplies exact base/challenger worktrees, but omits universe,
# BotVM, port and smoke arguments. Searcher replay RPC/WS tunnels are gate-owned and accept no CLI override.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase promote \
  --artifact-ref origin/ab/<gap-id> \
  --report-repo-path docs/research/reports/<report>.md \
  --botvm-address "$BOTVM_ADDRESS" \
  --base-root /path/to/base-worktree \
  --challenger-root /path/to/challenger-worktree \
  --universe /path/to/frozen-universe.json \
  --smoke-anvil-port 8655 \
  --smoke-blockscan-anvil-port 8656

# After exact merge, report archive, branch/worktree deletion and push.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase close
```

Trusted promotion uses these direct Node invocations. `npm run historical-gap-gate` is only an interactive
convenience alias and cannot serve as promotion evidence because npm shell configuration can replace a
package script before the gate starts.

Use `docs/research/templates/historical-gap.md`. Raw RPC URLs, keys and unredacted logs remain off Git.
