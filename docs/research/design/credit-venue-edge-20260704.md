# Design decision — credit-venue edge (lending markets as swap-like in→out edges)

> Scope: authorized, defensive on-chain arbitrage research. Architecture decision record — no code
> shipped here. Three-way review (Fable-1 skeptic-framed, Fable-2 design-confirm, orchestrator synthesis)
> of the operator's proposal to model Fluid/Aave/Euler lending markets as unified `in→out` edges so that a
> collateral depeg becomes a routable venue. Reference case: tx
> `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` (block 24710788).

## Verdict: the design is SOUND — build it as a unified in→out **credit edge**, with the guardrails below.
The core mechanic is a **faithful generalization of what we already shipped**: our one wired Fluid vault
is already a `slotKind:"lend"` edge whose plan-builder emits `nftId:0` (fresh position) + deposit + borrow
with **no close action** — i.e. abandon-exit + fresh-position isolation are already the de-facto semantics
of the replay-validated wstUSR arb. We are naming the architecture we have, then generalizing it.

## THREE exit models (not two) — which one the simple edge can hold
The apparent contradiction between "closed atomic captures nothing" and "closing on recovery is
profitable" dissolves once you separate the close TIMING:

| model | close | profit | what it is | simple in→out edge holds? |
|---|---|---|---|---|
| 1. same-tx open+close | in the SAME atomic tx | **0** | crosses the same DEX price both ways → gap cancels | n/a (no arb) |
| 2. **abandon** (reference did this at open) | never | **+loop surplus to you, financed by protocol bad debt** | you walk away from an underwater position; your gain = the protocol's loss | **YES** |
| 3. **hold + close on recovery** | a LATER tx, after C re-pegs | loop surplus **+ recovery equity** | a LEVERAGED DIRECTIONAL bet that C re-pegs | **NO** |

**The subtlety that decides the design:** at open, the loop surplus (reference: ~273 wstUSR) is NOT yet
net profit — it is offset by the freshly-opened position's NEGATIVE market equity (collateral market value
< debt during the depeg). That surplus becomes real ONLY by (2) abandoning — the negative equity becomes
the PROTOCOL's loss (bad debt), so from your wallet the token-delta is exactly +surplus — OR by (3)
holding until C recovers and the negative equity flips positive, capturing the recovery too but as a
directional bet with price risk + committed capital across ≥2 txs.

Consequence for the operator's design:
- **Model 2 (abandon) → the simple in→out edge + unified token-delta PnL is CORRECT and clean** (deposited
  collateral is genuinely spent). This is the model to build.
- **Model 3 (close-on-recovery) → the simple edge does NOT hold**: unified token-delta would book the
  unrealized open surplus as realized and hide the directional/price risk; it needs residual-position
  accounting + price-risk management — a separate leveraged-recovery strategy class, not a swap edge.

Corroboration: the reference position (NFTs 16398/16399) was CLOSED ~51 days later by a DIFFERENT party —
consistent with the original bot taking model-2 immediate surplus and walking away, while the residual
recovery value (model 3) was captured later by whoever closed it. Fable-1's "closed atomic = nothing" was
about model 1; the operator's "there is profit on close" is model 3 — both correct, different timings.

## The one thing that makes the whole design work (all three converged, UNDER MODEL 2)
**Under abandon-exit, unified token-delta PnL is EXACT, not an approximation — because the flash loop
physically realizes the market price in-tx.** To repay the flash-borrowed collateral C you MUST re-buy C
on DEXes at market; so "collateral spent at market value" is the actual execution price of the buy-back
leg, not a valuation model that could drift. The profit `borrow_value − collateral_market_value − costs`
is realized in-kind before the tx ends. This directly answers the worry "does unified PnL mis-count
borrowed money as profit?" — NO, provided the position is abandoned (never closed). And the credit edge's
quote (`maxBorrow = LTV · oracle_price · amountIn`) is exactly the collateral's **abandonment value**: it
beats a direct C→A DEX swap **iff the depeg is deeper than `(1 − LTV)`** — precisely the condition under
which abandoning is economically rational. So planner quote-competition auto-selects the credit edge only
when abandon is the right exit; **the planner needs zero risk logic.**

## Where the two reviews converged (the substance)
- Abandon (leave the position open) is the ONLY profitable form. A fully-closed atomic round-trip captures
  NOTHING — closing crosses the same DEX price both ways in one tx, so the oracle-vs-market gap cancels and
  you net your deposit back minus fees (Fable-1 arithmetic proof; Fable-2 confirmed via the flash mechanic).
- The reference tx LEAVES an open leveraged position (Fable-1 verified: Fluid position NFTs 16398/16399
  held ~51 days on the bot, later transferred and closed by a different party; only the Morpho flash was
  repaid in-tx). Profit was financed by abandoned debt against left-behind collateral.
