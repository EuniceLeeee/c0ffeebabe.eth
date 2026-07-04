# MEV-Share hash-only backrun — finalized verdict + rule-12 plan

> Authorized defensive on-chain arbitrage research. Mainnet reth + bounded-live searcher;
> reads public chain data; broadcast is a hard human-gated step. Neutral framing (Safety Rule 6).

Fresh independent analyst finalization. Node `i-0ff908dedeec9ebc6` is **BOUNDED-LIVE right now**
(`SEARCHER_DRY_RUN=0` + `/opt/MEV/.deploy-live` present) — all work below is read-only; **no deploy /
restart was performed**, and none is in this plan until a human window.

## Facts re-verified from primary sources (not the summary)

| Claim | Verified | Evidence |
|---|---|---|
| mev_sendBundle 100% rejected | YES | node `grep -c "backrun not found" /var/log/mev-live.log` = 164; every reject HTTP 200 `{"error":{"code":-32000,"message":"backrun not found"}}` |
| We have NEVER landed / been accepted on mev-share | YES | `bundle_included`=0 and `flashbots-mev-share: ACCEPTED`=0 in log + events jsonl |
| Submits are **exact-overlay** hash-only (not approximate noise) | YES | banner `hashOnlySubmit=gated` ⇒ `allowHashOnlySubmit=false` (`main.ts:419,489`); so only `overlayExact` passes `hashOnlySubmitDecision` (`main.ts:212,1740`). `eventPostImpactSeed` gives exact v2/v3/v4 post-state (`main.ts:2364-2402`). The 3 sampled `bundle_submitted` are real v2/v3/v4 swap paths |
| SSE `hash` is a **double-hash**, not the on-chain tx hash | YES | spec: "Double-hashed transaction hash, or bundle hash"; raw SSE frames captured from node show top-level `hash` + `txs[]` with **no** `hash` field. `extractTxHashes` (`main.ts:3214`) only pulls the top-level hash ⇒ we submit the correct identifier |
| Reverse-scan "80/80 never mined" is methodologically valid | YES | `/tmp/reject_gap.mjs` matches `keccak256(realTxHash)===hint` over blocks ±20 — the correct double-hash inversion; result `landed=0, private=80` |
| 3 fresh rejected victim hashes | never on chain | `eth_getTransactionByHash` on local reth = `null` (consistent w/ double-hash + never-landed) |

Pipeline latency is not the constraint: p50 14ms / p95 170ms, 0.015% > one block (prior, unchallenged).

## OPEN-POINT verdict — why 100% reject even within 170ms: **(c) primary + (b) secondary; (a) REFUTED**

- **(a) stale hints / SSE lag — REFUTED.** If we were merely late, the referenced tx would be
  **on-chain, landed-before-our-target**. `reject_gap.mjs` explicitly separates that bucket
  (`landedBeforeTarget`) from `private/never-mined` and found `landed=0`. The txs are **not on chain at
  all** (±20 blocks) — a timing race cannot produce that. Reducing SSE lag recovers nothing.
- **(b) non-backrunnable event shapes — CONTRIBUTES.** The raw SSE stream carries multi-tx **bundle**
  hints and bare ETH-transfer events (captured: `txs:[{to,fnSel:0x00000000},{to,fnSel:0x00000000}]`
  with the `0xeee…eee` native pseudo-token) — not all events are a single matchable pending swap.
- **(c) the orderflow never becomes a matchable/mined order — PRIMARY + DECISIVE.** The error is a
  **synchronous** `-32000` at submit (not accept-then-non-inclusion). That means the node does not hold
  the referenced hash as an open matchable order at our submit instant, and the reverse-scan confirms
  the underlying orderflow never reaches a block. These are private hints the node emits for
  transparency/refund accounting but that resolve to nothing we can append a backrun to. The "just-hinted
  ⇒ still pending ⇒ matchable" premise behind the 170ms question is simply false for this flow.

**No recoverable slice exists from faster submission.** The only latent value is the independent
~15-20% of hints that do resolve to a mined tx — but that is a **selection** problem (pick landable
hints at admission), not a **speed** problem, and our 81 exact-overlay submits landed on the wrong
~80% (reverse-scan 80/80 never-mined).

## DECISION — MEV-Share hash-only backrun is a POSTURE DEAD-END for our atomic-backrun architecture

Ship the low-risk efficiency fix + a cheap land-rate admission filter to **stop burning sim+submit on
structurally-unmatchable hints**; do **not** invest engineering to "recover" mev_sendBundle as a value
source. Rationale, grounded:
1. Value realized to date on this path = **zero** (ACCEPTED=0, INCLUDED=0, ever).
2. The landable ~15-20% is the **most-contested** orderflow (every searcher with an orderflow
   relationship sees the same hint simultaneously); winning is a bid/latency/relationship auction we
   have never won — consistent with the measured atomic-backrun **market ceiling = dust** on public flow
   (memory `project-atomic-backrun-market-ceiling`, `project-mevshare-flow-discarded`).
