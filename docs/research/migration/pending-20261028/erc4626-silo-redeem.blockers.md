# protocol:erc4626-silo-redeem — blocked (engine gaps)

Faithful JSON cannot be authored with the current public engine. Verified in-memory draft:
`erc4626-silo-redeem.draft.json` (not a deliverable; discovery/identity/pricing/execution paths partially validated).

## Gaps (file:line)
1. Multi-step view chain proof: `declarative-quote-proof.ts:71-104` / `declarative-protocol.ts:484-491`
   require one request whose input equals amountIn and output equals amountOut. The family's exact is
   `previewRedeem(amountIn) -> previewWithdraw(previewAssets)`; neither hop alone satisfies both.
2. Cannot declare exact unavailable while pricing is multi-round: `declarative-protocol.ts:124`
   throws "variant requires quote" when quoteFlow/readPrograms.quote are absent.
3. Exact evidence env (`declarative-protocol.ts:410-414`) cannot carry intermediate `previewAssets`
   required by `types.ts:95-105`; buildFragment re-hashes evidence (`:519-530`).
4. Discovery cannot express the family-owned nomination: no `opaque` FieldSource
   (`declarative-discovery.ts:19-23`), field map must be complete (`:122-136`), generic address-surface
   nomination drops opaque (`address-surface-nomination.ts:49-57`) and cannot read asset()/probe evidence.
   The Withdraw log cannot be declared because it has no payout-token field (`discovery.ts:53-57`).
5. Pricing `classifyUnavailable` (`pricing.ts:185-194`, reason `silo_preview_chain_zero`) has no
   declarative hook; `pricingFlow.decodeSnapshot` hard-fails (`declarative-protocol.ts:355-376`).

## Verdict
Skip per migration policy (no public TS changes). Revisit only if the framework adds the five hooks above.
