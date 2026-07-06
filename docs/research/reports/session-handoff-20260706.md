# MEV Searcher — Session Handoff (2026-07-06)

Paste-ready context for a fresh session. Repo `/Users/eunice/src/MEV`. Read `CLAUDE.md` (constitution),
`docs/research/HERMES.md` (runbook, rules 1–17), `docs/research/gates.md` (rule-12 validation).

## 0. TL;DR — where we are RIGHT NOW
- Node (EC2 `i-0ff908dedeec9ebc6`, SSM-only) is **bounded-live broadcasting** on test wallet
  `0xb8578B6…` (≤0.2 ETH cap, `SEARCHER_EV_GATE=1`, `SEARCHER_DRY_RUN=0`), commit `95ec2ff`, up ~16h.
- **Protocol edges are LIVE** behind marker `/opt/MEV/.protocol-edges` (`SEARCHER_ENABLE_PROTOCOL_EDGES=1`):
  PSM, wstETH, sUSDS, wstUSR + 6 coffee-flow ERC4626 vaults = **11 protocol entries** in the graph.
- **16h comparison result (the headline finding):** the 6 new vaults produced **ZERO** activity —
  0 candidates, 0 sims, 0 submits; wallet unchanged (no loss). See §4 — this REFRAMES the effort.

## 1. What this session shipped (all committed + pushed to origin/main)
Generator = Codex (`scripts/codex-run.sh`), evaluator = Claude (non-author, re-ran every gate). Commits:
- **Track A protocol execution** (edges the searcher can route): A0 taxonomy `31bbec5` (slotKind
  "protocol" + protocolAction, leavesStandingPosition **fail-closed**) · A1 PSM fee-aware quote `3933eaa`
  · A2 PSM buyGem build `8b586a0` · A5 wstETH wrap/unwrap `7eac27f` · A3/A4 ERC4626 (sUSDS+wstUSR)
  `4eacc5f`.
- **A6 go-live** `04d10ce`: `.protocol-edges` marker in deploy-node.sh (mirrors `.bribe-all-above-gas`);
  fork-sims passed (wstETH bit-exact, sUSDS bit-exact).
- **Protocol-adapter descriptor framework** (`81fac47`+`950fb50`): adding a protocol venue = ~1 descriptor
  row (encode/quote/build/template from one spec).
- **Venue-discovery pipeline** (`analysis/src/discovery/`): `venue-evidence.ts` (B2 topic classify) →
  `venue-aggregate.ts` (merge, `--store` incremental) → `venue-discovery-bq.ts` CLI (reads BigQuery
  transactions⋈logs export — **CSV / JSON-array / NDJSON auto-detect**) → `venue-registry.ts` (canonical
  library: status + **manually-fixable classification that persists across re-ingest**). Commits `d9e5389`
  `3df4d0a` `2d22571` `e0a223f`.
- **6 ERC4626 vaults wired LIVE** `95ec2ff`: steakUSDC, steakUSDT (Morpho, 17 tx each in coffee flow),
  srUSDe, sfrxETH, waEthUSDT, waEthUSDC — probe-verified + steakUSDC fork-sim (USDC storage-deal) passed.

## 2. Architecture context (how it fits — settled, do NOT re-litigate)
- Authority doc: `docs/research/design/unified-strategy-edge-impl-plan-20260704.md` (v2.2). System =
  `strategy_kind × edge_kind`. strategy_kind ∈ {backrun, block-scan}. edge_kind ∈ {swap, credit, lp,
  flash, protocol}. "atomic" BANNED as a strategy value; credit is a LEG not a strategy.
- **D5 (settled):** every edge returns a shared `EdgeQuote`; protocol/oracle valuation is a CONSTRAINT
  input, never EV; EV = route-level market PnL. The EdgeQuote spine (EQ-1..EQ-4) is NOT yet built — the
  current quoter returns `bigint` amountOut. Protocol legs are lossless in bigint (no positionDeltas), so
  their migration is byte-identical; the real EQ target is CREDIT (the `fluidDebtBps` solver special-case,
  untouched). Protocol legs this session did NOT create a parallel PnL — they dispatch through the one
  `quote()` like swaps.

