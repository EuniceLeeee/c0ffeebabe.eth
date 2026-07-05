# Protocol-edges operator runbook (A2 / A5 fork-sim · A3/A4 cast-verify · A6 window) — 2026-07-05

Hand-back for the node/human-gated steps behind the offline slices landed this relay
(A0 `31bbec5` · A1 `3933eaa` · A2 `8b586a0` · A5 `7eac27f` · B2 `198003b`). Everything below needs a
node / archive RPC or a go-live authorization, so it was NOT run autonomously (§9.3b, Safety Rule 1).
Run top-to-bottom; each step is independent and safe (read-only `cast` / local fork sim) until the
final A6 window, which is the human go-live gate.

Prereqs: `export ETH_RPC_URL=<a mainnet RPC>` (archive only needed where noted). `cast` = foundry.

---

## 1. Cast-verify the NEW addresses (do this BEFORE any fork-sim — CLAUDE.md §2, don't trust memory)

```bash
# A5 wstETH — confirm the two addresses added to ADDR in 7eac27f are what the code assumes.
cast call 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 "symbol()(string)"            # expect wstETH
cast call 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 "stETH()(address)"            # expect 0xae7ab965...
cast call 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 "getWstETHByStETH(uint256)(uint256)" 1000000000000000000
cast call 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 "getStETHByWstETH(uint256)(uint256)" 1000000000000000000
cast call 0xae7ab96520de3a18e5e111b5eaab095312d7fe84 "symbol()(string)"            # expect stETH
```
Pass = symbols/rate sane. FAIL any ⇒ fix the ADDR value before proceeding; the offline units mock the
reads so they can't catch a wrong address.

```bash
# A3/A4 ERC4626 — the addresses A3/A4 needs but that are NOT yet in the repo. Get them here, then the
# slice is A5-shaped (see docs/research/design/erc4626-a3a4-spec-20260705.md). Do sUSDS FIRST.
cast call 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD "asset()(address)"            # sUSDS -> USDS addr
cast call 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD "previewRedeem(uint256)(uint256)" 1000000000000000000
cast call 0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055 "asset()(address)"            # wstUSR -> underlying (may revert if not ERC4626)
```
Record the returned USDS + wstUSR-underlying addresses; add to ADDR with a provenance comment, then
generate the A3/A4 slice per the spec.

---

## 2. Fork-sim the deterministic legs (A2 PSM buyGem, A5 wstETH) — the "implemented → fixed" flip

The offline commits are `implemented` (calldata + routing + mocked-quote units green) but not `fixed`:
the round-trip vs the real contract is unverified. Author + run a fork test (a node-enabled Codex pass
is fine) that asserts, on a mainnet fork:

- **A2 PSM buyGem (DAI→USDC):** approve DAI to `0xf6e72Db5…`, `buyGem(executor, usdcOut)` where
  `usdcOut = quotePSM(DAI,USDC,daiIn)`; assert the executor's USDC delta == `usdcOut` and DAI spent
  ≤ `daiIn`. Confirms the quoter floor + the A2 encode agree with the live PSM (`tin`/`tout`).
- **A5 wstETH wrap (stETH→wstETH):** hold stETH, approve to `0x7f39c581…`, `wrap(stETHAmt)`; assert
  wstETH out == `getWstETHByStETH(stETHAmt)`. **Watch the stETH rebasing 1–2 wei `transferFrom` quirk**
  — the pulled stETH can be 1–2 wei short; the plan-builder uses exact `amtIn`, so confirm the sim
  doesn't revert on a 1-wei shortfall (if it does, that's a real finding → size with a wei of slack).
- **A5 wstETH unwrap (wstETH→stETH):** `unwrap(wstETHAmt)`; assert stETH out == `getStETHByWstETH(...)`.

Gate: each round-trip's realized delta == the quoter's prediction (± the documented stETH wei quirk).
Only then is A2/A5 `fixed`.

---

## 3. A6 — enable protocol edges on the node (HUMAN GATE: go-live class, Safety Rule 1)

wstETH edges are filtered out of the live graph until `SEARCHER_ENABLE_PROTOCOL_EDGES=1` (main.ts
merge filter, added in 7eac27f). This is a deliberate live-graph change — treat like any go-live.

1. Confirm the node is still in the bounded-live envelope and DON'T interrupt an active measurement:
   `cat /opt/MEV/.deploy-live` present, `grep SEARCHER_DRY_RUN /proc/<pid>/environ`, wallet ≤ cap.
2. Set the durable marker/env so `deploy-node.sh`'s recover-from-process preserves it. Add
   `SEARCHER_ENABLE_PROTOCOL_EDGES=1` to the node env the same way other durable flags are marker-gated.
3. Deploy latest (broadcast-safe, DRY_RUN-guarded) via the ONE sanctioned op:
   ```bash
   aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
     --parameters 'commands=["git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
   ```
4. Verify the banner shows `protocolEdges=enabled` and the wstETH pair is in the graph; run a
   ~30-min dry-run window; Step-1 competitor cross-ref + `hermes-gate` before any conclusion.
5. Do NOT create `/opt/MEV/.credit-live` — that's the Aave/credit standing-position gate, a SEPARATE
   human authorization, unrelated to A6.

---

## 4. What stays deferred (unchanged)
BS-3 viable exemplar · CR-5 archive (Fluid resolver quote) · BS-lane/BS-4 · CS-min/full · D · CR-8 ·
CR-6-live / Aave credit-live · broadcast. All per the plan §2 statuses.
