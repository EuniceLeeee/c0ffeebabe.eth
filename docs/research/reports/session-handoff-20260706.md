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
constructing deposit→swap→redeem loops. **Conclusion: venue coverage does NOT move the needle without the
block-scan/atomic scanner running live over the enriched graph.** The scanner (BS-1a/1b/2/3a) is
OFFLINE-COMPLETE (detect→route→size) but its LIVE integration was never built: `blockscan-lane.ts` does not
exist, `main.ts` never calls the scanner, node flag `SEARCHER_ENABLE_BLOCK_SCAN` is unset, 0 block-scan
activity. So the scanner was NOT brought live — only the venues were. Live scanner = a real workstream
(BS-lane + BS-3 full pipeline scan→sim→standalone-bundle + BS-4 window), not a flag flip.

**CORRECTION (2026-07-06 — a WRONG intermediate conclusion + the real finding, both recorded for honesty):**
First-pass check found 5/6 vault shares have ZERO DEX pools (only srUSDe has 4) and I wrongly concluded they
were "dead edges / coffee inventory." **That was refuted by tracing coffee's actual tx.** coffee is a pure
atomic-arb bot — it would not touch a venue it can't profit from. Tracing `0x9be73297…` (block 24568129, touches
steakUSDC+steakUSDT, 15 contracts, 47 logs) shows the REAL mechanism: **Balancer flash-loan → Morpho Blue
(0xbbbb…) supply/borrow/withdraw ×4 → MetaMorpho vault deposit/redeem across several vaults (steakUSDC/steakUSDT/
0xb8280955/0x4825eff2) → a few DEX swaps (UniV3) → WETH Withdrawal (profit in ETH).** The share is NEVER
DEX-swapped — **the loop closes through CREDIT (Morpho Blue borrow/supply) + vault deposit/redeem.** So the
"share must be DEX-traded" premise was wrong; a vault leg + a credit leg constructs the loop (this is exactly
the `strategy_kind × edge_kind` credit-edge case). **THE OVERLOOKED GAP: we are missing the Morpho Blue CREDIT
edge** (supply/borrow/withdraw/repay). The vault deposit/redeem (ERC4626) is wired, but the credit leg that
closes the loop is not in the system. So the vaults are NOT dead — they are legs awaiting the Morpho credit
edge + the block-scan scanner to construct the loop. **`0x9be73297…` QUANTIFIED (archive receipt, 2026-07-06):** Balancer flash **326,058 USDC** → Morpho Blue
(4 events) + MetaMorpho vaults → executor net **+0.001551 WETH ≈ $4.65 GROSS** (only token delta; USDC/USDT
net ~0), gasUsed 1.67M, minus builder/gas ⇒ **~$1 NET = DUST.** So the mechanism is confirmed (Morpho credit
is the missing edge) but the EV is coffee's known **dust ceiling** (memory `project-atomic-backrun-market-ceiling`:
coffeebabe ~$0.64/tx, ~$23/2.5h). **This DOWNGRADES the finding: not a big +EV unlock — a confirmed-but-dust
atomic-arb class.** The real question is ROI/posture, not capability: building Morpho-credit-edge + block-scan
lane + BS-3 + BS-4 to capture ~$1/tx dust hits the SAME "atomic = market ceiling" wall the project keeps
finding. Decide on that basis. (6 vault example txs: steakUSDC/steakUSDT `0x9be73297`, srUSDe `0xd63b56ca`,
sfrxETH `0xf4774e11`, waEthUSDT `0x33e4e9bc`, waEthUSDC `0x8ca222f1`.)

## 5. Open threads / suggested next steps (priority order)
1. **DONE 2026-07-06: `0x9be73297…` + all 6 vault txs quantified** via the NEW `tx-profit` CLI
   (`analysis/src/cli/tx-profit.ts`, reuses `pnl/arb-profit.ts` `priceArb` — builder-payment-aware; the
   earlier $4.65 hand-decode was WRONG, missed builder payment). NET profits: 0x9be73297 (steakUSDC+USDT)
   $2.23, 0x8ca222f1 (waEthUSDC) $2.44, 0x33e4e9bc (waEthUSDT) $0.36, 0xf4774e11 (sfrxETH) $0.21, 0xd63b56ca
   (srUSDe) $0.15 — **all DUST**. Confirms the ceiling; the ROI verdict in §4 stands.
