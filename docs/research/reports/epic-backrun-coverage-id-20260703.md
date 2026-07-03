# Epic — Backrun coverage-identification (2026-07-03, user decision)

> Decision (user, 2026-07-03): do NOT build no-victim arb now. Build the capability to IDENTIFY
> what venue/pool/adapter competitors use that we don't support — it directly serves BACKRUN (the
> mission: study who wins, classify OUR gap = pool/path/venue) and leaves the architecture seam for
> standing-cycle arb later. Focus stays on making backrun good.

## Priority (ordered)
1. **venue-gap classifier** — for any competitor tx, auto-say: is our gap a `venue_class` (missing DEX),
   `pool` (venue supported, pool not in graph), `execution_adapter` (venue identifiable+graphable, no
   quote/build adapter), `detection` (fully covered, opp not detected/routed), or `unknown`. Directly
   serves the north-star (see who wins → classify our gap).
2. **V2-fork factory/behavior discovery + bit-exact quote gate** — RigelSwap/DIFX etc.: if confirmed
   standard xy=k V2-fork, reuse existing `univ2` quote/build. Immediately strengthens BACKRUN (victim
   hits these fork pools → we can close). Bit-exact quote vs on-chain is the gate.
3. **competitor-path → pool force-include candidates** — pools seen in competitor reports that belong to
   an ALREADY-supported adapter → auto-generate force-include/pinned candidates. Production-shaped: fill
   who-earns venues, not a market-wide scan.
4. **lightweight venue capability registry** — a capability table both analysis + searcher read:
   `{venue, discoverable, quotable, buildable, supported_in_prod}`. Stops reports mis-saying "pool gap"
   — lets them say "venue supported but pool not in graph" vs "venue class unsupported". (Coupled with #1.)
5. **archive 0x4db34b5c as a future standing-cycle fixture** — pin as a known unsupported-strategy
   competitor path; regression basis IF we later add SmarDex/OUSD/Enzyme. Not run now.

## Architecture seam (design now, implement later)
`Opportunity` becomes an extensible union — `type Opportunity = BackrunOpportunity | StandingCycleOpportunity`
— but ONLY `BackrunOpportunity` is implemented now. Leave the seam; production focus stays backrun.
Reuse the EXISTING execution `ActionAdapter` registry (listener/src/adapters/registry.ts) — do not
reinvent (Codex 2nd-pass finding: venue knowledge is spread across token-graph adapter map, pool-impact
decoders, path-template lists, not just 3 switches).

## Explicitly NOT now (would pull off the backrun mainline)
standing-cycle detector · no-victim top-of-block scanner · 8-hop full-graph DFS · hardcoded exact-route
replay · full Enzyme/OUSD execution for the dust tx. (Deferred, gated on a census proving the class pays.)

## Slice 1 (this cycle) = #1 + #4 (coupled): capability table + 5-way venue-gap classifier
Gate (rule-12): on tx 0x4db34b5c the per-pool 5-way output matches the hand-trace in
replay-0x4db34b5c-gap-analysis.md (UniV3 0x9a77 + UniV2 0x0de0 → detection_gap; SmarDex/OUSD/Enzyme/
Rigel/DIFX → venue_class_gap).