- Isolation is MANDATORY and is per **credit-leg instance**, not per opportunity. It is BOTH risk-fencing
  AND a quote-purity requirement (a fresh empty account makes `quote()` depend only on venue/oracle/LTV
  state, not executor state) AND avoids the deposit-absorption trap (depositing into an account that holds
  an abandoned underwater position instantly backs the old debt — "the difference between a quote and a
  donation"). Fluid gives per-leg isolation free via `nftId`; Euler via sub-accounts; Aave needs a fresh
  disposable account per leg (and e-mode is account-global on Aave — one account can't serve an e-mode and
  a non-e-mode leg).
- The quote is NOT a v3/curve-style zero-RPC local math — it needs resolver/config reads (Fluid
  `VaultResolver.getVaultEntireData`; Aave `AaveOracle.getAssetPrice` + `Pool.getReserveData` bitmask +
  `getEModeCategoryData`; Euler `LTVBorrow` + oracle router). Today's `quoteFluidVault()` even throws and
  the solver searches `fluidDebtBps` as a GSS dimension; the operator's design correctly DELETES that
  search by computing max-safe borrow deterministically (out-per-in is linear in amountIn under
  abandonment, so debt-sizing is degenerate) — but recognize this as a **solver-contract change**, with a
  haircut ε below max-LTV (the 9999-bps precedent) so rounding / interest-index ticks don't revert the sim.
- It fires only on a real oracle-vs-market divergence — a **rare, large tail venue**, not per-block. A
  permanently-inserted edge is dead weight between depegs and can emit spurious "favorable" rates from
  oracle noise → insert the edge on a depeg signal (vault-oracle vs DEX-mid spread > threshold), or at
  least give it a score class so a pinned credit backbone doesn't regrow the path-explosion.

## The genuine open question (the reviews' only real divergence) — a policy/legitimacy call, not a bug
The profit is the lending **protocol's future bad debt** (LPs / liquidators absorb the abandoned
underwater position), not a DEX counterparty's loss. MECHANICALLY the posture holds (Fable-2): principal is
flash-borrowed and atomically protected, the isolated account holds only an ≈zero-market-equity abandoned
position (never funds), borrow proceeds are swept into the loop in-tx, BotVM keeps no standing balance — so
it fits the bounded-live envelope with a kill-switch. But the EXTRACTION CLASS differs from DEX arb
(Fable-1). Whether to run it is the operator's judgment, gated by `SEARCHER_ENABLE_CREDIT_EDGES` (default
off). This is not resolved by architecture; it is a deliberate decision to record.

## Architecture (agreed)
- **Unified edge, thin `kind` tag** — `VenueEdge { kind:"swap"|"credit"; tokenIn; tokenOut; quote(amountIn)
  →amountOut; build(amountIn,minOut)→Action[] }`. No Venue class hierarchy — the adapter registry
  (quoter/plan-builder/ActionAdapter dispatch + `capability.ts`) already IS the polymorphism; `kind` just
  drives policy lookups (enable flag, gas table, failure taxonomy, risk gates) from ONE table.
- Edge **identity must be venue-complete**: Aave is a shared-target venue (one Pool, many reserves — like
  the v4 singleton) → credit edges on shared targets need a `marketId`/mode discriminator (as v4 uses
  `poolId`) so `sameDirectedEdge`/dedup work.
- **Abandon enforced by capability-absence**: no repay/withdraw/close action exists in the credit adapter's
  build vocabulary or the ActionAdapter registry (already true for fluid). Position booked at ZERO value at
  open; any later harvest of a reverted depeg is a SEPARATE, human-gated operation with its own PnL, never
  retro-credited to the edge.
- **Scope of the edge abstraction**: it covers every ATOMIC `in→out` state transition — credit (proven),
  LP-token entry, wrap/unwrap, PSM. It does NOT cover temporal-structure strategies (JIT-LP, sandwich
  brackets, cross-block inventory) — those are bundle-SHAPE strategies above the planner; do not force them
  into the edge.

## Must-haves before any live credit edge (converged checklist)
1. Abandon enforced (no close action) + fresh isolated account per credit-leg + position booked at zero.
2. Deterministic max-safe-borrow quote (delete the `fluidDebtBps` search) + haircut ε; resolver reads per
   protocol; feasibility drop (caps/liquidity/frozen/mode-settable) BEFORE the sim.
3. **Per-adapter gas table — NOT optional.** A credit leg is 250–400k+ gas vs ~100k for a swap; with sims
   currently at `gas_estimate=0`, credit edges will systematically OVER-rank exactly in the dust regime we
   are fighting. `kind` is the hook for the gas table.
4. **Profit token valued at executable MARKET price** in the EV gate (the reference kept the depegged asset
   itself — valuing it at peg/oracle overstates profit exactly when this edge fires).
5. Depeg-signal-gated insertion (or a score class) so the pinned credit backbone doesn't regrow path
   explosion; TTL/decay must know credit opportunities die on ORACLE-KEEPER updates (a different race than
   swaps, which decay on someone else's swap).
6. Failure taxonomy into `pipeline_dropped`: `credit_infeasible` / `emode_required` (`mode_setup_failed`) /
   `credit_stale_oracle`.
7. `SEARCHER_ENABLE_CREDIT_EDGES=0/1` kill-switch; default off; live use behind the policy decision above.

## Recommended path (Fable-1 caution + Fable-2 confirmation reconciled)
Do NOT bolt it onto atomic-v1 as an always-on venue. Run it as an **epic, `strategy_shape: credit-edge`**,
ordered: (i) analysis identifies a credit edge (`0xf88b…` → `wstUSR collateral → USDC borrow via Fluid`);
(ii) replay fixture: adding the Fluid credit edge flips `candidate_plans 0→>0` on the reference case (the
rule-12 gate); (iii) the deterministic quote + per-adapter gas table + market-priced profit; (iv) generalize
to Aave/Euler + e-mode behind the resolver-quote adapter; (v) the policy/legitimacy decision + kill-switch
before any live enablement. The edge abstraction is right; the risk lives entirely in the adapter + the
enable gate, not the planner.

## Reviewer file anchors
`token-graph.ts` (registry + edge emission, POOL_REGISTRY ~104-113, `slotKind`), `quoter.ts:358`
(`quoteFluidVault` throws "requires solver debt search"), `amount-propagation.ts:123`
(`quoteFluidDebtBySearchBps`), `solver.ts` (`fluidDebtBps` GSS dimension), `plan-builder.ts:163-177`
(`nftId:0` open, no close), `src/FlashArb.sol:185` (`_depositAndBorrow`).