## 3. Two operator insights adopted this session (both correct)
- **"If the auto-adapter passes, it's protocol"** → classify by CAPABILITY not topic: the adapter-probe
  (`asset()`+`previewRedeem` respond on-chain ⇒ routable ERC4626) beats topic heuristics. Ran it on 52
  candidates → 34 confirmed ERC4626. **OPEN TODO: make the probe the PRIMARY classifier** (topic is the
  cheap pre-filter).
- **"coffee does no JIT, so 'lp' venues are really swap"** → confirmed: the 'lp' topic classifications are
  noise — they're swap pools (uni/curve) or credit (aUSDC/aWETH mis-tagged). The venue-registry's
  manual-override fixes these one line at a time.

## 4. THE KEY FINDING (drives the next session) — venue coverage ≠ capture
16h live, the 6 vaults fired 0 times. Root cause is STRUCTURAL, not "no opportunity": we are **backrun-only**
— we build candidates only from victim swaps we see, and vault-share tokens (steakUSDC etc.) are held, not
DEX-swapped, so the vault edges never enter a plan. Even the more-traded wstETH/sUSDS edges (35 log hits)
produced 0 candidates. coffee captures protocol-leg EV because it runs **atomic block-scan** — proactively
constructing deposit→swap→redeem loops. **Conclusion: venue coverage is now DONE but doesn't move the needle
without the block-scan/atomic scanner running live over the enriched graph.** The scanner (BS-1a/1b/2/3a) is
OFFLINE-COMPLETE (detect→route→size) but was EPIC-blocked on a viable +EV exemplar — the newly-wired vaults
are exactly the missing substrate for that scanner to find loops. **Next lever = block-scan, not more venues.**

## 5. Open threads / suggested next steps (priority order)
1. **Block-scan scanner live** over the enriched graph (BS-3 full pipeline: scan→sim→standalone bundle).
   This is the real needle-mover per §4. Needs a live-viable +EV exemplar; the vaults may supply it.
2. **Adapter-probe as primary classifier** (§3) — replace topic heuristic; feeds the venue-registry.
3. **More vaults** — 28 more probe-passing ERC4626 vaults found; wire the loop-closable ones (1 row each).
   But per §4, low value until the scanner can originate loops through them.
4. Deferred tail (unchanged, gated): CR-5 Fluid deterministic quote (archive-gated), Aave/Morpho credit
   (`.credit-live` human gate — DO NOT create it), CS-min/CS-full/D/CR-8.

## 6. Safety rules (load-bearing — never violate)
- **Broadcast = human gate.** Bounded-live envelope is authorized; anything beyond (fund wallet > cap, raise
  cap, real-funds key, broadcast outside envelope) needs fresh human OK.
- **NEVER create `/opt/MEV/.credit-live`** — authorizes standing-position (Aave/credit) submits; separate gate.
- Deploy only via `git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash` (broadcast-safe,
  mode-preserving). Verify banner mode + commit after. Never restart the searcher by hand.
- Disable protocol edges: `rm /opt/MEV/.protocol-edges` + redeploy.
- **NEVER `rg -rn`/`-rln`** (`-r`=--replace, corrupts reads).

## 7. Where to look
- Live state: node commit `95ec2ff`, `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl`.
- Memory: `~/.claude/projects/-Users-eunice-src-MEV/memory/project-track-a-b-protocol-edges.md` (this arc).
- Plan authority: `docs/research/design/unified-strategy-edge-impl-plan-20260704.md`.
- Runbook: `docs/research/design/protocol-edges-operator-runbook-20260705.md`.
- Venue library (616 venues, 2 coffee windows): regenerate via `analysis && npm run venue-discovery-bq --
  --input <BigQuery export> --store <lib.json>`; the BigQuery query needs a LOGS JOIN (tx metadata alone
  can't classify — one row per log: tx_hash, from_address, executor, log_index, log_address, topics).
