# Adapter LINEAGE architecture — classification separated from implementation (2026-07-06)

> Operator-directed design, validated against **Se7en-Seas/boring-vault**
> (https://github.com/Se7en-Seas/boring-vault — Veda's vault framework; its `DecoderAndSanitizer` pattern
> is the on-chain analog of our adapter/classification layer). Companion review:
> `docs/research/design/boring-vault-adapter-review-20260706.md`.
>
> **Rev 2 (authoritative, 2026-07-06):** every structural claim below re-verified against the code at
> HEAD (`72fbfd9` descriptor layer + later). Stale pointers fixed, this session's F-007 findings folded in,
> known-issues converted to an ordered gated plan, Merkle-authorization point re-adjudicated. Delta summary
> at the end.

## The rule (one line)
**Adapter is the implementation, lineage is the behavior family, edgeKind is the path semantics — the three
are SEPARATE. Code may split per protocol; the classification vocabulary must NOT fragment.** Adapters can
proliferate; taxonomy stays small. Classification is reused, code is protocol-specific.

```
adapterId       // concrete: how to call / build calldata / quote   (uniswap-v3, pancake-v3, sushi-v3)
lineage         // behavior family / reuse class                    (univ3)
edgeKind        // what leg it is in a path                         (swap | credit | protocol | lp | flash)
action          // the specific action (see vocabulary caveat below)
```
So: `PancakeV3 → lineage univ3 → edgeKind swap`; `sUSDS → lineage erc4626 → edgeKind protocol`;
`Fluid → lineage fluid-credit → edgeKind credit`. Never `pancakev3-kind` / `susds-kind` / a new strategy.

**Vocabulary caveat (verified):** there are currently TWO action vocabularies in code —
`ProtocolAction` (7 members, runtime edges: `strategy-taxonomy.ts:10-17`) and `AdapterAction`
(14 members, descriptor table: `adapter-descriptors.ts:8-10`, comment "Do not reuse ProtocolAction") —
with no mapping between them. That is remediation item **R3** below, not a feature.

## Why (what it prevents)
- **No classification explosion**: learning/gap-analysis/planner/venue-discovery keep ONE stable language
  as protocols grow. A competitor using PancakeV3 → we report `adapter=pancake-v3, lineage=univ3,
  edgeKind=swap` = "UniV3-like coverage gap", not a new strategy.
