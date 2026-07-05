# Live Safety Envelope — bounded-live broadcast authorization (dated)

> The concrete, dated safety-envelope detail behind CLAUDE.md Safety Rule 1. The **principle** (always-on,
> in CLAUDE.md): *mainnet broadcast/signing requires explicit human authorization; default dry-run;
> bounded-live only inside the marker/cap/EV-gate envelope.* This file is the enforced specifics — it can
> go stale (dated), which is exactly why it lives out of the constitution.

## Authorization
- **2026-06-10:** user authorized live bundle submission.
- **2026-07-03:** user authorized a **BOUNDED-LIVE test** — the searcher may broadcast autonomously ONLY
  inside a hard, script-enforced envelope, so worst-case loss is bounded to a tiny test wallet.

## The envelope (all must hold, else stay dry-run)
- Live is gated by the node-side marker `/opt/MEV/.deploy-live`.
- `deploy-node.sh` REFUSES live unless the signing wallet balance `≤ MEV_LIVE_MAX_WALLET_ETH` (default
  0.2 ETH) AND `SEARCHER_EV_GATE=1`.
- Flash-loan arbs are atomic (a bad arb reverts, principal never at risk) + the BotVM executor holds no
  standing funds → max loss is the test wallet's gas / builder-payment balance.
- Verified 2026-07-03: signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = 0.0027 ETH;
  BotVM `0x4aF9495C…5BCe` = empty.
- Even bounded, only broadcast a bundle that passed a **profitable on-fork / EV-gated simulation**
  (`sim.success` + net-EV + the assert-balance flash-repay guard). Never broadcast from an unverified or
  half-modified pipeline. Default is still dry-run; live is the marked exception.

## Still hard — never autonomous (a fresh explicit human OK required)
Funding the test wallet above the cap, raising `MEV_LIVE_MAX_WALLET_ETH`, swapping in the real-funds
private key, any broadcast outside the bounded envelope. The autonomous cron must NEVER do these.

## Safety valve
A bounded-live round reads the test-wallet balance at the start; if it dropped below 50% of its starting
balance → STOP, `rm /opt/MEV/.deploy-live` (revert to dry-run on next restart), and report.