2. **Add the Morpho Blue CREDIT edge** (supply/borrow/withdraw/repay on 0xbbbbBBBBbb…) — the missing leg that
   closes the vault loop. credit-edge (`edge_kind:"credit"`) case, D2/D5; Fluid credit is the template.
   (Dust EV — do only if pursuing the atomic-arb class with eyes open.)
3. **Block-scan scanner live** (BS-lane + BS-3 full pipeline + BS-4) over vault+credit+swap edges — the whole
   workstream, not a flag. **COORDINATION RESOLVED (2026-07-06):** the concurrent session shipped BS-1c
   (`0a1984c`, scanner prices protocol edges) + `searcher:blockscan-hunt` (`f48c371`, committed) and MEASURED
   it — 4 live blocks fork-solved = **ZERO +EV protocol/vault ring, only sub-cent pure-DEX dust** (decision-log
   F-007, `docs/analysis/20260706-protocol-edge-return-venue-gap.md`). Verdict: the DEX-NAV protocol class is
   empty and the Morpho-credit vault class is dust (§ above). **Do NOT wire the live block-scan lane to chase
   the protocol/vault class** — it is dust-bounded; the lever is posture/ROI, not the scanner.
4. **Adapter LINEAGE — classification inherited by behavior, code split by protocol (operator design
   2026-07-06; supersedes both the topic-heuristic AND my earlier "static edgeKind on 31 / giant family
   adapter" framings).** Principle: *代码按协议拆,能力按行为继承* — adapter files may proliferate, the
   classification vocabulary must NOT fragment. Rules:
   - **Classification vocab is fixed + reused**: `edgeKind` ∈ {swap, credit, protocol, lp, flash} +
     `protocolAction` ∈ {convert, wrap, redeem, mint, unwrap, stake, unstake} + (formalize) `creditAction` ∈
     {borrow, repay, supply, withdraw}. A new venue NEVER gets a new `*-kind`; it maps to an existing behavior
     class or (rarely) adds a behavior class — never a per-protocol kind like `susds-kind`.
   - **New adapter = derived, never from-scratch**: before adding an adapter, PROBE the venue with existing
     adapters (ERC4626: `asset()`+`previewRedeem`; wstETH: `getStETHByWstETH`; Curve: `coins()/get_dy`;
     Morpho: its interface). The one that adapts it fixes the classification (edgeKind+action) AND is the
     lineage base to copy/thin-wrap.
   - **Each adapter carries a `lineage` header**: `derivedFrom`, `reuses` (probe/quote/build fns), `custom`
     (the diffs — asset token, decimals, gas, maxRedeem, special reverts, fee), and *why not just the base*.
   - **Split-vs-config (Claude's added judgment, operator-agreed): don't make N identical files.** NO
     behavioral diff (pure ERC4626, only asset/decimals differ) → a **POOL_REGISTRY config row on the lineage
     base adapter** (exactly the current 6 vaults — keep it, it is more DRY than 6 identical `*.ts`). A real
     behavioral diff → a derived adapter file + lineage header. Lineage metadata attaches to BOTH.
   - Net: classification == routability (the adapter that classifies it routes it), stable analysis language
     across planner / LearningCase / venue-discovery / gap-report, and no redundant files.
5. Wiring-filter note: coffee-touch-frequency IS a valid signal (coffee only touches what it arbs) — the
   earlier "require DEX-traded share" filter was WRONG; the real requirement is a loop-closing leg exists
   (DEX swap OR credit OR another vault). Keep the 6 vault rows.
6. **Discipline: TOOL-FIRST (CLAUDE.md §5, names `analysis/src/pnl/*`).** This session hand-rolled a profit
   decode instead of using `arb-profit.ts` — a rule violation, now corrected by `tx-profit`. Check the
   toolset before hand-writing analysis.
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
