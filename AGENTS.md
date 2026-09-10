# MEV Flash Arbitrage — Project Instructions

## 1. Scope

AGENTS.md and CLAUDE.md contain identical canonical instructions; update both together.
Keep them concise. Case evidence, task-specific goals and detailed commands belong outside these files.
Load applicable companions (§6) before acting. Historical documentation is not current implementation
authority. Workflows never expand the active task's authorization.

## 2. Working discipline

- Think before coding: state material assumptions and choose the smallest testable change. Ask about
  necessary out-of-scope choices; within authorized unattended work, decide, record and proceed.
- Preserve unrelated user changes. No speculative frameworks, incidental refactors or unrelated cleanup.
  Never use `rg -rn`/`-rln`: `-r` means replacement.
- Verify remembered claims against current code/data. Work as change → check pairs.
- Build/tests passing means `implemented`, not `fixed`. Use the claim-specific validation in gates.md.
- Derive admission from reverse-verified on-chain identity, not hardcoded pool/factory/adapter allowlists.
  Constants may supply infrastructure identity evidence or provenance, never per-instance admission.
  Mandatory final sim remains fail-closed.

### Decoupling contract

- **Keep the central pipeline protocol-independent.** Main/runtime, coordinators, Graph, enumeration,
  Exact/Solver, and shared simulation/EV code own generic orchestration, search, transport and safety.
  Family IDs may be opaque registry keys, never semantic branch conditions.
- **No protocol special cases in central code:** no named Family/protocol branches, pool/factory address
  checks, protocol ABI/selectors/topics, storage layouts, fee curves or protocol math. Moving such logic
  into a central helper, configuration table or protocol-shaped DTO does not make it decoupled.
- **Family owns protocol meaning:** identity, state decoding, pricing model, amount-sensitive quotes,
  capacity constraints and execution encoding. Shared protocol-math libraries are called by Families,
  not imported by the central pipeline. Infrastructure identity constants stay with their owning module.
- **Separate generic policy from protocol semantics.** Token valuation and gas/amount-reference policies
  belong in reusable protocol-independent modules consuming generic inputs, not protocol state fields.
  Central code passes inputs and consumes results; it does not duplicate these calculations.
- **Keep module contracts stable.** Cache, incremental-search and internal algorithm changes must not
  force unrelated producers or consumers to maintain module-private versions, invalidation signals or
  result branches. Modules own their cache validity and fallback. Lifecycle wiring may be thin and generic;
  readiness must not introduce protocol-specific startup gates or duplicate schedulers.
- **Review the dependency direction.** Adding/changing a Family should touch only its implementation,
  generated catalog artifacts and semantic tests. A genuinely missing universal capability requires an
  explicit generic contract and contract tests, not a one-Family exception. Check imports and delegated
  helpers as well as visible branches; final source/authority, simulation and EV gates remain intact.

## 3. Mission

Build a profitable, position-conserving arbitrage searcher. Study comparable competitor successes to find
pool, path and execution gaps; close real gaps through replay/live evidence.

Production scope: DEX↔DEX or DEX↔permissionless-protocol closed loops. Keeper/reward, inventory, private
paths, credit, sandwich and JIT-LP remain excluded. Production Hermes observes blockscan and public-mempool
backrun; MEV-Share stays off. Backrun requires a real trigger and trusted causal replay. Narrow diagnostics
are not full production acceptance or deployment authority.

## 4. Hard safety rules (never autonomous)

Numbers are load-bearing; never renumber.

1. **Mainnet signing/broadcast require explicit human authorization.** Dated bounded-live authority applies
   only inside its script-enforced node-marker, wallet-cap, EV-gated profitable-sim envelope.
   Real-funds keys, additional funding, higher caps or out-of-envelope broadcast need fresh approval.
   See docs/live-safety-envelope.md; historical authorization is not automatic permission.
2. **Default dry-run:** `SEARCHER_DRY_RUN=1`; change posture only with authorization.
3. Correctness execution tests run on local forks, not mainnet submission.
4. Never expose/commit secrets, credential-bearing RPC URLs, .env or raw logs/JSONL. Use ignored logs/;
   only deliberately redacted review artifacts may enter docs/research/reports/.