- **Discovery reuses existing adapters**: a new venue is first PROBED against existing lineages (does it
  answer an existing adapter's probe?), reuse the adapter, then protocol-specific micro-adjust — instead
  of "write N new adapters".
- **Analysis ↔ production align**: the same descriptor drives routing, reporting, LearningCase, replay.

## Current state — code-verified inventory (2026-07-06)
All claims checked by reading the files, not the previous draft:
- **31 adapters registered** — `listener/src/adapters/index.ts` registers 27 explicitly + 4 generated from
  `PROTOCOL_LEG_DESCRIPTORS` (wsteth-wrap/unwrap, erc4626-deposit/redeem; `protocol-legs.ts:77-110`).
  `listener/src/shared/adapters/index.ts` is a re-export shim of the same registry. The descriptor test
  pins both counts at 31 (`searcher/test/adapter-descriptors.ts:47-48`).
- **Descriptor layer landed (`72fbfd9`) but UNCONSUMED.** The table + interface live in
  `listener/src/adapters/adapter-descriptors.ts` (interface :12-19, table :26-275); `classifyCall` /
  `assertDescriptorCoverage` in `listener/src/adapters/registry.ts:33-43`. A repo-wide grep finds exactly
  ONE consumer: the test `listener/src/searcher/test/adapter-descriptors.ts` (`npm run
  searcher:adapter-descriptors`, `listener/package.json:75`). No production code imports `classifyCall`,
  `descriptorFor`, or `ADAPTER_DESCRIPTORS`; `assertDescriptorCoverage` has no boot-time caller. All
  descriptor issues below are therefore LATENT, not live.
- **EdgeKind census** (pinned by the test :71-76): swap 16, protocol 8, null 3 (erc20-infra + guard),
  flash 2, credit 2 (`fluid-vault`, `fluid-dex-liquidate`), lp 0.
- **`ActionAdapter` is untouched** (`listener/src/types.ts:120-134`): `id / isWrapper / field2Offset /
  encode / matchTrace` — NO classification fields. Git history of `types.ts` shows no `edgeKind` field was
  ever committed (a concurrent edit in that direction did not survive). This is the design working as
  intended: classification lives ONLY in the descriptor table; the implementation interface stays a pure
  encode/match contract.
- **Runtime edges derive taxonomy in one place**: `TokenEdge.edgeKind`/`leavesStandingPosition` are
  "derived at construction via deriveEdgeTaxonomy... never set independently"
  (`planner/token-graph.ts:23-27`; derivation law `strategy-taxonomy.ts:67-80`).

## The descriptor (machine-readable, separate table keyed by adapterId — "把 lineage 跟 adapter 分开")
As landed (`adapter-descriptors.ts:12-19`):
```ts
interface AdapterDescriptor {
  adapterId: string;
  lineage: Lineage;                 // today (adapter-descriptors.ts:3-5): univ2|univ3|univ4|curve|
                                    //   balancer-flash|morpho-flash|psm|erc4626|wsteth|weth|
                                    //   fluid-credit|fluid-dex|erc20-infra
                                    //   (future when built: morpho-credit|aave-credit|…)
  edgeKind: EdgeKind | null;        // swap|credit|protocol|lp|flash ; null = non-venue infra
  action: AdapterAction;            // descriptor-level vocab; R3 reconciles with ProtocolAction
  canSendValue: boolean;            // univ4-settle-value + weth-deposit-value only (test-pinned)
  leavesStandingPositionDefault: boolean;  // credit → true (fail-closed default; runtime derivation
                                           //   is the source of truth — table comment :21-25)
}
```
`ADAPTER_DESCRIPTORS: Record<adapterId, AdapterDescriptor>` + `classifyCall(target, selector) =
matchCall(...) → descriptorFor(id)` + `assertDescriptorCoverage()` (throws if any registered adapter lacks
a descriptor). The classification table for the current 31 adapters IS the code file
(`adapter-descriptors.ts` — the earlier scratchpad Codex brief is gone; do not reference it).

**Deltas from the original spec (verified):** `quotable`/`buildable` were in the spec but DROPPED from the
landed code — restored as **R4** below (`fluid-dex-swap.encode()` throws "not supported in v3.0",
`fluid-dex.ts:53`, yet its descriptor is indistinguishable from a wired swap). Per-VENUE fields (target,
status, forkSimGate) live in venue-registry, which references adapterId — NOT here; the actual status vocab
is `candidate|known|routable|excluded` (`analysis/src/discovery/venue-registry.ts:7`), not "approved".

## Reuse boring-vault's PROTOCOL KNOWLEDGE — NOT its code (operator directive)
**Explicit: this is NOT "reuse the whole codebase / import their adapters."** boring-vault is a Solidity
on-chain vault; its decoders cannot be a library for our off-chain TS searcher, and we do NOT copy them
wholesale. What we reuse is the **protocol knowledge each decoder encodes** — signatures, which args define
a position, the catalog of protocols. Their per-protocol decoders live under
`src/base/DecodersAndSanitizers/Protocols/` (~50: ERC4626, MorphoBlue, AaveV3, Curve, UniswapV3,
PancakeSwapV3, BalancerV2, Lido, FluidDex, FluidFToken, PendleRouter, Convex, Gearbox, …). Concretely we
reuse:
- **Signatures + position-defining args** for each protocol (their decoder tells us exactly which args
  matter). E.g. `MorphoBlueDecoderAndSanitizer`: supply/withdraw/borrow/repay/supplyCollateral/
  withdrawCollateral, position = `(loanToken, collateralToken, oracle, irm, onBehalf)`, `receiver` is not
  position-defining. → our credit action maps 1:1; `leavesStandingPosition = onBehalf==executor not closed
  in-tx`. Reference it instead of reverse-engineering Morpho from scratch.
- **The Protocols/ list = our integration roadmap + classification reference set** — an unknown venue's
  selectors matched against it → instant lineage + a reference impl. It also enumerates the credit/protocol
  venues we lack (MorphoBlue, Fluid, Aave, Curve, Pendle, Gearbox…).
- **What we still write ourselves** (they don't do it — they're a vault, not a searcher): quote (amountOut
  or EdgeQuote), BotVM calldata encode, fork-sim gate, PnL, LearningCase.
- **Do NOT copy their CODE**: not the Solidity decoders as a library, not the Teller (deposit/withdraw
  flow) or Accountant (share pricing) — vault machinery for standing inventory we do not hold.

### The Merkle-authorization question (adjudicated, 2026-07-06)
The first draft dismissed boring-vault's `ManagerWithMerkleVerification` wholesale ("vault security model,
irrelevant"). Re-evaluated: **that was too flat.** Split the verdict:
- **Teller / Accountant / decoders-as-code: still do-not-copy.** Correct — share accounting and deposit
  flow have no analog in an atomic-flash searcher.
- **The AUTHORIZATION model itself: not irrelevant — a DEFERRED safety-architecture option.** Their model:
  every executed call must prove a Merkle leaf `(decoder, target, valueNonZero, selector, sanitized
  position-defining args)` against an on-chain root, per-strategist trees. That leaf is nearly field-for-field
  our `AdapterDescriptor` (adapterId, target predicate, `canSendValue`, selector, position-defining args) —
  i.e. it is the cryptographically-enforced form of the boundary we currently enforce **off-chain by
  process**: `SEARCHER_DRY_RUN`, the `/opt/MEV/.deploy-live` marker, the wallet cap, the S2
  `leavesStandingPosition` guard. All of those are "trust the env/process", and env-drift has flipped
  `SEARCHER_DRY_RUN` before (decision-log / node-env guard). An on-chain root would mean even a buggy or
  env-drifted searcher can only execute pre-approved action shapes; posture-specific roots (dry-run /
  bounded-live / credit-live) would be a graduated, auditable, on-chain form of Safety Rule 1 and the
  `.credit-live` gate.
- **Why NOT now (honest tradeoff):** (a) reachable EV today is dust-bounded (F-007 class 1) and the blast
  radius is already capped by the 0.2-ETH bounded-live envelope — the enforcement upgrade protects little
  marginal value; (b) it is a substantial Solidity build + audit surface, and per-call Merkle proof
  verification adds gas to every leg of an atomic bundle, which competes directly with thin margins;
  (c) the BotVM executor would need restructuring to route calls through a verifying manager.
- **Revisit triggers (record, don't build):** (1) raising the wallet cap / introducing the real-funds key;
  (2) opening `.credit-live` — a credit leg can leave a standing liability on partial failure, which is
  exactly where a process-trust boundary is weakest and a shape-level on-chain allowlist pays; (3) multiple
  operators/strategists. Until a trigger fires, the descriptor table is the off-chain precursor: keeping it
  accurate (R1–R5) keeps the future Merkle leaf set mechanically derivable from it.

## Adapter correctness — VERIFY against a real on-chain tx log (mandatory per adapter)
A descriptor / signature reference (boring-vault or our own guess) is a HYPOTHESIS until it matches real
chain data. **Every new/derived adapter must be validated against a real competitor tx (the collected
competitor corpus) BEFORE it is trusted — not just against a hand-written unit fixture.** Two checks:
1. **Decode/classify matches the log**: pull the real tx's receipt (`tx-profit`/`bundle-postmortem` already
   fetch it, or `cast receipt`), and for each call the tx made to that protocol, `matchTrace(target,
   selector)` must fire on OUR adapter and `classifyCall` must return the right `{lineage, edgeKind,
   action}`; the emitted logs (topic0 + which addresses) must be consistent with the descriptor's
   position-defining args. (E.g. steakUSDC/steakUSDT in `0x9be73297`: the Morpho Blue calls must classify
   `credit`, the vault deposit/redeem `protocol`.)
2. **Encode reproduces the on-chain calldata**: our `encode()` for that action, given the same params, must
   produce calldata byte-identical to what the real tx sent to the target (selector + args). A mismatch =
   the adapter is wrong, regardless of a green unit test.
This is the same discipline that caught earlier errors (the hand-decoded profit, the "dead edge" premise):
**ground the adapter in a real tx, don't trust the fixture.** Record the reference tx hash in the adapter's
lineage header. First corpus: `0x9be73297` (Morpho + vaults), `0xf88b498b…` (the credit exemplar, below),
plus the per-vault txs in the handoff §5. **Today this rule is prose only — no descriptor field, no gate
enforces it. That is R5.**

## Descriptor remediation plan — ordered, gated (converts the 2026-07-06 review findings)
All issues re-verified at HEAD. They are LATENT (descriptor unconsumed — see inventory above), which is
exactly why the order matters: **`classifyCall` must NOT be wired into venue-discovery / routing / any
production consumer until R1–R5 are done** — the first consumer would inherit every bug below. Each item:
one-line fix + the gate that proves it. Dependency-ordered:

- **R1 — boot-time coverage teeth (independent, one line, do first).**
  `assertDescriptorCoverage()` currently has NO production caller (only the test, `test/adapter-descriptors.ts:43`).
  *Fix:* call it at the end of `adapters/index.ts` after the last `register(...)`.
  *Gate:* process cannot boot with a registered adapter missing a descriptor (delete one descriptor →
  startup throws; the existing test keeps covering the inverse direction).

- **R2 — [MAJOR] kill `matchTrace` target-blindness + selector collisions (blocks R5 and all consumers).**
  Verified: every non-flash `matchTrace` is selector-only — weth (`wrap.ts:16-18,32-34,48-50`), protocol
  legs (`protocol-legs.ts:71-73`), psm (`psm.ts:34-37`), fluid (`fluid-vault.ts:28-30`,
  `fluid-dex.ts:36-38,56-58`), erc20 (`erc20.ts:22-24,39-41`); only morpho/balancer flash target-check
  (`morpho-flash.ts:35-38`, `balancer-flash.ts:48-51`). Consequences: `classifyCall(anyAddr, 0x2e1a7d4d)` →
  weth unwrap; `deposit()` on any addr → `weth-deposit-value`; and `weth-withdraw` vs `weth-withdraw-amount`
  SHARE selector `0x2e1a7d4d`, so registration order (`index.ts:66` before `:67`) makes `matchCall`
  (first-match iteration, `registry.ts:27-30`) permanently shadow the latter.
  *Fix:* target-check `ADDR.WETH` in the three weth `matchTrace`s (pattern: the flash adapters) + a
  registry-level gate asserting no two adapters match the same selector without disjoint target predicates.
  *Gate:* extend `searcher:adapter-descriptors` with negative cases (`classifyCall(nonWeth, 0x2e1a7d4d) ===
  null`) + the collision assertion. NOTE: the current test ENCODES the target-blind behavior (it classifies
  against dummy addresses `0x…01–04`, `test/adapter-descriptors.ts:82-100`) — it must be updated in the
  same commit or it will pin the bug.

- **R3 — [MAJOR] one total action-vocabulary mapping (blocks venue-registry wiring).**
  Verified drift: the `erc4626-deposit` runtime edge carries `protocolAction:"wrap"`
  (`token-graph.ts:330`) while its descriptor says `action:"deposit"` (`adapter-descriptors.ts:223`) — same
  adapter, two words, no mapping. Root cause: `ProtocolAction` (`strategy-taxonomy.ts:10-17`) has no
  `deposit` member, so the runtime picked the nearest standing-safe word. venue-registry stores
  `ProtocolAction[]` (`venue-registry.ts:18`), so wiring `classifyCall` output into it collides today.
  *Fix:* one total `adapterActionToProtocolAction()` next to the table (explicit `deposit→wrap` etc., or
  extend `ProtocolAction` with `deposit` + add it to `STANDING_SAFE_PROTOCOL_ACTIONS` — an ERC4626 deposit
  returns full value in-tx; decide once, in code).
  *Gate:* a test asserting the map is total over `AdapterAction` and that for every venue adapter the
  descriptor's mapped action equals the runtime edge's `protocolAction` (the erc4626-deposit case is the
  regression fixture).

- **R4 — [MAJOR] restore `quotable`/`buildable` (blocks routing consumers).**
  Verified: dropped from the landed interface (`adapter-descriptors.ts:12-19`); `fluid-dex-swap.encode()`
  throws (`fluid-dex.ts:53`) yet its descriptor reads like a wired swap.
  *Fix:* add both fields; `fluid-dex-swap → buildable:false`.
  *Gate:* extend the descriptor test: every `buildable:false` adapter is exactly the set whose `encode`
  is a documented stub; a routing consumer must filter on `buildable` (assert in the consumer's own gate
  when one exists).

- **R5 — [MAJOR] give the "verify vs a real tx log" rule teeth (depends on R2).**
  *Fix:* add `referenceTx?: string` to the descriptor + a zero-RPC committed-calldata fixture gate per
  venue adapter: pinned `(target, selector, calldata)` from the real tx → `matchCall` fires on our adapter,
  `classifyCall` returns the pinned `{lineage, edgeKind, action}` triple, `encode()` reproduces the bytes.
  Fail the gate on any venue adapter (edgeKind ≠ null) with no fixture.
  *Gate:* the fixture suite itself (extends `searcher:adapter-descriptors` or a sibling script). Depends on
  R2 — fixtures must assert CORRECT matching, not today's target-blind matching.

- **WIRE-GATE:** only after R1–R5 are green may `classifyCall` gain its first production consumer
  (venue-discovery cross-reference is the intended first one). Enforce in review, and note it in the
  consumer's PR description.

Minor tail (real, but not consumer-blocking — schedule opportunistically):
- **[MINOR] 6/31 descriptors unreachable via `classifyCall`** — univ4-swap/take/sync/settle/settle-value
  return `matchTrace → false` (`univ4.ts:90-92,111,126,140,154` — "matched via parent unlock, not
  standalone") and assert-balance likewise (`assert-balance.ts:15-17`); only top-level `unlock`
  (`0x48c89491`, `univ4.ts:62-64`) classifies. This is INTENTIONAL tree-structure (leaves live inside the
  unlock callback), but `classifyCall` callers must know classification is top-level-call-only for v4.
  *Fix:* document on the six descriptors (or add an `innerOnly:true` field) rather than inventing selectors.
- **[MINOR] polymorphic-selector actions are statically wrong**: `fluid-vault.operate`
  (`0x032d2276`) is sign-polymorphic (borrow/repay/supply/withdraw) but labeled `borrow`
  (`adapter-descriptors.ts:207`); `fluid-dex-liquidate` labeled `repay` is really a liquidation. `action`
  is a REPRESENTATIVE label for polymorphic selectors — the true action needs arg decoding (boring-vault
  review learning 3). This is credit-adapter work (deferred with it); until then the table comment should
  say "representative".
- **[MINOR] venue-registry coupling**: `adapterHint?` is unvalidated freetext (`venue-registry.ts:22`; the
  file imports nothing from `adapter-descriptors.ts`). *Fix (with the WIRE-GATE work, not before):* validate
  `adapterHint ∈ ADAPTER_DESCRIPTORS` in the venue-registry gate. Status vocab in this doc is now aligned to
  the code (`candidate|known|routable|excluded`).

## Adding a new venue — the workflow
```
scan/discover venue
 → PROBE against existing lineages (ERC4626: asset()+previewRedeem; univ3: token0/token1; morpho: iface; curve: coins/get_dy)
 → matches a lineage?
     yes → reuse that adapter; classification = the lineage's (edgeKind/action); if a behavioral quirk
           (custom revert/maxRedeem/decimals/fee), derive a thin protocol-specific adapter WITH a lineage
           header (derivedFrom / reuses / custom / why-not-base); if NO quirk, just a venue-registry row on
           the base adapter (today's 6 vaults — do NOT make identical files).
     no  → genuinely new behavior: new lineage + (rarely) a new edgeKind/action. Reference boring-vault's
           decoder for that protocol first.
 → either way: R5 fixture (real-tx classify + encode round-trip) before the venue can be `routable`.
```

## credit vs protocol-convert — a STRUCTURAL adapter distinction (keep distinct)
Not a strategy call — a shape-of-the-quote fact that determines how a credit adapter is written. F-007
(decision-log) established these are two different CLASSES economically; here is what that means for the
adapter layer:
- **`protocol` convert/wrap/redeem** (PSM, ERC4626, wstETH) → a plain TOKEN DELTA. Quotable as `bigint`
  amountOut today (EdgeQuote later); `leavesStandingPosition=false` per action
  (`strategy-taxonomy.ts:25-32,73-78`). Simple to write — deposit/redeem/wrap are pure conversions. Built
  and live behind `SEARCHER_ENABLE_PROTOCOL_EDGES`. Economically: DEX-NAV dust, even at a depeg block
  (F-007 class 1 — the depeg-block hunt found sub-dollar best).
- **`credit` borrow/supply** (Fluid, Morpho, Aave) → carries a POSITION by nature → the quote must be
  `positionDeltas`/`constraints`, NOT a `bigint` amountOut (D5). Economically: episodic $100–500 during
  market dislocations (F-007 class 2). Never a new strategy — it's a LEG.
- **The TWO-PRICE quote model (why credit is the hard class).** A credit leg's edge is priced by TWO
  independent prices at once: the collateral is valued at the lending protocol's ORACLE price (which tracks
  NAV and stays high through a market depeg), while the same asset is acquired/sold at the DEX MARKET price
  (which is dislocated low). The profit IS that spread. So a proper credit adapter must model
  **borrow-headroom from oracle state** and **the swap legs from market state** as separate inputs — never
  collapse them into a route-mid product. The `fluidDebtBps` grid search
  (`searcher/solver/solver.ts:96-168`) is the crude legacy version: it finds the spread empirically by
  scanning debt fractions through fork quotes instead of modeling the two prices; adequate for the
  grandfathered backrun path, not the design to copy.
- **The exemplar that pins all of this:** `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970`
  (block 24710788, coffeebabe) — `flash → Fluid borrow → swap → repay`, netting ~273 wstUSR + 0.078 WETH
  (~$100–500) during the wstUSR market depeg. `test/WstUSRArb.t.sol` (AC-3) reconstructs it on a fork. The
  planner fixture (`npm run searcher:planner`) proves the edge is load-bearing: credit edge ABSENT → 0
  candidates (`impact_token_no_supported_return_venue`); PRESENT → routes.
- **Known refinement the credit adapter MUST address (not done):** `deriveEdgeTaxonomy` flags credit
  `leavesStandingPosition:true` UNCONDITIONALLY (`strategy-taxonomy.ts:72`) — no net-zero refinement. An
  atomic borrow…repay loop that nets to zero in-tx (the `0xf88b` shape — principal-safe, position closed
  before the tx ends) is over-flagged, and the same bit excludes credit edges from block-scan
  (`detector/blockscan-scanner.ts:246`). The refinement = net-zero detection over the path (borrow+repay of
  the same market cancel) + terminal verify. This is CREDIT-LEG work; keep the fail-closed bit exactly as-is
  until that work ships its own gates.
- **Build sequencing (operator-set 2026-07-06, binding):** protocol leg [done] → **BS-3 block-scan live**
  (measure the realized profit gap vs the competitor) → **credit adapter LAST**, gated behind the
  `.credit-live` human gate (Safety Rule 1). The credit ADAPTER must NOT be built speculatively ahead of
  that sequence — keep the `credit` lineage + classification clean now (this doc), and when it is built,
  reuse boring-vault's `MorphoBlue`/`AaveV3` decoder signatures + position-defining args and verify against
  the real tx log (§ Adapter correctness / R5).

---
> **Scope note:** this doc is the ADAPTER ARCHITECTURE only (lineage / descriptor / reuse / verification).
> The EV / dust-vs-episodic / capture-path / build-or-not decisions for protocol + credit classes live in
> **`docs/decision-log.md` F-007** (two protocol classes: DEX-NAV dust vs credit episodic $100–500) and the
> session handoff — not here. Don't duplicate strategy into the architecture doc.

## What changed in this revision + open items
**Changed (rev 2):**
- Re-verified every structural claim at HEAD with file:line cites; added the "Current state" inventory
  (31 adapters confirmed; descriptor layer confirmed UNCONSUMED; `ActionAdapter` confirmed
  classification-free; the 6/31 unreachable + selector-shadowing + vocab-drift claims all reproduced from
  code, none stale).
- Fixed stale pointers: the classification table is `adapter-descriptors.ts` itself (the scratchpad Codex
  brief no longer exists); venue-registry status vocab corrected to `candidate|known|routable|excluded`.
- Converted the known-issues list into the ordered, gated remediation plan R1–R5 + WIRE-GATE + minor tail,
  with the explicit rule that `classifyCall` gets no production consumer before R1–R5.
- Re-adjudicated the Merkle-authorization point: "don't copy their code/Teller/Accountant" stands, but the
  AUTHORIZATION model is now recorded as a deferred safety-architecture option with explicit revisit
  triggers (wallet-cap raise / `.credit-live` / multi-operator), not "irrelevant".
- Folded in F-007 (two classes), the two-price (oracle-vs-market) credit quote model, the `0xf88b` exemplar
  + planner-fixture proof, the S2 net-zero refinement as deferred credit-leg work, and the binding build
  sequencing (protocol → BS-3 → credit LAST behind `.credit-live`).
**Open items:** R1–R5 unimplemented (descriptor safe only because unconsumed); credit adapter deferred per
sequencing; Merkle-authorization revisit dormant until a trigger fires; univ4 leaf classification semantics
undocumented in code (minor tail).
