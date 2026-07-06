# Handoff — adapter architecture + the 3 design docs: completion & next steps (2026-07-06)

For the next window. Assesses the completion of the three design docs, the code that backs them, the live
node, and the clear next moves. Read `CLAUDE.md` + `docs/research/HERMES.md` first (constitution + runbook).

## 0. TL;DR
- **Design is settled + code-verified; the CLASSIFICATION architecture (lineage/descriptor) is landed but
  UNCONSUMED and gated behind a 5-item remediation plan (R1–R5). The strategy question is settled by F-007:
  DEX-NAV protocol = **UNMEASURED (a ~5-block smoke test showed dust — NOT a don't-build basis, see §4)**;
  CREDIT = episodic $100–500 (posture-gated, build LAST).**
- **Repo HEAD**: `67d88b7` (lineage doc rev 2). **Node** `9a8f348`, bounded-live (`DRY_RUN=0`, wallet
  `0xb8578B6…` = 0.0027 ETH unchanged), markers `.deploy-live` + `.protocol-edges` + `.block-scan` on,
  `.credit-live` OFF. Block-scan lane runs **log-only** (Pass A); protocol edges live (11 entries).

## 1. The three docs — completion matrix
| doc | purpose | design | code behind it | verdict |
|---|---|---|---|---|
| `adapter-lineage-architecture-20260706.md` (rev 2, 315L) | THE adapter-architecture authority: lineage/descriptor/reuse/verification/remediation | **COMPLETE + code-verified** | descriptor table LANDED (`72fbfd9`) but **UNCONSUMED**; **R1–R5 UNIMPLEMENTED** | design done; implementation gated (§2) |
| `boring-vault-adapter-review-20260706.md` (72L) | reference: what to learn from Veda's DecoderAndSanitizer | **COMPLETE** (reference artifact) | n/a — knowledge, not code | done; cite it when building credit/new adapters |
| `unified-strategy-edge-impl-plan-20260704.md` (725L) | the master strategy×edge plan | **superseded in parts** by F-007 + the lineage doc | Phase 0/1 + scanner offline + BS-1c + BS-lane Pass A landed | historical authority; §4 for what's live vs dead |

## 2. adapter-lineage-architecture (rev 2) — status
**Landed:** the descriptor layer (`72fbfd9`) — `ADAPTER_DESCRIPTORS` table for all 31 adapters
(`adapter-descriptors.ts`), `classifyCall`/`assertDescriptorCoverage` (`registry.ts:33-43`), gate
`searcher:adapter-descriptors` 5/5. `ActionAdapter` stays classification-free (design intent). Credit
`leavesStandingPositionDefault` fixed to true/fail-closed (`0fc3c47`).

**Pending — the R1–R5 remediation (doc §"Descriptor remediation plan"), gated: no production consumer of
`classifyCall` until R1–R5 are green (WIRE-GATE):**
- **R1** — call `assertDescriptorCoverage()` at boot (`adapters/index.ts`) — 1 line, do first.
- **R2** — kill `matchTrace` target-blindness + selector collisions (weth `withdraw/deposit` classify on ANY
  address; `weth-withdraw`/`-amount` share `0x2e1a7d4d` → one is shadowed). Blocks R5 + all consumers.
- **R3** — one total `AdapterAction → ProtocolAction` map (two vocabs drift today: `erc4626-deposit` runtime
  `protocolAction:"wrap"` vs descriptor `action:"deposit"`). Blocks venue-registry wiring.
- **R4** — restore `quotable`/`buildable` (dropped from the landed table; `fluid-dex-swap.encode()` throws
  "not supported" yet looks wired).
- **R5** — give "verify vs a real tx log" teeth: `referenceTx?` field + zero-RPC committed-calldata fixtures
  gate (matchCall fires, classifyCall returns the pinned triple, encode() reproduces bytes). Depends on R2.
- Minor tail: 6/31 unreachable via classifyCall (univ4 leaves + assert-balance); polymorphic-selector action
  labels (fluid-vault `operate`); venue-registry `adapterHint` unvalidated.

**Deferred (not R-items):** the credit ADAPTER itself (Morpho/Aave/Fluid proper) — needs a market-vs-oracle
two-price quote (not a single amountOut), which we have NOT built; sequenced LAST, behind `.credit-live`.

## 3. What's LANDED vs what to build (code)
**Landed this arc:** Track A protocol execution (A0–A5, PSM/wstETH/ERC4626), A6 protocol-edges live, the
protocol-adapter descriptor framework, venue-discovery pipeline (evidence→aggregate→bq-reader→registry),
6 ERC4626 vaults live, `tx-profit` CLI, the lineage descriptor layer, BS-1c (scanner prices protocol edges),
`blockscan-hunt` (exemplar measurement), BS-lane Pass A (live block-scan lane, log-only, gated).

**DEX-NAV protocol class — NOT proven dust (correction 2026-07-06):** the "dust" read comes from a **~5-block
smoke test** (`blockscan-hunt`: 4 recent blocks + the `0xf88b` depeg block). That measurement proved BS-1c
WORKS (it surfaces + prices protocol rings) but did NOT measure the class's EV over a meaningful sample —
concluding "dust, don't build" from 5 blocks is the **starved-sample true-negative trap** the project has a
standing rule against ("never conclude a true-negative from a starved sample; size OUTCOME-DRIVEN"). Dislocations
are EPISODIC (depeg/volatility events). **Before any don't-build verdict, measure over an outcome-driven window
— hours, ideally event-targeted across multiple depeg blocks, not 5 consecutive quiet ones.** coffee demonstrably
nets >$1 in the PROTOCOL space: `0x9be73297` (steakUSDC+steakUSDT, $2.23) and `0x8ca222f1` (waEthUSDC, $2.44)
are **ERC4626-vault PROTOCOL arbs, NOT credit** — event-verified 2026-07-06: their Morpho Blue events are
`Supply`/`Withdraw`/`AccrueInterest` (the vault's internal ops), **ZERO Borrow** (F-007 classification
correction). So DEX-NAV/protocol is contradicted-by-evidence, not just under-sampled. BS-3 for DEX-NAV is
**not yet decidable**, not "don't build."

## 4. The binding decisions (do not re-open without reading the cited source)
- **F-007 (decision-log) — two protocol classes:** DEX-NAV protocol = smoke-test-dust but **UNMEASURED**
  (§ correction: 5 blocks ≠ a don't-build basis; re-measure outcome-driven); **CREDIT (Fluid/Morpho) =
  episodic $100–500** (`0xf88b` nets ~273 wstUSR at a wstUSR depeg via flash→Fluid borrow→swap→repay;
  BS-1c can't see it — credit-excluded by design). Capability EXISTS (AC-3 reconstructs it, Fluid edge
  grandfathered live); the gate is POSTURE (`.credit-live`, human). Reward is REAL, not dust.
- **Lineage architecture:** adapter=implementation, lineage=behavior family, edgeKind=path semantics; code
  splits per protocol, the classification vocab must not fragment. Credit stays a LEG, never a strategy.
- **Reuse boring-vault KNOWLEDGE not code** (Solidity → we take signatures + position-defining args + the
  Protocols/ catalog; write quote/encode/fork-sim/PnL ourselves; don't copy Merkle/Teller).
- **MEV-Share submit flag:** already flipped + measured insufficient (F-006/D-001, structural posture) —
  NOT an unflipped lever; the real production needle is the eligible-orderflow relationship.

## 5. Next window — clear ordered options (pick per operator intent)
1. **Adapter-classification path (offline, cheap, no dust dependency):** do R1 → R2 → R3 → R4 → R5 in order,
   then (WIRE-GATE passed) wire `classifyCall` into venue-discovery (replace the topic heuristic) + the
   loop-closability/return-path check (the open `tooling_defect`). This makes classification authoritative
   and is worth doing regardless of the EV verdict.
2. **Credit capture path (posture-gated, real $):** only if the operator takes the `.credit-live` decision —
   then the Fluid backrun ALREADY routes+sizes the `0xf88b` class (capture-first, no new code); CR-5 for
   precision; BS-3 credit-UN-excluded to catch it proactively. The Morpho credit ADAPTER (two-price quote)
   is the hard, last piece — build it referencing boring-vault `MorphoBlueDecoderAndSanitizer` + VERIFY vs
   `0x9be73297` (R5 discipline).
3. **Leave as-is:** the node is healthy bounded-live with the block-scan lane observing (log-only). No build
   is forced.

## 6. Safety + coordination
- **Broadcast/go-live = human gate.** Never create `/opt/MEV/.credit-live` (authorizes standing-position
  credit submits — a fresh Safety-Rule-1 decision). `.block-scan` is log-only (no submit path yet).
- Deploy only via `git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash` (mode-preserving).
  Disable a lane: `rm /opt/MEV/.<marker>` + redeploy.
- **Concurrent windows:** this repo was worked by two operator windows simultaneously (they collided on the
  shared tree, wiping uncommitted work twice). If you build code, commit FAST or consolidate to one window.
  `git log` first; the block-scan line (`0a1984c`/`bc8e8c9`/`9a8f348`) + the lineage line are both the
  operator's.
- **NEVER `rg -rn`/`-rln`** (`-r`=--replace, corrupts reads).
