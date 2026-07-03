---
name: bundle-postmortem
description: Diagnose why a submitted searcher bundle was never included on-chain. Use when a live/dry-run bundle passed the EV gate and got builder ACCEPTs but "上链 null" / never landed. Takes our backrun tx hash (prefix ok) or opportunity id.
---

# Bundle Post-Mortem

Scope note: authorized on-chain arbitrage research; analysis reads public chain data only;
broadcast stays human-gated (CLAUDE.md Safety Rule 1).

Answer "why didn't our submitted bundle land" with evidence, never guesses. The mechanical
core is codified in `analysis` (`npm run bundle-postmortem`); this skill is the procedure
around it. Method details: CLAUDE.md §6a "Bundle Post-Mortem".

## Procedure

1. **Locate the events file.** The searcher writes to the running process's
   `SEARCHER_EVENTS_PATH` — on the node read it from the process env
   (`sudo cat /proc/$(pgrep -f searcher/main | head -1)/environ | tr '\0' '\n' | grep EVENTS`).
   Do not assume `analysis/events/`.

2. **Run the script on the node** (events + local reth are both there; zero-CU):

   ```bash
   aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
     --parameters 'commands=["cd /opt/MEV/analysis && npm run bundle-postmortem -- --events <events jsonl> --tx <hash prefix> --rpc http://127.0.0.1:8545"]'
   ```

   It reports: where the pending swap landed + block builder identity; competing txs behind
   it (route venues, gross, builder payment = tip + coinbase transfer); our bid vs winner
   payment; `outbid` / `route_gap_decisive` verdicts; winner pools vs our runtime graph.

3. **Interpret with the fixed decision tree** (CLAUDE.md §6a): one-shot validity → builder
   reach (flashbots relay auto-shares to BuilderNet) → auction outcome → gap classification.
   Key discriminator: if winner payment > our FULL simulated gross, no bid policy could have
   won — the fix is route/pool coverage, not bidding.

4. **Manual follow-ups** the script can't do:
   - New/unknown winning builder → WebSearch its orderflow-sharing relationships before
     claiming a builder-reach gap.
   - Secondary-source-verify ≥1 key number via Alchemy (`$MAINNET_RPC_URL`).
   - Durable findings → memory; recurring gap_class → Findings Ledger (CLAUDE.md rule 13).

5. **Report** with each conclusion tied to the tool that produced it (script section,
   RPC call, WebSearch), per the analysis-tools-cited convention.
