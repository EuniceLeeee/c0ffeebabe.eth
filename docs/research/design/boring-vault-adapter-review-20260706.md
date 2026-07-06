# Architecture review — what our adapter layer can learn from Se7en-Seas/boring-vault (2026-07-06)

Reviewed `Se7en-Seas/boring-vault` (Veda) against our `ActionAdapter` + the lineage classification design
(handoff §5.4). Focus: the **DecoderAndSanitizer** pattern, which is the on-chain analog of our
adapter/classification layer. Verdict: it VALIDATES the lineage design and gives 5 concrete upgrades +
an immediate reference for the Morpho credit edge (task #16).

## What BoringVault is (only the relevant part)
On-chain vault (BoringVault holds funds; Teller = deposits/withdrawals; Accountant = share pricing;
ManagerWithMerkleVerification = authorizes strategist actions). The part relevant to US is the
**DecoderAndSanitizer**: a per-protocol, pure, minimal contract that, for each allowed protocol call,
extracts the sensitive/position-defining ADDRESS arguments from calldata. Each Merkle leaf =
`(decoder, target, valueNonZero, selector, packedAddressArgs)` — i.e. a `(target, selector) →
classification + which-addresses-it-touches` map. That is exactly our `matchCall(target,selector)→adapter`
+ the standing-position concern, formalized.

## 5 learnings for our adapter direction

1. **Per-BEHAVIOR mixin, composed by inheritance — a production system doing EXACTLY the lineage design.**
   `src/base/DecodersAndSanitizers/Protocols/` has ~50 mixins (ERC4626, MorphoBlue, Curve, UniswapV3,
   AaveV3, FluidDex, FluidFToken, Lido, BalancerV2, PendleRouter, Convex, Gearbox, PancakeSwapV3, …). ONE
   `ERC4626DecoderAndSanitizer` serves every ERC4626 vault; a protocol gets its OWN mixin only for quirks
   (Lido, EtherFi, WeEth). "Full" decoders compose the mixins they need via multiple inheritance. → This is
   the operator's "code split by protocol, classify by behavior, derive from base" + Claude's
   "split-vs-config only on a real behavioral diff." Not family-eats-all, not per-vault-from-scratch. Our
   current state (6 vaults on ONE erc4626 adapter via POOL_REGISTRY rows) = their "generic ERC4626 mixin
   reused" — correct.

2. **SEPARATE decode/classify from encode/execute — their biggest lesson.** Their DecoderAndSanitizer is
   `external pure virtual`, one line per function, does ONLY "which addresses does this call touch" — fully
   separate from execution (the vault calls the target itself). We CONFLATE encode + matchTrace in one
   `ActionAdapter`. Splitting a thin per-behavior DECODER (classify + extract position-defining args) from
   the ENCODER matches the operator's "classification = system language, adapter = implementation detail"
   and cleanly feeds `leavesStandingPosition`.

3. **The decoder extracts POSITION-DEFINING args → maps 1:1 onto leavesStandingPosition / D2.** Their
   `MorphoBlueDecoderAndSanitizer` decodes supply/withdraw/borrow/repay/supplyCollateral/withdrawCollateral
   and extracts `(loanToken, collateralToken, oracle, irm, onBehalf)` as the position-defining set; the
   `receiver` only tracks fund flow, not the position. That IS our standing-position rule: a Morpho action
   leaves a standing position defined by `(marketParams, onBehalf)`; if `onBehalf == our executor` and it
   is not closed in the same tx → `leavesStandingPosition=true` (S2/D2). Their decoder tells us precisely
   which args to read — no guessing.

4. **Their `Protocols/` catalog = a ready classification reference + integration roadmap.** ~50 protocols
   with canonical decoders + exact signatures. venue-discovery can cross-reference an unknown venue's
   selectors against this catalog → instant classification + a reference impl. It also enumerates exactly
   the credit/protocol venues we're missing (MorphoBlue, FluidDex/FToken, Aave, Curve, Pendle, Gearbox,
   Convex…) — a prioritizable roadmap, not guesswork.

5. **`(decoder, target, selector, sanitized-args)` = the unified classify + standing-position map we're
   building toward.** We already have `matchCall(target,selector)→adapter`. Adding each behavior's
   position-defining-address extraction (their "sanitize" output) makes `leavesStandingPosition`
   AUTHORITATIVE (read from the actual call args) instead of derived from `slotKind` — closes the
   topic-heuristic / static-label gap the operator flagged.

## Where we DIFFER (do NOT over-copy)
- BoringVault is an on-chain vault HOLDING funds; its Merkle-authorization + Teller/Accountant
  (share accounting) do NOT apply to our off-chain atomic-flash searcher (no standing inventory).
- Their decoder's PURPOSE is authorization (sanitize args vs an allowed set); OURS is routing + EV +
  standing-position. Same STRUCTURE, different use — take the structure, not the auth machinery.
- We additionally need the ENCODE side (build BotVM calldata) they don't (their vault calls targets
  directly). So our adapter = their decoder (classify) + an encoder (execute). Keep both — but SEPARATE.

## Actionable (folds into the pending builds)
- **Morpho credit edge (task #16):** use `MorphoBlueDecoderAndSanitizer.sol` as the signature + position-arg
  reference. `creditAction` maps 1:1: supply/withdraw/borrow/repay/supplyCollateral/withdrawCollateral.
  `leavesStandingPosition` = `(marketParams, onBehalf==executor)` position not closed in-tx.
- **Lineage classifier (task #15, redesigned):** adopt the per-behavior-mixin structure — a thin
  decoder-mixin per behavior that (a) declares selectors→classification, (b) extracts position-defining
  args. Separate from the encoder. Cross-reference venue-discovery against the decoder catalog.
- **Split `ActionAdapter`** into `decode/classify` (thin, per-behavior, feeds classification +
  standing-position) vs `encode` (execution). This is the concrete refactor the lineage design implies.
