# Live Safety Envelope — bounded-live broadcast authorization (dated)

> The concrete, dated safety-envelope detail behind CLAUDE.md Safety Rule 1. The **principle** (always-on,
> in CLAUDE.md): *mainnet broadcast/signing requires explicit human authorization; default dry-run;
> bounded-live only inside the marker/cap/EV-gate envelope.* This file is the enforced specifics — it can
> go stale (dated), which is exactly why it lives out of the constitution.

## Authorization
- **2026-06-10:** user authorized live bundle submission.
- **2026-07-03:** user authorized a **BOUNDED-LIVE test** — the searcher may broadcast autonomously ONLY
  inside a hard, script-enforced envelope, so worst-case loss is bounded to a tiny test wallet.
- **2026-07-12:** user authorized unattended **dual-live A/B canaries** for block-scan-only search: champion
  A plus one challenger B may run and submit simultaneously; a proven B may be merged/deployed to champion
  without another prompt. This authorization is conditional on every gate below and does not authorize
  funding, cap/key changes, standing-credit positions, or any out-of-envelope broadcast.
- **2026-07-13:** user extended that same bounded dual-live authorization to an explicit `dual` lane where
  A and B run block-scan plus victim-driven backrun together. Self-competition is accepted at this stage.
  The extension covers only position-conserving DEX or DEX+permissionless-protocol routes triggered by a
  public/MEV-Share swap or oracle update; wallet caps, EV/final-sim gates, keys, and all other exclusions are
  unchanged.

## The envelope (all must hold, else stay dry-run)
- Live is gated by the node-side marker `/opt/MEV/.deploy-live`.
- `deploy-node.sh` REFUSES live unless the signing wallet balance `≤ MEV_LIVE_MAX_WALLET_ETH`, the configured
  cap is positive and no greater than the fixed 0.2 ETH authorization, AND `SEARCHER_EV_GATE=1`.
- Flash-loan arbs are atomic (a bad arb reverts, principal never at risk) + the BotVM executor holds no
  standing funds → max loss is the test wallet's gas / builder-payment balance.
- Verified 2026-07-03: signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = 0.0027 ETH;
  BotVM `0x4aF9495C…5BCe` = empty.
- Even bounded, only broadcast a bundle that passed a **profitable on-fork / EV-gated simulation**
  (`sim.success` + net-EV + the assert-balance flash-repay guard). Never broadcast from an unverified or
  half-modified pipeline. Default is still dry-run; live is the marked exception.

### Dual-live A/B sub-envelope (all required)
- A is the bounded-live champion wallet `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` with BotVM
  `0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe`. B is the dedicated challenger wallet
  `0x2a6b8024190CF537efA3685792f201FD1Aac7294` with BotVM
  `0xCF471995e8FbD99F8dBE8377FA67Db89Ab18af24`. Each wallet independently satisfies the cap and 50%-of-
  baseline circuit breaker; B ownership is checked on-chain before every run.
- Both lanes are `SEARCHER_DRY_RUN=0`, `SEARCHER_EV_GATE=1`, with block-scan submit on. The default
  `blockscan-only` mode requires mempool/backrun off. The explicit `dual` mode requires both backrun and
  public mempool on for A and B; mixed postures are refused. They use separate wallets, BotVMs, main and
  block-scan anvil ports, logs, events, and equal CPU partitions. A is never restarted merely to launch B.
- Champion victim sources are durable only through `/opt/MEV/.backrun` plus `/opt/MEV/.mempool`; the deploy
  guard rejects `.mempool` without `.backrun`. B may inherit dual posture only when `AB_LANE_MODE=dual` and
  the trusted wrapper verifies matching A/B banners plus a live MEV-Share connection.
- B may start only through `scripts/deploy-ab-challenger.sh` fetched from trusted `origin/main`. The script
  verifies the exact A/B commits, derives B's normalized config from A's running process, checks declared
  config deltas, runs the trusted replay from a detached checkout of the exact A SHA, removes ignored `.env`
  files from B, passes only an allowlisted secret environment without a shell, snapshots/records universe
  inputs, owns the single B runtime lease, and stops/reaps B. In dual mode both main Anvil backends start
  eagerly so the wrapper can require and attribute the A/B sockets before accepting the run. A and B also
  inherit the same champion victim-stream endpoint; only its SHA-256 identity is logged and the wrapper
  rejects the run unless both current processes report the same identity. Both consume the same local reth
  HTTP/WS endpoints and the same content-addressed dynamic router allowlist. Each process carries its exact
  runtime commit in its environment, which must match the running unit's checkout. Dual readiness and renewal
  require the latest public-mempool connection state to be connected, not merely a historical startup line.
  `deploy-node.sh` and the B wrapper share one slot lock, and A deployment is refused while any live B unit or
  unclosed lease exists.
- Metrics are evidence, not merge authority. An agent records the causal/manual verdict after inspecting the
  paired window, reconciles it with the canonical comparison script, and uses a fresh non-author reviewer
  for every capability win or disagreement. Safety/correctness/evidence gates may veto; they cannot invent
  a win. Unresolved/crashed work retains its `ab/*` branch and stops B.
- A proven `win` may merge to `main`, deploy through the existing guarded `deploy-node.sh`, and delete only
  the gate-authorized literal `ab/*` branch. A decisive `lose` may delete its `ab/*` branch. No other branch
  deletion is authorized by this envelope.

## Still hard — never autonomous (a fresh explicit human OK required)
Funding the test wallet above the cap, raising the fixed 0.2 ETH authorization, swapping in the real-funds
private key, any broadcast outside the bounded envelope. The autonomous cron must NEVER do these.

## Safety valve
- Any A/B preflight or renewal envelope failure stops both A and B, restores A's CPU allocation, removes A's
  live marker, verifies both unit process trees are gone (escalating to `SIGKILL` if graceful stop times out),
  and closes an active experiment as `crashed_needs_escalation` before returning failure.
- The searcher independently validates EV gate, signer/BotVM ownership, the fixed wallet cap, and live balance
  before constructing any production submission component; deploy-script checks are defense in depth.
- B runs with `Restart=no` and a systemd `RuntimeMaxSec` matching its bounded lease, so a missed reaper or
  malformed journal cannot leave it broadcasting indefinitely. Renewal revalidates both current processes
  before extending the unit deadline and journal lease.
A bounded-live round reads each active test-wallet balance at the start; if either dropped below 50% of its
starting balance → STOP B immediately, `rm /opt/MEV/.deploy-live` (revert A to dry-run on next restart),
retain the challenger evidence/branch, and report.
