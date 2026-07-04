# Handoff-relay status (the loop's OFF switch)

> Read by `docs/research/autonomous-handoff-relay-round.md` Step 0a. Updated by every relay round at
> Step 4b. Two consecutive independent "done" verifications flip `status` to COMPLETE, after which every
> future round NO-OPs. Do not hand-edit `consecutive_done_confirmations` to skip the two-round bar.

status: IN_PROGRESS
consecutive_done_confirmations: 0

## Confirmation log (append-only; each entry = one round that re-verified all slices landed + gates green)
<!-- round-id · date · gate command re-run · result -->
