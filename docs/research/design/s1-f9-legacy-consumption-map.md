# S1 F9 Legacy Registry Consumption Map

> Dated 2026-08-17. Grounded in a full-file read of every production consumer
> plus the registry surface (production-registry.ts, adapter-family-registry.ts,
> route-leg-registry.ts, route-instance-identity.ts). Paths are the actual
> repo locations under listener/src/searcher/ (task-list paths corrected:
> planner/quoter.ts -> solver/quoter.ts; planner/plan-builder.ts ->
> solver/plan-builder.ts; solver/revm-live-backend.ts ->
> live-backends/revm-live-backend.ts; planner/path-template.ts ->
> templates/path-template.ts).

## Consumers (10 files)

| File | Lines | Registry methods consumed |
|---|---|---|
| planner/token-graph.ts | 691 | routes() findForPool 307/504, buildEdges 496, protocols() 245, POOL_REGISTRY import 243-246 |
| solver/quoter.ts | 72 | routes() findForEdge 49; quoteExact CALLED 54 |
| solver/plan-builder.ts | 162 | routes() findForEdge 102, defaultFunding() 50, findFundingByAction() 149; buildPlanFragment CALLED 106; buildFlashLoanRoot CALLED 151 |
| live-backends/revm-live-backend.ts | 596 | routes() findForEdge 459; prepared.quote CALLED 461 (legacy lane, Pair E) |
| solver/pool-state-updater.ts | 463 | routes() findForEdge 432 |
| solver/solver.ts | 1026 | routes() findForEdge 914; credits() 722/832 |
| solver/amount-propagation.ts | 186 | routes() findForEdge 159; credits() 82; creditPolicy.quoteOutputByDebtBps CALLED 86 |
| solver/flash-liquidity.ts | 137 | funding() 35, defaultFunding() 122; DEFAULT_FLASH_PROVIDERS import 34-41 |
| planner/planner.ts | 905 | defaultFunding() 190/390, findFundingByAction() 440 |
| templates/path-template.ts | 85 | routes() list 55, fundingActionIds() 61/76, creditActionIds() 62; TRADE_LEG_ADAPTERS + PathTemplate exports import 54-85 |

## Family fields read (metadata vs behavioral)

Behavioral (called functions, F9 deletion targets):
- buildEdges (token-graph 496)
- quoteExact (quoter 54)
- buildPlanFragment (plan-builder 106)
- prepared.quote (revm-live-backend 461)
- creditPolicy.quoteOutputByDebtBps (amount-propagation 86)
- buildFlashLoanRoot (plan-builder 151)

Metadata / identity-key derivation (read-only):
- id, declaredVenues, kind, livePoolState.kind, edgeAdapterIds,
  allowedTaxonomy, creditPolicy.debtBpsCandidates,
  creditPolicy.blocksPrefixInversion, prepared.quoteUnsupportedReason,
  funding.actionAdapterId / liquidityPriority / liquidityHolder / target,
  routeIdentity / planExecutionIdentity (route-instance-identity helpers:
  token-graph 313/505, inside buildEdges binding).

## Import-time (module side-effect) reads — cutover-critical

These freeze registry-derived data at FIRST IMPORT; F9 must neutralize them
with the registry cutover in the same commit:
- POOL_REGISTRY (token-graph 243-246; mergeDeclaredProtocolVenues at 249)
- DEFAULT_FLASH_PROVIDERS (flash-liquidity 34-41)
- TRADE_LEG_ADAPTERS + both PathTemplate exports (path-template 54-85)

## Strict-side equivalents (F8 status)

- ONLY live-backends/revm-live-backend.ts has real strict reads:
  strictExecutionProjectionForHop -> prewarmQuoteCalls 425-434 and
  allowanceSpender 584-588; resolveFundingPrewarmAddresses 235-243/362-368;
  strictRoutePrewarmAddresses 248-254/375-381;
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG default 239-240/366-367.
  Legacy quote (prepared.quote, findForEdge) intentionally remains until
  "Pair E" (comment 28-30).
- The other 9 files have ZERO strict-catalog identifiers. canonicalEdgeId in
  token-graph is a TokenEdge OUTPUT of the legacy buildEdges identity binding,
  not a strict read.

## F9 implications

1. The 6 behavioral call-sites are the legacy runtime call-sites the
   MigrationCleanupReceipt probes track; deleting them flips verdict=pass.
2. The 3 import-time registries must be removed in the same F9 slice (they
   freeze legacy-derived data at module load; leaving them makes the
   receipt scan pass while stale data still loads).
3. revm-live-backend's legacy quote lane (prepared.quote) is the Pair E
   legacy fallback; F9 removes it only after the strict quote source is
   proven in the live pipeline (F5 acceptance).