3. Whether to change **bid posture** or pursue **orderflow relationships** to contest that slice is a
   human posture decision (Safety Rule 1 territory), **not more code**.

## Ordered rule-12-gated plan

Harnesses already exist — reuse, don't build: `npm run searcher:submit-gate`
(`test/hashonly-submit-gate.ts`), `npm run searcher:victim-source-filter`
(`test/victim-source-filter.ts`).

### Step 1 — efficiency fix: stop auto-submitting hash-only mev_sendBundle (they 100% reject)
- **Change:** `hashOnlySubmitDecision(rawTx, overlayExact, allowApprox)` (`main.ts:212`) currently
  returns `rawTx || overlayExact || allowApprox`. Put the **exact-overlay** hash-only path behind a new
  explicit opt-in `allowHashOnlyMevShareSubmit` (env `SEARCHER_SUBMIT_HASHONLY_MEVSHARE`, **default
  off**), so hash-only mev-share bundles no longer auto-submit. rawTx (mempool) submits are untouched.
  Drop the gated hint at `main.ts:1740` with reason `hash_only_unmatchable` (distinct from the existing
  `hash_only_unverifiable`, which meant fidelity not matchability).
- **Note (corrects the summary's framing):** the *approximate* overlay path the summary targeted is
  **already** gated (`allowHashOnlySubmit=false` by default); the leak is the **exact-overlay** path.
  Fixing only "approximate" would change nothing.
- **rule-12 gate (deterministic flip):** update `hashonly-submit-gate.ts` truth table — the
  "hash-only exact overlay submits" case flips **true→false** under default config; a new opt-in case
  stays true only when the flag is set. `expected_transition: hash-only exact-overlay submit true→false
  (default)`; assert a recorded exact-overlay mev-share fixture yields `bundle_submitted` **1→0**,
  dropped `hash_only_unmatchable`. `npm run searcher:submit-gate` must pass. Sim still runs → fixtures
  still recorded (no measurement loss); only the wasted submit slot + polluted `submitted` metric go away.

### Step 2 — the real lever: land-rate admission filter that KEEPS the landable slice, before sim
- **Gap found in code:** the land-outcome signal (`victimSource.record`, `main.ts:1928`) is fed **only**
  by `enqueuePendingVictimOutcome` (`main.ts:1237-1243`), gated on `submissionMode==="victim-bundle" &&
  rawTx` — i.e. **mempool only**. Hash-only mev-share hints never feed it, and the tracker keys on
  `sender` which private hints usually omit. So the existing `admission/victim_source_low_landrate` gate
  (`main.ts:1230-1236`) is **structurally blind** to mev-share.
- **Design (concrete):**
  1. **Feed hash-only outcomes.** After a hint is processed, enqueue a pending-outcome for hash-only
     hints too, resolved by inverting the double-hash: over the next N blocks, `landed = ∃ tx in block
     with keccak256(txHash)===hintHash` (the `reject_gap.mjs` inversion, promoted into the drain loop).
  2. **Key on an observable, not `sender`.** Private hints hide `from`; key the tracker on the hint's
     **`txs[0].to`** (target contract/router/pool, present in the SSE event) — extend
     `VictimSourceTracker` to accept a generic key. A `to`-address whose recent streak never lands →
     skip at admission (extends the same `shouldSkip` gate), which also **saves the sim cost**, not just
     the submit.
  3. **Keep the good slice.** `shouldSkip` only fires after `minStreak` consecutive **never-land** in
     `windowBlocks`; any key that lands once re-admits (existing recovery semantics, already tested).
     Start in **shadow mode** (emit `victim_source_low_landrate` counterfactually, do not drop) for one
     window to confirm it isn't nuking landable keys, then enable.
- **rule-12 gate:** extend `victim-source-filter.ts` — feed a `to`-keyed sequence of never-land
  outcomes → assert the next hint on that key is dropped `victim_source_low_landrate` at **admission**
  (before sim), and a landed outcome re-admits. `expected_transition: hash-only hint on dead key →
  admission drop (sim not entered), bundle_submitted 1→0`. `npm run searcher:victim-source-filter` passes.

### Step 3 — honest posture escalation (human gate, not code)
Record in the Findings Ledger + report to the human: hash-only mev-share backrun has produced
ACCEPTED=0 / INCLUDED=0; the latent landable ~15-20% is the most-contested orderflow and, consistent
with the measured atomic-backrun dust ceiling, is not competitively winnable at our current
latency/relationship/bid posture. **Do not** spend further engineering on recovering mev_sendBundle.
Any move to contest that slice (bid-posture change, orderflow relationships / direct BuilderNet, MEV-Share
`sim`-first matching) is a **human posture decision** — escalate, do not self-authorize (Safety Rule 1).

## Gates summary
- Steps 1-2 are deterministic searcher-behavior changes → **rule-12 replay flips required** before any
  next window; `implemented` (build passes) is NOT `fixed`.
- Deploy only in a human-opened window: node is bounded-live; **do not restart to land this**.
- `searcher_behavior_change: yes` (Step 1 stops ghost submits; Step 2 changes admission).