5. Scripts default `--broadcast` off and require it explicitly.
6. Use accurate, neutral wording; never disguise actions or evade controls. See docs/agent-style.md.

## 5. Repository and evidence habits

- **Execute checks yourself.** Redact before sharing; preserve public on-chain evidence. Post-run analysis
  starts automatically, using local evidence before RPC. Prefer structured events; `pipeline_dropped`
  owns loss attribution. HERMES defines the no-candidate drill-down.
- **Manual first, tools second.** Independently inspect primary evidence, then query the generated
  `analysis` tool-index by capabilities. Inspect coverage/alternatives; execute selected IDs through
  tool-run on the same window. Record query, successful IDs, manifest path/hash and execution receipts;
  reconcile results. Remembered tools, printed commands, fixture-only/failed/skipped runs or partial
  capability coverage are not execution evidence. Follow reconciliation hooks and HERMES rules 16–17.
- **Tool defects close this round.** A fresh non-author reviewer adjudicates disagreements. Confirmed
  defects require the exact tooling_defect case, fix, regression test and codify_commit before closure.
  Only referenced defects block the round. The narrow legacy-harness exception in gates.md never excuses
  canonical producer/verifier or safety defects.
- **Keep verdicts separate.** adapter_fixed needs the same route-pinned Adapter Replay failure→pass;
  adapter_merge_ready additionally needs conformance and independently proven family_local closure.
  production_gap_fixed requires target-blind natural enumeration, Solver sizing, mandatory final sim and
  production EV across all six stages. Systemic/live-distribution changes require cohort and Hermes A/B
  evidence. No build, single-leg result or missing sample substitutes for these gates.
- **Codex-first delegation.** Use scripts/codex-run.sh for generation/investigation. Read HERMES rule 11
  for watchdog, timeout, output-file checks, fallback and genuine sandbox-limitation exceptions.
  Do not edit global Codex configuration. Non-authors review; approval requires executed checks and
  findings, not agreement. Preserve the three-pass cap.
- **Every .md edit: commit and push in the same turn.** Inspect branch/worktree state; stage only intended
  files. Preserve others' sections and changes; never commit secrets/raw logs.
- **Branch lifecycle.** Family work uses codex/*; a scoped verdict permits only the Family-owned merge,
  not deployment/deletion. Authorized unattended promotion/cleanup applies only to literal ab/* through
  HERMES gates. Start each challenger from current origin/main, never an old challenger.
  Guarded decisive win/lose closes the branch; unresolved work retains evidence/branch. Later resolution
  requires durable main evidence, original validation and the authorized resolution sweep—not raw deletion.
- **Learning capture is manual-triggered only.** When requested, generate session-evidence from the
  transcript, never hidden reasoning; write supported Method Trace fields, leaving unknowns unknown.
  Architecture reviews include the 12-axis matrix. Run method-trace-check and distill-harvest; report
  capture/harvest, tooling-defect disposition and decision-log updates. HERMES-specific handoff
  requirements still apply.

## 6. Load-on-demand map

- Autonomous/live/handoff/A-B: read docs/research/HERMES.md fully; preserve numbered rules 1–17,
  resource caps, follow-up, review and branch-lifecycle gates.
- Deterministic fixes/acceptance: docs/research/gates.md.
- Family implementation/execution semantics: docs/research/design/s1-unified-adapter-family-plugin-architecture.md.
  adapter-family-extension-boundary-and-six-step-acceptance.md is retired.
- Pinned historical batches: docs/research/HISTORICAL-GAP.md.
- One supplied landed transaction: docs/research/tx-gap-analysis-format.md.
- Before reopening settled issues: docs/decision-log.md.
- Broadcast envelope: docs/live-safety-envelope.md.
- Replay / commands / case context: docs/historical-replay.md, docs/dev-commands.md,
  docs/project-context.md.
- Learning outputs / harvested library: docs/analysis/README.md, docs/distill/method-traces.md.
