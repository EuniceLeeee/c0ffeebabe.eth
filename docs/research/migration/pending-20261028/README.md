# Blocked declarative JSON (pending framework fix)

`wsteth.json` and `rocksolid.json` are complete, in-memory-validated v2 definitions for static
protocol families (no dynamic `candidateSources` in their hand-written TS discovery).

Blocker: `declarative-discovery.ts` always projects `candidateSources` (even `[]`), while
`adapter-family-plugin.ts` rejects an empty array. The faithful JSON encoding is `"candidateSources": []`,
which makes the generated production entry throw at import.

Proposed minimal compatibility fix (not applied in this workspace; public TS changes are out of scope):
in `declarative-discovery.ts` project the field only when non-empty (legacy `~:65`, mapped `~:212`).

Affected families (15 of 23 with discovery.ts): badger, curve-lp, few-wrapped, goldx,
metronome-hgusdc, metronome-synth, peapods, psm, psv, rocksolid, set-redemption,
staked-usdat, token-conversion, wsteth, yearn-auction.
